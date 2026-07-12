(function () {
  if (typeof browser === "undefined" && typeof chrome !== "undefined") {
    window.browser = chrome;
  }

  if (
    typeof Uint8Array.prototype.fromBase64 === "function" &&
    typeof Uint8Array.prototype.toBase64 === "function"
  )
    return;

  function b64encode(bytes) {
    const CHUNK = 0x8000;
    let s = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(s);
  }

  function b64decode(str) {
    const bin = atob(str);
    const len = bin.length;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  Object.defineProperty(Uint8Array, "fromBase64", {
    value: function fromBase64(str) {
      return b64decode(str);
    },
    writable: true,
    configurable: true,
  });

  Object.defineProperty(Uint8Array.prototype, "toBase64", {
    value: function toBase64() {
      return b64encode(this);
    },
    writable: true,
    configurable: true,
  });

  const _resourceCache = new Map();

  window.__webhid = window.__webhid || {};
  window.__webhid.fetchResource = async function (path) {
    if (_resourceCache.has(path)) return _resourceCache.get(path);
    const resp = await browser.runtime.sendMessage({
      action: "fetchResource",
      path,
    });
    if (resp?.error) throw new Error(resp.error);
    const text = resp?.text || "";
    _resourceCache.set(path, text);
    return text;
  };
})();
