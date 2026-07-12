//! HID report descriptor parser → Chromium-shaped collections tree.
//!
//! Ported from `webhid-descriptor-wasm` (no WASM/bindgen dependencies).
//! Uses `hidreport` to parse raw descriptor bytes, then builds a
//! collections tree matching Chromium's `HIDDevice.collections` exactly.

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
            Field::Constant(_) => {
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
