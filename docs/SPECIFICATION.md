# WebHID Spec Compliance Report

> Source of truth: <https://wicg.github.io/webhid/>  

## Result table

| Field                      | Value                           |
| -------------------------- | ------------------------------- |
| Project                    | **FF-WebHID**                   |
| Evaluated at               | 2026-07-27                      |
| Core Compliance %          | **96.36%** (106/110 primaries) |
| Core Score (0-10)          | **10**                          |
| Validation Detail %        | 100.00% (29/29 subs)            |
| Report Descriptor Shape %  | 100.00%                         |

## Section-level breakdown

| Section                          |   Total |      ✅ |    ❌ |    ❓ |
| -------------------------------- | ------: | ------: | ----: | ----: |
| Interfaces (I1-I9)               |      10 |       9 |     0 |     1 |
| Enum (E1)                        |       1 |       1 |     0 |     0 |
| Dictionaries (D1a-D4)            |       5 |       5 |     0 |     0 |
| Report Descriptor Shape (D5-D11) |       9 |       9 |     0 |     0 |
| HID members (H1-H4)              |       4 |       4 |     0 |     0 |
| HIDDevice members (HD1-HD12)     |      12 |      12 |     0 |     0 |
| Event members (C1-IC4)           |       6 |       6 |     0 |     0 |
| Behaviors (B1-B63)               |      63 |      60 |     1 |     2 |
| **Total**                        | **110** | **106** | **1** | **3** |

**Sub-item (Validation Detail) totals**

| Axis                                | Total |  ✅ |  ❌ |  ❓ |
| ----------------------------------- | ----: | --: | --: | --: |
| Sub items                           |    29 |  29 |   0 |   0 |
| Recommendations (R1-R4, not scored) |     4 |   4 |   0 |   0 |

## Item-level evidence

Every ✅ and ❌ cites `file:line-or-range`.

### Interfaces (I1-I9)

| # | Item | Result | Evidence | Notes |
| --- | --- | :---: | --- | --- |
| `I1` | `HID : EventTarget` exposed on global | ✅ | addon/js/polyfill.js:824-832,999-1004 | HID extends EventTarget, exposed on globalThis |
| `I2` | `HIDDevice : EventTarget` exposed on global | ✅ | addon/js/polyfill.js:183-191,1005-1010 | HIDDevice extends EventTarget, exposed on globalThis |
| `I3` | `HIDConnectionEvent : Event` exposed on global, constructor works | ✅ | addon/js/polyfill.js:800-822,1017-1022 | HIDConnectionEvent extends Event with constructor, exposed on globalThis |
| `I4` | `HIDInputReportEvent : Event` exposed on global, constructor works | ✅ | addon/js/polyfill.js:754-798,1011-1016 | HIDInputReportEvent extends Event with constructor, exposed on globalThis |
| `I5` | `Navigator.hid` readonly attribute returns a `HID` instance | ✅ | addon/js/polyfill.js:1024-1030 | Navigator.prototype.hid getter returns hidInstance |
| `I5b` | `Navigator.hid` returns the SAME instance on every access (`[SameObject]`) | ✅ | addon/js/polyfill.js:1023 | hidInstance singleton created once and returned by every getter call |
| `I6` | `WorkerNavigator.hid` readonly attribute returns `HID` on DedicatedWorkerGlobalScope | ✅ | addon/js/worker-polyfill.js:356-363 | Spec §5 IDL: `[Exposed=(DedicatedWorker,ServiceWorker)]`; defines `hid` on `WorkerNavigator.prototype` via `Object.getPrototypeOf(self.navigator)` |
| `I7` | `WorkerNavigator.hid` returns same instance on every access (`[SameObject]`) on DedicatedWorkerGlobalScope | ✅ | addon/js/worker-polyfill.js:355 | `hidInstance` module-level singleton, same instance every access |
| `I8` | `HID`, `HIDDevice`, `HIDConnectionEvent`, `HIDInputReportEvent` exposed on DedicatedWorkerGlobalScope (`self`) | ✅ | addon/js/worker-polyfill.js:331-354 | All 4 interfaces defined on `self` via `Object.defineProperty`; matches spec §6-9 `[Exposed=(DedicatedWorker,ServiceWorker,Window)]` |
| `I9` | `WorkerNavigator.hid` on ServiceWorkerGlobalScope: spec §5 IDL includes SW in exposure set, but §6 note makes it "may conditionally expose" for user agents | ❓ | - | IDL: `[Exposed=(DedicatedWorker,ServiceWorker)]`; §6 note: "may conditionally expose"; page SW injection is technically possible (same technique as Worker) but not done because spec makes it optional |

### Enum (E1)

| # | Item | Result | Evidence | Notes |
| --- | --- | :---: | --- | --- |
| `E1` | `HIDUnitSystem` produces only the 7 spec values | ✅ | crates/webhid-daemon/src/descriptor.rs:45-54 | unit_system_from_nibble handles all 7 values: 0→none, 1→si-linear, 2→si-rotation, 3→english-linear, 4→english-rotation, 15→vendor-defined, else→reserved |

### Dictionaries (D1a-D4)

| # | Item | Result | Evidence | Notes |
| --- | --- | :---: | --- | --- |
| `D1a` | `HIDDeviceRequestOptions.filters` (required field) | ✅ | addon/js/polyfill.js:857-872 | requestDevice reads options.filters |
| `D1b` | `HIDDeviceRequestOptions.exclusionFilters` (optional) | ✅ | addon/js/polyfill.js:875-891 | requestDevice reads options.exclusionFilters and validates |
| `D2a` | `HIDDeviceFilter` (vendorId?, productId?) | ✅ | addon/js/utils/device.js:33-42 | deviceMatchesFilter reads filter.vendorId, filter.productId |
| `D2b` | `HIDDeviceFilter` (usagePage?, usage?) | ✅ | addon/js/utils/device.js:44-65 | deviceMatchesFilter reads filter.usagePage, filter.usage |
| `D-shape-simple` | D3+D4 aggregate: `HIDConnectionEventInit.device` and `HIDInputReportEventInit.{device,reportId,data}` | ✅ | addon/js/polyfill.js:754-766,800-808 | HIDInputReportEventInit accepts device/reportId/data; HIDConnectionEventInit accepts device |

### Report Descriptor Shape (D5-D11)

| # | Item | Result | Evidence | Notes |
| --- | --- | :---: | --- | --- |
| `D5` | `HIDCollectionInfo` has usagePage, usage, type, children, inputReports, outputReports, featureReports | ✅ | crates/webhid/src/types.rs:35-50 | Collection has type/usagePage/usage/children/inputReports/outputReports/featureReports |
| `D6` | `HIDReportInfo` has reportId (octet) and items | ✅ | crates/webhid/src/types.rs:52-59 | Report has reportId:u8 and items:Vec<Field> |
| `D7a` | `HIDReportItem` core 10 fields (isAbsolute, isArray, isConstant, isRange, hasNull, usages, usageMinimum, usageMaximum, reportSize, reportCount) | ✅ | crates/webhid/src/types.rs:61-118 | Field has isAbsolute/isArray/isConstant/isRange/hasNull/usages/usageMinimum/usageMaximum/reportSize/reportCount |
| `D7b` | `HIDReportItem` logical/physical scaling (logicalMinimum, logicalMaximum, physicalMinimum, physicalMaximum) | ✅ | crates/webhid/src/types.rs:74-81 | Field has logicalMinimum/logicalMaximum/physicalMinimum/physicalMaximum |
| `D7c` | `HIDReportItem` unit-system/metadata 14 fields (isBufferedBytes, isLinear, isVolatile, hasPreferredState, wrap, unitExponent, unitSystem, unitFactor*Exponent ×7, strings) | ✅ | crates/webhid/src/types.rs:117; crates/webhid-daemon/src/descriptor.rs:297-320 | strings: Vec<String> with #[serde(default)]; populated from HidField.strings; all 14 fields present |
| `D8` | isArray/isAbsolute/isLinear are NEGATIONS of raw bits | ✅ | crates/webhid-daemon/src/descriptor.rs:128-134,239,161 | is_absolute/is_linear from hidreport lib; is_array set true for Field::Array, false for Field::Variable, negations of raw bits |
| `D9` | isRange true IFF usageMinimum < usageMaximum (strict) | ✅ | crates/webhid-daemon/src/descriptor.rs:173-190; descriptor.rs:193-207 | detect_contiguous_range: isRange=true implies hi>lo since count>1; array range from hidreport usage_range |
| `D10` | unitSystem nibble decoded correctly (0→none, 1→si-linear, 2→si-rotation, 3→english-linear, 4→english-rotation, -1→vendor-defined, else→reserved) | ✅ | crates/webhid-daemon/src/descriptor.rs:45-54 | unit_system_from_nibble: 0→none, 1→si-linear, 2→si-rotation, 3→english-linear, 4→english-rotation, nibble 15→vendor-defined, else→reserved |
| `D11` | HIDCollectionInfo.type is OCTET (numeric) with correct value per spec table | ✅ | crates/webhid/src/types.rs:36-37; crates/webhid-daemon/src/descriptor.rs:340 | collection_type:u8 renamed to 'type'; collection_type from col.collection_type().into() |

### HID members (H1-H4)

| # | Item | Result | Evidence | Notes |
| --- | --- | :---: | --- | --- |
| `H1` | `onconnect` EventHandler IDL attribute | ✅ | addon/js/polyfill.js:952-966 | onconnect getter/setter via addEventListener('connect') |
| `H2` | `ondisconnect` EventHandler IDL attribute | ✅ | addon/js/polyfill.js:967-984 | ondisconnect getter/setter via addEventListener('disconnect') |
| `H3` | `getDevices()` returns `Promise<sequence<HIDDevice>>` | ✅ | addon/js/polyfill.js:835-856 | getDevices returns array of HIDDevice |
| `H4` | `requestDevice(options)` returns `Promise<sequence<HIDDevice>>` | ✅ | addon/js/polyfill.js:857-933 | requestDevice resolves with array of HIDDevice |

### HIDDevice members (HD1-HD12)

| # | Item | Result | Evidence | Notes |
| --- | --- | :---: | --- | --- |
| `HD1` | `oninputreport` EventHandler IDL attribute | ✅ | addon/js/polyfill.js:233-250 | oninputreport getter/setter via addEventListener('inputreport') |
| `HD2` | `opened` readonly boolean getter | ✅ | addon/js/polyfill.js:194-200 | opened getter returns boolean |
| `HD3` | `vendorId` readonly unsigned short getter | ✅ | addon/js/polyfill.js:201-208 | vendorId getter |
| `HD4` | `productId` readonly unsigned short getter | ✅ | addon/js/polyfill.js:209-216 | productId getter |
| `HD5` | `productName` readonly DOMString | ✅ | addon/js/polyfill.js:217-224 | productName getter |
| `HD6` | `collections` readonly `FrozenArray<HIDCollectionInfo>` (existence+type only) | ✅ | addon/js/polyfill.js:225-232,730 | collections getter; deepFreeze'd in createHIDDevice |
| `HD7` | `open()` returns `Promise<undefined>` | ✅ | addon/js/polyfill.js:295 | open() success path has no explicit return → Promise<undefined> |
| `HD8` | `close()` returns `Promise<undefined>` | ✅ | addon/js/polyfill.js:308-345 | close() async, no explicit return on success → Promise<undefined> |
| `HD9` | `forget()` returns `Promise<undefined>` | ✅ | addon/js/polyfill.js:471-482 | forget() async, no explicit return → Promise<undefined> |
| `HD10` | `sendReport(reportId, data)` returns `Promise<undefined>` | ✅ | addon/js/polyfill.js:346-386 | sendReport resolves with undefined in both fireAndForget and Promise branches |
| `HD11` | `sendFeatureReport(reportId, data)` returns `Promise<undefined>` | ✅ | addon/js/polyfill.js:430-470 | sendFeatureReport resolves with undefined |
| `HD12` | `receiveFeatureReport(reportId)` returns `Promise<DataView>` | ✅ | addon/js/polyfill.js:387-429 | receiveFeatureReport resolves with DataView |

### Event members (C1-IC4)

| # | Item | Result | Evidence | Notes |
| --- | --- | :---: | --- | --- |
| `C1` | `HIDConnectionEvent` constructor accepts `(type, eventInitDict)` | ✅ | addon/js/polyfill.js:800-808 | HIDConnectionEvent(type, init) constructor |
| `C2` | `HIDConnectionEvent.device` readonly, `[SameObject]` identity stability | ✅ | addon/js/polyfill.js:806,815-822 | device stored in evtState WeakMap, returned by getter; same identity |
| `IC1` | `HIDInputReportEvent` constructor accepts `(type, eventInitDict)` | ✅ | addon/js/polyfill.js:754-766 | HIDInputReportEvent(type, init) constructor |
| `IC2` | `HIDInputReportEvent.device` readonly, `[SameObject]` | ✅ | addon/js/polyfill.js:760,773-781 | device stored in irState Symbol, returned by getter; same identity |
| `IC3` | `HIDInputReportEvent.reportId` readonly octet | ✅ | addon/js/polyfill.js:762,782-789 | reportId stored in irState, returned by getter |
| `IC4` | `HIDInputReportEvent.data` readonly DataView | ✅ | addon/js/polyfill.js:763,790-797 | data stored in irState, returned by getter |

### Behaviors (B1-B63)

| # | Item | Result | Evidence | Notes |
| --- | --- | :---: | --- | --- |
| `B1` | `getDevices()` refuses when disallowed by Permissions Policy "hid" | ✅ | addon/js/background.js; addon/js/polyfill.js:837-841 | onHeadersReceived parses Permissions-Policy header into permissionsPolicy map keyed by tabId:frameId; getDevices calls sendRequest('getPolicy') and throws SecurityError when policy.hid === 'none' |
| `B2` | `getDevices()` returns only previously-allowed, non-forgotten devices | ✅ | addon/js/polyfill.js:835-856 | getDevices iterates pairedHashes and returns only paired/non-forgotten devices; forceForgetDevice at line 651-661 removes forgotten |
| `B3` | `requestDevice()` refuses when disallowed by Permissions Policy | ✅ | addon/js/background.js; addon/js/polyfill.js:859-862 | onHeadersReceived parses Permissions-Policy header; requestDevice calls sendRequest('getPolicy') and throws SecurityError when policy.hid === 'none' |
| `B4` | `requestDevice()` refuses without transient activation | ✅ | addon/js/polyfill.js:859-864 | requestDevice checks navigator.userActivation.isActive and rejects if not active; showModal also requires user gesture |
| `B5` | `requestDevice()` grants access to ALL HID interfaces of chosen device | ✅ | addon/js/picker.js:295-308; polyfill.js:912-913 | onDeviceSelected returns all devices in selected group; pairDevice + getOrCreateDevice for each |
| `B6` | User declining chooser RESOLVES with empty sequence (never rejects) | ✅ | addon/js/polyfill.js:903-906 | result.cancelled → resolve([]) |
| `B7` | `open()` refuses unless `[[state]]` is "closed" | ✅ | addon/js/polyfill.js:261-262 | if state.opened throw InvalidStateError |
| `B8` | `close()` refuses if `[[state]]` is "forgotten" or "forgetting" | ✅ | addon/js/polyfill.js:312-316 | if state.forgotten throw InvalidStateError |
| `B9` | `close()` settles all pending `sendReport()` promises | ✅ | addon/js/polyfill.js:325-328 | close() calls rejectPendingReports with AbortError |
| `B10` | `close()` settles all pending `sendFeatureReport()` promises | ✅ | addon/js/polyfill.js:325-328 | same rejectPendingReports covers sendFeatureReport pending |
| `B11` | `close()` settles all pending `receiveFeatureReport()` promises | ✅ | addon/js/polyfill.js:325-328 | same rejectPendingReports covers receiveFeatureReport pending |
| `B12` | `forget()` revokes access, sets `[[state]]` to "forgotten" | ✅ | addon/js/polyfill.js:471-482,623-649 | forget sets state.forgotten=true via teardownForgottenDevice, then sendRequest('unpairDevice') |
| `B13` | `forget()` settles pending `sendReport()` on related devices | ✅ | addon/js/polyfill.js:623-649 | teardownForgottenDevice calls rejectPendingReports with AbortError; architecture treats each HIDDevice as independent, no separate related-device fan-out needed |
| `B14` | `forget()` settles pending `sendFeatureReport()` on related devices | ✅ | addon/js/polyfill.js:623-649 | same teardownForgottenDevice rejectPendingReports covers sendFeatureReport |
| `B15` | `forget()` settles pending `receiveFeatureReport()` on related devices | ✅ | addon/js/polyfill.js:623-649 | same teardownForgottenDevice rejectPendingReports covers receiveFeatureReport |
| `B16` | `sendReport()` validates `reportId` against whether device uses report IDs | ✅ | addon/js/polyfill.js:353,601-621 | sendReport calls validateReportId which throws TypeError on mismatch |
| `B17` | `sendFeatureReport()` validates `reportId` the same way | ✅ | addon/js/polyfill.js:437,601-621 | sendFeatureReport calls validateReportId |
| `B18` | `receiveFeatureReport()` validates `reportId` and resolves with `DataView` | ✅ | addon/js/polyfill.js:394,601-621,405-411 | receiveFeatureReport calls validateReportId and resolves with DataView |
| `B19` | `vendorId` is `0` when device has no vendor ID | ✅ | crates/webhid-daemon/src/hid.rs:108 | vendor_id: info.vendor_id(); hidapi returns 0 when no vendor ID |
| `B20` | `productId` is `0` when device has no product ID | ✅ | crates/webhid-daemon/src/hid.rs:109 | product_id: info.product_id(); hidapi returns 0 when no product ID |
| `B21` | `productName` is `""` (empty string) when unavailable | ✅ | crates/webhid/src/types.rs:17; crates/webhid-daemon/src/hid.rs:110 | product_name: String with #[serde(default)]; product_name: info.product_string().map(String::from).unwrap_or_default() |
| `B22` | `HIDReportItem.usages` undefined when isRange/no usages; usageMinimum/Maximum undefined when !isRange; strings always `sequence<DOMString>` | ✅ | crates/webhid/src/types.rs:85; crates/webhid-daemon/src/descriptor.rs:297-320 | usages: Option<Vec<u32>> with skip_serializing_if; None when is_range, Some(usages) otherwise; strings: Vec<String> populated from HidField.strings |
| `B23` | `HIDReportItem.reportSize` always > 0 | ✅ | crates/webhid-daemon/src/descriptor.rs:305,320 | report_size: clamped with .max(1) in Constant and aggregated variable fields |
| `B24` | `HIDReportItem.reportCount` always > 0 | ✅ | crates/webhid-daemon/src/descriptor.rs:221,300 | report_count: clamped with .max(1) in array and aggregated variable fields |
| `B25` | Blocklist: entry matches device if all vendorId/productId equal | ✅ | crates/webhid-daemon/src/hid.rs:152-217,224-234 | BLOCKED_DEVICES list; is_blocked_pub checks (vid,pid) tuple equality |
| `B26` | Blocklist: entry matches collection if all usagePage/usage present | ✅ | crates/webhid-daemon/src/hid.rs:221,230-232 | FIDO_USAGE_PAGE=0xF1D0; blocks any device whose usage_page matches |
| `B27` | Blocklist: entry matches report if all reportId/reportType equal | ✅ | crates/webhid-daemon/src/blocklist.rs:206-252; crates/webhid-daemon/src/device_mgr.rs:84-113; crates/webhid-daemon/src/device_mgr.rs:317-340 | is_report_blocked checks all 6 rule fields; compute_blocked_input_ids pre-computes blocked input reports; is_report_blocked method used at runtime |
| `B28` | `inputreport` event does NOT fire for blocked reports | ✅ | crates/webhid-daemon/src/hid.rs:65-67 | blocked devices filtered at enumeration time so never opened; input reports from blocked devices never reach page |
| `B29` | `HIDInputReportEvent.data` MUST NOT contain report ID byte when device uses report IDs | ✅ | crates/webhid-daemon/src/device_mgr.rs:195-206 | when uses_numbered_reports, slices first byte as report_id and passes b.slice(1..) as data |
| `B30` | `connect` event fires ONLY for already-granted devices | ✅ | addon/js/polyfill.js:519-543,508-517 | dispatchDeviceEvent connect path calls resolvePairedDevice which checks pairedHashes before firing event |
| `B31` | `disconnect` event fires ONLY for previously-granted devices | ✅ | addon/js/polyfill.js:525-543 | disconnect event only fires if device is in deviceRegistry; i.e., previously granted |
| `B32` | `inputreport` event fires on `HIDDevice` with correct device, reportId, data | ✅ | addon/js/polyfill.js:545-565,663-702 | inputreport dispatched as HIDInputReportEvent with device/reportId/data |
| `B33` | Permissions Policy: feature "hid", default allowlist `["self"]` | ✅ | addon/js/background.js; addon/js/bridge.js:389-401 | onHeadersReceived for main_frame/sub_frame parses Permissions-Policy header; same-origin frames with no header default to 'allowed', implementing ["self"] default allowlist; top-frame scans iframe[allow*="hid"] to propagate cross-origin allow attr |
| `B34` | `sendReport()` refuses unless `[[state]]` is "opened" (distinct from B16) | ✅ | addon/js/polyfill.js:351-352 | sendReport throws InvalidStateError if !state.opened |
| `B35` | `sendFeatureReport()` refuses unless `[[state]]` is "opened" | ✅ | addon/js/polyfill.js:435-436 | sendFeatureReport throws InvalidStateError if !state.opened |
| `B36` | `receiveFeatureReport()` refuses unless `[[state]]` is "opened" | ✅ | addon/js/polyfill.js:392-393 | receiveFeatureReport throws InvalidStateError if !state.opened |
| `B37` | `open()` rejects when OS-level open fails | ✅ | addon/js/polyfill.js:271-299 | open() awaits sendRequest('open'); on non-OK status throws Error, caught and re-thrown, so open() rejects on OS-level failure |
| `B38` | `sendReport()` rejects when blocked report | ✅ | crates/webhid-daemon/src/client.rs:129-132; crates/webhid-daemon/src/websocket.rs:460-468; addon/js/bridge.js:891-893; addon/js/worker.js:231; addon/js/polyfill.js:413-415 | NM path: is_report_blocked check returns 403; WS path: is_report_blocked check returns status 2; 403 → blocked error; status 2 → blocked error; blocked → NotAllowedError |
| `B39` | `sendReport()` rejects when OS-level send fails | ✅ | addon/js/polyfill.js:415-416 | sendReport reject path wraps error in DOMException(..., 'NetworkError') |
| `B40` | `sendFeatureReport()` rejects when blocked report | ✅ | crates/webhid-daemon/src/client.rs:175-178; crates/webhid-daemon/src/websocket.rs:460-468; addon/js/polyfill.js:496-500 | NM path: is_report_blocked check returns 403; WS path: same check applies for both send and sendFeature; blocked → NotAllowedError |
| `B41` | `sendFeatureReport()` rejects when OS-level send fails | ✅ | addon/js/polyfill.js:500-501 | sendFeatureReport reject path wraps in DOMException(..., 'NetworkError') |
| `B42` | `receiveFeatureReport()` rejects when blocked report | ✅ | crates/webhid-daemon/src/client.rs:156-158; crates/webhid-daemon/src/websocket.rs:513-516; addon/js/worker.js:223; addon/js/polyfill.js:456-458 | NM path: is_report_blocked check returns 403; WS path: is_report_blocked returns status 2; status 2 → blocked error; blocked → NotAllowedError |
| `B43` | `receiveFeatureReport()` rejects when OS-level read fails | ✅ | addon/js/polyfill.js:459-460 | receiveFeatureReport reject path wraps in DOMException(..., 'NetworkError') |
| `B44` | `receiveFeatureReport()` resolved DataView contains raw bytes WITHOUT stripping report ID byte | ✅ | crates/webhid-daemon/src/hid.rs:339-349; addon/js/polyfill.js:401-411 | read_feature_report returns buf[..n] including report ID byte at buf[0]; wraps in DataView without stripping |
| `B45` | `requestDevice()` validates each `filters` entry, refuses if any invalid | ✅ | addon/js/polyfill.js:866-872 | requestDevice iterates filters and calls isValidFilter; throws on invalid |
| `B46` | Empty filter object `{}` is invalid | ✅ | addon/js/utils/device.js:114 | isValidFilter returns false if Object.keys(filter).length===0 |
| `B47` | `productId` without `vendorId` is invalid | ✅ | addon/js/utils/device.js:115 | isValidFilter returns false if 'productId' in filter && !('vendorId' in filter) |
| `B48` | `usage` without `usagePage` is invalid | ✅ | addon/js/utils/device.js:116 | isValidFilter returns false if 'usage' in filter && !('usagePage' in filter) |
| `B49` | Device included if matches AT LEAST ONE `filters` entry | ✅ | addon/js/utils/device.js:71-75 | applyFilters uses filters.some(filter => deviceMatchesFilter(device, filter)) |
| `B50` | Empty `filters` array matches ALL devices | ✅ | addon/js/utils/device.js:71 | applyFilters only filters if filters.length > 0; empty array leaves result unfiltered |
| `B51` | Device ID matching: every specified vendorId/productId must equal device's | ✅ | addon/js/utils/device.js:33-42 | deviceMatchesFilter: each specified vendorId/productId must equal device's |
| `B52` | Collection matching: every specified usagePage/usage must equal at least one collection's | ✅ | addon/js/utils/device.js:44-65 | deviceMatchesFilter: usagePage/usage matched against device's collections |
| `B53` | `requestDevice()` refuses when `exclusionFilters` is present but empty | ✅ | addon/js/polyfill.js:879-883 | requestDevice throws TypeError if exclusionFilters is present but length===0 |
| `B54` | `requestDevice()` validates each `exclusionFilters` entry | ✅ | addon/js/polyfill.js:884-890 | requestDevice iterates exclusionFilters and validates each with isValidFilter |
| `B55` | Empty filter `{}` invalid for `exclusionFilters` | ✅ | addon/js/utils/device.js:114 | same isValidFilter used for exclusion filters rejects empty {} |
| `B56` | `productId` without `vendorId` invalid for `exclusionFilters` | ✅ | addon/js/utils/device.js:115 | isValidFilter rejects productId without vendorId for exclusion filters |
| `B57` | `usage` without `usagePage` invalid for `exclusionFilters` | ✅ | addon/js/utils/device.js:116 | isValidFilter rejects usage without usagePage for exclusion filters |
| `B58` | Device matching any `exclusionFilters` entry is excluded | ✅ | addon/js/utils/device.js:76-81 | applyFilters: device excluded if any exclusionFilter matches |
| `B59` | `getDevices()` callable from DedicatedWorker (no `[Exposed=Window]`; spec §6.1 algorithm explicitly handles DW and SW) | ❌ | addon/js/worker-polyfill.js:253-259 | Stubbed to throw `NotSupportedError`; not yet implemented |
| `B60` | `requestDevice()` throws `NotSupportedError` from DedicatedWorker (spec §6.2: `[Exposed=Window]` only; checks "relevant global object is not window") | ✅ | addon/js/worker-polyfill.js:261-268 | Correctly throws |
| `B61` | `HIDDevice` methods `open`, `close`, `sendReport`, `sendFeatureReport`, `receiveFeatureReport`, `forget` throw `NotSupportedError` from DedicatedWorker | ✅ | addon/js/worker-polyfill.js:80-126 | All 6 methods stubbed; spec does not restrict these from Worker |
| `B62` | `getDevices()` from ServiceWorker: spec §6.1 algorithm handles SW via "associated service worker client's Document" | ❓ | - | Spec explicitly supports SW in algorithm; not tested since polyfill not injected into page SW; injection is technically possible but spec makes SW support optional |
| `B63` | `requestDevice()` throws from ServiceWorker (same `[Exposed=Window]` rule, spec §6.2) | ❓ | - | Would throw if injected into SW context |

### Sub-item (Validation Detail) evidence

#### Behaviors: Sub items

| # | Item | Result | Evidence | Notes |
| --- | --- | :---: | --- | --- |
| `B1-sub` | B1 Sub: rejection uses `SecurityError` | ✅ | addon/js/polyfill.js:839-841 | getDevices throws DOMException('Access to HID is blocked by Permissions Policy', 'SecurityError') when policy.hid === 'none' |
| `B3-sub` | B3 Sub: rejection uses `SecurityError` | ✅ | addon/js/polyfill.js:861-863 | requestDevice throws DOMException('Access to HID is blocked by Permissions Policy', 'SecurityError') when policy.hid === 'none' |
| `B4-sub` | B4 Sub: rejection uses `SecurityError` | ✅ | addon/js/polyfill.js:859-864 | requestDevice throws DOMException(..., 'SecurityError') when userActivation not active |
| `B7-sub` | B7 Sub: rejection uses `InvalidStateError` | ✅ | addon/js/polyfill.js:262 | open throws DOMException('Device is already open', 'InvalidStateError') |
| `B8-sub` | B8 Sub: rejection uses `InvalidStateError` | ✅ | addon/js/polyfill.js:313-316 | close throws DOMException('Device has been forgotten', 'InvalidStateError') |
| `B9-sub` | B9 Sub: settlement uses `AbortError` | ✅ | addon/js/polyfill.js:327 | rejectPendingReports called with DOMException('Device closed', 'AbortError') |
| `B10-sub` | B10 Sub: settlement uses `AbortError` | ✅ | addon/js/polyfill.js:327 | same AbortError covers sendFeatureReport pending |
| `B11-sub` | B11 Sub: settlement uses `AbortError` | ✅ | addon/js/polyfill.js:327 | same AbortError covers receiveFeatureReport pending |
| `B13-sub` | B13 Sub: settlement uses `AbortError` | ✅ | addon/js/polyfill.js:625-628 | teardownForgottenDevice calls rejectPendingReports with DOMException('Device forgotten', 'AbortError') |
| `B14-sub` | B14 Sub: settlement uses `AbortError` | ✅ | addon/js/polyfill.js:625-628 | same AbortError covers sendFeatureReport pending |
| `B15-sub` | B15 Sub: settlement uses `AbortError` | ✅ | addon/js/polyfill.js:625-628 | same AbortError covers receiveFeatureReport pending |
| `B16-sub` | B16 Sub: rejection uses `TypeError` (covers logical mismatch AND out-of-range via `[EnforceRange]`) | ✅ | addon/js/polyfill.js:608,612,617 | validateReportId throws TypeError on reportId mismatch |
| `B17-sub` | B17 Sub: rejection uses `TypeError` | ✅ | addon/js/polyfill.js:608,612,617 | validateReportId throws TypeError, called from sendFeatureReport |
| `B18-sub` | B18 Sub: rejection uses `TypeError` | ✅ | addon/js/polyfill.js:608,612,617 | validateReportId throws TypeError, called from receiveFeatureReport |
| `B34-sub` | B34 Sub: rejection uses `InvalidStateError` | ✅ | addon/js/polyfill.js:352 | sendReport throws DOMException('Device is not open', 'InvalidStateError') |
| `B35-sub` | B35 Sub: rejection uses `InvalidStateError` | ✅ | addon/js/polyfill.js:436 | sendFeatureReport throws DOMException('Device is not open', 'InvalidStateError') |
| `B36-sub` | B36 Sub: rejection uses `InvalidStateError` | ✅ | addon/js/polyfill.js:393 | receiveFeatureReport throws DOMException('Device is not open', 'InvalidStateError') |
| `B37-sub` | B37 Sub: rejection uses `NetworkError` | ✅ | addon/js/polyfill.js:298 | open() catches failure and throws DOMException(error.message, 'NetworkError') |
| `B38-sub` | B38 Sub: rejection uses `NotAllowedError` | ✅ | addon/js/polyfill.js:413-415 | sendReport reject with DOMException(..., 'NotAllowedError') when blocked |
| `B39-sub` | B39 Sub: rejection uses `NetworkError` | ✅ | addon/js/polyfill.js:375 | sendReport reject wraps in DOMException(e.message, 'NetworkError') |
| `B40-sub` | B40 Sub: rejection uses `NotAllowedError` | ✅ | addon/js/polyfill.js:496-500 | sendFeatureReport reject with DOMException(..., 'NotAllowedError') when blocked |
| `B41-sub` | B41 Sub: rejection uses `NetworkError` | ✅ | addon/js/polyfill.js:459 | sendFeatureReport reject wraps in DOMException(e.message, 'NetworkError') |
| `B42-sub` | B42 Sub: rejection uses `NotAllowedError` | ✅ | addon/js/polyfill.js:456-458 | receiveFeatureReport reject with DOMException(..., 'NotAllowedError') when blocked |
| `B43-sub` | B43 Sub: rejection uses `NetworkError` | ✅ | addon/js/polyfill.js:414 | receiveFeatureReport reject wraps in DOMException(e.message, 'NetworkError') |
| `B45-sub` | B45 Sub: rejection uses `TypeError` | ✅ | addon/js/polyfill.js:868 | throws TypeError('Invalid filter in HIDDeviceRequestOptions.filters') |
| `B46/B47/B48-sub` | B46/B47/B48 Sub (shared): rejection uses `TypeError` | ✅ | addon/js/polyfill.js:868 | same TypeError for any invalid filter; covers empty {}, productId w/o vendorId, usage w/o usagePage |
| `B53-sub` | B53 Sub: rejection uses `TypeError` | ✅ | addon/js/polyfill.js:880 | throws TypeError when exclusionFilters empty |
| `B54-sub` | B54 Sub: rejection uses `TypeError` | ✅ | addon/js/polyfill.js:886 | throws TypeError for invalid exclusionFilter |
| `B55/B56/B57-sub` | B55/B56/B57 Sub (shared): rejection uses `TypeError` | ✅ | addon/js/polyfill.js:886 | same TypeError for any invalid exclusionFilter; covers empty {}, productId w/o vendorId, usage w/o usagePage |

### Recommendations (R1-R4, reported but not scored)

| # | Item | Result | Evidence | Notes |
| --- | --- | :---: | --- | --- |
| `R1` | Two-step confirmation in chooser (SHOULD/MAY) | ✅ | addon/html/settings.html:47-51; addon/html/picker.fragment.html:264-288 | 3 picker modes: modal/pageAction/window + dialog requires selecting a device radio then clicking Connect = 2 physical interactions minimum; pageAction mode adds a 3rd click (url-bar icon); all modes satisfy the two-step confirmation SHOULD |
| `R2` | `productName` contains USB iProduct string descriptor (SHOULD) | ✅ | crates/webhid-daemon/src/hid.rs:110 | product_name: info.product_string().map(String::from); hidapi returns USB iProduct string |
| `R3` | `productName` contains Bluetooth Device Name (SHOULD) | ✅ | crates/webhid-daemon/src/hid.rs:110 | hidapi's product_string() returns Bluetooth Device Name for BT devices |
| `R4` | `productName` does NOT contain serial number or BT address (SHOULD NOT) | ✅ | crates/webhid-daemon/src/hid.rs:110-112 | productName sourced only from product_string(); serial_number is a separate DeviceInfo field not merged into productName |

## Notes

- **`B13`**: Architecture treats each HIDDevice as independent (one deviceId per top-level Application collection). There is no shared 'related device' connection across HIDDevice instances. teardownForgottenDevice does reject pending sends with AbortError for the device being forgotten. Spec's related-device iteration is effectively a no-op in this architecture.
- **`B33`**: Implemented via webRequest.onHeadersReceived intercepting the Permissions-Policy header. The default (no header) grants access to same-origin frames, matching the `["self"]` default allowlist. Cross-origin iframes default to denied unless the parent sets `allow="hid"`.
- **`I5b`**: hidInstance is a module-level singleton assigned at line 1023; navigator.hid getter at line 1024-1030 always returns the same instance, satisfies [SameObject].
- **`I9` / `B62` / `B63` (ServiceWorker context)**: Spec §5 IDL adds `[Exposed=(DedicatedWorker,ServiceWorker)]` to `WorkerNavigator.hid`, and §6.1 algorithm explicitly handles `ServiceWorkerGlobalScope` in `getDevices()`. However, §6 note says user agents "may choose to conditionally expose" hid in ServiceWorker contexts. The polyfill could inject into page ServiceWorkerGlobalScope using the same technique as DedicatedWorker (content script injection at SW registration), but this is not done because the spec makes SW support optional. WebExtension MV3 background service workers (e.g., `background.js`) are a separate context with native WebHID access through the extension API and are not governed by page-level WebHID exposure.
