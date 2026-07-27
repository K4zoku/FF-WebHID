"use strict";
var strictMode = (function () {
  try { undeclaredVar = 1; return false; } catch (e) { return true; }
})();
self.postMessage({
  strictMode: strictMode,
  hasNavigatorHid: typeof navigator !== 'undefined' && 'hid' in navigator,
  hasHID: typeof self.HID === 'function',
});
