import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path) => readFileSync(path, 'utf8')
const manifest = JSON.parse(read('addon/manifest.json'))
const manifestV2 = JSON.parse(read('addon/manifest.v2.json'))
const manifestChromium = JSON.parse(read('addon/manifest.chromium.json'))
const bridge = read('addon/js/content/isolated/bridge.js')
const main = read('addon/js/content/main/index.js')
const messages = read('addon/js/background/messages.js')
const nm = read('addon/js/background/nm.js')

function isolatedEntry(value) {
  return (
    value.content_scripts.find((entry) => entry.world === 'ISOLATED') || value.content_scripts[1]
  )
}

test('every production isolated bridge runs in every frame', () => {
  assert.equal(isolatedEntry(manifest).all_frames, true)
  assert.equal(isolatedEntry(manifestV2).all_frames, true)
  assert.equal(isolatedEntry(manifestChromium).all_frames, true)
})

test('bridge is exact-frame and uses same-document capability handoff', () => {
  assert.match(bridge, /wrappedJSObject\.webhid/)
  assert.match(bridge, /wrapReflectors: true/)
  assert.doesNotMatch(bridge, /createBootstrapGate|bootstrapReservations|frameContextBySource/)
  assert.doesNotMatch(bridge, /pagePorts|pageSourceByPort|portOrigin/)
})

test('background owns endpoint registry and exact input fanout', () => {
  assert.match(messages, /frameEndpoints/)
  assert.match(messages, /postToContentPort\(req\.port/)
  assert.match(nm, /collectDeviceSessionOwners\(deviceId\)/)
  assert.match(nm, /postToContentPort\(port/)
})

test('MAIN does not bootstrap through a top WindowProxy', () => {
  assert.doesNotMatch(main, /nativeWindowPostMessage/)
  assert.doesNotMatch(main, /windowObject\.top/)
  assert.match(main, /reflect\.deleteProperty\(globalThis, 'webhid'\)/)
})
