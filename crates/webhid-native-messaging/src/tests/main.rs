use super::*;

#[tokio::test]
async fn test_read_frame_normal() {
    let payload = b"hello";
    let mut frame = (payload.len() as u32).to_le_bytes().to_vec();
    frame.extend_from_slice(payload);
    let mut reader = &frame[..];
    let mut buf = Vec::new();
    let result = read_frame(&mut reader, &mut buf).await;
    assert!(result.is_ok());
    assert!(result.unwrap());
    assert_eq!(buf, payload);
}

#[tokio::test]
async fn test_read_frame_eof() {
    let mut empty: &[u8] = &[];
    let mut buf = Vec::new();
    let result = read_frame(&mut empty, &mut buf).await;
    assert!(result.is_ok());
    assert!(!result.unwrap());
}

#[tokio::test]
async fn test_read_frame_partial_header() {
    let mut partial: &[u8] = &[0x00, 0x01];
    let mut buf = Vec::new();
    let result = read_frame(&mut partial, &mut buf).await;
    assert!(result.is_ok());
    assert!(!result.unwrap());
}

#[tokio::test]
async fn test_read_frame_too_large() {
    let oversized = (MAX_NM_FRAME as u32 + 1).to_le_bytes();
    let mut reader: &[u8] = &oversized;
    let mut buf = Vec::new();
    let result = read_frame(&mut reader, &mut buf).await;
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert!(err.to_string().contains("frame too large"));
}

#[tokio::test]
async fn test_read_frame_max_size() {
    let mut frame = (MAX_NM_FRAME as u32).to_le_bytes().to_vec();
    frame.resize(4 + MAX_NM_FRAME, 0xAB);
    let mut reader: &[u8] = &frame;
    let mut buf = Vec::new();
    let result = read_frame(&mut reader, &mut buf).await;
    assert!(result.is_ok());
    assert!(result.unwrap());
    assert_eq!(buf.len(), MAX_NM_FRAME);
    assert_eq!(buf[0], 0xAB);
}

#[tokio::test]
async fn test_read_frame_empty_payload() {
    let frame = 0u32.to_le_bytes();
    let mut reader: &[u8] = &frame;
    let mut buf = Vec::new();
    let result = read_frame(&mut reader, &mut buf).await;
    assert!(result.is_ok());
    assert!(result.unwrap());
    assert!(buf.is_empty());
}

#[tokio::test]
async fn test_write_error_frame_format() {
    let mut output = Vec::new();
    write_error_frame(&mut output, "test error").await;
    assert!(output.len() >= 4, "should have length prefix");
    let json_len = u32::from_le_bytes([output[0], output[1], output[2], output[3]]) as usize;
    assert_eq!(output.len(), 4 + json_len);
    let json: serde_json::Value = serde_json::from_slice(&output[4..]).expect("valid JSON");
    assert_eq!(json["s"], 503);
    assert_eq!(json["E"], "test error");
}

#[tokio::test]
async fn test_write_error_frame_empty_message() {
    let mut output = Vec::new();
    write_error_frame(&mut output, "").await;
    let json_len = u32::from_le_bytes([output[0], output[1], output[2], output[3]]) as usize;
    let json: serde_json::Value =
        serde_json::from_slice(&output[4..4 + json_len]).expect("valid JSON");
    assert_eq!(json["s"], 503);
    assert_eq!(json["E"], "");
}

#[cfg(unix)]
#[test]
fn test_candidate_sockets_env_handling() {
    unsafe { std::env::set_var("WEBHID_SOCKET", "/tmp/custom.sock") };
    let candidates = candidate_sockets();
    unsafe { std::env::remove_var("WEBHID_SOCKET") };
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0], "/tmp/custom.sock");

    let candidates = candidate_sockets();
    assert!(!candidates.is_empty());
    #[cfg(target_os = "linux")]
    assert_eq!(candidates.last().unwrap(), "/run/webhid/webhid.sock");
}
