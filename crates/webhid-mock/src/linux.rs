//! Linux backend: raw bindings to the `/dev/uhid` interface + event loop.
//!
//! `/dev/uhid` is the kernel's userspace HID transport: a userspace process
//! opens `/dev/uhid`, writes a `UHID_CREATE2` event containing a report
//! descriptor + VID/PID/name, and the kernel instantiates a new
//! `/dev/hidrawN` device that real HID clients (including our `webhid-daemon`)
//! see as if it were a physical device. The userspace process then feeds
//! `UHID_INPUT2` events to inject input reports, and receives `UHID_OUTPUT`
//! / `UHID_GET_REPORT` / `UHID_SET_REPORT` events when the host writes or
//! queries reports.
//!
//! Only the subset of the protocol we actually need is defined here, we
//! skip output-ev, feature-report replies, etc. Structs match the kernel
//! ABI in `<linux/uhid.h>` and must not be reordered or resized.
//!
//! Refs:
//!   - https://www.kernel.org/doc/html/latest/hid/uhid.html
//!   - linux/uhid.h

use std::os::unix::io::RawFd;

use anyhow::Context as _;

use crate::{LoopAction, MockDevice, SpawnOpts, emit_stdout, handle_command};

pub const UHID_CREATE2: u32 = 11;
pub const UHID_DESTROY: u32 = 1;
pub const UHID_INPUT2: u32 = 12;

pub const UHID_START: u32 = 2;
pub const UHID_STOP: u32 = 3;
pub const UHID_OPEN: u32 = 4;
pub const UHID_CLOSE: u32 = 5;
pub const UHID_OUTPUT: u32 = 6;
pub const UHID_GET_REPORT: u32 = 9;
pub const UHID_GET_REPORT_REPLY: u32 = 10;
pub const UHID_SET_REPORT: u32 = 13;
pub const UHID_SET_REPORT_REPLY: u32 = 14;

/// `UHID_DATA_MAX` from <linux/uhid.h>. Maximum size of a single HID report
/// (input/output/feature) plus its 1-byte report ID prefix.
pub const UHID_DATA_MAX: usize = 4096;

/// `UHID_CREATE2_NAME_MAX` from <linux/uhid.h>. Includes the trailing NUL.
pub const UHID_CREATE2_NAME_MAX: usize = 128;

/// `phys` / `uniq` size from <linux/uhid.h> struct `uhid_create2_req`.
pub const UHID_DEVICE2_CLASS_MAX: usize = 64;

/// `struct uhid_create2_req`, sent to create a virtual HID device.
#[derive(Copy, Clone)]
#[repr(C, packed)]
pub struct UhidCreate2Req {
    /// NUL-terminated device name (UTF-8).
    pub name: [u8; UHID_CREATE2_NAME_MAX],
    /// NUL-terminated physical-path string. We leave it empty.
    pub phys: [u8; UHID_DEVICE2_CLASS_MAX],
    /// NUL-terminated unique-id string. We leave it empty.
    pub uniq: [u8; UHID_DEVICE2_CLASS_MAX],
    /// Length of `rd_data` in bytes (report descriptor size).
    pub rd_size: u16,
    /// Bus type: `BUS_USB = 0x03`, `BUS_BLUETOOTH = 0x05`, etc. We default
    /// to `BUS_USB` so the device shows up in hidapi's normal enumeration.
    pub bus: u16,
    /// 16-bit USB Vendor ID (zero-padded to u32 in the kernel struct).
    pub vendor: u32,
    /// 16-bit USB Product ID.
    pub product: u32,
    /// 16-bit device version (bcdDevice).
    pub version: u32,
    /// 16-bit HID country code (0 = not localized).
    pub country: u32,
    /// Raw report descriptor bytes.
    pub rd_data: [u8; UHID_DATA_MAX],
}

/// `struct uhid_input2_req`, sent to inject an input report into the host.
#[derive(Copy, Clone)]
#[repr(C, packed)]
pub struct UhidInput2Req {
    /// Length of `data` in bytes (NOT including the report ID byte that
    /// lives at `data[0]` for numbered reports).
    pub size: u16,
    /// Report data. For numbered reports, `data[0]` is the report ID and
    /// `size` includes it. For non-numbered reports, `data[0]` is the
    /// first payload byte.
    pub data: [u8; UHID_DATA_MAX],
}

/// `struct uhid_output_req`, received when the host writes an output
/// report to the device. We model it explicitly so we can read its `data`
/// and `size` fields without unsafe pointer arithmetic on a raw buffer.
#[derive(Copy, Clone)]
#[repr(C, packed)]
pub struct UhidOutputReq {
    /// Output report payload.
    pub data: [u8; UHID_DATA_MAX],
    /// Length of `data` in bytes.
    pub size: u16,
    /// Report type: 1 = OUTPUT, 2 = FEATURE. We don't currently use this.
    pub rtype: u8,
}

/// `struct uhid_get_report_req`, received when the host requests a
/// feature report.  We need to read `id` so the reply can match it.
#[derive(Copy, Clone)]
#[repr(C, packed)]
pub struct UhidGetReportReq {
    /// Request id, must be echoed in the reply.
    pub id: u32,
    /// Report number (HID report ID, or 0 for non-numbered).
    pub rnum: u8,
    /// Report type (0=input, 1=output, 2=feature).
    pub rtype: u8,
}

/// `struct uhid_get_report_reply_req`, sent in reply to a
/// UHID_GET_REPORT.  We reply with err=0 and empty data since
/// our virtual device has no meaningful feature reports to return.
#[derive(Copy, Clone)]
#[repr(C, packed)]
pub struct UhidGetReportReplyReq {
    /// Echo of the request id.
    pub id: u32,
    /// 0 = success, non-zero = error (e.g. ENOENT).
    pub err: u16,
    /// Number of valid bytes in `data`.
    pub size: u16,
    /// Report data (empty in our case).
    pub data: [u8; UHID_DATA_MAX],
}

/// `struct uhid_set_report_req`, received when the host sends a
/// feature report to the device.
#[derive(Copy, Clone)]
#[repr(C, packed)]
pub struct UhidSetReportReq {
    /// Request id, must be echoed in the reply.
    pub id: u32,
    /// Report number (HID report ID, or 0 for non-numbered).
    pub rnum: u8,
    /// Report type (0=input, 1=output, 2=feature).
    pub rtype: u8,
    /// Number of valid bytes in `data`.
    pub size: u16,
    /// Report data.
    pub data: [u8; UHID_DATA_MAX],
}

/// `struct uhid_set_report_reply_req`, sent in reply to a UHID_SET_REPORT.
#[derive(Copy, Clone)]
#[repr(C, packed)]
pub struct UhidSetReportReplyReq {
    /// Echo of the request id.
    pub id: u32,
    /// 0 = success, non-zero = error.
    pub err: u16,
}

/// `union uhid_event.u`, the variable-size arm of `struct uhid_event`.
///
/// Modelled as a Rust union; only one arm is active at a time. The kernel
/// picks which arm to read based on the `type` field in the parent struct.
/// The union's size is the size of its largest arm (`UhidCreate2Req`).
#[repr(C, packed)]
pub union UhidEventUnion {
    pub create2: UhidCreate2Req,
    pub input2: UhidInput2Req,
    pub output: UhidOutputReq,
    pub get_report: UhidGetReportReq,
    pub get_report_reply: UhidGetReportReplyReq,
    pub set_report: UhidSetReportReq,
    pub set_report_reply: UhidSetReportReplyReq,
}

/// `struct uhid_event`, the top-level envelope written to / read from
/// `/dev/uhid`. Layout: 4-byte type tag followed by the union.
#[repr(C, packed)]
pub struct UhidEvent {
    /// `__u32 type` from <linux/uhid.h>.
    pub type_: u32,
    /// The active arm depends on `type_`.
    pub u: UhidEventUnion,
}

/// Total size of a `uhid_event` as the kernel expects to read/write it.
/// This matches `sizeof(struct uhid_event)` in C, the kernel reads this
/// exact number of bytes per syscall.
pub const UHID_EVENT_SIZE: usize = std::mem::size_of::<UhidEvent>();

const _: () = assert!(
    UHID_EVENT_SIZE == 4376,
    "UHID_EVENT_SIZE mismatch with kernel ABI"
);

/// Open `/dev/uhid` for read+write. Requires write permission, either
/// root or a udev rule granting access to the calling user/group.
///
/// Returns the raw fd on success. Caller is responsible for `close(2)`.
pub fn open_uhid() -> std::io::Result<RawFd> {
    let fd = unsafe { libc::open(c"/dev/uhid".as_ptr(), libc::O_RDWR) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(fd)
}

/// Write a `uhid_event` to the fd. Returns the number of bytes written
/// (always `UHID_EVENT_SIZE` on success).  Retries on EINTR.
pub fn write_event(fd: RawFd, event: &UhidEvent) -> std::io::Result<usize> {
    loop {
        let written = unsafe {
            libc::write(
                fd,
                event as *const UhidEvent as *const std::ffi::c_void,
                UHID_EVENT_SIZE,
            )
        };
        if written < 0 {
            let err = std::io::Error::last_os_error();
            if err.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(err);
        }
        return Ok(written as usize);
    }
}

/// Read a `uhid_event` from the fd. Blocks until an event is available.
/// Retries on EINTR.
pub fn read_event(fd: RawFd, event: &mut UhidEvent) -> std::io::Result<usize> {
    loop {
        let n = unsafe {
            libc::read(
                fd,
                event as *mut UhidEvent as *mut std::ffi::c_void,
                UHID_EVENT_SIZE,
            )
        };
        if n < 0 {
            let err = std::io::Error::last_os_error();
            if err.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(err);
        }
        return Ok(n as usize);
    }
}

/// Build a `UHID_CREATE2` event from the given parameters.
///
/// - `name`: device name, will be NUL-padded into the 128-byte buffer.
/// - `rd`: raw report descriptor bytes (max 4096).
/// - `vid` / `pid` / `version` / `country`: USB descriptors.
/// - `bus`: BUS_USB (0x03) by default.
pub fn build_create_event(
    name: &str,
    rd: &[u8],
    vid: u16,
    pid: u16,
    version: u16,
    country: u8,
    bus: u16,
) -> anyhow::Result<UhidEvent> {
    if rd.len() > UHID_DATA_MAX {
        anyhow::bail!(
            "report descriptor too large: {} bytes (max {})",
            rd.len(),
            UHID_DATA_MAX
        );
    }
    if name.len() >= UHID_CREATE2_NAME_MAX {
        anyhow::bail!(
            "device name too long: {} bytes (max {})",
            name.len(),
            UHID_CREATE2_NAME_MAX - 1
        );
    }

    let mut create = UhidCreate2Req {
        name: [0u8; UHID_CREATE2_NAME_MAX],
        phys: [0u8; UHID_DEVICE2_CLASS_MAX],
        uniq: [0u8; UHID_DEVICE2_CLASS_MAX],
        rd_size: rd.len() as u16,
        bus,
        vendor: vid as u32,
        product: pid as u32,
        version: version as u32,
        country: country as u32,
        rd_data: [0u8; UHID_DATA_MAX],
    };
    let name_bytes = name.as_bytes();
    create.name[..name_bytes.len()].copy_from_slice(name_bytes);
    create.rd_data[..rd.len()].copy_from_slice(rd);

    Ok(UhidEvent {
        type_: UHID_CREATE2,
        u: UhidEventUnion { create2: create },
    })
}

/// Build a `UHID_INPUT2` event carrying the given report bytes.
///
/// `data` must already include the report ID as its first byte for
/// numbered-report devices. `data.len()` must be ≤ `UHID_DATA_MAX`.
pub fn build_input_event(data: &[u8]) -> anyhow::Result<UhidEvent> {
    if data.len() > UHID_DATA_MAX {
        anyhow::bail!(
            "input report too large: {} bytes (max {})",
            data.len(),
            UHID_DATA_MAX
        );
    }

    let mut input = UhidInput2Req {
        size: data.len() as u16,
        data: [0u8; UHID_DATA_MAX],
    };
    input.data[..data.len()].copy_from_slice(data);

    Ok(UhidEvent {
        type_: UHID_INPUT2,
        u: UhidEventUnion { input2: input },
    })
}

/// Build a `UHID_DESTROY` event.
pub fn build_destroy_event() -> UhidEvent {
    let u = UhidEventUnion {
        input2: UhidInput2Req {
            size: 0,
            data: [0u8; UHID_DATA_MAX],
        },
    };
    UhidEvent {
        type_: UHID_DESTROY,
        u,
    }
}

/// Build a `UHID_GET_REPORT_REPLY` acknowledging a GET_REPORT request.
///
/// We reply with `err = 0` and an empty payload since no feature report
/// data is expected for our test devices.
pub fn build_get_report_reply_event(id: u32) -> UhidEvent {
    UhidEvent {
        type_: UHID_GET_REPORT_REPLY,
        u: UhidEventUnion {
            get_report_reply: UhidGetReportReplyReq {
                id,
                err: 0,
                size: 0,
                data: [0u8; UHID_DATA_MAX],
            },
        },
    }
}

/// Build a `UHID_SET_REPORT_REPLY` acknowledging a SET_REPORT request.
pub fn build_set_report_reply_event(id: u32) -> UhidEvent {
    UhidEvent {
        type_: UHID_SET_REPORT_REPLY,
        u: UhidEventUnion {
            set_report_reply: UhidSetReportReplyReq { id, err: 0 },
        },
    }
}

/// Extract the request `id` from a UHID_GET_REPORT or UHID_SET_REPORT event.
///
/// SAFETY: the caller must have already verified `event.type_` matches the
/// expected type so the correct union arm is active.
pub fn get_report_request_id(event: &UhidEvent) -> u32 {
    unsafe { event.u.get_report.id }
}

/// Parse the variable-length payload of a `UHID_OUTPUT` event (host →
/// device output report) into a borrowed byte slice.
///
/// Returned slice points into the event's own `u.output.data` buffer and
/// is valid for as long as the event is.
pub fn output_event_payload(event: &UhidEvent) -> Option<&[u8]> {
    if event.type_ != UHID_OUTPUT {
        return None;
    }
    let output = unsafe { &event.u.output };
    let size = output.size as usize;
    if size > UHID_DATA_MAX {
        return None;
    }
    Some(&output.data[..size])
}

/// The spawned Linux virtual device: just the `/dev/uhid` fd.
struct LinuxDevice {
    fd: RawFd,
}

impl MockDevice for LinuxDevice {
    fn send_input(&self, payload: &[u8]) -> anyhow::Result<()> {
        let event = build_input_event(payload)?;
        write_event(self.fd, &event).context("UHID_INPUT2 write failed")?;
        Ok(())
    }
}

pub fn run_spawn(opts: SpawnOpts) -> anyhow::Result<()> {
    let rd = std::fs::read(&opts.descriptor_path)
        .with_context(|| format!("failed to read descriptor at {}", opts.descriptor_path))?;
    log::info!(
        "loaded {} bytes of report descriptor from {}",
        rd.len(),
        opts.descriptor_path
    );

    let fd = open_uhid()
        .context("failed to open /dev/uhid (are you root or in a group with write access?)")?;

    create_virtual_device(fd, &opts, &rd)?;

    emit_stdout(&serde_json::json!({
        "event": "ready",
        "vid": opts.vid,
        "pid": opts.pid,
        "name": opts.name,
        "usagePage": opts.usage_page,
        "usage": opts.usage,
    }));

    let dev = LinuxDevice { fd };

    set_stdin_nonblocking()?;

    let mut stdin_buf = Vec::new();
    run_event_loop(fd, &dev, &mut stdin_buf)?;

    destroy_device(fd);
    Ok(())
}

/// Build the `UHID_CREATE2` event for `opts` and write it to the fd.
fn create_virtual_device(fd: RawFd, opts: &SpawnOpts, rd: &[u8]) -> anyhow::Result<()> {
    let create = build_create_event(
        &opts.name,
        rd,
        opts.vid,
        opts.pid,
        opts.version,
        opts.country,
        opts.bus,
    )?;
    write_event(fd, &create).context("UHID_CREATE2 write failed")?;
    log::info!(
        "created virtual device: VID={:#06x} PID={:#06x} name='{}' rd={}B",
        opts.vid,
        opts.pid,
        opts.name,
        rd.len()
    );
    Ok(())
}

/// Set stdin to non-blocking mode so poll() can multiplex it with the uhid fd.
fn set_stdin_nonblocking() -> anyhow::Result<()> {
    let stdin_fd = libc::STDIN_FILENO;
    let stdin_flags = unsafe { libc::fcntl(stdin_fd, libc::F_GETFL) };
    if stdin_flags < 0 {
        anyhow::bail!(
            "fcntl(F_GETFL) on stdin failed: {}",
            std::io::Error::last_os_error()
        );
    }
    if unsafe { libc::fcntl(stdin_fd, libc::F_SETFL, stdin_flags | libc::O_NONBLOCK) } < 0 {
        anyhow::bail!(
            "fcntl(F_SETFL, O_NONBLOCK) on stdin failed: {}",
            std::io::Error::last_os_error()
        );
    }
    Ok(())
}

/// Poll the uhid fd and stdin until the loop should exit.
fn run_event_loop(fd: RawFd, dev: &dyn MockDevice, stdin_buf: &mut Vec<u8>) -> anyhow::Result<()> {
    let mut uhid_error_count = 0;

    loop {
        let mut pfds = build_pollfds(fd);

        let ret = unsafe { libc::poll(pfds.as_mut_ptr(), 2, -1) };
        if ret < 0 {
            let err = std::io::Error::last_os_error();
            if err.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            anyhow::bail!("poll failed: {err}");
        }

        match poll_dispatch(fd, dev, &pfds, &mut uhid_error_count, stdin_buf)? {
            LoopAction::Continue => {}
            LoopAction::Exit => break,
        }
    }
    Ok(())
}

/// The two fds poll() watches each iteration: uhid first, stdin second.
fn build_pollfds(fd: RawFd) -> [libc::pollfd; 2] {
    [
        libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        },
        libc::pollfd {
            fd: libc::STDIN_FILENO,
            events: libc::POLLIN,
            revents: 0,
        },
    ]
}

/// Dispatch one poll() result to the uhid / stdin handlers.
fn poll_dispatch(
    fd: RawFd,
    dev: &dyn MockDevice,
    pfds: &[libc::pollfd; 2],
    uhid_error_count: &mut u32,
    stdin_buf: &mut Vec<u8>,
) -> anyhow::Result<LoopAction> {
    let uhid_revents = pfds[0].revents;

    if uhid_revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
        return handle_uhid_error(uhid_revents, uhid_error_count);
    }

    if uhid_revents & libc::POLLIN != 0
        && let Err(e) = poll_read_uhid_event(fd)
    {
        log::warn!("uhid read error: {e:#}");
        return Ok(LoopAction::Exit);
    }

    let stdin_revents = pfds[1].revents;
    if stdin_revents & (libc::POLLIN | libc::POLLHUP) != 0 {
        return handle_stdin_poll(stdin_revents, dev, stdin_buf);
    }
    Ok(LoopAction::Continue)
}

/// Handle a uhid fd error state. Returns `Exit` after 3 consecutive errors;
/// otherwise sleeps briefly and lets the loop retry.
fn handle_uhid_error(revents: i16, count: &mut u32) -> anyhow::Result<LoopAction> {
    *count += 1;
    emit_stdout(&serde_json::json!({
        "event": "uhid_error",
        "revents": revents,
        "count": *count,
    }));
    if *count >= 3 {
        log::error!(
            "uhid fd entered error state (revents={}) after {}/3 checks; exiting",
            revents,
            *count,
        );
        return Ok(LoopAction::Exit);
    }
    log::warn!(
        "uhid fd error (revents={}) check {}/3, will pause before retry",
        revents,
        *count,
    );
    std::thread::sleep(std::time::Duration::from_millis(200));
    Ok(LoopAction::Continue)
}

/// Handle stdin readiness: drain readable bytes and process complete lines.
fn handle_stdin_poll(
    revents: i16,
    dev: &dyn MockDevice,
    buf: &mut Vec<u8>,
) -> anyhow::Result<LoopAction> {
    if revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
        log::info!("stdin closed, destroying device");
        return Ok(LoopAction::Exit);
    }
    let n = poll_read_stdin(buf)?;
    if n == 0 {
        log::info!("stdin EOF, destroying device");
        return Ok(LoopAction::Exit);
    }
    if poll_process_stdin(dev, buf)? == LoopAction::Exit {
        return Ok(LoopAction::Exit);
    }
    Ok(LoopAction::Continue)
}

/// Best-effort destroy of the virtual device, then close the fd.
fn destroy_device(fd: RawFd) {
    let _ = write_event(fd, &build_destroy_event());
    unsafe { libc::close(fd) };
}

fn poll_read_uhid_event(fd: RawFd) -> anyhow::Result<()> {
    let mut event = empty_uhid_event();
    let n = read_event(fd, &mut event).context("read_event failed")?;
    let kind = event.type_;

    dispatch_uhid_event(fd, kind, &event);

    log::info!("uhid event: type={kind} n={n}");
    Ok(())
}

/// A zeroed `uhid_event` with the `create2` union arm initialized. The
/// kernel overwrites the payload on read, so only `type_` carries meaning
/// on input.
fn empty_uhid_event() -> UhidEvent {
    UhidEvent {
        type_: 0,
        u: UhidEventUnion {
            create2: UhidCreate2Req {
                name: [0u8; UHID_CREATE2_NAME_MAX],
                phys: [0u8; UHID_DEVICE2_CLASS_MAX],
                uniq: [0u8; UHID_DEVICE2_CLASS_MAX],
                rd_size: 0,
                bus: 0,
                vendor: 0,
                product: 0,
                version: 0,
                country: 0,
                rd_data: [0u8; UHID_DATA_MAX],
            },
        },
    }
}

/// Emit the JSON event for one uhid event, replying where the protocol
/// requires (get/set-report).
fn dispatch_uhid_event(fd: RawFd, kind: u32, event: &UhidEvent) {
    match kind {
        UHID_START => emit_stdout(&serde_json::json!({"event": "uhid_start"})),
        UHID_STOP => emit_stdout(&serde_json::json!({"event": "uhid_stop"})),
        UHID_OPEN => emit_stdout(&serde_json::json!({"event": "uhid_open"})),
        UHID_CLOSE => emit_stdout(&serde_json::json!({"event": "uhid_close"})),
        UHID_OUTPUT => {
            if let Some(payload) = output_event_payload(event) {
                emit_stdout(&serde_json::json!({
                    "event": "output_report",
                    "data": payload,
                }));
            }
        }
        UHID_GET_REPORT => {
            reply_to_report_request(fd, "get_report", event, build_get_report_reply_event)
        }
        UHID_SET_REPORT => {
            reply_to_report_request(fd, "set_report", event, build_set_report_reply_event)
        }
        other => {
            emit_stdout(&serde_json::json!({
                "event": "unknown",
                "type": other,
            }));
        }
    }
}

/// Emit the get/set-report JSON event and write the matching reply.
fn reply_to_report_request(
    fd: RawFd,
    name: &str,
    event: &UhidEvent,
    build_reply: fn(u32) -> UhidEvent,
) {
    let rid = get_report_request_id(event);
    emit_stdout(&serde_json::json!({
        "event": name,
        "id": rid,
    }));
    let reply = build_reply(rid);
    if let Err(e) = write_event(fd, &reply) {
        log::warn!("{name} reply write failed: {e:#}");
    }
}

fn poll_read_stdin(buf: &mut Vec<u8>) -> anyhow::Result<usize> {
    let mut tmp = [0u8; 4096];
    let n = loop {
        let r = unsafe {
            libc::read(
                libc::STDIN_FILENO,
                tmp.as_mut_ptr() as *mut std::ffi::c_void,
                tmp.len(),
            )
        };
        if r < 0 {
            let err = std::io::Error::last_os_error();
            if err.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            if err.kind() == std::io::ErrorKind::WouldBlock {
                return Ok(0);
            }
            return Err(err.into());
        }
        break r;
    };
    if n == 0 {
        return Ok(0);
    }
    buf.extend_from_slice(&tmp[..n as usize]);
    Ok(n as usize)
}

/// Process complete lines from the stdin buffer. Returns `true` if the
/// caller should stop the event loop (destroy command received).
fn poll_process_stdin(dev: &dyn MockDevice, buf: &mut Vec<u8>) -> anyhow::Result<LoopAction> {
    loop {
        let newline = match buf.iter().position(|&b| b == b'\n') {
            Some(pos) => pos,
            None => return Ok(LoopAction::Continue),
        };

        let raw = std::str::from_utf8(&buf[..newline])
            .context("stdin is not valid UTF-8")?
            .trim()
            .to_owned();

        buf.drain(..=newline);

        if raw.is_empty() {
            continue;
        }

        match handle_command(dev, &raw) {
            Ok(LoopAction::Continue) => {}
            Ok(LoopAction::Exit) => return Ok(LoopAction::Exit),
            Err(e) => {
                emit_stdout(&serde_json::json!({
                    "event": "error",
                    "error": format!("{e:#}"),
                }));
            }
        }
    }
}
