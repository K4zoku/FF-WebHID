// Updated protocol.rs – switched to BytesMut for efficient JSON framing.

use std::io;

use bytes::BytesMut;
use serde::{Serialize, de::DeserializeOwned};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Maximum accepted message size (1 MiB). Anything larger is rejected to
/// prevent runaway allocations if the framing gets out of sync.
const MAX_MSG: usize = 1024 * 1024;

/// Read one length‑prefixed JSON message from `reader`.
pub async fn read_message<R, T>(reader: &mut R) -> io::Result<T>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    // Read the 4‑byte little‑endian length prefix.
    let len = reader.read_u32_le().await? as usize;

    if len > MAX_MSG {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("incoming message is too large ({len} bytes)"),
        ));
    }

    // Allocate a buffer large enough for the payload.
    let mut buf = BytesMut::with_capacity(len);
    // The buffer is empty at this point; set its length so that `read_exact`
    // knows how many bytes to read.
    buf.resize(len, 0);
    // Read the exact number of bytes into the buffer.
    reader.read_exact(&mut buf).await?;

    serde_json::from_slice(&buf).map_err(|e| {
        io::Error::new(io::ErrorKind::InvalidData, format!("JSON decode: {e}"))
    })
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