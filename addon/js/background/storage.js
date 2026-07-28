(function () {
  const logger = webhid.import("logger");
  const { deviceCache } = webhid.import("bgState");

  async function saveDeviceInfo(device) {
    if (!device || !device.deviceId) return;
    try {
      await browser.storage.local.set({
        [`deviceInfo:${device.deviceId}`]: device,
      });
    } catch (e) { logger.debug("saveDeviceInfo failed", e); }
  }

  async function saveDeviceInfoBatch(devices) {
    if (!devices || !devices.length) return;
    const entries = {};
    for (const d of devices) {
      if (d && d.deviceId) entries[`deviceInfo:${d.deviceId}`] = d;
    }
    try {
      await browser.storage.local.set(entries);
    } catch (e) { logger.debug("saveDeviceInfoBatch failed", e); }
  }

  async function getDeviceInfo(deviceId) {
    if (!deviceId) return null;
    const live = deviceCache.find((d) => d.deviceId === deviceId);
    if (live) return live;
    try {
      const result = await browser.storage.local.get(`deviceInfo:${deviceId}`);
      return result[`deviceInfo:${deviceId}`] || null;
    } catch {
      return null;
    }
  }

  async function removeDeviceInfo(deviceId) {
    if (!deviceId) return;
    try {
      await browser.storage.local.remove(`deviceInfo:${deviceId}`);
    } catch (e) { logger.debug("removeDeviceInfo failed", e); }
  }

  webhid.export("bgStorage", { saveDeviceInfo, saveDeviceInfoBatch, getDeviceInfo, removeDeviceInfo });
})();
