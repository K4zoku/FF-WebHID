(function () {
  if (typeof globalThis === 'undefined') {
    var getGlobal = function () {
      if (typeof window !== 'undefined') return window;
      if (typeof self !== 'undefined') return self;
      if (typeof global !== 'undefined') return global;
      return Function('return this')();
    };
    Object.defineProperty(Object.prototype, 'globalThis', {
      get: function () { return getGlobal(); },
      configurable: true,
      enumerable: false,
    });
  }
  const registry = new Map();
  const api = {
    export(name, value) {
      registry.set(name, value);
      api[name] = value;
      return value;
    },
    import(name) {
      const v = registry.get(name);
      if (v === undefined) throw new Error("module '" + name + "' not loaded");
      return v;
    },
  };
  Object.defineProperty(globalThis, 'webhid', { value: api, writable: false, enumerable: false, configurable: true });
})();
