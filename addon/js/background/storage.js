;(function () {
  const logger = webhid.import('logger')
  const { deviceCache } = webhid.import('bgState')

  const DB_NAME = 'webhid-store'
  const DB_VERSION = 2
  let dbPromise = null

  /**
   * Opens (or returns the cached) IndexedDB database instance.
   * @returns {Promise<object>}
   */
  function openDb() {
    if (dbPromise) return dbPromise
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = (event) => {
        const db = event.target.result
        if (!db.objectStoreNames.contains('deviceInfo')) {
          db.createObjectStore('deviceInfo', { keyPath: 'deviceId' })
        }
        if (!db.objectStoreNames.contains('origins')) {
          db.createObjectStore('origins', { keyPath: ['origin', 'deviceId'] })
        }
        if (!db.objectStoreNames.contains('grantGroups')) {
          const store = db.createObjectStore('grantGroups', {
            keyPath: 'id',
            autoIncrement: true
          })
          store.createIndex('byOrigin', 'origin', { unique: false })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    return dbPromise
  }

  /**
   * Waits for an IndexedDB transaction to complete.
   * @param {object} tx
   * @returns {Promise<void>}
   */
  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  }

  /**
   * Persists a single device info record to IndexedDB.
   * @param {object} device
   * @returns {Promise<void>}
   */
  async function saveDeviceInfo(device) {
    if (!device || !device.deviceId) return
    try {
      const db = await openDb()
      const tx = db.transaction('deviceInfo', 'readwrite')
      tx.objectStore('deviceInfo').put(device)
      await txDone(tx)
    } catch (e) {
      logger.debug('saveDeviceInfo failed', e)
    }
  }

  /**
   * Persists multiple device info records to IndexedDB in a single transaction.
   * @param {object[]} devices
   * @returns {Promise<void>}
   */
  async function saveDeviceInfoBatch(devices) {
    if (!devices || !devices.length) return
    try {
      const db = await openDb()
      const tx = db.transaction('deviceInfo', 'readwrite')
      const store = tx.objectStore('deviceInfo')
      for (const d of devices) {
        if (d && d.deviceId) store.put(d)
      }
      await txDone(tx)
    } catch (e) {
      logger.debug('saveDeviceInfoBatch failed', e)
    }
  }

  /**
   * Retrieves device info from the cache or IndexedDB.
   * @param {number} deviceId
   * @returns {Promise<object|null>}
   */
  async function getDeviceInfo(deviceId) {
    if (!deviceId) return null
    const live = deviceCache.find((d) => d.deviceId === deviceId)
    if (live) return live
    try {
      const db = await openDb()
      const tx = db.transaction('deviceInfo', 'readonly')
      return await new Promise((resolve, reject) => {
        const req = tx.objectStore('deviceInfo').get(deviceId)
        req.onsuccess = () => resolve(req.result || null)
        req.onerror = () => reject(req.error)
      })
    } catch {
      return null
    }
  }

  /**
   * Removes a device info record from IndexedDB.
   * @param {number} deviceId
   * @returns {Promise<void>}
   */
  async function removeDeviceInfo(deviceId) {
    if (!deviceId) return
    try {
      const db = await openDb()
      const tx = db.transaction('deviceInfo', 'readwrite')
      tx.objectStore('deviceInfo').delete(deviceId)
      await txDone(tx)
    } catch (e) {
      logger.debug('removeDeviceInfo failed', e)
    }
  }

  /**
   * Returns the list of allowed device IDs for a given origin.
   * @param {string} origin
   * @returns {Promise<number[]>}
   */
  async function getAllowedDevices(origin) {
    const db = await openDb()
    const tx = db.transaction('origins', 'readonly')
    const range = IDBKeyRange.bound([origin, -Infinity], [origin, Infinity])
    return await new Promise((resolve, reject) => {
      const req = tx.objectStore('origins').getAll(range)
      req.onsuccess = () => resolve(req.result.map((r) => r.deviceId))
      req.onerror = () => reject(req.error)
    })
  }

  /**
   * Returns the allowed device grants for an origin, each carrying the
   * 128-bit identity key captured at grant time.
   * @param {string} origin
   * @returns {Promise<Array<{deviceId: number, identityKey: string}>>}
   */
  async function getAllowedDeviceGrants(origin) {
    const db = await openDb()
    const tx = db.transaction('origins', 'readonly')
    const range = IDBKeyRange.bound([origin, -Infinity], [origin, Infinity])
    return await new Promise((resolve, reject) => {
      const req = tx.objectStore('origins').getAll(range)
      req.onsuccess = () =>
        resolve(
          req.result.map((r) => ({ deviceId: r.deviceId, identityKey: r.identityKey || '' }))
        )
      req.onerror = () => reject(req.error)
    })
  }

  /**
   * Adds a device to the allowed list for an origin, binding the physical
   * identity key present at grant time.
   * @param {string} origin
   * @param {number} deviceId
   * @param {string} identityKey
   * @returns {Promise<void>}
   */
  async function addAllowedDevice(origin, deviceId, identityKey) {
    const db = await openDb()
    const tx = db.transaction('origins', 'readwrite')
    tx.objectStore('origins').put({
      origin,
      deviceId: Number(deviceId),
      identityKey: identityKey || ''
    })
    await txDone(tx)
  }

  /**
   * Removes a device from the allowed list for an origin.
   * @param {string} origin
   * @param {number} deviceId
   * @returns {Promise<void>}
   */
  async function removeAllowedDevice(origin, deviceId) {
    const db = await openDb()
    const tx = db.transaction('origins', 'readwrite')
    tx.objectStore('origins').delete([origin, Number(deviceId)])
    await txDone(tx)
  }

  /**
   * Records a grant group: the device IDs granted together by one
   * requestDevice() call for one origin. Singleton grants are not recorded;
   * their forget semantics are plain per-device revocation.
   * @param {string} origin
   * @param {number[]} deviceIds
   * @returns {Promise<void>}
   */
  async function recordGrantGroup(origin, deviceIds) {
    if (!origin || !Array.isArray(deviceIds) || deviceIds.length < 2) return
    try {
      const db = await openDb()
      const tx = db.transaction('grantGroups', 'readwrite')
      tx.objectStore('grantGroups').add({
        origin,
        deviceIds: deviceIds.map((id) => Number(id)),
        grantedAt: Date.now()
      })
      await txDone(tx)
    } catch (e) {
      logger.debug('recordGrantGroup failed', e)
    }
  }

  /**
   * Returns all grant groups recorded for an origin.
   * @param {string} origin
   * @returns {Promise<Array<{id: number, origin: string, deviceIds: number[]}>>}
   */
  async function getGrantGroupsForOrigin(origin) {
    try {
      const db = await openDb()
      const tx = db.transaction('grantGroups', 'readonly')
      return await new Promise((resolve, reject) => {
        const req = tx.objectStore('grantGroups').index('byOrigin').getAll(origin)
        req.onsuccess = () => resolve(req.result || [])
        req.onerror = () => reject(req.error)
      })
    } catch {
      return []
    }
  }

  /**
   * Deletes grant groups by id.
   * @param {number[]} groupIds
   * @returns {Promise<void>}
   */
  async function deleteGrantGroups(groupIds) {
    if (!groupIds || !groupIds.length) return
    try {
      const db = await openDb()
      const tx = db.transaction('grantGroups', 'readwrite')
      const store = tx.objectStore('grantGroups')
      for (const id of groupIds) store.delete(id)
      await txDone(tx)
    } catch (e) {
      logger.debug('deleteGrantGroups failed', e)
    }
  }

  /**
   * Returns every currently allowed (origin, deviceId) pair, grouped by origin.
   * @returns {Promise<Map<string, number[]>>}
   */
  async function getAllAllowedByOrigin() {
    try {
      const db = await openDb()
      const tx = db.transaction('origins', 'readonly')
      const rows = await new Promise((resolve, reject) => {
        const req = tx.objectStore('origins').getAll()
        req.onsuccess = () => resolve(req.result || [])
        req.onerror = () => reject(req.error)
      })
      const map = new Map()
      for (const row of rows) {
        if (!map.has(row.origin)) map.set(row.origin, [])
        map.get(row.origin).push(row.deviceId)
      }
      return map
    } catch {
      return new Map()
    }
  }

  webhid.export('bgStorage', {
    openDb,
    txDone,
    saveDeviceInfo,
    saveDeviceInfoBatch,
    getDeviceInfo,
    removeDeviceInfo,
    getAllowedDevices,
    getAllowedDeviceGrants,
    addAllowedDevice,
    removeAllowedDevice,
    recordGrantGroup,
    getGrantGroupsForOrigin,
    deleteGrantGroups,
    getAllAllowedByOrigin
  })
})()
