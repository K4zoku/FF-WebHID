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

use hidreport::{Field, ReportDescriptor};

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

/// Build the report->collection association map used for blocklist pruning
/// and runtime report blocking. Derived from the complete report descriptor
/// when available, otherwise by walking the collection tree.
fn build_report_collection_map(info: &DeviceInfo) -> ReportCollectionMap {
    if !info.raw_descriptor.is_empty()
        && let Ok(rdesc) = ReportDescriptor::try_from(info.raw_descriptor.as_slice())
    {
        return map_from_parsed_descriptor(&rdesc);
    }
    map_from_collection_tree(info)
}

/// Association map from the complete parsed descriptor: every Variable/Array
/// field contributes its full collection ancestry to its report's entry;
/// constant fields are skipped.
fn map_from_parsed_descriptor(rdesc: &ReportDescriptor) -> ReportCollectionMap {
    fn add<T: hidreport::Report>(reports: &[T], rt_byte: u8, map: &mut ReportCollectionMap) {
        for report in reports {
            let rid: u8 = report
                .report_id()
                .as_ref()
                .map(|id| (*id).into())
                .unwrap_or(0);
            for field in report.fields() {
                let chain = match field {
                    Field::Variable(_) | Field::Array(_) => field.collections(),
                    Field::Constant(_) => continue,
                };
                let entry = map.entry((rid, rt_byte)).or_default();
                for c in chain {
                    let assoc = (
                        c.usages().first().map(|u| u.usage_page.into()),
                        c.usages().first().map(|u| u.usage_id.into()),
                        u8::from(c.collection_type()) == 1,
                    );
                    if !entry.contains(&assoc) {
                        entry.push(assoc);
                    }
                }
            }
        }
    }
    let mut map: ReportCollectionMap = HashMap::new();
    add(rdesc.input_reports(), 0, &mut map);
    add(rdesc.output_reports(), 1, &mut map);
    add(rdesc.feature_reports(), 2, &mut map);
    map
}

/// Association map built by walking the page-visible collection tree.
fn map_from_collection_tree(info: &DeviceInfo) -> ReportCollectionMap {
    fn walk(
        col: &webhid::Collection,
        ancestors: &[ReportAssociation],
        map: &mut ReportCollectionMap,
    ) {
        let is_app = col.collection_type == 1;
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

/// Direction byte -> report type: 0 input, 1 output, 2 feature (the byte
/// encoding used as the second half of a `ReportCollectionMap` key).
fn report_type_from_byte(rt_byte: u8) -> ReportType {
    match rt_byte {
        0 => ReportType::Input,
        1 => ReportType::Output,
        _ => ReportType::Feature,
    }
}

/// Report type -> direction byte (inverse of [`report_type_from_byte`]).
fn report_type_to_byte(rt: ReportType) -> u8 {
    match rt {
        ReportType::Input => 0,
        ReportType::Output => 1,
        ReportType::Feature => 2,
    }
}

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
                rules,
                vendor_id,
                product_id,
                *up,
                *u,
                report_id,
                report_type,
            ) || (*is_app && blocklist::is_always_protected(*up, *u, report_type))
        })
}

fn has_always_protected_collection(info: &DeviceInfo, report_type: ReportType) -> bool {
    info.collections
        .iter()
        .any(|c| blocklist::is_always_protected(c.usage_page, c.usage, report_type))
}

fn interface_protected(info: &DeviceInfo, report_type: ReportType) -> bool {
    if !info.collections.is_empty() {
        return false;
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
    ) || blocklist::is_always_protected(info.usage_page, info.usage, report_type)
}

/// Chromium's `RemoveProtectedReports` (content/browser/hid/hid_service.cc):
/// prune blocked reports from the page-visible collection tree. A device
/// whose collections all become empty is hidden (`None`), matching
/// `OnDeviceAdded`'s `collections.empty()` check. Only the `collections`
/// field is touched: the report map, reader and send path keep working off
/// the full parse, and `max_input_report_size` is preserved.
///
/// A device with no parsed collections (missing or unparseable report
/// descriptor) is also hidden. With no collections there is nothing to
/// classify reports against, so keeping it visible would let raw reports
/// pass unfiltered; security classification requires a parsed descriptor,
/// so the page-facing path fails closed.
pub fn prune_device_info(info: DeviceInfo) -> Option<DeviceInfo> {
    if info.collections.is_empty() {
        log::warn!(
            "device {:04x}:{:04x} ({}) hidden: no parsed collections (missing or unparseable report descriptor), failing closed",
            info.vendor_id,
            info.product_id,
            info.product_name
        );
        return None;
    }
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
    Some(DeviceInfo {
        collections,
        ..info
    })
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
    let input_reports = prune_reports(col.input_reports, 0, map, rules, vendor_id, product_id);
    let output_reports = prune_reports(col.output_reports, 1, map, rules, vendor_id, product_id);
    let feature_reports = prune_reports(col.feature_reports, 2, map, rules, vendor_id, product_id);
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

/// Drop reports of one direction (`rt_byte`: 0 input, 1 output, 2 feature)
/// whose report ID is protected per the blocklist rules and the
/// always-protected layer.
fn prune_reports(
    reports: Vec<webhid::Report>,
    rt_byte: u8,
    map: &ReportCollectionMap,
    rules: &[blocklist::BlocklistRule],
    vendor_id: u16,
    product_id: u16,
) -> Vec<webhid::Report> {
    let report_type = report_type_from_byte(rt_byte);
    reports
        .into_iter()
        .filter(|r| {
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
        })
        .collect()
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
    if max_size == 0 {
        return false;
    }
    if let Some(len) = payload_len
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
        let rt_byte = report_type_to_byte(report_type);
        match self.map.get(&(report_id, rt_byte)) {
            Some(assoc) => associations_any_protected(
                blocklist::blocklist_rules(),
                vendor_id,
                product_id,
                assoc,
                report_id,
                report_type,
            ),
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
    /// report type. A payload length of `None` means a read (no payload).
    /// A max size of zero (the report type is not declared in the descriptor)
    /// rejects the request, matching Chromium's `max_*_report_size() == 0`
    /// gates in `Write` / `GetFeatureReport` / `SendFeatureReport`.
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
#[path = "tests/report_blocking.rs"]
mod tests;
