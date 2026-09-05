#[cfg(any(target_os = "windows", target_os = "macos"))]
use std::collections::HashMap;
#[cfg(any(target_os = "windows", target_os = "macos"))]
use std::sync::Mutex;
use tokio::sync::broadcast;
use webhid::IpcResponse;

#[cfg(any(target_os = "windows", target_os = "macos"))]
static DEVICE_CACHE: Mutex<Option<HashMap<u32, webhid::DeviceInfo>>> = Mutex::new(None);

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn refresh_and_diff(event_tx: &broadcast::Sender<IpcResponse>) {
    let current: HashMap<u32, webhid::DeviceInfo> = match crate::hid::enumerate() {
        Ok(devs) => devs
            .into_iter()
            .filter_map(crate::report_blocking::prune_device_info)
            .map(|d| (d.device_id, d))
            .collect(),
        Err(_) => return,
    };
    let mut cache = DEVICE_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let cache = cache.get_or_insert_with(HashMap::new);

    for (id, info) in &current {
        if !cache.contains_key(id) {
            log::info!(
                "device connected: {:04x}:{:04x} ({})",
                info.vendor_id,
                info.product_id,
                info.device_id
            );
            let _ = event_tx.send(IpcResponse::DeviceConnected {
                device: info.clone(),
            });
        }
    }
    let removed: Vec<_> = cache
        .keys()
        .filter(|id| !current.contains_key(*id))
        .cloned()
        .collect();
    for id in &removed {
        if let Some(info) = cache.get(id) {
            log::info!(
                "device disconnected: {:04x}:{:04x} ({})",
                info.vendor_id,
                info.product_id,
                info.device_id
            );
            let _ = event_tx.send(IpcResponse::DeviceDisconnected {
                device: info.clone(),
            });
        }
    }
    cache.retain(|id, _| current.contains_key(id));
    for (id, info) in current {
        cache.insert(id, info);
    }
}

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
#[cfg(any(target_os = "windows", test))]
const DBT_DEVICEARRIVAL: u32 = 0x8000;
#[cfg(any(target_os = "windows", test))]
const DBT_DEVICEREMOVECOMPLETE: u32 = 0x8004;

#[cfg(any(target_os = "windows", test))]
fn should_refresh_device_change(wparam: u32) -> bool {
    matches!(wparam, DBT_DEVICEARRIVAL | DBT_DEVICEREMOVECOMPLETE)
}

#[cfg(test)]
#[path = "tests/hotplug.rs"]
mod tests;

#[cfg(target_os = "windows")]
const WM_DEVICECHANGE: u32 = 0x0219;
#[cfg(target_os = "windows")]
const WM_APP_REFRESH: u32 = 0x8000 + 1;

#[cfg(target_os = "windows")]
#[repr(C)]
struct WindowsWndClassW {
    style: u32,
    lpfn_wnd_proc: Option<unsafe extern "system" fn(isize, u32, usize, isize) -> isize>,
    cb_cls_extra: i32,
    cb_wnd_extra: i32,
    h_instance: isize,
    h_icon: isize,
    h_cursor: isize,
    hbr_background: isize,
    lpsz_menu_name: *const u16,
    lpsz_class_name: *const u16,
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct WindowsMsg {
    hwnd: isize,
    message: u32,
    w_param: usize,
    l_param: isize,
    time: u32,
    pt_x: i32,
    pt_y: i32,
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct WindowsDeviceInterface {
    dbcc_size: u32,
    dbcc_devicetype: u32,
    dbcc_reserved: u32,
    dbcc_classguid: [u8; 16],
    dbcc_name: [u16; 1],
}

#[cfg(target_os = "windows")]
const DBT_DEVTYP_DEVICEINTERFACE: u32 = 0x00000005;
#[cfg(target_os = "windows")]
const DEVICE_NOTIFY_WINDOW_HANDLE: u32 = 0x00000000;
#[cfg(target_os = "windows")]
const GUID_DEVINTERFACE_HID: [u8; 16] = [
    0xB2, 0x55, 0x1E, 0x4D, 0x6F, 0xF1, 0xCF, 0x11, 0x88, 0xCB, 0x00, 0x11, 0x11, 0x00, 0x00, 0x30,
];

#[cfg(target_os = "windows")]
#[link(name = "user32")]
unsafe extern "system" {
    fn RegisterClassW(lp_wnd_class: *const WindowsWndClassW) -> u16;
    fn CreateWindowExW(
        dw_ex_style: u32,
        lp_class_name: *const u16,
        lp_window_name: *const u16,
        dw_style: u32,
        x: i32,
        y: i32,
        n_width: i32,
        n_height: i32,
        h_wnd_parent: isize,
        h_menu: isize,
        h_instance: isize,
        lp_param: *mut std::ffi::c_void,
    ) -> isize;
    fn GetMessageW(
        lp_msg: *mut WindowsMsg,
        h_wnd: isize,
        w_msg_filter_min: u32,
        w_msg_filter_max: u32,
    ) -> i32;
    fn TranslateMessage(lp_msg: *const WindowsMsg) -> i32;
    fn DispatchMessageW(lp_msg: *const WindowsMsg) -> isize;
    fn DefWindowProcW(h_wnd: isize, msg: u32, w_param: usize, l_param: isize) -> isize;
    fn PostThreadMessageW(id_thread: u32, msg: u32, w_param: usize, l_param: isize) -> i32;
    fn RegisterDeviceNotificationW(
        h_recipient: isize,
        notification_filter: *const std::ffi::c_void,
        flags: u32,
    ) -> isize;
    fn UnregisterDeviceNotification(handle: isize) -> i32;
    fn DestroyWindow(h_wnd: isize) -> i32;
}

#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetModuleHandleW(lp_module_name: *const u16) -> isize;
    fn GetCurrentThreadId() -> u32;
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn windows_window_proc(
    hwnd: isize,
    msg: u32,
    w_param: usize,
    l_param: isize,
) -> isize {
    if msg == WM_DEVICECHANGE && should_refresh_device_change(w_param as u32) {
        log::debug!("WM_DEVICECHANGE received: wParam=0x{:08x}", w_param as u32);
        let thread_id = unsafe { GetCurrentThreadId() };
        let posted = unsafe { PostThreadMessageW(thread_id, WM_APP_REFRESH, 0, 0) };
        if posted == 0 {
            log::error!(
                "failed to post Windows HID refresh request: {}",
                std::io::Error::last_os_error()
            );
        } else {
            log::debug!("Windows HID refresh requested");
        }
        return 1;
    }

    unsafe { DefWindowProcW(hwnd, msg, w_param, l_param) }
}

#[cfg(target_os = "windows")]
fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
#[allow(non_snake_case)]
fn run_windows(event_tx: broadcast::Sender<IpcResponse>) {
    if let Ok(devices) = crate::hid::enumerate() {
        let mut cache = DEVICE_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        let cache = cache.get_or_insert_with(HashMap::new);
        for d in devices
            .into_iter()
            .filter_map(crate::report_blocking::prune_device_info)
        {
            cache.insert(d.device_id, d);
        }
    }

    unsafe {
        let class_name = to_wide("WebHIDHiddenWindow");
        let hinst = GetModuleHandleW(std::ptr::null());
        let wc = WindowsWndClassW {
            style: 0,
            lpfn_wnd_proc: Some(windows_window_proc),
            cb_cls_extra: 0,
            cb_wnd_extra: 0,
            h_instance: hinst,
            h_icon: 0,
            h_cursor: 0,
            hbr_background: 0,
            lpsz_menu_name: std::ptr::null(),
            lpsz_class_name: class_name.as_ptr(),
        };
        if RegisterClassW(&wc) == 0 {
            log::error!(
                "RegisterClassW failed for Windows HID notification window: {}",
                std::io::Error::last_os_error()
            );
            return;
        }

        let hwnd = CreateWindowExW(
            0,
            class_name.as_ptr(),
            std::ptr::null(),
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            hinst,
            std::ptr::null_mut(),
        );
        if hwnd == 0 {
            log::error!(
                "CreateWindowExW failed for Windows HID notification window: {}",
                std::io::Error::last_os_error()
            );
            return;
        }
        log::debug!("Windows HID notification hidden window created");

        let notify_filter = WindowsDeviceInterface {
            dbcc_size: std::mem::size_of::<WindowsDeviceInterface>() as u32,
            dbcc_devicetype: DBT_DEVTYP_DEVICEINTERFACE,
            dbcc_reserved: 0,
            dbcc_classguid: GUID_DEVINTERFACE_HID,
            dbcc_name: [0],
        };
        let hnotify = RegisterDeviceNotificationW(
            hwnd,
            &notify_filter as *const _ as *const std::ffi::c_void,
            DEVICE_NOTIFY_WINDOW_HANDLE,
        );
        if hnotify == 0 {
            log::error!(
                "RegisterDeviceNotificationW failed for HID interfaces: {}",
                std::io::Error::last_os_error()
            );
            DestroyWindow(hwnd);
            return;
        }
        log::debug!("Windows HID device notification registration succeeded");
        refresh_and_diff(&event_tx);

        let mut msg: WindowsMsg = std::mem::zeroed();
        loop {
            let result = GetMessageW(&mut msg, 0, 0, 0);
            if result == -1 {
                log::error!(
                    "GetMessageW failed in Windows HID notification loop: {}",
                    std::io::Error::last_os_error()
                );
                break;
            }
            if result == 0 {
                break;
            }
            if msg.hwnd == 0 && msg.message == WM_APP_REFRESH {
                log::debug!("processing Windows HID refresh request");
                refresh_and_diff(&event_tx);
                continue;
            }
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        if UnregisterDeviceNotification(hnotify) == 0 {
            log::error!(
                "UnregisterDeviceNotification failed for HID interfaces: {}",
                std::io::Error::last_os_error()
            );
        }
        DestroyWindow(hwnd);
    }
}

#[cfg(target_os = "linux")]
use std::collections::HashMap;
#[cfg(target_os = "linux")]
use std::os::unix::io::AsRawFd;
#[cfg(target_os = "linux")]
use std::sync::Mutex;

#[cfg(target_os = "linux")]
static DEVICE_CACHE: Mutex<Option<HashMap<u32, webhid::DeviceInfo>>> = Mutex::new(None);
#[cfg(target_os = "linux")]
static DEVNODE_TO_ID: Mutex<Option<HashMap<String, u32>>> = Mutex::new(None);

/// Seed the device cache and devnode-to-id map from the current hidapi
/// device list so that Remove events can be matched later.
#[cfg(target_os = "linux")]
fn seed_udev_cache() {
    let Ok(api) = hidapi::HidApi::new() else {
        return;
    };
    let mut cache = DEVICE_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let cache = cache.get_or_insert_with(HashMap::new);
    let mut dnmap = DEVNODE_TO_ID.lock().unwrap_or_else(|e| e.into_inner());
    let dnmap = dnmap.get_or_insert_with(HashMap::new);
    for info in api.device_list() {
        if crate::hid::is_blocked_pub(info) {
            continue;
        }
        if let Some(d) = crate::hid::info_from_hidapi_pub(info) {
            if crate::hid::is_blocked_by_vendor_product(&d) {
                continue;
            }
            let Some(d) = crate::report_blocking::prune_device_info(d) else {
                continue;
            };
            let devnode = info.path().to_string_lossy().into_owned();
            cache.insert(d.device_id, d.clone());
            dnmap.insert(devnode, d.device_id);
        }
    }
}

/// Translate one udev event into the corresponding device event. Returns
/// `None` for events that should be skipped (no devnode, hidden devices,
/// removals of unknown devices, or non-add/remove events).
#[cfg(target_os = "linux")]
fn handle_udev_event(event: udev::Event) -> Option<IpcResponse> {
    let devnode = match event.device().devnode().and_then(|p| p.to_str()) {
        Some(p) => p.to_string(),
        None => return None,
    };
    match event.event_type() {
        udev::EventType::Add => {
            let info = crate::hid::info_by_raw_path(&devnode)?;
            let info = crate::report_blocking::prune_device_info(info)?;
            log::info!(
                "device connected: {:04x}:{:04x} ({})",
                info.vendor_id,
                info.product_id,
                info.device_id
            );
            let mut cache = DEVICE_CACHE.lock().unwrap_or_else(|e| e.into_inner());
            let cache = cache.get_or_insert_with(HashMap::new);
            cache.insert(info.device_id, info.clone());
            let mut dnmap = DEVNODE_TO_ID.lock().unwrap_or_else(|e| e.into_inner());
            let dnmap = dnmap.get_or_insert_with(HashMap::new);
            dnmap.insert(devnode, info.device_id);
            Some(IpcResponse::DeviceConnected { device: info })
        }
        udev::EventType::Remove => {
            let device_id = {
                let mut dnmap = DEVNODE_TO_ID.lock().unwrap_or_else(|e| e.into_inner());
                dnmap.get_or_insert_with(HashMap::new).remove(&devnode)
            };
            let info = device_id.and_then(|id| {
                let mut cache = DEVICE_CACHE.lock().unwrap_or_else(|e| e.into_inner());
                cache.as_mut().and_then(|c| c.remove(&id))
            });
            match info {
                Some(i) => {
                    log::info!(
                        "device disconnected: {:04x}:{:04x} ({})",
                        i.vendor_id,
                        i.product_id,
                        i.device_id
                    );
                    Some(IpcResponse::DeviceDisconnected { device: i })
                }
                None => None,
            }
        }
        _ => None,
    }
}

#[cfg(target_os = "linux")]
fn start_udev(event_tx: broadcast::Sender<IpcResponse>) -> anyhow::Result<()> {
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

            seed_udev_cache();

            let fd = socket.as_raw_fd();
            loop {
                let mut pfd = libc::pollfd {
                    fd,
                    events: libc::POLLIN,
                    revents: 0,
                };
                let ret = unsafe { libc::poll(&mut pfd as *mut _, 1, -1) };
                if ret <= 0 {
                    continue;
                }

                for event in socket.iter() {
                    let Some(response) = handle_udev_event(event) else {
                        continue;
                    };
                    if event_tx.send(response).is_err() {
                        log::debug!("no receivers for udev event");
                    }
                }
            }
        })?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn run_macos(event_tx: broadcast::Sender<IpcResponse>) {
    use core_foundation_sys::base::*;
    use core_foundation_sys::runloop::*;
    use core_foundation_sys::string::*;

    type CFDictionaryRef = *const std::ffi::c_void;

    unsafe extern "C" {
        fn IOHIDManagerCreate(
            allocator: CFAllocatorRef,
            options: IOOptionBits,
        ) -> *mut std::ffi::c_void;
        fn IOHIDManagerOpen(manager: *mut std::ffi::c_void, options: IOOptionBits) -> IOReturn;
        fn IOHIDManagerSetDeviceMatching(manager: *mut std::ffi::c_void, matching: CFDictionaryRef);
        fn IOHIDManagerRegisterDeviceMatchingCallback(
            manager: *mut std::ffi::c_void,
            callback: extern "C" fn(
                *mut std::ffi::c_void,
                IOReturn,
                *mut std::ffi::c_void,
                *mut std::ffi::c_void,
            ),
            context: *mut std::ffi::c_void,
        );
        fn IOHIDManagerRegisterDeviceRemovalCallback(
            manager: *mut std::ffi::c_void,
            callback: extern "C" fn(
                *mut std::ffi::c_void,
                IOReturn,
                *mut std::ffi::c_void,
                *mut std::ffi::c_void,
            ),
            context: *mut std::ffi::c_void,
        );
        fn IOHIDManagerScheduleWithRunLoop(
            manager: *mut std::ffi::c_void,
            run_loop: CFRunLoopRef,
            mode: CFStringRef,
        );
    }

    type IOReturn = i32;
    type IOOptionBits = u32;
    const KIO_HID_OPTIONS_TYPE_NONE: IOOptionBits = 0;

    if let Ok(devices) = crate::hid::enumerate() {
        let mut cache = DEVICE_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        let cache = cache.get_or_insert_with(HashMap::new);
        for d in devices
            .into_iter()
            .filter_map(crate::report_blocking::prune_device_info)
        {
            cache.insert(d.device_id, d);
        }
    }

    let manager = unsafe { IOHIDManagerCreate(std::ptr::null(), KIO_HID_OPTIONS_TYPE_NONE) };
    if manager.is_null() {
        log::error!("IOHIDManagerCreate failed");
        return;
    }

    static GLOBAL_TX: std::sync::Mutex<Option<broadcast::Sender<IpcResponse>>> =
        std::sync::Mutex::new(None);
    *GLOBAL_TX.lock().unwrap_or_else(|e| e.into_inner()) = Some(event_tx);

    unsafe {
        IOHIDManagerSetDeviceMatching(manager, std::ptr::null());
        let ret = IOHIDManagerOpen(manager, KIO_HID_OPTIONS_TYPE_NONE);
        if ret != 0 {
            log::error!("IOHIDManagerOpen failed: {ret}");
            return;
        }

        extern "C" fn on_matching(
            _ctx: *mut std::ffi::c_void,
            _result: IOReturn,
            _sender: *mut std::ffi::c_void,
            _device: *mut std::ffi::c_void,
        ) {
            std::thread::sleep(std::time::Duration::from_millis(100));
            if let Some(tx) = GLOBAL_TX.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
                refresh_and_diff(tx);
            }
        }

        extern "C" fn on_removal(
            _ctx: *mut std::ffi::c_void,
            _result: IOReturn,
            _sender: *mut std::ffi::c_void,
            _device: *mut std::ffi::c_void,
        ) {
            if let Some(tx) = GLOBAL_TX.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
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
