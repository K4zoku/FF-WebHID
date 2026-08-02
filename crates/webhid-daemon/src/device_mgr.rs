use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use hidapi::HidDevice;
use sha2::{Digest, Sha256};

use tokio::sync::broadcast;
use tokio::task::JoinHandle;

use anyhow::anyhow;
use webhid::{DeviceInfo, IpcResponse};

use crate::blocklist::{self, ReportType};
use crate::hid;
const MODE_NM: &str = "nm";
const MODE_WS: &str = "ws";


struct Entry {
    device: Arc<Mutex<HidDevice>>,
    stop_flag: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
    refcount: u32,
    dataplane_modes: Mutex<HashMap<String, String>>,
    ws_generation: AtomicU64,
    vendor_id: u16,
    product_id: u16,
    report_to_collection: Arc<HashMap<(u8, u8), (Option<u16>, Option<u16>)>>,
}

fn random_hex_token(n: usize) -> Result<String, getrandom::Error> {
    let mut buf = vec![0u8; n];
    getrandom::fill(&mut buf)?;
    Ok(hex::encode(&buf))
}

fn build_report_collection_map(
    info: &DeviceInfo,
) -> HashMap<(u8, u8), (Option<u16>, Option<u16>)> {
    let mut map = HashMap::new();
    for col in &info.collections {
        let up = col.usage_page;
        let u = col.usage;
        for r in &col.input_reports {
            map.insert((r.report_id, 0), (up, u));
        }
        for r in &col.output_reports {
            map.insert((r.report_id, 1), (up, u));
        }
        for r in &col.feature_reports {
            map.insert((r.report_id, 2), (up, u));
        }
    }
    map
}

fn compute_blocked_input_ids(
    info: &DeviceInfo,
    report_map: &HashMap<(u8, u8), (Option<u16>, Option<u16>)>,
) -> HashSet<u8> {
    let rules = blocklist::blocklist_rules();
    let mut ids = HashSet::new();
    for col in &info.collections {
        for r in &col.input_reports {
            let (up, u) = report_map
                .get(&(r.report_id, 0))
                .copied()
                .unwrap_or((col.usage_page, col.usage));
            if blocklist::is_report_blocked(
                rules,
                info.vendor_id,
                info.product_id,
                up,
                u,
                r.report_id,
                ReportType::Input,
            ) {
                ids.insert(r.report_id);
            }
        }
    }
    ids
}

fn compute_ws_auth_hash(token: &str, nonce: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hasher.update(nonce.as_bytes());
    let digest = hasher.finalize();
    hex::encode(&digest)
}

pub struct DeviceManager {
    devices: Arc<Mutex<HashMap<u32, Entry>>>,
    ws_auth_hashes: Arc<Mutex<HashMap<String, (u32, String)>>>,
    ws_nonce: String,
    event_tx: broadcast::Sender<IpcResponse>,
}
impl DeviceManager {
    pub fn new(event_tx: broadcast::Sender<IpcResponse>) -> Self {
        let ws_nonce = random_hex_token(16)
            .expect("getrandom should not fail on modern kernels");
        Self {
            devices: Mutex::new(HashMap::new()).into(),
            ws_auth_hashes: Mutex::new(HashMap::new()).into(),
            ws_nonce,
            event_tx,
        }
    }

    pub fn ws_nonce(&self) -> &str {
        &self.ws_nonce
    }

    pub fn enumerate(&self) -> anyhow::Result<Vec<DeviceInfo>> {
        hid::enumerate()
    }


    pub fn open(&self, device_id: u32) -> anyhow::Result<(u32, Option<String>)> {
        let session_token = random_hex_token(16)?;
        let ws_auth_hash = compute_ws_auth_hash(&session_token, &self.ws_nonce);

        {
            let mut map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(entry) = map.get_mut(&device_id) {
                entry.refcount += 1;
                let rc = entry.refcount;
                entry.dataplane_modes.lock().unwrap_or_else(|e| e.into_inner())
                    .insert(session_token.clone(), MODE_NM.to_string());
                drop(map);
                self.ws_auth_hashes
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(ws_auth_hash.clone(), (device_id, session_token.clone()));
                log::info!("[device_mgr] {device_id:#x} refcount → {rc} (existing session)");
                return Ok((device_id, Some(session_token)));
            }
        }

        let (info, uses_numbered_reports, device) = hid::open_by_device_id(device_id)?;
        let id = info.device_id;

        let report_map = Arc::new(build_report_collection_map(&info));
        let blocked_input_ids = Arc::new(compute_blocked_input_ids(&info, &report_map));

        let stop_flag = Arc::new(AtomicBool::new(false));

        let reader_device = match hid::open_by_device_id(id) {
            Ok((_, _, d)) => d,
            Err(e) => {
                return Err(e);
            }
        };
        let reader_arc = Arc::new(Mutex::new(reader_device));
        let writer_arc = Arc::new(Mutex::new(device));

        let mut map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get_mut(&id) {
            entry.refcount += 1;
            let rc = entry.refcount;
            entry.dataplane_modes.lock().unwrap_or_else(|e| e.into_inner())
                .insert(session_token.clone(), MODE_NM.to_string());
            drop(map);
            self.ws_auth_hashes
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(ws_auth_hash.clone(), (id, session_token.clone()));
            log::info!("[device_mgr] {id:#x} refcount → {rc} (existing session)");
            return Ok((id, Some(session_token)));
        }

        let entry = Entry {
            device: Arc::clone(&writer_arc),
            stop_flag: Arc::clone(&stop_flag),
            handle: None,
            refcount: 1,
            ws_generation: AtomicU64::new(0),
            dataplane_modes: Mutex::new(HashMap::from([(session_token.clone(), MODE_NM.to_string())])),
            vendor_id: info.vendor_id,
            product_id: info.product_id,
            report_to_collection: Arc::clone(&report_map),
        };

        map.insert(id, entry);
        self.ws_auth_hashes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(ws_auth_hash.clone(), (id, session_token.clone()));

        let dev_id = id;
        let dev_for_task = Arc::clone(&reader_arc);
        let stop_for_task = Arc::clone(&stop_flag);
        let blocked_for_task = Arc::clone(&blocked_input_ids);
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
                        if blocked_for_task.contains(&report_id) {
                            log::debug!(
                                "[reader {dev_id:#x}] dropping blocked input report_id={report_id}"
                            );
                            continue;
                        }
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

    pub fn close(&self, device_id: u32, session_token: Option<&str>) -> anyhow::Result<()> {
        let mut map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        let entry = map
            .get_mut(&device_id)
            .ok_or_else(|| anyhow!("'{device_id:#x}' not open"))?;
        if let Some(token) = session_token {
            entry.dataplane_modes.lock().unwrap_or_else(|e| e.into_inner())
                .remove(token);
        }
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

        let mut hashes = self.ws_auth_hashes.lock().unwrap_or_else(|e| e.into_inner());
        hashes.retain(|_, (dev_id, _)| *dev_id != device_id);
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

    pub fn set_dataplane_mode(&self, device_id: u32, session_token: &str, mode: &str) {
        let map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get(&device_id) {
            entry.dataplane_modes.lock().unwrap_or_else(|e| e.into_inner())
                .insert(session_token.to_string(), mode.to_string());
            log::info!("[device_mgr] {device_id:#x} session dataplane mode → {mode}");
        }
    }

    pub fn ws_connect(&self, device_id: u32, session_token: &str) -> u64 {
        let map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get(&device_id) {
            let g = entry.ws_generation.fetch_add(1, Ordering::SeqCst) + 1;
            entry.dataplane_modes.lock().unwrap_or_else(|e| e.into_inner())
                .insert(session_token.to_string(), MODE_WS.to_string());
            log::info!("[device_mgr] {device_id:#x} WS connect gen={g}");
            g
        } else {
            0
        }
    }

    pub fn ws_disconnect(&self, device_id: u32, session_token: &str, generation: u64) {
        let map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get(&device_id) {
            let current = entry.ws_generation.load(Ordering::SeqCst);
            if current == generation {
                entry.dataplane_modes.lock().unwrap_or_else(|e| e.into_inner())
                    .insert(session_token.to_string(), MODE_NM.to_string());
                log::info!("[device_mgr] {device_id:#x} WS disconnect gen={generation} → nm");
            } else {
                log::info!(
                    "[device_mgr] {device_id:#x} WS disconnect gen={generation} stale (current={current}), keeping ws"
                );
            }
        }
    }

    pub fn has_nm_session(&self, device_id: u32) -> bool {
        let map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get(&device_id) {
            let modes = entry.dataplane_modes.lock().unwrap_or_else(|e| e.into_inner());
            modes.values().any(|m| m == MODE_NM)
        } else {
            false
        }
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
        self.ws_auth_hashes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }

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
        let mut hashes = self.ws_auth_hashes.lock().unwrap_or_else(|e| e.into_inner());
        hashes.retain(|_, (dev_id, _)| *dev_id != device_id);
        log::info!("[device_mgr] {device_id:#x} force-closed (hotplug removal)");
    }

    pub fn is_report_blocked(
        &self,
        device_id: u32,
        report_id: u8,
        report_type: ReportType,
    ) -> bool {
        let map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        let entry = match map.get(&device_id) {
            Some(e) => e,
            None => return false,
        };
        let rt_byte = match report_type {
            ReportType::Input => 0,
            ReportType::Output => 1,
            ReportType::Feature => 2,
        };
        let (up, u) = match entry.report_to_collection.get(&(report_id, rt_byte)) {
            Some(v) => *v,
            None => return false,
        };
        let rules = blocklist::blocklist_rules();
        blocklist::is_report_blocked(
            rules,
            entry.vendor_id,
            entry.product_id,
            up,
            u,
            report_id,
            report_type,
        )
    }

    pub fn get_device_by_ws_auth(&self, hash: &str) -> Option<(u32, String)> {
        use subtle::ConstantTimeEq;
        let hashes = self.ws_auth_hashes.lock().unwrap_or_else(|e| e.into_inner());
        let hash_bytes = hash.as_bytes();
        for (stored_hash, (dev_id, token)) in hashes.iter() {
            let stored_bytes = stored_hash.as_bytes();
            if stored_bytes.len() == hash_bytes.len()
                && stored_bytes.ct_eq(hash_bytes).into()
            {
                return Some((*dev_id, token.clone()));
            }
        }
        None
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::broadcast;

    fn test_token(seed: u8) -> String { hex::encode(&[seed; 16]) }
    fn test_nonce(seed: u8) -> String { hex::encode(&[seed; 16]) }

    #[test]
    fn test_has_nm_session_no_device() {
        let (tx, _) = broadcast::channel(16);
        let mgr = DeviceManager::new(tx);
        assert!(!mgr.has_nm_session(0xDEADBEEF));
        assert!(!mgr.has_nm_session(0x1234));
    }

    #[test]
    fn test_close_all_devices_no_devices() {
        let (tx, _) = broadcast::channel(16);
        let mgr = DeviceManager::new(tx);
        mgr.close_all_devices();
    }

    #[test]
    fn test_get_device_by_ws_auth_empty() {
        let (tx, _) = broadcast::channel(16);
        let mgr = DeviceManager::new(tx);
        assert!(mgr.get_device_by_ws_auth("anyhash").is_none());
    }

    #[test]
    fn test_ws_nonce_is_32_hex_chars() {
        let (tx, _) = broadcast::channel(16);
        let mgr = DeviceManager::new(tx);
        let nonce = mgr.ws_nonce();
        assert_eq!(nonce.len(), 32);
        assert!(nonce.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_compute_ws_auth_hash_is_64_hex_chars() {
        let hash = compute_ws_auth_hash(
            &test_token(0xa1),
            &test_nonce(0x01),
        );
        assert_eq!(hash.len(), 64);
        assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_compute_ws_auth_hash_deterministic() {
        let token = test_token(0xa1);
        let nonce = test_nonce(0x01);
        let h1 = compute_ws_auth_hash(&token, &nonce);
        let h2 = compute_ws_auth_hash(&token, &nonce);
        assert_eq!(h1, h2);
    }

    #[test]
    fn test_compute_ws_auth_hash_differs_on_token() {
        let nonce = test_nonce(0x01);
        let h1 = compute_ws_auth_hash(&test_token(0xa1), &nonce);
        let h2 = compute_ws_auth_hash(&test_token(0xb1), &nonce);
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_compute_ws_auth_hash_differs_on_nonce() {
        let token = test_token(0xa1);
        let h1 = compute_ws_auth_hash(&token, &test_nonce(0x01));
        let h2 = compute_ws_auth_hash(&token, &test_nonce(0x02));
        assert_ne!(h1, h2);
    }
}
