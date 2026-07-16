(function () {
  globalThis.__webhid = globalThis.__webhid || {};

  const _resourceCache = new Map();
  globalThis.__webhid.fetchResource = async function (path) {
    if (_resourceCache.has(path)) return _resourceCache.get(path);
    const resp = await browser.runtime.sendMessage({ action: "fetchResource", path });
    if (resp?.error) throw new Error(resp.error);
    const text = resp?.text || "";
    _resourceCache.set(path, text);
    return text;
  };

  const isOk = (s) => typeof s === "number" && s >= 200 && s < 300;
  const NAME = {
    200: "OK",
    201: "Created",
    204: "No Content",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    409: "Conflict",
    422: "Unprocessable Entity",
    500: "Internal Server Error",
    503: "Service Unavailable",
  };
  globalThis.__webhid.http = { isOk, name: (s) => NAME[s] || "HTTP " + s };
})();
