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
