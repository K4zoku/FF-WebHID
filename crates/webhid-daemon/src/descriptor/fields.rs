//! Field conversion: hidreport fields -> Chromium-shaped WebHidField, with
//! adjacent variable-field aggregation.

use hidreport::{Field, FieldAttributes, Usage, VariableField};

use webhid::types::Field as WebHidField;

fn pack_usage(u: &Usage) -> u32 {
    let page: u16 = u.usage_page.into();
    let id: u16 = u.usage_id.into();
    ((page as u32) << 16) | (id as u32)
}

fn nibble_as_i8(n: u8) -> i8 {
    if n < 8 { n as i8 } else { (n as i8) - 16 }
}

fn decode_unit_safe(unit: Option<&hidreport::Unit>) -> (String, i32, i32, i32, i32, i32, i32) {
    if let Some(u) = unit {
        let raw: u32 = u32::from(*u);
        let sys_nibble = (raw & 0x0F) as u8;
        let nibble_signed =
            |i: u32| -> i32 { nibble_as_i8(((raw >> (i * 4)) & 0x0F) as u8) as i32 };
        (
            webhid::collections_tlv::unit_system_from_nibble(sys_nibble).to_string(),
            nibble_signed(1),
            nibble_signed(2),
            nibble_signed(3),
            nibble_signed(4),
            nibble_signed(5),
            nibble_signed(6),
        )
    } else {
        ("none".to_string(), 0, 0, 0, 0, 0, 0)
    }
}

#[derive(PartialEq)]
struct VarSig {
    report_size: u32,
    logical_min: i32,
    logical_max: i32,
    physical_min: i32,
    physical_max: i32,
    unit_exponent: i32,
    unit_system: String,
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
    let (sys, len, mass, time, temp, cur, lum) = decode_unit_safe(v.unit.as_ref());
    VarSig {
        report_size: (v.bits.end - v.bits.start) as u32,
        logical_min: v.logical_minimum.into(),
        logical_max: v.logical_maximum.into(),
        physical_min: v.physical_minimum.map(|x| x.into()).unwrap_or(0),
        physical_max: v.physical_maximum.map(|x| x.into()).unwrap_or(0),
        unit_exponent: v.unit_exponent.map(|x| x.into()).unwrap_or(0),
        unit_system: sys,
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
        usages: if is_range { None } else { Some(final_usages) },
        usage_minimum: usage_min,
        usage_maximum: usage_max,
        report_size: sig.report_size.max(1),
        report_count: count.max(1),
        logical_minimum: sig.logical_min,
        logical_maximum: sig.logical_max,
        physical_minimum: sig.physical_min,
        physical_maximum: sig.physical_max,
        unit_exponent: sig.unit_exponent,
        unit_system: sig.unit_system,
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
        strings: vec![],
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

/// Usage list of an array field as (usages, is_range, usage_minimum,
/// usage_maximum): a declared usage range compresses to a range pair, an
/// explicit usage list stays explicit.
fn array_usage_range(a: &hidreport::ArrayField) -> (Vec<u32>, bool, Option<u32>, Option<u32>) {
    if a.is_usage_range() {
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
    }
}

fn make_array_field(a: &hidreport::ArrayField) -> WebHidField {
    let (usages, is_range, usage_min, usage_max) = array_usage_range(a);

    let (sys, len, mass, time, temp, cur, lum) = decode_unit_safe(a.unit.as_ref());

    let count: usize = a.report_count.into();
    let count_u32 = (count as u32).max(1);
    let total_bits = (a.bits.end - a.bits.start) as u32;
    let per_item_bits = total_bits / count_u32;

    WebHidField {
        usages: if is_range { None } else { Some(usages) },
        usage_minimum: usage_min,
        usage_maximum: usage_max,
        report_size: per_item_bits.max(1),
        report_count: count_u32,
        logical_minimum: a.logical_minimum.into(),
        logical_maximum: a.logical_maximum.into(),
        physical_minimum: a.physical_minimum.map(|x| x.into()).unwrap_or(0),
        physical_maximum: a.physical_maximum.map(|x| x.into()).unwrap_or(0),
        unit_exponent: a.unit_exponent.map(|x| x.into()).unwrap_or(0),
        unit_system: sys,
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
        strings: vec![],
    }
}

pub(super) fn convert_fields_aggregate(fields: &[Field]) -> Vec<WebHidField> {
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
                    if let Field::Variable(v2) = &fields[j]
                        && v2.bits.start == prev_end
                        && var_signature(v2) == sig
                    {
                        usages.push(pack_usage(&v2.usage));
                        count += 1;
                        prev_end = v2.bits.end;
                        j += 1;
                        continue;
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
                    report_size: total_bits.max(1),
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

#[cfg(test)]
#[path = "../tests/descriptor/fields.rs"]
mod tests;
