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

use tokio::io::BufReader;
use tokio::net::UnixStream;
use tokio::sync::{broadcast, mpsc};
use webhid::{protocol, IpcRequest, IpcResponse};

use crate::{device_mgr::DeviceManager, hid};

pub async fn handle(
    stream: UnixStream,
    client_id: u64,
    device_mgr: Arc<DeviceManager>,
    mut event_rx: broadcast::Receiver<IpcResponse>,
) -> anyhow::Result<()> {
    let (reader, writer) = stream.into_split();
    let mut reader = BufReader::new(reader);

    // All outbound messages go through this channel so the writer task owns
    // the socket write half exclusively.
    let (tx, mut rx) = mpsc::channel::<IpcResponse>(128);

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

        log::debug!("[client {client_id}] request: {request:?}");
        let response = dispatch(&device_mgr, client_id, request).await;
        log::debug!("[client {client_id}] response: {response:?}");

        if tx.send(response).await.is_err() {
            break; // writer task already gone
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

async fn dispatch(device_mgr: &DeviceManager, client_id: u64, req: IpcRequest) -> IpcResponse {
    let id = req.id();

    match req {
        IpcRequest::Enumerate { .. } => match device_mgr.enumerate() {
            Ok(devices) => IpcResponse::Devices { id, devices },
            Err(e) => IpcResponse::Error { id, message: e.to_string() },
        },

        IpcRequest::Open { vendor_id, product_id, .. } => {
            match device_mgr.open(vendor_id, product_id, client_id) {
                Ok(device_id) => IpcResponse::Opened { id, device_id },
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

        IpcRequest::Write { device_id, data, .. } => {
            match device_mgr.get_file(&device_id, client_id) {
                Err(e) => IpcResponse::Error { id, message: e.to_string() },
                Ok(file_arc) => {
                    let result = tokio::task::spawn_blocking(move || {
                        let file = file_arc.lock().unwrap();
                        hid::write_report(&file, &data)
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

        IpcRequest::ReadFeature { device_id, report_id, .. } => {
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

        IpcRequest::WriteFeature { device_id, data, .. } => {
            match device_mgr.get_file(&device_id, client_id) {
                Err(e) => IpcResponse::Error { id, message: e.to_string() },
                Ok(file_arc) => {
                    let result = tokio::task::spawn_blocking(move || {
                        let file = file_arc.lock().unwrap();
                        hid::write_feature_report(&file, &data)
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
