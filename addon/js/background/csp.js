(function () {
  const webhid = globalThis.webhid

  /**
   * @param {string} url
   * @returns {string}
   */
  function urlOrigin(url) {
    try {
      return new URL(url).origin
    } catch {
      return ''
    }
  }

  /**
   * Builds an origin-scoped cache key for a frame. The origin component makes
   * a stale entry from a previous document on the same (tab, frame) naturally
   * miss when the frame navigates to a different origin, instead of serving
   * the old origin's policy to the new document.
   * @param {number} tabId
   * @param {number} frameId
   * @param {string} origin
   * @returns {string}
   */
  function frameKey(tabId, frameId, origin) {
    return `${tabId}:${frameId}:${origin || ''}`
  }

  /**
   * @param {string} csp
   * @returns {{directives: object, order: string[]}}
   */
  function parseDirectives(csp) {
    const directives = {}
    const order = []
    for (const raw of csp.split(';')) {
      const trimmed = raw.trim()
      if (!trimmed) continue
      const parts = trimmed.split(/\s+/)
      const name = parts[0].toLowerCase()
      if (directives[name] !== undefined) continue
      directives[name] = parts.slice(1).join(' ')
      order.push(name)
    }
    return { directives, order }
  }

  /**
   * @param {string} list
   * @param {string} origin
   * @returns {boolean}
   */
  function sourceListAllowsWorker(list, origin) {
    const tokens = list.split(/\s+/)
    return tokens.includes('*') || tokens.includes("'self'") || tokens.includes(origin)
      || tokens.includes('http:') || tokens.includes('https:')
  }

  /**
   * @param {string} list
   * @returns {boolean}
   */
  function sourceListAllowsDaemonConnects(list) {
    const tokens = list.split(/\s+/)
    return (
      tokens.includes('*') ||
      tokens.includes('ws:') ||
      tokens.includes('ws://127.0.0.1:*') ||
      tokens.includes('https:') ||
      tokens.includes('https://127.0.0.1:*')
    )
  }

  /**
   * @param {string} csp
   * @param {object} cspInfo
   * @returns {{value: string, modified: boolean}}
   */
  function rewriteCspValue(csp, cspInfo) {
    const { directives, order } = parseDirectives(csp || '')
    let modified = false

    if (directives['worker-src'] !== undefined) {
      if (!directives['worker-src'].includes('blob:')) {
        directives['worker-src'] = directives['worker-src'] + ' blob:'
        modified = true
      }
    } else {
      const fallback = directives['script-src'] ?? directives['default-src']
      if (fallback !== undefined) {
        directives['worker-src'] = fallback + ' blob:'
        order.push('worker-src')
        modified = true
      }
    }

    if (directives['connect-src'] !== undefined) {
      if (!sourceListAllowsDaemonConnects(directives['connect-src'])) {
        directives['connect-src'] =
          directives['connect-src'] + ' ws://127.0.0.1:* https://127.0.0.1:*'
        modified = true
      }
    } else if (directives['default-src'] !== undefined) {
      directives['connect-src'] =
        directives['default-src'] + ' ws://127.0.0.1:* https://127.0.0.1:*'
      order.push('connect-src')
      modified = true
    }

    if (cspInfo.hasTrustedTypesRequire) {
      const ttList = directives['trusted-types']
      if (ttList === undefined) {
        directives['trusted-types'] = 'webhid-worker'
        order.push('trusted-types')
        modified = true
      } else if (!ttList.includes('webhid-worker')) {
        directives['trusted-types'] = ttList + ' webhid-worker'
        modified = true
      }
    }

    const rebuilt = order.map((name) => name + (directives[name] ? ' ' + directives[name] : '')).join('; ')
    return { value: rebuilt, modified }
  }

  /**
   * @param {Array|null} headers
   * @param {object} cspInfo
   * @returns {Array|null}
   */
  function rewriteCspForBlob(headers, cspInfo) {
    if (!headers) return null
    let modified = false
    const newHeaders = headers.map((h) => {
      if (h.name.toLowerCase() !== 'content-security-policy') return h
      const { value, modified: changed } = rewriteCspValue(h.value || '', cspInfo)
      if (changed) modified = true
      return { name: h.name, value }
    })
    return modified ? newHeaders : null
  }

  /**
   * @param {Array|null} cspValues
   * @param {string} spawnMode
   * @param {string} pageOrigin
   * @returns {object|null}
   */
  function parseCspForWorkerSpawn(cspValues, spawnMode, pageOrigin) {
    const mode = spawnMode
    if (!cspValues || cspValues.length === 0) return null
    let workerSrc
    let connectSrc
    let workerSrcBlocked = false
    let connectSrcBlocked = false
    let hasTrustedTypesRequire = false
    const trustedTypesNames = []
    for (const csp of cspValues.flatMap((v) => v.split(','))) {
      const { directives } = parseDirectives(csp)
      const effWorker = directives['worker-src'] ?? directives['script-src'] ?? directives['default-src']
      const effConnect = directives['connect-src'] ?? directives['default-src']
      if (workerSrc === undefined) workerSrc = effWorker
      if (connectSrc === undefined) connectSrc = effConnect
      if (effWorker !== undefined && !sourceListAllowsWorker(effWorker, pageOrigin)) {
        workerSrcBlocked = true
      }
      if (effConnect !== undefined && !sourceListAllowsDaemonConnects(effConnect)) {
        connectSrcBlocked = true
      }
      const tt = directives['require-trusted-types-for']
      if (tt !== undefined && tt.includes("'script'")) hasTrustedTypesRequire = true
      const ttList = directives['trusted-types']
      if (ttList !== undefined) {
        for (const token of ttList.split(/\s+/)) {
          if (token === "'none'" || token === "'allow-duplicates'") continue
          if (!trustedTypesNames.includes(token)) trustedTypesNames.push(token)
        }
      }
    }
    const shadowBlocked = workerSrcBlocked || connectSrcBlocked || hasTrustedTypesRequire
    const needsBlobFallback = mode === 'blob' || (mode === 'shadow' && shadowBlocked)
    return {
      workerSrc,
      connectSrc,
      workerSrcBlocked,
      connectSrcBlocked,
      hasTrustedTypesRequire,
      trustedTypesNames,
      shadowBlocked,
      needsBlobFallback,
    }
  }

  webhid.export('bgCsp', {
    urlOrigin,
    frameKey,
    parseDirectives,
    sourceListAllowsWorker,
    sourceListAllowsDaemonConnects,
    rewriteCspValue,
    rewriteCspForBlob,
    parseCspForWorkerSpawn,
  })
})()
