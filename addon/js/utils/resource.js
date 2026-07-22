(function () {
  const webhid = globalThis.webhid;
  const cache = new Map();
  webhid.export("fetchResource", async function fetchResource(path) {
    if (cache.has(path)) return cache.get(path);
    const resp = await browser.runtime.sendMessage({ action: "fetchResource", path });
    if (resp?.error) throw new Error(resp.error);
    const text = resp?.text || "";
    cache.set(path, text);
    return text;
  });
})();
