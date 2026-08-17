;(function () {
  const webhid = globalThis.webhid
  /** @type {import("../types.js").Logger} */
  const logger = webhid.import('logger')
  /** @type {{[key: string]: string}} */
  const svgCache = {}

  const guessDeviceType = webhid.import('guessDeviceType')
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
  webhid.export('groupDevices', groupDevices)
  webhid.export('groupIdFor', groupIdFor)
  webhid.export('isValidFilter', isValidFilter)
  webhid.export('applyDeviceIcon', applyDeviceIcon)
})()
