//! `uhid-mock` — virtual HID device mocker for FF-WebHID E2E tests.
//!
//! Creates a `/dev/uhid`-backed virtual HID device, then reads JSON commands
//! from stdin to inject input reports / destroy the device. Output events
//! from the kernel (host → device output reports, get_report queries) are
//! echoed as JSON on stdout so tests can assert on them.
//!
//! Linux-only. On other platforms the binary exits with code 1 and a
//! friendly message.
//!
//! See `README.md` for usage examples.

#![cfg_attr(not(target_os = "linux"), allow(dead_code, unused_imports))]

use std::io::Write;

#[cfg(target_os = "linux")]
mod uhid;

#[cfg(target_os = "linux")]
use anyhow::Context as _;

// ── Non-Linux stub ───────────────────────────────────────────────────────

#[cfg(not(target_os = "linux"))]
fn main() -> std::process::ExitCode {
    eprintln!("uhid-mock requires Linux (/dev/uhid kernel interface).");
    eprintln!("On macOS/Windows, run E2E tests against real hardware or skip them.");
    std::process::ExitCode::from(1)
}

// ── Linux main ───────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
fn main() -> std::process::ExitCode {
    match try_main() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e:#}");
            std::process::ExitCode::from(1)
        }
    }
}

#[cfg(target_os = "linux")]
fn try_main() -> anyhow::Result<()> {
    let args = parse_args()?;
    match args.command {
        Command::Spawn(opts) => run_spawn(opts),
    }
}

// ── CLI parsing ──────────────────────────────────────────────────────────
//
// Hand-rolled to avoid pulling in clap (matches the rest of the workspace,
// which has zero CLI deps). Supports only the few flags we need.

#[cfg(target_os = "linux")]
struct Args {
    command: Command,
}

#[cfg(target_os = "linux")]
enum Command {
    Spawn(SpawnOpts),
}

#[cfg(target_os = "linux")]
struct SpawnOpts {
    vid: u16,
    pid: u16,
    name: String,
    descriptor_path: String,
    usage_page: Option<u16>,
    usage: Option<u16>,
    bus: u16,
    version: u16,
    country: u8,
}

#[cfg(target_os = "linux")]
fn parse_args() -> anyhow::Result<Args> {
    let mut argv = std::env::args().skip(1);
    let sub = argv.next().unwrap_or_default();

    if matches!(sub.as_str(), "-h" | "--help" | "help") {
        print_usage();
        std::process::exit(0);
    }
    if sub != "spawn" {
        anyhow::bail!("unknown subcommand '{sub}'. Expected: spawn. See --help.");
    }

    let mut vid: Option<u16> = None;
    let mut pid: Option<u16> = None;
    let mut name = String::new();
    let mut descriptor_path = String::new();
    let mut usage_page: Option<u16> = None;
    let mut usage: Option<u16> = None;
    let mut bus: u16 = 0x03;
    let mut version: u16 = 0;
    let mut country: u8 = 0;

    while let Some(flag) = argv.next() {
        let val = argv.next().ok_or_else(|| {
            anyhow::anyhow!("flag '{flag}' requires a value")
        })?;
        match flag.as_str() {
            "--vid" | "-v" => {
                vid = Some(parse_u16(&val).context("--vid")?);
            }
            "--pid" | "-p" => {
                pid = Some(parse_u16(&val).context("--pid")?);
            }
            "--name" | "-n" => {
                name = val;
            }
            "--descriptor" | "-d" => {
                descriptor_path = val;
            }
            "--usage-page" => {
                usage_page = Some(parse_u16(&val).context("--usage-page")?);
            }
            "--usage" => {
                usage = Some(parse_u16(&val).context("--usage")?);
            }
            "--bus" => {
                bus = parse_u16(&val).context("--bus")?;
            }
            "--version" => {
                version = parse_u16(&val).context("--version")?;
            }
            "--country" => {
                country = parse_u8(&val).context("--country")?;
            }
            other => anyhow::bail!("unknown flag '{other}'"),
        }
    }

    let vid = vid.ok_or_else(|| anyhow::anyhow!("--vid is required"))?;
    let pid = pid.ok_or_else(|| anyhow::anyhow!("--pid is required"))?;
    if descriptor_path.is_empty() {
        anyhow::bail!("--descriptor is required");
    }
    if name.is_empty() {
        name = format!("uhid-mock {:04x}:{:04x}", vid, pid);
    }

    Ok(Args {
        command: Command::Spawn(SpawnOpts {
            vid,
            pid,
            name,
            descriptor_path,
            usage_page,
            usage,
            bus,
            version,
            country,
        }),
    })
}

#[cfg(target_os = "linux")]
fn parse_u16(s: &str) -> anyhow::Result<u16> {
    let s = s.trim();
    if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        u16::from_str_radix(hex, 16).map_err(|e| anyhow::anyhow!("invalid hex u16 '{s}': {e}"))
    } else {
        s.parse::<u16>().map_err(|e| anyhow::anyhow!("invalid u16 '{s}': {e}"))
    }
}

#[cfg(target_os = "linux")]
fn parse_u8(s: &str) -> anyhow::Result<u8> {
    let s = s.trim();
    if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        u8::from_str_radix(hex, 16).map_err(|e| anyhow::anyhow!("invalid hex u8 '{s}': {e}"))
    } else {
        s.parse::<u8>().map_err(|e| anyhow::anyhow!("invalid u8 '{s}': {e}"))
    }
}

#[cfg(target_os = "linux")]
fn print_usage() {
    eprintln!("uhid-mock — virtual HID device mocker (Linux only)");
    eprintln!();
    eprintln!("USAGE:");
    eprintln!("  uhid-mock spawn --vid <VID> --pid <PID> --descriptor <PATH> [OPTIONS]");
    eprintln!();
    eprintln!("REQUIRED:");
    eprintln!("  --vid, -v <NUM>            USB Vendor ID (decimal or 0x-prefixed hex)");
    eprintln!("  --pid, -p <NUM>            USB Product ID");
    eprintln!("  --descriptor, -d <PATH>    Path to binary HID report descriptor");
    eprintln!();
    eprintln!("OPTIONAL:");
    eprintln!("  --name, -n <STRING>        Device name (default: 'uhid-mock VID:PID')");
    eprintln!("  --usage-page <NUM>         Top-level usage page (informational only)");
    eprintln!("  --usage <NUM>              Top-level usage (informational only)");
    eprintln!("  --bus <NUM>                Bus type (default: 0x03 = USB)");
    eprintln!("  --version <NUM>            bcdDevice version (default: 0)");
    eprintln!("  --country <NUM>            HID country code (default: 0)");
    eprintln!();
    eprintln!("VALUES accept decimal or 0x-prefixed hex (e.g. 0x3554 = 13652).");
    eprintln!();
    eprintln!("After spawning, the binary reads JSON commands from stdin, one per line:");
    eprintln!("  {{\"cmd\":\"input\",\"reportId\":1,\"data\":[171,187,204]}}");
    eprintln!("  {{\"cmd\":\"input\",\"data\":[171,187,204]}}  (non-numbered report)");
    eprintln!("  {{\"cmd\":\"destroy\"}}");
    eprintln!("  {{\"cmd\":\"ping\"}}");
    eprintln!();
    eprintln!("Kernel events (UHID_OUTPUT etc.) are echoed to stdout as JSON.");
    eprintln!("On stdin EOF, the device is destroyed and the process exits.");
}

// ── Spawn + event loop (single-threaded, poll-based) ─────────────────────
//
// We use a single-threaded poll() loop that multiplexes between the uhid fd
// and stdin.  This avoids the "reader thread stuck on blocking read" problem
// that arises when the kernel's hid_add_device() workqueue is slow to run:
// the process can still accept stdin commands (including destroy) and exit
// cleanly without waiting for UHID_START.

#[cfg(target_os = "linux")]
fn run_spawn(opts: SpawnOpts) -> anyhow::Result<()> {
    let rd = std::fs::read(&opts.descriptor_path)
        .with_context(|| format!("failed to read descriptor at {}", opts.descriptor_path))?;
    log::info!(
        "loaded {} bytes of report descriptor from {}",
        rd.len(),
        opts.descriptor_path
    );

    let fd = uhid::open_uhid()
        .context("failed to open /dev/uhid (are you root or in a group with write access?)")?;

    let create = uhid::build_create_event(
        &opts.name,
        &rd,
        opts.vid,
        opts.pid,
        opts.version,
        opts.country,
        opts.bus,
    )?;
    uhid::write_event(fd, &create).context("UHID_CREATE2 write failed")?;
    log::info!(
        "created virtual device: VID={:#06x} PID={:#06x} name='{}' rd={}B",
        opts.vid,
        opts.pid,
        opts.name,
        rd.len()
    );

    // Emit ready immediately — UHID_START may arrive later (kernel workqueue).
    emit_stdout(&serde_json::json!({
        "event": "ready",
        "vid": opts.vid,
        "pid": opts.pid,
        "name": opts.name,
        "usagePage": opts.usage_page,
        "usage": opts.usage,
    }));

    // Set stdin to non-blocking so poll() can drive both fds.
    let stdin_fd = libc::STDIN_FILENO;
    let stdin_flags = unsafe { libc::fcntl(stdin_fd, libc::F_GETFL) };
    if stdin_flags < 0 {
        anyhow::bail!("fcntl(F_GETFL) on stdin failed: {}", std::io::Error::last_os_error());
    }
    if unsafe { libc::fcntl(stdin_fd, libc::F_SETFL, stdin_flags | libc::O_NONBLOCK) } < 0 {
        anyhow::bail!("fcntl(F_SETFL, O_NONBLOCK) on stdin failed: {}", std::io::Error::last_os_error());
    }

    let mut stdin_buf = Vec::new();
    let mut done = false;
    let mut uhid_error_count = 0;

    while !done {
        let mut pfds = [
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
        ];

        let ret = unsafe { libc::poll(pfds.as_mut_ptr(), 2, -1) };
        if ret < 0 {
            let err = std::io::Error::last_os_error();
            if err.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            anyhow::bail!("poll failed: {err}");
        }

        let uhid_revents = pfds[0].revents;

        // ── uhid fd error (POLLERR/POLLHUP/POLLNVAL) ──────────────────────
        // The kernel sets these when the virtual device has been destroyed
        // internally (a kernel bug on some Zen kernels after repeated
        // open/close cycles).  Exit cleanly so the test runner knows the
        // device is dead and can restart us.
        if uhid_revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
            uhid_error_count += 1;
            emit_stdout(&serde_json::json!({
                "event": "uhid_error",
                "revents": uhid_revents,
                "count": uhid_error_count,
            }));
            if uhid_error_count >= 3 {
                log::error!(
                    "uhid fd entered error state (revents={}) after {}/3 checks; exiting",
                    uhid_revents,
                    uhid_error_count,
                );
                break;
            }
            log::warn!(
                "uhid fd error (revents={}) check {}/3 — will pause before retry",
                uhid_revents,
                uhid_error_count,
            );
            std::thread::sleep(std::time::Duration::from_millis(200));
            continue;
        }

        if uhid_revents & libc::POLLIN != 0 {
            if let Err(e) = poll_read_uhid_event(fd) {
                log::warn!("uhid read error: {e:#}");
                break;
            }
        }

        let stdin_revents = pfds[1].revents;

        // stdin EOF or error
        if stdin_revents & (libc::POLLIN | libc::POLLHUP) != 0 {
            if stdin_revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
                log::info!("stdin closed, destroying device");
                break;
            }
            let n = poll_read_stdin(&mut stdin_buf)?;
            if n == 0 {
                log::info!("stdin EOF, destroying device");
                break;
            }
            done = poll_process_stdin(fd, &mut stdin_buf)?;
        }
    }

    // Cleanup — best-effort destroy, then let the process exit.
    let _ = uhid::write_event(fd, &uhid::build_destroy_event());
    unsafe { libc::close(fd) };
    Ok(())
}

#[cfg(target_os = "linux")]
fn poll_read_uhid_event(fd: std::os::unix::io::RawFd) -> anyhow::Result<()> {
    use uhid::*;
    let mut event = UhidEvent {
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
    };

    let n = read_event(fd, &mut event)
        .context("read_event failed")?;
    let kind = event.type_;

    match kind {
        UHID_START => emit_stdout(&serde_json::json!({"event": "uhid_start"})),
        UHID_STOP => emit_stdout(&serde_json::json!({"event": "uhid_stop"})),
        UHID_OPEN => emit_stdout(&serde_json::json!({"event": "uhid_open"})),
        UHID_CLOSE => emit_stdout(&serde_json::json!({"event": "uhid_close"})),
        UHID_OUTPUT => {
            if let Some(payload) = output_event_payload(&event) {
                emit_stdout(&serde_json::json!({
                    "event": "output_report",
                    "data": payload,
                }));
            }
        }
        UHID_GET_REPORT => {
            let rid = get_report_request_id(&event);
            emit_stdout(&serde_json::json!({
                "event": "get_report",
                "id": rid,
            }));
            let reply = build_get_report_reply_event(rid);
            if let Err(e) = write_event(fd, &reply) {
                log::warn!("get_report reply write failed: {e:#}");
            }
        }
        UHID_SET_REPORT => {
            let rid = get_report_request_id(&event);
            emit_stdout(&serde_json::json!({
                "event": "set_report",
                "id": rid,
            }));
            let reply = build_set_report_reply_event(rid);
            if let Err(e) = write_event(fd, &reply) {
                log::warn!("set_report reply write failed: {e:#}");
            }
        }
        other => {
            emit_stdout(&serde_json::json!({
                "event": "unknown",
                "type": other,
            }));
        }
    }

    log::info!("uhid event: type={kind} n={n}");
    Ok(())
}

#[cfg(target_os = "linux")]
fn poll_read_stdin(buf: &mut Vec<u8>) -> anyhow::Result<usize> {
    let mut tmp = [0u8; 4096];
    let n = loop {
        let r = unsafe {
            libc::read(libc::STDIN_FILENO, tmp.as_mut_ptr() as *mut std::ffi::c_void, tmp.len())
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
#[cfg(target_os = "linux")]
fn poll_process_stdin(fd: std::os::unix::io::RawFd, buf: &mut Vec<u8>) -> anyhow::Result<bool> {
    loop {
        let newline = match buf.iter().position(|&b| b == b'\n') {
            Some(pos) => pos,
            None => return Ok(false),
        };

        let raw = std::str::from_utf8(&buf[..newline])
            .context("stdin is not valid UTF-8")?
            .trim()
            .to_owned();

        buf.drain(..=newline);

        if raw.is_empty() {
            continue;
        }

        match handle_command(fd, &raw) {
            Ok(CmdResult::Continue) => {}
            Ok(CmdResult::Destroy) => return Ok(true),
            Err(e) => {
                emit_stdout(&serde_json::json!({
                    "event": "error",
                    "error": format!("{e:#}"),
                }));
            }
        }
    }
}

#[cfg(target_os = "linux")]
enum CmdResult {
    Continue,
    Destroy,
}

#[cfg(target_os = "linux")]
fn handle_command(fd: std::os::unix::io::RawFd, line: &str) -> anyhow::Result<CmdResult> {
    #[derive(serde::Deserialize)]
    #[serde(tag = "cmd")]
    enum Cmd {
        #[serde(rename = "input")]
        Input {
            #[serde(rename = "reportId")]
            report_id: Option<u8>,
            data: Option<Vec<u8>>,
        },
        #[serde(rename = "destroy")]
        Destroy,
        #[serde(rename = "ping")]
        Ping,
    }

    let cmd: Cmd = serde_json::from_str(line).context("failed to parse JSON command")?;
    match cmd {
        Cmd::Input { report_id, data } => {
            let payload = match (report_id, data) {
                (Some(rid), Some(mut d)) => {
                    let mut buf = Vec::with_capacity(1 + d.len());
                    buf.push(rid);
                    buf.append(&mut d);
                    buf
                }
                (Some(rid), None) => vec![rid],
                (None, Some(d)) => d,
                (None, None) => Vec::new(),
            };
            if payload.is_empty() {
                anyhow::bail!("input command requires either reportId or data");
            }
            let event = uhid::build_input_event(&payload)?;
            uhid::write_event(fd, &event).context("UHID_INPUT2 write failed")?;
            emit_stdout(&serde_json::json!({
                "event": "input_sent",
                "reportId": report_id.unwrap_or(0),
                "size": payload.len(),
            }));
        }
        Cmd::Destroy => {
            return Ok(CmdResult::Destroy);
        }
        Cmd::Ping => {
            emit_stdout(&serde_json::json!({"event": "pong"}));
        }
    }
    Ok(CmdResult::Continue)
}

#[cfg(target_os = "linux")]
fn emit_stdout(value: &serde_json::Value) {
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{}", value);
    let _ = stdout.flush();
}
