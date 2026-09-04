;(function () {
  const webhid = globalThis.webhid
  const pristine = webhid.import('pristine')
  const { object, types } = pristine
  const NativeMap = types.Map.constructor
  const NativeString = types.String.constructor
  const mapOps = types.Map.proto.methods
  const regexpOps = types.RegExp.proto.methods
  const stringOps = types.String.proto.methods
  const hardenMap = (value) => {
    object.defineProperties(value, {
      has: { value: (key) => mapOps.has(value, key) },
      get: { value: (key) => mapOps.get(value, key) },
      set: { value: (key, item) => mapOps.set(value, key, item) }
    })
    return value
  }
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
    const name = stringOps.toLowerCase(NativeString(device.productName || ''))
    for (let i = 0; i < TYPE_PATTERNS.length; i++) {
      const pattern = TYPE_PATTERNS[i][0]
      const type = TYPE_PATTERNS[i][1]
      if (regexpOps.test(pattern, name)) return type
    }
    return 'unknown'
  }

  /**
   * @param {import("../types.js").HIDDeviceInfo[]} devices
   * @returns {Map<string, import("../types.js").HIDDeviceInfo[]>}
   */
  function groupDevices(devices) {
    const groups = hardenMap(new NativeMap())
    for (const device of devices) {
      const name = device.productName || NativeString(device.deviceId)
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
    if (object.keys(filter).length === 0) return false
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
