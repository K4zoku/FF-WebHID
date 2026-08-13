;(function () {
  const webhid = globalThis.webhid
  /** @type {import("../types.js").Logger} */
  const logger = webhid.import('logger')
  /** @type {{[key: string]: string}} */
  const svgCache = {}

  const guessDeviceType = webhid.import('guessDeviceType')
  const applyFilters = webhid.import('applyFilters')
  const groupDevices = webhid.import('groupDevices')
  const groupIdFor = webhid.import('groupIdFor')
  const isValidFilter = webhid.import('isValidFilter')

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
  webhid.export('groupIdFor', groupIdFor)
  webhid.export('isValidFilter', isValidFilter)
  webhid.export('logExcludedDevices', logExcludedDevices)
  webhid.export('applyDeviceIcon', applyDeviceIcon)
})()
