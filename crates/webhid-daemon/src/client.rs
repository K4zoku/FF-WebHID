//! Handles a single native-messaging process connection.
//!
//! Two concurrent subtasks share the write half of the socket via an mpsc
//! channel:
//!
//!   1. **Request loop** – reads [`NmRequest`]s from the client, dispatches
//!      them to the [`DeviceManager`], and enqueues the [`NmResponse`].
//!   2. **Event forwarder** – subscribes to the broadcast bus and enqueues
//!      every hot-plug / input-report event (converted to [`NmResponse`]).
//!
//! A dedicated **writer task** drains the mpsc channel and serialises each
//! message to the socket, ensuring frames are never interleaved.

use std::sync::Arc;

use tokio::io::{AsyncRead, AsyncWrite, BufReader};
use tokio::sync::{broadcast, mpsc};
use webhid::{protocol, IpcResponse, NmRequest, NmResponse};

use crate::{device_mgr::DeviceManager, hid};

pub async fn handle(
    stream: impl AsyncRead + AsyncWrite + Unpin + Send + 'static,
    client_id: u64,
    device_mgr: Arc<DeviceManager>,
    mut event_rx: broadcast::Receiver<IpcResponse>,
    ws_port: u16,
) -> anyhow::Result<()> {
    let (reader, writer) = tokio::io::split(stream);
    let mut reader = BufReader::new(reader);

    let (tx, mut rx) = mpsc::channel::<NmResponse>(1024);

    // Announce capabilities (WS port) to the client immediately so the
    // addon can connect its data-plane Worker before opening any device.
    let _ = tx
        .send(NmResponse {
            event_type: Some("hello".into()),
            ws_port: Some(ws_port),
            ..Default::default()
        })
        .await;

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
    let device_mgr_for_events = Arc::clone(&device_mgr);
    let event_task = tokio::spawn(async move {
        loop {
            match event_rx.recv().await {
                Ok(ev) => {
                    if let webhid::IpcResponse::InputReport { ref device_id, .. } = ev {
                        if device_mgr_for_events.is_ws_active(device_id) {
                            continue;
                        }
                    }
                    if let Some(nm_ev) = ipc_event_to_nm(ev) {
                        if tx_events.send(nm_ev).await.is_err() {
                            break;
                        }
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    log::warn!("[client {client_id}] dropped {n} events (lagged)");
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    loop {
        let request: NmRequest = match protocol::read_message(&mut reader).await {
            Ok(r) => r,
            Err(e) => {
                if e.kind() != std::io::ErrorKind::UnexpectedEof {
                    log::warn!("[client {client_id}] read error: {e}");
                }
                break;
            }
        };
        let response = dispatch(&device_mgr, client_id, request, ws_port).await;
        if tx.send(response).await.is_err() {
            break;
        }
    }

    event_task.abort();
    writer_task.abort();
    device_mgr.close_client_devices(client_id);

    Ok(())
}

// ---------------------------------------------------------------------------
// Request dispatch
// ---------------------------------------------------------------------------

async fn dispatch(
    device_mgr: &DeviceManager,
    client_id: u64,
    req: NmRequest,
    ws_port: u16,
) -> NmResponse {
    let id = req.id();
    let mut resp = match req {
        NmRequest::Enumerate { .. } => match device_mgr.enumerate() {
            Ok(devices) => NmResponse::ok_with_devices(devices),
            Err(e) => NmResponse::err(e.to_string()),
        },

        NmRequest::Open { device_id, .. } => match device_mgr.open(&device_id, client_id) {
            Ok((dev_id, session_token)) => {
                NmResponse::ok_opened(dev_id, session_token, Some(ws_port))
            }
            Err(e) => NmResponse::err(e.to_string()),
        },

        NmRequest::Close { device_id, .. } => match device_mgr.close(&device_id, client_id) {
            Ok(()) => NmResponse::ok(),
            Err(e) => NmResponse::err(e.to_string()),
        },

        NmRequest::SendReport {
            device_id,
            report_id,
            data,
            ..
        } => match device_mgr.get_file(&device_id, client_id) {
            Err(e) => NmResponse::err(e.to_string()),
            Ok(dev_arc) => {
                let result = tokio::task::spawn_blocking(move || {
                    let dev = dev_arc.lock().unwrap();
                    hid::write_report(&dev, report_id, &data)
                })
                .await;
                match result {
                    Ok(Ok(())) => NmResponse::ok(),
                    Ok(Err(e)) => NmResponse::err(e.to_string()),
                    Err(e) => NmResponse::err(e.to_string()),
                }
            }
        },

        NmRequest::ReceiveFeatureReport {
            device_id,
            report_id,
            ..
        } => match device_mgr.get_file(&device_id, client_id) {
            Err(e) => NmResponse::err(e.to_string()),
            Ok(dev_arc) => {
                let result = tokio::task::spawn_blocking(move || {
                    let dev = dev_arc.lock().unwrap();
                    hid::read_feature_report(&dev, report_id)
                })
                .await;
                match result {
                    Ok(Ok(data)) => NmResponse::ok_with_data(data),
                    Ok(Err(e)) => NmResponse::err(e.to_string()),
                    Err(e) => NmResponse::err(e.to_string()),
                }
            }
        },

        NmRequest::SendFeatureReport {
            device_id,
            report_id,
            data,
            ..
        } => match device_mgr.get_file(&device_id, client_id) {
            Err(e) => NmResponse::err(e.to_string()),
            Ok(dev_arc) => {
                let result = tokio::task::spawn_blocking(move || {
                    let dev = dev_arc.lock().unwrap();
                    hid::write_feature_report(&dev, report_id, &data)
                })
                .await;
                match result {
                    Ok(Ok(())) => NmResponse::ok(),
                    Ok(Err(e)) => NmResponse::err(e.to_string()),
                    Err(e) => NmResponse::err(e.to_string()),
                }
            }
        },
    };
    resp.id = id;
    resp
}

// ---------------------------------------------------------------------------
// Event conversion  (internal broadcast  →  NmResponse for the socket)
// ---------------------------------------------------------------------------

fn ipc_event_to_nm(ev: IpcResponse) -> Option<NmResponse> {
    match ev {
        IpcResponse::DeviceConnected { device, .. } => Some(NmResponse::event_connect(device)),

        IpcResponse::DeviceDisconnected { device, .. } => Some(NmResponse::event_disconnect(device)),

        IpcResponse::InputReport {
            device_id,
            report_id,
            data,
            ..
        } => Some(NmResponse::event_input_report(device_id, report_id, data)),

        IpcResponse::Hello { ws_port, .. } => Some(NmResponse {
            event_type: Some("hello".into()),
            ws_port: Some(ws_port),
            ..Default::default()
        }),

        _ => {
            log::warn!("unexpected event: {ev:?}");
            None
        }
    }
}
