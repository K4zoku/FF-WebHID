//! Length-prefixed JSON framing used by both the IPC channel (daemon ↔
//! native-messaging process) and the native-messaging channel (addon ↔
//! native-messaging process).
//!
//! Frame format:
//! ```text
//! ┌─────────────────────┬──────────────────────────────┐
//! │  length : u32 LE    │  JSON payload : [u8; length] │
//! └─────────────────────┴──────────────────────────────┘
//! ```

use std::io;

use serde::{Serialize, de::DeserializeOwned};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Maximum accepted message size (1 MiB).  Anything larger is rejected to
/// prevent runaway allocations if the framing gets out of sync.
const MAX_MSG: usize = 1024 * 1024;

/// Read one length-prefixed JSON message from `reader`.
pub async fn read_message<R, T>(reader: &mut R) -> io::Result<T>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let mut len_buf = [0u8; 4];
    reader.read_exact(&mut len_buf).await?;
    let len = u32::from_le_bytes(len_buf) as usize;

    if len > MAX_MSG {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("incoming message is too large ({len} bytes)"),
        ));
    }

    let mut buf = vec![0u8; len];
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
    let json = serde_json::to_vec(value)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("JSON encode: {e}")))?;

    let len = (json.len() as u32).to_le_bytes();
    writer.write_all(&len).await?;
    writer.write_all(&json).await?;
    writer.flush().await
}
