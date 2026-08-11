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

use crate::blocklist::ReportType;
use crate::hid;
use crate::report_blocking::{DeviceReportBlocking, prune_device_info};
const MODE_NM: &str = "nm";
const MODE_WS: &str = "ws";
const MODE_WT: &str = "wt";

#[cfg(target_os = "linux")]
pub(crate) type DeviceHandle = Arc<HidDevice>;
#[cfg(not(target_os = "linux"))]
pub(crate) type DeviceHandle = Arc<Mutex<HidDevice>>;

/// Run a closure against the inner `HidDevice`. On Linux this is a direct
/// borrow (no Mutex). On other platforms it acquires the Mutex.
#[cfg(target_os = "linux")]
#[inline]
pub(crate) fn with_device<R>(handle: &DeviceHandle, f: impl FnOnce(&HidDevice) -> R) -> R {
    f(handle.as_ref())
}
#[cfg(not(target_os = "linux"))]
#[inline]
pub(crate) fn with_device<R>(handle: &DeviceHandle, f: impl FnOnce(&HidDevice) -> R) -> R {
    f(&*handle.lock().unwrap_or_else(|e| e.into_inner()))
}

struct Entry {
    device: DeviceHandle,
    stop_flag: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
    refcount: u32,
    dataplane_modes: Mutex<HashMap<String, String>>,
    ws_generation: AtomicU64,
    wt_generation: AtomicU64,
    vendor_id: u16,
    product_id: u16,
    /// Report-level protection state (map, fallbacks, send validation),
    /// computed once at open. See `crate::report_blocking`.
    blocking: Arc<crate::report_blocking::DeviceReportBlocking>,
}

fn random_hex_token(n: usize) -> Result<String, getrandom::Error> {
    let mut buf = vec![0u8; n];
    getrandom::fill(&mut buf)?;
    Ok(hex::encode(&buf))
}

fn compute_ws_auth_hash(token: &str, nonce: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hasher.update(nonce.as_bytes());
    let digest = hasher.finalize();
    hex::encode(digest)
}

/// Why a send/feature-read request was rejected before touching the device.
pub enum SendReject {
    Blocked,
    Invalid,
}

pub struct DeviceManager {
    devices: Arc<Mutex<HashMap<u32, Entry>>>,
    ws_auth_hashes: Arc<Mutex<HashMap<String, (u32, String)>>>,
    ws_nonce: String,
    event_tx: broadcast::Sender<IpcResponse>,
}

/// Parameters for a freshly opened device's background input reader.
struct ReaderConfig {
    dev_id: u32,
    dev_for_task: DeviceHandle,
    stop_flag: Arc<AtomicBool>,
    uses_numbered_reports: bool,
    blocked_input_ids: Arc<HashSet<u8>>,
    declared_input_ids: Arc<HashSet<u8>>,
    always_protected_input: bool,
    interface_protected_input: bool,
    devices: Arc<Mutex<HashMap<u32, Entry>>>,
    ws_auth_hashes: Arc<Mutex<HashMap<String, (u32, String)>>>,
    device_info: DeviceInfo,
}
impl DeviceManager {
    pub fn new(event_tx: broadcast::Sender<IpcResponse>) -> Self {
        let ws_nonce = random_hex_token(16).expect("getrandom should not fail on modern kernels");
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
        Ok(hid::enumerate()?
            .into_iter()
            .filter_map(prune_device_info)
            .collect())
    }

    pub fn open(&self, device_id: u32) -> anyhow::Result<(u32, Option<String>)> {
        let session_token = random_hex_token(16)?;
        let ws_auth_hash = compute_ws_auth_hash(&session_token, &self.ws_nonce);

        if let Some(id) = self.register_session_if_open(device_id, &session_token, &ws_auth_hash) {
            return Ok((id, Some(session_token)));
        }

        let (info, uses_numbered_reports, device) = hid::open_by_device_id(device_id)?;
        let id = info.device_id;

        let blocking = Arc::new(DeviceReportBlocking::new(&info, uses_numbered_reports));
        let blocked_input_ids =
            Arc::new(blocking.blocked_input_ids(info.vendor_id, info.product_id));
        let declared_input_ids = Arc::new(blocking.declared_input_ids());

        let stop_flag = Arc::new(AtomicBool::new(false));

        #[cfg(target_os = "linux")]
        let device_arc: DeviceHandle = Arc::new(device);
        #[cfg(not(target_os = "linux"))]
        let device_arc: DeviceHandle = Arc::new(Mutex::new(device));
        let dev_for_task = Arc::clone(&device_arc);

        if let Some(id) = self.register_session_if_open(id, &session_token, &ws_auth_hash) {
            return Ok((id, Some(session_token)));
        }

        let entry = Entry {
            device: Arc::clone(&device_arc),
            stop_flag: Arc::clone(&stop_flag),
            handle: None,
            refcount: 1,
            ws_generation: AtomicU64::new(0),
            wt_generation: AtomicU64::new(0),
            dataplane_modes: Mutex::new(HashMap::from([(
                session_token.clone(),
                MODE_NM.to_string(),
            )])),
            vendor_id: info.vendor_id,
            product_id: info.product_id,
            blocking: Arc::clone(&blocking),
        };

        let mut map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        map.insert(id, entry);
        self.ws_auth_hashes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(ws_auth_hash.clone(), (id, session_token.clone()));

        let handle = self.spawn_reader(ReaderConfig {
            dev_id: id,
            dev_for_task,
            stop_flag,
            uses_numbered_reports,
            blocked_input_ids,
            declared_input_ids,
            always_protected_input: blocking.always_protected[0],
            interface_protected_input: blocking.interface_protected[0],
            devices: Arc::clone(&self.devices),
            ws_auth_hashes: Arc::clone(&self.ws_auth_hashes),
            device_info: info.clone(),
        });
        if let Some(e) = map.get_mut(&id) {
            e.handle = Some(handle);
        }
        drop(map);

        Ok((id, Some(session_token)))
    }

    /// If `device_id` is already open, register a new NM-mode session for it
    /// (refcount +1, dataplane mode entry, WS auth hash) and return the
    /// device id. Returns `None` when the device is not currently open.
    fn register_session_if_open(
        &self,
        device_id: u32,
        session_token: &str,
        ws_auth_hash: &str,
    ) -> Option<u32> {
        let rc = {
            let mut map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
            let entry = map.get_mut(&device_id)?;
            entry.refcount += 1;
            let rc = entry.refcount;
            entry
                .dataplane_modes
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(session_token.to_string(), MODE_NM.to_string());
            rc
        };
        self.ws_auth_hashes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                ws_auth_hash.to_string(),
                (device_id, session_token.to_string()),
            );
        log::info!("[device_mgr] {device_id:#x} refcount → {rc} (existing session)");
        Some(device_id)
    }

    /// Spawn the background input reader for a freshly opened device. The
    /// reader stops when `stop_flag` is set and forwards unblocked input
    /// reports to the event bus.
    fn spawn_reader(&self, cfg: ReaderConfig) -> JoinHandle<()> {
        let ReaderConfig {
            dev_id,
            dev_for_task,
            stop_flag,
            uses_numbered_reports,
            blocked_input_ids,
            declared_input_ids,
            always_protected_input,
            interface_protected_input,
            devices: devices_for_task,
            ws_auth_hashes: hashes_for_task,
            device_info: info_for_task,
        } = cfg;
        let stop_for_task = Arc::clone(&stop_flag);
        let blocked_for_task = Arc::clone(&blocked_input_ids);
        let declared_for_task = Arc::clone(&declared_input_ids);
        let tx = self.event_tx.clone();

        log::info!(
            "[reader] starting for {dev_id:#x} (numbered_reports={uses_numbered_reports})"
        );
        tokio::spawn(async move {
            // A non-timeout read error leaves the device stuck open with no
            // hotplug event to clean it up, so the reader removes the entry,
            // clears its auth hashes and surfaces the disconnect itself.
            let cleanup_dead_reader = || {
                let removed = devices_for_task
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&dev_id)
                    .is_some();
                if removed {
                    hashes_for_task
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .retain(|_, (d, _)| *d != dev_id);
                    let _ = tx.send(IpcResponse::DeviceDisconnected {
                        device: info_for_task.clone(),
                    });
                }
            };
            loop {
                if stop_for_task.load(Ordering::SeqCst) {
                    break;
                }

                let read_result = tokio::task::spawn_blocking({
                    let dev = Arc::clone(&dev_for_task);
                    move || with_device(&dev, |d| hid::read_with_timeout(d, 500))
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
                        if blocked_for_task.contains(&report_id)
                            || interface_protected_input
                            || (!declared_for_task.contains(&report_id) && always_protected_input)
                        {
                            log::debug!(
                                "[reader {dev_id:#x}] dropping blocked input report_id={report_id}"
                            );
                            continue;
                        }
                        let _ = tx.send(IpcResponse::InputReport {
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
                        cleanup_dead_reader();
                        break;
                    }
                    Err(e) => {
                        log::warn!("[reader {dev_id:#x}] join error: {e}; stopping");
                        cleanup_dead_reader();
                        break;
                    }
                }
            }
            log::info!("[reader {dev_id:#x}] stopped");
        })
    }

    pub fn close(&self, device_id: u32, session_token: Option<&str>) -> anyhow::Result<()> {
        let token = session_token.ok_or_else(|| anyhow!("close requires session_token"))?;
        let mut map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        let entry = map
            .get_mut(&device_id)
            .ok_or_else(|| anyhow!("'{device_id:#x}' not open"))?;
        {
            let mut modes = entry
                .dataplane_modes
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if !modes.contains_key(token) {
                return Err(anyhow!("invalid session_token for device {device_id:#x}"));
            }
            modes.remove(token);
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

        let mut hashes = self
            .ws_auth_hashes
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        hashes.retain(|_, (dev_id, _)| *dev_id != device_id);
        log::info!("[device_mgr] {device_id:#x} closed (refcount → 0)");
        Ok(())
    }

    pub fn get_file(&self, device_id: u32) -> anyhow::Result<DeviceHandle> {
        let map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        let entry = map
            .get(&device_id)
            .ok_or_else(|| anyhow!("'{device_id:#x}' not open"))?;
        Ok(Arc::clone(&entry.device))
    }

    /// Resolves the open device handle, logging on failure.
    pub fn get_file_logged(&self, device_id: u32) -> Option<DeviceHandle> {
        match self.get_file(device_id) {
            Ok(f) => Some(f),
            Err(e) => {
                log::warn!("[device_mgr] get_file '{device_id:#x}': {e}");
                None
            }
        }
    }

    pub fn set_dataplane_mode(&self, device_id: u32, session_token: &str, mode: &str) {
        let map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get(&device_id) {
            entry
                .dataplane_modes
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(session_token.to_string(), mode.to_string());
            log::info!("[device_mgr] {device_id:#x} session dataplane mode → {mode}");
        }
    }

    pub fn ws_connect(&self, device_id: u32, session_token: &str) -> u64 {
        let map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get(&device_id) {
            let g = entry.ws_generation.fetch_add(1, Ordering::SeqCst) + 1;
            entry
                .dataplane_modes
                .lock()
                .unwrap_or_else(|e| e.into_inner())
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
                entry
                    .dataplane_modes
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(session_token.to_string(), MODE_NM.to_string());
                log::info!("[device_mgr] {device_id:#x} WS disconnect gen={generation} → nm");
            } else {
                log::info!(
                    "[device_mgr] {device_id:#x} WS disconnect gen={generation} stale (current={current}), keeping ws"
                );
            }
        }
    }

    pub fn wt_connect(&self, device_id: u32, session_token: &str) -> u64 {
        let map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get(&device_id) {
            let g = entry.wt_generation.fetch_add(1, Ordering::SeqCst) + 1;
            entry
                .dataplane_modes
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(session_token.to_string(), MODE_WT.to_string());
            log::info!("[device_mgr] {device_id:#x} WT connect gen={g}");
            g
        } else {
            0
        }
    }

    pub fn wt_disconnect(&self, device_id: u32, session_token: &str, generation: u64) {
        let map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get(&device_id) {
            let current = entry.wt_generation.load(Ordering::SeqCst);
            if current == generation {
                entry
                    .dataplane_modes
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(session_token.to_string(), MODE_NM.to_string());
                log::info!("[device_mgr] {device_id:#x} WT disconnect gen={generation} → nm");
            } else {
                log::info!(
                    "[device_mgr] {device_id:#x} WT disconnect gen={generation} stale (current={current}), keeping wt"
                );
            }
        }
    }

    pub fn has_nm_session(&self, device_id: u32) -> bool {
        let map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get(&device_id) {
            let modes = entry
                .dataplane_modes
                .lock()
                .unwrap_or_else(|e| e.into_inner());
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
        let mut hashes = self
            .ws_auth_hashes
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        hashes.retain(|_, (dev_id, _)| *dev_id != device_id);
        log::info!("[device_mgr] {device_id:#x} force-closed (hotplug removal)");
    }

    /// Chromium's `HidConnection::Write` / `GetFeatureReport` /
    /// `SendFeatureReport` pre-checks: the report ID must be consistent with
    /// the device's numbered-report mode (`has_report_id != (report_id != 0)`
    /// in Chromium) and the payload must fit the declared max size for the
    /// report type. A payload length of `None` means a read (no payload).
    /// A max size of zero (the report type is not declared in the descriptor)
    /// rejects the request, matching Chromium's `max_*_report_size() == 0`
    /// gates in `Write` / `GetFeatureReport` / `SendFeatureReport`.
    pub fn validate_report_send(
        &self,
        device_id: u32,
        report_id: u8,
        report_type: ReportType,
        payload_len: Option<usize>,
    ) -> bool {
        let map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        let Some(entry) = map.get(&device_id) else {
            return false;
        };
        entry
            .blocking
            .validate_report_send(report_id, report_type, payload_len)
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
        entry.blocking.is_report_protected(
            entry.vendor_id,
            entry.product_id,
            report_id,
            report_type,
        )
    }

    /// Blocklist first, then Chromium-style validation. Ok(()) means the
    /// report may proceed; Err carries the reject reason.
    pub fn report_send_allowed(
        &self,
        device_id: u32,
        report_id: u8,
        report_type: ReportType,
        payload_len: Option<usize>,
    ) -> Result<(), SendReject> {
        if self.is_report_blocked(device_id, report_id, report_type) {
            return Err(SendReject::Blocked);
        }
        if !self.validate_report_send(device_id, report_id, report_type, payload_len) {
            return Err(SendReject::Invalid);
        }
        Ok(())
    }

    pub fn get_device_by_ws_auth(&self, hash: &str) -> Option<(u32, String)> {
        self.ws_auth_hashes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(hash)
            .map(|(dev_id, token)| (*dev_id, token.clone()))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::broadcast;

    fn test_token(seed: u8) -> String {
        hex::encode([seed; 16])
    }
    fn test_nonce(seed: u8) -> String {
        hex::encode([seed; 16])
    }

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
    fn test_close_rejects_missing_session_token() {
        let (tx, _) = broadcast::channel(16);
        let mgr = DeviceManager::new(tx);
        let err = mgr.close(0xdeadbeef, None).unwrap_err();
        assert!(err.to_string().contains("session_token"));
    }

    #[test]
    fn test_get_device_by_ws_auth_roundtrip() {
        let (tx, _) = broadcast::channel(16);
        let mgr = DeviceManager::new(tx);
        let hash = "a".repeat(64);
        mgr.ws_auth_hashes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(hash.clone(), (0x1234, "tok".to_string()));
        assert_eq!(
            mgr.get_device_by_ws_auth(&hash),
            Some((0x1234, "tok".to_string()))
        );
        assert!(mgr.get_device_by_ws_auth("b".repeat(64).as_str()).is_none());
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
        let hash = compute_ws_auth_hash(&test_token(0xa1), &test_nonce(0x01));
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
