(function () {
  function guessDeviceType(device) {
    if (device.usagePage === 0x01) {
      const u = device.usage;
      if (u === 0x01 || u === 0x02) return "mouse";
      if (u === 0x06 || u === 0x07) return "keyboard";
      if (u === 0x04 || u === 0x08) return "joystick";
      if (u === 0x05) return "controller";
    }
    const name = (device.productName || "").toLowerCase();
    if (/mouse|trackball|trackpad|touchpad/i.test(name)) return "mouse";
    if (/keyboard|kbd/i.test(name)) return "keyboard";
    if (/joystick|flight.?stick|yoke|rudder|throttle/i.test(name))
      return "joystick";
    if (
      /gamepad|controller|xbox|playstation|dualshock|dualsense|joycon|joy.con/i.test(
        name,
      )
    )
      return "controller";
    if (/headset|headphone|earphone|\bmic(rophone)?\b|earbuds?/i.test(name))
      return "headset";
    if (/speaker|soundbar|audio|\bdac\b|amplifier/i.test(name))
      return "speaker";
    if (/webcam|camera|\bcam\b/i.test(name)) return "camera";
    return "unknown";
  }

  globalThis.__webhid = globalThis.__webhid || {};
  globalThis.__webhid.guessDeviceType = guessDeviceType;
})();
