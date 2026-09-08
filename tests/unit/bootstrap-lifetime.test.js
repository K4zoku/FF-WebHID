import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'

const source = readFileSync('addon/js/content/isolated/bootstrap-lifetime.js', 'utf8')
const manifest = JSON.parse(readFileSync('addon/manifest.json', 'utf8'))
const manifestV2 = JSON.parse(readFileSync('addon/manifest.v2.json', 'utf8'))
const chromiumManifest = JSON.parse(readFileSync('addon/manifest.chromium.json', 'utf8'))
const mainSource = readFileSync('addon/js/content/main/index.js', 'utf8')
const bridgeSource = readFileSync('addon/js/content/isolated/bridge.js', 'utf8')

test('bootstrap topology uses one structural DOM transfer', () => {
  assert.match(mainSource, /nativeWindowPostMessage, target, null/)
  assert.doesNotMatch(mainSource, /webhidBridgeRequest|webhidBridgeReady/)
  assert.doesNotMatch(bridgeSource, /webhidBridgeRequest|framePolicyResponse/)
  assert.equal(manifest.content_scripts.filter((entry) => entry.world === 'ISOLATED').length, 1)
  assert.equal(manifestV2.content_scripts.length, 2)
  assert.equal(
    chromiumManifest.content_scripts.filter((entry) => entry.world === 'ISOLATED').length,
    1
  )
  const isolatedEntry = manifest.content_scripts.find((entry) => entry.world === 'ISOLATED')
  assert.ok(isolatedEntry.js.includes('js/content/isolated/bootstrap-lifetime.js'))
  assert.equal(
    [
      ...manifest.content_scripts,
      ...manifestV2.content_scripts,
      ...chromiumManifest.content_scripts
    ].some((entry) => entry.js.includes('frame-identity.js')),
    false
  )
})

function loadGate(deps) {
  let createBootstrapGate
  const context = vm.createContext({
    webhid: {
      export(name, value) {
        if (name === 'createBootstrapGate') createBootstrapGate = value
      }
    }
  })
  vm.runInContext(source, context)
  return createBootstrapGate(deps)
}

function port() {
  return {
    closed: false,
    messages: [],
    onmessage: null,
    close() {
      this.closed = true
      this.onmessage = null
    },
    start() {},
    postMessage(message) {
      this.messages.push(message)
    }
  }
}

function identity(documentId) {
  return { frameId: 7, documentId }
}

function makeState(cleanup, nextDocumentId, currentDocumentId = nextDocumentId) {
  return {
    contexts: new Map(),
    reservations: new Map(),
    accepted: [],
    rejected: [],
    destroyed: [],
    timers: [],
    challengeSequence: 0,
    cleanup,
    nextIdentity: identity(nextDocumentId),
    currentIdentity: identity(currentDocumentId)
  }
}

function dependencies(state) {
  return {
    getReservation: (source) => state.reservations.get(source),
    setReservation: (source, value) => state.reservations.set(source, value),
    deleteReservation: (source) => state.reservations.delete(source),
    getContext: (source) => state.contexts.get(source),
    getIdentity: (_source) => state.nextIdentity,
    getCurrentIdentity: (_source) => state.currentIdentity,
    hasLifetime: (value) => value.frameId != null && value.documentId != null,
    sameLifetime: (context, value) =>
      context.frameId === value.frameId && context.documentId === value.documentId,
    accept: (newPort, source, origin, value) => {
      state.accepted.push(newPort)
      state.contexts.set(source, {
        port: newPort,
        source,
        origin,
        frameId: value.frameId,
        documentId: value.documentId,
        destroyed: false
      })
    },
    accepted: (newPort) => newPort.postMessage({ type: 'bootstrapAccepted' }),
    destroy: (context) => {
      state.destroyed.push(context)
      return state.cleanup
    },
    reject: (newPort) => {
      state.rejected.push(newPort)
      newPort.close()
    },
    createChallenge: () => 'challenge-' + ++state.challengeSequence,
    schedule: (callback, delay) => {
      const handle = { callback, delay, cancelled: false }
      state.timers.push(handle)
      return handle
    },
    cancel: (handle) => {
      handle.cancelled = true
    },
    probeTimeoutMs: 1000
  }
}

function bindOldContext(state, source) {
  const oldContext = {
    port: port(),
    source,
    frameId: 7,
    documentId: 'document-a',
    destroyed: false
  }
  state.contexts.set(source, oldContext)
  return oldContext
}

function respond(candidate) {
  const challenge = candidate.messages.find(
    (message) => message.type === 'bootstrapProbe'
  )?.challenge
  assert.equal(typeof challenge, 'string')
  candidate.onmessage({ data: { type: 'bootstrapProbeResponse', challenge } })
}

function fireNextDeadline(state) {
  const handle = state.timers.find((candidate) => !candidate.cancelled)
  assert.ok(handle)
  handle.callback()
}

async function finishCleanup(state, oldContext, releaseCleanup) {
  oldContext.destroyed = true
  releaseCleanup()
  await state.cleanup
  await Promise.resolve()
}

test('bootstrap gate enforces one structural port per document', () => {
  const state = makeState(Promise.resolve(), 'document-a')
  const source = {}
  const gate = loadGate(dependencies(state))
  const valid = port()
  gate({ data: null, ports: [valid], source, origin: 'https://page.test' })
  assert.deepEqual(state.accepted, [])
  respond(valid)
  assert.deepEqual(state.accepted, [valid])

  const nonNull = port()
  gate({ data: { bootstrap: true }, ports: [nonNull], source, origin: 'https://page.test' })
  const zero = port()
  gate({ data: null, ports: [], source, origin: 'https://page.test' })
  const first = port()
  const second = port()
  gate({ data: null, ports: [first, second], source, origin: 'https://page.test' })

  assert.equal(nonNull.closed, true)
  assert.equal(first.closed, true)
  assert.equal(second.closed, true)
  assert.equal(zero.closed, false)
  assert.deepEqual(state.accepted, [valid])
})
test('wrong challenge, type, and malformed responses do not go live', () => {
  const state = makeState(Promise.resolve(), 'document-a')
  const source = {}
  const gate = loadGate(dependencies(state))
  const candidate = port()
  gate({ data: null, ports: [candidate], source, origin: 'https://page.test' })
  const challenge = candidate.messages[0].challenge
  candidate.onmessage({ data: { type: 'bootstrapProbeResponse', challenge: 'wrong' } })
  candidate.onmessage({ data: { type: 'unexpected', challenge } })
  candidate.onmessage({ data: { type: 'bootstrapProbeResponse' } })
  assert.deepEqual(state.accepted, [])
  assert.equal(candidate.closed, false)
  candidate.onmessage({ data: { type: 'bootstrapProbeResponse', challenge } })
  assert.deepEqual(state.accepted, [candidate])
})

test('A to B rejects a same-lifetime duplicate and promotes B', async () => {
  let releaseCleanup
  const cleanup = new Promise((resolve) => {
    releaseCleanup = resolve
  })
  const state = makeState(cleanup, 'document-b')
  const source = {}
  const oldContext = bindOldContext(state, source)
  const gate = loadGate(dependencies(state))
  const reserved = port()
  gate({ data: null, ports: [reserved], source, origin: 'https://page.test' })
  respond(reserved)
  const duplicate = port()
  gate({ data: null, ports: [duplicate], source, origin: 'https://page.test' })

  assert.equal(duplicate.closed, true)
  assert.deepEqual(state.accepted, [])
  assert.deepEqual(state.destroyed, [oldContext])
  assert.equal(state.reservations.get(source).candidates[0].port, reserved)

  await finishCleanup(state, oldContext, releaseCleanup)
  assert.deepEqual(state.accepted, [reserved])
  assert.equal(state.reservations.has(source), false)
})

test('A to B to C keeps only C while A cleanup is pending', async () => {
  let releaseCleanup
  const cleanup = new Promise((resolve) => {
    releaseCleanup = resolve
  })
  const state = makeState(cleanup, 'document-b')
  const source = {}
  const oldContext = bindOldContext(state, source)
  const gate = loadGate(dependencies(state))
  const candidateB = port()
  gate({ data: null, ports: [candidateB], source, origin: 'https://page.test' })
  respond(candidateB)

  state.nextIdentity = identity('document-c')
  state.currentIdentity = identity('document-c')
  const candidateC = port()
  gate({ data: null, ports: [candidateC], source, origin: 'https://page.test' })
  respond(candidateC)

  assert.equal(candidateB.closed, true)
  assert.equal(candidateC.closed, false)
  assert.deepEqual(state.destroyed, [oldContext])
  assert.equal(state.reservations.get(source).candidates[0].port, candidateC)

  await finishCleanup(state, oldContext, releaseCleanup)
  assert.deepEqual(state.accepted, [candidateC])
  assert.equal(state.reservations.has(source), false)
})

test('A to B to C to D promotes only the latest candidate', async () => {
  let releaseCleanup
  const cleanup = new Promise((resolve) => {
    releaseCleanup = resolve
  })
  const state = makeState(cleanup, 'document-b')
  const source = {}
  const oldContext = bindOldContext(state, source)
  const gate = loadGate(dependencies(state))
  const candidates = [port(), port(), port()]
  gate({ data: null, ports: [candidates[0]], source, origin: 'https://page.test' })
  respond(candidates[0])
  for (const documentId of ['document-c', 'document-d']) {
    state.nextIdentity = identity(documentId)
    state.currentIdentity = identity(documentId)
    const candidate = candidates[documentId === 'document-c' ? 1 : 2]
    gate({ data: null, ports: [candidate], source, origin: 'https://page.test' })
    respond(candidate)
  }

  assert.equal(candidates[0].closed, true)
  assert.equal(candidates[1].closed, true)
  assert.equal(candidates[2].closed, false)
  assert.deepEqual(state.destroyed, [oldContext])

  await finishCleanup(state, oldContext, releaseCleanup)
  assert.deepEqual(state.accepted, [candidates[2]])
  assert.equal(state.reservations.has(source), false)
})

test('identity change before promotion rejects the stale candidate', async () => {
  let releaseCleanup
  const cleanup = new Promise((resolve) => {
    releaseCleanup = resolve
  })
  const state = makeState(cleanup, 'document-b')
  const source = {}
  const oldContext = bindOldContext(state, source)
  const gate = loadGate(dependencies(state))
  const candidateB = port()
  gate({ data: null, ports: [candidateB], source, origin: 'https://page.test' })
  respond(candidateB)
  state.currentIdentity = identity('document-c')

  await finishCleanup(state, oldContext, releaseCleanup)
  assert.equal(candidateB.closed, true)
  assert.deepEqual(state.accepted, [])
  assert.equal(state.reservations.has(source), true)
  assert.equal(state.reservations.get(source).candidates.length, 0)
})

test('stale candidate expires before a later live candidate', () => {
  const state = makeState(Promise.resolve(), 'document-c')
  const source = {}
  const gate = loadGate(dependencies(state))
  const stale = port()
  const legitimate = port()
  gate({ data: null, ports: [stale], source, origin: 'https://page.test' })
  gate({ data: null, ports: [legitimate], source, origin: 'https://page.test' })
  respond(legitimate)
  assert.deepEqual(state.accepted, [])
  fireNextDeadline(state)
  assert.deepEqual(state.accepted, [legitimate])
  assert.equal(stale.closed, true)
})
test('non-head timeout closes its port while the head is still pending', () => {
  const state = makeState(Promise.resolve(), 'document-c')
  const source = {}
  const gate = loadGate(dependencies(state))
  const head = port()
  const later = port()
  gate({ data: null, ports: [head], source, origin: 'https://page.test' })
  gate({ data: null, ports: [later], source, origin: 'https://page.test' })
  state.timers[1].callback()
  assert.equal(later.closed, true)
  assert.deepEqual(state.accepted, [])
  respond(head)
  assert.deepEqual(state.accepted, [head])
})

test('earliest live candidate wins over a faster later response', () => {
  const state = makeState(Promise.resolve(), 'document-c')
  const source = {}
  const gate = loadGate(dependencies(state))
  const legitimate = port()
  const hostile = port()
  gate({ data: null, ports: [legitimate], source, origin: 'https://page.test' })
  gate({ data: null, ports: [hostile], source, origin: 'https://page.test' })
  respond(hostile)
  assert.deepEqual(state.accepted, [])
  respond(legitimate)
  assert.deepEqual(state.accepted, [legitimate])
  assert.equal(hostile.closed, true)
})
test('stale B, legitimate C, and hostile C select legitimate C', () => {
  const state = makeState(Promise.resolve(), 'document-c')
  const source = {}
  const gate = loadGate(dependencies(state))
  const staleB = port()
  const legitimateC = port()
  const hostileC = port()
  gate({ data: null, ports: [staleB], source, origin: 'https://page.test' })
  gate({ data: null, ports: [legitimateC], source, origin: 'https://page.test' })
  gate({ data: null, ports: [hostileC], source, origin: 'https://page.test' })
  respond(hostileC)
  respond(legitimateC)
  assert.deepEqual(state.accepted, [])
  fireNextDeadline(state)
  assert.deepEqual(state.accepted, [legitimateC])
  assert.equal(staleB.closed, true)
  assert.equal(hostileC.closed, true)
})

test('same-lifetime duplicate preserves the original reserved port', () => {
  const state = makeState(new Promise(() => {}), 'document-b')
  const source = {}
  bindOldContext(state, source)
  const gate = loadGate(dependencies(state))
  const reserved = port()
  gate({ data: null, ports: [reserved], source, origin: 'https://page.test' })
  respond(reserved)
  const duplicate = port()
  gate({ data: null, ports: [duplicate], source, origin: 'https://page.test' })

  assert.equal(duplicate.closed, true)
  assert.equal(reserved.closed, false)
  assert.equal(state.reservations.get(source).candidates[0].port, reserved)
})
test('cleanup rejection closes all candidates and removes transition', async () => {
  const state = makeState(Promise.reject(new Error('cleanup failed')), 'document-b')
  const source = {}
  bindOldContext(state, source)
  const gate = loadGate(dependencies(state))
  const first = port()
  const second = port()
  gate({ data: null, ports: [first], source, origin: 'https://page.test' })
  gate({ data: null, ports: [second], source, origin: 'https://page.test' })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(first.closed, true)
  assert.equal(second.closed, true)
  assert.equal(state.reservations.has(source), false)
  assert.deepEqual(state.accepted, [])
})
