use std::time::Duration;

use bytes::Bytes;
use tokio::sync::broadcast;

pub const MSG_SEND_REPORT: u8 = 0x01;
pub const MSG_SEND_FEATURE_REPORT: u8 = 0x02;
pub const MSG_RECEIVE_FEATURE_REPORT: u8 = 0x03;

pub const RESP_SEND_REPORT: u8 = 0x81;
pub const RESP_SEND_FEATURE_REPORT: u8 = 0x82;
pub const RESP_RECEIVE_FEATURE_REPORT: u8 = 0x83;

pub const MSG_INPUT_BATCH: u8 = 0x00;

const DEFAULT_BATCH_FLUSH_MS: u64 = 0;
const ADAPTIVE_COALESCE_US: u64 = 25;

pub fn write_batch_frame(out: &mut Vec<u8>, reports: &[(u8, Bytes)]) {
    out.clear();
    let total_size: usize = 1 + reports.iter().map(|(_, d)| 2 + 1 + d.len()).sum::<usize>();
    out.reserve(total_size);
    out.push(MSG_INPUT_BATCH);
    for (report_id, data) in reports {
        let len = (1 + data.len()) as u16;
        out.push((len & 0xFF) as u8);
        out.push(((len >> 8) & 0xFF) as u8);
        out.push(*report_id);
        out.extend_from_slice(data);
    }
}

fn handle_event<F>(
    event_result: Result<webhid::IpcResponse, broadcast::error::RecvError>,
    device_id: u32,
    batch: &mut Vec<(u8, Bytes)>,
    flush: &mut F,
) -> bool
where
    F: FnMut(Vec<u8>) -> bool,
{
    match event_result {
        Ok(webhid::IpcResponse::InputReport {
            device_id: evt_device_id,
            report_id,
            data,
            ..
        }) => {
            if evt_device_id == device_id {
                log::trace!(
                    "[sender] InputReport device={:#x} report_id={} len={}",
                    device_id,
                    report_id,
                    data.len(),
                );
                batch.push((report_id, data));
            }
        }
        Ok(_) => {}
        Err(broadcast::error::RecvError::Lagged(n)) => {
            log::warn!("[sender] broadcast lagged by {n} events, flushing batch");
            if !batch.is_empty() {
                let mut tmp = Vec::with_capacity(256);
                write_batch_frame(&mut tmp, batch);
                if !flush(tmp) {
                    return false;
                }
                batch.clear();
            }
        }
        Err(broadcast::error::RecvError::Closed) => return false,
    }
    true
}

fn drain_available<F>(
    rx: &mut broadcast::Receiver<webhid::IpcResponse>,
    device_id: u32,
    batch: &mut Vec<(u8, Bytes)>,
    flush: &mut F,
) where
    F: FnMut(Vec<u8>) -> bool,
{
    loop {
        match rx.try_recv() {
            Ok(ev) => {
                if !handle_event(Ok(ev), device_id, batch, flush) {
                    break;
                }
            }
            Err(broadcast::error::TryRecvError::Empty) => break,
            Err(broadcast::error::TryRecvError::Closed) => break,
            Err(broadcast::error::TryRecvError::Lagged(n)) => {
                log::warn!("[sender] drain lagged by {n} events");
                if !batch.is_empty() {
                    let mut tmp = Vec::with_capacity(256);
                    write_batch_frame(&mut tmp, batch);
                    if !flush(tmp) {
                        break;
                    }
                    batch.clear();
                }
            }
        }
    }
}

pub async fn run_sender<F>(
    mut event_rx: broadcast::Receiver<webhid::IpcResponse>,
    device_id: u32,
    mut flush: F,
) where
    F: FnMut(Vec<u8>) -> bool + Send + 'static,
{
    let batch_ms = std::env::var("WEBHID_WS_BATCH_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_BATCH_FLUSH_MS);

    let mut batch: Vec<(u8, Bytes)> = Vec::with_capacity(8);
    let mut frame_buf: Vec<u8> = Vec::with_capacity(256);

    if batch_ms > 0 {
        let mut flush_interval = tokio::time::interval(Duration::from_millis(batch_ms));
        loop {
            tokio::select! {
                _ = flush_interval.tick() => {
                    if !batch.is_empty() {
                        write_batch_frame(&mut frame_buf, &batch);
                        if !flush(std::mem::take(&mut frame_buf)) {
                            break;
                        }
                        batch.clear();
                    }
                }
                event_result = event_rx.recv() => {
                    if !handle_event(event_result, device_id, &mut batch, &mut flush) {
                        break;
                    }
                }
            }
        }
        return;
    }

    let coalesce = Duration::from_micros(ADAPTIVE_COALESCE_US);
    loop {
        let event_result = event_rx.recv().await;
        if !handle_event(event_result, device_id, &mut batch, &mut flush) {
            break;
        }

        drain_available(&mut event_rx, device_id, &mut batch, &mut flush);

        if batch.len() > 1 {
            tokio::select! {
                _ = tokio::time::sleep(coalesce) => {}
                event_result = event_rx.recv() => {
                    if !handle_event(event_result, device_id, &mut batch, &mut flush) {
                        break;
                    }
                    drain_available(&mut event_rx, device_id, &mut batch, &mut flush);
                }
            }
        }

        if !batch.is_empty() {
            write_batch_frame(&mut frame_buf, &batch);
            if !flush(std::mem::take(&mut frame_buf)) {
                break;
            }
            batch.clear();
        }
    }
}

pub fn make_status_resp(resp_type: u8, req_id: u32, status: u8) -> Vec<u8> {
    let mut buf = Vec::with_capacity(6);
    buf.push(resp_type);
    buf.extend_from_slice(&req_id.to_le_bytes());
    buf.push(status);
    buf
}

pub fn make_feature_read_resp(req_id: u32, status: u8, data: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(8 + data.len());
    buf.push(RESP_RECEIVE_FEATURE_REPORT);
    buf.extend_from_slice(&req_id.to_le_bytes());
    buf.push(status);
    let len = data.len().min(0xFFFF) as u16;
    buf.extend_from_slice(&len.to_le_bytes());
    buf.extend_from_slice(&data[..len as usize]);
    buf
}

pub async fn handle_client_message<F>(
    frame: &[u8],
    device_mgr: &std::sync::Arc<crate::device_mgr::DeviceManager>,
    device_id: u32,
    mut emit: F,
) where
    F: FnMut(Vec<u8>),
{
    use crate::blocklist::ReportType;
    use crate::hid;
    use std::sync::Arc;

    if frame.is_empty() {
        log::warn!("[sender] empty binary frame from client");
        return;
    }
    let msg_type = frame[0];

    if frame.len() < 5 {
        log::warn!(
            "[sender] short frame (len={}, need ≥5 for type+req_id)",
            frame.len()
        );
        return;
    }
    let req_id = u32::from_le_bytes([frame[1], frame[2], frame[3], frame[4]]);

    match msg_type {
        MSG_SEND_REPORT | MSG_SEND_FEATURE_REPORT => {
            if frame.len() < 6 {
                let resp_type = if msg_type == MSG_SEND_REPORT {
                    RESP_SEND_REPORT
                } else {
                    RESP_SEND_FEATURE_REPORT
                };
                emit(make_status_resp(resp_type, req_id, 1));
                return;
            }
            let report_id = frame[5];
            let report_type = if msg_type == MSG_SEND_REPORT {
                ReportType::Output
            } else {
                ReportType::Feature
            };
            if device_mgr.is_report_blocked(device_id, report_id, report_type) {
                let resp_type = if msg_type == MSG_SEND_REPORT {
                    RESP_SEND_REPORT
                } else {
                    RESP_SEND_FEATURE_REPORT
                };
                emit(make_status_resp(resp_type, req_id, 2));
                return;
            }
            let payload: Arc<[u8]> = Arc::from(&frame[6..]);

            let dev_arc = match device_mgr.get_file(device_id) {
                Ok(f) => f,
                Err(e) => {
                    log::warn!("[sender] get_file '{device_id}': {e}");
                    let resp_type = if msg_type == MSG_SEND_REPORT {
                        RESP_SEND_REPORT
                    } else {
                        RESP_SEND_FEATURE_REPORT
                    };
                    emit(make_status_resp(resp_type, req_id, 1));
                    return;
                }
            };

            let result = tokio::task::spawn_blocking(move || {
                let dev = dev_arc.lock().unwrap_or_else(|e| e.into_inner());
                if msg_type == MSG_SEND_REPORT {
                    hid::write_report(&dev, report_id, &payload)
                } else {
                    hid::write_feature_report(&dev, report_id, &payload)
                }
            })
            .await;

            let status = match result {
                Ok(Ok(())) => 0u8,
                _ => 1u8,
            };
            let resp_type = if msg_type == MSG_SEND_REPORT {
                RESP_SEND_REPORT
            } else {
                RESP_SEND_FEATURE_REPORT
            };
            emit(make_status_resp(resp_type, req_id, status));
        }

        MSG_RECEIVE_FEATURE_REPORT => {
            if frame.len() < 6 {
                emit(make_feature_read_resp(req_id, 1, &[]));
                return;
            }
            let report_id = frame[5];
            if device_mgr.is_report_blocked(device_id, report_id, ReportType::Feature) {
                emit(make_feature_read_resp(req_id, 2, &[]));
                return;
            }

            let dev_arc = match device_mgr.get_file(device_id) {
                Ok(f) => f,
                Err(e) => {
                    log::warn!("[sender] get_file '{device_id}': {e}");
                    emit(make_feature_read_resp(req_id, 1, &[]));
                    return;
                }
            };

            let result = tokio::task::spawn_blocking(move || {
                let dev = dev_arc.lock().unwrap_or_else(|e| e.into_inner());
                hid::read_feature_report(&dev, report_id)
            })
            .await;

            match result {
                Ok(Ok(data)) => {
                    emit(make_feature_read_resp(req_id, 0, &data));
                }
                _ => {
                    emit(make_feature_read_resp(req_id, 1, &[]));
                }
            }
        }

        other => {
            log::warn!("[sender] rejecting unknown binary msg_type=0x{other:02x}");
            emit(make_status_resp(0xFF, req_id, 1));
        }
    }
}
