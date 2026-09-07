import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../../addon/js/background/nm.js', import.meta.url), 'utf8')

function loadNativeMessaging() {
  const exports = {}
  const ports = []
  const ownership = { cleared: 0, broadcasts: 0 }
  const context = {
    globalThis: null,
    browser: {
      runtime: {
        connectNative(name) {
          const disconnectListeners = []
          const port = {
            name,
            onMessage: { addListener() {} },
            onDisconnect: { addListener(listener) { disconnectListeners.push(listener) } },
            disconnect() {
              for (const listener of disconnectListeners) listener()
            }
          }
          ports.push({ port, disconnectListeners })
          return port
        }
      }
    },
    webhid: {
      import(name) {
        if (name === 'logger') return { debug() {}, warn() {}, error() {} }
        if (name === 'decodeDeviceCollections') return () => {}
        if (name === 'bgPacked') {
          return {
            ACT: {},
            PKG_INPUT_REPORT: 1,
            PKG_SEND_REPORT: 2,
            PKG_SEND_FEATURE_REPORT: 4,
            EVT_CONNECT: 1,
            EVT_DISCONNECT: 2,
            buildPackedSend() { return { toBase64() { return '' } } }
          }
        }
        if (name === 'bgState') return { deviceCache: [] }
        if (name === 'bgStorage') return { saveDeviceInfo() {} }
        if (name === 'bgStateOps') {
          return {
            tabsForEvent() { return null },
            broadcastGlobalReset() { ownership.broadcasts++ },
            clearAuthorityOwnership() { ownership.cleared++ },
            clearDeviceOwnership() {},
            forTabsOfOrigin() { return Promise.resolve() }
          }
        }
        if (name === 'http') return { isOk() { return true } }
        if (name === 'content-ports') return { postToContentPorts() { return new Set() } }
        throw new Error('unexpected import: ' + name)
      },
      export(name, value) {
        exports[name] = value
      }
    }
  }
  context.globalThis = context
  runInNewContext(source, context)
  return { nativeMessaging: exports.NativeMessaging, ports, ownership }
}

test('host switch retires authority once and ignores stale disconnect', async () => {
  const { nativeMessaging, ports, ownership } = loadNativeMessaging()
  await nativeMessaging.connect()
  const oldPort = ports[0]
  let pendingResult
  nativeMessaging.pending.set(1, { resolve(value) { pendingResult = value } })

  nativeMessaging.reconnectWithNewHost()

  assert.equal(nativeMessaging.port, ports[1].port)
  assert.equal(pendingResult.s, 503)
  assert.equal(ownership.cleared, 1)
  assert.equal(ownership.broadcasts, 1)

  for (const listener of oldPort.disconnectListeners) listener()
  assert.equal(nativeMessaging.port, ports[1].port)
  assert.equal(ownership.cleared, 1)
  assert.equal(ownership.broadcasts, 1)
})
