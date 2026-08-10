;(function () {
  const deviceCache = []
  const deviceTabMap = new Map()
  const permissionsPolicy = new Map()
  const allowedCrossOrigin = new Map()
  const pendingPicker = new Map()
  const workerPolyfillSites = new Set()
  const shadowArms = new Map()

  webhid.export('bgState', {
    deviceCache,
    deviceTabMap,
    permissionsPolicy,
    allowedCrossOrigin,
    pendingPicker,
    workerPolyfillSites,
    shadowArms
  })
})()
