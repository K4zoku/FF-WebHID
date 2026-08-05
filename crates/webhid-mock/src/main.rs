//! `webhid-mock` — virtual HID device mocker for FF-WebHID E2E tests.
//!
//! Creates a virtual HID device backed by the OS's userspace HID interface,
//! then reads JSON commands from stdin to inject input reports / destroy the
//! device. Output events from the OS (host → device output reports,
//! get_report queries) are echoed as JSON on stdout so tests can assert on
//! them.
//!
//! Platform backends:
//!   - Linux: `/dev/uhid` kernel interface (`linux.rs`)
//!   - macOS: `IOHIDUserDevice` (`macos.rs`)
//!   - Windows: unsupported (no userspace virtual-HID interface exists;
//!     a kernel-mode VHF/KMDF driver would be required)
//!
//! See `README.md` for usage examples.

#![cfg_attr(target_os = "windows", allow(dead_code, unused_imports))]

#[cfg(not(target_os = "windows"))]
use std::io::Write;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;

#[cfg(not(target_os = "windows"))]
use anyhow::Context as _;

#[cfg(target_os = "windows")]
fn main() -> std::process::ExitCode {
    eprintln!("webhid-mock: Windows is not supported.");
    eprintln!("Windows has no userspace virtual-HID interface; creating a virtual HID");
    eprintln!("device requires a kernel-mode driver (Virtual HID Framework / KMDF) or a");
    eprintln!("signed third-party driver (vJoy, ViGEm), both out of scope for a test tool.");
    eprintln!(
        "Run E2E tests on Linux (/dev/uhid) or macOS (IOHIDUserDevice), or against real hardware."
    );
    std::process::ExitCode::from(1)
}

#[cfg(not(target_os = "windows"))]
fn main() -> std::process::ExitCode {
    match try_main() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e:#}");
            std::process::ExitCode::from(1)
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn try_main() -> anyhow::Result<()> {
    let args = parse_args()?;
    match args.command {
        Command::Spawn(opts) => run_spawn(opts),
    }
}

#[cfg(target_os = "linux")]
fn run_spawn(opts: SpawnOpts) -> anyhow::Result<()> {
    linux::run_spawn(opts)
}

#[cfg(target_os = "macos")]
fn run_spawn(opts: SpawnOpts) -> anyhow::Result<()> {
    macos::run_spawn(opts)
}

#[cfg(not(target_os = "windows"))]
struct Args {
    command: Command,
}

#[cfg(not(target_os = "windows"))]
enum Command {
    Spawn(SpawnOpts),
}

#[cfg(not(target_os = "windows"))]
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

#[cfg(not(target_os = "windows"))]
struct ArgState {
    vid: Option<u16>,
    pid: Option<u16>,
    name: String,
    descriptor_path: String,
    usage_page: Option<u16>,
    usage: Option<u16>,
    bus: u16,
    version: u16,
    country: u8,
}

#[cfg(not(target_os = "windows"))]
impl Default for ArgState {
    fn default() -> Self {
        ArgState {
            vid: None,
            pid: None,
            name: String::new(),
            descriptor_path: String::new(),
            usage_page: None,
            usage: None,
            bus: 0x03,
            version: 0,
            country: 0,
        }
    }
}

#[cfg(not(target_os = "windows"))]
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

    let mut state = ArgState::default();
    while let Some(flag) = argv.next() {
        let val = argv
            .next()
            .ok_or_else(|| anyhow::anyhow!("flag '{flag}' requires a value"))?;
        apply_flag(&mut state, &flag, val)?;
    }

    finish_args(state)
}

/// Apply one `--flag` to the parsed state. Every flag takes exactly one
/// value; `val` is that value.
#[cfg(not(target_os = "windows"))]
fn apply_flag(state: &mut ArgState, flag: &str, val: String) -> anyhow::Result<()> {
    match flag {
        "--vid" | "-v" => state.vid = Some(parse_u16(&val).context("--vid")?),
        "--pid" | "-p" => state.pid = Some(parse_u16(&val).context("--pid")?),
        "--name" | "-n" => state.name = val,
        "--descriptor" | "-d" => state.descriptor_path = val,
        "--usage-page" => state.usage_page = Some(parse_u16(&val).context("--usage-page")?),
        "--usage" => state.usage = Some(parse_u16(&val).context("--usage")?),
        "--bus" => state.bus = parse_u16(&val).context("--bus")?,
        "--version" => state.version = parse_u16(&val).context("--version")?,
        "--country" => state.country = parse_u8(&val).context("--country")?,
        other => anyhow::bail!("unknown flag '{other}'"),
    }
    Ok(())
}

/// Validate the parsed state and assemble the final `Args`.
#[cfg(not(target_os = "windows"))]
fn finish_args(state: ArgState) -> anyhow::Result<Args> {
    let vid = state
        .vid
        .ok_or_else(|| anyhow::anyhow!("--vid is required"))?;
    let pid = state
        .pid
        .ok_or_else(|| anyhow::anyhow!("--pid is required"))?;
    if state.descriptor_path.is_empty() {
        anyhow::bail!("--descriptor is required");
    }
    let name = if state.name.is_empty() {
        format!("webhid-mock {:04x}:{:04x}", vid, pid)
    } else {
        state.name
    };

    Ok(Args {
        command: Command::Spawn(SpawnOpts {
            vid,
            pid,
            name,
            descriptor_path: state.descriptor_path,
            usage_page: state.usage_page,
            usage: state.usage,
            bus: state.bus,
            version: state.version,
            country: state.country,
        }),
    })
}

#[cfg(not(target_os = "windows"))]
fn parse_u16(s: &str) -> anyhow::Result<u16> {
    let s = s.trim();
    if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        u16::from_str_radix(hex, 16).map_err(|e| anyhow::anyhow!("invalid hex u16 '{s}': {e}"))
    } else {
        s.parse::<u16>()
            .map_err(|e| anyhow::anyhow!("invalid u16 '{s}': {e}"))
    }
}

#[cfg(not(target_os = "windows"))]
fn parse_u8(s: &str) -> anyhow::Result<u8> {
    let s = s.trim();
    if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        u8::from_str_radix(hex, 16).map_err(|e| anyhow::anyhow!("invalid hex u8 '{s}': {e}"))
    } else {
        s.parse::<u8>()
            .map_err(|e| anyhow::anyhow!("invalid u8 '{s}': {e}"))
    }
}

#[cfg(not(target_os = "windows"))]
fn print_usage() {
    eprintln!("webhid-mock — virtual HID device mocker (Linux + macOS)");
    eprintln!();
    eprintln!("USAGE:");
    eprintln!("  webhid-mock spawn --vid <VID> --pid <PID> --descriptor <PATH> [OPTIONS]");
    eprintln!();
    eprintln!("REQUIRED:");
    eprintln!("  --vid, -v <NUM>            USB Vendor ID (decimal or 0x-prefixed hex)");
    eprintln!("  --pid, -p <NUM>            USB Product ID");
    eprintln!("  --descriptor, -d <PATH>    Path to binary HID report descriptor");
    eprintln!();
    eprintln!("OPTIONAL:");
    eprintln!("  --name, -n <STRING>        Device name (default: 'webhid-mock VID:PID')");
    eprintln!("  --usage-page <NUM>         Top-level usage page (informational only)");
    eprintln!("  --usage <NUM>              Top-level usage (informational only)");
    eprintln!("  --bus <NUM>                Bus type (default: 0x03 = USB; Linux only,");
    eprintln!("                             macOS maps 0x03→'USB', 0x05→'Bluetooth')");
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
    eprintln!("OS events (output reports, get/set report queries) are echoed to stdout");
    eprintln!("as JSON. On stdin EOF, the device is destroyed and the process exits.");
}

/// A spawned virtual HID device. Platform backends implement this in
/// `linux.rs` / `macos.rs`; the JSON command handler only needs input
/// injection, everything else (event echoing) is backend-specific.
#[cfg(not(target_os = "windows"))]
trait MockDevice {
    /// Inject an input report into the host. `payload` must already include
    /// the report ID as its first byte for numbered-report devices.
    fn send_input(&self, payload: &[u8]) -> anyhow::Result<()>;
}

#[cfg(not(target_os = "windows"))]
enum CmdResult {
    Continue,
    Destroy,
}

/// Handle one JSON command line. Shared by all platform event loops.
#[cfg(not(target_os = "windows"))]
fn handle_command(dev: &dyn MockDevice, line: &str) -> anyhow::Result<CmdResult> {
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
            dev.send_input(&payload)?;
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

/// Emit one JSON event line on stdout. Safe to call from multiple threads
/// (each call takes the stdout lock for the whole line).
#[cfg(not(target_os = "windows"))]
fn emit_stdout(value: &serde_json::Value) {
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{}", value);
    let _ = stdout.flush();
}
