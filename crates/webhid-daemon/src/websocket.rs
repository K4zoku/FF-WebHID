use std::sync::Arc;

use anyhow::Context as _;
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;

const WS_CLOSE_UNKNOWN_TOKEN: u16 = 4401;
const WS_CLOSE_BAD_TOKEN: u16 = 4402;

use crate::batching;
use crate::device_mgr::DeviceManager;

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

    let actual_port = listener
        .local_addr()
        .with_context(|| "get WS listener local addr")?
        .port();
    log::info!("WebSocket server listening on 127.0.0.1:{actual_port}");

    if let Some(tx) = port_callback {
        let _ = tx.send(actual_port);
    }

    loop {
        match listener.accept().await {
            Ok((stream, addr)) => {
                let nodelay = stream.set_nodelay(true);
                if let Err(e) = &nodelay {
                    log::warn!("[ws] set_nodelay failed for {addr}: {e}");
                }
                log::info!(
                    "[ws] client connected from {addr} (TCP_NODELAY={})",
                    if nodelay.is_ok() { "on" } else { "off" }
                );
                let event_tx_clone = event_tx.clone();
                let device_mgr_clone = Arc::clone(&device_mgr);
                tokio::spawn(async move {
                    if let Err(e) =
                        handle_websocket(stream, event_tx_clone, device_mgr_clone, port).await
                    {
                        log::warn!("[ws] {addr} error: {e:#}");
                    }
                });
            }
            Err(e) => log::error!("[ws] accept error: {e}"),
        }
    }
}

#[allow(clippy::result_large_err)]
async fn handle_websocket(
    stream: tokio::net::TcpStream,
    event_tx: broadcast::Sender<webhid::IpcResponse>,
    device_mgr: Arc<DeviceManager>,
    _ws_port: u16,
) -> anyhow::Result<()> {
    let hash_holder: Arc<std::sync::Mutex<Option<String>>> = Arc::new(std::sync::Mutex::new(None));
    let hash_ref = Arc::clone(&hash_holder);

    let ws_stream =
        tokio_tungstenite::accept_hdr_async(stream, move |req: &Request, res: Response| {
            let host = req.uri().host().unwrap_or("");
            let is_loopback =
                host.is_empty() || host == "127.0.0.1" || host == "localhost" || host == "::1";
            if !is_loopback {
                log::warn!("[ws] rejected connection from host: {host}");
                let resp = Response::builder()
                    .status(StatusCode::FORBIDDEN)
                    .body(Some("Access denied".into()))
                    .expect("static 403 response should build");
                return Err(resp);
            }
            let hash = req
                .headers()
                .get("sec-websocket-protocol")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.strip_prefix("webhid."))
                .map(String::from);
            let mut holder = hash_ref.lock().unwrap_or_else(|e| e.into_inner());
            *holder = hash;
            let mut res = res;
            if let Some(proto) = req.headers().get("sec-websocket-protocol") {
                res.headers_mut()
                    .insert("sec-websocket-protocol", proto.clone());
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

    let hash = hash_holder.lock().unwrap_or_else(|e| e.into_inner()).take();
    let (hash, ws_stream) = match hash {
        Some(h) if h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit()) => (h, ws_stream),
        Some(_) => {
            log::warn!("[ws] invalid auth hash format; closing");
            let _ = send_close(ws_stream, WS_CLOSE_BAD_TOKEN, "bad token").await;
            return Ok(());
        }
        None => {
            log::warn!("[ws] no auth hash provided; closing");
            let _ = send_close(ws_stream, WS_CLOSE_BAD_TOKEN, "no token").await;
            return Ok(());
        }
    };

    let (device_id, session_token) = match device_mgr.get_device_by_ws_auth(&hash) {
        Some((id, token)) => (id, token),
        None => {
            log::warn!("[ws] unknown auth hash; closing");
            let _ = send_close(ws_stream, WS_CLOSE_UNKNOWN_TOKEN, "unknown token").await;
            return Ok(());
        }
    };

    log::info!("[ws] authenticated hash for device_id={device_id:#x}");

    let event_rx = event_tx.subscribe();

    let ws_gen = device_mgr.ws_connect(device_id, &session_token);

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

    let tx_for_receiver = tx.clone();
    let device_mgr_for_receiver = Arc::clone(&device_mgr);
    let device_id_for_receiver = device_id;
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
                    let dev_id = device_id_for_receiver;
                    tokio::spawn(async move {
                        batching::handle_client_message(&frame, &mgr, dev_id, |resp| {
                            let _ = tx_clone.send(Message::Binary(resp.into()));
                        })
                        .await;
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

    let tx_for_sender = tx.clone();
    let device_id_for_sender = device_id;

    let mut sender_task = tokio::spawn(batching::run_sender(
        event_rx,
        device_id_for_sender,
        move |frame: Vec<u8>| tx_for_sender.send(Message::Binary(frame.into())).is_ok(),
    ));

    tokio::select! {
        _ = &mut outgoing_task => {},
        _ = &mut receiver_task => {},
        _ = &mut sender_task => {},
    }
    outgoing_task.abort();
    receiver_task.abort();
    sender_task.abort();

    log::info!("[ws] connection for {device_id:#x} closed");
    device_mgr.ws_disconnect(device_id, &session_token, ws_gen);
    Ok(())
}

async fn send_close(
    ws_stream: tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    code: u16,
    reason: &'static str,
) -> Result<(), tokio_tungstenite::tungstenite::Error> {
    use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode as Cc;
    let (mut sender, mut receiver) = ws_stream.split();
    let _ = sender
        .send(Message::Close(Some(CloseFrame {
            code: Cc::from(code),
            reason: reason.into(),
        })))
        .await;
    while receiver.next().await.is_some() {}
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::batching::{MSG_INPUT_BATCH, write_batch_frame};
    use bytes::Bytes;

    fn create_batch_frame(reports: &[(u8, Bytes)]) -> Vec<u8> {
        let mut out = Vec::new();
        write_batch_frame(&mut out, reports);
        out
    }

    #[test]
    fn test_batch_frame_empty() {
        let frame = create_batch_frame(&[]);
        assert_eq!(frame, vec![0x00]);
    }

    #[test]
    fn test_batch_frame_single_report() {
        let reports: Vec<(u8, Bytes)> = vec![(0x01, Bytes::from(&[0xAA, 0xBB][..]))];
        let frame = create_batch_frame(&reports);
        assert_eq!(frame, vec![0x00, 0x03, 0x00, 0x01, 0xAA, 0xBB]);
    }

    #[test]
    fn test_batch_frame_multiple_reports() {
        let reports: Vec<(u8, Bytes)> = vec![
            (0x01, Bytes::from(&[0xAA][..])),
            (0x02, Bytes::from(&[0xBB, 0xCC][..])),
        ];
        let frame = create_batch_frame(&reports);
        assert_eq!(
            frame,
            vec![0x00, 0x02, 0x00, 0x01, 0xAA, 0x03, 0x00, 0x02, 0xBB, 0xCC]
        );
    }

    #[test]
    fn test_batch_frame_empty_report() {
        let reports: Vec<(u8, Bytes)> = vec![(0x05, Bytes::from(&[][..]))];
        let frame = create_batch_frame(&reports);
        assert_eq!(frame, vec![0x00, 0x01, 0x00, 0x05]);
    }

    #[test]
    fn test_batch_frame_large_payload() {
        let payload = vec![0xAA; 128];
        let reports: Vec<(u8, Bytes)> = vec![(0x01, Bytes::from(payload))];
        let frame = create_batch_frame(&reports);
        assert_eq!(frame[0], 0x00);
        assert_eq!(frame[1], 0x81);
        assert_eq!(frame[2], 0x00);
        assert_eq!(frame[3], 0x01);
        assert_eq!(frame.len(), 4 + 128);
    }

    #[test]
    fn test_status_resp_success() {
        let buf = batching::make_status_resp(0x81, 42, 0);
        assert_eq!(buf, vec![0x81, 42, 0, 0, 0, 0]);
    }

    #[test]
    fn test_status_resp_error() {
        let buf = batching::make_status_resp(0x82, 1, 1);
        assert_eq!(buf, vec![0x82, 1, 0, 0, 0, 1]);
    }

    #[test]
    fn test_status_resp_large_req_id() {
        let buf = batching::make_status_resp(0x81, 0xDEAD, 0);
        assert_eq!(buf, vec![0x81, 0xAD, 0xDE, 0x00, 0x00, 0x00]);
    }

    #[test]
    fn test_feature_read_resp_success() {
        let buf = batching::make_feature_read_resp(42, 0, &[0xAA, 0xBB]);
        assert_eq!(buf, vec![0x83, 42, 0, 0, 0, 0, 2, 0, 0xAA, 0xBB]);
    }

    #[test]
    fn test_feature_read_resp_error() {
        let buf = batching::make_feature_read_resp(7, 1, &[]);
        assert_eq!(buf, vec![0x83, 7, 0, 0, 0, 1, 0, 0]);
    }

    #[test]
    fn test_feature_read_resp_large_data() {
        let data = vec![0xFF; 300];
        let buf = batching::make_feature_read_resp(0, 0, &data);
        assert_eq!(buf[0], 0x83);
        assert_eq!(buf[5], 0);
        let len = u16::from_le_bytes([buf[6], buf[7]]);
        assert_eq!(len as usize, data.len().min(0xFFFF));
        assert_eq!(&buf[8..], &data[..len as usize]);
    }

    #[test]
    fn test_batch_frame_uses_shared_writer() {
        let reports: Vec<(u8, Bytes)> = vec![(0x01, Bytes::from(&[0xAA][..]))];
        let frame = create_batch_frame(&reports);
        assert_eq!(frame[0], MSG_INPUT_BATCH);
    }
}
