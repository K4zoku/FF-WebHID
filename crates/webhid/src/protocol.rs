// Protocol framing: length-prefixed JSON messages.

use std::io;

use base64::Engine;
use bytes::BytesMut;
use serde::{Serialize, de::DeserializeOwned};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::NmRequest;

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
    serde_json::from_slice(&buf).map_err(|e| {
        io::Error::new(io::ErrorKind::InvalidData, format!("JSON decode: {e}"))
    })
}

pub async fn read_nm_request<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> io::Result<NmRequest> {
    let v: serde_json::Value = read_message(reader).await?;
    let action = v.get("a")
        .and_then(|x| x.as_u64())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing 'a' (action)"))? as u8;
    let id = v.get("id").and_then(|x| x.as_u64()).map(|n| n as u32);
    Ok(match action {
        1 => NmRequest::Enumerate { id },
        2 => NmRequest::Open { id, device_id: get_str(&v, "i")? },
        3 => NmRequest::Close { id, device_id: get_str(&v, "i")? },
        4 => NmRequest::SendReport { id, packed: get_b64(&v, "d")? },
        5 => NmRequest::ReceiveFeatureReport {
            id, device_id: get_str(&v, "i")?, report_id: get_u8(&v, "r")?,
        },
        6 => NmRequest::SendFeatureReport {
            id, device_id: get_str(&v, "i")?, report_id: get_u8(&v, "r")?,
            data: get_b64(&v, "d")?,
        },
        7 => NmRequest::SetDataPlane {
            id, device_id: get_str(&v, "i")?, mode: get_str(&v, "m")?,
        },
        8 => NmRequest::Handshake { id },
        _ => return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unknown action: {action}"),
        )),
    })
}

fn get_str(v: &serde_json::Value, key: &str) -> io::Result<String> {
    v.get(key).and_then(|x| x.as_str()).map(String::from)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, format!("missing '{key}'")))
}

fn get_u8(v: &serde_json::Value, key: &str) -> io::Result<u8> {
    v.get(key).and_then(|x| x.as_u64()).map(|n| n as u8)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, format!("missing '{key}'")))
}

fn get_b64(v: &serde_json::Value, key: &str) -> io::Result<Vec<u8>> {
    let s = v.get(key).and_then(|x| x.as_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, format!("missing '{key}'")))?;
    base64::engine::general_purpose::STANDARD.decode(s)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("bad b64 in '{key}': {e}")))
}

/// Serialise `value` as JSON, prefix with its length, and write to `writer`.
pub async fn write_message<W, T>(writer: &mut W, value: &T) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    // Serialize to a Vec<u8> and copy into the buffer.
    let json = serde_json::to_vec(value).map_err(|e| {
        io::Error::new(io::ErrorKind::InvalidData, format!("JSON encode: {e}"))
    })?;
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
        struct Point { x: i32, y: i32 }

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
        // length prefix = 2 MiB  ( > MAX_MSG = 1 MiB )
        buf.extend_from_slice(&(2_000_000u32).to_le_bytes());
        // payload bytes (doesn't matter – size check happens first)
        buf.resize(buf.len() + 2_000_000, 0);

        let mut reader: &[u8] = &buf;
        let result: Result<serde_json::Value, _> = read_message(&mut reader).await;
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::InvalidData);
    }

    #[tokio::test]
    async fn test_empty_writer_flushes() {
        // write_message should still flush even for a minimal payload
        let mut buf = Vec::new();
        write_message(&mut buf, &true).await.unwrap();
        assert!(!buf.is_empty());
    }

    #[tokio::test]
    async fn test_read_nm_request_numeric_action() {
        use crate::NmRequest;
        // Enumerate: {"a":1}
        let mut buf = Vec::new();
        write_message(&mut buf, &serde_json::json!({"a": 1})).await.unwrap();
        let mut r: &[u8] = &buf;
        let req = read_nm_request(&mut r).await.unwrap();
        assert!(matches!(req, NmRequest::Enumerate { id: None }));

        // Open with id + deviceId
        let mut buf = Vec::new();
        write_message(&mut buf, &serde_json::json!({"a": 2, "id": 5, "i": "/dev/hidraw0"})).await.unwrap();
        let mut r: &[u8] = &buf;
        let req = read_nm_request(&mut r).await.unwrap();
        match req {
            NmRequest::Open { id, device_id } => {
                assert_eq!(id, Some(5));
                assert_eq!(device_id, "/dev/hidraw0");
            }
            _ => panic!("expected Open"),
        }

        // Handshake
        let mut buf = Vec::new();
        write_message(&mut buf, &serde_json::json!({"a": 8, "id": 7})).await.unwrap();
        let mut r: &[u8] = &buf;
        let req = read_nm_request(&mut r).await.unwrap();
        assert!(matches!(req, NmRequest::Handshake { id: Some(7) }));

        // Unknown action → error
        let mut buf = Vec::new();
        write_message(&mut buf, &serde_json::json!({"a": 99})).await.unwrap();
        let mut r: &[u8] = &buf;
        let err = read_nm_request(&mut r).await.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);

        // Missing 'a' → error
        let mut buf = Vec::new();
        write_message(&mut buf, &serde_json::json!({"id": 1})).await.unwrap();
        let mut r: &[u8] = &buf;
        let err = read_nm_request(&mut r).await.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    }
}