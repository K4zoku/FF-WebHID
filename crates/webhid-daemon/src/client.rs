use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

use crate::blocklist::ReportType;
use tokio::io::{AsyncRead, BufReader};
use tokio::sync::{broadcast, mpsc};
use webhid::{IpcResponse, NmMessage, NmRequest, NmResponse, parse_packed_send, protocol};

use crate::device_mgr::DeviceManager;
use crate::webtransport::WtState;

enum WriterTask {
    Async(tokio::task::JoinHandle<()>),
    Sync {
        task: thread::JoinHandle<()>,
        cancel: Arc<AtomicBool>,
    },
}

impl WriterTask {
    fn stop(self) {
        match self {
            WriterTask::Async(task) => task.abort(),
            WriterTask::Sync { cancel, task } => {
                cancel.store(true, Ordering::Release);
                drop(task);
            }
        }
    }
}

fn run_sync_writer<W: std::io::Write>(
    writer: &mut W,
    rx: &mut mpsc::Receiver<NmMessage>,
    cancel: &AtomicBool,
) {
    loop {
        let Some(msg) = rx.blocking_recv() else {
            break;
        };
        if cancel.load(Ordering::Acquire) {
            break;
        }
        if let Err(e) = protocol::write_message_sync(writer, &msg) {
            log::warn!("[client] write error: {e}");
            break;
        }
    }
}

fn spawn_sync_writer(rx: mpsc::Receiver<NmMessage>) -> WriterTask {
    let cancel = Arc::new(AtomicBool::new(false));
    let writer_cancel = Arc::clone(&cancel);
    let task = thread::spawn(move || {
        let stdout = std::io::stdout();
        let mut writer = stdout.lock();
        let mut rx = rx;
        run_sync_writer(&mut writer, &mut rx, &writer_cancel);
    });
    WriterTask::Sync { task, cancel }
}

/// Limits parsed synchronous requests to one frame ahead of dispatch.
const SYNC_REQUEST_QUEUE_CAPACITY: usize = 1;

fn spawn_sync_request_reader() -> mpsc::Receiver<Result<NmRequest, protocol::FrameReadError>> {
    let (tx, rx) = mpsc::channel(SYNC_REQUEST_QUEUE_CAPACITY);
    let _ = thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut reader = stdin.lock();
        loop {
            let result = protocol::read_nm_request_sync(&mut reader);
            let fatal = !matches!(result, Ok(_) | Err(protocol::FrameReadError::Malformed(_)));
            if tx.blocking_send(result).is_err() || fatal {
                break;
            }
        }
    });
    rx
}

pub async fn handle(
    reader: impl AsyncRead + Unpin + Send + 'static,
    writer: impl tokio::io::AsyncWrite + Unpin + Send + 'static,
    device_mgr: Arc<DeviceManager>,
    client_id: u64,
    event_rx: broadcast::Receiver<IpcResponse>,
    ws_port: u16,
    wt_state: Arc<WtState>,
) -> anyhow::Result<()> {
    let device_mgr_for_requests = Arc::clone(&device_mgr);
    let wt_state_for_requests = Arc::clone(&wt_state);
    handle_with_writer(
        reader,
        device_mgr,
        client_id,
        event_rx,
        move |rx: mpsc::Receiver<NmMessage>| {
            WriterTask::Async(tokio::spawn(async move {
                let mut writer = tokio::io::BufWriter::new(writer);
                let mut rx = rx;
                while let Some(msg) = rx.recv().await {
                    if let Err(e) = protocol::write_message(&mut writer, &msg).await {
                        log::warn!("[client] write error: {e}");
                        break;
                    }
                }
            }))
        },
        move |reader, tx| async move {
            run_async_request_loop(
                reader,
                device_mgr_for_requests,
                client_id,
                tx,
                ws_port,
                wt_state_for_requests,
            )
            .await;
        },
    )
    .await
}

pub async fn handle_nm_host(
    device_mgr: Arc<DeviceManager>,
    client_id: u64,
    event_rx: broadcast::Receiver<IpcResponse>,
    ws_port: u16,
    wt_state: Arc<WtState>,
) -> anyhow::Result<()> {
    let device_mgr_for_requests = Arc::clone(&device_mgr);
    let wt_state_for_requests = Arc::clone(&wt_state);
    handle_with_writer(
        (),
        device_mgr,
        client_id,
        event_rx,
        spawn_sync_writer,
        move |(), tx| async move {
            let mut requests = spawn_sync_request_reader();
            run_sync_request_loop(
                &mut requests,
                device_mgr_for_requests,
                client_id,
                tx,
                ws_port,
                wt_state_for_requests,
            )
            .await;
        },
    )
    .await
}

async fn handle_with_writer<R, W, L, Fut>(
    reader: R,
    device_mgr: Arc<DeviceManager>,
    client_id: u64,
    mut event_rx: broadcast::Receiver<IpcResponse>,
    writer_factory: W,
    request_loop_factory: L,
) -> anyhow::Result<()>
where
    R: Send + 'static,
    W: FnOnce(mpsc::Receiver<NmMessage>) -> WriterTask,
    L: FnOnce(R, mpsc::Sender<NmMessage>) -> Fut,
    Fut: Future<Output = ()> + Send,
{
    let (tx, rx) = mpsc::channel::<NmMessage>(1024);
    device_mgr.register_nm_sink(client_id, tx.clone());

    let writer_task = writer_factory(rx);

    let tx_events = tx.clone();
    let device_mgr_for_events = Arc::clone(&device_mgr);
    let event_task = tokio::spawn(async move {
        loop {
            match event_rx.recv().await {
                Ok(ev) => {
                    if !relay_client_event(ev, &device_mgr_for_events, &tx_events).await {
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

    request_loop_factory(reader, tx.clone()).await;

    event_task.abort();
    device_mgr.unregister_nm_sink(client_id);
    drop(tx);
    writer_task.stop();
    device_mgr.close_all_for_client(client_id);
    Ok(())
}

async fn run_async_request_loop<R>(
    reader: R,
    device_mgr: Arc<DeviceManager>,
    client_id: u64,
    tx: mpsc::Sender<NmMessage>,
    ws_port: u16,
    wt_state: Arc<WtState>,
) where
    R: AsyncRead + Unpin,
{
    let mut reader = BufReader::new(reader);
    loop {
        let Some(request) = read_next_request(&mut reader, &tx).await else {
            break;
        };
        if !dispatch_request(&device_mgr, client_id, request, &tx, ws_port, &wt_state).await {
            break;
        }
    }
}

async fn run_sync_request_loop(
    requests: &mut mpsc::Receiver<Result<NmRequest, protocol::FrameReadError>>,
    device_mgr: Arc<DeviceManager>,
    client_id: u64,
    tx: mpsc::Sender<NmMessage>,
    ws_port: u16,
    wt_state: Arc<WtState>,
) {
    while let Some(result) = requests.recv().await {
        let request = match result {
            Ok(request) => request,
            Err(protocol::FrameReadError::Oversized { declared }) => {
                log::warn!(
                    "[client] oversized NM frame ({declared} bytes); closing connection (stream desync)"
                );
                break;
            }
            Err(protocol::FrameReadError::Malformed(e)) => {
                log::warn!("[client] malformed NM frame dropped: {e}");
                if tx
                    .send(NmMessage::Control(NmResponse::err(400)))
                    .await
                    .is_err()
                {
                    break;
                }
                continue;
            }
            Err(protocol::FrameReadError::Io(e)) => {
                if e.kind() != std::io::ErrorKind::UnexpectedEof {
                    log::warn!("[client] read error: {e}");
                }
                break;
            }
        };
        if !dispatch_request(&device_mgr, client_id, request, &tx, ws_port, &wt_state).await {
            break;
        }
    }
}

async fn dispatch_request(
    device_mgr: &DeviceManager,
    client_id: u64,
    request: NmRequest,
    tx: &mpsc::Sender<NmMessage>,
    ws_port: u16,
    wt_state: &WtState,
) -> bool {
    let response = dispatch(device_mgr, client_id, request, ws_port, wt_state).await;
    tx.send(response).await.is_ok()
}

/// Forwards one broadcast event to the client stream, force-closing
/// disconnected devices and skipping input reports for sessions that are not
/// exposed over NM. Returns false when the client is gone and the event task
/// should stop.
async fn relay_client_event(
    ev: IpcResponse,
    device_mgr: &DeviceManager,
    tx: &mpsc::Sender<NmMessage>,
) -> bool {
    if let webhid::IpcResponse::DeviceDisconnected { device, .. } = &ev {
        device_mgr.force_close(device.device_id);
    }
    if let webhid::IpcResponse::InputReport { .. } = &ev {
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
            handle_open(device_mgr, device_id, ws_port, client_id).await
        }
        NmRequest::Close {
            device_id,
            session_token,
            ..
        } => handle_close(device_mgr, device_id, session_token, client_id),
        NmRequest::SendReport { packed, .. } => {
            handle_send_report(device_mgr, client_id, packed).await
        }
        NmRequest::ReceiveFeatureReport {
            device_id,
            report_id,
            ..
        } => handle_receive_feature_report(device_mgr, client_id, device_id, report_id).await,
        NmRequest::SendFeatureReport {
            device_id,
            report_id,
            data,
            ..
        } => handle_send_feature_report(device_mgr, client_id, device_id, report_id, data).await,
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
async fn handle_open(
    device_mgr: &DeviceManager,
    device_id: u32,
    ws_port: u16,
    client_id: u64,
) -> NmResponse {
    let mut resp = match device_mgr.open(device_id, client_id).await {
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

async fn handle_send_report(
    device_mgr: &DeviceManager,
    client_id: u64,
    packed: Vec<u8>,
) -> NmResponse {
    let Ok((req_id, device_id, report_id, data)) = parse_packed_send(&packed) else {
        return NmResponse::err(422);
    };
    let mut resp = match device_mgr.nm_report_send_allowed(
        client_id,
        device_id,
        report_id,
        ReportType::Output,
        Some(data.len()),
    ) {
        Ok(()) => match device_mgr
            .enqueue_nm_output(client_id, device_id, report_id, data.to_vec())
            .await
        {
            Ok(()) => NmResponse::ok(),
            Err(e) => {
                log::warn!(
                    "[nm] output worker failed dev={device_id:#x} report={report_id} len={}: {e}",
                    data.len()
                );
                NmResponse::err(500)
            }
        },
        Err(crate::device_mgr::SendReject::Blocked) => NmResponse::err(403),
        Err(crate::device_mgr::SendReject::Invalid) => NmResponse::err(500),
    };
    resp.id = Some(req_id);
    resp
}

async fn handle_receive_feature_report(
    device_mgr: &DeviceManager,
    client_id: u64,
    device_id: u32,
    report_id: u8,
) -> NmResponse {
    match report_precheck(device_mgr, device_id, report_id, ReportType::Feature, None) {
        Ok(()) => match device_mgr
            .enqueue_nm_feature_read(client_id, device_id, report_id)
            .await
        {
            Ok(data) => NmResponse::ok_with_data(data),
            Err(_) => NmResponse::err(500),
        },
        Err(e) => e,
    }
}

async fn handle_send_feature_report(
    device_mgr: &DeviceManager,
    client_id: u64,
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
        Ok(()) => match device_mgr
            .enqueue_nm_feature_write(client_id, device_id, report_id, data)
            .await
        {
            Ok(()) => NmResponse::ok(),
            Err(e) => {
                log::warn!("[nm] feature write failed dev={device_id:#x} report={report_id}: {e}");
                NmResponse::err(500)
            }
        },
        Err(e) => e,
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

/// Shared report pre-checks: blocklist first, then Chromium-style
/// validation. Ok(()) means the report may proceed; Err carries the response.
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

    struct DisconnectedWriter;

    impl std::io::Write for DisconnectedWriter {
        fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "NM peer disconnected",
            ))
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "NM peer disconnected",
            ))
        }
    }

    struct CountingWriter(usize);

    impl std::io::Write for CountingWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0 += 1;
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn test_sync_writer_drops_queued_messages_after_cancel() {
        let (tx, mut rx) = mpsc::channel(1);
        tx.try_send(NmMessage::Control(NmResponse::err(500)))
            .unwrap();
        drop(tx);
        let cancel = AtomicBool::new(true);
        let mut writer = CountingWriter(0);
        run_sync_writer(&mut writer, &mut rx, &cancel);
        assert_eq!(writer.0, 0);
    }

    #[test]
    fn test_sync_writer_handles_disconnect() {
        let (tx, mut rx) = mpsc::channel(1);
        tx.try_send(NmMessage::Control(NmResponse::err(500)))
            .unwrap();
        drop(tx);
        let mut writer = DisconnectedWriter;
        run_sync_writer(&mut writer, &mut rx, &AtomicBool::new(false));
    }

    #[test]
    fn test_sync_writer_shutdown_does_not_join_blocked_writer() {
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let cancel = Arc::new(AtomicBool::new(false));
        let task = WriterTask::Sync {
            task: thread::spawn({
                move || {
                    started_tx.send(()).unwrap();
                    let _ = release_rx.recv();
                }
            }),
            cancel,
        };
        started_rx.recv().unwrap();
        let started = std::time::Instant::now();
        task.stop();
        assert!(started.elapsed() < std::time::Duration::from_millis(100));
        release_tx.send(()).unwrap();
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
