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
//
// Every message is framed with a 4-byte little-endian length prefix followed
// by a UTF-8 JSON payload.  The "type" field acts as the discriminator.
// Events sent by the daemon always carry id = 0.
// ---------------------------------------------------------------------------

/// Request sent from the native-messaging process to the daemon.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum IpcRequest {
    Enumerate { id: u32 },
    Open { id: u32, device_id: String },
    Close { id: u32, device_id: String },
    SendReport { id: u32, device_id: String, report_id: u8, data: Vec<u8> },
    ReceiveFeatureReport { id: u32, device_id: String, report_id: u8 },
    SendFeatureReport { id: u32, device_id: String, report_id: u8, data: Vec<u8> },
    /// Client tells the daemon which data-plane channel to use for a device.
    /// `ws` = WebSocket (control + data over WS), `nm` = native messaging.
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

/// A response or unsolicited event sent from the daemon to the native-messaging process.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum IpcResponse {
    // Responses (id mirrors the matching request)
    Devices { id: u32, devices: Vec<DeviceInfo> },
    Opened { id: u32, device_id: String, session_token: Option<String>, ws_port: Option<u16> },
    Ok { id: u32 },
    Data { id: u32, data: Vec<u8> },
    Error { id: u32, message: String },
    // Unsolicited events (id = 0)
    DeviceConnected { id: u32, device: DeviceInfo },
    DeviceDisconnected { id: u32, device: DeviceInfo },
    InputReport {
        id: u32,
        device_id: String,
        report_id: u8,
        #[serde(with = "arc_bytes")]
        data: Arc<[u8]>,
    },
    /// Sent once when a client connects, announcing daemon capabilities
    /// (currently just the WebSocket data-plane port).
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
// Native-messaging protocol  (Firefox addon  <-->  native-messaging process)
//
// Firefox wraps every message with a 4-byte native-endian length prefix.
// On x86/ARM (little-endian) hosts this is identical to the IPC framing.
// The "action" field acts as the discriminator.
// ---------------------------------------------------------------------------

/// A request received from Firefox via stdin.
///
/// String-typed paths/IDs and base64‑encoded binary data replace the
/// previous number‑array encoding, reducing JSON wire size by ~40–55 %.
#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "lowercase")]
pub enum NmRequest {
    Enumerate {
        #[serde(default)]
        id: Option<u32>,
    },
    Open {
        #[serde(default)]
        id: Option<u32>,
        #[serde(rename = "deviceId")]
        device_id: String,
    },
    Close {
        #[serde(default)]
        id: Option<u32>,
        #[serde(rename = "deviceId")]
        device_id: String,
    },
    /// `device_id` is the device path as a plain string; `data` is the
    /// report *payload only* (base64‑encoded, without the leading report‑ID
    /// byte).  The daemon prepends `report_id` itself before calling
    /// `write(2)`.
    SendReport {
        #[serde(default)]
        id: Option<u32>,
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(default, rename = "reportId")]
        report_id: u8,
        #[serde(with = "base64_serde")]
        data: Vec<u8>,
    },
    /// `device_id` is the device path as a plain string; `report_id` is
    /// the feature report ID.
    ReceiveFeatureReport {
        #[serde(default)]
        id: Option<u32>,
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "reportId")]
        report_id: u8,
    },
    /// `device_id` is the device path as a plain string; `data` is the
    /// feature report *payload only* (base64‑encoded, same convention as
    /// `SendReport`).
    SendFeatureReport {
        #[serde(default)]
        id: Option<u32>,
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(default, rename = "reportId")]
        report_id: u8,
        #[serde(with = "base64_serde")]
        data: Vec<u8>,
    },
    /// Tell the daemon to route events for `device_id` over WS or NM.
    SetDataPlane {
        #[serde(default)]
        id: Option<u32>,
        #[serde(rename = "deviceId")]
        device_id: String,
        mode: String,
    },
    /// Request control-plane token + WS port. Daemon generates a control
    /// token (separate from per-device session tokens) that allows a
    /// control-only WS connection (enumerate/close, no device data).
    Handshake {
        #[serde(default)]
        id: Option<u32>,
    },
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

/// A response or event sent back to Firefox via stdout.
///
/// Binary fields (`data`) are base64‑encoded; string identifiers are plain
/// strings (not number arrays).  This reduces JSON wire size by ~40–55 %
/// compared to the previous number‑array encoding for HID payloads.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NmResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub success: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub devices: Option<Vec<DeviceInfo>>,
    /// HID report bytes (base64‑encoded in JSON).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(with = "base64_opt_serde")]
    pub data: Option<Vec<u8>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub control_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ws_port: Option<u16>,
    // Event fields
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device: Option<DeviceInfo>,
    /// Device path string – used in `open` responses and `input_report`
    /// events so the addon can match the event to an open `HIDDevice`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
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
        Self {
            success: Some(true),
            device_id: Some(device_id),
            session_token,
            ws_port,
            ..Default::default()
        }
    }

    pub fn err(message: impl Into<String>) -> Self {
        Self { success: Some(false), error: Some(message.into()), ..Default::default() }
    }

    pub fn event_connect(device: DeviceInfo) -> Self {
        Self { event_type: Some("connect".into()), device: Some(device), ..Default::default() }
    }

    pub fn event_disconnect(device: DeviceInfo) -> Self {
        Self { event_type: Some("disconnect".into()), device: Some(device), ..Default::default() }
    }

    pub fn event_input_report(device_id: String, report_id: u8, data: Vec<u8>) -> Self {
        Self {
            event_type: Some("input_report".into()),
            device_id: Some(device_id),
            report_id: Some(report_id),
            data: Some(data),
            ..Default::default()
        }
    }
}

// ---------------------------------------------------------------------------
// Base64 serde helpers  (human‑readable → base64 string, binary → raw bytes)
// ---------------------------------------------------------------------------

/// Serde helpers for `Vec<u8>` — base64 in human‑readable formats,
/// raw bytes in binary formats.
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

/// Same as `base64_serde` but wraps in `Option` — use for `Option<Vec<u8>>`.
#[allow(dead_code)]
pub(crate) mod base64_opt_serde {
    use base64::Engine;
    use serde::{de, Deserialize, Deserializer, Serialize as _, Serializer};

    pub fn serialize<S: Serializer>(
        bytes: &Option<Vec<u8>>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        match bytes {
            Some(b) if s.is_human_readable() => {
                let encoded = base64::engine::general_purpose::STANDARD.encode(b);
                encoded.serialize(s)
            }
            Some(b) => b.as_slice().serialize(s),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        d: D,
    ) -> Result<Option<Vec<u8>>, D::Error> {
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

#[cfg(test)]
mod tests {
    use super::*;

    // ── NmResponse builders ─────────────────────────────────────────────

    #[test]
    fn test_nm_response_ok() {
        let r = NmResponse::ok();
        assert_eq!(r.success, Some(true));
        assert!(r.error.is_none());
        assert!(r.devices.is_none());
        assert!(r.data.is_none());
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
            vendor_id: 0x1234,
            product_id: 0x5678,
            product_name: Some("Test".into()),
            manufacturer: None,
            serial_number: None,
            usage_page: None,
            usage: None,
            device_id: "abc".into(),
            collections: vec![],
            max_input_report_size: 64,
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
        assert!(r.data.is_none());
        assert_eq!(r.session_token, Some("tok".into()));
        assert_eq!(r.ws_port, Some(31337));
    }

    #[test]
    fn test_nm_response_ok_opened_no_ws() {
        let r = NmResponse::ok_opened("devpath".into(), None, None);
        assert_eq!(r.success, Some(true));
        assert_eq!(r.device_id, Some("devpath".into()));
        assert!(r.data.is_none());
        assert!(r.session_token.is_none());
        assert!(r.ws_port.is_none());
    }

    #[test]
    fn test_nm_response_event_connect() {
        let r = NmResponse::event_connect(DeviceInfo {
            vendor_id: 0x1234, product_id: 0x5678, product_name: None,
            manufacturer: None, serial_number: None, usage_page: None,
            usage: None, device_id: "dev1".into(), collections: vec![],
            max_input_report_size: 64,
        });
        assert_eq!(r.event_type, Some("connect".into()));
        assert!(r.device.is_some());
        assert_eq!(r.device.as_ref().unwrap().vendor_id, 0x1234);
    }

    #[test]
    fn test_nm_response_event_disconnect() {
        let r = NmResponse::event_disconnect(DeviceInfo {
            vendor_id: 0x4321, product_id: 0x8765, product_name: None,
            manufacturer: None, serial_number: None, usage_page: None,
            usage: None, device_id: "dev2".into(), collections: vec![],
            max_input_report_size: 64,
        });
        assert_eq!(r.event_type, Some("disconnect".into()));
        assert!(r.device.is_some());
        assert_eq!(r.device.as_ref().unwrap().vendor_id, 0x4321);
    }

    #[test]
    fn test_nm_response_event_input_report() {
        let r = NmResponse::event_input_report("dev1".into(), 5, vec![0xAA, 0xBB]);
        assert_eq!(r.event_type, Some("input_report".into()));
        assert_eq!(r.device_id, Some("dev1".into()));
        assert_eq!(r.report_id, Some(5));
        assert_eq!(r.data, Some(vec![0xAA, 0xBB]));
    }

    // ── NmRequest::id ───────────────────────────────────────────────────

    #[test]
    fn test_nm_request_id() {
        assert_eq!(NmRequest::Enumerate { id: None }.id(), None);
        assert_eq!(NmRequest::Enumerate { id: Some(3) }.id(), Some(3));
        assert_eq!(
            NmRequest::Open { id: Some(7), device_id: "".into() }.id(),
            Some(7)
        );
        assert_eq!(
            NmRequest::Close { id: None, device_id: "".into() }.id(),
            None
        );
        assert_eq!(
            NmRequest::SendReport { id: None, device_id: "".into(), report_id: 0, data: vec![] }.id(),
            None
        );
        assert_eq!(
            NmRequest::ReceiveFeatureReport { id: Some(9), device_id: "".into(), report_id: 0 }.id(),
            Some(9)
        );
        assert_eq!(
            NmRequest::SendFeatureReport { id: None, device_id: "".into(), report_id: 0, data: vec![] }.id(),
            None
        );
    }

    // ── IpcRequest::id ──────────────────────────────────────────────────

    #[test]
    fn test_ipc_request_id() {
        assert_eq!(IpcRequest::Enumerate { id: 1 }.id(), 1);
        assert_eq!(IpcRequest::Open { id: 2, device_id: "".into() }.id(), 2);
        assert_eq!(IpcRequest::Close { id: 3, device_id: "".into() }.id(), 3);
        assert_eq!(IpcRequest::SendReport { id: 5, device_id: "".into(), report_id: 0, data: vec![] }.id(), 5);
        assert_eq!(IpcRequest::ReceiveFeatureReport { id: 6, device_id: "".into(), report_id: 0 }.id(), 6);
        assert_eq!(IpcRequest::SendFeatureReport { id: 7, device_id: "".into(), report_id: 0, data: vec![] }.id(), 7);
    }

    // ── IpcResponse::id ─────────────────────────────────────────────────

    #[test]
    fn test_ipc_response_id() {
        assert_eq!(IpcResponse::Devices { id: 1, devices: vec![] }.id(), 1);
        assert_eq!(
            IpcResponse::Opened { id: 2, device_id: "".into(), session_token: None, ws_port: None }.id(),
            2
        );
        assert_eq!(IpcResponse::Ok { id: 3 }.id(), 3);
        assert_eq!(IpcResponse::Data { id: 4, data: vec![] }.id(), 4);
        assert_eq!(IpcResponse::Error { id: 5, message: "".into() }.id(), 5);
        assert_eq!(IpcResponse::DeviceConnected { id: 0, device: DeviceInfo {
            vendor_id: 0, product_id: 0, product_name: None, manufacturer: None,
            serial_number: None, usage_page: None, usage: None, device_id: "".into(),
            max_input_report_size: 64,
            collections: vec![],
        }}.id(), 0);
        assert_eq!(IpcResponse::Handshake { id: 0, ws_port: 8080 }.id(), 0);
    }

    // ── JSON round-trips ────────────────────────────────────────────────

    #[test]
    fn test_device_info_json_roundtrip() {
        let info = DeviceInfo {
            vendor_id: 0x1234,
            product_id: 0x5678,
            product_name: Some("Test Device".into()),
            manufacturer: Some("Test Vendor".into()),
            serial_number: Some("SN001".into()),
            usage_page: Some(0xFF00),
            usage: Some(0x01),
            device_id: "abc123def456".into(),
            collections: vec![],
            max_input_report_size: 64,
        };
        let json = serde_json::to_string(&info).unwrap();
        let de: DeviceInfo = serde_json::from_str(&json).unwrap();
        let json2 = serde_json::to_string(&de).unwrap();
        assert_eq!(json, json2);
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
            max_input_report_size: 64,
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

    #[test]
    fn test_nm_response_json_serialize() {
        let json = serde_json::to_string(&NmResponse::ok()).unwrap();
        assert_eq!(json, r#"{"success":true}"#);

        let json = serde_json::to_string(&NmResponse::err("err")).unwrap();
        assert_eq!(json, r#"{"success":false,"error":"err"}"#);

        let json = serde_json::to_string(&NmResponse::ok_with_data(vec![0xDE])).unwrap();
        // [0xDE] base64-encoded is "3g=="
        assert_eq!(json, r#"{"success":true,"data":"3g=="}"#);
    }

    #[test]
    fn test_nm_request_deserialize() {
        let json = r#"{"action":"enumerate"}"#;
        let req: NmRequest = serde_json::from_str(json).unwrap();
        assert!(matches!(req, NmRequest::Enumerate { id: None }));

        let json = r#"{"action":"open","deviceId":"test-dev"}"#;
        let req: NmRequest = serde_json::from_str(json).unwrap();
        assert!(matches!(req, NmRequest::Open { .. }));
        if let NmRequest::Open { device_id, .. } = req {
            assert_eq!(device_id, "test-dev");
        }

        let json = r#"{"action":"close","deviceId":"abc123"}"#;
        let req: NmRequest = serde_json::from_str(json).unwrap();
        assert!(matches!(req, NmRequest::Close { .. }));
    }
}

/// Serde helper for `Arc<[u8]>` — serialize as `Vec<u8>`, deserialize from `Vec<u8>`.
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
