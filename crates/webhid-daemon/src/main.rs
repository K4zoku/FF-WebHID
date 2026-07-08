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

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::args().any(|a| a == "--version" || a == "-V") {
        println!("webhid-daemon {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }

    init_logger();

    let ws_port: u16 = std::env::var("WEBHID_WS_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_WS_PORT);

    let (event_tx, _) = broadcast::channel::<IpcResponse>(EVENT_CAPACITY);

    hotplug::start(event_tx.clone());

    let device_mgr = Arc::new(DeviceManager::new(event_tx.clone()));

    {
        let event_tx_clone = event_tx.clone();
        let device_mgr_clone = Arc::clone(&device_mgr);
        tokio::spawn(async move {
            if let Err(e) = websocket::start_server(ws_port, event_tx_clone, device_mgr_clone).await {
                log::error!("WebSocket server error: {e:#}");
            }
        });
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
        log::info!("WebSocket server on port {ws_port}");

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

    #[cfg(windows)]
    {
        use tokio::net::windows::named_pipe::ServerOptions;
        let pipe_name = std::env::var("WEBHID_PIPE")
            .unwrap_or_else(|_| DEFAULT_PIPE.to_string());

        log::info!("webhid-daemon listening on {pipe_name}");
        log::info!("WebSocket server on port {ws_port}");

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
                if let Err(e) = client::handle(server, cid, mgr, rx, ws_port).await {
                    log::warn!("[client {cid}] error: {e:#}");
                }
                log::info!("[client {cid}] disconnected");
            });
        }
    }

    #[cfg(not(any(unix, windows)))]
    {
        log::info!("WebSocket server on port {ws_port}");
        log::info!("IPC not supported on this platform");
        tokio::signal::ctrl_c().await?;
        Ok(())
    }
}

fn init_logger() {
    let level = std::env::var("RUST_LOG")
        .ok()
        .and_then(|v| v.parse::<log::LevelFilter>().ok())
        .unwrap_or(log::LevelFilter::Info);
    if log::set_boxed_logger(Box::new(SimpleLogger)).is_ok() {
        log::set_max_level(level);
    }
}

struct SimpleLogger;

impl log::Log for SimpleLogger {
    fn enabled(&self, _: &log::Metadata) -> bool {
        true
    }
    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            eprintln!("[{:5} {}] {}", record.level(), record.target(), record.args());
        }
    }
    fn flush(&self) {}
}
