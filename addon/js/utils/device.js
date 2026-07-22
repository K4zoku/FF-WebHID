(function () {
  const webhid = globalThis.webhid;
  const _svgCache = {};

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

  function applyFilters(devices, filters) {
    if (!Array.isArray(filters) || filters.length === 0) return devices;
    return devices.filter((device) =>
      filters.some((filter) => {
        if (
          filter.vendorId !== undefined &&
          device.vendorId !== filter.vendorId
        )
          return false;
        if (
          filter.productId !== undefined &&
          device.productId !== filter.productId
        )
          return false;

        if (filter.usagePage !== undefined) {
          let pageMatch = false;
          const collections = device.collections || [];
          for (const collection of collections) {
            if (collection.usagePage !== filter.usagePage) continue;
            if (filter.usage !== undefined && collection.usage !== filter.usage)
              continue;
            pageMatch = true;
            break;
          }
          if (!pageMatch) return false;
        } else if (filter.usage !== undefined) {
          let usageMatch = false;
          const collections = device.collections || [];
          for (const collection of collections) {
            if (collection.usage === filter.usage) {
              usageMatch = true;
              break;
            }
          }
          if (!usageMatch) return false;
        }
        return true;
      }),
    );
  }

  function groupDevices(devices) {
    const groups = new Map();
    for (const device of devices) {
      const name = device.productName || "Unknown Device";
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(device);
    }
    return groups;
  }

  async function fetchDeviceIcon(type) {
    if (_svgCache[type]) return _svgCache[type];
    try {
      const svg = await webhid.import("fetchResource")(
        "res/" + type + ".svg",
      );
      _svgCache[type] = svg;
      return svg;
    } catch {
      return null;
    }
  }

  webhid.export("guessDeviceType", guessDeviceType);
  webhid.export("applyFilters", applyFilters);
  webhid.export("groupDevices", groupDevices);
  webhid.export("fetchDeviceIcon", fetchDeviceIcon);
})();
