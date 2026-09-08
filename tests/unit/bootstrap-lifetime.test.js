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
  assert.doesNotMatch(bridgeSource, /webhidBridgeRequest|webhidBridgeReady/)
  assert.doesNotMatch(bridgeSource, /webhidPolicyRequest|framePolicyResponse/)
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
  assert.match(bridgeSource, /'setFrameDelegation'/)
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
    close() {
      this.closed = true
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
    destroy: (context) => {
      state.destroyed.push(context)
      return state.cleanup
    },
    reject: (newPort) => {
      state.rejected.push(newPort)
      newPort.close()
    }
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
  const duplicate = port()
  gate({ data: null, ports: [duplicate], source, origin: 'https://page.test' })

  assert.equal(duplicate.closed, true)
  assert.deepEqual(state.accepted, [])
  assert.deepEqual(state.destroyed, [oldContext])
  assert.equal(state.reservations.get(source).port, reserved)

  await finishCleanup(state, oldContext, releaseCleanup)
  assert.deepEqual(state.accepted, [reserved])
  assert.equal(state.reservations.has(source), false)
  assert.equal(state.contexts.get(source).port, reserved)
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

  state.nextIdentity = identity('document-c')
  state.currentIdentity = identity('document-c')
  const candidateC = port()
  gate({ data: null, ports: [candidateC], source, origin: 'https://page.test' })

  assert.equal(candidateB.closed, true)
  assert.equal(candidateC.closed, false)
  assert.deepEqual(state.destroyed, [oldContext])
  assert.equal(state.reservations.get(source).port, candidateC)

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
  for (const documentId of ['document-c', 'document-d']) {
    state.nextIdentity = identity(documentId)
    state.currentIdentity = identity(documentId)
    const candidate = candidates[documentId === 'document-c' ? 1 : 2]
    gate({ data: null, ports: [candidate], source, origin: 'https://page.test' })
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
  state.currentIdentity = identity('document-c')

  await finishCleanup(state, oldContext, releaseCleanup)
  assert.equal(candidateB.closed, true)
  assert.deepEqual(state.accepted, [])
  assert.equal(state.reservations.has(source), false)
})

test('same-lifetime duplicate preserves the original reserved port', () => {
  const cleanup = new Promise(() => {})
  const state = makeState(cleanup, 'document-b')
  const source = {}
  bindOldContext(state, source)
  const gate = loadGate(dependencies(state))
  const reserved = port()
  gate({ data: null, ports: [reserved], source, origin: 'https://page.test' })
  const duplicate = port()
  gate({ data: null, ports: [duplicate], source, origin: 'https://page.test' })

  assert.equal(duplicate.closed, true)
  assert.equal(reserved.closed, false)
  assert.equal(state.reservations.get(source).port, reserved)
})
