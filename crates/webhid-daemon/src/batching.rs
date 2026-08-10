use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use tokio::sync::broadcast;

use crate::blocklist::ReportType;
use crate::device_mgr::{DeviceManager, with_device};
use crate::hid;

pub const MSG_SEND_REPORT: u8 = 0x01;
pub const MSG_SEND_FEATURE_REPORT: u8 = 0x02;
pub const MSG_RECEIVE_FEATURE_REPORT: u8 = 0x03;

pub const RESP_SEND_REPORT: u8 = 0x81;
pub const RESP_SEND_FEATURE_REPORT: u8 = 0x82;
pub const RESP_RECEIVE_FEATURE_REPORT: u8 = 0x83;

pub const MSG_INPUT_BATCH: u8 = 0x00;

const DEFAULT_BATCH_FLUSH_MS: u64 = 0;
const ADAPTIVE_COALESCE_US: u64 = 25;
const HIGH_RATE_COALESCE_MS: u64 = 8;
const RATE_WINDOW_MS: u64 = 4;
const HIGH_RATE_COUNT: u32 = 12;

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

/// Reads a `WEBHID_WS_*` integer knob, falling back to `default` when the
/// variable is unset or unparseable.
fn env_int<T>(name: &str, default: T) -> T
where
    T: std::str::FromStr,
{
    std::env::var(name)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}

/// Flushes `batch` as a single input-report frame. Returns false when the
/// flush callback reports failure and the sender must stop.
fn flush_batch<F>(batch: &mut Vec<(u8, Bytes)>, frame_buf: &mut Vec<u8>, flush: &mut F) -> bool
where
    F: FnMut(Vec<u8>) -> bool,
{
    if batch.is_empty() {
        return true;
    }
    write_batch_frame(frame_buf, batch);
    if !flush(std::mem::take(frame_buf)) {
        return false;
    }
    batch.clear();
    true
}

/// Like [`flush_batch`], then advances the rate-gate counters used to pick
/// the coalesce window for the next batch.
fn flush_batch_ratelimited<F>(
    batch: &mut Vec<(u8, Bytes)>,
    frame_buf: &mut Vec<u8>,
    flush: &mut F,
    rate_count: &mut u32,
    rate_start: &mut tokio::time::Instant,
    rate_window: Duration,
) -> bool
where
    F: FnMut(Vec<u8>) -> bool,
{
    if batch.is_empty() {
        return true;
    }
    write_batch_frame(frame_buf, batch);
    let flushed = batch.len() as u32;
    if !flush(std::mem::take(frame_buf)) {
        return false;
    }
    batch.clear();
    let now = tokio::time::Instant::now();
    if now.duration_since(*rate_start) >= rate_window {
        *rate_count = flushed;
        *rate_start = now;
    } else {
        *rate_count = rate_count.saturating_add(flushed);
    }
    true
}

fn handle_event<F>(
    event_result: Result<webhid::IpcResponse, broadcast::error::RecvError>,
    device_id: u32,
    batch: &mut Vec<(u8, Bytes)>,
    frame_buf: &mut Vec<u8>,
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
            if !flush_batch(batch, frame_buf, flush) {
                return false;
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
    frame_buf: &mut Vec<u8>,
    flush: &mut F,
) where
    F: FnMut(Vec<u8>) -> bool,
{
    loop {
        match rx.try_recv() {
            Ok(ev) => {
                if !handle_event(Ok(ev), device_id, batch, frame_buf, flush) {
                    break;
                }
            }
            Err(broadcast::error::TryRecvError::Empty) => break,
            Err(broadcast::error::TryRecvError::Closed) => break,
            Err(broadcast::error::TryRecvError::Lagged(n)) => {
                log::warn!("[sender] drain lagged by {n} events");
                if !flush_batch(batch, frame_buf, flush) {
                    break;
                }
            }
        }
    }
}

/// Selects the coalesce window: short while the rate gate is open, long once
/// the high-rate threshold has been crossed.
fn coalesce_window_duration(
    rate_count: u32,
    high_rate_count: u32,
    high_rate_coalesce: Duration,
    coalesce: Duration,
) -> Duration {
    if rate_count >= high_rate_count {
        high_rate_coalesce
    } else {
        coalesce
    }
}

/// Waits out the coalesce window, folding further input reports into the
/// batch. Returns false when the flush callback failed or the broadcast
/// closed and the sender must stop.
async fn coalesce_window<F>(
    event_rx: &mut broadcast::Receiver<webhid::IpcResponse>,
    device_id: u32,
    batch: &mut Vec<(u8, Bytes)>,
    frame_buf: &mut Vec<u8>,
    flush: &mut F,
    window: Duration,
) -> bool
where
    F: FnMut(Vec<u8>) -> bool,
{
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return true;
        }
        tokio::select! {
            _ = tokio::time::sleep(remaining) => return true,
            event_result = event_rx.recv() => {
                if !handle_event(event_result, device_id, batch, frame_buf, flush) {
                    return false;
                }
                drain_available(event_rx, device_id, batch, frame_buf, flush);
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
    let batch_ms = env_int::<u64>("WEBHID_WS_BATCH_MS", DEFAULT_BATCH_FLUSH_MS);

    let mut batch: Vec<(u8, Bytes)> = Vec::with_capacity(8);
    let mut frame_buf: Vec<u8> = Vec::with_capacity(256);

    if batch_ms > 0 {
        let mut flush_interval = tokio::time::interval(Duration::from_millis(batch_ms));
        loop {
            tokio::select! {
                _ = flush_interval.tick() => {
                    if !flush_batch(&mut batch, &mut frame_buf, &mut flush) {
                        break;
                    }
                }
                event_result = event_rx.recv() => {
                    if !handle_event(event_result, device_id, &mut batch, &mut frame_buf, &mut flush) {
                        break;
                    }
                }
            }
        }
        return;
    }

    let coalesce = Duration::from_micros(ADAPTIVE_COALESCE_US);
    let high_rate_coalesce = Duration::from_millis(env_int::<u64>(
        "WEBHID_WS_HIGH_RATE_MS",
        HIGH_RATE_COALESCE_MS,
    ));
    let rate_window =
        Duration::from_millis(env_int::<u64>("WEBHID_WS_RATE_WINDOW_MS", RATE_WINDOW_MS));
    let high_rate_count = env_int::<u32>("WEBHID_WS_HIGH_RATE_COUNT", HIGH_RATE_COUNT);
    let mut rate_count: u32 = 0;
    let mut rate_start = tokio::time::Instant::now();
    loop {
        let event_result = event_rx.recv().await;
        if !handle_event(
            event_result,
            device_id,
            &mut batch,
            &mut frame_buf,
            &mut flush,
        ) {
            break;
        }
        drain_available(
            &mut event_rx,
            device_id,
            &mut batch,
            &mut frame_buf,
            &mut flush,
        );

        if batch.len() > 1
            && !coalesce_window(
                &mut event_rx,
                device_id,
                &mut batch,
                &mut frame_buf,
                &mut flush,
                coalesce_window_duration(rate_count, high_rate_count, high_rate_coalesce, coalesce),
            )
            .await
        {
            break;
        }

        if !flush_batch_ratelimited(
            &mut batch,
            &mut frame_buf,
            &mut flush,
            &mut rate_count,
            &mut rate_start,
            rate_window,
        ) {
            break;
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
    let too_large = data.len() > 0xFFFF;
    buf.push(if too_large { 1 } else { status });
    let len = if too_large { 0 } else { data.len() } as u16;
    buf.extend_from_slice(&len.to_le_bytes());
    if !too_large {
        buf.extend_from_slice(data);
    }
    buf
}

/// Resolves the open device file for `device_id`, logging on failure.
fn get_device_file(
    device_mgr: &Arc<DeviceManager>,
    device_id: u32,
) -> Option<crate::device_mgr::DeviceHandle> {
    match device_mgr.get_file(device_id) {
        Ok(f) => Some(f),
        Err(e) => {
            log::warn!("[sender] get_file '{device_id}': {e}");
            None
        }
    }
}

fn send_resp_type(msg_type: u8) -> u8 {
    if msg_type == MSG_SEND_REPORT {
        RESP_SEND_REPORT
    } else {
        RESP_SEND_FEATURE_REPORT
    }
}

fn send_report_type(msg_type: u8) -> ReportType {
    if msg_type == MSG_SEND_REPORT {
        ReportType::Output
    } else {
        ReportType::Feature
    }
}

async fn handle_send_report_msg<F>(
    msg_type: u8,
    payload: &[u8],
    req_id: u32,
    device_mgr: &Arc<DeviceManager>,
    device_id: u32,
    emit: &mut F,
) where
    F: FnMut(Vec<u8>),
{
    let resp_type = send_resp_type(msg_type);
    if payload.is_empty() {
        emit(make_status_resp(resp_type, req_id, 1));
        return;
    }
    let report_id = payload[0];
    let report_type = send_report_type(msg_type);
    if device_mgr.is_report_blocked(device_id, report_id, report_type) {
        emit(make_status_resp(resp_type, req_id, 2));
        return;
    }
    if !device_mgr.validate_report_send(device_id, report_id, report_type, Some(payload.len() - 1))
    {
        emit(make_status_resp(resp_type, req_id, 1));
        return;
    }
    let report_data: Arc<[u8]> = Arc::from(&payload[1..]);

    let Some(dev_arc) = get_device_file(device_mgr, device_id) else {
        emit(make_status_resp(resp_type, req_id, 1));
        return;
    };

    let result = tokio::task::spawn_blocking(move || {
        with_device(&dev_arc, |dev| {
            if msg_type == MSG_SEND_REPORT {
                hid::write_report(dev, report_id, &report_data)
            } else {
                hid::write_feature_report(dev, report_id, &report_data)
            }
        })
    })
    .await;

    let status = match result {
        Ok(Ok(())) => 0u8,
        _ => 1u8,
    };
    emit(make_status_resp(resp_type, req_id, status));
}

async fn handle_receive_feature_report_msg<F>(
    payload: &[u8],
    req_id: u32,
    device_mgr: &Arc<DeviceManager>,
    device_id: u32,
    emit: &mut F,
) where
    F: FnMut(Vec<u8>),
{
    if payload.is_empty() {
        emit(make_feature_read_resp(req_id, 1, &[]));
        return;
    }
    let report_id = payload[0];
    if device_mgr.is_report_blocked(device_id, report_id, ReportType::Feature) {
        emit(make_feature_read_resp(req_id, 2, &[]));
        return;
    }
    if !device_mgr.validate_report_send(device_id, report_id, ReportType::Feature, None) {
        emit(make_feature_read_resp(req_id, 1, &[]));
        return;
    }

    let Some(dev_arc) = get_device_file(device_mgr, device_id) else {
        emit(make_feature_read_resp(req_id, 1, &[]));
        return;
    };

    let result = tokio::task::spawn_blocking(move || {
        with_device(&dev_arc, |d| hid::read_feature_report(d, report_id))
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

pub async fn handle_client_message<F>(
    frame: &[u8],
    device_mgr: &Arc<DeviceManager>,
    device_id: u32,
    mut emit: F,
) where
    F: FnMut(Vec<u8>),
{
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
            handle_send_report_msg(
                msg_type,
                &frame[5..],
                req_id,
                device_mgr,
                device_id,
                &mut emit,
            )
            .await
        }
        MSG_RECEIVE_FEATURE_REPORT => {
            handle_receive_feature_report_msg(&frame[5..], req_id, device_mgr, device_id, &mut emit)
                .await
        }
        other => {
            log::warn!("[sender] rejecting unknown binary msg_type=0x{other:02x}");
            emit(make_status_resp(0xFF, req_id, 1));
        }
    }
}
