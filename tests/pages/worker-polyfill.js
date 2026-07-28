async function tryCatch(fn) {
  try {
    await fn();
    return { ok: true };
  } catch (e) {
    return { ok: false, name: e.name, message: e.message };
  }
}

// Self-init the polyfill bridge port with a mock bridge
var initChannel = new MessageChannel();
self.dispatchEvent(new MessageEvent('message', {
  data: { type: 'webhid-init' },
  ports: [initChannel.port1],
}));

// Mock bridge handler
initChannel.port2.onmessage = function (event) {
  if (!event.data || !event.data.id) return;
  if (event.data.action === 'getPolicy') {
    initChannel.port2.postMessage({
      type: 'response', id: event.data.id, result: { hid: 'allowed' },
    });
  } else if (event.data.action === 'getPairedDevices') {
    initChannel.port2.postMessage({
      type: 'response', id: event.data.id, result: { hashes: [] },
    });
  } else if (event.data.action === 'enumerate') {
    initChannel.port2.postMessage({
      type: 'response', id: event.data.id, result: { s: 200, D: [] },
    });
  } else if (event.data.action === 'getSettings') {
    initChannel.port2.postMessage({
      type: 'response', id: event.data.id, result: { dataPlane: 'ws', logLevel: 1 },
    });
  } else {
    initChannel.port2.postMessage({
      type: 'response', id: event.data.id, result: { s: 200 },
    });
  }
};

(async function () {
  var result = {
    hasNavigatorHid: typeof navigator !== 'undefined' && 'hid' in navigator,
    hasHID: typeof self.HID === 'function',
    hasHIDDevice: typeof self.HIDDevice === 'function',
    hasHIDInputReportEvent: typeof self.HIDInputReportEvent === 'function',
    hasHIDConnectionEvent: typeof self.HIDConnectionEvent === 'function',
    hidToStringTag: Object.prototype.toString.call(navigator.hid),
    getDevicesResult: await tryCatch(function () { return navigator.hid.getDevices(); }),
    requestDeviceError: await tryCatch(function () { return navigator.hid.requestDevice(); }),
  };

  try {
    new self.HID();
    result.illegalConstructor = { ok: true };
  } catch (e) {
    result.illegalConstructor = { ok: false, name: e.name, message: e.message };
  }

  self.postMessage(result);
})();
