use base64::Engine;
use serde::{Deserialize, Deserializer, Serialize, Serializer, de};

use crate::types::{Collection, Field, Report};

const TAG_COLLECTION: u8 = 0x01;
const TAG_INPUT_REPORT: u8 = 0x02;
const TAG_OUTPUT_REPORT: u8 = 0x03;
const TAG_FEATURE_REPORT: u8 = 0x04;
const TAG_FIELD: u8 = 0x05;

const UNIT_SYSTEMS: &[&str] = &[
    "none",
    "si-linear",
    "si-rotation",
    "english-linear",
    "english-rotation",
    "vendor-defined",
    "reserved",
];

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

fn encode_field(buf: &mut Vec<u8>, field: &Field) {
    let mut value = Vec::new();

    let mut flags = 0u16;
    if field.is_absolute {
        flags |= 1 << 0;
    }
    if field.is_array {
        flags |= 1 << 1;
    }
    if field.is_range {
        flags |= 1 << 2;
    }
    if field.is_constant {
        flags |= 1 << 3;
    }
    if field.is_linear {
        flags |= 1 << 4;
    }
    if field.is_volatile {
        flags |= 1 << 5;
    }
    if field.is_buffered_bytes {
        flags |= 1 << 6;
    }
    if field.has_null {
        flags |= 1 << 7;
    }
    if field.has_preferred_state {
        flags |= 1 << 8;
    }
    if field.wrap {
        flags |= 1 << 9;
    }
    value.extend_from_slice(&flags.to_le_bytes());

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

    if field.is_range {
        if let Some(min) = field.usage_minimum {
            value.extend_from_slice(&min.to_le_bytes());
        } else {
            value.extend_from_slice(&0u32.to_le_bytes());
        }
        if let Some(max) = field.usage_maximum {
            value.extend_from_slice(&max.to_le_bytes());
        } else {
            value.extend_from_slice(&0u32.to_le_bytes());
        }
    } else if let Some(ref usages) = field.usages {
        write_varint(&mut value, usages.len() as u32);
        for &u in usages {
            value.extend_from_slice(&u.to_le_bytes());
        }
    } else {
        write_varint(&mut value, 0);
    }

    write_varint(&mut value, field.strings.len() as u32);
    for s in &field.strings {
        let bytes = s.as_bytes();
        write_varint(&mut value, bytes.len() as u32);
        value.extend_from_slice(bytes);
    }

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

fn decode_field(data: &[u8], off: &mut usize, end: usize) -> Field {
    let flags = u16::from_le_bytes([data[*off], data[*off + 1]]);
    *off += 2;
    let report_size = read_varint(data, off);
    let report_count = read_varint(data, off);
    let logical_minimum = i32::from_le_bytes([
        data[*off],
        data[*off + 1],
        data[*off + 2],
        data[*off + 3],
    ]);
    *off += 4;
    let logical_maximum = i32::from_le_bytes([
        data[*off],
        data[*off + 1],
        data[*off + 2],
        data[*off + 3],
    ]);
    *off += 4;
    let physical_minimum = i32::from_le_bytes([
        data[*off],
        data[*off + 1],
        data[*off + 2],
        data[*off + 3],
    ]);
    *off += 4;
    let physical_maximum = i32::from_le_bytes([
        data[*off],
        data[*off + 1],
        data[*off + 2],
        data[*off + 3],
    ]);
    *off += 4;
    let unit_exponent = data[*off] as i8 as i32;
    *off += 1;
    let unit_system = unit_system_from_tag(data[*off]);
    *off += 1;
    let unit_factor_length_exponent = data[*off] as i8 as i32;
    *off += 1;
    let unit_factor_mass_exponent = data[*off] as i8 as i32;
    *off += 1;
    let unit_factor_time_exponent = data[*off] as i8 as i32;
    *off += 1;
    let unit_factor_temperature_exponent = data[*off] as i8 as i32;
    *off += 1;
    let unit_factor_current_exponent = data[*off] as i8 as i32;
    *off += 1;
    let unit_factor_luminous_intensity_exponent = data[*off] as i8 as i32;
    *off += 1;

    let is_range = flags & (1 << 2) != 0;
    let (usages, usage_minimum, usage_maximum) = if is_range {
        let min = u32::from_le_bytes([
            data[*off],
            data[*off + 1],
            data[*off + 2],
            data[*off + 3],
        ]);
        *off += 4;
        let max = u32::from_le_bytes([
            data[*off],
            data[*off + 1],
            data[*off + 2],
            data[*off + 3],
        ]);
        *off += 4;
        (None, Some(min), Some(max))
    } else {
        let count = read_varint(data, off) as usize;
        let mut u = Vec::with_capacity(count);
        for _ in 0..count {
            u.push(u32::from_le_bytes([
                data[*off],
                data[*off + 1],
                data[*off + 2],
                data[*off + 3],
            ]));
            *off += 4;
        }
        (if u.is_empty() { None } else { Some(u) }, None, None)
    };

    let strings_count = read_varint(data, off) as usize;
    let mut strings = Vec::with_capacity(strings_count);
    for _ in 0..strings_count {
        let byte_len = read_varint(data, off) as usize;
        strings.push(String::from_utf8_lossy(&data[*off..*off + byte_len]).to_string());
        *off += byte_len;
    }

    Field {
        usages,
        usage_minimum,
        usage_maximum,
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
        is_absolute: flags & (1 << 0) != 0,
        is_array: flags & (1 << 1) != 0,
        is_range,
        is_constant: flags & (1 << 3) != 0,
        is_linear: flags & (1 << 4) != 0,
        is_volatile: flags & (1 << 5) != 0,
        is_buffered_bytes: flags & (1 << 6) != 0,
        has_null: flags & (1 << 7) != 0,
        has_preferred_state: flags & (1 << 8) != 0,
        wrap: flags & (1 << 9) != 0,
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
            if tag == TAG_COLLECTION {
                if let Node::Collection(c) = node {
                    roots.push(c);
                }
            }
        }
        Ok(roots)
    } else {
        Vec::<Collection>::deserialize(d)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn test_roundtrip_basic() {
        let original = make_test_collection();
        let mut buf = Vec::new();
        for col in &original {
            encode_collection(&mut buf, col);
        }
        let mut off = 0;
        let mut decoded = Vec::new();
        while off < buf.len() {
            let tag = buf[off];
            let node = decode_node(&buf, &mut off);
            if tag == TAG_COLLECTION {
                if let Node::Collection(c) = node {
                    decoded.push(c);
                }
            }
        }
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
        let mut buf = Vec::new();
        for col in &original {
            encode_collection(&mut buf, col);
        }
        assert!(buf.is_empty());
    }

    #[test]
    fn test_roundtrip_range_field() {
        let col = Collection {
            collection_type: 1,
            usage_page: Some(0x01),
            usage: Some(0x04),
            children: vec![],
            input_reports: vec![Report {
                report_id: 1,
                items: vec![Field {
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
                }],
            }],
            output_reports: vec![],
            feature_reports: vec![],
        };
        let original = vec![col];
        let mut buf = Vec::new();
        for col in &original {
            encode_collection(&mut buf, col);
        }
        let mut off = 0;
        let mut decoded = Vec::new();
        while off < buf.len() {
            let tag = buf[off];
            let node = decode_node(&buf, &mut off);
            if tag == TAG_COLLECTION {
                if let Node::Collection(c) = node {
                    decoded.push(c);
                }
            }
        }
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
        let mut buf = Vec::new();
        encode_collection(&mut buf, &make_test_collection()[0]);
        let mut unknown = Vec::new();
        unknown.push(0xFF);
        write_varint(&mut unknown, 5);
        unknown.extend_from_slice(&[1, 2, 3, 4, 5]);
        let mut after = Vec::new();
        encode_collection(&mut after, &make_test_collection()[0]);
        let mut full = Vec::new();
        full.extend_from_slice(&buf);
        full.extend_from_slice(&unknown);
        full.extend_from_slice(&after);
        let mut off = 0;
        let mut count = 0;
        while off < full.len() {
            let tag = full[off];
            let node = decode_node(&full, &mut off);
            if tag == TAG_COLLECTION {
                if let Node::Collection(_) = node {
                    count += 1;
                }
            }
        }
        assert_eq!(count, 2);
    }
}
