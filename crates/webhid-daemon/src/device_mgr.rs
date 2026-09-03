use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
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

/// Run one HID operation on the persistent per-device I/O worker.
trait DeviceIo: Send + 'static {
    fn output(&self, report_id: u8, data: &[u8]) -> std::io::Result<()>;
    fn feature_write(&self, report_id: u8, data: &[u8]) -> std::io::Result<()>;
    fn feature_read(&self, report_id: u8, buf_size: usize) -> std::io::Result<Vec<u8>>;
}

struct HidDeviceIo(DeviceHandle);

impl DeviceIo for HidDeviceIo {
    fn output(&self, report_id: u8, data: &[u8]) -> std::io::Result<()> {
        with_device(&self.0, |dev| hid::write_report(dev, report_id, data))
    }

    fn feature_write(&self, report_id: u8, data: &[u8]) -> std::io::Result<()> {
        with_device(&self.0, |dev| {
            hid::write_feature_report(dev, report_id, data)
        })
    }

    fn feature_read(&self, report_id: u8, buf_size: usize) -> std::io::Result<Vec<u8>> {
        with_device(&self.0, |dev| {
            hid::read_feature_report(dev, report_id, buf_size)
        })
    }
}

#[derive(Clone)]
pub(crate) struct TransportCapability {
    valid: Arc<AtomicBool>,
    revoked: watch::Sender<bool>,
}

impl TransportCapability {
    fn new() -> Self {
        let (revoked, _) = watch::channel(false);
        Self {
            valid: Arc::new(AtomicBool::new(true)),
            revoked,
        }
    }

    pub(crate) fn is_valid(&self) -> bool {
        self.valid.load(Ordering::SeqCst)
    }

    pub(crate) fn validity(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.valid)
    }

    pub(crate) fn subscribe_revocation(&self) -> watch::Receiver<bool> {
        self.revoked.subscribe()
    }

    fn revoke(&self) {
        if self.valid.swap(false, Ordering::SeqCst) {
            self.revoked.send_replace(true);
        }
    }
}

enum IoCommand {
    Shutdown,
    Output {
        report_id: u8,
        data: Vec<u8>,
        reply: oneshot::Sender<std::io::Result<()>>,
        epoch: u64,
        validity: Arc<AtomicBool>,
    },
    FeatureWrite {
        report_id: u8,
        data: Vec<u8>,
        reply: oneshot::Sender<std::io::Result<()>>,
        epoch: u64,
        validity: Arc<AtomicBool>,
    },
    FeatureRead {
        report_id: u8,
        buf_size: usize,
        reply: oneshot::Sender<std::io::Result<Vec<u8>>>,
        epoch: u64,
        validity: Arc<AtomicBool>,
    },
}

impl IoCommand {
    fn is_current(&self, epoch: &AtomicU64) -> bool {
        match self {
            Self::Shutdown => true,
            Self::Output {
                epoch: command_epoch,
                validity,
                ..
            }
            | Self::FeatureWrite {
                epoch: command_epoch,
                validity,
                ..
            }
            | Self::FeatureRead {
                epoch: command_epoch,
                validity,
                ..
            } => validity.load(Ordering::SeqCst) && *command_epoch == epoch.load(Ordering::SeqCst),
        }
    }

    fn reject(self) {
        let error = || std::io::Error::new(std::io::ErrorKind::BrokenPipe, "device session closed");
        match self {
            Self::Shutdown => {}
            Self::Output { reply, .. } | Self::FeatureWrite { reply, .. } => {
                let _ = reply.send(Err(error()));
            }
            Self::FeatureRead { reply, .. } => {
                let _ = reply.send(Err(error()));
            }
        }
    }
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

/// A WS/WT transport grant: the session generation, cancellation signal,
/// and revocable transport capability.
#[derive(Clone)]
pub struct TransportGrant {
    pub generation: u64,
    pub cancel: watch::Receiver<bool>,
    pub(crate) capability: TransportCapability,
}

#[derive(Clone)]
struct NmHotSession {
    io_tx: mpsc::Sender<IoCommand>,
    epoch: Arc<AtomicU64>,
    valid: Arc<AtomicBool>,
    blocking: Arc<crate::report_blocking::DeviceReportBlocking>,
    vendor_id: u16,
    product_id: u16,
    sink: mpsc::Sender<NmMessage>,
}

struct Entry {
    reader_start: Arc<(Mutex<bool>, Condvar)>,
    stop_flag: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
    io_tx: Option<mpsc::Sender<IoCommand>>,
    io_handle: Option<JoinHandle<()>>,
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
type TransportValidityMap = Arc<Mutex<HashMap<String, TransportCapability>>>;
struct OpenReservation {
    generation: u64,
    invalidated: Arc<AtomicBool>,
    notify: Arc<tokio::sync::Notify>,
}

pub struct DeviceManager {
    /// Serializes cold-path physical and logical lifetime transitions.
    /// Shared map locks are never held across awaits, HID calls, or joins.
    lifecycle: Arc<Mutex<()>>,
    devices: Arc<Mutex<HashMap<u32, Entry>>>,
    /// `session_token -> Session`. Sessions are the authority for device
    /// lifetime, data-plane mode, and WS/WT authentication.
    sessions: Arc<Mutex<HashMap<String, Session>>>,
    /// `ws_auth_hash -> session_token`. A hash dies with its session, never
    /// with the physical device.
    ws_auth_hashes: Arc<Mutex<HashMap<String, String>>>,
    /// Capability tokens for currently established WS/WT transports.
    transport_validity: TransportValidityMap,
    /// Per-device first-open reservations. A reservation remains until its
    /// opener publishes or abandons the lifetime, even if force_close
    /// invalidates it while physical open is in progress.
    opening: Mutex<HashMap<u32, Arc<OpenReservation>>>,
    /// Physical HID opener. Injectable for tests that must control and
    /// observe the first-open path.
    opener: Arc<DeviceOpener>,
    ws_nonce: String,
    event_tx: broadcast::Sender<IpcResponse>,
    nm_sinks: NmSinkMap,
    non_nm_sessions: Arc<AtomicUsize>,
    nm_hot: NmHotMap,
    next_lifetime_generation: AtomicU64,
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
    start_gate: Arc<(Mutex<bool>, Condvar)>,
    transport_validity: TransportValidityMap,
    lifecycle: Arc<Mutex<()>>,
    ws_auth_hashes: Arc<Mutex<HashMap<String, String>>>,
    device_info: DeviceInfo,
}
fn spawn_io_worker<D>(
    device: D,
    epoch: Arc<AtomicU64>,
    mut receiver: mpsc::Receiver<IoCommand>,
) -> JoinHandle<()>
where
    D: DeviceIo,
{
    thread::spawn(move || {
        while let Some(command) = receiver.blocking_recv() {
            if !command.is_current(&epoch) {
                command.reject();
                continue;
            }
            match command {
                IoCommand::Shutdown => break,
                IoCommand::Output {
                    report_id,
                    data,
                    reply,
                    ..
                } => {
                    let _ = reply.send(device.output(report_id, &data));
                }
                IoCommand::FeatureWrite {
                    report_id,
                    data,
                    reply,
                    ..
                } => {
                    let _ = reply.send(device.feature_write(report_id, &data));
                }
                IoCommand::FeatureRead {
                    report_id,
                    buf_size,
                    reply,
                    ..
                } => {
                    let _ = reply.send(device.feature_read(report_id, buf_size));
                }
            }
        }
    })
}

fn spawn_device_io_worker(
    device: DeviceHandle,
    epoch: Arc<AtomicU64>,
    receiver: mpsc::Receiver<IoCommand>,
) -> JoinHandle<()> {
    spawn_io_worker(HidDeviceIo(device), epoch, receiver)
}

async fn send_io_command<T>(
    io_tx: mpsc::Sender<IoCommand>,
    command: IoCommand,
    reply: oneshot::Receiver<std::io::Result<T>>,
) -> std::io::Result<T>
where
    T: Send + 'static,
{
    io_tx.send(command).await.map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::BrokenPipe, "device I/O worker stopped")
    })?;
    reply.await.map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::BrokenPipe, "device I/O worker stopped")
    })?
}
type ReaderStartGate = Arc<(Mutex<bool>, Condvar)>;

fn release_reader_start(gate: &ReaderStartGate) {
    let (started, wake) = &**gate;
    let mut started = started.lock().unwrap_or_else(|e| e.into_inner());
    *started = true;
    wake.notify_one();
}

fn wait_reader_start(gate: ReaderStartGate) {
    let (started, wake) = &*gate;
    let mut started = started.lock().unwrap_or_else(|e| e.into_inner());
    while !*started {
        started = wake.wait(started).unwrap_or_else(|e| e.into_inner());
    }
}

/// Explicitly wakes the worker even if stale sender clones still exist.
/// The fallback sender thread is teardown-only and never runs per report.
fn request_io_shutdown(io_tx: mpsc::Sender<IoCommand>) {
    match io_tx.try_send(IoCommand::Shutdown) {
        Ok(()) | Err(mpsc::error::TrySendError::Closed(_)) => {}
        Err(mpsc::error::TrySendError::Full(command)) => {
            let _ = thread::spawn(move || {
                let _ = io_tx.blocking_send(command);
            })
            .join();
        }
    }
}

fn stop_entry(mut entry: Entry) {
    entry.stop_flag.store(true, Ordering::SeqCst);
    entry.io_epoch.fetch_add(1, Ordering::SeqCst);
    release_reader_start(&entry.reader_start);
    if let Some(io_tx) = entry.io_tx.take() {
        request_io_shutdown(io_tx);
    }
    if let Some(handle) = entry.handle.take() {
        let _ = handle.join();
    }
    if let Some(handle) = entry.io_handle.take() {
        let _ = handle.join();
    }
}

fn stop_entry_io_worker(mut entry: Entry) {
    entry.stop_flag.store(true, Ordering::SeqCst);
    entry.io_epoch.fetch_add(1, Ordering::SeqCst);
    release_reader_start(&entry.reader_start);
    if let Some(io_tx) = entry.io_tx.take() {
        request_io_shutdown(io_tx);
    }
    if let Some(handle) = entry.io_handle.take() {
        let _ = handle.join();
    }
}

fn route_nm_input(sinks: &NmHotMap, device_id: u32, report_id: u8, data: &Bytes) {
    let targets: Vec<(mpsc::Sender<NmMessage>, Arc<AtomicBool>)> = sinks
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .filter(|((_, target_device_id), _)| *target_device_id == device_id)
        .map(|(_, hot)| (hot.sink.clone(), Arc::clone(&hot.valid)))
        .collect();
    for (target, valid) in targets {
        let mut message = NmMessage::packed_input_report(device_id, [(report_id, &data[..])]);
        loop {
            if !valid.load(Ordering::SeqCst) {
                break;
            }
            match target.try_send(message) {
                Ok(()) | Err(mpsc::error::TrySendError::Closed(_)) => break,
                Err(mpsc::error::TrySendError::Full(next)) => {
                    message = next;
                    std::thread::yield_now();
                }
            }
        }
    }
}
fn detach_dead_reader_lifetime(
    lifecycle: &Arc<Mutex<()>>,
    devices: &Arc<Mutex<HashMap<u32, Entry>>>,
    sessions: &Arc<Mutex<HashMap<String, Session>>>,
    transport_validity: &TransportValidityMap,
    nm_hot: &NmHotMap,
    ws_auth_hashes: &Arc<Mutex<HashMap<String, String>>>,
    device_id: u32,
) -> Option<(Entry, Vec<watch::Sender<bool>>, usize)> {
    let _lifecycle = lifecycle.lock().unwrap_or_else(|e| e.into_inner());
    let entry = devices
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&device_id)?;
    let (tokens, cancels, non_nm_count) = {
        let sessions = sessions.lock().unwrap_or_else(|e| e.into_inner());
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
        let mut sessions = sessions.lock().unwrap_or_else(|e| e.into_inner());
        for token in &tokens {
            sessions.remove(token);
        }
    }
    {
        let mut hashes = ws_auth_hashes.lock().unwrap_or_else(|e| e.into_inner());
        hashes.retain(|_, token| !tokens.contains(token));
    }
    {
        let mut validity = transport_validity.lock().unwrap_or_else(|e| e.into_inner());
        validity.retain(|token, capability| {
            if tokens.contains(token) {
                capability.revoke();
                false
            } else {
                true
            }
        });
    }
    nm_hot
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
    Some((entry, cancels, non_nm_count))
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
            lifecycle: Mutex::new(()).into(),
            devices: Mutex::new(HashMap::new()).into(),
            sessions: Mutex::new(HashMap::new()).into(),
            ws_auth_hashes: Mutex::new(HashMap::new()).into(),
            transport_validity: Mutex::new(HashMap::new()).into(),
            opening: Mutex::new(HashMap::new()),
            opener: Arc::new(opener),
            ws_nonce,
            event_tx,
            non_nm_sessions: Arc::new(AtomicUsize::new(0)),
            nm_sinks: Mutex::new(HashMap::new()).into(),
            nm_hot: Mutex::new(HashMap::new()).into(),
            next_lifetime_generation: AtomicU64::new(0),
            next_client_id: AtomicU64::new(0),
        }
    }

    /// Allocates a fresh IPC client id. Sessions record the client that
    /// opened them so a disconnect only tears down that client's sessions.
    pub fn new_client_id(&self) -> u64 {
        self.next_client_id.fetch_add(1, Ordering::SeqCst) + 1
    }
    pub fn register_nm_sink(&self, client_id: u64, sender: mpsc::Sender<NmMessage>) {
        let _lifecycle = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
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
            self.refresh_nm_hot_locked(device_id, client_id);
        }
    }

    pub fn unregister_nm_sink(&self, client_id: u64) {
        let _lifecycle = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
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

    fn replace_transport_validity(&self, session_token: &str) -> TransportCapability {
        let capability = TransportCapability::new();
        let mut tokens = self
            .transport_validity
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(old) = tokens.insert(session_token.to_string(), capability.clone()) {
            old.revoke();
        }
        capability
    }

    fn invalidate_transport_validity(&self, session_token: &str) {
        if let Some(capability) = self
            .transport_validity
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(session_token)
        {
            capability.revoke();
        }
    }
    fn transport_capability_current(
        &self,
        session_token: &str,
        capability: &TransportCapability,
    ) -> bool {
        self.transport_validity
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session_token)
            .is_some_and(|current| Arc::ptr_eq(&current.valid, &capability.valid))
    }

    fn invalidate_nm_hot_for_device_locked(&self, device_id: u32) {
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

    /// Refreshes the NM binding while the lifecycle mutex is held. The
    /// session, sink, and physical entry snapshot is therefore linearized
    /// with every teardown and cannot be published after its lifetime ends.
    fn refresh_nm_hot_locked(&self, device_id: u32, client_id: u64) {
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
                    io_tx: entry.io_tx.as_ref()?.clone(),
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

    async fn enqueue_io(
        io_tx: mpsc::Sender<IoCommand>,
        command: IoCommand,
        reply: oneshot::Receiver<std::io::Result<()>>,
    ) -> std::io::Result<()> {
        send_io_command(io_tx, command, reply).await
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
        Self::enqueue_io(
            hot.io_tx.clone(),
            IoCommand::Output {
                report_id,
                data,
                reply,
                epoch: hot.epoch.load(Ordering::SeqCst),
                validity: Arc::clone(&hot.valid),
            },
            result,
        )
        .await
    }

    pub async fn enqueue_nm_feature_write(
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
        Self::enqueue_io(
            hot.io_tx.clone(),
            IoCommand::FeatureWrite {
                report_id,
                data,
                reply,
                epoch: hot.epoch.load(Ordering::SeqCst),
                validity: Arc::clone(&hot.valid),
            },
            result,
        )
        .await
    }

    pub async fn enqueue_nm_feature_read(
        &self,
        client_id: u64,
        device_id: u32,
        report_id: u8,
    ) -> std::io::Result<Vec<u8>> {
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
        let command = IoCommand::FeatureRead {
            report_id,
            buf_size: self.read_buf_size(device_id),
            reply,
            epoch: hot.epoch.load(Ordering::SeqCst),
            validity: Arc::clone(&hot.valid),
        };
        send_io_command(hot.io_tx, command, result).await
    }

    fn transport_io_context(
        &self,
        device_id: u32,
        validity: &Arc<AtomicBool>,
    ) -> std::io::Result<(mpsc::Sender<IoCommand>, Arc<AtomicU64>, usize)> {
        if !validity.load(Ordering::SeqCst) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "transport inactive",
            ));
        }
        let devices = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        let entry = devices
            .get(&device_id)
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "device not open"))?;
        Ok((
            entry.io_tx.as_ref().cloned().ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::BrokenPipe, "device I/O worker stopped")
            })?,
            Arc::clone(&entry.io_epoch),
            entry.read_buf_size,
        ))
    }

    pub async fn enqueue_transport_output(
        &self,
        device_id: u32,
        validity: Arc<AtomicBool>,
        report_id: u8,
        data: Vec<u8>,
    ) -> std::io::Result<()> {
        let (io_tx, epoch, _) = self.transport_io_context(device_id, &validity)?;
        let (reply, result) = oneshot::channel();
        Self::enqueue_io(
            io_tx,
            IoCommand::Output {
                report_id,
                data,
                reply,
                epoch: epoch.load(Ordering::SeqCst),
                validity,
            },
            result,
        )
        .await
    }

    pub async fn enqueue_transport_feature_write(
        &self,
        device_id: u32,
        validity: Arc<AtomicBool>,
        report_id: u8,
        data: Vec<u8>,
    ) -> std::io::Result<()> {
        let (io_tx, epoch, _) = self.transport_io_context(device_id, &validity)?;
        let (reply, result) = oneshot::channel();
        Self::enqueue_io(
            io_tx,
            IoCommand::FeatureWrite {
                report_id,
                data,
                reply,
                epoch: epoch.load(Ordering::SeqCst),
                validity,
            },
            result,
        )
        .await
    }

    pub async fn enqueue_transport_feature_read(
        &self,
        device_id: u32,
        validity: Arc<AtomicBool>,
        report_id: u8,
    ) -> std::io::Result<Vec<u8>> {
        let (io_tx, epoch, read_buf_size) = self.transport_io_context(device_id, &validity)?;
        let (reply, result) = oneshot::channel();
        let command = IoCommand::FeatureRead {
            report_id,
            buf_size: read_buf_size,
            reply,
            epoch: epoch.load(Ordering::SeqCst),
            validity,
        };
        send_io_command(io_tx, command, result).await
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

        let reservation = loop {
            let (wait, reservation) = {
                let _lifecycle = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
                if self.register_session_locked(
                    device_id,
                    &session_token,
                    owner_client_id,
                    &ws_auth_hash,
                ) {
                    self.refresh_nm_hot_locked(device_id, owner_client_id);
                    return Ok((device_id, session_token));
                }
                let mut opening = self.opening.lock().unwrap_or_else(|e| e.into_inner());
                match opening.get(&device_id) {
                    Some(reservation) => {
                        (Some(Arc::clone(&reservation.notify).notified_owned()), None)
                    }
                    None => {
                        let reservation = Arc::new(OpenReservation {
                            generation: self
                                .next_lifetime_generation
                                .fetch_add(1, Ordering::SeqCst)
                                + 1,
                            invalidated: Arc::new(AtomicBool::new(false)),
                            notify: Arc::new(tokio::sync::Notify::new()),
                        });
                        opening.insert(device_id, Arc::clone(&reservation));
                        (None, Some(reservation))
                    }
                }
            };
            if let Some(reservation) = reservation {
                break reservation;
            }
            wait.expect("waiter must hold a notification future").await;
            let _lifecycle = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
            if self.register_session_locked(
                device_id,
                &session_token,
                owner_client_id,
                &ws_auth_hash,
            ) {
                self.refresh_nm_hot_locked(device_id, owner_client_id);
                return Ok((device_id, session_token));
            }
            if !self
                .opening
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .contains_key(&device_id)
            {
                return Err(anyhow!(
                    "device '{device_id:#x}' could not be opened by the concurrent opener"
                ));
            }
        };

        let result = self
            .open_physical(
                device_id,
                &session_token,
                owner_client_id,
                &ws_auth_hash,
                Arc::clone(&reservation),
            )
            .await;
        let notify = {
            let _lifecycle = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
            let mut opening = self.opening.lock().unwrap_or_else(|e| e.into_inner());
            match opening.get(&device_id) {
                Some(current) if current.generation == reservation.generation => Some(
                    opening
                        .remove(&device_id)
                        .expect("reservation is present")
                        .notify
                        .clone(),
                ),
                _ => None,
            }
        };
        if let Some(notify) = notify {
            notify.notify_waiters();
        }
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
        reservation: Arc<OpenReservation>,
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

        #[cfg(target_os = "linux")]
        let device_arc: DeviceHandle = Arc::new(device);
        #[cfg(not(target_os = "linux"))]
        let device_arc: DeviceHandle = Arc::new(Mutex::new(device));
        {
            let _lifecycle = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
            let current = !reservation.invalidated.load(Ordering::SeqCst)
                && self
                    .opening
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get(&device_id)
                    .is_some_and(|current| Arc::ptr_eq(current, &reservation));
            if !current {
                return Err(anyhow!(
                    "device '{device_id:#x}' open reservation invalidated"
                ));
            }
            if self.register_session_locked(id, session_token, owner_client_id, ws_auth_hash) {
                self.refresh_nm_hot_locked(id, owner_client_id);
                return Ok((id, session_token.to_string()));
            }
        }

        let stop_flag = Arc::new(AtomicBool::new(false));
        let reader_start: ReaderStartGate = Arc::new((Mutex::new(false), Condvar::new()));
        let io_epoch = Arc::new(AtomicU64::new(0));
        let (io_tx, io_rx) = mpsc::channel(128);
        let dev_for_task = Arc::clone(&device_arc);
        let handle = self.spawn_reader(ReaderConfig {
            dev_id: id,
            dev_for_task,
            start_gate: Arc::clone(&reader_start),
            stop_flag: Arc::clone(&stop_flag),
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
            transport_validity: Arc::clone(&self.transport_validity),
            lifecycle: Arc::clone(&self.lifecycle),
            ws_auth_hashes: Arc::clone(&self.ws_auth_hashes),
            device_info: info.clone(),
        });
        let io_handle =
            spawn_device_io_worker(Arc::clone(&device_arc), Arc::clone(&io_epoch), io_rx);

        let mut entry = Some(Entry {
            reader_start: Arc::clone(&reader_start),
            stop_flag,
            handle: Some(handle),
            io_tx: Some(io_tx),
            io_handle: Some(io_handle),
            io_epoch,
            vendor_id: info.vendor_id,
            product_id: info.product_id,
            read_buf_size,
            blocking,
        });

        let (installed, invalidated) = {
            let _lifecycle = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
            let current = !reservation.invalidated.load(Ordering::SeqCst)
                && self
                    .opening
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get(&device_id)
                    .is_some_and(|current| Arc::ptr_eq(current, &reservation));
            if !current {
                (false, true)
            } else if self.register_session_locked(id, session_token, owner_client_id, ws_auth_hash)
            {
                self.refresh_nm_hot_locked(id, owner_client_id);
                (false, false)
            } else {
                self.devices
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(id, entry.take().expect("new entry is still owned here"));
                assert!(self.register_session_locked(
                    id,
                    session_token,
                    owner_client_id,
                    ws_auth_hash
                ));
                self.refresh_nm_hot_locked(id, owner_client_id);
                (true, false)
            }
        };
        if invalidated {
            stop_entry(
                entry
                    .take()
                    .expect("invalidated reservation still owns local entry"),
            );
            return Err(anyhow!(
                "device '{device_id:#x}' open reservation invalidated"
            ));
        }
        if installed {
            release_reader_start(&reader_start);
        } else {
            stop_entry(
                entry
                    .take()
                    .expect("existing lifetime leaves local entry unused"),
            );
        }

        Ok((id, session_token.to_string()))
    }

    /// Registers a new logical session while the lifecycle mutex is held.
    fn register_session_locked(
        &self,
        device_id: u32,
        session_token: &str,
        owner_client_id: u64,
        ws_auth_hash: &str,
    ) -> bool {
        if !self
            .devices
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(&device_id)
        {
            return false;
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
            start_gate,
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
            transport_validity: transport_validity_for_task,
            lifecycle: lifecycle_for_task,
            ws_auth_hashes: hashes_for_task,
            device_info: info_for_task,
        } = cfg;
        let blocked_for_task = Arc::clone(&blocked_input_ids);
        let declared_for_task = Arc::clone(&declared_input_ids);
        let tx = self.event_tx.clone();
        thread::spawn(move || {
            wait_reader_start(start_gate);
            let cleanup_dead_reader = || {
                let Some((entry, cancels, non_nm_count)) = detach_dead_reader_lifetime(
                    &lifecycle_for_task,
                    &devices_for_task,
                    &sessions_for_task,
                    &transport_validity_for_task,
                    &nm_hot,
                    &hashes_for_task,
                    dev_id,
                ) else {
                    return;
                };
                stop_entry_io_worker(entry);
                if non_nm_count > 0 {
                    non_nm_sessions.fetch_sub(non_nm_count, Ordering::SeqCst);
                }
                for cancel in cancels {
                    let _ = cancel.send(true);
                }
                let _ = tx.send(IpcResponse::DeviceDisconnected {
                    device: info_for_task.clone(),
                });
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
        let (last_session, entry) = {
            let _lifecycle = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
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
            self.invalidate_transport_validity(session_token);
            self.ws_auth_hashes
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&hash);
            let _ = cancel_tx.send(true);
            self.update_non_nm_count(was_non_nm, false);
            let entry = if last_session {
                self.invalidate_nm_hot_for_device_locked(device_id);
                self.devices
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&device_id)
            } else {
                self.refresh_nm_hot_locked(device_id, owner_client_id);
                None
            };
            (last_session, entry)
        };
        if let Some(entry) = entry {
            stop_entry(entry);
        }
        if last_session {
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

    /// Descriptor-derived read buffer size for the device (report payload +
    /// report-id byte, floored and capped). Used for feature-report reads.
    pub fn read_buf_size(&self, device_id: u32) -> usize {
        let map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        map.get(&device_id)
            .map(|e| e.read_buf_size)
            .unwrap_or(crate::hid::MAX_READ_BUFFER)
    }
    /// Validates and applies a data-plane mode change for exactly one
    /// session while holding the lifecycle boundary.
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
        let _lifecycle = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
        let (was_non_nm, owner_client_id) = {
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
            (was_non_nm, session.owner_client_id)
        };
        self.invalidate_transport_validity(session_token);
        self.update_non_nm_count(was_non_nm, mode != MODE_NM);
        self.refresh_nm_hot_locked(device_id, owner_client_id);
        log::info!("[device_mgr] {device_id:#x} session dataplane mode → {mode}");
        Ok(())
    }

    /// Marks the session's data plane as WS. Returns the per-session
    /// generation, cancellation signal, and capability.
    pub fn ws_connect(&self, device_id: u32, session_token: &str) -> Option<TransportGrant> {
        let _lifecycle = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
        let (grant, owner_client_id, was_non_nm) = {
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            let session = sessions.get_mut(session_token)?;
            if !session.active || session.device_id != device_id {
                return None;
            }
            let was_non_nm = session.mode != MODE_NM;
            session.ws_generation += 1;
            session.mode = MODE_WS.to_string();
            let capability = self.replace_transport_validity(session_token);
            (
                TransportGrant {
                    generation: session.ws_generation,
                    cancel: session.cancel.subscribe(),
                    capability,
                },
                session.owner_client_id,
                was_non_nm,
            )
        };
        self.update_non_nm_count(was_non_nm, true);
        self.refresh_nm_hot_locked(device_id, owner_client_id);
        log::info!(
            "[device_mgr] {device_id:#x} WS connect gen={}",
            grant.generation
        );
        Some(grant)
    }

    /// Marks the session's data plane as WT. Returns the per-session
    /// generation, cancellation signal, and capability.
    pub fn wt_connect(&self, device_id: u32, session_token: &str) -> Option<TransportGrant> {
        let _lifecycle = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
        let (grant, owner_client_id, was_non_nm) = {
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            let session = sessions.get_mut(session_token)?;
            if !session.active || session.device_id != device_id {
                return None;
            }
            let was_non_nm = session.mode != MODE_NM;
            session.wt_generation += 1;
            session.mode = MODE_WT.to_string();
            let capability = self.replace_transport_validity(session_token);
            (
                TransportGrant {
                    generation: session.wt_generation,
                    cancel: session.cancel.subscribe(),
                    capability,
                },
                session.owner_client_id,
                was_non_nm,
            )
        };
        self.update_non_nm_count(was_non_nm, true);
        self.refresh_nm_hot_locked(device_id, owner_client_id);
        log::info!(
            "[device_mgr] {device_id:#x} WT connect gen={}",
            grant.generation
        );
        Some(grant)
    }
    /// Control-plane diagnostic for the transport generation and mode.
    /// Report execution uses the issued capability directly and does not
    /// call this session-map lookup.
    #[cfg_attr(not(test), allow(dead_code))]
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
            MODE_WS => session.mode == MODE_WS && session.ws_generation == generation,
            MODE_WT => session.mode == MODE_WT && session.wt_generation == generation,
            _ => false,
        }
    }

    pub(crate) fn ws_disconnect(
        &self,
        device_id: u32,
        session_token: &str,
        generation: u64,
        capability: &TransportCapability,
    ) {
        let _lifecycle = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
        let (owner_client_id, current_generation, was_non_nm, mode_current) = {
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            let session = match sessions.get_mut(session_token) {
                Some(session) if session.active && session.device_id == device_id => session,
                _ => return,
            };
            let owner_client_id = session.owner_client_id;
            let current_generation = session.ws_generation;
            let mode_current = current_generation == generation && session.mode == MODE_WS;
            let was_non_nm = session.mode != MODE_NM;
            (
                owner_client_id,
                current_generation,
                was_non_nm,
                mode_current,
            )
        };
        let current = mode_current && self.transport_capability_current(session_token, capability);
        if current {
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(session) = sessions.get_mut(session_token) {
                session.mode = MODE_NM.to_string();
            }
            drop(sessions);
            self.invalidate_transport_validity(session_token);
            self.update_non_nm_count(was_non_nm, false);
            self.refresh_nm_hot_locked(device_id, owner_client_id);
            log::info!("[device_mgr] {device_id:#x} WS disconnect gen={generation} → nm");
        } else {
            log::info!(
                "[ws] dev={device_id:#x} disconnect gen={generation} stale (current={current_generation})"
            );
        }
    }

    pub(crate) fn wt_disconnect(
        &self,
        device_id: u32,
        session_token: &str,
        generation: u64,
        capability: &TransportCapability,
    ) {
        let _lifecycle = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
        let (owner_client_id, current_generation, was_non_nm, mode_current) = {
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            let session = match sessions.get_mut(session_token) {
                Some(session) if session.active && session.device_id == device_id => session,
                _ => return,
            };
            let owner_client_id = session.owner_client_id;
            let current_generation = session.wt_generation;
            let mode_current = current_generation == generation && session.mode == MODE_WT;
            let was_non_nm = session.mode != MODE_NM;
            (
                owner_client_id,
                current_generation,
                was_non_nm,
                mode_current,
            )
        };
        let current = mode_current && self.transport_capability_current(session_token, capability);
        if current {
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(session) = sessions.get_mut(session_token) {
                session.mode = MODE_NM.to_string();
            }
            drop(sessions);
            self.invalidate_transport_validity(session_token);
            self.update_non_nm_count(was_non_nm, false);
            self.refresh_nm_hot_locked(device_id, owner_client_id);
            log::info!("[device_mgr] {device_id:#x} WT disconnect gen={generation} → nm");
        } else {
            log::info!(
                "[wt] dev={device_id:#x} disconnect gen={generation} stale (current={current_generation})"
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
        let (cancels, non_nm_count, entry) = {
            let _lifecycle = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(reservation) = self
                .opening
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&device_id)
            {
                reservation.invalidated.store(true, Ordering::SeqCst);
                reservation.notify.notify_waiters();
            }
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
                for token in &tokens {
                    sessions.remove(token);
                }
            }
            {
                let mut hashes = self
                    .ws_auth_hashes
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                hashes.retain(|_, token| !tokens.contains(token));
            }
            {
                let mut validity = self
                    .transport_validity
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                validity.retain(|token, capability| {
                    if tokens.contains(token) {
                        capability.revoke();
                        false
                    } else {
                        true
                    }
                });
            }
            self.invalidate_nm_hot_for_device_locked(device_id);
            let entry = self
                .devices
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&device_id);
            (cancels, non_nm_count, entry)
        };
        for cancel in cancels {
            let _ = cancel.send(true);
        }
        if non_nm_count > 0 {
            self.non_nm_sessions
                .fetch_sub(non_nm_count, Ordering::SeqCst);
        }
        if let Some(entry) = entry {
            stop_entry(entry);
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

    fn insert_active_session(mgr: &DeviceManager, token: &str, owner: u64) {
        mgr.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                token.to_string(),
                Session {
                    token: token.to_string(),
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
    #[derive(Debug, PartialEq)]
    enum IoCall {
        Output(u8, Vec<u8>),
        FeatureWrite(u8, Vec<u8>),
        FeatureRead(u8, usize),
    }

    #[derive(Clone)]
    struct MockDeviceIo {
        calls: Arc<Mutex<Vec<IoCall>>>,
    }

    impl DeviceIo for MockDeviceIo {
        fn output(&self, report_id: u8, data: &[u8]) -> std::io::Result<()> {
            self.calls
                .lock()
                .unwrap()
                .push(IoCall::Output(report_id, data.to_vec()));
            Ok(())
        }

        fn feature_write(&self, report_id: u8, data: &[u8]) -> std::io::Result<()> {
            self.calls
                .lock()
                .unwrap()
                .push(IoCall::FeatureWrite(report_id, data.to_vec()));
            Ok(())
        }

        fn feature_read(&self, report_id: u8, buf_size: usize) -> std::io::Result<Vec<u8>> {
            self.calls
                .lock()
                .unwrap()
                .push(IoCall::FeatureRead(report_id, buf_size));
            Ok(vec![report_id, buf_size as u8])
        }
    }

    fn atomic_validity() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(true))
    }

    fn install_test_io_entry(mgr: &DeviceManager, device_id: u32) -> Arc<Mutex<Vec<IoCall>>> {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let epoch = Arc::new(AtomicU64::new(0));
        let (io_tx, io_rx) = mpsc::channel(4);
        let io_handle = spawn_io_worker(
            MockDeviceIo {
                calls: Arc::clone(&calls),
            },
            Arc::clone(&epoch),
            io_rx,
        );
        let blocking = Arc::new(DeviceReportBlocking::new(
            &DeviceInfo {
                vendor_id: 1,
                product_id: 1,
                product_name: "test".to_string(),
                manufacturer: None,
                serial_number: None,
                usage_page: None,
                usage: None,
                device_id,
                descriptor_parse_failed: false,
                collections: Vec::new(),
                max_input_report_size: 64,
                raw_descriptor: Vec::new(),
            },
            true,
        ));
        mgr.devices
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                device_id,
                Entry {
                    reader_start: Arc::new((Mutex::new(true), Condvar::new())),
                    stop_flag: Arc::new(AtomicBool::new(false)),
                    handle: None,
                    io_tx: Some(io_tx),
                    io_handle: Some(io_handle),
                    io_epoch: epoch,
                    vendor_id: 1,
                    product_id: 1,
                    read_buf_size: 64,
                    blocking,
                },
            );
        calls
    }

    #[test]
    fn test_reader_start_gate_blocks_reads_until_publication() {
        let gate: ReaderStartGate = Arc::new((Mutex::new(false), Condvar::new()));
        let read_started = Arc::new(AtomicBool::new(false));
        let (created_tx, created_rx) = std::sync::mpsc::channel();
        let reader_gate = Arc::clone(&gate);
        let read_started_for_reader = Arc::clone(&read_started);
        let reader = thread::spawn(move || {
            created_tx.send(()).unwrap();
            wait_reader_start(reader_gate);
            read_started_for_reader.store(true, Ordering::SeqCst);
        });
        created_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("reader created");
        assert!(!read_started.load(Ordering::SeqCst));
        release_reader_start(&gate);
        reader.join().unwrap();
        assert!(read_started.load(Ordering::SeqCst));
    }
    #[test]
    fn test_abandoned_reader_releases_start_gate_on_teardown() {
        let gate: ReaderStartGate = Arc::new((Mutex::new(false), Condvar::new()));
        let stop_flag = Arc::new(AtomicBool::new(false));
        let would_read = Arc::new(AtomicBool::new(false));
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let reader_gate = Arc::clone(&gate);
        let reader_stop_flag = Arc::clone(&stop_flag);
        let would_read_for_reader = Arc::clone(&would_read);
        let reader = thread::spawn(move || {
            wait_reader_start(reader_gate);
            if !reader_stop_flag.load(Ordering::SeqCst) {
                would_read_for_reader.store(true, Ordering::SeqCst);
            }
            done_tx.send(()).unwrap();
        });
        let calls = Arc::new(Mutex::new(Vec::new()));
        let (io_tx, io_rx) = mpsc::channel(1);
        let io_epoch = Arc::new(AtomicU64::new(0));
        let io_handle = spawn_io_worker(
            MockDeviceIo {
                calls: Arc::clone(&calls),
            },
            Arc::clone(&io_epoch),
            io_rx,
        );
        let blocking = Arc::new(DeviceReportBlocking::new(
            &DeviceInfo {
                vendor_id: 1,
                product_id: 1,
                product_name: "test".to_string(),
                manufacturer: None,
                serial_number: None,
                usage_page: None,
                usage: None,
                device_id: 0x1234,
                descriptor_parse_failed: false,
                collections: Vec::new(),
                max_input_report_size: 64,
                raw_descriptor: Vec::new(),
            },
            true,
        ));
        stop_entry(Entry {
            reader_start: gate,
            handle: Some(reader),
            stop_flag: Arc::clone(&stop_flag),
            io_tx: Some(io_tx),
            io_handle: Some(io_handle),
            io_epoch,
            vendor_id: 1,
            product_id: 1,
            read_buf_size: 64,
            blocking,
        });
        done_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("abandoned reader released");
        assert!(calls.lock().unwrap_or_else(|e| e.into_inner()).is_empty());
        assert!(stop_flag.load(Ordering::SeqCst));
        assert!(!would_read.load(Ordering::SeqCst));
    }
    #[test]
    fn test_dead_reader_cleanup_removes_published_lifetime() {
        let (tx, _) = broadcast::channel(16);
        let mgr = Arc::new(DeviceManager::new(tx));
        let calls = install_test_io_entry(&mgr, 0x1234);
        insert_active_session(&mgr, "tok-nm", 1);
        insert_active_session(&mgr, "tok-ws", 2);
        mgr.ws_auth_hashes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .extend([
                ("hash-nm".to_string(), "tok-nm".to_string()),
                ("hash-ws".to_string(), "tok-ws".to_string()),
            ]);
        let (sink_tx, _sink_rx) = mpsc::channel(1);
        mgr.register_nm_sink(1, sink_tx);
        let ws = mgr.ws_connect(0x1234, "tok-ws").expect("WS connects");
        let io_epoch = {
            let devices = mgr.devices.lock().unwrap_or_else(|e| e.into_inner());
            Arc::clone(&devices.get(&0x1234).unwrap().io_epoch)
        };
        let old_epoch = io_epoch.load(Ordering::SeqCst);

        let (entry, cancels, non_nm_count) = detach_dead_reader_lifetime(
            &mgr.lifecycle,
            &mgr.devices,
            &mgr.sessions,
            &mgr.transport_validity,
            &mgr.nm_hot,
            &mgr.ws_auth_hashes,
            0x1234,
        )
        .expect("published lifetime");
        stop_entry_io_worker(entry);
        if non_nm_count > 0 {
            mgr.non_nm_sessions
                .fetch_sub(non_nm_count, Ordering::SeqCst);
        }
        for cancel in cancels {
            let _ = cancel.send(true);
        }
        assert_eq!(io_epoch.load(Ordering::SeqCst), old_epoch + 1);

        assert!(!ws.capability.is_valid());
        assert!(
            mgr.devices
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
        assert!(
            mgr.ws_auth_hashes
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty()
        );
        assert!(
            mgr.transport_validity
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty()
        );
        assert!(
            mgr.nm_hot
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty()
        );
        assert!(calls.lock().unwrap_or_else(|e| e.into_inner()).is_empty());
    }

    #[test]
    fn test_io_worker_executes_output_and_feature_commands() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let epoch = Arc::new(AtomicU64::new(7));
        let (tx, rx) = mpsc::channel(4);
        let worker = spawn_io_worker(
            MockDeviceIo {
                calls: Arc::clone(&calls),
            },
            Arc::clone(&epoch),
            rx,
        );
        let validity = atomic_validity();
        let (output_reply, output_result) = oneshot::channel();
        tx.blocking_send(IoCommand::Output {
            report_id: 1,
            data: vec![2, 3],
            reply: output_reply,
            epoch: 7,
            validity,
        })
        .unwrap();
        assert!(output_result.blocking_recv().unwrap().is_ok());

        let validity = atomic_validity();
        let (write_reply, write_result) = oneshot::channel();
        tx.blocking_send(IoCommand::FeatureWrite {
            report_id: 4,
            data: vec![5],
            reply: write_reply,
            epoch: 7,
            validity,
        })
        .unwrap();
        assert!(write_result.blocking_recv().unwrap().is_ok());

        let validity = atomic_validity();
        let (read_reply, read_result) = oneshot::channel();
        tx.blocking_send(IoCommand::FeatureRead {
            report_id: 6,
            buf_size: 32,
            reply: read_reply,
            epoch: 7,
            validity,
        })
        .unwrap();
        assert_eq!(read_result.blocking_recv().unwrap().unwrap(), vec![6, 32]);

        drop(tx);
        worker.join().unwrap();
        assert_eq!(
            *calls.lock().unwrap(),
            vec![
                IoCall::Output(1, vec![2, 3]),
                IoCall::FeatureWrite(4, vec![5]),
                IoCall::FeatureRead(6, 32),
            ]
        );
    }

    #[test]
    fn test_io_worker_rejects_stale_commands_without_touching_device() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let epoch = Arc::new(AtomicU64::new(2));
        let (tx, rx) = mpsc::channel(2);
        let worker = spawn_io_worker(
            MockDeviceIo {
                calls: Arc::clone(&calls),
            },
            epoch,
            rx,
        );
        let validity = atomic_validity();
        validity.store(false, Ordering::SeqCst);
        let (reply, result) = oneshot::channel();
        tx.blocking_send(IoCommand::FeatureRead {
            report_id: 1,
            buf_size: 8,
            reply,
            epoch: 2,
            validity,
        })
        .unwrap();
        assert_eq!(
            result.blocking_recv().unwrap().unwrap_err().kind(),
            std::io::ErrorKind::BrokenPipe
        );
        let validity = atomic_validity();
        let (reply, result) = oneshot::channel();
        tx.blocking_send(IoCommand::Output {
            report_id: 2,
            data: vec![3],
            reply,
            epoch: 1,
            validity,
        })
        .unwrap();
        assert!(result.blocking_recv().unwrap().is_err());
        drop(tx);
        worker.join().unwrap();
        assert!(calls.lock().unwrap().is_empty());
    }

    #[test]
    fn test_io_worker_shutdown_resolves_queued_request() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let (tx, rx) = mpsc::channel(1);
        let epoch = Arc::new(AtomicU64::new(0));
        let worker = spawn_io_worker(
            MockDeviceIo {
                calls: Arc::clone(&calls),
            },
            epoch,
            rx,
        );
        let validity = atomic_validity();
        validity.store(false, Ordering::SeqCst);
        let (reply, result) = oneshot::channel();
        tx.blocking_send(IoCommand::FeatureWrite {
            report_id: 9,
            data: vec![10],
            reply,
            epoch: 0,
            validity,
        })
        .unwrap();
        drop(tx);
        assert!(result.blocking_recv().unwrap().is_err());
        worker.join().unwrap();
        assert!(calls.lock().unwrap().is_empty());
    }

    #[test]
    fn test_force_close_drops_hot_sender_before_joining_worker() {
        let (tx, _) = broadcast::channel(16);
        let mgr = Arc::new(DeviceManager::new(tx));
        let calls = install_test_io_entry(&mgr, 0x1234);
        let (io_tx, epoch, blocking) = {
            let devices = mgr.devices.lock().unwrap_or_else(|e| e.into_inner());
            let entry = devices.get(&0x1234).unwrap();
            (
                entry.io_tx.as_ref().unwrap().clone(),
                Arc::clone(&entry.io_epoch),
                Arc::clone(&entry.blocking),
            )
        };
        let stale_sender = {
            let devices = mgr.devices.lock().unwrap_or_else(|e| e.into_inner());
            devices
                .get(&0x1234)
                .unwrap()
                .io_tx
                .as_ref()
                .unwrap()
                .clone()
        };
        mgr.nm_hot.lock().unwrap_or_else(|e| e.into_inner()).insert(
            (1, 0x1234),
            NmHotSession {
                io_tx,
                epoch,
                valid: Arc::new(AtomicBool::new(true)),
                blocking,
                vendor_id: 1,
                product_id: 1,
                sink: mpsc::channel(1).0,
            },
        );
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let mgr_for_close = Arc::clone(&mgr);
        let handle = thread::spawn(move || {
            mgr_for_close.force_close(0x1234);
            done_tx.send(()).unwrap();
        });
        assert!(done_rx.recv_timeout(Duration::from_secs(1)).is_ok());
        handle.join().unwrap();
        assert!(
            mgr.nm_hot
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty()
        );
        assert!(
            mgr.devices
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty()
        );
        assert!(calls.lock().unwrap_or_else(|e| e.into_inner()).is_empty());
        drop(stale_sender);
    }

    #[test]
    fn test_last_session_close_drops_hot_sender_before_joining_worker() {
        let (tx, _) = broadcast::channel(16);
        let mgr = Arc::new(DeviceManager::new(tx));
        let calls = install_test_io_entry(&mgr, 0x1234);
        insert_active_session(&mgr, "tok", 1);
        let (io_tx, epoch, blocking) = {
            let devices = mgr.devices.lock().unwrap_or_else(|e| e.into_inner());
            let entry = devices.get(&0x1234).unwrap();
            (
                entry.io_tx.as_ref().unwrap().clone(),
                Arc::clone(&entry.io_epoch),
                Arc::clone(&entry.blocking),
            )
        };
        let stale_sender = {
            let devices = mgr.devices.lock().unwrap_or_else(|e| e.into_inner());
            devices
                .get(&0x1234)
                .unwrap()
                .io_tx
                .as_ref()
                .unwrap()
                .clone()
        };
        mgr.nm_hot.lock().unwrap_or_else(|e| e.into_inner()).insert(
            (1, 0x1234),
            NmHotSession {
                io_tx,
                epoch,
                valid: Arc::new(AtomicBool::new(true)),
                blocking,
                vendor_id: 1,
                product_id: 1,
                sink: mpsc::channel(1).0,
            },
        );
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let mgr_for_close = Arc::clone(&mgr);
        let handle = thread::spawn(move || {
            mgr_for_close.close(0x1234, "tok", 1).unwrap();
            done_tx.send(()).unwrap();
        });
        assert!(done_rx.recv_timeout(Duration::from_secs(1)).is_ok());
        handle.join().unwrap();
        assert!(
            mgr.nm_hot
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty()
        );
        assert!(
            mgr.devices
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty()
        );
        assert!(calls.lock().unwrap_or_else(|e| e.into_inner()).is_empty());
        drop(stale_sender);
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
        let (io_tx, _io_rx) = mpsc::channel(1);
        let (other_io_tx, _other_io_rx) = mpsc::channel(1);
        let epoch = Arc::new(AtomicU64::new(0));
        mgr.nm_hot.lock().unwrap().extend([
            (
                (1, 7),
                NmHotSession {
                    io_tx,
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
                    io_tx: other_io_tx,
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
    fn test_route_nm_input_stops_when_sink_is_invalidated() {
        let (nm_tx, _nm_rx) = mpsc::channel(1);
        nm_tx.try_send(NmMessage::PackedData(vec![0])).unwrap();
        let valid = Arc::new(AtomicBool::new(true));
        let map: NmHotMap = Arc::new(Mutex::new(HashMap::from([(
            (1, 7),
            NmHotSession {
                io_tx: mpsc::channel(1).0,
                epoch: Arc::new(AtomicU64::new(0)),
                blocking: Arc::new(DeviceReportBlocking::new(
                    &DeviceInfo {
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
                    },
                    true,
                )),
                valid: Arc::clone(&valid),
                vendor_id: 1,
                product_id: 1,
                sink: nm_tx,
            },
        )])));
        let task = std::thread::spawn({
            let map = Arc::clone(&map);
            move || route_nm_input(&map, 7, 1, &Bytes::from_static(&[1, 2, 3]))
        });
        valid.store(false, Ordering::SeqCst);
        task.join().unwrap();
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

    /// Audit regression (HIGH): force-close invalidates an in-flight opener
    /// and prevents waiters from attaching to its abandoned lifetime.
    #[tokio::test]
    async fn test_force_close_invalidates_inflight_open_and_waiter() {
        use std::sync::atomic::AtomicUsize;
        use tokio::sync::oneshot;

        let (event_tx, _) = broadcast::channel(16);
        let (entered_tx, entered_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let entered_tx = Arc::new(Mutex::new(Some(entered_tx)));
        let release_rx = Arc::new(Mutex::new(Some(release_rx)));
        let opener_calls = Arc::new(AtomicUsize::new(0));
        let opener_calls_for_task = Arc::clone(&opener_calls);
        let entered_for_task = Arc::clone(&entered_tx);
        let release_for_task = Arc::clone(&release_rx);
        let mgr = Arc::new(DeviceManager::new_with_opener(event_tx, move |id| {
            opener_calls_for_task.fetch_add(1, Ordering::SeqCst);
            if let Some(tx) = entered_for_task.lock().unwrap().take() {
                let _ = tx.send(());
            }
            if let Some(rx) = release_for_task.lock().unwrap().take() {
                let _ = rx.blocking_recv();
            }
            Err(anyhow!("device '{id:#x}' unavailable in reservation test"))
        }));

        let open_a = {
            let mgr = Arc::clone(&mgr);
            tokio::spawn(async move { mgr.open(0x1234, 1).await })
        };
        entered_rx.await.unwrap();
        let open_b = {
            let mgr = Arc::clone(&mgr);
            tokio::spawn(async move { mgr.open(0x1234, 2).await })
        };
        tokio::task::yield_now().await;

        mgr.force_close(0x1234);
        assert!(
            mgr.opening
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&0x1234)
                .is_some_and(|reservation| reservation.invalidated.load(Ordering::SeqCst))
        );
        release_tx.send(()).unwrap();
        assert!(open_a.await.unwrap().is_err());
        assert!(open_b.await.unwrap().is_err());
        assert_eq!(opener_calls.load(Ordering::SeqCst), 1);
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
        assert!(
            mgr.devices
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty()
        );

        install_test_io_entry(&mgr, 0x1234);
        let (_, fresh_token) = mgr.open(0x1234, 3).await.expect("new lifetime opens");
        assert!(
            mgr.sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .contains_key(&fresh_token)
        );
        mgr.close(0x1234, &fresh_token, 3)
            .expect("close new lifetime");
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
        assert!(!g1.capability.is_valid());
        assert!(g2.capability.is_valid());
        assert!(!*g1.cancel.borrow());
        assert!(!*g2.cancel.borrow());
    }
    #[test]
    fn test_cross_plane_switch_invalidates_stale_transport() {
        let (tx, _) = broadcast::channel(16);
        let mgr = Arc::new(DeviceManager::new(tx));
        insert_active_session(&mgr, "tok", 1);

        let ws = mgr.ws_connect(0x1234, "tok").expect("WS connects");
        let wt = mgr.wt_connect(0x1234, "tok").expect("WT connects");
        assert!(!ws.capability.is_valid());
        assert!(wt.capability.is_valid());
        assert!(!mgr.session_transport_active(0x1234, "tok", MODE_WS, ws.generation));
        assert!(mgr.session_transport_active(0x1234, "tok", MODE_WT, wt.generation));

        let calls = Arc::new(Mutex::new(Vec::new()));
        let epoch = Arc::new(AtomicU64::new(0));
        let (io_tx, io_rx) = mpsc::channel(1);
        let worker = spawn_io_worker(
            MockDeviceIo {
                calls: Arc::clone(&calls),
            },
            epoch,
            io_rx,
        );
        let (reply, result) = oneshot::channel();
        io_tx
            .blocking_send(IoCommand::Output {
                report_id: 1,
                data: vec![2],
                reply,
                epoch: 0,
                validity: ws.capability.validity(),
            })
            .unwrap();
        assert!(result.blocking_recv().unwrap().is_err());
        drop(io_tx);
        worker.join().unwrap();
        assert!(calls.lock().unwrap().is_empty());

        mgr.ws_disconnect(0x1234, "tok", ws.generation, &ws.capability);
        assert!(mgr.session_transport_active(0x1234, "tok", MODE_WT, wt.generation));
        assert_eq!(
            mgr.sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get("tok")
                .unwrap()
                .mode,
            MODE_WT
        );

        mgr.wt_disconnect(0x1234, "tok", wt.generation, &wt.capability);
        let sessions = mgr.sessions.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(sessions.get("tok").unwrap().mode, MODE_NM);
        drop(sessions);
        assert!(!wt.capability.is_valid());

        let wt2 = mgr.wt_connect(0x1234, "tok").expect("WT reconnects");
        let ws2 = mgr.ws_connect(0x1234, "tok").expect("WS connects after WT");
        assert!(!wt2.capability.is_valid());
        assert!(ws2.capability.is_valid());
        let calls = Arc::new(Mutex::new(Vec::new()));
        let (io_tx, io_rx) = mpsc::channel(1);
        let worker = spawn_io_worker(
            MockDeviceIo {
                calls: Arc::clone(&calls),
            },
            Arc::new(AtomicU64::new(0)),
            io_rx,
        );
        let (reply, result) = oneshot::channel();
        io_tx
            .blocking_send(IoCommand::FeatureRead {
                report_id: 3,
                buf_size: 8,
                reply,
                epoch: 0,
                validity: wt2.capability.validity(),
            })
            .unwrap();
        assert!(result.blocking_recv().unwrap().is_err());
        drop(io_tx);
        worker.join().unwrap();
        assert!(calls.lock().unwrap().is_empty());
        mgr.wt_disconnect(0x1234, "tok", wt2.generation, &wt2.capability);
        assert!(mgr.session_transport_active(0x1234, "tok", MODE_WS, ws2.generation));
        assert_eq!(
            mgr.sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get("tok")
                .unwrap()
                .mode,
            MODE_WS
        );
        mgr.ws_disconnect(0x1234, "tok", ws2.generation, &ws2.capability);
        let ws3 = mgr.ws_connect(0x1234, "tok").expect("WS reconnects");
        assert!(ws3.capability.is_valid());
        mgr.set_dataplane_mode(0x1234, "tok", MODE_NM, 1)
            .expect("switches to NM");
        assert!(!ws3.capability.is_valid());
        assert!(!mgr.session_transport_active(0x1234, "tok", MODE_WS, ws3.generation));
        assert_eq!(
            mgr.sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get("tok")
                .unwrap()
                .mode,
            MODE_NM
        );
    }
    #[test]
    fn test_same_mode_disconnect_is_stale_but_current_disconnect_falls_back() {
        let (tx, _) = broadcast::channel(16);
        let mgr = DeviceManager::new(tx);
        insert_active_session(&mgr, "tok", 1);

        let ws = mgr.ws_connect(0x1234, "tok").expect("WS connects");
        mgr.set_dataplane_mode(0x1234, "tok", MODE_WS, 1)
            .expect("same-mode WS transition");
        assert!(!ws.capability.is_valid());
        mgr.ws_disconnect(0x1234, "tok", ws.generation, &ws.capability);
        assert_eq!(
            mgr.sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get("tok")
                .unwrap()
                .mode,
            MODE_WS
        );

        let wt = mgr.wt_connect(0x1234, "tok").expect("WT connects");
        mgr.set_dataplane_mode(0x1234, "tok", MODE_WT, 1)
            .expect("same-mode WT transition");
        assert!(!wt.capability.is_valid());
        mgr.wt_disconnect(0x1234, "tok", wt.generation, &wt.capability);
        assert_eq!(
            mgr.sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get("tok")
                .unwrap()
                .mode,
            MODE_WT
        );

        let wt_current = mgr.wt_connect(0x1234, "tok").expect("current WT connects");
        mgr.wt_disconnect(0x1234, "tok", wt_current.generation, &wt_current.capability);
        assert_eq!(
            mgr.sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get("tok")
                .unwrap()
                .mode,
            MODE_NM
        );
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
        assert!(!grant_a.capability.is_valid());
        assert!(grant_b.capability.is_valid());
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
        let mgr = DeviceManager::new(tx.clone());
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
        let sender = tokio::spawn(crate::batching::run_sender(
            tx.subscribe(),
            0x1234,
            grant.capability.validity(),
            grant.capability.subscribe_revocation(),
            grant.cancel.clone(),
            |_frame: Vec<u8>| true,
        ));
        let reconnect = mgr.wt_connect(0x1234, "tok").expect("WT reconnects");
        tokio::task::yield_now().await;
        assert_eq!(reconnect.generation, grant.generation + 1);
        assert!(!grant.capability.is_valid());
        tokio::time::timeout(Duration::from_secs(1), sender)
            .await
            .expect("WT sender wakes after reconnect")
            .expect("WT sender does not panic");
        assert!(reconnect.capability.is_valid());
        assert!(mgr.session_transport_active(0x1234, "tok", MODE_WT, reconnect.generation));
        mgr.close(0x1234, "tok", 1).expect("close");
        assert!(!mgr.session_transport_active(0x1234, "tok", MODE_WT, reconnect.generation));
        assert!(!reconnect.capability.is_valid());
        let mut cancel = reconnect.cancel.clone();
        tokio::time::timeout(Duration::from_secs(1), cancel.changed())
            .await
            .expect("WT transport cancelled on session close")
            .expect("cancel channel still open");
    }

    /// Audit regression (HIGH): NM hot refresh and last-session teardown
    /// must linearize without resurrecting a stale I/O sender.
    #[test]
    fn test_nm_hot_refresh_serializes_with_last_close() {
        use std::sync::Barrier;

        let (tx, _) = broadcast::channel(16);
        let mgr = Arc::new(DeviceManager::new(tx));
        let calls = install_test_io_entry(&mgr, 0x1234);
        insert_active_session(&mgr, "tok", 1);
        let (sink_tx, _sink_rx) = mpsc::channel(1);
        let barrier = Arc::new(Barrier::new(3));

        let register_mgr = Arc::clone(&mgr);
        let register_barrier = Arc::clone(&barrier);
        let register = thread::spawn(move || {
            register_barrier.wait();
            register_mgr.register_nm_sink(1, sink_tx);
        });
        let close_mgr = Arc::clone(&mgr);
        let close_barrier = Arc::clone(&barrier);
        let close = thread::spawn(move || {
            close_barrier.wait();
            close_mgr.close(0x1234, "tok", 1).expect("close");
        });
        barrier.wait();
        register.join().unwrap();
        close.join().unwrap();

        assert!(
            mgr.nm_hot
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty()
        );
        assert!(
            mgr.devices
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
        assert!(calls.lock().unwrap_or_else(|e| e.into_inner()).is_empty());
    }

    /// Audit regression (HIGH): a new logical open and last-session close
    /// must leave either a live session with its physical entry or neither.
    #[tokio::test]
    async fn test_open_vs_last_close_linearized() {
        let (tx, _) = broadcast::channel(16);
        let mgr = Arc::new(DeviceManager::new_with_opener(tx, |id| {
            Err(anyhow!("device '{id:#x}' unavailable in race test"))
        }));
        install_test_io_entry(&mgr, 0x1234);
        insert_active_session(&mgr, "old", 1);

        let barrier = Arc::new(tokio::sync::Barrier::new(3));
        let open_mgr = Arc::clone(&mgr);
        let open_barrier = Arc::clone(&barrier);
        let open_task = tokio::spawn(async move {
            open_barrier.wait().await;
            open_mgr.open(0x1234, 2).await
        });
        let close_mgr = Arc::clone(&mgr);
        let close_barrier = Arc::clone(&barrier);
        let close_task = tokio::spawn(async move {
            close_barrier.wait().await;
            close_mgr.close(0x1234, "old", 1)
        });
        barrier.wait().await;
        let open_result = open_task.await.unwrap();
        close_task.await.unwrap().unwrap();

        let device_present = mgr
            .devices
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(&0x1234);
        let session_present = mgr
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .any(|session| session.device_id == 0x1234 && session.active);
        assert_eq!(device_present, session_present);
        if open_result.is_ok() {
            assert!(device_present);
        } else {
            assert!(!device_present);
        }

        let remaining: Vec<(u32, String, u64)> = mgr
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .map(|session| {
                (
                    session.device_id,
                    session.token.clone(),
                    session.owner_client_id,
                )
            })
            .collect();
        for (device_id, token, owner) in remaining {
            mgr.close(device_id, &token, owner).expect("cleanup");
        }
    }

    /// Audit regression (HIGH): force-close cannot leave a concurrent open
    /// attached to the removed physical lifetime.
    #[tokio::test]
    async fn test_force_close_races_logical_open() {
        let (tx, _) = broadcast::channel(16);
        let mgr = Arc::new(DeviceManager::new_with_opener(tx, |id| {
            Err(anyhow!("device '{id:#x}' unavailable in race test"))
        }));
        install_test_io_entry(&mgr, 0x1234);
        insert_active_session(&mgr, "old", 1);

        let barrier = Arc::new(tokio::sync::Barrier::new(3));
        let open_mgr = Arc::clone(&mgr);
        let open_barrier = Arc::clone(&barrier);
        let open_task = tokio::spawn(async move {
            open_barrier.wait().await;
            open_mgr.open(0x1234, 2).await
        });
        let close_mgr = Arc::clone(&mgr);
        let close_barrier = Arc::clone(&barrier);
        let close_task = tokio::spawn(async move {
            close_barrier.wait().await;
            close_mgr.force_close(0x1234);
        });
        barrier.wait().await;
        let _ = open_task.await.unwrap();
        close_task.await.unwrap();

        assert!(
            mgr.devices
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
        assert!(
            mgr.ws_auth_hashes
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty()
        );
        assert!(
            mgr.transport_validity
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty()
        );
        assert!(
            mgr.nm_hot
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty()
        );
    }

    /// Audit regression (HIGH): same-kind replacement revokes and wakes an
    /// idle sender without requiring another report or session close.
    #[tokio::test]
    async fn test_same_kind_reconnect_wakes_idle_sender() {
        let (tx, _) = broadcast::channel(16);
        let mgr = Arc::new(DeviceManager::new(tx.clone()));
        insert_active_session(&mgr, "tok", 1);
        let grant = mgr.ws_connect(0x1234, "tok").expect("connect");
        let sender = tokio::spawn(crate::batching::run_sender(
            tx.subscribe(),
            0x1234,
            grant.capability.validity(),
            grant.capability.subscribe_revocation(),
            grant.cancel.clone(),
            |_frame: Vec<u8>| true,
        ));

        let replacement = mgr.ws_connect(0x1234, "tok").expect("reconnect");
        assert_eq!(replacement.generation, grant.generation + 1);
        assert!(!grant.capability.is_valid());
        assert!(replacement.capability.is_valid());
        tokio::time::timeout(Duration::from_secs(1), sender)
            .await
            .expect("old sender wakes after reconnect")
            .expect("old sender does not panic");
    }

    /// Audit regression (HIGH): invalidating a transport capability must
    /// stop its sender even when the session remains in the same mode.
    #[tokio::test]
    async fn test_sender_stops_delivery_after_transport_invalidation() {
        use bytes::Bytes as ReportBytes;
        use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

        let (tx, _keepalive_rx) = broadcast::channel(64);
        let mgr = Arc::new(DeviceManager::new(tx.clone()));
        insert_active_session(&mgr, "tok", 1);
        let grant = mgr.ws_connect(0x1234, "tok").expect("connect");

        let flushed = Arc::new(AtomicUsize::new(0));
        let flushed_for_sender = Arc::clone(&flushed);
        let sender = tokio::spawn(crate::batching::run_sender(
            tx.subscribe(),
            0x1234,
            grant.capability.validity(),
            grant.capability.subscribe_revocation(),
            grant.cancel.clone(),
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
        assert!(flushed.load(AtomicOrdering::SeqCst) > 0);

        mgr.set_dataplane_mode(0x1234, "tok", MODE_WS, 1)
            .expect("invalidate transport");
        assert!(!grant.capability.is_valid());
        let late_subscriber = grant.capability.subscribe_revocation();
        assert!(*late_subscriber.borrow());
        let flushed_after = flushed.load(AtomicOrdering::SeqCst);

        tokio::time::timeout(Duration::from_secs(2), sender)
            .await
            .expect("sender exits after capability invalidation")
            .expect("sender does not panic");
        assert_eq!(flushed.load(AtomicOrdering::SeqCst), flushed_after);
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
        let sender = tokio::spawn(crate::batching::run_sender(
            tx.subscribe(),
            0x1234,
            grant_a.capability.validity(),
            grant_a.capability.subscribe_revocation(),
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
