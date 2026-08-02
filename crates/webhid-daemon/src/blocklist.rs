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

pub fn device_is_blocked(
    rules: &[BlocklistRule],
    vendor_id: u16,
    product_id: u16,
    top_level_collections: &[(Option<u16>, Option<u16>)],
) -> bool {
    rules.iter().any(|r| {
        if r.report_id.is_some() || r.report_type.is_some() {
            return false;
        }
        if r.vendor.is_some_and(|v| v != vendor_id) {
            return false;
        }
        if r.product.is_some_and(|p| p != product_id) {
            return false;
        }
        if r.usage_page.is_some() || r.usage.is_some() {
            top_level_collections.iter().any(|(up, u)| {
                r.usage_page.is_none_or(|rp| Some(rp) == *up)
                    && r.usage.is_none_or(|ru| Some(ru) == *u)
            })
        } else {
            true
        }
    })
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
    fn test_fido_blocked() {
        let rules = blocklist_rules();
        let collections = [(Some(0xF1D0), Some(0x01u16))];
        assert!(device_is_blocked(rules, 0x1234, 0x5678, &collections));
    }

    #[test]
    fn test_mouse_blocked() {
        let rules = blocklist_rules();
        let collections = [(Some(0x0001), Some(0x0002u16))];
        assert!(device_is_blocked(rules, 0x1234, 0x5678, &collections));
    }

    #[test]
    fn test_keyboard_blocked() {
        let rules = blocklist_rules();
        let collections = [(Some(0x0001), Some(0x0006u16))];
        assert!(device_is_blocked(rules, 0x1234, 0x5678, &collections));
    }

    #[test]
    fn test_non_blocked_collection() {
        let rules = blocklist_rules();
        let collections = [(Some(0xFF00), Some(0x0001u16))];
        assert!(!device_is_blocked(rules, 0x1234, 0x5678, &collections));
    }

    #[test]
    fn test_onlykey_device_blocked() {
        let rules = blocklist_rules();
        let collections = [(Some(0xFF00), Some(0x0001u16))];
        assert!(device_is_blocked(rules, 0x1d50, 0x60fc, &collections));
        assert!(!device_is_blocked(rules, 0x1d50, 0x9999, &collections));
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
        let collections = [(Some(0xFF00), Some(0x0001u16))];
        assert!(!device_is_blocked(rules, 0x0b0e, 0x0000, &collections));
    }
}
