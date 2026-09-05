import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../../addon/js/background/state_ops.js', import.meta.url), 'utf8')

function loadStateOps() {
  let exported
  const deviceTabMap = new Map()
  const deviceSessions = new Map()
  const frameLifetimes = new Map()
  const orphanCleanup = new Map()
  const context = {
    globalThis: null,
    browser: { tabs: { query: async () => [] } },
    webhid: {
      import(name) {
        if (name === 'logger') return { debug() {}, warn() {}, error() {} }
        if (name === 'bgState')
          return { deviceTabMap, deviceSessions, frameLifetimes, orphanCleanup }
        throw new Error('unexpected import: ' + name)
      },
      export(_name, value) {
        exported = value
      }
    }
  }
  context.globalThis = context
  runInNewContext(source, context)
  return { ops: exported, deviceTabMap, deviceSessions, orphanCleanup }
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
}

test('tab cleanup preserves sibling sessions and retains failed closes', async () => {
  const { ops, deviceTabMap, deviceSessions, orphanCleanup } = loadStateOps()
  deviceTabMap.set(7, new Map([[11, 1], [22, 1]]))
  deviceSessions.set(
    7,
    new Map([
      ['session-a', { tabId: 11, origin: 'https://a.test' }],
      ['session-b', { tabId: 22, origin: 'https://b.test' }]
    ])
  )

  ops.purgeTab(11, async () => ({ s: 503 }))
  await flush()

  assert.deepEqual([...deviceTabMap.get(7).keys()], [22])
  assert.deepEqual([...deviceSessions.get(7).keys()], ['session-b'])
  assert.deepEqual([...orphanCleanup.keys()], ['session-a'])

  ops.retryOrphanCleanup(async () => ({ s: 500 }))
  await flush()
  assert.equal(orphanCleanup.has('session-a'), true)
  assert.equal(orphanCleanup.get('session-a').attempts, 1)
})

test('cleanup classifies terminal and retryable close outcomes', async () => {
  const { ops, deviceTabMap, deviceSessions, orphanCleanup } = loadStateOps()
  deviceSessions.set(7, new Map([['session-a', { tabId: 11, origin: 'https://a.test' }]]))
  deviceTabMap.set(7, new Map([[11, 1]]))

  assert.equal(ops.isCleanupConfirmed({ s: 204 }), true)
  assert.equal(ops.isCleanupConfirmed({ s: 404 }), true)
  assert.equal(ops.isCleanupConfirmed({ s: 500 }), false)
  assert.equal(ops.isCleanupConfirmed({ s: 503 }), false)
  assert.equal(ops.isCleanupConfirmed({ s: 403 }), false)

  ops.purgeTab(11, async () => ({ s: 503 }))
  await flush()
  assert.equal(deviceSessions.has(7), false)
  assert.equal(orphanCleanup.has('session-a'), true)

  for (let i = 0; i < 6; i++) {
    ops.retryOrphanCleanup(async () => ({ s: 500 }))
    await flush()
  }
  assert.equal(orphanCleanup.has('session-a'), true)

  deviceTabMap.set(7, new Map([[11, 1]]))
  deviceSessions.set(7, new Map([['session-b', { tabId: 11, origin: 'https://a.test' }]]))
  ops.purgeTab(11, async () => ({ s: 404 }))
  await flush()
  assert.equal(deviceSessions.has(7), false)
  assert.equal(orphanCleanup.has('session-b'), false)
})

test('frame cleanup closes only the owning session', async () => {
  const { ops, deviceTabMap, deviceSessions, orphanCleanup } = loadStateOps()
  ops.registerFrameLifetime(11, 'frame-a')
  ops.registerFrameLifetime(11, 'frame-b')
  ops.registerDeviceTab(7, 11)
  ops.registerDeviceTab(7, 11)
  ops.registerDeviceSession(7, 'session-a', {
    tabId: 11,
    origin: 'https://a.test',
    frameKey: 'frame-a'
  })
  ops.registerDeviceSession(7, 'session-b', {
    tabId: 11,
    origin: 'https://b.test',
    frameKey: 'frame-b'
  })

  assert.equal(ops.isSessionOwnedBy(7, 'session-a', 'https://a.test', 11, 'frame-a'), true)
  assert.equal(ops.isSessionOwnedBy(7, 'session-a', 'https://a.test', 11, 'frame-b'), false)

  ops.purgeFrame(11, 'frame-a', async () => ({ s: 204 }))
  await flush()

  assert.equal(ops.isFrameLifetimeActive(11, 'frame-a'), false)
  assert.equal(ops.isFrameLifetimeActive(11, 'frame-b'), true)
  assert.deepEqual([...deviceSessions.get(7).keys()], ['session-b'])
  assert.equal(deviceTabMap.get(7).get(11), 1)
  assert.equal(orphanCleanup.has('session-a'), false)
})

test('frame cleanup retains failed authority without affecting siblings', async () => {
  const { ops, deviceSessions, orphanCleanup } = loadStateOps()
  ops.registerFrameLifetime(11, 'frame-a')
  ops.registerFrameLifetime(11, 'frame-b')
  ops.registerDeviceTab(7, 11)
  ops.registerDeviceTab(7, 11)
  ops.registerDeviceSession(7, 'session-a', {
    tabId: 11,
    origin: 'https://a.test',
    frameKey: 'frame-a'
  })
  ops.registerDeviceSession(7, 'session-b', {
    tabId: 11,
    origin: 'https://b.test',
    frameKey: 'frame-b'
  })

  ops.purgeFrame(11, 'frame-a', async () => ({ s: 403 }))
  await flush()

  assert.deepEqual([...deviceSessions.get(7).keys()], ['session-b'])
  assert.equal(orphanCleanup.has('session-a'), true)
  assert.equal(ops.isFrameLifetimeActive(11, 'frame-b'), true)
})

test('authority and physical resets clear derived ownership', () => {
  const { ops, deviceTabMap, deviceSessions, orphanCleanup } = loadStateOps()
  ops.registerFrameLifetime(11, 'frame-a')
  ops.registerDeviceTab(7, 11)
  ops.registerDeviceSession(7, 'session-a', {
    tabId: 11,
    origin: 'https://a.test',
    frameKey: 'frame-a'
  })
  orphanCleanup.set('old-session', { deviceId: 7, attempts: 4 })

  ops.clearDeviceOwnership(7)
  assert.equal(deviceTabMap.has(7), false)
  assert.equal(deviceSessions.has(7), false)
  assert.equal(orphanCleanup.has('old-session'), false)
  assert.equal(ops.isFrameLifetimeActive(11, 'frame-a'), true)

  ops.clearAuthorityOwnership()
  assert.equal(deviceTabMap.size, 0)
  assert.equal(deviceSessions.size, 0)
  assert.equal(orphanCleanup.size, 0)
  assert.equal(ops.isFrameLifetimeActive(11, 'frame-a'), false)
})

test('retired frame generations cannot publish late sessions', async () => {
  const { ops, deviceSessions } = loadStateOps()
  ops.registerFrameLifetime(11, 'frame-a')
  await ops.purgeFrame(11, 'frame-a', async () => ({ s: 204 }))

  assert.equal(ops.registerFrameLifetime(11, 'frame-a'), false)
  assert.equal(
    ops.registerDeviceSession(7, 'late-session', {
      tabId: 11,
      origin: 'https://a.test',
      frameKey: 'frame-a'
    }),
    false
  )
  assert.equal(deviceSessions.size, 0)
})

test('failed cleanup does not remove a replacement owner with the same token', async () => {
  const { ops, deviceSessions, orphanCleanup } = loadStateOps()
  ops.registerFrameLifetime(11, 'frame-a')
  ops.registerDeviceSession(7, 'session-a', {
    tabId: 11,
    origin: 'https://a.test',
    frameKey: 'frame-a'
  })
  const { promise: close, resolve: finishClose } = Promise.withResolvers()
  const cleanup = ops.purgeFrame(11, 'frame-a', async () => {
    await close
    return { s: 503 }
  })

  ops.registerFrameLifetime(11, 'frame-b')
  ops.registerDeviceSession(7, 'session-a', {
    tabId: 11,
    origin: 'https://b.test',
    frameKey: 'frame-b'
  })
  finishClose()
  await cleanup

  const replacement = deviceSessions.get(7).get('session-a')
  assert.equal(replacement.tabId, 11)
  assert.equal(replacement.origin, 'https://b.test')
  assert.equal(replacement.frameKey, 'frame-b')
  assert.equal(orphanCleanup.has('session-a'), true)
})

test('same-device sessions stay independent across frame lifetimes', async () => {
  const { ops, deviceTabMap, deviceSessions } = loadStateOps()
  ops.registerFrameLifetime(11, 'frame-a')
  ops.registerFrameLifetime(11, 'frame-b')
  ops.registerDeviceTab(7, 11)
  ops.registerDeviceTab(7, 11)
  ops.registerDeviceSession(7, 'session-a', {
    tabId: 11,
    origin: 'https://a.test',
    frameKey: 'frame-a'
  })
  ops.registerDeviceSession(7, 'session-b', {
    tabId: 11,
    origin: 'https://b.test',
    frameKey: 'frame-b'
  })

  await ops.purgeFrame(11, 'frame-a', async () => ({ s: 204 }))

  assert.deepEqual([...deviceSessions.get(7).keys()], ['session-b'])
  assert.equal(deviceTabMap.get(7).get(11), 1)
  assert.equal(ops.isFrameLifetimeActive(11, 'frame-b'), true)
})

test('physical ownership reset removes every session for one device', () => {
  const { ops, deviceTabMap, deviceSessions, orphanCleanup } = loadStateOps()
  ops.registerFrameLifetime(11, 'frame-a')
  ops.registerFrameLifetime(11, 'frame-b')
  ops.registerDeviceTab(7, 11)
  ops.registerDeviceTab(7, 11)
  ops.registerDeviceSession(7, 'session-a', {
    tabId: 11,
    origin: 'https://a.test',
    frameKey: 'frame-a'
  })
  ops.registerDeviceSession(7, 'session-b', {
    tabId: 11,
    origin: 'https://b.test',
    frameKey: 'frame-b'
  })
  orphanCleanup.set('session-a', { deviceId: 7, attempts: 2 })

  ops.clearDeviceOwnership(7)

  assert.equal(deviceTabMap.has(7), false)
  assert.equal(deviceSessions.has(7), false)
  assert.equal(orphanCleanup.has('session-a'), false)
  assert.equal(ops.isFrameLifetimeActive(11, 'frame-a'), true)
  assert.equal(ops.isFrameLifetimeActive(11, 'frame-b'), true)
})
