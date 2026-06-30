mod client;
mod device_mgr;
mod hid;
mod udev_monitor;
mod websocket;

use std::sync::Arc;

use anyhow::Context as _;
use tokio::net::UnixListener;
use tokio::sync::broadcast;
use webhid::IpcResponse;

use device_mgr::DeviceManager;

const DEFAULT_SOCKET: &str = "/run/webhid/webhid.sock";
const DEFAULT_WS_PORT: u16 = 31337;
/// How many broadcast slots for device events before receivers start lagging.
const EVENT_CAPACITY: usize = 8192;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    env_logger::Builder::from_default_env()
        .filter_level(log::LevelFilter::Info)
        .init();

    let socket_path = std::env::var("WEBHID_SOCKET")
        .unwrap_or_else(|_| DEFAULT_SOCKET.to_string());
    let ws_port: u16 = std::env::var("WEBHID_WS_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_WS_PORT);

    // Ensure the parent directory exists (e.g. /run/webhid/).
    if let Some(parent) = std::path::Path::new(&socket_path).parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create socket dir '{}'", parent.display()))?;
    }

    // Remove a stale socket from a previous run.
    let _ = std::fs::remove_file(&socket_path);

    let listener = UnixListener::bind(&socket_path)
        .with_context(|| format!("bind '{socket_path}'"))?;

    // Allow any local user to connect so the (unprivileged) native-messaging
    // process can reach the (root) daemon.
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o666))
            .context("set socket permissions")?;
    }

    log::info!("webhid-daemon listening on {socket_path}");
    log::info!("webhid-daemon WebSocket server on port {ws_port}");

    // Shared event bus: daemon → all connected clients.
    let (event_tx, _) = broadcast::channel::<IpcResponse>(EVENT_CAPACITY);

    // Start udev hot-plug monitor in a background OS thread.
    udev_monitor::start(event_tx.clone()).context("start udev monitor")?;

    // Shared device manager.
    let device_mgr = Arc::new(DeviceManager::new(event_tx.clone()));

    // Spawn WebSocket server
    {
        let event_tx_clone = event_tx.clone();
        let device_mgr_clone = Arc::clone(&device_mgr);
        tokio::spawn(async move {
            if let Err(e) = websocket::start_server(ws_port, event_tx_clone, device_mgr_clone).await {
                log::error!("WebSocket server error: {e:#}");
            }
        });
    }

    let mut next_client_id: u64 = 0;
    loop {
        match listener.accept().await {
            Ok((stream, _addr)) => {
                next_client_id += 1;
                let cid = next_client_id;
                let mgr = Arc::clone(&device_mgr);
                let rx = event_tx.subscribe();
                let ws_port = ws_port;
                tokio::spawn(async move {
                    log::info!("[client {cid}] connected");
                    if let Err(e) = client::handle(stream, cid, mgr, rx, ws_port).await {
                        log::warn!("[client {cid}] error: {e:#}");
                    }
                    log::info!("[client {cid}] disconnected");
                });
            }
            Err(e) => log::error!("accept error: {e}"),
        }
    }
}
