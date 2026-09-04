use bytes::Bytes;
use serde::{Deserialize, Serialize};

/// Information about a connected HID device, derived from hidapi + sysfs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub vendor_id: u16,
    pub product_id: u16,
    #[serde(default)]
    pub product_name: String,
    #[serde(default)]
    pub manufacturer: Option<String>,
    #[serde(default)]
    pub serial_number: Option<String>,
    #[serde(default)]
    pub usage_page: Option<u16>,
    #[serde(default)]
    pub usage: Option<u16>,
    pub device_id: u32,
    #[serde(default, with = "crate::collections_tlv")]
    pub collections: Vec<Collection>,
    #[serde(default)]
    pub max_input_report_size: u32,
    /// True when the report descriptor was missing or failed to parse;
    /// `collections` is then empty.
    #[serde(default)]
    pub descriptor_parse_failed: bool,
    /// Raw HID report descriptor bytes. Daemon-side only; skipped on the wire.
    #[serde(skip)]
    pub raw_descriptor: Vec<u8>,
}

/// Optional filters for an enumerate request used by the device picker.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnumerateFilter {
    #[serde(default)]
    pub filters: Vec<DeviceFilter>,
    #[serde(default)]
    pub exclusion_filters: Vec<DeviceFilter>,
}

/// One WebHID requestDevice filter.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFilter {
    #[serde(default)]
    pub vendor_id: Option<u32>,
    #[serde(default)]
    pub product_id: Option<u32>,
    #[serde(default)]
    pub usage_page: Option<u32>,
    #[serde(default)]
    pub usage: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    #[serde(rename = "type")]
    pub collection_type: u8,
    #[serde(default)]
    pub usage_page: Option<u16>,
    #[serde(default)]
    pub usage: Option<u16>,
    #[serde(default)]
    pub children: Vec<Collection>,
    #[serde(default)]
    pub input_reports: Vec<Report>,
    #[serde(default)]
    pub output_reports: Vec<Report>,
    #[serde(default)]
    pub feature_reports: Vec<Report>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    #[serde(default)]
    pub report_id: u8,
    #[serde(default)]
    pub items: Vec<Field>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usages: Option<Vec<u32>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_minimum: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_maximum: Option<u32>,
    #[serde(default)]
    pub report_size: u32,
    #[serde(default)]
    pub report_count: u32,
    #[serde(default)]
    pub logical_minimum: i32,
    #[serde(default)]
    pub logical_maximum: i32,
    #[serde(default)]
    pub physical_minimum: i32,
    #[serde(default)]
    pub physical_maximum: i32,
    #[serde(default)]
    pub unit_exponent: i32,
    #[serde(default)]
    pub unit_system: String,
    #[serde(default)]
    pub unit_factor_length_exponent: i32,
    #[serde(default)]
    pub unit_factor_mass_exponent: i32,
    #[serde(default)]
    pub unit_factor_time_exponent: i32,
    #[serde(default)]
    pub unit_factor_temperature_exponent: i32,
    #[serde(default)]
    pub unit_factor_current_exponent: i32,
    #[serde(default)]
    pub unit_factor_luminous_intensity_exponent: i32,
    #[serde(default)]
    pub is_absolute: bool,
    #[serde(default)]
    pub is_array: bool,
    #[serde(default)]
    pub is_range: bool,
    #[serde(default)]
    pub is_constant: bool,
    #[serde(default)]
    pub is_linear: bool,
    #[serde(default)]
    pub is_volatile: bool,
    #[serde(default)]
    pub is_buffered_bytes: bool,
    #[serde(default)]
    pub has_null: bool,
    #[serde(default)]
    pub has_preferred_state: bool,
    #[serde(default)]
    pub wrap: bool,
    #[serde(default)]
    pub strings: Vec<String>,
}

#[derive(Debug, Clone)]
pub enum IpcResponse {
    DeviceConnected {
        device: DeviceInfo,
    },
    DeviceDisconnected {
        device: DeviceInfo,
    },
    InputReport {
        device_id: u32,
        report_id: u8,
        data: Bytes,
    },
}

pub const ACT_ENUM: u8 = 1;
pub const ACT_OPEN: u8 = 2;
pub const ACT_CLOSE: u8 = 3;
pub const ACT_RECV_FEATURE: u8 = 5;
pub const ACT_SET_DATA_PLANE: u8 = 7;
pub const ACT_HANDSHAKE: u8 = 8;

pub const EVT_CONNECT: u8 = 2;
pub const EVT_DISCONNECT: u8 = 3;

pub const PKG_INPUT_REPORT: u8 = 0x01;
pub const PKG_SEND_REPORT: u8 = 0x02;
pub const PKG_SEND_FEATURE_REPORT: u8 = 0x04;

/// A request received from Firefox via stdin.
/// Uses numeric action codes and single-char field names for minimal wire size.
/// Parsed manually in `protocol::read_nm_request` (numeric `a` not supported
/// by serde's `tag` attribute).
#[derive(Debug, Deserialize)]
pub enum NmRequest {
    Enumerate {
        #[serde(default)]
        id: Option<u32>,
        #[serde(rename = "f", default)]
        filter: Option<EnumerateFilter>,
    },
    Open {
        #[serde(default)]
        id: Option<u32>,
        #[serde(rename = "i")]
        device_id: u32,
    },
    Close {
        #[serde(default)]
        id: Option<u32>,
        #[serde(rename = "i")]
        device_id: u32,
        #[serde(rename = "T", default)]
        session_token: Option<String>,
    },
    /// Packed sendReport. `d` is base64 of TLV binary.
    SendReport {
        #[serde(default)]
        id: Option<u32>,
        #[serde(rename = "d")]
        packed: Vec<u8>,
    },
    ReceiveFeatureReport {
        #[serde(default)]
        id: Option<u32>,
        #[serde(rename = "i")]
        device_id: u32,
        #[serde(rename = "r")]
        report_id: u8,
    },
    SendFeatureReport {
        #[serde(default)]
        id: Option<u32>,
        #[serde(rename = "i")]
        device_id: u32,
        #[serde(rename = "r")]
        report_id: u8,
        #[serde(with = "base64_serde", rename = "d")]
        data: Vec<u8>,
    },
    SetDataPlane {
        #[serde(default)]
        id: Option<u32>,
        #[serde(rename = "i")]
        device_id: u32,
        #[serde(rename = "m")]
        mode: String,
        #[serde(rename = "T", default)]
        session_token: Option<String>,
    },
    Handshake {
        #[serde(default)]
        id: Option<u32>,
    },
}

impl NmRequest {
    pub fn id(&self) -> Option<u32> {
        match self {
            Self::Enumerate { id, .. }
            | Self::Open { id, .. }
            | Self::Close { id, .. }
            | Self::SendReport { id, .. }
            | Self::ReceiveFeatureReport { id, .. }
            | Self::SendFeatureReport { id, .. }
            | Self::SetDataPlane { id, .. }
            | Self::Handshake { id } => *id,
        }
    }
}

/// Parse a packed sendReport / sendFeatureReport TLV buffer.
/// Layout: [msgType][reqId u32 LE][devId u32 LE][reportId u8][payloadLen u16 LE][payload]
/// Returns (req_id, device_id, report_id, payload slice).
pub fn parse_packed_send(buf: &[u8]) -> std::io::Result<(u32, u32, u8, &[u8])> {
    let invalid = |msg: &str| std::io::Error::new(std::io::ErrorKind::InvalidData, msg);
    if buf.len() < 12 {
        return Err(invalid("short packed send TLV"));
    }
    let req_id = u32::from_le_bytes([buf[1], buf[2], buf[3], buf[4]]);
    let device_id = u32::from_le_bytes([buf[5], buf[6], buf[7], buf[8]]);
    let report_id = buf[9];
    let payload_len = u16::from_le_bytes([buf[10], buf[11]]) as usize;
    if buf.len() < 12 + payload_len {
        return Err(invalid("truncated payload"));
    }
    Ok((req_id, device_id, report_id, &buf[12..12 + payload_len]))
}

/// A response or event sent back to Firefox via stdout.
/// Uses single-char field names for minimal wire size.
/// Status uses HTTP semantics (200/201/204/4xx/5xx).
#[derive(Debug, Default, Serialize)]
pub struct NmResponse {
    #[serde(skip_serializing_if = "Option::is_none", rename = "n")]
    pub id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "s")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "D")]
    pub devices: Option<Vec<DeviceInfo>>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "d")]
    #[serde(with = "base64_opt_serde")]
    pub data: Option<Vec<u8>>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "t")]
    pub session_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "w")]
    pub ws_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "N")]
    pub ws_nonce: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "W")]
    pub wt_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "H")]
    pub wt_cert_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "P")]
    pub hid_permission: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "e")]
    pub event_type: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "v")]
    pub device: Option<DeviceInfo>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "i")]
    pub device_id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "r")]
    pub report_id: Option<u8>,
}

impl NmResponse {
    pub fn ok() -> Self {
        Self {
            status: Some(204),
            ..Default::default()
        }
    }
    pub fn ok_with_data(data: Vec<u8>) -> Self {
        Self {
            status: Some(200),
            data: Some(data),
            ..Default::default()
        }
    }
    pub fn ok_with_devices(devices: Vec<DeviceInfo>) -> Self {
        Self {
            status: Some(200),
            devices: Some(devices),
            ..Default::default()
        }
    }
    pub fn ok_opened(device_id: u32, session_token: Option<String>, ws_port: Option<u16>) -> Self {
        Self {
            status: Some(201),
            device_id: Some(device_id),
            session_token,
            ws_port,
            ..Default::default()
        }
    }
    pub fn err(code: u16) -> Self {
        Self {
            status: Some(code),
            ..Default::default()
        }
    }
    pub fn event_connect(device: DeviceInfo) -> Self {
        Self {
            event_type: Some(EVT_CONNECT),
            device: Some(device.clone()),
            device_id: Some(device.device_id),
            ..Default::default()
        }
    }
    pub fn event_disconnect(device: DeviceInfo) -> Self {
        Self {
            event_type: Some(EVT_DISCONNECT),
            device: Some(device.clone()),
            device_id: Some(device.device_id),
            ..Default::default()
        }
    }
}

/// Outbound NM message: either a structured control response/event,
/// or a pre-encoded packed data frame `{"d":"<base64>"}`.
#[derive(Debug)]
#[allow(clippy::large_enum_variant)]
pub enum NmMessage {
    Control(NmResponse),
    PackedData(Vec<u8>),
}

impl Serialize for NmMessage {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        match self {
            NmMessage::Control(r) => r.serialize(s),
            NmMessage::PackedData(buf) => {
                use base64::Engine;
                let b64 = base64::engine::general_purpose::STANDARD.encode(buf);
                let mut m = s.serialize_map(Some(1))?;
                m.serialize_entry("d", &b64)?;
                m.end()
            }
        }
    }
}

impl NmMessage {
    /// Build a packed input_report frame.
    /// Layout: [0x01][devId u32 LE]([reportId u8][payloadLen u16 LE][payload])*
    pub fn packed_input_report<'a>(
        device_id: u32,
        reports: impl IntoIterator<Item = (u8, &'a [u8])>,
    ) -> Self {
        let mut buf = Vec::with_capacity(8 + 16);
        buf.push(PKG_INPUT_REPORT);
        buf.extend_from_slice(&device_id.to_le_bytes());
        for (report_id, payload) in reports {
            buf.push(report_id);
            let len = payload.len() as u16;
            buf.extend_from_slice(&len.to_le_bytes());
            buf.extend_from_slice(payload);
        }
        NmMessage::PackedData(buf)
    }
}

pub(crate) mod base64_serde {
    use base64::Engine;
    use serde::{Deserialize, Deserializer, de};

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let encoded = String::deserialize(d)?;
        base64::engine::general_purpose::STANDARD
            .decode(&encoded)
            .map_err(de::Error::custom)
    }
}

pub(crate) mod base64_opt_serde {
    use base64::Engine;
    use serde::{Serialize as _, Serializer};

    pub fn serialize<S: Serializer>(bytes: &Option<Vec<u8>>, s: S) -> Result<S::Ok, S::Error> {
        match bytes {
            Some(b) if s.is_human_readable() => {
                let encoded = base64::engine::general_purpose::STANDARD.encode(b);
                encoded.serialize(s)
            }
            Some(b) => b.as_slice().serialize(s),
            None => s.serialize_none(),
        }
    }
}

#[cfg(test)]
#[path = "tests/types_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "tests/types_nm_response_tests.rs"]
mod nm_response_tests;
