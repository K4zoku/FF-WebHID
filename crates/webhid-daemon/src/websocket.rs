use std::sync::Arc;
use std::time::Duration;

use anyhow::Context as _;
use futures::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc};
use tokio::time::interval;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::Message;

use crate::device_mgr::DeviceManager;

/// Default flush interval for batching input reports (milliseconds).
const DEFAULT_BATCH_FLUSH_MS: u64 = 1;

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
        let query = req.uri().query().unwrap_or("");
        let token = extract_token(query);
        let mut holder = token_ref.lock().unwrap();
        *holder = token;
        Ok(res)
    })
    .await?;

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

    let (mut ws_sender, mut ws_receiver) = ws_stream.split();
    let (tx, mut rx) = mpsc::channel::<Message>(128);

    // --- Outgoing task: single owner of the ws_sender ---
    let outgoing_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if let Err(e) = ws_sender.send(msg).await {
                log::warn!("[ws] send error: {e}");
                break;
            }
        }
    });

    // --- Receiver task: handle incoming client frames (ping, close, etc.) ---
    let tx_for_receiver = tx.clone();
    let receiver_task = tokio::spawn(async move {
        while let Some(msg) = ws_receiver.next().await {
            match msg {
                Ok(Message::Ping(data)) => {
                    if let Err(_) = tx_for_receiver.send(Message::Pong(data)).await {
                        break;
                    }
                }
                Ok(Message::Close(_)) => break,
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
                        if let Err(_) = tx_for_sender.send(Message::Binary(frame.into())).await {
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
    Ok(())
}

fn extract_token(query: &str) -> Option<String> {
    query.split('&')
        .find(|p| p.starts_with("token="))
        .and_then(|p| p.split_once('='))
        .map(|(_, v)| v.to_string())
}

fn create_batch_frame(reports: &[Vec<u8>]) -> Vec<u8> {
    let total_size: usize = reports.iter().map(|r| 1 + r.len()).sum();
    let mut frame = Vec::with_capacity(total_size);
    for report in reports {
        frame.push(report.len() as u8);
        frame.extend_from_slice(report);
    }
    frame
}
