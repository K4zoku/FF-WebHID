use super::*;

fn device(vendor_id: u16, product_id: u16, usage_page: u16, usage: u16) -> DeviceInfo {
    DeviceInfo {
        vendor_id,
        product_id,
        product_name: String::new(),
        manufacturer: None,
        serial_number: None,
        usage_page: Some(usage_page),
        usage: Some(usage),
        device_id: 1,
        collections: vec![Collection {
            collection_type: 1,
            usage_page: Some(usage_page),
            usage: Some(usage),
            children: Vec::new(),
            input_reports: Vec::new(),
            output_reports: Vec::new(),
            feature_reports: Vec::new(),
        }],
        max_input_report_size: 0,
        descriptor_parse_failed: false,
        raw_descriptor: Vec::new(),
    }
}

fn filter(vendor_id: Option<u16>, product_id: Option<u16>) -> DeviceFilter {
    DeviceFilter {
        vendor_id: vendor_id.map(u32::from),
        product_id: product_id.map(u32::from),
        usage_page: None,
        usage: None,
    }
}

#[test]
fn prefilter_rejects_vid_pid_mismatch() {
    let query = EnumerateFilter {
        filters: vec![filter(Some(0x16c0), Some(1))],
        exclusion_filters: Vec::new(),
    };
    assert!(matches_vid_pid(0x16c0, 1, &query));
    assert!(!matches_vid_pid(0x16c0, 2, &query));
}

#[test]
fn prefilter_keeps_usage_only_filters_for_deep_matching() {
    let query = EnumerateFilter {
        filters: vec![DeviceFilter {
            vendor_id: None,
            product_id: None,
            usage_page: Some(1),
            usage: Some(5),
        }],
        exclusion_filters: Vec::new(),
    };
    assert!(matches_vid_pid(1, 2, &query));
}

#[test]
fn deep_matching_preserves_inclusion_and_exclusion_semantics() {
    let query = EnumerateFilter {
        filters: vec![DeviceFilter {
            vendor_id: Some(0x16c0),
            product_id: Some(1),
            usage_page: Some(1),
            usage: Some(5),
        }],
        exclusion_filters: vec![filter(Some(0x16c0), Some(2))],
    };
    assert!(matches_device(&device(0x16c0, 1, 1, 5), &query));
    assert!(!matches_device(&device(0x16c0, 1, 1, 6), &query));
    assert!(!matches_device(&device(0x16c0, 2, 1, 5), &query));
}
