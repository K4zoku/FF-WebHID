(function () {
  if (typeof window !== "undefined") return;

  const logger = webhid.import("logger");
  logger.initLogger("worker-polyfill");

  const devState = new WeakMap();
  const hidState = new WeakMap();
  const evtState = new WeakMap();
  const irState = Symbol("webhid_ir");
  const deviceRegistry = new Map();
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
        return devState.get(this) == null ? void 0 : devState.get(this).opened != null ? devState.get(this).opened : false;
      },
      enumerable: false,
      configurable: true,
    },
    vendorId: {
      get() {
        var dev = devState.get(this);
        return dev != null ? dev.vendorId : undefined;
      },
      enumerable: false,
      configurable: true,
    },
    productId: {
      get() {
        var dev = devState.get(this);
        return dev != null ? dev.productId : undefined;
      },
      enumerable: false,
      configurable: true,
    },
    productName: {
      get() {
        var dev = devState.get(this);
        return dev != null ? dev.productName : undefined;
      },
      enumerable: false,
      configurable: true,
    },
    collections: {
      get() {
        var dev = devState.get(this);
        return dev != null ? dev.collections : undefined;
      },
      enumerable: false,
      configurable: true,
    },
    oninputreport: {
      get() {
        return devState.get(this) == null ? void 0 : devState.get(this).oninputreport != null ? devState.get(this).oninputreport : null;
      },
      set(v) {
        const state = devState.get(this);
        if (!state) return;
        if (state.oninputreport)
          state.eventTarget.removeEventListener("inputreport", state.oninputreport);
        state.oninputreport = v;
        if (v) this.addEventListener("inputreport", v);
      },
      enumerable: false,
      configurable: true,
    },
    open: {
      value: async function () {
        throw new DOMException("Not implemented in worker", "NotSupportedError");
      },
      enumerable: false,
      configurable: true,
      writable: true,
    },
    close: {
      value: async function () {
        throw new DOMException("Not implemented in worker", "NotSupportedError");
      },
      enumerable: false,
      configurable: true,
      writable: true,
    },
    sendReport: {
      value: async function () {
        throw new DOMException("Not implemented in worker", "NotSupportedError");
      },
      enumerable: false,
      configurable: true,
      writable: true,
    },
    receiveFeatureReport: {
      value: async function () {
        throw new DOMException("Not implemented in worker", "NotSupportedError");
      },
      enumerable: false,
      configurable: true,
      writable: true,
    },
    sendFeatureReport: {
      value: async function () {
        throw new DOMException("Not implemented in worker", "NotSupportedError");
      },
      enumerable: false,
      configurable: true,
      writable: true,
    },
    forget: {
      value: async function () {
        throw new DOMException("Not implemented in worker", "NotSupportedError");
      },
      enumerable: false,
      configurable: true,
      writable: true,
    },
    addEventListener: {
      value: function (type, listener) {
        const state = devState.get(this);
        if (state) state.eventTarget.addEventListener(type, listener);
      },
      enumerable: false,
      configurable: true,
      writable: true,
    },
    removeEventListener: {
      value: function (type, listener) {
        const state = devState.get(this);
        if (state) state.eventTarget.removeEventListener(type, listener);
      },
      enumerable: false,
      configurable: true,
      writable: true,
    },
  });

  function createHIDDevice(deviceInfo) {
    const obj = Object.create(HIDDevice.prototype);
    const eventTarget = new EventTarget();
    obj.dispatchEvent = eventTarget.dispatchEvent.bind(eventTarget);
    devState.set(obj, {
      eventTarget: eventTarget,
      deviceId: deviceInfo.deviceId,
      vendorId: deviceInfo.vendorId,
      productId: deviceInfo.productId,
      productName: deviceInfo.productName,
      collections: deviceInfo.collections || [],
      opened: false,
      oninputreport: null,
    });
    return obj;
  }

  function getOrCreateDevice(deviceInfo) {
    const id = deviceInfo.deviceId;
    if (id && deviceRegistry.has(id)) return deviceRegistry.get(id);
    const device = createHIDDevice(deviceInfo);
    if (id) deviceRegistry.set(id, device);
    return device;
  }

  function HIDInputReportEvent(type, init) {
    const obj = Reflect.construct(
      Event,
      [type, init],
      new.target || HIDInputReportEvent,
    );
    obj[irState] = {
      device: init != null ? init.device : undefined,
      reportId: init != null ? init.reportId : undefined,
      data: init != null ? init.data : undefined,
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
        var st = this[irState];
        return st != null ? st.device : undefined;
      },
      enumerable: false,
      configurable: true,
    },
    reportId: {
      get() {
        var st = this[irState];
        return st != null ? st.reportId : undefined;
      },
      enumerable: false,
      configurable: true,
    },
    data: {
      get() {
        var st = this[irState];
        return st != null ? st.data : undefined;
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
    evtState.set(obj, { device: init == null ? void 0 : init.device != null ? init.device : init });
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
      var st = evtState.get(this);
      return st != null ? st.device : undefined;
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
        throw new DOMException("Not implemented in worker", "NotSupportedError");
      },
      enumerable: false,
      configurable: true,
      writable: true,
    },
    requestDevice: {
      value: async function () {
        throw new DOMException("Not implemented in worker", "NotSupportedError");
      },
      enumerable: false,
      configurable: true,
      writable: true,
    },
    addEventListener: {
      value: function (type, listener) {
        const state = hidState.get(this);
        if (state) state.eventTarget.addEventListener(type, listener);
      },
      enumerable: false,
      configurable: true,
      writable: true,
    },
    removeEventListener: {
      value: function (type, listener) {
        const state = hidState.get(this);
        if (state) state.eventTarget.removeEventListener(type, listener);
      },
      enumerable: false,
      configurable: true,
      writable: true,
    },
    onconnect: {
      get() {
        return hidState.get(this) == null ? void 0 : hidState.get(this).onconnect != null ? hidState.get(this).onconnect : null;
      },
      set(v) {
        const state = hidState.get(this);
        if (!state) return;
        if (state.onconnect)
          state.eventTarget.removeEventListener("connect", state.onconnect);
        state.onconnect = v;
        if (v) state.eventTarget.addEventListener("connect", v);
      },
      enumerable: false,
      configurable: true,
    },
    ondisconnect: {
      get() {
        return hidState.get(this) == null ? void 0 : hidState.get(this).ondisconnect != null ? hidState.get(this).ondisconnect : null;
      },
      set(v) {
        const state = hidState.get(this);
        if (!state) return;
        if (state.ondisconnect)
          state.eventTarget.removeEventListener("disconnect", state.ondisconnect);
        state.ondisconnect = v;
        if (v) state.eventTarget.addEventListener("disconnect", v);
      },
      enumerable: false,
      configurable: true,
    },
  });

  function createHID() {
    const obj = Object.create(HID.prototype);
    const eventTarget = new EventTarget();
    obj.dispatchEvent = eventTarget.dispatchEvent.bind(eventTarget);
    hidState.set(obj, {
      eventTarget: eventTarget,
      onconnect: null,
      ondisconnect: null,
    });
    return obj;
  }

  Object.defineProperty(self, "HID", {
    value: HID,
    writable: false,
    configurable: true,
    enumerable: false,
  });
  Object.defineProperty(self, "HIDDevice", {
    value: HIDDevice,
    writable: false,
    configurable: true,
    enumerable: false,
  });
  Object.defineProperty(self, "HIDInputReportEvent", {
    value: HIDInputReportEvent,
    writable: false,
    configurable: true,
    enumerable: false,
  });
  Object.defineProperty(self, "HIDConnectionEvent", {
    value: HIDConnectionEvent,
    writable: false,
    configurable: true,
    enumerable: false,
  });
  hidInstance = createHID();
  const navProto = Object.getPrototypeOf(self.navigator);
  Object.defineProperty(navProto, "hid", {
    get() {
      return hidInstance;
    },
    configurable: true,
    enumerable: true,
  });
})();
