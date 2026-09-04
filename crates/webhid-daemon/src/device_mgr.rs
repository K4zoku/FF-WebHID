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
    /// reader stops when `stop_flag` is set, sends active NM sessions directly
    /// to their `nm_hot` sinks, and publishes unblocked reports to the event
    /// bus only when non-NM sessions are active.
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
#[path = "tests/device_mgr.rs"]
mod tests;
