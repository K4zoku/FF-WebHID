;(function () {
  const webhid = globalThis.webhid
  const ports = new Set()
  /** @param {object} port @returns {void} */
  function registerContentPort(port) {
    ports.add(port)
    port.onDisconnect.addListener(() => ports.delete(port))
  }
  /**
   * @param {number[]|null} tabIds
   * @param {object} message
   * @param {string} portName
   * @returns {Set<number>}
   */
  function postToContentPorts(tabIds, message, portName) {
    const targets = tabIds ? new Set(tabIds) : null
    const reached = new Set()
    for (const port of ports) {
      if (portName && port.name !== portName) continue
      const tabId = port.sender && port.sender.tab && port.sender.tab.id
      if (targets && (tabId == null || !targets.has(tabId))) continue
      try {
        port.postMessage(message)
        if (tabId != null) reached.add(tabId)
      } catch {
        ports.delete(port)
      }
    }
    return reached
  }

  webhid.export('content-ports', { registerContentPort, postToContentPorts })
})()
