;(function () {
  /** @type {string[]} */
  var scripts = webhid.import('bundleFiles').mv2MainWorld
  var codes = []
  for (var i = 0; i < scripts.length; i++) {
    var xhr = new XMLHttpRequest()
    xhr.open('GET', browser.runtime.getURL(scripts[i]), false)
    try {
      xhr.send()
    } catch (e) {
      console.error('inject-main: failed to load', scripts[i], e)
      return
    }
    if (xhr.status !== 200) {
      console.error('inject-main: failed to load', scripts[i], xhr.status)
      return
    }
    codes.push(xhr.responseText)
  }
  var s = document.createElement('script')
  s.textContent = codes.join(';\n')
  document.documentElement.appendChild(s)
})()
