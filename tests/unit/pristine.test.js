import assert from 'node:assert/strict'
import { test } from 'node:test'

await import('../../addon/js/utils/pristine.js')
const pristine = globalThis.webhidPristine

test('captureType preserves native brands and immutable operations', () => {
  const captured = pristine.captureType(Map)
  const value = captured.construct([])
  captured.proto.methods.set(value, 'secret', 42)
  assert.equal(captured.proto.methods.get(value, 'secret'), 42)
  assert.equal(Object.isFrozen(captured.getDescriptor('get')), true)
  assert.equal(Object.isFrozen(captured.proto.methods), true)
  assert.equal(Object.prototype.toString.call(value), '[object Map]')
})

test('captureOps accepts an already captured type', () => {
  const captured = pristine.captureOps(pristine.types.Set)
  const value = captured.construct([])
  captured.proto.methods.add(value, 'value')
  assert.equal(captured.proto.methods.has(value, 'value'), true)
})
