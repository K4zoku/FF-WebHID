//! Thin byte forwarder between Firefox native-messaging stdin/stdout and the
//! webhid-daemon Unix domain socket.
//!
//! All protocol intelligence lives in the daemon (which speaks `NmRequest` /
//! `NmResponse` directly), so this binary is a pure pipe:
//!
//! ```text
//!   Firefox addon                  webhid-daemon
//!   (stdin)  ──► length-prefixed ──► (socket)
//!   (stdout) ◄── length-prefixed ◄── (socket)
//! ```
//!
//! The only logic here is retrying the daemon socket connection with
//! exponential backoff.

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader, BufWriter};

const MAX_FRAME_SIZE: usize = 1024 * 1024;
const CONNECT_TIMEOUT_MS: u64 = 5000;

/// Write a JSON error frame to the NM host's stdout (→ addon).
/// Format: `{"s":503,"E":"<msg>"}`: addon's `port.onMessage` receives it,
/// logs the error, and the pending request (if any) gets rejected.
async fn write_error_frame<W: AsyncWrite + Unpin>(w: &mut W, msg: &str) {
    let frame = serde_json::json!({"s": 503, "E": msg});
    let json = serde_json::to_vec(&frame).unwrap_or_default();
    let len = (json.len() as u32).to_le_bytes();
    let _ = w.write_all(&len).await;
    let _ = w.write_all(&json).await;
    let _ = w.flush().await;
}

#[cfg(target_os = "linux")]
const DEFAULT_SOCKET: &str = "/run/webhid/webhid.sock";
#[cfg(target_os = "macos")]
const DEFAULT_SOCKET: &str = "/tmp/webhid.sock";

#[cfg(unix)]
fn candidate_sockets() -> Vec<String> {
    if let Ok(path) = std::env::var("WEBHID_SOCKET") {
        return vec![path];
    }
    let mut candidates = Vec::new();
    #[cfg(target_os = "linux")]
    {
        let xdg = std::env::var("XDG_RUNTIME_DIR")
            .ok()
            .filter(|d| !d.is_empty());
        match xdg {
            Some(d) => candidates.push(format!("{d}/webhid/webhid.sock")),
            None => {
                let uid = unsafe { libc::getuid() };
                candidates.push(format!("/run/user/{uid}/webhid/webhid.sock"));
            }
        }
    }
    candidates.push(DEFAULT_SOCKET.to_string());
    candidates
}

#[cfg(target_os = "windows")]
const DEFAULT_PIPE: &str = r"\\.\pipe\webhid";

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    if std::env::args().any(|a| a == "--version" || a == "-V") {
        eprintln!("webhid-native-messaging {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }

    webhid::logging::init_logger();

    #[cfg(unix)]
    let daemon = {
        use tokio::net::UnixStream;
        let candidates = candidate_sockets();
        let mut delay = 100u64;
        let mut total_waited = 0u64;
        let (stream, connected_path) = loop {
            let mut last_err = None;
            let matched = 'candidates: {
                for path in &candidates {
                    match UnixStream::connect(path).await {
                        Ok(s) => break 'candidates Some((s, path.clone())),
                        Err(e) => last_err = Some(e),
                    }
                }
                None
            };
            if let Some((s, p)) = matched {
                break (s, p);
            }
            let last_err = last_err.unwrap();
            if total_waited >= CONNECT_TIMEOUT_MS {
                let msg = format!(
                    "cannot connect to webhid-daemon (tried {}): {last_err}\n\
                     Check: (1) daemon running? systemctl status webhid-daemon\n\
                     (2) socket path correct? (3) user in webhid group? sudo usermod -aG webhid $USER",
                    candidates.join(", "),
                );
                log::error!("{msg}");
                let mut stdout = tokio::io::stdout();
                write_error_frame(&mut stdout, &msg).await;
                return Err(anyhow::anyhow!(msg));
            }
            log::warn!("daemon connect failed ({last_err}), retry in {delay}ms");
            tokio::time::sleep(tokio::time::Duration::from_millis(delay)).await;
            total_waited += delay;
            delay = (delay * 2).min(2000);
        };
        log::info!("connected to daemon at {connected_path}");
        stream
    };

    #[cfg(windows)]
    let daemon = {
        use tokio::net::windows::named_pipe::ClientOptions;
        let pipe_name = std::env::var("WEBHID_PIPE").unwrap_or_else(|_| DEFAULT_PIPE.to_string());
        let mut delay = 100u64;
        let mut total_waited = 0u64;
        let stream = loop {
            match ClientOptions::new().open(&pipe_name) {
                Ok(s) => break s,
                Err(e) => {
                    if total_waited >= CONNECT_TIMEOUT_MS {
                        let msg = format!(
                            "cannot connect to daemon pipe '{pipe_name}' after retries: {e}\n\
                             Check: (1) daemon running? (2) pipe name correct?",
                        );
                        log::error!("{msg}");
                        let mut stdout = tokio::io::stdout();
                        write_error_frame(&mut stdout, &msg).await;
                        return Err(anyhow::anyhow!(msg));
                    }
                    log::warn!("daemon connect failed ({e}), retry in {delay}ms");
                    tokio::time::sleep(tokio::time::Duration::from_millis(delay)).await;
                    total_waited += delay;
                    delay = (delay * 2).min(2000);
                }
            }
        };
        log::info!("connected to daemon at {pipe_name}");
        stream
    };

    #[cfg(not(any(unix, windows)))]
    let daemon = {
        return Err(anyhow::anyhow!("IPC not supported on this platform"));
    };

    let (daemon_r, daemon_w) = tokio::io::split(daemon);
    let mut daemon_r = BufReader::new(daemon_r);
    let mut daemon_w = BufWriter::new(daemon_w);

    let mut stdin = BufReader::new(tokio::io::stdin());
    let mut stdout = BufWriter::with_capacity(256 * 1024, tokio::io::stdout());

    // ── stdin → daemon ───────────────────────────────────────────────────
    let forward_to_daemon = tokio::spawn(async move {
        let mut buf = Vec::with_capacity(4096);
        loop {
            match read_frame(&mut stdin, &mut buf).await {
                Ok(false) => break, // EOF
                Ok(true) => {}
                Err(e) => {
                    log::info!("stdin read error: {e}");
                    break;
                }
            }
            let len = u32::try_from(buf.len()).unwrap_or(0).to_le_bytes();
            let len_io = std::io::IoSlice::new(&len);
            let buf_io = std::io::IoSlice::new(&buf);
            if let Err(e) = daemon_w.write_vectored(&[len_io, buf_io]).await {
                log::warn!("daemon write error: {e}");
                break;
            }
            if let Err(e) = daemon_w.flush().await {
                log::warn!("daemon flush error: {e}");
                break;
            }
        }
        log::debug!("stdin → daemon forwarder exited");
    });

    // ── daemon → stdout ──────────────────────────────────────────────────
    let forward_to_stdout = tokio::spawn(async move {
        let mut buf = Vec::with_capacity(4096);
        loop {
            match read_frame(&mut daemon_r, &mut buf).await {
                Ok(false) => break,
                Ok(true) => {}
                Err(e) => {
                    log::warn!("daemon read error: {e}");
                    break;
                }
            }
            let len = u32::try_from(buf.len()).unwrap_or(0).to_le_bytes();
            let len_io = std::io::IoSlice::new(&len);
            let buf_io = std::io::IoSlice::new(&buf);
            if let Err(e) = stdout.write_vectored(&[len_io, buf_io]).await {
                log::warn!("stdout write error: {e}");
                break;
            }
            if let Err(e) = stdout.flush().await {
                log::warn!("stdout flush error: {e}");
                break;
            }
        }
        log::debug!("daemon → stdout forwarder exited");
    });

    tokio::select! {
        _ = forward_to_daemon => {},
        _ = forward_to_stdout => {},
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Raw length-prefixed frame helpers
// ---------------------------------------------------------------------------

/// Read a single length-prefixed frame into `buf`.
///
/// Returns:
/// - `Ok(true)`  – a frame was read
/// - `Ok(false)` – clean EOF
/// - `Err(_)`    – I/O error
async fn read_frame<R: AsyncRead + Unpin>(
    reader: &mut R,
    buf: &mut Vec<u8>,
) -> anyhow::Result<bool> {
    let mut len_bytes = [0u8; 4];
    match reader.read_exact(&mut len_bytes).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(false),
        Err(e) => return Err(e.into()),
    }

    let len = u32::from_le_bytes(len_bytes) as usize;
    if len > MAX_FRAME_SIZE {
        return Err(anyhow::anyhow!("frame too large: {len} bytes"));
    }
    buf.resize(len, 0);
    reader.read_exact(buf).await?;
    Ok(true)
}
