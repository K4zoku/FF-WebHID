//! Bridge between the Firefox addon (native-messaging protocol on stdin/stdout)
//! and the webhid-daemon (IPC protocol on a Unix domain socket).
//!
//! Message flow
//! ============
//!
//! ```text
//!  Firefox addon
//!    │  stdin  (NmRequest, length-prefixed JSON)
//!    ▼
//!  [stdin reader]──►[nm_to_ipc]──►[daemon writer]──► webhid-daemon
//!                                                           │
//!  Firefox addon                                    IpcResponse
//!    ▲  stdout (NmResponse, length-prefixed JSON)           │
//!    │                                                      │
//!  [stdout writer]◄──[per-request waiter task]◄──[daemon reader]
//!                     id>0 → ipc_to_nm (response)
//!  [stdout writer]◄──────────────────────────────[daemon reader]
//!                     id=0 → ipc_event_to_nm (event)
//! ```
//!
//! The main loop reads one NM request at a time from stdin and forwards it
//! to the daemon, then spawns a per-request task that waits for the
//! matching daemon response and forwards it to the stdout writer.  This
//! decouples stdin reads from response waits, so a slow response never
//! blocks the next request.  A parallel daemon-reader task routes
//! unsolicited events (id=0) directly to the stdout channel.

use std::collections::HashMap;
use tokio::io::{AsyncWriteExt, BufReader, BufWriter};
use std::sync::Arc;

use tokio::sync::{Mutex, mpsc, oneshot};
use webhid::{IpcRequest, IpcResponse, NmRequest, NmResponse, protocol};

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

    init_logger();

    #[cfg(unix)]
    let (daemon_read, daemon_write) = {
        use tokio::net::UnixStream;
        let candidates = candidate_sockets();
        let mut delay = 100u64;
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
            if delay > 30000 {
                return Err(anyhow::anyhow!(
                    "cannot connect to webhid-daemon (tried {}) after retries: {last_err}",
                    candidates.join(", "),
                ));
            }
            log::warn!("daemon connect failed ({last_err}), retry in {delay}ms");
            tokio::time::sleep(tokio::time::Duration::from_millis(delay)).await;
            delay = (delay * 2).min(2000);
        };
        log::info!("connected to daemon at {connected_path}");
        stream.into_split()
    };

    #[cfg(windows)]
    let (daemon_read, daemon_write) = {
        use tokio::net::windows::named_pipe::ClientOptions;
        let pipe_name = std::env::var("WEBHID_PIPE")
            .unwrap_or_else(|_| DEFAULT_PIPE.to_string());
        let mut delay = 100u64;
        let stream = loop {
            match ClientOptions::new().open(&pipe_name) {
                Ok(s) => break s,
                Err(e) => {
                    if delay > 30000 {
                        return Err(anyhow::anyhow!("cannot connect to daemon pipe '{pipe_name}' after retries: {e}"));
                    }
                    log::warn!("daemon connect failed ({e}), retry in {delay}ms");
                    tokio::time::sleep(tokio::time::Duration::from_millis(delay)).await;
                    delay *= 2;
                    if delay > 2000 { delay = 2000; }
                }
            }
        };
        log::info!("connected to daemon at {pipe_name}");
        let (daemon_read, daemon_write) = tokio::io::split(stream);
        (daemon_read, daemon_write)
    };

    #[cfg(not(any(unix, windows)))]
    let (daemon_read, daemon_write) = {
        return Err(anyhow::anyhow!("IPC not supported on this platform"));
    };

    // Serialise all writes to stdout through one task.  We previously
    // batched up to 16 messages / 5ms before flushing, but that introduced
    // up to 5ms of latency per response under load; when combined
    // with the old sequential main loop it caused the roundtrip latency
    // to climb monotonically as the page sent requests faster than the
    // NM loop could drain them.  The stdout writer now flushes every
    // message as soon as it arrives (the BufWriter still coalesces
    // small writes at the kernel level via writev-style buffering).
    let (stdout_tx, mut stdout_rx) = mpsc::channel::<NmResponse>(1024);
    #[allow(unused_must_use)]
    let _stdout_writer = tokio::spawn(async move {
        let mut out = BufWriter::with_capacity(256 * 1024, tokio::io::stdout());
        while let Some(msg) = stdout_rx.recv().await {
            if let Err(e) = protocol::write_message(&mut out, &msg).await {
                log::error!("stdout write: {e}");
                break;
            }
            // Flush immediately so Firefox sees the response without
            // waiting for a batch timer.  BufWriter still amortises
            // the underlying write(2) syscalls.
            if let Err(e) = out.flush().await {
                log::error!("stdout flush: {e}");
                break;
            }
        }
        let _ = out.flush().await;
        Ok::<(), anyhow::Error>(())
    });

    // Pending request map: request_id → oneshot sender waiting for the reply.
    let pending: Arc<Mutex<HashMap<u32, oneshot::Sender<IpcResponse>>>> =
        Arc::new(Mutex::new(HashMap::new()));

    // Daemon reader task – demultiplexes responses and events.
    let pending_rx = Arc::clone(&pending);
    let stdout_tx_ev = stdout_tx.clone();
    let daemon_reader = tokio::spawn(async move {
        let mut reader = BufReader::new(daemon_read);
        loop {
            match protocol::read_message::<_, IpcResponse>(&mut reader).await {
                Ok(response) => {
                    log::debug!("[daemon_reader] received response: {:?}", response);
                    if response.id() == 0 {
                        if let Some(nm) = ipc_event_to_nm(response) {
                            log::debug!("[daemon_reader] forwarding event: {:?}", nm);
                            let _ = stdout_tx_ev.send(nm).await;
                        }
                    } else {
                        let sender = pending_rx.lock().await.remove(&response.id());
                        if let Some(tx) = sender {
                            let _ = tx.send(response);
                        }
                    }
                }
                Err(e) => {
                    log::warn!("daemon disconnected: {e}");
                    // Reject all pending requests so page callers don't hang.
                    let mut pending = pending_rx.lock().await;
                    let count = pending.len();
                    for (_, tx) in pending.drain() {
                        let _ = tx.send(IpcResponse::Error {
                            id: 0,
                            message: "daemon disconnected".to_string(),
                        });
                    }
                    log::info!("rejected {count} pending requests due to daemon disconnect");
                    break;
                }
            }
        }
    });

    // Protect the daemon write half with a mutex so both the main loop and
    // (in the future) any concurrent task can send without races.
    let daemon_writer = Arc::new(Mutex::new(BufWriter::new(daemon_write)));

    // Concurrent main loop.
    //
    // The previous implementation processed one request at a time:
    //   read stdin → send to daemon → await response → enqueue stdout → repeat
    // This blocked the loop while waiting for each response, so requests
    // piled up in the stdin buffer whenever the page sent them faster than
    // the daemon could reply (e.g. image upload with rapid sendReport
    // packets interleaved with input_report events).  The roundtrip latency
    // climbed monotonically as the queue grew.
    //
    // The new loop spawns a task per request so reads from stdin and
    // daemon writes are never blocked by an outstanding response.  The
    // `pending` map plus the daemon reader task demultiplex responses
    // back to the correct waiter.  The `stdout_tx` channel serialises
    // all writes to Firefox.
    let mut next_id: u32 = 1;
    let mut stdin = BufReader::with_capacity(64 * 1024, tokio::io::stdin());

    loop {
        let nm_req: NmRequest = match protocol::read_message(&mut stdin).await {
            Ok(r) => r,
            Err(e) => {
                log::info!("Firefox disconnected: {e}");
                break;
            }
        };
        log::debug!("← Firefox: {nm_req:?}");
        let firefox_id = nm_req.id();

        let id = next_id;
        next_id = next_id.wrapping_add(1).max(1);

        let ipc_req = nm_to_ipc(nm_req, id);

        // Register the oneshot *before* sending so we cannot miss a fast reply.
        let (resp_tx, resp_rx) = oneshot::channel();
        pending.lock().await.insert(id, resp_tx);

        // Send request to daemon.
        {
            let mut w = daemon_writer.lock().await;
            if let Err(e) = protocol::write_message(&mut *w, &ipc_req).await {
                log::warn!("daemon write failed: {e}");
                pending.lock().await.remove(&id);
                let mut err_resp = NmResponse::err("daemon disconnected, please reload page");
                err_resp.id = firefox_id;
                let _ = stdout_tx.send(err_resp).await;
                continue;
            }
        }

        // Spawn a task that waits for the matching response and forwards
        // it to the stdout channel.  This decouples reading the next
        // stdin message from waiting for the current response.
        let stdout_tx_clone = stdout_tx.clone();
        tokio::spawn(async move {
            let mut nm_resp = match resp_rx.await {
                Ok(ipc_resp) => ipc_to_nm(ipc_resp),
                Err(_) => NmResponse::err("daemon disconnected"),
            };
            nm_resp.id = firefox_id;
            let _ = stdout_tx_clone.send(nm_resp).await;
        });
    }

    // Wait for in-flight requests to drain so we don't drop responses
    // the page is still waiting for.  Give them up to 5 seconds.
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(5);
    while pending.lock().await.len() > 0 {
        if tokio::time::Instant::now() >= deadline {
            log::warn!("drain timeout: {} requests still pending", pending.lock().await.len());
            break;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    }

    daemon_reader.abort();
    #[allow(unused_variables)]
    let _ = _stdout_writer.abort();
    Ok(())
}


// ---------------------------------------------------------------------------
// Protocol translation helpers
// ---------------------------------------------------------------------------

/// Convert a native-messaging request from Firefox into an IPC request for
/// the daemon, attaching the given sequence `id`.
fn nm_to_ipc(req: NmRequest, id: u32) -> IpcRequest {
    match req {
        NmRequest::Enumerate { .. } => IpcRequest::Enumerate { id },

        NmRequest::Open { device_id, .. } => {
            let device_id = String::from_utf8_lossy(&device_id).into_owned();
            IpcRequest::Open { id, device_id }
        }

        NmRequest::Close { data, .. } => {
            // `data` is the device path encoded as individual char codes.
            let device_id = String::from_utf8_lossy(&data).into_owned();
            IpcRequest::Close { id, device_id }
        }

        NmRequest::Read { data, timeout, .. } => {
            let device_id = String::from_utf8_lossy(&data).into_owned();
            IpcRequest::Read { id, device_id, timeout_ms: timeout }
        }

        NmRequest::SendReport { device_id, report_id, data, .. } => {
            let device_id = String::from_utf8_lossy(&device_id).into_owned();
            IpcRequest::SendReport { id, device_id, report_id, data }
        }

        NmRequest::ReceiveFeatureReport { device_id, report_id, .. } => {
            let device_id = String::from_utf8_lossy(&device_id).into_owned();
            IpcRequest::ReceiveFeatureReport { id, device_id, report_id }
        }

        NmRequest::SendFeatureReport { device_id, report_id, data, .. } => {
            let device_id = String::from_utf8_lossy(&device_id).into_owned();
            IpcRequest::SendFeatureReport { id, device_id, report_id, data }
        }
    }
}

/// Convert a daemon IPC response into the native-messaging format for Firefox.
fn ipc_to_nm(resp: IpcResponse) -> NmResponse {
    match resp {
        IpcResponse::Devices { devices, .. } => NmResponse::ok_with_devices(devices),

        IpcResponse::Opened { device_id, session_token, ws_port, .. } => {
            // The addon decodes the device ID as `String.fromCharCode(...data)`,
            // so we send the path as a byte array.
            NmResponse::ok_opened(device_id.into_bytes(), session_token, ws_port)
        }

        IpcResponse::Ok { .. } => NmResponse::ok(),

        IpcResponse::Data { data, .. } => NmResponse::ok_with_data(data),

        IpcResponse::Error { message, .. } => NmResponse::err(message),

        // Events should not arrive here (the reader task handles id=0).
        other => {
            log::warn!("unexpected event as response: {other:?}");
            NmResponse::err("unexpected event")
        }
    }
}

/// Convert a daemon event (id=0) into a native-messaging push message, or
/// return `None` if the event type is not forwarded to Firefox.
fn ipc_event_to_nm(resp: IpcResponse) -> Option<NmResponse> {
    match resp {
        IpcResponse::DeviceConnected { device, .. } => Some(NmResponse::event_connect(device)),

        IpcResponse::DeviceDisconnected { device, .. } => {
            Some(NmResponse::event_disconnect(device))
        }

        IpcResponse::InputReport { device_id, report_id, data, .. } => {
            Some(NmResponse::event_input_report(device_id.into_bytes(), report_id, data))
        }

        IpcResponse::Hello { ws_port, .. } => {
            Some(NmResponse {
                event_type: Some("hello".into()),
                ws_port: Some(ws_port),
                ..Default::default()
            })
        }

        _ => None,
    }
}

fn init_logger() {
    let level = std::env::var("RUST_LOG")
        .ok()
        .and_then(|v| v.parse::<log::LevelFilter>().ok())
        .unwrap_or(log::LevelFilter::Info);
    if log::set_boxed_logger(Box::new(SimpleLogger)).is_ok() {
        log::set_max_level(level);
    }
}

struct SimpleLogger;

impl log::Log for SimpleLogger {
    fn enabled(&self, _: &log::Metadata) -> bool {
        true
    }
    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            eprintln!("[{:5} {}] {}", record.level(), record.target(), record.args());
        }
    }
    fn flush(&self) {}
}

#[cfg(test)]
mod tests {
    use webhid::{NmRequest, IpcRequest, IpcResponse, DeviceInfo};

    // ── nm_to_ipc ───────────────────────────────────────────────────────

    #[test]
    fn test_nm_to_ipc_enumerate() {
        let req = NmRequest::Enumerate { id: None };
        let ipc = super::nm_to_ipc(req, 1);
        assert!(matches!(ipc, IpcRequest::Enumerate { id: 1 }));
    }

    #[test]
    fn test_nm_to_ipc_open() {
        let req = NmRequest::Open { id: None, device_id: b"test-dev".to_vec() };
        let ipc = super::nm_to_ipc(req, 2);
        assert!(matches!(ipc, IpcRequest::Open { id: 2, .. }));
        if let IpcRequest::Open { device_id, .. } = &ipc {
            assert_eq!(device_id, "test-dev");
        }
    }

    #[test]
    fn test_nm_to_ipc_open_non_utf8() {
        let req = NmRequest::Open { id: None, device_id: vec![0xFF, 0xFE] };
        let ipc = super::nm_to_ipc(req, 3);
        if let IpcRequest::Open { device_id, .. } = &ipc {
            assert_eq!(device_id.as_str(), std::string::String::from_utf8_lossy(&[0xFF, 0xFE]));
        } else {
            panic!("expected Open");
        }
    }

    #[test]
    fn test_nm_to_ipc_close() {
        let req = NmRequest::Close { id: Some(5), data: b"dev".to_vec() };
        let ipc = super::nm_to_ipc(req, 4);
        assert!(matches!(ipc, IpcRequest::Close { id: 4, .. }));
        if let IpcRequest::Close { device_id, .. } = &ipc {
            assert_eq!(device_id, "dev");
        }
    }

    #[test]
    fn test_nm_to_ipc_read() {
        let req = NmRequest::Read { id: None, data: b"dev".to_vec(), timeout: 5000 };
        let ipc = super::nm_to_ipc(req, 5);
        assert!(matches!(ipc, IpcRequest::Read { id: 5, timeout_ms: 5000, .. }));
    }

    #[test]
    fn test_nm_to_ipc_send_report() {
        let req = NmRequest::SendReport {
            id: None, device_id: b"dev".to_vec(), report_id: 1, data: vec![0x00, 0xFF],
        };
        let ipc = super::nm_to_ipc(req, 6);
        assert!(matches!(ipc, IpcRequest::SendReport { id: 6, report_id: 1, .. }));
        if let IpcRequest::SendReport { data, .. } = &ipc {
            assert_eq!(data, &[0x00, 0xFF]);
        }
    }

    #[test]
    fn test_nm_to_ipc_receive_feature_report() {
        let req = NmRequest::ReceiveFeatureReport {
            id: Some(10), device_id: b"dev".to_vec(), report_id: 0,
        };
        let ipc = super::nm_to_ipc(req, 7);
        assert!(matches!(ipc, IpcRequest::ReceiveFeatureReport { id: 7, report_id: 0, .. }));
    }

    #[test]
    fn test_nm_to_ipc_send_feature_report() {
        let req = NmRequest::SendFeatureReport {
            id: None, device_id: b"dev".to_vec(), report_id: 2, data: vec![0xAA],
        };
        let ipc = super::nm_to_ipc(req, 8);
        assert!(matches!(ipc, IpcRequest::SendFeatureReport { id: 8, report_id: 2, .. }));
    }

    // ── ipc_to_nm ───────────────────────────────────────────────────────

    fn test_device() -> DeviceInfo {
        DeviceInfo {
            vendor_id: 0x1234, product_id: 0x5678,
            product_name: Some("Test".into()), manufacturer: None,
            serial_number: None, usage_page: None, usage: None,
            device_id: "test-device-id".into(),
            report_descriptor: None, collections: None,
        }
    }

    #[test]
    fn test_ipc_to_nm_devices() {
        let dev = test_device();
        let resp = IpcResponse::Devices { id: 1, devices: vec![dev] };
        let nm = super::ipc_to_nm(resp);
        assert_eq!(nm.success, Some(true));
        assert!(nm.devices.is_some());
        let devs = nm.devices.unwrap();
        assert_eq!(devs.len(), 1);
        assert_eq!(devs[0].vendor_id, 0x1234);
        assert_eq!(devs[0].product_id, 0x5678);
        assert_eq!(devs[0].device_id, "test-device-id");
    }

    #[test]
    fn test_ipc_to_nm_opened() {
        let resp = IpcResponse::Opened {
            id: 2, device_id: "dev".into(),
            session_token: Some("tok123".into()), ws_port: Some(31337),
        };
        let nm = super::ipc_to_nm(resp);
        assert_eq!(nm.success, Some(true));
        assert_eq!(nm.data, Some(b"dev".to_vec()));
        assert_eq!(nm.session_token, Some("tok123".into()));
        assert_eq!(nm.ws_port, Some(31337));
    }

    #[test]
    fn test_ipc_to_nm_ok() {
        let resp = IpcResponse::Ok { id: 3 };
        let nm = super::ipc_to_nm(resp);
        assert_eq!(nm.success, Some(true));
        assert!(nm.error.is_none());
    }

    #[test]
    fn test_ipc_to_nm_data() {
        let resp = IpcResponse::Data { id: 4, data: vec![0xDE, 0xAD] };
        let nm = super::ipc_to_nm(resp);
        assert_eq!(nm.success, Some(true));
        assert_eq!(nm.data, Some(vec![0xDE, 0xAD]));
    }

    #[test]
    fn test_ipc_to_nm_error() {
        let resp = IpcResponse::Error { id: 5, message: "permission denied".into() };
        let nm = super::ipc_to_nm(resp);
        assert_eq!(nm.success, Some(false));
        assert_eq!(nm.error, Some("permission denied".into()));
    }

    #[test]
    fn test_ipc_to_nm_unexpected_event() {
        // Events (id=0) normally go through ipc_event_to_nm, not ipc_to_nm.
        // If one arrives here, it should produce an error response.
        let resp = IpcResponse::DeviceConnected { id: 0, device: test_device() };
        let nm = super::ipc_to_nm(resp);
        assert_eq!(nm.success, Some(false));
        assert!(nm.error.is_some());
    }

    // ── ipc_event_to_nm ─────────────────────────────────────────────────

    #[test]
    fn test_ipc_event_to_nm_device_connected() {
        let dev = test_device();
        let resp = IpcResponse::DeviceConnected { id: 0, device: dev };
        let nm = super::ipc_event_to_nm(resp).unwrap();
        assert_eq!(nm.event_type, Some("connect".into()));
        assert!(nm.device.is_some());
        assert_eq!(nm.device.as_ref().unwrap().vendor_id, 0x1234);
    }

    #[test]
    fn test_ipc_event_to_nm_device_disconnected() {
        let dev = test_device();
        let resp = IpcResponse::DeviceDisconnected { id: 0, device: dev };
        let nm = super::ipc_event_to_nm(resp).unwrap();
        assert_eq!(nm.event_type, Some("disconnect".into()));
        assert!(nm.device.is_some());
        assert_eq!(nm.device.as_ref().unwrap().vendor_id, 0x1234);
    }

    #[test]
    fn test_ipc_event_to_nm_input_report() {
        let resp = IpcResponse::InputReport {
            id: 0, device_id: "dev".into(), report_id: 5, data: vec![0xAA, 0xBB],
        };
        let nm = super::ipc_event_to_nm(resp).unwrap();
        assert_eq!(nm.event_type, Some("input_report".into()));
        assert_eq!(nm.device_id, Some(b"dev".to_vec()));
        assert_eq!(nm.report_id, Some(5));
        assert_eq!(nm.data, Some(vec![0xAA, 0xBB]));
    }

    #[test]
    fn test_ipc_event_to_nm_hello() {
        let resp = IpcResponse::Hello { id: 0, ws_port: 31337 };
        let nm = super::ipc_event_to_nm(resp).unwrap();
        assert_eq!(nm.event_type, Some("hello".into()));
        assert_eq!(nm.ws_port, Some(31337));
    }

    #[test]
    fn test_ipc_event_to_nm_non_event_returns_none() {
        let resp = IpcResponse::Ok { id: 0 };
        assert!(super::ipc_event_to_nm(resp).is_none());

        let resp = IpcResponse::Error { id: 0, message: "x".into() };
        assert!(super::ipc_event_to_nm(resp).is_none());
    }
}
