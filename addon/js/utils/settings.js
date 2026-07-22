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
//   settings.on('dataPlane', cb)   // subscribe single key
//   settings.on(['k1', 'k2'], cb)  // subscribe multiple keys
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
    const _values = { ...defaults };
    const _listeners = new Map();

    function _emit(key, value) {
      const cbs = _listeners.get(key);
      if (cbs) for (const cb of cbs) cb(value, _values);
    }

    const api = {
      on(keys, callback) {
        if (!Array.isArray(keys)) keys = [keys];
        for (const k of keys) {
          if (!_listeners.has(k)) _listeners.set(k, new Set());
          _listeners.get(k).add(callback);
        }
        return () => {
          for (const k of keys) _listeners.get(k)?.delete(callback);
        };
      },
      set(values) {
        const changed = {};
        for (const [k, v] of Object.entries(values)) {
          if (k in api || k === "on" || k === "set" || k === "getAll") continue;
          if (_values[k] !== v) {
            _values[k] = v;
            changed[k] = v;
            _emit(k, v);
          }
        }
        return changed;
      },
      getAll() {
        return { ..._values };
      },
    };

    return new Proxy(api, {
      get(target, prop, receiver) {
        if (prop in target) return target[prop];
        return _values[prop];
      },
      set(target, prop, value, receiver) {
        if (prop in target) {
          target[prop] = value;
          return true;
        }
        if (_values[prop] === value) return true;
        _values[prop] = value;
        _emit(prop, value);
        return true;
      },
      has(target, prop) {
        return prop in target || prop in _values;
      },
      ownKeys(target) {
        return [...new Set([...Object.keys(target), ...Object.keys(_values)])];
      },
      getOwnPropertyDescriptor(target, prop) {
        if (prop in target)
          return Object.getOwnPropertyDescriptor(target, prop);
        if (prop in _values) {
          return {
            configurable: true,
            enumerable: true,
            value: _values[prop],
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
