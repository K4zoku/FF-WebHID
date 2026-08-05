(function () {
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
    removeAllowedDevice,
    recordGrantGroup,
    getGrantGroupsForOrigin,
    deleteGrantGroups,
    getAllAllowedByOrigin
  } = webhid.import('bgStorage')
  const { registerDeviceTab, unregisterDeviceTab, isTabAuthorizedForDevice, purgeTab } =
    webhid.import('bgStateOps')
  const { ensureWorkerBundle, ensureWorkerPolyfillBundle } = webhid.import('bgBundle')
  const NativeMessaging = webhid.import('NativeMessaging')
  const { NM_HOST_FORWARDER, NM_HOST_DAEMON } = webhid.import('NM_HOST_NAMES')

  const STORAGE_SCHEMA_VERSION = 1
  const VERSION_KEY = 'meta :: storage :: version'
  const GLOBAL_NAMES = new Set(SETTING_NAMES)

  /** @type {number} */
  let lastHidPermission = 2

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
   * Firefox's default Accept header for top-level document navigations, keyed
   * by the first Firefox major version that introduced each value. Source:
   * MDN "List of default Accept values" (navigation row).
   * @type {Array<[number, string]>}
   */
  const NAVIGATION_ACCEPT_BY_VERSION = [
    [132, 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'],
    [
      128,
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/png,image/svg+xml,*/*;q=0.8'
    ],
    [92, 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8']
  ]

  /** Accept header matching the current Firefox's navigation default. */
  let navigationAccept = NAVIGATION_ACCEPT_BY_VERSION[0][1]

  browser.runtime
    .getBrowserInfo()
    .then((info) => {
      const major = Number.parseInt(info.version, 10)
      for (const [since, value] of NAVIGATION_ACCEPT_BY_VERSION) {
        if (major >= since) {
          navigationAccept = value
          break
        }
      }
    })
    .catch(() => {})

  /**
   * Sets a request header, replacing an existing header of the same name
   * (case-insensitively) or appending a new one.
   * @param {object[]} headers
   * @param {string} name
   * @param {string} value
   * @returns {object[]}
   */
  function setRequestHeader(headers, name, value) {
    const existing = headers.find((h) => h.name.toLowerCase() === name.toLowerCase())
    if (existing) existing.value = value
    else headers.push({ name, value })
    return headers
  }

  /**
   * Strips the fragment from a URL string.
   * @param {string} u
   * @returns {string}
   */
  function stripFragment(u) {
    const i = u.indexOf('#')
    return i === -1 ? u : u.slice(0, i)
  }

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
    return stripFragment(a) === stripFragment(b)
  }

  browser.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      const record = scriptDest.get(details.requestId)
      if (!record) return
      const header = (details.requestHeaders || []).find(
        (h) => h.name.toLowerCase() === 'sec-fetch-dest'
      )
      record.dest = header && header.value ? header.value : null
      if (!record.shadow || record.dest !== 'worker') return
      const headers = details.requestHeaders || (details.requestHeaders = [])
      // Fake a top-level user navigation so the server treats the shadow-URL
      // request as a plain page load instead of a worker fetch.
      setRequestHeader(headers, 'Sec-Fetch-Dest', 'document')
      setRequestHeader(headers, 'Sec-Fetch-Mode', 'navigate')
      setRequestHeader(headers, 'Sec-Fetch-Site', 'none')
      setRequestHeader(headers, 'Sec-Fetch-User', '?1')
      setRequestHeader(headers, 'Accept', navigationAccept)
      return { requestHeaders: headers }
    },
    { urls: ['<all_urls>'], types: ['script'] },
    ['blocking', 'requestHeaders']
  )

  /**
   * Redirect targets that continue a shadow-URL chain. Firefox keeps the same
   * requestId across a redirect chain, so the follow-up request cannot be told
   * apart by id; the onBeforeRequest listener matches it by URL instead and
   * keeps treating it as shadow. The chain is followed to the end: the browser
   * itself aborts after its own redirect limit (~20), which also bounds this
   * set.
   * @type {Set<string>}
   */
  const shadowRedirectTargets = new Set()

  browser.webRequest.onBeforeRedirect.addListener(
    (details) => {
      const record = scriptDest.get(details.requestId)
      if (!record || !record.shadow || !details.redirectUrl) return
      // A redirect to the request's own URL is not a useful hop: Firefox can
      // report one (self) firing alongside the real redirect target for the
      // first shadow request. Skip it entirely.
      if (stripFragment(details.redirectUrl) === stripFragment(details.url)) return
      scriptDest.delete(details.requestId)
      shadowRedirectTargets.add(stripFragment(details.redirectUrl))
    },
    { urls: ['<all_urls>'], types: ['script'] }
  )

  /**
   * Serves the worker bundle for the polyfill's own `new Worker(location.href)`
   * self-request (the shadow URL). When Sec-Fetch-Dest is observable and is not
   * "worker", the request is a page script whose URL merely equals the document
   * URL, and the response passes through untouched. Server redirects on the
   * shadow URL are followed to the end of the chain, with each hop treated the
   * same way.
   * @param {object} details
   * @returns {object | undefined}
   */
  function handleShadowUrl(details) {
    const record = { dest: null, shadow: true }
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
      const urlKey = stripFragment(details.url)
      if (shadowRedirectTargets.has(urlKey)) {
        shadowRedirectTargets.delete(urlKey)
        return handleShadowUrl(details)
      }
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

  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.type !== 'main_frame' && details.type !== 'sub_frame') return
      handleMetaCsp(details)
    },
    { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame'] },
    ['blocking']
  )

  /**
   * @param {object} details
   * @returns {void}
   */
  function handleMetaCsp(details) {
    const filter = browser.webRequest.filterResponseData(details.requestId)
    const enc = new TextEncoder()
    const dec = new TextDecoder()
    const rawChunks = []
    let scanText = ''
    let gaveUp = false
    let processed = false

    const origin = urlOrigin(details.url)

    const modePromise = (async () => {
      let mode = settings.workerSpawnMode
      if (origin) {
        const siteKey = siteSettingKey(origin, 'workerSpawnMode')
        const res = await browser.storage.local.get(siteKey).catch(() => ({}))
        if (res[siteKey] !== undefined) mode = res[siteKey]
      }
      return mode
    })()

    /** @returns {void} */
    function passthrough() {
      for (const buf of rawChunks) filter.write(buf)
      filter.disconnect()
    }

    /**
     * @param {boolean} eof
     * @returns {Promise<void>}
     */
    async function process(eof) {
      if (processed) return
      const headEnd = scanText.toLowerCase().indexOf('</head>')
      if (headEnd === -1 && !eof && !gaveUp) return
      processed = true
      const mode = await modePromise
      const html = scanText + dec.decode()
      const end = headEnd === -1 ? html.length : headEnd
      const head = html.slice(0, end)
      const metaInfos = []
      let anyChange = false
      const rewrittenHead = head.replace(/<meta\s[^>]*>/gi, (tag) => {
        if (!/http-equiv\s*=\s*["']?\s*content-security-policy\s*["']?/i.test(tag)) return tag
        const contentMatch = tag.match(/\bcontent\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i)
        if (!contentMatch) return tag
        const quote = contentMatch[2] !== undefined ? '"' : contentMatch[3] !== undefined ? "'" : ''
        const csp = contentMatch[2] ?? contentMatch[3] ?? contentMatch[4] ?? ''
        const info = parseCspForWorkerSpawn([csp], mode, origin)
        if (!info) return tag
        metaInfos.push(info)
        if (!info.needsBlobFallback) return tag
        const { value, modified } = rewriteCspValue(csp, info)
        if (!modified) return tag
        anyChange = true
        return tag.replace(contentMatch[0], 'content=' + (quote || '"') + value + (quote || '"'))
      })

      if (metaInfos.length) {
        const key = `csp:${frameKey(details.tabId, details.frameId, origin)}`
        browser.storage.session.get(key).then((r) => {
          const existing = r[key]
          const merged = {
            workerSrc: metaInfos[0].workerSrc ?? existing?.workerSrc,
            connectSrc: metaInfos[0].connectSrc ?? existing?.connectSrc,
            workerSrcBlocked: metaInfos.some((i) => i.workerSrcBlocked) || !!existing?.workerSrcBlocked,
            connectSrcBlocked: metaInfos.some((i) => i.connectSrcBlocked) || !!existing?.connectSrcBlocked,
            hasTrustedTypesRequire:
              metaInfos.some((i) => i.hasTrustedTypesRequire) || !!existing?.hasTrustedTypesRequire,
            shadowBlocked: metaInfos.some((i) => i.shadowBlocked) || !!existing?.shadowBlocked,
            metaShadowBlocked:
              metaInfos.some((i) => i.shadowBlocked) || !!existing?.metaShadowBlocked,
            headerShadowBlocked: !!existing?.headerShadowBlocked,
            needsBlobFallback: metaInfos.some((i) => i.needsBlobFallback) || !!existing?.needsBlobFallback,
          }
          browser.storage.session.set({ [key]: merged }).catch(() => {})
        }).catch(() => {})
      }

      if (!anyChange) {
        passthrough()
        return
      }
      filter.write(enc.encode(rewrittenHead + html.slice(end)))
      filter.close()
    }

    filter.ondata = (e) => {
      rawChunks.push(e.data)
      if (processed) return
      if (scanText.length < 262144) scanText += dec.decode(e.data, { stream: true })
      else gaveUp = true
      process(false)
    }
    filter.onstop = () => {
      process(true)
    }
    filter.onerror = () => {
      try { filter.disconnect() } catch { return }
    }
  }

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
        const key = frameKey(details.tabId, details.frameId, urlOrigin(details.url))
        permissionsPolicy.set(key, parsed)
        logger.debug('Permissions-Policy stored: ' + key + ' hid=' + parsed)
        break
      }
      return {}
    },
    { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame'] },
    ['blocking', 'responseHeaders']
  )

  const isMv2 = browser.runtime.getManifest().manifest_version === 2

  browser.webRequest.onHeadersReceived.addListener(
    async (details) => {
      if (details.type !== 'main_frame' && details.type !== 'sub_frame') return
      const cspValues = (details.responseHeaders || [])
        .filter((h) => h.name.toLowerCase() === 'content-security-policy')
        .map((h) => h.value || '')

      const origin = urlOrigin(details.url)
      const key = `csp:${frameKey(details.tabId, details.frameId, origin)}`

      let siteSpawnMode = settings.workerSpawnMode
      if (origin) {
        const siteKey = siteSettingKey(origin, 'workerSpawnMode')
        const siteResult = await browser.storage.local.get(siteKey)
        if (siteResult[siteKey] !== undefined) {
          siteSpawnMode = siteResult[siteKey]
        }
      }

      const cspInfo = parseCspForWorkerSpawn(cspValues, siteSpawnMode, origin)
      if (cspInfo) cspInfo.headerShadowBlocked = cspInfo.shadowBlocked
      let modified = null
      if (isMv2 && cspInfo && cspInfo.needsBlobFallback) {
        modified = rewriteCspForBlob(details.responseHeaders, cspInfo)
        if (modified) {
          cspInfo.rewrittenCsp = modified
            .filter((h) => h.name.toLowerCase() === 'content-security-policy')
            .map((h) => h.value)
        }
      }
      if (cspInfo) {
        browser.storage.session.set({ [key]: cspInfo })
          .catch((e) => logger.debug('csp session store failed', e))
      } else {
        browser.storage.session.remove(key).catch(() => {})
      }
      if (modified) return { responseHeaders: modified }
    },
    { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame'] },
    ['blocking', 'responseHeaders']
  )

  // A frame navigating to another origin in the same tab must not read the
  // previous document's cached CSP / Permissions-Policy. Purge both caches
  // when the navigation request starts (webRequest, no extra permission);
  // fresh values are stored again when the new response headers arrive. The
  // origin-scoped keys make any missed purge fail safe (lookup mismatch).
  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.tabId === undefined || details.frameId === undefined) return
      const prefix = `${details.tabId}:${details.frameId}:`
      for (const k of permissionsPolicy.keys()) {
        if (k.startsWith(prefix)) permissionsPolicy.delete(k)
      }
      browser.storage.session
        .get(null)
        .then((all) => {
          const keys = Object.keys(all).filter((k) => k.startsWith(`csp:${prefix}`))
          if (keys.length) browser.storage.session.remove(keys).catch(() => {})
        })
        .catch(() => {})
    },
    { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame'] }
  )

  browser.tabs.onRemoved.addListener((tabId) => {
    browser.storage.session.get(null).then((all) => {
      const keys = Object.keys(all).filter((k) => k.startsWith(`csp:${tabId}:`))
      if (keys.length) browser.storage.session.remove(keys).catch(() => {})
    })
  })

  /**
   * @param {string} url
   * @returns {string}
   */
  function urlOrigin(url) {
    try {
      return new URL(url).origin
    } catch {
      return ''
    }
  }

  /**
   * Builds an origin-scoped cache key for a frame. The origin component makes
   * a stale entry from a previous document on the same (tab, frame) naturally
   * miss when the frame navigates to a different origin, instead of serving
   * the old origin's policy to the new document.
   * @param {number} tabId
   * @param {number} frameId
   * @param {string} origin
   * @returns {string}
   */
  function frameKey(tabId, frameId, origin) {
    return `${tabId}:${frameId}:${origin || ''}`
  }

  /**
   * @param {string} csp
   * @param {object} cspInfo
   * @returns {{value: string, modified: boolean}}
   */
  function rewriteCspValue(csp, cspInfo) {
    const { directives, order } = parseDirectives(csp || '')
    let modified = false

    if (directives['worker-src'] !== undefined) {
      if (!directives['worker-src'].includes('blob:')) {
        directives['worker-src'] = directives['worker-src'] + ' blob:'
        modified = true
      }
    } else {
      const fallback = directives['script-src'] ?? directives['default-src']
      if (fallback !== undefined) {
        directives['worker-src'] = fallback + ' blob:'
        order.push('worker-src')
        modified = true
      }
    }

    if (directives['connect-src'] !== undefined) {
      if (!sourceListAllowsDaemonConnects(directives['connect-src'])) {
        directives['connect-src'] =
          directives['connect-src'] + ' ws://127.0.0.1:* https://127.0.0.1:*'
        modified = true
      }
    } else if (directives['default-src'] !== undefined) {
      directives['connect-src'] =
        directives['default-src'] + ' ws://127.0.0.1:* https://127.0.0.1:*'
      order.push('connect-src')
      modified = true
    }

    if (cspInfo.hasTrustedTypesRequire) {
      const ttList = directives['trusted-types']
      if (ttList === undefined) {
        directives['trusted-types'] = 'webhid-worker'
        order.push('trusted-types')
        modified = true
      } else if (!ttList.includes('webhid-worker')) {
        directives['trusted-types'] = ttList + ' webhid-worker'
        modified = true
      }
    }

    const rebuilt = order.map((name) => name + (directives[name] ? ' ' + directives[name] : '')).join('; ')
    return { value: rebuilt, modified }
  }

  /**
   * @param {Array|null} headers
   * @param {object} cspInfo
   * @returns {Array|null}
   */
  function rewriteCspForBlob(headers, cspInfo) {
    if (!headers) return null
    let modified = false
    const newHeaders = headers.map((h) => {
      if (h.name.toLowerCase() !== 'content-security-policy') return h
      const { value, modified: changed } = rewriteCspValue(h.value || '', cspInfo)
      if (changed) modified = true
      return { name: h.name, value }
    })
    return modified ? newHeaders : null
  }

  /**
   * @param {string} csp
   * @returns {{directives: object, order: string[]}}
   */
  function parseDirectives(csp) {
    const directives = {}
    const order = []
    for (const raw of csp.split(';')) {
      const trimmed = raw.trim()
      if (!trimmed) continue
      const parts = trimmed.split(/\s+/)
      const name = parts[0].toLowerCase()
      if (directives[name] !== undefined) continue
      directives[name] = parts.slice(1).join(' ')
      order.push(name)
    }
    return { directives, order }
  }

  /**
   * @param {string} list
   * @param {string} origin
   * @returns {boolean}
   */
  function sourceListAllowsWorker(list, origin) {
    const tokens = list.split(/\s+/)
    return tokens.includes('*') || tokens.includes("'self'") || tokens.includes(origin)
      || tokens.includes('http:') || tokens.includes('https:')
  }

  /**
   * @param {string} list
   * @returns {boolean}
   */
  function sourceListAllowsDaemonConnects(list) {
    const tokens = list.split(/\s+/)
    return (
      tokens.includes('*') ||
      tokens.includes('ws:') ||
      tokens.includes('ws://127.0.0.1:*') ||
      tokens.includes('https:') ||
      tokens.includes('https://127.0.0.1:*')
    )
  }

  /**
   * @param {Array|null} cspValues
   * @param {string} spawnMode
   * @param {string} pageOrigin
   * @returns {object|null}
   */
  function parseCspForWorkerSpawn(cspValues, spawnMode, pageOrigin) {
    const mode = spawnMode || settings.workerSpawnMode
    if (!cspValues || cspValues.length === 0) return null
    let workerSrc
    let connectSrc
    let workerSrcBlocked = false
    let connectSrcBlocked = false
    let hasTrustedTypesRequire = false
    const trustedTypesNames = []
    for (const csp of cspValues.flatMap((v) => v.split(','))) {
      const { directives } = parseDirectives(csp)
      const effWorker = directives['worker-src'] ?? directives['script-src'] ?? directives['default-src']
      const effConnect = directives['connect-src'] ?? directives['default-src']
      if (workerSrc === undefined) workerSrc = effWorker
      if (connectSrc === undefined) connectSrc = effConnect
      if (effWorker !== undefined && !sourceListAllowsWorker(effWorker, pageOrigin)) {
        workerSrcBlocked = true
      }
      if (effConnect !== undefined && !sourceListAllowsDaemonConnects(effConnect)) {
        connectSrcBlocked = true
      }
      const tt = directives['require-trusted-types-for']
      if (tt !== undefined && tt.includes("'script'")) hasTrustedTypesRequire = true
      const ttList = directives['trusted-types']
      if (ttList !== undefined) {
        for (const token of ttList.split(/\s+/)) {
          if (token === "'none'" || token === "'allow-duplicates'") continue
          if (!trustedTypesNames.includes(token)) trustedTypesNames.push(token)
        }
      }
    }
    const shadowBlocked = workerSrcBlocked || connectSrcBlocked || hasTrustedTypesRequire
    const needsBlobFallback = mode === 'blob' || (mode === 'shadow' && shadowBlocked)
    return {
      workerSrc,
      connectSrc,
      workerSrcBlocked,
      connectSrcBlocked,
      hasTrustedTypesRequire,
      trustedTypesNames,
      shadowBlocked,
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

      case 'getBackendStatus':
        (async () => {
          try {
            const resp = await NativeMessaging.handshake()
            if (typeof resp.P === 'number') lastHidPermission = resp.P
            sendResponse({
              nmConnected: NativeMessaging.port != null,
              daemonReachable: http.isOk(resp.s),
              hidPermission: typeof resp.P === 'number' ? resp.P : lastHidPermission,
              lastError: NativeMessaging.lastError || null
            })
          } catch {
            sendResponse({
              nmConnected: NativeMessaging.port != null,
              daemonReachable: false,
              hidPermission: lastHidPermission,
              lastError: NativeMessaging.lastError || null
            })
          }
        })()
        return true

      case 'recordGrantGroup':
        (async () => {
          try {
            if (!request.origin || !Array.isArray(request.deviceIds)) {
              sendResponse({ success: false })
              return
            }
            await recordGrantGroup(request.origin, request.deviceIds)
            sendResponse({ success: true })
          } catch (e) {
            sendResponse({ success: false, error: e.message })
          }
        })()
        return true

      case 'getGrantGroups':
        (async () => {
          try {
            const groups = await getGrantGroupsForOrigin(request.origin)
            sendResponse({ success: true, groups })
          } catch {
            sendResponse({ success: false, groups: [] })
          }
        })()
        return true

      case 'getAllPairedDevices':
        (async () => {
          try {
            const byOrigin = await getAllAllowedByOrigin()
            const origins = []
            for (const [origin, deviceIds] of byOrigin.entries()) {
              const devices = []
              for (const deviceId of deviceIds) {
                const info = await getDeviceInfo(deviceId)
                devices.push({
                  deviceId,
                  name: info ? info.productName || '' : '',
                  vendorId: info ? info.vendorId || 0 : 0,
                  productId: info ? info.productId || 0 : 0,
                  manufacturer: info ? info.manufacturer || '' : ''
                })
              }
              origins.push({ origin, devices })
            }
            origins.sort((a, b) => a.origin.localeCompare(b.origin))
            sendResponse({ success: true, origins })
          } catch (e) {
            sendResponse({ success: false, error: e.message, origins: [] })
          }
        })()
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
              // The daemon refreshes its permission status on the real open
              // (Linux EACCES); keep the freshest value for getBackendStatus.
              if (typeof response.P === 'number') lastHidPermission = response.P
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
        NativeMessaging.closeDevice(request.deviceId, request.T)
          .then((response) => {
            if (http.isOk(response.s)) unregisterDeviceTab(request.deviceId, tabId)
            sendResponse(response)
          })
          .catch(() => sendResponse({ s: 500 }))
        return true
      }

      case 'revokeDevice': {
        (async () => {
          try {
            const origin = request.origin
            if (!origin) {
              sendResponse({ success: false, error: 'no origin' })
              return
            }
            // Devices granted together by one requestDevice() call must be
            // forgotten as a group: revoking one interface must not leave the
            // others with live access. Callers may pass a whole display group
            // (deviceIds) or a single device (deviceId); grant groups are
            // unioned across all of them.
            const targetIds =
              Array.isArray(request.deviceIds) && request.deviceIds.length
                ? request.deviceIds.map((id) => Number(id))
                : [Number(request.deviceId)]
            const groups = await getGrantGroupsForOrigin(origin)
            const memberGroups = groups.filter((g) =>
              g.deviceIds.some((id) => targetIds.includes(id))
            )
            /** @type {Set<number>} */
            const toRevoke = new Set(targetIds)
            for (const g of memberGroups) {
              for (const id of g.deviceIds) toRevoke.add(Number(id))
            }
            for (const deviceId of toRevoke) {
              await removeAllowedDevice(origin, deviceId)
              removeDeviceInfo(deviceId)
              await NativeMessaging.closeDevice(deviceId).catch(() => {})
            }
            await deleteGrantGroups(memberGroups.map((g) => g.id))
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
              for (const deviceId of toRevoke) {
                unregisterDeviceTab(deviceId, tab.id)
                browser.tabs
                  .sendMessage(tab.id, {
                    action: 'webhidDeviceEvent',
                    event: { eventType: 'revoked', deviceId }
                  })
                  .catch(() => {})
              }
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

      case 'getCspInfo': {
        const tabId = sender.tab != null ? sender.tab.id : undefined
        if (tabId == null) {
          sendResponse(null)
          return false
        }
        // Prefer the frame's own origin (the bridge passes it explicitly);
        // sender.tab.url is the top-level document, wrong for cross-origin
        // frames.
        const origin = urlOrigin(request.origin || (sender.tab && sender.tab.url) || '')
        const key = `csp:${frameKey(tabId, sender.frameId ?? 0, origin)}`
        browser.storage.session.get(key)
          .then((r) => sendResponse(r[key] ?? null))
          .catch(() => sendResponse(null))
        return true
      }

      case 'getWorkerBundle':
        ensureWorkerBundle()
          .then((text) => sendResponse({ text }))
          .catch((e) => sendResponse({ error: e.message || String(e) }))
        return true

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
        // The frame's own origin: the bridge relays the frame's URL as
        // `url` (sender.tab.url is the top page, wrong for cross-origin
        // iframes).
        const origin = urlOrigin(request.url || (sender.tab && sender.tab.url) || '')
        let hid = null
        if (tid != null) hid = permissionsPolicy.get(frameKey(tid, sid, origin))
        if (hid == null && tid != null) hid = permissionsPolicy.get(frameKey(tid, 0, origin))
        if (hid === 'none') {
          sendResponse({ policy: { hid: 'none' } })
          return true
        }
        if (request.isCrossOrigin) {
          if (request.hasAllowAttr) {
            sendResponse({ policy: { hid: 'allowed' } })
            return true
          }
          let allowKey = tid != null ? frameKey(tid, sid, origin) : null
          if (allowKey && allowedCrossOrigin.has(allowKey)) {
            sendResponse({ policy: { hid: 'allowed' } })
            return true
          }
          const urlKey = `url:${urlOrigin(sender.tab && sender.tab.url)}:${request.url}`
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
        // The embedder (top frame) grants the embedded URL; scope by the
        // embedder's origin so the allow does not leak across tabs or after
        // the tab navigates to another origin.
        const embedderOrigin = urlOrigin(sender.tab && sender.tab.url)
        if (request.frameId === -1 && request.url) {
          key = `url:${embedderOrigin}:${request.url}`
        } else {
          const tid = sender.tab?.id
          if (tid == null) {
            sendResponse({ ok: false })
            return false
          }
          // Origin-scoped like the read side (getPolicy): an iframe that
          // navigates to another origin must not keep the allow.
          key = frameKey(tid, request.frameId, urlOrigin(request.url || (sender.tab && sender.tab.url) || ''))
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
