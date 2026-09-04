use super::*;

fn entry() -> DumpEntry {
    DumpEntry {
        device_id: 0x1234abcd,
        vendor_id: 0x1234,
        product_id: 0x5678,
        product_name: "Test".into(),
        manufacturer: Some("ACME".into()),
        serial_number: None,
        usage_page: 0xff00,
        usage: 0x01,
        path: "/dev/hidraw9".into(),
        device_blocked: None,
        vendor_product_blocked: None,
        descriptor_bytes: 8,
        descriptor_hex: None,
        parse_error: Some("Invalid data at offset 4: Missing Usages for main item".into()),
        collections: 0,
        max_input_report_size: 0,
        visible_in_picker: true,
    }
}

#[test]
fn test_format_text_parse_failed() {
    let text = entry().format_text();
    assert!(text.contains("1234:5678"), "vid:pid shown");
    assert!(text.contains("block: none"));
    assert!(
        text.contains("parse: failed: Invalid data at offset 4"),
        "parse error reason shown"
    );
    assert!(text.contains("picker: visible"));
}

#[test]
fn test_format_text_blocked() {
    let mut e = entry();
    e.device_blocked = Some("FIDO usage page 0xf1d0".into());
    e.parse_error = None;
    e.collections = 2;
    e.max_input_report_size = 64;
    e.visible_in_picker = false;
    let text = e.format_text();
    assert!(text.contains("block: FIDO usage page 0xf1d0"));
    assert!(text.contains("parse: ok (2 collection(s), max input 64 bytes)"));
    assert!(text.contains("picker: hidden"));
}

#[test]
fn test_json_skips_absent_optionals() {
    let json = serde_json::to_string(&entry()).unwrap();
    assert!(json.contains("visible_in_picker"));
    assert!(json.contains("parse_error"));
    assert!(
        !json.contains("descriptor_hex"),
        "absent hex must be omitted"
    );
    assert!(
        !json.contains("serial_number"),
        "absent serial must be omitted"
    );
}
