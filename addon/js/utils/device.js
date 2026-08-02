(function () {
  const webhid = globalThis.webhid
  /** @type {import("../types.js").Logger} */
  const logger = webhid.import('logger')
  /** @type {{[key: string]: string}} */
  const svgCache = {}

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
    if (/mouse|trackball|trackpad|touchpad/i.test(name)) return 'mouse'
    if (/keyboard|kbd/i.test(name)) return 'keyboard'
    if (/joystick|flight.?stick|yoke|rudder|throttle/i.test(name)) return 'joystick'
    if (/gamepad|controller|xbox|playstation|dualshock|dualsense|joycon|joy.con/i.test(name))
      return 'controller'
    if (/headset|headphone|earphone|\bmic(rophone)?\b|earbuds?/i.test(name)) return 'headset'
    if (/speaker|soundbar|audio|\bdac\b|amplifier/i.test(name)) return 'speaker'
    if (/webcam|camera|\bcam\b/i.test(name)) return 'camera'
    return 'unknown'
  }

  /**
   * @param {import("../types.js").HIDDeviceInfo} device
   * @param {import("../types.js").HIDDeviceFilter} filter
   * @returns {boolean}
   */
  function deviceMatchesFilter(device, filter) {
    if (filter.vendorId !== undefined && device.vendorId !== filter.vendorId) return false
    if (filter.productId !== undefined && device.productId !== filter.productId) return false

    if (filter.usagePage !== undefined) {
      let pageMatch = false
      const collections = device.collections || []
      for (const collection of collections) {
        if (collection.usagePage !== filter.usagePage) continue
        if (filter.usage !== undefined && collection.usage !== filter.usage) continue
        pageMatch = true
        break
      }
      if (!pageMatch) return false
    } else if (filter.usage !== undefined) {
      let usageMatch = false
      const collections = device.collections || []
      for (const collection of collections) {
        if (collection.usage === filter.usage) {
          usageMatch = true
          break
        }
      }
      if (!usageMatch) return false
    }
    return true
  }

  /**
   * @param {import("../types.js").HIDDeviceInfo[]} devices
   * @param {import("../types.js").HIDDeviceFilter[]} [filters]
   * @param {import("../types.js").HIDDeviceFilter[]} [exclusionFilters]
   * @returns {import("../types.js").HIDDeviceInfo[]}
   */
  function applyFilters(devices, filters, exclusionFilters) {
    let result = devices
    if (Array.isArray(filters) && filters.length > 0) {
      result = result.filter((device) =>
        filters.some((filter) => deviceMatchesFilter(device, filter))
      )
    }
    if (Array.isArray(exclusionFilters) && exclusionFilters.length > 0) {
      result = result.filter(
        (device) => !exclusionFilters.some((filter) => deviceMatchesFilter(device, filter))
      )
    }
    return result
  }

  /**
   * @param {import("../types.js").HIDDeviceInfo[]} devices
   * @returns {Map<string, import("../types.js").HIDDeviceInfo[]>}
   */
  function groupDevices(devices) {
    const groups = new Map()
    for (const device of devices) {
      const name = device.productName || 'Unknown Device'
      if (!groups.has(name)) groups.set(name, [])
      groups.get(name).push(device)
    }
    return groups
  }

  /**
   * @param {string} type
   * @returns {Promise<string|null>}
   */
  async function fetchDeviceIcon(type) {
    if (svgCache[type]) return svgCache[type]
    try {
      const svg = await webhid.import('fetchResource')('res/' + type + '.svg')
      svgCache[type] = svg
      return svg
    } catch (e) {
      logger.debug('fetchDeviceIcon failed', e)
      return null
    }
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
   * @param {import("../types.js").HIDDeviceInfo[]} allDevices
   * @param {number} matchCount
   * @param {import("../types.js").HIDDeviceFilter[]} [filters]
   * @param {Element} containerEl
   * @returns {boolean}
   */
  function logExcludedDevices(allDevices, matchCount, filters, containerEl) {
    if (matchCount > 0) return false
    logger.warn(
      'picker: 0/' + allDevices.length + ' devices matched filters=' + JSON.stringify(filters || [])
    )
    for (const d of allDevices) {
      const vidHex = '0x' + (d.vendorId || 0).toString(16).padStart(4, '0')
      const pidHex = '0x' + (d.productId || 0).toString(16).padStart(4, '0')
      const upHex = '0x' + (d.usagePage || 0).toString(16).padStart(4, '0')
      logger.warn(
        '  excluded: ' +
          (d.productName || '(unnamed)') +
          ' VID=' +
          vidHex +
          ' PID=' +
          pidHex +
          ' usagePage=' +
          upHex +
          ' usage=' +
          (d.usage || 0)
      )
    }
    const msg = document.createElement('div')
    msg.className = 'webhid-no-devices'
    msg.setAttribute('role', 'status')
    msg.textContent = webhid.import('t')('pickerNoMatch')
    containerEl.replaceChildren(msg)
    return true
  }

  /**
   * @param {Element} iconSpan
   * @param {string} type
   * @returns {void}
   */
  function applyDeviceIcon(iconSpan, type) {
    fetchDeviceIcon(type).then((svg) => {
      if (svg) {
        const svgDoc = new DOMParser().parseFromString(svg, 'image/svg+xml')
        const svgEl = svgDoc.documentElement
        if (svgEl) iconSpan.replaceChildren(svgEl.cloneNode(true))
      }
    })
  }

  webhid.export('guessDeviceType', guessDeviceType)
  webhid.export('applyFilters', applyFilters)
  webhid.export('groupDevices', groupDevices)
  webhid.export('fetchDeviceIcon', fetchDeviceIcon)
  webhid.export('isValidFilter', isValidFilter)
  webhid.export('logExcludedDevices', logExcludedDevices)
  webhid.export('applyDeviceIcon', applyDeviceIcon)
})()
