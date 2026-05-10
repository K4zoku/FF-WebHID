//! Tracks which hidraw devices are open and which client owns each one.

use std::collections::HashMap;
use std::fs::File;
use std::sync::{Arc, Mutex};

use anyhow::anyhow;
use webhid::DeviceInfo;

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
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

pub struct DeviceManager {
    // Key: hidraw node path (e.g. "/dev/hidraw0"), which is also the device_id
    // sent to the addon.
    devices: Mutex<HashMap<String, Entry>>,
}

impl DeviceManager {
    pub fn new() -> Self {
        Self { devices: Mutex::new(HashMap::new()) }
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
        map.insert(
            path.clone(),
            Entry { info, file: Arc::new(Mutex::new(file)), client_id },
        );
        Ok(path)
    }

    /// Close a device owned by `client_id`.
    pub fn close(&self, device_id: &str, client_id: u64) -> anyhow::Result<()> {
        let mut map = self.devices.lock().unwrap();
        let entry = map.get(device_id).ok_or_else(|| anyhow!("'{device_id}' not open"))?;
        if entry.client_id != client_id {
            return Err(anyhow!("'{device_id}' is not owned by this client"));
        }
        map.remove(device_id);
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
        self.devices.lock().unwrap().retain(|_, e| e.client_id != client_id);
    }
}
