;(function () {
  const logger = webhid.import('logger')
  const { deviceTabMap } = webhid.import('bgState')

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
   * Removes all device registrations for a tab and closes devices with no remaining tabs.
   * @param {number} tabId
   * @param {Function} closeDeviceFn
   * @returns {void}
   */
  function purgeTab(tabId, closeDeviceFn) {
    if (tabId == null) return
    for (const [deviceId, tabs] of deviceTabMap) {
      if (tabs.delete(tabId) && tabs.size === 0) {
        deviceTabMap.delete(deviceId)
        closeDeviceFn(deviceId).catch((e) => logger.debug('closeDevice failed', e))
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
    unregisterDeviceTab,
    clearDeviceTab,
    isTabAuthorizedForDevice,
    purgeTab,
    broadcastGlobalReset,
    forTabsOfOrigin
  })
})()
