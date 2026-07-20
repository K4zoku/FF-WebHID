//! Raw bindings to the Linux `/dev/uhid` interface.
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
//! Only the subset of the protocol we actually need is defined here — we
//! skip output-ev, feature-report replies, etc. Structs match the kernel
//! ABI in `<linux/uhid.h>` and must not be reordered or resized.
//!
//! Refs:
//!   - https://www.kernel.org/doc/html/latest/hid/uhid.html
//!   - linux/uhid.h

#![cfg(target_os = "linux")]

use std::os::unix::io::RawFd;

// ── Event type constants ─────────────────────────────────────────────────
//
// From `enum uhid_event_type` in <linux/uhid.h>. We only need a handful.
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

// ── Size limits ──────────────────────────────────────────────────────────

/// `UHID_DATA_MAX` from <linux/uhid.h>. Maximum size of a single HID report
/// (input/output/feature) plus its 1-byte report ID prefix.
pub const UHID_DATA_MAX: usize = 4096;

/// `UHID_CREATE2_NAME_MAX` from <linux/uhid.h>. Includes the trailing NUL.
pub const UHID_CREATE2_NAME_MAX: usize = 128;

/// `phys` / `uniq` size from <linux/uhid.h> struct `uhid_create2_req`.
pub const UHID_DEVICE2_CLASS_MAX: usize = 64;

// ── Request structs ──────────────────────────────────────────────────────
//
// `#[repr(C)]` is mandatory — these are written verbatim to `/dev/uhid` and
// the kernel reads them with the same C layout.

/// `struct uhid_create2_req` — sent to create a virtual HID device.
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

/// `struct uhid_input2_req` — sent to inject an input report into the host.
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

/// `struct uhid_output_req` — received when the host writes an output
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

/// `union uhid_event.u` — the variable-size arm of `struct uhid_event`.
///
/// Modelled as a Rust union; only one arm is active at a time. The kernel
/// picks which arm to read based on the `type` field in the parent struct.
/// The union's size is the size of its largest arm (`UhidCreate2Req`).
#[repr(C, packed)]
pub union UhidEventUnion {
    pub create2: UhidCreate2Req,
    pub input2: UhidInput2Req,
    pub output: UhidOutputReq,
}

/// `struct uhid_event` — the top-level envelope written to / read from
/// `/dev/uhid`. Layout: 4-byte type tag followed by the union.
#[repr(C, packed)]
pub struct UhidEvent {
    /// `__u32 type` from <linux/uhid.h>.
    pub type_: u32,
    /// The active arm depends on `type_`.
    pub u: UhidEventUnion,
}

/// Total size of a `uhid_event` as the kernel expects to read/write it.
/// This matches `sizeof(struct uhid_event)` in C — the kernel reads this
/// exact number of bytes per syscall.
pub const UHID_EVENT_SIZE: usize = std::mem::size_of::<UhidEvent>();

// Compile-time check: kernel's sizeof(struct uhid_event) = 4 + 128+64+64+2+2+4+4+4+4+4096 = 4376
const _: () = assert!(UHID_EVENT_SIZE == 4376, "UHID_EVENT_SIZE mismatch with kernel ABI");

// ── Syscall helpers ──────────────────────────────────────────────────────

/// Open `/dev/uhid` for read+write. Requires write permission — either
/// root or a udev rule granting access to the calling user/group.
///
/// Returns the raw fd on success. Caller is responsible for `close(2)`.
pub fn open_uhid() -> std::io::Result<RawFd> {
    // O_RDWR = 0o2; we don't need O_CLOEXEC because the process is single-
    // purpose and won't fork+exec while the fd is open.
    let fd = unsafe { libc::open(b"/dev/uhid\0".as_ptr() as *const _, libc::O_RDWR) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(fd)
}

/// Write a `uhid_event` to the fd. Returns the number of bytes written
/// (always `UHID_EVENT_SIZE` on success).
pub fn write_event(fd: RawFd, event: &UhidEvent) -> std::io::Result<usize> {
    let written = unsafe {
        libc::write(
            fd,
            event as *const UhidEvent as *const std::ffi::c_void,
            UHID_EVENT_SIZE,
        )
    };
    if written < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(written as usize)
}

/// Read a `uhid_event` from the fd. Blocks until an event is available.
pub fn read_event(fd: RawFd, event: &mut UhidEvent) -> std::io::Result<usize> {
    let n = unsafe {
        libc::read(
            fd,
            event as *mut UhidEvent as *mut std::ffi::c_void,
            UHID_EVENT_SIZE,
        )
    };
    if n < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(n as usize)
}

// ── Event constructors ───────────────────────────────────────────────────

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

    // Build the create2 arm directly so we don't need to touch the union
    // through conflicting references.
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

    // Wrap into the union — this is the only place we initialize the
    // union, and Rust is happy with a single in-place assignment.
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

/// Build a `UHID_DESTROY` event. The kernel will tear down the virtual
/// device and emit a final `UHID_STOP` event back to userspace.
pub fn build_destroy_event() -> UhidEvent {
    // For UHID_DESTROY the kernel doesn't read any union field, so we
    // initialize with the smallest arm (input2) and zero it.
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

// ── Reader helpers ───────────────────────────────────────────────────────

/// Parse the variable-length payload of a `UHID_OUTPUT` event (host →
/// device output report) into a borrowed byte slice.
///
/// Returned slice points into the event's own `u.output.data` buffer and
/// is valid for as long as the event is.
pub fn output_event_payload(event: &UhidEvent) -> Option<&[u8]> {
    if event.type_ != UHID_OUTPUT {
        return None;
    }
    // SAFETY: we just checked the type tag, so the output arm is active.
    let output = unsafe { &event.u.output };
    let size = output.size as usize;
    if size > UHID_DATA_MAX {
        return None;
    }
    Some(&output.data[..size])
}
