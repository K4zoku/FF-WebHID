;(async () => {
  /** @type {import("../types.js").Logger} */
  const logger = webhid.import('logger')
  const guessDeviceType = webhid.import('guessDeviceType')
  const groupDevices = webhid.import('groupDevices')
  const t = webhid.import('t')
  const localizeHTML = webhid.import('localizeHTML')
  const loadGlobalSettings = webhid.import('loadGlobalSettings')
  const loadEffectiveSettings = webhid.import('loadEffectiveSettings')
  const GLOBAL_DEFAULTS = webhid.import('GLOBAL_DEFAULTS')
  const settingsUi = webhid.import('settingsUi')
  const saveSiteSetting = webhid.import('saveSiteSetting')
  const syncBrowserTheme = webhid.import('syncBrowserTheme')
  const initInfoPopovers = webhid.import('initInfoPopovers')
  logger.initLogger('popup')

  syncBrowserTheme()
  if (browser.theme) browser.theme.onUpdated.addListener(syncBrowserTheme)

  localizeHTML(document)
  initInfoPopovers(document)
  const globalSettings = await loadGlobalSettings()

  /** @type {object|undefined} */
  let tab
  /** @type {string} */
  let origin = ''

  /**
   * Resolves the active tab and its http(s) origin. When the popup itself is
   * open as a tab in its own window (dev/testing), the active tab of its
   * window is itself; fall back to the active page tab of any window. The
   * real action popup is not a tab, so this branch never runs there.
   * @returns {Promise<{tab: object|undefined, origin: string}>}
   */
  async function resolveActiveTab() {
    let [t] = await browser.tabs.query({ active: true, currentWindow: true })
    if (t && t.url && t.url.startsWith(browser.runtime.getURL(''))) {
      const all = await browser.tabs.query({ active: true })
      t = all.find((x) => x.url && x.url.startsWith('http')) || t
    }
    let o = ''
    if (t && t.url) {
      try {
        const url = new URL(t.url)
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          o = url.origin
        }
      } catch (e) {
        logger.debug('URL parse failed', e)
      }
    }
    return { tab: t, origin: o }
  }

  /** @type {HTMLElement} */
  const siteButton = document.getElementById('site-name')
  /** @type {HTMLElement} */
  const siteLabel = document.getElementById('site-name-text')
  /** @type {HTMLElement} */
  const originList = document.getElementById('origin-list')

  /**
   * Collects every distinct http(s) origin in the tab from the bridge's page
   * ports, top-level first. Frames that never run the polyfill are absent.
   * @returns {Promise<string[]>}
   */
  async function loadFrameOrigins() {
    if (!tab || tab.id == null) return origin ? [origin] : []
    try {
      const resp = await browser.runtime.sendMessage({
        action: 'getFrameOrigins',
        tabId: tab.id
      })
      const origins = (resp && resp.origins) || []
      return origins.length ? origins : origin ? [origin] : []
    } catch (e) {
      logger.debug('getFrameOrigins failed', e)
      return origin ? [origin] : []
    }
  }

  /** @type {string[]} */
  let frameOrigins = []

  /**
   * Renders the selected origin on the dropdown button and closes the list.
   * @returns {void}
   */
  function renderSiteLabel() {
    siteLabel.textContent = origin || t('popupNoSite')
    siteButton.classList.toggle('has-list', frameOrigins.length > 1)
    siteButton.setAttribute('aria-expanded', 'false')
    originList.hidden = true
  }

  /**
   * @returns {void}
   */
  function openOriginList() {
    if (frameOrigins.length < 2) return
    for (const li of originList.children) {
      const selected = li.dataset.origin === origin
      li.classList.toggle('selected', selected)
      li.setAttribute('aria-selected', String(selected))
    }
    originList.hidden = false
    siteButton.setAttribute('aria-expanded', 'true')
  }

  /**
   * @returns {void}
   */
  function closeOriginList() {
    originList.hidden = true
    siteButton.setAttribute('aria-expanded', 'false')
  }

  /**
   * Switches the origin the popup operates on and re-renders for it.
   * @param {string} o
   * @returns {Promise<void>}
   */
  async function selectOrigin(o) {
    if (o === origin || !frameOrigins.includes(o)) return
    origin = o
    renderSiteLabel()
    settings = await loadSettings()
    applySettingsToUI()
    renderDevices()
    refreshStatus()
  }

  /**
   * Rebuilds the dropdown options for the current frameOrigins.
   * @returns {void}
   */
  function buildOriginList() {
    originList.textContent = ''
    for (const o of frameOrigins) {
      const li = document.createElement('li')
      li.className = 'origin-picker-option'
      li.setAttribute('role', 'option')
      li.setAttribute('tabindex', '-1')
      li.dataset.origin = o
      li.textContent = o
      li.addEventListener('click', () => selectOrigin(o))
      originList.appendChild(li)
    }
    renderSiteLabel()
  }

  /**
   * Wires dropdown interactions once; the option list is rebuilt per tab.
   * @returns {void}
   */
  function wireOriginPicker() {
    siteButton.addEventListener('click', (e) => {
      e.stopPropagation()
      if (originList.hidden) openOriginList()
      else closeOriginList()
    })
    siteButton.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault()
        openOriginList()
      } else if (e.key === 'Escape') {
        closeOriginList()
      }
    })
    originList.addEventListener('keydown', (e) => {
      const items = [...originList.children]
      const idx = items.findIndex((li) => li.dataset.origin === origin)
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const next = (idx + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length
        items[next].focus()
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        const li = e.target.closest('li')
        if (li) selectOrigin(li.dataset.origin)
      } else if (e.key === 'Escape') {
        closeOriginList()
        siteButton.focus()
      }
    })
    document.addEventListener('click', (e) => {
      if (!siteButton.contains(e.target) && !originList.contains(e.target)) closeOriginList()
    })
  }

  /** @type {number} */
  let refreshToken = 0
  /**
   * Re-targets the popup at the active tab: re-resolves the tab and origin,
   * rebuilds the origin list, and re-applies settings, devices, and status.
   * @returns {Promise<void>}
   */
  async function refreshForActiveTab() {
    const token = ++refreshToken
    const resolved = await resolveActiveTab()
    if (token !== refreshToken) return
    tab = resolved.tab
    origin = resolved.origin
    siteLabel.textContent = origin || t('popupNoSite')
    frameOrigins = await loadFrameOrigins()
    if (token !== refreshToken) return
    buildOriginList()
    settings = await loadSettings()
    if (token !== refreshToken) return
    applySettingsToUI()
    renderDevices()
    refreshStatus()
  }

  /**
   * Loads global and site settings, merging site overrides on top of global defaults.
   * @returns {Promise<object>}
   */
  async function loadSettings() {
    return loadEffectiveSettings(origin)
  }

  /**
   * Saves a single site-level setting.
   * @param {string} key
   * @param {any} value
   * @returns {Promise<void>}
   */
  async function saveSetting(key, value) {
    if (!origin) return
    await saveSiteSetting(origin, key, value)
  }

  let settings

  const viewDevices = document.getElementById('view-devices')
  const viewSettings = document.getElementById('view-settings')
  const btnSettings = document.getElementById('btn-settings')
  const startsInSettings = window.location.hash === '#settings' && !globalSettings.hidePageAction
  viewDevices.hidden = startsInSettings
  viewSettings.hidden = !startsInSettings
  btnSettings.classList.toggle('active', startsInSettings)

  btnSettings.addEventListener('click', () => {
    const open = viewSettings.hidden
    viewDevices.hidden = open
    viewSettings.hidden = !open
    btnSettings.classList.toggle('active', open)
  })

  /**
   * Applies the merged settings for the selected origin to the form controls.
   * @returns {void}
   */
  function applySettingsToUI() {
    applyPlaneRadios(settings, GLOBAL_DEFAULTS)
    /** @type {HTMLInputElement} */
    document.getElementById('workerPolyfillEnabled').checked =
      settings.workerPolyfillEnabled || false
    /** @type {HTMLInputElement} */
    document.getElementById('allowActivationlessRequestDevice').checked =
      settings.allowActivationlessRequestDevice || false
    refreshPlaneVisibility()
  }

  /** Applies plane visibility. */
  function refreshPlaneVisibility() {
    updatePlaneVisibility()
  }

  const { applyPlaneRadios, updatePlaneVisibility, saveDataPlane, bindRadioGroup } =
    settingsUi.createSettingsUi(saveSetting, () => refreshStatus())

  bindRadioGroup('devicePickerMode')
  bindRadioGroup('workerSpawnMode')
  bindRadioGroup('logLevel', (v) => parseInt(v, 10))

  document.querySelectorAll('input[name="dataPlane"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return
      saveDataPlane(radio.value)
      refreshPlaneVisibility()
      refreshStatus()
    })
  })
  document.getElementById('workerPolyfillEnabled').addEventListener('change', (e) => {
    saveSetting('workerPolyfillEnabled', e.target.checked)
  })
  document.getElementById('allowActivationlessRequestDevice').addEventListener('change', (e) => {
    saveSetting('allowActivationlessRequestDevice', e.target.checked)
  })

  /** @type {boolean} */
  let isMac = false
  /** @type {number} */
  let hidPermission = 2
  /** @returns {void} */
  function updateMacLink() {
    document.getElementById('mac-privacy').hidden = !(isMac && hidPermission === 1)
  }
  if (browser.runtime && browser.runtime.getPlatformInfo) {
    browser.runtime
      .getPlatformInfo()
      .then((info) => {
        isMac = info.os === 'mac'
        updateMacLink()
      })
      .catch(() => {})
  }

  /**
   * The plane the configured settings call for.
   * @returns {{plane: string, mode: (string|null)}}
   */
  function expectedPlane() {
    const dp = settings.dataPlane
    if (dp === 'nm') return { plane: 'nm', mode: null }
    if (dp === 'ws') return { plane: 'ws', mode: 'worker' }
    if (settings.useWorker === false) return { plane: 'wt', mode: 'inpage' }
    return { plane: 'wt', mode: 'worker' }
  }

  /**
   * @param {{plane: string, mode: (string|null)}} a
   * @param {{plane: string, mode: (string|null)}} b
   * @returns {boolean}
   */
  function samePlane(a, b) {
    return a.plane === b.plane && (a.mode || null) === (b.mode || null)
  }

  /**
   * Layers (worst state wins): daemon/NM unreachable -> red; any active plane
   * deviating from the configured default -> yellow; healthy -> green.
   * @returns {Promise<void>}
   */
  async function refreshStatus() {
    const status = document.getElementById('status')
    const text = document.getElementById('status-text')
    status.classList.remove('state-ok', 'state-warn', 'state-error')
    let backend = null
    try {
      backend = await browser.runtime.sendMessage({ action: 'getBackendStatus' })
    } catch (e) {
      logger.debug('getBackendStatus failed', e)
    }
    /** @type {Array<{deviceId: string, plane: string, mode: (string|null)}>} */
    let planes = []
    if (origin && tab && tab.id != null) {
      try {
        const r = await browser.tabs.sendMessage(tab.id, {
          action: 'getDataPlaneStatus',
          origin
        })
        planes = (r && r.planes) || []
      } catch (e) {
        logger.debug('getDataPlaneStatus failed', e)
      }
    }
    if (!backend || !backend.nmConnected || !backend.daemonReachable) {
      hidPermission = 2
      status.classList.add('state-error')
      text.textContent = t('statusOffline')
      status.title = t('statusOfflineGuidance')
      updateMacLink()
      return
    }
    hidPermission = typeof backend.hidPermission === 'number' ? backend.hidPermission : 2
    updateMacLink()
    status.title = ''
    const expected = expectedPlane()
    const fallbacks = planes.filter((p) => !samePlane(p, expected))
    if (fallbacks.length > 0) {
      status.classList.add('state-warn')
      const names = [
        ...new Set(fallbacks.map((p) => t('planeName' + String(p.plane).toUpperCase())))
      ]
      text.textContent = t('statusFallback', [names.join(', ')])
    } else {
      status.classList.add('state-ok')
      text.textContent = t('statusReady')
    }
  }

  /** @returns {Promise<string[]>} */
  async function loadDevices() {
    if (!origin) return []
    try {
      const resp = await browser.runtime.sendMessage({
        action: 'getPairedDevices',
        origin
      })
      return resp && resp.success ? resp.hashes : []
    } catch {
      return []
    }
  }

  /**
   * @param {number[]} deviceIds
   * @returns {Promise<void>}
   */
  async function removeDevice(deviceIds) {
    if (!origin || !deviceIds || !deviceIds.length) return
    try {
      await browser.runtime.sendMessage({
        action: 'revokeDevice',
        deviceIds,
        origin
      })
    } catch (e) {
      logger.debug('revokeDevice failed', e)
    }
    renderDevices()
    refreshStatus()
  }

  /**
   * Resolves device info for every paired device, preferring the enumerate
   * cache and falling back to per-device lookups.
   * @param {string[]} hashes
   * @param {import("../types.js").HIDDeviceInfo[]} cache
   * @returns {Promise<Map<number, import("../types.js").HIDDeviceInfo>>}
   */
  async function loadDeviceInfo(hashes, cache) {
    /** @type {Map<number, import("../types.js").HIDDeviceInfo>} */
    const infoByHash = new Map()
    for (const hash of hashes) {
      const id = Number(hash)
      let device = cache.find((d) => d.deviceId === id)
      if (!device) {
        try {
          const r = await browser.runtime.sendMessage({
            action: 'getDeviceInfo',
            deviceId: id
          })
          device = r != null && r.device != null ? r.device : null
        } catch (e) {
          logger.debug('getDeviceInfo failed', e)
        }
      }
      if (device) infoByHash.set(id, device)
    }
    return infoByHash
  }

  /**
   * Builds one device card for a display group (all interfaces of one device).
   * @param {number[]} members
   * @param {Map<number, import("../types.js").HIDDeviceInfo>} infoByHash
   * @param {Set<number>} openIds
   * @param {import("../types.js").HIDDeviceInfo[]} cache
   * @returns {{card: HTMLElement, open: boolean}}
   */
  function buildDeviceCard(members, infoByHash, openIds, cache) {
    const primary = members[0]
    /** @type {import("../types.js").HIDDeviceInfo|undefined} */
    const device = infoByHash.get(primary)
    const present = members.some((id) => cache.some((d) => d.deviceId === id))
    const isDisconnected = !present
    const cardOpen = present && members.some((id) => openIds.has(id))
    const name = device ? device.productName || t('popupUnknown') : t('popupPairedDevice')
    const type = guessDeviceType(device || { productName: name })
    const vid = device ? device.vendorId || 0 : 0
    const pid = device ? device.productId || 0 : 0
    const manufacturer = device ? device.manufacturer || '' : ''

    const card = document.createElement('div')
    card.className = 'device-card'
    card.setAttribute('role', 'listitem')
    if (isDisconnected) card.classList.add('disconnected')
    if (cardOpen) card.classList.add('open')

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

    if (manufacturer) {
      const vendorEl = document.createElement('div')
      vendorEl.className = 'device-vendor'
      vendorEl.textContent = manufacturer
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
    btn.onclick = () => removeDevice(members)
    card.appendChild(btn)

    return { card, open: cardOpen }
  }

  /** @type {number} */
  let renderToken = 0
  /** @returns {Promise<void>} */
  async function renderDevices() {
    const token = ++renderToken
    /** @type {HTMLElement} */
    const list = document.getElementById('device-list')
    /** @type {HTMLElement} */
    const noDevices = document.getElementById('no-devices')
    const hashes = await loadDevices()

    if (token !== renderToken) return

    list.innerHTML = ''
    if (hashes.length === 0) {
      noDevices.style.display = 'block'
      document.getElementById('device-count').textContent = ''
      return
    }
    noDevices.style.display = 'none'

    const response = await browser.runtime.sendMessage({
      action: 'getDeviceCache'
    })
    if (token !== renderToken) return
    /** @type {import("../types.js").HIDDeviceInfo[]} */
    const cache = (response && response.devices) || []

    /** @type {Set<number>} */
    let openIds = new Set()
    try {
      const r = await browser.tabs.sendMessage(tab.id, {
        action: 'getOpenDeviceIds',
        origin
      })
      const rIds = r != null ? r.ids : undefined
      if (rIds) openIds = new Set(rIds.map((id) => Number(id)))
    } catch (e) {
      logger.debug('getOpenDeviceIds failed', e)
    }

    const infoByHash = await loadDeviceInfo(hashes, cache)
    if (token !== renderToken) return

    const displayGroups = groupDevices(
      hashes.map((hash) => infoByHash.get(Number(hash)) || { deviceId: Number(hash) })
    )

    let openCount = 0
    let cardCount = 0
    for (const [, devices] of displayGroups) {
      const members = devices.map((d) => d.deviceId)
      const { card, open } = buildDeviceCard(members, infoByHash, openIds, cache)
      list.appendChild(card)
      if (open) openCount++
      cardCount++
    }
    document.getElementById('device-count').textContent = t('popupDeviceCount', [
      String(openCount),
      String(cardCount)
    ])
  }

  wireOriginPicker()
  await refreshForActiveTab()
  browser.tabs.onActivated.addListener(() => {
    refreshForActiveTab()
  })

  browser.runtime.onMessage.addListener((message) => {
    if (message.action === 'webhidDeviceEvent' && message.event) {
      const messageEvent = message.event
      if (messageEvent.eventType === 'connect' || messageEvent.eventType === 'disconnect') {
        renderDevices()
        refreshStatus()
      }
    }
  })

  document.getElementById('manage-devices').addEventListener('click', (e) => {
    e.preventDefault()
    browser.tabs
      .create({ url: browser.runtime.getURL('js/internal/pages/devices/index.html') })
      .catch((err) => logger.debug('open devices page failed', err))
    window.close()
  })

  document.getElementById('open-settings').onclick = () => {
    browser.runtime.openOptionsPage()
  }
})()
