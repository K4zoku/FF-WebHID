use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use anyhow::Context as _;
use bytes::Bytes;
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio::task::JoinHandle;
use wtransport::endpoint::IncomingSession;
use wtransport::endpoint::endpoint_side::Server;
use wtransport::tls::self_signed::time::Duration as TimeDuration;
use wtransport::{Connection, Endpoint, Identity, ServerConfig};

use crate::batching;
use crate::device_mgr::DeviceManager;

const DEFAULT_CERT_VALIDITY_SECS: u64 = 14 * 24 * 60 * 60;

struct WtGeneration {
    port: u16,
    cert_hash_hex: String,
    not_after: SystemTime,
    _handle: JoinHandle<()>,
}

impl WtGeneration {
    fn expired(&self) -> bool {
        SystemTime::now() >= self.not_after
    }
}

pub struct WtState {
    event_tx: broadcast::Sender<webhid::IpcResponse>,
    device_mgr: Arc<DeviceManager>,
    current: Mutex<Option<WtGeneration>>,
}

impl WtState {
    pub fn new(
        event_tx: broadcast::Sender<webhid::IpcResponse>,
        device_mgr: Arc<DeviceManager>,
    ) -> Self {
        Self {
            event_tx,
            device_mgr,
            current: Mutex::new(None),
        }
    }

    pub fn init(&self, readiness: oneshot::Sender<(u16, String)>) {
        match self.ensure_current() {
            Some(info) => {
                let _ = readiness.send(info);
            }
            None => {
                log::error!("[wt] WebTransport server failed to start; WT data plane unavailable");
            }
        }
    }

    pub fn ensure_current(&self) -> Option<(u16, String)> {
        let mut cur = self.current.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(g) = cur.as_ref() {
            if !g.expired() {
                return Some((g.port, g.cert_hash_hex.clone()));
            }
            log::info!(
                "[wt] generation port={} expired; rotating to a new port",
                g.port
            );
        }
        let g = match self.spawn_generation() {
            Ok(new_gen) => new_gen,
            Err(e) => {
                log::error!("[wt] failed to start generation: {e:#}");
                return None;
            }
        };
        let info = (g.port, g.cert_hash_hex.clone());
        *cur = Some(g);
        Some(info)
    }

    fn spawn_generation(&self) -> anyhow::Result<WtGeneration> {
        let validity_secs = std::env::var("WEBHID_WT_CERT_VALIDITY_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(DEFAULT_CERT_VALIDITY_SECS);
        let identity = build_identity(validity_secs)?;
        let cert_hash_hex = hex::encode(identity.certificate_chain().as_slice()[0].hash().as_ref());
        let config = ServerConfig::builder()
            .with_bind_address("127.0.0.1:0".parse().context("parse WT bind address")?)
            .with_identity(identity)
            .build();
        let endpoint = Endpoint::server(config).context("create WT endpoint")?;
        let port = endpoint.local_addr().context("get WT local addr")?.port();
        let not_after = SystemTime::now() + Duration::from_secs(validity_secs);
        let active = Arc::new(AtomicUsize::new(0));
        let handle = tokio::spawn(accept_loop(
            endpoint,
            not_after,
            Arc::clone(&active),
            self.event_tx.clone(),
            Arc::clone(&self.device_mgr),
        ));
        log::info!("[wt] server listening on 127.0.0.1:{port} (cert validity {validity_secs}s)");
        Ok(WtGeneration {
            port,
            cert_hash_hex,
            not_after,
            _handle: handle,
        })
    }
}

fn build_identity(validity_secs: u64) -> anyhow::Result<Identity> {
    Identity::self_signed_builder()
        .subject_alt_names(["127.0.0.1"])
        .from_now_utc()
        .offset_from_not_before(TimeDuration::seconds(validity_secs as i64))
        .build()
        .context("generate self-signed identity")
}

struct ActiveGuard(Arc<AtomicUsize>);

impl ActiveGuard {
    fn new(counter: Arc<AtomicUsize>) -> Self {
        counter.fetch_add(1, Ordering::SeqCst);
        Self(counter)
    }
}

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

async fn accept_loop(
    endpoint: Endpoint<Server>,
    not_after: SystemTime,
    active: Arc<AtomicUsize>,
    event_tx: broadcast::Sender<webhid::IpcResponse>,
    device_mgr: Arc<DeviceManager>,
) {
    loop {
        if SystemTime::now() >= not_after {
            if active.load(Ordering::SeqCst) == 0 {
                log::info!("[wt] generation expired and drained; stopping accept loop");
                break;
            }
            let incoming = tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(100)) => None,
                incoming = endpoint.accept() => Some(incoming),
            };
            if let Some(incoming) = incoming {
                tokio::spawn(async move {
                    match incoming.await {
                        Ok(req) => {
                            log::warn!("[wt] rejecting session on expired generation");
                            req.not_found().await;
                        }
                        Err(e) => log::debug!("[wt] incoming session error: {e}"),
                    }
                });
            }
            continue;
        }
        let incoming = endpoint.accept().await;
        let active_clone = Arc::clone(&active);
        let event_tx_clone = event_tx.clone();
        let mgr_clone = Arc::clone(&device_mgr);
        tokio::spawn(async move {
            let _guard = ActiveGuard::new(active_clone);
            if let Err(e) = handle_session(incoming, event_tx_clone, mgr_clone).await {
                log::warn!("[wt] session error: {e}");
            }
        });
    }
}

async fn handle_session(
    incoming: IncomingSession,
    event_tx: broadcast::Sender<webhid::IpcResponse>,
    device_mgr: Arc<DeviceManager>,
) -> anyhow::Result<()> {
    let req = incoming.await?;
    let hash = req.path().trim_start_matches('/').to_string();
    if hash.len() != 64 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        log::warn!("[wt] invalid auth hash in path");
        req.not_found().await;
        return Ok(());
    }
    let (device_id, session_token) = match device_mgr.get_device_by_ws_auth(&hash) {
        Some(v) => v,
        None => {
            log::warn!("[wt] unknown auth hash; rejecting session");
            req.not_found().await;
            return Ok(());
        }
    };
    log::info!("[wt] authenticated for device_id={device_id:#x}");
    let conn = req.accept().await?;
    let wt_gen = device_mgr.wt_connect(device_id, &session_token);
    let result = run_session(
        conn,
        event_tx,
        Arc::clone(&device_mgr),
        device_id,
        session_token.clone(),
        wt_gen,
    )
    .await;
    device_mgr.wt_disconnect(device_id, &session_token, wt_gen);
    result
}

async fn run_session(
    conn: Connection,
    event_tx: broadcast::Sender<webhid::IpcResponse>,
    device_mgr: Arc<DeviceManager>,
    device_id: u32,
    _session_token: String,
    _wt_gen: u64,
) -> anyhow::Result<()> {
    let (frame_tx, frame_rx) = mpsc::unbounded_channel::<Bytes>();

    let writer_conn = conn.clone();
    let writer_task = tokio::spawn(async move {
        let mut rx = frame_rx;
        while let Some(frame) = rx.recv().await {
            let (mut send, _recv) = match writer_conn.open_bi().await {
                Ok(opening) => match opening.await {
                    Ok(pair) => pair,
                    Err(_) => break,
                },
                Err(_) => break,
            };
            if send.write_all(&frame).await.is_err() {
                break;
            }
            if send.finish().await.is_err() {
                break;
            }
        }
    });

    let event_rx = event_tx.subscribe();
    let flush_tx = frame_tx.clone();
    let sender_task = tokio::spawn(batching::run_sender(
        event_rx,
        device_id,
        move |frame: Vec<u8>| flush_tx.send(Bytes::from(frame)).is_ok(),
    ));

    loop {
        match conn.accept_bi().await {
            Ok((_send, mut recv)) => {
                let frame_tx2 = frame_tx.clone();
                let mgr = Arc::clone(&device_mgr);
                tokio::spawn(async move {
                    let mut buf: Vec<u8> = Vec::new();
                    let mut chunk = [0u8; 4096];
                    loop {
                        match recv.read(&mut chunk).await {
                            Ok(Some(n)) => buf.extend_from_slice(&chunk[..n]),
                            Ok(None) => break,
                            Err(_) => return,
                        }
                    }
                    if buf.is_empty() {
                        return;
                    }
                    batching::handle_client_message(&buf, &mgr, device_id, move |resp| {
                        let _ = frame_tx2.send(Bytes::from(resp));
                    })
                    .await;
                });
            }
            Err(e) => {
                log::debug!("[wt] accept_bi error: {e}; session ending");
                break;
            }
        }
    }

    drop(frame_tx);
    sender_task.abort();
    writer_task.await.ok();
    Ok(())
}
