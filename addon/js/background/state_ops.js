;(function () {
  const logger = webhid.import('logger')
  const { deviceTabMap, deviceSessions, frameLifetimes, orphanCleanup } = webhid.import('bgState')

  const CLEANUP_ALREADY_GONE = 404

  /**
   * Whether a daemon close response proves that a session is no longer live.
   * @param {object|null|undefined} response
   * @returns {boolean}
   */
  function isCleanupConfirmed(response) {
    const status = response && response.s
    return (status >= 200 && status < 300) || status === CLEANUP_ALREADY_GONE
  }

  /**
   * Retains a session token as cleanup authority without resetting its retry
   * history when an existing orphan is retried.
   * @param {number} deviceId
   * @param {string} token
   * @param {object|null} [expectedOwner]
   * @returns {void}
   */
  function retainOrphanCleanup(deviceId, token, expectedOwner) {
    if (expectedOwner && deviceSessions.get(deviceId)?.get(token) === expectedOwner) {
      unregisterDeviceSession(deviceId, token)
    }
    if (!orphanCleanup.has(token)) orphanCleanup.set(token, { deviceId, attempts: 0 })
  }
  /**
   * Closes one daemon session and removes its browser ownership only after a
   * confirmed close or already-gone response.
   * @param {number} deviceId
   * @param {string} token
   * @param {Function} closeDeviceFn
   * @returns {Promise<boolean>}
   */
  async function closeForCleanup(deviceId, token, closeDeviceFn) {
    const ownerAtStart = deviceSessions.get(deviceId)?.get(token) || null
    try {
      const response = await closeDeviceFn(deviceId, token)
      if (isCleanupConfirmed(response)) {
        if (ownerAtStart && deviceSessions.get(deviceId)?.get(token) === ownerAtStart) {
          unregisterDeviceSession(deviceId, token)
        }
        orphanCleanup.delete(token)
        return true
      }
      if (response && response.s === 403) {
        logger.error('cleanup ownership invariant failed for device', deviceId, token)
      }
    } catch (e) {
      logger.debug('cleanup close failed for device', deviceId, e)
    }
    retainOrphanCleanup(deviceId, token, ownerAtStart)
    return false
  }

  /**
   * Registers a trusted bridge-owned document lifetime.
   * @param {number} tabId
   * @param {string} frameKey
   * @returns {boolean} false when this generation was already retired
   */
  function registerFrameLifetime(tabId, frameKey) {
    if (tabId == null || !frameKey) return false
    let frames = frameLifetimes.get(tabId)
    if (!frames) {
      frames = new Map()
      frameLifetimes.set(tabId, frames)
    }
    if (frames.get(frameKey) === 0) return false
    frames.set(frameKey, (frames.get(frameKey) || 0) + 1)
    return true
  }

  /**
   * @param {number} tabId
   * @param {string} frameKey
   * @returns {boolean}
   */
  function isFrameLifetimeActive(tabId, frameKey) {
    if (tabId == null || !frameKey) return false
    const frames = frameLifetimes.get(tabId)
    return !!frames && frames.get(frameKey) > 0
  }

  /**
   * Removes a frame lifetime so in-flight opens cannot publish ownership.
   * @param {number} tabId
   * @param {string} frameKey
   * @returns {void}
   */
  function retireFrameLifetime(tabId, frameKey) {
    if (tabId == null || !frameKey) return
    let frames = frameLifetimes.get(tabId)
    if (!frames) {
      frames = new Map()
      frameLifetimes.set(tabId, frames)
    }
    frames.set(frameKey, 0)
  }

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
   * Records one daemon session token with its owner.
   * `deviceSessions` is `deviceId -> Map<token, { tabId, origin, frameKey, bridgeInstanceId, clientKey }>` .
   * @param {number} deviceId
   * @param {string} token
   * @param {{tabId: number, origin: string, frameKey?: string, bridgeInstanceId?: string, clientKey?: string}} owner
   * @returns {boolean}
   */
  function registerDeviceSession(deviceId, token, owner) {
    if (!deviceId || !token || !owner || owner.tabId == null || !owner.origin) return false
    const frameKey = owner.frameKey || 'tab:' + owner.tabId
    if (!isFrameLifetimeActive(owner.tabId, frameKey) && !registerFrameLifetime(owner.tabId, frameKey)) {
      return false
    }
    let byToken = deviceSessions.get(deviceId)
    if (!byToken) {
      byToken = new Map()
      deviceSessions.set(deviceId, byToken)
    }
    byToken.set(token, {
      tabId: owner.tabId,
      origin: owner.origin,
      frameKey,
      bridgeInstanceId: owner.bridgeInstanceId || '',
      clientKey: owner.clientKey || ''
    })
    logger.debug('register session device ' + deviceId + ' tab ' + owner.tabId)
    return true
  }

  /**
   * Drops the exact session token after a successful close.
   * @param {number} deviceId
   * @param {string} token
   * @returns {void}
   */
  function unregisterDeviceSession(deviceId, token) {
    if (!deviceId || !token) return
    const byToken = deviceSessions.get(deviceId)
    if (!byToken) return
    byToken.delete(token)
    if (byToken.size === 0) deviceSessions.delete(deviceId)
  }

  /**
   * Collects session tokens for a device owned by `origin` (revocation).
   * @param {number} deviceId
   * @param {string} origin
   * @returns {string[]}
   */
  function collectDeviceSessionsForOrigin(deviceId, origin) {
    const byToken = deviceSessions.get(deviceId)
    if (!byToken || !origin) return []
    const tokens = []
    for (const [token, owner] of byToken) {
      if (owner.origin === origin) tokens.push(token)
    }
    return tokens
  }

  /**
   * Collects session tokens for a device owned by `tabId` (tab close).
   * @param {number} deviceId
   * @param {number} tabId
   * @returns {string[]}
   */
  function collectDeviceSessionsForTab(deviceId, tabId) {
    const byToken = deviceSessions.get(deviceId)
    if (!byToken || tabId == null) return []
    const tokens = []
    for (const [token, owner] of byToken) {
      if (owner.tabId === tabId) tokens.push(token)
    }
    return tokens
  }

  /**
   * Returns the trusted owner metadata for one session token.
   * @param {number} deviceId
   * @param {string} token
   * @returns {{tabId: number, origin: string, frameKey: string}|null}
   */
  function getDeviceSessionOwner(deviceId, token) {
    return deviceSessions.get(deviceId)?.get(token) || null
  }

  /**
   * Collects session tokens for one trusted frame generation.
   * @param {number} deviceId
   * @param {number} tabId
   * @param {string} frameKey
   * @returns {string[]}
   */
  function collectDeviceSessionsForFrame(deviceId, tabId, frameKey) {
    const byToken = deviceSessions.get(deviceId)
    if (!byToken || tabId == null || !frameKey) return []
    const tokens = []
    for (const [token, owner] of byToken) {
      if (owner.tabId === tabId && owner.frameKey === frameKey) tokens.push(token)
    }
    return tokens
  }

  /**
   * Collects every session token for a device (disconnect/global reset).
   * @param {number} deviceId
   * @returns {string[]}
   */
  function collectDeviceSessions(deviceId) {
    const byToken = deviceSessions.get(deviceId)
    return byToken ? [...byToken.keys()] : []
  }

  /**
   * Drops the session records owned by `origin` for a device.
   * @param {number} deviceId
   * @param {string} origin
   * @returns {void}
   */
  function clearDeviceSessionsForOrigin(deviceId, origin) {
    const byToken = deviceSessions.get(deviceId)
    if (!byToken || !origin) return
    for (const [token, owner] of byToken) {
      if (owner.origin === origin) byToken.delete(token)
    }
    if (byToken.size === 0) deviceSessions.delete(deviceId)
  }

  /**
   * Drops the session records owned by `tabId` for a device.
   * @param {number} deviceId
   * @param {number} tabId
   * @returns {void}
   */
  function clearDeviceSessionsForTab(deviceId, tabId) {
    const byToken = deviceSessions.get(deviceId)
    if (!byToken || tabId == null) return
    for (const [token, owner] of byToken) {
      if (owner.tabId === tabId) byToken.delete(token)
    }
    if (byToken.size === 0) deviceSessions.delete(deviceId)
  }

  /**
   * Drops every session record for a device (revocation / disconnect).
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
   * Whether `token` is the exact daemon session opened by `origin`, frame,
   * and (when given) tab. Principal-aware checks use this so a sibling frame
   * or origin can never operate on someone else's session.
   * @param {number} deviceId
   * @param {string} token
   * @param {string} origin
   * @param {number} [tabId]
   * @param {string} [frameKey]
   * @param {string} [clientKey]
   * @returns {boolean}
   */
  function isSessionOwnedBy(deviceId, token, origin, tabId, frameKey, clientKey) {
    const byToken = deviceSessions.get(deviceId)
    if (!byToken) return false
    const owner = byToken.get(token)
    if (!owner) return false
    if (owner.origin !== origin) return false
    if (tabId != null && owner.tabId !== tabId) return false
    if (frameKey != null && owner.frameKey !== frameKey) return false
    if (clientKey != null && owner.clientKey !== clientKey) return false
    return true
  }

  /**
   * Removes one frame generation and closes only its daemon sessions.
   * @param {number} tabId
   * @param {string} frameKey
   * @param {Function} closeDeviceFn
   * @returns {Promise<void>}
   */
  async function purgeFrame(tabId, frameKey, closeDeviceFn) {
    if (tabId == null || !frameKey) return
    retireFrameLifetime(tabId, frameKey)
    const deviceIds = new Set([...deviceSessions.keys(), ...deviceTabMap.keys()])
    const pending = []
    for (const deviceId of deviceIds) {
      const tokens = collectDeviceSessionsForFrame(deviceId, tabId, frameKey)
      for (const token of tokens) {
        unregisterDeviceTab(deviceId, tabId)
        pending.push(closeForCleanup(deviceId, token, closeDeviceFn))
      }
      const tabs = deviceTabMap.get(deviceId)
      if (tabs && tabs.size === 0) deviceTabMap.delete(deviceId)
    }
    await Promise.all(pending)
  }
  /**
   * Retires all frame lifetimes and sessions owned by one bridge instance.
   * @param {number} tabId
   * @param {string} bridgeInstanceId
   * @param {Function} closeDeviceFn
   * @returns {Promise<void>}
   */
  async function purgeBridge(tabId, bridgeInstanceId, closeDeviceFn) {
    if (tabId == null || !bridgeInstanceId) return
    const frames = frameLifetimes.get(tabId)
    const prefix = bridgeInstanceId + '/'
    if (frames) {
      for (const frameKey of frames.keys()) {
        if (frameKey.startsWith(prefix)) frames.set(frameKey, 0)
      }
    }
    const deviceIds = new Set([...deviceSessions.keys(), ...deviceTabMap.keys()])
    const pending = []
    for (const deviceId of deviceIds) {
      const byToken = deviceSessions.get(deviceId)
      if (byToken) {
        for (const [token, owner] of byToken) {
          if (owner.tabId !== tabId || owner.bridgeInstanceId !== bridgeInstanceId) continue
          unregisterDeviceTab(deviceId, tabId)
          pending.push(closeForCleanup(deviceId, token, closeDeviceFn))
        }
      }
      const tabs = deviceTabMap.get(deviceId)
      if (tabs && tabs.size === 0) deviceTabMap.delete(deviceId)
    }
    await Promise.all(pending)
  }

  /**
   * Moves a session whose daemon close failed into the orphan retry queue.
   * The ownership record is dropped only after the close is confirmed or the
   * token is tracked for retry, never before.
   * @param {number} deviceId
   * @param {string} token
   * @returns {void}
   */
  function enqueueOrphanCleanup(deviceId, token) {
    unregisterDeviceSession(deviceId, token)
    retainOrphanCleanup(deviceId, token)
  }

  /**
   * Retries every queued orphan close, passing `(deviceId, token)` to
   * `closeDeviceFn`. Entries are removed only on success or already-gone.
   * @param {Function} closeDeviceFn
   * @returns {number}
   */
  function retryOrphanCleanup(closeDeviceFn) {
    let touched = 0
    for (const [token, entry] of orphanCleanup) {
      entry.attempts += 1
      touched += 1
      closeForCleanup(entry.deviceId, token, closeDeviceFn).then((confirmed) => {
        if (!confirmed && entry.attempts % 5 === 0) {
          logger.warn('orphan cleanup still pending for device', entry.deviceId, token)
        }
      })
    }
    return touched
  }

  /**
   * Removes a closing tab's registrations and closes every session the tab
   * owned, passing `(deviceId, token)` to `closeDeviceFn`. Ownership records
   * are removed only after the daemon confirms the close; failures move to the
   * orphan retry queue. Sibling tab sessions remain untouched.
   * @param {number} tabId
   * @param {Function} closeDeviceFn
   * @returns {Promise<void>}
   */
  async function purgeTab(tabId, closeDeviceFn) {
    if (tabId == null) return
    const deviceIds = new Set([...deviceSessions.keys(), ...deviceTabMap.keys()])
    const pending = []
    for (const deviceId of deviceIds) {
      const tabs = deviceTabMap.get(deviceId)
      if (tabs) tabs.delete(tabId)
      const tokens = collectDeviceSessionsForTab(deviceId, tabId)
      for (const token of tokens) pending.push(closeForCleanup(deviceId, token, closeDeviceFn))
      if (tabs && tabs.size === 0) deviceTabMap.delete(deviceId)
    }
    frameLifetimes.delete(tabId)
    await Promise.all(pending)
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

  /**
   * Clears all browser ownership derived from one dead NM authority lifetime.
   * @returns {void}
   */
  function clearAuthorityOwnership() {
    deviceTabMap.clear()
    deviceSessions.clear()
    frameLifetimes.clear()
    orphanCleanup.clear()
  }

  /**
   * Clears all browser ownership derived from one physical device lifetime.
   * @param {number} deviceId
   * @returns {void}
   */
  function clearDeviceOwnership(deviceId) {
    deviceTabMap.delete(deviceId)
    deviceSessions.delete(deviceId)
    for (const [token, entry] of orphanCleanup) {
      if (entry.deviceId === deviceId) orphanCleanup.delete(token)
    }
  }
  webhid.export('bgStateOps', {
    tabsForEvent,
    registerDeviceTab,
    registerDeviceSession,
    unregisterDeviceSession,
    collectDeviceSessions,
    collectDeviceSessionsForOrigin,
    collectDeviceSessionsForTab,
    collectDeviceSessionsForFrame,
    getDeviceSessionOwner,
    clearDeviceSessions,
    clearDeviceSessionsForOrigin,
    clearDeviceSessionsForTab,
    enqueueOrphanCleanup,
    retryOrphanCleanup,
    unregisterDeviceTab,
    clearDeviceTab,
    isTabAuthorizedForDevice,
    isSessionOwnedBy,
    registerFrameLifetime,
    isFrameLifetimeActive,
    retireFrameLifetime,
    purgeFrame,
    purgeBridge,
    purgeTab,
    broadcastGlobalReset,
    clearAuthorityOwnership,
    clearDeviceOwnership,
    forTabsOfOrigin,
    isCleanupConfirmed,
    closeForCleanup
  })
})()
