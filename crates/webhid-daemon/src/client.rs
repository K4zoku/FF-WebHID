//! Handles a single native-messaging process connection.
//!
//! Two concurrent subtasks share the write half of the socket via an mpsc
//! channel:
//!
//!   1. **Request loop** – reads [`IpcRequest`]s from the client, dispatches
//!      them to the [`DeviceManager`], and enqueues the [`IpcResponse`].
//!   2. **Event forwarder** – subscribes to the broadcast bus and enqueues
//!      every hot-plug / input-report event.
//!
//! A dedicated **writer task** drains the mpsc channel and serialises each
//! message to the socket, ensuring frames are never interleaved.

use std::sync::Arc;
use std::time::Instant;

use tokio::io::BufReader;
use tokio::net::UnixStream;
use tokio::sync::{broadcast, mpsc};
use webhid::{protocol, IpcRequest, IpcResponse};

use crate::{device_mgr::DeviceManager, hid};

/// Threshold below which we don't log timing per-request.
const SLOW_THRESHOLD_MS: u128 = 5;

pub async fn handle(
    stream: UnixStream,
    client_id: u64,
    device_mgr: Arc<DeviceManager>,
    mut event_rx: broadcast::Receiver<IpcResponse>,
    ws_port: u16,
) -> anyhow::Result<()> {
    let (reader, writer) = stream.into_split();
    let mut reader = BufReader::new(reader);

    // All outbound messages go through this channel so the writer task owns
    // the socket write half exclusively.
    let (tx, mut rx) = mpsc::channel::<IpcResponse>(1024);

    // --- Writer task ---
    let writer_task = tokio::spawn(async move {
        let mut writer = tokio::io::BufWriter::new(writer);
        while let Some(msg) = rx.recv().await {
            if let Err(e) = protocol::write_message(&mut writer, &msg).await {
                log::warn!("[client {client_id}] write error: {e}");
                break;
            }
        }
    });

    // --- Event-forwarder task ---
    let tx_events = tx.clone();
    let event_task = tokio::spawn(async move {
        loop {
            match event_rx.recv().await {
                Ok(ev) => {
                    if tx_events.send(ev).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    log::warn!("[client {client_id}] dropped {n} events (lagged)");
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    // --- Request loop ---
    loop {
        let t_loop_start = Instant::now();
        let request: IpcRequest = match protocol::read_message(&mut reader).await {
            Ok(r) => r,
            Err(e) => {
                // EOF is normal when Firefox closes the native-messaging port.
                if e.kind() != std::io::ErrorKind::UnexpectedEof {
                    log::warn!("[client {client_id}] read error: {e}");
                }
                break;
            }
        };
        let t_read_ipc = t_loop_start.elapsed();
        let req_label = request.action_label();
        let req_id = request.id();

        log::debug!("[client {client_id}] request: {request:?}");
        let t_dispatch_start = Instant::now();
        let response = dispatch(&device_mgr, client_id, request, ws_port).await;
        let t_dispatch = t_dispatch_start.elapsed();
        log::debug!("[client {client_id}] response: {response:?}");

        let t_send_start = Instant::now();
        if tx.send(response).await.is_err() {
            break; // writer task already gone
        }
        let t_send = t_send_start.elapsed();

        let total = t_loop_start.elapsed();
        let total_ms = total.as_millis();
        let log_msg = format!(
            "[client-timing {client_id}] id={:<5} action={:<20} total={:>5}ms  read_ipc={:>4}ms  dispatch={:>5}ms  enqueue={:>4}ms",
            req_id,
            req_label,
            total_ms,
            t_read_ipc.as_millis(),
            t_dispatch.as_millis(),
            t_send.as_millis(),
        );
        if total_ms >= SLOW_THRESHOLD_MS {
            log::info!("{}", log_msg);
        } else {
            log::debug!("{}", log_msg);
        }
    }

    // Tear down subtasks and release all devices this client had open.
    event_task.abort();
    writer_task.abort();
    device_mgr.close_client_devices(client_id);

    Ok(())
}

// ---------------------------------------------------------------------------
// Request dispatch
// ---------------------------------------------------------------------------

async fn dispatch(device_mgr: &DeviceManager, client_id: u64, req: IpcRequest, ws_port: u16) -> IpcResponse {
    let id = req.id();

    match req {
        IpcRequest::Enumerate { .. } => match device_mgr.enumerate() {
            Ok(devices) => IpcResponse::Devices { id, devices },
            Err(e) => IpcResponse::Error { id, message: e.to_string() },
        },

        IpcRequest::Open { device_path, .. } => {
            match device_mgr.open(&device_path, client_id) {
                Ok((device_id, session_token)) => IpcResponse::Opened { id, device_id, session_token, ws_port: Some(ws_port) },
                Err(e) => IpcResponse::Error { id, message: e.to_string() },
            }
        }

        IpcRequest::Close { device_id, .. } => match device_mgr.close(&device_id, client_id) {
            Ok(()) => IpcResponse::Ok { id },
            Err(e) => IpcResponse::Error { id, message: e.to_string() },
        },

        IpcRequest::Read { device_id, timeout_ms, .. } => {
            match device_mgr.get_file(&device_id, client_id) {
                Err(e) => IpcResponse::Error { id, message: e.to_string() },
                Ok(file_arc) => {
                    let result = tokio::task::spawn_blocking(move || {
                        let file = file_arc.lock().unwrap();
                        hid::read_with_timeout(&file, timeout_ms)
                    })
                    .await;

                    match result {
                        Ok(Ok(data)) => IpcResponse::Data { id, data },
                        Ok(Err(e)) => IpcResponse::Error { id, message: e.to_string() },
                        Err(e) => IpcResponse::Error { id, message: e.to_string() },
                    }
                }
            }
        }

        IpcRequest::SendReport { device_id, report_id, data, .. } => {
            match device_mgr.get_file(&device_id, client_id) {
                Err(e) => IpcResponse::Error { id, message: e.to_string() },
                Ok(file_arc) => {
                    let data_len = data.len();
                    let result = tokio::task::spawn_blocking(move || {
                        let t_lock_start = Instant::now();
                        let file = file_arc.lock().unwrap();
                        let t_locked = t_lock_start.elapsed();
                        let t_op_start = Instant::now();
                        let r = hid::write_report(&file, report_id, &data);
                        let t_op = t_op_start.elapsed();
                        log::info!(
                            "[hid-timing] sendreport dev='{}' data_len={} lock_wait_ms={} op_ms={}",
                            device_id, data_len,
                            t_locked.as_millis(),
                            t_op.as_millis(),
                        );
                        r
                    })
                    .await;

                    match result {
                        Ok(Ok(())) => IpcResponse::Ok { id },
                        Ok(Err(e)) => IpcResponse::Error { id, message: e.to_string() },
                        Err(e) => IpcResponse::Error { id, message: e.to_string() },
                    }
                }
            }
        }

        IpcRequest::ReceiveFeatureReport { device_id, report_id, .. } => {
            match device_mgr.get_file(&device_id, client_id) {
                Err(e) => IpcResponse::Error { id, message: e.to_string() },
                Ok(file_arc) => {
                    let result = tokio::task::spawn_blocking(move || {
                        let file = file_arc.lock().unwrap();
                        hid::read_feature_report(&file, report_id)
                    })
                    .await;

                    match result {
                        Ok(Ok(data)) => IpcResponse::Data { id, data },
                        Ok(Err(e)) => IpcResponse::Error { id, message: e.to_string() },
                        Err(e) => IpcResponse::Error { id, message: e.to_string() },
                    }
                }
            }
        }

        IpcRequest::SendFeatureReport { device_id, report_id, data, .. } => {
            match device_mgr.get_file(&device_id, client_id) {
                Err(e) => IpcResponse::Error { id, message: e.to_string() },
                Ok(file_arc) => {
                    let data_len = data.len();
                    let result = tokio::task::spawn_blocking(move || {
                        let t_lock_start = Instant::now();
                        let file = file_arc.lock().unwrap();
                        let t_locked = t_lock_start.elapsed();
                        let t_op_start = Instant::now();
                        let r = hid::write_feature_report(&file, report_id, &data);
                        let t_op = t_op_start.elapsed();
                        log::info!(
                            "[hid-timing] sendfeaturereport dev='{}' report_id={} data_len={} lock_wait_ms={} op_ms={}",
                            device_id, report_id, data_len,
                            t_locked.as_millis(),
                            t_op.as_millis(),
                        );
                        r
                    })
                    .await;

                    match result {
                        Ok(Ok(())) => IpcResponse::Ok { id },
                        Ok(Err(e)) => IpcResponse::Error { id, message: e.to_string() },
                        Err(e) => IpcResponse::Error { id, message: e.to_string() },
                    }
                }
            }
        }
    }
}
