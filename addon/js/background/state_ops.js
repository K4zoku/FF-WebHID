;(function () {
  const logger = webhid.import('logger')
  const { deviceTabMap, deviceSessions } = webhid.import('bgState')

  /**
   * Returns the list of tab IDs authorized for the device in the given event, or null.
   * @param {object} message
   * @returns {number[]|null}
   */
  function tabsForEvent(message) {
    if (!message.i) return null
    const tabs = deviceTabMap.get(message.i)
    return tabs && tabs.size > 0 ? [...tabs.keys()] : null
  }

  /**
   * Registers a tab as authorized to access a device, counted per open.
   * @param {number} deviceId
   * @param {number} tabId
   * @returns {void}
   */
  function registerDeviceTab(deviceId, tabId) {
    if (!deviceId || tabId == null) return
    let tabs = deviceTabMap.get(deviceId)
    if (!tabs) {
      tabs = new Map()
      deviceTabMap.set(deviceId, tabs)
    }
    tabs.set(tabId, (tabs.get(tabId) || 0) + 1)
    logger.debug('register device ' + deviceId + ' tab ' + tabId)
  }

  /**
   * Records one daemon session token with its owner.
   * `deviceSessions` is `deviceId -> Map<token, { tabId, origin }>`.
   * @param {number} deviceId
   * @param {string} token
   * @param {{tabId: number, origin: string}} owner
   * @returns {void}
   */
  function registerDeviceSession(deviceId, token, owner) {
    if (!deviceId || !token || !owner || owner.tabId == null || !owner.origin) return
    let byToken = deviceSessions.get(deviceId)
    if (!byToken) {
      byToken = new Map()
      deviceSessions.set(deviceId, byToken)
    }
    byToken.set(token, { tabId: owner.tabId, origin: owner.origin })
    logger.debug('register session device ' + deviceId + ' tab ' + owner.tabId)
  }

  /**
   * Drops the exact session token after a successful close.
   * @param {number} deviceId
   * @param {string} token
   * @returns {void}
   */
  function unregisterDeviceSession(deviceId, token) {
    if (!deviceId || !token) return
    const byToken = deviceSessions.get(deviceId)
    if (!byToken) return
    byToken.delete(token)
    if (byToken.size === 0) deviceSessions.delete(deviceId)
  }

  /**
   * Collects session tokens for a device owned by `origin` (revocation).
   * @param {number} deviceId
   * @param {string} origin
   * @returns {string[]}
   */
  function collectDeviceSessionsForOrigin(deviceId, origin) {
    const byToken = deviceSessions.get(deviceId)
    if (!byToken || !origin) return []
    const tokens = []
    for (const [token, owner] of byToken) {
      if (owner.origin === origin) tokens.push(token)
    }
    return tokens
  }

  /**
   * Collects session tokens for a device owned by `tabId` (tab close).
   * @param {number} deviceId
   * @param {number} tabId
   * @returns {string[]}
   */
  function collectDeviceSessionsForTab(deviceId, tabId) {
    const byToken = deviceSessions.get(deviceId)
    if (!byToken || tabId == null) return []
    const tokens = []
    for (const [token, owner] of byToken) {
      if (owner.tabId === tabId) tokens.push(token)
    }
    return tokens
  }

  /**
   * Collects every session token for a device (disconnect/global reset).
   * @param {number} deviceId
   * @returns {string[]}
   */
  function collectDeviceSessions(deviceId) {
    const byToken = deviceSessions.get(deviceId)
    return byToken ? [...byToken.keys()] : []
  }

  /**
   * Drops the session records owned by `origin` for a device.
   * @param {number} deviceId
   * @param {string} origin
   * @returns {void}
   */
  function clearDeviceSessionsForOrigin(deviceId, origin) {
    const byToken = deviceSessions.get(deviceId)
    if (!byToken || !origin) return
    for (const [token, owner] of byToken) {
      if (owner.origin === origin) byToken.delete(token)
    }
    if (byToken.size === 0) deviceSessions.delete(deviceId)
  }

  /**
   * Drops the session records owned by `tabId` for a device.
   * @param {number} deviceId
   * @param {number} tabId
   * @returns {void}
   */
  function clearDeviceSessionsForTab(deviceId, tabId) {
    const byToken = deviceSessions.get(deviceId)
    if (!byToken || tabId == null) return
    for (const [token, owner] of byToken) {
      if (owner.tabId === tabId) byToken.delete(token)
    }
    if (byToken.size === 0) deviceSessions.delete(deviceId)
  }

  /**
   * Drops every session record for a device (revocation / disconnect).
   * @param {number} deviceId
   * @returns {void}
   */
  function clearDeviceSessions(deviceId) {
    deviceSessions.delete(deviceId)
  }

  /**
   * Unregisters one open of a device from a tab, removing the device entry
   * when the tab holds no more opens.
   * @param {number} deviceId
   * @param {number} tabId
   * @returns {void}
   */
  function unregisterDeviceTab(deviceId, tabId) {
    if (!deviceId || tabId == null) return
    const tabs = deviceTabMap.get(deviceId)
    if (!tabs) return
    const remaining = (tabs.get(tabId) || 0) - 1
    if (remaining > 0) {
      tabs.set(tabId, remaining)
    } else {
      tabs.delete(tabId)
      if (tabs.size === 0) deviceTabMap.delete(deviceId)
    }
  }

  /**
   * Removes every open of a device from a tab (grant revocation).
   * @param {number} deviceId
   * @param {number} tabId
   * @returns {void}
   */
  function clearDeviceTab(deviceId, tabId) {
    if (!deviceId || tabId == null) return
    const tabs = deviceTabMap.get(deviceId)
    if (!tabs) return
    tabs.delete(tabId)
    if (tabs.size === 0) deviceTabMap.delete(deviceId)
  }

  /**
   * Checks whether a tab is authorized to access a device.
   * @param {number} tabId
   * @param {number} deviceId
   * @returns {boolean}
   */
  function isTabAuthorizedForDevice(tabId, deviceId) {
    const tabs = deviceTabMap.get(deviceId)
    return !!tabs && (tabs.get(tabId) || 0) > 0
  }

  /**
   * Removes a closing tab's registrations and closes every session the tab
   * owned, passing `(deviceId, token)` to `closeDeviceFn`. The tab's
   * sessions are always cleaned even when other tabs keep the device open.
   * @param {number} tabId
   * @param {Function} closeDeviceFn
   * @returns {void}
   */
  function purgeTab(tabId, closeDeviceFn) {
    if (tabId == null) return
    for (const [deviceId, tabs] of deviceTabMap) {
      if (!tabs.has(tabId)) continue
      tabs.delete(tabId)
      const tokens = collectDeviceSessionsForTab(deviceId, tabId)
      clearDeviceSessionsForTab(deviceId, tabId)
      for (const token of tokens) {
        closeDeviceFn(deviceId, token).catch((e) =>
          logger.debug('closeDevice failed', deviceId, e)
        )
      }
      if (tabs.size === 0) {
        deviceTabMap.delete(deviceId)
        deviceSessions.delete(deviceId)
      }
    }
  }
  /**
   * Runs `fn` for every tab whose top-level origin matches `origin`
   * (all tabs when `origin` is null).
   * @param {string|null} origin
   * @param {(tab: object) => void|Promise<void>} fn
   * @returns {Promise<void>}
   */
  async function forTabsOfOrigin(origin, fn) {
    const tabs = await browser.tabs.query({})
    for (const tab of tabs) {
      if (!tab.url) continue
      let tabOrigin
      try {
        tabOrigin = new URL(tab.url).origin
      } catch {
        continue
      }
      if (origin && tabOrigin !== origin) continue
      await fn(tab)
    }
  }

  /**
   * Sends a globalReset message to all tabs.
   * @returns {void}
   */
  function broadcastGlobalReset() {
    forTabsOfOrigin(null, (tab) =>
      browser.tabs.sendMessage(tab.id, { action: 'globalReset' }).catch(() => {})
    ).catch((e) => logger.debug('broadcastGlobalReset failed', e))
  }

  webhid.export('bgStateOps', {
    tabsForEvent,
    registerDeviceTab,
    registerDeviceSession,
    unregisterDeviceSession,
    collectDeviceSessions,
    collectDeviceSessionsForOrigin,
    collectDeviceSessionsForTab,
    clearDeviceSessions,
    clearDeviceSessionsForOrigin,
    clearDeviceSessionsForTab,
    unregisterDeviceTab,
    clearDeviceTab,
    isTabAuthorizedForDevice,
    purgeTab,
    broadcastGlobalReset,
    forTabsOfOrigin
  })
})()
