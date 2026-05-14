//! Tracks which hidraw devices are open and which client owns each one.

use std::collections::HashMap;
use std::fs::File;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};

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
    /// Shared file handle – cloned out to blocking tasks for I/O.
    file: Arc<Mutex<File>>,
    /// The client that performed the `open`; only that client may use or
    /// close the device.
    client_id: u64,
    /// Signal the background reader to stop.
    stop_flag: Arc<AtomicBool>,
    /// Join handle for the reader task so we can abort it on close.
    handle: Option<JoinHandle<()>>,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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

    /// Open the first device matching `vendor_id`:`product_id` on behalf of
    /// `client_id`.  Returns the device path, which is used as the stable
    /// device ID throughout the session.
    pub fn open(&self, vendor_id: u16, product_id: u16, client_id: u64) -> anyhow::Result<String> {
        let (info, file) = hid::open(vendor_id, product_id)?;
        let path = info.path.clone();

        let mut map = self.devices.lock().unwrap();
        if map.contains_key(&path) {
            return Err(anyhow!("'{path}' is already open"));
        }

        // Prepare entry with a stopped reader for now; we'll spawn the reader
        // and then store its handle in the map so we can stop it later.
        let stop_flag = Arc::new(AtomicBool::new(false));
        let file_arc = Arc::new(Mutex::new(file));
        let entry = Entry { info: info.clone(), file: Arc::clone(&file_arc), client_id, stop_flag: Arc::clone(&stop_flag), handle: None };

        map.insert(path.clone(), entry);

        // Spawn background reader task that polls the hidraw fd and broadcasts
        // `IpcResponse::InputReport` events. Use `spawn_blocking` for the
        // blocking read while keeping the outer task lightweight.
        let device_id = path.clone();
        let file_for_task = Arc::clone(&file_arc);
        let stop_for_task = Arc::clone(&stop_flag);
        let tx = self.event_tx.clone();

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
                        hid::read_with_timeout(&f, 500)
                    }
                })
                .await;

                match read_result {
                    Ok(Ok(buf)) => {
                        // HID raw read returns the report-id as the first byte
                        // when the device uses numbered reports.
                        let (report_id, data) = if !buf.is_empty() {
                            (buf[0], buf[1..].to_vec())
                        } else {
                            (0u8, Vec::new())
                        };

                        let _ = tx.send(IpcResponse::InputReport { id: 0, device_id: device_id.clone(), report_id, data });
                    }
                    Ok(Err(e)) => {
                        // Timeout is expected; continue. Other errors likely
                        // mean the device is gone or the fd is bad so we stop.
                        if e.kind() == std::io::ErrorKind::TimedOut {
                            continue;
                        }
                        break;
                    }
                    Err(_) => {
                        // The blocking task itself panicked or was cancelled.
                        break;
                    }
                }
            }
        });

        // Store the handle so we can stop it when the device is closed.
        if let Some(e) = map.get_mut(&path) {
            e.handle = Some(handle);
        }

        Ok(path)
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
}
