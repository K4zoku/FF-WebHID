import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../../addon/js/background/content-ports.js', import.meta.url), 'utf8')

function loadContentPorts() {
  let exported
  const context = {
    globalThis: null,
    webhid: {
      export(_name, value) {
        exported = value
      }
    }
  }
  context.globalThis = context
  runInNewContext(source, context)
  return exported
}

function makePort(tabId) {
  const deliveries = []
  return {
    name: 'webhid-data:7',
    sender: tabId == null ? {} : { tab: { id: tabId } },
    onDisconnect: { addListener() {} },
    deliveries,
    postMessage(message) {
      deliveries.push(message)
    }
  }
}

test('explicit targets only reach matching data Ports', () => {
  const contentPorts = loadContentPorts()
  const portA = makePort(11)
  const nonmatchingPort = makePort(99)
  const tablessPort = makePort(null)
  contentPorts.registerContentPort(portA)
  contentPorts.registerContentPort(nonmatchingPort)
  contentPorts.registerContentPort(tablessPort)

  const message = { action: 'webhidDeviceEvent', event: { eventType: 'input_report' } }
  const reached = contentPorts.postToContentPorts([11, 22], message, 'webhid-data:7')

  assert.deepEqual([...reached], [11])
  assert.deepEqual(portA.deliveries, [message])
  assert.deepEqual(nonmatchingPort.deliveries, [])
  assert.deepEqual(tablessPort.deliveries, [])
  assert.deepEqual([11, 22].filter((tabId) => !reached.has(tabId)), [22])
})
