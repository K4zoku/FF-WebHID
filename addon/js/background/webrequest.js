;(function () {
  const webhid = globalThis.webhid
  const logger = webhid.import('logger')
  const { workerPolyfillSites, permissionsPolicy, shadowArms } = webhid.import('bgState')
  const { ensureWorkerBundle, ensureWorkerPolyfillBundle } = webhid.import('bgBundle')
  const { parseCspForWorkerSpawn, rewriteCspValue, rewriteCspForBlob, urlOrigin, frameKey, allowInlineScript } =
    webhid.import('bgCsp')
  const loadSiteSettings = webhid.import('loadSiteSettings')
  const bundleFiles = webhid.import('bundleFiles')

  const isMv2 = browser.runtime.getManifest().manifest_version === 2

  let mv2ScriptHashPromise = null
  /**
   * CSP hash token ('sha256-…') of the exact MV2 MAIN-world bundle text the
   * content-script injector injects, so strict page CSPs can allow it.
   * @returns {Promise<string|null>}
   */
  function mv2ScriptHashToken() {
    if (!mv2ScriptHashPromise) {
      mv2ScriptHashPromise = (async () => {
        const texts = await Promise.all(
          bundleFiles.mv2MainWorld.map((f) =>
            fetch(browser.runtime.getURL(f)).then((r) => r.text())
          )
        )
        const digest = await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(texts.join(';\n'))
        )
        return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`
      })().catch((e) => {
        logger.debug('mv2 script hash failed', e)
        mv2ScriptHashPromise = null
        return null
      })
    }
    return mv2ScriptHashPromise
  }

  /**
   * Maps the CSP response headers through `rewrite`, returning a new header
   * array when any value changed.
   * @param {object[]} headers
   * @param {(value: string) => string|null} rewrite
   * @returns {object[]|null}
   */
  function rewriteCspHeaders(headers, rewrite) {
    let changed = false
    const out = headers.map((h) => {
      if (h.name.toLowerCase() !== 'content-security-policy') return h
      const value = rewrite(h.value || '')
      if (value === null || value === h.value) return h
      changed = true
      return { name: h.name, value }
    })
    return changed ? out : null
  }

  /**
   * Redirect targets that continue a shadow-URL chain. Firefox keeps the same
   * requestId across a redirect chain, so the follow-up request cannot be told
   * apart by id; the onBeforeRequest listener matches it by URL instead and
   * keeps treating it as shadow. The chain is followed to the end: the browser
   * itself aborts after its own redirect limit (~20), which also bounds this
   * set.
   * @type {Set<string>}
   */
  const shadowRedirectTargets = new Set()

  /** @type {Map<number, {dest: string|null, shadow?: boolean}>} */
  const scriptDest = new Map()

  /**
   * Firefox's default Accept header for top-level document navigations, keyed
   * by the first Firefox major version that introduced each value. Source:
   * MDN "List of default Accept values" (navigation row).
   * @type {Array<[number, string]>}
   */
  const NAVIGATION_ACCEPT_BY_VERSION = [
    [132, 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'],
    [
      128,
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/png,image/svg+xml,*/*;q=0.8'
    ],
    [92, 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8']
  ]

  /** Accept header matching the current Firefox's navigation default. */
  let navigationAccept = NAVIGATION_ACCEPT_BY_VERSION[0][1]

  /**
   * Sets a request header, replacing an existing header of the same name
   * (case-insensitively) or appending a new one.
   * @param {object[]} headers
   * @param {string} name
   * @param {string} value
   * @returns {object[]}
   */
  function setRequestHeader(headers, name, value) {
    const existing = headers.find((h) => h.name.toLowerCase() === name.toLowerCase())
    if (existing) existing.value = value
    else headers.push({ name, value })
    return headers
  }

  /**
   * Strips the fragment from a URL string.
   * @param {string} u
   * @returns {string}
   */
  function stripFragment(u) {
    const i = u.indexOf('#')
    return i === -1 ? u : u.slice(0, i)
  }

  /**
   * Compares two URLs ignoring their fragment. Firefox strips fragments from
   * the worker-script request URL but keeps them in documentUrl, so a page at
   * "/page#sec" spawning `new Worker(location.href)` would otherwise never
   * match the shadow-URL check.
   * @param {string} a
   * @param {string} b
   * @returns {boolean}
   */
  function sameUrlModuloFragment(a, b) {
    return stripFragment(a) === stripFragment(b)
  }

  /**
   * Checks whether a shadow arm is pending for the request's tab+document,
   * without consuming it. Consumption happens in handleShadowUrl's onstart,
   * so page scripts whose URL merely equals the document URL never steal the
   * arm from the polyfill's data-worker spawn.
   * @param {object} details
   * @returns {boolean}
   */
  function hasShadowArm(details) {
    if (details.tabId === undefined || details.documentUrl === undefined) return false
    const key = `${details.tabId}:${stripFragment(details.documentUrl)}`
    const arm = shadowArms.get(key)
    if (!arm || Date.now() - arm.at > 3000) {
      if (arm) shadowArms.delete(key)
      return false
    }
    return true
  }

  /**
   * Consumes one shadow arm for the request's tab+document.
   * @param {object} details
   * @returns {boolean}
   */
  function consumeShadowArm(details) {
    if (details.tabId === undefined || details.documentUrl === undefined) return false
    const key = `${details.tabId}:${stripFragment(details.documentUrl)}`
    const arm = shadowArms.get(key)
    if (!arm) return false
    if (arm.count <= 1) shadowArms.delete(key)
    else shadowArms.set(key, { count: arm.count - 1, at: arm.at })
    return true
  }

  /**
   * Serves the worker bundle for the polyfill's own `new Worker(location.href)`
   * self-request (the shadow URL). When Sec-Fetch-Dest is observable and is not
   * "worker", the request is a page script whose URL merely equals the document
   * URL, and the response passes through untouched. Server redirects on the
   * shadow URL are followed to the end of the chain, with each hop treated the
   * same way.
   * @param {object} details
   * @returns {object | undefined}
   */
  function handleShadowUrl(details) {
    const record = { dest: null, shadow: true }
    scriptDest.set(details.requestId, record)
    const filter = browser.webRequest.filterResponseData(details.requestId)
    const enc = new TextEncoder()
    filter.onstart = () => {
      if (record.dest !== null && record.dest !== 'worker') {
        filter.disconnect()
        scriptDest.delete(details.requestId)
        return
      }
      consumeShadowArm(details)
      ensureWorkerBundle().then((bundle) => {
        if (bundle) filter.write(enc.encode(bundle))
        else
          filter.write(
            enc.encode("self.postMessage({ type: 'error', error: 'worker bundle not ready' });")
          )
        filter.close()
        scriptDest.delete(details.requestId)
      })
    }
    return {}
  }

  /**
   * Prefixes the opt-in worker-polyfill bundle into dedicated worker scripts
   * when `workerPolyfillEnabled` (global or per-site) is on. Destinations other
   * than a dedicated worker per Sec-Fetch-Dest (page scripts, importScripts,
   * dynamic imports, shared/service workers) are left unmodified; `dest ===
   * null` falls back to the legacy inject-everything behavior.
   * @param {object} details
   * @param {{workerPolyfillEnabled: boolean}} settings
   * @returns {object | undefined}
   */
  function handleInjection(details, settings) {
    let origin = null
    try {
      origin = new URL(details.url).origin
    } catch {
      void 0
    }
    if (!settings.workerPolyfillEnabled && (!origin || !workerPolyfillSites.has(origin))) return

    const record = { dest: null }
    scriptDest.set(details.requestId, record)
    const filter = browser.webRequest.filterResponseData(details.requestId)
    const enc = new TextEncoder()
    const dec = new TextDecoder()
    let firstChunk = true
    let injectPromise = Promise.resolve()
    filter.ondata = (event) => {
      if (!firstChunk) {
        injectPromise = injectPromise.then(() => filter.write(event.data))
        return
      }
      firstChunk = false
      injectPromise = injectPromise.then(async () => {
        const isWorkerScope = record.dest === null || record.dest === 'worker'
        const bundle = await ensureWorkerPolyfillBundle()
        if (!bundle || !isWorkerScope) {
          filter.write(event.data)
          return
        }
        const str = dec.decode(event.data, { stream: true })
        const cleaned = str.replace(/\/\/[^\n]*\n/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
        const hasUseStrict = /^\s*["']use strict["'];?\s*/.test(cleaned)
        if (hasUseStrict) {
          const p = str.indexOf('"use strict"')
          const pos = p >= 0 ? p : str.indexOf("'use strict'")
          let end = pos + 12
          if (str[end] === ';') end++
          while (end < str.length && /\s/.test(str[end])) end++
          filter.write(enc.encode(str.slice(0, end)))
          filter.write(enc.encode(bundle))
          filter.write(enc.encode(str.slice(end)))
        } else {
          filter.write(enc.encode(bundle))
          filter.write(event.data)
        }
      })
    }
    filter.onstop = () => {
      injectPromise.then(() => {
        filter.close()
        scriptDest.delete(details.requestId)
      })
    }
    filter.onerror = () => {
      scriptDest.delete(details.requestId)
      try {
        filter.close()
      } catch {
        void 0
      }
    }
    return {}
  }

  /**
   * Rewrites an in-document CSP `<meta>` tag in place when the worker spawn
   * needs a blob fallback, and records the analyzed policy for the bridge.
   * @param {object} details
   * @param {{workerSpawnMode: string}} settings
   * @returns {void}
   */
  function handleMetaCsp(details, settings) {
    const filter = browser.webRequest.filterResponseData(details.requestId)
    const enc = new TextEncoder()
    const dec = new TextDecoder()
    const rawChunks = []
    let scanText = ''
    let gaveUp = false
    let processed = false

    const origin = urlOrigin(details.url)

    const modePromise = resolveSiteSpawnMode(origin, settings)

    /** @returns {void} */
    function passthrough() {
      for (const buf of rawChunks) filter.write(buf)
      filter.disconnect()
    }

    /**
     * @param {boolean} eof
     * @returns {Promise<void>}
     */
    async function process(eof) {
      if (processed) return
      const headEnd = scanText.toLowerCase().indexOf('</head>')
      if (headEnd === -1 && !eof && !gaveUp) return
      processed = true
      const mode = await modePromise
      const scriptHashToken = isMv2 ? await mv2ScriptHashToken() : null
      const html = scanText + dec.decode()
      const end = headEnd === -1 ? html.length : headEnd
      const head = html.slice(0, end)
      const metaInfos = []
      let anyChange = false
      const rewrittenHead = head.replace(/<meta\s[^>]*>/gi, (tag) => {
        if (!/http-equiv\s*=\s*["']?\s*content-security-policy\s*["']?/i.test(tag)) return tag
        const contentMatch = tag.match(/\bcontent\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i)
        if (!contentMatch) return tag
        const quote = contentMatch[2] !== undefined ? '"' : contentMatch[3] !== undefined ? "'" : ''
        const csp = contentMatch[2] ?? contentMatch[3] ?? contentMatch[4] ?? ''
        const info = parseCspForWorkerSpawn([csp], mode, origin)
        if (!info) return tag
        metaInfos.push(info)
        let value = csp
        let changed = false
        if (mode === 'blob' && info.needsBlobFallback) {
          const { value: v, modified } = rewriteCspValue(value, info)
          if (modified) {
            value = v
            changed = true
          }
        }
        if (scriptHashToken) {
          const v = allowInlineScript(value, scriptHashToken)
          if (v !== null) {
            value = v
            changed = true
          }
        }
        if (!changed) return tag
        anyChange = true
        return tag.replace(contentMatch[0], 'content=' + (quote || '"') + value + (quote || '"'))
      })

      if (metaInfos.length) {
        const key = `csp:${frameKey(details.tabId, details.frameId, origin)}`
        browser.storage.session
          .get(key)
          .then((r) => {
            const existing = r[key]
            const merged = {
              workerSrc: metaInfos[0].workerSrc ?? existing?.workerSrc,
              connectSrc: metaInfos[0].connectSrc ?? existing?.connectSrc,
              workerSrcBlocked:
                metaInfos.some((i) => i.workerSrcBlocked) || !!existing?.workerSrcBlocked,
              connectSrcBlocked:
                metaInfos.some((i) => i.connectSrcBlocked) || !!existing?.connectSrcBlocked,
              hasTrustedTypesRequire:
                metaInfos.some((i) => i.hasTrustedTypesRequire) ||
                !!existing?.hasTrustedTypesRequire,
              shadowBlocked: metaInfos.some((i) => i.shadowBlocked) || !!existing?.shadowBlocked,
              metaShadowBlocked:
                metaInfos.some((i) => i.shadowBlocked) || !!existing?.metaShadowBlocked,
              headerShadowBlocked: !!existing?.headerShadowBlocked,
              needsBlobFallback:
                metaInfos.some((i) => i.needsBlobFallback) || !!existing?.needsBlobFallback
            }
            browser.storage.session.set({ [key]: merged }).catch(() => {})
          })
          .catch(() => {})
      }

      if (!anyChange) {
        passthrough()
        return
      }
      filter.write(enc.encode(rewrittenHead + html.slice(end)))
      filter.close()
    }

    filter.ondata = (e) => {
      rawChunks.push(e.data)
      if (processed) return
      if (scanText.length < 262144) scanText += dec.decode(e.data, { stream: true })
      else gaveUp = true
      process(false)
    }
    filter.onstop = () => {
      process(true)
    }
    filter.onerror = () => {
      try {
        filter.disconnect()
      } catch {
        return
      }
    }
  }

  /**
   * Records the resolved per-frame spawn mode, preferring the per-site
   * override.
   * @param {string} origin
   * @param {{workerSpawnMode: string}} settings
   * @returns {Promise<string>}
   */
  async function resolveSiteSpawnMode(origin, settings) {
    let mode = settings.workerSpawnMode
    if (!origin) return mode
    const site = await loadSiteSettings(origin).catch(() => ({}))
    if (site.workerSpawnMode !== undefined) {
      mode = site.workerSpawnMode
    }
    return mode
  }

  /**
   * Stores the frame's effective CSP info in session storage so the bridge can
   * pre-flight its worker spawn, rewriting the header for MV2 blob fallback.
   * @param {object} details
   * @param {{workerSpawnMode: string}} settings
   * @returns {Promise<object | undefined>}
   */
  async function storeFrameCspInfo(details, settings) {
    const cspValues = (details.responseHeaders || [])
      .filter((h) => h.name.toLowerCase() === 'content-security-policy')
      .map((h) => h.value || '')

    const origin = urlOrigin(details.url)
    const key = `csp:${frameKey(details.tabId, details.frameId, origin)}`

    const siteSpawnMode = await resolveSiteSpawnMode(origin, settings)

    const cspInfo = parseCspForWorkerSpawn(cspValues, siteSpawnMode, origin)
    if (cspInfo) cspInfo.headerShadowBlocked = cspInfo.shadowBlocked
    let modified = null
    if (isMv2 && cspValues.length) {
      const token = await mv2ScriptHashToken()
      let headers = details.responseHeaders
      if (cspInfo && cspInfo.needsBlobFallback) {
        const blob = rewriteCspForBlob(headers, cspInfo)
        if (blob) {
          headers = blob
          cspInfo.rewrittenCsp = blob
            .filter((h) => h.name.toLowerCase() === 'content-security-policy')
            .map((h) => h.value)
        }
      }
      if (token) {
        const inline = rewriteCspHeaders(headers, (value) => allowInlineScript(value, token))
        if (inline) modified = inline
      }
      if (!modified && headers !== details.responseHeaders) modified = headers
    }
    if (cspInfo) {
      browser.storage.session
        .set({ [key]: cspInfo })
        .catch((e) => logger.debug('csp session store failed', e))
    } else {
      browser.storage.session.remove(key).catch(() => {})
    }
    return modified
  }

  /**
   * @param {object} details
   * @returns {void}
   */
  function storePermissionsPolicy(details) {
    const ph = details.responseHeaders?.find(
      (h) => h.name.toLowerCase() === 'permissions-policy'
    )?.value
    if (!ph) return
    for (const raw of ph.split(',')) {
      const eq = raw.trim().indexOf('=')
      if (eq === -1) continue
      const f = raw.trim().slice(0, eq).trim().toLowerCase()
      const v = raw
        .trim()
        .slice(eq + 1)
        .trim()
      if (f !== 'hid') continue
      const parsed = v === '()' ? 'none' : v === '*' ? 'all' : v === 'self' ? 'self' : v
      const key = frameKey(details.tabId, details.frameId, urlOrigin(details.url))
      permissionsPolicy.set(key, parsed)
      logger.debug('Permissions-Policy stored: ' + key + ' hid=' + parsed)
      break
    }
  }

  /**
   * Registers all webRequest listeners used by the background page.
   * @param {{workerSpawnMode: string, workerPolyfillEnabled: boolean}} settings
   * @returns {void}
   */
  function registerWebRequestHandlers(settings) {
    browser.runtime
      .getBrowserInfo()
      .then((info) => {
        const major = Number.parseInt(info.version, 10)
        for (const [since, value] of NAVIGATION_ACCEPT_BY_VERSION) {
          if (major >= since) {
            navigationAccept = value
            break
          }
        }
      })
      .catch(() => {})

    browser.webRequest.onBeforeSendHeaders.addListener(
      (details) => {
        const record = scriptDest.get(details.requestId)
        if (!record) return
        const header = (details.requestHeaders || []).find(
          (h) => h.name.toLowerCase() === 'sec-fetch-dest'
        )
        record.dest = header && header.value ? header.value : null
        if (!record.shadow || record.dest !== 'worker') return
        const headers = details.requestHeaders || (details.requestHeaders = [])
        setRequestHeader(headers, 'Sec-Fetch-Dest', 'document')
        setRequestHeader(headers, 'Sec-Fetch-Mode', 'navigate')
        setRequestHeader(headers, 'Sec-Fetch-Site', 'none')
        setRequestHeader(headers, 'Sec-Fetch-User', '?1')
        setRequestHeader(headers, 'Accept', navigationAccept)
        return { requestHeaders: headers }
      },
      { urls: ['<all_urls>'], types: ['script'] },
      ['blocking', 'requestHeaders']
    )

    browser.webRequest.onBeforeRedirect.addListener(
      (details) => {
        const record = scriptDest.get(details.requestId)
        if (!record || !record.shadow || !details.redirectUrl) return
        if (stripFragment(details.redirectUrl) === stripFragment(details.url)) return
        scriptDest.delete(details.requestId)
        shadowRedirectTargets.add(stripFragment(details.redirectUrl))
      },
      { urls: ['<all_urls>'], types: ['script'] }
    )

    browser.webRequest.onBeforeRequest.addListener(
      (details) => {
        if (details.type !== 'script') return
        const urlKey = stripFragment(details.url)
        if (shadowRedirectTargets.has(urlKey)) {
          shadowRedirectTargets.delete(urlKey)
          return handleShadowUrl(details)
        }
        const isShadowUrl =
          details.documentUrl !== undefined &&
          sameUrlModuloFragment(details.url, details.documentUrl)
        if (isShadowUrl && hasShadowArm(details)) return handleShadowUrl(details)
        return handleInjection(details, settings)
      },
      { urls: ['<all_urls>'], types: ['script'] },
      ['blocking']
    )

    browser.webRequest.onErrorOccurred.addListener(
      (details) => {
        scriptDest.delete(details.requestId)
      },
      { urls: ['<all_urls>'], types: ['script'] }
    )

    browser.webRequest.onBeforeRequest.addListener(
      (details) => {
        if (details.type !== 'main_frame' && details.type !== 'sub_frame') return
        handleMetaCsp(details, settings)
      },
      { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame'] },
      ['blocking']
    )

    browser.webRequest.onHeadersReceived.addListener(
      (details) => {
        if (
          details.type !== 'script' ||
          details.documentUrl === undefined ||
          !sameUrlModuloFragment(details.url, details.documentUrl)
        )
          return
        const record = scriptDest.get(details.requestId)
        if (record && record.dest !== null && record.dest !== 'worker') return
        const headers = details.responseHeaders.filter(
          (h) =>
            !/^(content-security-policy|content-type|content-length|content-disposition|x-content-type-options)$/i.test(
              h.name
            )
        )
        headers.push({ name: 'Content-Type', value: 'application/javascript' })
        return { responseHeaders: headers }
      },
      { urls: ['<all_urls>'], types: ['script'] },
      ['blocking', 'responseHeaders']
    )

    browser.webRequest.onHeadersReceived.addListener(
      (details) => {
        storePermissionsPolicy(details)
        return {}
      },
      { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame'] },
      ['blocking', 'responseHeaders']
    )

    browser.webRequest.onHeadersReceived.addListener(
      async (details) => {
        if (details.type !== 'main_frame' && details.type !== 'sub_frame') return
        const modified = await storeFrameCspInfo(details, settings)
        if (modified) return { responseHeaders: modified }
      },
      { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame'] },
      ['blocking', 'responseHeaders']
    )

    browser.webRequest.onBeforeRequest.addListener(
      (details) => {
        if (details.tabId === undefined || details.frameId === undefined) return
        const prefix = `${details.tabId}:${details.frameId}:`
        for (const k of permissionsPolicy.keys()) {
          if (k.startsWith(prefix)) permissionsPolicy.delete(k)
        }
        browser.storage.session
          .get(null)
          .then((all) => {
            const keys = Object.keys(all).filter((k) => k.startsWith(`csp:${prefix}`))
            if (keys.length) browser.storage.session.remove(keys).catch(() => {})
          })
          .catch(() => {})
      },
      { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame'] }
    )
  }

  webhid.export('registerWebRequestHandlers', registerWebRequestHandlers)
  webhid.export('stripFragment', stripFragment)
})()
