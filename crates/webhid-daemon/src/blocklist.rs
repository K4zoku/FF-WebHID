#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReportType {
    Input,
    Output,
    Feature,
}

#[derive(Debug, Clone)]
pub struct BlocklistRule {
    pub vendor: Option<u16>,
    pub product: Option<u16>,
    pub usage_page: Option<u16>,
    pub usage: Option<u16>,
    pub report_id: Option<u8>,
    pub report_type: Option<ReportType>,
}

/// Rule-table constructor, positional in (vendor, product, usage_page,
/// usage, report_id, report_type) order, one line per WICG blocklist entry.
const fn rule(
    vendor: Option<u16>,
    product: Option<u16>,
    usage_page: Option<u16>,
    usage: Option<u16>,
    report_id: Option<u8>,
    report_type: Option<ReportType>,
) -> BlocklistRule {
    BlocklistRule {
        vendor,
        product,
        usage_page,
        usage,
        report_id,
        report_type,
    }
}

pub fn blocklist_rules() -> &'static [BlocklistRule] {
    static RULES: &[BlocklistRule] = &[
        rule(None, None, Some(0xF1D0), None, None, None),
        rule(None, None, Some(0x0001), Some(0x0002), None, None),
        rule(None, None, Some(0x0001), Some(0x0006), None, None),
        rule(None, None, Some(0x0001), Some(0x0007), None, None),
        rule(None, None, Some(0x0001), Some(0x0080), None, None),
        rule(
            Some(0x0b0e),
            None,
            Some(0xff00),
            None,
            Some(0x05),
            Some(ReportType::Output),
        ),
        rule(Some(0x1d50), Some(0x60fc), None, None, None, None),
    ];
    RULES
}

pub fn device_is_blocked(rules: &[BlocklistRule], vendor_id: u16, product_id: u16) -> bool {
    rules.iter().any(|r| {
        if r.report_id.is_some() || r.report_type.is_some() {
            return false;
        }
        if r.usage_page.is_some() || r.usage.is_some() {
            return false;
        }
        if r.vendor.is_none() {
            return false;
        }
        if r.vendor.is_some_and(|v| v != vendor_id) {
            return false;
        }
        if r.product.is_some_and(|p| p != product_id) {
            return false;
        }
        true
    })
}

/// Mirrors Chromium's `HidConnection::IsAlwaysProtected`
/// (`services/device/public/cpp/hid/hid_report_utils.cc`): a hardcoded layer
/// applied on top of the blocklist rules, independent of the WICG
/// `blocklist.txt`. Usage page 0x07 (Keyboard/Keypad page) is always
/// protected for every report type; Generic Desktop Pointer/Mouse/Keyboard/
/// Keypad usages are always protected for input and output (not feature, the
/// feature reports of mouse/keyboard collections are still blocked by the
/// blocklist rules); Generic Desktop System Control 0x80-0x8f and System
/// Dock 0xa0-0xb6 are always protected for every type.
pub fn is_always_protected(
    usage_page: Option<u16>,
    usage: Option<u16>,
    report_type: ReportType,
) -> bool {
    let Some(up) = usage_page else {
        return false;
    };
    if up == 0x0007 {
        return true;
    }
    if up != 0x0001 {
        return false;
    }
    let Some(u) = usage else {
        return false;
    };
    match u {
        0x0001 | 0x0002 | 0x0006 | 0x0007 => report_type != ReportType::Feature,
        0x0080..=0x008f => true,
        0x00a0..=0x00b6 => true,
        _ => false,
    }
}

pub fn is_report_blocked(
    rules: &[BlocklistRule],
    vendor_id: u16,
    product_id: u16,
    collection_usage_page: Option<u16>,
    collection_usage: Option<u16>,
    report_id: u8,
    report_type: ReportType,
) -> bool {
    rules.iter().any(|r| {
        if r.vendor.is_some_and(|v| v != vendor_id) {
            return false;
        }
        if r.product.is_some_and(|p| p != product_id) {
            return false;
        }
        if r.usage_page
            .is_some_and(|up| Some(up) != collection_usage_page)
        {
            return false;
        }
        if r.usage.is_some_and(|u| Some(u) != collection_usage) {
            return false;
        }
        if r.report_id.is_some_and(|ri| ri != report_id) {
            return false;
        }
        if r.report_type.is_some_and(|rt| rt != report_type) {
            return false;
        }
        true
    })
}

#[cfg(test)]
#[path = "tests/blocklist.rs"]
mod tests;
