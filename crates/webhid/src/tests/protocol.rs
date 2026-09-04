use super::*;

#[tokio::test]
async fn test_write_then_read_u32() {
    let mut buf = Vec::new();
    write_message(&mut buf, &42u32).await.unwrap();

    let mut reader: &[u8] = &buf;
    let val: u32 = read_message(&mut reader).await.unwrap();
    assert_eq!(val, 42);
}

#[tokio::test]
async fn test_write_then_read_string() {
    let mut buf = Vec::new();
    write_message(&mut buf, &"hello".to_string()).await.unwrap();

    let mut reader: &[u8] = &buf;
    let val: String = read_message(&mut reader).await.unwrap();
    assert_eq!(val, "hello");
}

#[tokio::test]
async fn test_write_then_read_struct() {
    #[derive(serde::Serialize, serde::Deserialize)]
    struct Point {
        x: i32,
        y: i32,
    }

    let pt = Point { x: 10, y: -5 };
    let mut buf = Vec::new();
    write_message(&mut buf, &pt).await.unwrap();

    let mut reader: &[u8] = &buf;
    let de: Point = read_message(&mut reader).await.unwrap();
    assert_eq!(de.x, 10);
    assert_eq!(de.y, -5);
}

#[tokio::test]
async fn test_rejects_oversized_message() {
    let mut buf = Vec::new();
    buf.extend_from_slice(&(2_000_000u32).to_le_bytes());
    buf.resize(buf.len() + 2_000_000, 0);

    let mut reader: &[u8] = &buf;
    let result: Result<serde_json::Value, _> = read_message(&mut reader).await;
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::InvalidData);
}

#[tokio::test]
async fn test_empty_writer_flushes() {
    let mut buf = Vec::new();
    write_message(&mut buf, &true).await.unwrap();
    assert!(!buf.is_empty());
}

/// Frame `json` as a length-prefixed message and parse it as an NmRequest.
async fn read_json(json: serde_json::Value) -> Result<NmRequest, FrameReadError> {
    let mut buf = Vec::new();
    write_message(&mut buf, &json).await.unwrap();
    let mut r: &[u8] = &buf;
    read_nm_request(&mut r).await
}

fn read_json_sync(json: serde_json::Value) -> Result<NmRequest, FrameReadError> {
    let mut buf = Vec::new();
    write_message_sync(&mut buf, &json).unwrap();
    let mut reader: &[u8] = &buf;
    read_nm_request_sync(&mut reader)
}

#[tokio::test]
async fn test_read_nm_request_enumerate() {
    let req = read_json(serde_json::json!({"a": 1})).await.unwrap();
    assert!(matches!(
        req,
        NmRequest::Enumerate {
            id: None,
            filter: None
        }
    ));
}

#[tokio::test]
async fn test_read_nm_request_enumerate_filter() {
    let req = read_json(serde_json::json!({
        "a": 1,
        "n": 7,
        "f": {
            "filters": [{"vendorId": 0x16c0, "productId": 1}],
            "exclusionFilters": [{"usagePage": 1, "usage": 6}]
        }
    }))
    .await
    .unwrap();
    match req {
        NmRequest::Enumerate {
            id,
            filter: Some(filter),
        } => {
            assert_eq!(id, Some(7));
            assert_eq!(filter.filters[0].vendor_id, Some(0x16c0));
            assert_eq!(filter.filters[0].product_id, Some(1));
            assert_eq!(filter.exclusion_filters[0].usage_page, Some(1));
            assert_eq!(filter.exclusion_filters[0].usage, Some(6));
        }
        _ => panic!("expected filtered Enumerate"),
    }
}

#[tokio::test]
async fn test_read_nm_request_open() {
    let req = read_json(serde_json::json!({"a": 2, "n": 5, "i": 305419896}))
        .await
        .unwrap();
    match req {
        NmRequest::Open { id, device_id } => {
            assert_eq!(id, Some(5));
            assert_eq!(device_id, 305419896);
        }
        _ => panic!("expected Open"),
    }
}

#[tokio::test]
async fn test_read_nm_request_handshake() {
    let req = read_json(serde_json::json!({"a": 8, "n": 7}))
        .await
        .unwrap();
    assert!(matches!(req, NmRequest::Handshake { id: Some(7) }));
}

#[tokio::test]
async fn test_read_nm_request_unknown_action() {
    let err = read_json(serde_json::json!({"a": 99})).await.unwrap_err();
    assert!(matches!(err, FrameReadError::Malformed(_)));
}

#[tokio::test]
async fn test_read_nm_request_missing_action() {
    let err = read_json(serde_json::json!({"n": 1})).await.unwrap_err();
    assert!(matches!(err, FrameReadError::Malformed(_)));
}

#[tokio::test]
async fn test_read_nm_request_oversized_frame_is_fatal() {
    // Declared length over the ceiling with only a few trailing bytes;
    // must be reported as Oversized (stream at unknown boundary), not
    // Malformed (which would imply the frame was consumed).
    let mut buf = Vec::new();
    buf.extend_from_slice(&((MAX_NM_FRAME + 1) as u32).to_le_bytes());
    buf.extend_from_slice(b"{");
    let mut r: &[u8] = &buf;
    match read_nm_request(&mut r).await {
        Err(FrameReadError::Oversized { declared }) => {
            assert_eq!(declared, MAX_NM_FRAME + 1);
        }
        other => panic!("expected Oversized, got {other:?}"),
    }
}

#[tokio::test]
async fn test_read_nm_request_action_out_of_range() {
    let err = read_json(serde_json::json!({"a": 258})).await.unwrap_err();
    assert!(matches!(err, FrameReadError::Malformed(_)));
}

#[tokio::test]
async fn test_read_nm_request_device_id_out_of_range() {
    let err = read_json(serde_json::json!({"a": 2, "i": 4294967296u64}))
        .await
        .unwrap_err();
    assert!(matches!(err, FrameReadError::Malformed(_)));
}

#[tokio::test]
async fn test_read_nm_request_report_id_out_of_range() {
    let err = read_json(serde_json::json!({"a": 5, "i": 1, "r": 257}))
        .await
        .unwrap_err();
    assert!(matches!(err, FrameReadError::Malformed(_)));
}

#[tokio::test]
async fn test_read_nm_request_packed_send_report() {
    use base64::Engine;
    let mut tlv = vec![0x02u8];
    tlv.extend_from_slice(&42u32.to_le_bytes());
    tlv.extend_from_slice(&0xCAFEBABEu32.to_le_bytes());
    tlv.push(7);
    tlv.extend_from_slice(&3u16.to_le_bytes());
    tlv.extend_from_slice(&[0xAA, 0xBB, 0xCC]);
    let b64 = base64::engine::general_purpose::STANDARD.encode(&tlv);
    let req = read_json(serde_json::json!({"d": b64})).await.unwrap();
    match req {
        NmRequest::SendReport { id, packed } => {
            assert_eq!(id, None);
            assert_eq!(packed[0], 0x02);
            assert_eq!(packed.len(), tlv.len());
        }
        _ => panic!("expected SendReport"),
    }
}

#[test]
fn test_read_nm_request_sync_packed_send_report() {
    use base64::Engine;
    let mut tlv = vec![0x02u8];
    tlv.extend_from_slice(&42u32.to_le_bytes());
    tlv.extend_from_slice(&0xCAFEBABEu32.to_le_bytes());
    tlv.push(7);
    tlv.extend_from_slice(&3u16.to_le_bytes());
    tlv.extend_from_slice(&[0xAA, 0xBB, 0xCC]);
    let b64 = base64::engine::general_purpose::STANDARD.encode(&tlv);
    let req = read_json_sync(serde_json::json!({"d": b64})).unwrap();
    match req {
        NmRequest::SendReport { id, packed } => {
            assert_eq!(id, None);
            assert_eq!(packed, tlv);
        }
        _ => panic!("expected SendReport"),
    }
}

#[test]
fn test_read_nm_request_sync_packed_escaped_base64() {
    use base64::Engine;
    let mut tlv = vec![0x02u8];
    tlv.extend_from_slice(&42u32.to_le_bytes());
    tlv.extend_from_slice(&0xCAFEBABEu32.to_le_bytes());
    tlv.push(7);
    tlv.extend_from_slice(&2u16.to_le_bytes());
    tlv.extend_from_slice(&[0xAA, 0xBB]);
    let b64 = base64::engine::general_purpose::STANDARD.encode(&tlv);
    let body = format!(r#"{{"d":"{}"}}"#, b64.replace('=', r#"\u003d"#));
    assert!(body.contains(r#"\u003d"#));
    let mut frame = (body.len() as u32).to_le_bytes().to_vec();
    frame.extend_from_slice(body.as_bytes());
    let mut reader: &[u8] = &frame;
    let req = read_nm_request_sync(&mut reader).unwrap();
    assert!(matches!(
        req,
        NmRequest::SendReport { id: None, packed } if packed == tlv
    ));
}

#[tokio::test]
async fn test_read_nm_request_packed_send_feature_report() {
    use base64::Engine;
    let mut tlv = vec![0x04u8];
    tlv.extend_from_slice(&99u32.to_le_bytes());
    tlv.extend_from_slice(&0x12345678u32.to_le_bytes());
    tlv.push(1);
    tlv.extend_from_slice(&2u16.to_le_bytes());
    tlv.extend_from_slice(&[0xDD, 0xEE]);
    let b64 = base64::engine::general_purpose::STANDARD.encode(&tlv);
    let req = read_json(serde_json::json!({"d": b64})).await.unwrap();
    match req {
        NmRequest::SendFeatureReport {
            id,
            device_id,
            report_id,
            data,
        } => {
            assert_eq!(id, Some(99));
            assert_eq!(device_id, 0x12345678);
            assert_eq!(report_id, 1);
            assert_eq!(data, vec![0xDD, 0xEE]);
        }
        _ => panic!("expected SendFeatureReport"),
    }
}

#[tokio::test]
async fn test_read_nm_request_packed_unknown_msg_type() {
    use base64::Engine;
    let tlv = vec![0xFFu8, 0, 0, 0, 0];
    let b64 = base64::engine::general_purpose::STANDARD.encode(&tlv);
    let err = read_json(serde_json::json!({"d": b64})).await.unwrap_err();
    assert!(matches!(err, FrameReadError::Malformed(_)));
}
