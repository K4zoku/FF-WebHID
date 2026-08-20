;(function () {
  const deviceCache = []
  const deviceTabMap = new Map()
  /** deviceId -> Map<tabId, Set<token>>: every daemon session token this
   * background is responsible for, so revoke/tab-cleanup can close the
   * exact sessions instead of guessing by device id. */
  const deviceSessions = new Map()
  const permissionsPolicy = new Map()
  const allowedCrossOrigin = new Map()
  const pendingPicker = new Map()
  const workerPolyfillSites = new Set()
  const shadowArms = new Map()

  webhid.export('bgState', {
    deviceCache,
    deviceTabMap,
    deviceSessions,
    permissionsPolicy,
    allowedCrossOrigin,
    pendingPicker,
    workerPolyfillSites,
    shadowArms
  })
})()
