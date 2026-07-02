(function () {
  if (navigator.hid) return; // already installed

  let _reqId = 0;
  const _pending = {};

  // ── Device persistence helpers ────────────────────────────────────────────
  // Store and retrieve device permissions from addon storage (browser.storage.local)
  // Device permissions are stored per site origin on the addon side
  // Communication happens via sendRequest
  //
  // Device identification hash includes:
  // - vendor_id & product_id (USB IDs)
  // - serial_number (device serial, may be empty)
  // - path (device path, may be empty)
  // Hash is created from these fields to uniquely identify physical devices

  let _savedDevices = null;
  let _deviceInfoCache = null;

  /**
   * Creates a hash from device identifiers for effective unique device identification.
   * Uses vendor_id, product_id, serial_number, and path to create a stable identifier.
   * @param {Object} device - Device object with vendor_id, product_id, serial_number, path
   * @returns {string} Hex string hash
   */
  function createDeviceHash(device) {
    const vendorId = String(device.vendor_id || 0);
    const productId = String(device.product_id || 0);
    const serialNumber = String(device.serial_number || "");
    const deviceId = String(device.device_id || "");
    const identifier = vendorId + ":" + productId + ":" + serialNumber + ":" + deviceId;

    // Simple DJB2 hash algorithm
    let hash = 5381;
    for (let i = 0; i < identifier.length; i++) {
      hash = ((hash << 5) + hash) + identifier.charCodeAt(i);
      hash = hash & 0xFFFFFFFF; // Convert to 32-bit integer
    }

    // Convert to positive hex string
    return Math.abs(hash).toString(16);
  }

  async function getSavedDevices() {
    // Return cached hashes if available
    if (_savedDevices !== null) {
      return _savedDevices;
    }

    try {
      const result = await sendRequest(
        "getSavedDevices",
        { origin: window.location.origin },
      );
      _savedDevices = result.hashes || [];
      // Clear device cache so next getDevices() refreshes
      _deviceInfoCache = null;
      return _savedDevices;
    } catch (error) {
      return [];
    }
  }

  async function getDeviceCache() {
    if (_deviceInfoCache !== null) {
      return _deviceInfoCache;
    }

    try {
      const response = await sendRequest("enumerate");
      const devices = response.success && Array.isArray(response.devices) ? response.devices : [];
      _deviceInfoCache = new Map();
      for (const device of devices) {
        const hash = createDeviceHash(device);
        _deviceInfoCache.set(hash, device);
      }
      return _deviceInfoCache;
    } catch (error) {
      _deviceInfoCache = new Map();
      return _deviceInfoCache;
    }
  }

  async function getDeviceByHash(hash) {
    const cache = await getDeviceCache();
    return cache.get(hash) || null;
  }

  async function saveDevice(deviceInfo) {
    try {
      // Clear cache to force refresh
      _savedDevices = null;
      const deviceHash = createDeviceHash(deviceInfo);

      const result = await sendRequest(
        "saveDevice",
        {
          origin: window.location.origin,
          device: {
            hash: deviceHash,
          },
        }
      );

      if (result.success) {
        // Update cache with just the hashes array
        _savedDevices = result.hashes || [];
        // Clear device cache so next getDevices() refreshes
        _deviceInfoCache = null;
      }
    } catch (error) {

    }
  }

  async function deviceMatchesSaved(device) {
    const savedHashes = await getSavedDevices();
    const deviceHash = createDeviceHash(device);
    return savedHashes.includes(deviceHash);
  }

  // Listen for responses and events from the content script bridge.
  window.addEventListener("message", (event) => {
    if (!event.data) return;
    if (event.data.__webhid_bridge === "res") {
      const handler = _pending[event.data.id];
      if (handler) {
        delete _pending[event.data.id];
        handler(event.data.result);
      }
    }
  });

  function sendRequest(action, payload) {
    return new Promise((resolve) => {
      const id = ++_reqId;
      _pending[id] = resolve;
      window.postMessage(
        { __webhid_bridge: "req", id, action, payload: payload || {} },
        "*",
      );
    });
  }

  // ── Event classes ────────────────────────────────────────────────────────

  class HIDInputReportEvent extends Event {
    constructor(type, init) {
      super(type, init);
      this.device = init.device;
      this.reportId = init.reportId;
      this.data = init.data;
    }
  }

  class HIDConnectionEvent extends Event {
    constructor(type, device) {
      super(type);
      this.device = device;
    }
  }

  class HIDDeviceEvent extends Event {
    constructor(type, device) {
      super(type);
      this.device = device;
    }
  }

  // Very small, forgiving HID report-descriptor parser that extracts a
  // shallow collection tree (usage page / usage per Collection). This is
  // intentionally minimal: it looks for common opcodes (Usage Page = 0x05,
  // Usage = 0x09, Collection = 0xA1, End Collection = 0xC0) and associates
  // the most-recent usage/page with the following Collection. This will
  // cover many USB HID descriptors and provides immediate `collections`
  // data for pages; it is not a fully-compliant HID parser.
  function parseReportDescriptor(bytes) {
    const collections = [];
    const stack = [];
    let i = 0;
    let currentUsagePage = null;
    let currentUsage = null;
    let reportSize = 0;
    let reportCount = 0;
    let reportId = 0;

    const readData = (size) => {
      if (i + size > bytes.length) return null;
      let val = 0;
      for (let k = 0; k < size; k++) {
        val |= bytes[i + k] << (8 * k);
      }
      i += size;
      return val;
    };

    function ensureReports(col) {
      if (!col.inputReports) col.inputReports = [];
      if (!col.outputReports) col.outputReports = [];
      if (!col.featureReports) col.featureReports = [];
    }

    function addReport(col, type) {
      ensureReports(col);
      const arr = type === 'input' ? col.inputReports : type === 'output' ? col.outputReports : col.featureReports;
      const id = reportId || 0;
      let rep = arr.find(r => r.reportId === id);
      if (!rep) {
        rep = { reportId: id, items: [] };
        arr.push(rep);
      }
      rep.items.push({
        reportId: id,
        reportType: type,
        reportSize: reportSize,
        reportCount: reportCount,
        usagePage: currentUsagePage,
        usage: currentUsage,
      });
    }

    while (i < bytes.length) {
      const b = bytes[i++];
      if (b === 0x05) {
        const v = readData(1);
        if (v !== null) currentUsagePage = v;
      } else if (b === 0x06) {
        const v = readData(2);
        if (v !== null) currentUsagePage = v;
      } else if (b === 0x09) {
        const v = readData(1);
        if (v !== null) currentUsage = v;
      } else if (b === 0x29) {
        readData(1);
      } else if (b === 0x75) {
        const v = readData(1);
        if (v !== null) reportSize = v;
      } else if (b === 0x95) {
        const v = readData(1);
        if (v !== null) reportCount = v;
      } else if (b === 0x85) {
        const v = readData(1);
        if (v !== null) reportId = v;
      } else if (b === 0xA1) {
        const colType = readData(1);
        const col = { type: colType, usagePage: currentUsagePage, usage: currentUsage, children: [], inputReports: [], outputReports: [], featureReports: [] };
        if (stack.length === 0) {
          collections.push(col);
        } else {
          stack[stack.length - 1].children.push(col);
        }
        stack.push(col);
        currentUsage = null;
      } else if (b === 0xC0) {
        stack.pop();
      } else if ((b & 0xF0) === 0x80 || (b & 0xF0) === 0x90 || (b & 0xF0) === 0xB0) {
        const sizeCode = b & 0x03;
        const size = sizeCode === 0 ? 0 : sizeCode === 1 ? 1 : sizeCode === 2 ? 2 : 4;
        i += size;
        if (stack.length > 0) {
          const type = (b & 0xF0) === 0x80 ? 'input' : (b & 0xF0) === 0x90 ? 'output' : 'feature';
          addReport(stack[stack.length - 1], type);
        }
        currentUsage = null;
      } else {
        const sizeCode = b & 0x03;
        const size = sizeCode === 0 ? 0 : sizeCode === 1 ? 1 : sizeCode === 2 ? 2 : 4;
        i += size;
      }
    }

    return collections;
  }

  // ── HIDDevice ─────────────────────────────────────────────────────────────

  class HIDDevice extends EventTarget {
    // Private fields for internal bookkeeping
    #inputReportListeners = new Map();  // Maps wrapper -> original listener
    #inputReportEventWrappers = new Map();  // Maps wrapper -> event wrapper function
    #oninputreportListener = null;  // The current oninputreport listener
    #parsedCollections = null;
    // Backing store for the read-only `opened` attribute.  The WebHID
    // spec mandates that `HIDDevice.opened` is a read-only boolean;
    // page code must not be able to flip it directly.
    #opened = false;
    // Hot-path active flag: set to true once the SAB/Worker is established
    // for this device.  When true, sendReport / sendFeatureReport /
    // receiveFeatureReport bypass the JSON control plane and go directly
    // over the WebSocket (page → Worker → WS → daemon → hidraw), reducing
    // roundtrip latency from ~10–20ms to ~1–3ms.
    #hotPath = false;
    #sabListener = null;
    #inputLoopStarted = false;

    #installSabListener() {
      if (this.#sabListener) return;
      const listener = (event) => {
        if (!event.data || event.data.__webhid_bridge !== "evt") return;
        const detail = event.data.event;
        if (!detail || detail.event_type !== "webhid-sab") return;
        const evDeviceId = detail.device_id ? String.fromCharCode(...detail.device_id) : null;
        if (!evDeviceId || !this.deviceId || evDeviceId !== this.deviceId) return;
        this.#hotPath = true;
        console.info('[webhid] hotPath ON for', this.deviceId);
        if (!this.#inputLoopStarted) {
          this.#inputLoopStarted = true;
          startInputReportLoop(this, detail.sab, detail.reportSize);
        }
        window.removeEventListener("message", listener);
        this.#sabListener = null;
      };
      this.#sabListener = listener;
      window.addEventListener("message", listener);
    }

    constructor(deviceInfo) {
      super();
      this.vendorId = deviceInfo.vendor_id;
      this.productId = deviceInfo.product_id;
      this.productName = deviceInfo.product_name;
      this.manufacturer = deviceInfo.manufacturer;
      this.serialNumber = deviceInfo.serial_number;
      this.usbVendorId = deviceInfo.vendor_id;
      this.usbProductId = deviceInfo.product_id;
      // HID usage information (may be null/undefined if daemon didn't provide it)
      this.usagePage = deviceInfo.usage_page !== undefined ? deviceInfo.usage_page : null;
      this.usage = deviceInfo.usage !== undefined ? deviceInfo.usage : null;
      this.deviceId = null;
      // The hidraw path uniquely identifies this HID interface and is
      // what the daemon expects on `open`.  A composite USB device
      // exposes several interfaces — each gets its own HIDDevice
      // instance with a distinct path, even when vid/pid are identical.
      this.path = deviceInfo.device_id || null;

      // If the daemon provided parsed `collections`, prefer them. The
      // daemon-side collection objects may use snake_case field names; we
      // normalise them to the page API shape (camelCase + `type` instead
      // of `collection_type`).
      this.reportDescriptor = null;

      function normalizeCollection(c) {
        const out = {
          type: c.type !== undefined ? c.type : (c.collection_type !== undefined ? c.collection_type : null),
          usagePage: c.usagePage !== undefined ? c.usagePage : (c.usage_page !== undefined ? c.usage_page : null),
          usage: c.usage !== undefined ? c.usage : null,
          children: [],
          // Always initialize report arrays to prevent "items is undefined" errors
          // when iterating over collections - WebHID spec expects these arrays
          // to always be present (even if empty).
          inputReports: [],
          outputReports: [],
          featureReports: [],
        };

        // Normalize children recursively
        if (Array.isArray(c.children) && c.children.length > 0) {
          out.children = c.children.map(normalizeCollection);
        }

        // If the daemon provided richer report metadata, populate the report arrays
        // Each report contains `reportId` and an `items` array with field-level metadata.
        if (Array.isArray(c.reports) && c.reports.length > 0) {
          c.reports.forEach((r) => {
            const rep = {
              reportId: r.id !== undefined && r.id !== null ? r.id : 0,
              items: Array.isArray(r.fields)
                ? r.fields.map((f) => ({
                  reportId: f.report_id !== undefined && f.report_id !== null ? f.report_id : (r.id !== undefined && r.id !== null ? r.id : 0),
                  reportType: f.report_type !== undefined ? f.report_type : (r.report_type !== undefined ? r.report_type : null),
                  reportSize: f.size !== undefined ? f.size : (r.size_bits !== undefined ? r.size_bits : null),
                  reportCount: f.count !== undefined ? f.count : null,
                  usagePage: f.usage_page !== undefined ? f.usage_page : (f.usagePage !== undefined ? f.usagePage : null),
                  usage: f.usage !== undefined ? f.usage : null,
                  // Accept either legacy small `usages` (u16) or packed `packed_usages` (u32)
                  usages: Array.isArray(f.usages) ? f.usages : (Array.isArray(f.packed_usages) ? f.packed_usages : null),
                  // Forward additional optional attributes if present so pages can
                  // inspect them when available (preserve both snake_case and
                  // camelCase names from daemon-side serialization).
                  isArray: f.is_array !== undefined ? f.is_array : f.isArray !== undefined ? f.isArray : undefined,
                  isRange: f.is_range !== undefined ? f.is_range : f.isRange !== undefined ? f.isRange : undefined,
                  isAbsolute: f.is_absolute !== undefined ? f.is_absolute : f.isAbsolute !== undefined ? f.isAbsolute : undefined,
                  hasNull: f.has_null !== undefined ? f.has_null : f.hasNull !== undefined ? f.hasNull : undefined,
                  logicalMinimum: f.logical_minimum !== undefined ? f.logical_minimum : f.logicalMinimum !== undefined ? f.logicalMinimum : undefined,
                  logicalMaximum: f.logical_maximum !== undefined ? f.logical_maximum : f.logicalMaximum !== undefined ? f.logicalMaximum : undefined,
                  physicalMinimum: f.physical_minimum !== undefined ? f.physical_minimum : f.physicalMinimum !== undefined ? f.physicalMinimum : undefined,
                  physicalMaximum: f.physical_maximum !== undefined ? f.physical_maximum : f.physicalMaximum !== undefined ? f.physicalMaximum : undefined,
                  unitExponent: f.unit_exponent !== undefined ? f.unit_exponent : f.unitExponent !== undefined ? f.unitExponent : undefined,
                  unitSystem: f.unit_system !== undefined ? f.unit_system : f.unitSystem !== undefined ? f.unitSystem : undefined,
                  usageMinimum: f.usage_minimum !== undefined ? f.usage_minimum : f.usageMinimum !== undefined ? f.usageMinimum : undefined,
                  usageMaximum: f.usage_maximum !== undefined ? f.usage_maximum : f.usageMaximum !== undefined ? f.usageMaximum : undefined,
                  bitOffset: f.bit_offset !== undefined ? f.bit_offset : f.bitOffset !== undefined ? f.bitOffset : undefined,
                }))
                : [],
            };

            if (r.report_type === "input") out.inputReports.push(rep);
            else if (r.report_type === "output") out.outputReports.push(rep);
            else if (r.report_type === "feature") out.featureReports.push(rep);
          });
        }

        return out;
      }

      if (deviceInfo.collections && Array.isArray(deviceInfo.collections)) {
        try {
          this.#parsedCollections = deviceInfo.collections.map(normalizeCollection);
        } catch (e) {
          this.#parsedCollections = null;
        }
      } else if (deviceInfo.report_descriptor && Array.isArray(deviceInfo.report_descriptor)) {
        try {
          const arr = new Uint8Array(deviceInfo.report_descriptor);
          this.reportDescriptor = arr;
          // JS parser runs immediately (sync fallback)
          this.#parsedCollections = parseReportDescriptor(arr);
          // Ask bridge (isolated world, CSP-free) for WASM parse — richer output
          const parseId = ++_reqId;
          window.postMessage({ __webhid_bridge: "parse-descriptor", id: parseId, bytes: Array.from(arr) }, "*");
          const wasmListener = (event) => {
            if (!event.data || event.data.__webhid_bridge !== "parse-descriptor-result") return;
            if (event.data.id !== parseId) return;
            window.removeEventListener("message", wasmListener);
            if (event.data.collections) {
              try {
                this.#parsedCollections = Array.from(event.data.collections).map(normalizeCollection);
                this.maxInputReportSize = this.#calculateMaxInputReportSize();
              } catch (e) {}
            }
          };
          window.addEventListener("message", wasmListener);
        } catch (e) {
          this.reportDescriptor = null;
          this.#parsedCollections = null;
        }
      }

      this.maxInputReportSize = this.#calculateMaxInputReportSize();
    }

    #calculateMaxInputReportSize() {
      let max = 2048;
      const visit = (c) => {
        if (c.inputReports) {
          for (const r of c.inputReports) {
            const size = Math.ceil((r.size_bits || r.reportSize || r.size || 0) / 8);
            if (size > max) max = size;
          }
        }
        if (c.children) c.children.forEach(visit);
      };
      this.collections.forEach(visit);
      return max;
    }

    // Read-only `opened` attribute (WebHID spec compliant).  Page code
    // cannot assign to this; only `open()` / `close()` flip the
    // underlying private field.
    get opened() {
      return this.#opened;
    }

    // Return parsed collections (if available) or fallback to usage info.
    get collections() {
      if (this.#parsedCollections) return this.#parsedCollections;
      // Return a properly structured collection with empty report arrays
      // to match the WebHID spec and prevent "items is undefined" errors
      return [{
        usagePage: this.usagePage,
        usage: this.usage,
        inputReports: [],
        outputReports: [],
        featureReports: [],
        children: []
      }];
    }

    async open() {
      if (this.opened) {
        throw new DOMException("Device is already open", "InvalidStateError");
      }
      if (!this.path) {
        throw new DOMException(
          "HIDDevice has no underlying hidraw path",
          "InvalidStateError",
        );
      }
      try {
        // Address the specific hidraw interface by path — sending only
        // vid/pid would let the daemon pick any one of several matching
        // interfaces and silently ignore the rest.
        const response = await sendRequest("open", {
          device_id: this.path.split("").map((c) => c.charCodeAt(0)),
          reportSize: this.maxInputReportSize,
        });
        if (response.success) {
          this.#opened = true;
          this.deviceId = String.fromCharCode(...response.data);
          console.log('[webhid] open ok, installing sab listener for', this.deviceId);
          this.#installSabListener();
          this.dispatchEvent(new Event("open"));
          return true;
        }
        throw new Error(response.error || "Failed to open device");
      } catch (error) {
        throw new DOMException(error.message, "InvalidStateError");
      }
    }

    async close() {
      if (!this.opened || !this.deviceId) return;
      try {
        const response = await sendRequest("close", {
          data: this.deviceId.split("").map((c) => c.charCodeAt(0)),
        });
        if (response.success) {
          this.#opened = false;
          this.#hotPath = false;
          this.#inputLoopStarted = false;
          if (this.#sabListener) {
            window.removeEventListener("message", this.#sabListener);
            this.#sabListener = null;
          }
          this.deviceId = null;
          this.dispatchEvent(new Event("close"));
        } else {
          throw new Error("Failed to close device");
        }
      } catch (error) {
        throw new DOMException(error.message, "InvalidStateError");
      }
    }

    async sendReport(reportId, data) {
      // console.debug("[WebHID]", `sendReport(${reportId}, new Uint8Array([${data}]).buffer)`);
      if (!this.opened)
        throw new DOMException("Device is not open", "InvalidStateError");
      const buffer =
        data instanceof DataView
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
      try {
        // Hot path: when the Worker/WS data plane is established, route
        // the call via `worker-send` so the bridge forwards it to the
        // Worker, which sends a binary WS frame straight to the daemon.
        // This bypasses the JSON control plane (page → background.js →
        // NM host → daemon → NM host → background.js → page) and cuts
        // roundtrip latency by ~5–10×.
        const action = this.#hotPath ? "worker-send" : "sendreport";
        const response = await sendRequest(action, {
          device_id: this.deviceId.split("").map((c) => c.charCodeAt(0)),
          report_id: reportId,
          data: Array.from(buffer),
        });
        if (response.success) return;
        throw new Error("sendReport failed");
      } catch (error) {
        throw new DOMException(error.message, "NetworkError");
      }
    }

    async receiveFeatureReport(reportId) {
      if (!this.opened)
        throw new DOMException("Device is not open", "InvalidStateError");
      try {
        const action = this.#hotPath ? "worker-receiveFeature" : "receivefeaturereport";
        const response = await sendRequest(action, {
          device_id: this.deviceId.split("").map((c) => c.charCodeAt(0)),
          report_id: reportId,
        });
        if (response.success && response.data) {
          return new DataView(new Uint8Array(response.data).buffer);
        }
        throw new Error("receiveFeatureReport failed");
      } catch (error) {
        throw new DOMException(error.message, "NetworkError");
      }
    }

    async sendFeatureReport(reportId, data) {
      if (!this.opened)
        throw new DOMException("Device is not open", "InvalidStateError");
      const buffer =
        data instanceof DataView
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
      try {
        const action = this.#hotPath ? "worker-sendFeature" : "sendfeaturereport";
        const response = await sendRequest(action, {
          device_id: this.deviceId.split("").map((c) => c.charCodeAt(0)),
          report_id: reportId,
          data: Array.from(buffer),
        });
        if (response.success) {
          return undefined;
        }
        throw new Error("sendFeatureReport failed");
      } catch (error) {
        throw new DOMException(error.message, "NetworkError");
      }
    }

    addEventListener(type, listener) {
      super.addEventListener(type, listener);
      if (type === "inputreport") {
        const wrapper = (event) => {
          if (!event.data || event.data.__webhid_bridge !== "evt") return;
          const detail = event.data.event;

          if (!detail) {
            console.debug("[WebHID] wrapper: no detail, skipping");
            return;
          }

          const event_type = detail.event_type;

          // Decode device_id from the event for comparison
          const evDeviceId = detail.device_id
            ? String.fromCharCode(...detail.device_id)
            : null;

          // Handle SharedArrayBuffer loop initiation
          if (event_type === "webhid-sab") {
            if (evDeviceId && this.deviceId && evDeviceId === this.deviceId) {
              this.#hotPath = true;
              if (!this.#inputLoopStarted) {
                this.#inputLoopStarted = true;
                startInputReportLoop(this, detail.sab, detail.reportSize);
              }
            }
            return;
          }

          // Handle input_report events (IPC fallback path).
          //
          // The daemon's reader task reads input reports from hidraw and
          // broadcasts them via the IPC control plane as `input_report`
          // events.  The SAB/WebSocket data plane is the intended fast path,
          // but when it is not operational (worker failed to connect, WS
          // server unreachable, etc.) these IPC events are the only way
          // input reports reach the page.  Without this handler the page
          // never sees device responses that arrive as input reports,
          // causing protocols that expect ACKs to stall.
          if (event_type === "input_report") {
            if (this.#hotPath) return;
            if (evDeviceId && this.deviceId && evDeviceId !== this.deviceId) return;
            const dataBytes = detail.data
              ? new Uint8Array(detail.data)
              : new Uint8Array(0);
            this.dispatchEvent(new HIDInputReportEvent('inputreport', {
              device: this,
              reportId: detail.report_id || 0,
              data: new DataView(dataBytes.buffer, dataBytes.byteOffset, dataBytes.byteLength),
            }));
            return;
          }

          // Handle connection events
          if (event_type === "connect" || event_type === "connected") {
            this.dispatchEvent(new HIDConnectionEvent("connect", this));
            return;
          }

          // Handle disconnection events
          if (event_type === "disconnect" || event_type === "disconnected") {
            this.dispatchEvent(new HIDConnectionEvent("disconnect", this));
            return;
          }

          console.debug("[WebHID] wrapper: unknown event_type:", event_type);
        };

        // Register this wrapper for the original listener
        // Use the listener's unique identity as key (listener.toString())
        const listenerKey = listener.toString();
        this.#inputReportListeners.set(listenerKey, listener);
        this.#inputReportEventWrappers.set(wrapper, (event) => {
          // Call the registered listener
          listener(event);
        });

        window.addEventListener("message", wrapper);

      }
    }

    removeEventListener(type, listener) {
      super.removeEventListener(type, listener);
      if (type === "inputreport") {
        // For removeEventListener called from oninputreport setter (with null),
        // the listener passed is the current one stored in #oninputreportListener
        if (!listener || !listener.toString()) {
          // Clear all listeners when removing oninputreport
          this.#inputReportListeners.clear();
          this.#inputReportEventWrappers.forEach((fn, wrapperKey) => {
            window.removeEventListener("message", wrapperKey);
          });
          this.#inputReportEventWrappers.clear();
        } else {
          // Remove specific listener
          const listenerKey = listener.toString();
          this.#inputReportListeners.delete(listenerKey);

          // Remove window message listener if no wrappers left
          if (this.#inputReportListeners.size === 0) {
            this.#inputReportEventWrappers.forEach((fn, wrapperKey) => {
              window.removeEventListener("message", fn);
            });
            this.#inputReportEventWrappers.clear();
            this.#inputReportListeners.clear();
          }
        }
      }
    }

    get oninputreport() {
      return this.#oninputreportListener;
    }

    set oninputreport(listener) {
      // Always pass the current listener to removeEventListener
      const currentListener = this.#oninputreportListener;
      this.removeEventListener("inputreport", currentListener);

      // Set the new listener
      if (listener !== null) {
        this.#oninputreportListener = listener;
        this.addEventListener("inputreport", listener);
      } else {
        this.#oninputreportListener = null;
      }
    }
  }

  /**
   * High-frequency input loop that drains the SharedArrayBuffer ring buffer.
   * Uses Atomics.waitAsync to sleep until the Worker notifies us of new data.
   */
  function startInputReportLoop(device, sab, reportSize) {
    const meta    = new Int32Array(sab, 0, 3);  // [head, tail, dropped]
    const reports = new Uint8Array(sab, 12);
    const cap     = (sab.byteLength - 12) / reportSize;
    let   tail    = Atomics.load(meta, 1);

    // 0-delay yield via MessageChannel (setTimeout has 4ms minimum clamp).
    // Critical for animation frame delivery: 4ms × hundreds of frames = seconds
    // of accumulated latency, which shows up as stale/mismatched frames when
    // SayoDevice stacks transparent image layers.
    const _yieldChan = new MessageChannel();
    let _yieldCb = null;
    _yieldChan.port1.onmessage = () => { if (_yieldCb) { const cb = _yieldCb; _yieldCb = null; cb(); } };
    const scheduleYield = (cb) => { _yieldCb = cb; _yieldChan.port2.postMessage(0); };

    function drain() {
      let head = Atomics.load(meta, 0);
      let n = 0;
      const BATCH = 64;
      while (tail !== head && n < BATCH) {
        const slotOffset = tail * reportSize;
        const storedLen  = reports[slotOffset] | (reports[slotOffset + 1] << 8);
        if (storedLen === 0) {
          tail = (tail + 1) % cap;
          Atomics.store(meta, 1, tail);
          head = Atomics.load(meta, 0);
          continue;
        }
        const reportId  = reports[slotOffset + 2];
        const payloadLen = storedLen - 1;
        const payload = new Uint8Array(payloadLen);
        payload.set(reports.subarray(slotOffset + 3, slotOffset + 3 + payloadLen));
        device.dispatchEvent(new HIDInputReportEvent('inputreport', {
          device,
          reportId,
          data: new DataView(payload.buffer, 0, payloadLen),
        }));
        tail = (tail + 1) % cap;
        Atomics.store(meta, 1, tail);
        head = Atomics.load(meta, 0);
        n++;
      }
      if (tail !== head) {
        scheduleYield(drain);
      }
    }

    function wait() {
      const head = Atomics.load(meta, 0);
      if (head !== tail) {
        // reports already waiting — drain without sleeping
        drain();
      }
      // sleep until Worker calls Atomics.notify(meta, 0)
      const result = Atomics.waitAsync(meta, 0, Atomics.load(meta, 0));
      if (result.async) {
        result.value.then(() => {
          drain();
          wait(); // re-arm
        });
      } else {
        // Value changed synchronously or error occurred
        drain();
        // Use requestAnimationFrame or setTimeout to avoid deep recursion if
        // the worker is incredibly fast (unlikely but safe)
        requestAnimationFrame(wait);
      }
    }

    wait();
  }

  // ── HID (navigator.hid) ───────────────────────────────────────────────────

  class HID extends EventTarget {
    async getDevices() {
      // Returns a Promise that resolves with an array of connected HID devices
      // that the user has previously been granted access to in response to a
      // requestDevice() call.
      try {
        const savedHashes = await getSavedDevices();
        const deviceCache = await getDeviceCache();
        const grantedDevices = [];
        for (const hash of savedHashes) {
          const device = deviceCache.get(hash);
          if (device) {
            grantedDevices.push(new HIDDevice(device));
          }
        }
        return grantedDevices;
      } catch (error) {
        return [];
      }
    }

    // Per the WebHID spec the argument is an options object: { filters: [] }
    async requestDevice(options = {}) {
      const filters = Array.isArray(options.filters) ? options.filters : [];
      return new Promise((resolve, reject) => {
        const id = ++_reqId;
        _pending[id] = (result) => {
          if (result.cancelled) {
            reject(new DOMException("No device selected", "NotFoundError"));
          } else {
            // result may contain 'devices' (array) or legacy 'device' (single)
            const devices = result.devices || (result.device ? [result.device] : []);
            if (devices.length === 0) {
              reject(new DOMException("No device selected", "NotFoundError"));
              return;
            }

            // Save each selected device permission for future getDevices() calls
            for (const d of devices) {
              saveDevice(d);
            }

            // Resolve with an array of HIDDevice instances per spec
            resolve(devices.map((d) => new HIDDevice(d)));
          }
        };
        window.postMessage(
          {
            __webhid_bridge: "req",
            id,
            action: "requestDevice",
            payload: { filters }, // always an array
          },
          "*",
        );
      });
    }
  }

  // ── Expose ────────────────────────────────────────────────────────────────

  navigator.hid = new HID();
  window.HIDDevice = HIDDevice;
  window.HIDInputReportEvent = HIDInputReportEvent;
  window.HIDConnectionEvent = HIDConnectionEvent;
  window.HIDDeviceEvent = HIDDeviceEvent;
})();
