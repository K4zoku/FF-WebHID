(function () {
  const webhid = globalThis.webhid;
  const _cache = new Map();
  webhid.export("fetchResource", async function fetchResource(path) {
    if (_cache.has(path)) return _cache.get(path);
    const resp = await browser.runtime.sendMessage({ action: "fetchResource", path });
    if (resp?.error) throw new Error(resp.error);
    const text = resp?.text || "";
    _cache.set(path, text);
    return text;
  });
})();
