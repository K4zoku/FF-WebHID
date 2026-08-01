;(function () {
  'use strict'

  /** @type {import("./types.js").Logger} */
  const logger = webhid.import('logger')
  const http = webhid.import('http')
  const createSettingsStore = webhid.import('createSettingsStore')
  const loadGlobalSettings = webhid.import('loadGlobalSettings')
  const loadSiteSettings = webhid.import('loadSiteSettings')
  const parseSettingsKey = webhid.import('parseSettingsKey')
  const WebHidDevicePicker = webhid.import('WebHidDevicePicker')
  logger.initLogger('bridge')

  const devicePicker = new WebHidDevicePicker()
  document.documentElement.appendChild(devicePicker.host)

  /** @type {Set<string>} */
  const openDevices = new Set()
  /** @type {Map<string, string>} */
  const sessionTokens = new Map()

  browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getOpenDeviceIds') {
      sendResponse({ ids: Array.from(openDevices) })
      return true
    }
  })

  /** @type {Map<string, Worker>} */
  const workers = new Map()
  /** @type {Map<string, Map<number, Function>>} */
  const workerCallbacks = new Map()
  /** @type {Set<string>} */
  const workerReady = new Set()
  /** @type {Map<string, object[]>} */
  const workerQueues = new Map()
  /** @type {Map<string, MessagePort>} */
  const dataPorts = new Map()
  /** @type {number|null} */
  let wsPort = null
  /** @type {string|null} */
  let wsNonce = null
  /** @type {import("./types.js").SettingsStore} */
  const settings = createSettingsStore(webhid.import('GLOBAL_DEFAULTS'))
  settings.on('logLevel', (v) => logger.applyLevel(v))
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
    const worker = workers.get(deviceId)
    if (worker) {
      const port = dataPorts.get(deviceId)
      if (port && keepPort) {
        try {
          worker.postMessage({ type: 'unsetPort' })
        } catch (e) {
          logger.debug('unsetPort failed (keepPort)', e)
        }
        const returned = await new Promise((resolve) => {
          let done = false
          const onMsg = (event) => {
            if (done) return
            if (event.data && event.data.type === 'returnPort') {
              done = true
              worker.onmessage = null
              resolve((event.ports && event.ports[0]) || null)
            }
          }
          worker.onmessage = onMsg
          setTimeout(() => {
            if (!done) {
              done = true
              worker.onmessage = null
              resolve(null)
            }
          }, 500)
        })
        if (returned) {
          dataPorts.set(deviceId, returned)
          returned.onmessage = (e) => onDataPortMessage(deviceId, e.data)
        }
      } else if (port) {
        dataPorts.delete(deviceId)
        try {
          worker.postMessage({ type: 'unsetPort' })
        } catch (e) {
          logger.debug('unsetPort failed (port path)', e)
        }
        try {
          port.onmessage = null
          port.close()
        } catch (e) {
          logger.debug('port cleanup failed (port path)', e)
        }
      }
      worker.terminate()
      workers.delete(deviceId)
    } else if (!keepPort) {
      const port = dataPorts.get(deviceId)
      if (port) {
        try {
          port.onmessage = null
          port.close()
        } catch (e) {
          logger.debug('port cleanup failed (no worker)', e)
        }
        dataPorts.delete(deviceId)
      }
    }
    workerCallbacks.delete(deviceId)
    workerReady.delete(deviceId)
    workerQueues.delete(deviceId)
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
        spawnDataPlane(deviceId, resp.t, resp.w || wsPort)
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

  let cachedCspBlocked = null

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
    if (cachedCspBlocked === null) {
      try {
        const info = await browser.runtime.sendMessage({ action: 'getCspInfo' })
        cachedCspBlocked = !!(info && info.shadowWorkerBlocked)
      } catch { /* no CSP info for this frame; assume shadow is allowed */ }
    }
    if (cachedCspBlocked) {
      logger.info('page CSP blocks the shadow worker for', deviceId, '; using NM data plane')
      return false
    }
    let worker
    try {
      worker = new Worker(location.href)
    } catch (e) {
      logger.warn('redirect worker failed for', deviceId, ':', e.message)
    }
    if (!worker) return false

    if (spawnGen.get(deviceId) !== gen) {
      logger.info('worker spawn stale, discarding for', deviceId)
      worker.terminate()
      return false
    }
    workers.set(deviceId, worker)

    return new Promise((resolveSpawn) => {
      let resolved = false
      let readyTimer = null

      const fail = (reason) => {
        if (resolved) return
        resolved = true
        if (readyTimer) clearTimeout(readyTimer)
        worker.onerror = null
        worker.onmessage = null
        worker.terminate()
        workers.delete(deviceId)
        workerReady.delete(deviceId)
        dataPorts.delete(deviceId)
        const queue = workerQueues.get(deviceId)
        if (queue) {
          const callbackMap = workerCallbacks.get(deviceId)
          for (const workerMsg of queue) {
            if (callbackMap && callbackMap.has(workerMsg.reqId)) {
              callbackMap.get(workerMsg.reqId)({
                error: 'worker spawn failed'
              })
              callbackMap.delete(workerMsg.reqId)
            }
          }
          workerQueues.delete(deviceId)
        }
        logger.warn('worker spawn failed for', deviceId, ':', reason)
        resolveSpawn(false)
      }

      worker.onerror = (e) => fail('onerror: ' + (e.message || 'unknown'))
      readyTimer = setTimeout(() => fail('ready timeout'), 3000)

      worker.onmessage = ({ data }) => {
        if (data.type === 'ready') {
          if (resolved) return
          resolved = true
          if (readyTimer) clearTimeout(readyTimer)
          logger.info('worker ready for', deviceId)
          workerReady.add(deviceId)
          const queue = workerQueues.get(deviceId)
          if (queue) {
            for (const workerMsg of queue) {
              worker.postMessage(workerMsg, workerMsg.data ? [workerMsg.data.buffer] : [])
            }
            workerQueues.delete(deviceId)
          }
          const port = dataPorts.get(deviceId)
          if (port) {
            port.onmessage = null
            try {
              worker.postMessage({ type: 'setPort' }, [port])
            } catch (e) {
              logger.warn('set-port transfer failed for', deviceId, ':', e.message)
              port.onmessage = (e2) => onDataPortMessage(deviceId, e2.data)
            }
          }
          worker.postMessage({
            type: 'settings',
            dataPlane: settings.dataPlane,
            logLevel: settings.logLevel
          })
          resolveSpawn(true)
          return
        }
        if (data.type === 'auth-failed') {
          logger.warn('worker auth-failed for', deviceId, 'code=' + data.code + '; re-opening')
          const orphanCallbackMap = workerCallbacks.get(deviceId)
          if (orphanCallbackMap) {
            for (const [, callback] of orphanCallbackMap) callback({ error: 'worker auth-failed' })
            orphanCallbackMap.clear()
          }
          workers.delete(deviceId)
          workerReady.delete(deviceId)
          dataPorts.delete(deviceId)
          refreshDataPlaneToken(deviceId)
          return
        }
        if (data.type === 'closed') {
          logger.warn('worker closed for', deviceId)
          const orphanCallbackMap = workerCallbacks.get(deviceId)
          if (orphanCallbackMap) {
            for (const [, callback] of orphanCallbackMap) callback({ error: 'worker closed' })
            orphanCallbackMap.clear()
          }
          workers.delete(deviceId)
          workerReady.delete(deviceId)
          dataPorts.delete(deviceId)
          replyToPage({
            type: 'event',
            event: { eventType: 'disconnect', deviceId: deviceId }
          })
          return
        }
        if (data.type === 'inputReport') {
          const view = data.data ? new Uint8Array(data.data) : null
          if (view && logger.level >= 3 && data.reportId !== 33) {
            let hex = ''
            for (let i = 0; i < Math.min(8, view.length); i++)
              hex += view[i].toString(16).padStart(2, '0') + ' '
            logger.debug(
              'worker→page inputReport device=' +
                deviceId +
                ' reportId=' +
                data.reportId +
                ' len=' +
                view.length +
                ' first8=' +
                hex
            )
          }
          replyToPage(
            {
              type: 'event',
              event: {
                eventType: 'input_report',
                deviceId: deviceId,
                reportId: data.reportId,
                data: view
              }
            },
            view ? [view.buffer] : []
          )
          return
        }
        if (data.type === 'sendResult' || data.type === 'featureResult') {
          const callbackMap = workerCallbacks.get(deviceId)
          if (callbackMap && callbackMap.has(data.reqId)) {
            const callback = callbackMap.get(data.reqId)
            callbackMap.delete(data.reqId)
            if (data.error) callback({ s: 500 })
            else if (data.data) callback({ s: 200, d: data.data })
            else callback({ s: 204 })
          }
        }
      }

      worker.postMessage({
        type: 'connect',
        wsPort,
        token: wsAuthHash,
        reportSize: opts.reportSize || 64,
        logLevel: logger.level
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
    const ok = await spawnWorker(deviceId, sessionToken, wsPort, opts, gen)
    if (!ok && spawnGen.get(deviceId) === gen) {
      logger.warn('worker spawn failed for', deviceId, '; falling back to NM')
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

  if (window === window.top) {
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
      if (event.data != null && event.data.id != null) requestPortMap.set(event.data.id, port)
      handleRequest(event.data, event.ports, source)
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
   * @param {object} data
   * @param {MessagePort[]} ports
   * @param {Window} source
   * @returns {Promise<void>}
   */
  async function handleRequest(data, ports, _source) {
    if (!data || data.id === undefined) return

    const { id, action: reqAction, payload } = data
    let action = reqAction
    logger.debug('req action=' + action + ' id=' + id)

    if (action === 'workerPort') {
      const p = ports && ports[0]
      if (p) {
        const origin = getRequestOrigin(data)
        portOrigin.set(p, origin || window.location.origin)
        p.onmessage = (event) => {
          if (event.data != null && event.data.id != null) requestPortMap.set(event.data.id, p)
          handleRequest(event.data, event.ports, null)
        }
        replyToPage({ type: 'response', id, result: { ok: true } })
      }
      return
    }

    if (action === 'dataPort') {
      const deviceId = payload.deviceId
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
      dataPorts.set(deviceId, port)
      logger.debug('data port received for device', deviceId)
      const worker = workers.get(deviceId)
      if (worker && workerReady.has(deviceId)) {
        try {
          worker.postMessage({ type: 'setPort' }, [port])
        } catch (e) {
          logger.warn('set-port transfer failed for', deviceId, ':', e.message)
          port.onmessage = (event) => onDataPortMessage(deviceId, event.data)
        }
      } else {
        port.onmessage = (event) => onDataPortMessage(deviceId, event.data)
      }
      return
    }

    if (action === 'getPolicy') {
      ;(async () => {
        try {
          const requestFrameUrl = (payload && payload.frameUrl) || ''
          let hasAllowAttr = false
          if (window === window.top && requestFrameUrl) {
            for (const iframe of document.querySelectorAll('iframe[allow*="hid" i]')) {
              const s = iframe.src || iframe.getAttribute('src') || ''
              if (s === requestFrameUrl) {
                hasAllowAttr = true
                break
              }
            }
          }
          const policyUrl = requestFrameUrl || getRequestOrigin(data) || location.href
          const resp = await browser.runtime.sendMessage({
            action: 'getPolicy',
            isCrossOrigin: payload && payload.isCrossOrigin ? true : false,
            url: policyUrl,
            hasAllowAttr
          })
          const result = resp ? resp.policy || { hid: 'allowed' } : { hid: 'allowed' }
          result._dbg = {
            requestFrameUrl,
            hasAllowAttr,
            top: window === window.top
          }
          replyToPage({ type: 'response', id, result })
        } catch (e) {
          replyToPage({
            type: 'response',
            id,
            result: { hid: 'allowed', _err: String(e) }
          })
        }
      })()
      return
    }

    if (action === 'getSettings') {
      try {
        const global = await loadGlobalSettings()
        const origin = window.location.origin
        if (origin) {
          const site = await loadSiteSettings(origin)
          for (const [k, v] of Object.entries(site)) global[k] = v
        }
        settings.set(global)
        replyToPage({ type: 'response', id, result: global })
      } catch {
        replyToPage({ type: 'response', id, result: {} })
      }
      return
    }

    if (
      (action === 'sendReport' ||
        action === 'sendFeatureReport' ||
        action === 'receiveFeatureReport') &&
      payload &&
      payload.deviceId &&
      workers.has(payload.deviceId)
    ) {
      action =
        action === 'sendReport'
          ? 'workerSend'
          : action === 'sendFeatureReport'
            ? 'workerSendFeature'
            : 'workerReceiveFeature'
    }

    if (
      action === 'workerSend' ||
      action === 'workerSendFeature' ||
      action === 'workerReceiveFeature'
    ) {
      const deviceId = payload.deviceId

      const worker = workers.get(deviceId)
      if (worker && workerReady.has(deviceId)) {
        const workerType =
          action === 'workerSend'
            ? 'send'
            : action === 'workerSendFeature'
              ? 'sendFeature'
              : 'receiveFeature'
        const workerMsg = {
          type: workerType,
          reqId: id,
          reportId: payload.reportId
        }
        if (action === 'workerSend' || action === 'workerSendFeature') workerMsg.data = payload.data

        {
          let callbackMap = workerCallbacks.get(deviceId)
          if (!callbackMap) {
            callbackMap = new Map()
            workerCallbacks.set(deviceId, callbackMap)
          }
          callbackMap.set(id, (data) => {
            const result = data.error
              ? { s: 500 }
              : data.data
                ? { s: 200, d: data.data }
                : { s: 204 }
            const transfers = result.d instanceof Uint8Array ? [result.d.buffer] : []
            replyToPage({ type: 'response', id, result }, transfers.length ? transfers : undefined)
          })
        }
        worker.postMessage(workerMsg)
        return
      }

      if (worker) {
        const workerType =
          action === 'workerSend'
            ? 'send'
            : action === 'workerSendFeature'
              ? 'sendFeature'
              : 'receiveFeature'
        const workerMsg = {
          type: workerType,
          reqId: id,
          reportId: payload.reportId
        }
        if (action === 'workerSend' || action === 'workerSendFeature') workerMsg.data = payload.data

        {
          let callbackMap = workerCallbacks.get(deviceId)
          if (!callbackMap) {
            callbackMap = new Map()
            workerCallbacks.set(deviceId, callbackMap)
          }
          callbackMap.set(id, (data) => {
            const result = data.error
              ? { s: 500 }
              : data.data
                ? { s: 200, d: data.data }
                : { s: 204 }
            const transfers = result.d instanceof Uint8Array ? [result.d.buffer] : []
            replyToPage({ type: 'response', id, result }, transfers.length ? transfers : undefined)
          })
        }

        if (!workerQueues.has(deviceId)) workerQueues.set(deviceId, [])
        workerQueues.get(deviceId).push(workerMsg)
        return
      }

      logger.warn('no worker for', deviceId, '; falling back to NM')
      const fallbackAction =
        action === 'workerSend'
          ? 'sendReport'
          : action === 'workerSendFeature'
            ? 'sendFeatureReport'
            : 'receiveFeatureReport'
      try {
        const msg = Object.assign({ action: fallbackAction }, payload || {})
        const response = await browser.runtime.sendMessage(msg)
        const transfers = response && response.d instanceof Uint8Array ? [response.d.buffer] : []
        replyToPage(
          { type: 'response', id, result: response },
          transfers.length ? transfers : undefined
        )
      } catch {
        replyToPage({ type: 'response', id, result: { s: 500 } })
      }
      return
    }

    if (action === 'requestDevice') {
      const filters = (payload && payload.filters) || []
      const exclusionFilters = (payload && payload.exclusionFilters) || []

      if (settings.devicePickerMode === 'pageAction' || settings.devicePickerMode === 'window') {
        browser.runtime
          .sendMessage({
            action: 'showPicker',
            requestId: id,
            filters,
            exclusionFilters,
            origin: getRequestOrigin(data),
            mode: settings.devicePickerMode
          })
          .catch((e) => logger.debug('showPicker send failed', e))
        const pickerTimeout = setTimeout(() => {
          replyToPage({
            type: 'response',
            id,
            result: { cancelled: true }
          })
        }, 30000)
        const onPickerResult = (msg) => {
          if (msg.action !== 'pickerResult' || msg.requestId !== id) return
          clearTimeout(pickerTimeout)
          browser.runtime.onMessage.removeListener(onPickerResult)
          if (msg.selected && msg.devices) {
            replyToPage({
              type: 'response',
              id,
              result: { devices: msg.devices }
            })
          } else {
            replyToPage({
              type: 'response',
              id,
              result: { cancelled: true }
            })
          }
        }
        browser.runtime.onMessage.addListener(onPickerResult)
        return
      }

      const result = await devicePicker.show(filters, exclusionFilters)
      replyToPage({
        type: 'response',
        id,
        result: result.devices.length ? { devices: result.devices } : { cancelled: true }
      })
      return
    }

    try {
      let response
      if (action === 'open') {
        const allowed = await isDeviceAllowed(payload.deviceId)
        if (!allowed) {
          replyToPage({ type: 'response', id, result: { s: 403 } })
          return
        }
      }
      const msg = Object.assign({ action, origin: getRequestOrigin(data) }, payload || {})
      response = await browser.runtime.sendMessage(msg)

      if (action === 'open' && http.isOk(response.s) && response.t) {
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
          spawnDataPlane(deviceId, response.t, response.w || wsPort)
        }
      }

      if (action === 'close') {
        const deviceId = payload.deviceId
        const sessionToken = sessionTokens.get(deviceId)
        logger.debug('close deviceId=' + deviceId)
        openDevices.delete(deviceId)
        sessionTokens.delete(deviceId)
        if (sessionToken) {
          msg.T = sessionToken
        }
        browser.runtime
          .sendMessage({
            action: 'deviceCountChanged',
            count: openDevices.size
          })
          .catch((e) => logger.debug('deviceCountChanged (close) failed', e))
        despawnDataPlane(deviceId)
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

  browser.runtime.onMessage.addListener((message) => {
    if (message.action === 'globalReset') {
      handleGlobalReset()
      return
    }
    if (message.action === 'webhidDeviceEvent' && message.event) {
      const messageEvent = message.event
      if (messageEvent.eventType === 'input_report') {
        const port = dataPorts.get(messageEvent.deviceId)
        if (port) {
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
          return
        }
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
  })

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
      const callback = (response) => {
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
        } else {
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
      }
      const m = Object.assign({ action }, payload)
      browser.runtime
        .sendMessage(m)
        .then(callback)
        .catch(() => callback({ s: 500 }))
      return
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
    if (dp === 'ws') {
      for (const id of openDevices) {
        const token = sessionTokens.get(id)
        if (token) spawnDataPlane(id, token, wsPort)
      }
    } else {
      for (const id of openDevices) {
        const port = dataPorts.get(id)
        if (port && !port.onmessage) {
          port.onmessage = (event) => onDataPortMessage(id, event.data)
        }
      }
    }
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
