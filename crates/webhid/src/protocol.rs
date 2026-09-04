use std::borrow::Cow;
use std::io;

use base64::Engine;
use bytes::BytesMut;
use serde::Serialize;
#[cfg(test)]
use serde::de::DeserializeOwned;
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
    if let Some(req) =
        try_read_packed(&buf).map_err(|e| FrameReadError::Malformed(e.to_string()))?
    {
        return Ok(req);
    }
    let v: serde_json::Value = serde_json::from_slice(&buf)
        .map_err(|e| FrameReadError::Malformed(format!("JSON decode: {e}")))?;
    read_json_request(&v).map_err(|e| FrameReadError::Malformed(e.to_string()))
}

/// Synchronously read one Native Messaging request frame.
pub fn read_nm_request_sync<R: io::Read>(reader: &mut R) -> Result<NmRequest, FrameReadError> {
    let mut len_buf = [0u8; 4];
    reader
        .read_exact(&mut len_buf)
        .map_err(FrameReadError::Io)?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > MAX_NM_FRAME {
        return Err(FrameReadError::Oversized { declared: len });
    }
    let mut buf = BytesMut::with_capacity(len);
    buf.resize(len, 0);
    reader.read_exact(&mut buf).map_err(FrameReadError::Io)?;
    if let Some(req) =
        try_read_packed(&buf).map_err(|e| FrameReadError::Malformed(e.to_string()))?
    {
        return Ok(req);
    }
    let v: serde_json::Value = serde_json::from_slice(&buf)
        .map_err(|e| FrameReadError::Malformed(format!("JSON decode: {e}")))?;
    read_json_request(&v).map_err(|e| FrameReadError::Malformed(e.to_string()))
}

/// Packed messages: {"d":"<b64>"} with no "a" field. msgType byte inside
/// TLV discriminates send_report (0x02) vs send_feature_report (0x04).
/// reqId is inside the TLV, not the JSON "n" field.
/// Returns `None` when the message is not a packed frame.
#[derive(serde::Deserialize)]
struct PackedEnvelope<'a> {
    #[serde(borrow)]
    d: Option<Cow<'a, str>>,
    #[serde(default, deserialize_with = "mark_field_present")]
    a: bool,
}

fn mark_field_present<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
    <serde::de::IgnoredAny as serde::Deserialize>::deserialize(deserializer).map(|_| true)
}
fn try_read_packed(buf: &[u8]) -> io::Result<Option<NmRequest>> {
    let Ok(envelope) = serde_json::from_slice::<PackedEnvelope<'_>>(buf) else {
        return Ok(None);
    };
    let Some(d) = envelope.d else {
        return Ok(None);
    };
    if envelope.a {
        return Ok(None);
    }
    let packed = base64::engine::general_purpose::STANDARD
        .decode(d.as_bytes())
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
        .map(|n| {
            u32::try_from(n).map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("request id {n} out of range"),
                )
            })
        })
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
/// Synchronously serialise `value` as JSON, prefix with its length, and write
/// to a blocking writer.
pub fn write_message_sync<W, T>(writer: &mut W, value: &T) -> io::Result<()>
where
    W: io::Write,
    T: Serialize,
{
    let json = serde_json::to_vec(value)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("JSON encode: {e}")))?;
    let buf = BytesMut::from(&json[..]);

    let len = buf.len() as u32;
    writer.write_all(&len.to_le_bytes())?;
    writer.write_all(&buf)?;
    writer.flush()
}

#[test]
fn test_write_message_sync() {
    let mut buf = Vec::new();
    write_message_sync(&mut buf, &42u32).unwrap();
    assert_eq!(&buf[..4], &(2u32.to_le_bytes()));
    assert_eq!(&buf[4..], b"42");
}

#[cfg(test)]
#[path = "tests/protocol.rs"]
mod tests;
