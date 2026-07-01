use tokio::sync::broadcast;
use webhid::IpcResponse;

pub fn start(event_tx: broadcast::Sender<IpcResponse>) {
    #[cfg(target_os = "linux")]
    {
        if let Err(e) = start_udev(event_tx) {
            log::error!("failed to start udev monitor: {e}");
        }
    }
    #[cfg(target_os = "macos")]
    {
        std::thread::Builder::new()
            .name("hidapi-poll".into())
            .spawn(move || poll_loop(event_tx))
            .ok();
    }
    #[cfg(target_os = "windows")]
    {
        std::thread::Builder::new()
            .name("hidapi-poll".into())
            .spawn(move || poll_loop(event_tx))
            .ok();
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = event_tx;
        log::warn!("hot-plug not supported on this platform");
    }
}

#[cfg(target_os = "linux")]
fn start_udev(event_tx: broadcast::Sender<IpcResponse>) -> anyhow::Result<()> {
    use std::collections::HashMap;
    use std::os::unix::io::AsRawFd;
    use std::sync::Mutex;

    static DEVICE_CACHE: Mutex<Option<HashMap<String, webhid::DeviceInfo>>> = Mutex::new(None);

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

            if let Ok(devices) = crate::hid::enumerate() {
                let mut cache = DEVICE_CACHE.lock().unwrap();
                let cache = cache.get_or_insert_with(HashMap::new);
                for d in devices {
                    cache.insert(d.device_id.clone(), d);
                }
            }

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
                            let Some(info) = crate::hid::info_by_raw_path(&devnode) else { continue };
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
                                None => { continue; }
                            }
                        }
                        _ => continue,
                    };
                    if event_tx.send(response).is_err() {
                        log::debug!("no receivers for udev event");
                    }
                }
            }
        })?;
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn poll_loop(event_tx: broadcast::Sender<IpcResponse>) {
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::time::Duration;

    static DEVICE_CACHE: Mutex<Option<HashMap<String, webhid::DeviceInfo>>> = Mutex::new(None);

    // Initial populate
    {
        let mut cache = DEVICE_CACHE.lock().unwrap();
        let cache = cache.get_or_insert_with(HashMap::new);
        if let Ok(devices) = crate::hid::enumerate() {
            for d in devices {
                cache.insert(d.device_id.clone(), d);
            }
        }
    }

    loop {
        std::thread::sleep(Duration::from_secs(2));

        let current: HashMap<String, webhid::DeviceInfo> = match crate::hid::enumerate() {
            Ok(devs) => devs.into_iter().map(|d| (d.device_id.clone(), d)).collect(),
            Err(_) => continue,
        };

        let mut cache = DEVICE_CACHE.lock().unwrap();
        let cache = cache.get_or_insert_with(HashMap::new);

        // Detect new devices
        let new_ids: Vec<_> = current.keys().filter(|id| !cache.contains_key(*id)).cloned().collect();
        for id in &new_ids {
            if let Some(info) = current.get(id) {
                log::info!("device connected: {:04x}:{:04x} ({})", info.vendor_id, info.product_id, info.device_id);
                let _ = event_tx.send(IpcResponse::DeviceConnected { id: 0, device: info.clone() });
            }
        }

        // Detect removed devices
        let removed_ids: Vec<_> = cache.keys().filter(|id| !current.contains_key(*id)).cloned().collect();
        for id in &removed_ids {
            if let Some(info) = cache.get(id) {
                log::info!("device disconnected: {:04x}:{:04x} ({})", info.vendor_id, info.product_id, info.device_id);
                let _ = event_tx.send(IpcResponse::DeviceDisconnected { id: 0, device: info.clone() });
            }
        }

        cache.retain(|id, _| current.contains_key(id));
        for (id, info) in current {
            cache.insert(id, info);
        }
    }
}
