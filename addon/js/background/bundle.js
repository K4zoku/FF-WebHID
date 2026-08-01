;(function () {
  const _logger = webhid.import('logger')

  let workerBundle = null
  let workerBundlePromise = null

  /**
   * Fetches and caches the worker bundle (worker index + utils) as a single string.
   * @returns {Promise<string>}
   */
  async function ensureWorkerBundle() {
    if (workerBundle) return workerBundle
    if (workerBundlePromise) return workerBundlePromise
    const files = [
      'js/utils/bootstrap.js',
      'js/utils/logger.js',
      'js/utils/settings.js',
      'js/utils/websocket.js',
      'js/content/isolated/worker/index.js'
    ]
    workerBundlePromise = (async () => {
      const texts = await Promise.all(
        files.map((f) =>
          fetch(browser.runtime.getURL(f)).then((r) => {
            if (!r.ok) throw new Error('fetch ' + f + ' failed: ' + r.status)
            return r.text()
          })
        )
      )
      workerBundle = texts.join('\n')
      return workerBundle
    })()
    return workerBundlePromise
  }
  ensureWorkerBundle()

  let workerPolyfillBundle = null
  let workerPolyfillBundlePromise = null

  /**
   * Fetches and caches the polyfill worker bundle (main index + utils) as a single string.
   * @returns {Promise<string>}
   */
  async function ensureWorkerPolyfillBundle() {
    if (workerPolyfillBundle) return workerPolyfillBundle
    if (workerPolyfillBundlePromise) return workerPolyfillBundlePromise
    const files = [
      'js/utils/bootstrap.js',
      'js/utils/logger.js',
      'js/utils/http.js',
      'js/utils/settings.js',
      'js/utils/device.js',
      'js/content/main/index.js'
    ]
    workerPolyfillBundlePromise = (async () => {
      const texts = await Promise.all(
        files.map((f) =>
          fetch(browser.runtime.getURL(f)).then((r) => {
            if (!r.ok) throw new Error('fetch ' + f + ' failed: ' + r.status)
            return r.text()
          })
        )
      )
      workerPolyfillBundle = texts.join('\n')
      return workerPolyfillBundle
    })()
    return workerPolyfillBundlePromise
  }
  ensureWorkerPolyfillBundle()

  webhid.export('bgBundle', { ensureWorkerBundle, ensureWorkerPolyfillBundle })
})()
