;(function () {
  const deviceCache = []
  const deviceTabMap = new Map()
  /** deviceId -> Map<tabId, Set<token>>: every daemon session token this
   * background is responsible for, so revoke/tab-cleanup can close the
   * exact sessions instead of guessing by device id. */
  const deviceSessions = new Map()
  /** tabId -> Map<frameKey, generation>: trusted document lifetimes. */
  const frameLifetimes = new Map()
  /** token -> { deviceId, attempts }: session closes that failed, kept for
   * retry after their owner tab is gone. */
  const orphanCleanup = new Map()
  const permissionsPolicy = new Map()
  const frameDelegations = new Map()
  const pendingPicker = new Map()
  /** @type {Map<object, object>} */
  const frameEndpoints = new Map()
  const workerPolyfillSites = new Set()
  const shadowArms = new Map()
  const pageActionVisibility = {
    hidePageAction: false,
    usedTabs: new Set(),
    chains: new Map()
  }

  function pageActionDesired(tabId) {
    return (
      pendingPicker.get(tabId)?.mode === 'pageAction' ||
      (!pageActionVisibility.hidePageAction && pageActionVisibility.usedTabs.has(tabId))
    )
  }

  function reconcilePageAction(tabId) {
    if (tabId == null || !browser.pageAction) return Promise.resolve()
    const previous = pageActionVisibility.chains.get(tabId) || Promise.resolve()
    const current = previous
      .catch(() => {})
      .then(async () => {
        for (;;) {
          const visible = pageActionDesired(tabId)
          try {
            await browser.pageAction[visible ? 'show' : 'hide'](tabId)
          } catch {
            void 0
          }
          if (pageActionDesired(tabId) === visible) return
        }
      })
      .finally(() => {
        if (pageActionVisibility.chains.get(tabId) === current)
          pageActionVisibility.chains.delete(tabId)
      })
    pageActionVisibility.chains.set(tabId, current)
    return current
  }

  pageActionVisibility.reconcile = reconcilePageAction

  pageActionVisibility.setHidden = (hidden) => {
    pageActionVisibility.hidePageAction = !!hidden
    return browser.tabs
      .query({})
      .then((tabs) =>
        Promise.all(tabs.filter((tab) => tab.id != null).map((tab) => reconcilePageAction(tab.id)))
      )
  }

  pageActionVisibility.markUsed = (tabId) => {
    if (tabId != null) pageActionVisibility.usedTabs.add(tabId)
    return reconcilePageAction(tabId)
  }

  pageActionVisibility.clearTab = (tabId) => {
    pageActionVisibility.usedTabs.delete(tabId)
    pageActionVisibility.chains.delete(tabId)
  }

  webhid.export('bgState', {
    deviceCache,
    deviceTabMap,
    deviceSessions,
    frameLifetimes,
    orphanCleanup,
    permissionsPolicy,
    frameDelegations,
    frameEndpoints,
    pageActionVisibility,
    pendingPicker,
    workerPolyfillSites,
    shadowArms
  })
})()
