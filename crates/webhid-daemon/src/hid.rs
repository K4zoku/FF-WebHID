//! HID device access via hidapi (cross-platform) + udev hot-plug (Linux).

use hidapi::{DeviceInfo as HidDeviceInfo, HidApi, HidDevice};
use std::cell::RefCell;
use webhid::{Collection, DeviceInfo, EnumerateFilter};

thread_local! {
    static WRITE_BUF: RefCell<Vec<u8>> = RefCell::new(Vec::with_capacity(256));
    static READ_BUF: RefCell<Vec<u8>> = RefCell::new(Vec::with_capacity(256));
}

const DEFAULT_READ_SIZE: usize = 4096;

/// Generate a stable `u32` device identifier from the device path.
///
/// Uses FNV-1a 32-bit hash of the platform-specific device path
/// (Linux: `/dev/hidraw0` / syspath; Windows: device interface path;
/// macOS: IOService path). Same device in same port → same hash across
/// reboots. Two devices with identical vid/pid/serial but different
/// physical ports have different paths → different hashes.
pub fn make_device_id(info: &HidDeviceInfo) -> u32 {
    let path = info.path().to_string_lossy();
    #[cfg(target_os = "linux")]
    {
        if let Some(syspath) = resolve_linux_syspath(&path) {
            return webhid::hash_device_id(&syspath);
        }
    }
    webhid::hash_device_id(&path)
}

#[cfg(target_os = "linux")]
fn resolve_linux_syspath(devnode: &str) -> Option<String> {
    let name = std::path::Path::new(devnode).file_name()?.to_str()?;
    let syslink = format!("/sys/class/hidraw/{name}/device");
    let realpath = std::fs::canonicalize(&syslink).ok()?;
    let parent = realpath.parent()?;
    let mut base = parent.to_string_lossy().into_owned();

    if base.ends_with("/misc/uhid")
        && let Some(dir) = realpath.file_name().and_then(|n| n.to_str())
        && let Some(id_part) = dir.split('.').next()
    {
        base = format!("{base}/{id_part}");
    }
    Some(base)
}

/// Return every currently connected HID device via hidapi.
///
/// Chromium groups HID interfaces by (vid, pid, serial) and exposes
/// only the **top-level Application collections**; one HIDDevice per
/// top-level Application collection, not one per hidraw node.  We
/// replicate this: enumerate all hidapi entries, group by
/// (vid, pid, serial), then within each group select only interfaces
/// whose top-level collection is an Application collection (type 0x01).
/// Interfaces that share the same top-level Application collection
/// (same report descriptor) are deduplicated.
pub fn enumerate() -> anyhow::Result<Vec<DeviceInfo>> {
    enumerate_with_filter(None)
}

/// Stable physical-device identity used to keep two distinct no-serial
/// devices apart while still merging multiple interfaces of one device.
/// On Linux the syspath base already identifies the physical device (all
/// of its interfaces canonicalize to the same path); elsewhere the hidapi
/// path is the best available per-interface identity.
fn physical_identity(info: &HidDeviceInfo) -> String {
    let path = info.path().to_string_lossy();
    #[cfg(target_os = "linux")]
    {
        if let Some(syspath) = resolve_linux_syspath(&path) {
            return syspath;
        }
    }
    path.into_owned()
}

/// Key that identifies one physical device across hidapi entries: the
/// serial number when present, the platform physical identity otherwise.
/// Used to detect 32-bit device-id hash collisions.
fn physical_key(info: &HidDeviceInfo) -> String {
    let serial = info.serial_number().unwrap_or("");
    if serial.is_empty() {
        physical_identity(info)
    } else {
        format!("serial:{serial}")
    }
}

/// Number of distinct physical devices among `entries`. More than one means
/// the entries' shared 32-bit device id is ambiguous and must not be used
/// as an authority (opening the id could select the wrong physical device).
fn distinct_physical_count(entries: &[&HidDeviceInfo]) -> usize {
    let mut seen = std::collections::HashSet::new();
    for info in entries {
        seen.insert(physical_key(info));
    }
    seen.len()
}

/// Enumerates devices while rejecting impossible VID/PID candidates before
/// report descriptors are opened and parsed.
pub fn enumerate_with_filter(filter: Option<&EnumerateFilter>) -> anyhow::Result<Vec<DeviceInfo>> {
    let api = HidApi::new()?;

    let mut groups: std::collections::HashMap<
        (u16, u16, String),
        Vec<(String, &HidDeviceInfo)>,
    > = std::collections::HashMap::new();
    // device_id -> distinct physical devices hashing to it; used to drop
    // colliding ids from enumeration entirely (fail closed).
    let mut id_physical: std::collections::HashMap<u32, std::collections::HashSet<String>> =
        std::collections::HashMap::new();
    for info in api.device_list() {
        if let Some(filter) = filter {
            if !crate::enumeration_filter::matches_vid_pid(
                info.vendor_id(),
                info.product_id(),
                filter,
            ) {
                continue;
            }
        }
        if is_blocked_pub(info) {
            continue;
        }
        let serial = info.serial_number().unwrap_or("").to_string();
        // When the device has no serial number, distinct physical devices
        // with identical vid/pid must not be merged. Bucket by physical
        // identity instead; with a serial, the serial already separates
        // devices and every interface of one device shares one bucket.
        let phys = if serial.is_empty() {
            physical_identity(info)
        } else {
            String::new()
        };
        id_physical
            .entry(make_device_id(info))
            .or_default()
            .insert(physical_key(info));
        groups
            .entry((info.vendor_id(), info.product_id(), serial))
            .or_default()
            .push((phys, info));
    }

    let mut devices = Vec::new();
    for ifaces in groups.values() {
        let mut seen_descriptors: std::collections::HashMap<&String, std::collections::HashSet<Vec<u8>>> =
            std::collections::HashMap::new();
        for (phys, info) in ifaces {
            let desc = read_raw_report_descriptor_with_api(&api, info);
            if !seen_descriptors.entry(phys).or_default().insert(desc.clone()) {
                continue;
            }
            if let Some(d) = info_from_hidapi_pub_with_desc(info, desc) {
                if is_blocked_by_vendor_product(&d) {
                    continue;
                }
                if id_physical
                    .get(&d.device_id)
                    .map(|phys_set| phys_set.len() > 1)
                    .unwrap_or(false)
                {
                    log::warn!(
                        "[hid] device_id {:#x} is shared by {} distinct physical devices; hiding all of them (hash collision)",
                        d.device_id,
                        id_physical[&d.device_id].len()
                    );
                    continue;
                }
                devices.push(d);
            }
        }
    }
    Ok(devices)
}

/// Build a `DeviceInfo` from a hidapi `DeviceInfo`, fetching its report
/// descriptor via a fresh `HidApi` instance.
#[cfg(target_os = "linux")]
pub fn info_from_hidapi_pub(info: &HidDeviceInfo) -> Option<DeviceInfo> {
    info_from_hidapi_pub_with_desc(info, read_raw_report_descriptor(info))
}

fn info_from_hidapi_pub_with_desc(info: &HidDeviceInfo, desc: Vec<u8>) -> Option<DeviceInfo> {
    let collections = if !desc.is_empty() {
        match crate::descriptor::parse_report_descriptor(&desc) {
            Ok(c) => c,
            Err(e) => {
                log::warn!(
                    "device {:04x}:{:04x} report descriptor parse failed ({} bytes): {e}",
                    info.vendor_id(),
                    info.product_id(),
                    desc.len()
                );
                vec![]
            }
        }
    } else {
        vec![]
    };
    Some(build_device_info(info, collections, desc))
}

/// Assemble a `DeviceInfo` from a hidapi entry and its parsed collections.
/// Shared by the enumerate path and the `dump` subcommand so both report
/// exactly the same shape the daemon sees.
pub(crate) fn build_device_info(
    info: &HidDeviceInfo,
    collections: Vec<Collection>,
    raw_descriptor: Vec<u8>,
) -> DeviceInfo {
    let max_input_report_size = crate::descriptor::max_input_report_size(&collections);
    DeviceInfo {
        vendor_id: info.vendor_id(),
        product_id: info.product_id(),
        product_name: info.product_string().map(String::from).unwrap_or_default(),
        manufacturer: info.manufacturer_string().map(String::from),
        serial_number: info.serial_number().map(String::from),
        usage_page: Some(info.usage_page()),
        usage: Some(info.usage()),
        device_id: make_device_id(info),
        descriptor_parse_failed: collections.is_empty(),
        collections,
        max_input_report_size,
        raw_descriptor,
    }
}

/// Fetch a device's raw HID report descriptor by opening a fresh `HidApi`
/// instance. Used by the Linux udev hot-plug path where we receive a raw
/// device path (no `HidApi` borrow available).
#[cfg(target_os = "linux")]
fn read_raw_report_descriptor(info: &HidDeviceInfo) -> Vec<u8> {
    let Ok(api) = HidApi::new() else {
        return Vec::new();
    };
    read_raw_report_descriptor_with_api(&api, info)
}

pub(crate) fn read_raw_report_descriptor_with_api(api: &HidApi, info: &HidDeviceInfo) -> Vec<u8> {
    let opened = api.open_path(info.path());
    #[cfg(unix)]
    note_open_result(&opened);
    let Ok(dev) = opened else {
        return Vec::new();
    };
    let mut buf = vec![0u8; hidapi::MAX_REPORT_DESCRIPTOR_SIZE];
    let Ok(n) = dev.get_report_descriptor(&mut buf) else {
        return Vec::new();
    };
    buf.truncate(n);
    buf
}

/// Known FIDO/U2F security key devices.  These devices can be used to
/// exfiltrate credentials if a malicious page gains raw HID access, so we
/// block them entirely, one-to-one with the per-product entries in
/// Chromium's `hid_blocklist.cc`.
const BLOCKED_DEVICES: &[(u16, u16)] = &[
    (0x096e, 0x0850),
    (0x096e, 0x0852),
    (0x096e, 0x0853),
    (0x096e, 0x0854),
    (0x096e, 0x0856),
    (0x096e, 0x0858),
    (0x096e, 0x085a),
    (0x096e, 0x085b),
    (0x096e, 0x0880),
    (0x09c3, 0x0023),
    (0x1050, 0x0010),
    (0x1050, 0x0018),
    (0x1050, 0x0030),
    (0x1050, 0x0110),
    (0x1050, 0x0111),
    (0x1050, 0x0112),
    (0x1050, 0x0113),
    (0x1050, 0x0114),
    (0x1050, 0x0115),
    (0x1050, 0x0116),
    (0x1050, 0x0120),
    (0x1050, 0x0200),
    (0x1050, 0x0211),
    (0x1050, 0x0401),
    (0x1050, 0x0402),
    (0x1050, 0x0403),
    (0x1050, 0x0404),
    (0x1050, 0x0405),
    (0x1050, 0x0406),
    (0x1050, 0x0407),
    (0x1050, 0x0410),
    (0x10c4, 0x8acf),
    (0x1209, 0x4321),
    (0x1209, 0x4322),
    (0x18d1, 0x5026),
    (0x1a44, 0x00bb),
    (0x1d50, 0x60fc),
    (0x1e0d, 0xf1ae),
    (0x1e0d, 0xf1d0),
    (0x1ea8, 0xf025),
    (0x20a0, 0x4287),
    (0x24dc, 0x0101),
    (0x2581, 0xf1d0),
    (0x2abe, 0x1002),
    (0x2ccf, 0x0880),
];

/// FIDO usage page (Alliance Auth), catches any security key not in the
/// per-product list above.
const FIDO_USAGE_PAGE: u16 = 0xF1D0;

/// Returns true if a device should be blocked from WebHID access.
pub fn is_blocked_pub(info: &HidDeviceInfo) -> bool {
    device_level_block_reason(info).is_some()
}

/// Human-readable reason a device is blocked at the device level, if any.
/// The `dump` subcommand surfaces this so support reports say *why* a
/// device is missing, not just that it is.
pub(crate) fn device_level_block_reason(info: &HidDeviceInfo) -> Option<String> {
    if info.usage_page() == FIDO_USAGE_PAGE {
        return Some(format!("FIDO usage page 0x{FIDO_USAGE_PAGE:04x}"));
    }
    let vid = info.vendor_id();
    let pid = info.product_id();
    BLOCKED_DEVICES
        .iter()
        .find(|&&(v, p)| v == vid && p == pid)
        .map(|&(v, p)| format!("per-product security-key blocklist entry {v:04x}:{p:04x}"))
}

/// Vendor/product rules from the blocklist (e.g. OnlyKey). Collection usage
/// rules are enforced per report instead, matching the WICG spec and
/// Chromium: consumer-input devices stay enumerable, only their reports are
/// blocked.
pub fn is_blocked_by_vendor_product(info: &webhid::DeviceInfo) -> bool {
    let rules = crate::blocklist::blocklist_rules();
    crate::blocklist::device_is_blocked(rules, info.vendor_id, info.product_id)
}

/// Open a device by its stable `device_id` (u32 FNV-1a hash of path).
/// Returns (DeviceInfo, uses_numbered_reports, HidDevice) for I/O.
/// When the 32-bit id is shared by more than one distinct physical device,
/// the id is ambiguous and opening it is refused: the permission could
/// otherwise resolve to the wrong physical device.
pub fn open_by_device_id(device_id: u32) -> anyhow::Result<(DeviceInfo, bool, HidDevice)> {
    let api = HidApi::new()?;
    let matches: Vec<&HidDeviceInfo> = api
        .device_list()
        .filter(|info| !is_blocked_pub(info) && make_device_id(info) == device_id)
        .collect();
    if distinct_physical_count(&matches) > 1 {
        return Err(anyhow::anyhow!(
            "device_id '{device_id:#x}' is ambiguous ({} distinct physical devices hash to it); refusing to open",
            distinct_physical_count(&matches)
        ));
    }
    for info in matches {
        let desc = read_raw_report_descriptor_with_api(&api, info);
        let device_info = info_from_hidapi_pub_with_desc(info, desc.clone())
            .ok_or_else(|| anyhow::anyhow!("failed to build DeviceInfo"))?;
        if is_blocked_by_vendor_product(&device_info) {
            continue;
        }
        let numbered = uses_numbered_reports(&desc);
        let opened = api.open_path(info.path());
        #[cfg(unix)]
        note_open_result(&opened);
        let dev = opened?;
        return Ok((device_info, numbered, dev));
    }
    Err(anyhow::anyhow!("device_id '{}' not found", device_id))
}

/// Scan a raw HID report descriptor for the presence of any `Report ID`
/// global item (tag `0x84`).
pub fn uses_numbered_reports(buf: &[u8]) -> bool {
    let mut i = 0usize;
    while i < buf.len() {
        let prefix = buf[i];
        if prefix == 0xFE {
            if i + 1 >= buf.len() {
                break;
            }
            let data_size = buf[i + 1] as usize;
            i = i.saturating_add(3).saturating_add(data_size);
            continue;
        }
        if (prefix & 0xFC) == 0x84 {
            return true;
        }
        let payload = match prefix & 0x03 {
            0 => 0,
            1 => 1,
            2 => 2,
            3 => 4,
            _ => unreachable!(),
        };
        i = i.saturating_add(1).saturating_add(payload);
    }
    false
}

/// Block until a HID input report is available (or `timeout_ms` expires).
pub fn read_with_timeout(dev: &HidDevice, timeout_ms: i32) -> std::io::Result<Vec<u8>> {
    READ_BUF.with(|buf| {
        let mut buf = buf.borrow_mut();
        buf.resize(DEFAULT_READ_SIZE, 0);
        let n = dev
            .read_timeout(&mut buf, timeout_ms)
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "HID read timed out",
            ));
        }
        Ok(buf[..n].to_vec())
    })
}

/// Write a HID output report.  hidapi expects the first byte to be the report ID.
pub fn write_report(dev: &HidDevice, report_id: u8, payload: &[u8]) -> std::io::Result<()> {
    WRITE_BUF.with(|buf| {
        let mut buf = buf.borrow_mut();
        buf.clear();
        buf.push(report_id);
        buf.extend_from_slice(payload);
        let n = dev
            .write(&buf)
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        if cfg!(not(target_os = "windows")) && n != buf.len() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::WriteZero,
                format!("short write: {} of {} bytes", n, buf.len()),
            ));
        }
        Ok(())
    })
}

/// Receive a HID feature report.  hidapi's `get_feature_report` expects
/// the first byte to be the report ID and returns the report including it.
pub fn read_feature_report(dev: &HidDevice, report_id: u8) -> std::io::Result<Vec<u8>> {
    READ_BUF.with(|buf| {
        let mut buf = buf.borrow_mut();
        buf.resize(DEFAULT_READ_SIZE, 0);
        buf[0] = report_id;
        let n = dev
            .get_feature_report(&mut buf)
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        Ok(buf[..n].to_vec())
    })
}

/// Send a HID feature report.  hidapi's `send_feature_report` expects
/// the first byte to be the report ID.
pub fn write_feature_report(dev: &HidDevice, report_id: u8, payload: &[u8]) -> std::io::Result<()> {
    WRITE_BUF.with(|buf| {
        let mut buf = buf.borrow_mut();
        buf.clear();
        buf.push(report_id);
        buf.extend_from_slice(payload);
        dev.send_feature_report(&buf)
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        Ok(())
    })
}

/// Look up a DeviceInfo by raw platform path (used by hot-plug monitor).
#[cfg(target_os = "linux")]
pub fn info_by_raw_path(raw_path: &str) -> Option<DeviceInfo> {
    let api = HidApi::new().ok()?;
    for info in api.device_list() {
        if info.path().to_string_lossy() == raw_path {
            if is_blocked_pub(info) {
                return None;
            }
            if let Some(d) = info_from_hidapi_pub(info) {
                if is_blocked_by_vendor_product(&d) {
                    return None;
                }
                return Some(d);
            }
            return None;
        }
    }
    None
}

use std::sync::atomic::{AtomicU8, Ordering};

/// Cached HID permission status: 0 = ok, 1 = missing, 2 = unknown.
/// The daemon probes once at startup; permission state (TCC on macOS, group
/// membership / udev on Linux) is fixed for the process lifetime.
static HID_PERMISSION: AtomicU8 = AtomicU8::new(2);

/// Stores the probed HID permission status.
pub fn set_hid_permission(v: u8) {
    HID_PERMISSION.store(v, Ordering::Relaxed);
}

/// Returns the cached HID permission status (0 ok, 1 missing, 2 unknown).
pub fn hid_permission() -> u8 {
    HID_PERMISSION.load(Ordering::Relaxed)
}

/// Probes whether the daemon can read HID devices.
///
/// Windows needs no permission, so it is always ok. On macOS, Input
/// Monitoring (TCC) gates IOHIDManager: `IOHIDManagerOpen` returns
/// kIOReturnNotPermitted when the daemon is not allowed, while the bundled
/// hidapi silently enumerates zero devices in that case, so the probe calls
/// the manager directly. On other unixes the status stays "unknown" until a
/// real open happens; `note_open_result` then records the actual outcome.
pub fn probe_hid_permission() -> u8 {
    #[cfg(target_os = "windows")]
    {
        0
    }
    #[cfg(target_os = "macos")]
    {
        macos_hid_permission_probe()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        2
    }
}

#[cfg(target_os = "macos")]
fn macos_hid_permission_probe() -> u8 {
    const KIOHID_OPTIONS_NONE: u32 = 0;
    const KIORETURN_SUCCESS: i32 = 0;

    unsafe {
        let mgr = IOHIDManagerCreate(std::ptr::null(), KIOHID_OPTIONS_NONE);
        if mgr.is_null() {
            return 2;
        }
        IOHIDManagerSetDeviceMatching(mgr, std::ptr::null());
        let ret = IOHIDManagerOpen(mgr, KIOHID_OPTIONS_NONE);
        let _ = IOHIDManagerClose(mgr, KIOHID_OPTIONS_NONE);
        CFRelease(mgr.cast());
        if ret == KIORETURN_SUCCESS { 0 } else { 1 }
    }
}

/// Updates the cached HID permission status from a real hidapi open result:
/// success means access works, EACCES/EPERM means the permission is missing,
/// any other error leaves the current status untouched.
#[cfg(unix)]
fn note_open_result<T>(res: &Result<T, hidapi::HidError>) {
    const EACCES: i32 = 13;
    const EPERM: i32 = 1;
    match res {
        Ok(_) => set_hid_permission(0),
        Err(hidapi::HidError::IoError { error })
            if matches!(error.raw_os_error(), Some(EACCES) | Some(EPERM)) =>
        {
            set_hid_permission(1);
        }
        Err(_) => {}
    }
}

#[cfg(target_os = "macos")]
#[link(name = "IOKit", kind = "framework")]
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn IOHIDManagerCreate(
        allocator: *const std::ffi::c_void,
        options: u32,
    ) -> *mut std::ffi::c_void;
    fn IOHIDManagerSetDeviceMatching(
        manager: *mut std::ffi::c_void,
        matching: *const std::ffi::c_void,
    );
    fn IOHIDManagerOpen(manager: *mut std::ffi::c_void, options: u32) -> i32;
    fn IOHIDManagerClose(manager: *mut std::ffi::c_void, options: u32) -> i32;
    fn CFRelease(cf: *const std::ffi::c_void);
}

#[cfg(test)]
mod tests {
    use super::uses_numbered_reports;

    #[test]
    fn test_uses_numbered_reports_empty() {
        assert!(!uses_numbered_reports(&[]));
    }

    #[test]
    fn test_uses_numbered_reports_no_report_id() {
        let desc = vec![
            0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, 0x09, 0x01, 0x75, 0x08, 0x95, 0x03, 0x81, 0x02,
            0xC0,
        ];
        assert!(!uses_numbered_reports(&desc));
    }

    #[test]
    fn test_uses_numbered_reports_with_report_id() {
        let desc = vec![
            0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, 0x85, 0x01, 0x09, 0x01, 0x75, 0x08, 0x95, 0x03,
            0x81, 0x02, 0xC0,
        ];
        assert!(uses_numbered_reports(&desc));
    }

    #[test]
    fn test_uses_numbered_reports_long_item_skipped() {
        let desc = vec![
            0xFE, 0x02, 0x00, 0x00, 0x00, 0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, 0x75, 0x08, 0x95,
            0x01, 0x81, 0x02, 0xC0,
        ];
        assert!(!uses_numbered_reports(&desc));
    }

    #[test]
    fn test_uses_numbered_reports_report_id_after_long_item() {
        let desc = vec![
            0xFE, 0x00, 0x00, 0x85, 0x02, 0x75, 0x08, 0x95, 0x01, 0x81, 0x02,
        ];
        assert!(uses_numbered_reports(&desc));
    }

    #[test]
    fn test_uses_numbered_reports_truncated_long_item() {
        assert!(!uses_numbered_reports(&[0xFE]));
    }

    #[test]
    fn test_uses_numbered_reports_just_long_item_no_tag() {
        assert!(!uses_numbered_reports(&[0xFE, 0x00]));
    }

    #[test]
    fn test_uses_numbered_reports_report_id_at_end() {
        let desc = vec![0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, 0x85, 0x01];
        assert!(uses_numbered_reports(&desc));
    }

    #[test]
    fn test_uses_numbered_reports_non_report_id_global_items() {
        let desc = vec![
            0x05, 0x01, 0x15, 0x00, 0x25, 0x01, 0x75, 0x08, 0x95, 0x01, 0x35, 0x00, 0x45, 0x00,
            0x65, 0x00, 0x55, 0x00,
        ];
        assert!(!uses_numbered_reports(&desc));
    }
}
