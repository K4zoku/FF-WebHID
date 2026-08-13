;(function () {
  if (typeof browser === 'undefined' && typeof chrome !== 'undefined') {
    globalThis.browser = chrome
  }
})()
