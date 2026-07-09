(function () {
  if (navigator.hid) return; // already installed

  let _reqId = 0;
  const _pending = {};

  // ── Device persistence helpers ────────────────────────────────────────────
  // Device permissions stored per site origin. Hash from vid/pid/serial/path.

  let _savedDevices = null;
  let _deviceInfoCache = null;

  // ── Base64 helper (decode only — encode lives in background.js) ───────

  function base64Decode(str) {
    return Uint8Array.fromBase64(str);
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
        const hash = __webhid.createDeviceHash(device);
        _deviceInfoCache.set(hash, device);
      }
      return _deviceInfoCache;
    } catch (error) {
      _deviceInfoCache = new Map();
      return _deviceInfoCache;
    }
  }


  async function saveDevice(deviceInfo) {
    try {
      // Clear cache to force refresh
      _savedDevices = null;
      const deviceHash = __webhid.createDeviceHash(deviceInfo);

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

  // ── Transport ────────────────────────────────────────────────────────────
  //
  // Two data-plane modes (both go through the content-script bridge —
  // Firefox does not support `externally_connectable`, so the page cannot
  // connect to the background directly):
  //   ws — page → bridge → worker → WebSocket → daemon (SAB or postMessage)
  //   nm  — page → bridge → background → NM host → daemon (no worker/WS/SAB)
  //
  // In `nm` mode the polyfill sends data actions as `sendreport` /
  // `sendfeaturereport` / `receivefeaturereport` (instead of `worker-*`),
  // which the bridge forwards to the background via runtime.sendMessage.
  //
  // The page (MAIN world) has no `browser.*` APIs, so settings are fetched
  // via a bridge request and updated via bridge-pushed `settings` events.

  const _defs = globalThis.__webhid.GLOBAL_DEFAULTS;
  let _dataPlane = _defs.dataPlane;
  let _perfLogging = _defs.perfLogging;
  let _fireAndForget = _defs.fireAndForget;

  function _applyPerf() {
    const active = _perfLogging && __webhid.logger._level >= 3;
    if (active) {
      __webhid.perf.begin = () => performance.now();
      __webhid.perf.end = (t0, label) => __webhid.logger.debug(label + ' ' + (performance.now() - t0).toFixed(2) + 'ms');
    } else {
      __webhid.perf.begin = () => {};
      __webhid.perf.end = () => {};
    }
  }

  // Listen for responses, events, and settings pushes from the bridge.
  window.addEventListener("message", (event) => {
    if (!event.data) return;
    if (event.data.__webhid_bridge === "res") {
      const handler = _pending[event.data.id];
      if (handler) {
        delete _pending[event.data.id];
        handler(event.data.result);
      }
      return;
    }
    if (event.data.__webhid_bridge === "settings") {
      const s = event.data.settings;
      if (s.dataPlane !== undefined) { _dataPlane = s.dataPlane; __webhid.logger.info('[webhid] data plane changed: ' + _dataPlane); }
      if (s.fireAndForget !== undefined) { _fireAndForget = s.fireAndForget; __webhid.logger.info('[webhid] fire-and-forget: ' + _fireAndForget); }
      if (s.logLevel !== undefined && __webhid.logger.applyLevel) __webhid.logger.applyLevel(s.logLevel);
      if (s.perfLogging !== undefined) _perfLogging = s.perfLogging;
      _applyPerf();
    }
  });

  function sendRequest(action, payload) {
    return new Promise((resolve) => {
      const id = ++_reqId;
      _pending[id] = resolve;
      const msg = { __webhid_bridge: "req", id, action, payload: payload || {} };
      const transfer = (payload && payload.data instanceof Uint8Array) ? [payload.data.buffer] : [];
      window.postMessage(msg, "*", transfer);
    });
  }

  function sendFireAndForget(action, payload) {
    const msg = { __webhid_bridge: "req", id: 0, action, payload: payload || {}, fireAndForget: true };
    const transfer = (payload && payload.data instanceof Uint8Array) ? [payload.data.buffer] : [];
    window.postMessage(msg, "*", transfer);
  }

  // Fetch initial settings from the bridge (which has browser.storage access).
  sendRequest("getSettings", {}).then((s) => {
    if (!s) return;
    if (s.dataPlane !== undefined) _dataPlane = s.dataPlane;
    if (s.fireAndForget !== undefined) _fireAndForget = s.fireAndForget;
    if (s.logLevel !== undefined && __webhid.logger.applyLevel) __webhid.logger.applyLevel(s.logLevel);
    if (s.perfLogging !== undefined) _perfLogging = s.perfLogging;
    _applyPerf();
    __webhid.logger.info('[webhid] data plane: ' + _dataPlane + ' (fire-and-forget: ' + _fireAndForget + ')');
  });

  // ── Event classes ────────────────────────────────────────────────────────

  class HIDInputReportEvent extends Event {
    #device;
    #reportId;
    #data;
    constructor(type, init) {
      super(type, init);
      this.#device = init.device;
      this.#reportId = init.reportId;
      this.#data = init.data;
    }
    get device() { return this.#device; }
    get reportId() { return this.#reportId; }
    get data() { return this.#data; }
  }

  class HIDConnectionEvent extends Event {
    #device;
    constructor(type, device) {
      super(type);
      this.#device = device;
    }
    get device() { return this.#device; }
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
    #inputReportWrappers = new Set();
    #oninputreportListener = null;
    #parsedCollections = null;
    #opened = false;
    #sabListener = null;
    #inputLoopStarted = false;
    #sabDrainActive = false;
    #deviceId = null;
    #maxInputReportSize = 2048;

    #installSabListener() {
      if (this.#sabListener) return;
      const listener = (event) => {
        if (!event.data || event.data.__webhid_bridge !== "evt") return;
        const detail = event.data.event;
        if (!detail) return;
        const evDeviceId = detail.device_id;
        if (!evDeviceId || !this.#deviceId || evDeviceId !== this.#deviceId) return;

        if (detail.event_type === "webhid-sab") {
          // SAB path: start/update drain loop
          this.#sabDrainActive = true;
          if (!this.#inputLoopStarted) {
            this.#inputLoopStarted = true;
            startInputReportLoop(this, detail.sab, detail.reportSize, detail.wakePort);
          } else {
            const updateFn = _sabUpdateFns.get(this);
            if (updateFn) updateFn(detail.sab, detail.reportSize, detail.wakePort);
          }
        } else if (detail.event_type === "webhid-sab-disabled") {
          // SAB unavailable (COOP/COEP blocked). Input reports arrive via
          // `input_report` events from the worker.
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
      this.#deviceId = deviceInfo.device_id || null;

      this.#parsedCollections = deviceInfo.collections || [];

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

    get collections() {
      return this.#parsedCollections;
    }

    async open() {
      if (this.opened) {
        throw new DOMException("Device is already open", "InvalidStateError");
      }
      if (!this.#deviceId) {
        throw new DOMException("No device ID", "InvalidStateError");
      }
      try {
        const response = await sendRequest("open", {
          device_id: this.#deviceId,
          reportSize: this.#maxInputReportSize,
        });
        if (response.success) {
          this.#opened = true;
          __webhid.logger.info('[webhid] open deviceId=' + this.#deviceId + ' dataPlane=' + _dataPlane);
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
      if (!this.opened) return;
      __webhid.logger.debug('[webhid] close deviceId=' + this.#deviceId);
      try {
        const response = await sendRequest("close", {
          device_id: this.#deviceId,
        });
        if (response.success) {
          this.#opened = false;
          this.#inputLoopStarted = false;
          this.#sabDrainActive = false;
          if (this.#sabListener) {
            window.removeEventListener("message", this.#sabListener);
            this.#sabListener = null;
          }
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
      const view = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const buffer = view.slice();
      const t0 = __webhid.perf.begin();
      try {
        const action = _dataPlane === 'nm' ? "sendreport" : "worker-send";
        __webhid.logger.debug('[webhid] sendReport reportId=' + reportId + ' len=' + buffer.length);
        if (_fireAndForget) {
          sendFireAndForget(action, {
            device_id: this.#deviceId,
            report_id: reportId,
            data: buffer,
          });
          __webhid.perf.end(t0, '[webhid] sendReport reportId=' + reportId);
          return;
        }
        const response = await sendRequest(action, {
          device_id: this.#deviceId,
          report_id: reportId,
          data: buffer,
        });
        if (response.success) {
          __webhid.perf.end(t0, '[webhid] sendReport reportId=' + reportId);
          return;
        }
        throw new Error("sendReport failed");
      } catch (error) {
        throw new DOMException(error.message, "NetworkError");
      }
    }

    async receiveFeatureReport(reportId) {
      if (!this.opened)
        throw new DOMException("Device is not open", "InvalidStateError");
      try {
        const action = _dataPlane === 'nm' ? "receivefeaturereport" : "worker-receiveFeature";
        const response = await sendRequest(action, {
          device_id: this.#deviceId,
          report_id: reportId,
        });
        if (response.success && response.data) {
          __webhid.logger.debug('[webhid] receiveFeatureReport done len=' + (typeof response.data === 'string' ? 'base64' : response.data.length));
          const buf = typeof response.data === 'string' ? base64Decode(response.data) : response.data;
          return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        }
        throw new Error("receiveFeatureReport failed");
      } catch (error) {
        throw new DOMException(error.message, "NetworkError");
      }
    }

    async sendFeatureReport(reportId, data) {
      if (!this.opened)
        throw new DOMException("Device is not open", "InvalidStateError");
      const view = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const buffer = view.slice();
      __webhid.logger.debug('[webhid] sendFeatureReport reportId=' + reportId + ' len=' + buffer.length);
      try {
        const action = _dataPlane === 'nm' ? "sendfeaturereport" : "worker-sendFeature";
        if (_fireAndForget) {
          sendFireAndForget(action, {
            device_id: this.#deviceId,
            report_id: reportId,
            data: buffer,
          });
          return undefined;
        }
        const response = await sendRequest(action, {
          device_id: this.#deviceId,
          report_id: reportId,
          data: buffer,
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
        device_id: this.#deviceId,
      });
    }

    addEventListener(type, listener) {
      super.addEventListener(type, listener);
      if (type === "inputreport") {
        const wrapper = (event) => {
          if (!event.data || event.data.__webhid_bridge !== "evt") return;
          const detail = event.data.event;

          if (!detail) {
            __webhid.logger.debug("[WebHID] wrapper: no detail, skipping");
            return;
          }

          const event_type = detail.event_type;

          const evDeviceId = detail.device_id;

          // Handle SharedArrayBuffer loop initiation
          if (event_type === "webhid-sab") {
            if (evDeviceId && this.#deviceId && evDeviceId === this.#deviceId) {
              if (!this.#inputLoopStarted) {
                this.#inputLoopStarted = true;
                startInputReportLoop(this, detail.sab, detail.reportSize, detail.wakePort);
              }
            }
            return;
          }

          if (event_type === "input_report") {
            if (this.#sabDrainActive) return;
            if (evDeviceId && this.#deviceId && evDeviceId !== this.#deviceId) return;
            const dataBytes = typeof detail.data === 'string'
              ? base64Decode(detail.data)
              : detail.data
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

          __webhid.logger.debug("[WebHID] wrapper: unknown event_type:", event_type);
        };

        // Register this wrapper for the original listener
        // Use the listener's unique identity as key (listener.toString())
        const listenerKey = listener.toString();
        this.#inputReportListeners.set(listenerKey, listener);
        this.#inputReportWrappers.add(wrapper);

        window.addEventListener("message", wrapper);

      }
    }

    removeEventListener(type, listener) {
      super.removeEventListener(type, listener);
      if (type === "inputreport") {
        if (!listener || !listener.toString()) {
          this.#inputReportListeners.clear();
          this.#inputReportWrappers.forEach((wrapper) => {
            window.removeEventListener("message", wrapper);
          });
          this.#inputReportWrappers.clear();
        } else {
          const listenerKey = listener.toString();
          this.#inputReportListeners.delete(listenerKey);

          if (this.#inputReportListeners.size === 0) {
            this.#inputReportWrappers.forEach((wrapper) => {
              window.removeEventListener("message", wrapper);
            });
            this.#inputReportWrappers.clear();
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
  function startInputReportLoop(device, sab, reportSize, wakePort) {
    let meta    = new Int32Array(sab, 0, 3);
    let reports = new Uint8Array(sab, 12);
    let cap     = (sab.byteLength - 12) / reportSize;
    let tail    = Atomics.load(meta, 1);
    let lastDropped = Atomics.load(meta, 2);
    let generation = 0;
    let _drainBuf = null;
    let _wakePort = wakePort || null;

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
        if (!_drainBuf || _drainBuf.byteLength < payloadLen) {
          _drainBuf = new ArrayBuffer(Math.max(payloadLen, reportSize));
        }
        const drainView = new Uint8Array(_drainBuf, 0, payloadLen);
        drainView.set(reports.subarray(slotOffset + 3, slotOffset + 3 + payloadLen));
        const dataView = new DataView(_drainBuf, 0, payloadLen);
        device.dispatchEvent(new HIDInputReportEvent('inputreport', {
          device,
          reportId,
          data: dataView,
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
        __webhid.logger.warn('[webhid] SAB DROPPED ' + delta + ' input reports (total=' + dropped + ')');
      }
      if (tail !== head) scheduleYield(drain);
    }

    function wait() {
      const myGen = generation;
      const head = Atomics.load(meta, 0);
      if (head !== tail) drain();

      if (_wakePort) {
        _wakePort.onmessage = () => {
          if (myGen !== generation) return;
          drain();
          wait();
        };
      } else {
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
    }

    _sabUpdateFns.set(device, (newSab, newReportSize, newWakePort) => {
      meta = new Int32Array(newSab, 0, 3);
      reports = new Uint8Array(newSab, 12);
      reportSize = newReportSize;
      cap = (newSab.byteLength - 12) / reportSize;
      tail = Atomics.load(meta, 1);
      lastDropped = Atomics.load(meta, 2);
      if (newWakePort) _wakePort = newWakePort;
      generation++;
      drain();
      wait();
    });

    wait();
  }

  // ── HID (navigator.hid) ───────────────────────────────────────────────────

  class HID extends EventTarget {
    async getDevices() {
      __webhid.logger.debug('[webhid] getDevices');
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
        __webhid.logger.debug('[webhid] getDevices returned ' + grantedDevices.length + ' device(s)');
        return grantedDevices;
      } catch (error) {
        __webhid.logger.warn('[webhid] getDevices error:', error);
        return [];
      }
    }

    // Per the WebHID spec the argument is an options object: { filters: [] }
    async requestDevice(options = {}) {
      const filters = Array.isArray(options.filters) ? options.filters : [];
      __webhid.logger.debug('[webhid] requestDevice filters=' + JSON.stringify(filters));
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
})();
