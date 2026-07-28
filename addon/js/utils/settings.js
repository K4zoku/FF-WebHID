(function () {
  const webhid = globalThis.webhid;

  /** @type {import("../types.js").SettingsDefaults} */
  const GLOBAL_DEFAULTS = {
    dataPlane: "ws",
    logLevel: 1,
    daemonAsNmHost: false,
    devicePickerMode: "modal",
    workerPolyfillEnabled: false,
  };

  /**
   * @param {object} defaults
   * @returns {import("../types.js").SettingsStore}
   */
  function createSettingsStore(defaults) {
    /** @type {{[key: string]: any}} */
    const values = { ...defaults };
    /** @type {Map<string, Set<Function>>} */
    const listeners = new Map();

    /**
     * @param {string} key
     * @param {any} value
     * @returns {void}
     */
    function emit(key, value) {
      const callbacks = listeners.get(key);
      if (callbacks) for (const callback of callbacks) callback(value, values);
    }

    const api = {
      /**
       * @param {string|string[]} keys
       * @param {Function} callback
       * @returns {Function}
       */
      on(keys, callback) {
        if (!Array.isArray(keys)) keys = [keys];
        for (const k of keys) {
          if (!listeners.has(k)) listeners.set(k, new Set());
          listeners.get(k).add(callback);
        }
        return () => {
          for (const k of keys) {
            var cbs = listeners.get(k);
            if (cbs != null) cbs.delete(callback);
          }
        };
      },
      /**
       * @param {object} patch
       * @returns {object}
       */
      set(patch) {
        const changed = {};
        for (const [k, v] of Object.entries(patch)) {
          if (k in api || k === "on" || k === "set" || k === "getAll") continue;
          if (values[k] !== v) {
            values[k] = v;
            changed[k] = v;
            emit(k, v);
          }
        }
        return changed;
      },
      /** @returns {object} */
      getAll() {
        return { ...values };
      },
    };

    return new Proxy(api, {
      /**
       * @param {object} target
       * @param {string|symbol} prop
       * @param {object} receiver
       * @returns {any}
       */
      get(target, prop, receiver) {
        if (prop in target) return target[prop];
        return values[prop];
      },
      /**
       * @param {object} target
       * @param {string|symbol} prop
       * @param {any} value
       * @param {object} receiver
       * @returns {boolean}
       */
      set(target, prop, value, receiver) {
        if (prop in target) {
          target[prop] = value;
          return true;
        }
        if (values[prop] === value) return true;
        values[prop] = value;
        emit(prop, value);
        return true;
      },
      /**
       * @param {object} target
       * @param {string|symbol} prop
       * @returns {boolean}
       */
      has(target, prop) {
        return prop in target || prop in values;
      },
      /**
       * @param {object} target
       * @returns {string[]}
       */
      ownKeys(target) {
        return [...new Set([...Object.keys(target), ...Object.keys(values)])];
      },
      /**
       * @param {object} target
       * @param {string|symbol} prop
       * @returns {PropertyDescriptor|undefined}
       */
      getOwnPropertyDescriptor(target, prop) {
        if (prop in target)
          return Object.getOwnPropertyDescriptor(target, prop);
        if (prop in values) {
          return {
            configurable: true,
            enumerable: true,
            value: values[prop],
            writable: true,
          };
        }
        return undefined;
      },
    });
  }

  webhid.export("GLOBAL_DEFAULTS", GLOBAL_DEFAULTS);
  webhid.export("createSettingsStore", createSettingsStore);
})();
