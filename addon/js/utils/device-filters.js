;(function () {
  /** @type {Array<[RegExp, string]>} */
  const TYPE_PATTERNS = [
    [/mouse|trackball|trackpad|touchpad/i, 'mouse'],
    [/keyboard|kbd/i, 'keyboard'],
    [/joystick|flight.?stick|yoke|rudder|throttle/i, 'joystick'],
    [/gamepad|controller|xbox|playstation|dualshock|dualsense|joycon|joy.con/i, 'controller'],
    [/headset|headphone|earphone|\bmic(rophone)?\b|earbuds?/i, 'headset'],
    [/speaker|soundbar|audio|\bdac\b|amplifier/i, 'speaker'],
    [/webcam|camera|\bcam\b/i, 'camera']
  ]

  /**
   * @param {import("../types.js").HIDDeviceInfo} device
   * @returns {string}
   */
  function guessDeviceType(device) {
    if (device.usagePage === 0x01) {
      const u = device.usage
      if (u === 0x01 || u === 0x02) return 'mouse'
      if (u === 0x06 || u === 0x07) return 'keyboard'
      if (u === 0x04 || u === 0x08) return 'joystick'
      if (u === 0x05) return 'controller'
    }
    const name = (device.productName || '').toLowerCase()
    for (const [pattern, type] of TYPE_PATTERNS) {
      if (pattern.test(name)) return type
    }
    return 'unknown'
  }

  /**
   * @param {import("../types.js").HIDDeviceInfo[]} devices
   * @returns {Map<string, import("../types.js").HIDDeviceInfo[]>}
   */
  function groupDevices(devices) {
    const groups = new Map()
    for (const device of devices) {
      const name = device.productName || String(device.deviceId)
      if (!groups.has(name)) groups.set(name, [])
      groups.get(name).push(device)
    }
    return groups
  }

  /**
   * @param {import("../types.js").HIDDeviceFilter} filter
   * @returns {boolean}
   */
  function isValidFilter(filter) {
    if (!filter || typeof filter !== 'object') return false
    if (Object.keys(filter).length === 0) return false
    if ('productId' in filter && !('vendorId' in filter)) return false
    if ('usage' in filter && !('usagePage' in filter)) return false
    return true
  }

  /**
   * @param {import("../types.js").HIDDeviceInfo[]} devs
   * @returns {string}
   */
  function groupIdFor(devs) {
    return devs.length === 1 ? devs[0].deviceId : 'group:' + devs[0].deviceId
  }

  webhid.export('guessDeviceType', guessDeviceType)
  webhid.export('groupDevices', groupDevices)
  webhid.export('groupIdFor', groupIdFor)
  webhid.export('isValidFilter', isValidFilter)
})()
