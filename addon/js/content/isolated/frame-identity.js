;(function () {
  'use strict'

  const parentWindow = window.parent
  window.addEventListener('message', (event) => {
    const data = event.data
    if (!data || data.type !== 'webhidFrameContext' || event.source !== parentWindow) return
    if (typeof data.frameKey !== 'string' || !data.frameKey) return
    browser.runtime.sendMessage({ action: 'registerFrameContext', frameKey: data.frameKey }).catch(() => {})
  })
})()
