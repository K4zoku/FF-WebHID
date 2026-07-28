(function () {
  /** @type {string[]} */
  var scripts = [
    "js/utils/bootstrap.js",
    "js/utils/resource.js",
    "js/utils/http.js",
    "js/utils/logger.js",
    "js/utils/device.js",
    "js/utils/settings.js",
    "js/utils/base64.js",
    "js/content/main/index.js",
  ];

  /**
   * @param {string} path
   * @returns {Promise<{text: string}>}
   */
  var fetchScript = function (path) {
    return browser.runtime.sendMessage({
      action: "fetchResource",
      path: path,
    });
  };

  Promise.all(scripts.map(fetchScript))
    .then(function (responses) {
      var codes = responses.map(function (r) {
        return r.text;
      });
      var s = document.createElement("script");
      s.textContent = codes.join("\n");
      document.documentElement.appendChild(s);
    })
    .catch(function (e) {
      console.error("inject-main: failed to load scripts:", e);
    });
})();
