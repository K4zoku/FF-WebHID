self.onmessage = (e) => {
  self.postMessage({ gotNull: e.data === null, data: e.data })
}
