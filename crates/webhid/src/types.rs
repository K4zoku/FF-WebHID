use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Shared device info
// ---------------------------------------------------------------------------

/// A (shallow) collection entry derived from a HID report descriptor.
#[derive(Debug, Clone, Serialize, Deserialize)]
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
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Field {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report_id: Option<u8>,
    pub report_type: String,
    pub size: u32,
    pub count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_page: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usages: Option<Vec<u16>>,
}

/// A HID report grouping (identified by report-id and type).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Report {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<u8>,
    pub report_type: String,
    pub size_bits: u32,
    #[serde(default)]
    pub fields: Vec<Field>,
}

/// Information about a connected HID device, derived from udev/sysfs.
#[derive(Debug, Clone, Serialize, Deserialize)]
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
    /// Raw HID report descriptor bytes, when available (from sysfs). This is
    /// provided so the addon can parse full `collections` metadata without
    /// requiring the daemon to implement descriptor parsing.  (Daemon may
    /// also populate `collections` directly.)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report_descriptor: Option<Vec<u8>>,
    /// Parsed collection metadata (populated by daemon when possible).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collections: Option<Vec<Collection>>,
    /// Absolute path to the hidraw node, e.g. `/dev/hidraw0`.
    /// This doubles as the stable device ID sent to the addon.
    pub path: String,
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
#[serde(tag = "type")]
pub enum IpcRequest {
    /// List every connected HID device.
    Enumerate { id: u32 },
    /// Open the first device that matches the given vendor/product IDs.
    Open { id: u32, vendor_id: u16, product_id: u16 },
    /// Release an open device.
    Close { id: u32, device_id: String },
    /// Block until a HID input report arrives or `timeout_ms` elapses.
    Read { id: u32, device_id: String, timeout_ms: u64 },
    /// Send a HID output report.
    Write { id: u32, device_id: String, data: Vec<u8> },
}

impl IpcRequest {
    pub fn id(&self) -> u32 {
        match self {
            Self::Enumerate { id }
            | Self::Open { id, .. }
            | Self::Close { id, .. }
            | Self::Read { id, .. }
            | Self::Write { id, .. } => *id,
        }
    }
}

/// Response or unsolicited event sent from the daemon to the native-messaging process.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum IpcResponse {
    // Responses (id mirrors the matching request)
    Devices { id: u32, devices: Vec<DeviceInfo> },
    Opened { id: u32, device_id: String },
    Ok { id: u32 },
    Data { id: u32, data: Vec<u8> },
    Error { id: u32, message: String },
    // Unsolicited events (id = 0)
    DeviceConnected { id: u32, device: DeviceInfo },
    DeviceDisconnected { id: u32, device: DeviceInfo },
    InputReport { id: u32, device_id: String, report_id: u8, data: Vec<u8> },
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
            | Self::InputReport { id, .. } => *id,
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
#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "lowercase")]
pub enum NmRequest {
    Enumerate,
    Open {
        vendor_id: u16,
        product_id: u16,
    },
    /// `data` is the device path encoded as a byte array, e.g.
    /// `"/dev/hidraw0"` → `[47, 100, 101, 118, ...]`.
    Close { data: Vec<u8> },
    /// `data` is the device path as bytes; `timeout` is in milliseconds.
    Read { data: Vec<u8>, timeout: u64 },
    /// `device_id` is the device path as bytes; `data` is the report payload.
    Write { device_id: Vec<u8>, data: Vec<u8> },
}

/// A response or event sent back to Firefox via stdout.
#[derive(Debug, Default, Serialize)]
pub struct NmResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub success: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub devices: Option<Vec<DeviceInfo>>,
    /// Raw bytes: device path for `open`, HID report for `read`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Vec<u8>>,
    // Event fields
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device: Option<DeviceInfo>,
    /// Device path as bytes – used in `input_report` events so the addon can
    /// match the event to an open `HIDDevice` instance.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<Vec<u8>>,
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

    pub fn err(message: impl Into<String>) -> Self {
        Self { success: Some(false), error: Some(message.into()), ..Default::default() }
    }

    pub fn event_connect(device: DeviceInfo) -> Self {
        Self { event_type: Some("connect".into()), device: Some(device), ..Default::default() }
    }

    pub fn event_disconnect(device: DeviceInfo) -> Self {
        Self { event_type: Some("disconnect".into()), device: Some(device), ..Default::default() }
    }

    pub fn event_input_report(device_id: Vec<u8>, report_id: u8, data: Vec<u8>) -> Self {
        Self {
            event_type: Some("input_report".into()),
            device_id: Some(device_id),
            report_id: Some(report_id),
            data: Some(data),
            ..Default::default()
        }
    }
}
