use std::collections::HashMap;
use std::os::unix::io::AsRawFd;
use std::sync::Mutex;

use tokio::sync::broadcast;
use webhid::IpcResponse;

use crate::hid;

static DEVICE_CACHE: Mutex<Option<HashMap<String, webhid::DeviceInfo>>> = Mutex::new(None);

pub fn start(event_tx: broadcast::Sender<IpcResponse>) -> anyhow::Result<()> {
    std::thread::Builder::new()
        .name("udev-monitor".into())
        .spawn(move || {
            let socket = match udev::MonitorBuilder::new()
                .and_then(|b| b.match_subsystem("hidraw"))
                .and_then(|b| b.listen())
            {
                Ok(s) => s,
                Err(e) => {
                    log::error!("failed to create udev monitor: {e}");
                    return;
                }
            };
            run(socket, event_tx);
        })?;
    Ok(())
}

fn run(socket: udev::MonitorSocket, event_tx: broadcast::Sender<IpcResponse>) {
    let fd = socket.as_raw_fd();
    loop {
        let mut pfd = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
        let ret = unsafe { libc::poll(&mut pfd as *mut _, 1, -1) };
        if ret <= 0 { continue; }

        for event in socket.iter() {
            let devnode = match event.device().devnode().and_then(|p| p.to_str()) {
                Some(p) => p.to_string(),
                None => continue,
            };
            let response = match event.event_type() {
                udev::EventType::Add => {
                    let Some(info) = hid::info_by_raw_path(&devnode) else { continue };
                    log::info!("device connected: {:04x}:{:04x} ({})", info.vendor_id, info.product_id, info.device_id);
                    let mut cache = DEVICE_CACHE.lock().unwrap();
                    let cache = cache.get_or_insert_with(HashMap::new);
                    cache.insert(devnode, info.clone());
                    IpcResponse::DeviceConnected { id: 0, device: info }
                }
                udev::EventType::Remove => {
                    let mut cache = DEVICE_CACHE.lock().unwrap();
                    let info = cache.as_mut().and_then(|c| c.remove(&devnode));
                    match info {
                        Some(i) => {
                            log::info!("device disconnected: {:04x}:{:04x} ({})", i.vendor_id, i.product_id, i.device_id);
                            IpcResponse::DeviceDisconnected { id: 0, device: i }
                        }
                        None => {
                            log::warn!("device disconnected (unknown, no cached info): {}", devnode);
                            continue;
                        }
                    }
                }
                _ => continue,
            };
            if event_tx.send(response).is_err() {
                log::debug!("no receivers for udev event");
            }
        }
    }
}
