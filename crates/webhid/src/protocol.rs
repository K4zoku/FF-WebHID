use std::io;

use base64::Engine;
use bytes::BytesMut;
use serde::{Serialize, de::DeserializeOwned};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::NmRequest;
use crate::{PKG_SEND_FEATURE_REPORT, PKG_SEND_REPORT, parse_packed_send};

const MAX_MSG: usize = 1024 * 1024;

pub async fn read_message<R, T>(reader: &mut R) -> io::Result<T>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let len = reader.read_u32_le().await? as usize;
    if len > MAX_MSG {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("incoming message is too large ({len} bytes)"),
        ));
    }
    let mut buf = BytesMut::with_capacity(len);
    buf.resize(len, 0);
    reader.read_exact(&mut buf).await?;
    serde_json::from_slice(&buf)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("JSON decode: {e}")))
}

pub async fn read_nm_request<R: AsyncRead + Unpin>(reader: &mut R) -> io::Result<NmRequest> {
    let v: serde_json::Value = read_message(reader).await?;
    if let Some(req) = try_read_packed(&v)? {
        return Ok(req);
    }
    read_json_request(&v)
}

/// Packed messages: {"d":"<b64>"} with no "a" field. msgType byte inside
/// TLV discriminates send_report (0x02) vs send_feature_report (0x04).
/// reqId is inside the TLV, not the JSON "n" field.
/// Returns `None` when the message is not a packed frame.
fn try_read_packed(v: &serde_json::Value) -> io::Result<Option<NmRequest>> {
    let Some(d) = v.get("d").and_then(|x| x.as_str()) else {
        return Ok(None);
    };
    if v.get("a").is_some() {
        return Ok(None);
    }
    let packed = base64::engine::general_purpose::STANDARD
        .decode(d)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("bad b64: {e}")))?;
    if packed.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "empty packed TLV",
        ));
    }
    let req = match packed[0] {
        PKG_SEND_REPORT => NmRequest::SendReport { id: None, packed },
        PKG_SEND_FEATURE_REPORT => {
            let (req_id, device_id, report_id, data) = parse_packed_send(&packed)?;
            NmRequest::SendFeatureReport {
                id: Some(req_id),
                device_id,
                report_id,
                data: data.to_vec(),
            }
        }
        other => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unknown packed msgType: {other:#x}"),
            ));
        }
    };
    Ok(Some(req))
}

/// Non-packed messages: dispatch by the numeric "a" field.
fn read_json_request(v: &serde_json::Value) -> io::Result<NmRequest> {
    let action = v
        .get("a")
        .and_then(|x| x.as_u64())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing 'a' (action)"))?
        as u8;
    let id = v.get("n").and_then(|x| x.as_u64()).map(|n| n as u32);
    Ok(match action {
        crate::ACT_ENUM => NmRequest::Enumerate { id },
        crate::ACT_OPEN => NmRequest::Open {
            id,
            device_id: get_u32(v, "i")?,
        },
        crate::ACT_CLOSE => NmRequest::Close {
            id,
            device_id: get_u32(v, "i")?,
            session_token: v.get("T").and_then(|x| x.as_str()).map(String::from),
        },
        crate::ACT_SEND_REPORT => NmRequest::SendReport {
            id,
            packed: get_b64(v, "d")?,
        },
        crate::ACT_RECV_FEATURE => NmRequest::ReceiveFeatureReport {
            id,
            device_id: get_u32(v, "i")?,
            report_id: get_u8(v, "r")?,
        },
        crate::ACT_SEND_FEATURE => NmRequest::SendFeatureReport {
            id,
            device_id: get_u32(v, "i")?,
            report_id: get_u8(v, "r")?,
            data: get_b64(v, "d")?,
        },
        crate::ACT_SET_DATA_PLANE => NmRequest::SetDataPlane {
            id,
            device_id: get_u32(v, "i")?,
            mode: get_str(v, "m")?,
            session_token: v.get("T").and_then(|x| x.as_str()).map(String::from),
        },
        crate::ACT_HANDSHAKE => NmRequest::Handshake { id },
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unknown action: {action}"),
            ));
        }
    })
}

fn get_str(v: &serde_json::Value, key: &str) -> io::Result<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(String::from)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, format!("missing '{key}'")))
}

fn get_u8(v: &serde_json::Value, key: &str) -> io::Result<u8> {
    v.get(key)
        .and_then(|x| x.as_u64())
        .map(|n| n as u8)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, format!("missing '{key}'")))
}

fn get_u32(v: &serde_json::Value, key: &str) -> io::Result<u32> {
    v.get(key)
        .and_then(|x| x.as_u64())
        .map(|n| n as u32)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, format!("missing '{key}'")))
}

fn get_b64(v: &serde_json::Value, key: &str) -> io::Result<Vec<u8>> {
    let s = v
        .get(key)
        .and_then(|x| x.as_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, format!("missing '{key}'")))?;
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .map_err(|e| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("bad b64 in '{key}': {e}"),
            )
        })
}

/// Serialise `value` as JSON, prefix with its length, and write to `writer`.
pub async fn write_message<W, T>(writer: &mut W, value: &T) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let json = serde_json::to_vec(value)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("JSON encode: {e}")))?;
    let buf = BytesMut::from(&json[..]);

    let len = buf.len() as u32;
    writer.write_u32_le(len).await?;
    writer.write_all(&buf).await?;
    writer.flush().await
}

#[cfg(test)]
mod tests {
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
    async fn read_json(json: serde_json::Value) -> io::Result<NmRequest> {
        let mut buf = Vec::new();
        write_message(&mut buf, &json).await.unwrap();
        let mut r: &[u8] = &buf;
        read_nm_request(&mut r).await
    }

    #[tokio::test]
    async fn test_read_nm_request_enumerate() {
        let req = read_json(serde_json::json!({"a": 1})).await.unwrap();
        assert!(matches!(req, NmRequest::Enumerate { id: None }));
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
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    }

    #[tokio::test]
    async fn test_read_nm_request_missing_action() {
        let err = read_json(serde_json::json!({"n": 1})).await.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
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
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    }
}
