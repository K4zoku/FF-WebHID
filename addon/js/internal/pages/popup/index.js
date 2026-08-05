;(async () => {
  /** @type {import("../types.js").Logger} */
  const logger = webhid.import('logger')
  const guessDeviceType = webhid.import('guessDeviceType')
  const groupDevices = webhid.import('groupDevices')
  const t = webhid.import('t')
  const localizeHTML = webhid.import('localizeHTML')
  const loadGlobalSettings = webhid.import('loadGlobalSettings')
  const loadSiteSettings = webhid.import('loadSiteSettings')
  const GLOBAL_DEFAULTS = webhid.import('GLOBAL_DEFAULTS')
  const saveSiteSetting = webhid.import('saveSiteSetting')
  const syncBrowserTheme = webhid.import('syncBrowserTheme')
  const initInfoPopovers = webhid.import('initInfoPopovers')
  logger.initLogger('popup')

  syncBrowserTheme()
  if (browser.theme) browser.theme.onUpdated.addListener(syncBrowserTheme)

  localizeHTML(document)
  initInfoPopovers(document)

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
  /** @type {string} */
  let origin = ''
  if (tab && tab.url) {
    try {
      const url = new URL(tab.url)
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        origin = url.origin
      }
    } catch (e) {
      logger.debug('URL parse failed', e)
    }
  }

  /** @type {HTMLElement} */
  const siteLabel = document.getElementById('site-name')
  siteLabel.textContent = origin || t('popupNoSite')

  /**
   * Loads global and site settings, merging site overrides on top of global defaults.
   * @returns {Promise<object>}
   */
  async function loadSettings() {
    const global = await loadGlobalSettings()
    if (!origin) return global
    const site = await loadSiteSettings(origin)
    return { ...global, ...site }
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

  const settings = await loadSettings()

  // ── View switching: Paired Devices <-> Settings (§1) ──────────────
  // The gear button lives in the status footer and toggles between the two
  // views; it shows an active state while the Settings view is open.
  const viewDevices = document.getElementById('view-devices')
  const viewSettings = document.getElementById('view-settings')
  const btnSettings = document.getElementById('btn-settings')
  btnSettings.addEventListener('click', () => {
    const open = viewSettings.hidden
    viewDevices.hidden = open
    viewSettings.hidden = !open
    btnSettings.classList.toggle('active', open)
  })

  // ── Settings controls (§7 radios) ─────────────────────────────────
  /**
   * Checks the radio with the given name/value.
   * @param {string} name
   * @param {string} value
   * @returns {void}
   */
  function setRadioValue(name, value) {
    const radio = document.querySelector(`input[name="${name}"][value="${value}"]`)
    if (radio) radio.checked = true
  }

  /**
   * Returns the value of the checked radio in the group.
   * @param {string} name
   * @returns {string}
   */
  function currentRadioValue(name) {
    const radio = document.querySelector(`input[name="${name}"]:checked`)
    return radio ? radio.value : ''
  }

  setRadioValue('dataPlane', settings.dataPlane)
  setRadioValue('devicePickerMode', settings.devicePickerMode || GLOBAL_DEFAULTS.devicePickerMode)
  setRadioValue('workerSpawnMode', settings.workerSpawnMode || GLOBAL_DEFAULTS.workerSpawnMode)
  setRadioValue('logLevel', String(settings.logLevel))
  /** @type {HTMLInputElement} */
  document.getElementById('workerPolyfillEnabled').checked = settings.workerPolyfillEnabled || false
  /** @type {HTMLInputElement} */
  document.getElementById('allowActivationlessRequestDevice').checked =
    settings.allowActivationlessRequestDevice || false
  /** @type {HTMLInputElement} */
  const useWorkerCheckbox = document.getElementById('useWorker')
  useWorkerCheckbox.checked = settings.useWorker !== false

  /**
   * @param {string} o
   * @returns {boolean}
   */
  function isLoopbackOrigin(o) {
    if (!o) return false
    try {
      const host = new URL(o).hostname
      return host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host)
    } catch {
      return false
    }
  }

  /**
   * In-page WebTransport only exists when the worker is off, the data plane is
   * WT, and the daemon offered a WT port. The LNA prompt only applies to
   * public origins; loopback pages and worker-context WT are exempt.
   * @returns {void}
   */
  function updateInPageWarning() {
    const show =
      currentRadioValue('dataPlane') === 'wt' &&
      !useWorkerCheckbox.checked &&
      !isLoopbackOrigin(origin)
    document.getElementById('warning-inpage-wt').hidden = !show
  }

  /**
   * Shows only the options that apply to the current data plane:
   * useWorker only matters for WT (WS always needs the worker, NM needs
   * neither); workerSpawnMode matters only when a worker will actually spawn.
   * @returns {void}
   */
  function updatePlaneVisibility() {
    const dp = currentRadioValue('dataPlane')
    const useWorker = useWorkerCheckbox.checked
    document.getElementById('useWorker-setting').style.display = dp === 'wt' ? '' : 'none'
    document.getElementById('workerSpawnMode-setting').style.display =
      dp !== 'nm' && useWorker ? '' : 'none'
    updateInPageWarning()
  }
  updatePlaneVisibility()

  /**
   * Binds change handling for one radio group, saving on selection.
   * @param {string} name
   * @param {(value: string) => any} [transform]
   * @returns {void}
   */
  function bindRadioGroup(name, transform) {
    document.querySelectorAll(`input[name="${name}"]`).forEach((radio) => {
      radio.addEventListener('change', () => {
        if (!radio.checked) return
        saveSetting(name, transform ? transform(radio.value) : radio.value)
        if (name === 'dataPlane') updatePlaneVisibility()
        refreshStatus()
      })
    })
  }
  bindRadioGroup('dataPlane')
  bindRadioGroup('devicePickerMode')
  bindRadioGroup('workerSpawnMode')
  bindRadioGroup('logLevel', (v) => parseInt(v, 10))

  useWorkerCheckbox.addEventListener('change', (e) => {
    saveSetting('useWorker', e.target.checked)
    updatePlaneVisibility()
    refreshStatus()
  })
  document.getElementById('workerPolyfillEnabled').addEventListener('change', (e) => {
    saveSetting('workerPolyfillEnabled', e.target.checked)
  })
  document.getElementById('allowActivationlessRequestDevice').addEventListener('change', (e) => {
    saveSetting('allowActivationlessRequestDevice', e.target.checked)
  })

  // ── macOS Input Monitoring link (§4) ──────────────────────────────
  // Shown only on macOS AND when the daemon reports it cannot read HID
  // devices (Input Monitoring / TCC denied). The daemon probes this once at
  // startup (macOS: IOHIDManagerOpen fails without TCC; Windows is always ok).
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

  // ── Status footer (§2) ────────────────────────────────────────────
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
        const r = await browser.tabs.sendMessage(tab.id, { action: 'getDataPlaneStatus' })
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

  // ── Paired devices (§1, §9 group display) ─────────────────────────
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
        action: 'getOpenDeviceIds'
      })
      var rIds = r != null ? r.ids : undefined
      if (rIds) openIds = new Set(rIds.map((id) => Number(id)))
    } catch (e) {
      logger.debug('getOpenDeviceIds failed', e)
    }

    // Resolve info for every paired device first so cards can be grouped the
    // same way the picker groups them (by product name).
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
    if (token !== renderToken) return

    const displayGroups = groupDevices(
      hashes.map((hash) => infoByHash.get(Number(hash)) || { deviceId: Number(hash) })
    )

    let openCount = 0
    let cardCount = 0
    for (const [, devices] of displayGroups) {
      const members = devices.map((d) => d.deviceId)
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

      list.appendChild(card)
      if (cardOpen) openCount++
      cardCount++
    }
    document.getElementById('device-count').textContent = t('popupDeviceCount', [
      String(openCount),
      String(cardCount)
    ])
  }

  await Promise.all([renderDevices(), refreshStatus()])

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
