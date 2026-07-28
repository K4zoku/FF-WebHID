(function () {
  const logger = webhid.import("logger");
  const { deviceCache } = webhid.import("bgState");

  const DB_NAME = "webhid-store";
  const DB_VERSION = 1;
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains("deviceInfo")) {
          db.createObjectStore("deviceInfo", { keyPath: "deviceId" });
        }
        if (!db.objectStoreNames.contains("origins")) {
          db.createObjectStore("origins", { keyPath: ["origin", "deviceId"] });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function saveDeviceInfo(device) {
    if (!device || !device.deviceId) return;
    try {
      const db = await openDb();
      const tx = db.transaction("deviceInfo", "readwrite");
      tx.objectStore("deviceInfo").put(device);
      await txDone(tx);
    } catch (e) {
      logger.debug("saveDeviceInfo failed", e);
    }
  }

  async function saveDeviceInfoBatch(devices) {
    if (!devices || !devices.length) return;
    try {
      const db = await openDb();
      const tx = db.transaction("deviceInfo", "readwrite");
      const store = tx.objectStore("deviceInfo");
      for (const d of devices) {
        if (d && d.deviceId) store.put(d);
      }
      await txDone(tx);
    } catch (e) {
      logger.debug("saveDeviceInfoBatch failed", e);
    }
  }

  async function getDeviceInfo(deviceId) {
    if (!deviceId) return null;
    const live = deviceCache.find((d) => d.deviceId === deviceId);
    if (live) return live;
    try {
      const db = await openDb();
      const tx = db.transaction("deviceInfo", "readonly");
      return await new Promise((resolve, reject) => {
        const req = tx.objectStore("deviceInfo").get(deviceId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return null;
    }
  }

  async function removeDeviceInfo(deviceId) {
    if (!deviceId) return;
    try {
      const db = await openDb();
      const tx = db.transaction("deviceInfo", "readwrite");
      tx.objectStore("deviceInfo").delete(deviceId);
      await txDone(tx);
    } catch (e) {
      logger.debug("removeDeviceInfo failed", e);
    }
  }

  async function getAllowedDevices(origin) {
    const db = await openDb();
    const tx = db.transaction("origins", "readonly");
    const range = IDBKeyRange.bound([origin, -Infinity], [origin, Infinity]);
    return await new Promise((resolve, reject) => {
      const req = tx.objectStore("origins").getAll(range);
      req.onsuccess = () => resolve(req.result.map((r) => r.deviceId));
      req.onerror = () => reject(req.error);
    });
  }

  async function addAllowedDevice(origin, deviceId) {
    const db = await openDb();
    const tx = db.transaction("origins", "readwrite");
    tx.objectStore("origins").put({ origin, deviceId: Number(deviceId) });
    await txDone(tx);
  }

  async function removeAllowedDevice(origin, deviceId) {
    const db = await openDb();
    const tx = db.transaction("origins", "readwrite");
    tx.objectStore("origins").delete([origin, Number(deviceId)]);
    await txDone(tx);
  }

  webhid.export("bgStorage", {
    openDb,
    saveDeviceInfo,
    saveDeviceInfoBatch,
    getDeviceInfo,
    removeDeviceInfo,
    getAllowedDevices,
    addAllowedDevice,
    removeAllowedDevice,
  });
})();
