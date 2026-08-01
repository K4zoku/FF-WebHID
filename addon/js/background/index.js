;(function () {
  const logger = webhid.import('logger')
  const http = webhid.import('http')
  const decodeCollectionsTlv = webhid.import('decodeCollectionsTlv')
  const createSettingsStore = webhid.import('createSettingsStore')
  const GLOBAL_DEFAULTS = webhid.import('GLOBAL_DEFAULTS')
  const SETTING_NAMES = webhid.import('SETTING_NAMES')
  const globalSettingKey = webhid.import('globalSettingKey')
  const siteSettingKey = webhid.import('siteSettingKey')
  const parseSettingsKey = webhid.import('parseSettingsKey')
  const loadGlobalSettings = webhid.import('loadGlobalSettings')
  const saveGlobalSetting = webhid.import('saveGlobalSetting')
  logger.initLogger('bg')

  const { deviceCache, pendingPicker, workerPolyfillSites, permissionsPolicy, allowedCrossOrigin } =
    webhid.import('bgState')
  const {
    openDb,
    _saveDeviceInfo,
    saveDeviceInfoBatch,
    getDeviceInfo,
    removeDeviceInfo,
    getAllowedDevices,
    addAllowedDevice,
    removeAllowedDevice
  } = webhid.import('bgStorage')
  const { registerDeviceTab, unregisterDeviceTab, isTabAuthorizedForDevice, purgeTab } =
    webhid.import('bgStateOps')
  const { ensureWorkerBundle, ensureWorkerPolyfillBundle } = webhid.import('bgBundle')
  const NativeMessaging = webhid.import('NativeMessaging')
  const { NM_HOST_FORWARDER, NM_HOST_DAEMON } = webhid.import('NM_HOST_NAMES')

  const STORAGE_SCHEMA_VERSION = 1
  const VERSION_KEY = 'meta :: storage :: version'
  const GLOBAL_NAMES = new Set(SETTING_NAMES)

  /**
   * Migrates legacy browser.storage.local entries to the IndexedDB schema.
   * @returns {Promise<void>}
   */
  async function migrateLegacyStorage() {
    const all = await browser.storage.local.get(null)
    const keysToRemove = []
    const patch = {}
    const db = await openDb()

    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith('deviceInfo:')) continue
      const deviceId = key.slice('deviceInfo:'.length)
      const tx = db.transaction('deviceInfo', 'readwrite')
      tx.objectStore('deviceInfo').put({
        deviceId: Number(deviceId),
        ...value
      })
      await txDone(tx)
      keysToRemove.push(key)
    }

    for (const [key, value] of Object.entries(all)) {
      if (
        key.startsWith('deviceInfo:') ||
        key.startsWith('site:') ||
        key.startsWith('settings :: ') ||
        key.startsWith('meta :: ') ||
        GLOBAL_NAMES.has(key)
      )
        continue
      if (!Array.isArray(value)) continue
      let origin = key
      try {
        origin = decodeURIComponent(key)
      } catch {
        /* ignored */
      }
      const tx = db.transaction('origins', 'readwrite')
      const store = tx.objectStore('origins')
      for (const deviceId of value) store.put({ origin, deviceId: Number(deviceId) })
      await txDone(tx)
      keysToRemove.push(key)
    }

    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith('site:')) continue
      const origin = key.slice('site:'.length)
      for (const [name, v] of Object.entries(value)) patch[siteSettingKey(origin, name)] = v
      keysToRemove.push(key)
    }

    for (const name of GLOBAL_NAMES) {
      if (name in all) {
        patch[globalSettingKey(name)] = all[name]
        keysToRemove.push(name)
      }
    }

    if (Object.keys(patch).length) await browser.storage.local.set(patch)
    if (keysToRemove.length) await browser.storage.local.remove(keysToRemove)
  }

  /**
   * Waits for an IndexedDB transaction to complete.
   * @param {object} tx
   * @returns {Promise<void>}
   */
  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  }

  /**
   * Ensures the IndexedDB storage schema is at the current version, migrating if needed.
   * @returns {Promise<void>}
   */
  async function ensureStorageSchemaVersion() {
    const { [VERSION_KEY]: stored } = await browser.storage.local.get(VERSION_KEY)
    if (stored === STORAGE_SCHEMA_VERSION) return
    if (stored === undefined) {
      await migrateLegacyStorage()
    }
    await browser.storage.local.set({ [VERSION_KEY]: STORAGE_SCHEMA_VERSION })
  }

  /**
   * Decodes TLV-encoded collections on each device in-place.
   * @param {object[]} devices
   * @returns {void}
   */
  function decodeDeviceCollections(devices) {
    if (!Array.isArray(devices)) return
    for (const dev of devices) {
      if (dev && typeof dev.collections === 'string') {
        try {
          dev.collections = decodeCollectionsTlv(dev.collections)
        } catch (e) {
          logger.warn('decodeCollectionsTlv failed for device', dev.deviceId, e.message)
          dev.collections = []
        }
      }
    }
  }

  const settings = createSettingsStore(GLOBAL_DEFAULTS)

  /**
   * Returns the NM host name based on the daemonAsNmHost setting.
   * @returns {string}
   */
  function nmHostName() {
    return settings.daemonAsNmHost ? NM_HOST_DAEMON : NM_HOST_FORWARDER
  }

  /**
   * Loads NM host settings from storage and configures the NativeMessaging host.
   * @returns {Promise<void>}
   */
  async function loadNmHostSetting() {
    await ensureStorageSchemaVersion()
    const global = await loadGlobalSettings()
    if (global.daemonAsNmHost === undefined) {
      const platformInfo = await browser.runtime.getPlatformInfo()
      if (platformInfo.os === 'win') {
        global.daemonAsNmHost = true
        await saveGlobalSetting('daemonAsNmHost', true)
      }
    }
    settings.set(global)
    NativeMessaging.nmHostName = nmHostName()
    logger.info('NM host:', nmHostName())
  }

  settings.on('daemonAsNmHost', () => {
    logger.info('NM host changed:', nmHostName())
    NativeMessaging.nmHostName = nmHostName()
    NativeMessaging.reconnectWithNewHost()
  })

  /**
   * Rebuilds the set of origins that have worker polyfill enabled.
   * @returns {Promise<void>}
   */
  async function refreshWorkerPolyfillSites() {
    workerPolyfillSites.clear()
    const all = await browser.storage.local.get(null)
    for (const [key, val] of Object.entries(all)) {
      const parsed = parseSettingsKey(key)
      if (parsed && parsed.scope === 'site' && parsed.name === 'workerPolyfillEnabled' && val) {
        workerPolyfillSites.add(parsed.origin)
      }
    }
  }
  refreshWorkerPolyfillSites()

  const scriptDest = new Map()

  /**
   * Compares two URLs ignoring their fragment. Firefox strips fragments from
   * the worker-script request URL but keeps them in documentUrl, so a page at
   * "/page#sec" spawning `new Worker(location.href)` would otherwise never
   * match the shadow-URL check.
   * @param {string} a
   * @param {string} b
   * @returns {boolean}
   */
  function sameUrlModuloFragment(a, b) {
    const strip = (u) => {
      const i = u.indexOf('#')
      return i === -1 ? u : u.slice(0, i)
    }
    return strip(a) === strip(b)
  }

  browser.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      const record = scriptDest.get(details.requestId)
      if (!record) return
      const header = (details.requestHeaders || []).find(
        (h) => h.name.toLowerCase() === 'sec-fetch-dest'
      )
      record.dest = header && header.value ? header.value : null
    },
    { urls: ['<all_urls>'], types: ['script'] },
    ['requestHeaders']
  )

  /**
   * Serves the worker bundle for the polyfill's own `new Worker(location.href)`
   * self-request (the shadow URL). When Sec-Fetch-Dest is observable and is not
   * "worker", the request is a page script whose URL merely equals the document
   * URL, and the response passes through untouched.
   * @param {object} details
   * @returns {object | undefined}
   */
  function handleShadowUrl(details) {
    const record = { dest: null }
    scriptDest.set(details.requestId, record)
    const filter = browser.webRequest.filterResponseData(details.requestId)
    const enc = new TextEncoder()
    filter.onstart = () => {
      if (record.dest !== null && record.dest !== 'worker') {
        filter.disconnect()
        scriptDest.delete(details.requestId)
        return
      }
      ensureWorkerBundle().then((bundle) => {
        if (bundle) filter.write(enc.encode(bundle))
        else
          filter.write(
            enc.encode("self.postMessage({ type: 'error', error: 'worker bundle not ready' });")
          )
        filter.close()
        scriptDest.delete(details.requestId)
      })
    }
    return {}
  }

  /**
   * Prefixes the opt-in worker-polyfill bundle into dedicated worker scripts
   * when `workerPolyfillEnabled` (global or per-site) is on. Destinations other
   * than a dedicated worker per Sec-Fetch-Dest (page scripts, importScripts,
   * dynamic imports, shared/service workers) are left unmodified; `dest ===
   * null` falls back to the legacy inject-everything behavior.
   * @param {object} details
   * @returns {object | undefined}
   */
  function handleInjection(details) {
    let origin = null
    try {
      origin = new URL(details.url).origin
    } catch {
      /* unregistered device */
    }
    if (!settings.workerPolyfillEnabled && (!origin || !workerPolyfillSites.has(origin))) return

    const record = { dest: null }
    scriptDest.set(details.requestId, record)
    const filter = browser.webRequest.filterResponseData(details.requestId)
    const enc = new TextEncoder()
    const dec = new TextDecoder()
    let firstChunk = true
    let injectPromise = Promise.resolve()
    filter.onstart = () => {}
    filter.ondata = (event) => {
      if (!firstChunk) {
        injectPromise = injectPromise.then(() => filter.write(event.data))
        return
      }
      firstChunk = false
      injectPromise = injectPromise.then(async () => {
        const isWorkerScope = record.dest === null || record.dest === 'worker'
        const bundle = await ensureWorkerPolyfillBundle()
        if (!bundle || !isWorkerScope) {
          filter.write(event.data)
          return
        }
        const str = dec.decode(event.data, { stream: true })
        const cleaned = str.replace(/\/\/[^\n]*\n/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
        const hasUseStrict = /^\s*["']use strict["'];?\s*/.test(cleaned)
        if (hasUseStrict) {
          const p = str.indexOf('"use strict"')
          const pos = p >= 0 ? p : str.indexOf("'use strict'")
          let end = pos + 12
          if (str[end] === ';') end++
          while (end < str.length && /\s/.test(str[end])) end++
          filter.write(enc.encode(str.slice(0, end)))
          filter.write(enc.encode(bundle))
          filter.write(enc.encode(str.slice(end)))
        } else {
          filter.write(enc.encode(bundle))
          filter.write(event.data)
        }
      })
    }
    filter.onstop = () => {
      injectPromise.then(() => {
        filter.close()
        scriptDest.delete(details.requestId)
      })
    }
    filter.onerror = () => {
      scriptDest.delete(details.requestId)
      try {
        filter.close()
      } catch {
        /* no such device */
      }
    }
    return {}
  }

  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.type !== 'script') return
      const isShadowUrl =
        details.documentUrl !== undefined && sameUrlModuloFragment(details.url, details.documentUrl)
      if (isShadowUrl) return handleShadowUrl(details)
      return handleInjection(details)
    },
    { urls: ['<all_urls>'], types: ['script'] },
    ['blocking']
  )

  browser.webRequest.onErrorOccurred.addListener(
    (details) => {
      scriptDest.delete(details.requestId)
    },
    { urls: ['<all_urls>'], types: ['script'] }
  )

  browser.webRequest.onHeadersReceived.addListener(
    (details) => {
      if (
        details.type !== 'script' ||
        details.documentUrl === undefined ||
        !sameUrlModuloFragment(details.url, details.documentUrl)
      )
        return
      const record = scriptDest.get(details.requestId)
      if (record && record.dest !== null && record.dest !== 'worker') return
      const headers = details.responseHeaders.filter(
        (h) =>
          !/^(content-security-policy|content-type|content-length|content-disposition|x-content-type-options)$/i.test(
            h.name
          )
      )
      headers.push({ name: 'Content-Type', value: 'application/javascript' })
      return { responseHeaders: headers }
    },
    { urls: ['<all_urls>'], types: ['script'] },
    ['blocking', 'responseHeaders']
  )

  browser.webRequest.onHeadersReceived.addListener(
    (details) => {
      const ph = details.responseHeaders?.find(
        (h) => h.name.toLowerCase() === 'permissions-policy'
      )?.value
      if (!ph) return {}
      for (const raw of ph.split(',')) {
        const eq = raw.trim().indexOf('=')
        if (eq === -1) continue
        const f = raw.trim().slice(0, eq).trim().toLowerCase()
        const v = raw
          .trim()
          .slice(eq + 1)
          .trim()
        if (f !== 'hid') continue
        const parsed = v === '()' ? 'none' : v === '*' ? 'all' : v === 'self' ? 'self' : v
        const key = `${details.tabId}:${details.frameId}`
        permissionsPolicy.set(key, parsed)
        logger.debug('Permissions-Policy stored: ' + key + ' hid=' + parsed)
        break
      }
      return {}
    },
    { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame'] },
    ['blocking', 'responseHeaders']
  )

  browser.webRequest.onHeadersReceived.addListener(
    (details) => {
      if (details.type !== 'main_frame' && details.type !== 'sub_frame') return
      const cspHeader = details.responseHeaders?.find(
        (h) => h.name.toLowerCase() === 'content-security-policy'
      )?.value || ''
      const tabId = details.tabId
      const frameId = details.frameId
      const cspInfo = parseCspForWorkerSpawn(cspHeader)
      if (cspInfo) {
        browser.storage.session.set({
          [`csp:${tabId}:${frameId}`]: cspInfo,
        }).catch(() => {})
      }
    },
    { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame'] },
    ['responseHeaders']
  )

  function parseCspForWorkerSpawn(csp) {
    if (!csp) return null
    const directives = {}
    for (const raw of csp.split(';')) {
      const parts = raw.trim().split(/\s+/)
      if (!parts.length) continue
      directives[parts[0].toLowerCase()] = parts.slice(1).join(' ')
    }
    const workerSrc = directives['worker-src'] || directives['script-src'] || directives['default-src'] || ''
    const connectSrc = directives['connect-src'] || directives['default-src'] || ''
    const hasTrustedTypesRequire = directives['require-trusted-types-for']?.includes("'script'")
    const trustedTypesAllowlist = directives['trusted-types']
    const needsBlobFallback = settings.workerSpawnMode === 'blob'
      || (settings.workerSpawnMode === 'shadow' && (
        (workerSrc && !workerSrc.includes('blob:') && !workerSrc.includes('*'))
        || hasTrustedTypesRequire
      ))
    return {
      workerSrc,
      connectSrc,
      hasTrustedTypesRequire,
      trustedTypesAllowlist,
      needsBlobFallback,
    }
  }

  browser.runtime.onStartup.addListener(() => {
    loadNmHostSetting().then(() => NativeMessaging.connect())
  })
  browser.runtime.onInstalled.addListener(() => {
    loadNmHostSetting().then(() => NativeMessaging.connect())
  })
  loadNmHostSetting().then(() => NativeMessaging.connect())
  browser.tabs.onRemoved.addListener((tabId) =>
    purgeTab(tabId, (d) => NativeMessaging.closeDevice(d))
  )

  var actionApi = browser.browserAction || browser.action || null
  if (actionApi && actionApi.onClicked) {
    actionApi.onClicked.addListener(function () {
      browser.runtime.openOptionsPage()
    })
  }

  var notificationsApi = browser.notifications || null
  if (notificationsApi && notificationsApi.onClicked) {
    notificationsApi.onClicked.addListener(function () {
      if (pendingPicker.size > 0) {
        var entries = pendingPicker.entries()
        var first = entries.next()
        if (first.done) return
        var tabId = first.value[0]
        browser.tabs
          .update(tabId, { active: true })
          .catch((e) => logger.debug('tabs.update failed', e))
        if (browser.pageAction.openPopup)
          browser.pageAction.openPopup().catch((e) => logger.debug('openPopup failed', e))
        notificationsApi
          .clear('webhid-picker')
          .catch((e) => logger.debug('notifications.clear failed', e))
      }
    })
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    let hasSiteChange = false
    const patch = {}
    for (const [key, change] of Object.entries(changes)) {
      const parsed = parseSettingsKey(key)
      if (!parsed) continue
      if (parsed.scope === 'global') {
        patch[parsed.name] = change.newValue
      } else if (parsed.scope === 'site' && parsed.name === 'workerPolyfillEnabled') {
        hasSiteChange = true
      }
    }
    if (hasSiteChange) refreshWorkerPolyfillSites()
    if (Object.keys(patch).length === 0) return
    settings.set(patch)
  })

  browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.action) {
      case 'enumerate':
        NativeMessaging.enumerateDevices()
          .then((response) => {
            if (http.isOk(response.s) && response.D) {
              decodeDeviceCollections(response.D)
              deviceCache.length = 0
              deviceCache.push(...response.D)
              saveDeviceInfoBatch(response.D)
            }
            sendResponse(response)
          })
          .catch(() => sendResponse({ s: 500 }))
        return true

      case 'handshake':
        NativeMessaging.handshake()
          .then(sendResponse)
          .catch(() => sendResponse({ s: 500 }))
        return true

      case 'open': {
        const tabId = sender.tab != null ? sender.tab.id : undefined
        getAllowedDevices(request.origin).then((deviceIds) => {
          if (!deviceIds.includes(request.deviceId)) {
            sendResponse({ s: 403 })
            return
          }
          NativeMessaging.openDevice(request.deviceId)
            .then((response) => {
              if (http.isOk(response.s) && response.i) registerDeviceTab(response.i, tabId)
              sendResponse(response)
            })
            .catch(() => sendResponse({ s: 500 }))
        })
        return true
      }

      case 'close': {
        const tabId = sender.tab != null ? sender.tab.id : undefined
        if (!isTabAuthorizedForDevice(tabId, request.deviceId)) {
          sendResponse({ s: 403 })
          return true
        }
        NativeMessaging.closeDevice(request.deviceId, request.sessionToken)
          .then((response) => {
            if (http.isOk(response.s)) unregisterDeviceTab(request.deviceId, tabId)
            sendResponse(response)
          })
          .catch(() => sendResponse({ s: 500 }))
        return true
      }

      case 'revokeDevice': {
        ;(async () => {
          try {
            const origin = request.origin
            if (!origin) {
              sendResponse({ success: false, error: 'no origin' })
              return
            }
            await removeAllowedDevice(origin, request.deviceId)
            removeDeviceInfo(request.deviceId)
            await NativeMessaging.closeDevice(request.deviceId).catch(() => {})
            const tabs = await browser.tabs.query({})
            for (const tab of tabs) {
              if (!tab.url) continue
              let tabOrigin
              try {
                tabOrigin = new URL(tab.url).origin
              } catch {
                continue
              }
              if (tabOrigin !== origin) continue
              unregisterDeviceTab(request.deviceId, tab.id)
              browser.tabs
                .sendMessage(tab.id, {
                  action: 'webhidDeviceEvent',
                  event: { eventType: 'revoked', deviceId: request.deviceId }
                })
                .catch(() => {})
              const deviceIds = await getAllowedDevices(origin)
              browser.tabs
                .sendMessage(tab.id, {
                  action: 'allowedDevicesChanged',
                  deviceIds
                })
                .catch(() => {})
            }
            sendResponse({ success: true })
          } catch (e) {
            sendResponse({ success: false, error: e.message })
          }
        })()
        return true
      }

      case 'setDataPlane':
        if (
          !isTabAuthorizedForDevice(
            sender.tab != null ? sender.tab.id : undefined,
            request.deviceId
          )
        ) {
          sendResponse({ s: 403 })
          return true
        }
        NativeMessaging.sendRequest({
          a: webhid.import('bgPacked').ACT.sdp,
          i: request.deviceId,
          m: request.mode,
          T: request.sessionToken
        })
          .then(sendResponse)
          .catch(() => sendResponse({ s: 500 }))
        return true

      case 'sendReport':
        if (
          !isTabAuthorizedForDevice(
            sender.tab != null ? sender.tab.id : undefined,
            request.deviceId
          )
        ) {
          sendResponse({ s: 403 })
          return true
        }
        NativeMessaging.sendReport(request.deviceId, request.reportId || 0, request.data)
          .then((resp) => {
            sendResponse(resp)
          })
          .catch(() => sendResponse({ s: 500 }))
        return true

      case 'receiveFeatureReport':
        if (
          !isTabAuthorizedForDevice(
            sender.tab != null ? sender.tab.id : undefined,
            request.deviceId
          )
        ) {
          sendResponse({ s: 403 })
          return true
        }
        NativeMessaging.receiveFeatureReport(request.deviceId, request.reportId)
          .then(sendResponse)
          .catch(() => sendResponse({ s: 500 }))
        return true

      case 'sendFeatureReport':
        if (
          !isTabAuthorizedForDevice(
            sender.tab != null ? sender.tab.id : undefined,
            request.deviceId
          )
        ) {
          sendResponse({ s: 403 })
          return true
        }
        NativeMessaging.sendFeatureReport(request.deviceId, request.reportId || 0, request.data)
          .then(sendResponse)
          .catch(() => sendResponse({ s: 500 }))
        return true

      case 'getPairedDevices':
        ;(async () => {
          try {
            const deviceIds = await getAllowedDevices(request.origin)
            sendResponse({ success: true, hashes: deviceIds })
          } catch (e) {
            sendResponse({ success: false, error: e.message, hashes: [] })
          }
        })()
        return true

      case 'pairDevice':
        ;(async () => {
          try {
            await addAllowedDevice(request.origin, request.device.deviceId)
            const deviceIds = await getAllowedDevices(request.origin)
            const tabs = await browser.tabs.query({})
            for (const tab of tabs) {
              if (!tab.url) continue
              let tabOrigin
              try {
                tabOrigin = new URL(tab.url).origin
              } catch {
                continue
              }
              if (tabOrigin !== request.origin) continue
              browser.tabs
                .sendMessage(tab.id, {
                  action: 'allowedDevicesChanged',
                  deviceIds
                })
                .catch(() => {})
            }
            sendResponse({ success: true, hashes: deviceIds })
          } catch (e) {
            sendResponse({ success: false, error: e.message, hashes: [] })
          }
        })()
        return true

      case 'unpairDevice':
        ;(async () => {
          try {
            if (request.deviceId) {
              await removeAllowedDevice(request.origin, request.deviceId)
              removeDeviceInfo(request.deviceId)
              const tabs = await browser.tabs.query({})
              for (const tab of tabs) {
                if (!tab.url) continue
                let tabOrigin
                try {
                  tabOrigin = new URL(tab.url).origin
                } catch {
                  continue
                }
                if (tabOrigin !== request.origin) continue
                const deviceIds = await getAllowedDevices(request.origin)
                browser.tabs
                  .sendMessage(tab.id, {
                    action: 'allowedDevicesChanged',
                    deviceIds
                  })
                  .catch(() => {})
              }
            }
            const deviceIds = await getAllowedDevices(request.origin)
            sendResponse({ success: true, hashes: deviceIds })
          } catch (e) {
            sendResponse({ success: false, error: e.message })
          }
        })()
        return true

      case 'getAllowedDevices':
        ;(async () => {
          try {
            const deviceIds = await getAllowedDevices(request.origin)
            sendResponse({ deviceIds })
          } catch {
            sendResponse({ deviceIds: [] })
          }
        })()
        return true

      case 'registerDevice': {
        const tabId = sender.tab != null ? sender.tab.id : undefined
        if (request.deviceId && tabId != null) registerDeviceTab(request.deviceId, tabId)
        sendResponse({ s: 204 })
        return false
      }

      case 'unregisterDevice': {
        const tabId = sender.tab != null ? sender.tab.id : undefined
        if (request.deviceId && tabId != null) unregisterDeviceTab(request.deviceId, tabId)
        sendResponse({ s: 204 })
        return false
      }

      case 'deviceCountChanged':
        if (actionApi) {
          var tabId = sender.tab != null ? sender.tab.id : undefined
          if (tabId != null)
            actionApi.setBadgeText({
              text: request.count > 0 ? String(request.count) : '',
              tabId
            })
        }
        return false

      case 'getDeviceCache':
        if (deviceCache.length === 0) {
          NativeMessaging.enumerateDevices()
            .then((response) => {
              if (http.isOk(response.s) && response.D) {
                decodeDeviceCollections(response.D)
                deviceCache.length = 0
                deviceCache.push(...response.D)
              }
              saveDeviceInfoBatch(deviceCache)
              sendResponse({ devices: deviceCache })
            })
            .catch(() => sendResponse({ devices: deviceCache }))
          return true
        }
        saveDeviceInfoBatch(deviceCache)
        sendResponse({ devices: deviceCache })
        return false

      case 'getDeviceInfo':
        getDeviceInfo(request.deviceId).then((device) => sendResponse({ device }))
        return true

      case 'fetchResource': {
        const path = request.path
        if (!path || typeof path !== 'string' || path.includes('..')) {
          sendResponse({ error: 'invalid path' })
          return false
        }
        fetch(browser.runtime.getURL(path))
          .then((r) => r.text())
          .then((text) => sendResponse({ text }))
          .catch((e) => sendResponse({ error: e.message || String(e) }))
        return true
      }

      case 'showPicker': {
        const tabId = sender.tab != null ? sender.tab.id : undefined
        if (tabId == null) {
          sendResponse({ error: 'no tab' })
          return false
        }
        const req = {
          requestId: request.requestId,
          tabId,
          filters: request.filters || [],
          exclusionFilters: request.exclusionFilters || [],
          origin: request.origin,
          mode: request.mode || 'pageAction'
        }
        pendingPicker.set(tabId, req)
        if (req.mode === 'window') {
          var sW = globalThis.screen?.availWidth || 1280
          var sH = globalThis.screen?.availHeight || 720
          const winW = Math.min(380, sW - 20)
          const winH = Math.min(480, sH - 80)
          browser.windows
            .create({
              type: 'popup',
              url: 'js/internal/pages/picker/index.html',
              width: winW,
              height: winH,
              left: Math.max(0, Math.round((sW - winW) / 2)),
              top: Math.max(0, Math.round((sH - winH) / 2))
            })
            .catch(() => {})
        } else {
          browser.pageAction.setIcon({
            tabId,
            path: 'icons/gamepad.alert.svg'
          })
          browser.pageAction.setPopup({
            tabId,
            popup: 'js/internal/pages/picker/index.html'
          })
          if (browser.pageAction.openPopup) browser.pageAction.openPopup().catch(() => {})
          browser.tabs
            .query({ active: true, currentWindow: true })
            .then((tabs) => {
              const tab = tabs[0]
              if (tab && tab.id !== tabId) {
                browser.notifications.create('webhid-picker', {
                  type: 'basic',
                  iconUrl: browser.runtime.getURL('icons/icon.svg'),
                  title: 'WebHID',
                  message: `A website (${request.origin}) is requesting a HID device. Click to choose.`
                })
              }
            })
            .catch(() => {})
        }
        sendResponse({ ok: true })
        return false
      }

      case 'getPendingPicker': {
        sendResponse(pendingPicker.size > 0 ? [...pendingPicker.values()][0] : null)
        return false
      }

      case 'getPolicy': {
        const sid = sender.frameId
        const tid = sender.tab?.id
        let hid = null
        if (tid != null) hid = permissionsPolicy.get(`${tid}:${sid}`)
        if (hid == null && tid != null) hid = permissionsPolicy.get(`${tid}:0`)
        if (hid === 'none') {
          sendResponse({ policy: { hid: 'none' } })
          return true
        }
        if (request.isCrossOrigin) {
          if (request.hasAllowAttr) {
            sendResponse({ policy: { hid: 'allowed' } })
            return true
          }
          let allowKey = tid != null ? `${tid}:${sid}` : null
          if (allowKey && allowedCrossOrigin.has(allowKey)) {
            sendResponse({ policy: { hid: 'allowed' } })
            return true
          }
          const urlKey = `url:${request.url}`
          if (allowedCrossOrigin.has(urlKey)) {
            sendResponse({ policy: { hid: 'allowed' } })
            return true
          }
          sendResponse({ policy: { hid: 'none' } })
          return true
        }
        sendResponse({ policy: { hid: 'allowed' } })
        return true
      }

      case 'setFrameAllow': {
        let key
        if (request.frameId === -1 && request.url) {
          key = `url:${request.url}`
        } else {
          const tid = sender.tab?.id
          if (tid == null) {
            sendResponse({ ok: false })
            return false
          }
          key = `${tid}:${request.frameId}`
        }
        allowedCrossOrigin.set(key, true)
        sendResponse({ ok: true })
        return false
      }

      case 'pickerResult': {
        const { requestId, selected, devices } = request
        let tabId = request.tabId
        if (tabId == null && pendingPicker.size > 0) tabId = [...pendingPicker.keys()][0]
        const req = tabId != null ? pendingPicker.get(tabId) : null
        if (tabId != null) pendingPicker.delete(tabId)
        var reqMode = req?.mode
        if (reqMode === 'pageAction') {
          browser.pageAction.setIcon({ tabId, path: 'icons/gamepad.svg' })
          browser.pageAction.setPopup({
            tabId,
            popup: 'js/internal/pages/popup/index.html'
          })
          if (browser.notifications) browser.notifications.clear('webhid-picker').catch(() => {})
        }
        if (request.windowId != null) browser.windows.remove(request.windowId).catch(() => {})
        if (tabId != null)
          browser.tabs
            .sendMessage(tabId, {
              action: 'pickerResult',
              requestId,
              selected,
              devices: selected ? devices : null
            })
            .catch(() => {})
        sendResponse({ ok: true })
        return false
      }

      default:
        return false
    }
  })
})()
