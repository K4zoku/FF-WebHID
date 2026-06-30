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


use tokio::net::UnixStream;
use tokio::sync::{Mutex, mpsc, oneshot};
use webhid::{IpcRequest, IpcResponse, NmRequest, NmResponse, protocol};

const DEFAULT_SOCKET: &str = "/run/webhid/webhid.sock";

/// Threshold below which we don't log timing (avoid noise).  Anything above
/// this is logged at `info` so you can spot the slow stage without digging
/// through debug logs.

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Always log to stderr; stdout is reserved for the native-messaging protocol.
    env_logger::Builder::from_default_env()
        .target(env_logger::Target::Stderr)
        .filter_level(log::LevelFilter::Info)
        .init();

    let socket_path = std::env::var("WEBHID_SOCKET")
        .unwrap_or_else(|_| DEFAULT_SOCKET.to_string());

    // Connect with retry — daemon may be restarting.  Backoff: 100ms, 200ms,
    // 400ms, ... up to 2s.  Total wait up to ~30s before giving up.
    let stream = {
        let mut delay = 100u64;
        loop {
            match UnixStream::connect(&socket_path).await {
                Ok(s) => break s,
                Err(e) => {
                    if delay > 30000 {
                        return Err(anyhow::anyhow!("cannot connect to webhid-daemon at '{socket_path}' after retries: {e}"));
                    }
                    log::warn!("daemon connect failed ({e}), retry in {delay}ms");
                    tokio::time::sleep(tokio::time::Duration::from_millis(delay)).await;
                    delay *= 2;
                    if delay > 2000 { delay = 2000; }
                }
            }
        }
    };
    log::info!("connected to daemon at {socket_path}");

    let (daemon_read, daemon_write) = stream.into_split();

    // Serialise all writes to stdout through one task.  We previously
    // batched up to 16 messages / 5ms before flushing, but that introduced
    // up to 5ms of latency per response under load — and when combined
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
