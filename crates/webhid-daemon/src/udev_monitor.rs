//! Watches udev for hidraw add/remove events and broadcasts them to all
//! connected clients via a [`tokio::sync::broadcast`] channel.
//!
//! The `udev::MonitorSocket` wraps a raw pointer and is therefore not `Send`.
//! We work around this by creating it *inside* the background OS thread, so
//! no cross-thread transfer ever happens.

use std::os::unix::io::AsRawFd;

use tokio::sync::broadcast;
use webhid::IpcResponse;

use crate::hid;

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
                    IpcResponse::DeviceConnected { id: 0, device: info }
                }
                udev::EventType::Remove => {
                    // For remove, we can't query hidapi (device gone).
                    // Build a minimal DeviceInfo with just the path-derived device_id.
                    log::info!("device disconnected: {}", devnode);
                    let info = webhid::DeviceInfo {
                        vendor_id: 0, product_id: 0,
                        product_name: None, manufacturer: None, serial_number: None,
                        usage_page: None, usage: None,
                        device_id: devnode,
                        report_descriptor: None, collections: None,
                    };
                    IpcResponse::DeviceDisconnected { id: 0, device: info }
                }
                _ => continue,
            };
            if event_tx.send(response).is_err() {
                log::debug!("no receivers for udev event");
            }
        }
    }
}
