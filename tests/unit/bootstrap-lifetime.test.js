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

function dependencies(state) {
  return {
    getReservation: (source) => state.reservations.get(source),
    setReservation: (source, value) => state.reservations.set(source, value),
    deleteReservation: (source) => state.reservations.delete(source),
    getContext: (source) => state.contexts.get(source),
    getIdentity: (_source) => state.nextIdentity,
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

test('bootstrap gate enforces one structural port per document', () => {
  const state = {
    contexts: new Map(),
    reservations: new Map(),
    accepted: [],
    rejected: [],
    destroyed: [],
    cleanup: Promise.resolve(),
    nextIdentity: identity('document-a')
  }
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

test('transition reserves the first new-document port until cleanup completes', async () => {
  let releaseCleanup
  const cleanup = new Promise((resolve) => {
    releaseCleanup = resolve
  })
  const state = {
    contexts: new Map(),
    reservations: new Map(),
    accepted: [],
    rejected: [],
    destroyed: [],
    cleanup,
    nextIdentity: identity('document-b')
  }
  const source = {}
  const oldPort = port()
  const oldContext = {
    port: oldPort,
    source,
    frameId: 7,
    documentId: 'document-a',
    destroyed: false
  }
  state.contexts.set(source, oldContext)
  const gate = loadGate(dependencies(state))
  const reserved = port()
  gate({ data: null, ports: [reserved], source, origin: 'https://page.test' })
  const duplicate = port()
  gate({ data: null, ports: [duplicate], source, origin: 'https://page.test' })

  assert.equal(duplicate.closed, true)
  assert.deepEqual(state.accepted, [])
  assert.deepEqual(state.destroyed, [oldContext])
  assert.equal(state.reservations.get(source).port, reserved)
  assert.equal(state.contexts.get(source), oldContext)

  oldContext.destroyed = true
  releaseCleanup()
  await cleanup
  await Promise.resolve()

  assert.deepEqual(state.accepted, [reserved])
  assert.equal(state.reservations.has(source), false)
  assert.equal(state.contexts.get(source).port, reserved)
  assert.equal(duplicate.closed, true)
})
