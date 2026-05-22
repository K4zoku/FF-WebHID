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
//!  [stdout writer]◄──────────────────────────────[daemon reader]
//!                   id>0 → ipc_to_nm (response)
//!                   id=0 → ipc_event_to_nm (event)
//! ```
//!
//! The main task processes one NM request at a time.  A parallel daemon-reader
//! task routes incoming IPC messages: responses go to the pending `oneshot`
//! channel; events are forwarded directly to the stdout channel.

use std::collections::{HashMap, VecDeque};
use tokio::io::{AsyncWriteExt, BufReader, BufWriter};
use std::sync::Arc;


use tokio::net::UnixStream;
use tokio::sync::{Mutex, mpsc, oneshot};
use webhid::{IpcRequest, IpcResponse, NmRequest, NmResponse, protocol};

const DEFAULT_SOCKET: &str = "/run/webhid/webhid.sock";

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

    let stream = UnixStream::connect(&socket_path).await.map_err(|e| {
        anyhow::anyhow!("cannot connect to webhid-daemon at '{socket_path}': {e}")
    })?;
    log::info!("connected to daemon at {socket_path}");

    let (daemon_read, daemon_write) = stream.into_split();

    // Serialise all writes to stdout through one task with batching.
    const BATCH_SIZE: usize = 16;
    const BATCH_FLUSH_MS: u64 = 5;

    let (stdout_tx, mut stdout_rx) = mpsc::channel::<NmResponse>(64);
    #[allow(unused_must_use)]
    let _stdout_writer = tokio::spawn(async move {
        let mut out = BufWriter::with_capacity(256 * 1024, tokio::io::stdout());
        let mut batch: VecDeque<NmResponse> = VecDeque::with_capacity(BATCH_SIZE);

        loop {
            // Collect messages until batch is full or flush timeout
            let mut got_first = false;
            while batch.len() < BATCH_SIZE {
                let timeout = tokio::time::sleep(tokio::time::Duration::from_millis(BATCH_FLUSH_MS));
                tokio::select! {
                    msg = stdout_rx.recv() => {
                        match msg {
                            Some(m) => {
                                batch.push_back(m);
                                got_first = true;
                            },
                            None => {
                                // Channel closed, flush and exit
                                flush_batch(&mut out, &mut batch).await;
                                return Ok::<(), anyhow::Error>(());
                            }
                        }
                    }
                    _ = timeout => {
                        if got_first {
                            break; // Timeout reached after getting first message
                        }
                        // No messages received yet, continue waiting
                    }
                }
            }

            // Flush the batch
            if let Err(e) = flush_batch(&mut out, &mut batch).await {
                log::error!("stdout write: {e}");
                break;
            }

            // If channel is closed, exit
            if stdout_rx.is_closed() {
                break;
            }
        }
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
                        // Unsolicited event → convert and forward to Firefox.
                        if let Some(nm) = ipc_event_to_nm(response) {
                            log::debug!("[daemon_reader] forwarding event: {:?}", nm);
                            let _ = stdout_tx_ev.send(nm).await;
                        }
                    } else {
                        // Response to a pending request → wake the waiter.
                        let sender = pending_rx.lock().await.remove(&response.id());
                        if let Some(tx) = sender {
                            let _ = tx.send(response);
                        }
                    }
                }
                Err(e) => {
                    log::info!("daemon disconnected: {e}");
                    break;
                }
            }
        }
    });

    // Protect the daemon write half with a mutex so both the main loop and
    // (in the future) any concurrent task can send without races.
    let daemon_writer = Arc::new(Mutex::new(BufWriter::new(daemon_write)));

    // Main loop: one NM request at a time.
    let mut next_id: u32 = 1;
    let mut stdin = BufReader::with_capacity(64 * 1024, tokio::io::stdin());

    loop {
        let nm_req: NmRequest = match protocol::read_message(&mut stdin).await {
            Ok(r) => r,
            Err(e) => {
                // Firefox closed the port (normal shutdown).
                log::info!("Firefox disconnected: {e}");
                break;
            }
        };
        log::debug!("← Firefox: {nm_req:?}");
        let firefox_id = nm_req.id();

        let id = next_id;
        // Reserve id=0 for events; wrap around skipping 0.
        next_id = next_id.wrapping_add(1).max(1);

        let ipc_req = nm_to_ipc(nm_req, id);

        // Register the oneshot *before* sending so we cannot miss a fast reply.
        let (resp_tx, resp_rx) = oneshot::channel();
        pending.lock().await.insert(id, resp_tx);

        // Send request to daemon.
        {
            let mut w = daemon_writer.lock().await;
            if let Err(e) = protocol::write_message(&mut *w, &ipc_req).await {
                log::error!("daemon write: {e}");
                pending.lock().await.remove(&id);
                let mut err_resp = NmResponse::err("daemon communication error");
                err_resp.id = firefox_id;
                let _ = stdout_tx.send(err_resp).await;
                continue;
            }
        }

        // Await the matching response (the daemon reader task will deliver it).
        let mut nm_resp = match resp_rx.await {
            Ok(ipc_resp) => {
                log::debug!("→ daemon: {ipc_resp:?}");
                ipc_to_nm(ipc_resp)
            }
            Err(_) => NmResponse::err("daemon disconnected"),
        };
        nm_resp.id = firefox_id;

        log::debug!("→ Firefox: {nm_resp:?}");
        let _ = stdout_tx.send(nm_resp).await;
    }

    daemon_reader.abort();
    #[allow(unused_variables)]
    let _ = _stdout_writer.abort();
    Ok(())
}


// ---------------------------------------------------------------------------
// Batching helpers
// ---------------------------------------------------------------------------

async fn flush_batch<W: tokio::io::AsyncWrite + Unpin>(
    out: &mut W,
    batch: &mut VecDeque<NmResponse>,
) -> std::io::Result<()> {
    if batch.is_empty() {
        return Ok(());
    }

    // Write all messages in batch
    for msg in batch.drain(..) {
        protocol::write_message(out, &msg).await?;
    }

    // Flush the buffer
    out.flush().await?;

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
            let device_path = String::from_utf8_lossy(&device_id).into_owned();
            IpcRequest::Open { id, device_path }
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
            // Encode device_id as bytes so the addon can compare with its
            // stored deviceId string.
            log::debug!(
                "[ipc_event_to_nm] InputReport: device_id='{}', report_id={}, data_len={}",
                device_id,
                report_id,
                data.len()
            );
            Some(NmResponse::event_input_report(device_id.into_bytes(), report_id, data))
        }

        _ => None,
    }
}
