use std::sync::Arc;

use crate::blocklist::ReportType;
use tokio::io::{AsyncRead, BufReader};
use tokio::sync::{broadcast, mpsc};
use webhid::{IpcResponse, NmMessage, NmRequest, NmResponse, parse_packed_send, protocol};

use crate::device_mgr::DeviceManager;
use crate::{hid, webtransport::WtState};

pub async fn handle(
    reader: impl AsyncRead + Unpin + Send + 'static,
    writer: impl tokio::io::AsyncWrite + Unpin + Send + 'static,
    device_mgr: Arc<DeviceManager>,
    client_id: u64,
    mut event_rx: broadcast::Receiver<IpcResponse>,
    ws_port: u16,
    wt_state: Arc<WtState>,
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
                    if !relay_client_event(ev, &device_mgr_for_events, client_id, &tx_events).await
                    {
                        break;
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
        let Some(request) = read_next_request(&mut reader, &tx).await else {
            break;
        };
        let response = dispatch(&device_mgr, client_id, request, ws_port, &wt_state).await;
        if tx.send(response).await.is_err() {
            break;
        }
    }

    event_task.abort();
    writer_task.abort();
    device_mgr.close_all_for_client(client_id);
    Ok(())
}

/// Forwards one broadcast event to the client stream, force-closing
/// disconnected devices and skipping input reports for sessions that are not
/// exposed over NM. Returns false when the client is gone and the event task
/// should stop.
async fn relay_client_event(
    ev: IpcResponse,
    device_mgr: &DeviceManager,
    client_id: u64,
    tx: &mpsc::Sender<NmMessage>,
) -> bool {
    if let webhid::IpcResponse::DeviceDisconnected { device, .. } = &ev {
        device_mgr.force_close(device.device_id);
    }
    if let webhid::IpcResponse::InputReport { device_id, .. } = &ev
        && !device_mgr.has_nm_session_for_client(*device_id, client_id)
    {
        return true;
    }
    if tx.send(ipc_event_to_nm(ev)).await.is_err() {
        return false;
    }
    true
}

/// Reads the next NM request frame. Malformed frames are answered with 400
/// and skipped. Returns None once the stream ends, an oversized frame is
/// seen (the byte boundary is unrecoverable), or a fatal error occurs.
async fn read_next_request<R: AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
    tx: &mpsc::Sender<NmMessage>,
) -> Option<NmRequest> {
    loop {
        match protocol::read_nm_request(reader).await {
            Ok(r) => return Some(r),
            Err(protocol::FrameReadError::Oversized { declared }) => {
                log::warn!(
                    "[client] oversized NM frame ({declared} bytes); closing connection (stream desync)"
                );
                return None;
            }
            Err(protocol::FrameReadError::Malformed(e)) => {
                log::warn!("[client] malformed NM frame dropped: {e}");
                let err_resp = NmMessage::Control(NmResponse::err(400));
                if tx.send(err_resp).await.is_err() {
                    return None;
                }
                continue;
            }
            Err(protocol::FrameReadError::Io(e)) => {
                if e.kind() != std::io::ErrorKind::UnexpectedEof {
                    log::warn!("[client] read error: {e}");
                }
                return None;
            }
        }
    }
}

async fn dispatch(
    device_mgr: &DeviceManager,
    client_id: u64,
    req: NmRequest,
    ws_port: u16,
    wt_state: &WtState,
) -> NmMessage {
    let req_id = req.id();
    let resp: NmResponse = match req {
        NmRequest::Enumerate { filter, .. } => handle_enumerate(device_mgr, filter.as_ref()),
        NmRequest::Open { device_id, .. } => {
            handle_open(device_mgr, device_id, ws_port, client_id)
        }
        NmRequest::Close {
            device_id,
            session_token,
            ..
        } => handle_close(device_mgr, device_id, session_token, client_id),
        NmRequest::SendReport { packed, .. } => handle_send_report(device_mgr, packed).await,
        NmRequest::ReceiveFeatureReport {
            device_id,
            report_id,
            ..
        } => handle_receive_feature_report(device_mgr, device_id, report_id).await,
        NmRequest::SendFeatureReport {
            device_id,
            report_id,
            data,
            ..
        } => handle_send_feature_report(device_mgr, device_id, report_id, data).await,
        NmRequest::SetDataPlane {
            device_id,
            mode,
            session_token,
            ..
        } => handle_set_data_plane(device_mgr, device_id, mode, session_token, client_id),
        NmRequest::Handshake { .. } => handle_handshake(device_mgr, ws_port, wt_state),
    };
    let mut resp = resp;
    if resp.id.is_none() {
        resp.id = req_id;
    }
    NmMessage::Control(resp)
}

fn handle_enumerate(
    device_mgr: &DeviceManager,
    filter: Option<&webhid::EnumerateFilter>,
) -> NmResponse {
    let result = match filter {
        Some(filter) => device_mgr.enumerate_filtered(Some(filter)),
        None => device_mgr.enumerate(),
    };
    match result {
        Ok(devices) => NmResponse::ok_with_devices(devices),
        Err(_) => NmResponse::err(500),
    }
}
fn handle_open(
    device_mgr: &DeviceManager,
    device_id: u32,
    ws_port: u16,
    client_id: u64,
) -> NmResponse {
    let mut resp = match device_mgr.open(device_id, client_id) {
        Ok((dev_id, session_token)) => {
            NmResponse::ok_opened(dev_id, Some(session_token), Some(ws_port))
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
    };
    resp.hid_permission = Some(crate::hid::hid_permission());
    resp
}

fn handle_close(
    device_mgr: &DeviceManager,
    device_id: u32,
    session_token: Option<String>,
    client_id: u64,
) -> NmResponse {
    let Some(token) = session_token else {
        return NmResponse::err(400);
    };
    match device_mgr.close(device_id, &token, client_id) {
        Ok(()) => NmResponse::ok(),
        Err(e) => {
            let msg = e.to_string();
            let code = if msg.contains("owned by another") {
                403
            } else if msg.contains("not open") {
                404
            } else {
                500
            };
            log::warn!("[nm] close dev={device_id:#x} rejected: {msg}");
            NmResponse::err(code)
        }
    }
}

async fn handle_send_report(device_mgr: &DeviceManager, packed: Vec<u8>) -> NmResponse {
    let Ok((req_id, device_id, report_id, data)) = parse_packed_send(&packed) else {
        return NmResponse::err(422);
    };
    let mut resp = match report_precheck(
        device_mgr,
        device_id,
        report_id,
        ReportType::Output,
        Some(data.len()),
    ) {
        Ok(()) => match write_blocking(device_mgr, device_id, report_id, data, false).await {
            Ok(()) => NmResponse::ok(),
            Err(e) => e,
        },
        Err(e) => e,
    };
    resp.id = Some(req_id);
    resp
}

async fn handle_receive_feature_report(
    device_mgr: &DeviceManager,
    device_id: u32,
    report_id: u8,
) -> NmResponse {
    match report_precheck(device_mgr, device_id, report_id, ReportType::Feature, None) {
        Ok(()) => match read_feature_report_blocking(device_mgr, device_id, report_id).await {
            Ok(data) => NmResponse::ok_with_data(data),
            Err(e) => e,
        },
        Err(e) => e,
    }
}

async fn handle_send_feature_report(
    device_mgr: &DeviceManager,
    device_id: u32,
    report_id: u8,
    data: Vec<u8>,
) -> NmResponse {
    match report_precheck(
        device_mgr,
        device_id,
        report_id,
        ReportType::Feature,
        Some(data.len()),
    ) {
        Ok(()) => match write_blocking(device_mgr, device_id, report_id, &data, true).await {
            Ok(()) => NmResponse::ok(),
            Err(e) => e,
        },
        Err(e) => e,
    }
}

fn handle_set_data_plane(
    device_mgr: &DeviceManager,
    device_id: u32,
    mode: String,
    session_token: Option<String>,
    client_id: u64,
) -> NmResponse {
    let Some(token) = session_token else {
        return NmResponse::err(400);
    };
    match device_mgr.set_dataplane_mode(device_id, &token, &mode, client_id) {
        Ok(()) => NmResponse::ok(),
        Err(e) => {
            let msg = e.to_string();
            let code = if msg.contains("owned by another") {
                403
            } else if msg.contains("invalid data plane mode") {
                400
            } else {
                404
            };
            log::warn!("[nm] setDataPlane dev={device_id:#x} rejected: {msg}");
            NmResponse::err(code)
        }
    }
}

fn handle_handshake(device_mgr: &DeviceManager, ws_port: u16, wt_state: &WtState) -> NmResponse {
    let (wt_port, wt_cert_hash) = match wt_state.ensure_current() {
        Some((port, hash)) => (Some(port), Some(hash)),
        None => (None, None),
    };
    NmResponse {
        status: Some(200),
        ws_port: Some(ws_port),
        ws_nonce: Some(device_mgr.ws_nonce().to_string()),
        wt_port,
        wt_cert_hash,
        hid_permission: Some(crate::hid::hid_permission()),
        ..Default::default()
    }
}

/// Shared report pre-checks: blocklist first, then Chromium-style
/// validation. Ok(()) means the report may proceed; Err carries the
/// response to return instead.
#[allow(clippy::result_large_err)]
fn report_precheck(
    device_mgr: &DeviceManager,
    device_id: u32,
    report_id: u8,
    report_type: ReportType,
    payload_len: Option<usize>,
) -> Result<(), NmResponse> {
    device_mgr
        .report_send_allowed(device_id, report_id, report_type, payload_len)
        .map_err(|reason| match reason {
            crate::device_mgr::SendReject::Blocked => {
                log::warn!(
                    "[nm] send blocked dev={device_id:#x} report={report_id} type={report_type:?} len={payload_len:?}"
                );
                NmResponse::err(403)
            }
            crate::device_mgr::SendReject::Invalid => {
                log::warn!(
                    "[nm] send invalid dev={device_id:#x} report={report_id} type={report_type:?} len={payload_len:?}"
                );
                NmResponse::err(500)
            }
        })
}

/// Resolves the open device handle, mapping a missing device to a 404.
#[allow(clippy::result_large_err)]
fn open_device(
    device_mgr: &DeviceManager,
    device_id: u32,
) -> Result<crate::device_mgr::DeviceHandle, NmResponse> {
    device_mgr
        .get_file_logged(device_id)
        .ok_or_else(|| NmResponse::err(404))
}

async fn write_blocking(
    device_mgr: &DeviceManager,
    device_id: u32,
    report_id: u8,
    data: &[u8],
    feature: bool,
) -> Result<(), NmResponse> {
    let dev_arc = open_device(device_mgr, device_id)?;
    let data_owned = data.to_vec();
    match crate::device_mgr::run_device_op(dev_arc, move |d| {
        if feature {
            hid::write_feature_report(d, report_id, &data_owned)
        } else {
            hid::write_report(d, report_id, &data_owned)
        }
    })
    .await
    {
        Ok(()) => Ok(()),
        Err(e) => {
            log::warn!(
                "[nm] write failed dev={device_id:#x} report={report_id} len={} feature={feature}: {e}",
                data.len()
            );
            Err(NmResponse::err(500))
        }
    }
}

async fn read_feature_report_blocking(
    device_mgr: &DeviceManager,
    device_id: u32,
    report_id: u8,
) -> Result<Vec<u8>, NmResponse> {
    let dev_arc = open_device(device_mgr, device_id)?;
    let buf_size = device_mgr.read_buf_size(device_id);
    match crate::device_mgr::run_device_op(dev_arc, move |d| {
        hid::read_feature_report(d, report_id, buf_size)
    })
    .await
    {
        Ok(data) => Ok(data),
        Err(_) => Err(NmResponse::err(500)),
    }
}

fn ipc_event_to_nm(ev: IpcResponse) -> NmMessage {
    match ev {
        IpcResponse::DeviceConnected { device } => {
            NmMessage::Control(NmResponse::event_connect(device))
        }
        IpcResponse::DeviceDisconnected { device } => {
            NmMessage::Control(NmResponse::event_disconnect(device))
        }
        IpcResponse::InputReport {
            device_id,
            report_id,
            data,
        } => NmMessage::packed_input_report(device_id, [(report_id, &data[..])]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use webhid::{
        DeviceInfo,
        types::{EVT_CONNECT, EVT_DISCONNECT, PKG_INPUT_REPORT},
    };

    fn dummy_device(id: u32) -> DeviceInfo {
        DeviceInfo {
            vendor_id: 0x1234,
            product_id: 0x5678,
            product_name: "Test".into(),
            manufacturer: None,
            serial_number: None,
            usage_page: None,
            usage: None,
            device_id: id,
            descriptor_parse_failed: false,
            collections: vec![],
            max_input_report_size: 64,
            raw_descriptor: Vec::new(),
        }
    }

    #[test]
    fn test_ipc_event_to_nm_connect() {
        let dev = dummy_device(42);
        let ev = IpcResponse::DeviceConnected {
            device: dev.clone(),
        };
        let result = ipc_event_to_nm(ev);
        match result {
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
            device: dev.clone(),
        };
        let result = ipc_event_to_nm(ev);
        match result {
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
            device_id: 7,
            report_id: 1,
            data: bytes::Bytes::from_static(&[0xAA, 0xBB]),
        };
        let result = ipc_event_to_nm(ev);
        match result {
            NmMessage::PackedData(buf) => {
                assert_eq!(buf[0], PKG_INPUT_REPORT);
                assert_eq!(&buf[1..5], &7u32.to_le_bytes());
                assert_eq!(buf[5], 1);
                let payload_len = u16::from_le_bytes([buf[6], buf[7]]) as usize;
                assert_eq!(payload_len, 2);
                assert_eq!(&buf[8..10], &[0xAA, 0xBB]);
            }
            _ => panic!("expected PackedData"),
        }
    }
}
