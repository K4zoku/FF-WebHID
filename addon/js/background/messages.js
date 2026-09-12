;(function () {
  const webhid = globalThis.webhid
  const { registerContentPort, postToContentPort } = webhid.import('content-ports')
  const http = webhid.import('http')
  const logger = webhid.import('logger')
  const isChromium = webhid.import('isChromium')
  const decodeDeviceCollections = webhid.import('decodeDeviceCollections')
  const {
    deviceCache,
    pendingPicker,
    permissionsPolicy,
    frameDelegations,
    frameEndpoints,
    pageActionVisibility
  } = webhid.import('bgState')
  const {
    saveDeviceInfoBatch,
    getDeviceInfo,
    getAllowedDevices,
    addAllowedDevice,
    removeAllowedDevice,
    removeDeviceInfo,
    recordGrantGroup,
    getGrantGroupsForOrigin,
    deleteGrantGroups,
    getAllAllowedByOrigin
  } = webhid.import('bgStorage')
  const {
    registerDeviceTab,
    registerDeviceSession,
    unregisterDeviceSession,
    unregisterDeviceTab,
    isTabAuthorizedForDevice,
    isSessionOwnedBy,
    registerFrameLifetime,
    isFrameLifetimeActive,
    purgeFrame,
    collectDeviceSessionsForOrigin,
    getDeviceSessionOwner,
    closeForCleanup
  } = webhid.import('bgStateOps')
  const { urlOrigin, frameKey, documentFrameKey } = webhid.import('bgCsp')
  const NativeMessaging = webhid.import('NativeMessaging')
  const bgPacked = webhid.import('bgPacked')
  const { ensureWorkerBundle } = webhid.import('bgBundle')

  /** @type {number} */
  let lastHidPermission = 2

  /** @type {object|null} */
  let actionApi = null

  let nextEndpointId = 0
  /**
   * Registers one browser-owned exact frame endpoint.
   * @param {object} port
   * @returns {object|null}
   */
  function registerFrameEndpoint(port) {
    const sender = port.sender || {}
    const tabId = sender.tab?.id
    const frameId = Number.isInteger(sender.frameId) ? sender.frameId : null
    const documentId =
      typeof sender.documentId === 'string' && sender.documentId ? sender.documentId : null
    const origin = urlOrigin(sender.url || '')
    if (tabId == null || frameId == null || !origin) return null
    const endpoint = {
      id: 'endpoint-' + ++nextEndpointId,
      port,
      tabId,
      frameId,
      documentId,
      origin,
      url: sender.url,
      frameKey: 'endpoint-' + nextEndpointId
    }
    frameEndpoints.set(port, endpoint)
    if (!registerFrameLifetime(tabId, endpoint.frameKey)) {
      frameEndpoints.delete(port)
      return null
    }
    return endpoint
  }
  /**
   * @param {object} port
   * @returns {object|null}
   */
  function endpointForPort(port) {
    return (port && frameEndpoints.get(port)) || null
  }
  /**
   * @param {object} sender
   * @param {object} port
   * @returns {object|null}
   */
  function endpointForRequest(sender, port) {
    return endpointForPort(port)
  }
  const delegationPending = new Map()
  let nextDelegationId = 0
  /**
   * Resolves the parent endpoint for an exact child document.
   * @param {object} endpoint
   * @returns {object|null}
   */
  function parentEndpointFor(endpoint) {
    const entry = policyEntryForDocument(
      endpoint.tabId,
      endpoint.frameId,
      endpoint.documentId,
      endpoint.origin
    )
    const parentFrameId = entry && entry.parentFrameId >= 0 ? entry.parentFrameId : 0
    const parentDocumentId = entry && entry.parentDocumentId
    if (endpoint.frameId === 0) return null
    for (const candidate of frameEndpoints.values()) {
      if (
        candidate.tabId === endpoint.tabId &&
        candidate.frameId === parentFrameId &&
        (!parentDocumentId || candidate.documentId === parentDocumentId) &&
        candidate.documentId &&
        candidate.port !== endpoint.port
      )
        return candidate
    }
    return null
  }
  /**
   * Queries the exact parent endpoint for iframe delegation.
   * @param {object} endpoint
   * @returns {Promise<boolean>}
   */
  function queryFrameDelegation(endpoint) {
    const parent = parentEndpointFor(endpoint)
    if (!parent) return Promise.resolve(false)
    const requestId = 'delegation:' + ++nextDelegationId
    return new Promise((resolve) => {
      delegationPending.set(requestId, { endpoint, parent, resolve })
      postToContentPort(parent.port, {
        action: 'frameDelegationQuery',
        requestId,
        childFrameId: endpoint.frameId,
        childDocumentId: endpoint.documentId
      })
    })
  }
  /**
   * Sends an origin-scoped event to every registered exact frame endpoint.
   * @param {string} origin
   * @param {object} message
   * @returns {void}
   */
  function postToOriginEndpoints(origin, message) {
    for (const endpoint of frameEndpoints.values()) {
      if (endpoint.origin === origin) postToContentPort(endpoint.port, message)
    }
  }
  /**
   * Replaces the in-memory device cache with `devices` (decoded), persisting
   * them afterwards.
   * @param {object[]} devices
   * @returns {void}
   */
  function refreshDeviceCache(devices) {
    decodeDeviceCollections(devices)
    deviceCache.length = 0
    deviceCache.push(...devices)
    saveDeviceInfoBatch(devices)
  }

  /**
   * @param {string} origin
   * @param {number[]} deviceIds
   * @returns {Promise<void>}
   */
  async function notifyAllowedDevicesChanged(origin, deviceIds) {
    postToOriginEndpoints(origin, { action: 'allowedDevicesChanged', origin, deviceIds })
  }

  /**
   * Unpairs the devices in `toRevoke` from `origin`, closes them in the
   * daemon, deletes their grant groups, and tells matching tabs.
   * @param {string} origin
   * @param {Set<number>} toRevoke
   * @param {object[]} memberGroups
   * @returns {Promise<void>}
   */
  async function revokeDevices(origin, toRevoke, memberGroups) {
    for (const deviceId of toRevoke) {
      await removeAllowedDevice(origin, deviceId)
      removeDeviceInfo(deviceId)
      const tokens = collectDeviceSessionsForOrigin(deviceId, origin)
      for (const token of tokens) {
        const owner = getDeviceSessionOwner(deviceId, token)
        if (owner) unregisterDeviceTab(deviceId, owner.tabId)
        await closeForCleanup(deviceId, token, (id, sessionToken) =>
          NativeMessaging.closeDevice(id, sessionToken)
        )
      }
    }
    await deleteGrantGroups(memberGroups.map((g) => g.id))
    const deviceIds = await getAllowedDevices(origin)
    for (const deviceId of toRevoke) {
      postToOriginEndpoints(origin, {
        action: 'webhidDeviceEvent',
        event: { eventType: 'revoked', deviceId, origin }
      })
    }
    postToOriginEndpoints(origin, { action: 'allowedDevicesChanged', origin, deviceIds })
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleEnumerate(request, sender, sendResponse) {
    const filter = {
      filters: Array.isArray(request.filters) ? request.filters : [],
      exclusionFilters: Array.isArray(request.exclusionFilters) ? request.exclusionFilters : []
    }
    const hasFilter = filter.filters.length > 0 || filter.exclusionFilters.length > 0
    NativeMessaging.enumerateDevices(hasFilter ? filter : undefined)
      .then((response) => {
        if (http.isOk(response.s) && response.D) {
          if (hasFilter) decodeDeviceCollections(response.D)
          else refreshDeviceCache(response.D)
        }
        sendResponse(hasFilter ? Object.assign({}, response, { filtered: true }) : response)
      })
      .catch(() => sendResponse({ s: 500 }))
    return true
  }

  /**
   *
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleEnumeratePaired(request, sender, sendResponse) {
    const origin = request.origin || ''
    NativeMessaging.enumerateDevices()
      .then(async (response) => {
        if (http.isOk(response.s) && response.D) {
          const ids = await getAllowedDevices(origin)
          const paired = response.D.filter((d) => ids.includes(d.deviceId))
          decodeDeviceCollections(paired)
          sendResponse({ s: response.s, D: paired })
        } else {
          sendResponse(response)
        }
      })
      .catch(() => sendResponse({ s: 500 }))
    return true
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleHandshake(request, sender, sendResponse) {
    NativeMessaging.handshake()
      .then(sendResponse)
      .catch(() => sendResponse({ s: 500 }))
    return true
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleGetBackendStatus(request, sender, sendResponse) {
    ;(async () => {
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
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleRecordGrantGroup(request, sender, sendResponse) {
    ;(async () => {
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
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleGetGrantGroups(request, sender, sendResponse) {
    ;(async () => {
      try {
        const groups = await getGrantGroupsForOrigin(request.origin)
        sendResponse({ success: true, groups })
      } catch {
        sendResponse({ success: false, groups: [] })
      }
    })()
    return true
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleGetAllPairedDevices(request, sender, sendResponse) {
    ;(async () => {
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
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @param {object} port
   * @returns {boolean}
   */
  function handleOpen(request, sender, sendResponse, port) {
    const endpoint = endpointForRequest(sender, port)
    if (!endpoint) {
      sendResponse({ s: 403 })
      return true
    }
    const { tabId, origin, frameKey } = endpoint
    if (!isFrameLifetimeActive(tabId, frameKey)) {
      sendResponse({ s: 503 })
      return true
    }
    getAllowedDevices(origin)
      .then((deviceIds) => {
        if (!deviceIds.includes(request.deviceId)) {
          sendResponse({ s: 403 })
          return
        }
        NativeMessaging.openDevice(request.deviceId)
          .then(async (response) => {
            if (typeof response.P === 'number') lastHidPermission = response.P
            if (http.isOk(response.s) && response.i) {
              const stillAllowed = (await getAllowedDevices(origin)).includes(request.deviceId)
              const ownerStillAlive = isFrameLifetimeActive(tabId, frameKey)
              if (!stillAllowed || !ownerStillAlive) {
                if (response.t)
                  await closeForCleanup(response.i, response.t, (id, token) =>
                    NativeMessaging.closeDevice(id, token)
                  )
                sendResponse({ s: ownerStillAlive ? 403 : 503 })
                return
              }
              let sessionRegistered = true
              if (response.t) {
                sessionRegistered = registerDeviceSession(response.i, response.t, {
                  tabId,
                  frameId: endpoint.frameId,
                  documentId: endpoint.documentId,
                  origin,
                  frameKey,
                  port,
                  clientKey: request.clientKey
                })
              }
              if (!sessionRegistered) {
                if (response.t)
                  await closeForCleanup(response.i, response.t, (id, token) =>
                    NativeMessaging.closeDevice(id, token)
                  )
                sendResponse({ s: 503 })
                return
              }
              registerDeviceTab(response.i, tabId)
            }
            sendResponse(response)
          })
          .catch(() => sendResponse({ s: 500 }))
      })
      .catch(() => sendResponse({ s: 500 }))
    return true
  }

  /**
   * @param {object} sender
   * @param {number} deviceId
   * @returns {boolean}
   */
  function tabAllowsDevice(sender, deviceId) {
    const tabId = sender.tab != null ? sender.tab.id : undefined
    return isTabAuthorizedForDevice(tabId, deviceId)
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @param {object} port
   * @returns {boolean}
   */
  function handleClose(request, sender, sendResponse, port) {
    const endpoint = endpointForRequest(sender, port)
    const tabId = endpoint?.tabId
    if (!endpoint || !isTabAuthorizedForDevice(tabId, request.deviceId)) {
      sendResponse({ s: 403 })
      return true
    }
    if (
      request.T &&
      !isSessionOwnedBy(
        request.deviceId,
        request.T,
        endpoint.origin,
        endpoint.tabId,
        endpoint.frameKey,
        request.clientKey,
        port
      )
    ) {
      sendResponse({ s: 403 })
      return true
    }
    NativeMessaging.closeDevice(request.deviceId, request.T)
      .then((response) => {
        if (http.isOk(response.s)) {
          unregisterDeviceTab(request.deviceId, tabId)
          if (request.T) unregisterDeviceSession(request.deviceId, request.T)
        }
        sendResponse(response)
      })
      .catch(() => sendResponse({ s: 500 }))
    return true
  }

  /**
   * Closes all sessions owned by one exact bridge endpoint.
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @param {object} port
   * @returns {boolean}
   */
  async function handleFrameDestroyed(request, sender, sendResponse, port) {
    const endpoint = endpointForRequest(sender, port)
    if (endpoint) {
      await purgeFrame(endpoint.tabId, endpoint.frameKey, (deviceId, token) =>
        NativeMessaging.closeDevice(deviceId, token)
      )
      const exactKey = documentFrameKey(endpoint.tabId, endpoint.frameId, endpoint.documentId)
      frameDelegations.delete(exactKey)
      permissionsPolicy.delete(exactKey)
    }
    sendResponse({ s: 204 })
    return true
  }

  /**
   * Closes a daemon session returned by an open whose browser owner died.
   * @param {object} request
   * @param {object} _sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleCleanupSession(request, _sender, sendResponse) {
    closeForCleanup(request.deviceId, request.sessionToken, (deviceId, token) =>
      NativeMessaging.closeDevice(deviceId, token)
    ).then((confirmed) => sendResponse({ s: confirmed ? 204 : 503 }))
    return true
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleRevokeDevice(request, sender, sendResponse) {
    ;(async () => {
      try {
        const origin = request.origin
        if (!origin) {
          sendResponse({ success: false, error: 'no origin' })
          return
        }
        const targetIds =
          Array.isArray(request.deviceIds) && request.deviceIds.length
            ? request.deviceIds.map((id) => Number(id))
            : [Number(request.deviceId)]
        const groups = await getGrantGroupsForOrigin(origin)
        const memberGroups = groups.filter((g) => g.deviceIds.some((id) => targetIds.includes(id)))
        /** @type {Set<number>} */
        const toRevoke = new Set(targetIds)
        for (const g of memberGroups) {
          for (const id of g.deviceIds) toRevoke.add(Number(id))
        }
        await revokeDevices(origin, toRevoke, memberGroups)
        sendResponse({ success: true })
      } catch (e) {
        sendResponse({ success: false, error: e.message })
      }
    })()
    return true
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @param {object} port
   * @returns {boolean}
   */
  function handleSetDataPlane(request, sender, sendResponse, port) {
    const endpoint = endpointForRequest(sender, port)
    if (!endpoint || !tabAllowsDevice(sender, request.deviceId)) {
      sendResponse({ s: 403 })
      return true
    }
    if (
      request.sessionToken &&
      !isSessionOwnedBy(
        request.deviceId,
        request.sessionToken,
        endpoint.origin,
        endpoint.tabId,
        endpoint.frameKey,
        request.clientKey,
        port
      )
    ) {
      sendResponse({ s: 403 })
      return true
    }
    NativeMessaging.sendRequest({
      a: bgPacked.ACT.sdp,
      i: request.deviceId,
      m: request.mode,
      T: request.sessionToken
    })
      .then(sendResponse)
      .catch(() => sendResponse({ s: 500 }))
    return true
  }
  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleSendReport(request, sender, sendResponse) {
    if (!tabAllowsDevice(sender, request.deviceId)) {
      sendResponse({ s: 403 })
      return true
    }
    NativeMessaging.sendReport(request.deviceId, request.reportId || 0, request.data)
      .then(sendResponse)
      .catch(() => sendResponse({ s: 500 }))
    return true
  }
  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleReceiveFeatureReport(request, sender, sendResponse) {
    if (!tabAllowsDevice(sender, request.deviceId)) {
      sendResponse({ s: 403 })
      return true
    }
    NativeMessaging.receiveFeatureReport(request.deviceId, request.reportId)
      .then(sendResponse)
      .catch(() => sendResponse({ s: 500 }))
    return true
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleSendFeatureReport(request, sender, sendResponse) {
    if (!tabAllowsDevice(sender, request.deviceId)) {
      sendResponse({ s: 403 })
      return true
    }
    NativeMessaging.sendFeatureReport(request.deviceId, request.reportId || 0, request.data)
      .then(sendResponse)
      .catch(() => sendResponse({ s: 500 }))
    return true
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleGetPairedDevices(request, sender, sendResponse) {
    ;(async () => {
      try {
        const deviceIds = await getAllowedDevices(request.origin)
        sendResponse({ success: true, hashes: deviceIds })
      } catch (e) {
        sendResponse({ success: false, error: e.message, hashes: [] })
      }
    })()
    return true
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handlePairDevice(request, sender, sendResponse) {
    ;(async () => {
      try {
        await addAllowedDevice(request.origin, request.device.deviceId)
        const deviceIds = await getAllowedDevices(request.origin)
        await notifyAllowedDevicesChanged(request.origin, deviceIds)
        sendResponse({ success: true, hashes: deviceIds })
      } catch (e) {
        sendResponse({ success: false, error: e.message, hashes: [] })
      }
    })()
    return true
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleUnpairDevice(request, sender, sendResponse) {
    ;(async () => {
      try {
        if (request.deviceId) {
          await removeAllowedDevice(request.origin, request.deviceId)
          removeDeviceInfo(request.deviceId)
        }
        const deviceIds = await getAllowedDevices(request.origin)
        if (request.deviceId) {
          await notifyAllowedDevicesChanged(request.origin, deviceIds)
        }
        sendResponse({ success: true, hashes: deviceIds })
      } catch (e) {
        sendResponse({ success: false, error: e.message })
      }
    })()
    return true
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleGetAllowedDevices(request, sender, sendResponse) {
    ;(async () => {
      try {
        const deviceIds = await getAllowedDevices(request.origin)
        sendResponse({ deviceIds })
      } catch {
        sendResponse({ deviceIds: [] })
      }
    })()
    return true
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @returns {boolean}
   */
  function handleDeviceCountChanged(request, sender) {
    if (actionApi) {
      const tabId = sender.tab != null ? sender.tab.id : undefined
      if (tabId != null)
        actionApi.setBadgeText({
          text: request.count > 0 ? String(request.count) : '',
          tabId
        })
    }
    return false
  }

  /**
   * Shows the page action for a tab that has used the WebHID API.
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleShowPageAction(request, sender, sendResponse) {
    const tabId = sender.tab != null ? sender.tab.id : undefined
    if (isChromium || !browser.pageAction || tabId == null) {
      sendResponse({})
      return false
    }
    pageActionVisibility.markUsed(tabId).catch((e) => logger.debug('pageAction.show failed', e))
    sendResponse({})
    return false
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleGetDeviceCache(request, sender, sendResponse) {
    if (deviceCache.length === 0) {
      NativeMessaging.enumerateDevices()
        .then((response) => {
          if (http.isOk(response.s) && response.D) {
            refreshDeviceCache(response.D)
          }
          sendResponse({ devices: deviceCache })
        })
        .catch(() => sendResponse({ devices: deviceCache }))
      return true
    }
    saveDeviceInfoBatch(deviceCache)
    sendResponse({ devices: deviceCache })
    return false
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleGetDeviceInfo(request, sender, sendResponse) {
    const fromPage = sender.url != null && !sender.url.startsWith(browser.runtime.getURL(''))
    if (fromPage) {
      getAllowedDevices(request.origin || '').then((ids) => {
        const tabId = sender.tab != null ? sender.tab.id : undefined
        if (ids.includes(request.deviceId) || isTabAuthorizedForDevice(tabId, request.deviceId)) {
          getDeviceInfo(request.deviceId).then((device) => sendResponse({ device }))
        } else {
          sendResponse({ device: null })
        }
      })
      return true
    }
    getDeviceInfo(request.deviceId).then((device) => sendResponse({ device }))
    return true
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleFetchResource(request, sender, sendResponse) {
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

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleGetCspInfo(request, sender, sendResponse) {
    const tabId = sender.tab != null ? sender.tab.id : undefined
    if (tabId == null) {
      sendResponse(null)
      return false
    }
    const origin = urlOrigin(sender.url || '')
    if (!origin) {
      sendResponse(null)
      return false
    }
    const key = `csp:${frameKey(tabId, sender.frameId ?? 0, origin)}`
    browser.storage.session
      .get(key)
      .then((r) => sendResponse(r[key] ?? null))
      .catch(() => sendResponse(null))
    return true
  }

  /**
   * Relays the frame-origin list for a tab from its top-frame bridge. The
   * popup passes its active tab's id; page messages carry it via sender.tab.
   * @param {object} request
   * @param {object} sender
   * @param {Function} sendResponse
   * @returns {boolean}
   */
  function handleGetFrameOrigins(request, sender, sendResponse) {
    const tabId = request.tabId != null ? request.tabId : sender.tab ? sender.tab.id : undefined
    if (tabId == null) {
      sendResponse({ origins: [] })
      return false
    }
    const origins = []
    const seen = new Set()
    const endpoints = [...frameEndpoints.values()]
      .filter((endpoint) => endpoint.tabId === tabId)
      .sort((a, b) => a.frameId - b.frameId)
    for (const endpoint of endpoints) {
      if (seen.has(endpoint.origin)) continue
      seen.add(endpoint.origin)
      origins.push(endpoint.origin)
    }
    sendResponse({ origins })
    return false
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleGetWorkerBundle(request, sender, sendResponse) {
    ensureWorkerBundle()
      .then((text) => sendResponse({ text }))
      .catch((e) => sendResponse({ error: e.message || String(e) }))
    return true
  }

  /**
   * Opens the picker in a dedicated popup window.
   * @returns {void}
   */
  function openPickerWindow() {
    const sW = globalThis.screen?.availWidth || 1280
    const sH = globalThis.screen?.availHeight || 720
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
  }

  /**
   * Restores the page action visibility and popup after a picker closes.
   * @param {number} tabId
   * @returns {void}
   */
  function restorePageAction(tabId) {
    if (isChromium || !browser.pageAction || tabId == null) return
    Promise.all([
      pageActionVisibility.reconcile(tabId),
      browser.pageAction.setIcon({ tabId, path: 'icons/gamepad.svg' }),
      browser.pageAction.setPopup({
        tabId,
        popup: 'js/internal/pages/popup/index.html'
      })
    ]).catch((e) => logger.debug('restore pageAction failed', e))
  }

  /**
   * Opens the picker as a pageAction popup, alerting the user via a
   * notification when the requesting tab is not the active one.
   * @param {object} req
   * @param {number} tabId
   * @param {string} origin
   * @returns {void}
   */
  function openPickerPageAction(tabId, origin) {
    if (isChromium) return
    pageActionVisibility
      .reconcile(tabId)
      .then(() =>
        Promise.all([
          browser.pageAction.setIcon({
            tabId,
            path: 'icons/gamepad.alert.svg'
          }),
          browser.pageAction.setPopup({
            tabId,
            popup: 'js/internal/pages/picker/index.html'
          })
        ])
      )
      .then(() => {
        if (browser.pageAction.openPopup) return browser.pageAction.openPopup()
      })
      .catch((e) => logger.debug('openPickerPageAction failed', e))
    browser.tabs
      .query({ active: true, currentWindow: true })
      .then((tabs) => {
        const tab = tabs[0]
        if (tab && tab.id !== tabId) {
          browser.notifications.create('webhid-picker', {
            type: 'basic',
            iconUrl: browser.runtime.getURL('icons/icon.svg'),
            title: 'WebHID',
            message: `A website (${origin}) is requesting a HID device. Click to choose.`
          })
        }
      })
      .catch(() => {})
  }

  /**
   * Cancels a page-action picker after the requesting page times out.
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleCancelPicker(request, sender, sendResponse) {
    const tabId = sender.tab != null ? sender.tab.id : undefined
    const req = tabId != null ? pendingPicker.get(tabId) : null
    if (req && req.requestId === request.requestId) {
      pendingPicker.delete(tabId)
      if (req.mode === 'pageAction') {
        restorePageAction(tabId)
        if (browser.notifications) browser.notifications.clear('webhid-picker').catch(() => {})
      }
    }
    sendResponse({ ok: true })
    return false
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @param {object} port
   * @returns {boolean}
   */
  function handleShowPicker(request, sender, sendResponse, port) {
    const endpoint = endpointForRequest(sender, port)
    const tabId = endpoint?.tabId
    if (!endpoint) {
      sendResponse({ error: 'no frame endpoint' })
      return false
    }
    const req = {
      requestId: request.requestId,
      tabId,
      port,
      filters: request.filters || [],
      exclusionFilters: request.exclusionFilters || [],
      origin: endpoint.origin,
      mode: request.mode || 'pageAction'
    }
    if (req.mode === 'modal') {
      const top = [...frameEndpoints.values()].find(
        (candidate) => candidate.tabId === tabId && candidate.frameId === 0
      )
      if (!top) {
        sendResponse({ error: 'top frame endpoint unavailable' })
        return false
      }
      req.uiPort = top.port
      pendingPicker.set(tabId, req)
      postToContentPort(top.port, {
        action: 'showInlinePicker',
        requestId: req.requestId,
        filters: req.filters,
        exclusionFilters: req.exclusionFilters
      })
    } else {
      pendingPicker.set(tabId, req)
      if (req.mode === 'window') openPickerWindow()
      else openPickerPageAction(tabId, endpoint.origin)
    }
    sendResponse({ ok: true })
    return false
  }

  /**
   * Accepts a picker result from the registered top-frame UI host.
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @param {object} port
   * @returns {boolean}
   */
  function handleInlinePickerResult(request, sender, sendResponse, port) {
    const req = [...pendingPicker.values()].find(
      (candidate) => candidate.requestId === request.requestId
    )
    if (!req || req.uiPort !== port) {
      sendResponse({ ok: false })
      return false
    }
    pendingPicker.delete(req.tabId)
    postToContentPort(req.port, {
      action: 'pickerResult',
      requestId: req.requestId,
      selected: request.selected === true,
      devices: request.selected === true ? request.devices : null
    })
    sendResponse({ ok: true })
    return false
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleGetPendingPicker(request, sender, sendResponse) {
    sendResponse(pendingPicker.size > 0 ? [...pendingPicker.values()][0] : null)
    return false
  }

  /**
   * Resolves a policy record to the document ID observed by the browser.
   * @param {number} tabId
   * @param {number} frameId
   * @param {string} documentId
   * @param {string} origin
   * @returns {object|null}
   */
  function policyEntryForDocument(tabId, frameId, documentId, origin) {
    const exactKey = documentFrameKey(tabId, frameId, documentId)
    let entry = permissionsPolicy.get(exactKey)
    if (!entry) {
      const pendingKey = documentFrameKey(tabId, frameId, '')
      entry = permissionsPolicy.get(pendingKey) || null
      if (entry && entry.origin === origin) {
        permissionsPolicy.delete(pendingKey)
        entry.documentId = documentId
        permissionsPolicy.set(exactKey, entry)
      }
    }
    return entry && entry.origin === origin ? entry : null
  }
  /**
   * Computes the effective `hid` policy for one browser-authenticated frame
   * document.
   * @param {object} request
   * @param {object} sender
   * @returns {{policy: {hid: string}}}
   */
  function policyForRequest(request, sender) {
    const tabId = sender.tab?.id
    const frameId = Number.isInteger(sender.frameId) ? sender.frameId : null
    const documentId = typeof sender.documentId === 'string' ? sender.documentId : null
    const requestedOrigin = urlOrigin(sender.url || '')
    if (tabId == null || frameId == null || !documentId || !requestedOrigin) {
      return { policy: { hid: 'none' } }
    }
    const exactKey = documentFrameKey(tabId, frameId, documentId)
    const entry = policyEntryForDocument(tabId, frameId, documentId, requestedOrigin)
    if (!entry || entry.effective.kind === 'none') {
      return { policy: { hid: 'none' } }
    }
    if (entry.parentFrameId >= 0) {
      if (!entry.parentKey) return { policy: { hid: 'none' } }
      const parent = permissionsPolicy.get(entry.parentKey)
      if (!parent || !parent.origin) return { policy: { hid: 'none' } }
      if (parent.origin !== entry.origin && frameDelegations.get(exactKey) !== true) {
        return { policy: { hid: 'none' } }
      }
    }
    const eff = entry.effective
    if (eff.kind === 'all' || (eff.kind === 'list' && eff.origins.includes(entry.origin))) {
      return { policy: { hid: 'allowed' } }
    }
    return { policy: { hid: 'none' } }
  }
  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @param {object} port
   * @returns {boolean}
   */
  async function handleGetPolicy(request, sender, sendResponse, port) {
    const endpoint = endpointForRequest(sender, port)
    if (endpoint) {
      const key = documentFrameKey(endpoint.tabId, endpoint.frameId, endpoint.documentId)
      const entry = policyEntryForDocument(
        endpoint.tabId,
        endpoint.frameId,
        endpoint.documentId,
        endpoint.origin
      )
      if (
        entry &&
        endpoint.frameId !== 0 &&
        entry.parentFrameId >= 0 &&
        entry.parentKey &&
        permissionsPolicy.get(entry.parentKey)?.origin !== entry.origin
      ) {
        const delegated = await queryFrameDelegation(endpoint)
        frameDelegations.set(key, delegated)
      }
    }
    sendResponse(policyForRequest(request, sender))
    return false
  }
  /**
   * Records delegation for this browser-authenticated frame document.
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleSetFrameDelegation(request, sender, sendResponse) {
    const tabId = sender.tab?.id
    const frameId = Number.isInteger(sender.frameId) ? sender.frameId : null
    const documentId = typeof sender.documentId === 'string' ? sender.documentId : null
    const origin = urlOrigin(sender.url || '')
    if (tabId == null || frameId == null || !documentId || !origin) {
      sendResponse({ ok: false })
      return false
    }
    const exactKey = documentFrameKey(tabId, frameId, documentId)
    const entry = policyEntryForDocument(tabId, frameId, documentId, origin)
    if (!entry || entry.origin !== origin) {
      sendResponse({ ok: false })
      return false
    }
    frameDelegations.set(exactKey, request.delegated === true)
    sendResponse({ ok: true })
    return false
  }
  /**
   * Arms the shadow-URL interception for the next worker script request from
   * the given tab+document, so the polyfill's own data-worker spawn is
   * distinguishable from a page self-worker. The webRequest handler consumes
   * one arm per matching request.
   * @param {object} request
   * @param {object} sender
   * @param {Function} sendResponse
   * @returns {boolean}
   */
  function handleArmShadowSpawn(request, sender, sendResponse) {
    const tabId = request.tabId != null ? request.tabId : sender.tab ? sender.tab.id : null
    const url = typeof request.url === 'string' ? request.url : ''
    const arm = webhid.import('armShadowSpawn')
    if (arm) arm(tabId, url)
    sendResponse({ ok: true })
    return false
  }

  /**
   *
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleUnarmShadowSpawn(request, sender, sendResponse) {
    const tabId = request.tabId != null ? request.tabId : sender.tab ? sender.tab.id : null
    const url = typeof request.url === 'string' ? request.url : ''
    const unarm = webhid.import('unarmShadowSpawn')
    if (unarm) unarm(tabId, url)
    sendResponse({ ok: true })
    return false
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handlePickerResult(request, sender, sendResponse) {
    const pickerPage = browser.runtime.getURL('js/internal/pages/picker/index.html')
    if (sender.url == null || !sender.url.startsWith(pickerPage)) {
      logger.warn('pickerResult rejected: sender is not the picker page')
      sendResponse({ ok: false })
      return false
    }
    const { requestId, selected, devices } = request
    let tabId = request.tabId
    if (tabId == null && pendingPicker.size > 0) tabId = [...pendingPicker.keys()][0]
    const req = tabId != null ? pendingPicker.get(tabId) : null
    if (tabId != null) pendingPicker.delete(tabId)
    if (req?.mode === 'pageAction' && !isChromium) {
      restorePageAction(tabId)
      if (browser.notifications) browser.notifications.clear('webhid-picker').catch(() => {})
    }
    if (request.windowId != null) browser.windows.remove(request.windowId).catch(() => {})
    if (req?.port) {
      postToContentPort(req.port, {
        action: 'pickerResult',
        requestId,
        selected,
        devices: selected ? devices : null
      })
    }
    sendResponse({ ok: true })
    return false
  }

  /** @type {object} */
  const HANDLERS = {
    enumerate: handleEnumerate,
    enumeratePaired: handleEnumeratePaired,
    handshake: handleHandshake,
    getBackendStatus: handleGetBackendStatus,
    recordGrantGroup: handleRecordGrantGroup,
    getGrantGroups: handleGetGrantGroups,
    getAllPairedDevices: handleGetAllPairedDevices,
    open: handleOpen,
    close: handleClose,
    frameDestroyed: handleFrameDestroyed,
    revokeDevice: handleRevokeDevice,
    cleanupSession: handleCleanupSession,
    setDataPlane: handleSetDataPlane,
    sendReport: handleSendReport,
    receiveFeatureReport: handleReceiveFeatureReport,
    sendFeatureReport: handleSendFeatureReport,
    getPairedDevices: handleGetPairedDevices,
    pairDevice: handlePairDevice,
    unpairDevice: handleUnpairDevice,
    getAllowedDevices: handleGetAllowedDevices,
    deviceCountChanged: handleDeviceCountChanged,
    showPageAction: handleShowPageAction,
    getDeviceCache: handleGetDeviceCache,
    getDeviceInfo: handleGetDeviceInfo,
    fetchResource: handleFetchResource,
    getCspInfo: handleGetCspInfo,
    getFrameOrigins: handleGetFrameOrigins,
    getWorkerBundle: handleGetWorkerBundle,
    showPicker: handleShowPicker,
    cancelPicker: handleCancelPicker,
    getPendingPicker: handleGetPendingPicker,
    setFrameDelegation: handleSetFrameDelegation,
    getPolicy: handleGetPolicy,
    armShadowSpawn: handleArmShadowSpawn,
    unarmShadowSpawn: handleUnarmShadowSpawn,
    pickerResult: handlePickerResult,
    inlinePickerResult: handleInlinePickerResult
  }

  /**
   * Registers the background message dispatcher.
   * @param {{actionApi: object|null}} deps
   * @returns {void}
   */
  function registerMessageHandlers(deps) {
    actionApi = deps.actionApi
    browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
      const handler = HANDLERS[request.action]
      if (!handler) return false
      return handler(request, sender, sendResponse)
    })
    browser.runtime.onConnect.addListener((port) => {
      registerContentPort(port)
      const endpoint = port.name === 'webhid-control' ? registerFrameEndpoint(port) : null
      port.onMessage.addListener((request) => {
        if (request.action === 'frameDelegationResult') {
          const pending = delegationPending.get(request.requestId)
          if (!pending || pending.parent.port !== port) return
          delegationPending.delete(request.requestId)
          pending.resolve(request.delegated === true)
          return
        }
        const handler = HANDLERS[request.action]
        if (!handler) return
        let responded = false
        const sendPortResponse = (response) => {
          if (responded) return
          responded = true
          const responseMessage = { ...(response || {}) }
          if (request.reqId != null) responseMessage.reqId = request.reqId
          try {
            port.postMessage(responseMessage)
          } catch {
            void 0
          }
        }
        try {
          const result = handler(request, port.sender, sendPortResponse, port)
          if (result && typeof result.then === 'function') {
            result.catch(() => sendPortResponse({ s: 500 }))
          } else if (result !== true && !responded) {
            sendPortResponse(result || {})
          }
        } catch {
          sendPortResponse({ s: 500 })
        }
      })
      if (endpoint) {
        port.onDisconnect.addListener(() => {
          if (frameEndpoints.get(port) !== endpoint) return
          frameEndpoints.delete(port)
          for (const [tabId, request] of pendingPicker) {
            if (request.port !== port && request.uiPort !== port) continue
            pendingPicker.delete(tabId)
          }
          for (const [requestId, pending] of delegationPending) {
            if (pending.endpoint !== endpoint && pending.parent !== endpoint) continue
            delegationPending.delete(requestId)
            pending.resolve(false)
          }
          purgeFrame(endpoint.tabId, endpoint.frameKey, (deviceId, token) =>
            NativeMessaging.closeDevice(deviceId, token)
          ).catch((e) => logger.debug('frame endpoint cleanup failed', e))
        })
      }
    })
  }

  webhid.export('registerMessageHandlers', registerMessageHandlers)
})()
