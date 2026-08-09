;(async function () {
  try {
    const devices = await navigator.hid.getDevices()
    self.postMessage({ ok: true, hasNavigatorHid: 'hid' in navigator, count: devices.length })
  } catch (e) {
    self.postMessage({ ok: false, name: e.name, message: e.message })
  }
})()
