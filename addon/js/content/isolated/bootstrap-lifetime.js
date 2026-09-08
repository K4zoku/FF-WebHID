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
      getCurrentIdentity,
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
      const identity = getIdentity(source)
      const reservation = getReservation(source)
      if (reservation) {
        if (
          !hasLifetime(identity) ||
          !hasLifetime(reservation.identity) ||
          sameLifetime(reservation.identity, identity)
        ) {
          reject(port)
          return
        }
        reject(reservation.port)
        reservation.port = port
        reservation.identity = identity
        reservation.origin = event.origin
        reservation.failed = false
        return
      }
      const previous = getContext(source)
      if (!previous) {
        accept(port, source, event.origin, identity)
        return
      }
      if (sameLifetime(previous, identity) || !hasLifetime(previous) || !hasLifetime(identity)) {
        reject(port)
        return
      }
      const transition = {
        previous,
        identity,
        port,
        origin: event.origin,
        failed: false
      }
      setReservation(source, transition)
      const rejectTransition = () => {
        transition.failed = true
        reject(transition.port)
        deleteReservation(source)
      }
      destroy(previous).then(
        () => {
          const current = getReservation(source)
          if (current !== transition || transition.failed) return
          if (!previous.destroyed) {
            rejectTransition()
            return
          }
          const browserIdentity = getCurrentIdentity(source)
          if (!hasLifetime(browserIdentity) || !sameLifetime(transition.identity, browserIdentity)) {
            rejectTransition()
            return
          }
          try {
            accept(transition.port, source, transition.origin, transition.identity)
            deleteReservation(source)
          } catch {
            rejectTransition()
          }
        },
        () => {
          if (getReservation(source) === transition) rejectTransition()
        }
      )
    }
  }

  webhid.export('createBootstrapGate', createBootstrapGate)
})()
