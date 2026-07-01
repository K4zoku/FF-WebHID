//! HID device access via hidapi (cross-platform) + udev hot-plug (Linux).


use hidapi::{HidApi, HidDevice, DeviceInfo as HidDeviceInfo};
use webhid::{DeviceInfo, Collection};

// ---------------------------------------------------------------------------
// device_id — stable, platform-independent identifier
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
    // for disambiguation — two devices with identical vid/pid/serial but
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
/// Composite USB devices expose multiple HID interfaces — hidapi lists each
/// one separately.  We group interfaces by (vid, pid, serial) and pick the
/// "primary" interface: the first vendor-defined one (usage_page >= 0xFF00),
/// or failing that the first non-boot interface, else the first.  This
/// matches what most WebHID-consuming pages expect (one entry per physical
/// device, like Chromium's picker).
pub fn enumerate() -> anyhow::Result<Vec<DeviceInfo>> {
    let api = HidApi::new()?;
    let mut groups: std::collections::HashMap<(u16, u16, String), Vec<&HidDeviceInfo>> = std::collections::HashMap::new();
    for info in api.device_list() {
        if is_blocked(info) { continue; }
        let serial = info.serial_number().unwrap_or("").to_string();
        let key = if serial.is_empty() {
            make_device_id(info)
        } else {
            format!("{}:{}:{}", info.vendor_id(), info.product_id(), serial)
        };
        groups.entry((info.vendor_id(), info.product_id(), key)).or_default().push(info);
    }
    let mut devices = Vec::new();
    for ifaces in groups.values() {
        let primary = ifaces.iter()
            .find(|i| i.usage_page() >= 0xFF00)
            .or_else(|| ifaces.iter().find(|i| i.usage_page() != 0x01))
            .copied()
            .unwrap_or(ifaces[0]);
        if let Some(d) = info_from_hidapi(primary) {
            devices.push(d);
        }
    }
    Ok(devices)
}

/// Build a `DeviceInfo` from a hidapi `DeviceInfo`.
fn info_from_hidapi(info: &HidDeviceInfo) -> Option<DeviceInfo> {
    let device_id = make_device_id(info);
    let (report_descriptor, collections) = read_report_descriptor(info);
    Some(DeviceInfo {
        vendor_id: info.vendor_id(),
        product_id: info.product_id(),
        product_name: info.product_string().map(String::from),
        manufacturer: info.manufacturer_string().map(String::from),
        serial_number: info.serial_number().map(String::from),
        usage_page: Some(info.usage_page()),
        usage: Some(info.usage()),
        device_id,
        report_descriptor,
        collections,
    })
}

/// Try to read the raw HID report descriptor from sysfs (Linux) so the
/// addon can parse full `collections` metadata.  Returns (descriptor, parsed_collections).
fn read_report_descriptor(info: &HidDeviceInfo) -> (Option<Vec<u8>>, Option<Vec<Collection>>) {
    let path = info.path().to_string_lossy();
    // Linux: path is like "/dev/hidraw0" — sysfs at /sys/class/hidraw/hidrawN/device/report_descriptor
    #[cfg(target_os = "linux")]
    {
        if let Some(devname) = path.rsplit('/').next() {
            let sys_path = format!("/sys/class/hidraw/{}/device/report_descriptor", devname);
            if let Ok(bytes) = std::fs::read(&sys_path) {
                let cols = parse_report_descriptor(&bytes);
                return (Some(bytes), if cols.is_empty() { None } else { Some(cols) });
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = path;
    }
    (None, None)
}

// ---------------------------------------------------------------------------
// Blocklist — security keys that must never be exposed to web pages
// ---------------------------------------------------------------------------

/// Known FIDO/U2F security key vendor IDs.  These devices can be used to
/// exfiltrate credentials if a malicious page gains raw HID access, so we
/// block them entirely — matching Chromium's `hid_blocklist.cc`.
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
fn is_blocked(info: &HidDeviceInfo) -> bool {
    let vid = info.vendor_id();
    if BLOCKED_VIDS.contains(&vid) { return true; }
    if info.usage_page() == FIDO_USAGE_PAGE { return true; }
    false
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

/// Open a device by its stable `device_id`.
/// Returns (DeviceInfo, HidDevice) for I/O.
pub fn open_by_device_id(device_id: &str) -> anyhow::Result<(DeviceInfo, HidDevice)> {
    let api = HidApi::new()?;
    for info in api.device_list() {
        if is_blocked(info) { continue; }
        if make_device_id(info) == device_id {
            let dev = api.open_path(info.path())?;
            let device_info = info_from_hidapi(info)
                .ok_or_else(|| anyhow::anyhow!("failed to build DeviceInfo"))?;
            return Ok((device_info, dev));
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
    let mut buf = vec![0u8; 4096];
    let n = dev.read_timeout(&mut buf, timeout_ms)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    if n == 0 {
        return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "HID read timed out"));
    }
    buf.truncate(n);
    Ok(buf)
}

/// Write a HID output report.  hidapi expects the first byte to be the report ID.
pub fn write_report(dev: &HidDevice, report_id: u8, payload: &[u8]) -> std::io::Result<()> {
    let mut buf = Vec::with_capacity(payload.len() + 1);
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
}

/// Receive a HID feature report.  hidapi's `get_feature_report` expects
/// the first byte to be the report ID and returns the report including it.
pub fn read_feature_report(dev: &HidDevice, report_id: u8) -> std::io::Result<Vec<u8>> {
    let mut buf = vec![0u8; 4096];
    buf[0] = report_id;
    let n = dev.get_feature_report(&mut buf)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    buf.truncate(n);
    Ok(buf)
}

/// Send a HID feature report.  hidapi's `send_feature_report` expects
/// the first byte to be the report ID.
pub fn write_feature_report(dev: &HidDevice, report_id: u8, payload: &[u8]) -> std::io::Result<()> {
    let mut buf = Vec::with_capacity(payload.len() + 1);
    buf.push(report_id);
    buf.extend_from_slice(payload);
    dev.send_feature_report(&buf)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    Ok(())
}

/// Look up a DeviceInfo by raw platform path (used by hot-plug monitor).
#[cfg(target_os = "linux")]
pub fn info_by_raw_path(raw_path: &str) -> Option<DeviceInfo> {
    let api = HidApi::new().ok()?;
    for info in api.device_list() {
        if info.path().to_string_lossy() == raw_path {
            return info_from_hidapi(info);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Report descriptor parser (kept from original; used for collections metadata)
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
fn parse_report_descriptor(buf: &[u8]) -> Vec<Collection> {
    let mut flat: Vec<Collection> = Vec::new();
    let mut parents: Vec<Option<usize>> = Vec::new();
    let mut stack_parents: Vec<usize> = Vec::new();
    let mut i: usize = 0;
    let mut usage_page: Option<u16> = None;
    let mut report_size: u32 = 0;
    let mut report_count: u32 = 0;
    let mut report_id: u8 = 0;
    let mut usages: Vec<u16> = Vec::new();
    let mut usage_min: Option<u16> = None;
    let mut usage_max: Option<u16> = None;

    while i < buf.len() {
        let b = buf[i];
        i += 1;
        if b == 0xFE {
            if i >= buf.len() { break; }
            let len = buf[i] as usize;
            i += 1;
            if i >= buf.len() { break; }
            i += 1;
            i = i.saturating_add(len);
            continue;
        }
        match b {
            0x05 => { if i < buf.len() { usage_page = Some(buf[i] as u16); i += 1; } }
            0x06 => { if i + 1 < buf.len() { let v = (buf[i] as u16) | ((buf[i + 1] as u16) << 8); usage_page = Some(v); i += 2; } }
            0x09 => { if i < buf.len() { usages.push(buf[i] as u16); i += 1; } }
            0x0A => { if i + 1 < buf.len() { let v = (buf[i] as u16) | ((buf[i + 1] as u16) << 8); usages.push(v); i += 2; } }
            0x19 => { if i < buf.len() { usage_min = Some(buf[i] as u16); i += 1; } }
            0x29 => { if i < buf.len() { usage_max = Some(buf[i] as u16); i += 1; } }
            0x2A => { if i + 1 < buf.len() { let v = (buf[i] as u16) | ((buf[i + 1] as u16) << 8); usages.push(v); i += 2; } }
            0x75 => { if i < buf.len() { report_size = buf[i] as u32; i += 1; } }
            0x95 => { if i < buf.len() { report_count = buf[i] as u32; i += 1; } }
            0x85 => { if i < buf.len() { report_id = buf[i]; i += 1; } }
            0xA1 => {
                if i < buf.len() {
                    let col_type = buf[i];
                    i += 1;
                    let col = Collection { collection_type: col_type, usage_page, usage: usages.last().cloned(), children: Vec::new(), reports: None };
                    let parent = stack_parents.last().cloned().map(|v| v);
                    flat.push(col);
                    parents.push(parent);
                    let new_idx = flat.len() - 1;
                    stack_parents.push(new_idx);
                    usages.clear();
                    usage_min = None;
                    usage_max = None;
                }
            }
            0xC0 => { stack_parents.pop(); }
            other if (other & 0xF0) == 0x80 || (other & 0xF0) == 0x90 || (other & 0xF0) == 0xB0 => {
                let size_code = (other & 0x03) as usize;
                let payload_size = match size_code { 0 => 0, 1 => 1, 2 => 2, 3 => 4, _ => 0 };
                i = i.saturating_add(payload_size);
                let report_id_opt = if report_id == 0 { None } else { Some(report_id) };
                let report_type = if (other & 0xF0) == 0x80 { "input" } else if (other & 0xF0) == 0x90 { "output" } else { "feature" };
                let mut field_usages: Option<Vec<u16>> = None;
                if !usages.is_empty() {
                    field_usages = Some(usages.clone());
                } else if usage_min.is_some() && usage_max.is_some() {
                    let min = usage_min.unwrap();
                    let max = usage_max.unwrap();
                    if max >= min {
                        let mut v = Vec::new();
                        for u in min..=max { v.push(u); }
                        field_usages = Some(v);
                    }
                }
                let field = webhid::Field {
                    report_id: report_id_opt,
                    report_type: report_type.to_string(),
                    size: report_size,
                    count: report_count,
                    usage_page,
                    usage: usages.last().cloned(),
                    usages: field_usages,
                    ..Default::default()
                };
                if let Some(&col_idx) = stack_parents.last() {
                    if let Some(col) = flat.get_mut(col_idx) {
                        if col.reports.is_none() { col.reports = Some(Vec::new()); }
                        let reports = col.reports.as_mut().unwrap();
                        let mut found = false;
                        for r in reports.iter_mut() {
                            if r.id == field.report_id && r.report_type == field.report_type {
                                r.fields.push(field.clone());
                                found = true;
                                break;
                            }
                        }
                        if !found {
                            let rep = webhid::Report { id: field.report_id, report_type: field.report_type.clone(), size_bits: field.size * field.count, fields: vec![field] };
                            reports.push(rep);
                        }
                    }
                } else {
                    let mut col = Collection { collection_type: 0, usage_page, usage: None, children: Vec::new(), reports: None };
                    let rep = webhid::Report { id: field.report_id, report_type: field.report_type.clone(), size_bits: field.size * field.count, fields: vec![field] };
                    col.reports = Some(vec![rep]);
                    flat.push(col);
                    parents.push(None);
                }
                usages.clear();
                usage_min = None;
                usage_max = None;
            }
            _ => {
                let size_code = (b & 0x03) as usize;
                let size = match size_code { 0 => 0, 1 => 1, 2 => 2, 3 => 4, _ => 0 };
                i = i.saturating_add(size);
            }
        }
    }

    let mut nodes: Vec<Collection> = flat.iter().map(|c| Collection { collection_type: c.collection_type, usage_page: c.usage_page, usage: c.usage, children: Vec::new(), reports: c.reports.clone() }).collect();
    let mut roots: Vec<Collection> = Vec::new();
    let clones = nodes.clone();
    for (idx, parent_opt) in parents.into_iter().enumerate() {
        if let Some(p) = parent_opt {
            nodes[p].children.push(clones[idx].clone());
        } else {
            roots.push(clones[idx].clone());
        }
    }
    roots
}
