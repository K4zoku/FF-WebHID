use std::sync::Arc;
use std::time::Duration;

use anyhow::Context as _;
use futures::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc};
use tokio::time::interval;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;

use crate::device_mgr::DeviceManager;
use crate::hid;

/// Default flush interval for batching input reports (milliseconds).
const DEFAULT_BATCH_FLUSH_MS: u64 = 1;

// ---------------------------------------------------------------------------
// Wire format for client → daemon binary frames (page → device hot path)
// ---------------------------------------------------------------------------
//
// First byte is the message type:
//
//   0x01  SendReport (output report)
//         [0x01][req_id_u32 LE][report_id_u8][...payload]
//         Daemon writes via hidraw `write(2)` and sends back:
//         [0x81][req_id_u32 LE][status_u8]   (status: 0=ok, 1=err)
//
//   0x02  SendFeatureReport
//         [0x02][req_id_u32 LE][report_id_u8][...payload]
//         Daemon issues HIDIOCSFEATURE and sends back:
//         [0x82][req_id_u32 LE][status_u8]
//
//   0x03  ReceiveFeatureReport
//         [0x03][req_id_u32 LE][report_id_u8]
//         Daemon issues HIDIOCGFEATURE and sends back:
//         [0x83][req_id_u32 LE][status_u8][len_u16 LE][...data]
//         (data length = 0 on error)
//
// Frames from daemon → page that are NOT in this scheme are input-report
// batches (existing format: `[len_u8][report_bytes]...`) — preserved for
// backward compat with the existing SAB ring buffer.

const MSG_SEND_REPORT: u8 = 0x01;
const MSG_SEND_FEATURE_REPORT: u8 = 0x02;
const MSG_RECEIVE_FEATURE_REPORT: u8 = 0x03;

const RESP_SEND_REPORT: u8 = 0x81;
const RESP_SEND_FEATURE_REPORT: u8 = 0x82;
const RESP_RECEIVE_FEATURE_REPORT: u8 = 0x83;

/// Start the WebSocket server on the given port.
pub async fn start_server(
    port: u16,
    event_tx: broadcast::Sender<webhid::IpcResponse>,
    device_mgr: Arc<DeviceManager>,
) -> anyhow::Result<()> {
    let addr = format!("127.0.0.1:{port}");
    let listener = TcpListener::bind(&addr)
        .await
        .with_context(|| format!("bind WebSocket server on {addr}"))?;

    log::info!("WebSocket server listening on {addr}");

    loop {
        match listener.accept().await {
            Ok((stream, addr)) => {
                log::info!("[ws] client connected from {addr}");
                let event_tx_clone = event_tx.clone();
                let device_mgr_clone = Arc::clone(&device_mgr);
                tokio::spawn(async move {
                    if let Err(e) = handle_websocket(stream, event_tx_clone, device_mgr_clone).await {
                        log::warn!("[ws] {addr} error: {e:#}");
                    }
                });
            }
            Err(e) => log::error!("[ws] accept error: {e}"),
        }
    }
}

/// Handle a single WebSocket connection.
async fn handle_websocket(
    stream: tokio::net::TcpStream,
    event_tx: broadcast::Sender<webhid::IpcResponse>,
    device_mgr: Arc<DeviceManager>,
) -> anyhow::Result<()> {
    // Capture the session token from the HTTP upgrade request.
    let token_holder: Arc<std::sync::Mutex<Option<String>>> =
        Arc::new(std::sync::Mutex::new(None));
    let token_ref = Arc::clone(&token_holder);

    let ws_stream = tokio_tungstenite::accept_hdr_async(stream, move |req: &Request, res: Response| {
        let host = req.uri().host().unwrap_or("");
        if !host.is_empty() && host != "127.0.0.1" && host != "localhost" {
            log::warn!("[ws] rejected connection from host: {host}");
            let resp = Response::builder()
                .status(StatusCode::FORBIDDEN)
                .body(Some("Access denied".into()))
                .unwrap();
            return Err(resp);
        }
        let query = req.uri().query().unwrap_or("");
        let token = extract_token(query);
        let mut holder = token_ref.lock().unwrap();
        *holder = token;
        Ok(res)
    })
    .await;

    let ws_stream = match ws_stream {
        Ok(s) => s,
        Err(e) => {
            log::warn!("[ws] handshake failed: {e}");
            return Ok(());
        }
    };

    let token = token_holder.lock().unwrap().take();
    let token = match token {
        Some(t) => t,
        None => {
            log::warn!("[ws] no session token in query params — closing");
            return Ok(());
        }
    };

    // Authenticate: look up the device_id for this token.
    let device_id = match device_mgr.get_device_by_token(&token) {
        Some(id) => id,
        None => {
            log::warn!("[ws] unknown session token — closing");
            return Ok(());
        }
    };

    log::info!("[ws] authenticated token for device_id={device_id}");
    device_mgr.set_ws_active(&device_id, true);

    let (mut ws_sender, mut ws_receiver) = ws_stream.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    let outgoing_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if let Err(e) = ws_sender.send(msg).await {
                log::warn!("[ws] send error: {e}");
                break;
            }
        }
    });

    // --- Receiver task: handle incoming client frames (ping, close, hot-path writes) ---
    //
    // Page sends output/feature reports as binary frames so they bypass
    // the JSON control plane entirely (5–10× lower latency for sendReport).
    // Each frame is dispatched on a blocking thread to write to hidraw,
    // and the response is enqueued back to the page via `tx`.
    let tx_for_receiver = tx.clone();
    let device_mgr_for_receiver = Arc::clone(&device_mgr);
    let client_id_for_receiver = 0u64; // WS connections are not bound to an IPC client_id
    // Clone device_id before moving it into the receiver closure so the
    // sender task below can still use the original.  `async move` captures
    // by value, so without this clone the sender task's
    // `device_id.clone()` would fail to compile (E0382).
    let device_id_for_receiver = device_id.clone();
    let receiver_task = tokio::spawn(async move {
        while let Some(msg) = ws_receiver.next().await {
            match msg {
                Ok(Message::Ping(data)) => {
                    if tx_for_receiver.send(Message::Pong(data)).is_err() {
                        break;
                    }
                }
                Ok(Message::Close(_)) => break,
                Ok(Message::Binary(frame)) => {
                    let tx_clone = tx_for_receiver.clone();
                    let mgr = Arc::clone(&device_mgr_for_receiver);
                    let dev_id = device_id_for_receiver.clone();
                    tokio::spawn(async move {
                        handle_client_binary(&frame, &mgr, client_id_for_receiver, &dev_id, tx_clone).await;
                    });
                }
                Err(e) => {
                    log::warn!("[ws] read error: {e}");
                    break;
                }
                _ => {}
            }
        }
    });

    // --- Sender task: batch and forward input reports ---
    let tx_for_sender = tx.clone();
    let device_id_for_sender = device_id.clone();
    let batch_ms = std::env::var("WEBHID_WS_BATCH_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_BATCH_FLUSH_MS);
    
    let mut event_rx = event_tx.subscribe();
    let sender_task = tokio::spawn(async move {
        let mut batch: Vec<Vec<u8>> = Vec::with_capacity(64);
        let mut flush_interval = interval(Duration::from_millis(batch_ms));

        loop {
            tokio::select! {
                _ = flush_interval.tick() => {
                    if !batch.is_empty() {
                        let frame = create_batch_frame(&batch);
                        if tx_for_sender.send(Message::Binary(frame.into())).is_err() {
                            break;
                        }
                        batch.clear();
                    }
                }
                event_result = event_rx.recv() => {
                    match event_result {
                        Ok(webhid::IpcResponse::InputReport { device_id: evt_device_id, report_id, data, .. }) => {
                            if evt_device_id == device_id_for_sender {
                                let mut full_report = Vec::with_capacity(1 + data.len());
                                full_report.push(report_id);
                                full_report.extend_from_slice(&data);
                                batch.push(full_report);
                            }
                        }
                        Ok(_) => {}
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            log::warn!("[ws] broadcast lagged by {n} events");
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
        }
    });

    // Wait for tasks to complete.
    tokio::select! {
        _ = outgoing_task => {},
        _ = receiver_task => {},
        _ = sender_task => {},
    };

    log::info!("[ws] connection for {device_id} closed");
    device_mgr.set_ws_active(&device_id, false);
    Ok(())
}

fn extract_token(query: &str) -> Option<String> {
    query.split('&')
        .find(|p| p.starts_with("token="))
        .and_then(|p| p.split_once('='))
        .map(|(_, v)| v.to_string())
}

fn create_batch_frame(reports: &[Vec<u8>]) -> Vec<u8> {
    let total_size: usize = reports.iter().map(|r| 2 + r.len()).sum();
    let mut frame = Vec::with_capacity(total_size);
    for report in reports {
        let len = report.len() as u16;
        frame.push((len & 0xFF) as u8);
        frame.push(((len >> 8) & 0xFF) as u8);
        frame.extend_from_slice(report);
    }
    frame
}

/// Parse a client-sent binary frame (page → daemon hot path) and dispatch it
/// to hidraw.  Sends the response back via the outgoing `tx` channel as a
/// binary frame so the page can resolve the corresponding Promise.
async fn handle_client_binary(
    frame: &[u8],
    device_mgr: &Arc<DeviceManager>,
    _client_id: u64,
    device_id: &str,
    tx: mpsc::UnboundedSender<Message>,
) {
    if frame.is_empty() {
        log::warn!("[ws] empty binary frame from client");
        return;
    }
    let msg_type = frame[0];

    // All hot-path messages carry a u32 LE request id right after the type
    // byte so the page can match the response to its in-flight Promise.
    if frame.len() < 5 {
        log::warn!("[ws] short frame (len={}, need ≥5 for type+req_id)", frame.len());
        return;
    }
    let req_id = u32::from_le_bytes([frame[1], frame[2], frame[3], frame[4]]);

    match msg_type {
        MSG_SEND_REPORT | MSG_SEND_FEATURE_REPORT => {
            // [type][req_id_u32 LE][report_id_u8][...payload]
            if frame.len() < 6 {
                let resp_type = if msg_type == MSG_SEND_REPORT { RESP_SEND_REPORT } else { RESP_SEND_FEATURE_REPORT };
                let _ = tx.send(make_status_resp(resp_type, req_id, 1));
                return;
            }
            let report_id = frame[5];
            let payload = frame[6..].to_vec();

            let dev_arc = match device_mgr.get_file_by_device_id(device_id) {
                Ok(f) => f,
                Err(e) => {
                    log::warn!("[ws] get_file_by_device_id '{device_id}': {e}");
                    let resp_type = if msg_type == MSG_SEND_REPORT { RESP_SEND_REPORT } else { RESP_SEND_FEATURE_REPORT };
                    let _ = tx.send(make_status_resp(resp_type, req_id, 1));
                    return;
                }
            };

            let result = tokio::task::spawn_blocking(move || {
                let dev = dev_arc.lock().unwrap();
                if msg_type == MSG_SEND_REPORT {
                    hid::write_report(&dev, report_id, &payload)
                } else {
                    hid::write_feature_report(&dev, report_id, &payload)
                }
            })
            .await;

            let status = match result { Ok(Ok(())) => 0u8, _ => 1u8 };
            let resp_type = if msg_type == MSG_SEND_REPORT { RESP_SEND_REPORT } else { RESP_SEND_FEATURE_REPORT };
            let _ = tx.send(make_status_resp(resp_type, req_id, status));
        }

        MSG_RECEIVE_FEATURE_REPORT => {
            // [type][req_id_u32 LE][report_id_u8]
            if frame.len() < 6 {
                let _ = tx.send(make_feature_read_resp(req_id, 1, &[]));
                return;
            }
            let report_id = frame[5];

            let dev_arc = match device_mgr.get_file_by_device_id(device_id) {
                Ok(f) => f,
                Err(e) => {
                    log::warn!("[ws] get_file_by_device_id '{device_id}': {e}");
                    let _ = tx.send(make_feature_read_resp(req_id, 1, &[]));
                    return;
                }
            };

            let result = tokio::task::spawn_blocking(move || {
                let dev = dev_arc.lock().unwrap();
                hid::read_feature_report(&dev, report_id)
            })
            .await;

            match result {
                Ok(Ok(data)) => {
                    let _ = tx.send(make_feature_read_resp(req_id, 0, &data));
                }
                _ => {
                    let _ = tx.send(make_feature_read_resp(req_id, 1, &[]));
                }
            }
        }

        other => {
            log::warn!("[ws] unknown binary msg_type=0x{other:02x}");
        }
    }
}

/// Build a `[resp_type][req_id_u32 LE][status_u8]` response frame.
fn make_status_resp(resp_type: u8, req_id: u32, status: u8) -> Message {
    let mut buf = Vec::with_capacity(6);
    buf.push(resp_type);
    buf.extend_from_slice(&req_id.to_le_bytes());
    buf.push(status);
    Message::Binary(buf.into())
}

/// Build a `[0x83][req_id_u32 LE][status_u8][len_u16 LE][...data]` response
/// for ReceiveFeatureReport.  `data` is empty on error.
fn make_feature_read_resp(req_id: u32, status: u8, data: &[u8]) -> Message {
    let mut buf = Vec::with_capacity(8 + data.len());
    buf.push(RESP_RECEIVE_FEATURE_REPORT);
    buf.extend_from_slice(&req_id.to_le_bytes());
    buf.push(status);
    let len = data.len().min(0xFFFF) as u16;
    buf.extend_from_slice(&len.to_le_bytes());
    buf.extend_from_slice(&data[..len as usize]);
    Message::Binary(buf.into())
}
