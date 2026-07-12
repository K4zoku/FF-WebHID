// Bootstrap for ISOLATED world content script.
// Chromium gives each content script file its own scope,
// so we fetch all sources and eval them in one shared scope.
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
    "js/utils/ws-transport.js",
    "js/device-picker.js",
    "js/bridge.js",
  ];

  var sources = await Promise.all(files.map(function (f) { return fetchResource(f); }));

  // Strip IIFE wrappers so all code shares one scope via eval
  var combined = sources.join("\n").replace(
    /\(function\s*\(\s*\)\s*\{[\s\S]*?\}\)\(\);?/g,
    function (match) {
      // Extract inner content
      var inner = match.replace(/^\(function\s*\(\s*\)\s*\{/, "").replace(/\}\)\(\);?\s*$/, "");
      return inner;
    }
  );

  // Direct eval in sloppy mode — shares caller's scope
  (0, eval)(combined);
})();
