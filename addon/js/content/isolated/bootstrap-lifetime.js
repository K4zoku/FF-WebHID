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
      accepted,
      destroy,
      reject,
      createChallenge,
      schedule,
      cancel,
      probeTimeoutMs
    } = deps

    function closeCandidate(candidate) {
      if (candidate.closed) return
      candidate.closed = true
      if (candidate.deadlineHandle != null) cancel(candidate.deadlineHandle)
      candidate.deadlineHandle = null
      candidate.port.onmessage = null
      reject(candidate.port)
    }

    function closeCandidates(transition) {
      for (const candidate of transition.candidates) closeCandidate(candidate)
      transition.candidates.length = 0
    }

    function failTransition(source, transition) {
      if (transition.failed) return
      transition.failed = true
      closeCandidates(transition)
      if (getReservation(source) === transition) deleteReservation(source)
    }

    function tryPromote(source, transition) {
      if (transition.failed || getReservation(source) !== transition) return
      while (transition.candidates.length > 0) {
        const head = transition.candidates[0]
        if (head.expired) {
          transition.candidates.shift()
          closeCandidate(head)
          continue
        }
        if (!head.live || !transition.cleanupComplete) return
        const currentIdentity = getCurrentIdentity(source)
        if (!hasLifetime(currentIdentity)) {
          failTransition(source, transition)
          return
        }
        if (!sameLifetime(transition.targetIdentity, currentIdentity)) {
          closeCandidates(transition)
          transition.targetIdentity = currentIdentity
          return
        }
        if (!sameLifetime(head.identity, transition.targetIdentity)) {
          transition.candidates.shift()
          closeCandidate(head)
          continue
        }
        transition.candidates.shift()
        if (head.deadlineHandle != null) cancel(head.deadlineHandle)
        head.deadlineHandle = null
        head.port.onmessage = null
        let acceptedContext = null
        try {
          acceptedContext = accept(head.port, source, head.origin, head.identity)
          accepted(head.port)
          for (const candidate of transition.candidates) closeCandidate(candidate)
          transition.candidates.length = 0
          deleteReservation(source)
        } catch {
          if (acceptedContext) destroy(acceptedContext).catch(() => {})
          reject(head.port)
          failTransition(source, transition)
        }
        return
      }
    }

    function addCandidate(source, transition, port, origin, identity) {
      const candidate = {
        sequence: transition.nextSequence++,
        port,
        origin,
        identity,
        challenge: createChallenge(),
        live: false,
        expired: false,
        closed: false,
        deadlineHandle: null
      }
      transition.candidates.push(candidate)
      port.onmessage = (messageEvent) => {
        const data = messageEvent.data
        if (
          !candidate.expired &&
          data &&
          data.type === 'bootstrapProbeResponse' &&
          data.challenge === candidate.challenge
        ) {
          candidate.live = true
          if (candidate.deadlineHandle != null) cancel(candidate.deadlineHandle)
          candidate.deadlineHandle = null
          tryPromote(source, transition)
        }
      }
      if (typeof port.start === 'function') port.start()
      candidate.deadlineHandle = schedule(() => {
        if (candidate.expired || candidate.live || candidate.closed) return
        candidate.expired = true
        closeCandidate(candidate)
        tryPromote(source, transition)
      }, probeTimeoutMs)
      try {
        port.postMessage({ type: 'bootstrapProbe', challenge: candidate.challenge })
      } catch {
        candidate.expired = true
        closeCandidate(candidate)
        tryPromote(source, transition)
      }
    }

    function startTransition(source, port, origin, identity, previous) {
      const transition = {
        previous,
        targetIdentity: identity,
        cleanupComplete: previous == null,
        candidates: [],
        nextSequence: 0,
        failed: false
      }
      setReservation(source, transition)
      addCandidate(source, transition, port, origin, identity)
      if (!previous) return
      destroy(previous).then(
        () => {
          if (getReservation(source) !== transition || transition.failed) return
          transition.cleanupComplete = true
          tryPromote(source, transition)
        },
        () => failTransition(source, transition)
      )
    }

    return (event) => {
      const ports = event.ports != null ? Array.from(event.ports) : []
      if (event.data !== null || ports.length !== 1 || !event.source) {
        for (const port of ports) reject(port)
        return
      }
      const port = ports[0]
      const source = event.source
      const identity = getIdentity(source)
      if (!hasLifetime(identity)) {
        reject(port)
        return
      }
      const transition = getReservation(source)
      if (transition) {
        if (sameLifetime(transition.targetIdentity, identity)) {
          if (transition.candidates.some((candidate) => candidate.live)) {
            reject(port)
            return
          }
          addCandidate(source, transition, port, event.origin, identity)
          return
        }
        closeCandidates(transition)
        transition.targetIdentity = identity
        addCandidate(source, transition, port, event.origin, identity)
        return
      }
      const previous = getContext(source)
      if (previous && sameLifetime(previous, identity)) {
        reject(port)
        return
      }
      if (previous && (!hasLifetime(previous) || !hasLifetime(identity))) {
        reject(port)
        return
      }
      startTransition(source, port, event.origin, identity, previous || null)
    }
  }

  webhid.export('createBootstrapGate', createBootstrapGate)
})()
