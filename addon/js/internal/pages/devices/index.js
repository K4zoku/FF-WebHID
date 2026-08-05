;(async () => {
  /** @type {import("../types.js").Logger} */
  const logger = webhid.import('logger')
  const guessDeviceType = webhid.import('guessDeviceType')
  const groupDevices = webhid.import('groupDevices')
  const t = webhid.import('t')
  const localizeHTML = webhid.import('localizeHTML')
  const syncBrowserTheme = webhid.import('syncBrowserTheme')
  logger.initLogger('devices')

  syncBrowserTheme()
  if (browser.theme) browser.theme.onUpdated.addListener(syncBrowserTheme)

  localizeHTML(document)

  /** @type {number} */
  let renderToken = 0

  /**
   * @returns {Promise<Array<{origin: string, devices: Array<{deviceId: number, name: string, vendorId: number, productId: number, manufacturer: string}>}>>}
   */
  async function loadAll() {
    try {
      const resp = await browser.runtime.sendMessage({ action: 'getAllPairedDevices' })
      return resp && resp.success ? resp.origins : []
    } catch {
      return []
    }
  }

  /**
   * @param {object[]} group
   * @param {string} origin
   * @returns {HTMLElement}
   */
  function buildDeviceCard(group, origin) {
    const members = group.map((d) => d.deviceId)
    const primary = group[0]
    const name = primary.productName || t('popupUnknown')
    const type = guessDeviceType({ productName: name, vendorId: primary.vendorId })
    const vid = primary.vendorId || 0
    const pid = primary.productId || 0

    const card = document.createElement('div')
    card.className = 'device-card'

    const icon = document.createElement('img')
    icon.className = 'device-icon'
    icon.src = browser.runtime.getURL(`res/${type}.svg`)
    icon.alt = type
    card.appendChild(icon)

    const info = document.createElement('div')
    info.className = 'device-info'

    const nameEl = document.createElement('div')
    nameEl.className = 'device-name'
    nameEl.textContent = name
    info.appendChild(nameEl)

    if (primary.manufacturer) {
      const vendorEl = document.createElement('div')
      vendorEl.className = 'device-vendor'
      vendorEl.textContent = primary.manufacturer
      info.appendChild(vendorEl)
    }

    if (members.length > 1) {
      const ifaceEl = document.createElement('div')
      ifaceEl.className = 'device-vendor'
      ifaceEl.textContent = t('pickerInterfaces', [String(members.length)])
      info.appendChild(ifaceEl)
    }

    const vidEl = document.createElement('div')
    vidEl.className = 'device-vid'
    vidEl.textContent = `${vid.toString(16).padStart(4, '0')}:${pid.toString(16).padStart(4, '0')}`
    info.appendChild(vidEl)

    card.appendChild(info)

    const btn = document.createElement('button')
    btn.className = 'btn-revoke'
    btn.textContent = t('popupRevoke')
    btn.setAttribute('aria-label', t('popupRevoke') + ': ' + name)
    btn.addEventListener('click', async () => {
      try {
        await browser.runtime.sendMessage({
          action: 'revokeDevice',
          deviceIds: members,
          origin
        })
      } catch (e) {
        logger.debug('revokeDevice failed', e)
      }
      render()
    })
    card.appendChild(btn)
    return card
  }

  /** @returns {Promise<void>} */
  async function render() {
    const token = ++renderToken
    /** @type {HTMLElement} */
    const list = document.getElementById('devices-list')
    /** @type {HTMLElement} */
    const none = document.getElementById('devices-none')
    const origins = await loadAll()
    if (token !== renderToken) return

    list.innerHTML = ''
    none.hidden = origins.length > 0

    for (const { origin, devices } of origins) {
      const section = document.createElement('section')
      section.className = 'origin-section'

      const originEl = document.createElement('h2')
      originEl.className = 'origin-name'
      originEl.textContent = origin
      section.appendChild(originEl)

      const displayGroups = groupDevices(
        devices.map((d) => ({
          deviceId: Number(d.deviceId),
          productName: d.name || '',
          vendorId: d.vendorId || 0,
          productId: d.productId || 0,
          manufacturer: d.manufacturer || ''
        }))
      )

      for (const [, group] of displayGroups) {
        section.appendChild(buildDeviceCard(group, origin))
      }

      list.appendChild(section)
    }
  }

  await render()
})()
