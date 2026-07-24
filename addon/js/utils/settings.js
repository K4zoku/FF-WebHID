// Settings module: defaults + Proxy-based observer store.
//
// Loaded by every context (background, content scripts, workers, popup,
// settings page). Exports:
//   __webhid.export('GLOBAL_DEFAULTS', ...)
//   __webhid.export('createSettingsStore', ...)
//
// Store usage:
//   const settings = __webhid.import('createSettingsStore')(__webhid.import('GLOBAL_DEFAULTS'));
//   settings.dataPlane             // read
//   settings.dataPlane = 'ws'      // write (fires listeners)
//   settings.set({ dataPlane: 'ws' })  // bulk write, returns changed keys
//   settings.on('dataPlane', callback)   // subscribe single key
//   settings.on(['k1', 'k2'], callback)  // subscribe multiple keys
//   settings.getAll()              // snapshot all values
//
// Listeners fire ONLY when a value actually changes (=== comparison).

(function () {
  const webhid = globalThis.webhid;
  const GLOBAL_DEFAULTS = {
    fireAndForget: true,
    dataPlane: "ws",
    logLevel: 1,
    daemonAsNmHost: false,
    devicePickerMode: "modal",
  };

  function createSettingsStore(defaults) {
    const values = { ...defaults };
    const listeners = new Map();

    function emit(key, value) {
      const callbacks = listeners.get(key);
      if (callbacks) for (const callback of callbacks) callback(value, values);
    }

    const api = {
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
      getAll() {
        return { ...values };
      },
    };

    return new Proxy(api, {
      get(target, prop, receiver) {
        if (prop in target) return target[prop];
        return values[prop];
      },
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
      has(target, prop) {
        return prop in target || prop in values;
      },
      ownKeys(target) {
        return [...new Set([...Object.keys(target), ...Object.keys(values)])];
      },
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
