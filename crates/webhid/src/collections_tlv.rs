use base64::Engine;
use serde::{Deserialize, Deserializer, Serialize, Serializer, de};

use crate::types::{Collection, Field, Report};

const TAG_COLLECTION: u8 = 0x01;
const TAG_INPUT_REPORT: u8 = 0x02;
const TAG_OUTPUT_REPORT: u8 = 0x03;
const TAG_FEATURE_REPORT: u8 = 0x04;
const TAG_FIELD: u8 = 0x05;

/// Canonical unit-system vocabulary: the wire tag is the index into this
/// table. Kept in sync with the JS mirror in `addon/js/utils/descriptor-tlv.js`
/// (parity-tested in the JS test suite).
pub const UNIT_SYSTEMS: &[&str] = &[
    "none",
    "si-linear",
    "si-rotation",
    "english-linear",
    "english-rotation",
    "vendor-defined",
    "reserved",
];

/// HID unit nibble -> unit-system name, via the canonical table.
pub fn unit_system_from_nibble(nibble: u8) -> &'static str {
    let tag = match nibble {
        0 => 0,
        1 => 1,
        2 => 2,
        3 => 3,
        4 => 4,
        15 => 5,
        _ => 6,
    };
    UNIT_SYSTEMS[tag]
}

fn unit_system_to_tag(s: &str) -> u8 {
    for (i, name) in UNIT_SYSTEMS.iter().enumerate() {
        if *name == s {
            return i as u8;
        }
    }
    6
}

fn unit_system_from_tag(tag: u8) -> String {
    UNIT_SYSTEMS
        .get(tag as usize)
        .map(|s| s.to_string())
        .unwrap_or_else(|| "reserved".to_string())
}

fn write_varint(buf: &mut Vec<u8>, mut value: u32) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value != 0 {
            buf.push(byte | 0x80);
        } else {
            buf.push(byte);
            break;
        }
    }
}

fn read_varint(data: &[u8], off: &mut usize) -> u32 {
    let mut result = 0u32;
    let mut shift = 0u32;
    loop {
        let byte = data[*off];
        *off += 1;
        result |= ((byte & 0x7f) as u32) << shift;
        if byte & 0x80 == 0 {
            break;
        }
        shift += 7;
    }
    result
}

fn write_node_header(buf: &mut Vec<u8>, tag: u8, value_len: usize) {
    buf.push(tag);
    write_varint(buf, value_len as u32);
}

fn encode_collection(buf: &mut Vec<u8>, col: &Collection) {
    let mut value = Vec::new();
    let mut presence = 0u8;
    if col.usage_page.is_some() {
        presence |= 1;
    }
    if col.usage.is_some() {
        presence |= 2;
    }
    value.push(presence);
    if let Some(up) = col.usage_page {
        value.extend_from_slice(&up.to_le_bytes());
    }
    if let Some(u) = col.usage {
        value.extend_from_slice(&u.to_le_bytes());
    }
    value.push(col.collection_type);

    for child in &col.children {
        encode_collection(&mut value, child);
    }
    for r in &col.input_reports {
        encode_report(&mut value, TAG_INPUT_REPORT, r);
    }
    for r in &col.output_reports {
        encode_report(&mut value, TAG_OUTPUT_REPORT, r);
    }
    for r in &col.feature_reports {
        encode_report(&mut value, TAG_FEATURE_REPORT, r);
    }

    write_node_header(buf, TAG_COLLECTION, value.len());
    buf.extend_from_slice(&value);
}

fn encode_report(buf: &mut Vec<u8>, tag: u8, report: &Report) {
    let mut value = Vec::new();
    value.push(report.report_id);
    for field in &report.items {
        encode_field(&mut value, field);
    }

    write_node_header(buf, tag, value.len());
    buf.extend_from_slice(&value);
}

/// Pack the field's boolean flags into the u16 bitfield used on the wire.
/// Bit order matches the original flag encoding and must not change.
fn encode_field_flags(field: &Field) -> u16 {
    let bits = [
        field.is_absolute,
        field.is_array,
        field.is_range,
        field.is_constant,
        field.is_linear,
        field.is_volatile,
        field.is_buffered_bytes,
        field.has_null,
        field.has_preferred_state,
        field.wrap,
    ];
    let mut flags = 0u16;
    for (i, set) in bits.into_iter().enumerate() {
        if set {
            flags |= 1u16 << i;
        }
    }
    flags
}

/// Encode the usage block: either a min/max range pair, an explicit usage
/// list, or an empty list (varint 0).
fn encode_field_usages(value: &mut Vec<u8>, field: &Field) {
    if field.is_range {
        let min = field.usage_minimum.unwrap_or(0);
        let max = field.usage_maximum.unwrap_or(0);
        value.extend_from_slice(&min.to_le_bytes());
        value.extend_from_slice(&max.to_le_bytes());
    } else if let Some(usages) = &field.usages {
        write_varint(value, usages.len() as u32);
        for &u in usages {
            value.extend_from_slice(&u.to_le_bytes());
        }
    } else {
        write_varint(value, 0);
    }
}

/// Encode the strings block: varint count, then varint-length-prefixed UTF-8.
fn encode_field_strings(value: &mut Vec<u8>, strings: &[String]) {
    write_varint(value, strings.len() as u32);
    for s in strings {
        let bytes = s.as_bytes();
        write_varint(value, bytes.len() as u32);
        value.extend_from_slice(bytes);
    }
}

fn encode_field(buf: &mut Vec<u8>, field: &Field) {
    let mut value = Vec::new();

    value.extend_from_slice(&encode_field_flags(field).to_le_bytes());

    write_varint(&mut value, field.report_size);
    write_varint(&mut value, field.report_count);
    value.extend_from_slice(&field.logical_minimum.to_le_bytes());
    value.extend_from_slice(&field.logical_maximum.to_le_bytes());
    value.extend_from_slice(&field.physical_minimum.to_le_bytes());
    value.extend_from_slice(&field.physical_maximum.to_le_bytes());
    value.push(field.unit_exponent as i8 as u8);
    value.push(unit_system_to_tag(&field.unit_system));
    value.push(field.unit_factor_length_exponent as i8 as u8);
    value.push(field.unit_factor_mass_exponent as i8 as u8);
    value.push(field.unit_factor_time_exponent as i8 as u8);
    value.push(field.unit_factor_temperature_exponent as i8 as u8);
    value.push(field.unit_factor_current_exponent as i8 as u8);
    value.push(field.unit_factor_luminous_intensity_exponent as i8 as u8);

    encode_field_usages(&mut value, field);
    encode_field_strings(&mut value, &field.strings);

    write_node_header(buf, TAG_FIELD, value.len());
    buf.extend_from_slice(&value);
}

fn decode_collection(data: &[u8], off: &mut usize, end: usize) -> Collection {
    let presence = data[*off];
    *off += 1;
    let usage_page = if presence & 1 != 0 {
        let v = u16::from_le_bytes([data[*off], data[*off + 1]]);
        *off += 2;
        Some(v)
    } else {
        None
    };
    let usage = if presence & 2 != 0 {
        let v = u16::from_le_bytes([data[*off], data[*off + 1]]);
        *off += 2;
        Some(v)
    } else {
        None
    };
    let collection_type = data[*off];
    *off += 1;

    let mut children = Vec::new();
    let mut input_reports = Vec::new();
    let mut output_reports = Vec::new();
    let mut feature_reports = Vec::new();

    while *off < end {
        let tag = data[*off];
        let node = decode_node(data, off);
        match (tag, node) {
            (TAG_COLLECTION, Node::Collection(c)) => children.push(c),
            (TAG_INPUT_REPORT, Node::Report(r)) => input_reports.push(r),
            (TAG_OUTPUT_REPORT, Node::Report(r)) => output_reports.push(r),
            (TAG_FEATURE_REPORT, Node::Report(r)) => feature_reports.push(r),
            _ => {}
        }
    }

    Collection {
        collection_type,
        usage_page,
        usage,
        children,
        input_reports,
        output_reports,
        feature_reports,
    }
}

fn decode_report(data: &[u8], off: &mut usize, end: usize) -> Report {
    let report_id = data[*off];
    *off += 1;
    let mut items = Vec::new();
    while *off < end {
        let node = decode_node(data, off);
        if let Node::Field(f) = node {
            items.push(f);
        }
    }
    Report { report_id, items }
}

/// Unchecked little-endian i32 read; advances `off` by 4. Mirrors the
/// original `read_u32!` macro: callers are responsible for bounds.
fn read_i32(data: &[u8], off: &mut usize) -> i32 {
    let v = i32::from_le_bytes([data[*off], data[*off + 1], data[*off + 2], data[*off + 3]]);
    *off += 4;
    v
}

/// Unchecked i8-as-i32 read; advances `off` by 1, mirroring `read_u8!`.
fn read_i8_i32(data: &[u8], off: &mut usize) -> i32 {
    let v = data[*off] as i8 as i32;
    *off += 1;
    v
}

/// Fixed-size portion of a field's TLV value: flags, sizes, ranges and unit
/// metadata.
struct FieldFixed {
    flags: u16,
    report_size: u32,
    report_count: u32,
    logical_minimum: i32,
    logical_maximum: i32,
    physical_minimum: i32,
    physical_maximum: i32,
    unit_exponent: i32,
    unit_system: String,
    unit_factor_length_exponent: i32,
    unit_factor_mass_exponent: i32,
    unit_factor_time_exponent: i32,
    unit_factor_temperature_exponent: i32,
    unit_factor_current_exponent: i32,
    unit_factor_luminous_intensity_exponent: i32,
}

/// Decode the fixed-size prefix of a field value. `None` on truncation.
/// Bounds checks mirror the original: a 2-byte flags check and a single
/// 16-byte check covering the four i32s; the trailing exponent bytes were
/// read unchecked before and remain so.
fn decode_field_fixed(data: &[u8], off: &mut usize, end: usize) -> Option<FieldFixed> {
    if *off + 2 > end {
        return None;
    }
    let flags = u16::from_le_bytes([data[*off], data[*off + 1]]);
    *off += 2;
    let report_size = read_varint(data, off);
    let report_count = read_varint(data, off);

    if *off + 16 > end {
        return None;
    }
    let logical_minimum = read_i32(data, off);
    let logical_maximum = read_i32(data, off);
    let physical_minimum = read_i32(data, off);
    let physical_maximum = read_i32(data, off);
    let unit_exponent = read_i8_i32(data, off);
    let unit_system = unit_system_from_tag(data[*off]);
    *off += 1;
    let unit_factor_length_exponent = read_i8_i32(data, off);
    let unit_factor_mass_exponent = read_i8_i32(data, off);
    let unit_factor_time_exponent = read_i8_i32(data, off);
    let unit_factor_temperature_exponent = read_i8_i32(data, off);
    let unit_factor_current_exponent = read_i8_i32(data, off);
    let unit_factor_luminous_intensity_exponent = read_i8_i32(data, off);

    Some(FieldFixed {
        flags,
        report_size,
        report_count,
        logical_minimum,
        logical_maximum,
        physical_minimum,
        physical_maximum,
        unit_exponent,
        unit_system,
        unit_factor_length_exponent,
        unit_factor_mass_exponent,
        unit_factor_time_exponent,
        unit_factor_temperature_exponent,
        unit_factor_current_exponent,
        unit_factor_luminous_intensity_exponent,
    })
}

/// Decoded usage block: (usages, usage_minimum, usage_maximum).
type DecodedUsages = Option<(Option<Vec<u32>>, Option<u32>, Option<u32>)>;

/// Decode the usage block: (usages, usage_minimum, usage_maximum).
/// `None` on truncation.
fn decode_field_usages(data: &[u8], off: &mut usize, end: usize, is_range: bool) -> DecodedUsages {
    if is_range {
        if *off + 8 > end {
            return None;
        }
        let min = u32::from_le_bytes([data[*off], data[*off + 1], data[*off + 2], data[*off + 3]]);
        *off += 4;
        let max = u32::from_le_bytes([data[*off], data[*off + 1], data[*off + 2], data[*off + 3]]);
        *off += 4;
        Some((None, Some(min), Some(max)))
    } else {
        let count = read_varint(data, off) as usize;
        if *off + count * 4 > end {
            return None;
        }
        let mut usages = Vec::with_capacity(count);
        for _ in 0..count {
            usages.push(u32::from_le_bytes([
                data[*off],
                data[*off + 1],
                data[*off + 2],
                data[*off + 3],
            ]));
            *off += 4;
        }
        Some((
            if usages.is_empty() {
                None
            } else {
                Some(usages)
            },
            None,
            None,
        ))
    }
}

/// Decode the strings block: varint count, then varint-length-prefixed
/// strings. `None` on truncation.
fn decode_field_strings(data: &[u8], off: &mut usize, end: usize) -> Option<Vec<String>> {
    let count = read_varint(data, off) as usize;
    let mut strings = Vec::with_capacity(count);
    for _ in 0..count {
        let byte_len = read_varint(data, off) as usize;
        if *off + byte_len > end {
            return None;
        }
        strings.push(String::from_utf8_lossy(&data[*off..*off + byte_len]).to_string());
        *off += byte_len;
    }
    Some(strings)
}

fn decode_field(data: &[u8], off: &mut usize, end: usize) -> Field {
    let Some(fixed) = decode_field_fixed(data, off, end) else {
        *off = end;
        return Field::default();
    };
    let is_range = fixed.flags & (1 << 2) != 0;
    let Some((usages, usage_minimum, usage_maximum)) =
        decode_field_usages(data, off, end, is_range)
    else {
        *off = end;
        return Field::default();
    };
    let Some(strings) = decode_field_strings(data, off, end) else {
        *off = end;
        return Field::default();
    };

    Field {
        usages,
        usage_minimum,
        usage_maximum,
        report_size: fixed.report_size,
        report_count: fixed.report_count,
        logical_minimum: fixed.logical_minimum,
        logical_maximum: fixed.logical_maximum,
        physical_minimum: fixed.physical_minimum,
        physical_maximum: fixed.physical_maximum,
        unit_exponent: fixed.unit_exponent,
        unit_system: fixed.unit_system,
        unit_factor_length_exponent: fixed.unit_factor_length_exponent,
        unit_factor_mass_exponent: fixed.unit_factor_mass_exponent,
        unit_factor_time_exponent: fixed.unit_factor_time_exponent,
        unit_factor_temperature_exponent: fixed.unit_factor_temperature_exponent,
        unit_factor_current_exponent: fixed.unit_factor_current_exponent,
        unit_factor_luminous_intensity_exponent: fixed.unit_factor_luminous_intensity_exponent,
        is_absolute: fixed.flags & (1 << 0) != 0,
        is_array: fixed.flags & (1 << 1) != 0,
        is_range,
        is_constant: fixed.flags & (1 << 3) != 0,
        is_linear: fixed.flags & (1 << 4) != 0,
        is_volatile: fixed.flags & (1 << 5) != 0,
        is_buffered_bytes: fixed.flags & (1 << 6) != 0,
        has_null: fixed.flags & (1 << 7) != 0,
        has_preferred_state: fixed.flags & (1 << 8) != 0,
        wrap: fixed.flags & (1 << 9) != 0,
        strings,
    }
}

enum Node {
    Collection(Collection),
    Report(Report),
    Field(Field),
}

fn decode_node(data: &[u8], off: &mut usize) -> Node {
    let tag = data[*off];
    *off += 1;
    let len = read_varint(data, off) as usize;
    let end = *off + len;
    let node = match tag {
        TAG_COLLECTION => Node::Collection(decode_collection(data, off, end)),
        TAG_INPUT_REPORT | TAG_OUTPUT_REPORT | TAG_FEATURE_REPORT => {
            Node::Report(decode_report(data, off, end))
        }
        TAG_FIELD => Node::Field(decode_field(data, off, end)),
        _ => {
            *off = end;
            Node::Field(Field::default())
        }
    };
    *off = end;
    node
}

pub fn serialize<S: Serializer>(collections: &Vec<Collection>, s: S) -> Result<S::Ok, S::Error> {
    if s.is_human_readable() {
        let mut buf = Vec::new();
        for col in collections {
            encode_collection(&mut buf, col);
        }
        let encoded = base64::engine::general_purpose::STANDARD.encode(&buf);
        encoded.serialize(s)
    } else {
        collections.serialize(s)
    }
}

pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<Collection>, D::Error> {
    if d.is_human_readable() {
        let encoded = String::deserialize(d)?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&encoded)
            .map_err(de::Error::custom)?;
        let mut off = 0;
        let mut roots = Vec::new();
        while off < bytes.len() {
            let tag = bytes[off];
            let node = decode_node(&bytes, &mut off);
            if tag == TAG_COLLECTION
                && let Node::Collection(c) = node
            {
                roots.push(c);
            }
        }
        Ok(roots)
    } else {
        Vec::<Collection>::deserialize(d)
    }
}

#[cfg(test)]
#[path = "tests/collections_tlv.rs"]
mod tests;
