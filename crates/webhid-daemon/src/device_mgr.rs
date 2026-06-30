//! Tracks which hidraw devices are open and which client owns each one.

use std::collections::HashMap;
use std::fs::File;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};

use rand::RngExt;

use tokio::task::JoinHandle;
use tokio::sync::broadcast;

use anyhow::anyhow;
use webhid::{DeviceInfo, IpcResponse};

use crate::hid;

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

struct Entry {
    /// The parsed device information (kept so `enumerate` doesn't need to
    /// re-query udev for already-open devices).
    #[allow(dead_code)]
    info: DeviceInfo,
    /// Writer file handle – used by `sendReport` / `sendFeatureReport`.
    /// Cloned out to blocking tasks for I/O. Has its own `Mutex` so writer
    /// tasks never block on the reader task's `poll(2)` window.
    ///
    /// The background reader task holds its *own* `Arc<Mutex<File>>` over
    /// a separately-`dup(2)`'d fd (see `open()`), so reader and writer
    /// never contend on the same userspace lock.
    file: Arc<Mutex<File>>,
    /// The client that performed the `open`; only that client may use or
    /// close the device.
    client_id: u64,
    /// Signal the background reader to stop.
    stop_flag: Arc<AtomicBool>,
    /// Join handle for the reader task so we can abort it on close.
    handle: Option<JoinHandle<()>>,
    /// Session token for WebSocket authentication (optional)
    session_token: Option<String>,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Generate a random 128-bit hex session token for WebSocket authentication.
fn generate_session_token() -> String {
    let mut rng = rand::rng();
    // 16 bytes = 128 bits, encoded as hex = 32 characters
    let bytes: [u8; 16] = rng.random();
    hex::encode(bytes)
}

pub struct DeviceManager {
    // Key: hidraw node path (e.g. "/dev/hidraw0"), which is also the device_id
    // sent to the addon.
    devices: Mutex<HashMap<String, Entry>>,
    /// Event broadcaster used to publish unsolicited input reports / hotplug
    /// events to connected clients.
    event_tx: broadcast::Sender<IpcResponse>,
}

impl DeviceManager {
    pub fn new(event_tx: broadcast::Sender<IpcResponse>) -> Self {
        Self { devices: Mutex::new(HashMap::new()), event_tx }
    }

    /// List all currently connected HID devices via udev.
    pub fn enumerate(&self) -> anyhow::Result<Vec<DeviceInfo>> {
        hid::enumerate()
    }

    /// Open the hidraw node at `device_path` on behalf of `client_id`.
    /// Returns the device path, which is used as the stable device ID
    /// throughout the session.
    ///
    /// Each hidraw node may be opened independently — a composite USB
    /// device with multiple HID interfaces exposes one path per interface
    /// and each one needs its own reader task.
    ///
    /// Semantics for already-open devices:
    /// * If `client_id` already holds this device open, the call is a
    ///   no-op and returns the existing device id.  This matches the
    ///   WebHID spec, where calling `HIDDevice.open()` on a device that
    ///   another page in the same browser session already opened (or that
    ///   the page re-instantiated after a reload without explicit close)
    ///   must not fail.
    /// * If a *different* client holds it open the call still fails, so
    ///   two independent native-messaging connections can't fight over
    ///   one hidraw fd.
    pub fn open(&self, device_path: &str, client_id: u64) -> anyhow::Result<(String, Option<String>)> {
        // Fast path: avoid the expensive `hid::open_by_path` (which
        // re-enumerates udev) when the device is already owned by us.
        {
            let map = self.devices.lock().unwrap();
            if let Some(existing) = map.get(device_path) {
                return if existing.client_id == client_id {
                    Ok((device_path.to_string(), existing.session_token.clone()))
                } else {
                    Err(anyhow!(
                        "'{device_path}' is open by a different client"
                    ))
                };
            }
        }

        let (info, file) = hid::open_by_path(device_path)?;
        let path = info.path.clone();

        let mut map = self.devices.lock().unwrap();
        // Re-check under the lock in case another task opened the device
        // between our two critical sections (TOCTOU).
        if let Some(existing) = map.get(&path) {
            drop(file); // discard the redundant fd we just opened
            return if existing.client_id == client_id {
                Ok((path, existing.session_token.clone()))
            } else {
                Err(anyhow!("'{path}' is open by a different client"))
            };
        }

        // Decide once whether this interface uses numbered reports.  This
        // governs how `read(2)` results are framed for the rest of the
        // session.
        let uses_numbered_reports = info
            .report_descriptor
            .as_deref()
            .map(hid::uses_numbered_reports)
            .unwrap_or(false);

        // Generate session token for WebSocket authentication
        let session_token = self::generate_session_token();

        // Prepare entry with a stopped reader for now; we'll spawn the reader
        // and then store its handle in the map so we can stop it later.
        let stop_flag = Arc::new(AtomicBool::new(false));
        // `dup(2)` the fd so the reader task has its own file descriptor
        // with its own `Mutex`. Without this, the reader task would hold
        // the shared `Mutex<File>` for the entire 5-second `poll(2)`
        // window inside `hid::read_with_timeout`, blocking every writer
        // (output and feature reports) for up to 5 seconds per call. On
        // rapid multi-packet transfers (e.g. SayoDevice image upload) the
        // cumulative latency caused the device to time out mid-transfer
        // and report CRC mismatches.
        //
        // Both fds refer to the same hidraw device; the kernel still
        // serializes actual I/O at the device level, so this is safe.
        let reader_file = file.try_clone().map_err(|e| {
            anyhow!("dup() reader fd for '{path}': {e}")
        })?;
        let reader_arc = Arc::new(Mutex::new(reader_file));
        let writer_arc = Arc::new(Mutex::new(file));
        let entry = Entry {
            info: info.clone(),
            file: Arc::clone(&writer_arc),
            client_id,
            stop_flag: Arc::clone(&stop_flag),
            handle: None,
            session_token: Some(session_token.clone()),
        };

        map.insert(path.clone(), entry);

        // Spawn background reader task that polls the hidraw fd and broadcasts
        // `IpcResponse::InputReport` events. Use `spawn_blocking` for the
        // blocking read while keeping the outer task lightweight.
        let device_id = path.clone();
        let file_for_task = Arc::clone(&reader_arc);
        let stop_for_task = Arc::clone(&stop_flag);
        let tx = self.event_tx.clone();
        // Captured by the reader closure below — decides whether to peel
        // off `buf[0]` as the report ID for every read.
        let uses_numbered_reports = uses_numbered_reports;

        log::info!(
            "[reader] starting for {device_id} (numbered_reports={uses_numbered_reports})"
        );
        let handle = tokio::spawn(async move {
            // Loop until `stop_flag` is set or the read syscall returns a
            // non-recoverable error.
            loop {
                if stop_for_task.load(Ordering::SeqCst) {
                    break;
                }

                let read_result = tokio::task::spawn_blocking({
                    let file = Arc::clone(&file_for_task);
                    move || {
                        let f = file.lock().unwrap();
                        // Use a modest timeout so we can check the stop flag
                        // periodically.
                        hid::read_with_timeout(&f, 5000)
                    }
                })
                .await;

                match read_result {
                    Ok(Ok(buf)) => {
                        let (report_id, data) = if uses_numbered_reports {
                            if !buf.is_empty() {
                                (buf[0], buf[1..].to_vec())
                            } else {
                                (0u8, Vec::new())
                            }
                        } else {
                            (0u8, buf)
                        };
                        log::info!("[reader {device_id}] input report id={report_id} len={}", data.len());
                        let _ = tx.send(IpcResponse::InputReport { id: 0, device_id: device_id.clone(), report_id, data });
                    }
                    Ok(Err(e)) => {
                        // Timeout is expected; continue. Other errors likely
                        // mean the device is gone or the fd is bad so we stop.
                        if e.kind() == std::io::ErrorKind::TimedOut {
                            continue;
                        }
                        log::warn!("[reader {device_id}] read error: {e}; stopping");
                        break;
                    }
                    Err(e) => {
                        // The blocking task itself panicked or was cancelled.
                        log::warn!("[reader {device_id}] join error: {e}; stopping");
                        break;
                    }
                }
            }
            log::info!("[reader {device_id}] stopped");
        });

        // Store the handle so we can stop it when the device is closed.
        if let Some(e) = map.get_mut(&path) {
            e.handle = Some(handle);
        }

        Ok((path, Some(session_token)))
    }

    /// Close a device owned by `client_id`.
    pub fn close(&self, device_id: &str, client_id: u64) -> anyhow::Result<()> {
        let mut map = self.devices.lock().unwrap();
        let entry = map.get(device_id).ok_or_else(|| anyhow!("'{device_id}' not open"))?;
        if entry.client_id != client_id {
            return Err(anyhow!("'{device_id}' is not owned by this client"));
        }

        // Remove the entry so we can control its reader task.
        if let Some(mut entry) = map.remove(device_id) {
            entry.stop_flag.store(true, Ordering::SeqCst);
            if let Some(handle) = entry.handle.take() {
                handle.abort();
            }
        }

        Ok(())
    }

    /// Return a cloned `Arc` to the file handle so a `spawn_blocking` task can
    /// lock it and perform I/O without blocking the async executor.
    pub fn get_file(&self, device_id: &str, client_id: u64) -> anyhow::Result<Arc<Mutex<File>>> {
        let map = self.devices.lock().unwrap();
        let entry = map.get(device_id).ok_or_else(|| anyhow!("'{device_id}' not open"))?;
        if entry.client_id != client_id {
            return Err(anyhow!("'{device_id}' is not owned by this client"));
        }
        Ok(Arc::clone(&entry.file))
    }

    /// Return a cloned `Arc` to the file handle for a device authenticated
    /// by session token (used by the WebSocket hot path).  Bypasses the
    /// `client_id` ownership check because the WS connection was already
    /// authenticated by `get_device_by_token` during the HTTP upgrade.
    pub fn get_file_by_device_id(&self, device_id: &str) -> anyhow::Result<Arc<Mutex<File>>> {
        let map = self.devices.lock().unwrap();
        let entry = map.get(device_id).ok_or_else(|| anyhow!("'{device_id}' not open"))?;
        Ok(Arc::clone(&entry.file))
    }

    /// Remove every device opened by `client_id` (called on disconnect).
    pub fn close_client_devices(&self, client_id: u64) {
        let mut map = self.devices.lock().unwrap();
        let keys: Vec<String> = map.iter().filter(|(_, e)| e.client_id == client_id).map(|(k, _)| k.clone()).collect();
        for k in keys {
            if let Some(mut entry) = map.remove(&k) {
                entry.stop_flag.store(true, Ordering::SeqCst);
                if let Some(handle) = entry.handle.take() {
                    handle.abort();
                }
            }
        }
    }

    /// Look up a device_id by its session token.
    /// Returns `None` if no device matches the token.
    pub fn get_device_by_token(&self, token: &str) -> Option<String> {
        let map = self.devices.lock().unwrap();
        map.iter()
            .find(|(_, entry)| entry.session_token.as_deref() == Some(token))
            .map(|(device_id, _)| device_id.clone())
    }
}
