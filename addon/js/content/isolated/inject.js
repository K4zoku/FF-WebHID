;(function () {
  /** @type {string[]} */
  var scripts = webhid.import('bundleFiles').mv2MainWorld

  /**
   * @param {string} path
   * @returns {Promise<{text: string}>}
   */
  var fetchScript = function (path) {
    return browser.runtime.sendMessage({
      action: 'fetchResource',
      path: path
    })
  }

  Promise.all(scripts.map(fetchScript))
    .then(function (responses) {
      var codes = responses.map(function (r) {
        return r.text
      })
      var s = document.createElement('script')
      s.textContent = codes.join(';\n')
      document.documentElement.appendChild(s)
    })
    .catch(function (e) {
      console.error('inject-main: failed to load scripts:', e)
    })
})()
