;(function () {
  'use strict'

  const parentWindow = window.parent
  const policyPort = browser.runtime.connect({ name: 'webhid-frame-policy' })

  policyPort.onMessage.addListener(() => {})

  window.addEventListener('message', (event) => {
    const data = event.data
    if (
      !data ||
      data.type !== 'webhidPolicyRequest' ||
      event.source !== parentWindow ||
      typeof data.requestId !== 'string' ||
      !data.requestId
    )
      return
    const marker = '/policy-'
    const markerIndex = data.requestId.indexOf(marker)
    if (markerIndex <= 0) return
    try {
      policyPort.postMessage({
        action: 'getPolicy',
        requestId: data.requestId,
        bridgeInstanceId: data.requestId.slice(0, markerIndex),
        origin: window.location.origin,
        frameAuthority: true
      })
    } catch {}
  })
})()
