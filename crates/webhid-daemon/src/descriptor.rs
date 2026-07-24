//! HID report descriptor parser → Chromium-shaped collections tree.

use hidreport::{
    Collection as HidCollection, Field, FieldAttributes, ReportDescriptor, UnitSystem, Units,
    Usage, VariableField,
};
use std::collections::HashMap;
use webhid::types::{Collection, Field as WebHidField, Report};

/// Parse a raw HID report descriptor into a Chromium-shaped collections tree.
pub fn parse_report_descriptor(bytes: &[u8]) -> Vec<Collection> {
    let rdesc = match ReportDescriptor::try_from(bytes) {
        Ok(d) => d,
        Err(_) => {
            log::warn!("failed to parse report descriptor ({} bytes)", bytes.len());
            return vec![];
        }
    };

    let mut tree = CollectionTreeBuilder::new();
    for report in rdesc.input_reports() {
        tree.add_report(report, "input");
    }
    for report in rdesc.output_reports() {
        tree.add_report(report, "output");
    }
    for report in rdesc.feature_reports() {
        tree.add_report(report, "feature");
    }

    tree.build()
}

// ── Usage helpers ─────────────────────────────────────────────────────────

fn pack_usage(u: &Usage) -> u32 {
    let page: u16 = u.usage_page.into();
    let id: u16 = u.usage_id.into();
    ((page as u32) << 16) | (id as u32)
}

fn unit_system_string(sys: UnitSystem) -> &'static str {
    match sys {
        UnitSystem::None => "none",
        UnitSystem::SILinear => "si-linear",
        UnitSystem::SIRotation => "si-rotation",
        UnitSystem::EnglishLinear => "english-linear",
        UnitSystem::EnglishRotation => "english-rotation",
    }
}

fn units_exponent(u: &Units) -> i32 {
    match u {
        Units::None => 0,
        Units::Centimeter { exponent }
        | Units::Radians { exponent }
        | Units::Inch { exponent }
        | Units::Degrees { exponent }
        | Units::Gram { exponent }
        | Units::Slug { exponent }
        | Units::Seconds { exponent }
        | Units::Kelvin { exponent }
        | Units::Fahrenheit { exponent }
        | Units::Ampere { exponent }
        | Units::Candela { exponent } => *exponent as i32,
    }
}

fn decode_unit(unit: Option<&hidreport::Unit>) -> (UnitSystem, i32, i32, i32, i32, i32, i32) {
    if let Some(u) = unit {
        let sys = u.system();
        (
            sys,
            units_exponent(&u.length()),
            units_exponent(&u.mass()),
            units_exponent(&u.time()),
            units_exponent(&u.temperature()),
            units_exponent(&u.current()),
            units_exponent(&u.luminosity()),
        )
    } else {
        (UnitSystem::None, 0, 0, 0, 0, 0, 0)
    }
}

// ── Variable-field signature for aggregation ──────────────────────────────

#[derive(PartialEq)]
struct VarSig {
    report_size: u32,
    logical_min: i32,
    logical_max: i32,
    physical_min: i32,
    physical_max: i32,
    unit_exponent: i32,
    unit_system: &'static str,
    unit_len: i32,
    unit_mass: i32,
    unit_time: i32,
    unit_temp: i32,
    unit_cur: i32,
    unit_lum: i32,
    is_absolute: bool,
    is_linear: bool,
    is_volatile: bool,
    is_buffered_bytes: bool,
    has_null: bool,
    has_preferred_state: bool,
    wrap: bool,
}

fn var_signature(v: &VariableField) -> VarSig {
    let (sys, len, mass, time, temp, cur, lum) = decode_unit(v.unit.as_ref());
    VarSig {
        report_size: (v.bits.end - v.bits.start) as u32,
        logical_min: v.logical_minimum.into(),
        logical_max: v.logical_maximum.into(),
        physical_min: v.physical_minimum.map(|x| x.into()).unwrap_or(0),
        physical_max: v.physical_maximum.map(|x| x.into()).unwrap_or(0),
        unit_exponent: v.unit_exponent.map(|x| x.into()).unwrap_or(0),
        unit_system: unit_system_string(sys),
        unit_len: len,
        unit_mass: mass,
        unit_time: time,
        unit_temp: temp,
        unit_cur: cur,
        unit_lum: lum,
        is_absolute: v.is_absolute(),
        is_linear: v.is_linear(),
        is_volatile: v.is_volatile().unwrap_or(false),
        is_buffered_bytes: v.is_buffered_bytes(),
        has_null: v.has_null_state(),
        has_preferred_state: v.has_preferred_state(),
        wrap: v.wraps(),
    }
}

fn make_aggregated_variable(first: &VariableField, usages: Vec<u32>, count: u32) -> WebHidField {
    let sig = var_signature(first);
    let (final_usages, is_range, usage_min, usage_max) = detect_contiguous_range(usages);

    WebHidField {
        usages: final_usages,
        usage_minimum: usage_min,
        usage_maximum: usage_max,
        report_size: sig.report_size,
        report_count: count,
        logical_minimum: sig.logical_min,
        logical_maximum: sig.logical_max,
        physical_minimum: sig.physical_min,
        physical_maximum: sig.physical_max,
        unit_exponent: sig.unit_exponent,
        unit_system: sig.unit_system.to_string(),
        unit_factor_length_exponent: sig.unit_len,
        unit_factor_mass_exponent: sig.unit_mass,
        unit_factor_time_exponent: sig.unit_time,
        unit_factor_temperature_exponent: sig.unit_temp,
        unit_factor_current_exponent: sig.unit_cur,
        unit_factor_luminous_intensity_exponent: sig.unit_lum,
        is_absolute: sig.is_absolute,
        is_array: false,
        is_range,
        is_constant: false,
        is_linear: sig.is_linear,
        is_volatile: sig.is_volatile,
        is_buffered_bytes: sig.is_buffered_bytes,
        has_null: sig.has_null,
        has_preferred_state: sig.has_preferred_state,
        wrap: sig.wrap,
    }
}

fn detect_contiguous_range(usages: Vec<u32>) -> (Vec<u32>, bool, Option<u32>, Option<u32>) {
    if usages.len() > 1 {
        let page = (usages[0] >> 16) as u16;
        let lo = (usages[0] & 0xFFFF) as u16;
        let same_page = usages.iter().all(|u| ((*u >> 16) as u16) == page);
        let sequential = usages
            .iter()
            .enumerate()
            .all(|(i, u)| ((*u & 0xFFFF) as u16) == lo.saturating_add(i as u16));
        if same_page && sequential {
            let hi = lo + (usages.len() as u16) - 1;
            let lo_packed = ((page as u32) << 16) | (lo as u32);
            let hi_packed = ((page as u32) << 16) | (hi as u32);
            return (vec![], true, Some(lo_packed), Some(hi_packed));
        }
    }
    (usages, false, None, None)
}

fn make_array_field(a: &hidreport::ArrayField) -> WebHidField {
    let (usages, is_range, usage_min, usage_max) = if a.is_usage_range() {
        if let Some(r) = a.usage_range() {
            let lo_page: u16 = r.minimum().usage_page().into();
            let lo_id: u16 = r.minimum().usage_id().into();
            let hi_id: u16 = r.maximum().usage_id().into();
            let lo_packed = ((lo_page as u32) << 16) | (lo_id as u32);
            let hi_packed = ((lo_page as u32) << 16) | (hi_id as u32);
            (vec![], true, Some(lo_packed), Some(hi_packed))
        } else {
            (vec![], true, None, None)
        }
    } else {
        let usages: Vec<u32> = a.usages().iter().map(pack_usage).collect();
        (usages, false, None, None)
    };

    let (sys, len, mass, time, temp, cur, lum) = decode_unit(a.unit.as_ref());

    let count: usize = a.report_count.into();
    let count_u32 = count as u32;
    let total_bits = (a.bits.end - a.bits.start) as u32;
    let per_item_bits = if count > 0 {
        total_bits / count_u32
    } else {
        total_bits
    };

    WebHidField {
        usages,
        usage_minimum: usage_min,
        usage_maximum: usage_max,
        report_size: per_item_bits,
        report_count: count_u32,
        logical_minimum: a.logical_minimum.into(),
        logical_maximum: a.logical_maximum.into(),
        physical_minimum: a.physical_minimum.map(|x| x.into()).unwrap_or(0),
        physical_maximum: a.physical_maximum.map(|x| x.into()).unwrap_or(0),
        unit_exponent: a.unit_exponent.map(|x| x.into()).unwrap_or(0),
        unit_system: unit_system_string(sys).to_string(),
        unit_factor_length_exponent: len,
        unit_factor_mass_exponent: mass,
        unit_factor_time_exponent: time,
        unit_factor_temperature_exponent: temp,
        unit_factor_current_exponent: cur,
        unit_factor_luminous_intensity_exponent: lum,
        is_absolute: a.is_absolute(),
        is_array: true,
        is_range,
        is_constant: false,
        is_linear: a.is_linear(),
        is_volatile: a.is_volatile().unwrap_or(false),
        is_buffered_bytes: a.is_buffered_bytes(),
        has_null: a.has_null_state(),
        has_preferred_state: a.has_preferred_state(),
        wrap: a.wraps(),
    }
}

fn convert_fields_aggregate(fields: &[Field]) -> Vec<WebHidField> {
    let mut out: Vec<WebHidField> = Vec::new();
    let mut i = 0;
    while i < fields.len() {
        match &fields[i] {
            Field::Variable(v) => {
                let sig = var_signature(v);
                let mut usages = vec![pack_usage(&v.usage)];
                let mut count: u32 = 1;
                let mut prev_end = v.bits.end;
                let mut j = i + 1;
                while j < fields.len() {
                    if let Field::Variable(v2) = &fields[j] {
                        if v2.bits.start == prev_end && var_signature(v2) == sig {
                            usages.push(pack_usage(&v2.usage));
                            count += 1;
                            prev_end = v2.bits.end;
                            j += 1;
                            continue;
                        }
                    }
                    break;
                }
                out.push(make_aggregated_variable(v, usages, count));
                i = j;
            }
            Field::Array(a) => {
                out.push(make_array_field(a));
                i += 1;
            }
            Field::Constant(c) => {
                let total_bits = (c.bits.end - c.bits.start) as u32;
                out.push(WebHidField {
                    report_size: total_bits,
                    report_count: 1,
                    is_constant: true,
                    ..Default::default()
                });
                i += 1;
            }
        }
    }
    out
}

// ── Collection tree builder ───────────────────────────────────────────────

struct ColNode {
    collection_type: u8,
    usage_page: Option<u16>,
    usage: Option<u16>,
    children: Vec<String>,
    input_reports: Vec<Report>,
    output_reports: Vec<Report>,
    feature_reports: Vec<Report>,
}

struct CollectionTreeBuilder {
    nodes: HashMap<String, ColNode>,
    root_ids: Vec<String>,
}

impl CollectionTreeBuilder {
    fn new() -> Self {
        Self {
            nodes: HashMap::new(),
            root_ids: Vec::new(),
        }
    }

    fn col_key(c: &HidCollection) -> String {
        format!("{:?}", c.id())
    }

    fn ensure_chain(&mut self, chain: &[HidCollection]) {
        for (i, col) in chain.iter().enumerate() {
            let id_str = Self::col_key(col);
            if !self.nodes.contains_key(&id_str) {
                if i == 0 {
                    self.root_ids.push(id_str.clone());
                }
                if i > 0 {
                    let pid = Self::col_key(&chain[i - 1]);
                    if let Some(p) = self.nodes.get_mut(&pid) {
                        if !p.children.contains(&id_str) {
                            p.children.push(id_str.clone());
                        }
                    }
                }
                let collection_type: u8 = col.collection_type().into();
                let usage_page = col.usages().first().map(|u| u.usage_page.into());
                let usage = col.usages().first().map(|u| u.usage_id.into());
                self.nodes.insert(
                    id_str,
                    ColNode {
                        collection_type,
                        usage_page,
                        usage,
                        children: Vec::new(),
                        input_reports: Vec::new(),
                        output_reports: Vec::new(),
                        feature_reports: Vec::new(),
                    },
                );
            }
        }
    }

    fn add_report(&mut self, report: &impl hidreport::Report, rtype: &str) {
        let rid: u8 = report
            .report_id()
            .as_ref()
            .map(|id| (*id).into())
            .unwrap_or(0);
        let items = convert_fields_aggregate(report.fields());

        if items.is_empty() {
            return;
        }

        let web_report = Report {
            report_id: rid,
            items,
        };

        let chain: &[HidCollection] = report
            .fields()
            .iter()
            .find_map(|f| match f {
                Field::Variable(_) | Field::Array(_) => Some(f.collections()),
                _ => None,
            })
            .unwrap_or(&[]);

        if chain.is_empty() {
            return;
        }

        self.ensure_chain(chain);

        if let Some(last) = chain.last() {
            let lid = Self::col_key(last);
            if let Some(n) = self.nodes.get_mut(&lid) {
                match rtype {
                    "input" => n.input_reports.push(web_report),
                    "output" => n.output_reports.push(web_report),
                    "feature" => n.feature_reports.push(web_report),
                    _ => {}
                }
            }
        }
    }

    fn build(self) -> Vec<Collection> {
        let mut result = Vec::new();
        for rid in &self.root_ids {
            if let Some(r) = self.build_node(rid) {
                result.push(r);
            }
        }
        if result.is_empty() {
            result.push(Collection {
                collection_type: 1,
                usage_page: None,
                usage: None,
                children: vec![],
                input_reports: vec![],
                output_reports: vec![],
                feature_reports: vec![],
            });
        }
        result
    }

    fn build_node(&self, id: &str) -> Option<Collection> {
        let n = self.nodes.get(id)?;
        Some(Collection {
            collection_type: n.collection_type,
            usage_page: n.usage_page,
            usage: n.usage,
            children: n
                .children
                .iter()
                .filter_map(|c| self.build_node(c))
                .collect(),
            input_reports: n.input_reports.clone(),
            output_reports: n.output_reports.clone(),
            feature_reports: n.feature_reports.clone(),
        })
    }
}

/// Walk a collections tree and return the maximum input report payload size in bytes.
/// Each input report's size = sum of (report_size × report_count) for all items.
/// Returns 0 if no input reports are found.
pub fn max_input_report_size(collections: &[Collection]) -> u32 {
    fn visit(collections: &[Collection]) -> u32 {
        let mut max = 0u32;
        for c in collections {
            for r in &c.input_reports {
                let bits: u32 = r
                    .items
                    .iter()
                    .map(|f| f.report_size.saturating_mul(f.report_count))
                    .fold(0u32, |a, b| a.saturating_add(b));
                let bytes = bits.div_ceil(8);
                if bytes > max {
                    max = bytes;
                }
            }
            let child_max = visit(&c.children);
            if child_max > max {
                max = child_max;
            }
        }
        max
    }
    visit(collections)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── pack_usage ────────────────────────────────────────────────────────

    #[test]
    fn test_pack_usage() {
        let u = Usage {
            usage_page: 0x0001.into(),
            usage_id: 0x0002.into(),
        };
        assert_eq!(pack_usage(&u), 0x0001_0002);
    }

    #[test]
    fn test_pack_usage_fido() {
        let u = Usage {
            usage_page: 0xF1D0.into(),
            usage_id: 0x0001.into(),
        };
        assert_eq!(pack_usage(&u), 0xF1D0_0001);
    }

    // ── unit_system_string ────────────────────────────────────────────────

    #[test]
    fn test_unit_system_string_none() {
        assert_eq!(unit_system_string(UnitSystem::None), "none");
    }

    #[test]
    fn test_unit_system_string_si_linear() {
        assert_eq!(unit_system_string(UnitSystem::SILinear), "si-linear");
    }

    #[test]
    fn test_unit_system_string_si_rotation() {
        assert_eq!(unit_system_string(UnitSystem::SIRotation), "si-rotation");
    }

    #[test]
    fn test_unit_system_string_english_linear() {
        assert_eq!(
            unit_system_string(UnitSystem::EnglishLinear),
            "english-linear"
        );
    }

    #[test]
    fn test_unit_system_string_english_rotation() {
        assert_eq!(
            unit_system_string(UnitSystem::EnglishRotation),
            "english-rotation"
        );
    }

    // ── units_exponent ────────────────────────────────────────────────────

    #[test]
    fn test_units_exponent_none() {
        assert_eq!(units_exponent(&Units::None), 0);
    }

    #[test]
    fn test_units_exponent_centimeter() {
        assert_eq!(units_exponent(&Units::Centimeter { exponent: -2 }), -2);
    }

    #[test]
    fn test_units_exponent_gram() {
        assert_eq!(units_exponent(&Units::Gram { exponent: 3 }), 3);
    }

    #[test]
    fn test_units_exponent_seconds() {
        assert_eq!(units_exponent(&Units::Seconds { exponent: -1 }), -1);
    }

    // ── decode_unit ───────────────────────────────────────────────────────

    #[test]
    fn test_decode_unit_none() {
        let (sys, len, mass, time, temp, cur, lum) = decode_unit(None);
        assert!(matches!(sys, UnitSystem::None));
        assert_eq!((len, mass, time, temp, cur, lum), (0, 0, 0, 0, 0, 0));
    }

    // ── detect_contiguous_range ───────────────────────────────────────────

    #[test]
    fn test_detect_contiguous_range_single() {
        let usages = vec![0x0001_0002u32];
        let (u, is_range, _lo, _hi) = detect_contiguous_range(usages.clone());
        assert!(!is_range);
        assert_eq!(u, usages);
    }

    #[test]
    fn test_detect_contiguous_range_full() {
        // Three consecutive usages in page 0x0001: 0xE0, 0xE1, 0xE2
        let usages = vec![0x0001_00E0, 0x0001_00E1, 0x0001_00E2];
        let (u, is_range, lo, hi) = detect_contiguous_range(usages);
        assert!(is_range);
        assert!(u.is_empty());
        assert_eq!(lo, Some(0x0001_00E0));
        assert_eq!(hi, Some(0x0001_00E2));
    }

    #[test]
    fn test_detect_contiguous_range_different_pages() {
        let usages = vec![0x0001_00E0, 0x0002_00E1];
        let (u, is_range, lo, hi) = detect_contiguous_range(usages.clone());
        assert!(!is_range);
        assert_eq!(u, usages);
        assert_eq!(lo, None);
        assert_eq!(hi, None);
    }

    #[test]
    fn test_detect_contiguous_range_non_sequential() {
        let usages = vec![0x0001_00E0, 0x0001_00E2];
        let (u, is_range, lo, hi) = detect_contiguous_range(usages.clone());
        assert!(!is_range);
        assert_eq!(u, usages);
        assert_eq!(lo, None);
        assert_eq!(hi, None);
    }

    #[test]
    fn test_detect_contiguous_range_overflow_safe() {
        // Usage at 0xFFFF should not panic when adding 1
        let usages = vec![0x0001_FFFF, 0x0002_0000]; // different pages
        let (u, is_range, _lo, _hi) = detect_contiguous_range(usages.clone());
        assert!(!is_range);
        assert_eq!(u, usages);
    }

    // ── max_input_report_size ─────────────────────────────────────────────

    #[test]
    fn test_max_input_report_size_empty() {
        assert_eq!(max_input_report_size(&[]), 0);
    }

    #[test]
    fn test_max_input_report_size_no_input_reports() {
        let collections = vec![Collection {
            collection_type: 1,
            usage_page: None,
            usage: None,
            children: vec![],
            input_reports: vec![],
            output_reports: vec![],
            feature_reports: vec![],
        }];
        assert_eq!(max_input_report_size(&collections), 0);
    }

    #[test]
    fn test_max_input_report_size_single_report() {
        let collections = vec![Collection {
            collection_type: 1,
            usage_page: None,
            usage: None,
            children: vec![],
            input_reports: vec![Report {
                report_id: 0,
                items: vec![WebHidField {
                    report_size: 8,
                    report_count: 3,
                    ..Default::default()
                }],
            }],
            output_reports: vec![],
            feature_reports: vec![],
        }];
        // 8 bits * 3 = 24 bits = 3 bytes
        assert_eq!(max_input_report_size(&collections), 3);
    }

    #[test]
    fn test_max_input_report_size_multiple_reports() {
        let collections = vec![Collection {
            collection_type: 1,
            usage_page: None,
            usage: None,
            children: vec![],
            input_reports: vec![
                Report {
                    report_id: 1,
                    items: vec![WebHidField {
                        report_size: 8,
                        report_count: 1,
                        ..Default::default()
                    }],
                },
                Report {
                    report_id: 2,
                    items: vec![
                        WebHidField {
                            report_size: 8,
                            report_count: 4,
                            ..Default::default()
                        },
                        WebHidField {
                            report_size: 16,
                            report_count: 1,
                            ..Default::default()
                        },
                    ],
                },
            ],
            output_reports: vec![],
            feature_reports: vec![],
        }];
        // Report 1: 8*1 = 8 bits = 1 byte
        // Report 2: 8*4 + 16*1 = 48 bits = 6 bytes
        assert_eq!(max_input_report_size(&collections), 6);
    }

    #[test]
    fn test_max_input_report_size_nested() {
        let collections = vec![Collection {
            collection_type: 1,
            usage_page: None,
            usage: None,
            children: vec![Collection {
                collection_type: 2,
                usage_page: None,
                usage: None,
                children: vec![],
                input_reports: vec![Report {
                    report_id: 0,
                    items: vec![WebHidField {
                        report_size: 64,
                        report_count: 1,
                        ..Default::default()
                    }],
                }],
                output_reports: vec![],
                feature_reports: vec![],
            }],
            input_reports: vec![],
            output_reports: vec![],
            feature_reports: vec![],
        }];
        // 64 bits = 8 bytes in nested collection
        assert_eq!(max_input_report_size(&collections), 8);
    }

    #[test]
    fn test_max_input_report_size_overflow_does_not_panic() {
        let collections = vec![Collection {
            collection_type: 1,
            usage_page: None,
            usage: None,
            children: vec![],
            input_reports: vec![Report {
                report_id: 0,
                items: vec![WebHidField {
                    report_size: u32::MAX,
                    report_count: u32::MAX,
                    ..Default::default()
                }],
            }],
            output_reports: vec![],
            feature_reports: vec![],
        }];
        // Should not panic; saturating arithmetic means result is some large value
        let result = max_input_report_size(&collections);
        assert!(result > 0);
    }

    // ── parse_report_descriptor ───────────────────────────────────────────

    #[test]
    fn test_parse_empty_descriptor() {
        // Empty descriptor → parsing fails → empty vec
        let collections = parse_report_descriptor(&[]);
        assert!(collections.is_empty());
    }

    #[test]
    fn test_parse_invalid_descriptor() {
        // Single byte is not a valid HID descriptor → parsing fails → empty vec
        let collections = parse_report_descriptor(&[0xFF]);
        assert!(collections.is_empty());
    }

    #[test]
    fn test_parse_valid_descriptor_with_no_reports() {
        // A descriptor with only a collection opening (no reports)
        // This parses successfully but has no reports, so build()
        // produces the fallback collection
        let desc = vec![
            0x05, 0x01, // Usage Page (Generic Desktop)
            0x09, 0x02, // Usage (Mouse)
            0xA1, 0x01, // Collection (Application)
            0xC0,       // End Collection
        ];
        let collections = parse_report_descriptor(&desc);
        // hidreport should parse this as a valid descriptor, but with 0 reports,
        // so build() produces the fallback Collection
        // Note: if hidreport rejects this as invalid, it returns empty vec too
        assert!(!collections.is_empty() || desc.is_empty());
    }

    #[test]
    fn test_parse_mouse_descriptor() {
        // Simple mouse: no report ID, one application collection, one input report
        let desc = vec![
            0x05, 0x01, // Usage Page (Generic Desktop)
            0x09, 0x02, // Usage (Mouse)
            0xA1, 0x01, // Collection (Application)
            0x09, 0x01, // Usage (Pointer)
            0x75, 0x08, // Report Size (8)
            0x95, 0x03, // Report Count (3)
            0x81, 0x02, // Input (Data,Var,Abs)
            0xC0,       // End Collection
        ];
        let collections = parse_report_descriptor(&desc);
        assert!(!collections.is_empty(), "should produce at least one collection");
        let app = &collections[0];
        assert_eq!(app.collection_type, 1);
        assert_eq!(app.usage_page, Some(1)); // Generic Desktop
        assert_eq!(app.usage, Some(2)); // Mouse
        assert!(!app.input_reports.is_empty(), "should have input reports");
        // Report should have items
        let report = &app.input_reports[0];
        assert!(!report.items.is_empty());
    }

    #[test]
    fn test_parse_descriptor_max_input_size_derived() {
        // Joystick with known total bit count
        let desc = vec![
            0x05, 0x01, // Usage Page (Generic Desktop)
            0x09, 0x04, // Usage (Joystick)
            0xA1, 0x01, // Collection (Application)
            0x09, 0x01, // Usage (Pointer)
            0x15, 0x00, // Logical Minimum (0)
            0x25, 0x01, // Logical Maximum (1)
            0x75, 0x01, // Report Size (1)
            0x95, 0x08, // Report Count (8)
            0x81, 0x02, // Input (Data,Var,Abs)
            0x09, 0x01, // Usage (Pointer)
            0x75, 0x08, // Report Size (8)
            0x95, 0x04, // Report Count (4)
            0x81, 0x02, // Input (Data,Var,Abs)
            0xC0,       // End Collection
        ];
        let collections = parse_report_descriptor(&desc);
        // 8*1 + 8*4 = 40 bits = 5 bytes of input
        // But hidreport may round to nearest byte boundary
        let max = max_input_report_size(&collections);
        assert!(max >= 5, "expected at least 5 bytes, got {max}");
    }

    // ── Edge-case / malformed descriptors ──────────────────────────────────

    fn fixture_path(name: &str) -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(std::path::Path::parent)
            .unwrap()
            .join("tests/fixtures/descriptors")
            .join(name)
    }

    fn read_edge_fixture(name: &str) -> Vec<u8> {
        let path = fixture_path("edge").join(name);
        std::fs::read(&path).unwrap_or_else(|e| panic!("failed to read {path:?}: {e}"))
    }

    fn parse_edge(name: &str) -> Vec<Collection> {
        parse_report_descriptor(&read_edge_fixture(name))
    }

    #[test]
    fn test_edge_empty() {
        let c = parse_edge("empty.bin");
        assert!(c.is_empty());
        assert_eq!(max_input_report_size(&c), 0);
    }

    #[test]
    fn test_edge_single_byte() {
        let c = parse_edge("single-byte.bin");
        // Invalid descriptor → empty collections
        let _ = max_input_report_size(&c);
    }

    #[test]
    fn test_edge_truncated_input() {
        let c = parse_edge("truncated-input.bin");
        let _ = max_input_report_size(&c);
    }

    #[test]
    fn test_edge_truncated_long_item() {
        let c = parse_edge("truncated-long-item.bin");
        let _ = max_input_report_size(&c);
    }

    #[test]
    fn test_edge_unclosed_collection() {
        let c = parse_edge("unclosed-collection.bin");
        let _ = max_input_report_size(&c);
    }

    #[test]
    fn test_edge_extra_end_collection() {
        let c = parse_edge("extra-end-collection.bin");
        let _ = max_input_report_size(&c);
    }

    #[test]
    fn test_edge_deep_nesting() {
        // 32 levels of nested collections must not cause stack overflow
        // in either parse_report_descriptor or max_input_report_size
        let c = parse_edge("deep-nesting.bin");
        let m = max_input_report_size(&c);
        // Should have found the innermost 1-byte report
        assert_eq!(m, 1);
    }

    #[test]
    fn test_edge_report_size_zero() {
        let c = parse_edge("report-size-zero.bin");
        // 0 bits → 0 bytes
        assert_eq!(max_input_report_size(&c), 0);
    }

    #[test]
    fn test_edge_report_count_zero() {
        let c = parse_edge("report-count-zero.bin");
        assert_eq!(max_input_report_size(&c), 0);
    }

    #[test]
    fn test_edge_logical_max_ffffffff() {
        let c = parse_edge("logical-max-ffffffff.bin");
        let _ = max_input_report_size(&c);
    }

    #[test]
    fn test_edge_multiple_report_ids() {
        let c = parse_edge("multiple-report-ids.bin");
        // Should parse into multiple reports (3 report IDs)
        let m = max_input_report_size(&c);
        assert!(m > 0);
    }

    #[test]
    fn test_edge_usage_page_ffff() {
        let c = parse_edge("usage-page-ffff.bin");
        let _ = max_input_report_size(&c);
    }

    #[test]
    fn test_edge_report_size_max() {
        let c = parse_edge("report-size-max.bin");
        // saturating math must not overflow
        let _ = max_input_report_size(&c);
    }

    #[test]
    fn test_edge_collection_only() {
        let c = parse_edge("collection-only.bin");
        let _ = max_input_report_size(&c);
    }

    #[test]
    fn test_edge_unit_exponent_overflow() {
        let c = parse_edge("unit-exponent-overflow.bin");
        let _ = max_input_report_size(&c);
    }

    #[test]
    fn test_edge_vendor_extended_usage() {
        let c = parse_edge("vendor-extended-usage.bin");
        let _ = max_input_report_size(&c);
    }

    #[test]
    fn test_edge_valid_no_input_reports() {
        let c = parse_edge("valid-no-input-reports.bin");
        // Valid descriptor but only output reports → 0 input size
        assert_eq!(max_input_report_size(&c), 0);
    }

    #[test]
    fn test_edge_variable_after_array() {
        let c = parse_edge("variable-after-array.bin");
        // Must not panic; array + variable in same report is valid HID
        let _ = max_input_report_size(&c);
    }

    #[test]
    fn test_switchpro_descriptor() {
        let path = fixture_path("switchpro-gamepad.bin");
        let bytes = std::fs::read(&path).unwrap();
        let collections = parse_report_descriptor(&bytes);
        assert!(!collections.is_empty(), "should parse into at least one collection");

        let app = &collections[0];
        assert_eq!(app.collection_type, 1); // Application
        assert_eq!(app.usage_page, Some(0x01)); // Generic Desktop
        assert_eq!(app.usage, Some(0x04)); // Joystick

        // Should have input reports (report ID 0x30)
        assert!(!app.input_reports.is_empty(), "should have input reports");
        let report = &app.input_reports[0];
        assert_eq!(report.report_id, 0x30);
        assert!(!report.items.is_empty(), "should have report items");

        // max_input_report_size now includes constant padding (63 bytes total).
        assert_eq!(max_input_report_size(&collections), 63);
    }
}
