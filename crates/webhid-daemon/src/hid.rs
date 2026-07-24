//! HID device access via hidapi (cross-platform) + udev hot-plug (Linux).

use hidapi::{DeviceInfo as HidDeviceInfo, HidApi, HidDevice};
use std::cell::RefCell;
use webhid::DeviceInfo;

thread_local! {
    static WRITE_BUF: RefCell<Vec<u8>> = RefCell::new(Vec::with_capacity(256));
    static READ_BUF: RefCell<Vec<u8>> = RefCell::new(Vec::with_capacity(256));
}

const DEFAULT_READ_SIZE: usize = 4096;

// ---------------------------------------------------------------------------
// device_id: stable, platform-independent identifier
// ---------------------------------------------------------------------------

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
    Some(parent.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

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
    let api = HidApi::new()?;

    let mut groups: std::collections::HashMap<(u16, u16, String), Vec<&HidDeviceInfo>> =
        std::collections::HashMap::new();
    for info in api.device_list() {
        if is_blocked_pub(info) {
            continue;
        }
        let serial = info.serial_number().unwrap_or("").to_string();
        groups
            .entry((info.vendor_id(), info.product_id(), serial))
            .or_default()
            .push(info);
    }

    let mut devices = Vec::new();
    for ifaces in groups.values() {
        let mut seen_descriptors: std::collections::HashSet<Vec<u8>> =
            std::collections::HashSet::new();
        for info in ifaces {
            let desc = read_raw_report_descriptor_with_api(&api, info);
            if !seen_descriptors.insert(desc.clone()) {
                continue;
            }
            if let Some(d) = info_from_hidapi_pub_with_desc(info, desc) {
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
    let device_id = make_device_id(info);
    let collections = if !desc.is_empty() {
        crate::descriptor::parse_report_descriptor(&desc)
    } else {
        vec![]
    };
    let max_input_report_size = crate::descriptor::max_input_report_size(&collections);
    Some(DeviceInfo {
        vendor_id: info.vendor_id(),
        product_id: info.product_id(),
        product_name: info.product_string().map(String::from),
        manufacturer: info.manufacturer_string().map(String::from),
        serial_number: info.serial_number().map(String::from),
        usage_page: Some(info.usage_page()),
        usage: Some(info.usage()),
        device_id,
        collections,
        max_input_report_size,
    })
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

fn read_raw_report_descriptor_with_api(api: &HidApi, info: &HidDeviceInfo) -> Vec<u8> {
    let Ok(dev) = api.open_path(info.path()) else {
        return Vec::new();
    };
    let mut buf = vec![0u8; hidapi::MAX_REPORT_DESCRIPTOR_SIZE];
    let Ok(n) = dev.get_report_descriptor(&mut buf) else {
        return Vec::new();
    };
    buf.truncate(n);
    buf
}

// ---------------------------------------------------------------------------
// Blocklist: security keys that must never be exposed to web pages
// ---------------------------------------------------------------------------

/// Known FIDO/U2F security key devices.  These devices can be used to
/// exfiltrate credentials if a malicious page gains raw HID access, so we
/// block them entirely, one-to-one with the per-product entries in
/// Chromium's `hid_blocklist.cc`.
const BLOCKED_DEVICES: &[(u16, u16)] = &[
    // KEY-ID
    (0x096e, 0x0850),
    // Feitian
    (0x096e, 0x0852),
    (0x096e, 0x0853),
    (0x096e, 0x0854),
    (0x096e, 0x0856),
    (0x096e, 0x0858),
    (0x096e, 0x085a),
    (0x096e, 0x085b),
    // HyperFIDO
    (0x096e, 0x0880),
    // HID Global BlueTrust Token
    (0x09c3, 0x0023),
    // Yubikey
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
    // U2F Zero
    (0x10c4, 0x8acf),
    // Mooltipass Mini-BLE
    (0x1209, 0x4321),
    // Mooltipass Arduino sketch
    (0x1209, 0x4322),
    // Google Titan
    (0x18d1, 0x5026),
    // VASCO
    (0x1a44, 0x00bb),
    // OnlyKey
    (0x1d50, 0x60fc),
    // Keydo AES
    (0x1e0d, 0xf1ae),
    // Neowave Keydo
    (0x1e0d, 0xf1d0),
    // Thetis
    (0x1ea8, 0xf025),
    // Nitrokey
    (0x20a0, 0x4287),
    // JaCarta
    (0x24dc, 0x0101),
    // Happlink
    (0x2581, 0xf1d0),
    // Bluink
    (0x2abe, 0x1002),
    // Feitian USB, HyperFIDO
    (0x2ccf, 0x0880),
];

/// FIDO usage page (Alliance Auth) — catches any security key not in the
/// per-product list above.
const FIDO_USAGE_PAGE: u16 = 0xF1D0;

/// Returns true if a device should be blocked from WebHID access.
pub fn is_blocked_pub(info: &HidDeviceInfo) -> bool {
    let vid = info.vendor_id();
    let pid = info.product_id();
    if BLOCKED_DEVICES.contains(&(vid, pid)) {
        return true;
    }
    if info.usage_page() == FIDO_USAGE_PAGE {
        return true;
    }
    false
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

/// Open a device by its stable `device_id` (u32 FNV-1a hash of path).
/// Returns (DeviceInfo, uses_numbered_reports, HidDevice) for I/O.
pub fn open_by_device_id(device_id: u32) -> anyhow::Result<(DeviceInfo, bool, HidDevice)> {
    let api = HidApi::new()?;
    for info in api.device_list() {
        if is_blocked_pub(info) {
            continue;
        }
        if make_device_id(info) == device_id {
            let desc = read_raw_report_descriptor_with_api(&api, info);
            let device_info = info_from_hidapi_pub_with_desc(info, desc.clone())
                .ok_or_else(|| anyhow::anyhow!("failed to build DeviceInfo"))?;
            let numbered = uses_numbered_reports(&desc);
            let dev = api.open_path(info.path())?;
            return Ok((device_info, numbered, dev));
        }
    }
    Err(anyhow::anyhow!("device_id '{}' not found", device_id))
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

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
/// hidapi's `read_timeout` handles polling internally.
pub fn read_with_timeout(
    dev: &HidDevice,
    timeout_ms: i32,
    buf_size: usize,
) -> std::io::Result<Vec<u8>> {
    READ_BUF.with(|buf| {
        let mut buf = buf.borrow_mut();
        let size = buf_size.max(DEFAULT_READ_SIZE);
        buf.resize(size, 0);
        let n = dev
            .read_timeout(&mut buf, timeout_ms)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
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
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
        if n != buf.len() {
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
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
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
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
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
            return info_from_hidapi_pub(info);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::uses_numbered_reports;

    #[test]
    fn test_uses_numbered_reports_empty() {
        assert!(!uses_numbered_reports(&[]));
    }

    #[test]
    fn test_uses_numbered_reports_no_report_id() {
        // HID descriptor for a simple mouse (no Report ID)
        let desc = vec![
            0x05, 0x01, // Usage Page (Generic Desktop)
            0x09, 0x02, // Usage (Mouse)
            0xA1, 0x01, // Collection (Application)
            0x09, 0x01, // Usage (Pointer)
            0x75, 0x08, // Report Size (8)
            0x95, 0x03, // Report Count (3)
            0x81, 0x02, // Input (Data,Var,Abs)
            0xC0, // End Collection
        ];
        assert!(!uses_numbered_reports(&desc));
    }

    #[test]
    fn test_uses_numbered_reports_with_report_id() {
        // HID descriptor with Report ID = 1
        let desc = vec![
            0x05, 0x01, // Usage Page (Generic Desktop)
            0x09, 0x02, // Usage (Mouse)
            0xA1, 0x01, // Collection (Application)
            0x85, 0x01, // Report ID (1)
            0x09, 0x01, // Usage (Pointer)
            0x75, 0x08, // Report Size (8)
            0x95, 0x03, // Report Count (3)
            0x81, 0x02, // Input (Data,Var,Abs)
            0xC0, // End Collection
        ];
        assert!(uses_numbered_reports(&desc));
    }

    #[test]
    fn test_uses_numbered_reports_long_item_skipped() {
        // Long item (0xFE) followed by normal items – no Report ID
        // Long item: 0xFE, data_size, tag, data...
        let desc = vec![
            0xFE, 0x02, 0x00, 0x00, 0x00, // Long item with 2 data bytes (all zero)
            0x05, 0x01, // Usage Page (Generic Desktop)
            0x09, 0x02, // Usage (Mouse)
            0xA1, 0x01, // Collection
            0x75, 0x08, // Report Size
            0x95, 0x01, // Report Count
            0x81, 0x02, // Input
            0xC0, // End Collection
        ];
        assert!(!uses_numbered_reports(&desc));
    }

    #[test]
    fn test_uses_numbered_reports_report_id_after_long_item() {
        // Long item: [0xFE, data_size=0, tag=0x00] (3 bytes total)
        // Parser skips 3+0=3 bytes from start, landing on 0x85
        let desc = vec![
            0xFE, 0x00, 0x00, // Long item (data_size=0, tag=0x00)
            0x85, 0x02, // Report ID (2)
            0x75, 0x08, // Report Size
            0x95, 0x01, // Report Count
            0x81, 0x02, // Input
        ];
        assert!(uses_numbered_reports(&desc));
    }

    #[test]
    fn test_uses_numbered_reports_truncated_long_item() {
        // Only the 0xFE prefix byte, no data_size – should not panic
        assert!(!uses_numbered_reports(&[0xFE]));
    }

    #[test]
    fn test_uses_numbered_reports_just_long_item_no_tag() {
        // 0xFE + data_size(0) = 2 bytes, parser skips 3+0=3 bytes from i=0
        // i becomes 3, which is >= len(2), returns false
        assert!(!uses_numbered_reports(&[0xFE, 0x00]));
    }

    #[test]
    fn test_uses_numbered_reports_report_id_at_end() {
        let desc = vec![
            0x05, 0x01, // Usage Page
            0x09, 0x02, // Usage
            0xA1, 0x01, // Collection
            0x85, 0x01, // Report ID (1) – at the end
        ];
        assert!(uses_numbered_reports(&desc));
    }

    #[test]
    fn test_uses_numbered_reports_non_report_id_global_items() {
        // Usage Page, Logical Minimum/Maximum, Report Size, Report Count etc.
        // No Report ID – should return false
        let desc = vec![
            0x05, 0x01, // Usage Page (Generic Desktop)
            0x15, 0x00, // Logical Minimum (0)
            0x25, 0x01, // Logical Maximum (1)
            0x75, 0x08, // Report Size (8)
            0x95, 0x01, // Report Count (1)
            0x35, 0x00, // Physical Minimum (0)
            0x45, 0x00, // Physical Maximum (0)
            0x65, 0x00, // Unit (None)
            0x55, 0x00, // Unit Exponent (0)
        ];
        assert!(!uses_numbered_reports(&desc));
    }
}
