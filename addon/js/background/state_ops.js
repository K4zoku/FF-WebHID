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
   * Records one daemon session token for a (device, tab) pair so cleanup
   * paths can close the exact session.
   * @param {number} deviceId
   * @param {number} tabId
   * @param {string} token
   * @returns {void}
   */
  function registerDeviceSession(deviceId, tabId, token) {
    if (!deviceId || tabId == null || !token) return
    let byTab = deviceSessions.get(deviceId)
    if (!byTab) {
      byTab = new Map()
      deviceSessions.set(deviceId, byTab)
    }
    let tokens = byTab.get(tabId)
    if (!tokens) {
      tokens = new Set()
      byTab.set(tabId, tokens)
    }
    tokens.add(token)
    logger.debug('register session device ' + deviceId + ' tab ' + tabId)
  }

  /**
   * Drops one session token for a (device, tab) pair after a successful
   * close.
   * @param {number} deviceId
   * @param {number} tabId
   * @param {string} token
   * @returns {void}
   */
  function unregisterDeviceSession(deviceId, tabId, token) {
    if (!deviceId || tabId == null || !token) return
    const byTab = deviceSessions.get(deviceId)
    if (!byTab) return
    const tokens = byTab.get(tabId)
    if (!tokens) return
    tokens.delete(token)
    if (tokens.size === 0) byTab.delete(tabId)
    if (byTab.size === 0) deviceSessions.delete(deviceId)
  }

  /**
   * Collects every session token for a device across all tabs (revocation).
   * @param {number} deviceId
   * @returns {string[]}
   */
  function collectDeviceSessions(deviceId) {
    const byTab = deviceSessions.get(deviceId)
    if (!byTab) return []
    const tokens = []
    for (const set of byTab.values()) tokens.push(...set)
    return tokens
  }

  /**
   * Drops every session record for a device (revocation).
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
   * Removes all device registrations for a tab and closes every exact
   * session the tab held, passing `(deviceId, token)` to `closeDeviceFn`.
   * @param {number} tabId
   * @param {Function} closeDeviceFn
   * @returns {void}
   */
  function purgeTab(tabId, closeDeviceFn) {
    if (tabId == null) return
    for (const [deviceId, tabs] of deviceTabMap) {
      if (tabs.delete(tabId) && tabs.size === 0) {
        deviceTabMap.delete(deviceId)
        const byTab = deviceSessions.get(deviceId)
        const tokens = byTab ? [...(byTab.get(tabId) || [])] : []
        if (byTab) {
          byTab.delete(tabId)
          if (byTab.size === 0) deviceSessions.delete(deviceId)
        }
        for (const token of tokens) {
          closeDeviceFn(deviceId, token).catch((e) =>
            logger.debug('closeDevice failed', deviceId, e)
          )
        }
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
    clearDeviceSessions,
    unregisterDeviceTab,
    clearDeviceTab,
    isTabAuthorizedForDevice,
    purgeTab,
    broadcastGlobalReset,
    forTabsOfOrigin
  })
})()
