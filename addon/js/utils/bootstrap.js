;(function () {
  if (typeof globalThis === 'undefined') {
    var getGlobal = function () {
      if (typeof window !== 'undefined') return window
      if (typeof self !== 'undefined') return self
      if (typeof global !== 'undefined') return global
      return (
        (function () {
          return this
        })() || {}
      )
    }
    Object.defineProperty(Object.prototype, 'globalThis', {
      get: function () {
        return getGlobal()
      },
      configurable: true,
      enumerable: false
    })
  }
  /** @type {Map<string, any>} */
  const registry = new Map()
  const api = {
    /**
     * @param {string} name
     * @param {any} value
     * @returns {any}
     */
    export(name, value) {
      registry.set(name, value)
      api[name] = value
      return value
    },
    /**
     * @param {string} name
     * @returns {any}
     */
    import(name) {
      const v = registry.get(name)
      if (v === undefined) throw new Error("module '" + name + "' not loaded")
      return v
    }
  }
  Object.defineProperty(globalThis, 'webhid', {
    value: api,
    writable: false,
    enumerable: false,
    configurable: true
  })

  // Single shared engine detection. Runs in every world (background, MAIN,
  // ISOLATED, extension pages, workers). Contexts without a browser API
  // (MAIN world, plain workers) have `browser` undefined and read false,
  // which is correct: only worlds with extension API access need to know.
  // On Chromium the shim has already aliased `browser = chrome` by now, so
  // the URL scheme is the reliable post-alias signal.
  api.export(
    'isChromium',
    typeof browser !== 'undefined' &&
      browser.runtime != null &&
      browser.runtime.getURL('').startsWith('chrome-extension://')
  )
})()
