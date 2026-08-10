;(function () {
  'use strict'

  /** @type {import("./types.js").Logger} */
  const logger = webhid.import('logger')
  const http = webhid.import('http')
  const createSettingsStore = webhid.import('createSettingsStore')
  const loadGlobalSettings = webhid.import('loadGlobalSettings')
  const loadSiteSettings = webhid.import('loadSiteSettings')
  const siteSettingKey = webhid.import('siteSettingKey')
  const parseSettingsKey = webhid.import('parseSettingsKey')
  const WebHidDevicePicker = webhid.import('WebHidDevicePicker')
  logger.initLogger('bridge')

  const devicePicker = new WebHidDevicePicker()
  document.documentElement.appendChild(devicePicker.host)

  const PAGE_BLOCKED_ACTIONS = new Set([
    'pairDevice',
    'recordGrantGroup',
    'getGrantGroups',
    'getAllPairedDevices',
    'revokeDevice',
    'getDeviceCache',
    'getDeviceInfo',
    'showPicker',
    'pickerResult'
  ])

  /** @type {Set<string>} */
  const openDevices = new Set()
  /** @type {Map<string, string>} */
  const sessionTokens = new Map()

  browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getOpenDeviceIds') {
      sendResponse({ ids: Array.from(openDevices) })
      return true
    }
    if (request.action === 'getFrameOrigins') {
      sendResponse({ origins: collectFrameOrigins() })
      return true
    }
    if (request.action === 'getDataPlaneStatus') {
      const planes = []
      const seen = new Set()
      for (const [deviceId, transport] of deviceTransports) {
        if (workers.has(deviceId)) {
          planes.push({ deviceId, plane: transport, mode: 'worker' })
          seen.add(deviceId)
        }
      }
      for (const deviceId of inPageDevices) {
        if (!seen.has(deviceId)) {
          planes.push({ deviceId, plane: 'wt', mode: 'inpage' })
          seen.add(deviceId)
        }
      }
      for (const deviceId of nmPlanes) {
        if (!seen.has(deviceId)) planes.push({ deviceId, plane: 'nm', mode: null })
      }
      sendResponse({ planes, defaultPlane: settings.dataPlane })
      return true
    }
  })

  /** @type {Map<string, object>} */
  const workers = new Map()
  /** @type {Set<string>} */
  const workerReadyDevices = new Set()
  /** @type {Map<string, object>} */
  const connectParams = new Map()
  /** @type {Map<string, string>} */
  const deviceTransports = new Map()
  /** @type {Set<string>} */
  const nmPlanes = new Set()
  /** @type {Map<string, MessagePort>} */
  const dataPorts = new Map()
  /** @type {number|null} */
  let wsPort = null
  /** @type {string|null} */
  let wsNonce = null
  /** @type {number|null} */
  let wtPort = null
  /** @type {string|null} */
  let wtCertHash = null
  /** @type {import("./types.js").SettingsStore} */
  const settings = createSettingsStore(webhid.import('GLOBAL_DEFAULTS'))
  logger.bindSettings(settings)
  /** @type {Map<Window, MessagePort>} */
  const pagePorts = new Map()
  /** @type {Map<MessagePort, Window>} */
  const pageSourceByPort = new Map()
  /** @type {Map<string, MessagePort>} */
  const requestPortMap = new Map()
  /** @type {Map<MessagePort, string>} */
  const portOrigin = new Map()
  /** @type {Map<Window, boolean>} */
  const allowAttrMap = new Map()
  /** @type {Map<string, number>} */
  const spawnGen = new Map()

  const allowedDeviceIds = new Set()
  let allowedDeviceIdsReady = false
  const allowedDeviceIdsQueue = []

  /**
   * Resolves all queued isDeviceAllowed promises with the current allowed set.
   * @returns {void}
   */
  function flushAllowedDeviceIdsQueue() {
    while (allowedDeviceIdsQueue.length) {
      const { deviceId, resolve } = allowedDeviceIdsQueue.shift()
      resolve(allowedDeviceIds.has(deviceId))
    }
  }

  /**
   * Checks whether a device is in the allowed set, queuing if not yet loaded.
   * @param {string} deviceId
   * @returns {Promise<boolean>}
   */
  function isDeviceAllowed(deviceId) {
    if (allowedDeviceIdsReady) return Promise.resolve(allowedDeviceIds.has(deviceId))
    return new Promise((resolve) => {
      allowedDeviceIdsQueue.push({ deviceId, resolve })
    })
  }

  /**
   * Loads the allowed device IDs for the current origin from the background.
   * @returns {Promise<void>}
   */
  async function loadAllowedDeviceIds() {
    try {
      const resp = await browser.runtime.sendMessage({
        action: 'getAllowedDevices',
        origin: window.location.origin
      })
      if (resp && Array.isArray(resp.deviceIds)) {
        allowedDeviceIds.clear()
        for (const id of resp.deviceIds) allowedDeviceIds.add(id)
      }
    } catch (e) {
      logger.warn('loadAllowedDeviceIds failed:', e.message)
    }
    allowedDeviceIdsReady = true
    flushAllowedDeviceIdsQueue()
  }

  /**
   * @param {string} sessionToken
   * @returns {Promise<string|null>}
   */
  async function computeWsAuthHash(sessionToken) {
    if (!wsNonce || !sessionToken) return null
    const data = new TextEncoder().encode(sessionToken + wsNonce)
    const digest = await crypto.subtle.digest('SHA-256', data)
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }

  /**
   * @param {string} deviceId
   * @param {{keepPort?: boolean}} [opts]
   * @returns {Promise<void>}
   */
  async function despawnDataPlane(deviceId, { keepPort = false } = {}) {
    const gen = (spawnGen.get(deviceId) || 0) + 1
    spawnGen.set(deviceId, gen)
    if (inPageDevices.has(deviceId)) {
      inPageDevices.delete(deviceId)
      const pagePort = pagePorts.get(window)
      if (pagePort) pagePort.postMessage({ type: 'dataPlaneDisconnect', deviceId })
    }
    const worker = workers.get(deviceId)
    if (worker) {
      const port = dataPorts.get(deviceId)
      if (port && !keepPort) {
        dataPorts.delete(deviceId)
        try {
          port.onmessage = null
          port.close()
        } catch (e) {
          logger.debug('port cleanup failed (port path)', e)
        }
      }
      worker.terminate()
      workers.delete(deviceId)
      workerReadyDevices.delete(deviceId)
    } else if (!keepPort) {
      const port = dataPorts.get(deviceId)
      if (port) {
        try {
          port.onmessage = null
          port.close()
        } catch (e) {
          logger.debug('port cleanup failed (no worker)', e)
        }
      }
      dataPorts.delete(deviceId)
    }
    connectParams.delete(deviceId)
    deviceTransports.delete(deviceId)
    nmPlanes.delete(deviceId)
    spawnGen.delete(deviceId)
  }

  /**
   * @param {string} deviceId
   * @returns {Promise<void>}
   */
  async function refreshDataPlaneToken(deviceId) {
    if (workers.has(deviceId)) return
    try {
      const resp = await browser.runtime.sendMessage({
        action: 'open',
        deviceId
      })
      if (http.isOk(resp.s) && resp.t) {
        sessionTokens.set(deviceId, resp.t)
        spawnDataPlane(deviceId, resp.t, resp.w || wsPort, { rewire: true })
      } else {
        logger.error(
          'data plane token refresh failed for',
          deviceId,
          's=' + (resp != null ? resp.s : 0)
        )
      }
    } catch (e) {
      logger.error('data plane token refresh error:', e.message)
    }
  }

  let cachedSpawnMode = null

  /**
   * @returns {Promise<string>}
   */
  async function resolveSpawnMode() {
    if (cachedSpawnMode) return cachedSpawnMode
    const origin = window.location.origin
    let mode = settings.workerSpawnMode
    if (origin) {
      const siteKey = siteSettingKey(origin, 'workerSpawnMode')
      const siteResult = await browser.storage.local.get(siteKey)
      if (siteResult[siteKey] !== undefined) mode = siteResult[siteKey]
    }
    if (mode === 'blob') {
      cachedSpawnMode = 'blob'
      return 'blob'
    }
    try {
      const info = await browser.runtime.sendMessage({
        action: 'getCspInfo',
        origin: window.location.origin
      })
      if (info && info.needsBlobFallback) {
        if (mode === 'shadow') {
          cachedSpawnMode = 'nm'
          return 'nm'
        }
        const mv2 = browser.runtime.getManifest().manifest_version === 2
        if (!mv2 && info.headerShadowBlocked) {
          cachedSpawnMode = 'nm'
          return 'nm'
        }
        cachedSpawnMode = 'blob'
        return 'blob'
      }
    } catch (e) {
      logger.debug('getCspInfo failed', e)
    }
    cachedSpawnMode = 'shadow'
    return 'shadow'
  }

  /**
   * @returns {Promise<string>}
   */
  async function fetchWorkerBundle() {
    const resp = await browser.runtime.sendMessage({ action: 'getWorkerBundle' })
    if (!resp || !resp.text) throw new Error('worker bundle fetch failed')
    return resp.text
  }

  /** @type {Map<string, object>} */
  const pendingSpawns = new Map()
  let spawnReqSeq = 0
  /** @type {Set<string>} */
  const inPageDevices = new Set()
  /** @type {Map<string, {resolve: Function, timer: ReturnType<typeof setTimeout>}>} */
  const pendingPlaneSpawns = new Map()
  let planeReqSeq = 0

  /**
   * @param {object} payload
   * @returns {Promise<object>}
   */
  function requestMainWorldSpawn(payload) {
    const port = pagePorts.get(window)
    if (!port) return Promise.reject(new Error('no page port for worker spawn'))
    return new Promise((resolve, reject) => {
      const id = 'spawn:' + ++spawnReqSeq
      const timer = setTimeout(() => {
        pendingSpawns.delete(id)
        reject(new Error('worker spawn request timeout'))
      }, 10000)
      pendingSpawns.set(id, { resolve, reject, timer })
      port.postMessage({ type: 'spawnWorkerRequest', id, payload })
    })
  }

  /**
   * @param {object} port
   * @returns {object}
   */
  function makeWorkerProxy(port) {
    const proxy = {}
    let onerrorHandler = null
    proxy.postMessage = (msg, transfer) => port.postMessage(msg, transfer)
    proxy.terminate = () => port.postMessage({ type: 'terminate' })
    Object.defineProperty(proxy, 'onmessage', {
      set(fn) {
        port.onmessage = (event) => {
          if (event.data && event.data.type === 'worker-error') {
            if (onerrorHandler) onerrorHandler({ message: event.data.message })
          } else if (fn) {
            fn(event)
          }
        }
      },
      configurable: true
    })
    Object.defineProperty(proxy, 'onerror', {
      set(fn) {
        onerrorHandler = fn
      },
      configurable: true
    })
    return proxy
  }

  /**
   * Asks the page to spawn a main-world worker in the given mode.
   * @param {string} deviceId
   * @param {string} mode
   * @returns {Promise<object>}
   */
  async function attemptWorkerSpawn(deviceId, mode) {
    if (mode === 'blob') {
      return requestMainWorldSpawn({
        mode: 'blob',
        bundleText: await fetchWorkerBundle(),
        deviceId
      })
    }
    return requestMainWorldSpawn({ mode: 'shadow', deviceId })
  }

  /**
   * @param {string} deviceId
   * @param {string} sessionToken
   * @param {number} wsPort
   * @param {object} [opts]
   * @param {number} [opts.reportSize]
   * @param {number} gen
   * @returns {Promise<boolean>}
   */
  async function spawnWorker(deviceId, sessionToken, wsPort, opts = {}, gen) {
    if (workers.has(deviceId)) return true
    const wsAuthHash = await computeWsAuthHash(sessionToken)
    if (!wsAuthHash) {
      logger.warn(
        'cannot derive WS auth hash for',
        deviceId,
        '; wsNonce missing — falling back to NM'
      )
      return false
    }
    let spawnResult = null
    let spawnMode = await resolveSpawnMode()
    if (spawnMode === 'nm') {
      logger.info('page CSP blocks all worker spawn modes for', deviceId, '; using NM data plane')
      return false
    }
    try {
      spawnResult = await attemptWorkerSpawn(deviceId, spawnMode)
    } catch (e) {
      logger.warn('worker spawn failed for', deviceId, '(', spawnMode, '):', e.message)
    }
    if (!spawnResult || !spawnResult.ok) return false

    if (spawnGen.get(deviceId) !== gen) {
      logger.info('worker spawn stale, discarding for', deviceId)
      requestMainWorldSpawn({ mode: 'terminate', deviceId }).catch(() => {})
      return false
    }
    workers.set(deviceId, null)
    deviceTransports.set(deviceId, opts.wtPort != null ? 'wt' : 'ws')
    connectParams.set(deviceId, {
      transport: opts.wtPort != null ? 'wt' : 'ws',
      wsPort: opts.wtPort != null ? undefined : wsPort,
      wtPort: opts.wtPort != null ? opts.wtPort : undefined,
      wtCertHash: opts.wtPort != null ? opts.wtCertHash : undefined,
      token: wsAuthHash,
      reportSize: opts.reportSize || 64,
      logLevel: logger.level
    })
    return true
  }

  /**
   * @param {string} deviceId
   * @param {string} sessionToken
   * @param {number} wsPort
   * @param {object} [opts]
   * @returns {Promise<void>}
   */
  /**
   * @param {string} deviceId
   * @param {string} sessionToken
   * @param {object} opts
   * @returns {Promise<boolean>}
   */
  async function spawnInPageDataPlane(deviceId, sessionToken, opts) {
    const wsAuthHash = await computeWsAuthHash(sessionToken)
    if (!wsAuthHash) return false
    const port = pagePorts.get(window)
    if (!port) return false
    return new Promise((resolve) => {
      const id = 'plane:' + ++planeReqSeq
      const timer = setTimeout(() => {
        pendingPlaneSpawns.delete(id)
        inPageDevices.delete(deviceId)
        resolve(false)
      }, 10000)
      pendingPlaneSpawns.set(id, { resolve, timer, deviceId })
      inPageDevices.add(deviceId)
      port.postMessage({
        type: 'dataPlaneConnect',
        id,
        deviceId,
        payload: {
          transport: 'wt',
          wtPort: opts.wtPort,
          wtCertHash: opts.wtCertHash,
          token: wsAuthHash,
          reportSize: opts.reportSize || 64,
          logLevel: logger.level
        }
      })
    })
  }

  /**
   * @param {string} deviceId
   * @param {string} sessionToken
   * @param {number} wsPort
   * @param {object} [opts]
   * @returns {Promise<void>}
   */
  async function spawnDataPlane(deviceId, sessionToken, wsPort, opts = {}) {
    const gen = (spawnGen.get(deviceId) || 0) + 1
    spawnGen.set(deviceId, gen)
    let ok
    if (settings.useWorker === false && opts.wtPort != null) {
      ok = await spawnInPageDataPlane(deviceId, sessionToken, opts)
    } else {
      ok = await spawnWorker(deviceId, sessionToken, wsPort, opts, gen)
      if (ok && opts.rewire) {
        const pagePort = pagePorts.get(window)
        if (pagePort) pagePort.postMessage({ type: 'wireWorkerPort', deviceId })
      }
    }
    if (!ok && spawnGen.get(deviceId) === gen) {
      logger.warn('data plane spawn failed for', deviceId, '; falling back to NM')
      nmPlanes.add(deviceId)
      deviceTransports.delete(deviceId)
      browser.runtime
        .sendMessage({
          action: 'setDataPlane',
          deviceId: deviceId,
          mode: 'nm',
          sessionToken: sessionToken
        })
        .catch((e) => logger.debug('setDataPlane NM fallback failed', e))
    }
  }

  ;(async () => {
    try {
      const resp = await browser.runtime.sendMessage({ action: 'handshake' })
      if (http.isOk(resp.s) && resp.w) {
        wsPort = resp.w
        wsNonce = resp.N || null
        wtPort = resp.W || null
        wtCertHash = resp.H || null
        if (!wsNonce) {
          logger.warn(
            'handshake: daemon did not send ws_nonce (old version?); ' +
              'WS data plane will fall back to NM'
          )
        }
        const global = await loadGlobalSettings()
        const origin = window.location.origin
        if (origin) {
          const site = await loadSiteSettings(origin)
          for (const [k, v] of Object.entries(site)) global[k] = v
        }
        settings.set(global)
        loadAllowedDeviceIds()
      }
    } catch (e) {
      logger.warn('handshake failed:', e.message)
    }
  })()

  /**
   * Reports iframe src URLs with allow="hid" to the background so cross-origin
   * permissions can be tracked.
   * @returns {void}
   */
  function reportIframes() {
    const iframes = document.querySelectorAll('iframe[allow*="hid" i]')
    for (const iframe of iframes) {
      const src = iframe.src || iframe.getAttribute('src') || ''
      if (!src) continue
      browser.runtime
        .sendMessage({
          action: 'setFrameAllow',
          url: src,
          frameId: -1
        })
        .catch((e) => logger.debug('setFrameAllow failed', e))
    }
  }
  if (window === window.top) {
    reportIframes()
    const observer = new MutationObserver(() => reportIframes())
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    })
  }

  /**
   * @param {object} msg
   * @param {ArrayBuffer[]} [transfer]
   * @returns {void}
   */
  function replyToPage(msg, transfer) {
    if (msg != null && msg.id != null) {
      const port = requestPortMap.get(msg.id)
      if (port) {
        requestPortMap.delete(msg.id)
        port.postMessage(msg, transfer)
        return
      }
    }
    if (msg != null && (msg.type === 'event' || msg.type === 'settings')) {
      for (const port of pagePorts.values()) port.postMessage(msg, transfer)
    }
  }

  /**
   * @param {object} data
   * @returns {void}
   */
  function handleSpawnWorkerResponse(data) {
    const pending = pendingSpawns.get(data.id)
    if (pending) {
      clearTimeout(pending.timer)
      pendingSpawns.delete(data.id)
      pending.resolve(data.result || {})
    }
  }

  /**
   * @param {object} data
   * @returns {void}
   */
  function handlePlaneResponse(data) {
    const pending = pendingPlaneSpawns.get(data.id)
    if (pending) {
      clearTimeout(pending.timer)
      pendingPlaneSpawns.delete(data.id)
      pending.resolve(!!(data.result && data.result.ok))
    }
  }

  /**
   * @param {object} data
   * @returns {void}
   */
  function handleDataPlaneEvent(data) {
    const deviceId = data.deviceId
    const ev = data.event || {}
    if (ev.type === 'closed') {
      inPageDevices.delete(deviceId)
      let spawnPending = false
      for (const [, entry] of pendingPlaneSpawns) {
        if (entry.deviceId === deviceId) {
          spawnPending = true
          break
        }
      }
      if (!spawnPending) {
        replyToPage({
          type: 'event',
          event: { eventType: 'disconnect', deviceId: deviceId }
        })
      }
    } else if (ev.type === 'auth-failed') {
      inPageDevices.delete(deviceId)
      refreshDataPlaneToken(deviceId)
    }
  }

  /**
   * @param {object} data
   * @returns {void}
   */
  function handleWorkerErrorEvent(data) {
    const deviceId = data.deviceId
    logger.warn('worker errored for', deviceId, ':', data.message)
    if (workers.has(deviceId)) {
      workers.delete(deviceId)
      connectParams.delete(deviceId)
      replyToPage({
        type: 'event',
        event: { eventType: 'disconnect', deviceId: deviceId }
      })
    }
  }

  /** @type {Object<string, function>} */
  const PAGE_PORT_HANDLERS = {
    spawnWorkerResponse: handleSpawnWorkerResponse,
    dataPlaneResponse: handlePlaneResponse,
    dataPlaneEvent: handleDataPlaneEvent,
    workerError: handleWorkerErrorEvent
  }

  window.addEventListener('message', (event) => {
    const port = event.ports != null ? event.ports[0] : undefined
    if (!port) return
    if (pagePorts.has(event.source)) return
    const source = event.source
    pagePorts.set(source, port)
    pageSourceByPort.set(port, source)
    portOrigin.set(port, event.origin)
    if (window === window.top) {
      for (const iframe of document.querySelectorAll('iframe')) {
        if (iframe.contentWindow === source) {
          if (iframe.hasAttribute('allow')) allowAttrMap.set(source, true)
          break
        }
      }
    }
    port.onmessage = (event) => {
      const data = event.data
      if (!data) return
      const handler = PAGE_PORT_HANDLERS[data.type]
      if (handler) {
        handler(data)
        return
      }
      if (data.id != null) requestPortMap.set(data.id, port)
      handleRequest(data, event.ports, source)
    }
    logger.debug('[bridge] page port established for', event.source === window ? 'window' : 'child')
  })

  /**
   * @param {object} data
   * @returns {string}
   */
  function getRequestOrigin(data) {
    const port = requestPortMap.get(data.id)
    return port ? portOrigin.get(port) : window.location.origin
  }

  /**
   * Distinct http(s) origins of every frame running the polyfill in this tab,
   * top-level first. Origins come from the engine-set `event.origin` of each
   * page port, never from page-visible state.
   * @returns {string[]}
   */
  function collectFrameOrigins() {
    const seen = new Set()
    const origins = []
    const topOrigin = window.location.origin
    if (topOrigin && (topOrigin.startsWith('http:') || topOrigin.startsWith('https:'))) {
      seen.add(topOrigin)
      origins.push(topOrigin)
    }
    for (const o of portOrigin.values()) {
      if (!o || seen.has(o)) continue
      if (!(o.startsWith('http:') || o.startsWith('https:'))) continue
      seen.add(o)
      origins.push(o)
    }
    return origins
  }

  /**
   * @param {object} data
   * @param {MessagePort[]} ports
   * @returns {Promise<void>}
   */
  async function handleWorkerPortRequest(data, ports) {
    const p = ports && ports[0]
    if (!p) return
    const origin = getRequestOrigin(data)
    portOrigin.set(p, origin || window.location.origin)
    p.onmessage = (event) => {
      if (event.data != null && event.data.id != null) requestPortMap.set(event.data.id, p)
      handleRequest(event.data, event.ports, null)
    }
    replyToPage({ type: 'response', id: data.id, result: { ok: true } })
  }

  /**
   * @param {object} data
   * @param {MessagePort[]} ports
   * @returns {Promise<void>}
   */
  async function handleDataPortRequest(data, ports) {
    const deviceId = data.payload.deviceId
    const port = ports && ports[0]
    if (!deviceId || !port) {
      logger.warn('data-port: missing deviceId or port')
      return
    }
    const allowed = await isDeviceAllowed(deviceId)
    if (!allowed) {
      logger.warn('data-port: not authorized for device', deviceId)
      try {
        port.close()
      } catch (e) {
        logger.debug('unauthorized port close failed', e)
      }
      return
    }
    if (workers.has(deviceId)) {
      const proxy = makeWorkerProxy(port)
      workers.set(deviceId, proxy)
      proxy.onmessage = (event) => {
        const data = event.data
        if (!data || !data.type) return
        if (data.type === 'ready') {
          logger.info('worker ready for', deviceId)
          workerReadyDevices.add(deviceId)
          proxy.postMessage({
            type: 'settings',
            dataPlane: settings.dataPlane,
            logLevel: settings.logLevel
          })
          return
        }
        if (data.type === 'auth-failed') {
          logger.warn('worker auth-failed for', deviceId, 'code=' + data.code + '; re-opening')
          if (workers.get(deviceId) === proxy) {
            workers.delete(deviceId)
            workerReadyDevices.delete(deviceId)
            dataPorts.delete(deviceId)
            refreshDataPlaneToken(deviceId)
          }
          return
        }
        if (data.type === 'closed') {
          logger.warn('worker closed for', deviceId)
          if (workers.get(deviceId) === proxy) {
            workers.delete(deviceId)
            workerReadyDevices.delete(deviceId)
            dataPorts.delete(deviceId)
            replyToPage({
              type: 'event',
              event: { eventType: 'disconnect', deviceId: deviceId }
            })
          }
          return
        }
      }
      const params = connectParams.get(deviceId)
      if (params) {
        connectParams.delete(deviceId)
        proxy.postMessage(Object.assign({ type: 'connect' }, params))
      }
      logger.debug('worker control port received for device', deviceId)
      return
    }
    dataPorts.set(deviceId, port)
    logger.debug('data port received for device', deviceId)
    port.onmessage = (event) => onDataPortMessage(deviceId, event.data)
  }

  /**
   * @param {object} data
   * @returns {Promise<void>}
   */
  async function handleGetCspInfoRequest(data) {
    try {
      const resp = await browser.runtime.sendMessage({ action: 'getCspInfo' })
      replyToPage({ type: 'response', id: data.id, result: resp || {} })
    } catch {
      replyToPage({ type: 'response', id: data.id, result: {} })
    }
  }

  /**
   * @param {object} data
   * @returns {Promise<void>}
   */
  async function handleGetPolicyRequest(data) {
    try {
      const payload = data.payload || {}
      const isCrossOrigin = payload.isCrossOrigin ? true : false
      const url = getRequestOrigin(data) || location.href
      let hasAllowAttr = false
      if (window === window.top) {
        const port = requestPortMap.get(data.id)
        const source = port ? pageSourceByPort.get(port) : null
        if (source) {
          for (const iframe of document.querySelectorAll('iframe[allow*="hid" i]')) {
            if (iframe.contentWindow !== source) continue
            try {
              hasAllowAttr = new URL(iframe.src).origin === new URL(url).origin
            } catch {
              hasAllowAttr = false
            }
            break
          }
        }
      }
      const resp = await browser.runtime.sendMessage({
        action: 'getPolicy',
        isCrossOrigin,
        url,
        hasAllowAttr
      })
      const result = resp ? resp.policy || { hid: 'allowed' } : { hid: 'allowed' }
      result._dbg = {
        isCrossOrigin,
        url,
        hasAllowAttr,
        top: window === window.top
      }
      replyToPage({ type: 'response', id: data.id, result })
    } catch (e) {
      replyToPage({
        type: 'response',
        id: data.id,
        result: { hid: 'allowed', _err: String(e) }
      })
    }
  }

  /**
   * @param {object} data
   * @returns {Promise<void>}
   */
  async function handleGetSettingsRequest(data) {
    try {
      const global = await loadGlobalSettings()
      const origin = window.location.origin
      if (origin) {
        const site = await loadSiteSettings(origin)
        for (const [k, v] of Object.entries(site)) global[k] = v
      }
      settings.set(global)
      replyToPage({ type: 'response', id: data.id, result: global })
    } catch {
      replyToPage({ type: 'response', id: data.id, result: {} })
    }
  }

  /**
   * @param {object} data
   * @returns {Promise<void>}
   */
  async function handleReportRequest(data) {
    const payload = data.payload || {}
    if (!payload.deviceId) return
    try {
      const msg = Object.assign({ action: data.action }, payload)
      const response = await browser.runtime.sendMessage(msg)
      const transfers = response && response.d instanceof Uint8Array ? [response.d.buffer] : []
      replyToPage(
        { type: 'response', id: data.id, result: response },
        transfers.length ? transfers : undefined
      )
    } catch {
      replyToPage({ type: 'response', id: data.id, result: { s: 500 } })
    }
  }

  /**
   * @param {object} data
   * @returns {Promise<void>}
   */
  async function handleRequestDeviceRequest(data) {
    const payload = data.payload || {}
    const filters = payload.filters || []
    const exclusionFilters = payload.exclusionFilters || []

    if (settings.devicePickerMode === 'pageAction' || settings.devicePickerMode === 'window') {
      browser.runtime
        .sendMessage({
          action: 'showPicker',
          requestId: data.id,
          filters,
          exclusionFilters,
          origin: getRequestOrigin(data),
          mode: settings.devicePickerMode
        })
        .catch((e) => logger.debug('showPicker send failed', e))
      const pickerTimeout = setTimeout(() => {
        replyToPage({
          type: 'response',
          id: data.id,
          result: { cancelled: true }
        })
      }, 30000)
      const onPickerResult = async (msg) => {
        if (msg.action !== 'pickerResult' || msg.requestId !== data.id) return
        clearTimeout(pickerTimeout)
        browser.runtime.onMessage.removeListener(onPickerResult)
        if (msg.selected && msg.devices) {
          await grantSelectedDevices(getRequestOrigin(data), msg.devices)
          replyToPage({
            type: 'response',
            id: data.id,
            result: { devices: msg.devices }
          })
        } else {
          replyToPage({
            type: 'response',
            id: data.id,
            result: { cancelled: true }
          })
        }
      }
      browser.runtime.onMessage.addListener(onPickerResult)
      return
    }

    const result = await devicePicker.show(filters, exclusionFilters)
    if (result.devices && result.devices.length) {
      await grantSelectedDevices(getRequestOrigin(data), result.devices)
    }
    replyToPage({
      type: 'response',
      id: data.id,
      result: result.devices.length ? { devices: result.devices } : { cancelled: true }
    })
  }

  /**
   * Runs the post-open data-plane spawn for a device.
   * @param {object} response
   * @returns {Promise<void>}
   */
  async function handleOpenSuccess(response) {
    const deviceId = response.i
    openDevices.add(deviceId)
    sessionTokens.set(deviceId, response.t)
    browser.runtime
      .sendMessage({
        action: 'deviceCountChanged',
        count: openDevices.size
      })
      .catch((e) => logger.debug('deviceCountChanged (open) failed', e))
    logger.debug('open ok deviceId=' + deviceId + ' wsPort=' + response.w)

    const dataPlane = settings.dataPlane
    if (dataPlane === 'ws') {
      await spawnDataPlane(deviceId, response.t, response.w || wsPort)
    } else if (dataPlane === 'wt') {
      if (wtPort != null) {
        if (settings.useWorker === false) {
          spawnDataPlane(deviceId, response.t, null, { wtPort, wtCertHash })
        } else {
          await spawnDataPlane(deviceId, response.t, null, { wtPort, wtCertHash })
        }
      } else {
        await spawnDataPlane(deviceId, response.t, response.w || wsPort)
      }
    }
  }

  /**
   * Tears down the data plane after a device close.
   * @param {object} payload
   * @returns {void}
   */
  function handleCloseSuccess(payload) {
    const deviceId = payload.deviceId
    logger.debug('close deviceId=' + deviceId)
    openDevices.delete(deviceId)
    sessionTokens.delete(deviceId)
    browser.runtime
      .sendMessage({
        action: 'deviceCountChanged',
        count: openDevices.size
      })
      .catch((e) => logger.debug('deviceCountChanged (close) failed', e))
    despawnDataPlane(deviceId)
  }

  async function grantSelectedDevices(origin, devices) {
    await Promise.all(
      devices.map((device) =>
        browser.runtime
          .sendMessage({
            action: 'pairDevice',
            origin,
            device: { deviceId: device.deviceId }
          })
          .catch(() => {})
      )
    )
    if (devices.length > 1) {
      browser.runtime
        .sendMessage({
          action: 'recordGrantGroup',
          origin,
          deviceIds: devices.map((device) => device.deviceId)
        })
        .catch(() => {})
    }
  }

  /**
   * Routes open/close and other pass-through device actions to the background.
   * @param {object} data
   * @returns {Promise<void>}
   */
  async function handleGenericRequest(data) {
    const { id, action, payload } = data
    try {
      if (PAGE_BLOCKED_ACTIONS.has(action)) {
        replyToPage({ type: 'response', id, result: { s: 403 } })
        return
      }
      let response
      if (action === 'open') {
        const allowed = await isDeviceAllowed(payload.deviceId)
        if (!allowed) {
          replyToPage({ type: 'response', id, result: { s: 403 } })
          return
        }
      }
      const effectiveAction = action === 'enumerate' ? 'enumeratePaired' : action
      const msg = Object.assign(
        { action: effectiveAction, origin: getRequestOrigin(data) },
        payload || {}
      )
      if (action === 'close') {
        const sessionToken = sessionTokens.get(payload.deviceId)
        if (sessionToken) msg.T = sessionToken
      }
      response = await browser.runtime.sendMessage(msg)

      if (action === 'open' && http.isOk(response.s) && response.t) {
        await handleOpenSuccess(response)
      }

      if (action === 'close') {
        handleCloseSuccess(payload)
      }

      const transfers = response && response.d instanceof Uint8Array ? [response.d.buffer] : []
      replyToPage(
        { type: 'response', id, result: response },
        transfers.length ? transfers : undefined
      )
    } catch {
      replyToPage({ type: 'response', id, result: { s: 500 } })
    }
  }

  /** @type {Object<string, function>} */
  const REQUEST_HANDLERS = {
    workerPort: handleWorkerPortRequest,
    dataPort: handleDataPortRequest,
    getCspInfo: handleGetCspInfoRequest,
    getPolicy: handleGetPolicyRequest,
    getSettings: handleGetSettingsRequest,
    sendReport: handleReportRequest,
    sendFeatureReport: handleReportRequest,
    receiveFeatureReport: handleReportRequest,
    requestDevice: handleRequestDeviceRequest
  }

  /**
   * @param {object} data
   * @param {MessagePort[]} ports
   * @param {Window|null} _source
   * @returns {Promise<void>}
   */
  async function handleRequest(data, ports, _source) {
    if (!data || data.id === undefined) return

    logger.debug('req action=' + data.action + ' id=' + data.id)

    const handler = REQUEST_HANDLERS[data.action]
    if (handler) {
      await handler(data, ports)
      return
    }
    await handleGenericRequest(data, ports)
  }

  /** @returns {void} */
  function handleGlobalReset() {
    logger.warn('global reset: clearing bridge device state')
    const deviceIds = Array.from(openDevices)
    openDevices.clear()
    sessionTokens.clear()
    for (const deviceId of deviceIds) {
      try {
        despawnDataPlane(deviceId)
      } catch (e) {
        logger.warn('global reset: despawn failed for', deviceId, e.message)
      }
      replyToPage({
        type: 'event',
        event: { eventType: 'disconnect', deviceId }
      })
    }
    browser.runtime
      .sendMessage({ action: 'deviceCountChanged', count: 0 })
      .catch((e) => logger.debug('deviceCountChanged (reset) failed', e))
  }

  /**
   * Forwards an NM input report to the page over the device's data port.
   * @param {object} messageEvent
   * @returns {boolean} true when a port handled the report
   */
  function forwardInputReportToPage(messageEvent) {
    const port = dataPorts.get(messageEvent.deviceId)
    if (!port) return false
    const view = messageEvent.data
    const buffer = view ? view.buffer || view : null
    try {
      port.postMessage(
        {
          type: 'inputReport',
          reportId: messageEvent.reportId,
          data: buffer
        },
        buffer ? [buffer] : []
      )
    } catch (e) {
      logger.debug('forward inputReport to page failed', e)
    }
    return true
  }

  /**
   * @param {object} message
   * @returns {void}
   */
  function handleBackgroundEvent(message) {
    const messageEvent = message.event
    if (messageEvent.eventType === 'input_report') {
      if (workerReadyDevices.has(messageEvent.deviceId)) return
      if (forwardInputReportToPage(messageEvent)) return
    }
    if (messageEvent.eventType === 'disconnect') {
      const port = dataPorts.get(messageEvent.deviceId)
      if (port) {
        try {
          port.postMessage({ type: 'disconnect' })
        } catch (e) {
          logger.debug('forward disconnect to page failed', e)
        }
      }
    }
    if (
      devicePicker &&
      devicePicker.isOpen &&
      (messageEvent.eventType === 'connect' || messageEvent.eventType === 'disconnect')
    ) {
      devicePicker.refreshDevices()
    }
    replyToPage({ type: 'event', event: messageEvent })
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message.action === 'globalReset') {
      handleGlobalReset()
      return
    }
    if (message.action === 'webhidDeviceEvent' && message.event) {
      handleBackgroundEvent(message)
    }
  })

  /**
   * Sends the report result back over the device's data port.
   * @param {object} msg
   * @param {MessagePort|null} port
   * @param {object|null} response
   * @returns {void}
   */
  function handleWorkerReportResponse(msg, port, response) {
    if (!port) return
    const status = response ? response.s : 500
    if (msg.type === 'receiveFeature') {
      if (status === 403) {
        try {
          port.postMessage({
            type: 'featureResult',
            reqId: msg.reqId,
            error: 'blocked'
          })
        } catch (e) {
          logger.debug('postMessage featureResult blocked failed', e)
        }
        return
      }
      const data = http.isOk(status) && response.d ? response.d : null
      try {
        port.postMessage({
          type: 'featureResult',
          reqId: msg.reqId,
          data: data || null
        })
      } catch (e) {
        logger.debug('postMessage featureResult data failed', e)
      }
      return
    }
    let error = null
    if (status === 403) error = 'blocked'
    else if (!http.isOk(status)) error = 'send failed'
    try {
      port.postMessage({
        type: msg.type === 'send' ? 'sendResult' : 'featureResult',
        reqId: msg.reqId,
        error
      })
    } catch (e) {
      logger.debug('postMessage sendResult failed', e)
    }
  }

  /**
   * @param {string} deviceId
   * @param {object} msg
   * @returns {void}
   */
  function onDataPortMessage(deviceId, msg) {
    if (!msg) return
    if (msg.type === 'send' || msg.type === 'sendFeature' || msg.type === 'receiveFeature') {
      const action =
        msg.type === 'send'
          ? 'sendReport'
          : msg.type === 'sendFeature'
            ? 'sendFeatureReport'
            : 'receiveFeatureReport'
      const payload = { deviceId, reportId: msg.reportId }
      if (msg.type === 'send' || msg.type === 'sendFeature') payload.data = msg.data
      const port = dataPorts.get(deviceId)
      const m = Object.assign({ action }, payload)
      browser.runtime.sendMessage(m).then(
        (response) => handleWorkerReportResponse(msg, port, response),
        () => handleWorkerReportResponse(msg, port, { s: 500 })
      )
    }
  }

  /**
   * Respawns the open devices' planes for the requested mode after a switch.
   * @param {string} dp
   * @returns {void}
   */
  function respawnPlanesForMode(dp) {
    if (dp === 'ws') {
      for (const id of openDevices) {
        const token = sessionTokens.get(id)
        if (token) spawnDataPlane(id, token, wsPort, { rewire: true })
      }
    } else if (dp === 'wt') {
      for (const id of openDevices) {
        const token = sessionTokens.get(id)
        if (token) {
          if (wtPort != null) {
            spawnDataPlane(id, token, null, { wtPort, wtCertHash, rewire: true })
          } else {
            spawnDataPlane(id, token, wsPort, { rewire: true })
          }
        }
      }
    } else {
      for (const id of openDevices) {
        const port = dataPorts.get(id)
        if (port && !port.onmessage) {
          port.onmessage = (event) => onDataPortMessage(id, event.data)
        }
      }
    }
  }

  /**
   * @param {string} dp
   * @returns {Promise<void>}
   */
  async function applyDataPlane(dp) {
    for (const id of openDevices) {
      await despawnDataPlane(id, { keepPort: true })
    }
    respawnPlanesForMode(dp)
    for (const id of openDevices) {
      browser.runtime
        .sendMessage({
          action: 'setDataPlane',
          deviceId: id,
          mode: dp
        })
        .catch((e) => logger.debug('applyDataPlane failed for device', id, e))
    }
    logger.info('data plane changed:', dp, 'open devices:', openDevices.size)
  }

  settings.on('dataPlane', (dp) => applyDataPlane(dp))

  settings.on('workerSpawnMode', () => {
    cachedSpawnMode = null
    applyDataPlane(settings.dataPlane)
  })

  settings.on('useWorker', () => applyDataPlane(settings.dataPlane))

  settings.on(['dataPlane', 'logLevel'], () => {
    const all = settings.getAll()
    const patch = {}
    for (const k of ['dataPlane', 'logLevel']) {
      patch[k] = all[k]
    }
    replyToPage({ type: 'settings', settings: patch })
    const workerMsg = { type: 'settings', ...patch }
    for (const worker of workers.values()) worker.postMessage(workerMsg)
  })

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    const origin = window.location.origin
    const patch = {}
    for (const [key, change] of Object.entries(changes)) {
      const parsed = parseSettingsKey(key)
      if (!parsed) continue
      if (parsed.scope === 'global') {
        patch[parsed.name] = change.newValue
      } else if (parsed.scope === 'site' && parsed.origin === origin) {
        patch[parsed.name] = change.newValue
      }
    }
    if (Object.keys(patch).length === 0) return
    settings.set(patch)
  })

  browser.runtime.onMessage.addListener((message) => {
    if (message.action === 'allowedDevicesChanged' && Array.isArray(message.deviceIds)) {
      allowedDeviceIds.clear()
      for (const id of message.deviceIds) allowedDeviceIds.add(id)
    }
  })
})()
