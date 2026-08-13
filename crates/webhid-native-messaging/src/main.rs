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

use webhid::protocol::MAX_NM_FRAME;

const CONNECT_TIMEOUT_MS: u64 = 5000;

/// Write a JSON error frame to the NM host's stdout (→ addon). Format: `{"s":503,"E":"<msg>"}`.
async fn write_error_frame<W: AsyncWrite + Unpin>(w: &mut W, msg: &str) {
    let frame = serde_json::json!({"s": 503, "E": msg});
    let json = serde_json::to_vec(&frame).unwrap_or_default();
    let len = (json.len() as u32).to_le_bytes();
    let _ = w.write_all(&len).await;
    let _ = w.write_all(&json).await;
    let _ = w.flush().await;
}

#[cfg(target_os = "linux")]
async fn connect_abstract(name: &str) -> std::io::Result<tokio::net::UnixStream> {
    use std::os::linux::net::SocketAddrExt;
    use std::os::unix::net::SocketAddr;
    let name = name.to_string();
    tokio::task::spawn_blocking(move || {
        let addr = SocketAddr::from_abstract_name(name.as_bytes())?;
        let stream = std::os::unix::net::UnixStream::connect_addr(&addr)?;
        stream.set_nonblocking(true)?;
        tokio::net::UnixStream::from_std(stream)
    })
    .await?
}

#[cfg(unix)]
async fn connect_to_path(path: &str) -> std::io::Result<tokio::net::UnixStream> {
    if let Some(rest) = path.strip_prefix('@') {
        #[cfg(target_os = "linux")]
        {
            connect_abstract(rest).await
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = rest;
            Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "abstract sockets not supported on this platform",
            ))
        }
    } else {
        tokio::net::UnixStream::connect(path).await
    }
}

#[cfg(unix)]
fn candidate_sockets() -> Vec<String> {
    webhid::socket_path::forwarder_socket_candidates()
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    if std::env::args().any(|a| a == "--version" || a == "-V") {
        eprintln!("webhid-native-messaging {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }

    webhid::logging::init_logger();
    apply_hardening();

    let daemon = connect_to_daemon().await?;
    run_forwarders(daemon).await
}

/// Apply prctl + seccomp hardening (Linux release builds with the
/// `hardening` feature; no-op everywhere else).
#[cfg(feature = "hardening")]
fn apply_hardening() {
    webhid::security::apply_prctl_hardening();
    webhid::security::apply_seccomp_filter(webhid::security::NM_SYSCALLS);
}

#[cfg(not(feature = "hardening"))]
fn apply_hardening() {}

/// Retry `connect` with exponential backoff until `CONNECT_TIMEOUT_MS`
/// elapses. On timeout, writes an error frame to stdout (so the addon sees
/// it) and errors out.
async fn connect_with_retry<C, F, S>(target: &str, hint: &str, mut connect: C) -> anyhow::Result<S>
where
    C: FnMut() -> F,
    F: std::future::Future<Output = std::io::Result<S>>,
{
    let mut delay = 100u64;
    let mut total_waited = 0u64;
    loop {
        match connect().await {
            Ok(s) => return Ok(s),
            Err(e) => {
                if total_waited >= CONNECT_TIMEOUT_MS {
                    let msg = format!("cannot connect to {target}: {e}\n{hint}");
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
    }
}

/// Connect to the daemon socket, retrying every candidate path with
/// exponential backoff until `CONNECT_TIMEOUT_MS` elapses.
#[cfg(unix)]
async fn connect_to_daemon() -> anyhow::Result<tokio::net::UnixStream> {
    let candidates = candidate_sockets();
    connect_with_retry(
        &format!("webhid-daemon (tried {})", candidates.join(", ")),
        "Check: (1) daemon running? systemctl status webhid-daemon\n\
         (2) socket path correct? (3) user in webhid group? sudo usermod -aG webhid $USER",
        || async {
            let (s, path) = try_connect_candidates(&candidates).await?;
            log::info!("connected to daemon at {path}");
            Ok(s)
        },
    )
    .await
}

/// Try every candidate socket path once, returning the first success.
#[cfg(unix)]
async fn try_connect_candidates(
    candidates: &[String],
) -> std::io::Result<(tokio::net::UnixStream, String)> {
    let mut last_err = None;
    for path in candidates {
        match connect_to_path(path).await {
            Ok(s) => return Ok((s, path.clone())),
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.expect("candidate_sockets returned zero entries"))
}

/// Connect to the daemon named pipe, retrying with exponential backoff
/// until `CONNECT_TIMEOUT_MS` elapses. On timeout, writes an error frame to
/// stdout (so the addon sees it) and errors out.
#[cfg(windows)]
async fn connect_to_daemon() -> anyhow::Result<tokio::net::windows::named_pipe::NamedPipeClient> {
    use tokio::net::windows::named_pipe::ClientOptions;
    let pipe_name =
        std::env::var("WEBHID_PIPE").unwrap_or_else(|_| webhid::socket_path::PIPE.to_string());
    connect_with_retry(
        &format!("daemon pipe '{pipe_name}'"),
        "Check: (1) daemon running? (2) pipe name correct?",
        || {
            let pipe = pipe_name.clone();
            std::future::ready(ClientOptions::new().open(&pipe).map(|s| {
                log::info!("connected to daemon at {pipe}");
                s
            }))
        },
    )
    .await
}

#[cfg(not(any(unix, windows)))]
async fn connect_to_daemon() -> anyhow::Result<std::io::Empty> {
    Err(anyhow::anyhow!("IPC not supported on this platform"))
}

/// Split the daemon connection and run the two byte-forwarding directions
/// concurrently. Returns when either direction ends (the other is dropped,
/// which tears the process down after `main` returns).
async fn run_forwarders<S>(daemon: S) -> anyhow::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (daemon_r, daemon_w) = tokio::io::split(daemon);
    let daemon_r = BufReader::new(daemon_r);
    let daemon_w = BufWriter::new(daemon_w);

    let stdin = BufReader::new(tokio::io::stdin());
    let stdout = BufWriter::with_capacity(256 * 1024, tokio::io::stdout());

    let forward_to_daemon = tokio::spawn(forward_stdin_to_daemon(stdin, daemon_w));
    let forward_to_stdout = tokio::spawn(forward_daemon_to_stdout(daemon_r, stdout));

    tokio::select! {
        _ = forward_to_daemon => {},
        _ = forward_to_stdout => {},
    }

    Ok(())
}

/// Forward length-prefixed frames from the NM host's stdin to the daemon.
async fn forward_stdin_to_daemon<R, W>(mut stdin: R, mut daemon_w: W)
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buf = Vec::with_capacity(4096);
    loop {
        match read_frame(&mut stdin, &mut buf).await {
            Ok(false) => break,
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
}

/// Forward length-prefixed frames from the daemon to the NM host's stdout.
async fn forward_daemon_to_stdout<R, W>(mut daemon_r: R, mut stdout: W)
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
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
}

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
    if len > MAX_NM_FRAME {
        return Err(anyhow::anyhow!("frame too large: {len} bytes"));
    }
    buf.resize(len, 0);
    reader.read_exact(buf).await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_read_frame_normal() {
        let payload = b"hello";
        let mut frame = (payload.len() as u32).to_le_bytes().to_vec();
        frame.extend_from_slice(payload);
        let mut reader = &frame[..];
        let mut buf = Vec::new();
        let result = read_frame(&mut reader, &mut buf).await;
        assert!(result.is_ok());
        assert!(result.unwrap());
        assert_eq!(buf, payload);
    }

    #[tokio::test]
    async fn test_read_frame_eof() {
        let mut empty: &[u8] = &[];
        let mut buf = Vec::new();
        let result = read_frame(&mut empty, &mut buf).await;
        assert!(result.is_ok());
        assert!(!result.unwrap());
    }

    #[tokio::test]
    async fn test_read_frame_partial_header() {
        let mut partial: &[u8] = &[0x00, 0x01];
        let mut buf = Vec::new();
        let result = read_frame(&mut partial, &mut buf).await;
        assert!(result.is_ok());
        assert!(!result.unwrap());
    }

    #[tokio::test]
    async fn test_read_frame_too_large() {
        let oversized = (MAX_NM_FRAME as u32 + 1).to_le_bytes();
        let mut reader: &[u8] = &oversized;
        let mut buf = Vec::new();
        let result = read_frame(&mut reader, &mut buf).await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.to_string().contains("frame too large"));
    }

    #[tokio::test]
    async fn test_read_frame_max_size() {
        let mut frame = (MAX_NM_FRAME as u32).to_le_bytes().to_vec();
        frame.resize(4 + MAX_NM_FRAME, 0xAB);
        let mut reader: &[u8] = &frame;
        let mut buf = Vec::new();
        let result = read_frame(&mut reader, &mut buf).await;
        assert!(result.is_ok());
        assert!(result.unwrap());
        assert_eq!(buf.len(), MAX_NM_FRAME);
        assert_eq!(buf[0], 0xAB);
    }

    #[tokio::test]
    async fn test_read_frame_empty_payload() {
        let frame = 0u32.to_le_bytes();
        let mut reader: &[u8] = &frame;
        let mut buf = Vec::new();
        let result = read_frame(&mut reader, &mut buf).await;
        assert!(result.is_ok());
        assert!(result.unwrap());
        assert!(buf.is_empty());
    }

    #[tokio::test]
    async fn test_write_error_frame_format() {
        let mut output = Vec::new();
        write_error_frame(&mut output, "test error").await;
        assert!(output.len() >= 4, "should have length prefix");
        let json_len = u32::from_le_bytes([output[0], output[1], output[2], output[3]]) as usize;
        assert_eq!(output.len(), 4 + json_len);
        let json: serde_json::Value = serde_json::from_slice(&output[4..]).expect("valid JSON");
        assert_eq!(json["s"], 503);
        assert_eq!(json["E"], "test error");
    }

    #[tokio::test]
    async fn test_write_error_frame_empty_message() {
        let mut output = Vec::new();
        write_error_frame(&mut output, "").await;
        let json_len = u32::from_le_bytes([output[0], output[1], output[2], output[3]]) as usize;
        let json: serde_json::Value =
            serde_json::from_slice(&output[4..4 + json_len]).expect("valid JSON");
        assert_eq!(json["s"], 503);
        assert_eq!(json["E"], "");
    }

    #[cfg(unix)]
    #[test]
    fn test_candidate_sockets_env_handling() {
        unsafe { std::env::set_var("WEBHID_SOCKET", "/tmp/custom.sock") };
        let candidates = candidate_sockets();
        unsafe { std::env::remove_var("WEBHID_SOCKET") };
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0], "/tmp/custom.sock");

        let candidates = candidate_sockets();
        assert!(!candidates.is_empty());
        #[cfg(target_os = "linux")]
        assert_eq!(candidates.last().unwrap(), "/run/webhid/webhid.sock");
    }
}
