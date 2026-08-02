mod batching;
mod blocklist;
mod client;
mod descriptor;
mod device_mgr;
mod hid;
mod hotplug;
mod security;
mod websocket;
mod webtransport;

use std::sync::Arc;

#[cfg(unix)]
use anyhow::Context as _;
use tokio::sync::broadcast;
use webhid::IpcResponse;

use device_mgr::DeviceManager;

const DEFAULT_WS_PORT: u16 = 0;
const EVENT_CAPACITY: usize = 8192;

#[cfg(target_os = "macos")]
const DEFAULT_SOCKET: &str = "/tmp/webhid.sock";

#[cfg(unix)]
fn validate_socket_path(path: &str) -> String {
    #[cfg(target_os = "linux")]
    {
        if path.starts_with('@') {
            return path.to_string();
        }
    }
    let p = std::path::Path::new(path);
    if !p.is_absolute() {
        panic!("WEBHID_SOCKET must be an absolute path");
    }
    if path.contains("..") {
        panic!("WEBHID_SOCKET must not contain '..'");
    }
    path.to_string()
}

#[cfg(unix)]
fn resolve_socket_path() -> String {
    if let Ok(path) = std::env::var("WEBHID_SOCKET") {
        return validate_socket_path(&path);
    }
    #[cfg(target_os = "linux")]
    {
        if unsafe { libc::geteuid() } == 0 {
            // Root/system daemon: abstract socket (no filesystem entry → no symlink attack)
            return "@webhid".to_string();
        }
        // User-mode: filesystem socket (parent dir is 0700, no cross-user symlink risk)
        if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
            if !dir.is_empty() {
                let p = std::path::Path::new(&dir);
                if p.is_absolute() && !dir.contains("..") {
                    return format!("{dir}/webhid/webhid.sock");
                }
            }
        }
        let uid = unsafe { libc::getuid() };
        return format!("/run/user/{uid}/webhid/webhid.sock");
    }
    #[cfg(not(target_os = "linux"))]
    DEFAULT_SOCKET.to_string()
}

#[cfg(unix)]
fn socket_mode(path: &str) -> u32 {
    if path.starts_with("/run/user/") || path.contains("/run/user/") {
        0o600
    } else {
        0o660
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

    #[cfg(feature = "hardening")]
    {
        webhid::security::apply_prctl_hardening();
        webhid::security::apply_seccomp_filter(crate::security::DAEMON_SYSCALLS);
    }

    let nm_host_info = detect_nm_host_mode();
    let nm_host_mode = nm_host_info.is_some();

    let ws_port: u16 = if nm_host_mode {
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

    let actual_ws_port = {
        let event_tx_clone = event_tx.clone();
        let device_mgr_clone = Arc::clone(&device_mgr);
        let (port_tx, port_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            match websocket::start_server(ws_port, event_tx_clone, device_mgr_clone, Some(port_tx))
                .await
            {
                Ok(_) => {}
                Err(e) => log::error!("WebSocket server error: {e:#}"),
            }
        });
        port_rx.await.unwrap_or(DEFAULT_WS_PORT)
    };

    let wt_state = Arc::new(webtransport::WtState::new(
        event_tx.clone(),
        Arc::clone(&device_mgr),
    ));
    {
        let (wt_ready_tx, wt_ready_rx) = tokio::sync::oneshot::channel();
        wt_state.init(wt_ready_tx);
        match wt_ready_rx.await {
            Ok((wt_port, _hash)) => {
                log::info!("WebTransport server on port {wt_port}");
            }
            Err(_) => {
                log::error!("WebTransport server failed to start; WT data plane unavailable");
            }
        }
    }

    if let Some((manifest_path, addon_id)) = &nm_host_info {
        log::info!("running in NM-host mode (stdin/stdout, no IPC socket)");
        log::info!("started by add-on '{addon_id}' (manifest: {manifest_path})");
        log::info!("WebSocket server on port {actual_ws_port} (random)");

        let stdin = tokio::io::stdin();
        let stdout = tokio::io::stdout();
        let rx = event_tx.subscribe();
        client::handle(
            stdin,
            stdout,
            device_mgr,
            rx,
            actual_ws_port,
            Arc::clone(&wt_state),
        )
        .await?;
        return Ok(());
    }

    #[cfg(unix)]
    {
        use tokio::net::UnixListener;
        let socket_path = resolve_socket_path();

        let listener = if socket_path.starts_with('@') {
            #[cfg(target_os = "linux")]
            {
                use std::os::linux::net::SocketAddrExt;
                use std::os::unix::net::SocketAddr;
                let name = socket_path[1..].as_bytes();
                let addr = SocketAddr::from_abstract_name(name).with_context(|| {
                    format!("invalid abstract socket name '{}'", &socket_path[1..])
                })?;
                let std_listener = std::os::unix::net::UnixListener::bind_addr(&addr)
                    .with_context(|| format!("bind abstract socket '{socket_path}'"))?;
                std_listener.set_nonblocking(true)?;
                UnixListener::from_std(std_listener)?
            }
            #[cfg(not(target_os = "linux"))]
            {
                anyhow::bail!("abstract sockets are not supported on this platform");
            }
        } else {
            if let Some(parent) = std::path::Path::new(&socket_path).parent() {
                std::fs::create_dir_all(parent)
                    .with_context(|| format!("create socket dir '{}'", parent.display()))?;
            }
            let _ = std::fs::remove_file(&socket_path);
            let listener = UnixListener::bind(&socket_path)
                .with_context(|| format!("bind '{socket_path}'"))?;
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(
                    &socket_path,
                    std::fs::Permissions::from_mode(socket_mode(&socket_path)),
                )
                .context("set socket permissions")?;
            }
            listener
        };

        log::info!("webhid-daemon listening on {socket_path}");
        log::info!("WebSocket server on port {actual_ws_port}");

        loop {
            match listener.accept().await {
                Ok((stream, _addr)) => {
                    #[cfg(target_os = "linux")]
                    if !security::verify_peer(&stream) {
                        log::warn!("[client] rejected: peer not in webhid group");
                        continue;
                    }
                    let mgr = Arc::clone(&device_mgr);
                    let rx = event_tx.subscribe();
                    let wt_state_for_client = Arc::clone(&wt_state);
                    tokio::spawn(async move {
                        log::info!("[client] connected");
                        let (reader, writer) = tokio::io::split(stream);
                        if let Err(e) = client::handle(
                            reader,
                            writer,
                            mgr,
                            rx,
                            actual_ws_port,
                            wt_state_for_client,
                        )
                        .await
                        {
                            log::warn!("[client] error: {e:#}");
                        }
                        log::info!("[client] disconnected");
                    });
                }
                Err(e) => log::error!("accept error: {e}"),
            }
        }
    }

    #[cfg(windows)]
    {
        use tokio::net::windows::named_pipe::ServerOptions;
        let pipe_name = match std::env::var("WEBHID_PIPE") {
            Ok(name) if name.starts_with(r"\\.\pipe\") && !name[8..].contains('\\') => name,
            _ => DEFAULT_PIPE.to_string(),
        };

        log::info!("webhid-daemon listening on {pipe_name}");
        log::info!("WebSocket server on port {actual_ws_port}");

        loop {
            let server = ServerOptions::new()
                .first_pipe_instance(true)
                .create(&pipe_name)?;

            server.connect().await?;
            let mgr = Arc::clone(&device_mgr);
            let rx = event_tx.subscribe();
            let wt_state_for_client = Arc::clone(&wt_state);
            tokio::spawn(async move {
                log::info!("[client] connected");
                let (reader, writer) = tokio::io::split(server);
                if let Err(e) =
                    client::handle(reader, writer, mgr, rx, actual_ws_port, wt_state_for_client)
                        .await
                {
                    log::warn!("[client] error: {e:#}");
                }
                log::info!("[client] disconnected");
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
