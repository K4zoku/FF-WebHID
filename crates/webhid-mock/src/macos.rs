//! macOS backend: `IOHIDUserDevice` (IOKit) + CFRunLoop event loop.
//!
//! `IOHIDUserDevice` is IOKit's userspace virtual-HID interface: a process
//! creates a device object from a property dictionary (report descriptor,
//! VID/PID, product name), schedules it on a run loop, and the HID system
//! exposes it to real clients (IOHIDManager, hidapi, our `webhid-daemon`)
//! as if it were physical hardware. Input reports are injected with
//! `IOHIDUserDeviceHandleReport`; host → device output/feature reports
//! arrive through the set-report callback, host queries through the
//! get-report callback.
//!
//! Deprecation status: the API is deprecated since macOS 11 in favor of
//! CoreHID's `HIDVirtualDevice`, but CoreHID requires the
//! `com.apple.developer.hid.virtual.device` entitlement, which needs Apple
//! approval and a provisioning profile — a non-starter for a test tool.
//! `IOHIDUserDevice` still ships in IOKit.framework and works without any
//! entitlement (observed in the wild on macOS 26). Rust FFI is unaffected
//! by the C-side deprecation attribute.
//!
//! Threading model: the main thread owns the CFRunLoop (callbacks fire
//! there); a second thread blocks on stdin and handles JSON commands.
//! Command `destroy` and stdin EOF exit the process directly — process
//! death closes the IOHIDUserClient connection and the kernel removes the
//! virtual device, the same teardown path as Linux closing the uhid fd.
//!
//! Refs:
//!   - IOKit/hid/IOHIDUserDevice.h (SDK header)
//!   - https://github.com/opensource-apple/IOKitUser (hid.subproj)

use std::ffi::c_void;

use anyhow::Context as _;
use core_foundation::base::{CFIndex, CFType, TCFType};
use core_foundation::data::CFData;
use core_foundation::number::CFNumber;
use core_foundation::runloop::{CFRunLoop, CFRunLoopRef};
use core_foundation::string::{CFString, CFStringRef};
use core_foundation_sys::base::CFTypeRef;
use core_foundation_sys::dictionary::{
    CFDictionaryCreate, CFDictionaryRef, kCFTypeDictionaryKeyCallBacks,
    kCFTypeDictionaryValueCallBacks,
};

use crate::{CmdResult, MockDevice, SpawnOpts, emit_stdout, handle_command};

type IOHIDUserDeviceRef = *mut c_void;

/// `IOHIDReportType` from IOKit/hid/IOHIDKeys.h.
type IOHIDReportType = u32;
/// `kIOHIDReportTypeOutput` — host → device output report.
const K_IO_HID_REPORT_TYPE_OUTPUT: IOHIDReportType = 1;

/// `IOReturn` success.
const K_IO_RETURN_SUCCESS: i32 = 0;

/// `IOHIDUserDeviceReportCallback` from IOHIDUserDevice.h. Invoked on the
/// run loop thread the device is scheduled with.
type IOHIDUserDeviceReportCallback =
    extern "C" fn(*mut c_void, IOHIDReportType, u32, *mut u8, CFIndex) -> i32;

#[allow(non_snake_case)]
#[link(name = "IOKit", kind = "framework")]
unsafe extern "C" {
    fn IOHIDUserDeviceCreate(
        allocator: *const c_void,
        properties: CFDictionaryRef,
    ) -> IOHIDUserDeviceRef;
    fn IOHIDUserDeviceScheduleWithRunLoop(
        device: IOHIDUserDeviceRef,
        run_loop: CFRunLoopRef,
        mode: CFStringRef,
    );
    fn IOHIDUserDeviceRegisterGetReportCallback(
        device: IOHIDUserDeviceRef,
        callback: IOHIDUserDeviceReportCallback,
        refcon: *mut c_void,
    );
    fn IOHIDUserDeviceRegisterSetReportCallback(
        device: IOHIDUserDeviceRef,
        callback: IOHIDUserDeviceReportCallback,
        refcon: *mut c_void,
    );
    fn IOHIDUserDeviceHandleReport(
        device: IOHIDUserDeviceRef,
        report: *mut u8,
        report_length: CFIndex,
    ) -> i32;
}

#[allow(non_upper_case_globals)]
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    /// Exported run-loop mode constant (not wrapped by the core-foundation
    /// crate). Safe to pass by value; it is a process-lifetime CFString.
    static kCFRunLoopDefaultMode: CFStringRef;
}

extern "C" fn get_report_cb(
    _refcon: *mut c_void,
    report_type: IOHIDReportType,
    report_id: u32,
    _report: *mut u8,
    _report_length: CFIndex,
) -> i32 {
    emit_stdout(&serde_json::json!({
        "event": "get_report",
        "id": report_id,
        "reportType": report_type,
    }));
    K_IO_RETURN_SUCCESS
}

extern "C" fn set_report_cb(
    _refcon: *mut c_void,
    report_type: IOHIDReportType,
    report_id: u32,
    report: *mut u8,
    report_length: CFIndex,
) -> i32 {
    let bytes: &[u8] = if report.is_null() || report_length <= 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(report, report_length as usize) }
    };

    if report_type == K_IO_HID_REPORT_TYPE_OUTPUT {
        let data: Vec<u8> = if report_id != 0 {
            let mut v = Vec::with_capacity(bytes.len() + 1);
            v.push(report_id as u8);
            v.extend_from_slice(bytes);
            v
        } else {
            bytes.to_vec()
        };
        emit_stdout(&serde_json::json!({
            "event": "output_report",
            "data": data,
        }));
    } else {
        emit_stdout(&serde_json::json!({
            "event": "set_report",
            "id": report_id,
            "reportType": report_type,
            "data": bytes,
        }));
    }
    K_IO_RETURN_SUCCESS
}

/// Send/Sync wrapper for the raw device ref.
///
/// SAFETY: `IOHIDUserDeviceHandleReport` is a Mach IPC call into the kernel
/// and is safe to invoke from any thread. Get/set-report callbacks are
/// serialized by IOKit onto the run loop thread. The device is never
/// released (it lives until process exit, which tears down the kernel-side
/// device), so there is no concurrent CFRelease.
#[derive(Copy, Clone)]
struct SendDevice(usize);
unsafe impl Send for SendDevice {}
unsafe impl Sync for SendDevice {}

struct MacOSDevice {
    device: SendDevice,
}

impl MockDevice for MacOSDevice {
    fn send_input(&self, payload: &[u8]) -> anyhow::Result<()> {
        let ret = unsafe {
            IOHIDUserDeviceHandleReport(
                self.device.0 as IOHIDUserDeviceRef,
                payload.as_ptr() as *mut u8,
                payload.len() as CFIndex,
            )
        };
        if ret != K_IO_RETURN_SUCCESS {
            anyhow::bail!("IOHIDUserDeviceHandleReport failed: IOReturn {ret:#x}");
        }
        Ok(())
    }
}

/// Build the `IOHIDUserDeviceCreate` property dictionary. Keys are the
/// string literals behind the `kIOHID*Key` macros in IOKit/hid/IOHIDKeys.h
/// (macros, not exported symbols, so we construct them directly).
///
/// Calls `CFDictionaryCreate` directly (via core-foundation-sys) because
/// the typed `CFDictionary::from_CFType_pairs` wrapper requires a single
/// concrete value type, while our values are a mix of CFData / CFNumber /
/// CFString. Returns a create-rule (+1) reference; intentionally never
/// released since the device lives until process exit.
fn build_properties(opts: &SpawnOpts, rd: &[u8]) -> CFDictionaryRef {
    let mut keys: Vec<CFString> = Vec::new();
    let mut values: Vec<CFType> = Vec::new();
    let mut push = |key: &str, value: CFType| {
        keys.push(CFString::new(key));
        values.push(value);
    };

    push_identity_properties(&mut push, opts, rd);
    push_optional_properties(&mut push, opts);

    let key_refs: Vec<CFTypeRef> = keys.iter().map(|k| k.as_CFTypeRef()).collect();
    let value_refs: Vec<CFTypeRef> = values.iter().map(|v| v.as_CFTypeRef()).collect();
    let dict = unsafe {
        CFDictionaryCreate(
            core_foundation_sys::base::kCFAllocatorDefault,
            key_refs.as_ptr(),
            value_refs.as_ptr(),
            keys.len() as CFIndex,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        )
    };
    assert!(!dict.is_null(), "CFDictionaryCreate failed");
    dict
}

/// Push the properties every device has: report descriptor + USB identity.
fn push_identity_properties(push: &mut impl FnMut(&str, CFType), opts: &SpawnOpts, rd: &[u8]) {
    push("ReportDescriptor", CFData::from_buffer(rd).as_CFType());
    push("VendorID", CFNumber::from(opts.vid as i64).as_CFType());
    push("ProductID", CFNumber::from(opts.pid as i64).as_CFType());
    push("Product", CFString::new(&opts.name).as_CFType());
    push("Manufacturer", CFString::new("webhid-mock").as_CFType());
    push(
        "VersionNumber",
        CFNumber::from(opts.version as i64).as_CFType(),
    );
}

/// Push the optional properties: country code, transport, usage page/usage.
fn push_optional_properties(push: &mut impl FnMut(&str, CFType), opts: &SpawnOpts) {
    if opts.country != 0 {
        push(
            "CountryCode",
            CFNumber::from(opts.country as i64).as_CFType(),
        );
    }
    let transport = match opts.bus {
        0x03 => Some("USB"),
        0x05 => Some("Bluetooth"),
        _ => None,
    };
    if let Some(t) = transport {
        push("Transport", CFString::new(t).as_CFType());
    }
    if let Some(up) = opts.usage_page {
        push("PrimaryUsagePage", CFNumber::from(up as i64).as_CFType());
    }
    if let Some(u) = opts.usage {
        push("PrimaryUsage", CFNumber::from(u as i64).as_CFType());
    }
}

pub fn run_spawn(opts: SpawnOpts) -> anyhow::Result<()> {
    let rd = std::fs::read(&opts.descriptor_path)
        .with_context(|| format!("failed to read descriptor at {}", opts.descriptor_path))?;
    log::info!(
        "loaded {} bytes of report descriptor from {}",
        rd.len(),
        opts.descriptor_path
    );

    let props = build_properties(&opts, &rd);
    let device = unsafe { IOHIDUserDeviceCreate(std::ptr::null(), props) };
    if device.is_null() {
        anyhow::bail!(
            "IOHIDUserDeviceCreate failed (HID system unavailable or invalid properties)"
        );
    }
    log::info!(
        "created virtual device: VID={:#06x} PID={:#06x} name='{}' rd={}B",
        opts.vid,
        opts.pid,
        opts.name,
        rd.len()
    );

    let run_loop = CFRunLoop::get_current();
    unsafe {
        IOHIDUserDeviceRegisterGetReportCallback(device, get_report_cb, std::ptr::null_mut());
        IOHIDUserDeviceRegisterSetReportCallback(device, set_report_cb, std::ptr::null_mut());
        IOHIDUserDeviceScheduleWithRunLoop(
            device,
            run_loop.as_concrete_TypeRef(),
            kCFRunLoopDefaultMode,
        );
    }

    emit_stdout(&serde_json::json!({
        "event": "ready",
        "vid": opts.vid,
        "pid": opts.pid,
        "name": opts.name,
        "usagePage": opts.usage_page,
        "usage": opts.usage,
    }));

    let dev = MacOSDevice {
        device: SendDevice(device as usize),
    };
    std::thread::spawn(move || stdin_loop(dev));

    CFRunLoop::run_current();
    Ok(())
}

/// Blocking stdin reader on a dedicated thread. Exits the process on
/// `destroy` or EOF; process death is the device-teardown signal (the
/// kernel removes the IOHIDUserDevice when our connection closes).
fn stdin_loop(dev: MacOSDevice) {
    use std::io::BufRead as _;

    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                log::warn!("stdin read error: {e}");
                break;
            }
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match handle_command(&dev, line) {
            Ok(CmdResult::Continue) => {}
            Ok(CmdResult::Destroy) => {
                log::info!("destroy command received, exiting");
                std::process::exit(0);
            }
            Err(e) => {
                emit_stdout(&serde_json::json!({
                    "event": "error",
                    "error": format!("{e:#}"),
                }));
            }
        }
    }
    log::info!("stdin EOF, exiting");
    std::process::exit(0);
}
