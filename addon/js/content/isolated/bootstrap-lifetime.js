;(function () {
  'use strict'

  /**
   * Creates the one-time bootstrap gate for a bridge's document contexts.
   * @param {object} deps
   * @returns {(event: MessageEvent) => void}
   */
  function createBootstrapGate(deps) {
    const {
      getReservation,
      setReservation,
      deleteReservation,
      getContext,
      getIdentity,
      hasLifetime,
      sameLifetime,
      accept,
      destroy,
      reject
    } = deps

    return (event) => {
      const ports = event.ports != null ? Array.from(event.ports) : []
      if (event.data !== null || ports.length !== 1 || !event.source) {
        for (const port of ports) reject(port)
        return
      }
      const port = ports[0]
      const source = event.source
      if (getReservation(source)) {
        reject(port)
        return
      }
      const identity = getIdentity(source)
      const previous = getContext(source)
      if (!previous) {
        accept(port, source, event.origin, identity)
        return
      }
      if (
        sameLifetime(previous, identity) ||
        !hasLifetime(previous) ||
        !hasLifetime(identity)
      ) {
        reject(port)
        return
      }
      const reservation = {
        previous,
        identity,
        port,
        origin: event.origin,
        failed: false
      }
      setReservation(source, reservation)
      const rejectReservation = () => {
        reservation.failed = true
        reject(reservation.port)
      }
      destroy(previous).then(
        () => {
          if (getReservation(source) !== reservation || reservation.failed) return
          if (!previous.destroyed) {
            rejectReservation()
            return
          }
          try {
            accept(reservation.port, source, reservation.origin, reservation.identity)
            deleteReservation(source)
          } catch {
            rejectReservation()
          }
        },
        () => {
          if (getReservation(source) === reservation) rejectReservation()
        }
      )
    }
  }

  webhid.export('createBootstrapGate', createBootstrapGate)
})()
