;(function () {
  const webhid = globalThis.webhid
  const http = webhid.import('http')
  const logger = webhid.import('logger')
  const decodeCollectionsTlv = webhid.import('decodeCollectionsTlv')
  const { deviceCache, pendingPicker, permissionsPolicy, allowedCrossOrigin } =
    webhid.import('bgState')
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
  const { registerDeviceTab, unregisterDeviceTab, isTabAuthorizedForDevice } =
    webhid.import('bgStateOps')
  const { urlOrigin, frameKey } = webhid.import('bgCsp')
  const NativeMessaging = webhid.import('NativeMessaging')
  const bgPacked = webhid.import('bgPacked')
  const { ensureWorkerBundle } = webhid.import('bgBundle')

  /** @type {number} */
  let lastHidPermission = 2

  /** @type {object|null} */
  let actionApi = null

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

  /**
   * @param {string} origin
   * @param {number[]} deviceIds
   * @returns {Promise<void>}
   */
  async function notifyAllowedDevicesChanged(origin, deviceIds) {
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
      browser.tabs
        .sendMessage(tab.id, { action: 'allowedDevicesChanged', deviceIds })
        .catch(() => {})
    }
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
        .sendMessage(tab.id, { action: 'allowedDevicesChanged', deviceIds })
        .catch(() => {})
    }
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleEnumerate(request, sender, sendResponse) {
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
   * @returns {boolean}
   */
  function handleOpen(request, sender, sendResponse) {
    const tabId = sender.tab != null ? sender.tab.id : undefined
    getAllowedDevices(request.origin).then((deviceIds) => {
      if (!deviceIds.includes(request.deviceId)) {
        sendResponse({ s: 403 })
        return
      }
      NativeMessaging.openDevice(request.deviceId)
        .then((response) => {
          if (typeof response.P === 'number') lastHidPermission = response.P
          if (http.isOk(response.s) && response.i) registerDeviceTab(response.i, tabId)
          sendResponse(response)
        })
        .catch(() => sendResponse({ s: 500 }))
    })
    return true
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleClose(request, sender, sendResponse) {
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
   * @returns {boolean}
   */
  function handleSetDataPlane(request, sender, sendResponse) {
    if (
      !isTabAuthorizedForDevice(sender.tab != null ? sender.tab.id : undefined, request.deviceId)
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
    if (
      !isTabAuthorizedForDevice(sender.tab != null ? sender.tab.id : undefined, request.deviceId)
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
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleReceiveFeatureReport(request, sender, sendResponse) {
    if (
      !isTabAuthorizedForDevice(sender.tab != null ? sender.tab.id : undefined, request.deviceId)
    ) {
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
    if (
      !isTabAuthorizedForDevice(sender.tab != null ? sender.tab.id : undefined, request.deviceId)
    ) {
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
          const deviceIds = await getAllowedDevices(request.origin)
          await notifyAllowedDevicesChanged(request.origin, deviceIds)
        }
        const deviceIds = await getAllowedDevices(request.origin)
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
    const origin = urlOrigin(request.origin || (sender.tab && sender.tab.url) || '')
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
    browser.tabs
      .sendMessage(tabId, { action: 'getFrameOrigins' })
      .then((r) => sendResponse({ origins: (r && r.origins) || [] }))
      .catch(() => sendResponse({ origins: [] }))
    return true
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
   * Opens the picker as a pageAction popup, alerting the user via a
   * notification when the requesting tab is not the active one.
   * @param {object} req
   * @param {number} tabId
   * @param {string} origin
   * @returns {void}
   */
  function openPickerPageAction(req, tabId, origin) {
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
            message: `A website (${origin}) is requesting a HID device. Click to choose.`
          })
        }
      })
      .catch(() => {})
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleShowPicker(request, sender, sendResponse) {
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
      openPickerWindow()
    } else {
      openPickerPageAction(req, tabId, request.origin)
    }
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
   * Computes the effective `hid` policy for a frame.
   * @param {object} request
   * @param {object} sender
   * @returns {{policy: {hid: string}}}
   */
  function policyForRequest(request, sender) {
    const sid = sender.frameId
    const tid = sender.tab?.id
    const origin = urlOrigin(request.url || (sender.tab && sender.tab.url) || '')
    let hid = null
    if (tid != null) hid = permissionsPolicy.get(frameKey(tid, sid, origin))
    if (hid == null && tid != null) hid = permissionsPolicy.get(frameKey(tid, 0, origin))
    if (hid === 'none') return { policy: { hid: 'none' } }
    if (request.isCrossOrigin) {
      if (request.hasAllowAttr) return { policy: { hid: 'allowed' } }
      const allowKey = tid != null ? frameKey(tid, sid, origin) : null
      if (allowKey && allowedCrossOrigin.has(allowKey)) return { policy: { hid: 'allowed' } }
      const urlKey = `url:${urlOrigin(sender.tab && sender.tab.url)}:${request.url}`
      if (allowedCrossOrigin.has(urlKey)) return { policy: { hid: 'allowed' } }
      return { policy: { hid: 'none' } }
    }
    return { policy: { hid: 'allowed' } }
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleGetPolicy(request, sender, sendResponse) {
    sendResponse(policyForRequest(request, sender))
    return true
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
  function handleSetFrameAllow(request, sender, sendResponse) {
    let key
    const embedderOrigin = urlOrigin(sender.tab && sender.tab.url)
    if (request.frameId === -1 && request.url) {
      key = `url:${embedderOrigin}:${request.url}`
    } else {
      const tid = sender.tab?.id
      if (tid == null) {
        sendResponse({ ok: false })
        return false
      }
      key = frameKey(
        tid,
        request.frameId,
        urlOrigin(request.url || (sender.tab && sender.tab.url) || '')
      )
    }
    allowedCrossOrigin.set(key, true)
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
    const reqMode = req?.mode
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
    revokeDevice: handleRevokeDevice,
    setDataPlane: handleSetDataPlane,
    sendReport: handleSendReport,
    receiveFeatureReport: handleReceiveFeatureReport,
    sendFeatureReport: handleSendFeatureReport,
    getPairedDevices: handleGetPairedDevices,
    pairDevice: handlePairDevice,
    unpairDevice: handleUnpairDevice,
    getAllowedDevices: handleGetAllowedDevices,
    deviceCountChanged: handleDeviceCountChanged,
    getDeviceCache: handleGetDeviceCache,
    getDeviceInfo: handleGetDeviceInfo,
    fetchResource: handleFetchResource,
    getCspInfo: handleGetCspInfo,
    getFrameOrigins: handleGetFrameOrigins,
    getWorkerBundle: handleGetWorkerBundle,
    showPicker: handleShowPicker,
    getPendingPicker: handleGetPendingPicker,
    getPolicy: handleGetPolicy,
    armShadowSpawn: handleArmShadowSpawn,
    unarmShadowSpawn: handleUnarmShadowSpawn,
    setFrameAllow: handleSetFrameAllow,
    pickerResult: handlePickerResult
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
  }

  webhid.export('registerMessageHandlers', registerMessageHandlers)
})()
