//! Low-level HID device access via Linux hidraw and udev.

use std::fs::{File, OpenOptions};
use std::io;
use std::os::unix::io::AsRawFd;

use webhid::DeviceInfo;

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

    Some(DeviceInfo {
        vendor_id: vid,
        product_id: pid,
        product_name,
        manufacturer,
        serial_number,
        usage_page: None,
        usage: None,
        path,
    })
}

fn prop_str(dev: &udev::Device, key: &str) -> Option<String> {
    dev.property_value(key)?.to_str().map(str::to_string)
}

// ---------------------------------------------------------------------------
// Open / close
// ---------------------------------------------------------------------------

/// Find and open the first hidraw node that matches `vendor_id`:`product_id`.
/// Returns `(DeviceInfo, File)`.
pub fn open(vendor_id: u16, product_id: u16) -> anyhow::Result<(DeviceInfo, File)> {
    let info = enumerate()?
        .into_iter()
        .find(|d| d.vendor_id == vendor_id && d.product_id == product_id)
        .ok_or_else(|| anyhow::anyhow!("device {:04x}:{:04x} not found", vendor_id, product_id))?;

    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&info.path)
        .map_err(|e| anyhow::anyhow!("open '{}': {e}", info.path))?;

    Ok((info, file))
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

/// Write a HID output report.  The caller is responsible for prepending the
/// report-ID byte (use `0x00` when the device has no numbered reports).
///
/// Call this only from `spawn_blocking`.
pub fn write_report(file: &File, data: &[u8]) -> io::Result<()> {
    let fd = file.as_raw_fd();
    // SAFETY: data slice is valid; fd is open for writing.
    let n = unsafe { libc::write(fd, data.as_ptr().cast(), data.len()) };
    if n < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
