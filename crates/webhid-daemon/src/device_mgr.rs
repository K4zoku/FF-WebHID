//! Tracks which devices are open and which client owns each one.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};

use hidapi::HidDevice;

use tokio::task::JoinHandle;
use tokio::sync::broadcast;

use anyhow::anyhow;
use webhid::{DeviceInfo, IpcResponse};

use crate::hid;

struct Entry {
    device: Arc<Mutex<HidDevice>>,
    client_id: u64,
    stop_flag: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
    session_token: Option<String>,
    /// `"ws"` or `"nm"` — controls which channel receives input reports.
    dataplane_mode: Mutex<String>,
}

const HEX_CHARS: &[u8; 16] = b"0123456789abcdef";

fn generate_session_token() -> Result<String, getrandom::Error> {
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf)?;

    let mut out = String::with_capacity(32);
    for b in buf {
        out.push(HEX_CHARS[(b >> 4) as usize] as char);
        out.push(HEX_CHARS[(b & 0x0f) as usize] as char);
    }
    Ok(out)
}

pub struct DeviceManager {
    devices: Mutex<HashMap<u32, Entry>>,
    event_tx: broadcast::Sender<IpcResponse>,
    control_token: Mutex<Option<String>>,
}

impl DeviceManager {
    pub fn new(event_tx: broadcast::Sender<IpcResponse>) -> Self {
        Self { devices: Mutex::new(HashMap::new()), event_tx, control_token: Mutex::new(None) }
    }

    pub fn get_or_create_control_token(&self) -> String {
        let mut guard = self.control_token.lock().unwrap();
        if let Some(ref t) = *guard {
            return t.clone();
        }
        let token = generate_session_token().unwrap_or_else(|e| {
            log::error!("failed to generate control token: {e}");
            let fallback = format!("fallback_{}", std::process::id());
            fallback
        });
        *guard = Some(token.clone());
        token
    }

    pub fn validate_control_token(&self, token: &str) -> bool {
        self.control_token.lock().unwrap().as_deref() == Some(token)
    }

    pub fn enumerate(&self) -> anyhow::Result<Vec<DeviceInfo>> {
        hid::enumerate()
    }

    pub fn open(&self, device_id: u32, client_id: u64) -> anyhow::Result<(u32, Option<String>)> {
        {
            let map = self.devices.lock().unwrap();
            if let Some(existing) = map.get(&device_id) {
                return if existing.client_id == client_id {
                    Ok((device_id, existing.session_token.clone()))
                } else {
                    Err(anyhow!("'{device_id:#x}' is open by a different client"))
                };
            }
        }

        let (info, uses_numbered_reports, device) = hid::open_by_device_id(device_id)?;
        let id = info.device_id;

        let mut map = self.devices.lock().unwrap();
        if let Some(existing) = map.get(&id) {
            return if existing.client_id == client_id {
                Ok((id, existing.session_token.clone()))
            } else {
                Err(anyhow!("'{id:#x}' is open by a different client"))
            };
        }

        let session_token = self::generate_session_token()?;
        let stop_flag = Arc::new(AtomicBool::new(false));
        // Open a second handle for the reader task so it doesn't hold the
        // writer's mutex during poll(2).  hidapi allows multiple opens of
        // the same device path.  Without this, every write blocks for up
        // to 5 seconds waiting for the reader's read_timeout to expire.
        let reader_device = hid::open_by_device_id(id)?.2;
        let reader_arc = Arc::new(Mutex::new(reader_device));
        let writer_arc = Arc::new(Mutex::new(device));
        let entry = Entry {
            device: Arc::clone(&writer_arc),
            client_id,
            stop_flag: Arc::clone(&stop_flag),
            handle: None,
            session_token: Some(session_token.clone()),
            dataplane_mode: Mutex::new("nm".to_string()),
        };

        map.insert(id, entry);

        let dev_id = id;
        let dev_for_task = Arc::clone(&reader_arc);
        let stop_for_task = Arc::clone(&stop_flag);
        let tx = self.event_tx.clone();
        let uses_numbered_reports = uses_numbered_reports;

        log::info!("[reader] starting for {dev_id:#x} (numbered_reports={uses_numbered_reports})");
        let handle = tokio::spawn(async move {
            loop {
                if stop_for_task.load(Ordering::SeqCst) { break; }

                let read_result = tokio::task::spawn_blocking({
                    let dev = Arc::clone(&dev_for_task);
                    move || {
                        let d = dev.lock().unwrap();
                        hid::read_with_timeout(&d, 5000)
                    }
                })
                .await;

                match read_result {
                    Ok(Ok(buf)) => {
                        let (report_id, data): (u8, Arc<[u8]>) = if uses_numbered_reports {
                            if !buf.is_empty() { (buf[0], Arc::from(&buf[1..])) } else { (0u8, Arc::from(&[][..])) }
                        } else {
                            (0u8, Arc::from(buf.as_slice()))
                        };
                        let _ = tx.send(IpcResponse::InputReport { id: 0, device_id: dev_id, report_id, data });
                    }
                    Ok(Err(e)) => {
                        if e.kind() == std::io::ErrorKind::TimedOut { continue; }
                        log::warn!("[reader {dev_id:#x}] read error: {e}; stopping");
                        break;
                    }
                    Err(e) => {
                        log::warn!("[reader {dev_id:#x}] join error: {e}; stopping");
                        break;
                    }
                }
            }
            log::info!("[reader {dev_id:#x}] stopped");
        });

        if let Some(e) = map.get_mut(&id) {
            e.handle = Some(handle);
        }

        Ok((id, Some(session_token)))
    }

    pub fn close(&self, device_id: u32, client_id: u64) -> anyhow::Result<()> {
        let mut map = self.devices.lock().unwrap();
        let entry = map.get(&device_id).ok_or_else(|| anyhow!("'{device_id:#x}' not open"))?;
        if entry.client_id != client_id {
            return Err(anyhow!("'{device_id:#x}' is not owned by this client"));
        }
        if let Some(mut entry) = map.remove(&device_id) {
            entry.stop_flag.store(true, Ordering::SeqCst);
            if let Some(handle) = entry.handle.take() { handle.abort(); }
        }
        Ok(())
    }

    pub fn get_file(&self, device_id: u32, client_id: u64) -> anyhow::Result<Arc<Mutex<HidDevice>>> {
        let map = self.devices.lock().unwrap();
        let entry = map.get(&device_id).ok_or_else(|| anyhow!("'{device_id:#x}' not open"))?;
        if entry.client_id != client_id {
            return Err(anyhow!("'{device_id:#x}' is not owned by this client"));
        }
        Ok(Arc::clone(&entry.device))
    }

    pub fn get_file_by_device_id(&self, device_id: u32) -> anyhow::Result<Arc<Mutex<HidDevice>>> {
        let map = self.devices.lock().unwrap();
        let entry = map.get(&device_id).ok_or_else(|| anyhow!("'{device_id:#x}' not open"))?;
        Ok(Arc::clone(&entry.device))
    }

    pub fn set_dataplane_mode(&self, device_id: u32, mode: &str) {
        let map = self.devices.lock().unwrap();
        if let Some(entry) = map.get(&device_id) {
            *entry.dataplane_mode.lock().unwrap() = mode.to_string();
            log::info!("[device_mgr] {device_id:#x} dataplane mode → {mode}");
        }
    }

    pub fn dataplane_mode(&self, device_id: u32) -> String {
        let map = self.devices.lock().unwrap();
        map.get(&device_id)
            .map(|e| e.dataplane_mode.lock().unwrap().clone())
            .unwrap_or_else(|| "nm".to_string())
    }

    pub fn close_client_devices(&self, client_id: u64) {
        let mut map = self.devices.lock().unwrap();
        let keys: Vec<u32> = map.iter().filter(|(_, e)| e.client_id == client_id).map(|(k, _)| *k).collect();
        for k in keys {
            if let Some(mut entry) = map.remove(&k) {
                entry.stop_flag.store(true, Ordering::SeqCst);
                if let Some(handle) = entry.handle.take() { handle.abort(); }
            }
        }
    }

    pub fn get_device_by_token(&self, token: &str) -> Option<u32> {
        let map = self.devices.lock().unwrap();
        map.iter()
            .find(|(_, entry)| entry.session_token.as_deref() == Some(token))
            .map(|(device_id, _)| *device_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::broadcast;

    #[test]
    fn test_ws_active_default_false() {
        let (tx, _) = broadcast::channel(16);
        let mgr = DeviceManager::new(tx);
        assert_eq!(mgr.dataplane_mode(0xDEADBEEF), "nm");
        assert_eq!(mgr.dataplane_mode(0x1234), "nm");
    }

    #[test]
    fn test_close_client_devices_no_devices() {
        let (tx, _) = broadcast::channel(16);
        let mgr = DeviceManager::new(tx);
        // Should not panic
        mgr.close_client_devices(42);
    }

    #[test]
    fn test_get_device_by_token_empty() {
        let (tx, _) = broadcast::channel(16);
        let mgr = DeviceManager::new(tx);
        assert!(mgr.get_device_by_token("any").is_none());
    }
}
