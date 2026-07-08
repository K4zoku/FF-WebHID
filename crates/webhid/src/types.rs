use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Shared device info
// ---------------------------------------------------------------------------

/// A (shallow) collection entry derived from a HID report descriptor.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Collection {
    #[serde(rename = "type")]
    pub collection_type: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_page: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<u16>,
    #[serde(default)]
    pub children: Vec<Collection>,
    /// Optional, richer report metadata parsed from the descriptor.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reports: Option<Vec<Report>>,
}

/// A field within a HID report (input/output/feature).
///
/// This struct was intentionally kept small historically but needs to be
/// expanded to carry the richer set of attributes Chromium exposes (flags,
/// logical/physical ranges, units, usage ranges, and packed usages). Keep
/// backward-compatible field names where possible so older consumers still
/// work.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Field {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report_id: Option<u8>,

    // report_type is typically "input" | "output" | "feature"
    pub report_type: String,

    // size in bits and count of items (as before)
    pub size: u32,
    pub count: u32,

    // Usage information: keep both the split `usage_page`/`usage` form for
    // compatibility and a packed `packed_usages` vector (u32) to match
    // Chromium's representation which may pack usagePage<<16 | usage.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_page: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<u16>,

    /// Legacy small-usages array (kept for backward compatibility).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usages: Option<Vec<u16>>,

    /// Packed usages (u32) to match Chromium's packed encoding.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub packed_usages: Option<Vec<u32>>,

    // Per-item flags (optional)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_array: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_range: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_absolute: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_null: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_preferred_state: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_linear: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_buffered_bytes: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_constant: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_volatile: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wrap: Option<bool>,

    // Numeric ranges and units
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logical_minimum: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logical_maximum: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub physical_minimum: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub physical_maximum: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit_exponent: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit_system: Option<String>,

    // Usage range (when item uses UsageMinimum/UsageMaximum)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_minimum: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_maximum: Option<u32>,

    // Optional bit offset within the report payload (helpful for consumers).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bit_offset: Option<u32>,
}

/// A HID report grouping (identified by report-id and type).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Report {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<u8>,
    pub report_type: String,
    pub size_bits: u32,
    #[serde(default)]
    pub fields: Vec<Field>,
}

/// Information about a connected HID device, derived from hidapi + sysfs.
#[derive(Debug, Clone, Serialize, Deserialize, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
pub struct DeviceInfo {
    pub vendor_id: u16,
    pub product_id: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub product_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manufacturer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serial_number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_page: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<u16>,
    /// Stable, platform-independent device identifier.
    /// Format: hash of (vid, pid, serial, interface_number, usage_page, usage, physical_location).
    /// This is what the page sees as `deviceId` and what `open()` takes.
    pub device_id: String,
    /// Raw HID report descriptor bytes, when available (from hidapi/sysfs).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report_descriptor: Option<Vec<u8>>,
    /// Parsed collection metadata (populated by daemon when possible).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[rkyv(with = rkyv::with::Skip)]
    pub collections: Option<Vec<Collection>>,
}

// ---------------------------------------------------------------------------
// IPC protocol  (native-messaging-process  <-->  daemon)
//
// Every message is framed with a 4-byte little-endian length prefix followed
// by a UTF-8 JSON payload.  The "type" field acts as the discriminator.
// Events sent by the daemon always carry id = 0.
// ---------------------------------------------------------------------------

/// Request sent from the native-messaging process to the daemon.
#[derive(Debug, Serialize, Deserialize, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
#[serde(tag = "type")]
pub enum IpcRequest {
    /// List every connected HID device.
    Enumerate { id: u32 },
    /// Open a device by its stable `device_id` (returned by `Enumerate`).
    /// The daemon maps this to the platform-specific raw path internally.
    Open { id: u32, device_id: String },
    /// Release an open device.
    Close { id: u32, device_id: String },
    /// Block until a HID input report arrives or `timeout_ms` elapses.
    Read { id: u32, device_id: String, timeout_ms: u64 },
    /// Send a HID output report.  `data` is the report *payload only*;
    /// the daemon is responsible for prepending the `report_id` byte
    /// before handing the buffer to `write(2)`.  Use `report_id = 0`
    /// for interfaces that don't use numbered reports (Linux hidraw
    /// still requires the leading zero).
    SendReport { id: u32, device_id: String, report_id: u8, data: Vec<u8> },
    /// Receive a HID feature report.
    ReceiveFeatureReport { id: u32, device_id: String, report_id: u8 },
    /// Send a HID feature report.  `data` is the report *payload only*
    /// (same convention as `SendReport`).
    SendFeatureReport { id: u32, device_id: String, report_id: u8, data: Vec<u8> },
}

impl IpcRequest {
    pub fn id(&self) -> u32 {
        match self {
            Self::Enumerate { id }
            | Self::Open { id, .. }
            | Self::Close { id, .. }
            | Self::Read { id, .. }
            | Self::SendReport { id, .. }
            | Self::ReceiveFeatureReport { id, .. }
            | Self::SendFeatureReport { id, .. } => *id,
        }
    }
}

/// A response or unsolicited event sent from the daemon to the native-messaging process.
#[derive(Debug, Clone, Serialize, Deserialize, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
#[serde(tag = "type")]
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
    InputReport { id: u32, device_id: String, report_id: u8, data: Vec<u8> },
    /// Sent once when a client connects, announcing daemon capabilities
    /// (currently just the WebSocket data-plane port).
    Hello { id: u32, ws_port: u16 },
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
            | Self::Hello { id, .. } => *id,
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
        device_id: String,
    },
    /// `data` is the device path as a plain string (e.g. `"/dev/hidraw0"`).
    Close {
        #[serde(default)]
        id: Option<u32>,
        data: String,
    },
    /// `data` is the device path as a plain string; `timeout` is in
    /// milliseconds.
    Read {
        #[serde(default)]
        id: Option<u32>,
        data: String,
        timeout: u64,
    },
    /// `device_id` is the device path as a plain string; `data` is the
    /// report *payload only* (base64‑encoded, without the leading report‑ID
    /// byte).  The daemon prepends `report_id` itself before calling
    /// `write(2)`.
    SendReport {
        #[serde(default)]
        id: Option<u32>,
        device_id: String,
        #[serde(default)]
        report_id: u8,
        #[serde(with = "base64_serde")]
        data: Vec<u8>,
    },
    /// `device_id` is the device path as a plain string; `report_id` is
    /// the feature report ID.
    ReceiveFeatureReport {
        #[serde(default)]
        id: Option<u32>,
        device_id: String,
        report_id: u8,
    },
    /// `device_id` is the device path as a plain string; `data` is the
    /// feature report *payload only* (base64‑encoded, same convention as
    /// `SendReport`).
    SendFeatureReport {
        #[serde(default)]
        id: Option<u32>,
        device_id: String,
        #[serde(default)]
        report_id: u8,
        #[serde(with = "base64_serde")]
        data: Vec<u8>,
    },
}

impl NmRequest {
    pub fn id(&self) -> Option<u32> {
        match self {
            Self::Enumerate { id }
            | Self::Open { id, .. }
            | Self::Close { id, .. }
            | Self::Read { id, .. }
            | Self::SendReport { id, .. }
            | Self::ReceiveFeatureReport { id, .. }
            | Self::SendFeatureReport { id, .. } => *id,
        }
    }
}

/// A response or event sent back to Firefox via stdout.
///
/// Binary fields (`data`) are base64‑encoded; string identifiers are plain
/// strings (not number arrays).  This reduces JSON wire size by ~40–55 %
/// compared to the previous number‑array encoding for HID payloads.
#[derive(Debug, Default, Serialize)]
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
            report_descriptor: None,
            collections: None,
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
            usage: None, device_id: "dev1".into(), report_descriptor: None,
            collections: None,
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
            usage: None, device_id: "dev2".into(), report_descriptor: None,
            collections: None,
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
            NmRequest::Close { id: None, data: "".into() }.id(),
            None
        );
        assert_eq!(
            NmRequest::Read { id: Some(1), data: "".into(), timeout: 0 }.id(),
            Some(1)
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
        assert_eq!(IpcRequest::Read { id: 4, device_id: "".into(), timeout_ms: 0 }.id(), 4);
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
            report_descriptor: None, collections: None,
        }}.id(), 0);
        assert_eq!(IpcResponse::Hello { id: 0, ws_port: 8080 }.id(), 0);
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
            report_descriptor: Some(vec![0x05, 0x01, 0x09, 0x02]),
            collections: None,
        };
        let json = serde_json::to_string(&info).unwrap();
        let de: DeviceInfo = serde_json::from_str(&json).unwrap();
        let json2 = serde_json::to_string(&de).unwrap();
        assert_eq!(json, json2);
    }

    #[test]
    fn test_collection_json_roundtrip() {
        let col = Collection {
            collection_type: 1,
            usage_page: Some(0x01),
            usage: Some(0x02),
            children: vec![],
            reports: Some(vec![Report {
                id: Some(1),
                report_type: "input".into(),
                size_bits: 8,
                fields: vec![Field {
                    report_id: Some(1),
                    report_type: "input".into(),
                    size: 8,
                    count: 1,
                    usage_page: Some(0x01),
                    usage: Some(0x02),
                    usages: None,
                    packed_usages: None,
                    is_array: None,
                    is_range: None,
                    is_absolute: None,
                    has_null: None,
                    has_preferred_state: None,
                    is_linear: None,
                    is_buffered_bytes: None,
                    is_constant: None,
                    is_volatile: None,
                    wrap: None,
                    logical_minimum: None,
                    logical_maximum: None,
                    physical_minimum: None,
                    physical_maximum: None,
                    unit_exponent: None,
                    unit_system: None,
                    usage_minimum: None,
                    usage_maximum: None,
                    bit_offset: None,
                }],
            }]),
        };
        let json = serde_json::to_string(&col).unwrap();
        let de: Collection = serde_json::from_str(&json).unwrap();
        let json2 = serde_json::to_string(&de).unwrap();
        assert_eq!(json, json2);
    }

    #[test]
    fn test_ipc_request_json_roundtrip() {
        let cases: Vec<IpcRequest> = vec![
            IpcRequest::Enumerate { id: 1 },
            IpcRequest::Open { id: 2, device_id: "test-device".into() },
            IpcRequest::Close { id: 3, device_id: "test-device".into() },
            IpcRequest::Read { id: 4, device_id: "test-device".into(), timeout_ms: 5000 },
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
            usage: None, device_id: "dev".into(), report_descriptor: None,
            collections: None,
        };
        let cases: Vec<IpcResponse> = vec![
            IpcResponse::Devices { id: 1, devices: vec![dev.clone()] },
            IpcResponse::Opened { id: 2, device_id: "dev".into(), session_token: Some("tok".into()), ws_port: Some(31337) },
            IpcResponse::Ok { id: 3 },
            IpcResponse::Data { id: 4, data: vec![0x01, 0x02] },
            IpcResponse::Error { id: 5, message: "fail".into() },
            IpcResponse::Hello { id: 0, ws_port: 31337 },
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

        let json = r#"{"action":"open","device_id":"test-dev"}"#;
        let req: NmRequest = serde_json::from_str(json).unwrap();
        assert!(matches!(req, NmRequest::Open { .. }));
        if let NmRequest::Open { device_id, .. } = req {
            assert_eq!(device_id, "test-dev");
        }

        let json = r#"{"action":"close","data":"/dev/hidraw0"}"#;
        let req: NmRequest = serde_json::from_str(json).unwrap();
        assert!(matches!(req, NmRequest::Close { .. }));
    }
}
