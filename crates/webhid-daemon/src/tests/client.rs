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
