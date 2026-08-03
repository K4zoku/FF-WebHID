//! Report-level protection: mirrors Chromium's blocklist application on the
//! daemon side. Function names and semantics cross-reference Chromium source
//! directly so a future Chromium change becomes a diff-by-name exercise:
//! - rule matching: `services/device/public/cpp/hid/hid_blocklist.cc`
//! - always-protected usages and report lookup: `services/device/public/cpp/hid/hid_report_utils.cc`
//! - per-device protected sets: `services/device/hid/hid_device_info.cc`
//! - runtime per-report decision and send pre-checks: `services/device/hid/hid_connection.cc`
//! - page-visible pruning: `content/browser/hid/hid_service.cc`

use std::collections::{HashMap, HashSet};

use webhid::DeviceInfo;

use crate::blocklist::{self, ReportType};

/// One collection on a report's chain: usage_page, usage, and whether the
/// collection is an Application collection (type 0x01). Chromium propagates
/// every report to all of its ancestor collections (hid_collection.cc), so a
/// report is associated with every collection from its innermost container up
/// to the top level; the Application flag mirrors the Application-only gate
/// in Chromium's HasReportInAlwaysProtectedCollection.
type ReportAssociation = (Option<u16>, Option<u16>, bool);

/// (report_id, report_type) -> every collection association for that report.
/// Multiple collections can share a report_id (notably unnumbered report 0),
/// so each key carries a list. Nested child collections are walked
/// recursively, mirroring Chromium's kWebHidRecursiveFiltering (enabled by
/// default) so reports living in child collections (e.g. a Keyboard nested
/// under a vendor top-level) are seen.
type ReportCollectionMap = HashMap<(u8, u8), Vec<ReportAssociation>>;

fn build_report_collection_map(info: &DeviceInfo) -> ReportCollectionMap {
    fn walk(
        col: &webhid::Collection,
        ancestors: &[ReportAssociation],
        map: &mut ReportCollectionMap,
    ) {
        let is_app = col.collection_type == 1; // Application
        let mut chain = Vec::with_capacity(ancestors.len() + 1);
        chain.extend_from_slice(ancestors);
        chain.push((col.usage_page, col.usage, is_app));
        for r in &col.input_reports {
            map.entry((r.report_id, 0))
                .or_default()
                .extend_from_slice(&chain);
        }
        for r in &col.output_reports {
            map.entry((r.report_id, 1))
                .or_default()
                .extend_from_slice(&chain);
        }
        for r in &col.feature_reports {
            map.entry((r.report_id, 2))
                .or_default()
                .extend_from_slice(&chain);
        }
        for c in &col.children {
            walk(c, &chain, map);
        }
    }
    let mut map: ReportCollectionMap = HashMap::new();
    for col in &info.collections {
        walk(col, &[], &mut map);
    }
    map
}

fn always_protected_usage(up: Option<u16>, u: Option<u16>, rt: ReportType) -> bool {
    blocklist::is_always_protected(up, u, rt)
}

// A report is protected when ANY collection association matches a blocklist
// rule, or when an Application collection on its chain is always protected.
// This mirrors Chromium's HidBlocklist::GetProtectedReportIds (union of the
// report IDs of every collection matching a rule) plus the hardcoded
// IsAlwaysProtected layer (HidConnection::IsReportProtected): if a keyboard
// collection and a vendor collection share a report_id (common for unnumbered
// report 0), the report is still dropped because the keyboard data in it must
// never reach the page. An empty association list never blocks.
fn associations_any_protected(
    rules: &[blocklist::BlocklistRule],
    vendor_id: u16,
    product_id: u16,
    associations: &[ReportAssociation],
    report_id: u8,
    report_type: ReportType,
) -> bool {
    !associations.is_empty()
        && associations.iter().any(|(up, u, is_app)| {
            blocklist::is_report_blocked(
                rules, vendor_id, product_id, *up, *u, report_id, report_type,
            ) || (*is_app && always_protected_usage(*up, *u, report_type))
        })
}

// Mirrors Chromium's HidConnection::HasAlwaysProtectedCollection: whether any
// TOP-LEVEL collection's usage is always protected for the report type. Used
// as the fallback for reports not declared anywhere in the descriptor (see
// HidConnection::IsReportProtected), where Chromium drops unknown report IDs
// on devices that carry an always-protected collection of that type.
fn has_always_protected_collection(info: &DeviceInfo, report_type: ReportType) -> bool {
    info.collections
        .iter()
        .any(|c| always_protected_usage(c.usage_page, c.usage, report_type))
}

// Fallback for devices whose report descriptor failed to parse (or is
// empty), so `collections` carries no blocking information: if the hidapi
// interface usage itself matches a blocklist rule or is always protected,
// every report is treated as protected. Chromium's parser is lenient enough
// to interpret such descriptors, so this closes the gap where an unparseable
// consumer-input device would otherwise flow unblocked (e.g. a boot-keyboard
// interface with an empty descriptor).
fn interface_protected(info: &DeviceInfo, report_type: ReportType) -> bool {
    if !info.collections.is_empty() {
        return false; // parsed: the report map handles blocking
    }
    let rules = blocklist::blocklist_rules();
    blocklist::is_report_blocked(
        rules,
        info.vendor_id,
        info.product_id,
        info.usage_page,
        info.usage,
        0,
        report_type,
    ) || always_protected_usage(info.usage_page, info.usage, report_type)
}

/// Chromium's `RemoveProtectedReports` (content/browser/hid/hid_service.cc):
/// prune blocked reports from the page-visible collection tree. A device
/// whose collections all become empty is hidden (`None`), matching
/// `OnDeviceAdded`'s `collections.empty()` check. Only the `collections`
/// field is touched: the report map, reader and send path keep working off
/// the full parse, and `max_input_report_size` is preserved.
pub fn prune_device_info(info: DeviceInfo) -> Option<DeviceInfo> {
    let map = build_report_collection_map(&info);
    let rules = blocklist::blocklist_rules();
    let collections: Vec<webhid::Collection> = info
        .collections
        .into_iter()
        .filter_map(|c| prune_collection(c, &map, rules, info.vendor_id, info.product_id))
        .collect();
    if collections.is_empty() {
        return None;
    }
    Some(DeviceInfo { collections, ..info })
}

fn prune_collection(
    col: webhid::Collection,
    map: &ReportCollectionMap,
    rules: &[blocklist::BlocklistRule],
    vendor_id: u16,
    product_id: u16,
) -> Option<webhid::Collection> {
    let children: Vec<webhid::Collection> = col
        .children
        .into_iter()
        .filter_map(|c| prune_collection(c, map, rules, vendor_id, product_id))
        .collect();
    let report_kept = |r: &webhid::Report, rt_byte: u8| -> bool {
        let report_type = match rt_byte {
            0 => ReportType::Input,
            1 => ReportType::Output,
            _ => ReportType::Feature,
        };
        let protected = map
            .get(&(r.report_id, rt_byte))
            .map(|assoc| {
                associations_any_protected(
                    rules,
                    vendor_id,
                    product_id,
                    assoc,
                    r.report_id,
                    report_type,
                )
            })
            .unwrap_or(false);
        !protected
    };
    let input_reports: Vec<webhid::Report> = col
        .input_reports
        .into_iter()
        .filter(|r| report_kept(r, 0))
        .collect();
    let output_reports: Vec<webhid::Report> = col
        .output_reports
        .into_iter()
        .filter(|r| report_kept(r, 1))
        .collect();
    let feature_reports: Vec<webhid::Report> = col
        .feature_reports
        .into_iter()
        .filter(|r| report_kept(r, 2))
        .collect();
    if input_reports.is_empty()
        && output_reports.is_empty()
        && feature_reports.is_empty()
        && children.is_empty()
    {
        return None;
    }
    Some(webhid::Collection {
        collection_type: col.collection_type,
        usage_page: col.usage_page,
        usage: col.usage,
        children,
        input_reports,
        output_reports,
        feature_reports,
    })
}

/// See [`DeviceReportBlocking::validate_report_send`]. Kept as a free
/// function so the Chromium-parity rules are unit-testable without opening a
/// device.
fn report_write_valid(
    numbered_reports: bool,
    max_size: u32,
    report_id: u8,
    payload_len: Option<usize>,
) -> bool {
    if numbered_reports != (report_id != 0) {
        return false;
    }
    if let Some(len) = payload_len
        && max_size > 0
        && len > max_size as usize
    {
        return false;
    }
    true
}

/// Input report IDs protected by the blocklist rules (Chromium's
/// `GetProtectedReportIds` for kReportTypeInput).
fn compute_blocked_input_ids(
    vendor_id: u16,
    product_id: u16,
    report_map: &ReportCollectionMap,
) -> HashSet<u8> {
    let rules = blocklist::blocklist_rules();
    let mut ids = HashSet::new();
    for (&(report_id, rt_byte), associations) in report_map {
        if rt_byte != 0 {
            continue;
        }
        if associations_any_protected(
            rules,
            vendor_id,
            product_id,
            associations,
            report_id,
            ReportType::Input,
        ) {
            ids.insert(report_id);
        }
    }
    ids
}

/// Per-device blocking state, computed once at open. Groups what Chromium
/// stores in `HidDeviceInfo` (protected report ID sets, has_report_id, max
/// report sizes) with the runtime checks `HidConnection` performs, so the
/// reader and send paths share one immutable context.
pub struct DeviceReportBlocking {
    pub(crate) map: ReportCollectionMap,
    /// IsAlwaysProtected fallback per report type (input/output/feature):
    /// whether any top-level collection is always protected for that type.
    pub(crate) always_protected: [bool; 3],
    /// Parse-failure fallback per report type: hidapi interface usage itself
    /// is protected (unparseable descriptor, e.g. empty boot-keyboard
    /// interface).
    pub(crate) interface_protected: [bool; 3],
    /// Report ID mode (any report ID present in the descriptor), used to
    /// validate send report IDs like Chromium's `has_report_id`.
    pub(crate) numbered_reports: bool,
    /// Declared max output/feature payload sizes in bytes (0 = not declared).
    pub(crate) max_output_report_size: u32,
    pub(crate) max_feature_report_size: u32,
}

impl DeviceReportBlocking {
    pub fn new(info: &DeviceInfo, numbered_reports: bool) -> Self {
        Self {
            map: build_report_collection_map(info),
            always_protected: [
                has_always_protected_collection(info, ReportType::Input),
                has_always_protected_collection(info, ReportType::Output),
                has_always_protected_collection(info, ReportType::Feature),
            ],
            interface_protected: [
                interface_protected(info, ReportType::Input),
                interface_protected(info, ReportType::Output),
                interface_protected(info, ReportType::Feature),
            ],
            numbered_reports,
            max_output_report_size: crate::descriptor::max_output_report_size(&info.collections),
            max_feature_report_size: crate::descriptor::max_feature_report_size(&info.collections),
        }
    }

    /// Input report IDs the reader must drop.
    pub fn blocked_input_ids(&self, vendor_id: u16, product_id: u16) -> HashSet<u8> {
        compute_blocked_input_ids(vendor_id, product_id, &self.map)
    }

    /// Every input report ID declared in the descriptor, used by the reader
    /// to distinguish documented reports from the always-protected fallback.
    pub fn declared_input_ids(&self) -> HashSet<u8> {
        self.map
            .keys()
            .filter(|(_, rt)| *rt == 0)
            .map(|(rid, _)| *rid)
            .collect()
    }

    /// Chromium's `HidConnection::IsReportProtected`: blocklist protected IDs
    /// plus the always-protected layer, with the undocumented-ID fallback.
    pub fn is_report_protected(
        &self,
        vendor_id: u16,
        product_id: u16,
        report_id: u8,
        report_type: ReportType,
    ) -> bool {
        let rt_byte = match report_type {
            ReportType::Input => 0,
            ReportType::Output => 1,
            ReportType::Feature => 2,
        };
        match self.map.get(&(report_id, rt_byte)) {
            Some(assoc) => associations_any_protected(
                blocklist::blocklist_rules(),
                vendor_id,
                product_id,
                assoc,
                report_id,
                report_type,
            ),
            // Undocumented report ID: Chromium falls back to blocking when
            // the device has an always-protected collection of this type, or
            // when the unparsed interface usage itself is protected.
            None => {
                self.always_protected[rt_byte as usize]
                    || self.interface_protected[rt_byte as usize]
            }
        }
    }

    /// Chromium's `HidConnection::Write` / `GetFeatureReport` /
    /// `SendFeatureReport` pre-checks: the report ID must be consistent with
    /// the device's numbered-report mode (`has_report_id != (report_id != 0)`
    /// in Chromium) and the payload must fit the declared max size for the
    /// report type. A payload length of `None` means a read (no payload). The
    /// max-size-zero case (report type not declared in the descriptor) is
    /// deliberately allowed: the daemon issues raw SET/GET_REPORT ioctls
    /// regardless of declaration, which the e2e feature-report coverage
    /// relies on.
    pub fn validate_report_send(
        &self,
        report_id: u8,
        report_type: ReportType,
        payload_len: Option<usize>,
    ) -> bool {
        let max_size = match report_type {
            ReportType::Output => self.max_output_report_size,
            ReportType::Feature => self.max_feature_report_size,
            ReportType::Input => return false,
        };
        report_write_valid(self.numbered_reports, max_size, report_id, payload_len)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use webhid::{Collection, Report};

    fn col(usage_page: Option<u16>, usage: Option<u16>, input_ids: &[u8]) -> Collection {
        Collection {
            collection_type: 1, // Application
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
            collections,
            max_input_report_size: 64,
        }
    }

    #[test]
    fn test_associations_any_protected_rule_only() {
        let rules = blocklist::blocklist_rules();
        // FIDO usage page is always blocked at the report level.
        let all_blocked = vec![(Some(0xF1D0), None, true), (Some(0xF1D0), None, true)];
        assert!(associations_any_protected(
            rules,
            0x1234,
            0x5678,
            &all_blocked,
            0x01,
            ReportType::Input
        ));
        // ANY blocked association blocks the report, even if another (Generic
        // Desktop / Joystick) is unblocked: the shared report may carry the
        // blocked collection's data.
        let mixed = vec![(Some(0xF1D0), None, true), (Some(0x0001), Some(0x0004), true)];
        assert!(associations_any_protected(
            rules,
            0x1234,
            0x5678,
            &mixed,
            0x01,
            ReportType::Input
        ));
        // No association matches -> not blocked.
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
        // No associations -> no blocking.
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
        // Usage page 0x07 (Keyboard/Keypad page) is always protected for
        // every report type.
        assert!(associations_any_protected(
            rules,
            0x1234,
            0x5678,
            &[(Some(0x0007), None, true)],
            0x01,
            ReportType::Input
        ));
        assert!(associations_any_protected(
            rules,
            0x1234,
            0x5678,
            &[(Some(0x0007), None, true)],
            0x01,
            ReportType::Feature
        ));
        // Generic Desktop Pointer is always protected for input/output but
        // not feature.
        assert!(associations_any_protected(
            rules,
            0x1234,
            0x5678,
            &[(Some(0x0001), Some(0x0001), true)],
            0x01,
            ReportType::Input
        ));
        assert!(associations_any_protected(
            rules,
            0x1234,
            0x5678,
            &[(Some(0x0001), Some(0x0001), true)],
            0x01,
            ReportType::Output
        ));
        assert!(!associations_any_protected(
            rules,
            0x1234,
            0x5678,
            &[(Some(0x0001), Some(0x0001), true)],
            0x01,
            ReportType::Feature
        ));
        // Always-protected requires an Application collection: a Pointer
        // usage on a Physical child is not enough on its own.
        assert!(!associations_any_protected(
            rules,
            0x1234,
            0x5678,
            &[(Some(0x0001), Some(0x0001), false)],
            0x01,
            ReportType::Input
        ));
        // System Control range 0x80-0x8f and 0xa0-0xb6 are always protected;
        // the gap 0x90-0x9f is not.
        assert!(associations_any_protected(
            rules,
            0x1234,
            0x5678,
            &[(Some(0x0001), Some(0x0085), true)],
            0x01,
            ReportType::Feature
        ));
        assert!(associations_any_protected(
            rules,
            0x1234,
            0x5678,
            &[(Some(0x0001), Some(0x00b6), true)],
            0x01,
            ReportType::Input
        ));
        assert!(!associations_any_protected(
            rules,
            0x1234,
            0x5678,
            &[(Some(0x0001), Some(0x0095), true)],
            0x01,
            ReportType::Input
        ));
        // Non-Generic-Desktop pages are not always protected.
        assert!(!associations_any_protected(
            rules,
            0x1234,
            0x5678,
            &[(Some(0x0002), Some(0x0006), true)],
            0x01,
            ReportType::Input
        ));
    }

    #[test]
    fn test_compute_blocked_input_ids_any_association_blocks() {
        // Keyboard (blocked) + Joystick (not blocked) share unnumbered id 0:
        // the keyboard association still blocks the shared report, matching
        // Chromium's union of protected report IDs.
        let info = device_info(vec![
            col(Some(0x0001), Some(0x0006), &[0]), // Keyboard
            col(Some(0x0001), Some(0x0004), &[0]), // Joystick
        ]);
        let map = build_report_collection_map(&info);
        assert_eq!(
            compute_blocked_input_ids(info.vendor_id, info.product_id, &map),
            HashSet::from([0])
        );

        // Keyboard + Mouse share id 0, both blocked -> dropped.
        let info = device_info(vec![
            col(Some(0x0001), Some(0x0006), &[0]), // Keyboard
            col(Some(0x0001), Some(0x0002), &[0]), // Mouse
        ]);
        let map = build_report_collection_map(&info);
        assert_eq!(
            compute_blocked_input_ids(info.vendor_id, info.product_id, &map),
            HashSet::from([0])
        );

        // Single blocked association still blocks.
        let info = device_info(vec![col(Some(0x0001), Some(0x0006), &[0])]);
        let map = build_report_collection_map(&info);
        assert_eq!(
            compute_blocked_input_ids(info.vendor_id, info.product_id, &map),
            HashSet::from([0])
        );

        // Id 0 is keyboard-only, id 1 is keyboard + joystick: both blocked,
        // because the keyboard declares both.
        let info = device_info(vec![
            col(Some(0x0001), Some(0x0006), &[0, 1]), // Keyboard
            col(Some(0x0001), Some(0x0004), &[1]),    // Joystick
        ]);
        let map = build_report_collection_map(&info);
        assert_eq!(
            compute_blocked_input_ids(info.vendor_id, info.product_id, &map),
            HashSet::from([0, 1])
        );

        // Nothing matches the rules -> nothing blocked.
        let info = device_info(vec![col(Some(0x0001), Some(0x0004), &[0])]); // Joystick
        let map = build_report_collection_map(&info);
        assert!(compute_blocked_input_ids(info.vendor_id, info.product_id, &map).is_empty());
    }

    #[test]
    fn test_e2e_fixtures_unblocked_with_report_blocking() {
        // vendor.bin and gamepad.bin must stay fully usable under
        // unconditional report-level blocking (Chromium parity).
        let read_fixture = |file: &str| -> DeviceInfo {
            let path = concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../tests/fixtures/descriptors/"
            );
            let bytes = std::fs::read(format!("{path}{file}"))
                .unwrap_or_else(|e| panic!("{file}: {e}"));
            let info = DeviceInfo {
                vendor_id: 0x16c0,
                product_id: 0x0001,
                product_name: String::new(),
                manufacturer: None,
                serial_number: None,
                usage_page: None,
                usage: None,
                device_id: 1,
                collections: crate::descriptor::parse_report_descriptor(&bytes),
                max_input_report_size: 0,
            };
            assert!(
                !info.collections.is_empty(),
                "{file}: descriptor failed to parse"
            );
            info
        };
        // vendor.bin and gamepad.bin carry no protected usages and must stay
        // fully usable. Regression guard for the default-features flip.
        for file in ["vendor.bin", "gamepad.bin"] {
            let info = read_fixture(file);
            let map = build_report_collection_map(&info);
            let blocked = compute_blocked_input_ids(info.vendor_id, info.product_id, &map);
            assert!(
                blocked.is_empty(),
                "{file}: e2e fixture unexpectedly blocked input reports {blocked:?}"
            );
        }
        // mouse.bin and keyboard.bin are consumer-input fixtures: their
        // reports must be blocked, matching Chromium (mouse reports sit in a
        // Physical child but propagate to the Mouse Application ancestor),
        // and pruning must hide the whole device.
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
        // vendor.bin and gamepad.bin stay fully visible after pruning.
        for file in ["vendor.bin", "gamepad.bin"] {
            let info = read_fixture(file);
            let pruned = prune_device_info(info).expect("{file} kept");
            assert!(!pruned.collections.is_empty());
        }
    }

    #[test]
    fn test_prune_keyboard_only_hidden() {
        // A device whose collections all become empty after pruning is hidden,
        // mirroring Chromium's OnDeviceAdded collections.empty() check.
        let kb = device_info(vec![col(Some(0x0001), Some(0x0006), &[0])]);
        assert!(prune_device_info(kb).is_none());

        // Usage page 0x07 (Keyboard/Keypad page) is always protected.
        let kbd_page = device_info(vec![col(Some(0x0007), Some(0x0001), &[5])]);
        assert!(prune_device_info(kbd_page).is_none());
    }

    #[test]
    fn test_prune_mouse_physical_child_hidden() {
        // Mouse report in a Physical child: the report propagates to the
        // Mouse Application ancestor, is blocked, and the whole device is
        // pruned to nothing.
        let mut phys = col(Some(0x0009), Some(0x0001), &[3]); // Physical/Pointer
        phys.collection_type = 0;
        let mut mouse = col(Some(0x0001), Some(0x0002), &[]); // Mouse top-level
        mouse.children = vec![phys];
        assert!(prune_device_info(device_info(vec![mouse])).is_none());
    }

    #[test]
    fn test_prune_mixed_vendor_keyboard() {
        // Vendor collection (report 1 in/out, unblocked) + Keyboard collection
        // (report 0, blocked): the keyboard collection is pruned, the vendor
        // collection survives with its reports, and max_input_report_size is
        // preserved.
        let kb = col(Some(0x0001), Some(0x0006), &[0]); // Keyboard
        let vendor = webhid::Collection {
            collection_type: 1,
            usage_page: Some(0xFF00),
            usage: Some(0x0001),
            children: vec![],
            input_reports: vec![Report { report_id: 1, items: vec![] }],
            output_reports: vec![Report { report_id: 1, items: vec![] }],
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
        // Keyboard nested under a vendor top-level: the child is pruned, the
        // vendor top-level survives with its own report.
        let nested_kb = col(Some(0x0001), Some(0x0006), &[1]); // Keyboard child
        let mut vendor = col(Some(0xFF00), Some(0x0001), &[2]); // vendor report 2
        vendor.children = vec![nested_kb];
        let pruned = prune_device_info(device_info(vec![vendor])).expect("vendor kept");
        assert_eq!(pruned.collections.len(), 1);
        assert!(pruned.collections[0].children.is_empty(), "keyboard child pruned");
        assert_eq!(pruned.collections[0].input_reports.len(), 1);

        // Vendor top-level with no own reports: everything pruned -> hidden.
        let mut vendor2 = col(Some(0xFF00), Some(0x0001), &[]);
        vendor2.children = vec![col(Some(0x0001), Some(0x0006), &[1])];
        assert!(prune_device_info(device_info(vec![vendor2])).is_none());
    }

    #[test]
    fn test_prune_pointer_physical_under_vendor_kept() {
        // Pointer-usage Physical child under a vendor top-level is not
        // protected (no rule, not an Application): everything survives.
        let mut phys = col(Some(0x0001), Some(0x0001), &[3]); // Physical/Pointer
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
        // Numbered device: report ID 0 is invalid, any non-zero ID is valid.
        assert!(!report_write_valid(true, 64, 0, Some(64)));
        assert!(report_write_valid(true, 64, 1, Some(64)));
        // Unnumbered device: only report ID 0 is valid.
        assert!(report_write_valid(false, 64, 0, Some(64)));
        assert!(!report_write_valid(false, 64, 1, Some(64)));
        // Oversized payload fails; exactly max passes.
        assert!(!report_write_valid(true, 64, 1, Some(65)));
        assert!(report_write_valid(true, 64, 1, Some(64)));
        // Undeclared report type (max size 0): size not enforced (raw
        // SET/GET_REPORT ioctl allowance the e2e feature coverage relies on),
        // but the report ID mode check still applies.
        assert!(report_write_valid(true, 0, 1, Some(1024)));
        assert!(!report_write_valid(true, 0, 0, Some(1024)));
        // Read (no payload): only the report ID mode check applies.
        assert!(report_write_valid(false, 64, 0, None));
        assert!(!report_write_valid(false, 64, 1, None));
        assert!(report_write_valid(true, 0, 2, None));
    }

    #[test]
    fn test_interface_protected_fallback() {
        // Unparseable/empty descriptor with a protected hidapi interface
        // usage (e.g. a boot-keyboard interface): every report is blocked.
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
        // Mouse feature reports are also blocked: the WICG Mouse rule carries
        // no reportType, so it matches feature reports too, exactly like
        // Chromium's GetProtectedReportIds for kReportTypeFeature.
        assert!(interface_protected(&boot_mouse, ReportType::Feature));

        // Vendor interface usage: never protected.
        let vendor = DeviceInfo {
            usage_page: Some(0xFF00),
            usage: Some(0x0001),
            ..device_info(vec![])
        };
        assert!(!interface_protected(&vendor, ReportType::Input));
        assert!(!interface_protected(&vendor, ReportType::Output));
        assert!(!interface_protected(&vendor, ReportType::Feature));

        // Parsed devices never take the interface path, even when their
        // top-level usage matches a rule (the report map handles them).
        let parsed = device_info(vec![col(Some(0x0001), Some(0x0006), &[0])]);
        assert!(!interface_protected(&parsed, ReportType::Input));
    }

    #[test]
    fn test_always_protected_fallback() {
        // Chromium's HasAlwaysProtectedCollection fallback: a keyboard
        // top-level protects input/output (not feature); vendor-only devices
        // have no always-protected collection.
        let kb = device_info(vec![col(Some(0x0001), Some(0x0006), &[0])]);
        assert!(has_always_protected_collection(&kb, ReportType::Input));
        assert!(has_always_protected_collection(&kb, ReportType::Output));
        assert!(!has_always_protected_collection(&kb, ReportType::Feature));

        let mouse = device_info(vec![col(Some(0x0001), Some(0x0002), &[0])]);
        assert!(has_always_protected_collection(&mouse, ReportType::Input));
        assert!(!has_always_protected_collection(&mouse, ReportType::Feature));

        let vendor = device_info(vec![col(Some(0xFF00), Some(0x0001), &[1])]);
        assert!(!has_always_protected_collection(&vendor, ReportType::Input));
        assert!(!has_always_protected_collection(&vendor, ReportType::Output));
        assert!(!has_always_protected_collection(&vendor, ReportType::Feature));
    }

    #[test]
    fn test_compute_blocked_input_ids_nested_collections() {
        // A Keyboard nested as a child of a vendor top-level is walked
        // recursively (Chromium's kWebHidRecursiveFiltering, enabled by
        // default): its report is blocked.
        let nested_kb = col(Some(0x0001), Some(0x0006), &[1]); // Keyboard
        let mut vendor = col(Some(0xFF00), Some(0x0001), &[]); // Vendor top-level
        vendor.children = vec![nested_kb];
        let info = device_info(vec![vendor]);
        let map = build_report_collection_map(&info);
        assert_eq!(
            compute_blocked_input_ids(info.vendor_id, info.product_id, &map),
            HashSet::from([1])
        );

        // A Mouse pointer report attached to a Physical child is still
        // blocked: Chromium propagates the report to all ancestor collections
        // (hid_collection.cc), so the Mouse Application top-level (0x01/0x02)
        // carries it and matches the Mouse rule.
        let mut phys = col(Some(0x0009), Some(0x0001), &[3]); // Physical/Pointer
        phys.collection_type = 0;
        let mut mouse = col(Some(0x0001), Some(0x0002), &[]); // Mouse top-level
        mouse.children = vec![phys];
        let info = device_info(vec![mouse]);
        let map = build_report_collection_map(&info);
        assert_eq!(
            compute_blocked_input_ids(info.vendor_id, info.product_id, &map),
            HashSet::from([3])
        );

        // A Pointer-usage Physical child under a VENDOR top-level stays
        // unblocked: neither the vendor Application nor the non-Application
        // Pointer child is protected (no rule matches, always-protected
        // requires an Application collection).
        let mut phys = col(Some(0x0001), Some(0x0001), &[3]); // Physical/Pointer
        phys.collection_type = 0;
        let mut vendor = col(Some(0xFF00), Some(0x0001), &[]); // Vendor top-level
        vendor.children = vec![phys];
        let info = device_info(vec![vendor]);
        let map = build_report_collection_map(&info);
        assert!(compute_blocked_input_ids(info.vendor_id, info.product_id, &map).is_empty());
    }
}
