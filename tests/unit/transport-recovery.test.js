import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const bridge = readFileSync(
  new URL('../../addon/js/content/isolated/bridge.js', import.meta.url),
  'utf8'
)
const main = readFileSync(new URL('../../addon/js/content/main/index.js', import.meta.url), 'utf8')

test('auth-failed recovery has no dangling removed-helper call', () => {
  assert.doesNotMatch(bridge, /refreshDataPlaneToken/)
  assert.match(bridge, /signalGeneration != null && currentGeneration !== signalGeneration/)
  assert.match(bridge, /worker transport auth failed/)
  assert.match(bridge, /in-page transport auth failed/)
})

test('transport failure is client-scoped and MAIN fails fast', () => {
  assert.match(bridge, /type: 'dataPlaneUnavailable'/)
  assert.match(bridge, /clientForKey\(context, clientKeyForPlaneKey\(key\)\)/)
  assert.match(main, /state\.planeUnavailable \|\| !state\.planeReady/)
  assert.match(main, /state\.dataPortGeneration !== state\.planeGeneration/)
  assert.match(main, /rejectPendingReports\(\s*state,\s*new NativeDOMException\(data\.reason/)
  const despawn = bridge.slice(bridge.indexOf('async function despawnDataPlane'))
  assert.ok(
    despawn.indexOf('notifyPlaneUnavailable') < despawn.indexOf('beginPlaneGeneration'),
    'retirement must announce unavailability before advancing the generation'
  )
})
