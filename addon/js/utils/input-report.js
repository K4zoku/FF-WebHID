;(function () {
  const webhid = globalThis.webhid

  /**
   * @param {unknown} data
   * @returns {ArrayBuffer|null}
   */
  function resolveInputReportBuffer(data) {
    if (data == null) return null
    if (Object.prototype.toString.call(data) === '[object ArrayBuffer]') return data
    if (!ArrayBuffer.isView(data)) return null

    const buffer = data.buffer
    if (
      Object.prototype.toString.call(buffer) === '[object ArrayBuffer]' &&
      data.byteOffset === 0 &&
      data.byteLength === buffer.byteLength
    ) {
      return buffer
    }

    const normalized = new Uint8Array(data.byteLength)
    normalized.set(new Uint8Array(buffer, data.byteOffset, data.byteLength))
    return normalized.buffer
  }

  /**
   * @param {Set<MessagePort>} ports
   * @param {{reportId: number, data?: unknown}} messageEvent
   * @param {{debug: (...args: any[]) => void}} logger
   * @returns {boolean}
   */
  function forwardInputReportToPorts(ports, messageEvent, logger) {
    if (!ports || ports.size === 0) return false

    const buffer = resolveInputReportBuffer(messageEvent.data)
    const message = {
      type: 'inputReport',
      reportId: messageEvent.reportId,
      data: buffer
    }

    if (ports.size === 1) {
      const port = ports.values().next().value
      try {
        port.postMessage(message, buffer ? [buffer] : [])
        return true
      } catch (e) {
        logger.debug('forward inputReport to page failed', e)
        return false
      }
    }

    const recipients = Array.from(ports)
    const copies = []
    if (buffer) {
      for (let i = 0; i < recipients.length - 1; i++) {
        copies.push(buffer.slice(0))
      }
    }

    let handled = false
    for (let i = 0; i < recipients.length; i++) {
      const transferBuffer = buffer ? (i === recipients.length - 1 ? buffer : copies[i]) : null
      try {
        recipients[i].postMessage(
          { type: 'inputReport', reportId: messageEvent.reportId, data: transferBuffer },
          transferBuffer ? [transferBuffer] : []
        )
        handled = true
      } catch (e) {
        logger.debug('forward inputReport to page failed', e)
      }
    }
    return handled
  }

  webhid.export('forwardInputReportToPorts', forwardInputReportToPorts)
})()
