;(async function () {
  var has = 'hid' in navigator
  try {
    var state = await navigator.permissions.query({ name: 'hid' })
    self.postMessage({ got: 'message', hasNavigatorHid: has, state: state.state })
  } catch (e) {
    self.postMessage({ got: 'error', hasNavigatorHid: has, name: e.name, message: e.message })
  }
})()
