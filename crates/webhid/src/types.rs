use std::sync::Arc;

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Shared device info
// ---------------------------------------------------------------------------

/// Information about a connected HID device, derived from hidapi + sysfs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub vendor_id: u16,
    pub product_id: u16,
    #[serde(default)]
    pub product_name: Option<String>,
    #[serde(default)]
    pub manufacturer: Option<String>,
    #[serde(default)]
    pub serial_number: Option<String>,
    #[serde(default)]
    pub usage_page: Option<u16>,
    #[serde(default)]
    pub usage: Option<u16>,
    pub device_id: String,
    #[serde(default)]
    pub collections: Vec<Collection>,
    #[serde(default)]
    pub max_input_report_size: u32,
}

// ── Collections tree (parsed report descriptor) ───────────────────────────

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    #[serde(default)]
    pub usages: Vec<u32>,
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
}

// ---------------------------------------------------------------------------
// IPC protocol  (native-messaging-process  <-->  daemon)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum IpcRequest {
    Enumerate { id: u32 },
    Open { id: u32, device_id: String },
    Close { id: u32, device_id: String },
    SendReport { id: u32, device_id: String, report_id: u8, data: Vec<u8> },
    ReceiveFeatureReport { id: u32, device_id: String, report_id: u8 },
    SendFeatureReport { id: u32, device_id: String, report_id: u8, data: Vec<u8> },
    SetDataPlane { id: u32, device_id: String, mode: String },
}

impl IpcRequest {
    pub fn id(&self) -> u32 {
        match self {
            Self::Enumerate { id }
            | Self::Open { id, .. }
            | Self::Close { id, .. }
            | Self::SendReport { id, .. }
            | Self::ReceiveFeatureReport { id, .. }
            | Self::SendFeatureReport { id, .. }
            | Self::SetDataPlane { id, .. } => *id,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum IpcResponse {
    Devices { id: u32, devices: Vec<DeviceInfo> },
    Opened { id: u32, device_id: String, session_token: Option<String>, ws_port: Option<u16> },
    Ok { id: u32 },
    Data { id: u32, data: Vec<u8> },
    Error { id: u32, message: String },
    DeviceConnected { id: u32, device: DeviceInfo },
    DeviceDisconnected { id: u32, device: DeviceInfo },
    InputReport {
        id: u32,
        device_id: String,
        report_id: u8,
        #[serde(with = "arc_bytes")]
        data: Arc<[u8]>,
    },
    Handshake { id: u32, ws_port: u16 },
}

impl IpcResponse {
    pub fn id(&self) -> u32 {
        match self {
            Self::Devices { id, .. }
            | Self::Opened { id, .. }
            | Self::Ok { id }
            | Self::Data { id, .. }
            | Self::Error { id, .. }
            | Self::DeviceConnected { id, .. }
            | Self::DeviceDisconnected { id, .. }
            | Self::InputReport { id, .. }
            | Self::Handshake { id, .. } => *id,
        }
    }
}

// ---------------------------------------------------------------------------
// NM action codes (numeric)
// ---------------------------------------------------------------------------

pub const ACT_ENUM: u8 = 1;
pub const ACT_OPEN: u8 = 2;
pub const ACT_CLOSE: u8 = 3;
pub const ACT_SEND_REPORT: u8 = 4;
pub const ACT_RECV_FEATURE: u8 = 5;
pub const ACT_SEND_FEATURE: u8 = 6;
pub const ACT_SET_DATA_PLANE: u8 = 7;
pub const ACT_HANDSHAKE: u8 = 8;

// NM event codes (numeric, used in the "e" field)
pub const EVT_HANDSHAKE: u8 = 1;
pub const EVT_CONNECT: u8 = 2;
pub const EVT_DISCONNECT: u8 = 3;
// input_report is packed ({"d":"..."}), no "e" field needed.

// Packed binary message types (first byte of TLV payload)
pub const PKG_INPUT_REPORT: u8 = 0x01;
pub const PKG_SEND_REPORT: u8 = 0x02;

// ---------------------------------------------------------------------------
// NM request (addon → daemon)
// ---------------------------------------------------------------------------

/// A request received from Firefox via stdin.
/// Uses numeric action codes and single-char field names for minimal wire size.
/// Parsed manually in `protocol::read_nm_request` (numeric `a` not supported
/// by serde's `tag` attribute).
#[derive(Debug, Deserialize)]
pub enum NmRequest {
    Enumerate { #[serde(default)] id: Option<u32> },
    Open { #[serde(default)] id: Option<u32>, #[serde(rename = "i")] device_id: String },
    Close { #[serde(default)] id: Option<u32>, #[serde(rename = "i")] device_id: String },
    /// Packed sendReport. `d` is base64 of TLV binary.
    SendReport { #[serde(default)] id: Option<u32>, #[serde(rename = "d")] packed: Vec<u8> },
    ReceiveFeatureReport { #[serde(default)] id: Option<u32>, #[serde(rename = "i")] device_id: String, #[serde(rename = "r")] report_id: u8 },
    SendFeatureReport { #[serde(default)] id: Option<u32>, #[serde(rename = "i")] device_id: String, #[serde(rename = "r")] report_id: u8, #[serde(with = "base64_serde", rename = "d")] data: Vec<u8> },
    SetDataPlane { #[serde(default)] id: Option<u32>, #[serde(rename = "i")] device_id: String, #[serde(rename = "m")] mode: String },
    Handshake { #[serde(default)] id: Option<u32> },
}

impl NmRequest {
    pub fn id(&self) -> Option<u32> {
        match self {
            Self::Enumerate { id }
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

/// Parse a packed sendReport TLV buffer.
/// Layout: [msgType][devIdLen][devId][reportId][payloadLen u16 LE][payload]
pub fn parse_packed_send_report(buf: &[u8]) -> std::io::Result<(&str, u8, &[u8])> {
    let invalid = |msg: &str| std::io::Error::new(std::io::ErrorKind::InvalidData, msg);
    if buf.len() < 5 { return Err(invalid("short packed sendReport")); }
    if buf[0] != PKG_SEND_REPORT { return Err(invalid("bad msgType")); }
    let n = buf[1] as usize;
    if buf.len() < 2 + n + 3 { return Err(invalid("truncated header")); }
    let device_id = std::str::from_utf8(&buf[2..2+n])
        .map_err(|_| invalid("non-utf8 deviceId"))?;
    let report_id = buf[2+n];
    let payload_len = u16::from_le_bytes([buf[3+n], buf[4+n]]) as usize;
    if buf.len() < 5+n + payload_len { return Err(invalid("truncated payload")); }
    Ok((device_id, report_id, &buf[5+n..5+n+payload_len]))
}

// ---------------------------------------------------------------------------
// NM response / event (daemon → addon)
// ---------------------------------------------------------------------------

/// A response or event sent back to Firefox via stdout.
/// Uses single-char field names for minimal wire size.
#[derive(Debug, Default, Serialize)]
pub struct NmResponse {
    #[serde(skip_serializing_if = "Option::is_none", rename = "n")]
    pub id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "o")]
    pub success: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "E")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "D")]
    pub devices: Option<Vec<DeviceInfo>>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "d")]
    #[serde(with = "base64_opt_serde")]
    pub data: Option<Vec<u8>>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "t")]
    pub session_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "c")]
    pub control_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "w")]
    pub ws_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "e")]
    pub event_type: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "v")]
    pub device: Option<DeviceInfo>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "i")]
    pub device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "r")]
    pub report_id: Option<u8>,
}

impl NmResponse {
    pub fn ok() -> Self {
        Self { success: Some(true), ..Default::default() }
    }
    pub fn ok_with_data(data: Vec<u8>) -> Self {
        Self { success: Some(true), data: Some(data), ..Default::default() }
    }
    pub fn ok_with_devices(devices: Vec<DeviceInfo>) -> Self {
        Self { success: Some(true), devices: Some(devices), ..Default::default() }
    }
    pub fn ok_opened(device_id: String, session_token: Option<String>, ws_port: Option<u16>) -> Self {
        Self { success: Some(true), device_id: Some(device_id), session_token, ws_port, ..Default::default() }
    }
    pub fn err(message: impl Into<String>) -> Self {
        Self { success: Some(false), error: Some(message.into()), ..Default::default() }
    }
    pub fn event_connect(device: DeviceInfo) -> Self {
        Self { event_type: Some(EVT_CONNECT), device: Some(device), ..Default::default() }
    }
    pub fn event_disconnect(device: DeviceInfo) -> Self {
        Self { event_type: Some(EVT_DISCONNECT), device: Some(device), ..Default::default() }
    }
}

// ---------------------------------------------------------------------------
// NmMessage: control response or packed data frame
// ---------------------------------------------------------------------------

/// Outbound NM message: either a structured control response/event,
/// or a pre-encoded packed data frame `{"d":"<base64>"}`.
#[derive(Debug)]
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
    /// `reports` is a slice of (report_id, payload) pairs; multiple entries
    /// produce a multi-report batch (JS decoder loops).
    pub fn packed_input_report<'a>(
        device_id: &str,
        reports: impl IntoIterator<Item = (u8, &'a [u8])>,
    ) -> Self {
        let dev_bytes = device_id.as_bytes();
        debug_assert!(dev_bytes.len() <= 255, "deviceId too long");
        let mut buf = Vec::with_capacity(2 + dev_bytes.len() + 16);
        buf.push(PKG_INPUT_REPORT);
        buf.push(dev_bytes.len() as u8);
        buf.extend_from_slice(dev_bytes);
        for (report_id, payload) in reports {
            buf.push(report_id);
            let len = payload.len() as u16;
            buf.extend_from_slice(&len.to_le_bytes());
            buf.extend_from_slice(payload);
        }
        NmMessage::PackedData(buf)
    }
}

// ---------------------------------------------------------------------------
// Base64 serde helpers
// ---------------------------------------------------------------------------

#[allow(dead_code)]
pub(crate) mod base64_serde {
    use base64::Engine;
    use serde::{de, Deserialize, Deserializer, Serialize as _, Serializer};

    pub fn serialize<S: Serializer>(bytes: &Vec<u8>, s: S) -> Result<S::Ok, S::Error> {
        if s.is_human_readable() {
            let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
            encoded.serialize(s)
        } else {
            bytes.as_slice().serialize(s)
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let encoded = String::deserialize(d)?;
        base64::engine::general_purpose::STANDARD
            .decode(&encoded)
            .map_err(de::Error::custom)
    }
}

#[allow(dead_code)]
pub(crate) mod base64_opt_serde {
    use base64::Engine;
    use serde::{de, Deserialize, Deserializer, Serialize as _, Serializer};

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

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<u8>>, D::Error> {
        let opt: Option<String> = Option::deserialize(d)?;
        match opt {
            Some(encoded) => base64::engine::general_purpose::STANDARD
                .decode(&encoded)
                .map(Some)
                .map_err(de::Error::custom),
            None => Ok(None),
        }
    }
}

/// Serde helper for `Arc<[u8]>`.
mod arc_bytes {
    use std::sync::Arc;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(bytes: &Arc<[u8]>, s: S) -> Result<S::Ok, S::Error> {
        bytes.as_ref().serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Arc<[u8]>, D::Error> {
        let v = Vec::<u8>::deserialize(d)?;
        Ok(Arc::from(v))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_nm_response_ok() {
        let r = NmResponse::ok();
        assert_eq!(r.success, Some(true));
    }

    #[test]
    fn test_nm_response_err() {
        let r = NmResponse::err("something went wrong");
        assert_eq!(r.success, Some(false));
        assert_eq!(r.error, Some("something went wrong".into()));
    }

    #[test]
    fn test_nm_response_ok_with_data() {
        let r = NmResponse::ok_with_data(vec![1, 2, 3]);
        assert_eq!(r.success, Some(true));
        assert_eq!(r.data, Some(vec![1, 2, 3]));
    }

    #[test]
    fn test_nm_response_ok_with_devices() {
        let dev = DeviceInfo {
            vendor_id: 0x1234, product_id: 0x5678, product_name: Some("Test".into()),
            manufacturer: None, serial_number: None, usage_page: None,
            usage: None, device_id: "abc".into(), collections: vec![],
            max_input_report_size: 0,
        };
        let r = NmResponse::ok_with_devices(vec![dev]);
        assert_eq!(r.success, Some(true));
        assert!(r.devices.is_some());
    }

    #[test]
    fn test_nm_response_ok_opened() {
        let r = NmResponse::ok_opened("devpath".into(), Some("tok".into()), Some(31337));
        assert_eq!(r.success, Some(true));
        assert_eq!(r.device_id, Some("devpath".into()));
        assert_eq!(r.session_token, Some("tok".into()));
        assert_eq!(r.ws_port, Some(31337));
    }

    #[test]
    fn test_nm_response_json_serialize() {
        let json = serde_json::to_string(&NmResponse::ok()).unwrap();
        assert_eq!(json, r#"{"o":true}"#);

        let json = serde_json::to_string(&NmResponse::err("err")).unwrap();
        assert_eq!(json, r#"{"o":false,"E":"err"}"#);

        let json = serde_json::to_string(&NmResponse::ok_with_data(vec![0xDE])).unwrap();
        assert_eq!(json, r#"{"o":true,"d":"3g=="}"#);
    }

    #[test]
    fn test_packed_input_report() {
        let device_id = "abc123";
        let payload = [0xAA, 0xBB, 0xCC];
        let msg = NmMessage::packed_input_report(device_id, [(33u8, &payload[..])]);
        match msg {
            NmMessage::PackedData(buf) => {
                assert_eq!(buf[0], PKG_INPUT_REPORT);
                assert_eq!(buf[1], device_id.len() as u8);
                assert_eq!(&buf[2..2+device_id.len()], device_id.as_bytes());
                assert_eq!(buf[2+device_id.len()], 33);
                let payload_start = 5 + device_id.len();
                assert_eq!(&buf[payload_start..], &payload);
            }
            _ => panic!("expected PackedData"),
        }
    }

    #[test]
    fn test_parse_packed_send_report() {
        let device_id = "testdev";
        let payload = [0x01, 0x02, 0x03];
        let mut buf = vec![PKG_SEND_REPORT, device_id.len() as u8];
        buf.extend_from_slice(device_id.as_bytes());
        buf.push(42); // reportId
        buf.extend_from_slice(&(payload.len() as u16).to_le_bytes());
        buf.extend_from_slice(&payload);

        let (dev_id, report_id, data) = parse_packed_send_report(&buf).unwrap();
        assert_eq!(dev_id, device_id);
        assert_eq!(report_id, 42);
        assert_eq!(data, &payload);
    }

    #[test]
    fn test_ipc_request_json_roundtrip() {
        let cases: Vec<IpcRequest> = vec![
            IpcRequest::Enumerate { id: 1 },
            IpcRequest::Open { id: 2, device_id: "test-device".into() },
            IpcRequest::Close { id: 3, device_id: "test-device".into() },
            IpcRequest::SendReport { id: 5, device_id: "test-device".into(), report_id: 1, data: vec![0x00, 0xFF] },
            IpcRequest::ReceiveFeatureReport { id: 6, device_id: "test-device".into(), report_id: 0 },
            IpcRequest::SendFeatureReport { id: 7, device_id: "test-device".into(), report_id: 0, data: vec![0xAA] },
        ];
        for req in cases {
            let json = serde_json::to_string(&req).unwrap();
            let de: IpcRequest = serde_json::from_str(&json).unwrap();
            assert_eq!(de.id(), req.id());
        }
    }

    #[test]
    fn test_ipc_response_json_roundtrip() {
        let dev = DeviceInfo {
            vendor_id: 0x1234, product_id: 0x5678, product_name: None,
            manufacturer: None, serial_number: None, usage_page: None,
            usage: None, device_id: "dev".into(), collections: vec![],
            max_input_report_size: 0,
        };
        let cases: Vec<IpcResponse> = vec![
            IpcResponse::Devices { id: 1, devices: vec![dev.clone()] },
            IpcResponse::Opened { id: 2, device_id: "dev".into(), session_token: Some("tok".into()), ws_port: Some(31337) },
            IpcResponse::Ok { id: 3 },
            IpcResponse::Data { id: 4, data: vec![0x01, 0x02] },
            IpcResponse::Error { id: 5, message: "fail".into() },
            IpcResponse::Handshake { id: 0, ws_port: 31337 },
        ];
        for resp in cases {
            let json = serde_json::to_string(&resp).unwrap();
            let de: IpcResponse = serde_json::from_str(&json).unwrap();
            assert_eq!(de.id(), resp.id());
        }
    }
}
