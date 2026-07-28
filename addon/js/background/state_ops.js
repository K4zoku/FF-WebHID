(function () {
  const logger = webhid.import("logger");
  const { ACT, PKG_INPUT_REPORT, EVT_CONNECT, EVT_DISCONNECT } = webhid.import("bgPacked");
  const { deviceTabMap, deviceCache } = webhid.import("bgState");
  const { saveDeviceInfo, saveDeviceInfoBatch } = webhid.import("bgStorage");
  const http = webhid.import("http");

  function tabsForEvent(message) {
    const eventType = message.e;
    if (eventType === 1 || !message.i) return null;
    const tabs = deviceTabMap.get(message.i);
    return tabs && tabs.size > 0 ? [...tabs] : null;
  }

  function registerDeviceTab(deviceId, tabId) {
    if (!deviceId || tabId == null) return;
    let tabs = deviceTabMap.get(deviceId);
    if (!tabs) {
      tabs = new Set();
      deviceTabMap.set(deviceId, tabs);
    }
    tabs.add(tabId);
    logger.debug("register device " + deviceId + " tab " + tabId);
  }

  function unregisterDeviceTab(deviceId, tabId) {
    if (!deviceId || tabId == null) return;
    const tabs = deviceTabMap.get(deviceId);
    if (!tabs) return;
    tabs.delete(tabId);
    if (tabs.size === 0) deviceTabMap.delete(deviceId);
  }

  function isTabAuthorizedForDevice(tabId, deviceId) {
    const tabs = deviceTabMap.get(deviceId);
    return !!tabs && tabs.has(tabId);
  }

  function purgeTab(tabId, closeDeviceFn) {
    if (tabId == null) return;
    for (const [deviceId, tabs] of deviceTabMap) {
      if (tabs.delete(tabId) && tabs.size === 0) {
        deviceTabMap.delete(deviceId);
        closeDeviceFn(deviceId).catch((e) => logger.debug("closeDevice failed", e));
      }
    }
  }

  async function isDeviceAllowedForOrigin(origin, deviceId) {
    if (!origin || origin === "null" || !deviceId) return false;
    const key = encodeURIComponent(origin);
    const result = await browser.storage.local.get(key);
    return (result[key] || []).includes(deviceId);
  }

  function broadcastGlobalReset() {
    browser.tabs
      .query({})
      .then((tabs) => {
        for (const tab of tabs) {
          if (!tab.url) continue;
          try { new URL(tab.url); } catch (e) { continue; }
          browser.tabs
            .sendMessage(tab.id, { action: "globalReset" })
            .catch((e) => logger.debug("globalReset send to tab failed", e));
        }
      })
      .catch((e) => logger.debug("broadcastGlobalReset failed", e));
  }

  webhid.export("bgStateOps", {
    tabsForEvent, registerDeviceTab, unregisterDeviceTab, isTabAuthorizedForDevice,
    purgeTab, isDeviceAllowedForOrigin, broadcastGlobalReset,
  });
})();
