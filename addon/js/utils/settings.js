;(function () {
  const webhid = globalThis.webhid
  const pristine = webhid.import('pristine')
  const { object, types } = pristine
  const NativeMap = types.Map.constructor
  const NativeSet = types.Set.constructor
  const NativeProxy = types.Proxy.constructor
  const Map = NativeMap
  const Set = NativeSet
  const Proxy = NativeProxy
  const isChromium = webhid.import('isChromium')
  const isMv2 =
    typeof browser !== 'undefined' &&
    browser.runtime != null &&
    browser.runtime.getManifest().manifest_version === 2
  const mapOps = types.Map.proto.methods
  const setOps = types.Set.proto.methods
  const arrayOps = types.Array.proto.methods
  function hardenMap(value) {
    object.defineProperties(value, {
      get: { value: (key) => mapOps.get(value, key) },
      set: { value: (key, item) => mapOps.set(value, key, item) },
      delete: { value: (key) => mapOps.delete(value, key) },
      has: { value: (key) => mapOps.has(value, key) },
      forEach: { value: (callback, receiver) => mapOps.forEach(value, callback, receiver) }
    })
    return value
  }
  function hardenSet(value) {
    object.defineProperties(value, {
      add: { value: (item) => setOps.add(value, item) },
      delete: { value: (item) => setOps.delete(value, item) },
      has: { value: (item) => setOps.has(value, item) }
    })
    return value
  }
  /** @type {import("../types.js").SettingsDefaults} */
  const GLOBAL_DEFAULTS = {
    dataPlane: types.WebTransport ? 'wt' : 'ws',
    logLevel: 1,
    daemonAsNmHost: false,
    hidePageAction: false,
    devicePickerMode: 'modal',
    workerPolyfillEnabled: false,
    workerSpawnMode: isChromium || isMv2 ? 'blob' : 'shadow',
    useWorker: true,
    allowActivationlessRequestDevice: false
  }

  /**
   * @param {object} defaults
   * @returns {import("../types.js").SettingsStore}
   */
  function createSettingsStore(defaults) {
    /** @type {{[key: string]: any}} */
    const values = { ...defaults }
    /** @type {Map<string, Set<Function>>} */
    const listeners = hardenMap(new Map())

    /**
     * @param {string} key
     * @param {any} value
     * @returns {void}
     */
    function emit(key, value) {
      const callbacks = listeners.get(key)
      if (callbacks) for (const callback of callbacks) callback(value, values)
    }

    const api = {
      /**
       * @param {string|string[]} keys
       * @param {Function} callback
       * @returns {Function}
       */
      on(keys, callback) {
        if (!Array.isArray(keys)) keys = [keys]
        for (const k of keys) {
          if (!listeners.has(k)) listeners.set(k, hardenSet(new Set()))
          listeners.get(k).add(callback)
        }
        return () => {
          for (const k of keys) {
            var cbs = listeners.get(k)
            if (cbs != null) cbs.delete(callback)
          }
        }
      },
      /**
       * @param {object} patch
       * @returns {object}
       */
      set(patch) {
        const changed = {}
        for (const [k, v] of object.entries(patch)) {
          if (k in api || k === 'on' || k === 'set' || k === 'getAll') continue
          if (values[k] !== v) {
            values[k] = v
            changed[k] = v
            emit(k, v)
          }
        }
        return changed
      },
      /** @returns {object} */
      getAll() {
        return { ...values }
      }
    }

    return new Proxy(api, {
      /**
       * @param {object} target
       * @param {string|symbol} prop
       * @param {object} receiver
       * @returns {any}
       */
      get(target, prop) {
        if (prop in target) return target[prop]
        return values[prop]
      },
      /**
       * @param {object} target
       * @param {string|symbol} prop
       * @param {any} value
       * @param {object} receiver
       * @returns {boolean}
       */
      set(target, prop, value) {
        if (prop in target) {
          target[prop] = value
          return true
        }
        if (values[prop] === value) return true
        values[prop] = value
        emit(prop, value)
        return true
      },
      /**
       * @param {object} target
       * @param {string|symbol} prop
       * @returns {boolean}
       */
      has(target, prop) {
        return prop in target || prop in values
      },
      /**
       * @param {object} target
       * @returns {string[]}
       */
      ownKeys(target) {
        const keys = []
        const append = (source) => {
          for (let i = 0; i < source.length; i++) {
            const key = source[i]
            if (!arrayOps.includes(keys, key)) keys[keys.length] = key
          }
        }
        append(object.keys(target))
        append(object.keys(values))
        return keys
      },
      /**
       * @param {object} target
       * @param {string|symbol} prop
       * @returns {PropertyDescriptor|undefined}
       */
      getOwnPropertyDescriptor(target, prop) {
        if (prop in target) return object.getOwnPropertyDescriptor(target, prop)
        if (prop in values) {
          return {
            configurable: true,
            enumerable: true,
            value: values[prop],
            writable: true
          }
        }
        return undefined
      }
    })
  }

  webhid.export('GLOBAL_DEFAULTS', GLOBAL_DEFAULTS)
  webhid.export('createSettingsStore', createSettingsStore)

  const SETTING_NAMES = object.keys(GLOBAL_DEFAULTS)

  /**
   * Settings that can be overridden per site, except global-only settings.
   */
  const SITE_SETTING_NAMES = SETTING_NAMES.filter(
    (n) => n !== 'daemonAsNmHost' && n !== 'hidePageAction'
  )

  /**
   * Builds the storage key for a global setting.
   * @param {string} name
   * @returns {string}
   */
  function globalSettingKey(name) {
    return `settings :: ${name}`
  }

  /**
   * Builds the storage key for a site-specific setting.
   * @param {string} origin
   * @param {string} name
   * @returns {string}
   */
  function siteSettingKey(origin, name) {
    return `settings :: ${origin} :: ${name}`
  }

  /**
   * Parses a settings storage key into scope, origin, and name components.
   * @param {string} key
   * @returns {object|null}
   */
  function parseSettingsKey(key) {
    const parts = key.split(' :: ')
    if (parts[0] !== 'settings') return null
    if (parts.length === 2) return { scope: 'global', name: parts[1] }
    if (parts.length === 3) return { scope: 'site', origin: parts[1], name: parts[2] }
    return null
  }

  /**
   * Loads all global settings from storage, applying defaults for missing keys.
   * @returns {Promise<object>}
   */
  async function loadGlobalSettings() {
    const keys = SETTING_NAMES.map((n) => globalSettingKey(n))
    const raw = await browser.storage.local.get(keys)
    const result = {}
    for (const name of SETTING_NAMES) {
      const k = globalSettingKey(name)
      result[name] = k in raw ? raw[k] : GLOBAL_DEFAULTS[name]
    }
    return result
  }

  /**
   * Loads site-specific settings for the given origin from storage.
   * @param {string} origin
   * @returns {Promise<object>}
   */
  async function loadSiteSettings(origin) {
    const keys = SITE_SETTING_NAMES.map((n) => siteSettingKey(origin, n))
    const raw = await browser.storage.local.get(keys)
    const result = {}
    for (const name of SITE_SETTING_NAMES) {
      const k = siteSettingKey(origin, name)
      if (k in raw) result[name] = raw[k]
    }
    return result
  }

  /**
   * Loads global settings overlaid with the site's overrides for `origin`.
   * @param {string} origin
   * @returns {Promise<object>}
   */
  async function loadEffectiveSettings(origin) {
    const global = await loadGlobalSettings()
    if (!origin) return global
    const site = await loadSiteSettings(origin)
    for (const [k, v] of object.entries(site)) global[k] = v
    return global
  }

  /**
   * Saves a single global setting to storage.
   * @param {string} name
   * @param {any} value
   * @returns {Promise<void>}
   */
  async function saveGlobalSetting(name, value) {
    await browser.storage.local.set({ [globalSettingKey(name)]: value })
  }

  /**
   * Saves a single site-specific setting to storage.
   * @param {string} origin
   * @param {string} name
   * @param {any} value
   * @returns {Promise<void>}
   */
  async function saveSiteSetting(origin, name, value) {
    await browser.storage.local.set({ [siteSettingKey(origin, name)]: value })
  }

  webhid.export('SETTING_NAMES', SETTING_NAMES)
  webhid.export('globalSettingKey', globalSettingKey)
  webhid.export('siteSettingKey', siteSettingKey)
  webhid.export('parseSettingsKey', parseSettingsKey)
  webhid.export('loadGlobalSettings', loadGlobalSettings)
  webhid.export('loadSiteSettings', loadSiteSettings)
  webhid.export('loadEffectiveSettings', loadEffectiveSettings)
  webhid.export('saveGlobalSetting', saveGlobalSetting)
  webhid.export('saveSiteSetting', saveSiteSetting)
})()
