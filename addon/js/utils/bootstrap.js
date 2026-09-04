;(function () {
  const pristine = globalThis.webhidPristine
  if (!pristine) throw new Error('pristine intrinsics are not loaded')
  const { object } = pristine
  const map = pristine.types.Map
  const mapSet = map.proto.methods.set
  const mapGet = map.proto.methods.get
  const NativeError = pristine.types.Error.constructor
  const registry = map.construct([])
  const api = {
    /**
     * @param {string} name
     * @param {any} value
     * @returns {any}
     */
    export(name, value) {
      mapSet(registry, name, value)
      api[name] = value
      return value
    },
    /**
     * @param {string} name
     * @returns {any}
     */
    import(name) {
      const v = mapGet(registry, name)
      if (v === undefined) throw new NativeError("module '" + name + "' not loaded")
      return v
    }
  }
  object.defineProperty(globalThis, 'webhid', {
    value: api,
    writable: false,
    enumerable: false,
    configurable: true
  })
  object.defineProperty(globalThis, 'webhidPristine', {
    value: undefined,
    writable: false,
    enumerable: false,
    configurable: true
  })

  api.export(
    'isChromium',
    typeof browser !== 'undefined' &&
      browser.runtime != null &&
      browser.runtime.getURL('').startsWith('chrome-extension://')
  )
  api.export('pristine', pristine)
})()
