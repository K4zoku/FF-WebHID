(function () {
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
