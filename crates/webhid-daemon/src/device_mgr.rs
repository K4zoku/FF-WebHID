use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use bytes::Bytes;
use hidapi::HidDevice;
use sha2::{Digest, Sha256};

use tokio::sync::{broadcast, mpsc, oneshot, watch};

use anyhow::anyhow;
use webhid::{DeviceInfo, IpcResponse, NmMessage};

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
    /// Set to `true` when the session is closed or revoked. Every WS/WT
    /// transport derived from this session holds a `watch::Receiver` on it
    /// (see `TransportGrant`), so a closed session can never keep using the
    /// physical device through a stale data-plane connection. A watch
    /// channel (not a bare Notify) so a transport that subscribes after the
    /// close still observes the closed state.
    cancel: watch::Sender<bool>,
}

/// A WS/WT transport grant: the per-session transport generation plus the
/// session's cancellation signal. The transport must select on `cancel` and
/// verify `session_transport_active` before touching the device, so a closed
/// session can never keep operating through an established connection.
#[derive(Clone)]
pub struct TransportGrant {
    pub generation: u64,
    pub cancel: watch::Receiver<bool>,
}

struct OutputCommand {
    report_id: u8,
    data: Vec<u8>,
    reply: oneshot::Sender<std::io::Result<()>>,
    epoch: u64,
    valid: Arc<AtomicBool>,
}
#[derive(Clone)]
struct NmHotSession {
    output_tx: mpsc::Sender<OutputCommand>,
    epoch: Arc<AtomicU64>,
    valid: Arc<AtomicBool>,
    blocking: Arc<crate::report_blocking::DeviceReportBlocking>,
    vendor_id: u16,
    product_id: u16,
    sink: mpsc::Sender<NmMessage>,
}

struct Entry {
    device: DeviceHandle,
    stop_flag: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
    output_tx: Option<mpsc::Sender<OutputCommand>>,
    output_handle: Option<JoinHandle<()>>,
    io_epoch: Arc<AtomicU64>,
    vendor_id: u16,
    product_id: u16,
    /// Input/feature read buffer size derived from the descriptor's max
    /// report payload (+ report-id byte), capped by `hid::MAX_READ_BUFFER`.
    read_buf_size: usize,
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

type DeviceOpener = dyn Fn(u32) -> anyhow::Result<(DeviceInfo, bool, HidDevice)> + Send + Sync;
type NmSinkMap = Arc<Mutex<HashMap<u64, mpsc::Sender<NmMessage>>>>;
type NmHotMap = Arc<Mutex<HashMap<(u64, u32), NmHotSession>>>;

pub struct DeviceManager {
    devices: Arc<Mutex<HashMap<u32, Entry>>>,
    /// `session_token -> Session`. Sessions are the authority for device
    /// lifetime, data-plane mode, and WS/WT authentication.
    sessions: Arc<Mutex<HashMap<String, Session>>>,
    /// `ws_auth_hash -> session_token`. A hash dies with its session, never
    /// with the physical device.
    ws_auth_hashes: Arc<Mutex<HashMap<String, String>>>,
    /// `device_id -> Notify` for in-flight first opens. Exactly one opener
    /// performs the physical open per device; concurrent openers wait on the
    /// notify and register their session against the resulting entry.
    opening: Mutex<HashMap<u32, Arc<tokio::sync::Notify>>>,
    /// Physical HID opener. Injectable for tests that must control and
    /// observe the first-open path.
    opener: Arc<DeviceOpener>,
    ws_nonce: String,
    event_tx: broadcast::Sender<IpcResponse>,
    nm_sinks: NmSinkMap,
    non_nm_sessions: Arc<AtomicUsize>,
    nm_hot: NmHotMap,
    next_client_id: AtomicU64,
}

/// Parameters for a freshly opened device's background input reader.
struct ReaderConfig {
    dev_id: u32,
    dev_for_task: DeviceHandle,
    nm_hot: NmHotMap,
    non_nm_sessions: Arc<AtomicUsize>,
    stop_flag: Arc<AtomicBool>,
    uses_numbered_reports: bool,
    read_buf_size: usize,
    blocked_input_ids: Arc<HashSet<u8>>,
    declared_input_ids: Arc<HashSet<u8>>,
    always_protected_input: bool,
    interface_protected_input: bool,
    devices: Arc<Mutex<HashMap<u32, Entry>>>,
    sessions: Arc<Mutex<HashMap<String, Session>>>,
    ws_auth_hashes: Arc<Mutex<HashMap<String, String>>>,
    device_info: DeviceInfo,
}
fn spawn_output_writer(
    device: DeviceHandle,
    epoch: Arc<AtomicU64>,
    mut receiver: mpsc::Receiver<OutputCommand>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        while let Some(command) = receiver.blocking_recv() {
            if !command.valid.load(Ordering::SeqCst)
                || command.epoch != epoch.load(Ordering::SeqCst)
            {
                let _ = command.reply.send(Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "device session closed",
                )));
                continue;
            }
            let result = with_device(&device, |hid| {
                hid::write_report(hid, command.report_id, &command.data)
            });
            let _ = command.reply.send(result);
        }
    })
}

fn stop_entry(mut entry: Entry) {
    entry.stop_flag.store(true, Ordering::SeqCst);
    entry.io_epoch.fetch_add(1, Ordering::SeqCst);
    drop(entry.output_tx.take());
    if let Some(handle) = entry.handle.take() {
        let _ = handle.join();
    }
    if let Some(handle) = entry.output_handle.take() {
        let _ = handle.join();
    }
}

fn stop_entry_output_worker(mut entry: Entry) {
    entry.stop_flag.store(true, Ordering::SeqCst);
    entry.io_epoch.fetch_add(1, Ordering::SeqCst);
    drop(entry.output_tx.take());
    if let Some(handle) = entry.output_handle.take() {
        let _ = handle.join();
    }
}

fn route_nm_input(sinks: &NmHotMap, device_id: u32, report_id: u8, data: &Bytes) {
    let targets: Vec<mpsc::Sender<NmMessage>> = sinks
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .filter(|((_, target_device_id), _)| *target_device_id == device_id)
        .map(|(_, hot)| hot.sink.clone())
        .collect();
    for target in targets {
        let message = NmMessage::packed_input_report(device_id, [(report_id, &data[..])]);
        let _ = target.blocking_send(message);
    }
}

impl DeviceManager {
    pub fn new(event_tx: broadcast::Sender<IpcResponse>) -> Self {
        Self::new_with_opener(event_tx, hid::open_by_device_id)
    }

    fn new_with_opener(
        event_tx: broadcast::Sender<IpcResponse>,
        opener: impl Fn(u32) -> anyhow::Result<(DeviceInfo, bool, HidDevice)> + Send + Sync + 'static,
    ) -> Self {
        let ws_nonce = random_hex_token(16).expect("getrandom should not fail on modern kernels");
        Self {
            devices: Mutex::new(HashMap::new()).into(),
            sessions: Mutex::new(HashMap::new()).into(),
            ws_auth_hashes: Mutex::new(HashMap::new()).into(),
            opening: Mutex::new(HashMap::new()),
            opener: Arc::new(opener),
            ws_nonce,
            event_tx,
            non_nm_sessions: Arc::new(AtomicUsize::new(0)),
            nm_sinks: Mutex::new(HashMap::new()).into(),
            nm_hot: Mutex::new(HashMap::new()).into(),
            next_client_id: AtomicU64::new(0),
        }
    }

    /// Allocates a fresh IPC client id. Sessions record the client that
    /// opened them so a disconnect only tears down that client's sessions.
    pub fn new_client_id(&self) -> u64 {
        self.next_client_id.fetch_add(1, Ordering::SeqCst) + 1
    }
    pub fn register_nm_sink(&self, client_id: u64, sender: mpsc::Sender<NmMessage>) {
        self.nm_sinks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(client_id, sender);
        let device_ids: HashSet<u32> = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|session| session.owner_client_id == client_id && session.active)
            .map(|session| session.device_id)
            .collect();
        for device_id in device_ids {
            self.refresh_nm_hot(device_id, client_id);
        }
    }

    pub fn unregister_nm_sink(&self, client_id: u64) {
        self.nm_sinks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&client_id);
        self.nm_hot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|(owner, _), hot| {
                if *owner == client_id {
                    hot.valid.store(false, Ordering::SeqCst);
                    false
                } else {
                    true
                }
            });
    }
    fn update_non_nm_count(&self, was_non_nm: bool, is_non_nm: bool) {
        match (was_non_nm, is_non_nm) {
            (false, true) => {
                self.non_nm_sessions.fetch_add(1, Ordering::SeqCst);
            }
            (true, false) => {
                self.non_nm_sessions.fetch_sub(1, Ordering::SeqCst);
            }
            _ => {}
        }
    }

    fn refresh_nm_hot(&self, device_id: u32, client_id: u64) {
        let active = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .any(|session| {
                session.device_id == device_id
                    && session.owner_client_id == client_id
                    && session.active
                    && session.mode == MODE_NM
            });
        let sink = self
            .nm_sinks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&client_id)
            .cloned();
        let hot = if active {
            let devices = self.devices.lock().unwrap_or_else(|e| e.into_inner());
            devices.get(&device_id).and_then(|entry| {
                Some(NmHotSession {
                    output_tx: entry.output_tx.as_ref()?.clone(),
                    epoch: Arc::clone(&entry.io_epoch),
                    valid: Arc::new(AtomicBool::new(true)),
                    blocking: Arc::clone(&entry.blocking),
                    vendor_id: entry.vendor_id,
                    product_id: entry.product_id,
                    sink: sink?,
                })
            })
        } else {
            None
        };
        let mut nm_hot = self.nm_hot.lock().unwrap_or_else(|e| e.into_inner());
        let key = (client_id, device_id);
        if let Some(old) = nm_hot.remove(&key) {
            old.valid.store(false, Ordering::SeqCst);
        }
        if let Some(hot) = hot {
            nm_hot.insert(key, hot);
        }
    }

    pub fn nm_report_send_allowed(
        &self,
        client_id: u64,
        device_id: u32,
        report_id: u8,
        report_type: ReportType,
        payload_len: Option<usize>,
    ) -> Result<(), SendReject> {
        let hot = self
            .nm_hot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&(client_id, device_id))
            .cloned()
            .ok_or(SendReject::Invalid)?;
        if hot
            .blocking
            .is_report_protected(hot.vendor_id, hot.product_id, report_id, report_type)
        {
            return Err(SendReject::Blocked);
        }
        if !hot
            .blocking
            .validate_report_send(report_id, report_type, payload_len)
        {
            return Err(SendReject::Invalid);
        }
        Ok(())
    }

    pub async fn enqueue_nm_output(
        &self,
        client_id: u64,
        device_id: u32,
        report_id: u8,
        data: Vec<u8>,
    ) -> std::io::Result<()> {
        let hot = self
            .nm_hot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&(client_id, device_id))
            .cloned()
            .ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::PermissionDenied, "NM session inactive")
            })?;
        let (reply, result) = oneshot::channel();
        hot.output_tx
            .send(OutputCommand {
                report_id,
                data,
                reply,
                epoch: hot.epoch.load(Ordering::SeqCst),
                valid: Arc::clone(&hot.valid),
            })
            .await
            .map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::BrokenPipe, "output worker stopped")
            })?;
        result.await.map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::BrokenPipe, "output worker stopped")
        })?
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

    pub async fn open(
        &self,
        device_id: u32,
        owner_client_id: u64,
    ) -> anyhow::Result<(u32, String)> {
        let session_token = random_hex_token(16)?;
        let ws_auth_hash = compute_ws_auth_hash(&session_token, &self.ws_nonce);

        if self.register_session(device_id, &session_token, owner_client_id, &ws_auth_hash) {
            self.refresh_nm_hot(device_id, owner_client_id);
            return Ok((device_id, session_token));
        }

        let mut is_opener = false;
        loop {
            let wait = {
                let mut opening = self.opening.lock().unwrap_or_else(|e| e.into_inner());
                match opening.get(&device_id) {
                    Some(n) => Some(Arc::clone(n).notified_owned()),
                    None => {
                        let n = Arc::new(tokio::sync::Notify::new());
                        opening.insert(device_id, Arc::clone(&n));
                        is_opener = true;
                        None
                    }
                }
            };
            if is_opener {
                break;
            }
            let wait = wait.expect("waiter must hold a notification future");
            wait.await;
            if self.register_session(device_id, &session_token, owner_client_id, &ws_auth_hash) {
                self.refresh_nm_hot(device_id, owner_client_id);
                return Ok((device_id, session_token));
            }
            let opening_in_progress = self
                .opening
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .contains_key(&device_id);
            if !opening_in_progress {
                return Err(anyhow!(
                    "device '{device_id:#x}' could not be opened by the concurrent opener"
                ));
            }
        }

        let result = self
            .open_physical(device_id, &session_token, owner_client_id, &ws_auth_hash)
            .await;
        let notify = self
            .opening
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&device_id)
            .expect("opener sentinel must be present");
        notify.notify_waiters();
        result
    }

    /// Opens the physical HID device and spawns its reader. Only the first
    /// opener for a device runs this; concurrent openers await the notify.
    async fn open_physical(
        &self,
        device_id: u32,
        session_token: &str,
        owner_client_id: u64,
        ws_auth_hash: &str,
    ) -> anyhow::Result<(u32, String)> {
        let (info, uses_numbered_reports, device) = tokio::task::spawn_blocking({
            let opener = Arc::clone(&self.opener);
            move || (opener)(device_id)
        })
        .await
        .map_err(|e| anyhow!("open task join failed: {e}"))??;
        let id = info.device_id;

        if info.descriptor_parse_failed {
            return Err(anyhow!(
                "device '{device_id:#x}' has no parsed report descriptor; refusing to open (fail closed)"
            ));
        }

        let blocking = Arc::new(DeviceReportBlocking::new(&info, uses_numbered_reports));
        let blocked_input_ids =
            Arc::new(blocking.blocked_input_ids(info.vendor_id, info.product_id));
        let declared_input_ids = Arc::new(blocking.declared_input_ids());
        let max_payload = crate::descriptor::max_input_report_size(&info.collections)
            .max(crate::descriptor::max_output_report_size(&info.collections))
            .max(crate::descriptor::max_feature_report_size(
                &info.collections,
            ));
        let read_buf_size = (max_payload as usize + 1).clamp(64, crate::hid::MAX_READ_BUFFER);

        let stop_flag = Arc::new(AtomicBool::new(false));
        let io_epoch = Arc::new(AtomicU64::new(0));
        let (output_tx, output_rx) = mpsc::channel(128);

        #[cfg(target_os = "linux")]
        let device_arc: DeviceHandle = Arc::new(device);
        #[cfg(not(target_os = "linux"))]
        let device_arc: DeviceHandle = Arc::new(Mutex::new(device));
        let dev_for_task = Arc::clone(&device_arc);

        if self.register_session(id, session_token, owner_client_id, ws_auth_hash) {
            self.refresh_nm_hot(id, owner_client_id);
            return Ok((id, session_token.to_string()));
        }

        let entry = Entry {
            device: Arc::clone(&device_arc),
            stop_flag: Arc::clone(&stop_flag),
            handle: None,
            output_tx: Some(output_tx),
            output_handle: None,
            io_epoch: Arc::clone(&io_epoch),
            vendor_id: info.vendor_id,
            product_id: info.product_id,
            read_buf_size,
            blocking: Arc::clone(&blocking),
        };

        let mut map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        map.insert(id, entry);
        drop(map);
        self.register_session(id, session_token, owner_client_id, ws_auth_hash);
        self.refresh_nm_hot(id, owner_client_id);

        let handle = self.spawn_reader(ReaderConfig {
            dev_id: id,
            dev_for_task,
            stop_flag,
            uses_numbered_reports,
            read_buf_size,
            blocked_input_ids,
            declared_input_ids,
            always_protected_input: blocking.always_protected[0],
            interface_protected_input: blocking.interface_protected[0],
            devices: Arc::clone(&self.devices),
            nm_hot: Arc::clone(&self.nm_hot),
            non_nm_sessions: Arc::clone(&self.non_nm_sessions),
            sessions: Arc::clone(&self.sessions),
            ws_auth_hashes: Arc::clone(&self.ws_auth_hashes),
            device_info: info.clone(),
        });
        let output_handle = spawn_output_writer(device_arc, io_epoch, output_rx);
        if let Some(e) = self
            .devices
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_mut(&id)
        {
            e.handle = Some(handle);
            e.output_handle = Some(output_handle);
        }

        Ok((id, session_token.to_string()))
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
                    cancel: watch::channel(false).0,
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
            read_buf_size,
            blocked_input_ids,
            declared_input_ids,
            always_protected_input,
            interface_protected_input,
            devices: devices_for_task,
            nm_hot,
            non_nm_sessions,
            sessions: sessions_for_task,
            ws_auth_hashes: hashes_for_task,
            device_info: info_for_task,
        } = cfg;
        let blocked_for_task = Arc::clone(&blocked_input_ids);
        let declared_for_task = Arc::clone(&declared_input_ids);
        let tx = self.event_tx.clone();
        thread::spawn(move || {
            let cleanup_dead_reader = || {
                let removed = devices_for_task
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&dev_id);
                if let Some(entry) = removed {
                    stop_entry_output_worker(entry);
                    nm_hot.lock().unwrap_or_else(|e| e.into_inner()).retain(
                        |(_, hot_device_id), hot| {
                            if *hot_device_id == dev_id {
                                hot.valid.store(false, Ordering::SeqCst);
                                false
                            } else {
                                true
                            }
                        },
                    );
                    let (tokens, cancels, non_nm_count) = {
                        let sessions = sessions_for_task.lock().unwrap_or_else(|e| e.into_inner());
                        let mut tokens = Vec::new();
                        let mut cancels = Vec::new();
                        let mut non_nm_count = 0;
                        for session in sessions.values().filter(|s| s.device_id == dev_id) {
                            if session.mode != MODE_NM {
                                non_nm_count += 1;
                            }
                            tokens.push(session.token.clone());
                            cancels.push(session.cancel.clone());
                        }
                        (tokens, cancels, non_nm_count)
                    };
                    {
                        let mut sessions =
                            sessions_for_task.lock().unwrap_or_else(|e| e.into_inner());
                        for t in &tokens {
                            sessions.remove(t);
                        }
                    }
                    if non_nm_count > 0 {
                        non_nm_sessions.fetch_sub(non_nm_count, Ordering::SeqCst);
                    }
                    {
                        let mut hashes = hashes_for_task.lock().unwrap_or_else(|e| e.into_inner());
                        hashes.retain(|_, token| !tokens.contains(token));
                    }
                    for cancel in cancels {
                        let _ = cancel.send(true);
                    }
                    let _ = tx.send(IpcResponse::DeviceDisconnected {
                        device: info_for_task.clone(),
                    });
                }
            };
            loop {
                if stop_flag.load(Ordering::SeqCst) {
                    break;
                }
                let read_result = with_device(&dev_for_task, |d| {
                    hid::read_with_timeout(d, 500, read_buf_size)
                });
                match read_result {
                    Ok(buf) => {
                        let (report_id, data): (u8, Bytes) = if uses_numbered_reports {
                            if !buf.is_empty() {
                                let b = Bytes::from(buf);
                                (b[0], b.slice(1..))
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
                        route_nm_input(&nm_hot, dev_id, report_id, &data);
                        if non_nm_sessions.load(Ordering::SeqCst) > 0 {
                            let _ = tx.send(IpcResponse::InputReport {
                                device_id: dev_id,
                                report_id,
                                data,
                            });
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                    Err(e) => {
                        log::warn!("[reader {dev_id:#x}] read error: {e}; stopping");
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
    pub fn close(
        &self,
        device_id: u32,
        session_token: &str,
        owner_client_id: u64,
    ) -> anyhow::Result<()> {
        let (hash, cancel_tx, last_session, was_non_nm) = {
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
            let was_non_nm = session.mode != MODE_NM;
            let hash = session.ws_auth_hash.clone();
            let cancel_tx = session.cancel.clone();
            sessions.remove(session_token);
            let last_session = !sessions
                .values()
                .any(|s| s.device_id == device_id && s.active);
            (hash, cancel_tx, last_session, was_non_nm)
        };
        self.ws_auth_hashes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&hash);
        let _ = cancel_tx.send(true);
        self.update_non_nm_count(was_non_nm, false);
        self.refresh_nm_hot(device_id, owner_client_id);
        if last_session {
            let entry = self
                .devices
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&device_id);
            if let Some(entry) = entry {
                stop_entry(entry);
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

    /// Descriptor-derived read buffer size for the device (report payload +
    /// report-id byte, floored and capped). Used for feature-report reads.
    pub fn read_buf_size(&self, device_id: u32) -> usize {
        let map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        map.get(&device_id)
            .map(|e| e.read_buf_size)
            .unwrap_or(crate::hid::MAX_READ_BUFFER)
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
        let was_non_nm = session.mode != MODE_NM;
        session.mode = mode.to_string();
        drop(sessions);
        self.update_non_nm_count(was_non_nm, mode != MODE_NM);
        self.refresh_nm_hot(device_id, owner_client_id);
        log::info!("[device_mgr] {device_id:#x} session dataplane mode → {mode}");
        Ok(())
    }

    /// Marks the session's data plane as WS. Returns the per-session
    /// generation and the session's cancellation signal, or None when the
    /// session is not active (the caller must treat None as "not connected").
    pub fn ws_connect(&self, device_id: u32, session_token: &str) -> Option<TransportGrant> {
        let (grant, owner_client_id, was_non_nm) = {
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            let session = sessions.get_mut(session_token)?;
            if !session.active || session.device_id != device_id {
                return None;
            }
            let was_non_nm = session.mode != MODE_NM;
            session.ws_generation += 1;
            session.mode = MODE_WS.to_string();
            (
                TransportGrant {
                    generation: session.ws_generation,
                    cancel: session.cancel.subscribe(),
                },
                session.owner_client_id,
                was_non_nm,
            )
        };
        self.update_non_nm_count(was_non_nm, true);
        self.refresh_nm_hot(device_id, owner_client_id);
        log::info!(
            "[device_mgr] {device_id:#x} WS connect gen={}",
            grant.generation
        );
        Some(grant)
    }

    /// Marks the session's data plane as WT. Returns the per-session
    /// generation and the session's cancellation signal, or None when the
    /// session is not active.
    pub fn wt_connect(&self, device_id: u32, session_token: &str) -> Option<TransportGrant> {
        let (grant, owner_client_id, was_non_nm) = {
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            let session = sessions.get_mut(session_token)?;
            if !session.active || session.device_id != device_id {
                return None;
            }
            let was_non_nm = session.mode != MODE_NM;
            session.wt_generation += 1;
            session.mode = MODE_WT.to_string();
            (
                TransportGrant {
                    generation: session.wt_generation,
                    cancel: session.cancel.subscribe(),
                },
                session.owner_client_id,
                was_non_nm,
            )
        };
        self.update_non_nm_count(was_non_nm, true);
        self.refresh_nm_hot(device_id, owner_client_id);
        log::info!(
            "[device_mgr] {device_id:#x} WT connect gen={}",
            grant.generation
        );
        Some(grant)
    }

    /// Whether the transport identified by `(session_token, kind,
    /// generation)` still belongs to an active session on `device_id`. An
    /// established WS/WT connection must verify this before performing any
    /// inbound HID operation and before delivering any outbound report, so
    /// a closed session can never keep driving the physical device.
    pub fn session_transport_active(
        &self,
        device_id: u32,
        session_token: &str,
        kind: &str,
        generation: u64,
    ) -> bool {
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let Some(session) = sessions.get(session_token) else {
            return false;
        };
        if !session.active || session.device_id != device_id {
            return false;
        }
        match kind {
            MODE_WS => session.ws_generation == generation,
            MODE_WT => session.wt_generation == generation,
            _ => false,
        }
    }

    pub fn ws_disconnect(&self, device_id: u32, session_token: &str, generation: u64) {
        let (owner_client_id, current_generation, was_non_nm) = {
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            let session = match sessions.get_mut(session_token) {
                Some(session) if session.active && session.device_id == device_id => session,
                _ => return,
            };
            let owner_client_id = session.owner_client_id;
            let current_generation = session.ws_generation;
            let was_non_nm = session.mode != MODE_NM;
            if current_generation == generation {
                session.mode = MODE_NM.to_string();
            }
            (owner_client_id, current_generation, was_non_nm)
        };
        if current_generation == generation {
            self.update_non_nm_count(was_non_nm, false);
            self.refresh_nm_hot(device_id, owner_client_id);
            log::info!("[device_mgr] {device_id:#x} WS disconnect gen={generation} → nm");
        } else {
            log::info!(
                "[device_mgr] {device_id:#x} WS disconnect gen={generation} stale (current={current_generation}), keeping ws"
            );
        }
    }

    pub fn wt_disconnect(&self, device_id: u32, session_token: &str, generation: u64) {
        let (owner_client_id, current_generation, was_non_nm) = {
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            let session = match sessions.get_mut(session_token) {
                Some(session) if session.active && session.device_id == device_id => session,
                _ => return,
            };
            let owner_client_id = session.owner_client_id;
            let current_generation = session.wt_generation;
            let was_non_nm = session.mode != MODE_NM;
            if current_generation == generation {
                session.mode = MODE_NM.to_string();
            }
            (owner_client_id, current_generation, was_non_nm)
        };
        if current_generation == generation {
            self.update_non_nm_count(was_non_nm, false);
            self.refresh_nm_hot(device_id, owner_client_id);
            log::info!("[device_mgr] {device_id:#x} WT disconnect gen={generation} → nm");
        } else {
            log::info!(
                "[device_mgr] {device_id:#x} WT disconnect gen={generation} stale (current={current_generation}), keeping wt"
            );
        }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn has_nm_session_for_client(&self, device_id: u32, client_id: u64) -> bool {
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions.values().any(|session| {
            session.device_id == device_id
                && session.owner_client_id == client_id
                && session.active
                && session.mode == MODE_NM
        })
    }

    /// Tears down a device regardless of sessions (hotplug removal). Every
    /// session on the device and every WS/WT auth hash die with it.
    pub fn force_close(&self, device_id: u32) {
        let entry = self
            .devices
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&device_id);
        let Some(entry) = entry else {
            return;
        };
        stop_entry(entry);
        self.nm_hot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|(_, hot_device_id), hot| {
                if *hot_device_id == device_id {
                    hot.valid.store(false, Ordering::SeqCst);
                    false
                } else {
                    true
                }
            });
        let (tokens, cancels, non_nm_count) = {
            let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            let mut tokens = Vec::new();
            let mut cancels = Vec::new();
            let mut non_nm_count = 0;
            for session in sessions.values().filter(|s| s.device_id == device_id) {
                if session.mode != MODE_NM {
                    non_nm_count += 1;
                }
                tokens.push(session.token.clone());
                cancels.push(session.cancel.clone());
            }
            (tokens, cancels, non_nm_count)
        };
        {
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            for t in &tokens {
                sessions.remove(t);
            }
        }
        {
            let mut hashes = self
                .ws_auth_hashes
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            hashes.retain(|_, token| !tokens.contains(token));
        }
        if non_nm_count > 0 {
            self.non_nm_sessions
                .fetch_sub(non_nm_count, Ordering::SeqCst);
        }
        for cancel in cancels {
            let _ = cancel.send(true);
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
    use std::time::Duration;
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
    fn test_route_nm_input_uses_bound_sinks() {
        let (tx, _) = broadcast::channel(16);
        let mgr = DeviceManager::new(tx);
        let (nm_tx, mut nm_rx) = mpsc::channel(1);
        let (other_tx, mut other_rx) = mpsc::channel(1);
        let info = DeviceInfo {
            vendor_id: 1,
            product_id: 1,
            product_name: "test".to_string(),
            manufacturer: None,
            serial_number: None,
            usage_page: None,
            usage: None,
            device_id: 7,
            descriptor_parse_failed: false,
            collections: Vec::new(),
            max_input_report_size: 64,
            raw_descriptor: Vec::new(),
        };
        let blocking = Arc::new(DeviceReportBlocking::new(&info, true));
        let (output_tx, _output_rx) = mpsc::channel(1);
        let (other_output_tx, _other_output_rx) = mpsc::channel(1);
        let epoch = Arc::new(AtomicU64::new(0));
        mgr.nm_hot.lock().unwrap().extend([
            (
                (1, 7),
                NmHotSession {
                    output_tx,
                    epoch: Arc::clone(&epoch),
                    blocking: Arc::clone(&blocking),
                    valid: Arc::new(AtomicBool::new(true)),
                    vendor_id: 1,
                    product_id: 1,
                    sink: nm_tx,
                },
            ),
            (
                (2, 8),
                NmHotSession {
                    output_tx: other_output_tx,
                    epoch,
                    blocking,
                    valid: Arc::new(AtomicBool::new(true)),
                    vendor_id: 1,
                    product_id: 1,
                    sink: other_tx,
                },
            ),
        ]);
        route_nm_input(&mgr.nm_hot, 7, 1, &Bytes::from_static(&[1, 2, 3]));
        assert!(matches!(nm_rx.try_recv(), Ok(NmMessage::PackedData(_))));
        assert!(matches!(
            other_rx.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
    }

    #[test]
    fn test_close_all_for_client_no_devices() {
        let (tx, _) = broadcast::channel(16);
        let mgr = DeviceManager::new(tx);
        mgr.close_all_for_client(1);
    }

    #[tokio::test]
    async fn test_concurrent_first_open_serialized() {
        use std::sync::atomic::AtomicU32;
        use tokio::sync::oneshot;
        let (tx, _) = broadcast::channel(16);
        let (entered_tx, entered_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let entered_tx = Arc::new(std::sync::Mutex::new(Some(entered_tx)));
        let release_rx = Arc::new(std::sync::Mutex::new(Some(release_rx)));
        let calls = Arc::new(AtomicU32::new(0));
        let calls_for_opener = Arc::clone(&calls);
        let entered_for_opener = Arc::clone(&entered_tx);
        let release_for_opener = Arc::clone(&release_rx);
        let opener = move |id: u32| {
            calls_for_opener.fetch_add(1, Ordering::SeqCst);
            if let Some(tx) = entered_for_opener.lock().unwrap().take() {
                let _ = tx.send(());
            }
            if let Some(rx) = release_for_opener.lock().unwrap().take() {
                let _ = rx.blocking_recv();
            }
            Err(anyhow!("device '{id:#x}' not found (test opener)"))
        };
        let mgr = Arc::new(DeviceManager::new_with_opener(tx, opener));

        let mgr_a = Arc::clone(&mgr);
        let task_a = tokio::spawn(async move { mgr_a.open(0x1234, 1).await });
        entered_rx.await.unwrap();

        let mut tasks = Vec::new();
        for client in 2..=4u64 {
            let mgr_b = Arc::clone(&mgr);
            tasks.push(tokio::spawn(
                async move { mgr_b.open(0x1234, client).await },
            ));
        }
        tokio::task::yield_now().await;

        release_tx.send(()).unwrap();
        let res_a = task_a.await.unwrap();
        assert!(res_a.is_err());
        for task in tasks {
            assert!(task.await.unwrap().is_err());
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(
            mgr.opening
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty()
        );
        assert!(
            mgr.sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty()
        );
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
                    cancel: watch::channel(false).0,
                },
            );
        let err = mgr.close(0x1234, "tok", 2).unwrap_err();
        assert!(err.to_string().contains("owned by another"));
        assert!(
            mgr.sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .contains_key("tok")
        );
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
                    cancel: watch::channel(false).0,
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
                    cancel: watch::channel(false).0,
                },
            );
        mgr.ws_auth_hashes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert("a".repeat(64), "tok".to_string());
        assert!(mgr.close(0x1234, "tok", 1).is_ok());
        assert!(
            mgr.sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty()
        );
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
                    cancel: watch::channel(false).0,
                },
            );
        assert!(mgr.set_dataplane_mode(0x1234, "tok", "quic", 1).is_err());
        assert!(mgr.set_dataplane_mode(0x1234, "nope", "ws", 1).is_err());
        assert!(mgr.set_dataplane_mode(0x1234, "tok", "ws", 2).is_err());
        assert!(mgr.set_dataplane_mode(0x1234, "tok", "wt", 1).is_ok());
        let sessions = mgr.sessions.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(sessions.get("tok").unwrap().mode, MODE_WT);
    }

    #[test]
    fn test_ws_connect_requires_active_session() {
        let (tx, _) = broadcast::channel(16);
        let mgr = DeviceManager::new(tx);
        assert!(mgr.ws_connect(0x1234, "missing").is_none());
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
                    active: false,
                    ws_generation: 0,
                    wt_generation: 0,
                    cancel: watch::channel(false).0,
                },
            );
        assert!(mgr.ws_connect(0x1234, "tok").is_none());
        assert!(mgr.ws_connect(0x5678, "tok").is_none());
    }

    #[test]
    fn test_ws_connect_returns_generation_and_cancel() {
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
                    cancel: watch::channel(false).0,
                },
            );
        let g1 = mgr
            .ws_connect(0x1234, "tok")
            .expect("active session connects");
        assert_eq!(g1.generation, 1);
        let g2 = mgr
            .ws_connect(0x1234, "tok")
            .expect("reconnect bumps generation");
        assert_eq!(g2.generation, 2);
        assert!(!*g1.cancel.borrow());
        assert!(!*g2.cancel.borrow());
    }

    #[tokio::test]
    async fn test_session_transport_active_tracks_close() {
        let (tx, _) = broadcast::channel(16);
        let mgr = DeviceManager::new(tx);
        for (tok, owner) in [("tokA", 1u64), ("tokB", 2u64)] {
            mgr.sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(
                    tok.to_string(),
                    Session {
                        token: tok.to_string(),
                        device_id: 0x1234,
                        owner_client_id: owner,
                        mode: MODE_NM.to_string(),
                        ws_auth_hash: "a".repeat(64),
                        active: true,
                        ws_generation: 0,
                        wt_generation: 0,
                        cancel: watch::channel(false).0,
                    },
                );
        }
        let grant_a = mgr.ws_connect(0x1234, "tokA").expect("A connects");
        let grant_b = mgr.ws_connect(0x1234, "tokB").expect("B connects");
        assert!(mgr.session_transport_active(0x1234, "tokA", MODE_WS, grant_a.generation));
        assert!(mgr.session_transport_active(0x1234, "tokB", MODE_WS, grant_b.generation));

        mgr.close(0x1234, "tokA", 1).expect("close A");
        assert!(!mgr.session_transport_active(0x1234, "tokA", MODE_WS, grant_a.generation));
        assert!(mgr.session_transport_active(0x1234, "tokB", MODE_WS, grant_b.generation));
        let mut cancel_a = grant_a.cancel.clone();
        tokio::time::timeout(Duration::from_secs(1), cancel_a.changed())
            .await
            .expect("A transport cancelled on session close")
            .expect("cancel channel still open");
        let grant_b2 = mgr.ws_connect(0x1234, "tokB").expect("B reconnects");
        assert_eq!(grant_b2.generation, grant_b.generation + 1);
        assert!(!mgr.session_transport_active(0x1234, "tokB", MODE_WS, grant_b.generation));
        assert!(mgr.session_transport_active(0x1234, "tokB", MODE_WS, grant_b2.generation));
    }

    #[tokio::test]
    async fn test_wt_transport_cancelled_by_close() {
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
                    cancel: watch::channel(false).0,
                },
            );
        let grant = mgr.wt_connect(0x1234, "tok").expect("WT connects");
        assert!(mgr.session_transport_active(0x1234, "tok", MODE_WT, grant.generation));
        mgr.close(0x1234, "tok", 1).expect("close");
        assert!(!mgr.session_transport_active(0x1234, "tok", MODE_WT, grant.generation));
        let mut cancel = grant.cancel.clone();
        tokio::time::timeout(Duration::from_secs(1), cancel.changed())
            .await
            .expect("WT transport cancelled on session close")
            .expect("cancel channel still open");
    }

    /// Audit regression (HIGH): a closed session's established transport
    /// must stop delivering input reports even while another session keeps
    /// the device open, and the surviving session keeps working.
    #[tokio::test]
    async fn test_sender_stops_delivery_after_session_close() {
        use bytes::Bytes as ReportBytes;
        use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
        let (tx, mut _keepalive_rx) = broadcast::channel(64);
        let mgr = Arc::new(DeviceManager::new(tx.clone()));
        for (tok, owner) in [("tokA", 1u64), ("tokB", 2u64)] {
            mgr.sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(
                    tok.to_string(),
                    Session {
                        token: tok.to_string(),
                        device_id: 0x1234,
                        owner_client_id: owner,
                        mode: MODE_NM.to_string(),
                        ws_auth_hash: "a".repeat(64),
                        active: true,
                        ws_generation: 0,
                        wt_generation: 0,
                        cancel: watch::channel(false).0,
                    },
                );
        }
        let grant_a = mgr.ws_connect(0x1234, "tokA").expect("A connects");
        let grant_b = mgr.ws_connect(0x1234, "tokB").expect("B connects");

        let flushed = Arc::new(AtomicUsize::new(0));
        let flushed_for_sender = Arc::clone(&flushed);
        let mgr_for_sender = Arc::clone(&mgr);
        let sender = tokio::spawn(crate::batching::run_sender(
            tx.subscribe(),
            0x1234,
            mgr_for_sender,
            "tokA".to_string(),
            grant_a.generation,
            MODE_WS,
            grant_a.cancel.clone(),
            move |_frame: Vec<u8>| {
                flushed_for_sender.fetch_add(1, AtomicOrdering::SeqCst);
                true
            },
        ));

        tx.send(webhid::IpcResponse::InputReport {
            device_id: 0x1234,
            report_id: 1,
            data: ReportBytes::from(&[0xAA][..]),
        })
        .expect("broadcast");
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            flushed.load(AtomicOrdering::SeqCst) > 0,
            "A should receive reports while its session is open"
        );

        mgr.close(0x1234, "tokA", 1).expect("close A");
        assert!(!mgr.session_transport_active(0x1234, "tokA", MODE_WS, grant_a.generation));
        assert!(mgr.session_transport_active(0x1234, "tokB", MODE_WS, grant_b.generation));

        tokio::time::timeout(Duration::from_secs(2), sender)
            .await
            .expect("sender task exits after session close")
            .expect("sender task does not panic");
        let flushed_after = flushed.load(AtomicOrdering::SeqCst);

        tx.send(webhid::IpcResponse::InputReport {
            device_id: 0x1234,
            report_id: 1,
            data: ReportBytes::from(&[0xBB][..]),
        })
        .expect("broadcast");
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(
            flushed.load(AtomicOrdering::SeqCst),
            flushed_after,
            "A must not receive reports after its session closed"
        );

        assert!(mgr.session_transport_active(0x1234, "tokB", MODE_WS, grant_b.generation));
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
                    cancel: watch::channel(false).0,
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
                    cancel: watch::channel(false).0,
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
