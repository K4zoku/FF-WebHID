use std::io;

use base64::Engine;
use bytes::BytesMut;
#[cfg(test)]
use serde::de::DeserializeOwned;
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::NmRequest;
use crate::{PKG_SEND_FEATURE_REPORT, PKG_SEND_REPORT, parse_packed_send};

/// Native Messaging frame ceiling: messages larger than this are rejected.
pub const MAX_NM_FRAME: usize = 1024 * 1024;

/// A native-messaging frame could not be read.
#[derive(Debug)]
pub enum FrameReadError {
    /// The declared frame length exceeds `MAX_NM_FRAME`. The body was never
    /// consumed, so the stream is at an unknown byte boundary; the
    /// connection must be closed rather than resuming on a bogus length.
    Oversized { declared: usize },
    /// The frame was fully consumed but could not be parsed; the stream is
    /// still at a frame boundary and parsing may continue.
    Malformed(String),
    /// Underlying I/O failure (including clean EOF).
    Io(std::io::Error),
}

impl std::fmt::Display for FrameReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameReadError::Oversized { declared } => {
                write!(f, "frame length {declared} exceeds maximum {MAX_NM_FRAME}")
            }
            FrameReadError::Malformed(msg) => write!(f, "malformed frame: {msg}"),
            FrameReadError::Io(e) => write!(f, "frame read error: {e}"),
        }
    }
}

impl std::error::Error for FrameReadError {}

#[cfg(test)]
pub(crate) async fn read_message<R, T>(reader: &mut R) -> io::Result<T>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let len = reader.read_u32_le().await? as usize;
    if len > MAX_NM_FRAME {
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

pub async fn read_nm_request<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> Result<NmRequest, FrameReadError> {
    let len = reader.read_u32_le().await.map_err(FrameReadError::Io)? as usize;
    if len > MAX_NM_FRAME {
        // Fatal: the oversized body is still on the wire. Reading it would
        // only let the next length field fall at an unknown offset.
        return Err(FrameReadError::Oversized { declared: len });
    }
    let mut buf = BytesMut::with_capacity(len);
    buf.resize(len, 0);
    reader
        .read_exact(&mut buf)
        .await
        .map_err(FrameReadError::Io)?;
    let v: serde_json::Value = serde_json::from_slice(&buf)
        .map_err(|e| FrameReadError::Malformed(format!("JSON decode: {e}")))?;
    if let Some(req) = try_read_packed(&v).map_err(|e| FrameReadError::Malformed(e.to_string()))? {
        return Ok(req);
    }
    read_json_request(&v).map_err(|e| FrameReadError::Malformed(e.to_string()))
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
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing 'a' (action)"))?;
    let action = u8::try_from(action).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("action {action} out of range"),
        )
    })?;
    let id = v
        .get("n")
        .and_then(|x| x.as_u64())
        .map(|n| u32::try_from(n).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidData, format!("request id {n} out of range"))
        }))
        .transpose()?;
    let filter = v
        .get("f")
        .map(|value| {
            serde_json::from_value(value.clone()).map_err(|e| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("invalid enumerate filter: {e}"),
                )
            })
        })
        .transpose()?;
    Ok(match action {
        crate::ACT_ENUM => NmRequest::Enumerate { id, filter },
        crate::ACT_OPEN => NmRequest::Open {
            id,
            device_id: get_u32(v, "i")?,
        },
        crate::ACT_CLOSE => NmRequest::Close {
            id,
            device_id: get_u32(v, "i")?,
            session_token: v.get("T").and_then(|x| x.as_str()).map(String::from),
        },
        crate::ACT_RECV_FEATURE => NmRequest::ReceiveFeatureReport {
            id,
            device_id: get_u32(v, "i")?,
            report_id: get_u8(v, "r")?,
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
    let n = v
        .get(key)
        .and_then(|x| x.as_u64())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, format!("missing '{key}'")))?;
    u8::try_from(n).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("'{key}' value {n} out of range"),
        )
    })
}

fn get_u32(v: &serde_json::Value, key: &str) -> io::Result<u32> {
    let n = v
        .get(key)
        .and_then(|x| x.as_u64())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, format!("missing '{key}'")))?;
    u32::try_from(n).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("'{key}' value {n} out of range"),
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
    async fn read_json(json: serde_json::Value) -> Result<NmRequest, FrameReadError> {
        let mut buf = Vec::new();
        write_message(&mut buf, &json).await.unwrap();
        let mut r: &[u8] = &buf;
        read_nm_request(&mut r).await
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
        let err = read_json(serde_json::json!({"a": 2, "i": 4294967296u64})).await.unwrap_err();
        assert!(matches!(err, FrameReadError::Malformed(_)));
    }

    #[tokio::test]
    async fn test_read_nm_request_report_id_out_of_range() {
        let err = read_json(serde_json::json!({"a": 5, "i": 1, "r": 257})).await.unwrap_err();
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
}
