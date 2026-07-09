mod client;
mod descriptor;
mod device_mgr;
mod hid;
mod hotplug;
mod websocket;

use std::sync::Arc;

#[cfg(unix)]
use anyhow::Context as _;
use tokio::sync::broadcast;
use webhid::IpcResponse;

use device_mgr::DeviceManager;

const DEFAULT_WS_PORT: u16 = 31337;
const EVENT_CAPACITY: usize = 8192;

#[cfg(target_os = "linux")]
const DEFAULT_SOCKET: &str = "/run/webhid/webhid.sock";
#[cfg(target_os = "macos")]
const DEFAULT_SOCKET: &str = "/tmp/webhid.sock";

#[cfg(unix)]
fn resolve_socket_path() -> String {
    if let Ok(path) = std::env::var("WEBHID_SOCKET") {
        return path;
    }
    #[cfg(target_os = "linux")]
    if unsafe { libc::geteuid() } != 0 {
        if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
            if !dir.is_empty() {
                return format!("{dir}/webhid/webhid.sock");
            }
        }
        let uid = unsafe { libc::getuid() };
        return format!("/run/user/{uid}/webhid/webhid.sock");
    }
    DEFAULT_SOCKET.to_string()
}

#[cfg(unix)]
fn socket_mode(path: &str) -> u32 {
    if path.starts_with("/run/user/") || path.contains("/run/user/") {
        0o600
    } else {
        0o666
    }
}

#[cfg(target_os = "windows")]
const DEFAULT_PIPE: &str = r"\\.\pipe\webhid";

fn detect_nm_host_mode() -> Option<(String, String)> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        return None;
    }
    let manifest_path = &args[1];
    let addon_id = &args[2];

    if manifest_path.starts_with('-') || addon_id.starts_with('-') {
        return None;
    }
    let p = std::path::Path::new(manifest_path);
    if !p.is_file() {
        return None;
    }
    Some((manifest_path.clone(), addon_id.clone()))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::args().any(|a| a == "--version" || a == "-V") {
        println!("webhid-daemon {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }

    webhid::logging::init_logger();

    // NM-host mode: daemon acts as the native messaging host directly,
    // speaking the NM protocol on stdin/stdout (no separate NM host binary,
    // no IPC socket). This eliminates 1 IPC hop + 2 copies per frame.
    // Requires the daemon to run as the user (with udev rules for hidraw).
    // WS port is random to avoid conflicts with a root daemon instance.
    //
    // Detection is based on the 2 positional args Firefox passes to every
    // native-messaging host (manifest path + addon ID), per the Mozilla spec.
    // See `detect_nm_host_mode` above.
    let nm_host_info = detect_nm_host_mode();
    let nm_host_mode = nm_host_info.is_some();

    let ws_port: u16 = if nm_host_mode {
        // Bind to port 0 → OS assigns a random free port.
        // We'll read it back after binding.
        0
    } else {
        std::env::var("WEBHID_WS_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(DEFAULT_WS_PORT)
    };

    let (event_tx, _) = broadcast::channel::<IpcResponse>(EVENT_CAPACITY);

    hotplug::start(event_tx.clone());

    let device_mgr = Arc::new(DeviceManager::new(event_tx.clone()));

    // Start WS server and get the actual bound port.
    let actual_ws_port = {
        let event_tx_clone = event_tx.clone();
        let device_mgr_clone = Arc::clone(&device_mgr);
        let (port_tx, port_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            match websocket::start_server(ws_port, event_tx_clone, device_mgr_clone, Some(port_tx)).await {
                Ok(_) => {}
                Err(e) => log::error!("WebSocket server error: {e:#}"),
            }
        });
        port_rx.await.unwrap_or(DEFAULT_WS_PORT)
    };

    if let Some((manifest_path, addon_id)) = &nm_host_info {
        log::info!("running in NM-host mode (stdin/stdout, no IPC socket)");
        log::info!("started by add-on '{addon_id}' (manifest: {manifest_path})");
        log::info!("WebSocket server on port {actual_ws_port} (random)");

        // In NM-host mode, stdin/stdout ARE the IPC channel.
        // The daemon reads NmRequest from stdin and writes NmResponse to stdout,
        // exactly like the thin forwarder did — but without the extra hop.
        // stdin only implements AsyncRead and stdout only implements AsyncWrite,
        // so we pass them directly as separate halves (no `tokio::io::split`).
        let stdin = tokio::io::stdin();
        let stdout = tokio::io::stdout();
        let rx = event_tx.subscribe();
        let cid = 0; // single client in NM-host mode
        client::handle(stdin, stdout, cid, device_mgr, rx, actual_ws_port).await?;
        return Ok(());
    }

    #[cfg(unix)]
    {
        use tokio::net::UnixListener;
        let socket_path = resolve_socket_path();

        if let Some(parent) = std::path::Path::new(&socket_path).parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create socket dir '{}'", parent.display()))?;
        }
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path)
            .with_context(|| format!("bind '{socket_path}'"))?;

        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(socket_mode(&socket_path)))
                .context("set socket permissions")?;
        }

        log::info!("webhid-daemon listening on {socket_path}");
        log::info!("WebSocket server on port {actual_ws_port}");

        let mut next_client_id: u64 = 0;
        loop {
            match listener.accept().await {
                Ok((stream, _addr)) => {
                    next_client_id += 1;
                    let cid = next_client_id;
                    let mgr = Arc::clone(&device_mgr);
                    let rx = event_tx.subscribe();
                    tokio::spawn(async move {
                        log::info!("[client {cid}] connected");
                        let (reader, writer) = tokio::io::split(stream);
                        if let Err(e) = client::handle(reader, writer, cid, mgr, rx, actual_ws_port).await {
                            log::warn!("[client {cid}] error: {e:#}");
                        }
                        log::info!("[client {cid}] disconnected");
                    });
                }
                Err(e) => log::error!("accept error: {e}"),
            }
        }
    }

    #[cfg(windows)]
    {
        use tokio::net::windows::named_pipe::ServerOptions;
        let pipe_name = std::env::var("WEBHID_PIPE")
            .unwrap_or_else(|_| DEFAULT_PIPE.to_string());

        log::info!("webhid-daemon listening on {pipe_name}");
        log::info!("WebSocket server on port {actual_ws_port}");

        let mut next_client_id: u64 = 0;
        loop {
            let server = ServerOptions::new()
                .first_pipe_instance(true)
                .create(&pipe_name)?;

            server.connect().await?;
            next_client_id += 1;
            let cid = next_client_id;
            let mgr = Arc::clone(&device_mgr);
            let rx = event_tx.subscribe();
            tokio::spawn(async move {
                log::info!("[client {cid}] connected");
                let (reader, writer) = tokio::io::split(server);
                if let Err(e) = client::handle(reader, writer, cid, mgr, rx, actual_ws_port).await {
                    log::warn!("[client {cid}] error: {e:#}");
                }
                log::info!("[client {cid}] disconnected");
            });
        }
    }

    #[cfg(not(any(unix, windows)))]
    {
        log::info!("WebSocket server on port {actual_ws_port}");
        log::info!("IPC not supported on this platform");
        tokio::signal::ctrl_c().await?;
        Ok(())
    }
}


