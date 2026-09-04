use super::*;
use webhid::{Collection, Report};

fn col(usage_page: Option<u16>, usage: Option<u16>, input_ids: &[u8]) -> Collection {
    Collection {
        collection_type: 1,
        usage_page,
        usage,
        children: vec![],
        input_reports: input_ids
            .iter()
            .map(|&report_id| Report {
                report_id,
                items: vec![],
            })
            .collect(),
        output_reports: vec![],
        feature_reports: vec![],
    }
}

fn device_info(collections: Vec<Collection>) -> DeviceInfo {
    DeviceInfo {
        vendor_id: 0x1234,
        product_id: 0x5678,
        product_name: String::new(),
        manufacturer: None,
        serial_number: None,
        usage_page: None,
        usage: None,
        device_id: 1,
        descriptor_parse_failed: collections.is_empty(),
        collections,
        max_input_report_size: 64,
        raw_descriptor: Vec::new(),
    }
}

#[test]
fn test_associations_any_protected_rule_only() {
    let rules = blocklist::blocklist_rules();
    let all_blocked = vec![(Some(0xF1D0), None, true), (Some(0xF1D0), None, true)];
    assert!(associations_any_protected(
        rules,
        0x1234,
        0x5678,
        &all_blocked,
        0x01,
        ReportType::Input
    ));
    let mixed = vec![
        (Some(0xF1D0), None, true),
        (Some(0x0001), Some(0x0004), true),
    ];
    assert!(associations_any_protected(
        rules,
        0x1234,
        0x5678,
        &mixed,
        0x01,
        ReportType::Input
    ));
    let none_match = vec![
        (Some(0x0001), Some(0x0004), true),
        (Some(0x0001), Some(0x0005), true),
    ];
    assert!(!associations_any_protected(
        rules,
        0x1234,
        0x5678,
        &none_match,
        0x01,
        ReportType::Input
    ));
    assert!(!associations_any_protected(
        rules,
        0x1234,
        0x5678,
        &[],
        0x01,
        ReportType::Input
    ));
}

#[test]
fn test_associations_any_protected_always_protected() {
    let rules = blocklist::blocklist_rules();
    type AlwaysProtectedCase = (
        &'static [(Option<u16>, Option<u16>, bool)],
        ReportType,
        bool,
    );
    let cases: &[AlwaysProtectedCase] = &[
        (&[(Some(0x0007), None, true)], ReportType::Input, true),
        (&[(Some(0x0007), None, true)], ReportType::Feature, true),
        (
            &[(Some(0x0001), Some(0x0001), true)],
            ReportType::Input,
            true,
        ),
        (
            &[(Some(0x0001), Some(0x0001), true)],
            ReportType::Output,
            true,
        ),
        (
            &[(Some(0x0001), Some(0x0001), true)],
            ReportType::Feature,
            false,
        ),
        (
            &[(Some(0x0001), Some(0x0001), false)],
            ReportType::Input,
            false,
        ),
        (
            &[(Some(0x0001), Some(0x0085), true)],
            ReportType::Feature,
            true,
        ),
        (
            &[(Some(0x0001), Some(0x00b6), true)],
            ReportType::Input,
            true,
        ),
        (
            &[(Some(0x0001), Some(0x0095), true)],
            ReportType::Input,
            false,
        ),
        (
            &[(Some(0x0002), Some(0x0006), true)],
            ReportType::Input,
            false,
        ),
    ];
    for (assoc, report_type, expected) in cases {
        assert_eq!(
            associations_any_protected(rules, 0x1234, 0x5678, assoc, 0x01, *report_type),
            *expected,
            "associations {assoc:?}, report type {report_type:?}"
        );
    }
}

#[test]
fn test_compute_blocked_input_ids_any_association_blocks() {
    let info = device_info(vec![
        col(Some(0x0001), Some(0x0006), &[0]),
        col(Some(0x0001), Some(0x0004), &[0]),
    ]);
    let map = build_report_collection_map(&info);
    assert_eq!(
        compute_blocked_input_ids(info.vendor_id, info.product_id, &map),
        HashSet::from([0])
    );

    let info = device_info(vec![
        col(Some(0x0001), Some(0x0006), &[0]),
        col(Some(0x0001), Some(0x0002), &[0]),
    ]);
    let map = build_report_collection_map(&info);
    assert_eq!(
        compute_blocked_input_ids(info.vendor_id, info.product_id, &map),
        HashSet::from([0])
    );

    let info = device_info(vec![col(Some(0x0001), Some(0x0006), &[0])]);
    let map = build_report_collection_map(&info);
    assert_eq!(
        compute_blocked_input_ids(info.vendor_id, info.product_id, &map),
        HashSet::from([0])
    );

    let info = device_info(vec![
        col(Some(0x0001), Some(0x0006), &[0, 1]),
        col(Some(0x0001), Some(0x0004), &[1]),
    ]);
    let map = build_report_collection_map(&info);
    assert_eq!(
        compute_blocked_input_ids(info.vendor_id, info.product_id, &map),
        HashSet::from([0, 1])
    );

    let info = device_info(vec![col(Some(0x0001), Some(0x0004), &[0])]);
    let map = build_report_collection_map(&info);
    assert!(compute_blocked_input_ids(info.vendor_id, info.product_id, &map).is_empty());
}

fn read_fixture(file: &str) -> DeviceInfo {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/descriptors/"
    );
    let bytes = std::fs::read(format!("{path}{file}")).unwrap_or_else(|e| panic!("{file}: {e}"));
    let info = DeviceInfo {
        vendor_id: 0x16c0,
        product_id: 0x0001,
        product_name: String::new(),
        manufacturer: None,
        serial_number: None,
        usage_page: None,
        usage: None,
        device_id: 1,
        descriptor_parse_failed: false,
        collections: crate::descriptor::parse_report_descriptor(&bytes)
            .unwrap_or_else(|e| panic!("{file}: descriptor parse failed: {e}")),
        max_input_report_size: 0,
        raw_descriptor: bytes,
    };
    assert!(
        !info.collections.is_empty(),
        "{file}: descriptor failed to parse"
    );
    info
}

#[test]
fn test_e2e_fixtures_unblocked_with_report_blocking() {
    for file in ["vendor.bin", "gamepad.bin"] {
        let info = read_fixture(file);
        let map = build_report_collection_map(&info);
        let blocked = compute_blocked_input_ids(info.vendor_id, info.product_id, &map);
        assert!(
            blocked.is_empty(),
            "{file}: e2e fixture unexpectedly blocked input reports {blocked:?}"
        );
    }
}

#[test]
fn test_e2e_consumer_input_fixtures_blocked_and_hidden() {
    for file in ["mouse.bin", "keyboard.bin"] {
        let info = read_fixture(file);
        let map = build_report_collection_map(&info);
        let blocked = compute_blocked_input_ids(info.vendor_id, info.product_id, &map);
        assert!(
            !blocked.is_empty(),
            "{file}: consumer-input fixture unexpectedly unblocked"
        );
        assert!(
            prune_device_info(info).is_none(),
            "{file}: should be hidden after pruning"
        );
    }
}

#[test]
fn test_e2e_fixtures_stay_visible_after_pruning() {
    for file in ["vendor.bin", "gamepad.bin"] {
        let info = read_fixture(file);
        let pruned = prune_device_info(info).expect("{file} kept");
        assert!(!pruned.collections.is_empty());
    }
}

#[test]
fn test_prune_keyboard_only_hidden() {
    let kb = device_info(vec![col(Some(0x0001), Some(0x0006), &[0])]);
    assert!(prune_device_info(kb).is_none());

    let kbd_page = device_info(vec![col(Some(0x0007), Some(0x0001), &[5])]);
    assert!(prune_device_info(kbd_page).is_none());
}

#[test]
fn test_unparseable_descriptor_device_hidden_fail_closed() {
    let info = device_info(vec![]);
    assert!(
        prune_device_info(info).is_none(),
        "parse-failed device must be hidden (fail closed)"
    );
}

#[test]
fn test_prune_mouse_physical_child_hidden() {
    let mut phys = col(Some(0x0009), Some(0x0001), &[3]);
    phys.collection_type = 0;
    let mut mouse = col(Some(0x0001), Some(0x0002), &[]);
    mouse.children = vec![phys];
    assert!(prune_device_info(device_info(vec![mouse])).is_none());
}

#[test]
fn test_prune_mixed_vendor_keyboard() {
    let kb = col(Some(0x0001), Some(0x0006), &[0]);
    let vendor = webhid::Collection {
        collection_type: 1,
        usage_page: Some(0xFF00),
        usage: Some(0x0001),
        children: vec![],
        input_reports: vec![Report {
            report_id: 1,
            items: vec![],
        }],
        output_reports: vec![Report {
            report_id: 1,
            items: vec![],
        }],
        feature_reports: vec![],
    };
    let mut info = device_info(vec![kb, vendor]);
    info.max_input_report_size = 64;
    let pruned = prune_device_info(info).expect("vendor collection survives");
    assert_eq!(pruned.max_input_report_size, 64);
    assert_eq!(pruned.collections.len(), 1);
    let c = &pruned.collections[0];
    assert_eq!(c.usage_page, Some(0xFF00));
    assert_eq!(c.input_reports.len(), 1);
    assert_eq!(c.output_reports.len(), 1);
}

#[test]
fn test_prune_nested_keyboard() {
    let nested_kb = col(Some(0x0001), Some(0x0006), &[1]);
    let mut vendor = col(Some(0xFF00), Some(0x0001), &[2]);
    vendor.children = vec![nested_kb];
    let pruned = prune_device_info(device_info(vec![vendor])).expect("vendor kept");
    assert_eq!(pruned.collections.len(), 1);
    assert!(
        pruned.collections[0].children.is_empty(),
        "keyboard child pruned"
    );
    assert_eq!(pruned.collections[0].input_reports.len(), 1);

    let mut vendor2 = col(Some(0xFF00), Some(0x0001), &[]);
    vendor2.children = vec![col(Some(0x0001), Some(0x0006), &[1])];
    assert!(prune_device_info(device_info(vec![vendor2])).is_none());
}

#[test]
fn test_prune_pointer_physical_under_vendor_kept() {
    let mut phys = col(Some(0x0001), Some(0x0001), &[3]);
    phys.collection_type = 0;
    let mut vendor = col(Some(0xFF00), Some(0x0001), &[2]);
    vendor.children = vec![phys];
    let pruned = prune_device_info(device_info(vec![vendor])).expect("kept");
    assert_eq!(pruned.collections.len(), 1);
    assert_eq!(pruned.collections[0].children.len(), 1);
    assert_eq!(pruned.collections[0].children[0].input_reports.len(), 1);
}

#[test]
fn test_report_write_valid() {
    assert!(!report_write_valid(true, 64, 0, Some(64)));
    assert!(report_write_valid(true, 64, 1, Some(64)));
    assert!(report_write_valid(false, 64, 0, Some(64)));
    assert!(!report_write_valid(false, 64, 1, Some(64)));
    assert!(!report_write_valid(true, 64, 1, Some(65)));
    assert!(report_write_valid(true, 64, 1, Some(64)));
    assert!(!report_write_valid(true, 0, 1, Some(1024)));
    assert!(!report_write_valid(true, 0, 0, Some(1024)));
    assert!(report_write_valid(false, 64, 0, None));
    assert!(!report_write_valid(false, 64, 1, None));
    assert!(!report_write_valid(true, 0, 2, None));
}

#[test]
fn test_interface_protected_fallback() {
    let boot_kb = DeviceInfo {
        usage_page: Some(0x0001),
        usage: Some(0x0006),
        ..device_info(vec![])
    };
    assert!(interface_protected(&boot_kb, ReportType::Input));
    assert!(interface_protected(&boot_kb, ReportType::Output));

    let boot_mouse = DeviceInfo {
        usage_page: Some(0x0001),
        usage: Some(0x0002),
        ..device_info(vec![])
    };
    assert!(interface_protected(&boot_mouse, ReportType::Input));
    assert!(interface_protected(&boot_mouse, ReportType::Feature));

    let vendor = DeviceInfo {
        usage_page: Some(0xFF00),
        usage: Some(0x0001),
        ..device_info(vec![])
    };
    assert!(!interface_protected(&vendor, ReportType::Input));
    assert!(!interface_protected(&vendor, ReportType::Output));
    assert!(!interface_protected(&vendor, ReportType::Feature));

    let parsed = device_info(vec![col(Some(0x0001), Some(0x0006), &[0])]);
    assert!(!interface_protected(&parsed, ReportType::Input));
}

#[test]
fn test_always_protected_fallback() {
    let kb = device_info(vec![col(Some(0x0001), Some(0x0006), &[0])]);
    assert!(has_always_protected_collection(&kb, ReportType::Input));
    assert!(has_always_protected_collection(&kb, ReportType::Output));
    assert!(!has_always_protected_collection(&kb, ReportType::Feature));

    let mouse = device_info(vec![col(Some(0x0001), Some(0x0002), &[0])]);
    assert!(has_always_protected_collection(&mouse, ReportType::Input));
    assert!(!has_always_protected_collection(
        &mouse,
        ReportType::Feature
    ));

    let vendor = device_info(vec![col(Some(0xFF00), Some(0x0001), &[1])]);
    assert!(!has_always_protected_collection(&vendor, ReportType::Input));
    assert!(!has_always_protected_collection(
        &vendor,
        ReportType::Output
    ));
    assert!(!has_always_protected_collection(
        &vendor,
        ReportType::Feature
    ));
}

#[test]
fn test_compute_blocked_input_ids_nested_collections() {
    let nested_kb = col(Some(0x0001), Some(0x0006), &[1]);
    let mut vendor = col(Some(0xFF00), Some(0x0001), &[]);
    vendor.children = vec![nested_kb];
    let info = device_info(vec![vendor]);
    let map = build_report_collection_map(&info);
    assert_eq!(
        compute_blocked_input_ids(info.vendor_id, info.product_id, &map),
        HashSet::from([1])
    );

    let mut phys = col(Some(0x0009), Some(0x0001), &[3]);
    phys.collection_type = 0;
    let mut mouse = col(Some(0x0001), Some(0x0002), &[]);
    mouse.children = vec![phys];
    let info = device_info(vec![mouse]);
    let map = build_report_collection_map(&info);
    assert_eq!(
        compute_blocked_input_ids(info.vendor_id, info.product_id, &map),
        HashSet::from([3])
    );

    let mut phys = col(Some(0x0001), Some(0x0001), &[3]);
    phys.collection_type = 0;
    let mut vendor = col(Some(0xFF00), Some(0x0001), &[]);
    vendor.children = vec![phys];
    let info = device_info(vec![vendor]);
    let map = build_report_collection_map(&info);
    assert!(compute_blocked_input_ids(info.vendor_id, info.product_id, &map).is_empty());
}

const VENDOR_PAGE: &[u8] = &[0x06, 0x00, 0xFF]; // Usage Page (Vendor 0xFF00)
const GD_PAGE: &[u8] = &[0x05, 0x01]; // Usage Page (Generic Desktop 0x0001)
const CONSUMER_PAGE: &[u8] = &[0x05, 0x0C]; // Usage Page (Consumer 0x000C)

/// Bytes for one Application collection holding a single 8-bit variable
/// input field. `report_id: None` emits no Report ID item, inheriting the
/// one currently in effect.
fn app_input_collection(
    page: &[u8],
    collection_usage: u8,
    report_id: Option<u8>,
    field_usage: u8,
) -> Vec<u8> {
    let mut d = Vec::new();
    d.extend_from_slice(page);
    d.extend_from_slice(&[0x09, collection_usage]); // Usage (collection)
    d.extend_from_slice(&[0xA1, 0x01]); // Collection (Application)
    if let Some(rid) = report_id {
        d.extend_from_slice(&[0x85, rid]); // Report ID
    }
    d.extend_from_slice(&[0x09, field_usage]); // Usage (field)
    d.extend_from_slice(&[0x75, 0x08]); // Report Size (8)
    d.extend_from_slice(&[0x95, 0x01]); // Report Count (1)
    d.extend_from_slice(&[0x81, 0x02]); // Input (Data,Var,Abs)
    d.extend_from_slice(&[0xC0]); // End Collection
    d
}

/// Build a `DeviceInfo` from a raw report descriptor, retaining the bytes
/// in `raw_descriptor`.
fn device_from_descriptor(desc: &[u8]) -> DeviceInfo {
    let collections =
        crate::descriptor::parse_report_descriptor(desc).expect("test descriptor parses");
    DeviceInfo {
        vendor_id: 0x1234,
        product_id: 0x5678,
        product_name: String::new(),
        manufacturer: None,
        serial_number: None,
        usage_page: None,
        usage: None,
        device_id: 1,
        descriptor_parse_failed: false,
        collections,
        max_input_report_size: 64,
        raw_descriptor: desc.to_vec(),
    }
}

/// Protected input report IDs for `info`.
fn blocked_inputs(info: &DeviceInfo) -> HashSet<u8> {
    let map = build_report_collection_map(info);
    compute_blocked_input_ids(info.vendor_id, info.product_id, &map)
}

#[test]
fn test_vendor_only_report_not_protected() {
    let desc = app_input_collection(VENDOR_PAGE, 0x01, Some(5), 0x02);
    let info = device_from_descriptor(&desc);
    assert!(blocked_inputs(&info).is_empty());
    assert!(prune_device_info(info).is_some());
}

#[test]
fn test_keyboard_only_report_protected_and_hidden() {
    let desc = app_input_collection(GD_PAGE, 0x06, Some(5), 0x07);
    let info = device_from_descriptor(&desc);
    assert_eq!(blocked_inputs(&info), HashSet::from([5]));
    assert!(prune_device_info(info).is_none());
}

#[test]
fn test_mixed_report_field_order_does_not_change_protection() {
    // Report 5 spans a vendor and a keyboard collection.
    let mut vendor_first = Vec::new();
    vendor_first.extend(app_input_collection(VENDOR_PAGE, 0x01, Some(5), 0x02));
    vendor_first.extend(app_input_collection(GD_PAGE, 0x06, None, 0x07));

    let mut keyboard_first = Vec::new();
    keyboard_first.extend(app_input_collection(GD_PAGE, 0x06, Some(5), 0x07));
    keyboard_first.extend(app_input_collection(VENDOR_PAGE, 0x01, None, 0x02));

    let vf = device_from_descriptor(&vendor_first);
    let kf = device_from_descriptor(&keyboard_first);
    assert_eq!(blocked_inputs(&vf), HashSet::from([5]));
    assert_eq!(blocked_inputs(&kf), HashSet::from([5]));
}

#[test]
fn test_protected_field_in_middle_still_protects_report() {
    // Report 5 spans vendor, keyboard, then consumer collections.
    let mut desc = Vec::new();
    desc.extend(app_input_collection(VENDOR_PAGE, 0x01, Some(5), 0x02));
    desc.extend(app_input_collection(GD_PAGE, 0x06, None, 0x07));
    desc.extend(app_input_collection(CONSUMER_PAGE, 0x01, None, 0x02));
    let info = device_from_descriptor(&desc);
    assert_eq!(blocked_inputs(&info), HashSet::from([5]));
}

#[test]
fn test_only_affected_report_id_blocked() {
    // Report 5 vendor-only, report 6 keyboard.
    let mut desc = Vec::new();
    desc.extend(app_input_collection(VENDOR_PAGE, 0x01, Some(5), 0x02));
    desc.extend(app_input_collection(GD_PAGE, 0x06, Some(6), 0x07));
    let info = device_from_descriptor(&desc);
    assert_eq!(blocked_inputs(&info), HashSet::from([6]));
}

#[test]
fn test_padding_does_not_alter_classification() {
    let mut desc = Vec::new();
    desc.extend_from_slice(VENDOR_PAGE);
    desc.extend_from_slice(&[0x09, 0x01]);
    desc.extend_from_slice(&[0xA1, 0x01]);
    desc.extend_from_slice(&[0x85, 0x05]); // Report ID 5
    desc.extend_from_slice(&[0x09, 0x02]);
    desc.extend_from_slice(&[0x75, 0x08, 0x95, 0x01]);
    desc.extend_from_slice(&[0x81, 0x02]); // vendor data field
    desc.extend_from_slice(&[0x75, 0x08, 0x95, 0x03]);
    desc.extend_from_slice(&[0x81, 0x01]); // constant padding
    desc.extend_from_slice(&[0xC0]);
    desc.extend(app_input_collection(GD_PAGE, 0x06, None, 0x07));
    let info = device_from_descriptor(&desc);
    assert_eq!(blocked_inputs(&info), HashSet::from([5]));
}

#[test]
fn test_mixed_protected_report_pruned_from_visible_metadata() {
    let mut desc = Vec::new();
    desc.extend(app_input_collection(VENDOR_PAGE, 0x01, Some(5), 0x02));
    desc.extend(app_input_collection(GD_PAGE, 0x06, None, 0x07));
    let info = device_from_descriptor(&desc);
    assert!(prune_device_info(info).is_none());
}

#[test]
fn test_protected_report_id_removed_from_every_collection() {
    let mut desc = Vec::new();
    desc.extend(app_input_collection(VENDOR_PAGE, 0x01, Some(5), 0x02));
    desc.extend(app_input_collection(VENDOR_PAGE, 0x01, Some(6), 0x02));
    desc.extend(app_input_collection(GD_PAGE, 0x06, Some(5), 0x07));
    let info = device_from_descriptor(&desc);
    let pruned = prune_device_info(info).expect("device stays visible via report 6");
    assert_eq!(pruned.collections.len(), 1);
    let vendor_col = &pruned.collections[0];
    assert_eq!(vendor_col.usage_page, Some(0xFF00));
    assert_eq!(vendor_col.input_reports.len(), 1);
    assert_eq!(vendor_col.input_reports[0].report_id, 6);
    assert!(
        !pruned
            .collections
            .iter()
            .any(|c| c.input_reports.iter().any(|r| r.report_id == 5)),
        "protected report id 5 must be absent from every visible collection"
    );
}
