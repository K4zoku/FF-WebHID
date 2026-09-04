use super::*;

#[test]
fn test_nm_request_id_enumerate() {
    let req = NmRequest::Enumerate {
        id: Some(5),
        filter: None,
    };
    assert_eq!(req.id(), Some(5));
}

#[test]
fn test_nm_request_id_open() {
    let req = NmRequest::Open {
        id: Some(10),
        device_id: 0x1234,
    };
    assert_eq!(req.id(), Some(10));
}

#[test]
fn test_nm_request_id_close() {
    let req = NmRequest::Close {
        id: Some(20),
        device_id: 0x5678,
        session_token: None,
    };
    assert_eq!(req.id(), Some(20));
}

#[test]
fn test_nm_request_id_handshake() {
    let req = NmRequest::Handshake { id: Some(30) };
    assert_eq!(req.id(), Some(30));
}

#[test]
fn test_nm_request_id_send_report() {
    let req = NmRequest::SendReport {
        id: Some(40),
        packed: vec![
            0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00,
        ],
    };
    assert_eq!(req.id(), Some(40));
}

#[test]
fn test_parse_packed_send_short() {
    let err = parse_packed_send(&[0x02, 0x00]).unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
}

#[test]
fn test_parse_packed_send_truncated_payload() {
    let mut buf = vec![
        PKG_SEND_REPORT,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x01,
        0x10,
        0x00,
    ];
    buf.extend_from_slice(&[0; 5]);
    let err = parse_packed_send(&buf).unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
}

#[test]
fn test_parse_packed_send_zero_length_payload() {
    let buf = vec![
        PKG_SEND_REPORT,
        0xEF,
        0xBE,
        0xAD,
        0xDE,
        0x78,
        0x56,
        0x34,
        0x12,
        0x00,
        0x00,
        0x00,
    ];
    let (req_id, dev_id, report_id, data) = parse_packed_send(&buf).unwrap();
    assert_eq!(req_id, 0xDEADBEEF);
    assert_eq!(dev_id, 0x12345678);
    assert_eq!(report_id, 0);
    assert!(data.is_empty());
}

#[test]
fn test_nm_message_control_json() {
    let msg = NmMessage::Control(NmResponse::ok());
    let json = serde_json::to_string(&msg).unwrap();
    assert_eq!(json, r#"{"s":204}"#);
}

#[test]
fn test_nm_message_packed_data_json() {
    let msg = NmMessage::PackedData(vec![0x01, 0x02, 0x03]);
    let json = serde_json::to_string(&msg).unwrap();
    assert_eq!(json, r#"{"d":"AQID"}"#);
}

#[test]
fn test_base64_opt_serde_none_in_nm_response() {
    let r = NmResponse::err(404);
    let json = serde_json::to_string(&r).unwrap();
    assert_eq!(json, r#"{"s":404}"#);
}

#[test]
fn test_base64_opt_serde_some_in_nm_response() {
    let r = NmResponse::ok_with_data(vec![0xDE, 0xAD]);
    let json = serde_json::to_string(&r).unwrap();
    assert_eq!(json, r#"{"s":200,"d":"3q0="}"#);
}

#[test]
fn test_nm_response_ok() {
    let r = NmResponse::ok();
    assert_eq!(r.status, Some(204));
}

#[test]
fn test_nm_response_err() {
    let r = NmResponse::err(404);
    assert_eq!(r.status, Some(404));
}

#[test]
fn test_nm_response_ok_with_data() {
    let r = NmResponse::ok_with_data(vec![1, 2, 3]);
    assert_eq!(r.status, Some(200));
    assert_eq!(r.data, Some(vec![1, 2, 3]));
}

#[test]
fn test_nm_response_ok_with_devices() {
    let dev = DeviceInfo {
        vendor_id: 0x1234,
        product_id: 0x5678,
        product_name: "Test".into(),
        manufacturer: None,
        serial_number: None,
        usage_page: None,
        usage: None,
        device_id: 0xabc,
        descriptor_parse_failed: false,
        collections: vec![],
        max_input_report_size: 0,
        raw_descriptor: Vec::new(),
    };
    let r = NmResponse::ok_with_devices(vec![dev]);
    assert_eq!(r.status, Some(200));
    assert!(r.devices.is_some());
}

#[test]
fn test_nm_response_ok_opened() {
    let r = NmResponse::ok_opened(0x1234, Some("tok".into()), Some(31337));
    assert_eq!(r.status, Some(201));
    assert_eq!(r.device_id, Some(0x1234));
    assert_eq!(r.session_token, Some("tok".into()));
    assert_eq!(r.ws_port, Some(31337));
}

#[test]
fn test_nm_response_json_serialize() {
    let json = serde_json::to_string(&NmResponse::ok()).unwrap();
    assert_eq!(json, r#"{"s":204}"#);

    let json = serde_json::to_string(&NmResponse::err(404)).unwrap();
    assert_eq!(json, r#"{"s":404}"#);

    let json = serde_json::to_string(&NmResponse::ok_with_data(vec![0xDE])).unwrap();
    assert_eq!(json, r#"{"s":200,"d":"3g=="}"#);
}

#[test]
fn test_packed_input_report() {
    let device_id: u32 = 0x12345678;
    let payload = [0xAA, 0xBB, 0xCC];
    let msg = NmMessage::packed_input_report(device_id, [(33u8, &payload[..])]);
    match msg {
        NmMessage::PackedData(buf) => {
            assert_eq!(buf[0], PKG_INPUT_REPORT);
            assert_eq!(&buf[1..5], &device_id.to_le_bytes());
            assert_eq!(buf[5], 33);
            let payload_len = u16::from_le_bytes([buf[6], buf[7]]) as usize;
            assert_eq!(payload_len, 3);
            assert_eq!(&buf[8..8 + payload_len], &payload);
        }
        _ => panic!("expected PackedData"),
    }
}

#[test]
fn test_parse_packed_send() {
    let req_id: u32 = 0xCAFEBABE;
    let device_id: u32 = 0xDEADBEEF;
    let payload = [0x01, 0x02, 0x03];
    let mut buf = vec![PKG_SEND_REPORT];
    buf.extend_from_slice(&req_id.to_le_bytes());
    buf.extend_from_slice(&device_id.to_le_bytes());
    buf.push(42);
    buf.extend_from_slice(&(payload.len() as u16).to_le_bytes());
    buf.extend_from_slice(&payload);

    let (rid, dev_id, report_id, data) = parse_packed_send(&buf).unwrap();
    assert_eq!(rid, req_id);
    assert_eq!(dev_id, device_id);
    assert_eq!(report_id, 42);
    assert_eq!(data, &payload);
}
