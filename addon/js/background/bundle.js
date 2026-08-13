;(function () {
  /** @type {Map<string, Promise<string>>} */
  const bundleCache = new Map()

  /**
   * Fetches and caches a bundle (list name from bundle-files.js → joined
   * source string). Warm-starting the worker bundles at load time keeps the
   * first spawn cheap.
   * @param {string} name
   * @returns {Promise<string>}
   */
  function ensureBundle(name) {
    let cached = bundleCache.get(name)
    if (cached) return cached
    const files = webhid.import('bundleFiles')[name]
    cached = (async () => {
      const texts = await Promise.all(
        files.map((f) =>
          fetch(browser.runtime.getURL(f)).then((r) => {
            if (!r.ok) throw new Error('fetch ' + f + ' failed: ' + r.status)
            return r.text()
          })
        )
      )
      return texts.join(';') + ';'
    })()
    bundleCache.set(name, cached)
    return cached
  }

  ensureBundle('worker')
  ensureBundle('workerPolyfill')

  webhid.export('bgBundle', {
    ensureWorkerBundle: () => ensureBundle('worker'),
    ensureWorkerPolyfillBundle: () => ensureBundle('workerPolyfill')
  })
})()
