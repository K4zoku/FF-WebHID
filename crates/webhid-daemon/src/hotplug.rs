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
        Ok(devs) => devs.into_iter().map(|d| (d.device_id, d)).collect(),
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

    static DEVICE_CACHE: Mutex<Option<HashMap<u32, webhid::DeviceInfo>>> = Mutex::new(None);

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

            if let Ok(api) = hidapi::HidApi::new() {
                let mut cache = DEVICE_CACHE.lock().unwrap();
                let cache = cache.get_or_insert_with(HashMap::new);
                for info in api.device_list() {
                    if crate::hid::is_blocked_pub(info) { continue; }
                    if let Some(d) = crate::hid::info_from_hidapi_pub(info) {
                        cache.insert(d.device_id, d);
                    }
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
                            cache.insert(info.device_id, info.clone());
                            IpcResponse::DeviceConnected { id: 0, device: info }
                        }
                        udev::EventType::Remove => {
                            let mut cache = DEVICE_CACHE.lock().unwrap();
                            let info = cache.as_mut().and_then(|c| c.remove(&webhid::hash_device_id(&devnode)));
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
#[allow(non_snake_case, non_upper_case_globals)]
fn run_windows(event_tx: broadcast::Sender<IpcResponse>) {
    // Seed cache
    if let Ok(devices) = crate::hid::enumerate() {
        let mut cache = DEVICE_CACHE.lock().unwrap();
        let cache = cache.get_or_insert_with(HashMap::new);
        for d in devices {
            cache.insert(d.device_id, d);
        }
    }

    // Raw Win32 FFI: avoids windows crate API version mismatches
    type HMODULE = isize;
    type HWND = isize;
    type HINSTANCE = isize;
    
    type UINT = u32;
    type WPARAM = usize;
    type LPARAM = isize;
    type LRESULT = isize;
    type DWORD = u32;
    type WORD = u16;
    type HANDLE = isize;

    const WM_DEVICECHANGE: UINT = 0x0219;
    const DBT_DEVTYP_DEVICEINTERFACE: DWORD = 0x00000005;
    const DEVICE_NOTIFY_WINDOW_HANDLE: DWORD = 0x00000000;

    #[repr(C)]
    struct WNDCLASSW {
        style: UINT,
        lpfnWndProc: Option<unsafe extern "system" fn(HWND, UINT, WPARAM, LPARAM) -> LRESULT>,
        cbClsExtra: i32,
        cbWndExtra: i32,
        hInstance: HINSTANCE,
        hIcon: isize,
        hCursor: isize,
        hbrBackground: isize,
        lpszMenuName: *const u16,
        lpszClassName: *const u16,
    }

    #[repr(C)]
    struct MSG {
        hwnd: HWND,
        message: UINT,
        wParam: WPARAM,
        lParam: LPARAM,
        time: DWORD,
        pt_x: i32,
        pt_y: i32,
    }

    #[repr(C)]
    struct DEV_BROADCAST_DEVICEINTERFACE_W {
        dbcc_size: DWORD,
        dbcc_devicetype: DWORD,
        dbcc_reserved: DWORD,
        dbcc_classguid: [u8; 16], // GUID
        dbcc_name: [u16; 1], // variable-length, we don't use it
    }

    // GUID_DEVINTERFACE_HID: {4D1E55B2-F16F-11CF-88CB-001111000030}
    const GUID_DEVINTERFACE_HID: [u8; 16] = [
        0xB2, 0x55, 0x1E, 0x4D, 0x6F, 0xF1, 0xCF, 0x11,
        0x88, 0xCB, 0x00, 0x11, 0x11, 0x00, 0x00, 0x30,
    ];

    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetModuleHandleW(lpModuleName: *const u16) -> HMODULE;
        fn RegisterClassW(lpWndClass: *const WNDCLASSW) -> WORD;
        fn CreateWindowExW(
            dwExStyle: DWORD, lpClassName: *const u16, lpWindowName: *const u16,
            dwStyle: DWORD, x: i32, y: i32, nWidth: i32, nHeight: i32,
            hWndParent: HWND, hMenu: isize, hInstance: HINSTANCE, lpParam: *mut std::ffi::c_void,
        ) -> HWND;
        fn GetMessageW(lpMsg: *mut MSG, hWnd: HWND, wMsgFilterMin: UINT, wMsgFilterMax: UINT) -> BOOL;
        fn DefWindowProcW(hWnd: HWND, Msg: UINT, wParam: WPARAM, lParam: LPARAM) -> LRESULT;
        fn RegisterDeviceNotificationW(
            hRecipient: HANDLE, NotificationFilter: *const std::ffi::c_void, Flags: DWORD,
        ) -> HANDLE;
    }

    type BOOL = i32;

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe {
        let class_name: Vec<u16> = to_wide("WebHIDHiddenWindow");
        let hinst = GetModuleHandleW(std::ptr::null());

        let wc = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(DefWindowProcW),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinst,
            hIcon: 0,
            hCursor: 0,
            hbrBackground: 0,
            lpszMenuName: std::ptr::null(),
            lpszClassName: class_name.as_ptr(),
        };
        RegisterClassW(&wc);

        let hwnd = CreateWindowExW(
            0, class_name.as_ptr(), std::ptr::null(), 0,
            0, 0, 0, 0, 0, 0, hinst, std::ptr::null_mut(),
        );

        if hwnd == 0 {
            log::error!("CreateWindowExW failed");
            return;
        }

        let notify_filter = DEV_BROADCAST_DEVICEINTERFACE_W {
            dbcc_size: std::mem::size_of::<DEV_BROADCAST_DEVICEINTERFACE_W>() as DWORD,
            dbcc_devicetype: DBT_DEVTYP_DEVICEINTERFACE,
            dbcc_reserved: 0,
            dbcc_classguid: GUID_DEVINTERFACE_HID,
            dbcc_name: [0],
        };

        let _hnotify = RegisterDeviceNotificationW(
            hwnd,
            &notify_filter as *const _ as *const std::ffi::c_void,
            DEVICE_NOTIFY_WINDOW_HANDLE,
        );

        let tx = event_tx;
        let mut msg: MSG = std::mem::zeroed();
        loop {
            let ret = GetMessageW(&mut msg, 0, 0, 0);
            if ret <= 0 { break; }
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
    use core_foundation_sys::base::*;
    use core_foundation_sys::runloop::*;
    use core_foundation_sys::string::*;

    type CFDictionaryRef = *const std::ffi::c_void;

    static DEVICE_CACHE: Mutex<Option<HashMap<u32, webhid::DeviceInfo>>> = Mutex::new(None);

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
    const KIO_HID_OPTIONS_TYPE_NONE: IOOptionBits = 0;

    // Seed cache
    if let Ok(devices) = crate::hid::enumerate() {
        let mut cache = DEVICE_CACHE.lock().unwrap();
        let cache = cache.get_or_insert_with(HashMap::new);
        for d in devices {
            cache.insert(d.device_id, d);
        }
    }

    let manager = unsafe { IOHIDManagerCreate(std::ptr::null(), KIO_HID_OPTIONS_TYPE_NONE) };
    if manager.is_null() {
        log::error!("IOHIDManagerCreate failed");
        return;
    }

    // Global for C callbacks (can't capture closures)
    static GLOBAL_TX: std::sync::Mutex<Option<broadcast::Sender<IpcResponse>>> = std::sync::Mutex::new(None);
    *GLOBAL_TX.lock().unwrap() = Some(event_tx);

    unsafe {
        IOHIDManagerSetDeviceMatching(manager, std::ptr::null());
        let ret = IOHIDManagerOpen(manager, KIO_HID_OPTIONS_TYPE_NONE);
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
