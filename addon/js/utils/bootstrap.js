(function () {
  const _registry = new Map();
  const api = {
    export(name, value) {
      _registry.set(name, value);
      api[name] = value;
      return value;
    },
    import(name) {
      const v = _registry.get(name);
      if (v === undefined) throw new Error("module '" + name + "' not loaded");
      return v;
    },
  };
  globalThis.__webhid = api;
})();
