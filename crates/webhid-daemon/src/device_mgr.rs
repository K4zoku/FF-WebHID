use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use hidapi::HidDevice;
use sha2::{Digest, Sha256};

use tokio::sync::broadcast;
use tokio::task::JoinHandle;

use anyhow::anyhow;
use webhid::{DeviceInfo, IpcResponse};

use crate::blocklist::{self, ReportType};
use crate::hid;
const MODE_NM: &str = "nm";
const MODE_WS: &str = "ws";
const MODE_WT: &str = "wt";

// One collection on a report's chain: usage_page, usage, and whether the
// collection is an Application collection (type 0x01). Chromium propagates
// every report to all of its ancestor collections (hid_collection.cc), so a
// report is associated with every collection from its innermost container up
// to the top level; the Application flag mirrors the Application-only gate
// in Chromium's HasReportInAlwaysProtectedCollection.
type ReportAssociation = (Option<u16>, Option<u16>, bool);

// (report_id, report_type) -> every collection association for that report.
// Multiple collections can share a report_id (notably unnumbered report 0),
// so each key carries a list. Nested child collections are walked
// recursively, mirroring Chromium's kWebHidRecursiveFiltering (enabled by
// default) so reports living in child collections (e.g. a Keyboard nested
// under a vendor top-level) are seen.
type ReportCollectionMap = HashMap<(u8, u8), Vec<ReportAssociation>>;

struct Entry {
    device: Arc<Mutex<HidDevice>>,
    stop_flag: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
    refcount: u32,
    dataplane_modes: Mutex<HashMap<String, String>>,
    ws_generation: AtomicU64,
    wt_generation: AtomicU64,
    vendor_id: u16,
    product_id: u16,
    report_to_collection: Arc<ReportCollectionMap>,
    /// Chromium's IsAlwaysProtected fallback per report type (input/output/
    /// feature): whether any top-level collection is always protected for
    /// that type. Blocks report IDs not declared anywhere in the descriptor.
    always_protected: [bool; 3],
    /// Parse-failure fallback per report type: hidapi interface usage itself
    /// is protected (unparseable descriptor, e.g. empty boot-keyboard
    /// interface). Blocks every report when true.
    interface_protected: [bool; 3],
}

fn random_hex_token(n: usize) -> Result<String, getrandom::Error> {
    let mut buf = vec![0u8; n];
    getrandom::fill(&mut buf)?;
    Ok(hex::encode(&buf))
}

fn build_report_collection_map(info: &DeviceInfo) -> ReportCollectionMap {
    fn walk(
        col: &webhid::Collection,
        ancestors: &[ReportAssociation],
        map: &mut ReportCollectionMap,
    ) {
        let is_app = col.collection_type == 1; // Application
        let mut chain = Vec::with_capacity(ancestors.len() + 1);
        chain.extend_from_slice(ancestors);
        chain.push((col.usage_page, col.usage, is_app));
        for r in &col.input_reports {
            map.entry((r.report_id, 0))
                .or_default()
                .extend_from_slice(&chain);
        }
        for r in &col.output_reports {
            map.entry((r.report_id, 1))
                .or_default()
                .extend_from_slice(&chain);
        }
        for r in &col.feature_reports {
            map.entry((r.report_id, 2))
                .or_default()
                .extend_from_slice(&chain);
        }
        for c in &col.children {
            walk(c, &chain, map);
        }
    }
    let mut map: ReportCollectionMap = HashMap::new();
    for col in &info.collections {
        walk(col, &[], &mut map);
    }
    map
}

#[cfg(feature = "report-blocking")]
fn always_protected_usage(up: Option<u16>, u: Option<u16>, rt: ReportType) -> bool {
    blocklist::is_always_protected(up, u, rt)
}
#[cfg(not(feature = "report-blocking"))]
fn always_protected_usage(_up: Option<u16>, _u: Option<u16>, _rt: ReportType) -> bool {
    false
}

// A report is protected when ANY collection association matches a blocklist
// rule, or when an Application collection on its chain is always protected.
// This mirrors Chromium's HidBlocklist::GetProtectedReportIds (union of the
// report IDs of every collection matching a rule) plus the hardcoded
// IsAlwaysProtected layer (HidConnection::IsReportProtected): if a keyboard
// collection and a vendor collection share a report_id (common for unnumbered
// report 0), the report is still dropped because the keyboard data in it must
// never reach the page. An empty association list never blocks.
fn associations_any_protected(
    rules: &[blocklist::BlocklistRule],
    vendor_id: u16,
    product_id: u16,
    associations: &[ReportAssociation],
    report_id: u8,
    report_type: ReportType,
) -> bool {
    !associations.is_empty()
        && associations.iter().any(|(up, u, is_app)| {
            blocklist::is_report_blocked(
                rules, vendor_id, product_id, *up, *u, report_id, report_type,
            ) || (*is_app && always_protected_usage(*up, *u, report_type))
        })
}

// Mirrors Chromium's HidConnection::HasAlwaysProtectedCollection: whether any
// TOP-LEVEL collection's usage is always protected for the report type. Used
// as the fallback for reports not declared anywhere in the descriptor (see
// HidConnection::IsReportProtected), where Chromium drops unknown report IDs
// on devices that carry an always-protected collection of that type.
fn has_always_protected_collection(info: &DeviceInfo, report_type: ReportType) -> bool {
    info.collections
        .iter()
        .any(|c| always_protected_usage(c.usage_page, c.usage, report_type))
}

// Fallback for devices whose report descriptor failed to parse (or is
// empty), so `collections` carries no blocking information: if the hidapi
// interface usage itself matches a blocklist rule or is always protected,
// every report is treated as protected. Chromium's parser is lenient enough
// to interpret such descriptors, so this closes the gap where an unparseable
// consumer-input device would otherwise flow unblocked (e.g. a boot-keyboard
// interface with an empty descriptor).
fn interface_protected(info: &DeviceInfo, report_type: ReportType) -> bool {
    if !info.collections.is_empty() {
        return false; // parsed: the report map handles blocking
    }
    let rules = blocklist::blocklist_rules();
    blocklist::is_report_blocked(
        rules,
        info.vendor_id,
        info.product_id,
        info.usage_page,
        info.usage,
        0,
        report_type,
    ) || always_protected_usage(info.usage_page, info.usage, report_type)
}

fn compute_blocked_input_ids(info: &DeviceInfo, report_map: &ReportCollectionMap) -> HashSet<u8> {
    let rules = blocklist::blocklist_rules();
    let mut ids = HashSet::new();
    for (&(report_id, rt_byte), associations) in report_map {
        if rt_byte != 0 {
            continue;
        }
        if associations_any_protected(
            rules,
            info.vendor_id,
            info.product_id,
            associations,
            report_id,
            ReportType::Input,
        ) {
            ids.insert(report_id);
        }
    }
    ids
}

fn compute_ws_auth_hash(token: &str, nonce: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hasher.update(nonce.as_bytes());
    let digest = hasher.finalize();
    hex::encode(digest)
}

pub struct DeviceManager {
    devices: Arc<Mutex<HashMap<u32, Entry>>>,
    ws_auth_hashes: Arc<Mutex<HashMap<String, (u32, String)>>>,
    ws_nonce: String,
    event_tx: broadcast::Sender<IpcResponse>,
}
impl DeviceManager {
    pub fn new(event_tx: broadcast::Sender<IpcResponse>) -> Self {
        let ws_nonce = random_hex_token(16).expect("getrandom should not fail on modern kernels");
        Self {
            devices: Mutex::new(HashMap::new()).into(),
            ws_auth_hashes: Mutex::new(HashMap::new()).into(),
            ws_nonce,
            event_tx,
        }
    }

    pub fn ws_nonce(&self) -> &str {
        &self.ws_nonce
    }

    pub fn enumerate(&self) -> anyhow::Result<Vec<DeviceInfo>> {
        hid::enumerate()
    }

    pub fn open(&self, device_id: u32) -> anyhow::Result<(u32, Option<String>)> {
        let session_token = random_hex_token(16)?;
        let ws_auth_hash = compute_ws_auth_hash(&session_token, &self.ws_nonce);

        {
            let mut map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(entry) = map.get_mut(&device_id) {
                entry.refcount += 1;
                let rc = entry.refcount;
                entry
                    .dataplane_modes
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(session_token.clone(), MODE_NM.to_string());
                drop(map);
                self.ws_auth_hashes
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(ws_auth_hash.clone(), (device_id, session_token.clone()));
                log::info!("[device_mgr] {device_id:#x} refcount → {rc} (existing session)");
                return Ok((device_id, Some(session_token)));
            }
        }

        let (info, uses_numbered_reports, device) = hid::open_by_device_id(device_id)?;
        let id = info.device_id;

        let report_map = Arc::new(build_report_collection_map(&info));
        let blocked_input_ids = Arc::new(compute_blocked_input_ids(&info, &report_map));
        let declared_input_ids: Arc<HashSet<u8>> = Arc::new(
            report_map
                .keys()
                .filter(|(_, rt)| *rt == 0)
                .map(|(rid, _)| *rid)
                .collect(),
        );
        let always_protected = [
            has_always_protected_collection(&info, ReportType::Input),
            has_always_protected_collection(&info, ReportType::Output),
            has_always_protected_collection(&info, ReportType::Feature),
        ];
        let interface_protected = [
            interface_protected(&info, ReportType::Input),
            interface_protected(&info, ReportType::Output),
            interface_protected(&info, ReportType::Feature),
        ];

        let stop_flag = Arc::new(AtomicBool::new(false));

        let reader_device = match hid::open_by_device_id(id) {
            Ok((_, _, d)) => d,
            Err(e) => {
                return Err(e);
            }
        };
        let reader_arc = Arc::new(Mutex::new(reader_device));
        let writer_arc = Arc::new(Mutex::new(device));

        let mut map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get_mut(&id) {
            entry.refcount += 1;
            let rc = entry.refcount;
            entry
                .dataplane_modes
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(session_token.clone(), MODE_NM.to_string());
            drop(map);
            self.ws_auth_hashes
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(ws_auth_hash.clone(), (id, session_token.clone()));
            log::info!("[device_mgr] {id:#x} refcount → {rc} (existing session)");
            return Ok((id, Some(session_token)));
        }

        let entry = Entry {
            device: Arc::clone(&writer_arc),
            stop_flag: Arc::clone(&stop_flag),
            handle: None,
            refcount: 1,
            ws_generation: AtomicU64::new(0),
            wt_generation: AtomicU64::new(0),
            dataplane_modes: Mutex::new(HashMap::from([(
                session_token.clone(),
                MODE_NM.to_string(),
            )])),
            vendor_id: info.vendor_id,
            product_id: info.product_id,
            report_to_collection: Arc::clone(&report_map),
            always_protected,
            interface_protected,
        };

        map.insert(id, entry);
        self.ws_auth_hashes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(ws_auth_hash.clone(), (id, session_token.clone()));

        let dev_id = id;
        let dev_for_task = Arc::clone(&reader_arc);
        let stop_for_task = Arc::clone(&stop_flag);
        let blocked_for_task = Arc::clone(&blocked_input_ids);
        let declared_for_task = Arc::clone(&declared_input_ids);
        let always_protected_input = always_protected[0];
        let interface_protected_input = interface_protected[0];
        let tx = self.event_tx.clone();
        let read_buf_size = info.max_input_report_size as usize + 1;

        log::info!(
            "[reader] starting for {dev_id:#x} (numbered_reports={uses_numbered_reports}, buf_size={read_buf_size})"
        );
        let handle = tokio::spawn(async move {
            loop {
                if stop_for_task.load(Ordering::SeqCst) {
                    break;
                }

                let read_result = tokio::task::spawn_blocking({
                    let dev = Arc::clone(&dev_for_task);
                    move || {
                        let d = dev.lock().unwrap_or_else(|e| e.into_inner());
                        hid::read_with_timeout(&d, 500, read_buf_size)
                    }
                })
                .await;

                match read_result {
                    Ok(Ok(buf)) => {
                        let (report_id, data): (u8, Bytes) = if uses_numbered_reports {
                            if !buf.is_empty() {
                                let b = Bytes::from(buf);
                                let report_id = b[0];
                                let data = b.slice(1..);
                                (report_id, data)
                            } else {
                                (0u8, Bytes::new())
                            }
                        } else {
                            (0u8, Bytes::from(buf))
                        };
                        // Chromium's HidConnection::ProcessInputReport: drop
                        // protected report IDs, and drop IDs not declared in
                        // the descriptor when the device carries an
                        // always-protected input collection (fallback for
                        // undocumented reports).
                        if blocked_for_task.contains(&report_id)
                            || interface_protected_input
                            || (!declared_for_task.contains(&report_id)
                                && always_protected_input)
                        {
                            log::debug!(
                                "[reader {dev_id:#x}] dropping blocked input report_id={report_id}"
                            );
                            continue;
                        }
                        let _ = tx.send(IpcResponse::InputReport {
                            id: 0,
                            device_id: dev_id,
                            report_id,
                            data,
                        });
                    }
                    Ok(Err(e)) => {
                        if e.kind() == std::io::ErrorKind::TimedOut {
                            continue;
                        }
                        log::warn!("[reader {dev_id:#x}] read error: {e}; stopping");
                        break;
                    }
                    Err(e) => {
                        log::warn!("[reader {dev_id:#x}] join error: {e}; stopping");
                        break;
                    }
                }
            }
            log::info!("[reader {dev_id:#x}] stopped");
        });

        if let Some(e) = map.get_mut(&id) {
            e.handle = Some(handle);
        }

        Ok((id, Some(session_token)))
    }

    pub fn close(&self, device_id: u32, session_token: Option<&str>) -> anyhow::Result<()> {
        let mut map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        let entry = map
            .get_mut(&device_id)
            .ok_or_else(|| anyhow!("'{device_id:#x}' not open"))?;
        if let Some(token) = session_token {
            entry
                .dataplane_modes
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(token);
        }
        if entry.refcount > 1 {
            entry.refcount -= 1;
            log::info!(
                "[device_mgr] {device_id:#x} refcount → {} (session closed, device stays open)",
                entry.refcount
            );
            return Ok(());
        }
        let mut entry = map
            .remove(&device_id)
            .ok_or_else(|| anyhow!("'{device_id:#x}' not open"))?;
        entry.stop_flag.store(true, Ordering::SeqCst);
        if let Some(handle) = entry.handle.take() {
            handle.abort();
        }
        drop(map);

        let mut hashes = self
            .ws_auth_hashes
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        hashes.retain(|_, (dev_id, _)| *dev_id != device_id);
        log::info!("[device_mgr] {device_id:#x} closed (refcount → 0)");
        Ok(())
    }

    pub fn get_file(&self, device_id: u32) -> anyhow::Result<Arc<Mutex<HidDevice>>> {
        let map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        let entry = map
            .get(&device_id)
            .ok_or_else(|| anyhow!("'{device_id:#x}' not open"))?;
        Ok(Arc::clone(&entry.device))
    }

    pub fn set_dataplane_mode(&self, device_id: u32, session_token: &str, mode: &str) {
        let map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get(&device_id) {
            entry
                .dataplane_modes
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(session_token.to_string(), mode.to_string());
            log::info!("[device_mgr] {device_id:#x} session dataplane mode → {mode}");
        }
    }

    pub fn ws_connect(&self, device_id: u32, session_token: &str) -> u64 {
        let map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get(&device_id) {
            let g = entry.ws_generation.fetch_add(1, Ordering::SeqCst) + 1;
            entry
                .dataplane_modes
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(session_token.to_string(), MODE_WS.to_string());
            log::info!("[device_mgr] {device_id:#x} WS connect gen={g}");
            g
        } else {
            0
        }
    }

    pub fn ws_disconnect(&self, device_id: u32, session_token: &str, generation: u64) {
        let map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get(&device_id) {
            let current = entry.ws_generation.load(Ordering::SeqCst);
            if current == generation {
                entry
                    .dataplane_modes
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(session_token.to_string(), MODE_NM.to_string());
                log::info!("[device_mgr] {device_id:#x} WS disconnect gen={generation} → nm");
            } else {
                log::info!(
                    "[device_mgr] {device_id:#x} WS disconnect gen={generation} stale (current={current}), keeping ws"
                );
            }
        }
    }

    pub fn wt_connect(&self, device_id: u32, session_token: &str) -> u64 {
        let map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get(&device_id) {
            let g = entry.wt_generation.fetch_add(1, Ordering::SeqCst) + 1;
            entry
                .dataplane_modes
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(session_token.to_string(), MODE_WT.to_string());
            log::info!("[device_mgr] {device_id:#x} WT connect gen={g}");
            g
        } else {
            0
        }
    }

    pub fn wt_disconnect(&self, device_id: u32, session_token: &str, generation: u64) {
        let map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get(&device_id) {
            let current = entry.wt_generation.load(Ordering::SeqCst);
            if current == generation {
                entry
                    .dataplane_modes
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(session_token.to_string(), MODE_NM.to_string());
                log::info!("[device_mgr] {device_id:#x} WT disconnect gen={generation} → nm");
            } else {
                log::info!(
                    "[device_mgr] {device_id:#x} WT disconnect gen={generation} stale (current={current}), keeping wt"
                );
            }
        }
    }

    pub fn has_nm_session(&self, device_id: u32) -> bool {
        let map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get(&device_id) {
            let modes = entry
                .dataplane_modes
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            modes.values().any(|m| m == MODE_NM)
        } else {
            false
        }
    }

    pub fn close_all_devices(&self) {
        let mut map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        let keys: Vec<u32> = map.keys().copied().collect();
        for k in keys {
            if let Some(mut entry) = map.remove(&k) {
                entry.stop_flag.store(true, Ordering::SeqCst);
                if let Some(handle) = entry.handle.take() {
                    handle.abort();
                }
            }
        }
        drop(map);
        self.ws_auth_hashes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }

    pub fn force_close(&self, device_id: u32) {
        let mut map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        let Some(mut entry) = map.remove(&device_id) else {
            return;
        };
        entry.stop_flag.store(true, Ordering::SeqCst);
        if let Some(handle) = entry.handle.take() {
            handle.abort();
        }
        drop(map);
        let mut hashes = self
            .ws_auth_hashes
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        hashes.retain(|_, (dev_id, _)| *dev_id != device_id);
        log::info!("[device_mgr] {device_id:#x} force-closed (hotplug removal)");
    }

    pub fn is_report_blocked(
        &self,
        device_id: u32,
        report_id: u8,
        report_type: ReportType,
    ) -> bool {
        let map = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        let entry = match map.get(&device_id) {
            Some(e) => e,
            None => return false,
        };
        let rt_byte = match report_type {
            ReportType::Input => 0,
            ReportType::Output => 1,
            ReportType::Feature => 2,
        };
        let associations = match entry.report_to_collection.get(&(report_id, rt_byte)) {
            Some(v) => v,
            // Undocumented report ID: Chromium falls back to blocking when
            // the device has an always-protected collection of this type, or
            // when the unparsed interface usage itself is protected.
            None => {
                return entry.always_protected[rt_byte as usize]
                    || entry.interface_protected[rt_byte as usize]
            }
        };
        let rules = blocklist::blocklist_rules();
        associations_any_protected(
            rules,
            entry.vendor_id,
            entry.product_id,
            associations,
            report_id,
            report_type,
        )
    }

    pub fn get_device_by_ws_auth(&self, hash: &str) -> Option<(u32, String)> {
        use subtle::ConstantTimeEq;
        let hashes = self
            .ws_auth_hashes
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let hash_bytes = hash.as_bytes();
        for (stored_hash, (dev_id, token)) in hashes.iter() {
            let stored_bytes = stored_hash.as_bytes();
            if stored_bytes.len() == hash_bytes.len() && stored_bytes.ct_eq(hash_bytes).into() {
                return Some((*dev_id, token.clone()));
            }
        }
        None
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::broadcast;
    #[cfg(feature = "report-blocking")]
    use webhid::{Collection, Report};

    #[cfg(feature = "report-blocking")]
    fn col(usage_page: Option<u16>, usage: Option<u16>, input_ids: &[u8]) -> Collection {
        Collection {
            collection_type: 1, // Application
            usage_page,
            usage,
            children: vec![],
            input_reports: input_ids
                .iter()
                .map(|&report_id| Report {
                    report_id,
                    items: vec![],
                })
                .collect(),
            output_reports: vec![],
            feature_reports: vec![],
        }
    }

    #[cfg(feature = "report-blocking")]
    fn device_info(collections: Vec<Collection>) -> DeviceInfo {
        DeviceInfo {
            vendor_id: 0x1234,
            product_id: 0x5678,
            product_name: String::new(),
            manufacturer: None,
            serial_number: None,
            usage_page: None,
            usage: None,
            device_id: 1,
            collections,
            max_input_report_size: 64,
        }
    }

    fn test_token(seed: u8) -> String {
        hex::encode([seed; 16])
    }
    fn test_nonce(seed: u8) -> String {
        hex::encode([seed; 16])
    }

    #[test]
    fn test_associations_any_protected_rule_only() {
        let rules = blocklist::blocklist_rules();
        // FIDO usage page is always blocked at the report level.
        let all_blocked = vec![(Some(0xF1D0), None, true), (Some(0xF1D0), None, true)];
        assert!(associations_any_protected(
            rules,
            0x1234,
            0x5678,
            &all_blocked,
            0x01,
            ReportType::Input
        ));
        // ANY blocked association blocks the report, even if another (Generic
        // Desktop / Joystick) is unblocked: the shared report may carry the
        // blocked collection's data.
        let mixed = vec![(Some(0xF1D0), None, true), (Some(0x0001), Some(0x0004), true)];
        assert!(associations_any_protected(
            rules,
            0x1234,
            0x5678,
            &mixed,
            0x01,
            ReportType::Input
        ));
        // No association matches -> not blocked.
        let none_match = vec![
            (Some(0x0001), Some(0x0004), true),
            (Some(0x0001), Some(0x0005), true),
        ];
        assert!(!associations_any_protected(
            rules,
            0x1234,
            0x5678,
            &none_match,
            0x01,
            ReportType::Input
        ));
        // No associations -> no blocking.
        assert!(!associations_any_protected(
            rules,
            0x1234,
            0x5678,
            &[],
            0x01,
            ReportType::Input
        ));
    }

    #[cfg(feature = "report-blocking")]
    #[test]
    fn test_associations_any_protected_always_protected() {
        let rules = blocklist::blocklist_rules();
        // Usage page 0x07 (Keyboard/Keypad page) is always protected for
        // every report type.
        assert!(associations_any_protected(
            rules,
            0x1234,
            0x5678,
            &[(Some(0x0007), None, true)],
            0x01,
            ReportType::Input
        ));
        assert!(associations_any_protected(
            rules,
            0x1234,
            0x5678,
            &[(Some(0x0007), None, true)],
            0x01,
            ReportType::Feature
        ));
        // Generic Desktop Pointer is always protected for input/output but
        // not feature.
        assert!(associations_any_protected(
            rules,
            0x1234,
            0x5678,
            &[(Some(0x0001), Some(0x0001), true)],
            0x01,
            ReportType::Input
        ));
        assert!(associations_any_protected(
            rules,
            0x1234,
            0x5678,
            &[(Some(0x0001), Some(0x0001), true)],
            0x01,
            ReportType::Output
        ));
        assert!(!associations_any_protected(
            rules,
            0x1234,
            0x5678,
            &[(Some(0x0001), Some(0x0001), true)],
            0x01,
            ReportType::Feature
        ));
        // Always-protected requires an Application collection: a Pointer
        // usage on a Physical child is not enough on its own.
        assert!(!associations_any_protected(
            rules,
            0x1234,
            0x5678,
            &[(Some(0x0001), Some(0x0001), false)],
            0x01,
            ReportType::Input
        ));
        // System Control range 0x80-0x8f and 0xa0-0xb6 are always protected;
        // the gap 0x90-0x9f is not.
        assert!(associations_any_protected(
            rules,
            0x1234,
            0x5678,
            &[(Some(0x0001), Some(0x0085), true)],
            0x01,
            ReportType::Feature
        ));
        assert!(associations_any_protected(
            rules,
            0x1234,
            0x5678,
            &[(Some(0x0001), Some(0x00b6), true)],
            0x01,
            ReportType::Input
        ));
        assert!(!associations_any_protected(
            rules,
            0x1234,
            0x5678,
            &[(Some(0x0001), Some(0x0095), true)],
            0x01,
            ReportType::Input
        ));
        // Non-Generic-Desktop pages are not always protected.
        assert!(!associations_any_protected(
            rules,
            0x1234,
            0x5678,
            &[(Some(0x0002), Some(0x0006), true)],
            0x01,
            ReportType::Input
        ));
    }

    #[cfg(feature = "report-blocking")]
    #[test]
    fn test_compute_blocked_input_ids_any_association_blocks() {
        // Keyboard (blocked) + Joystick (not blocked) share unnumbered id 0:
        // the keyboard association still blocks the shared report, matching
        // Chromium's union of protected report IDs.
        let info = device_info(vec![
            col(Some(0x0001), Some(0x0006), &[0]), // Keyboard
            col(Some(0x0001), Some(0x0004), &[0]), // Joystick
        ]);
        let map = build_report_collection_map(&info);
        assert_eq!(compute_blocked_input_ids(&info, &map), HashSet::from([0]));

        // Keyboard + Mouse share id 0, both blocked -> dropped.
        let info = device_info(vec![
            col(Some(0x0001), Some(0x0006), &[0]), // Keyboard
            col(Some(0x0001), Some(0x0002), &[0]), // Mouse
        ]);
        let map = build_report_collection_map(&info);
        assert_eq!(compute_blocked_input_ids(&info, &map), HashSet::from([0]));

        // Single blocked association still blocks.
        let info = device_info(vec![col(Some(0x0001), Some(0x0006), &[0])]);
        let map = build_report_collection_map(&info);
        assert_eq!(compute_blocked_input_ids(&info, &map), HashSet::from([0]));

        // Id 0 is keyboard-only, id 1 is keyboard + joystick: both blocked,
        // because the keyboard declares both.
        let info = device_info(vec![
            col(Some(0x0001), Some(0x0006), &[0, 1]), // Keyboard
            col(Some(0x0001), Some(0x0004), &[1]),    // Joystick
        ]);
        let map = build_report_collection_map(&info);
        assert_eq!(compute_blocked_input_ids(&info, &map), HashSet::from([0, 1]));

        // Nothing matches the rules -> nothing blocked.
        let info = device_info(vec![col(Some(0x0001), Some(0x0004), &[0])]); // Joystick
        let map = build_report_collection_map(&info);
        assert!(compute_blocked_input_ids(&info, &map).is_empty());
    }

    #[cfg(feature = "report-blocking")]
    #[test]
    fn test_e2e_fixtures_unblocked_with_report_blocking() {
        // The e2e harness builds the daemon with default features (now
        // including report-blocking); vendor.bin and gamepad.bin must stay
        // fully usable. Regression guard for the default-features flip.
        let read_fixture = |file: &str| -> DeviceInfo {
            let path = concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../tests/fixtures/descriptors/"
            );
            let bytes = std::fs::read(format!("{path}{file}"))
                .unwrap_or_else(|e| panic!("{file}: {e}"));
            let info = DeviceInfo {
                vendor_id: 0x16c0,
                product_id: 0x0001,
                product_name: String::new(),
                manufacturer: None,
                serial_number: None,
                usage_page: None,
                usage: None,
                device_id: 1,
                collections: crate::descriptor::parse_report_descriptor(&bytes),
                max_input_report_size: 0,
            };
            assert!(
                !info.collections.is_empty(),
                "{file}: descriptor failed to parse"
            );
            info
        };
        // vendor.bin and gamepad.bin carry no protected usages and must stay
        // fully usable. Regression guard for the default-features flip.
        for file in ["vendor.bin", "gamepad.bin"] {
            let info = read_fixture(file);
            let map = build_report_collection_map(&info);
            let blocked = compute_blocked_input_ids(&info, &map);
            assert!(
                blocked.is_empty(),
                "{file}: e2e fixture unexpectedly blocked input reports {blocked:?}"
            );
        }
        // mouse.bin and keyboard.bin are consumer-input fixtures: their
        // reports must be blocked with the feature on, matching Chromium
        // (mouse reports sit in a Physical child but propagate to the Mouse
        // Application ancestor).
        for file in ["mouse.bin", "keyboard.bin"] {
            let info = read_fixture(file);
            let map = build_report_collection_map(&info);
            let blocked = compute_blocked_input_ids(&info, &map);
            assert!(
                !blocked.is_empty(),
                "{file}: consumer-input fixture unexpectedly unblocked"
            );
        }
    }

    #[cfg(feature = "report-blocking")]
    #[test]
    fn test_interface_protected_fallback() {
        // Unparseable/empty descriptor with a protected hidapi interface
        // usage (e.g. a boot-keyboard interface): every report is blocked.
        let boot_kb = DeviceInfo {
            usage_page: Some(0x0001),
            usage: Some(0x0006),
            ..device_info(vec![])
        };
        assert!(interface_protected(&boot_kb, ReportType::Input));
        assert!(interface_protected(&boot_kb, ReportType::Output));

        let boot_mouse = DeviceInfo {
            usage_page: Some(0x0001),
            usage: Some(0x0002),
            ..device_info(vec![])
        };
        assert!(interface_protected(&boot_mouse, ReportType::Input));
        // Mouse feature reports are also blocked: the WICG Mouse rule carries
        // no reportType, so it matches feature reports too, exactly like
        // Chromium's GetProtectedReportIds for kReportTypeFeature.
        assert!(interface_protected(&boot_mouse, ReportType::Feature));

        // Vendor interface usage: never protected.
        let vendor = DeviceInfo {
            usage_page: Some(0xFF00),
            usage: Some(0x0001),
            ..device_info(vec![])
        };
        assert!(!interface_protected(&vendor, ReportType::Input));
        assert!(!interface_protected(&vendor, ReportType::Output));
        assert!(!interface_protected(&vendor, ReportType::Feature));

        // Parsed devices never take the interface path, even when their
        // top-level usage matches a rule (the report map handles them).
        let parsed = device_info(vec![col(Some(0x0001), Some(0x0006), &[0])]);
        assert!(!interface_protected(&parsed, ReportType::Input));
    }

    #[cfg(feature = "report-blocking")]
    #[test]
    fn test_always_protected_fallback() {
        // Chromium's HasAlwaysProtectedCollection fallback: a keyboard
        // top-level protects input/output (not feature); vendor-only devices
        // have no always-protected collection.
        let kb = device_info(vec![col(Some(0x0001), Some(0x0006), &[0])]);
        assert!(has_always_protected_collection(&kb, ReportType::Input));
        assert!(has_always_protected_collection(&kb, ReportType::Output));
        assert!(!has_always_protected_collection(&kb, ReportType::Feature));

        let mouse = device_info(vec![col(Some(0x0001), Some(0x0002), &[0])]);
        assert!(has_always_protected_collection(&mouse, ReportType::Input));
        assert!(!has_always_protected_collection(&mouse, ReportType::Feature));

        let vendor = device_info(vec![col(Some(0xFF00), Some(0x0001), &[1])]);
        assert!(!has_always_protected_collection(&vendor, ReportType::Input));
        assert!(!has_always_protected_collection(&vendor, ReportType::Output));
        assert!(!has_always_protected_collection(&vendor, ReportType::Feature));
    }

    #[cfg(feature = "report-blocking")]
    #[test]
    fn test_compute_blocked_input_ids_nested_collections() {
        // A Keyboard nested as a child of a vendor top-level is walked
        // recursively (Chromium's kWebHidRecursiveFiltering, enabled by
        // default): its report is blocked.
        let nested_kb = col(Some(0x0001), Some(0x0006), &[1]); // Keyboard
        let mut vendor = col(Some(0xFF00), Some(0x0001), &[]); // Vendor top-level
        vendor.children = vec![nested_kb];
        let info = device_info(vec![vendor]);
        let map = build_report_collection_map(&info);
        assert_eq!(compute_blocked_input_ids(&info, &map), HashSet::from([1]));

        // A Mouse pointer report attached to a Physical child is still
        // blocked: Chromium propagates the report to all ancestor collections
        // (hid_collection.cc), so the Mouse Application top-level (0x01/0x02)
        // carries it and matches the Mouse rule.
        let mut phys = col(Some(0x0009), Some(0x0001), &[3]); // Physical/Pointer
        phys.collection_type = 0;
        let mut mouse = col(Some(0x0001), Some(0x0002), &[]); // Mouse top-level
        mouse.children = vec![phys];
        let info = device_info(vec![mouse]);
        let map = build_report_collection_map(&info);
        assert_eq!(compute_blocked_input_ids(&info, &map), HashSet::from([3]));

        // A Pointer-usage Physical child under a VENDOR top-level stays
        // unblocked: neither the vendor Application nor the non-Application
        // Pointer child is protected (no rule matches, always-protected
        // requires an Application collection).
        let mut phys = col(Some(0x0001), Some(0x0001), &[3]); // Physical/Pointer
        phys.collection_type = 0;
        let mut vendor = col(Some(0xFF00), Some(0x0001), &[]); // Vendor top-level
        vendor.children = vec![phys];
        let info = device_info(vec![vendor]);
        let map = build_report_collection_map(&info);
        assert!(compute_blocked_input_ids(&info, &map).is_empty());
    }

    #[test]
    fn test_has_nm_session_no_device() {
        let (tx, _) = broadcast::channel(16);
        let mgr = DeviceManager::new(tx);
        assert!(!mgr.has_nm_session(0xDEADBEEF));
        assert!(!mgr.has_nm_session(0x1234));
    }

    #[test]
    fn test_close_all_devices_no_devices() {
        let (tx, _) = broadcast::channel(16);
        let mgr = DeviceManager::new(tx);
        mgr.close_all_devices();
    }

    #[test]
    fn test_get_device_by_ws_auth_empty() {
        let (tx, _) = broadcast::channel(16);
        let mgr = DeviceManager::new(tx);
        assert!(mgr.get_device_by_ws_auth("anyhash").is_none());
    }

    #[test]
    fn test_ws_nonce_is_32_hex_chars() {
        let (tx, _) = broadcast::channel(16);
        let mgr = DeviceManager::new(tx);
        let nonce = mgr.ws_nonce();
        assert_eq!(nonce.len(), 32);
        assert!(nonce.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_compute_ws_auth_hash_is_64_hex_chars() {
        let hash = compute_ws_auth_hash(&test_token(0xa1), &test_nonce(0x01));
        assert_eq!(hash.len(), 64);
        assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_compute_ws_auth_hash_deterministic() {
        let token = test_token(0xa1);
        let nonce = test_nonce(0x01);
        let h1 = compute_ws_auth_hash(&token, &nonce);
        let h2 = compute_ws_auth_hash(&token, &nonce);
        assert_eq!(h1, h2);
    }

    #[test]
    fn test_compute_ws_auth_hash_differs_on_token() {
        let nonce = test_nonce(0x01);
        let h1 = compute_ws_auth_hash(&test_token(0xa1), &nonce);
        let h2 = compute_ws_auth_hash(&test_token(0xb1), &nonce);
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_compute_ws_auth_hash_differs_on_nonce() {
        let token = test_token(0xa1);
        let h1 = compute_ws_auth_hash(&token, &test_nonce(0x01));
        let h2 = compute_ws_auth_hash(&token, &test_nonce(0x02));
        assert_ne!(h1, h2);
    }
}
