//! Watches udev for hidraw add/remove events and broadcasts them to all
//! connected clients via a [`tokio::sync::broadcast`] channel.
//!
//! The `udev::MonitorSocket` wraps a raw pointer and is therefore not `Send`.
//! We work around this by creating it *inside* the background OS thread, so
//! no cross-thread transfer ever happens.
//!
//! The socket is non-blocking by default; we use `poll(2)` to block until
//! an event arrives before draining with `socket.iter()`.

use std::os::unix::io::AsRawFd;

use tokio::sync::broadcast;
use webhid::IpcResponse;

use crate::hid::info_from_device;

/// Spawn a background OS thread that blocks on the udev socket and forwards
/// device connect/disconnect events to `event_tx`.
pub fn start(event_tx: broadcast::Sender<IpcResponse>) -> anyhow::Result<()> {
    std::thread::Builder::new()
        .name("udev-monitor".into())
        .spawn(move || {
            // Create everything inside the thread – MonitorSocket is !Send.
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
        // Block until the kernel has at least one event ready.
        let mut pfd = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
        // SAFETY: valid pollfd; fd is open for the lifetime of socket.
        let ret = unsafe { libc::poll(&mut pfd as *mut _, 1, -1 /* infinite */) };
        if ret <= 0 {
            // Interrupted by a signal or error – just retry.
            continue;
        }

        // Drain all events that are currently queued.
        for event in socket.iter() {
            let response = match event.event_type() {
                udev::EventType::Add => {
                    let Some(info) = info_from_device(&event.device()) else { continue };
                    log::info!(
                        "device connected: {:04x}:{:04x} ({})",
                        info.vendor_id, info.product_id, info.path
                    );
                    IpcResponse::DeviceConnected { id: 0, device: info }
                }
                udev::EventType::Remove => {
                    let Some(info) = info_from_device(&event.device()) else { continue };
                    log::info!(
                        "device disconnected: {:04x}:{:04x} ({})",
                        info.vendor_id, info.product_id, info.path
                    );
                    IpcResponse::DeviceDisconnected { id: 0, device: info }
                }
                _ => continue,
            };

            // If there are no receivers the send returns Err – that's fine,
            // we keep monitoring in case a new client connects later.
            if event_tx.send(response).is_err() {
                log::debug!("no receivers for udev event (no clients connected)");
            }
        }
    }
}
