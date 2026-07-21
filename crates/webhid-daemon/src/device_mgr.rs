use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use hidapi::HidDevice;

use tokio::sync::broadcast;
use tokio::task::JoinHandle;

use anyhow::anyhow;
use webhid::{DeviceInfo, IpcResponse};

use crate::hid;

// M1: We use `.lock().unwrap_or_else(|e| e.into_inner())` instead of
// `.lock().unwrap()` throughout this crate. A Mutex becomes "poisoned" when
// a thread panics while holding the lock; the default `.unwrap()` would then
// propagate the poison to every subsequent lock attempt, permanently
// disabling that mutex for the lifetime of the process. The std-recommended
// recovery is to extract the inner guard via `PoisonError::into_inner`,
// which lets the next locker proceed (the data may be in an inconsistent
// state, but that is generally preferable to a hard failure for a long-
// running daemon). The panic that caused the poison is still logged via
// the panic hook, so we don't lose the diagnostic.

struct Entry {
    device: Arc<Mutex<HidDevice>>,
    stop_flag: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
    refcount: u32,
    dataplane_mode: Mutex<String>,
    ws_generation: AtomicU64,
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
    devices: Arc<Mutex<HashMap<u32, Entry>>>,
    tokens: Arc<Mutex<HashMap<String, u32>>>,
    event_tx: broadcast::Sender<IpcResponse>,
}

impl DeviceManager {
    pub fn new(event_tx: broadcast::Sender<IpcResponse>) -> Self {
        Self {
            devices: Mutex::new(HashMap::new()).into(),
            tokens: Mutex::new(HashMap::new()).into(),
            event_tx,
        }
    }

    pub fn enumerate(&self) -> anyhow::Result<Vec<DeviceInfo>> {
        hid::enumerate()
    }

    pub fn open(&self, device_id: u32) -> anyhow::Result<(u32, Option<String>)> {
        let session_token = generate_session_token()?;

        {
            let mut map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(entry) = map.get_mut(&device_id) {
                entry.refcount += 1;
                let rc = entry.refcount;
                drop(map);
                self.tokens
                    .lock()
                    .unwrap()
                    .insert(session_token.clone(), device_id);
                log::info!("[device_mgr] {device_id:#x} refcount → {rc} (existing session)");
                return Ok((device_id, Some(session_token)));
            }
        }

        let (info, uses_numbered_reports, device) = hid::open_by_device_id(device_id)?;
        let id = info.device_id;

        let stop_flag = Arc::new(AtomicBool::new(false));
        // E9: Previously this code called open_by_device_id a second time just
        // to obtain a second HidDevice handle for the reader task. If the
        // device was unplugged in the tiny gap between the two opens, the
        // second call would fail (and even worse, future changes could leave
        // the first handle dangling untracked). The reader task only needs an
        // independent handle to avoid read/write contention on the same
        // hidapi handle; if we can't get a second one we surface the error
        // immediately instead of leaving the writer handle orphaned.
        let reader_device = match hid::open_by_device_id(id) {
            Ok((_, _, d)) => d,
            Err(e) => {
                // `device` (the writer handle we already opened) is dropped
                // here on return, so no resource leak.
                return Err(e);
            }
        };
        let reader_arc = Arc::new(Mutex::new(reader_device));
        let writer_arc = Arc::new(Mutex::new(device));

        let mut map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get_mut(&id) {
            entry.refcount += 1;
            let rc = entry.refcount;
            drop(map);
            self.tokens
                .lock()
                .unwrap()
                .insert(session_token.clone(), id);
            log::info!("[device_mgr] {id:#x} refcount → {rc} (existing session)");
            return Ok((id, Some(session_token)));
        }

        let entry = Entry {
            device: Arc::clone(&writer_arc),
            stop_flag: Arc::clone(&stop_flag),
            handle: None,
            refcount: 1,
            ws_generation: AtomicU64::new(0),
            dataplane_mode: Mutex::new("nm".to_string()),
        };

        map.insert(id, entry);
        self.tokens
            .lock()
            .unwrap()
            .insert(session_token.clone(), id);

        let dev_id = id;
        let dev_for_task = Arc::clone(&reader_arc);
        let stop_for_task = Arc::clone(&stop_flag);
        let tx = self.event_tx.clone();
        let read_buf_size = info.max_input_report_size as usize + 1;

        log::info!(
            "[reader] starting for {dev_id:#x} (numbered_reports={uses_numbered_reports}, buf_size={read_buf_size})"
        );
        let handle = tokio::spawn(async move {
            loop {
                if stop_for_task.load(Ordering::SeqCst) {
                    break;
                }

                let read_result = tokio::task::spawn_blocking({
                    let dev = Arc::clone(&dev_for_task);
                    move || {
                        let d = dev.lock().unwrap_or_else(|e| e.into_inner());
                        hid::read_with_timeout(&d, 500, read_buf_size)
                    }
                })
                .await;

                match read_result {
                    Ok(Ok(buf)) => {
                        let (report_id, data): (u8, Bytes) = if uses_numbered_reports {
                            if !buf.is_empty() {
                                let b = Bytes::from(buf);
                                let report_id = b[0];
                                let data = b.slice(1..);
                                (report_id, data)
                            } else {
                                (0u8, Bytes::new())
                            }
                        } else {
                            (0u8, Bytes::from(buf))
                        };
                        let _ = tx.send(IpcResponse::InputReport {
                            id: 0,
                            device_id: dev_id,
                            report_id,
                            data,
                        });
                    }
                    Ok(Err(e)) => {
                        if e.kind() == std::io::ErrorKind::TimedOut {
                            continue;
                        }
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
        let mut map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        let entry = map
            .get_mut(&device_id)
            .ok_or_else(|| anyhow!("'{device_id:#x}' not open"))?;
        if entry.refcount > 1 {
            entry.refcount -= 1;
            log::info!(
                "[device_mgr] {device_id:#x} refcount → {} (session closed, device stays open)",
                entry.refcount
            );
            return Ok(());
        }
        let mut entry = map
            .remove(&device_id)
            .ok_or_else(|| anyhow!("'{device_id:#x}' not open"))?;
        entry.stop_flag.store(true, Ordering::SeqCst);
        if let Some(handle) = entry.handle.take() {
            handle.abort();
        }
        drop(map);

        let mut tokens = self.tokens.lock().unwrap_or_else(|e| e.into_inner());
        tokens.retain(|_, &mut v| v != device_id);
        log::info!("[device_mgr] {device_id:#x} closed (refcount → 0)");
        Ok(())
    }

    pub fn get_file(&self, device_id: u32) -> anyhow::Result<Arc<Mutex<HidDevice>>> {
        let map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        let entry = map
            .get(&device_id)
            .ok_or_else(|| anyhow!("'{device_id:#x}' not open"))?;
        Ok(Arc::clone(&entry.device))
    }

    pub fn set_dataplane_mode(&self, device_id: u32, mode: &str) {
        let map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get(&device_id) {
            *entry.dataplane_mode.lock().unwrap_or_else(|e| e.into_inner()) = mode.to_string();
            log::info!("[device_mgr] {device_id:#x} dataplane mode → {mode}");
        }
    }

    pub fn ws_connect(&self, device_id: u32) -> u64 {
        let map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get(&device_id) {
            let g = entry.ws_generation.fetch_add(1, Ordering::SeqCst) + 1;
            *entry.dataplane_mode.lock().unwrap_or_else(|e| e.into_inner()) = "ws".to_string();
            log::info!("[device_mgr] {device_id:#x} WS connect gen={g}");
            g
        } else {
            0
        }
    }

    pub fn ws_disconnect(&self, device_id: u32, generation: u64) {
        let map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get(&device_id) {
            let current = entry.ws_generation.load(Ordering::SeqCst);
            if current == generation {
                *entry.dataplane_mode.lock().unwrap_or_else(|e| e.into_inner()) = "nm".to_string();
                log::info!("[device_mgr] {device_id:#x} WS disconnect gen={generation} → nm");
            } else {
                log::info!(
                    "[device_mgr] {device_id:#x} WS disconnect gen={generation} stale (current={current}), keeping ws"
                );
            }
        }
    }

    pub fn dataplane_mode(&self, device_id: u32) -> String {
        let map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        map.get(&device_id)
            .map(|e| {
                e.dataplane_mode
                    .lock()
                    .unwrap_or_else(|pe| pe.into_inner())
                    .clone()
            })
            .unwrap_or_else(|| "nm".to_string())
    }

    pub fn close_all_devices(&self) {
        let mut map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        let keys: Vec<u32> = map.keys().copied().collect();
        for k in keys {
            if let Some(mut entry) = map.remove(&k) {
                entry.stop_flag.store(true, Ordering::SeqCst);
                if let Some(handle) = entry.handle.take() {
                    handle.abort();
                }
            }
        }
        drop(map);
        self.tokens.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }

    /// Forcefully close a device regardless of its refcount.
    ///
    /// M2: Used by the hotplug path when the OS reports a device has been
    /// physically removed. The normal `close()` decrements refcount and
    /// only tears down the device when refcount hits 0 — that is the right
    /// behavior for an explicit per-session close from a tab, but it is the
    /// wrong behavior when the hardware is gone: every open session is now
    /// invalid and the device entry must be removed so subsequent
    /// sendReport / receiveFeatureReport calls fail cleanly with 404
    /// instead of writing to a stale handle.
    pub fn force_close(&self, device_id: u32) {
        let mut map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        let Some(mut entry) = map.remove(&device_id) else {
            return;
        };
        entry.stop_flag.store(true, Ordering::SeqCst);
        if let Some(handle) = entry.handle.take() {
            handle.abort();
        }
        drop(map);
        let mut tokens = self.tokens.lock().unwrap_or_else(|e| e.into_inner());
        tokens.retain(|_, &mut v| v != device_id);
        log::info!("[device_mgr] {device_id:#x} force-closed (hotplug removal)");
    }

    pub fn get_device_by_token(&self, token: &str) -> Option<u32> {
        use subtle::ConstantTimeEq;
        let tokens = self.tokens.lock().unwrap_or_else(|e| e.into_inner());
        for (stored, device_id) in tokens.iter() {
            if stored.as_bytes().ct_eq(token.as_bytes()).into() {
                return Some(*device_id);
            }
        }
        None
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
