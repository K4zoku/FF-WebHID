(function () {
  if (globalThis.navigator?.hid) return;
  __webhid.logger.initLogger('polyfill');

  let _reqId = 0;
  const _pending = {};

  let _savedDevices = null;
  let _deviceInfoCache = null;

  async function getSavedDevices() {
    if (_savedDevices !== null) return _savedDevices;
    try {
      const result = await sendRequest("getSavedDevices", { origin: globalThis.location?.origin || '' });
      _savedDevices = result.hashes || [];
      _deviceInfoCache = null;
      return _savedDevices;
    } catch { return []; }
  }

  async function getDeviceCache() {
    if (_deviceInfoCache !== null) return _deviceInfoCache;
    try {
      const response = await sendRequest("enumerate");
      const devices = __webhid.http.isOk(response.s) && Array.isArray(response.D) ? response.D : [];
      _deviceInfoCache = new Map();
      for (const d of devices) _deviceInfoCache.set(d.deviceId, d);
      return _deviceInfoCache;
    } catch { _deviceInfoCache = new Map(); return _deviceInfoCache; }
  }

  async function saveDevice(deviceInfo) {
    try {
      _savedDevices = null;
      const result = await sendRequest("saveDevice", {
        origin: globalThis.location?.origin || '',
        device: { deviceId: deviceInfo.deviceId },
      });
      if (result.success) {
        _savedDevices = result.hashes || [];
        _deviceInfoCache = null;
      }
    } catch {}
  }

  const _defs = globalThis.__webhid.GLOBAL_DEFAULTS;
  const settings = __webhid.createSettingsStore(_defs);

  globalThis.addEventListener("message", (event) => {
    if (event.source !== globalThis) return;
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
      globalThis.postMessage(msg, "*", xfers.length ? xfers : undefined);
    });
  }

  function sendFireAndForget(action, payload) {
    const msg = { __webhid_bridge: "req", id: 0, action, payload: payload || {}, fireAndForget: true };
    const xfers = [];
    if (payload && payload.data instanceof Uint8Array) {
      msg.__transfer = true;
      xfers.push(payload.data.buffer);
    }
    globalThis.postMessage(msg, "*", xfers.length ? xfers : undefined);
  }

  settings.on('dataPlane', (v) => __webhid.logger.info('data plane changed: ' + v));
  settings.on('fireAndForget', (v) => __webhid.logger.info('fire-and-forget: ' + v));
  settings.on('logLevel', (v) => { if (__webhid.logger.applyLevel) __webhid.logger.applyLevel(v); });

  sendRequest("getSettings", {}).then((s) => {
    if (!s) return;
    settings.set(s);
    __webhid.logger.info('data plane: ' + settings.dataPlane + ' (fire-and-forget: ' + settings.fireAndForget + ')');
  });

  const _devState = new WeakMap();
  const _hidState = new WeakMap();
  const _evtState = new WeakMap();
  const _deviceRegistry = new Map();

  function HIDDevice() { throw new TypeError('Illegal constructor'); }
  HIDDevice.prototype = Object.create(EventTarget.prototype);
  HIDDevice.prototype.constructor = HIDDevice;
  Object.defineProperty(HIDDevice.prototype, Symbol.toStringTag, { value: 'HIDDevice', configurable: true });

  Object.defineProperties(HIDDevice.prototype, {
    opened: { get() { return _devState.get(this)?.opened ?? false; }, enumerable: true, configurable: true },
    vendorId: { get() { return _devState.get(this)?.vendorId; }, enumerable: true, configurable: true },
    productId: { get() { return _devState.get(this)?.productId; }, enumerable: true, configurable: true },
    productName: { get() { return _devState.get(this)?.productName; }, enumerable: true, configurable: true },
    collections: { get() { return _devState.get(this)?.collections; }, enumerable: true, configurable: true },
    oninputreport: {
      get() { return _devState.get(this)?.oninputreport ?? null; },
      set(v) {
        const s = _devState.get(this);
        if (!s) return;
        if (s.oninputreport) s.et.removeEventListener('inputreport', s.oninputreport);
        s.oninputreport = v;
        if (v) this.addEventListener('inputreport', v);
      },
      enumerable: true, configurable: true,
    },
    open: { value: async function() {
      const s = _devState.get(this); if (!s) throw new DOMException("Invalid state", "InvalidStateError");
      if (s.opened) throw new DOMException("Device is already open", "InvalidStateError");
      try {
        const response = await sendRequest("open", { deviceId: s.deviceId, reportSize: s.maxInputReportSize + 3 });
        if (__webhid.http.isOk(response.s)) {
          s.opened = true;
          __webhid.logger.info('open deviceId=' + s.deviceId + ' dataPlane=' + settings.dataPlane);
          this.dispatchEvent(new Event("open"));
          return true;
        }
        throw new Error("Open failed: " + __webhid.http.name(response.s || 0));
      } catch (error) { throw new DOMException(error.message, "InvalidStateError"); }
    }, enumerable: true, configurable: true, writable: true },
    close: { value: async function() {
      const s = _devState.get(this); if (!s) return;
      if (!s.opened) return;
      __webhid.logger.debug('close deviceId=' + s.deviceId);
      try {
        const response = await sendRequest("close", { deviceId: s.deviceId });
        if (__webhid.http.isOk(response.s)) {
          s.opened = false;
          if (s.port) { s.port.onmessage = null; s.port.close(); s.port = null; }
          this.dispatchEvent(new Event("close"));
        } else { throw new Error("Failed to close device"); }
      } catch (error) { throw new DOMException(error.message, "InvalidStateError"); }
    }, enumerable: true, configurable: true, writable: true },
    sendReport: { value: async function(reportId, data) {
      const s = _devState.get(this); if (!s) throw new DOMException("Invalid state", "InvalidStateError");
      if (!s.opened) throw new DOMException("Device is not open", "InvalidStateError");
      const view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const buffer = view.slice();
      try {
        const action = settings.dataPlane === 'nm' ? "sendreport" : "worker-send";
        __webhid.logger.debug('sendReport reportId=' + reportId + ' len=' + buffer.length);
        if (settings.fireAndForget) { sendFireAndForget(action, { deviceId: s.deviceId, reportId, data: buffer }); return; }
        const response = await sendRequest(action, { deviceId: s.deviceId, reportId, data: buffer });
        if (__webhid.http.isOk(response.s)) return;
        throw new Error("sendReport failed");
      } catch (error) { throw new DOMException(error.message, "NetworkError"); }
    }, enumerable: true, configurable: true, writable: true },
    receiveFeatureReport: { value: async function(reportId) {
      const s = _devState.get(this); if (!s) throw new DOMException("Invalid state", "InvalidStateError");
      if (!s.opened) throw new DOMException("Device is not open", "InvalidStateError");
      try {
        const action = settings.dataPlane === 'nm' ? "receivefeaturereport" : "worker-receiveFeature";
        const response = await sendRequest(action, { deviceId: s.deviceId, reportId });
        if (__webhid.http.isOk(response.s) && response.d) {
          const buf = typeof response.d === 'string' ? Uint8Array.fromBase64(response.d) : response.d;
          return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        }
        throw new Error("receiveFeatureReport failed");
      } catch (error) { throw new DOMException(error.message, "NetworkError"); }
    }, enumerable: true, configurable: true, writable: true },
    sendFeatureReport: { value: async function(reportId, data) {
      const s = _devState.get(this); if (!s) throw new DOMException("Invalid state", "InvalidStateError");
      if (!s.opened) throw new DOMException("Device is not open", "InvalidStateError");
      const view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const buffer = view.slice();
      __webhid.logger.debug('sendFeatureReport reportId=' + reportId + ' len=' + buffer.length);
      try {
        const action = settings.dataPlane === 'nm' ? "sendfeaturereport" : "worker-sendFeature";
        if (settings.fireAndForget) { sendFireAndForget(action, { deviceId: s.deviceId, reportId, data: buffer }); return undefined; }
        const response = await sendRequest(action, { deviceId: s.deviceId, reportId, data: buffer });
        if (__webhid.http.isOk(response.s)) return undefined;
        throw new Error("sendFeatureReport failed");
      } catch (error) { throw new DOMException(error.message, "NetworkError"); }
    }, enumerable: true, configurable: true, writable: true },
    forget: { value: async function() {
      const s = _devState.get(this); if (!s) return;
      if (s.opened) await this.close();
      await sendRequest("forgetDevice", { deviceId: s.deviceId });
    }, enumerable: true, configurable: true, writable: true },
    addEventListener: { value: function(type, listener) {
      const s = _devState.get(this);
      if (s) s.et.addEventListener(type, listener);
      if (type !== "inputreport") return;
      if (!s) return;
      if (s.wrappers.has(listener)) return;
      const wrapper = (event) => {
        if (event.source !== globalThis) return;
        if (!event.data || event.data.__webhid_bridge !== "evt") return;
        const detail = event.data.event;
        if (!detail) return;
        const eventType = detail.eventType;
        const evDeviceId = detail.deviceId;
        if (eventType === "webhid-data-ready") {
          if (detail.port && !s.port) {
            s.port = detail.port;
            s.port.onmessage = (portEvent) => {
              const d = portEvent.data;
              if (d.type !== 'inputReport') return;
              if (s.deviceId && d.deviceId && d.deviceId !== s.deviceId) return;
              const dataView = d.data ? new DataView(d.data) : new DataView(new ArrayBuffer(0));
              this.dispatchEvent(new HIDInputReportEvent('inputreport', { device: this, reportId: d.reportId, data: dataView }));
            };
            __webhid.logger.info('MessagePort connected for device=' + s.deviceId);
          }
          return;
        }
        if (eventType === "input_report") {
          if (evDeviceId && s.deviceId && evDeviceId !== s.deviceId) return;
          let dataView;
          if (typeof detail.data === 'string') {
            const buf = Uint8Array.fromBase64(detail.data);
            dataView = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
          } else if (detail.data) {
            dataView = new DataView(detail.data.buffer, detail.data.byteOffset, detail.data.byteLength);
          } else { dataView = new DataView(new ArrayBuffer(0)); }
          this.dispatchEvent(new HIDInputReportEvent('inputreport', { device: this, reportId: detail.reportId, data: dataView }));
          return;
        }
        if (eventType === "disconnect") {
          _deviceInfoCache = null;
          this.dispatchEvent(new HIDConnectionEvent("disconnect", { device: this }));
          return;
        }
      };
      s.wrappers.set(listener, wrapper);
      globalThis.addEventListener("message", wrapper);
    }, enumerable: true, configurable: true, writable: true },
    removeEventListener: { value: function(type, listener) {
      const s = _devState.get(this);
      if (s) s.et.removeEventListener(type, listener);
      if (type !== "inputreport") return;
      if (!s) return;
      const wrapper = s.wrappers.get(listener);
      if (!wrapper) return;
      s.wrappers.delete(listener);
      globalThis.removeEventListener("message", wrapper);
    }, enumerable: true, configurable: true, writable: true },
  });

  function _createHIDDevice(deviceInfo) {
    const obj = Object.create(HIDDevice.prototype);
    const _et = new EventTarget();
    obj.dispatchEvent = _et.dispatchEvent.bind(_et);
    _devState.set(obj, {
      et: _et,
      deviceId: deviceInfo.deviceId,
      vendorId: deviceInfo.vendorId,
      productId: deviceInfo.productId,
      productName: deviceInfo.productName,
      collections: deviceInfo.collections || [],
      opened: false,
      port: null,
      maxInputReportSize: deviceInfo.maxInputReportSize || 64,
      oninputreport: null,
      wrappers: new Map(),
    });
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
    const obj = Reflect.construct(Event, [type, init], new.target || HIDInputReportEvent);
    _evtState.set(obj, { device: init?.device, reportId: init?.reportId, data: init?.data });
    return obj;
  }
  HIDInputReportEvent.prototype = Object.create(Event.prototype);
  HIDInputReportEvent.prototype.constructor = HIDInputReportEvent;
  Object.defineProperty(HIDInputReportEvent.prototype, Symbol.toStringTag, { value: 'HIDInputReportEvent', configurable: true });
  Object.defineProperties(HIDInputReportEvent.prototype, {
    device: { get() { return _evtState.get(this)?.device; }, enumerable: true, configurable: true },
    reportId: { get() { return _evtState.get(this)?.reportId; }, enumerable: true, configurable: true },
    data: { get() { return _evtState.get(this)?.data; }, enumerable: true, configurable: true },
  });

  function HIDConnectionEvent(type, init) {
    const obj = Reflect.construct(Event, [type], new.target || HIDConnectionEvent);
    _evtState.set(obj, { device: init?.device ?? init });
    return obj;
  }
  HIDConnectionEvent.prototype = Object.create(Event.prototype);
  HIDConnectionEvent.prototype.constructor = HIDConnectionEvent;
  Object.defineProperty(HIDConnectionEvent.prototype, Symbol.toStringTag, { value: 'HIDConnectionEvent', configurable: true });
  Object.defineProperty(HIDConnectionEvent.prototype, 'device', {
    get() { return _evtState.get(this)?.device; }, enumerable: true, configurable: true,
  });

  function HID() { throw new TypeError('Illegal constructor'); }
  HID.prototype = Object.create(EventTarget.prototype);
  HID.prototype.constructor = HID;
  Object.defineProperty(HID.prototype, Symbol.toStringTag, { value: 'HID', configurable: true });

  Object.defineProperties(HID.prototype, {
    getDevices: { value: async function() {
      __webhid.logger.debug('getDevices');
      try {
        const savedHashes = await getSavedDevices();
        const deviceCache = await getDeviceCache();
        const granted = [];
        for (const hash of savedHashes) {
          const device = deviceCache.get(hash);
          if (device) granted.push(getOrCreateDevice(device));
        }
        __webhid.logger.debug('getDevices returned ' + granted.length + ' device(s)');
        return granted;
      } catch (error) { __webhid.logger.warn('getDevices error:', error); return []; }
    }, enumerable: true, configurable: true, writable: true },
    requestDevice: { value: async function(options = {}) {
      const filters = Array.isArray(options.filters) ? options.filters : [];
      __webhid.logger.debug('requestDevice filters=' + JSON.stringify(filters));
      return new Promise((resolve, reject) => {
        const id = ++_reqId;
        _pending[id] = (result) => {
          if (result.cancelled) { reject(new DOMException("No device selected", "NotFoundError")); return; }
          const devices = result.devices;
          if (!devices || devices.length === 0) { reject(new DOMException("No device selected", "NotFoundError")); return; }
          for (const d of devices) saveDevice(d);
          resolve(devices.map((d) => getOrCreateDevice(d)));
        };
        globalThis.postMessage({ __webhid_bridge: "req", id, action: "requestDevice", payload: { filters } }, "*");
      });
    }, enumerable: true, configurable: true, writable: true },
    addEventListener: { value: function(type, listener) {
      const s = _hidState.get(this);
      if (s) s.et.addEventListener(type, listener);
    }, enumerable: true, configurable: true, writable: true },
    removeEventListener: { value: function(type, listener) {
      const s = _hidState.get(this);
      if (s) s.et.removeEventListener(type, listener);
    }, enumerable: true, configurable: true, writable: true },
    onconnect: {
      get() { return _hidState.get(this)?.onconnect ?? null; },
      set(v) {
        const s = _hidState.get(this); if (!s) return;
        if (s.onconnect) s.et.removeEventListener('connect', s.onconnect);
        s.onconnect = v;
        if (v) s.et.addEventListener('connect', v);
      },
      enumerable: true, configurable: true,
    },
    ondisconnect: {
      get() { return _hidState.get(this)?.ondisconnect ?? null; },
      set(v) {
        const s = _hidState.get(this); if (!s) return;
        if (s.ondisconnect) s.et.removeEventListener('disconnect', s.ondisconnect);
        s.ondisconnect = v;
        if (v) s.et.addEventListener('disconnect', v);
      },
      enumerable: true, configurable: true,
    },
  });

  function _createHID() {
    const obj = Object.create(HID.prototype);
    const _et = new EventTarget();
    obj.dispatchEvent = _et.dispatchEvent.bind(_et);
    _hidState.set(obj, { et: _et, onconnect: null, ondisconnect: null });
    return obj;
  }

  Object.defineProperty(globalThis, 'HID', { value: HID, writable: false, configurable: true, enumerable: false });
  Object.defineProperty(globalThis, 'HIDDevice', { value: HIDDevice, writable: false, configurable: true, enumerable: false });
  Object.defineProperty(globalThis, 'HIDInputReportEvent', { value: HIDInputReportEvent, writable: false, configurable: true, enumerable: false });
  Object.defineProperty(globalThis, 'HIDConnectionEvent', { value: HIDConnectionEvent, writable: false, configurable: true, enumerable: false });
  Object.defineProperty(globalThis.navigator, 'hid', {
    value: _createHID(), writable: false, configurable: true, enumerable: true,
  });
})();
