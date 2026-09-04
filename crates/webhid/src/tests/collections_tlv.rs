use super::*;

#[test]
fn test_unit_system_from_nibble_none() {
    assert_eq!(unit_system_from_nibble(0), "none");
}

#[test]
fn test_unit_system_from_nibble_si_linear() {
    assert_eq!(unit_system_from_nibble(1), "si-linear");
}

#[test]
fn test_unit_system_from_nibble_si_rotation() {
    assert_eq!(unit_system_from_nibble(2), "si-rotation");
}

#[test]
fn test_unit_system_from_nibble_english_linear() {
    assert_eq!(unit_system_from_nibble(3), "english-linear");
}

#[test]
fn test_unit_system_from_nibble_english_rotation() {
    assert_eq!(unit_system_from_nibble(4), "english-rotation");
}

#[test]
fn test_unit_system_from_nibble_vendor_defined() {
    assert_eq!(unit_system_from_nibble(15), "vendor-defined");
}

#[test]
fn test_unit_system_from_nibble_reserved() {
    assert_eq!(unit_system_from_nibble(5), "reserved");
    assert_eq!(unit_system_from_nibble(7), "reserved");
    assert_eq!(unit_system_from_nibble(8), "reserved");
    assert_eq!(unit_system_from_nibble(14), "reserved");
}

fn make_test_collection() -> Vec<Collection> {
    vec![Collection {
        collection_type: 1,
        usage_page: Some(0x01),
        usage: Some(0x02),
        children: vec![],
        input_reports: vec![Report {
            report_id: 0,
            items: vec![Field {
                usages: Some(vec![0x10001, 0x10002]),
                usage_minimum: None,
                usage_maximum: None,
                report_size: 8,
                report_count: 2,
                logical_minimum: 0,
                logical_maximum: 255,
                physical_minimum: 0,
                physical_maximum: 255,
                unit_exponent: 0,
                unit_system: "none".to_string(),
                unit_factor_length_exponent: 0,
                unit_factor_mass_exponent: 0,
                unit_factor_time_exponent: 0,
                unit_factor_temperature_exponent: 0,
                unit_factor_current_exponent: 0,
                unit_factor_luminous_intensity_exponent: 0,
                is_absolute: true,
                is_array: false,
                is_range: false,
                is_constant: false,
                is_linear: true,
                is_volatile: false,
                is_buffered_bytes: false,
                has_null: false,
                has_preferred_state: false,
                wrap: false,
                strings: vec![],
            }],
        }],
        output_reports: vec![],
        feature_reports: vec![],
    }]
}

fn encode_collections(collections: &[Collection]) -> Vec<u8> {
    let mut buf = Vec::new();
    for col in collections {
        encode_collection(&mut buf, col);
    }
    buf
}

fn decode_collections(buf: &[u8]) -> Vec<Collection> {
    let mut off = 0;
    let mut decoded = Vec::new();
    while off < buf.len() {
        let tag = buf[off];
        let node = decode_node(buf, &mut off);
        if tag == TAG_COLLECTION
            && let Node::Collection(c) = node
        {
            decoded.push(c);
        }
    }
    decoded
}

#[test]
fn test_roundtrip_basic() {
    let original = make_test_collection();
    let decoded = decode_collections(&encode_collections(&original));
    assert_eq!(decoded.len(), original.len());
    let orig = &original[0];
    let dec = &decoded[0];
    assert_eq!(dec.collection_type, orig.collection_type);
    assert_eq!(dec.usage_page, orig.usage_page);
    assert_eq!(dec.usage, orig.usage);
    assert_eq!(dec.input_reports.len(), 1);
    let orig_r = &orig.input_reports[0];
    let dec_r = &dec.input_reports[0];
    assert_eq!(dec_r.report_id, orig_r.report_id);
    assert_eq!(dec_r.items.len(), 1);
    let orig_f = &orig_r.items[0];
    let dec_f = &dec_r.items[0];
    assert_eq!(dec_f.report_size, orig_f.report_size);
    assert_eq!(dec_f.report_count, orig_f.report_count);
    assert_eq!(dec_f.logical_minimum, orig_f.logical_minimum);
    assert_eq!(dec_f.logical_maximum, orig_f.logical_maximum);
    assert_eq!(dec_f.is_absolute, orig_f.is_absolute);
    assert_eq!(dec_f.is_range, orig_f.is_range);
    assert_eq!(dec_f.usages, orig_f.usages);
}

#[test]
fn test_roundtrip_empty() {
    let original: Vec<Collection> = vec![];
    assert!(encode_collections(&original).is_empty());
}

fn make_range_field() -> Field {
    Field {
        usages: None,
        usage_minimum: Some(0x10001),
        usage_maximum: Some(0x10010),
        report_size: 16,
        report_count: 16,
        logical_minimum: 0,
        logical_maximum: 65535,
        physical_minimum: 0,
        physical_maximum: 65535,
        unit_exponent: 0,
        unit_system: "si-linear".to_string(),
        unit_factor_length_exponent: 1,
        unit_factor_mass_exponent: 0,
        unit_factor_time_exponent: 0,
        unit_factor_temperature_exponent: 0,
        unit_factor_current_exponent: 0,
        unit_factor_luminous_intensity_exponent: 0,
        is_absolute: false,
        is_array: true,
        is_range: true,
        is_constant: false,
        is_linear: false,
        is_volatile: true,
        is_buffered_bytes: false,
        has_null: true,
        has_preferred_state: true,
        wrap: false,
        strings: vec!["Button".to_string()],
    }
}

fn make_range_collection() -> Collection {
    Collection {
        collection_type: 1,
        usage_page: Some(0x01),
        usage: Some(0x04),
        children: vec![],
        input_reports: vec![Report {
            report_id: 1,
            items: vec![make_range_field()],
        }],
        output_reports: vec![],
        feature_reports: vec![],
    }
}

#[test]
fn test_roundtrip_range_field() {
    let original = vec![make_range_collection()];
    let decoded = decode_collections(&encode_collections(&original));
    assert_eq!(decoded.len(), 1);
    let f = &decoded[0].input_reports[0].items[0];
    assert!(f.is_range);
    assert_eq!(f.usage_minimum, Some(0x10001));
    assert_eq!(f.usage_maximum, Some(0x10010));
    assert_eq!(f.unit_system, "si-linear");
    assert_eq!(f.unit_factor_length_exponent, 1);
    assert!(f.is_volatile);
    assert!(f.has_null);
    assert_eq!(f.strings, vec!["Button"]);
}

#[test]
fn test_serde_roundtrip() {
    let original = make_test_collection();
    let json = serde_json::to_string(&original).unwrap();
    let decoded: Vec<Collection> = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.len(), original.len());
}

#[test]
fn test_unknown_tag_skip() {
    let mut full = encode_collections(&make_test_collection());
    full.push(0xFF);
    write_varint(&mut full, 5);
    full.extend_from_slice(&[1, 2, 3, 4, 5]);
    full.extend_from_slice(&encode_collections(&make_test_collection()));
    let decoded = decode_collections(&full);
    assert_eq!(decoded.len(), 2);
}
