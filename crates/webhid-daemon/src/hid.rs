//! Low-level HID device access via Linux hidraw and udev.

use std::fs::{File, OpenOptions};
use std::io;
use std::os::unix::io::AsRawFd;

use webhid::{DeviceInfo, Collection};

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

/// Return every currently connected hidraw device, as reported by udev.
pub fn enumerate() -> anyhow::Result<Vec<DeviceInfo>> {
    let mut en = udev::Enumerator::new()?;
    en.match_subsystem("hidraw")?;
    let list = en.scan_devices()?.filter_map(|d| info_from_device(&d)).collect();
    Ok(list)
}

/// Build a [`DeviceInfo`] from a udev `Device`.  Returns `None` when
/// mandatory properties are absent (e.g. non-USB hidraw nodes).
pub fn info_from_device(dev: &udev::Device) -> Option<DeviceInfo> {
    let path = dev.devnode()?.to_str()?.to_string();

    // ID_VENDOR_ID / ID_MODEL_ID are 4-hex-digit strings set by udev rules.
    let vid = u16::from_str_radix(dev.property_value("ID_VENDOR_ID")?.to_str()?, 16).ok()?;
    let pid = u16::from_str_radix(dev.property_value("ID_MODEL_ID")?.to_str()?, 16).ok()?;

    let product_name = prop_str(dev, "ID_MODEL");
    let manufacturer = prop_str(dev, "ID_VENDOR");
    let serial_number = prop_str(dev, "ID_SERIAL_SHORT");

    // Attempt to read the raw report descriptor from sysfs. For a hidraw
    // node `/dev/hidrawN` the descriptor is typically available at
    // `/sys/class/hidraw/hidrawN/device/report_descriptor`. If this fails we
    // simply omit the descriptor. If we successfully obtain the descriptor we
    // parse it into a shallow `collections` tree so the addon gets structured
    // metadata directly from the daemon.
    let (report_descriptor, collections) = std::path::Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(|devname| {
            let sys_path = format!("/sys/class/hidraw/{}/device/report_descriptor", devname);
            match std::fs::read(&sys_path) {
                Ok(bytes) => {
                    // Parse into collections; parsing is forgiving and may
                    // return an empty vector on errors.
                    let cols = parse_report_descriptor(&bytes);
                    Some((Some(bytes), if cols.is_empty() { None } else { Some(cols) }))
                }
                Err(_) => None,
            }
        })
        .unwrap_or((None, None));

    Some(DeviceInfo {
        vendor_id: vid,
        product_id: pid,
        product_name,
        manufacturer,
        serial_number,
        usage_page: None,
        usage: None,
        report_descriptor,
        collections,
        path,
    })
}

fn prop_str(dev: &udev::Device, key: &str) -> Option<String> {
    dev.property_value(key)?.to_str().map(str::to_string)
}

// ---------------------------------------------------------------------------
// Open / close
// ---------------------------------------------------------------------------

/// Open a hidraw node by its absolute path.
///
/// This is the preferred (and only) way to open a device because a single
/// logical USB device often exposes several HID interfaces — one hidraw
/// node each — and vid/pid alone can't distinguish them.  The returned `DeviceInfo` is looked up via udev so
/// the caller still gets descriptor / collections metadata for the
/// specific interface.
pub fn open_by_path(path: &str) -> anyhow::Result<(DeviceInfo, File)> {
    let info = enumerate()?
        .into_iter()
        .find(|d| d.path == path)
        .ok_or_else(|| anyhow::anyhow!("hidraw '{path}' not found"))?;

    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&info.path)
        .map_err(|e| anyhow::anyhow!("open '{}': {e}", info.path))?;

    Ok((info, file))
}

/// Scan a raw HID report descriptor for the presence of any `Report ID`
/// global item (tag `0x85`).
///
/// Per the HID spec, an interface either uses *numbered* reports (every
/// report has an explicit ID and the kernel prepends that ID byte to each
/// `read()`), or *unnumbered* reports (no ID byte is prepended).  This
/// flag determines whether the daemon should strip `buf[0]` as the report
/// ID when forwarding input reports.
///
/// The walk only needs to recognise the *short item* encoding for the
/// `Report ID` item — the descriptor parser elsewhere handles long items
/// and bSize=3 payloads, but for this purpose we can use a simple linear
/// scan that skips over each item by its declared size.
pub fn uses_numbered_reports(buf: &[u8]) -> bool {
    let mut i = 0usize;
    while i < buf.len() {
        let prefix = buf[i];

        // Long item (rare): bTag=0xF, bType=0x3, bSize=0x2 → header 0xFE.
        if prefix == 0xFE {
            // [0xFE, bDataSize, bLongItemTag, ...data]
            if i + 1 >= buf.len() { break; }
            let data_size = buf[i + 1] as usize;
            i = i.saturating_add(3).saturating_add(data_size);
            continue;
        }

        // Short item:  bSize bits 0-1, bType bits 2-3, bTag bits 4-7.
        // `Report ID` is a Global item, tag 0b1000 (0x85 is the canonical
        // 1-byte form 0b10000101).  Detect by comparing the upper nibble
        // (tag+type) — that masks off the size bits so any payload length
        // matches.
        if (prefix & 0xFC) == 0x84 {
            return true;
        }

        // bSize encoding: 0,1,2,3 → 0,1,2,4 bytes of payload.
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

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

/// Block until a HID input report is available (or `timeout_ms` expires),
/// then return the raw bytes (including the report-ID byte if the device uses
/// numbered reports).
///
/// Uses `poll(2)` so the calling thread is parked in the kernel while waiting.
/// Call this only from `spawn_blocking`.
pub fn read_with_timeout(file: &File, timeout_ms: u64) -> io::Result<Vec<u8>> {
    let fd = file.as_raw_fd();
    let timeout_i32 = timeout_ms.min(i32::MAX as u64) as i32;

    let mut pfd = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
    // SAFETY: valid pollfd slice, valid timeout.
    let ret = unsafe { libc::poll(&mut pfd as *mut _, 1, timeout_i32) };

    if ret < 0 {
        return Err(io::Error::last_os_error());
    }
    if ret == 0 {
        return Err(io::Error::new(io::ErrorKind::TimedOut, "HID read timed out"));
    }
    if pfd.revents & libc::POLLIN == 0 {
        return Err(io::Error::new(io::ErrorKind::BrokenPipe, "HID device error"));
    }

    let mut buf = vec![0u8; 256]; // 64-byte USB HID max + headroom for BT
    // SAFETY: buf is valid writable memory; fd is open.
    let n = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
    if n < 0 {
        return Err(io::Error::last_os_error());
    }
    buf.truncate(n as usize);
    Ok(buf)
}

/// Write a HID output report.
///
/// Linux `write(2)` on `/dev/hidrawN` requires the first byte of the
/// buffer to be the report ID (`0` for interfaces that don't use
/// numbered reports).  `payload` is the report data *without* that
/// leading byte; this function prepends it before calling the kernel.
///
/// Call this only from `spawn_blocking`.
pub fn write_report(file: &File, report_id: u8, payload: &[u8]) -> io::Result<()> {
    let fd = file.as_raw_fd();

    // Build the wire-format buffer: `[report_id, ...payload]`.
    let mut buf = Vec::with_capacity(payload.len() + 1);
    buf.push(report_id);
    buf.extend_from_slice(payload);

    // SAFETY: buf is a valid contiguous slice; fd is open for writing.
    let n = unsafe { libc::write(fd, buf.as_ptr().cast(), buf.len()) };
    if n < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Receive a HID feature report.
///
/// This uses the HIDIOCGFEATURE ioctl to retrieve a feature report.
/// The report_id should be the feature report ID to request.
/// Returns the raw feature report bytes including the report ID.
///
/// Call this only from `spawn_blocking`.
pub fn read_feature_report(file: &File, report_id: u8) -> io::Result<Vec<u8>> {
    let fd = file.as_raw_fd();
    // The buffer format for HIDIOCGFEATURE is:
    // [report_id] [report_data...]
    // The driver fills in the report data starting after the report_id byte.
    let mut buf = vec![0u8; 256]; // Max HID report size + 1 for report_id
    buf[0] = report_id;

    // HIDIOCGFEATURE = _IOCGFEATURE('H', 0x07)
    // From Linux kernel uapi/linux/hidraw.h - evaluates to 0xc0244807 on little-endian
    let ioctl_cmd = 0xc0244807u64;
    let ret = unsafe {
        libc::ioctl(fd, ioctl_cmd as libc::c_ulong, buf.as_mut_ptr())
    };

    if ret < 0 {
        return Err(io::Error::last_os_error());
    }

    buf.truncate(ret as usize);
    Ok(buf)
}

/// Send a HID feature report.
///
/// Uses the `HIDIOCSFEATURE` ioctl, which expects a buffer of the form
/// `[report_id, ...payload]`.  `payload` is the data without that
/// leading byte; this function prepends `report_id` before issuing the
/// ioctl.
///
/// Call this only from `spawn_blocking`.
pub fn write_feature_report(file: &File, report_id: u8, payload: &[u8]) -> io::Result<()> {
    let fd = file.as_raw_fd();

    // Build the wire-format buffer: `[report_id, ...payload]`.
    let mut buf = Vec::with_capacity(payload.len() + 1);
    buf.push(report_id);
    buf.extend_from_slice(payload);

    // HIDIOCSFEATURE = _IOCSFEATURE('H', 0x06)
    // From Linux kernel uapi/linux/hidraw.h - evaluates to 0xc0244806 on
    // little-endian.
    let ioctl_cmd = 0xc0244806u64;
    let ret = unsafe {
        libc::ioctl(fd, ioctl_cmd as libc::c_ulong, buf.as_mut_ptr())
    };

    if ret < 0 {
        return Err(io::Error::last_os_error());
    }

    Ok(())
}

/// Parse a raw HID report descriptor into a shallow collection tree.
/// This is a forgiving, limited parser sufficient to extract Collection
/// boundaries along with the most recent Usage Page / Usage. It is not a
/// full HID descriptor implementation but covers common descriptors.
fn parse_report_descriptor(buf: &[u8]) -> Vec<Collection> {
    let mut flat: Vec<Collection> = Vec::new();
    let mut parents: Vec<Option<usize>> = Vec::new();
    let mut stack_parents: Vec<usize> = Vec::new();
    let mut i: usize = 0;

    // Global state
    let mut usage_page: Option<u16> = None;
    let mut report_size: u32 = 0;
    let mut report_count: u32 = 0;
    let mut report_id: u8 = 0;

    // Local state
    let mut usages: Vec<u16> = Vec::new();
    let mut usage_min: Option<u16> = None;
    let mut usage_max: Option<u16> = None;

    while i < buf.len() {
        let b = buf[i];
        i += 1;

        // Long item (0xFE) - skip
        if b == 0xFE {
            if i >= buf.len() { break; }
            let len = buf[i] as usize;
            i += 1;
            // skip tag
            if i >= buf.len() { break; }
            i += 1;
            i = i.saturating_add(len);
            continue;
        }

        // Common opcodes we care about (for a more complete parser this
        // should be expanded to fully decode short-item format, but this
        // covers the idiomatic opcodes found in most USB HID descriptors).
        match b {
            0x05 => {
                // Usage Page (1 byte)
                if i < buf.len() {
                    usage_page = Some(buf[i] as u16);
                    i += 1;
                }
            }
            0x06 => {
                // Usage Page (16-bit)
                if i + 1 < buf.len() {
                    let v = (buf[i] as u16) | ((buf[i + 1] as u16) << 8);
                    usage_page = Some(v);
                    i += 2;
                }
            }
            0x09 => {
                // Usage (1 byte)
                if i < buf.len() {
                    usages.push(buf[i] as u16);
                    i += 1;
                }
            }
            0x0A => {
                // Usage (16-bit)
                if i + 1 < buf.len() {
                    let v = (buf[i] as u16) | ((buf[i + 1] as u16) << 8);
                    usages.push(v);
                    i += 2;
                }
            }
            0x19 => {
                // Usage Minimum (1 byte)
                if i < buf.len() {
                    usage_min = Some(buf[i] as u16);
                    i += 1;
                }
            }
            0x29 => {
                // Usage Maximum (1 byte)
                if i < buf.len() {
                    usage_max = Some(buf[i] as u16);
                    i += 1;
                }
            }
            0x2A => {
                // Usage Min/Max (16-bit)
                if i + 1 < buf.len() {
                    let v = (buf[i] as u16) | ((buf[i + 1] as u16) << 8);
                    // Ambiguous tag in short parsing; prefer treating as a single
                    // usage entry when used as 'Usage'
                    usages.push(v);
                    i += 2;
                }
            }
            0x75 => {
                // Report Size (bits)
                if i < buf.len() {
                    report_size = buf[i] as u32;
                    i += 1;
                }
            }
            0x95 => {
                // Report Count
                if i < buf.len() {
                    report_count = buf[i] as u32;
                    i += 1;
                }
            }
            0x85 => {
                // Report ID
                if i < buf.len() {
                    report_id = buf[i];
                    i += 1;
                }
            }
            0xA1 => {
                // Collection: next byte is collection type
                if i < buf.len() {
                    let col_type = buf[i];
                    i += 1;
                    let col = Collection { collection_type: col_type, usage_page, usage: usages.last().cloned(), children: Vec::new(), reports: None };
                    let parent = stack_parents.last().cloned().map(|v| v);
                    flat.push(col);
                    parents.push(parent);
                    let new_idx = flat.len() - 1;
                    stack_parents.push(new_idx);
                    // reset local usages so children don't inherit unless specified
                    usages.clear();
                    usage_min = None;
                    usage_max = None;
                }
            }
            0xC0 => {
                // End Collection
                stack_parents.pop();
            }
            other if (other & 0xF0) == 0x80 || (other & 0xF0) == 0x90 || (other & 0xF0) == 0xB0 => {
                // Main items: Input (0x80..), Output (0x90..), Feature (0xB0..)
                // Determine size of the item payload from low two bits.
                let size_code = (other & 0x03) as usize;
                let payload_size = match size_code {
                    0 => 0,
                    1 => 1,
                    2 => 2,
                    3 => 4,
                    _ => 0,
                };
                // Consume payload bytes (these are the item data/flags, not
                // the report payload itself).
                i = i.saturating_add(payload_size);

                let report_id_opt = if report_id == 0 { None } else { Some(report_id) };
                let report_type = if (other & 0xF0) == 0x80 { "input" } else if (other & 0xF0) == 0x90 { "output" } else { "feature" };

                // Build usage list for this field
                let mut field_usages: Option<Vec<u16>> = None;
                if !usages.is_empty() {
                    field_usages = Some(usages.clone());
                } else if usage_min.is_some() && usage_max.is_some() {
                    let min = usage_min.unwrap();
                    let max = usage_max.unwrap();
                    if max >= min {
                        let mut v = Vec::new();
                        for u in min..=max {
                            v.push(u);
                        }
                        field_usages = Some(v);
                    }
                }

                // Compose a Field
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

                // Insert field into the active collection's report bucket.
                if let Some(&col_idx) = stack_parents.last() {
                    if let Some(col) = flat.get_mut(col_idx) {
                        if col.reports.is_none() { col.reports = Some(Vec::new()); }
                        let reports = col.reports.as_mut().unwrap();
                        // find matching report by id + type
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
                    // No active collection, create a root placeholder
                    let mut col = Collection { collection_type: 0, usage_page, usage: None, children: Vec::new(), reports: None };
                    let rep = webhid::Report { id: field.report_id, report_type: field.report_type.clone(), size_bits: field.size * field.count, fields: vec![field] };
                    col.reports = Some(vec![rep]);
                    flat.push(col);
                    parents.push(None);
                }

                // Clear local usages after assigning them to a field.
                usages.clear();
                usage_min = None;
                usage_max = None;
            }
            _ => {
                // Fallback: interpret the short-item size and skip payload.
                let size_code = (b & 0x03) as usize;
                let size = match size_code {
                    0 => 0,
                    1 => 1,
                    2 => 2,
                    3 => 4,
                    _ => 0,
                };
                i = i.saturating_add(size);
            }
        }
    }

    // Build nested tree from flat list using parent indices.
    let mut nodes: Vec<Collection> = flat.iter().map(|c| Collection { collection_type: c.collection_type, usage_page: c.usage_page, usage: c.usage, children: Vec::new(), reports: c.reports.clone() }).collect();
    let mut roots: Vec<Collection> = Vec::new();

    // Use a clone of nodes for safe immutable access while mutating `nodes`.
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
