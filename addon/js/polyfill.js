(function () {
  if (navigator.hid) return; // already installed

  let _reqId = 0;
  const _pending = {};

  // ── Device persistence helpers ────────────────────────────────────────────
  // Device permissions stored per site origin. Hash from vid/pid/serial/path.

  let _savedDevices = null;
  let _deviceInfoCache = null;

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
        _deviceInfoCache.set(device.deviceId, device);
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

      const result = await sendRequest(
        "saveDevice",
        {
          origin: window.location.origin,
          device: {
            deviceId: deviceInfo.deviceId,
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
  //   ws — page → bridge → WebSocket → daemon (input reports via postMessage transfer)
  //   nm  — page → bridge → background → NM host → daemon
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
      const xfers = [];
      if (payload && payload.data instanceof Uint8Array) {
        msg.__transfer = true;
        xfers.push(payload.data.buffer);
      }
      window.postMessage(msg, "*", xfers.length ? xfers : undefined);
    });
  }

  function sendFireAndForget(action, payload) {
    const msg = { __webhid_bridge: "req", id: 0, action, payload: payload || {}, fireAndForget: true };
    const xfers = [];
    if (payload && payload.data instanceof Uint8Array) {
      msg.__transfer = true;
      xfers.push(payload.data.buffer);
    }
    window.postMessage(msg, "*", xfers.length ? xfers : undefined);
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

  function getOrCreateDevice(deviceInfo) {
    const id = deviceInfo.deviceId;
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
    #deviceId = null;
    #maxInputReportSize = 2048;
    #port = null; // MessagePort for direct worker→page input reports

    constructor(deviceInfo) {
      super();
      this.vendorId = deviceInfo.vendorId;
      this.productId = deviceInfo.productId;
      this.productName = deviceInfo.productName;
      this.#deviceId = deviceInfo.deviceId || null;

      this.#parsedCollections = deviceInfo.collections || [];

      this.#maxInputReportSize = deviceInfo.maxInputReportSize || 64;
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
          deviceId: this.#deviceId,
          reportSize: this.#maxInputReportSize + 3,
        });
        if (response.success) {
          this.#opened = true;
          __webhid.logger.info('[webhid] open deviceId=' + this.#deviceId + ' dataPlane=' + _dataPlane);
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
          deviceId: this.#deviceId,
        });
        if (response.success) {
          this.#opened = false;
          if (this.#port) {
            this.#port.onmessage = null;
            this.#port.close();
            this.#port = null;
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
            deviceId: this.#deviceId,
            reportId: reportId,
            data: buffer,
          });
          __webhid.perf.end(t0, '[webhid] sendReport reportId=' + reportId);
          return;
        }
        const response = await sendRequest(action, {
          deviceId: this.#deviceId,
          reportId: reportId,
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
          deviceId: this.#deviceId,
          reportId: reportId,
        });
        if (response.success && response.data) {
          __webhid.logger.debug('[webhid] receiveFeatureReport done len=' + (typeof response.data === 'string' ? 'base64' : response.data.length));
          const buf = typeof response.data === 'string' ? Uint8Array.fromBase64(response.data) : response.data;
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
            deviceId: this.#deviceId,
            reportId: reportId,
            data: buffer,
          });
          return undefined;
        }
        const response = await sendRequest(action, {
          deviceId: this.#deviceId,
          reportId: reportId,
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
      await sendRequest("forgetDevice", { deviceId: this.#deviceId });
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

          const eventType = detail.eventType;

          const evDeviceId = detail.deviceId;

          if (eventType === "webhid-data-ready") {
            if (detail.port && !this.#port) {
              this.#port = detail.port;
              this.#port.onmessage = (portEvent) => {
                const d = portEvent.data;
                if (d.type === 'inputReport') {
                  if (this.#deviceId && d.deviceId && d.deviceId !== this.#deviceId) return;
                  let dataView;
                  if (d.data) {
                    dataView = new DataView(d.data);
                  } else {
                    dataView = new DataView(new ArrayBuffer(0));
                  }
                  if (dataView.byteLength > 0 && d.reportId !== 33) {
                    let hex = '';
                    for (let i = 0; i < Math.min(8, dataView.byteLength); i++) hex += dataView.getUint8(i).toString(16).padStart(2, '0') + ' ';
                    __webhid.logger.debug('[webhid] port inputReport device=' + this.#deviceId + ' reportId=' + d.reportId + ' len=' + dataView.byteLength + ' first8=' + hex);
                  }
                  this.dispatchEvent(new HIDInputReportEvent('inputreport', {
                    device: this,
                    reportId: d.reportId,
                    data: dataView,
                  }));
                }
              };
              __webhid.logger.info('[webhid] MessagePort connected for device=' + this.#deviceId + ' — direct worker→page input reports');
            }
            return;
          }

          if (eventType === "input_report") {
            if (evDeviceId && this.#deviceId && evDeviceId !== this.#deviceId) return;
            let dataView;
            if (typeof detail.data === 'string') {
              const buf = Uint8Array.fromBase64(detail.data);
              dataView = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
            } else if (detail.data) {
              dataView = new DataView(detail.data.buffer, detail.data.byteOffset, detail.data.byteLength);
            } else {
              dataView = new DataView(new ArrayBuffer(0));
            }
            if (dataView.byteLength > 0 && detail.reportId !== 33) {
              let hex = '';
              for (let i = 0; i < Math.min(8, dataView.byteLength); i++) hex += dataView.getUint8(i).toString(16).padStart(2, '0') + ' ';
              __webhid.logger.debug('[webhid] page inputReport device=' + (this.#deviceId || evDeviceId) + ' reportId=' + detail.reportId + ' len=' + dataView.byteLength + ' first8=' + hex);
            }
            this.dispatchEvent(new HIDInputReportEvent('inputreport', {
              device: this,
              reportId: detail.reportId,
              data: dataView,
            }));
            return;
          }

          // Handle disconnection events
          if (eventType === "disconnect") {
            this.dispatchEvent(new HIDConnectionEvent("disconnect", this));
            return;
          }

          __webhid.logger.debug("[WebHID] wrapper: unknown eventType:", eventType);
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
