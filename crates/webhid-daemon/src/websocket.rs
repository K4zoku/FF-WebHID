use std::sync::Arc;
use std::time::Duration;

use anyhow::Context as _;
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;

use crate::device_mgr::DeviceManager;
use crate::hid;

/// Default flush policy: `0` = adaptive (drain + burst coalescing).
/// Set `WEBHID_WS_BATCH_MS=N` (N > 0) to use a fixed N ms timer instead.
const DEFAULT_BATCH_FLUSH_MS: u64 = 0;

/// Coalescing window for adaptive burst batching (microseconds).
/// When a burst is detected (>1 report drained in one cycle), the sender
/// waits up to this duration for additional reports before flushing.
const ADAPTIVE_COALESCE_US: u64 = 100;

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
// batches (existing format: `[len_u8][report_bytes]...`); preserved for
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
    port_callback: Option<tokio::sync::oneshot::Sender<u16>>,
) -> anyhow::Result<()> {
    let addr = format!("127.0.0.1:{port}");
    let listener = TcpListener::bind(&addr)
        .await
        .with_context(|| format!("bind WebSocket server on {addr}"))?;

    let actual_port = listener.local_addr().unwrap().port();
    log::info!("WebSocket server listening on 127.0.0.1:{actual_port}");

    // Send the actual bound port back to the caller (for --nm-host mode
    // where port 0 = random).
    if let Some(tx) = port_callback {
        let _ = tx.send(actual_port);
    }

    loop {
        match listener.accept().await {
            Ok((stream, addr)) => {
                // Disable Nagle's algorithm: HID input reports are small,
                // latency-sensitive frames. Without TCP_NODELAY, Nagle + delayed
                // ACK can add ~40ms latency to the first frame after idle and
                // cause burst coalescing jitter.
                if let Err(e) = stream.set_nodelay(true) {
                    log::warn!("[ws] set_nodelay failed for {addr}: {e}");
                }
                log::info!("[ws] client connected from {addr} (TCP_NODELAY=on)");
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
        // Read token from Sec-WebSocket-Protocol header (subprotocol).
        // Browser WebSocket API doesn't support custom headers, so we use
        // the subprotocol mechanism: client sends `webhid.<token>` as
        // the subprotocol. This avoids exposing the token in the URL.
        let token = req.headers().get("sec-websocket-protocol")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.strip_prefix("webhid."))
            .map(String::from);
        let mut holder = token_ref.lock().unwrap();
        *holder = token;
        // Echo back the subprotocol so the browser accepts the handshake
        let mut res = res;
        if let Some(proto) = req.headers().get("sec-websocket-protocol") {
            res.headers_mut().insert("sec-websocket-protocol", proto.clone());
        }
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
        Some(t) if t.len() == 32 && t.chars().all(|c| c.is_ascii_hexdigit()) => t,
        Some(_) => {
            log::warn!("[ws] invalid token format; closing");
            return Ok(());
        }
        None => {
            log::warn!("[ws] no token provided; closing");
            return Ok(());
        }
    };

    // Check if this is a control-only token first.
    if device_mgr.validate_control_token(&token) {
        log::info!("[ws] control-only connection accepted");
        return handle_control_ws(ws_stream, device_mgr).await;
    }

    // Otherwise: device session token.
    let device_id = match device_mgr.get_device_by_token(&token) {
        Some(id) => id,
        None => {
            log::warn!("[ws] unknown token; closing");
            return Ok(());
        }
    };

    log::info!("[ws] authenticated token for device_id={device_id}");

    let mut event_rx = event_tx.subscribe();

    device_mgr.set_dataplane_mode(&device_id, "ws");

    let (mut ws_sender, mut ws_receiver) = ws_stream.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    let mut outgoing_task = tokio::spawn(async move {
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
    let device_id_for_receiver = device_id.clone();
    let mut receiver_task = tokio::spawn(async move {
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
                        handle_client_binary(&frame, &mgr, &dev_id, tx_clone).await;
                    });
                }
                Ok(Message::Text(text)) => {
                    let tx_clone = tx_for_receiver.clone();
                    let mgr = Arc::clone(&device_mgr_for_receiver);
                    let dev_id = device_id_for_receiver.clone();
                    tokio::spawn(async move {
                        handle_client_text(&text, &mgr, &dev_id, tx_clone).await;
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

    // --- Sender task ---
    //
    // Adaptive flushing (default, batch_ms == 0):
    //   1. Block on recv() for the first report.
    //   2. Drain all immediately-available reports via try_recv() (natural
    //      coalescing from kernel poll).
    //   3. If only 1 report was drained (sparse): flush immediately —
    //      zero added latency.
    //   4. If >1 reports were drained (burst): wait up to ADAPTIVE_COALESCE_US
    //      for more, drain again, then flush — amortizes syscall overhead.
    //
    // Fixed-timer mode (batch_ms > 0): legacy behavior, flush every N ms.
    let tx_for_sender = tx.clone();
    let device_id_for_sender = device_id.clone();
    let batch_ms = std::env::var("WEBHID_WS_BATCH_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_BATCH_FLUSH_MS);

    let mut sender_task = tokio::spawn(async move {
        let mut batch: Vec<(u8, Arc<[u8]>)> = Vec::with_capacity(8);

        // Fixed-timer mode.
        if batch_ms > 0 {
            let mut flush_interval = tokio::time::interval(Duration::from_millis(batch_ms));
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
                        if !handle_event(event_result, &device_id_for_sender, &mut batch, &tx_for_sender) {
                            break;
                        }
                    }
                }
            }
            return;
        }

        // Adaptive mode.
        let coalesce = Duration::from_micros(ADAPTIVE_COALESCE_US);
        loop {
            // 1. Block for first event.
            let event_result = event_rx.recv().await;
            if !handle_event(event_result, &device_id_for_sender, &mut batch, &tx_for_sender) {
                break;
            }

            // 2. Drain immediately-available events.
            drain_available(&mut event_rx, &device_id_for_sender, &mut batch, &tx_for_sender);

            // 3. Burst coalescing: if multiple reports accumulated, wait
            //    briefly for more before flushing.
            if batch.len() > 1 {
                tokio::select! {
                    _ = tokio::time::sleep(coalesce) => {}
                    event_result = event_rx.recv() => {
                        if !handle_event(event_result, &device_id_for_sender, &mut batch, &tx_for_sender) {
                            break;
                        }
                        drain_available(&mut event_rx, &device_id_for_sender, &mut batch, &tx_for_sender);
                    }
                }
            }

            // 4. Flush.
            if !batch.is_empty() {
                let frame = create_batch_frame(&batch);
                if tx_for_sender.send(Message::Binary(frame.into())).is_err() {
                    break;
                }
                batch.clear();
            }
        }
    });

    // Wait for tasks to complete.
    tokio::select! {
        _ = &mut outgoing_task => {},
        _ = &mut receiver_task => {},
        _ = &mut sender_task => {},
    }
    outgoing_task.abort();
    receiver_task.abort();
    sender_task.abort();

    log::info!("[ws] connection for {device_id} closed");
    device_mgr.set_dataplane_mode(&device_id, "nm");
    Ok(())
}

/// Handle a control-only WS connection (enumerate/close, no device data).
/// Text frames are JSON control messages; binary frames are rejected.
async fn handle_control_ws(
    ws_stream: tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    device_mgr: Arc<DeviceManager>,
) -> anyhow::Result<()> {
    use futures_util::StreamExt;
    let (mut ws_sender, mut ws_receiver) = ws_stream.split();

    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    let outgoing = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_sender.send(msg).await.is_err() { break; }
        }
    });

    while let Some(msg) = ws_receiver.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                let tx_clone = tx.clone();
                let mgr = Arc::clone(&device_mgr);
                tokio::spawn(async move {
                    handle_client_text(&text, &mgr, "", tx_clone).await;
                });
            }
            Ok(Message::Ping(data)) => { let _ = tx.send(Message::Pong(data)); }
            Ok(Message::Close(_)) => break,
            Ok(Message::Binary(_)) => {
                log::warn!("[ws-control] binary frames not allowed on control connection");
            }
            Err(e) => { log::warn!("[ws-control] read error: {e}"); break; }
            _ => {}
        }
    }

    outgoing.abort();
    log::info!("[ws-control] connection closed");
    Ok(())
}

/// Append matching `InputReport`s to `batch`; flush on `Lagged`.
/// Returns `false` when the channel is closed.
fn handle_event(
    event_result: Result<webhid::IpcResponse, broadcast::error::RecvError>,
    device_id: &str,
    batch: &mut Vec<(u8, Arc<[u8]>)>,
    tx: &mpsc::UnboundedSender<Message>,
) -> bool {
    match event_result {
        Ok(webhid::IpcResponse::InputReport {
            device_id: evt_device_id,
            report_id,
            data,
            ..
        }) => {
            if evt_device_id == device_id {
                batch.push((report_id, data));
            }
        }
        Ok(_) => {}
        Err(broadcast::error::RecvError::Lagged(n)) => {
            log::warn!("[ws] broadcast lagged by {n} events, flushing batch");
            if !batch.is_empty() {
                let frame = create_batch_frame(batch);
                if tx.send(Message::Binary(frame.into())).is_err() {
                    return false;
                }
                batch.clear();
            }
        }
        Err(broadcast::error::RecvError::Closed) => return false,
    }
    true
}

/// Drain all immediately-available events from the broadcast channel without
/// blocking. Used by the adaptive sender to coalesce reports that arrived
/// during the same poll iteration.
fn drain_available(
    rx: &mut broadcast::Receiver<webhid::IpcResponse>,
    device_id: &str,
    batch: &mut Vec<(u8, Arc<[u8]>)>,
    tx: &mpsc::UnboundedSender<Message>,
) {
    loop {
        match rx.try_recv() {
            Ok(ev) => {
                if !handle_event(Ok(ev), device_id, batch, tx) {
                    break;
                }
            }
            Err(broadcast::error::TryRecvError::Empty) => break,
            Err(broadcast::error::TryRecvError::Closed) => break,
            Err(broadcast::error::TryRecvError::Lagged(n)) => {
                log::warn!("[ws] drain lagged by {n} events");
                if !batch.is_empty() {
                    let frame = create_batch_frame(batch);
                    if tx.send(Message::Binary(frame.into())).is_err() {
                        break;
                    }
                    batch.clear();
                }
            }
        }
    }
}

fn create_batch_frame(reports: &[(u8, Arc<[u8]>)]) -> Vec<u8> {
    let total_size: usize = reports.iter().map(|(_, d)| 2 + 1 + d.len()).sum();
    let mut frame = Vec::with_capacity(total_size);
    for (report_id, data) in reports {
        let len = (1 + data.len()) as u16;
        frame.push((len & 0xFF) as u8);
        frame.push(((len >> 8) & 0xFF) as u8);
        frame.push(*report_id);
        frame.extend_from_slice(data);
    }
    frame
}

/// Parse a client-sent binary frame (page → daemon hot path) and dispatch it
/// to hidraw.  Sends the response back via the outgoing `tx` channel as a
/// binary frame so the page can resolve the corresponding Promise.
async fn handle_client_binary(
    frame: &[u8],
    device_mgr: &Arc<DeviceManager>,
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
            let payload: Arc<[u8]> = Arc::from(&frame[6..]);

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
            log::warn!("[ws] rejecting unknown binary msg_type=0x{other:02x}");
            let _ = tx.send(make_status_resp(0xFF, req_id, 1));
        }
    }
}

/// Handle a JSON text frame (control plane over WS).
async fn handle_client_text(
    text: &str,
    device_mgr: &Arc<DeviceManager>,
    device_id: &str,
    tx: mpsc::UnboundedSender<Message>,
) {
    let req: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(e) => {
            let _ = tx.send(Message::Text(
                serde_json::json!({ "err": format!("JSON parse: {e}") }).to_string().into(),
            ));
            return;
        }
    };

    let id = req.get("id").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let action = req.get("action").and_then(|v| v.as_str()).unwrap_or("");

    let result = match action {
        "enumerate" => {
            match device_mgr.enumerate() {
                Ok(devices) => serde_json::json!({ "id": id, "ok": true, "devs": devices }),
                Err(e) => serde_json::json!({ "id": id, "ok": false, "err": e.to_string() }),
            }
        }
        "close" => {
            match device_mgr.close(device_id, 0) {
                Ok(()) => serde_json::json!({ "id": id, "ok": true }),
                Err(e) => serde_json::json!({ "id": id, "ok": false, "err": e.to_string() }),
            }
        }
        _ => {
            serde_json::json!({ "id": id, "ok": false, "err": format!("unknown action: {action}") })
        }
    };

    let _ = tx.send(Message::Text(result.to_string().into()));
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

#[cfg(test)]
mod tests {
    use super::*;

    // ── create_batch_frame ──────────────────────────────────────────────

    #[test]
    fn test_batch_frame_empty() {
        let frame = create_batch_frame(&[]);
        assert!(frame.is_empty());
    }

    #[test]
    fn test_batch_frame_single_report() {
        let reports: Vec<(u8, Arc<[u8]>)> = vec![(0x01, Arc::from(&[0xAA, 0xBB][..]))];
        let frame = create_batch_frame(&reports);
        // [len_u16 LE = 3][report_id=0x01][payload 0xAA, 0xBB]
        assert_eq!(frame, vec![0x03, 0x00, 0x01, 0xAA, 0xBB]);
    }

    #[test]
    fn test_batch_frame_multiple_reports() {
        let reports: Vec<(u8, Arc<[u8]>)> = vec![
            (0x01, Arc::from(&[0xAA][..])),
            (0x02, Arc::from(&[0xBB, 0xCC][..])),
        ];
        let frame = create_batch_frame(&reports);
        // [2, 0, 0x01, 0xAA, 3, 0, 0x02, 0xBB, 0xCC]
        assert_eq!(frame, vec![0x02, 0x00, 0x01, 0xAA, 0x03, 0x00, 0x02, 0xBB, 0xCC]);
    }

    #[test]
    fn test_batch_frame_empty_report() {
        let reports: Vec<(u8, Arc<[u8]>)> = vec![(0x05, Arc::from(&[][..]))];
        let frame = create_batch_frame(&reports);
        // [len=1, 0, report_id=0x05]
        assert_eq!(frame, vec![0x01, 0x00, 0x05]);
    }

    // ── make_status_resp ────────────────────────────────────────────────

    #[test]
    fn test_status_resp_success() {
        let msg = make_status_resp(0x81, 42, 0);
        let expected = vec![0x81, 42, 0, 0, 0, 0];
        assert_eq!(msg, Message::Binary(expected.into()));
    }

    #[test]
    fn test_status_resp_error() {
        let msg = make_status_resp(0x82, 1, 1);
        assert_eq!(msg, Message::Binary(vec![0x82, 1, 0, 0, 0, 1].into()));
    }

    #[test]
    fn test_status_resp_large_req_id() {
        let msg = make_status_resp(0x81, 0xDEAD, 0);
        assert_eq!(msg, Message::Binary(vec![0x81, 0xAD, 0xDE, 0x00, 0x00, 0x00].into()));
    }

    // ── make_feature_read_resp ──────────────────────────────────────────

    #[test]
    fn test_feature_read_resp_success() {
        let msg = make_feature_read_resp(42, 0, &[0xAA, 0xBB]);
        assert_eq!(
            msg,
            Message::Binary(vec![0x83, 42, 0, 0, 0, 0, 2, 0, 0xAA, 0xBB].into())
        );
    }

    #[test]
    fn test_feature_read_resp_error() {
        let msg = make_feature_read_resp(7, 1, &[]);
        assert_eq!(
            msg,
            Message::Binary(vec![0x83, 7, 0, 0, 0, 1, 0, 0].into())
        );
    }

    #[test]
    fn test_feature_read_resp_large_data() {
        let data = vec![0xFF; 300];
        let msg = make_feature_read_resp(0, 0, &data);
        if let Message::Binary(buf) = &msg {
            assert_eq!(buf[0], 0x83);
            assert_eq!(buf[5], 0);
            let len = u16::from_le_bytes([buf[6], buf[7]]);
            assert_eq!(len as usize, data.len().min(0xFFFF));
            assert_eq!(&buf[8..], &data[..len as usize]);
        } else {
            panic!("expected Binary message");
        }
    }
}
