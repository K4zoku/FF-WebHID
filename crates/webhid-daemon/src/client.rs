use std::sync::Arc;

use tokio::io::{AsyncRead, BufReader};
use tokio::sync::{broadcast, mpsc};
use webhid::{IpcResponse, NmMessage, NmRequest, NmResponse, parse_packed_send, protocol};

use crate::{device_mgr::DeviceManager, hid};

pub async fn handle(
    reader: impl AsyncRead + Unpin + Send + 'static,
    writer: impl tokio::io::AsyncWrite + Unpin + Send + 'static,
    device_mgr: Arc<DeviceManager>,
    mut event_rx: broadcast::Receiver<IpcResponse>,
    ws_port: u16,
) -> anyhow::Result<()> {
    let mut reader = BufReader::new(reader);
    let (tx, mut rx) = mpsc::channel::<NmMessage>(1024);

    let writer_task = tokio::spawn(async move {
        let mut writer = tokio::io::BufWriter::new(writer);
        while let Some(msg) = rx.recv().await {
            if let Err(e) = protocol::write_message(&mut writer, &msg).await {
                log::warn!("[client] write error: {e}");
                break;
            }
        }
    });

    let tx_events = tx.clone();
    let device_mgr_for_events = Arc::clone(&device_mgr);
    let event_task = tokio::spawn(async move {
        loop {
            match event_rx.recv().await {
                Ok(ev) => {
                    if let webhid::IpcResponse::InputReport { ref device_id, .. } = ev {
                        if device_mgr_for_events.dataplane_mode(*device_id) == "ws" {
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
                    log::warn!("[client] dropped {n} events (lagged)");
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    loop {
        let request: NmRequest = match protocol::read_nm_request(&mut reader).await {
            Ok(r) => r,
            Err(e) => {
                // E7: Be graceful on InvalidData (JSON decode failure or bad
                // base64 inside a packed TLV). The WS handler already replies
                // with a JSON error and keeps the connection alive; the NM
                // path used to bail on any error, killing the whole NM
                // connection on a single malformed frame and forcing a
                // reconnect. We now reply with a 400-level response (no id
                // since we couldn't parse one) and keep reading the next
                // frame.
                //
                // Other error kinds (UnexpectedEof, ConnectionReset, …)
                // still terminate the loop — we cannot recover from those
                // because the byte stream is no longer aligned.
                if e.kind() == std::io::ErrorKind::InvalidData {
                    log::warn!("[client] malformed NM frame dropped: {e}");
                    let err_resp = NmMessage::Control(NmResponse::err(400));
                    if tx.send(err_resp).await.is_err() {
                        break;
                    }
                    continue;
                }
                if e.kind() != std::io::ErrorKind::UnexpectedEof {
                    log::warn!("[client] read error: {e}");
                }
                break;
            }
        };
        let response = dispatch(&device_mgr, request, ws_port).await;
        if tx.send(response).await.is_err() {
            break;
        }
    }

    event_task.abort();
    writer_task.abort();
    device_mgr.close_all_devices();
    Ok(())
}

async fn dispatch(device_mgr: &DeviceManager, req: NmRequest, ws_port: u16) -> NmMessage {
    let req_id = req.id();
    let resp: NmResponse = match req {
        NmRequest::Enumerate { .. } => match device_mgr.enumerate() {
            Ok(devices) => NmResponse::ok_with_devices(devices),
            Err(_) => NmResponse::err(500),
        },

        NmRequest::Open { device_id, .. } => match device_mgr.open(device_id) {
            Ok((dev_id, session_token)) => {
                NmResponse::ok_opened(dev_id, session_token, Some(ws_port))
            }
            Err(e) => {
                let msg = e.to_string();
                let code = if msg.contains("not found") || msg.contains("No such") {
                    404
                } else {
                    500
                };
                NmResponse::err(code)
            }
        },

        NmRequest::Close { device_id, .. } => match device_mgr.close(device_id) {
            Ok(()) => NmResponse::ok(),
            Err(e) => {
                let code = if e.to_string().contains("not open") {
                    404
                } else {
                    500
                };
                NmResponse::err(code)
            }
        },

        NmRequest::SendReport { packed, .. } => match parse_packed_send(&packed) {
            Ok((req_id, device_id, report_id, data)) => {
                let result_resp = match device_mgr.get_file(device_id) {
                    Err(_) => NmResponse::err(404),
                    Ok(dev_arc) => {
                        let data_owned = data.to_vec();
                        let result = tokio::task::spawn_blocking(move || {
                            let dev = dev_arc.lock().unwrap();
                            hid::write_report(&dev, report_id, &data_owned)
                        })
                        .await;
                        match result {
                            Ok(Ok(())) => NmResponse::ok(),
                            Ok(Err(_)) => NmResponse::err(500),
                            Err(_) => NmResponse::err(500),
                        }
                    }
                };
                let mut r = result_resp;
                r.id = Some(req_id);
                r
            }
            Err(_) => NmResponse::err(422),
        },

        NmRequest::ReceiveFeatureReport {
            device_id,
            report_id,
            ..
        } => match device_mgr.get_file(device_id) {
            Err(_) => NmResponse::err(404),
            Ok(dev_arc) => {
                let result = tokio::task::spawn_blocking(move || {
                    let dev = dev_arc.lock().unwrap();
                    hid::read_feature_report(&dev, report_id)
                })
                .await;
                match result {
                    Ok(Ok(data)) => NmResponse::ok_with_data(data),
                    Ok(Err(_)) => NmResponse::err(500),
                    Err(_) => NmResponse::err(500),
                }
            }
        },

        NmRequest::SendFeatureReport {
            device_id,
            report_id,
            data,
            ..
        } => match device_mgr.get_file(device_id) {
            Err(_) => NmResponse::err(404),
            Ok(dev_arc) => {
                let result = tokio::task::spawn_blocking(move || {
                    let dev = dev_arc.lock().unwrap();
                    hid::write_feature_report(&dev, report_id, &data)
                })
                .await;
                match result {
                    Ok(Ok(())) => NmResponse::ok(),
                    Ok(Err(_)) => NmResponse::err(500),
                    Err(_) => NmResponse::err(500),
                }
            }
        },

        NmRequest::SetDataPlane {
            device_id, mode, ..
        } => {
            device_mgr.set_dataplane_mode(device_id, &mode);
            NmResponse::ok()
        }

        NmRequest::Handshake { .. } => match device_mgr.get_or_create_control_token() {
            Ok(control_token) => NmResponse {
                status: Some(200),
                control_token: Some(control_token),
                ws_port: Some(ws_port),
                ..Default::default()
            },
            Err(_) => NmResponse::err(500),
        },
    };
    let mut resp = resp;
    if resp.id.is_none() {
        resp.id = req_id;
    }
    NmMessage::Control(resp)
}

fn ipc_event_to_nm(ev: IpcResponse) -> Option<NmMessage> {
    match ev {
        IpcResponse::DeviceConnected { device, .. } => {
            Some(NmMessage::Control(NmResponse::event_connect(device)))
        }
        IpcResponse::DeviceDisconnected { device, .. } => {
            Some(NmMessage::Control(NmResponse::event_disconnect(device)))
        }
        IpcResponse::InputReport {
            device_id,
            report_id,
            data,
            ..
        } => Some(NmMessage::packed_input_report(
            device_id,
            [(report_id, &data[..])],
        )),
        _ => {
            log::warn!("unexpected event: {ev:?}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use webhid::{DeviceInfo, types::{EVT_CONNECT, EVT_DISCONNECT, PKG_INPUT_REPORT}};

    fn dummy_device(id: u32) -> DeviceInfo {
        DeviceInfo {
            vendor_id: 0x1234,
            product_id: 0x5678,
            product_name: Some("Test".into()),
            manufacturer: None,
            serial_number: None,
            usage_page: None,
            usage: None,
            device_id: id,
            collections: vec![],
            max_input_report_size: 64,
        }
    }

    #[test]
    fn test_ipc_event_to_nm_connect() {
        let dev = dummy_device(42);
        let ev = IpcResponse::DeviceConnected {
            id: 0,
            device: dev.clone(),
        };
        let result = ipc_event_to_nm(ev);
        assert!(result.is_some());
        match result.unwrap() {
            NmMessage::Control(r) => {
                assert_eq!(r.event_type, Some(EVT_CONNECT));
                assert_eq!(r.device_id, Some(42));
                assert!(r.device.is_some());
            }
            _ => panic!("expected Control"),
        }
    }

    #[test]
    fn test_ipc_event_to_nm_disconnect() {
        let dev = dummy_device(99);
        let ev = IpcResponse::DeviceDisconnected {
            id: 0,
            device: dev.clone(),
        };
        let result = ipc_event_to_nm(ev);
        assert!(result.is_some());
        match result.unwrap() {
            NmMessage::Control(r) => {
                assert_eq!(r.event_type, Some(EVT_DISCONNECT));
                assert_eq!(r.device_id, Some(99));
            }
            _ => panic!("expected Control"),
        }
    }

    #[test]
    fn test_ipc_event_to_nm_input_report() {
        let ev = IpcResponse::InputReport {
            id: 0,
            device_id: 7,
            report_id: 1,
            data: bytes::Bytes::from_static(&[0xAA, 0xBB]),
        };
        let result = ipc_event_to_nm(ev);
        assert!(result.is_some());
        match result.unwrap() {
            NmMessage::PackedData(buf) => {
                assert_eq!(buf[0], PKG_INPUT_REPORT);
                assert_eq!(&buf[1..5], &7u32.to_le_bytes());
                assert_eq!(buf[5], 1); // report_id
                let payload_len = u16::from_le_bytes([buf[6], buf[7]]) as usize;
                assert_eq!(payload_len, 2);
                assert_eq!(&buf[8..10], &[0xAA, 0xBB]);
            }
            _ => panic!("expected PackedData"),
        }
    }

    #[test]
    fn test_ipc_event_to_nm_ignores_non_event() {
        let ev = IpcResponse::Ok { id: 42 };
        assert!(ipc_event_to_nm(ev).is_none());
    }

    #[test]
    fn test_ipc_event_to_nm_ignores_error() {
        let ev = IpcResponse::Error {
            id: 1,
            message: "test".into(),
        };
        assert!(ipc_event_to_nm(ev).is_none());
    }
}
