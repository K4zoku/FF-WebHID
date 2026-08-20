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
pub const MODE_NM: &str = "nm";
pub const MODE_WS: &str = "ws";
pub const MODE_WT: &str = "wt";

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

pub(crate) async fn run_device_op<T, F>(handle: DeviceHandle, op: F) -> std::io::Result<T>
where
    F: FnOnce(&HidDevice) -> std::io::Result<T> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(move || with_device(&handle, op))
        .await
        .unwrap_or_else(|e| Err(std::io::Error::other(format!("device op join failed: {e}"))))
}

/// One logical `HIDDevice.open()` session, owned by exactly one IPC client.
///
/// The physical device handle lives as long as at least one session is
/// active on it; every session carries its own data-plane mode, auth hash
/// and per-transport generation, so closing one session can never affect
/// another session's state.
struct Session {
    token: String,
    device_id: u32,
    owner_client_id: u64,
    mode: String,
    ws_auth_hash: String,
    active: bool,
    ws_generation: u64,
    wt_generation: u64,
}

struct Entry {
    device: DeviceHandle,
    stop_flag: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
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

pub fn is_valid_auth_hash(h: &str) -> bool {
    h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit())
}

/// Why a send/feature-read request was rejected before touching the device.
pub enum SendReject {
    Blocked,
    Invalid,
}

pub struct DeviceManager {
    devices: Arc<Mutex<HashMap<u32, Entry>>>,
    /// `session_token -> Session`. Sessions are the authority for device
    /// lifetime, data-plane mode, and WS/WT authentication.
    sessions: Arc<Mutex<HashMap<String, Session>>>,
    /// `ws_auth_hash -> session_token`. A hash dies with its session, never
    /// with the physical device.
    ws_auth_hashes: Arc<Mutex<HashMap<String, String>>>,
    ws_nonce: String,
    event_tx: broadcast::Sender<IpcResponse>,
    next_client_id: AtomicU64,
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
    sessions: Arc<Mutex<HashMap<String, Session>>>,
    ws_auth_hashes: Arc<Mutex<HashMap<String, String>>>,
    device_info: DeviceInfo,
}
impl DeviceManager {
    pub fn new(event_tx: broadcast::Sender<IpcResponse>) -> Self {
        let ws_nonce = random_hex_token(16).expect("getrandom should not fail on modern kernels");
        Self {
            devices: Mutex::new(HashMap::new()).into(),
            sessions: Mutex::new(HashMap::new()).into(),
            ws_auth_hashes: Mutex::new(HashMap::new()).into(),
            ws_nonce,
            event_tx,
            next_client_id: AtomicU64::new(0),
        }
    }

    /// Allocates a fresh IPC client id. Sessions record the client that
    /// opened them so a disconnect only tears down that client's sessions.
    pub fn new_client_id(&self) -> u64 {
        self.next_client_id.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn ws_nonce(&self) -> &str {
        &self.ws_nonce
    }

    pub fn enumerate(&self) -> anyhow::Result<Vec<DeviceInfo>> {
        self.enumerate_filtered(None)
    }

    pub fn enumerate_filtered(
        &self,
        filter: Option<&webhid::EnumerateFilter>,
    ) -> anyhow::Result<Vec<DeviceInfo>> {
        let devices = match filter {
            Some(filter) => hid::enumerate_with_filter(Some(filter))?,
            None => hid::enumerate()?,
        };
        Ok(devices
            .into_iter()
            .filter_map(prune_device_info)
            .filter(|device| {
                filter
                    .map(|filter| crate::enumeration_filter::matches_device(device, filter))
                    .unwrap_or(true)
            })
            .collect())
    }

    pub fn open(&self, device_id: u32, owner_client_id: u64) -> anyhow::Result<(u32, String)> {
        let session_token = random_hex_token(16)?;
        let ws_auth_hash = compute_ws_auth_hash(&session_token, &self.ws_nonce);

        if self.register_session(device_id, &session_token, owner_client_id, &ws_auth_hash) {
            return Ok((device_id, session_token));
        }

        let (info, uses_numbered_reports, device) = hid::open_by_device_id(device_id)?;
        let id = info.device_id;

        // Fail closed: a device whose report descriptor is missing or failed
        // to parse has no collections to classify reports against, so the
        // page-facing path must not open it (see prune_device_info).
        if info.descriptor_parse_failed {
            return Err(anyhow!(
                "device '{device_id:#x}' has no parsed report descriptor; refusing to open (fail closed)"
            ));
        }

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

        if self.register_session(id, &session_token, owner_client_id, &ws_auth_hash) {
            return Ok((id, session_token));
        }

        let entry = Entry {
            device: Arc::clone(&device_arc),
            stop_flag: Arc::clone(&stop_flag),
            handle: None,
            vendor_id: info.vendor_id,
            product_id: info.product_id,
            blocking: Arc::clone(&blocking),
        };

        let mut map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        map.insert(id, entry);
        drop(map);
        self.register_session(id, &session_token, owner_client_id, &ws_auth_hash);

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
            sessions: Arc::clone(&self.sessions),
            ws_auth_hashes: Arc::clone(&self.ws_auth_hashes),
            device_info: info.clone(),
        });
        if let Some(e) = self
            .devices
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_mut(&id)
        {
            e.handle = Some(handle);
        }

        Ok((id, session_token))
    }

    /// Registers a new logical session for `device_id`. Returns true when
    /// the session was registered, false when the device is not currently
    /// open. The session starts in NM mode and its WS auth hash becomes
    /// resolvable immediately.
    fn register_session(
        &self,
        device_id: u32,
        session_token: &str,
        owner_client_id: u64,
        ws_auth_hash: &str,
    ) -> bool {
        {
            let map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
            if !map.contains_key(&device_id) {
                return false;
            }
        }
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                session_token.to_string(),
                Session {
                    token: session_token.to_string(),
                    device_id,
                    owner_client_id,
                    mode: MODE_NM.to_string(),
                    ws_auth_hash: ws_auth_hash.to_string(),
                    active: true,
                    ws_generation: 0,
                    wt_generation: 0,
                },
            );
        self.ws_auth_hashes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(ws_auth_hash.to_string(), session_token.to_string());
        log::info!(
            "[device_mgr] {device_id:#x} session registered (owner client {owner_client_id})"
        );
        true
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
            sessions: sessions_for_task,
            ws_auth_hashes: hashes_for_task,
            device_info: info_for_task,
        } = cfg;
        let stop_for_task = Arc::clone(&stop_flag);
        let blocked_for_task = Arc::clone(&blocked_input_ids);
        let declared_for_task = Arc::clone(&declared_input_ids);
        let tx = self.event_tx.clone();

        log::info!("[reader] starting for {dev_id:#x} (numbered_reports={uses_numbered_reports})");
        tokio::spawn(async move {
            let cleanup_dead_reader = || {
                let removed = devices_for_task
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&dev_id)
                    .is_some();
                if removed {
                    let tokens: Vec<String> = {
                        let sessions = sessions_for_task
                            .lock()
                            .unwrap_or_else(|e| e.into_inner());
                        sessions
                            .values()
                            .filter(|s| s.device_id == dev_id)
                            .map(|s| s.token.clone())
                            .collect()
                    };
                    {
                        let mut sessions = sessions_for_task
                            .lock()
                            .unwrap_or_else(|e| e.into_inner());
                        for t in &tokens {
                            sessions.remove(t);
                        }
                    }
                    {
                        let mut hashes = hashes_for_task
                            .lock()
                            .unwrap_or_else(|e| e.into_inner());
                        hashes.retain(|_, token| !tokens.contains(token));
                    }
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

    /// Closes exactly one logical session. The session's WS auth hash dies
    /// with it, and the physical device is torn down only when no other
    /// session holds it. Closing an already-closed/unknown session is a
    /// no-op success so browser-side cleanup that races a revoke is safe.
    pub fn close(&self, device_id: u32, session_token: &str, owner_client_id: u64) -> anyhow::Result<()> {
        let (hash, last_session) = {
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            let Some(session) = sessions.get_mut(session_token) else {
                return Ok(());
            };
            if session.device_id != device_id {
                return Err(anyhow!(
                    "session token does not match device {device_id:#x}"
                ));
            }
            if session.owner_client_id != owner_client_id {
                return Err(anyhow!(
                    "session token is owned by another IPC client (owner {} != {owner_client_id})",
                    session.owner_client_id
                ));
            }
            if !session.active {
                return Ok(());
            }
            session.active = false;
            let hash = session.ws_auth_hash.clone();
            sessions.remove(session_token);
            let last_session = !sessions
                .values()
                .any(|s| s.device_id == device_id && s.active);
            (hash, last_session)
        };
        self.ws_auth_hashes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&hash);
        if last_session {
            let mut map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(mut entry) = map.remove(&device_id) {
                entry.stop_flag.store(true, Ordering::SeqCst);
                if let Some(handle) = entry.handle.take() {
                    handle.abort();
                }
            }
            log::info!("[device_mgr] {device_id:#x} closed (last session)");
        } else {
            log::info!("[device_mgr] {device_id:#x} session closed (device stays open)");
        }
        Ok(())
    }

    /// Closes every active session owned by `client_id`. Used when an IPC
    /// client disconnects; other clients' sessions are untouched.
    pub fn close_all_for_client(&self, client_id: u64) {
        let owned: Vec<(u32, String)> = {
            let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            sessions
                .values()
                .filter(|s| s.owner_client_id == client_id && s.active)
                .map(|s| (s.device_id, s.token.clone()))
                .collect()
        };
        for (device_id, token) in owned {
            if let Err(e) = self.close(device_id, &token, client_id) {
                log::warn!("[device_mgr] close_all_for_client({client_id}): {e}");
            }
        }
        if !self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .any(|s| s.owner_client_id == client_id)
        {
            log::info!("[device_mgr] client {client_id} disconnected; sessions closed");
        }
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

    /// Validates and applies a data-plane mode change for exactly one
    /// session. The session must exist, be active, match the device, belong
    /// to the requesting client, and name a known mode.
    pub fn set_dataplane_mode(
        &self,
        device_id: u32,
        session_token: &str,
        mode: &str,
        owner_client_id: u64,
    ) -> anyhow::Result<()> {
        if !matches!(mode, MODE_NM | MODE_WS | MODE_WT) {
            return Err(anyhow!("invalid data plane mode '{mode}'"));
        }
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let Some(session) = sessions.get_mut(session_token) else {
            return Err(anyhow!("no session for token"));
        };
        if !session.active {
            return Err(anyhow!("session is closed"));
        }
        if session.device_id != device_id {
            return Err(anyhow!("session token does not match device {device_id:#x}"));
        }
        if session.owner_client_id != owner_client_id {
            return Err(anyhow!(
                "session token is owned by another IPC client (owner {} != {owner_client_id})",
                session.owner_client_id
            ));
        }
        session.mode = mode.to_string();
        log::info!("[device_mgr] {device_id:#x} session dataplane mode → {mode}");
        Ok(())
    }

    /// Marks the session's data plane as WS. Returns the per-session
    /// generation, or 0 when the session is not active (the caller must
    /// treat 0 as "not connected").
    pub fn ws_connect(&self, device_id: u32, session_token: &str) -> u64 {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let Some(session) = sessions.get_mut(session_token) else {
            return 0;
        };
        if !session.active || session.device_id != device_id {
            return 0;
        }
        session.ws_generation += 1;
        session.mode = MODE_WS.to_string();
        log::info!("[device_mgr] {device_id:#x} WS connect gen={}", session.ws_generation);
        session.ws_generation
    }

    pub fn ws_disconnect(&self, device_id: u32, session_token: &str, generation: u64) {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let Some(session) = sessions.get_mut(session_token) else {
            return;
        };
        if !session.active || session.device_id != device_id {
            return;
        }
        if session.ws_generation == generation {
            session.mode = MODE_NM.to_string();
            log::info!("[device_mgr] {device_id:#x} WS disconnect gen={generation} → nm");
        } else {
            log::info!(
                "[device_mgr] {device_id:#x} WS disconnect gen={generation} stale (current={}), keeping ws",
                session.ws_generation
            );
        }
    }

    /// Marks the session's data plane as WT. Returns the per-session
    /// generation, or 0 when the session is not active.
    pub fn wt_connect(&self, device_id: u32, session_token: &str) -> u64 {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let Some(session) = sessions.get_mut(session_token) else {
            return 0;
        };
        if !session.active || session.device_id != device_id {
            return 0;
        }
        session.wt_generation += 1;
        session.mode = MODE_WT.to_string();
        log::info!("[device_mgr] {device_id:#x} WT connect gen={}", session.wt_generation);
        session.wt_generation
    }

    pub fn wt_disconnect(&self, device_id: u32, session_token: &str, generation: u64) {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let Some(session) = sessions.get_mut(session_token) else {
            return;
        };
        if !session.active || session.device_id != device_id {
            return;
        }
        if session.wt_generation == generation {
            session.mode = MODE_NM.to_string();
            log::info!("[device_mgr] {device_id:#x} WT disconnect gen={generation} → nm");
        } else {
            log::info!(
                "[device_mgr] {device_id:#x} WT disconnect gen={generation} stale (current={}), keeping wt",
                session.wt_generation
            );
        }
    }

    /// Whether `client_id` holds an active NM-mode session on `device_id`.
    /// Used by NM clients to decide whether to relay input reports.
    pub fn has_nm_session_for_client(&self, device_id: u32, client_id: u64) -> bool {
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions.values().any(|s| {
            s.device_id == device_id
                && s.owner_client_id == client_id
                && s.active
                && s.mode == MODE_NM
        })
    }

    /// Tears down a device regardless of sessions (hotplug removal). Every
    /// session on the device and every WS/WT auth hash die with it.
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
        let tokens: Vec<String> = {
            let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            sessions
                .values()
                .filter(|s| s.device_id == device_id)
                .map(|s| s.token.clone())
                .collect()
        };
        {
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            for t in &tokens {
                sessions.remove(t);
            }
        }
        {
            let mut hashes = self.ws_auth_hashes.lock().unwrap_or_else(|e| e.into_inner());
            hashes.retain(|_, token| !tokens.contains(token));
        }
        log::info!("[device_mgr] {device_id:#x} force-closed (hotplug removal)");
    }

    pub fn report_send_allowed(
        &self,
        device_id: u32,
        report_id: u8,
        report_type: ReportType,
        payload_len: Option<usize>,
    ) -> Result<(), SendReject> {
        let map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        let Some(entry) = map.get(&device_id) else {
            return Err(SendReject::Invalid);
        };
        if entry.blocking.is_report_protected(
            entry.vendor_id,
            entry.product_id,
            report_id,
            report_type,
        ) {
            return Err(SendReject::Blocked);
        }
        if !entry
            .blocking
            .validate_report_send(report_id, report_type, payload_len)
        {
            return Err(SendReject::Invalid);
        }
        Ok(())
    }

    /// Resolves a WS/WT auth hash to an active session's `(device_id,
    /// token)`. Closed sessions' hashes are removed atomically with the
    /// close, so a stale hash never resolves.
    pub fn get_device_by_ws_auth(&self, hash: &str) -> Option<(u32, String)> {
        let token = self
            .ws_auth_hashes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(hash)?
            .clone();
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let session = sessions.get(&token)?;
        if !session.active {
            return None;
        }
        Some((session.device_id, session.token.clone()))
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
        assert!(!mgr.has_nm_session_for_client(0xDEADBEEF, 1));
        assert!(!mgr.has_nm_session_for_client(0x1234, 1));
    }

    #[test]
    fn test_close_all_for_client_no_devices() {
        let (tx, _) = broadcast::channel(16);
        let mgr = DeviceManager::new(tx);
        mgr.close_all_for_client(1);
    }

    #[test]
    fn test_close_unknown_session_is_idempotent() {
        let (tx, _) = broadcast::channel(16);
        let mgr = DeviceManager::new(tx);
        assert!(mgr.close(0xdeadbeef, "no-such-token", 1).is_ok());
    }

    #[test]
    fn test_close_owner_mismatch_rejected() {
        let (tx, _) = broadcast::channel(16);
        let mgr = DeviceManager::new(tx);
        mgr.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                "tok".to_string(),
                Session {
                    token: "tok".to_string(),
                    device_id: 0x1234,
                    owner_client_id: 1,
                    mode: MODE_NM.to_string(),
                    ws_auth_hash: "a".repeat(64),
                    active: true,
                    ws_generation: 0,
                    wt_generation: 0,
                },
            );
        let err = mgr.close(0x1234, "tok", 2).unwrap_err();
        assert!(err.to_string().contains("owned by another"));
        // Session survives a rejected close.
        assert!(mgr.sessions.lock().unwrap_or_else(|e| e.into_inner()).contains_key("tok"));
    }

    #[test]
    fn test_close_device_mismatch_rejected() {
        let (tx, _) = broadcast::channel(16);
        let mgr = DeviceManager::new(tx);
        mgr.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                "tok".to_string(),
                Session {
                    token: "tok".to_string(),
                    device_id: 0x1234,
                    owner_client_id: 1,
                    mode: MODE_NM.to_string(),
                    ws_auth_hash: "a".repeat(64),
                    active: true,
                    ws_generation: 0,
                    wt_generation: 0,
                },
            );
        let err = mgr.close(0x5678, "tok", 1).unwrap_err();
        assert!(err.to_string().contains("does not match device"));
    }

    #[test]
    fn test_close_removes_hash_with_session() {
        let (tx, _) = broadcast::channel(16);
        let mgr = DeviceManager::new(tx);
        mgr.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                "tok".to_string(),
                Session {
                    token: "tok".to_string(),
                    device_id: 0x1234,
                    owner_client_id: 1,
                    mode: MODE_NM.to_string(),
                    ws_auth_hash: "a".repeat(64),
                    active: true,
                    ws_generation: 0,
                    wt_generation: 0,
                },
            );
        mgr.ws_auth_hashes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert("a".repeat(64), "tok".to_string());
        assert!(mgr.close(0x1234, "tok", 1).is_ok());
        assert!(mgr.sessions.lock().unwrap_or_else(|e| e.into_inner()).is_empty());
        assert!(
            mgr.ws_auth_hashes
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty()
        );
    }

    #[test]
    fn test_set_dataplane_mode_validation() {
        let (tx, _) = broadcast::channel(16);
        let mgr = DeviceManager::new(tx);
        mgr.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                "tok".to_string(),
                Session {
                    token: "tok".to_string(),
                    device_id: 0x1234,
                    owner_client_id: 1,
                    mode: MODE_NM.to_string(),
                    ws_auth_hash: "a".repeat(64),
                    active: true,
                    ws_generation: 0,
                    wt_generation: 0,
                },
            );
        // Unknown mode rejected.
        assert!(mgr.set_dataplane_mode(0x1234, "tok", "quic", 1).is_err());
        // Unknown token rejected.
        assert!(mgr.set_dataplane_mode(0x1234, "nope", "ws", 1).is_err());
        // Wrong owner rejected.
        assert!(mgr.set_dataplane_mode(0x1234, "tok", "ws", 2).is_err());
        // Valid transition applies.
        assert!(mgr.set_dataplane_mode(0x1234, "tok", "wt", 1).is_ok());
        let sessions = mgr.sessions.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(sessions.get("tok").unwrap().mode, MODE_WT);
    }

    #[test]
    fn test_ws_connect_requires_active_session() {
        let (tx, _) = broadcast::channel(16);
        let mgr = DeviceManager::new(tx);
        // No session at all.
        assert_eq!(mgr.ws_connect(0x1234, "missing"), 0);
        mgr.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                "tok".to_string(),
                Session {
                    token: "tok".to_string(),
                    device_id: 0x1234,
                    owner_client_id: 1,
                    mode: MODE_NM.to_string(),
                    ws_auth_hash: "a".repeat(64),
                    active: false, // closed session must not reconnect
                    ws_generation: 0,
                    wt_generation: 0,
                },
            );
        assert_eq!(mgr.ws_connect(0x1234, "tok"), 0);
        // Wrong device also rejected.
        assert_eq!(mgr.ws_connect(0x5678, "tok"), 0);
    }

    #[test]
    fn test_get_device_by_ws_auth_roundtrip() {
        let (tx, _) = broadcast::channel(16);
        let mgr = DeviceManager::new(tx);
        let hash = "a".repeat(64);
        mgr.ws_auth_hashes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(hash.clone(), "tok".to_string());
        mgr.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                "tok".to_string(),
                Session {
                    token: "tok".to_string(),
                    device_id: 0x1234,
                    owner_client_id: 1,
                    mode: MODE_NM.to_string(),
                    ws_auth_hash: hash.clone(),
                    active: true,
                    ws_generation: 0,
                    wt_generation: 0,
                },
            );
        assert_eq!(
            mgr.get_device_by_ws_auth(&hash),
            Some((0x1234, "tok".to_string()))
        );
        assert!(mgr.get_device_by_ws_auth("b".repeat(64).as_str()).is_none());
    }

    #[test]
    fn test_get_device_by_ws_auth_closed_session_is_stale() {
        let (tx, _) = broadcast::channel(16);
        let mgr = DeviceManager::new(tx);
        let hash = "a".repeat(64);
        mgr.ws_auth_hashes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(hash.clone(), "tok".to_string());
        mgr.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                "tok".to_string(),
                Session {
                    token: "tok".to_string(),
                    device_id: 0x1234,
                    owner_client_id: 1,
                    mode: MODE_NM.to_string(),
                    ws_auth_hash: hash.clone(),
                    active: false,
                    ws_generation: 0,
                    wt_generation: 0,
                },
            );
        assert!(mgr.get_device_by_ws_auth(&hash).is_none());
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
