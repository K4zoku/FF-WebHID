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

pub fn blocklist_rules() -> &'static [BlocklistRule] {
    static RULES: &[BlocklistRule] = &[
        // FIDO HID U2F
        BlocklistRule {
            vendor: None,
            product: None,
            usage_page: Some(0xF1D0),
            usage: None,
            report_id: None,
            report_type: None,
        },
        // Generic Desktop / Mouse
        BlocklistRule {
            vendor: None,
            product: None,
            usage_page: Some(0x0001),
            usage: Some(0x0002),
            report_id: None,
            report_type: None,
        },
        // Generic Desktop / Keyboard
        BlocklistRule {
            vendor: None,
            product: None,
            usage_page: Some(0x0001),
            usage: Some(0x0006),
            report_id: None,
            report_type: None,
        },
        // Generic Desktop / Keypad
        BlocklistRule {
            vendor: None,
            product: None,
            usage_page: Some(0x0001),
            usage: Some(0x0007),
            report_id: None,
            report_type: None,
        },
        // Generic Desktop / System Control
        BlocklistRule {
            vendor: None,
            product: None,
            usage_page: Some(0x0001),
            usage: Some(0x0080),
            report_id: None,
            report_type: None,
        },
        // Jabra proprietary (vendor 0x0b0e, usagePage 0xff00, reportId 0x05, output)
        BlocklistRule {
            vendor: Some(0x0b0e),
            product: None,
            usage_page: Some(0xff00),
            usage: None,
            report_id: Some(0x05),
            report_type: Some(ReportType::Output),
        },
        // OnlyKey (vendor 0x1d50, product 0x60fc)
        BlocklistRule {
            vendor: Some(0x1d50),
            product: Some(0x60fc),
            usage_page: None,
            usage: None,
            report_id: None,
            report_type: None,
        },
    ];
    RULES
}

pub fn device_is_blocked(rules: &[BlocklistRule], vendor_id: u16, product_id: u16) -> bool {
    // Device-level blocking matches vendor/product rules only. Rules that
    // carry a usage page or usage describe collections or reports and are
    // enforced per report by `is_report_blocked`, matching the WICG spec and
    // Chromium: consumer-input devices stay enumerable, only their reports
    // are blocked. FIDO devices are additionally hidden by usage page in
    // hid.rs.
    // A vendor ID is required, mirroring Chromium's
    // HidBlocklist::IsVendorProductBlockedByEntry.
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
        // kPageKeyboard: Keyboard/Keypad usage page.
        return true;
    }
    if up != 0x0001 {
        // kPageGenericDesktop only below.
        return false;
    }
    let Some(u) = usage else {
        return false;
    };
    match u {
        // kGenericDesktopPointer/Mouse/Keyboard/Keypad.
        0x0001 | 0x0002 | 0x0006 | 0x0007 => report_type != ReportType::Feature,
        // kGenericDesktopSystemControl..SystemWarmRestart.
        0x0080..=0x008f => true,
        // kGenericDesktopSystemDock..SystemDisplaySwap.
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
mod tests {
    use super::*;

    #[test]
    fn test_parse_blocklist() {
        let rules = blocklist_rules();
        assert!(!rules.is_empty(), "blocklist should have at least one rule");
        let jabra = rules.iter().find(|r| r.vendor == Some(0x0b0e));
        assert!(jabra.is_some(), "should contain Jabra rule");
        assert_eq!(jabra.unwrap().report_type, Some(ReportType::Output));
        assert_eq!(jabra.unwrap().report_id, Some(0x05));
    }

    #[test]
    fn test_consumer_input_devices_stay_enumerable() {
        let rules = blocklist_rules();
        // Usage rules block reports, not devices (WICG spec + Chromium model).
        assert!(!device_is_blocked(rules, 0x1234, 0x5678));
        {
            assert!(is_report_blocked(
                rules,
                0x1234,
                0x5678,
                Some(0x0001),
                Some(0x0002),
                1,
                ReportType::Input,
            ));
            assert!(is_report_blocked(
                rules,
                0x1234,
                0x5678,
                Some(0x0001),
                Some(0x0006),
                1,
                ReportType::Input,
            ));
            assert!(is_report_blocked(
                rules,
                0x1234,
                0x5678,
                Some(0x0001),
                Some(0x0007),
                1,
                ReportType::Input,
            ));
            assert!(is_report_blocked(
                rules,
                0x1234,
                0x5678,
                Some(0x0001),
                Some(0x0080),
                1,
                ReportType::Input,
            ));
            // Output/feature reports in those collections are blocked too
            // (rule report_type is None, matching any type).
            assert!(is_report_blocked(
                rules,
                0x1234,
                0x5678,
                Some(0x0001),
                Some(0x0006),
                1,
                ReportType::Output,
            ));
        }
        // Vendor-defined collections are untouched either way.
        assert!(!is_report_blocked(
            rules,
            0x1234,
            0x5678,
            Some(0xFF00),
            Some(0x0001),
            1,
            ReportType::Input,
        ));
    }

    #[test]
    fn test_fido_report_blocked() {
        let rules = blocklist_rules();
        // FIDO devices are device-blocked by usage page in hid.rs; the rule
        // here also blocks their reports at the report level.
        assert!(!device_is_blocked(rules, 0x1234, 0x5678));
        assert!(is_report_blocked(
            rules,
            0x1234,
            0x5678,
            Some(0xF1D0),
            Some(0x01),
            0,
            ReportType::Input,
        ));
    }

    #[test]
    fn test_onlykey_device_blocked() {
        let rules = blocklist_rules();
        assert!(device_is_blocked(rules, 0x1d50, 0x60fc));
        assert!(!device_is_blocked(rules, 0x1d50, 0x9999));
    }

    #[test]
    fn test_jabra_report_blocked() {
        let rules = blocklist_rules();
        assert!(is_report_blocked(
            rules,
            0x0b0e,
            0x0000,
            Some(0xFF00),
            Some(0x0001),
            0x05,
            ReportType::Output,
        ));
        assert!(!is_report_blocked(
            rules,
            0x0b0e,
            0x0000,
            Some(0xFF00),
            Some(0x0001),
            0x05,
            ReportType::Input,
        ));
        assert!(!is_report_blocked(
            rules,
            0x0b0e,
            0x0000,
            Some(0xFF00),
            Some(0x0001),
            0x06,
            ReportType::Output,
        ));
        assert!(!is_report_blocked(
            rules,
            0x9999,
            0x0000,
            Some(0xFF00),
            Some(0x0001),
            0x05,
            ReportType::Output,
        ));
    }

    #[test]
    fn test_report_level_rule_does_not_block_device() {
        let rules = blocklist_rules();
        assert!(!device_is_blocked(rules, 0x0b0e, 0x0000));
    }
}
