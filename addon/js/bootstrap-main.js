// Bootstrap for MAIN world content script.
if (typeof browser === "undefined" && typeof chrome !== "undefined") {
  browser = chrome;
}

(async function () {
  var runtime = typeof browser !== "undefined" ? browser : chrome;

  var _resourceCache = {};
  async function fetchResource(path) {
    if (_resourceCache[path]) return _resourceCache[path];
    var resp = await runtime.sendMessage({ action: "fetchResource", path: path });
    if (resp && resp.error) throw new Error(resp.error);
    var text = (resp && resp.text) || "";
    _resourceCache[path] = text;
    return text;
  }

  var files = [
    "js/utils/browser-compat.js",
    "js/utils/logger.js",
    "js/utils/device-utils.js",
    "js/utils/settings.js",
    "js/utils/http-status.js",
    "js/polyfill.js",
  ];

  var sources = await Promise.all(files.map(function (f) { return fetchResource(f); }));

  var combined = sources.join("\n").replace(
    /\(function\s*\(\s*\)\s*\{[\s\S]*?\}\)\(\);?/g,
    function (match) {
      var inner = match.replace(/^\(function\s*\(\s*\)\s*\{/, "").replace(/\}\)\(\);?\s*$/, "");
      return inner;
    }
  );

  (0, eval)(combined);
})();
