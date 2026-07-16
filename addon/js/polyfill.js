(function () {
  if (window.navigator?.hid) return;
  const _logger = __webhid.import("logger");
  const _http = __webhid.import("http");
  const _GLOBAL_DEFAULTS = __webhid.import("GLOBAL_DEFAULTS");
  const _createSettingsStore = __webhid.import("createSettingsStore");
  _logger.initLogger("polyfill");

  let _reqId = 0;
  const _pending = {};

  const _channel = new MessageChannel();
  const _bridgePort = _channel.port1;
  window.postMessage({ __webhid_bridge: "init" }, "*", [_channel.port2]);

  let _pairedDevices = null;
  let _deviceInfoCache = null;

  async function getPairedDevices() {
    if (_pairedDevices !== null) return _pairedDevices;
    try {
      const result = await sendRequest("getPairedDevices", {
        origin: window.location?.origin || "",
      });
      _pairedDevices = result.hashes || [];
      _deviceInfoCache = null;
      return _pairedDevices;
    } catch {
      return [];
    }
  }

  async function getDeviceCache() {
    if (_deviceInfoCache !== null) return _deviceInfoCache;
    try {
      const response = await sendRequest("enumerate");
      const devices =
        _http.isOk(response.s) && Array.isArray(response.D)
          ? response.D
          : [];
      _deviceInfoCache = new Map();
      for (const d of devices) _deviceInfoCache.set(d.deviceId, d);
      return _deviceInfoCache;
    } catch {
      _deviceInfoCache = new Map();
      return _deviceInfoCache;
    }
  }

  async function pairDevice(deviceInfo) {
    try {
      _pairedDevices = null;
      const result = await sendRequest("pairDevice", {
        origin: window.location?.origin || "",
        device: { deviceId: deviceInfo.deviceId },
      });
      if (result.success) {
        _pairedDevices = result.hashes || [];
        _deviceInfoCache = null;
      }
    } catch {}
  }

  const _defs = _GLOBAL_DEFAULTS;
  const settings = _createSettingsStore(_defs);

  _bridgePort.onmessage = (event) => {
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
      settings.set(event.data.settings || {});
      return;
    }
    if (event.data.__webhid_bridge === "evt") {
      _dispatchDeviceEvent(event.data.event);
    }
  };

  function sendRequest(action, payload) {
    return new Promise((resolve) => {
      const id = ++_reqId;
      _pending[id] = resolve;
      const msg = {
        __webhid_bridge: "req",
        id,
        action,
        payload: payload || {},
      };
      const xfers = [];
      if (payload && payload.data instanceof Uint8Array) {
        msg.__transfer = true;
        xfers.push(payload.data.buffer);
      }
      _bridgePort.postMessage(msg, xfers.length ? xfers : undefined);
    });
  }

  function sendFireAndForget(action, payload) {
    const msg = {
      __webhid_bridge: "req",
      id: 0,
      action,
      payload: payload || {},
      fireAndForget: true,
    };
    const xfers = [];
    if (payload && payload.data instanceof Uint8Array) {
      msg.__transfer = true;
      xfers.push(payload.data.buffer);
    }
    _bridgePort.postMessage(msg, xfers.length ? xfers : undefined);
  }

  settings.on("dataPlane", (v) =>
    _logger.info("data plane changed: " + v),
  );
  settings.on("fireAndForget", (v) =>
    _logger.info("fire-and-forget: " + v),
  );
  settings.on("logLevel", (v) => {
    if (_logger.applyLevel)
      _logger.applyLevel(v);
  });

  sendRequest("getSettings", {}).then((s) => {
    if (!s) return;
    settings.set(s);
    _logger.info(
      "data plane: " +
        settings.dataPlane +
        " (fire-and-forget: " +
        settings.fireAndForget +
        ")",
    );
  });

  const _devState = new WeakMap();
  const _hidState = new WeakMap();
  const _evtState = new WeakMap();
  const _irState = Symbol("webhid_ir");
  const _deviceRegistry = new Map();

  function HIDDevice() {
    throw new TypeError("Illegal constructor");
  }
  HIDDevice.prototype = Object.create(EventTarget.prototype);
  HIDDevice.prototype.constructor = HIDDevice;
  Object.defineProperty(HIDDevice.prototype, Symbol.toStringTag, {
    value: "HIDDevice",
    configurable: true,
  });

  Object.defineProperties(HIDDevice.prototype, {
    opened: {
      get() {
        return _devState.get(this)?.opened ?? false;
      },
      enumerable: true,
      configurable: true,
    },
    vendorId: {
      get() {
        return _devState.get(this)?.vendorId;
      },
      enumerable: true,
      configurable: true,
    },
    productId: {
      get() {
        return _devState.get(this)?.productId;
      },
      enumerable: true,
      configurable: true,
    },
    productName: {
      get() {
        return _devState.get(this)?.productName;
      },
      enumerable: true,
      configurable: true,
    },
    collections: {
      get() {
        return _devState.get(this)?.collections;
      },
      enumerable: true,
      configurable: true,
    },
    oninputreport: {
      get() {
        return _devState.get(this)?.oninputreport ?? null;
      },
      set(v) {
        const s = _devState.get(this);
        if (!s) return;
        if (s.oninputreport)
          s.et.removeEventListener("inputreport", s.oninputreport);
        s.oninputreport = v;
        if (v) this.addEventListener("inputreport", v);
      },
      enumerable: true,
      configurable: true,
    },
    open: {
      value: async function () {
        const s = _devState.get(this);
        if (!s) throw new DOMException("Invalid state", "InvalidStateError");
        if (s.opened)
          throw new DOMException("Device is already open", "InvalidStateError");
        try {
          const response = await sendRequest("open", {
            deviceId: s.deviceId,
            reportSize: s.maxInputReportSize + 3,
          });
          if (_http.isOk(response.s)) {
            s.opened = true;
            const dataChannel = new MessageChannel();
            s.dataPort = dataChannel.port1;
            s.dataPort.onmessage = (ev) => _onDataPortMessage(s, ev.data);
            _bridgePort.postMessage(
              {
                __webhid_bridge: "req",
                id: 0,
                action: "data-port",
                payload: { deviceId: s.deviceId },
              },
              [dataChannel.port2],
            );
            _logger.info("open deviceId=" + s.deviceId);
            this.dispatchEvent(new Event("open"));
            return true;
          }
          throw new Error(
            "Open failed: " + _http.name(response.s || 0),
          );
        } catch (error) {
          throw new DOMException(error.message, "InvalidStateError");
        }
      },
      enumerable: true,
      configurable: true,
      writable: true,
    },
    close: {
      value: async function () {
        const s = _devState.get(this);
        if (!s) return;
        if (!s.opened) return;
        _logger.debug("close deviceId=" + s.deviceId);
        try {
          const response = await sendRequest("close", { deviceId: s.deviceId });
          if (_http.isOk(response.s)) {
            s.opened = false;
            if (s.dataPort) {
              s.dataPort.onmessage = null;
              s.dataPort.close();
              s.dataPort = null;
            }
            this.dispatchEvent(new Event("close"));
          } else {
            throw new Error("Failed to close device");
          }
        } catch (error) {
          throw new DOMException(error.message, "InvalidStateError");
        }
      },
      enumerable: true,
      configurable: true,
      writable: true,
    },
    sendReport: {
      value: async function (reportId, data) {
        const s = _devState.get(this);
        if (!s) throw new DOMException("Invalid state", "InvalidStateError");
        if (!s.opened)
          throw new DOMException("Device is not open", "InvalidStateError");
        const view =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const buffer = view.slice();
        try {
          _logger.debug(
            "sendReport reportId=" + reportId + " len=" + buffer.length,
          );
          if (!s.dataPort) throw new Error("data port not connected");
          const reqId = ++_reqId;
          const msg = { type: "send", reqId, reportId, data: buffer };
          if (settings.fireAndForget) {
            s.dataPort.postMessage(msg, [buffer.buffer]);
            return;
          }
          return new Promise((resolve, reject) => {
            s.dataPending = s.dataPending || new Map();
            s.dataPending.set(reqId, {
              resolve: () => resolve(),
              reject: (e) =>
                reject(new DOMException(e.message || e, "NetworkError")),
            });
            s.dataPort.postMessage(msg, [buffer.buffer]);
          });
        } catch (error) {
          throw new DOMException(error.message, "NetworkError");
        }
      },
      enumerable: true,
      configurable: true,
      writable: true,
    },
    receiveFeatureReport: {
      value: async function (reportId) {
        const s = _devState.get(this);
        if (!s) throw new DOMException("Invalid state", "InvalidStateError");
        if (!s.opened)
          throw new DOMException("Device is not open", "InvalidStateError");
        try {
          if (!s.dataPort) throw new Error("data port not connected");
          const reqId = ++_reqId;
          return new Promise((resolve, reject) => {
            s.dataPending = s.dataPending || new Map();
            s.dataPending.set(reqId, {
              resolve: (d) => {
                if (!d) return resolve(new DataView(new ArrayBuffer(0)));
                const buf = d instanceof Uint8Array ? d : new Uint8Array(d);
                resolve(
                  new DataView(buf.buffer, buf.byteOffset, buf.byteLength),
                );
              },
              reject: (e) =>
                reject(new DOMException(e.message || e, "NetworkError")),
            });
            s.dataPort.postMessage({ type: "receiveFeature", reqId, reportId });
          });
        } catch (error) {
          throw new DOMException(error.message, "NetworkError");
        }
      },
      enumerable: true,
      configurable: true,
      writable: true,
    },
    sendFeatureReport: {
      value: async function (reportId, data) {
        const s = _devState.get(this);
        if (!s) throw new DOMException("Invalid state", "InvalidStateError");
        if (!s.opened)
          throw new DOMException("Device is not open", "InvalidStateError");
        const view =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const buffer = view.slice();
        _logger.debug(
          "sendFeatureReport reportId=" + reportId + " len=" + buffer.length,
        );
        try {
          if (!s.dataPort) throw new Error("data port not connected");
          const reqId = ++_reqId;
          const msg = { type: "sendFeature", reqId, reportId, data: buffer };
          if (settings.fireAndForget) {
            s.dataPort.postMessage(msg, [buffer.buffer]);
            return undefined;
          }
          return new Promise((resolve, reject) => {
            s.dataPending = s.dataPending || new Map();
            s.dataPending.set(reqId, {
              resolve: () => resolve(undefined),
              reject: (e) =>
                reject(new DOMException(e.message || e, "NetworkError")),
            });
            s.dataPort.postMessage(msg, [buffer.buffer]);
          });
        } catch (error) {
          throw new DOMException(error.message, "NetworkError");
        }
      },
      enumerable: true,
      configurable: true,
      writable: true,
    },
    forget: {
      value: async function () {
        const s = _devState.get(this);
        if (!s) return;
        if (s.opened) await this.close();
        await sendRequest("unpairDevice", { deviceId: s.deviceId });
      },
      enumerable: true,
      configurable: true,
      writable: true,
    },
    addEventListener: {
      value: function (type, listener) {
        const s = _devState.get(this);
        if (s) s.et.addEventListener(type, listener);
      },
      enumerable: true,
      configurable: true,
      writable: true,
    },
    removeEventListener: {
      value: function (type, listener) {
        const s = _devState.get(this);
        if (s) s.et.removeEventListener(type, listener);
      },
      enumerable: true,
      configurable: true,
      writable: true,
    },
  });

  function _dispatchDeviceEvent(detail) {
    if (!detail) return;
    if (detail.eventType === "connect" || detail.eventType === "disconnect") {
      const dev = detail.deviceId ? _deviceRegistry.get(detail.deviceId) : null;
      if (dev) {
        if (detail.eventType === "disconnect") _deviceInfoCache = null;
        dev.dispatchEvent(
          new HIDConnectionEvent(detail.eventType, { device: dev }),
        );
      }
      return;
    }
  }

  function _onDataPortMessage(s, d) {
    if (!d) return;
    if (d.type === "sendResult" || d.type === "featureResult") {
      const p = s.dataPending?.get(d.reqId);
      if (!p) return;
      s.dataPending.delete(d.reqId);
      if (d.error) p.reject(new Error(d.error));
      else if (d.type === "featureResult") p.resolve(d.data);
      else p.resolve();
      return;
    }
    if (d.type === "inputReport") {
      const dataView = d.data
        ? new DataView(d.data)
        : new DataView(new ArrayBuffer(0));
      const dev = s.self;
      if (dev)
        dev.dispatchEvent(
          new HIDInputReportEvent("inputreport", {
            device: dev,
            reportId: d.reportId,
            data: dataView,
          }),
        );
      return;
    }
    if (d.type === "disconnect") {
      _deviceInfoCache = null;
      const dev = s.self;
      if (dev)
        dev.dispatchEvent(
          new HIDConnectionEvent("disconnect", { device: dev }),
        );
      return;
    }
  }

  function _createHIDDevice(deviceInfo) {
    const obj = Object.create(HIDDevice.prototype);
    const _et = new EventTarget();
    obj.dispatchEvent = _et.dispatchEvent.bind(_et);
    const state = {
      et: _et,
      self: obj,
      deviceId: deviceInfo.deviceId,
      vendorId: deviceInfo.vendorId,
      productId: deviceInfo.productId,
      productName: deviceInfo.productName,
      collections: deviceInfo.collections || [],
      opened: false,
      dataPort: null,
      dataPending: null,
      maxInputReportSize: deviceInfo.maxInputReportSize || 64,
      oninputreport: null,
    };
    _devState.set(obj, state);
    return obj;
  }

  function getOrCreateDevice(deviceInfo) {
    const id = deviceInfo.deviceId;
    if (id && _deviceRegistry.has(id)) return _deviceRegistry.get(id);
    const dev = _createHIDDevice(deviceInfo);
    if (id) _deviceRegistry.set(id, dev);
    return dev;
  }

  function HIDInputReportEvent(type, init) {
    const obj = Reflect.construct(
      Event,
      [type, init],
      new.target || HIDInputReportEvent,
    );
    obj[_irState] = {
      device: init?.device,
      reportId: init?.reportId,
      data: init?.data,
    };
    return obj;
  }
  HIDInputReportEvent.prototype = Object.create(Event.prototype);
  HIDInputReportEvent.prototype.constructor = HIDInputReportEvent;
  Object.defineProperty(HIDInputReportEvent.prototype, Symbol.toStringTag, {
    value: "HIDInputReportEvent",
    configurable: true,
  });
  Object.defineProperties(HIDInputReportEvent.prototype, {
    device: {
      get() {
        return this[_irState]?.device;
      },
      enumerable: true,
      configurable: true,
    },
    reportId: {
      get() {
        return this[_irState]?.reportId;
      },
      enumerable: true,
      configurable: true,
    },
    data: {
      get() {
        return this[_irState]?.data;
      },
      enumerable: true,
      configurable: true,
    },
  });

  function HIDConnectionEvent(type, init) {
    const obj = Reflect.construct(
      Event,
      [type],
      new.target || HIDConnectionEvent,
    );
    _evtState.set(obj, { device: init?.device ?? init });
    return obj;
  }
  HIDConnectionEvent.prototype = Object.create(Event.prototype);
  HIDConnectionEvent.prototype.constructor = HIDConnectionEvent;
  Object.defineProperty(HIDConnectionEvent.prototype, Symbol.toStringTag, {
    value: "HIDConnectionEvent",
    configurable: true,
  });
  Object.defineProperty(HIDConnectionEvent.prototype, "device", {
    get() {
      return _evtState.get(this)?.device;
    },
    enumerable: true,
    configurable: true,
  });

  function HID() {
    throw new TypeError("Illegal constructor");
  }
  HID.prototype = Object.create(EventTarget.prototype);
  HID.prototype.constructor = HID;
  Object.defineProperty(HID.prototype, Symbol.toStringTag, {
    value: "HID",
    configurable: true,
  });

  Object.defineProperties(HID.prototype, {
    getDevices: {
      value: async function () {
        _logger.debug("getDevices");
        try {
          const pairedHashes = await getPairedDevices();
          const deviceCache = await getDeviceCache();
          const granted = [];
          for (const hash of pairedHashes) {
            const device = deviceCache.get(hash);
            if (device) granted.push(getOrCreateDevice(device));
          }
          _logger.debug(
            "getDevices returned " + granted.length + " device(s)",
          );
          return granted;
        } catch (error) {
          _logger.warn("getDevices error:", error);
          return [];
        }
      },
      enumerable: true,
      configurable: true,
      writable: true,
    },
    requestDevice: {
      value: async function (options = {}) {
        if (navigator.userActivation && !navigator.userActivation.isActive) {
          throw new DOMException(
            "Must be handling a user gesture to perform a hid.requestDevice() call.",
            "SecurityError",
          );
        }
        const filters = Array.isArray(options.filters) ? options.filters : [];
        _logger.debug(
          "requestDevice filters=" + JSON.stringify(filters),
        );
        return new Promise((resolve, reject) => {
          const id = ++_reqId;
          _pending[id] = (result) => {
            if (result.cancelled) {
              reject(new DOMException("No device selected", "NotFoundError"));
              return;
            }
            const devices = result.devices;
            if (!devices || devices.length === 0) {
              reject(new DOMException("No device selected", "NotFoundError"));
              return;
            }
            for (const d of devices) pairDevice(d);
            resolve(devices.map((d) => getOrCreateDevice(d)));
          };
          _bridgePort.postMessage({
            __webhid_bridge: "req",
            id,
            action: "requestDevice",
            payload: { filters },
          });
        });
      },
      enumerable: true,
      configurable: true,
      writable: true,
    },
    addEventListener: {
      value: function (type, listener) {
        const s = _hidState.get(this);
        if (s) s.et.addEventListener(type, listener);
      },
      enumerable: true,
      configurable: true,
      writable: true,
    },
    removeEventListener: {
      value: function (type, listener) {
        const s = _hidState.get(this);
        if (s) s.et.removeEventListener(type, listener);
      },
      enumerable: true,
      configurable: true,
      writable: true,
    },
    onconnect: {
      get() {
        return _hidState.get(this)?.onconnect ?? null;
      },
      set(v) {
        const s = _hidState.get(this);
        if (!s) return;
        if (s.onconnect) s.et.removeEventListener("connect", s.onconnect);
        s.onconnect = v;
        if (v) s.et.addEventListener("connect", v);
      },
      enumerable: true,
      configurable: true,
    },
    ondisconnect: {
      get() {
        return _hidState.get(this)?.ondisconnect ?? null;
      },
      set(v) {
        const s = _hidState.get(this);
        if (!s) return;
        if (s.ondisconnect)
          s.et.removeEventListener("disconnect", s.ondisconnect);
        s.ondisconnect = v;
        if (v) s.et.addEventListener("disconnect", v);
      },
      enumerable: true,
      configurable: true,
    },
  });

  function _createHID() {
    const obj = Object.create(HID.prototype);
    const _et = new EventTarget();
    obj.dispatchEvent = _et.dispatchEvent.bind(_et);
    _hidState.set(obj, { et: _et, onconnect: null, ondisconnect: null });
    return obj;
  }

  Object.defineProperty(globalThis, "HID", {
    value: HID,
    writable: false,
    configurable: true,
    enumerable: false,
  });
  Object.defineProperty(globalThis, "HIDDevice", {
    value: HIDDevice,
    writable: false,
    configurable: true,
    enumerable: false,
  });
  Object.defineProperty(globalThis, "HIDInputReportEvent", {
    value: HIDInputReportEvent,
    writable: false,
    configurable: true,
    enumerable: false,
  });
  Object.defineProperty(globalThis, "HIDConnectionEvent", {
    value: HIDConnectionEvent,
    writable: false,
    configurable: true,
    enumerable: false,
  });
  Object.defineProperty(window.navigator, "hid", {
    value: _createHID(),
    writable: false,
    configurable: true,
    enumerable: true,
  });
})();
