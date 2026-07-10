//! HID device access via hidapi (cross-platform) + udev hot-plug (Linux).


use hidapi::{HidApi, HidDevice, DeviceInfo as HidDeviceInfo};
use std::cell::RefCell;
use webhid::DeviceInfo;

// Thread-local buffers to avoid per-call allocation in the hot path.
// These are used by write_report, write_feature_report, and read_feature_report
// which are always called from spawn_blocking threads.
thread_local! {
    static WRITE_BUF: RefCell<Vec<u8>> = RefCell::new(Vec::with_capacity(4096));
    static READ_BUF: RefCell<Vec<u8>> = RefCell::new(Vec::with_capacity(4096));
}

// ---------------------------------------------------------------------------
// device_id: stable, platform-independent identifier
// ---------------------------------------------------------------------------

/// Generate a stable device identifier from HID metadata.
///
/// Format: hash of (vid, pid, serial, interface_number, usage_page, usage,
/// physical_location).  This is stable across reboots (as long as the device
/// stays plugged into the same USB port) and distinguishes composite USB
/// devices with multiple HID interfaces.
pub fn make_device_id(info: &HidDeviceInfo) -> String {
    let serial = info.serial_number().unwrap_or("");
    let interface = info.interface_number();
    let usage_page = info.usage_page();
    let usage = info.usage();
    // Physical location: on Linux, hidapi path encodes it. On Windows,
    // the instance ID contains bus/port info. We use the raw path here
    // for disambiguation; two devices with identical vid/pid/serial but
    // different physical ports will have different paths.
    let path = info.path().to_string_lossy();
    let ident = format!(
        "{:04x}:{:04x}:{}:{}:{:04x}:{:04x}:{}",
        info.vendor_id(),
        info.product_id(),
        serial,
        interface,
        usage_page,
        usage,
        path,
    );
    let mut hash: u64 = 5381;
    for b in ident.bytes() {
        hash = hash.wrapping_mul(33).wrapping_add(b as u64);
    }
    format!("{:016x}", hash)
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

    // Group by (vid, pid, serial); each group = 1 physical device
    let mut groups: std::collections::HashMap<(u16, u16, String), Vec<&HidDeviceInfo>> = std::collections::HashMap::new();
    for info in api.device_list() {
        if is_blocked_pub(info) { continue; }
        let serial = info.serial_number().unwrap_or("").to_string();
        groups.entry((info.vendor_id(), info.product_id(), serial)).or_default().push(info);
    }

    let mut devices = Vec::new();
    for ifaces in groups.values() {
        // Deduplicate by report descriptor bytes; multiple hidraw nodes
        // may expose the same descriptor (e.g. /dev/hidraw0 and /dev/hidraw1
        // both being the same interface on some kernels).
        let mut seen_descriptors: std::collections::HashSet<Vec<u8>> = std::collections::HashSet::new();
        for info in ifaces {
            let desc = read_raw_report_descriptor_with_api(&api, info);
            if !seen_descriptors.insert(desc.clone()) {
                continue; // duplicate interface; skip
            }
            if let Some(d) = info_from_hidapi_pub_with_desc(info, desc) {
                devices.push(d);
            }
        }
    }
    Ok(devices)
}

/// Build a `DeviceInfo` from a hidapi `DeviceInfo`.
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

fn read_raw_report_descriptor(info: &HidDeviceInfo) -> Vec<u8> {
    let Ok(api) = HidApi::new() else { return Vec::new() };
    read_raw_report_descriptor_with_api(&api, info)
}

fn read_raw_report_descriptor_with_api(api: &HidApi, info: &HidDeviceInfo) -> Vec<u8> {
    let Ok(dev) = api.open_path(info.path()) else { return Vec::new() };
    let mut buf = vec![0u8; hidapi::MAX_REPORT_DESCRIPTOR_SIZE];
    let Ok(n) = dev.get_report_descriptor(&mut buf) else { return Vec::new() };
    buf.truncate(n);
    buf
}

// ---------------------------------------------------------------------------
// Blocklist: security keys that must never be exposed to web pages
// ---------------------------------------------------------------------------

/// Known FIDO/U2F security key vendor IDs.  These devices can be used to
/// exfiltrate credentials if a malicious page gains raw HID access, so we
/// block them entirely, matching Chromium's `hid_blocklist.cc`.
const BLOCKED_VIDS: &[u16] = &[
    0x1050, // YubiKey
    0x096E, // Feitian
    0x0973, // OnlyKey
    0x413C, // Dell (fido)
    0x17EF, // Lenovo (fido)
    0x2CCF, // Nitrokey
    0x20A0, // Nitrokey (old)
    0x1EA8, // Google Titan
    0x32A3, // Somu
    0xC2BF, // HyperSecu
];

/// FIDO usage page (Alliance Auth).
const FIDO_USAGE_PAGE: u16 = 0xF1D0;

/// Returns true if a device should be blocked from WebHID access.
pub fn is_blocked_pub(info: &HidDeviceInfo) -> bool {
    let vid = info.vendor_id();
    if BLOCKED_VIDS.contains(&vid) { return true; }
    if info.usage_page() == FIDO_USAGE_PAGE { return true; }
    false
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

/// Open a device by its stable `device_id`.
/// Returns (DeviceInfo, uses_numbered_reports, HidDevice) for I/O.
pub fn open_by_device_id(device_id: &str) -> anyhow::Result<(DeviceInfo, bool, HidDevice)> {
    let api = HidApi::new()?;
    for info in api.device_list() {
        if is_blocked_pub(info) { continue; }
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
            if i + 1 >= buf.len() { break; }
            let data_size = buf[i + 1] as usize;
            i = i.saturating_add(3).saturating_add(data_size);
            continue;
        }
        if (prefix & 0xFC) == 0x84 { return true; }
        let payload = match prefix & 0x03 {
            0 => 0, 1 => 1, 2 => 2, 3 => 4, _ => unreachable!(),
        };
        i = i.saturating_add(1).saturating_add(payload);
    }
    false
}

/// Block until a HID input report is available (or `timeout_ms` expires).
/// hidapi's `read_timeout` handles polling internally.
pub fn read_with_timeout(dev: &HidDevice, timeout_ms: i32) -> std::io::Result<Vec<u8>> {
    READ_BUF.with(|buf| {
        let mut buf = buf.borrow_mut();
        buf.resize(4096, 0);
        let n = dev.read_timeout(&mut buf, timeout_ms)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
        if n == 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "HID read timed out"));
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
        let n = dev.write(&buf)
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
        buf.resize(4096, 0);
        buf[0] = report_id;
        let n = dev.get_feature_report(&mut buf)
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
            0xC0,       // End Collection
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
            0xC0,       // End Collection
        ];
        assert!(uses_numbered_reports(&desc));
    }

    #[test]
    fn test_uses_numbered_reports_long_item_skipped() {
        // Long item (0xFE) followed by normal items – no Report ID
        // Long item: 0xFE, data_size, tag, data...
        let desc = vec![
            0xFE, 0x02, 0x00, 0x00, 0x00, // Long item with 2 data bytes (all zero)
            0x05, 0x01,                    // Usage Page (Generic Desktop)
            0x09, 0x02,                    // Usage (Mouse)
            0xA1, 0x01,                    // Collection
            0x75, 0x08,                    // Report Size
            0x95, 0x01,                    // Report Count
            0x81, 0x02,                    // Input
            0xC0,                          // End Collection
        ];
        assert!(!uses_numbered_reports(&desc));
    }

    #[test]
    fn test_uses_numbered_reports_report_id_after_long_item() {
        // Long item: [0xFE, data_size=0, tag=0x00] (3 bytes total)
        // Parser skips 3+0=3 bytes from start, landing on 0x85
        let desc = vec![
            0xFE, 0x00, 0x00, // Long item (data_size=0, tag=0x00)
            0x85, 0x02,       // Report ID (2)
            0x75, 0x08,       // Report Size
            0x95, 0x01,       // Report Count
            0x81, 0x02,       // Input
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
            0x05, 0x01,       // Usage Page (Generic Desktop)
            0x15, 0x00,       // Logical Minimum (0)
            0x25, 0x01,       // Logical Maximum (1)
            0x75, 0x08,       // Report Size (8)
            0x95, 0x01,       // Report Count (1)
            0x35, 0x00,       // Physical Minimum (0)
            0x45, 0x00,       // Physical Maximum (0)
            0x65, 0x00,       // Unit (None)
            0x55, 0x00,       // Unit Exponent (0)
        ];
        assert!(!uses_numbered_reports(&desc));
    }
}
