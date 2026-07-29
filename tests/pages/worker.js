async function tryCatch(fn) {
  try {
    await fn();
    return { ok: true };
  } catch (e) {
    return { ok: false, name: e.name, message: e.message };
  }
}

(async function () {
  var result = {
    hasNavigatorHid: typeof navigator !== 'undefined' && 'hid' in navigator,
    hasHID: typeof self.HID === 'function',
    hasHIDDevice: typeof self.HIDDevice === 'function',
    hasHIDInputReportEvent: typeof self.HIDInputReportEvent === 'function',
    hasHIDConnectionEvent: typeof self.HIDConnectionEvent === 'function',
    hidToStringTag: typeof navigator !== 'undefined' && navigator.hid ? Object.prototype.toString.call(navigator.hid) : 'undefined',
    getDevicesResult: typeof navigator.hid.getDevices === 'function' ? { ok: true } : { ok: false },
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
