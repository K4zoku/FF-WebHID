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
            .name("iohid-monitor".into())
            .spawn(move || run_macos(event_tx))
            .ok();
    }
    #[cfg(target_os = "windows")]
    {
        std::thread::Builder::new()
            .name("devnotify".into())
            .spawn(move || run_windows(event_tx))
            .ok();
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = event_tx;
        log::warn!("hot-plug not supported on this platform");
    }
}

// =====================================================================
// Linux: udev
// =====================================================================

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

// =====================================================================
// Windows: RegisterDeviceNotification + WM_DEVICECHANGE
// =====================================================================

#[cfg(target_os = "windows")]
fn run_windows(event_tx: broadcast::Sender<IpcResponse>) {
    use std::collections::HashMap;
    use std::sync::Mutex;
    use windows::Win32::UI::WindowsAndMessaging::*;
    use windows::Win32::Foundation::*;
    use windows::core::*;

    static DEVICE_CACHE: Mutex<Option<HashMap<String, webhid::DeviceInfo>>> = Mutex::new(None);

    fn refresh_and_diff(event_tx: &broadcast::Sender<IpcResponse>) {
        let current: HashMap<String, webhid::DeviceInfo> = match crate::hid::enumerate() {
            Ok(devs) => devs.into_iter().map(|d| (d.device_id.clone(), d)).collect(),
            Err(_) => return,
        };
        let mut cache = DEVICE_CACHE.lock().unwrap();
        let cache = cache.get_or_insert_with(HashMap::new);

        for (id, info) in &current {
            if !cache.contains_key(id) {
                log::info!("device connected: {:04x}:{:04x} ({})", info.vendor_id, info.product_id, info.device_id);
                let _ = event_tx.send(IpcResponse::DeviceConnected { id: 0, device: info.clone() });
            }
        }
        let removed: Vec<_> = cache.keys().filter(|id| !current.contains_key(*id)).cloned().collect();
        for id in &removed {
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

    // Seed cache
    if let Ok(devices) = crate::hid::enumerate() {
        let mut cache = DEVICE_CACHE.lock().unwrap();
        let cache = cache.get_or_insert_with(HashMap::new);
        for d in devices {
            cache.insert(d.device_id.clone(), d);
        }
    }

    unsafe {
        let class_name = w!("WebHIDHiddenWindow");
        let hinst = GetModuleHandleW(None).unwrap();
        let wc = WNDCLASSW {
            lpfnWndProc: Some(def_window_proc),
            hInstance: hinst.into(),
            lpszClassName: class_name,
            ..Default::default()
        };
        RegisterClassW(&wc);

        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            class_name,
            w!(""),
            WINDOW_STYLE::default(),
            0, 0, 0, 0,
            None, None, hinst, None,
        ).unwrap();

        let mut notify_filter = DEV_BROADCAST_DEVICEINTERFACE_W {
            dbcc_size: std::mem::size_of::<DEV_BROADCAST_DEVICEINTERFACE_W>() as u32,
            dbcc_devicetype: DBT_DEVTYP_DEVICEINTERFACE,
            dbcc_reserved: 0,
            dbcc_classguid: windows::Win32::Devices::DeviceAndDriverInstallation::GUID_DEVINTERFACE_HID,
            dbcc_name: [0; 512],
        };

        let _hnotify = RegisterDeviceNotificationW(
            hwnd,
            &notify_filter as *const _ as *const _,
            DEVICE_NOTIFY_WINDOW_HANDLE,
        );

        let tx = event_tx.clone();
        let mut msg = MSG::default();
        loop {
            let ret = GetMessageW(&mut msg, None, 0, 0);
            if ret.0 <= 0 { break; }
            if msg.message == WM_DEVICECHANGE {
                refresh_and_diff(&tx);
            }
        }
    }
}

// =====================================================================
// macOS: IOHIDManager matching + run loop callbacks
// =====================================================================

#[cfg(target_os = "macos")]
fn run_macos(event_tx: broadcast::Sender<IpcResponse>) {
    use std::collections::HashMap;
    use std::sync::Mutex;
    use core_foundation_sys::base::*;
    use core_foundation_sys::runloop::*;
    use core_foundation_sys::string::*;

    type CFDictionaryRef = *const std::ffi::c_void;

    static DEVICE_CACHE: Mutex<Option<HashMap<String, webhid::DeviceInfo>>> = Mutex::new(None);

    unsafe extern "C" {
        fn IOHIDManagerCreate(allocator: CFAllocatorRef, options: IOOptionBits) -> *mut std::ffi::c_void;
        fn IOHIDManagerOpen(manager: *mut std::ffi::c_void, options: IOOptionBits) -> IOReturn;
        fn IOHIDManagerSetDeviceMatching(manager: *mut std::ffi::c_void, matching: CFDictionaryRef);
        fn IOHIDManagerRegisterDeviceMatchingCallback(
            manager: *mut std::ffi::c_void,
            callback: extern "C" fn(*mut std::ffi::c_void, IOReturn, *mut std::ffi::c_void, *mut std::ffi::c_void),
            context: *mut std::ffi::c_void,
        );
        fn IOHIDManagerRegisterDeviceRemovalCallback(
            manager: *mut std::ffi::c_void,
            callback: extern "C" fn(*mut std::ffi::c_void, IOReturn, *mut std::ffi::c_void, *mut std::ffi::c_void),
            context: *mut std::ffi::c_void,
        );
        fn IOHIDManagerScheduleWithRunLoop(manager: *mut std::ffi::c_void, run_loop: CFRunLoopRef, mode: CFStringRef);
    }

    type IOReturn = i32;
    type IOOptionBits = u32;
    const kIOHIDOptionsTypeNone: IOOptionBits = 0;

    // We can't easily get DeviceInfo from the raw IOHIDDeviceRef in the callback
    // without linking against IOKit framework properly.  Instead, we do a full
    // enumerate + diff on every callback — same as poll but event-driven (no
    // sleep, instant response).
    fn refresh_and_diff(event_tx: &broadcast::Sender<IpcResponse>) {
        let current: HashMap<String, webhid::DeviceInfo> = match crate::hid::enumerate() {
            Ok(devs) => devs.into_iter().map(|d| (d.device_id.clone(), d)).collect(),
            Err(_) => return,
        };
        let mut cache = DEVICE_CACHE.lock().unwrap();
        let cache = cache.get_or_insert_with(HashMap::new);

        for (id, info) in &current {
            if !cache.contains_key(id) {
                log::info!("device connected: {:04x}:{:04x} ({})", info.vendor_id, info.product_id, info.device_id);
                let _ = event_tx.send(IpcResponse::DeviceConnected { id: 0, device: info.clone() });
            }
        }
        let removed: Vec<_> = cache.keys().filter(|id| !current.contains_key(*id)).cloned().collect();
        for id in &removed {
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

    // Seed cache
    if let Ok(devices) = crate::hid::enumerate() {
        let mut cache = DEVICE_CACHE.lock().unwrap();
        let cache = cache.get_or_insert_with(HashMap::new);
        for d in devices {
            cache.insert(d.device_id.clone(), d);
        }
    }

    let manager = unsafe { IOHIDManagerCreate(std::ptr::null(), kIOHIDOptionsTypeNone) };
    if manager.is_null() {
        log::error!("IOHIDManagerCreate failed");
        return;
    }

    // Global for C callbacks (can't capture closures)
    static GLOBAL_TX: std::sync::Mutex<Option<broadcast::Sender<IpcResponse>>> = std::sync::Mutex::new(None);
    *GLOBAL_TX.lock().unwrap() = Some(event_tx);

    unsafe {
        IOHIDManagerSetDeviceMatching(manager, std::ptr::null());
        let ret = IOHIDManagerOpen(manager, kIOHIDOptionsTypeNone);
        if ret != 0 {
            log::error!("IOHIDManagerOpen failed: {ret}");
            return;
        }

        extern "C" fn on_matching(_ctx: *mut std::ffi::c_void, _result: IOReturn, _sender: *mut std::ffi::c_void, _device: *mut std::ffi::c_void) {
            std::thread::sleep(std::time::Duration::from_millis(100));
            if let Some(tx) = GLOBAL_TX.lock().unwrap().as_ref() {
                refresh_and_diff(tx);
            }
        }

        extern "C" fn on_removal(_ctx: *mut std::ffi::c_void, _result: IOReturn, _sender: *mut std::ffi::c_void, _device: *mut std::ffi::c_void) {
            if let Some(tx) = GLOBAL_TX.lock().unwrap().as_ref() {
                refresh_and_diff(tx);
            }
        }

        IOHIDManagerRegisterDeviceMatchingCallback(manager, on_matching, std::ptr::null_mut());
        IOHIDManagerRegisterDeviceRemovalCallback(manager, on_removal, std::ptr::null_mut());

        let run_loop = CFRunLoopGetCurrent();
        let mode = kCFRunLoopDefaultMode;
        IOHIDManagerScheduleWithRunLoop(manager, run_loop, mode);

        CFRunLoopRun();
    }
}
