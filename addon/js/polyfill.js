(function () {
  if (window.navigator?.hid) return;
  const webhid = globalThis.webhid;
  const logger = webhid.import("logger");
  const http = webhid.import("http");
  const GLOBAL_DEFAULTS = webhid.import("GLOBAL_DEFAULTS");
  const createSettingsStore = webhid.import("createSettingsStore");
  const isValidFilter = webhid.import("isValidFilter");
  delete globalThis.webhid;
  logger.initLogger("polyfill");

  let nextReqId = 0;
  const pending = {};

  const channel = new MessageChannel();
  const bridgePort = channel.port1;
  const target = window === window.top ? window : window.top;
  target.postMessage(null, "*", [channel.port2]);

  let pairedDevices = null;
  let deviceInfoCache = null;

  async function getPairedDevices() {
    if (pairedDevices !== null) return pairedDevices;
    try {
      const result = await sendRequest("getPairedDevices", {
        origin: window.location?.origin || "",
      });
      pairedDevices = result.hashes || [];
      deviceInfoCache = null;
      return pairedDevices;
    } catch {
      return [];
    }
  }

  async function getDeviceCache() {
    if (deviceInfoCache !== null) return deviceInfoCache;
    try {
      const response = await sendRequest("enumerate");
      const devices =
        http.isOk(response.s) && Array.isArray(response.D) ? response.D : [];
      deviceInfoCache = new Map();
      for (const d of devices) deviceInfoCache.set(d.deviceId, d);
      return deviceInfoCache;
    } catch {
      deviceInfoCache = new Map();
      return deviceInfoCache;
    }
  }

  async function pairDevice(deviceInfo) {
    try {
      pairedDevices = null;
      const result = await sendRequest("pairDevice", {
        origin: window.location?.origin || "",
        device: { deviceId: deviceInfo.deviceId },
      });
      if (result && result.success) {
        pairedDevices = result.hashes || [];
        deviceInfoCache = null;
      } else {
        // S5: Surface pairing failures to the log so they aren't silently
        // swallowed. requestDevice() already resolved with the device, but
        // the user should be able to see (via the addon's debug log) that
        // the pairDevice round-trip failed; subsequent getDevices() calls
        // will not return this device.
        logger.warn(
          "pairDevice returned non-success for deviceId=" +
            deviceInfo.deviceId +
            ": " +
            http.name(result?.s || 0),
        );
      }
    } catch (e) {
      // S5: Log the underlying error too. Previously this was a bare
      // `catch {}` which made pairing failures invisible to anyone trying
      // to debug "I picked a device but getDevices() is empty".
      logger.warn("pairDevice error:", e?.message || e);
    }
  }

  const defs = GLOBAL_DEFAULTS;
  const settings = createSettingsStore(defs);

  bridgePort.onmessage = (event) => {
    if (!event.data) return;
    if (event.data.type === "res") {
      const handler = pending[event.data.id];
      if (handler) {
        delete pending[event.data.id];
        handler(event.data.result);
      }
      return;
    }
    if (event.data.type === "settings") {
      settings.set(event.data.settings || {});
      return;
    }
    if (event.data.type === "evt") {
      dispatchDeviceEvent(event.data.event);
    }
  };

  function sendRequest(action, payload, opts = {}) {
    return new Promise((resolve) => {
      const id = ++nextReqId;
      // S4: Default 30s timeout so a request whose response never comes
      // back (bridge died, content-script context invalidated, page
      // navigated) does not leave the caller hanging forever. Callers
      // can override via opts.timeoutMs; pass 0 to disable. On timeout
      // we resolve with { s: 504 } so existing status-checking code
      // (http.isOk) treats it as a failure rather than a crash.
      const timeoutMs = opts.timeoutMs ?? 30000;
      let settled = false;
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          delete pending[id];
          logger.warn("sendRequest timeout: " + action + " (id=" + id + ")");
          resolve({ s: 504 });
        }, timeoutMs);
      }
      pending[id] = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        delete pending[id];
        resolve(result);
      };
      const msg = {
        type: "req",
        id,
        action,
        payload: payload || {},
      };
      const xfers = [];
      if (payload && payload.data instanceof Uint8Array) {
        xfers.push(payload.data.buffer);
      }
      bridgePort.postMessage(msg, xfers.length ? xfers : undefined);
    });
  }

  function sendFireAndForget(action, payload) {
    const msg = {
      type: "req",
      id: 0,
      action,
      payload: payload || {},
      fireAndForget: true,
    };
    const xfers = [];
    if (payload && payload.data instanceof Uint8Array) {
      xfers.push(payload.data.buffer);
    }
    bridgePort.postMessage(msg, xfers.length ? xfers : undefined);
  }

  settings.on("dataPlane", (v) => logger.info("data plane changed: " + v));
  settings.on("fireAndForget", (v) => logger.info("fire-and-forget: " + v));
  settings.on("logLevel", (v) => {
    if (logger.applyLevel) logger.applyLevel(v);
  });

  sendRequest("getSettings", {}).then((s) => {
    if (!s) return;
    settings.set(s);
    logger.info(
      "data plane: " +
        settings.dataPlane +
        " (fire-and-forget: " +
        settings.fireAndForget +
        ")",
    );
  });

  const devState = new WeakMap();
  const hidState = new WeakMap();
  const evtState = new WeakMap();
  const irState = Symbol("webhid_ir");
  const deviceRegistry = new Map();
  // S1: Hold the singleton HID instance so that connect/disconnect events
  // can be dispatched on `navigator.hid` (spec-compliant) rather than on the
  // HIDDevice itself. Per the WebHID spec, `navigator.hid.onconnect` and
  // `navigator.hid.ondisconnect` must fire for device hot-plug events.
  let hidInstance = null;

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
        return devState.get(this)?.opened ?? false;
      },
      enumerable: false,
      configurable: true,
    },
    vendorId: {
      get() {
        return devState.get(this)?.vendorId;
      },
      enumerable: false,
      configurable: true,
    },
    productId: {
      get() {
        return devState.get(this)?.productId;
      },
      enumerable: false,
      configurable: true,
    },
    productName: {
      get() {
        return devState.get(this)?.productName;
      },
      enumerable: false,
      configurable: true,
    },
    collections: {
      get() {
        return devState.get(this)?.collections;
      },
      enumerable: false,
      configurable: true,
    },
    oninputreport: {
      get() {
        return devState.get(this)?.oninputreport ?? null;
      },
      set(v) {
        const s = devState.get(this);
        if (!s) return;
        if (s.oninputreport)
          s.et.removeEventListener("inputreport", s.oninputreport);
        s.oninputreport = v;
        if (v) this.addEventListener("inputreport", v);
      },
      enumerable: false,
      configurable: true,
    },
    open: {
      value: async function () {
        const s = devState.get(this);
        if (!s) throw new DOMException("Invalid state", "InvalidStateError");
        if (s.opened)
          throw new DOMException("Device is already open", "InvalidStateError");
        // S4: Reject concurrent open() calls without exposing the opening
        // flag on the device surface (spec only defines `opened`). This
        // closes the await-gap race where two calls could both pass the
        // `s.opened` guard and both flip `opened` to true.
        if (s.opening)
          throw new DOMException("Device is already open", "InvalidStateError");
        s.opening = true;
        try {
          const response = await sendRequest("open", {
            deviceId: s.deviceId,
            reportSize: s.maxInputReportSize + 3,
          });
          if (http.isOk(response.s)) {
            const dataChannel = new MessageChannel();
            s.dataPort = dataChannel.port1;
            s.dataPort.onmessage = (ev) => onDataPortMessage(s, ev.data);
            bridgePort.postMessage(
              {
                type: "req",
                id: 0,
                action: "dataPort",
                payload: { deviceId: s.deviceId },
              },
              [dataChannel.port2],
            );
            // S3: Flip `opened` only after the data channel is fully wired.
            // Previously `s.opened = true` was set before the port was set
            // up, leaving a partial-state window where sendReport would
            // throw "data port not connected" despite opened === true.
            s.opened = true;
            logger.info("open deviceId=" + s.deviceId);
            this.dispatchEvent(new Event("open"));
            return true;
          }
          throw new Error("Open failed: " + http.name(response.s || 0));
        } catch (error) {
          throw new DOMException(error.message, "InvalidStateError");
        } finally {
          s.opening = false;
        }
      },
      enumerable: false,
      configurable: true,
      writable: true,
    },
    close: {
      value: async function () {
        const s = devState.get(this);
        if (!s) return;
        if (!s.opened) return;
        logger.debug("close deviceId=" + s.deviceId);
        try {
          const response = await sendRequest("close", { deviceId: s.deviceId });
          if (http.isOk(response.s)) {
            s.opened = false;
            // E3: Reject any still-pending sendReport / sendFeatureReport /
            // receiveFeatureReport Promises before tearing down the data port
            // so they do not dangle forever after the device is closed.
            if (s.dataPending && s.dataPending.size) {
              const err = new DOMException("Device closed", "NetworkError");
              for (const [, p] of s.dataPending) {
                try {
                  p.reject(err);
                } catch {}
              }
              s.dataPending.clear();
            }
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
      enumerable: false,
      configurable: true,
      writable: true,
    },
    sendReport: {
      value: async function (reportId, data) {
        const s = devState.get(this);
        if (!s) throw new DOMException("Invalid state", "InvalidStateError");
        if (!s.opened)
          throw new DOMException("Device is not open", "InvalidStateError");
        const view =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const buffer = view.slice();
        try {
          logger.debug(
            "sendReport reportId=" + reportId + " len=" + buffer.length,
          );
          if (!s.dataPort) throw new Error("data port not connected");
          const reqId = ++nextReqId;
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
      enumerable: false,
      configurable: true,
      writable: true,
    },
    receiveFeatureReport: {
      value: async function (reportId) {
        const s = devState.get(this);
        if (!s) throw new DOMException("Invalid state", "InvalidStateError");
        if (!s.opened)
          throw new DOMException("Device is not open", "InvalidStateError");
        try {
          if (!s.dataPort) throw new Error("data port not connected");
          const reqId = ++nextReqId;
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
      enumerable: false,
      configurable: true,
      writable: true,
    },
    sendFeatureReport: {
      value: async function (reportId, data) {
        const s = devState.get(this);
        if (!s) throw new DOMException("Invalid state", "InvalidStateError");
        if (!s.opened)
          throw new DOMException("Device is not open", "InvalidStateError");
        const view =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const buffer = view.slice();
        logger.debug(
          "sendFeatureReport reportId=" + reportId + " len=" + buffer.length,
        );
        try {
          if (!s.dataPort) throw new Error("data port not connected");
          const reqId = ++nextReqId;
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
      enumerable: false,
      configurable: true,
      writable: true,
    },
    forget: {
      value: async function () {
        const s = devState.get(this);
        if (!s) return;
        if (s.opened) await this.close();
        await sendRequest("unpairDevice", { deviceId: s.deviceId });
        // S2: Invalidate both the paired-hash cache and the device-info
        // cache so subsequent getDevices() calls reflect the unpairing.
        // Without this the device kept reappearing in getDevices() even
        // after forget() succeeded.
        pairedDevices = null;
        deviceInfoCache = null;
        deviceRegistry.delete(s.deviceId);
      },
      enumerable: false,
      configurable: true,
      writable: true,
    },
    addEventListener: {
      value: function (type, listener) {
        const s = devState.get(this);
        if (s) s.et.addEventListener(type, listener);
      },
      enumerable: false,
      configurable: true,
      writable: true,
    },
    removeEventListener: {
      value: function (type, listener) {
        const s = devState.get(this);
        if (s) s.et.removeEventListener(type, listener);
      },
      enumerable: false,
      configurable: true,
      writable: true,
    },
  });

  /**
   * Resolves a HIDDevice for a paired deviceId this page has not yet
   * materialized (e.g. first connect event of the session, before any
   * getDevices()/requestDevice() call).
   */
  async function resolvePairedDevice(deviceId) {
    deviceInfoCache = null;
    const [hashes, cache] = await Promise.all([
      getPairedDevices(),
      getDeviceCache(),
    ]);
    if (!hashes.includes(deviceId)) return null;
    const info = cache.get(deviceId);
    return info ? getOrCreateDevice(info) : null;
  }

  async function dispatchDeviceEvent(detail) {
    if (!detail) return;
    if (detail.eventType === "connect" || detail.eventType === "disconnect") {
      let dev = detail.deviceId ? deviceRegistry.get(detail.deviceId) : null;
      if (!dev && detail.eventType === "connect" && detail.deviceId) {
        try {
          dev = await resolvePairedDevice(detail.deviceId);
        } catch (e) {
          logger.warn("connect event lookup failed:", e?.message || e);
        }
      }
      if (hidInstance && dev) {
        if (detail.eventType === "disconnect") deviceInfoCache = null;
        hidInstance.dispatchEvent(
          new HIDConnectionEvent(detail.eventType, { device: dev }),
        );
        if (detail.eventType === "disconnect") {
          deviceRegistry.delete(detail.deviceId);
        }
      }
      return;
    }
    if (detail.eventType === "input_report") {
      const dev = detail.deviceId ? deviceRegistry.get(detail.deviceId) : null;
      if (dev) {
        const dataView = detail.data
          ? new DataView(
              detail.data.buffer || detail.data,
              detail.data.byteOffset || 0,
              detail.data.byteLength,
            )
          : new DataView(new ArrayBuffer(0));
        dev.dispatchEvent(
          new HIDInputReportEvent("inputreport", {
            device: dev,
            reportId: detail.reportId,
            data: dataView,
          }),
        );
      }
      return;
    }
  }

  function onDataPortMessage(s, d) {
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
        ? new DataView(
            d.data.buffer || d.data,
            d.data.byteOffset || 0,
            d.data.byteLength,
          )
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
      deviceInfoCache = null;
      const dev = s.self;
      if (dev)
        dev.dispatchEvent(
          new HIDConnectionEvent("disconnect", { device: dev }),
        );
      return;
    }
  }

  /** Recursively freezes an object and all of its own properties in place. */
  function deepFreeze(object) {
    const propNames = Reflect.ownKeys(object);

    for (const name of propNames) {
      const value = object[name];

      if ((value && typeof value === "object") || typeof value === "function") {
        deepFreeze(value);
      }
    }

    return Object.freeze(object);
  }

  function createHIDDevice(deviceInfo) {
    const obj = Object.create(HIDDevice.prototype);
    const et = new EventTarget();
    obj.dispatchEvent = et.dispatchEvent.bind(et);
    const state = {
      et: et,
      self: obj,
      deviceId: deviceInfo.deviceId,
      vendorId: deviceInfo.vendorId,
      productId: deviceInfo.productId,
      productName: deviceInfo.productName,
      collections: deepFreeze(deviceInfo.collections || []),
      opened: false,
      // S4: internal "opening" flag — NOT exposed on the HIDDevice surface
      // (spec only defines `opened`). Used to guard against concurrent
      // open() calls racing through the `await sendRequest("open", ...)`
      // gap and both flipping `opened` to true.
      opening: false,
      dataPort: null,
      dataPending: null,
      maxInputReportSize: deviceInfo.maxInputReportSize || 64,
      oninputreport: null,
    };
    devState.set(obj, state);
    return obj;
  }

  function getOrCreateDevice(deviceInfo) {
    const id = deviceInfo.deviceId;
    if (id && deviceRegistry.has(id)) return deviceRegistry.get(id);
    const dev = createHIDDevice(deviceInfo);
    if (id) deviceRegistry.set(id, dev);
    return dev;
  }

  function HIDInputReportEvent(type, init) {
    const obj = Reflect.construct(
      Event,
      [type, init],
      new.target || HIDInputReportEvent,
    );
    obj[irState] = {
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
        return this[irState]?.device;
      },
      enumerable: false,
      configurable: true,
    },
    reportId: {
      get() {
        return this[irState]?.reportId;
      },
      enumerable: false,
      configurable: true,
    },
    data: {
      get() {
        return this[irState]?.data;
      },
      enumerable: false,
      configurable: true,
    },
  });

  function HIDConnectionEvent(type, init) {
    const obj = Reflect.construct(
      Event,
      [type],
      new.target || HIDConnectionEvent,
    );
    evtState.set(obj, { device: init?.device ?? init });
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
      return evtState.get(this)?.device;
    },
    enumerable: false,
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
        logger.debug("getDevices");
        try {
          const pairedHashes = await getPairedDevices();
          const deviceCache = await getDeviceCache();
          const granted = [];
          for (const hash of pairedHashes) {
            const device = deviceCache.get(hash);
            if (device) granted.push(getOrCreateDevice(device));
          }
          logger.debug("getDevices returned " + granted.length + " device(s)");
          return granted;
        } catch (error) {
          logger.warn("getDevices error:", error);
          return [];
        }
      },
      enumerable: false,
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
        for (const filter of filters) {
          if (!isValidFilter(filter)) {
            throw new TypeError(
              "Invalid filter in HIDDeviceRequestOptions.filters",
            );
          }
        }

        let exclusionFilters = [];
        if (options.exclusionFilters !== undefined) {
          exclusionFilters = Array.isArray(options.exclusionFilters)
            ? options.exclusionFilters
            : [];
          if (exclusionFilters.length === 0) {
            throw new TypeError(
              "HIDDeviceRequestOptions.exclusionFilters must not be empty when present",
            );
          }
          for (const filter of exclusionFilters) {
            if (!isValidFilter(filter)) {
              throw new TypeError(
                "Invalid filter in HIDDeviceRequestOptions.exclusionFilters",
              );
            }
          }
        }

        logger.debug(
          "requestDevice filters=" +
            JSON.stringify(filters) +
            " exclusionFilters=" +
            JSON.stringify(exclusionFilters),
        );
        return new Promise((resolve, reject) => {
          const id = ++nextReqId;
          pending[id] = async (result) => {
            try {
              if (result.cancelled) {
                reject(new DOMException("No device selected", "NotFoundError"));
                return;
              }
              const devices = result.devices;
              if (!devices || devices.length === 0) {
                reject(new DOMException("No device selected", "NotFoundError"));
                return;
              }
              await Promise.all(devices.map((d) => pairDevice(d)));
              resolve(devices.map((d) => getOrCreateDevice(d)));
            } catch (e) {
              reject(
                new DOMException(
                  e?.message || "requestDevice failed",
                  "NetworkError",
                ),
              );
            }
          };
          bridgePort.postMessage({
            type: "req",
            id,
            action: "requestDevice",
            payload: { filters, exclusionFilters },
          });
        });
      },
      enumerable: false,
      configurable: true,
      writable: true,
    },
    addEventListener: {
      value: function (type, listener) {
        const s = hidState.get(this);
        if (s) s.et.addEventListener(type, listener);
      },
      enumerable: false,
      configurable: true,
      writable: true,
    },
    removeEventListener: {
      value: function (type, listener) {
        const s = hidState.get(this);
        if (s) s.et.removeEventListener(type, listener);
      },
      enumerable: false,
      configurable: true,
      writable: true,
    },
    onconnect: {
      get() {
        return hidState.get(this)?.onconnect ?? null;
      },
      set(v) {
        const s = hidState.get(this);
        if (!s) return;
        if (s.onconnect) s.et.removeEventListener("connect", s.onconnect);
        s.onconnect = v;
        if (v) s.et.addEventListener("connect", v);
      },
      enumerable: false,
      configurable: true,
    },
    ondisconnect: {
      get() {
        return hidState.get(this)?.ondisconnect ?? null;
      },
      set(v) {
        const s = hidState.get(this);
        if (!s) return;
        if (s.ondisconnect)
          s.et.removeEventListener("disconnect", s.ondisconnect);
        s.ondisconnect = v;
        if (v) s.et.addEventListener("disconnect", v);
      },
      enumerable: false,
      configurable: true,
    },
  });

  function createHID() {
    const obj = Object.create(HID.prototype);
    const et = new EventTarget();
    obj.dispatchEvent = et.dispatchEvent.bind(et);
    hidState.set(obj, { et: et, onconnect: null, ondisconnect: null });
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
  hidInstance = createHID();
  Object.defineProperty(Navigator.prototype, "hid", {
    get() {
      return hidInstance;
    },
    configurable: true,
    enumerable: true,
  });
})();
