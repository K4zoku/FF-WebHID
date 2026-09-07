;(async function () {
  let queryHid
  try {
    queryHid = (await navigator.permissions.query({ name: 'hid' })).state
  } catch (error) {
    queryHid = 'ERROR: ' + error.message
  }

  let getDevices
  try {
    await navigator.hid.getDevices()
    getDevices = { ok: true }
  } catch (error) {
    getDevices = { ok: false, name: error.name, message: error.message }
  }

  self.postMessage({ queryHid, getDevices })
})()
