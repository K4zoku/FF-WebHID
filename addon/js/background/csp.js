;(function () {
  const webhid = globalThis.webhid

  const CSP_DIRECTIVE_NAMES = new Set([
    'default-src',
    'script-src',
    'script-src-elem',
    'script-src-attr',
    'style-src',
    'style-src-elem',
    'style-src-attr',
    'img-src',
    'connect-src',
    'worker-src',
    'child-src',
    'frame-src',
    'font-src',
    'media-src',
    'object-src',
    'manifest-src',
    'prefetch-src',
    'navigate-to',
    'form-action',
    'base-uri',
    'sandbox',
    'frame-ancestors',
    'plugin-types',
    'report-uri',
    'report-to',
    'upgrade-insecure-requests',
    'block-all-mixed-content',
    'require-sri-for',
    'trusted-types',
    'require-trusted-types-for'
  ])

  /**
   * @param {string} csp
   * @returns {boolean}
   */
  function hasUnseparatedDirective(csp) {
    return csp.split(';').some((raw) => {
      const parts = raw.trim().split(/\s+/)
      return parts.slice(1).some((token) => CSP_DIRECTIVE_NAMES.has(token.toLowerCase()))
    })
  }
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
    return (
      tokens.includes('*') ||
      tokens.includes("'self'") ||
      tokens.includes(origin) ||
      tokens.includes('http:') ||
      tokens.includes('https:')
    )
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
    const original = csp || ''
    if (hasUnseparatedDirective(original)) return { value: original, modified: false }
    const { directives } = parseDirectives(original)
    const segments = original.split(';')
    let modified = false

    /**
     * @param {string} name
     * @param {string} token
     * @returns {boolean}
     */
    function appendToDirective(name, token) {
      const index = segments.findIndex((segment) => {
        const parts = segment.trim().split(/\s+/)
        return parts[0]?.toLowerCase() === name
      })
      if (index === -1) return false
      const parts = segments[index].trim().split(/\s+/)
      if (parts.slice(1).includes(token)) return false
      segments[index] = segments[index].trim() + ' ' + token
      return true
    }

    /**
     * @param {string} name
     * @param {string} value
     * @returns {void}
     */
    function appendDirective(name, value) {
      const segment = name + (value ? ' ' + value : '')
      const trailingEmpty = segments.length > 0 && !segments[segments.length - 1].trim()
      const index = trailingEmpty ? segments.length - 1 : segments.length
      segments.splice(index, 0, segment)
    }

    if (directives['worker-src'] !== undefined) {
      if (!directives['worker-src'].split(/\s+/).includes('blob:')) {
        modified = appendToDirective('worker-src', 'blob:') || modified
      }
    } else {
      const fallback = directives['script-src'] ?? directives['default-src']
      if (fallback !== undefined) {
        appendDirective('worker-src', fallback + ' blob:')
        modified = true
      }
    }

    if (directives['connect-src'] !== undefined) {
      if (!sourceListAllowsDaemonConnects(directives['connect-src'])) {
        modified = appendToDirective('connect-src', 'ws://127.0.0.1:*') || modified
        modified = appendToDirective('connect-src', 'https://127.0.0.1:*') || modified
      }
    } else if (directives['default-src'] !== undefined) {
      appendDirective(
        'connect-src',
        directives['default-src'] + ' ws://127.0.0.1:* https://127.0.0.1:*'
      )
      modified = true
    }

    if (cspInfo.hasTrustedTypesRequire) {
      const ttList = directives['trusted-types']
      if (ttList === undefined) {
        appendDirective('trusted-types', 'webhid-worker')
        modified = true
      } else if (!ttList.split(/\s+/).includes('webhid-worker')) {
        modified = appendToDirective('trusted-types', 'webhid-worker') || modified
      }
    }

    return { value: segments.join(';'), modified }
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
      const effWorker =
        directives['worker-src'] ?? directives['script-src'] ?? directives['default-src']
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
      needsBlobFallback
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
    parseCspForWorkerSpawn
  })
})()
