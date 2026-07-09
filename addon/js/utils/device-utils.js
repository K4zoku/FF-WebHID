(function () {
function createDeviceHash(device) {
  const vendorId = String(device.vendor_id || 0);
  const productId = String(device.product_id || 0);
  const serialNumber = String(device.serial_number || "");
  const deviceId = String(device.device_id || "");
  const identifier = vendorId + ":" + productId + ":" + serialNumber + ":" + deviceId;
  let hash = 5381;
  for (let i = 0; i < identifier.length; i++) {
    hash = ((hash << 5) + hash) + identifier.charCodeAt(i);
    hash = hash & 0xFFFFFFFF;
  }
  return Math.abs(hash).toString(16);
}

function guessDeviceType(device) {
  if (device.usage_page === 0x01) {
    const u = device.usage;
    if (u === 0x01 || u === 0x02) return "mouse";
    if (u === 0x06 || u === 0x07) return "keyboard";
    if (u === 0x04 || u === 0x08) return "joystick";
    if (u === 0x05) return "controller";
  }
  const name = (device.product_name || "").toLowerCase();
  if (/mouse|trackball|trackpad|touchpad/i.test(name))                         return "mouse";
  if (/keyboard|kbd/i.test(name))                                              return "keyboard";
  if (/joystick|flight.?stick|yoke|rudder|throttle/i.test(name))              return "joystick";
  if (/gamepad|controller|xbox|playstation|dualshock|dualsense|joycon|joy.con/i.test(name)) return "controller";
  if (/headset|headphone|earphone|\bmic(rophone)?\b|earbuds?/i.test(name))    return "headset";
  if (/speaker|soundbar|audio|\bdac\b|amplifier/i.test(name))                 return "speaker";
  if (/webcam|camera|\bcam\b/i.test(name))                                    return "camera";
  return "unknown";
}

if (typeof self !== 'undefined') { self.__webhid = self.__webhid || {}; self.__webhid.createDeviceHash = createDeviceHash; self.__webhid.guessDeviceType = guessDeviceType; }
if (typeof window !== 'undefined') { window.__webhid = window.__webhid || {}; window.__webhid.createDeviceHash = createDeviceHash; window.__webhid.guessDeviceType = guessDeviceType; }
if (typeof module !== 'undefined' && module.exports) module.exports = { createDeviceHash, guessDeviceType };
})();
