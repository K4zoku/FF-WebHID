(function () {
  if (navigator.hid) return; // already installed

  let _reqId = 0;
  const _pending = {};

  // ── Device persistence helpers ────────────────────────────────────────────
  // Device permissions stored per site origin. Hash from vid/pid/serial/path.

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

  // Minimal HID report-descriptor parser (JS fallback). WASM parser in
  // bridge.js produces richer output; this only extracts usage page/usage
  // per collection for immediate sync availability.
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

  // ── Global device registry ────────────────────────────────────────────────
  // Tracks all HIDDevice instances so getDevices()/requestDevice() return
  // the SAME objects. Open state is shared across tabs (matches Chromium).
  const _deviceRegistry = new Map(); // internalId -> HIDDevice

  // WeakMap for SAB-swap callback (can't use private field since
  // startInputReportLoop is a standalone function, not a class method).
  const _sabUpdateFns = new WeakMap();

  function getOrCreateDevice(deviceInfo) {
    const id = deviceInfo.device_id;
    if (id && _deviceRegistry.has(id)) {
      return _deviceRegistry.get(id);
    }
    const dev = new HIDDevice(deviceInfo);
    if (id) _deviceRegistry.set(id, dev);
    return dev;
  }

  // ── HIDDevice ─────────────────────────────────────────────────────────────

  class HIDDevice extends EventTarget {
    #inputReportListeners = new Map();
    #inputReportEventWrappers = new Map();
    #oninputreportListener = null;
    #parsedCollections = null;
    #opened = false;
    #hotPath = false;
    #sabListener = null;
    #inputLoopStarted = false;
    #sabDrainActive = false;
    #deviceId = null;
    #internalId = null;
    #manufacturer = null;
    #serialNumber = null;
    #usagePage = null;
    #usage = null;
    #reportDescriptor = null;
    #maxInputReportSize = 2048;

    #installSabListener() {
      if (this.#sabListener) return;
      const listener = (event) => {
        if (!event.data || event.data.__webhid_bridge !== "evt") return;
        const detail = event.data.event;
        if (!detail) return;
        const evDeviceId = detail.device_id ? String.fromCharCode(...detail.device_id) : null;
        if (!evDeviceId || !this.#deviceId || evDeviceId !== this.#deviceId) return;

        if (detail.event_type === "webhid-sab") {
          // SAB path: start/update drain loop
          this.#hotPath = true;
          this.#sabDrainActive = true;
          if (!this.#inputLoopStarted) {
            this.#inputLoopStarted = true;
            startInputReportLoop(this, detail.sab, detail.reportSize);
          } else {
            const updateFn = _sabUpdateFns.get(this);
            if (updateFn) updateFn(detail.sab, detail.reportSize);
          }
        } else if (detail.event_type === "webhid-sab-disabled") {
          // SAB unavailable (COOP/COEP blocked). Enable hotPath for send/
          // receive/feature routing via WS worker, but skip SAB drain loop.
          // Input reports arrive via `input_report` events from the worker.
          this.#hotPath = true;
          this.#sabDrainActive = false;
          this.#inputLoopStarted = true; // prevent SAB drain from starting later
        }
      };
      this.#sabListener = listener;
      window.addEventListener("message", listener);
    }

    constructor(deviceInfo) {
      super();
      this.vendorId = deviceInfo.vendor_id;
      this.productId = deviceInfo.product_id;
      this.productName = deviceInfo.product_name;
      this.#manufacturer = deviceInfo.manufacturer || null;
      this.#serialNumber = deviceInfo.serial_number || null;
      this.#usagePage = deviceInfo.usage_page !== undefined ? deviceInfo.usage_page : null;
      this.#usage = deviceInfo.usage !== undefined ? deviceInfo.usage : null;
      this.#deviceId = null;
      this.#internalId = deviceInfo.device_id || null;
      this.#reportDescriptor = null;

      // ... normalize collections ...

      // Normalizes a field to Chromium's HIDReportItem shape.
      // Accepts both snake_case (daemon/WASM) and camelCase keys.
      // Emits `usages` XOR (`usageMinimum` + `usageMaximum`) per isRange.
      function normalizeField(f, fallbackReportId, fallbackReportType) {
        const pick = (camel, snake) =>
          f[camel] !== undefined ? f[camel] :
          f[snake] !== undefined ? f[snake] : undefined;

        const isRange = pick("isRange", "is_range") === true;
        let usageMinimum = pick("usageMinimum", "usage_minimum");
        let usageMaximum = pick("usageMaximum", "usage_maximum");

        // usages: prefer spec camelCase, then snake_case, then packed_usages (u32).
        // If usages look like u16 values and we have a usagePage, pack them into
        // the Chromium-style u32 form (page<<16 | id).
        const uPage = f.usagePage !== undefined ? f.usagePage
                    : f.usage_page !== undefined ? f.usage_page
                    : null;
        let usages = null;
        if (Array.isArray(f.usages)) usages = f.usages.slice();
        else if (Array.isArray(f.packed_usages)) usages = f.packed_usages.slice();
        if (usages && usages.length && typeof usages[0] === "number" && usages[0] < 0x10000 && uPage != null) {
          usages = usages.map(u => ((uPage << 16) | (u & 0xFFFF)) >>> 0);
        }

        // If isRange is true but usageMinimum/usageMaximum are missing
        // (e.g. from the JS parser fallback), try to derive them from the
        // usages list.
        if (isRange && usageMinimum == null && usageMaximum == null && usages && usages.length > 1) {
          const page = (usages[0] >> 16) & 0xFFFF;
          const lo = usages[0] & 0xFFFF;
          const hi = usages[usages.length - 1] & 0xFFFF;
          usageMinimum = ((page << 16) | lo) >>> 0;
          usageMaximum = ((page << 16) | hi) >>> 0;
        }

        const item = {
          reportSize: f.reportSize !== undefined ? f.reportSize
                    : f.size !== undefined ? f.size
                    : f.size_bits !== undefined ? f.size_bits
                    : 0,
          reportCount: f.reportCount !== undefined ? f.reportCount
                     : f.count !== undefined ? f.count
                     : 0,
          isArray: pick("isArray", "is_array") === true,
          isRange,
          isAbsolute: pick("isAbsolute", "is_absolute") === true,
          isConstant: pick("isConstant", "is_constant") === true,
          isLinear: pick("isLinear", "is_linear") === true,
          isVolatile: pick("isVolatile", "is_volatile") === true,
          isBufferedBytes: pick("isBufferedBytes", "is_buffered_bytes") === true,
          hasNull: pick("hasNull", "has_null") === true,
          hasPreferredState: pick("hasPreferredState", "has_preferred_state") === true,
          wrap: pick("wrap", "wrap") === true,
          logicalMinimum: pick("logicalMinimum", "logical_minimum") ?? 0,
          logicalMaximum: pick("logicalMaximum", "logical_maximum") ?? 0,
          physicalMinimum: pick("physicalMinimum", "physical_minimum") ?? 0,
          physicalMaximum: pick("physicalMaximum", "physical_maximum") ?? 0,
          unitExponent: pick("unitExponent", "unit_exponent") ?? 0,
          unitSystem: pick("unitSystem", "unit_system") ?? "none",
          unitFactorLengthExponent: pick("unitFactorLengthExponent", "unit_factor_length_exponent") ?? 0,
          unitFactorMassExponent: pick("unitFactorMassExponent", "unit_factor_mass_exponent") ?? 0,
          unitFactorTimeExponent: pick("unitFactorTimeExponent", "unit_factor_time_exponent") ?? 0,
          unitFactorTemperatureExponent: pick("unitFactorTemperatureExponent", "unit_factor_temperature_exponent") ?? 0,
          unitFactorCurrentExponent: pick("unitFactorCurrentExponent", "unit_factor_current_exponent") ?? 0,
          unitFactorLuminousIntensityExponent: pick("unitFactorLuminousIntensityExponent", "unit_factor_luminous_intensity_exponent") ?? 0,
        };

        // Emit `usages` XOR `usageMinimum`+`usageMaximum`, matching Chromium.
        if (isRange) {
          item.usageMinimum = usageMinimum ?? 0;
          item.usageMaximum = usageMaximum ?? 0;
        } else {
          item.usages = usages || [];
        }

        return item;
      }

      // Convert a single report object to spec shape.
      // Accepts both { reportId, items[] } (WASM/JS) and
      // { id, fields[], report_type } (daemon).
      function normalizeReport(r, fallbackType) {
        const rid = r.reportId !== undefined ? r.reportId
                  : r.id !== undefined && r.id !== null ? r.id
                  : 0;
        const rtype = r.reportType !== undefined ? r.reportType
                    : r.report_type !== undefined ? r.report_type
                    : fallbackType;
        const items = Array.isArray(r.items) ? r.items
                    : Array.isArray(r.fields) ? r.fields
                    : [];
        return {
          reportId: rid,
          items: items.map(f => normalizeField(f, rid, rtype)),
        };
      }

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

        // Path A: WASM / JS parser format: inputReports/outputReports/
        // featureReports are already split arrays on the collection object.
        const hasSplitReports =
          (Array.isArray(c.inputReports) && c.inputReports.length > 0) ||
          (Array.isArray(c.outputReports) && c.outputReports.length > 0) ||
          (Array.isArray(c.featureReports) && c.featureReports.length > 0);

        if (hasSplitReports) {
          if (Array.isArray(c.inputReports)) {
            out.inputReports = c.inputReports.map(r => normalizeReport(r, "input"));
          }
          if (Array.isArray(c.outputReports)) {
            out.outputReports = c.outputReports.map(r => normalizeReport(r, "output"));
          }
          if (Array.isArray(c.featureReports)) {
            out.featureReports = c.featureReports.map(r => normalizeReport(r, "feature"));
          }
          return out;
        }

        // Path B: legacy daemon format: flat `reports` array with per-report
        // `report_type` field.
        if (Array.isArray(c.reports) && c.reports.length > 0) {
          c.reports.forEach((r) => {
            const rep = normalizeReport(r, null);
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
          this.#reportDescriptor = arr;
          // JS parser runs immediately (sync fallback)
          this.#parsedCollections = parseReportDescriptor(arr);
          // Ask bridge (isolated world, CSP-free) for WASM parse: richer output
          const parseId = ++_reqId;
          window.postMessage({ __webhid_bridge: "parse-descriptor", id: parseId, bytes: Array.from(arr) }, "*");
          const wasmListener = (event) => {
            if (!event.data || event.data.__webhid_bridge !== "parse-descriptor-result") return;
            if (event.data.id !== parseId) return;
            window.removeEventListener("message", wasmListener);
            if (event.data.collections) {
              try {
                this.#parsedCollections = Array.from(event.data.collections).map(normalizeCollection);
                this.#maxInputReportSize = this.#calculateMaxInputReportSize();
              } catch (e) {}
            }
          };
          window.addEventListener("message", wasmListener);
        } catch (e) {
          this.#reportDescriptor = null;
          this.#parsedCollections = null;
        }
      }

      this.#maxInputReportSize = this.#calculateMaxInputReportSize();
    }

    #calculateMaxInputReportSize() {
      let max = 2048;
      const visit = (c) => {
        if (c.inputReports) {
          for (const r of c.inputReports) {
            // Sum the bit size of every item in the report (reportSize *
            // reportCount for each item) to compute the total report payload
            // size in bytes. Falls back to per-report legacy fields if no
            // items are present.
            let bits = 0;
            if (Array.isArray(r.items) && r.items.length > 0) {
              for (const it of r.items) {
                const sz = it.reportSize || it.size || it.size_bits || 0;
                const cnt = it.reportCount || it.count || 1;
                bits += sz * cnt;
              }
            } else {
              bits = (r.size_bits || r.reportSize || r.size || 0) * 8;
            }
            const size = Math.ceil(bits / 8);
            if (size > max) max = size;
          }
        }
        if (c.children) c.children.forEach(visit);
      };
      this.collections.forEach(visit);
      return max;
    }

    get opened() { return this.#opened; }
    get deviceId() { return this.#deviceId; }

    // Return parsed collections (if available) or fallback to usage info.
    get collections() {
      if (this.#parsedCollections) return this.#parsedCollections;
      // Return a properly structured collection with empty report arrays
      // to match the WebHID spec and prevent "items is undefined" errors
      return [{
        usagePage: this.#usagePage,
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
      if (!this.#internalId) {
        throw new DOMException("No device ID", "InvalidStateError");
      }
      try {
        const response = await sendRequest("open", {
          device_id: this.#internalId.split("").map((c) => c.charCodeAt(0)),
          reportSize: this.#maxInputReportSize,
        });
        if (response.success) {
          this.#opened = true;
          this.#deviceId = response.device_id;
          logger.debug('[webhid] open deviceId=' + this.#deviceId);
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
      if (!this.opened || !this.#deviceId) return;
      logger.debug('[webhid] close deviceId=' + this.#deviceId);
      try {
        const response = await sendRequest("close", {
          device_id: this.#deviceId,
        });
        if (response.success) {
          this.#opened = false;
          this.#hotPath = false;
          this.#inputLoopStarted = false;
          this.#sabDrainActive = false;
          if (this.#sabListener) {
            window.removeEventListener("message", this.#sabListener);
            this.#sabListener = null;
          }
          this.#deviceId = null;
          this.dispatchEvent(new Event("close"));
        } else {
          throw new Error("Failed to close device");
        }
      } catch (error) {
        throw new DOMException(error.message, "InvalidStateError");
      }
    }

    async sendReport(reportId, data) {
      if (!this.opened)
        throw new DOMException("Device is not open", "InvalidStateError");
      const buffer =
        data instanceof DataView
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
      const t0 = perf.begin();
      try {
        if (!this.#hotPath && this.#sabListener) {
          await this.#waitForHotPath(2000);
        }
        const action = this.#hotPath ? "worker-send" : "sendreport";
        logger.debug('[webhid] sendReport reportId=' + reportId + ' len=' + buffer.length + ' hotPath=' + this.#hotPath);
        const response = await sendRequest(action, {
          device_id: this.#deviceId.split("").map((c) => c.charCodeAt(0)),
          report_id: reportId,
          data: Array.from(buffer),
        });
        if (response.success) {
          perf.end(t0, '[webhid] sendReport reportId=' + reportId);
          return;
        }
        throw new Error("sendReport failed");
      } catch (error) {
        throw new DOMException(error.message, "NetworkError");
      }
    }

    #waitForHotPath(timeoutMs) {
      return new Promise((resolve) => {
        if (this.#hotPath) return resolve();
        const start = Date.now();
        const check = () => {
          if (this.#hotPath) return resolve();
          if (Date.now() - start >= timeoutMs) return resolve();
          setTimeout(check, 10);
        };
        check();
      });
    }

    async receiveFeatureReport(reportId) {
      if (!this.opened)
        throw new DOMException("Device is not open", "InvalidStateError");
      logger.debug('[webhid] receiveFeatureReport reportId=' + reportId + ' hotPath=' + this.#hotPath);
      try {
        const action = this.#hotPath ? "worker-receiveFeature" : "receivefeaturereport";
        const response = await sendRequest(action, {
          device_id: this.#deviceId.split("").map((c) => c.charCodeAt(0)),
          report_id: reportId,
        });
        if (response.success && response.data) {
          logger.debug('[webhid] receiveFeatureReport done len=' + response.data.length);
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
      logger.debug('[webhid] sendFeatureReport reportId=' + reportId + ' len=' + buffer.length + ' hotPath=' + this.#hotPath);
      try {
        const action = this.#hotPath ? "worker-sendFeature" : "sendfeaturereport";
        const response = await sendRequest(action, {
          device_id: this.#deviceId.split("").map((c) => c.charCodeAt(0)),
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

    async forget() {
      if (this.opened) await this.close();
      await sendRequest("forgetDevice", {
        device_id: this.#internalId.split("").map((c) => c.charCodeAt(0)),
      });
    }

    addEventListener(type, listener) {
      super.addEventListener(type, listener);
      if (type === "inputreport") {
        const wrapper = (event) => {
          if (!event.data || event.data.__webhid_bridge !== "evt") return;
          const detail = event.data.event;

          if (!detail) {
            logger.debug("[WebHID] wrapper: no detail, skipping");
            return;
          }

          const event_type = detail.event_type;

          // Decode device_id from the event for comparison
          const evDeviceId = detail.device_id
            ? String.fromCharCode(...detail.device_id)
            : null;

          // Handle SharedArrayBuffer loop initiation
          if (event_type === "webhid-sab") {
            if (evDeviceId && this.#deviceId && evDeviceId === this.#deviceId) {
              this.#hotPath = true;
              if (!this.#inputLoopStarted) {
                this.#inputLoopStarted = true;
                startInputReportLoop(this, detail.sab, detail.reportSize);
              }
            }
            return;
          }

          if (event_type === "input_report") {
            if (this.#sabDrainActive) return;
            if (evDeviceId && this.#deviceId && evDeviceId !== this.#deviceId) return;
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

          logger.debug("[WebHID] wrapper: unknown event_type:", event_type);
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

  // SAB drain loop. Uses Atomics.waitAsync + generation counter for SAB swaps.
  function startInputReportLoop(device, sab, reportSize) {
    let meta    = new Int32Array(sab, 0, 3);
    let reports = new Uint8Array(sab, 12);
    let cap     = (sab.byteLength - 12) / reportSize;
    let tail    = Atomics.load(meta, 1);
    let lastDropped = Atomics.load(meta, 2);
    let generation = 0;

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
      const dropped = Atomics.load(meta, 2);
      if (dropped !== lastDropped) {
        const delta = dropped - lastDropped;
        lastDropped = dropped;
        logger.warn('[webhid] SAB DROPPED ' + delta + ' input reports (total=' + dropped + ')');
      }
      if (tail !== head) scheduleYield(drain);
    }

    function wait() {
      const myGen = generation;
      const head = Atomics.load(meta, 0);
      if (head !== tail) drain();
      const result = Atomics.waitAsync(meta, 0, Atomics.load(meta, 0));
      if (result.async) {
        result.value.then(() => {
          if (myGen !== generation) return;
          drain();
          wait();
        });
      } else {
        if (myGen !== generation) return;
        drain();
        requestAnimationFrame(() => { if (myGen !== generation) return; wait(); });
      }
    }

    _sabUpdateFns.set(device, (newSab, newReportSize) => {
      meta = new Int32Array(newSab, 0, 3);
      reports = new Uint8Array(newSab, 12);
      reportSize = newReportSize;
      cap = (newSab.byteLength - 12) / reportSize;
      tail = Atomics.load(meta, 1);
      lastDropped = Atomics.load(meta, 2);
      generation++;
      drain();
      wait();
    });

    wait();
  }

  // ── HID (navigator.hid) ───────────────────────────────────────────────────

  class HID extends EventTarget {
    async getDevices() {
      logger.debug('[webhid] getDevices');
      try {
        const savedHashes = await getSavedDevices();
        const deviceCache = await getDeviceCache();
        const grantedDevices = [];
        for (const hash of savedHashes) {
          const device = deviceCache.get(hash);
          if (device) {
            grantedDevices.push(getOrCreateDevice(device));
          }
        }
        logger.debug('[webhid] getDevices returned ' + grantedDevices.length + ' device(s)');
        return grantedDevices;
      } catch (error) {
        logger.warn('[webhid] getDevices error:', error);
        return [];
      }
    }

    // Per the WebHID spec the argument is an options object: { filters: [] }
    async requestDevice(options = {}) {
      const filters = Array.isArray(options.filters) ? options.filters : [];
      logger.debug('[webhid] requestDevice filters=' + JSON.stringify(filters));
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
            resolve(devices.map((d) => getOrCreateDevice(d)));
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
