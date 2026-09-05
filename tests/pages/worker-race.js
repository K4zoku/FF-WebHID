;(async function () {
  try {
    var state = await navigator.permissions.query({ name: 'hid' })
    self.postMessage({
      got: 'message',
      hasNavigatorHid: 'hid' in navigator,
      state: state.state
    })
  } catch (e) {
    self.postMessage({
      got: 'error',
      hasNavigatorHid: 'hid' in navigator,
      name: e.name,
      message: e.message
    })
  }
})()
