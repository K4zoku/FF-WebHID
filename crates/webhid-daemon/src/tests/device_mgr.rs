use super::*;
use std::time::Duration;
use tokio::sync::broadcast;

fn test_token(seed: u8) -> String {
    hex::encode([seed; 16])
}
fn test_nonce(seed: u8) -> String {
    hex::encode([seed; 16])
}

fn insert_active_session(mgr: &DeviceManager, token: &str, owner: u64) {
    mgr.sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(
            token.to_string(),
            Session {
                token: token.to_string(),
                device_id: 0x1234,
                owner_client_id: owner,
                mode: MODE_NM.to_string(),
                ws_auth_hash: "a".repeat(64),
                active: true,
                ws_generation: 0,
                wt_generation: 0,
                cancel: watch::channel(false).0,
            },
        );
}
#[derive(Debug, PartialEq)]
enum IoCall {
    Output(u8, Vec<u8>),
    FeatureWrite(u8, Vec<u8>),
    FeatureRead(u8, usize),
}

#[derive(Clone)]
struct MockDeviceIo {
    calls: Arc<Mutex<Vec<IoCall>>>,
}

impl DeviceIo for MockDeviceIo {
    fn output(&self, report_id: u8, data: &[u8]) -> std::io::Result<()> {
        self.calls
            .lock()
            .unwrap()
            .push(IoCall::Output(report_id, data.to_vec()));
        Ok(())
    }

    fn feature_write(&self, report_id: u8, data: &[u8]) -> std::io::Result<()> {
        self.calls
            .lock()
            .unwrap()
            .push(IoCall::FeatureWrite(report_id, data.to_vec()));
        Ok(())
    }

    fn feature_read(&self, report_id: u8, buf_size: usize) -> std::io::Result<Vec<u8>> {
        self.calls
            .lock()
            .unwrap()
            .push(IoCall::FeatureRead(report_id, buf_size));
        Ok(vec![report_id, buf_size as u8])
    }
}

fn atomic_validity() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(true))
}

fn install_test_io_entry(mgr: &DeviceManager, device_id: u32) -> Arc<Mutex<Vec<IoCall>>> {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let epoch = Arc::new(AtomicU64::new(0));
    let (io_tx, io_rx) = mpsc::channel(4);
    let io_handle = spawn_io_worker(
        MockDeviceIo {
            calls: Arc::clone(&calls),
        },
        Arc::clone(&epoch),
        io_rx,
    );
    let blocking = Arc::new(DeviceReportBlocking::new(
        &DeviceInfo {
            vendor_id: 1,
            product_id: 1,
            product_name: "test".to_string(),
            manufacturer: None,
            serial_number: None,
            usage_page: None,
            usage: None,
            device_id,
            descriptor_parse_failed: false,
            collections: Vec::new(),
            max_input_report_size: 64,
            raw_descriptor: Vec::new(),
        },
        true,
    ));
    mgr.devices
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(
            device_id,
            Entry {
                reader_start: Arc::new((Mutex::new(true), Condvar::new())),
                stop_flag: Arc::new(AtomicBool::new(false)),
                handle: None,
                io_tx: Some(io_tx),
                io_handle: Some(io_handle),
                io_epoch: epoch,
                vendor_id: 1,
                product_id: 1,
                read_buf_size: 64,
                blocking,
            },
        );
    calls
}

#[test]
fn test_reader_start_gate_blocks_reads_until_publication() {
    let gate: ReaderStartGate = Arc::new((Mutex::new(false), Condvar::new()));
    let read_started = Arc::new(AtomicBool::new(false));
    let (created_tx, created_rx) = std::sync::mpsc::channel();
    let reader_gate = Arc::clone(&gate);
    let read_started_for_reader = Arc::clone(&read_started);
    let reader = thread::spawn(move || {
        created_tx.send(()).unwrap();
        wait_reader_start(reader_gate);
        read_started_for_reader.store(true, Ordering::SeqCst);
    });
    created_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("reader created");
    assert!(!read_started.load(Ordering::SeqCst));
    release_reader_start(&gate);
    reader.join().unwrap();
    assert!(read_started.load(Ordering::SeqCst));
}
#[test]
fn test_abandoned_reader_releases_start_gate_on_teardown() {
    let gate: ReaderStartGate = Arc::new((Mutex::new(false), Condvar::new()));
    let stop_flag = Arc::new(AtomicBool::new(false));
    let would_read = Arc::new(AtomicBool::new(false));
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let reader_gate = Arc::clone(&gate);
    let reader_stop_flag = Arc::clone(&stop_flag);
    let would_read_for_reader = Arc::clone(&would_read);
    let reader = thread::spawn(move || {
        wait_reader_start(reader_gate);
        if !reader_stop_flag.load(Ordering::SeqCst) {
            would_read_for_reader.store(true, Ordering::SeqCst);
        }
        done_tx.send(()).unwrap();
    });
    let calls = Arc::new(Mutex::new(Vec::new()));
    let (io_tx, io_rx) = mpsc::channel(1);
    let io_epoch = Arc::new(AtomicU64::new(0));
    let io_handle = spawn_io_worker(
        MockDeviceIo {
            calls: Arc::clone(&calls),
        },
        Arc::clone(&io_epoch),
        io_rx,
    );
    let blocking = Arc::new(DeviceReportBlocking::new(
        &DeviceInfo {
            vendor_id: 1,
            product_id: 1,
            product_name: "test".to_string(),
            manufacturer: None,
            serial_number: None,
            usage_page: None,
            usage: None,
            device_id: 0x1234,
            descriptor_parse_failed: false,
            collections: Vec::new(),
            max_input_report_size: 64,
            raw_descriptor: Vec::new(),
        },
        true,
    ));
    stop_entry(Entry {
        reader_start: gate,
        handle: Some(reader),
        stop_flag: Arc::clone(&stop_flag),
        io_tx: Some(io_tx),
        io_handle: Some(io_handle),
        io_epoch,
        vendor_id: 1,
        product_id: 1,
        read_buf_size: 64,
        blocking,
    });
    done_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("abandoned reader released");
    assert!(calls.lock().unwrap_or_else(|e| e.into_inner()).is_empty());
    assert!(stop_flag.load(Ordering::SeqCst));
    assert!(!would_read.load(Ordering::SeqCst));
}
#[test]
fn test_dead_reader_cleanup_removes_published_lifetime() {
    let (tx, _) = broadcast::channel(16);
    let mgr = Arc::new(DeviceManager::new(tx));
    let calls = install_test_io_entry(&mgr, 0x1234);
    insert_active_session(&mgr, "tok-nm", 1);
    insert_active_session(&mgr, "tok-ws", 2);
    mgr.ws_auth_hashes
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .extend([
            ("hash-nm".to_string(), "tok-nm".to_string()),
            ("hash-ws".to_string(), "tok-ws".to_string()),
        ]);
    let (sink_tx, _sink_rx) = mpsc::channel(1);
    mgr.register_nm_sink(1, sink_tx);
    let ws = mgr.ws_connect(0x1234, "tok-ws").expect("WS connects");
    let io_epoch = {
        let devices = mgr.devices.lock().unwrap_or_else(|e| e.into_inner());
        Arc::clone(&devices.get(&0x1234).unwrap().io_epoch)
    };
    let old_epoch = io_epoch.load(Ordering::SeqCst);

    let (entry, cancels, non_nm_count) = detach_dead_reader_lifetime(
        &mgr.lifecycle,
        &mgr.devices,
        &mgr.sessions,
        &mgr.transport_validity,
        &mgr.nm_hot,
        &mgr.ws_auth_hashes,
        0x1234,
    )
    .expect("published lifetime");
    stop_entry_io_worker(entry);
    if non_nm_count > 0 {
        mgr.non_nm_sessions
            .fetch_sub(non_nm_count, Ordering::SeqCst);
    }
    for cancel in cancels {
        let _ = cancel.send(true);
    }
    assert_eq!(io_epoch.load(Ordering::SeqCst), old_epoch + 1);

    assert!(!ws.capability.is_valid());
    assert!(
        mgr.devices
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
    );
    assert!(
        mgr.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
    );
    assert!(
        mgr.ws_auth_hashes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
    );
    assert!(
        mgr.transport_validity
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
    );
    assert!(
        mgr.nm_hot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
    );
    assert!(calls.lock().unwrap_or_else(|e| e.into_inner()).is_empty());
}

#[test]
fn test_io_worker_executes_output_and_feature_commands() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let epoch = Arc::new(AtomicU64::new(7));
    let (tx, rx) = mpsc::channel(4);
    let worker = spawn_io_worker(
        MockDeviceIo {
            calls: Arc::clone(&calls),
        },
        Arc::clone(&epoch),
        rx,
    );
    let validity = atomic_validity();
    let (output_reply, output_result) = oneshot::channel();
    tx.blocking_send(IoCommand::Output {
        report_id: 1,
        data: vec![2, 3],
        reply: output_reply,
        epoch: 7,
        validity,
    })
    .unwrap();
    assert!(output_result.blocking_recv().unwrap().is_ok());

    let validity = atomic_validity();
    let (write_reply, write_result) = oneshot::channel();
    tx.blocking_send(IoCommand::FeatureWrite {
        report_id: 4,
        data: vec![5],
        reply: write_reply,
        epoch: 7,
        validity,
    })
    .unwrap();
    assert!(write_result.blocking_recv().unwrap().is_ok());

    let validity = atomic_validity();
    let (read_reply, read_result) = oneshot::channel();
    tx.blocking_send(IoCommand::FeatureRead {
        report_id: 6,
        buf_size: 32,
        reply: read_reply,
        epoch: 7,
        validity,
    })
    .unwrap();
    assert_eq!(read_result.blocking_recv().unwrap().unwrap(), vec![6, 32]);

    drop(tx);
    worker.join().unwrap();
    assert_eq!(
        *calls.lock().unwrap(),
        vec![
            IoCall::Output(1, vec![2, 3]),
            IoCall::FeatureWrite(4, vec![5]),
            IoCall::FeatureRead(6, 32),
        ]
    );
}

#[test]
fn test_io_worker_rejects_stale_commands_without_touching_device() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let epoch = Arc::new(AtomicU64::new(2));
    let (tx, rx) = mpsc::channel(2);
    let worker = spawn_io_worker(
        MockDeviceIo {
            calls: Arc::clone(&calls),
        },
        epoch,
        rx,
    );
    let validity = atomic_validity();
    validity.store(false, Ordering::SeqCst);
    let (reply, result) = oneshot::channel();
    tx.blocking_send(IoCommand::FeatureRead {
        report_id: 1,
        buf_size: 8,
        reply,
        epoch: 2,
        validity,
    })
    .unwrap();
    assert_eq!(
        result.blocking_recv().unwrap().unwrap_err().kind(),
        std::io::ErrorKind::BrokenPipe
    );
    let validity = atomic_validity();
    let (reply, result) = oneshot::channel();
    tx.blocking_send(IoCommand::Output {
        report_id: 2,
        data: vec![3],
        reply,
        epoch: 1,
        validity,
    })
    .unwrap();
    assert!(result.blocking_recv().unwrap().is_err());
    drop(tx);
    worker.join().unwrap();
    assert!(calls.lock().unwrap().is_empty());
}

#[test]
fn test_io_worker_shutdown_resolves_queued_request() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let (tx, rx) = mpsc::channel(1);
    let epoch = Arc::new(AtomicU64::new(0));
    let worker = spawn_io_worker(
        MockDeviceIo {
            calls: Arc::clone(&calls),
        },
        epoch,
        rx,
    );
    let validity = atomic_validity();
    validity.store(false, Ordering::SeqCst);
    let (reply, result) = oneshot::channel();
    tx.blocking_send(IoCommand::FeatureWrite {
        report_id: 9,
        data: vec![10],
        reply,
        epoch: 0,
        validity,
    })
    .unwrap();
    drop(tx);
    assert!(result.blocking_recv().unwrap().is_err());
    worker.join().unwrap();
    assert!(calls.lock().unwrap().is_empty());
}

#[test]
fn test_force_close_drops_hot_sender_before_joining_worker() {
    let (tx, _) = broadcast::channel(16);
    let mgr = Arc::new(DeviceManager::new(tx));
    let calls = install_test_io_entry(&mgr, 0x1234);
    let (io_tx, epoch, blocking) = {
        let devices = mgr.devices.lock().unwrap_or_else(|e| e.into_inner());
        let entry = devices.get(&0x1234).unwrap();
        (
            entry.io_tx.as_ref().unwrap().clone(),
            Arc::clone(&entry.io_epoch),
            Arc::clone(&entry.blocking),
        )
    };
    let stale_sender = {
        let devices = mgr.devices.lock().unwrap_or_else(|e| e.into_inner());
        devices
            .get(&0x1234)
            .unwrap()
            .io_tx
            .as_ref()
            .unwrap()
            .clone()
    };
    mgr.nm_hot.lock().unwrap_or_else(|e| e.into_inner()).insert(
        (1, 0x1234),
        NmHotSession {
            io_tx,
            epoch,
            valid: Arc::new(AtomicBool::new(true)),
            blocking,
            vendor_id: 1,
            product_id: 1,
            sink: mpsc::channel(1).0,
        },
    );
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let mgr_for_close = Arc::clone(&mgr);
    let handle = thread::spawn(move || {
        mgr_for_close.force_close(0x1234);
        done_tx.send(()).unwrap();
    });
    assert!(done_rx.recv_timeout(Duration::from_secs(1)).is_ok());
    handle.join().unwrap();
    assert!(
        mgr.nm_hot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
    );
    assert!(
        mgr.devices
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
    );
    assert!(calls.lock().unwrap_or_else(|e| e.into_inner()).is_empty());
    drop(stale_sender);
}

#[test]
fn test_last_session_close_drops_hot_sender_before_joining_worker() {
    let (tx, _) = broadcast::channel(16);
    let mgr = Arc::new(DeviceManager::new(tx));
    let calls = install_test_io_entry(&mgr, 0x1234);
    insert_active_session(&mgr, "tok", 1);
    let (io_tx, epoch, blocking) = {
        let devices = mgr.devices.lock().unwrap_or_else(|e| e.into_inner());
        let entry = devices.get(&0x1234).unwrap();
        (
            entry.io_tx.as_ref().unwrap().clone(),
            Arc::clone(&entry.io_epoch),
            Arc::clone(&entry.blocking),
        )
    };
    let stale_sender = {
        let devices = mgr.devices.lock().unwrap_or_else(|e| e.into_inner());
        devices
            .get(&0x1234)
            .unwrap()
            .io_tx
            .as_ref()
            .unwrap()
            .clone()
    };
    mgr.nm_hot.lock().unwrap_or_else(|e| e.into_inner()).insert(
        (1, 0x1234),
        NmHotSession {
            io_tx,
            epoch,
            valid: Arc::new(AtomicBool::new(true)),
            blocking,
            vendor_id: 1,
            product_id: 1,
            sink: mpsc::channel(1).0,
        },
    );
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let mgr_for_close = Arc::clone(&mgr);
    let handle = thread::spawn(move || {
        mgr_for_close.close(0x1234, "tok", 1).unwrap();
        done_tx.send(()).unwrap();
    });
    assert!(done_rx.recv_timeout(Duration::from_secs(1)).is_ok());
    handle.join().unwrap();
    assert!(
        mgr.nm_hot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
    );
    assert!(
        mgr.devices
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
    );
    assert!(calls.lock().unwrap_or_else(|e| e.into_inner()).is_empty());
    drop(stale_sender);
}

#[test]
fn test_has_nm_session_no_device() {
    let (tx, _) = broadcast::channel(16);
    let mgr = DeviceManager::new(tx);
    assert!(!mgr.has_nm_session_for_client(0xDEADBEEF, 1));
    assert!(!mgr.has_nm_session_for_client(0x1234, 1));
}
#[test]
fn test_route_nm_input_uses_bound_sinks() {
    let (tx, _) = broadcast::channel(16);
    let mgr = DeviceManager::new(tx);
    let (nm_tx, mut nm_rx) = mpsc::channel(1);
    let (other_tx, mut other_rx) = mpsc::channel(1);
    let info = DeviceInfo {
        vendor_id: 1,
        product_id: 1,
        product_name: "test".to_string(),
        manufacturer: None,
        serial_number: None,
        usage_page: None,
        usage: None,
        device_id: 7,
        descriptor_parse_failed: false,
        collections: Vec::new(),
        max_input_report_size: 64,
        raw_descriptor: Vec::new(),
    };
    let blocking = Arc::new(DeviceReportBlocking::new(&info, true));
    let (io_tx, _io_rx) = mpsc::channel(1);
    let (other_io_tx, _other_io_rx) = mpsc::channel(1);
    let epoch = Arc::new(AtomicU64::new(0));
    mgr.nm_hot.lock().unwrap().extend([
        (
            (1, 7),
            NmHotSession {
                io_tx,
                epoch: Arc::clone(&epoch),
                blocking: Arc::clone(&blocking),
                valid: Arc::new(AtomicBool::new(true)),
                vendor_id: 1,
                product_id: 1,
                sink: nm_tx,
            },
        ),
        (
            (2, 8),
            NmHotSession {
                io_tx: other_io_tx,
                epoch,
                blocking,
                valid: Arc::new(AtomicBool::new(true)),
                vendor_id: 1,
                product_id: 1,
                sink: other_tx,
            },
        ),
    ]);
    route_nm_input(&mgr.nm_hot, 7, 1, &Bytes::from_static(&[1, 2, 3]));
    assert!(matches!(nm_rx.try_recv(), Ok(NmMessage::PackedData(_))));
    assert!(matches!(
        other_rx.try_recv(),
        Err(mpsc::error::TryRecvError::Empty)
    ));
}

#[test]
fn test_route_nm_input_stops_when_sink_is_invalidated() {
    let (nm_tx, _nm_rx) = mpsc::channel(1);
    nm_tx.try_send(NmMessage::PackedData(vec![0])).unwrap();
    let valid = Arc::new(AtomicBool::new(true));
    let map: NmHotMap = Arc::new(Mutex::new(HashMap::from([(
        (1, 7),
        NmHotSession {
            io_tx: mpsc::channel(1).0,
            epoch: Arc::new(AtomicU64::new(0)),
            blocking: Arc::new(DeviceReportBlocking::new(
                &DeviceInfo {
                    vendor_id: 1,
                    product_id: 1,
                    product_name: "test".to_string(),
                    manufacturer: None,
                    serial_number: None,
                    usage_page: None,
                    usage: None,
                    device_id: 7,
                    descriptor_parse_failed: false,
                    collections: Vec::new(),
                    max_input_report_size: 64,
                    raw_descriptor: Vec::new(),
                },
                true,
            )),
            valid: Arc::clone(&valid),
            vendor_id: 1,
            product_id: 1,
            sink: nm_tx,
        },
    )])));
    let task = std::thread::spawn({
        let map = Arc::clone(&map);
        move || route_nm_input(&map, 7, 1, &Bytes::from_static(&[1, 2, 3]))
    });
    valid.store(false, Ordering::SeqCst);
    task.join().unwrap();
}

#[test]
fn test_close_all_for_client_no_devices() {
    let (tx, _) = broadcast::channel(16);
    let mgr = DeviceManager::new(tx);
    mgr.close_all_for_client(1);
}

#[tokio::test]
async fn test_concurrent_first_open_serialized() {
    use std::sync::atomic::AtomicU32;
    use tokio::sync::oneshot;
    let (tx, _) = broadcast::channel(16);
    let (entered_tx, entered_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let entered_tx = Arc::new(std::sync::Mutex::new(Some(entered_tx)));
    let release_rx = Arc::new(std::sync::Mutex::new(Some(release_rx)));
    let calls = Arc::new(AtomicU32::new(0));
    let calls_for_opener = Arc::clone(&calls);
    let entered_for_opener = Arc::clone(&entered_tx);
    let release_for_opener = Arc::clone(&release_rx);
    let opener = move |id: u32| {
        calls_for_opener.fetch_add(1, Ordering::SeqCst);
        if let Some(tx) = entered_for_opener.lock().unwrap().take() {
            let _ = tx.send(());
        }
        if let Some(rx) = release_for_opener.lock().unwrap().take() {
            let _ = rx.blocking_recv();
        }
        Err(anyhow!("device '{id:#x}' not found (test opener)"))
    };
    let mgr = Arc::new(DeviceManager::new_with_opener(tx, opener));

    let mgr_a = Arc::clone(&mgr);
    let task_a = tokio::spawn(async move { mgr_a.open(0x1234, 1).await });
    entered_rx.await.unwrap();

    let mut tasks = Vec::new();
    for client in 2..=4u64 {
        let mgr_b = Arc::clone(&mgr);
        tasks.push(tokio::spawn(
            async move { mgr_b.open(0x1234, client).await },
        ));
    }
    tokio::task::yield_now().await;

    release_tx.send(()).unwrap();
    let res_a = task_a.await.unwrap();
    assert!(res_a.is_err());
    for task in tasks {
        assert!(task.await.unwrap().is_err());
    }
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(
        mgr.opening
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
    );
    assert!(
        mgr.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
    );
}

/// Audit regression (HIGH): force-close invalidates an in-flight opener
/// and prevents waiters from attaching to its abandoned lifetime.
#[tokio::test]
async fn test_force_close_invalidates_inflight_open_and_waiter() {
    use std::sync::atomic::AtomicUsize;
    use tokio::sync::oneshot;

    let (event_tx, _) = broadcast::channel(16);
    let (entered_tx, entered_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let entered_tx = Arc::new(Mutex::new(Some(entered_tx)));
    let release_rx = Arc::new(Mutex::new(Some(release_rx)));
    let opener_calls = Arc::new(AtomicUsize::new(0));
    let opener_calls_for_task = Arc::clone(&opener_calls);
    let entered_for_task = Arc::clone(&entered_tx);
    let release_for_task = Arc::clone(&release_rx);
    let mgr = Arc::new(DeviceManager::new_with_opener(event_tx, move |id| {
        opener_calls_for_task.fetch_add(1, Ordering::SeqCst);
        if let Some(tx) = entered_for_task.lock().unwrap().take() {
            let _ = tx.send(());
        }
        if let Some(rx) = release_for_task.lock().unwrap().take() {
            let _ = rx.blocking_recv();
        }
        Err(anyhow!("device '{id:#x}' unavailable in reservation test"))
    }));

    let open_a = {
        let mgr = Arc::clone(&mgr);
        tokio::spawn(async move { mgr.open(0x1234, 1).await })
    };
    entered_rx.await.unwrap();
    let open_b = {
        let mgr = Arc::clone(&mgr);
        tokio::spawn(async move { mgr.open(0x1234, 2).await })
    };
    tokio::task::yield_now().await;

    mgr.force_close(0x1234);
    assert!(
        mgr.opening
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&0x1234)
            .is_some_and(|reservation| reservation.invalidated.load(Ordering::SeqCst))
    );
    release_tx.send(()).unwrap();
    assert!(open_a.await.unwrap().is_err());
    assert!(open_b.await.unwrap().is_err());
    assert_eq!(opener_calls.load(Ordering::SeqCst), 1);
    assert!(
        mgr.opening
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
    );
    assert!(
        mgr.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
    );
    assert!(
        mgr.devices
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
    );

    install_test_io_entry(&mgr, 0x1234);
    let (_, fresh_token) = mgr.open(0x1234, 3).await.expect("new lifetime opens");
    assert!(
        mgr.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(&fresh_token)
    );
    mgr.close(0x1234, &fresh_token, 3)
        .expect("close new lifetime");
}

#[test]
fn test_close_unknown_session_is_idempotent() {
    let (tx, _) = broadcast::channel(16);
    let mgr = DeviceManager::new(tx);
    assert!(mgr.close(0xdeadbeef, "no-such-token", 1).is_ok());
}

#[test]
fn test_close_owner_mismatch_rejected() {
    let (tx, _) = broadcast::channel(16);
    let mgr = DeviceManager::new(tx);
    mgr.sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(
            "tok".to_string(),
            Session {
                token: "tok".to_string(),
                device_id: 0x1234,
                owner_client_id: 1,
                mode: MODE_NM.to_string(),
                ws_auth_hash: "a".repeat(64),
                active: true,
                ws_generation: 0,
                wt_generation: 0,
                cancel: watch::channel(false).0,
            },
        );
    let err = mgr.close(0x1234, "tok", 2).unwrap_err();
    assert!(err.to_string().contains("owned by another"));
    assert!(
        mgr.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key("tok")
    );
}

#[test]
fn test_close_device_mismatch_rejected() {
    let (tx, _) = broadcast::channel(16);
    let mgr = DeviceManager::new(tx);
    mgr.sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(
            "tok".to_string(),
            Session {
                token: "tok".to_string(),
                device_id: 0x1234,
                owner_client_id: 1,
                mode: MODE_NM.to_string(),
                ws_auth_hash: "a".repeat(64),
                active: true,
                ws_generation: 0,
                wt_generation: 0,
                cancel: watch::channel(false).0,
            },
        );
    let err = mgr.close(0x5678, "tok", 1).unwrap_err();
    assert!(err.to_string().contains("does not match device"));
}

#[test]
fn test_close_removes_hash_with_session() {
    let (tx, _) = broadcast::channel(16);
    let mgr = DeviceManager::new(tx);
    mgr.sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(
            "tok".to_string(),
            Session {
                token: "tok".to_string(),
                device_id: 0x1234,
                owner_client_id: 1,
                mode: MODE_NM.to_string(),
                ws_auth_hash: "a".repeat(64),
                active: true,
                ws_generation: 0,
                wt_generation: 0,
                cancel: watch::channel(false).0,
            },
        );
    mgr.ws_auth_hashes
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert("a".repeat(64), "tok".to_string());
    assert!(mgr.close(0x1234, "tok", 1).is_ok());
    assert!(
        mgr.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
    );
    assert!(
        mgr.ws_auth_hashes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
    );
}

#[test]
fn test_set_dataplane_mode_validation() {
    let (tx, _) = broadcast::channel(16);
    let mgr = DeviceManager::new(tx);
    mgr.sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(
            "tok".to_string(),
            Session {
                token: "tok".to_string(),
                device_id: 0x1234,
                owner_client_id: 1,
                mode: MODE_NM.to_string(),
                ws_auth_hash: "a".repeat(64),
                active: true,
                ws_generation: 0,
                wt_generation: 0,
                cancel: watch::channel(false).0,
            },
        );
    assert!(mgr.set_dataplane_mode(0x1234, "tok", "quic", 1).is_err());
    assert!(mgr.set_dataplane_mode(0x1234, "nope", "ws", 1).is_err());
    assert!(mgr.set_dataplane_mode(0x1234, "tok", "ws", 2).is_err());
    assert!(mgr.set_dataplane_mode(0x1234, "tok", "wt", 1).is_ok());
    let sessions = mgr.sessions.lock().unwrap_or_else(|e| e.into_inner());
    assert_eq!(sessions.get("tok").unwrap().mode, MODE_WT);
}

#[test]
fn test_ws_connect_requires_active_session() {
    let (tx, _) = broadcast::channel(16);
    let mgr = DeviceManager::new(tx);
    assert!(mgr.ws_connect(0x1234, "missing").is_none());
    mgr.sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(
            "tok".to_string(),
            Session {
                token: "tok".to_string(),
                device_id: 0x1234,
                owner_client_id: 1,
                mode: MODE_NM.to_string(),
                ws_auth_hash: "a".repeat(64),
                active: false,
                ws_generation: 0,
                wt_generation: 0,
                cancel: watch::channel(false).0,
            },
        );
    assert!(mgr.ws_connect(0x1234, "tok").is_none());
    assert!(mgr.ws_connect(0x5678, "tok").is_none());
}

#[test]
fn test_ws_connect_returns_generation_and_cancel() {
    let (tx, _) = broadcast::channel(16);
    let mgr = DeviceManager::new(tx);
    mgr.sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(
            "tok".to_string(),
            Session {
                token: "tok".to_string(),
                device_id: 0x1234,
                owner_client_id: 1,
                mode: MODE_NM.to_string(),
                ws_auth_hash: "a".repeat(64),
                active: true,
                ws_generation: 0,
                wt_generation: 0,
                cancel: watch::channel(false).0,
            },
        );
    let g1 = mgr
        .ws_connect(0x1234, "tok")
        .expect("active session connects");
    assert_eq!(g1.generation, 1);
    let g2 = mgr
        .ws_connect(0x1234, "tok")
        .expect("reconnect bumps generation");
    assert_eq!(g2.generation, 2);
    assert!(!g1.capability.is_valid());
    assert!(g2.capability.is_valid());
    assert!(!*g1.cancel.borrow());
    assert!(!*g2.cancel.borrow());
}
#[test]
fn test_cross_plane_switch_invalidates_stale_transport() {
    let (tx, _) = broadcast::channel(16);
    let mgr = Arc::new(DeviceManager::new(tx));
    insert_active_session(&mgr, "tok", 1);

    let ws = mgr.ws_connect(0x1234, "tok").expect("WS connects");
    let wt = mgr.wt_connect(0x1234, "tok").expect("WT connects");
    assert!(!ws.capability.is_valid());
    assert!(wt.capability.is_valid());
    assert!(!mgr.session_transport_active(0x1234, "tok", MODE_WS, ws.generation));
    assert!(mgr.session_transport_active(0x1234, "tok", MODE_WT, wt.generation));

    let calls = Arc::new(Mutex::new(Vec::new()));
    let epoch = Arc::new(AtomicU64::new(0));
    let (io_tx, io_rx) = mpsc::channel(1);
    let worker = spawn_io_worker(
        MockDeviceIo {
            calls: Arc::clone(&calls),
        },
        epoch,
        io_rx,
    );
    let (reply, result) = oneshot::channel();
    io_tx
        .blocking_send(IoCommand::Output {
            report_id: 1,
            data: vec![2],
            reply,
            epoch: 0,
            validity: ws.capability.validity(),
        })
        .unwrap();
    assert!(result.blocking_recv().unwrap().is_err());
    drop(io_tx);
    worker.join().unwrap();
    assert!(calls.lock().unwrap().is_empty());

    mgr.ws_disconnect(0x1234, "tok", ws.generation, &ws.capability);
    assert!(mgr.session_transport_active(0x1234, "tok", MODE_WT, wt.generation));
    assert_eq!(
        mgr.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get("tok")
            .unwrap()
            .mode,
        MODE_WT
    );

    mgr.wt_disconnect(0x1234, "tok", wt.generation, &wt.capability);
    let sessions = mgr.sessions.lock().unwrap_or_else(|e| e.into_inner());
    assert_eq!(sessions.get("tok").unwrap().mode, MODE_NM);
    drop(sessions);
    assert!(!wt.capability.is_valid());

    let wt2 = mgr.wt_connect(0x1234, "tok").expect("WT reconnects");
    let ws2 = mgr.ws_connect(0x1234, "tok").expect("WS connects after WT");
    assert!(!wt2.capability.is_valid());
    assert!(ws2.capability.is_valid());
    let calls = Arc::new(Mutex::new(Vec::new()));
    let (io_tx, io_rx) = mpsc::channel(1);
    let worker = spawn_io_worker(
        MockDeviceIo {
            calls: Arc::clone(&calls),
        },
        Arc::new(AtomicU64::new(0)),
        io_rx,
    );
    let (reply, result) = oneshot::channel();
    io_tx
        .blocking_send(IoCommand::FeatureRead {
            report_id: 3,
            buf_size: 8,
            reply,
            epoch: 0,
            validity: wt2.capability.validity(),
        })
        .unwrap();
    assert!(result.blocking_recv().unwrap().is_err());
    drop(io_tx);
    worker.join().unwrap();
    assert!(calls.lock().unwrap().is_empty());
    mgr.wt_disconnect(0x1234, "tok", wt2.generation, &wt2.capability);
    assert!(mgr.session_transport_active(0x1234, "tok", MODE_WS, ws2.generation));
    assert_eq!(
        mgr.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get("tok")
            .unwrap()
            .mode,
        MODE_WS
    );
    mgr.ws_disconnect(0x1234, "tok", ws2.generation, &ws2.capability);
    let ws3 = mgr.ws_connect(0x1234, "tok").expect("WS reconnects");
    assert!(ws3.capability.is_valid());
    mgr.set_dataplane_mode(0x1234, "tok", MODE_NM, 1)
        .expect("switches to NM");
    assert!(!ws3.capability.is_valid());
    assert!(!mgr.session_transport_active(0x1234, "tok", MODE_WS, ws3.generation));
    assert_eq!(
        mgr.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get("tok")
            .unwrap()
            .mode,
        MODE_NM
    );
}
#[test]
fn test_same_mode_disconnect_is_stale_but_current_disconnect_falls_back() {
    let (tx, _) = broadcast::channel(16);
    let mgr = DeviceManager::new(tx);
    insert_active_session(&mgr, "tok", 1);

    let ws = mgr.ws_connect(0x1234, "tok").expect("WS connects");
    mgr.set_dataplane_mode(0x1234, "tok", MODE_WS, 1)
        .expect("same-mode WS transition");
    assert!(!ws.capability.is_valid());
    mgr.ws_disconnect(0x1234, "tok", ws.generation, &ws.capability);
    assert_eq!(
        mgr.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get("tok")
            .unwrap()
            .mode,
        MODE_WS
    );

    let wt = mgr.wt_connect(0x1234, "tok").expect("WT connects");
    mgr.set_dataplane_mode(0x1234, "tok", MODE_WT, 1)
        .expect("same-mode WT transition");
    assert!(!wt.capability.is_valid());
    mgr.wt_disconnect(0x1234, "tok", wt.generation, &wt.capability);
    assert_eq!(
        mgr.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get("tok")
            .unwrap()
            .mode,
        MODE_WT
    );

    let wt_current = mgr.wt_connect(0x1234, "tok").expect("current WT connects");
    mgr.wt_disconnect(0x1234, "tok", wt_current.generation, &wt_current.capability);
    assert_eq!(
        mgr.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get("tok")
            .unwrap()
            .mode,
        MODE_NM
    );
}

#[tokio::test]
async fn test_session_transport_active_tracks_close() {
    let (tx, _) = broadcast::channel(16);
    let mgr = DeviceManager::new(tx);
    for (tok, owner) in [("tokA", 1u64), ("tokB", 2u64)] {
        mgr.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                tok.to_string(),
                Session {
                    token: tok.to_string(),
                    device_id: 0x1234,
                    owner_client_id: owner,
                    mode: MODE_NM.to_string(),
                    ws_auth_hash: "a".repeat(64),
                    active: true,
                    ws_generation: 0,
                    wt_generation: 0,
                    cancel: watch::channel(false).0,
                },
            );
    }
    let grant_a = mgr.ws_connect(0x1234, "tokA").expect("A connects");
    let grant_b = mgr.ws_connect(0x1234, "tokB").expect("B connects");
    assert!(mgr.session_transport_active(0x1234, "tokA", MODE_WS, grant_a.generation));
    assert!(mgr.session_transport_active(0x1234, "tokB", MODE_WS, grant_b.generation));

    mgr.close(0x1234, "tokA", 1).expect("close A");
    assert!(!mgr.session_transport_active(0x1234, "tokA", MODE_WS, grant_a.generation));
    assert!(!grant_a.capability.is_valid());
    assert!(grant_b.capability.is_valid());
    assert!(mgr.session_transport_active(0x1234, "tokB", MODE_WS, grant_b.generation));
    let mut cancel_a = grant_a.cancel.clone();
    tokio::time::timeout(Duration::from_secs(1), cancel_a.changed())
        .await
        .expect("A transport cancelled on session close")
        .expect("cancel channel still open");
    let grant_b2 = mgr.ws_connect(0x1234, "tokB").expect("B reconnects");
    assert_eq!(grant_b2.generation, grant_b.generation + 1);
    assert!(!mgr.session_transport_active(0x1234, "tokB", MODE_WS, grant_b.generation));
    assert!(mgr.session_transport_active(0x1234, "tokB", MODE_WS, grant_b2.generation));
}

#[tokio::test]
async fn test_wt_transport_cancelled_by_close() {
    let (tx, _) = broadcast::channel(16);
    let mgr = DeviceManager::new(tx.clone());
    mgr.sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(
            "tok".to_string(),
            Session {
                token: "tok".to_string(),
                device_id: 0x1234,
                owner_client_id: 1,
                mode: MODE_NM.to_string(),
                ws_auth_hash: "a".repeat(64),
                active: true,
                ws_generation: 0,
                wt_generation: 0,
                cancel: watch::channel(false).0,
            },
        );
    let grant = mgr.wt_connect(0x1234, "tok").expect("WT connects");
    let sender = tokio::spawn(crate::batching::run_sender(
        tx.subscribe(),
        0x1234,
        grant.capability.validity(),
        grant.capability.subscribe_revocation(),
        grant.cancel.clone(),
        |_frame: Vec<u8>| true,
    ));
    let reconnect = mgr.wt_connect(0x1234, "tok").expect("WT reconnects");
    tokio::task::yield_now().await;
    assert_eq!(reconnect.generation, grant.generation + 1);
    assert!(!grant.capability.is_valid());
    tokio::time::timeout(Duration::from_secs(1), sender)
        .await
        .expect("WT sender wakes after reconnect")
        .expect("WT sender does not panic");
    assert!(reconnect.capability.is_valid());
    assert!(mgr.session_transport_active(0x1234, "tok", MODE_WT, reconnect.generation));
    mgr.close(0x1234, "tok", 1).expect("close");
    assert!(!mgr.session_transport_active(0x1234, "tok", MODE_WT, reconnect.generation));
    assert!(!reconnect.capability.is_valid());
    let mut cancel = reconnect.cancel.clone();
    tokio::time::timeout(Duration::from_secs(1), cancel.changed())
        .await
        .expect("WT transport cancelled on session close")
        .expect("cancel channel still open");
}

/// Audit regression (HIGH): NM hot refresh and last-session teardown
/// must linearize without resurrecting a stale I/O sender.
#[test]
fn test_nm_hot_refresh_serializes_with_last_close() {
    use std::sync::Barrier;

    let (tx, _) = broadcast::channel(16);
    let mgr = Arc::new(DeviceManager::new(tx));
    let calls = install_test_io_entry(&mgr, 0x1234);
    insert_active_session(&mgr, "tok", 1);
    let (sink_tx, _sink_rx) = mpsc::channel(1);
    let barrier = Arc::new(Barrier::new(3));

    let register_mgr = Arc::clone(&mgr);
    let register_barrier = Arc::clone(&barrier);
    let register = thread::spawn(move || {
        register_barrier.wait();
        register_mgr.register_nm_sink(1, sink_tx);
    });
    let close_mgr = Arc::clone(&mgr);
    let close_barrier = Arc::clone(&barrier);
    let close = thread::spawn(move || {
        close_barrier.wait();
        close_mgr.close(0x1234, "tok", 1).expect("close");
    });
    barrier.wait();
    register.join().unwrap();
    close.join().unwrap();

    assert!(
        mgr.nm_hot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
    );
    assert!(
        mgr.devices
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
    );
    assert!(
        mgr.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
    );
    assert!(calls.lock().unwrap_or_else(|e| e.into_inner()).is_empty());
}

/// Audit regression (HIGH): a new logical open and last-session close
/// must leave either a live session with its physical entry or neither.
#[tokio::test]
async fn test_open_vs_last_close_linearized() {
    let (tx, _) = broadcast::channel(16);
    let mgr = Arc::new(DeviceManager::new_with_opener(tx, |id| {
        Err(anyhow!("device '{id:#x}' unavailable in race test"))
    }));
    install_test_io_entry(&mgr, 0x1234);
    insert_active_session(&mgr, "old", 1);

    let barrier = Arc::new(tokio::sync::Barrier::new(3));
    let open_mgr = Arc::clone(&mgr);
    let open_barrier = Arc::clone(&barrier);
    let open_task = tokio::spawn(async move {
        open_barrier.wait().await;
        open_mgr.open(0x1234, 2).await
    });
    let close_mgr = Arc::clone(&mgr);
    let close_barrier = Arc::clone(&barrier);
    let close_task = tokio::spawn(async move {
        close_barrier.wait().await;
        close_mgr.close(0x1234, "old", 1)
    });
    barrier.wait().await;
    let open_result = open_task.await.unwrap();
    close_task.await.unwrap().unwrap();

    let device_present = mgr
        .devices
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains_key(&0x1234);
    let session_present = mgr
        .sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .any(|session| session.device_id == 0x1234 && session.active);
    assert_eq!(device_present, session_present);
    if open_result.is_ok() {
        assert!(device_present);
    } else {
        assert!(!device_present);
    }

    let remaining: Vec<(u32, String, u64)> = mgr
        .sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .map(|session| {
            (
                session.device_id,
                session.token.clone(),
                session.owner_client_id,
            )
        })
        .collect();
    for (device_id, token, owner) in remaining {
        mgr.close(device_id, &token, owner).expect("cleanup");
    }
}

/// Audit regression (HIGH): force-close cannot leave a concurrent open
/// attached to the removed physical lifetime.
#[tokio::test]
async fn test_force_close_races_logical_open() {
    let (tx, _) = broadcast::channel(16);
    let mgr = Arc::new(DeviceManager::new_with_opener(tx, |id| {
        Err(anyhow!("device '{id:#x}' unavailable in race test"))
    }));
    install_test_io_entry(&mgr, 0x1234);
    insert_active_session(&mgr, "old", 1);

    let barrier = Arc::new(tokio::sync::Barrier::new(3));
    let open_mgr = Arc::clone(&mgr);
    let open_barrier = Arc::clone(&barrier);
    let open_task = tokio::spawn(async move {
        open_barrier.wait().await;
        open_mgr.open(0x1234, 2).await
    });
    let close_mgr = Arc::clone(&mgr);
    let close_barrier = Arc::clone(&barrier);
    let close_task = tokio::spawn(async move {
        close_barrier.wait().await;
        close_mgr.force_close(0x1234);
    });
    barrier.wait().await;
    let _ = open_task.await.unwrap();
    close_task.await.unwrap();

    assert!(
        mgr.devices
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
    );
    assert!(
        mgr.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
    );
    assert!(
        mgr.ws_auth_hashes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
    );
    assert!(
        mgr.transport_validity
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
    );
    assert!(
        mgr.nm_hot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
    );
}

/// Audit regression (HIGH): same-kind replacement revokes and wakes an
/// idle sender without requiring another report or session close.
#[tokio::test]
async fn test_same_kind_reconnect_wakes_idle_sender() {
    let (tx, _) = broadcast::channel(16);
    let mgr = Arc::new(DeviceManager::new(tx.clone()));
    insert_active_session(&mgr, "tok", 1);
    let grant = mgr.ws_connect(0x1234, "tok").expect("connect");
    let sender = tokio::spawn(crate::batching::run_sender(
        tx.subscribe(),
        0x1234,
        grant.capability.validity(),
        grant.capability.subscribe_revocation(),
        grant.cancel.clone(),
        |_frame: Vec<u8>| true,
    ));

    let replacement = mgr.ws_connect(0x1234, "tok").expect("reconnect");
    assert_eq!(replacement.generation, grant.generation + 1);
    assert!(!grant.capability.is_valid());
    assert!(replacement.capability.is_valid());
    tokio::time::timeout(Duration::from_secs(1), sender)
        .await
        .expect("old sender wakes after reconnect")
        .expect("old sender does not panic");
}

/// Audit regression (HIGH): invalidating a transport capability must
/// stop its sender even when the session remains in the same mode.
#[tokio::test]
async fn test_sender_stops_delivery_after_transport_invalidation() {
    use bytes::Bytes as ReportBytes;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

    let (tx, _keepalive_rx) = broadcast::channel(64);
    let mgr = Arc::new(DeviceManager::new(tx.clone()));
    insert_active_session(&mgr, "tok", 1);
    let grant = mgr.ws_connect(0x1234, "tok").expect("connect");

    let flushed = Arc::new(AtomicUsize::new(0));
    let flushed_for_sender = Arc::clone(&flushed);
    let sender = tokio::spawn(crate::batching::run_sender(
        tx.subscribe(),
        0x1234,
        grant.capability.validity(),
        grant.capability.subscribe_revocation(),
        grant.cancel.clone(),
        move |_frame: Vec<u8>| {
            flushed_for_sender.fetch_add(1, AtomicOrdering::SeqCst);
            true
        },
    ));

    tx.send(webhid::IpcResponse::InputReport {
        device_id: 0x1234,
        report_id: 1,
        data: ReportBytes::from(&[0xAA][..]),
    })
    .expect("broadcast");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(flushed.load(AtomicOrdering::SeqCst) > 0);

    mgr.set_dataplane_mode(0x1234, "tok", MODE_WS, 1)
        .expect("invalidate transport");
    assert!(!grant.capability.is_valid());
    let late_subscriber = grant.capability.subscribe_revocation();
    assert!(*late_subscriber.borrow());
    let flushed_after = flushed.load(AtomicOrdering::SeqCst);

    tokio::time::timeout(Duration::from_secs(2), sender)
        .await
        .expect("sender exits after capability invalidation")
        .expect("sender does not panic");
    assert_eq!(flushed.load(AtomicOrdering::SeqCst), flushed_after);
}

/// Audit regression (HIGH): a closed session's established transport
/// must stop delivering input reports even while another session keeps
/// the device open, and the surviving session keeps working.
#[tokio::test]
async fn test_sender_stops_delivery_after_session_close() {
    use bytes::Bytes as ReportBytes;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    let (tx, mut _keepalive_rx) = broadcast::channel(64);
    let mgr = Arc::new(DeviceManager::new(tx.clone()));
    for (tok, owner) in [("tokA", 1u64), ("tokB", 2u64)] {
        mgr.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                tok.to_string(),
                Session {
                    token: tok.to_string(),
                    device_id: 0x1234,
                    owner_client_id: owner,
                    mode: MODE_NM.to_string(),
                    ws_auth_hash: "a".repeat(64),
                    active: true,
                    ws_generation: 0,
                    wt_generation: 0,
                    cancel: watch::channel(false).0,
                },
            );
    }
    let grant_a = mgr.ws_connect(0x1234, "tokA").expect("A connects");
    let grant_b = mgr.ws_connect(0x1234, "tokB").expect("B connects");

    let flushed = Arc::new(AtomicUsize::new(0));
    let flushed_for_sender = Arc::clone(&flushed);
    let sender = tokio::spawn(crate::batching::run_sender(
        tx.subscribe(),
        0x1234,
        grant_a.capability.validity(),
        grant_a.capability.subscribe_revocation(),
        grant_a.cancel.clone(),
        move |_frame: Vec<u8>| {
            flushed_for_sender.fetch_add(1, AtomicOrdering::SeqCst);
            true
        },
    ));

    tx.send(webhid::IpcResponse::InputReport {
        device_id: 0x1234,
        report_id: 1,
        data: ReportBytes::from(&[0xAA][..]),
    })
    .expect("broadcast");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        flushed.load(AtomicOrdering::SeqCst) > 0,
        "A should receive reports while its session is open"
    );

    mgr.close(0x1234, "tokA", 1).expect("close A");
    assert!(!mgr.session_transport_active(0x1234, "tokA", MODE_WS, grant_a.generation));
    assert!(mgr.session_transport_active(0x1234, "tokB", MODE_WS, grant_b.generation));

    tokio::time::timeout(Duration::from_secs(2), sender)
        .await
        .expect("sender task exits after session close")
        .expect("sender task does not panic");
    let flushed_after = flushed.load(AtomicOrdering::SeqCst);

    tx.send(webhid::IpcResponse::InputReport {
        device_id: 0x1234,
        report_id: 1,
        data: ReportBytes::from(&[0xBB][..]),
    })
    .expect("broadcast");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        flushed.load(AtomicOrdering::SeqCst),
        flushed_after,
        "A must not receive reports after its session closed"
    );

    assert!(mgr.session_transport_active(0x1234, "tokB", MODE_WS, grant_b.generation));
}

#[test]
fn test_get_device_by_ws_auth_roundtrip() {
    let (tx, _) = broadcast::channel(16);
    let mgr = DeviceManager::new(tx);
    let hash = "a".repeat(64);
    mgr.ws_auth_hashes
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(hash.clone(), "tok".to_string());
    mgr.sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(
            "tok".to_string(),
            Session {
                token: "tok".to_string(),
                device_id: 0x1234,
                owner_client_id: 1,
                mode: MODE_NM.to_string(),
                ws_auth_hash: hash.clone(),
                active: true,
                ws_generation: 0,
                wt_generation: 0,
                cancel: watch::channel(false).0,
            },
        );
    assert_eq!(
        mgr.get_device_by_ws_auth(&hash),
        Some((0x1234, "tok".to_string()))
    );
    assert!(mgr.get_device_by_ws_auth("b".repeat(64).as_str()).is_none());
}

#[test]
fn test_get_device_by_ws_auth_closed_session_is_stale() {
    let (tx, _) = broadcast::channel(16);
    let mgr = DeviceManager::new(tx);
    let hash = "a".repeat(64);
    mgr.ws_auth_hashes
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(hash.clone(), "tok".to_string());
    mgr.sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(
            "tok".to_string(),
            Session {
                token: "tok".to_string(),
                device_id: 0x1234,
                owner_client_id: 1,
                mode: MODE_NM.to_string(),
                ws_auth_hash: hash.clone(),
                active: false,
                ws_generation: 0,
                wt_generation: 0,
                cancel: watch::channel(false).0,
            },
        );
    assert!(mgr.get_device_by_ws_auth(&hash).is_none());
}

#[test]
fn test_get_device_by_ws_auth_empty() {
    let (tx, _) = broadcast::channel(16);
    let mgr = DeviceManager::new(tx);
    assert!(mgr.get_device_by_ws_auth("anyhash").is_none());
}

#[test]
fn test_ws_nonce_is_32_hex_chars() {
    let (tx, _) = broadcast::channel(16);
    let mgr = DeviceManager::new(tx);
    let nonce = mgr.ws_nonce();
    assert_eq!(nonce.len(), 32);
    assert!(nonce.chars().all(|c| c.is_ascii_hexdigit()));
}

#[test]
fn test_compute_ws_auth_hash_is_64_hex_chars() {
    let hash = compute_ws_auth_hash(&test_token(0xa1), &test_nonce(0x01));
    assert_eq!(hash.len(), 64);
    assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
}

#[test]
fn test_compute_ws_auth_hash_deterministic() {
    let token = test_token(0xa1);
    let nonce = test_nonce(0x01);
    let h1 = compute_ws_auth_hash(&token, &nonce);
    let h2 = compute_ws_auth_hash(&token, &nonce);
    assert_eq!(h1, h2);
}

#[test]
fn test_compute_ws_auth_hash_differs_on_token() {
    let nonce = test_nonce(0x01);
    let h1 = compute_ws_auth_hash(&test_token(0xa1), &nonce);
    let h2 = compute_ws_auth_hash(&test_token(0xb1), &nonce);
    assert_ne!(h1, h2);
}

#[test]
fn test_compute_ws_auth_hash_differs_on_nonce() {
    let token = test_token(0xa1);
    let h1 = compute_ws_auth_hash(&token, &test_nonce(0x01));
    let h2 = compute_ws_auth_hash(&token, &test_nonce(0x02));
    assert_ne!(h1, h2);
}
