use super::*;
use crate::batching::{MSG_INPUT_BATCH, write_batch_frame};
use bytes::Bytes;

fn create_batch_frame(reports: &[(u8, Bytes)]) -> Vec<u8> {
    let mut out = Vec::new();
    write_batch_frame(&mut out, reports);
    out
}

#[test]
fn test_batch_frame_empty() {
    let frame = create_batch_frame(&[]);
    assert_eq!(frame, vec![0x00]);
}

#[test]
fn test_batch_frame_single_report() {
    let reports: Vec<(u8, Bytes)> = vec![(0x01, Bytes::from(&[0xAA, 0xBB][..]))];
    let frame = create_batch_frame(&reports);
    assert_eq!(frame, vec![0x00, 0x03, 0x00, 0x01, 0xAA, 0xBB]);
}

#[test]
fn test_batch_frame_multiple_reports() {
    let reports: Vec<(u8, Bytes)> = vec![
        (0x01, Bytes::from(&[0xAA][..])),
        (0x02, Bytes::from(&[0xBB, 0xCC][..])),
    ];
    let frame = create_batch_frame(&reports);
    assert_eq!(
        frame,
        vec![0x00, 0x02, 0x00, 0x01, 0xAA, 0x03, 0x00, 0x02, 0xBB, 0xCC]
    );
}

#[test]
fn test_batch_frame_empty_report() {
    let reports: Vec<(u8, Bytes)> = vec![(0x05, Bytes::from(&[][..]))];
    let frame = create_batch_frame(&reports);
    assert_eq!(frame, vec![0x00, 0x01, 0x00, 0x05]);
}

#[test]
fn test_batch_frame_large_payload() {
    let payload = vec![0xAA; 128];
    let reports: Vec<(u8, Bytes)> = vec![(0x01, Bytes::from(payload))];
    let frame = create_batch_frame(&reports);
    assert_eq!(frame[0], 0x00);
    assert_eq!(frame[1], 0x81);
    assert_eq!(frame[2], 0x00);
    assert_eq!(frame[3], 0x01);
    assert_eq!(frame.len(), 4 + 128);
}

#[test]
fn test_status_resp_success() {
    let buf = batching::make_status_resp(0x81, 42, 0);
    assert_eq!(buf, vec![0x81, 42, 0, 0, 0, 0]);
}

#[test]
fn test_status_resp_error() {
    let buf = batching::make_status_resp(0x82, 1, 1);
    assert_eq!(buf, vec![0x82, 1, 0, 0, 0, 1]);
}

#[test]
fn test_status_resp_large_req_id() {
    let buf = batching::make_status_resp(0x81, 0xDEAD, 0);
    assert_eq!(buf, vec![0x81, 0xAD, 0xDE, 0x00, 0x00, 0x00]);
}

#[test]
fn test_feature_read_resp_success() {
    let buf = batching::make_feature_read_resp(42, 0, &[0xAA, 0xBB]);
    assert_eq!(buf, vec![0x83, 42, 0, 0, 0, 0, 2, 0, 0xAA, 0xBB]);
}

#[test]
fn test_feature_read_resp_error() {
    let buf = batching::make_feature_read_resp(7, 1, &[]);
    assert_eq!(buf, vec![0x83, 7, 0, 0, 0, 1, 0, 0]);
}

#[test]
fn test_feature_read_resp_large_data() {
    let data = vec![0xFF; 0x10000];
    let buf = batching::make_feature_read_resp(0, 0, &data);
    assert_eq!(buf[0], 0x83);
    assert_eq!(buf[5], 1);
    let len = u16::from_le_bytes([buf[6], buf[7]]);
    assert_eq!(len, 0);
    assert_eq!(buf.len(), 8);
}

#[test]
fn test_batch_frame_uses_shared_writer() {
    let reports: Vec<(u8, Bytes)> = vec![(0x01, Bytes::from(&[0xAA][..]))];
    let frame = create_batch_frame(&reports);
    assert_eq!(frame[0], MSG_INPUT_BATCH);
}
