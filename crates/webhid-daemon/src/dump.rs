//! `webhid-daemon dump`: print every HID device the daemon sees, with the
//! exact decisions the picker would make, for support reports.
//!
//! Runs the same code paths as the daemon (`hid` enumeration, blocklist,
//! descriptor parse, report pruning), so the output always matches what the
//! extension shows. A user pasting this output tells us at which layer a
//! device disappears: OS enumeration, blocklist, descriptor parse, or
//! report pruning.

use hidapi::{DeviceInfo as HidDeviceInfo, HidApi};
use serde::Serialize;

use crate::descriptor::parse_report_descriptor;
use crate::hid;
use crate::report_blocking::prune_device_info;

/// Run the `dump` subcommand. `args` is everything after `dump`.
pub fn run(args: impl Iterator<Item = String>) -> anyhow::Result<()> {
    let mut hex_descriptor = false;
    let mut json = false;
    for arg in args {
        match arg.as_str() {
            "--descriptor" => hex_descriptor = true,
            "--json" => json = true,
            other => anyhow::bail!("unknown dump flag '{other}' (expected --descriptor, --json)"),
        }
    }

    let api = HidApi::new()?;
    let mut entries: Vec<DumpEntry> = Vec::new();
    for info in api.device_list() {
        entries.push(dump_entry(&api, info, hex_descriptor));
    }

    if json {
        println!("{}", serde_json::to_string_pretty(&entries)?);
    } else {
        for e in &entries {
            print!("{}", e.format_text());
        }
        println!("{} device(s)", entries.len());
    }
    Ok(())
}

#[derive(Serialize)]
struct DumpEntry {
    device_id: u32,
    vendor_id: u16,
    product_id: u16,
    product_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    manufacturer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    serial_number: Option<String>,
    usage_page: u16,
    usage: u16,
    path: String,
    /// Device-level block reason (security keys / FIDO page), if blocked.
    #[serde(skip_serializing_if = "Option::is_none")]
    device_blocked: Option<String>,
    /// WICG vendor/product rule (e.g. OnlyKey), if blocked.
    #[serde(skip_serializing_if = "Option::is_none")]
    vendor_product_blocked: Option<String>,
    descriptor_bytes: usize,
    /// Raw descriptor as hex, only when `--descriptor` was passed.
    #[serde(skip_serializing_if = "Option::is_none")]
    descriptor_hex: Option<String>,
    /// hidreport error when the descriptor failed to parse.
    #[serde(skip_serializing_if = "Option::is_none")]
    parse_error: Option<String>,
    collections: usize,
    max_input_report_size: u32,
    /// Whether the device would show up in the extension picker.
    visible_in_picker: bool,
}

impl DumpEntry {
    fn format_text(&self) -> String {
        use std::fmt::Write;
        let mut s = String::new();
        let _ = writeln!(
            s,
            "== {:08x}: {:04x}:{:04x} \"{}\" ==",
            self.device_id, self.vendor_id, self.product_id, self.product_name
        );
        if let Some(m) = &self.manufacturer {
            let _ = writeln!(s, "  manufacturer: {m}");
        }
        if let Some(serial) = &self.serial_number {
            let _ = writeln!(s, "  serial: {serial}");
        }
        let _ = writeln!(
            s,
            "  usage: page 0x{:04x} usage 0x{:04x}",
            self.usage_page, self.usage
        );
        let _ = writeln!(s, "  path: {}", self.path);
        match &self.device_blocked {
            Some(reason) => {
                let _ = writeln!(s, "  block: {reason} (hidden from picker)");
            }
            None => match &self.vendor_product_blocked {
                Some(reason) => {
                    let _ = writeln!(s, "  block: {reason} (hidden from picker)");
                }
                None => {
                    let _ = writeln!(s, "  block: none");
                }
            },
        }
        let _ = writeln!(
            s,
            "  descriptor: {} bytes{}",
            self.descriptor_bytes,
            self.descriptor_hex
                .as_ref()
                .map(|h| format!("\n    {h}"))
                .unwrap_or_default()
        );
        match &self.parse_error {
            Some(e) => {
                let _ = writeln!(s, "  parse: failed: {e}");
            }
            None => {
                let _ = writeln!(
                    s,
                    "  parse: ok ({} collection(s), max input {} bytes)",
                    self.collections, self.max_input_report_size
                );
            }
        }
        let _ = writeln!(
            s,
            "  picker: {}",
            if self.visible_in_picker {
                "visible"
            } else {
                "hidden"
            }
        );
        let _ = writeln!(s);
        s
    }
}

fn dump_entry(api: &HidApi, info: &HidDeviceInfo, hex_descriptor: bool) -> DumpEntry {
    let device_blocked = hid::device_level_block_reason(info);
    let desc = if device_blocked.is_none() {
        hid::read_raw_report_descriptor_with_api(api, info)
    } else {
        Vec::new()
    };

    let parse_result = if desc.is_empty() {
        Err("no report descriptor (open or read failed)".to_string())
    } else {
        match parse_report_descriptor(&desc) {
            Ok(c) => Ok(c),
            Err(e) => Err(e.to_string()),
        }
    };
    let collections = parse_result.clone().unwrap_or_default();
    let collection_count = parse_result.as_ref().map(|c| c.len()).unwrap_or(0);
    let parse_error = parse_result.err();

    let device_info = hid::build_device_info(info, collections, desc.clone());
    let vendor_product_blocked = hid::is_blocked_by_vendor_product(&device_info)
        .then(|| "WICG vendor/product blocklist rule".to_string());
    let max_input_report_size = device_info.max_input_report_size;
    let visible_in_picker = device_blocked.is_none()
        && vendor_product_blocked.is_none()
        && prune_device_info(device_info).is_some();

    DumpEntry {
        device_id: hid::make_device_id(info),
        vendor_id: info.vendor_id(),
        product_id: info.product_id(),
        product_name: info.product_string().map(String::from).unwrap_or_default(),
        manufacturer: info.manufacturer_string().map(String::from),
        serial_number: info.serial_number().map(String::from),
        usage_page: info.usage_page(),
        usage: info.usage(),
        path: info.path().to_string_lossy().into_owned(),
        device_blocked,
        vendor_product_blocked,
        descriptor_bytes: desc.len(),
        descriptor_hex: hex_descriptor.then(|| {
            desc.iter()
                .map(|b| format!("{b:02x}"))
                .collect::<Vec<_>>()
                .join(" ")
        }),
        parse_error,
        collections: collection_count,
        max_input_report_size,
        visible_in_picker,
    }
}

#[cfg(test)]
#[path = "tests/dump.rs"]
mod tests;
