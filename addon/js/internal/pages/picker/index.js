;(async () => {
  /** @type {import("../types.js").Logger} */
  const logger = webhid.import('logger')
  const http = webhid.import('http')
  const guessDeviceType = webhid.import('guessDeviceType')
  const t = webhid.import('t')
  const localizeHTML = webhid.import('localizeHTML')
  const applyFilters = webhid.import('applyFilters')
  const groupDevices = webhid.import('groupDevices')
  const logExcludedDevices = webhid.import('logExcludedDevices')
  const applyDeviceIcon = webhid.import('applyDeviceIcon')
  const syncBrowserTheme = webhid.import('syncBrowserTheme')
  logger.initLogger('picker-popup')

  syncBrowserTheme()
  if (browser.theme) browser.theme.onUpdated.addListener(syncBrowserTheme)

  localizeHTML(document)

  /** @type {HTMLElement} */
  const listEl = document.getElementById('picker-list')
  /** @type {HTMLElement} */
  const cancelBtn = document.getElementById('picker-cancel')
  /** @type {HTMLElement} */
  const connectBtn = document.getElementById('picker-connect')

  /** @type {string|null} */
  let selectedDeviceId = null
  /** @type {{[key: string]: import("../types.js").HIDDeviceInfo[]}} */
  let deviceGroups = {}
  /** @type {{requestId: number, tabId: number, filters?: import("../types.js").HIDDeviceFilter[], exclusionFilters?: import("../types.js").HIDDeviceFilter[]}|null} */
  let pendingRequest = null

  /** @returns {Promise<void>} */
  async function loadPending() {
    const resp = await browser.runtime.sendMessage({
      action: 'getPendingPicker'
    })
    pendingRequest = resp
    if (!pendingRequest) {
      const msg = document.createElement('div')
      msg.className = 'webhid-no-devices'
      msg.setAttribute('role', 'status')
      msg.textContent = t('pickerNoPending')
      listEl.replaceChildren(msg)
      return
    }
    await loadDevices()
  }

  /**
   * @param {string} name
   * @param {import("../types.js").HIDDeviceInfo[]} devs
   * @param {string} groupId
   * @returns {HTMLElement}
   */
  function buildDeviceItem(name, devs, groupId) {
    const device = devs[0]
    const type = guessDeviceType(device)

    const item = document.createElement('label')
    item.className = 'webhid-device-item'
    item.tabIndex = 0
    item.setAttribute('role', 'option')
    item.dataset.deviceId = groupId

    const radio = document.createElement('input')
    radio.type = 'radio'
    radio.name = 'webhid-device'
    radio.className = 'webhid-device-radio'
    radio.value = groupId

    const iconSpan = document.createElement('span')
    iconSpan.className = 'webhid-device-icon'

    const body = document.createElement('div')
    body.className = 'webhid-device-body'

    const nameEl = document.createElement('div')
    nameEl.className = 'webhid-device-name'
    nameEl.textContent = name
    body.appendChild(nameEl)

    if (device.manufacturer) {
      const vendorEl = document.createElement('div')
      vendorEl.className = 'webhid-device-vendor'
      vendorEl.textContent = device.manufacturer
      body.appendChild(vendorEl)
    }

    if (devs.length > 1) {
      const ifaceEl = document.createElement('div')
      ifaceEl.className = 'webhid-device-iface'
      ifaceEl.textContent = t('pickerInterfaces', [String(devs.length)])
      body.appendChild(ifaceEl)
    }

    if (device.descriptorParseFailed) {
      const hintEl = document.createElement('div')
      hintEl.className = 'webhid-device-parse-failed'
      hintEl.textContent = t('pickerParseFailed')
      body.appendChild(hintEl)
    }

    item.appendChild(radio)
    item.appendChild(iconSpan)
    item.appendChild(body)
    applyDeviceIcon(iconSpan, type)
    radio.addEventListener('change', () => {
      selectedDeviceId = groupId
      connectBtn.disabled = false
      listEl
        .querySelectorAll('.webhid-device-item')
        .forEach((el) => el.classList.remove('selected'))
      item.classList.add('selected')
    })
    return item
  }

  /** @returns {Promise<void>} */
  async function loadDevices() {
    const loading = document.createElement('div')
    loading.className = 'webhid-loading'
    loading.setAttribute('role', 'status')
    loading.textContent = t('pickerLoading')
    listEl.replaceChildren(loading)
    let devices
    try {
      const response = await browser.runtime.sendMessage({ action: 'enumerate' })
      if (!http.isOk(response.s)) {
        showPickerMessage(t('pickerNoDaemon'), true)
        return
      }
      devices = Array.isArray(response.D) ? response.D : []
    } catch (error) {
      logger.warn(
        'enumerate exception:',
        error != null ? (error.message != null ? error.message : error) : error
      )
      showPickerMessage(t('pickerNoDaemon'), true)
      return
    }
    if (devices.length === 0) {
      showPickerMessage(t('pickerNoDevices'))
      return
    }

    const filtered = applyFilters(
      devices,
      pendingRequest.filters || [],
      pendingRequest.exclusionFilters || []
    )
    if (logExcludedDevices(devices, filtered.length, pendingRequest.filters, listEl)) return
    logger.debug('picker: ' + filtered.length + '/' + devices.length + ' devices matched')

    const groups = groupDevices(filtered)

    deviceGroups = {}
    listEl.innerHTML = ''

    for (const [name, devs] of groups.entries()) {
      const groupId = devs.length === 1 ? devs[0].deviceId : 'group:' + devs[0].deviceId
      deviceGroups[groupId] = devs.slice()
      listEl.appendChild(buildDeviceItem(name, devs, groupId))
    }
  }

  /**
   * @param {string} message
   * @param {boolean} [isError]
   * @returns {void}
   */
  function showPickerMessage(message, isError = false) {
    const msg = document.createElement('div')
    msg.className = isError ? 'webhid-error' : 'webhid-no-devices'
    msg.setAttribute('role', 'status')
    msg.textContent = message
    listEl.replaceChildren(msg)
  }

  connectBtn.addEventListener('click', async () => {
    if (!selectedDeviceId || !pendingRequest) return
    const devices = deviceGroups[selectedDeviceId] || []
    await browser.runtime.sendMessage({
      action: 'pickerResult',
      requestId: pendingRequest.requestId,
      tabId: pendingRequest.tabId,
      windowId:
        browser.windows.getCurrent != null ? (await browser.windows.getCurrent()).id : undefined,
      selected: true,
      devices
    })
    pendingRequest = null
    window.close()
  })

  cancelBtn.addEventListener('click', async () => {
    if (pendingRequest) {
      await browser.runtime.sendMessage({
        action: 'pickerResult',
        requestId: pendingRequest.requestId,
        tabId: pendingRequest.tabId,
        windowId:
          browser.windows.getCurrent != null ? (await browser.windows.getCurrent()).id : undefined,
        selected: false
      })
      pendingRequest = null
    }
    window.close()
  })

  window.addEventListener('unload', () => {
    if (pendingRequest) {
      browser.runtime.sendMessage({
        action: 'pickerResult',
        requestId: pendingRequest.requestId,
        tabId: pendingRequest.tabId,
        windowId: undefined,
        selected: false
      })
    }
  })

  await loadPending()
})()
