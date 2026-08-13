;(function () {
  /** @type {string[]} */
  var scripts = webhid.import('bundleFiles').mv2MainWorld
  var fetchScript = webhid.import('fetchResource')

  Promise.all(scripts.map(fetchScript))
    .then(function (texts) {
      var s = document.createElement('script')
      s.textContent = texts.join(';\n')
      document.documentElement.appendChild(s)
    })
    .catch(function (e) {
      console.error('inject-main: failed to load scripts:', e)
    })
})()
