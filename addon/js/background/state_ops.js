;(function () {
  const logger = webhid.import('logger')
  const {
    ACT: _ACT,
    PKG_INPUT_REPORT: _PKG_INPUT_REPORT,
    EVT_CONNECT: _EVT_CONNECT,
    EVT_DISCONNECT: _EVT_DISCONNECT
  } = webhid.import('bgPacked')
  const { deviceTabMap, deviceCache: _deviceCache } = webhid.import('bgState')
  const { saveDeviceInfo: _saveDeviceInfo, saveDeviceInfoBatch: _saveDeviceInfoBatch } =
    webhid.import('bgStorage')
  const _http = webhid.import('http')

  /**
   * Returns the list of tab IDs authorized for the device in the given event, or null.
   * @param {object} message
   * @returns {number[]|null}
   */
  function tabsForEvent(message) {
    const eventType = message.e
    if (eventType === 1 || !message.i) return null
    const tabs = deviceTabMap.get(message.i)
    return tabs && tabs.size > 0 ? [...tabs] : null
  }

  /**
   * Registers a tab as authorized to access a device.
   * @param {number} deviceId
   * @param {number} tabId
   * @returns {void}
   */
  function registerDeviceTab(deviceId, tabId) {
    if (!deviceId || tabId == null) return
    let tabs = deviceTabMap.get(deviceId)
    if (!tabs) {
      tabs = new Set()
      deviceTabMap.set(deviceId, tabs)
    }
    tabs.add(tabId)
    logger.debug('register device ' + deviceId + ' tab ' + tabId)
  }

  /**
   * Unregisters a tab from a device, removing the device entry if no tabs remain.
   * @param {number} deviceId
   * @param {number} tabId
   * @returns {void}
   */
  function unregisterDeviceTab(deviceId, tabId) {
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
    return !!tabs && tabs.has(tabId)
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
   * Sends a globalReset message to all tabs.
   * @returns {void}
   */
  function broadcastGlobalReset() {
    browser.tabs
      .query({})
      .then((tabs) => {
        for (const tab of tabs) {
          if (!tab.url) continue
          try {
            new URL(tab.url)
          } catch {
            continue
          }
          browser.tabs
            .sendMessage(tab.id, { action: 'globalReset' })
            .catch((e) => logger.debug('globalReset send to tab failed', e))
        }
      })
      .catch((e) => logger.debug('broadcastGlobalReset failed', e))
  }

  webhid.export('bgStateOps', {
    tabsForEvent,
    registerDeviceTab,
    unregisterDeviceTab,
    isTabAuthorizedForDevice,
    purgeTab,
    broadcastGlobalReset
  })
})()
