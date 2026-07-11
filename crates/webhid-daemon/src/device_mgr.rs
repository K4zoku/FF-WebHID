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
    stop_flag: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
    refcount: u32,
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
    tokens: Mutex<HashMap<String, u32>>,
    event_tx: broadcast::Sender<IpcResponse>,
    control_token: Mutex<Option<String>>,
}

impl DeviceManager {
    pub fn new(event_tx: broadcast::Sender<IpcResponse>) -> Self {
        Self {
            devices: Mutex::new(HashMap::new()),
            tokens: Mutex::new(HashMap::new()),
            event_tx,
            control_token: Mutex::new(None),
        }
    }

    pub fn get_or_create_control_token(&self) -> anyhow::Result<String> {
        let mut guard = self.control_token.lock().unwrap();
        if let Some(ref t) = *guard {
            return Ok(t.clone());
        }
        let token = generate_session_token()
            .map_err(|e| anyhow::anyhow!("failed to generate control token: {e}"))?;
        *guard = Some(token.clone());
        Ok(token)
    }

    pub fn validate_control_token(&self, token: &str) -> bool {
        self.control_token.lock().unwrap().as_deref() == Some(token)
    }

    pub fn enumerate(&self) -> anyhow::Result<Vec<DeviceInfo>> {
        hid::enumerate()
    }

    pub fn open(&self, device_id: u32) -> anyhow::Result<(u32, Option<String>)> {
        let session_token = generate_session_token()?;

        {
            let mut map = self.devices.lock().unwrap();
            if let Some(entry) = map.get_mut(&device_id) {
                entry.refcount += 1;
                let rc = entry.refcount;
                drop(map);
                self.tokens.lock().unwrap().insert(session_token.clone(), device_id);
                log::info!("[device_mgr] {device_id:#x} refcount → {rc} (existing session)");
                return Ok((device_id, Some(session_token)));
            }
        }

        let (info, uses_numbered_reports, device) = hid::open_by_device_id(device_id)?;
        let id = info.device_id;

        let mut map = self.devices.lock().unwrap();
        if let Some(entry) = map.get_mut(&id) {
            entry.refcount += 1;
            let rc = entry.refcount;
            drop(map);
            self.tokens.lock().unwrap().insert(session_token.clone(), id);
            log::info!("[device_mgr] {id:#x} refcount → {rc} (existing session)");
            return Ok((id, Some(session_token)));
        }

        let stop_flag = Arc::new(AtomicBool::new(false));
        let reader_device = hid::open_by_device_id(id)?.2;
        let reader_arc = Arc::new(Mutex::new(reader_device));
        let writer_arc = Arc::new(Mutex::new(device));
        let entry = Entry {
            device: Arc::clone(&writer_arc),
            stop_flag: Arc::clone(&stop_flag),
            handle: None,
            refcount: 1,
            dataplane_mode: Mutex::new("nm".to_string()),
        };

        map.insert(id, entry);
        self.tokens.lock().unwrap().insert(session_token.clone(), id);

        let dev_id = id;
        let dev_for_task = Arc::clone(&reader_arc);
        let stop_for_task = Arc::clone(&stop_flag);
        let tx = self.event_tx.clone();

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

    pub fn close(&self, device_id: u32) -> anyhow::Result<()> {
        let mut map = self.devices.lock().unwrap();
        let entry = map.get_mut(&device_id).ok_or_else(|| anyhow!("'{device_id:#x}' not open"))?;
        if entry.refcount > 1 {
            entry.refcount -= 1;
            log::info!("[device_mgr] {device_id:#x} refcount → {} (session closed, device stays open)", entry.refcount);
            return Ok(());
        }
        let mut entry = map.remove(&device_id).unwrap();
        entry.stop_flag.store(true, Ordering::SeqCst);
        if let Some(handle) = entry.handle.take() { handle.abort(); }
        drop(map);

        let mut tokens = self.tokens.lock().unwrap();
        tokens.retain(|_, &mut v| v != device_id);
        log::info!("[device_mgr] {device_id:#x} closed (refcount → 0)");
        Ok(())
    }

    pub fn get_file(&self, device_id: u32) -> anyhow::Result<Arc<Mutex<HidDevice>>> {
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

    pub fn close_all_devices(&self) {
        let mut map = self.devices.lock().unwrap();
        let keys: Vec<u32> = map.keys().copied().collect();
        for k in keys {
            if let Some(mut entry) = map.remove(&k) {
                entry.stop_flag.store(true, Ordering::SeqCst);
                if let Some(handle) = entry.handle.take() { handle.abort(); }
            }
        }
        drop(map);
        self.tokens.lock().unwrap().clear();
    }

    pub fn get_device_by_token(&self, token: &str) -> Option<u32> {
        self.tokens.lock().unwrap().get(token).copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::broadcast;

    #[test]
    fn test_dataplane_mode_default() {
        let (tx, _) = broadcast::channel(16);
        let mgr = DeviceManager::new(tx);
        assert_eq!(mgr.dataplane_mode(0xDEADBEEF), "nm");
        assert_eq!(mgr.dataplane_mode(0x1234), "nm");
    }

    #[test]
    fn test_close_all_devices_no_devices() {
        let (tx, _) = broadcast::channel(16);
        let mgr = DeviceManager::new(tx);
        mgr.close_all_devices();
    }

    #[test]
    fn test_get_device_by_token_empty() {
        let (tx, _) = broadcast::channel(16);
        let mgr = DeviceManager::new(tx);
        assert!(mgr.get_device_by_token("any").is_none());
    }
}
