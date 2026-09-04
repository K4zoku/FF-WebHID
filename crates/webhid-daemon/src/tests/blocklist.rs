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
    assert!(!device_is_blocked(rules, 0x1234, 0x5678));
    for usage in [0x0002, 0x0006, 0x0007, 0x0080] {
        assert!(
            is_report_blocked(
                rules,
                0x1234,
                0x5678,
                Some(0x0001),
                Some(usage),
                1,
                ReportType::Input,
            ),
            "usage {usage:#06x} should be blocked"
        );
    }
    assert!(is_report_blocked(
        rules,
        0x1234,
        0x5678,
        Some(0x0001),
        Some(0x0006),
        1,
        ReportType::Output,
    ));
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
