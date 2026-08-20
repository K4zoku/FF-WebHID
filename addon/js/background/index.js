;(function () {
  const webhid = globalThis.webhid
  const logger = webhid.import('logger')
  const isChromium = webhid.import('isChromium')
  const createSettingsStore = webhid.import('createSettingsStore')
  const GLOBAL_DEFAULTS = webhid.import('GLOBAL_DEFAULTS')
  const SETTING_NAMES = webhid.import('SETTING_NAMES')
  const globalSettingKey = webhid.import('globalSettingKey')
  const siteSettingKey = webhid.import('siteSettingKey')
  const parseSettingsKey = webhid.import('parseSettingsKey')
  const loadGlobalSettings = webhid.import('loadGlobalSettings')
  const saveGlobalSetting = webhid.import('saveGlobalSetting')
  logger.initLogger('bg')

  const { workerPolyfillSites, pendingPicker, shadowArms } = webhid.import('bgState')
  const { openDb, txDone } = webhid.import('bgStorage')
  const { purgeTab, retryOrphanCleanup } = webhid.import('bgStateOps')
  const NativeMessaging = webhid.import('NativeMessaging')
  const { NM_HOST_FORWARDER, NM_HOST_DAEMON } = webhid.import('NM_HOST_NAMES')
  const registerMessageHandlers = webhid.import('registerMessageHandlers')
  const registerWebRequestHandlers = webhid.import('registerWebRequestHandlers')
  const stripFragment = webhid.import('stripFragment')

  const STORAGE_SCHEMA_VERSION = 1
  const VERSION_KEY = 'meta :: storage :: version'
  const GLOBAL_NAMES = new Set(SETTING_NAMES)

  /**
   * Copies legacy `deviceInfo:*` entries into the IndexedDB deviceInfo store.
   * @param {object} all
   * @param {object} db
   * @returns {Promise<string[]>}
   */
  async function migrateDeviceInfoEntries(all, db) {
    const keysToRemove = []
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
    return keysToRemove
  }

  /**
   * Copies legacy origin->deviceId array entries into the IndexedDB origins
   * store.
   * @param {object} all
   * @param {object} db
   * @returns {Promise<string[]>}
   */
  async function migrateOriginEntries(all, db) {
    const keysToRemove = []
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
        void 0
      }
      const tx = db.transaction('origins', 'readwrite')
      const store = tx.objectStore('origins')
      for (const deviceId of value) store.put({ origin, deviceId: Number(deviceId) })
      await txDone(tx)
      keysToRemove.push(key)
    }
    return keysToRemove
  }

  /**
   * Flattens legacy `site:*` entries into per-name site setting keys.
   * @param {object} all
   * @returns {{patch: object, keysToRemove: string[]}}
   */
  function migrateSiteEntries(all) {
    const patch = {}
    const keysToRemove = []
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith('site:')) continue
      const origin = key.slice('site:'.length)
      for (const [name, v] of Object.entries(value)) patch[siteSettingKey(origin, name)] = v
      keysToRemove.push(key)
    }
    return { patch, keysToRemove }
  }

  /**
   * Maps legacy bare-name global settings to their prefixed keys.
   * @param {object} all
   * @returns {{patch: object, keysToRemove: string[]}}
   */
  function migrateGlobalEntries(all) {
    const patch = {}
    const keysToRemove = []
    for (const name of GLOBAL_NAMES) {
      if (name in all) {
        patch[globalSettingKey(name)] = all[name]
        keysToRemove.push(name)
      }
    }
    return { patch, keysToRemove }
  }

  /**
   * Migrates legacy browser.storage.local entries to the IndexedDB schema.
   * @returns {Promise<void>}
   */
  async function migrateLegacyStorage() {
    const all = await browser.storage.local.get(null)
    const db = await openDb()

    const keysToRemove = [
      ...(await migrateDeviceInfoEntries(all, db)),
      ...(await migrateOriginEntries(all, db))
    ]
    const site = migrateSiteEntries(all)
    const globals = migrateGlobalEntries(all)
    const patch = { ...site.patch, ...globals.patch }
    keysToRemove.push(...site.keysToRemove, ...globals.keysToRemove)

    if (Object.keys(patch).length) await browser.storage.local.set(patch)
    if (keysToRemove.length) await browser.storage.local.remove(keysToRemove)
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
    const key = globalSettingKey('daemonAsNmHost')
    const stored = await browser.storage.local.get(key)
    if (stored[key] === undefined) {
      const platformInfo = await browser.runtime.getPlatformInfo()
      if (platformInfo.os === 'win' || platformInfo.os === "mac") {
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

  browser.runtime.onStartup.addListener(() => {
    loadNmHostSetting().then(() => NativeMessaging.connect())
  })
  browser.runtime.onInstalled.addListener(() => {
    loadNmHostSetting().then(() => NativeMessaging.connect())
  })
  loadNmHostSetting().then(() => NativeMessaging.connect())
  browser.tabs.onRemoved.addListener((tabId) =>
    purgeTab(tabId, (deviceId, token) => NativeMessaging.closeDevice(deviceId, token))
  )

  ;(function scheduleOrphanRetry() {
    setTimeout(() => {
      retryOrphanCleanup((deviceId, token) => NativeMessaging.closeDevice(deviceId, token))
      scheduleOrphanRetry()
    }, 30000)
  })()

  const actionApi = browser.browserAction || browser.action || null
  if (actionApi && actionApi.onClicked) {
    actionApi.onClicked.addListener(function () {
      browser.runtime.openOptionsPage()
    })
  }

  const notificationsApi = browser.notifications || null
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
        if (!isChromium && browser.pageAction && browser.pageAction.openPopup)
          browser.pageAction.openPopup().catch((e) => logger.debug('openPopup failed', e))
        notificationsApi
          .clear('webhid-picker')
          .catch((e) => logger.debug('notifications.clear failed', e))
      }
    })
  }

  webhid.export('armShadowSpawn', (tabId, url) => {
    if (tabId == null || typeof url !== 'string' || !url) return
    const key = `${tabId}:${stripFragment(url)}`
    const existing = shadowArms.get(key)
    shadowArms.set(key, { count: (existing ? existing.count : 0) + 1, at: Date.now() })
  })

  webhid.export('unarmShadowSpawn', (tabId, url) => {
    if (tabId == null || typeof url !== 'string' || !url) return
    const key = `${tabId}:${stripFragment(url)}`
    const existing = shadowArms.get(key)
    if (!existing) return
    if (existing.count <= 1) shadowArms.delete(key)
    else shadowArms.set(key, { count: existing.count - 1, at: existing.at })
  })

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

  browser.tabs.onRemoved.addListener((tabId) => {
    browser.storage.session.get(null).then((all) => {
      const keys = Object.keys(all).filter((k) => k.startsWith(`csp:${tabId}:`))
      if (keys.length) browser.storage.session.remove(keys).catch(() => {})
    })
  })

  registerWebRequestHandlers(settings)
  registerMessageHandlers({ actionApi })
})()
