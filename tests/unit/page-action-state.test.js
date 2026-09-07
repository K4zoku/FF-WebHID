import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../../addon/js/background/state.js', import.meta.url), 'utf8')

function deferred() {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function loadState() {
  const events = []
  const hide = deferred()
  const browser = {
    pageAction: {
      hide: async (tabId) => {
        events.push(['hide', tabId])
        await hide.promise
      },
      show: async (tabId) => {
        events.push(['show', tabId])
      }
    },
    tabs: {
      query: async () => [{ id: 7 }]
    }
  }
  let exported
  const context = {
    browser,
    globalThis: null,
    webhid: {
      export(_name, value) {
        exported = value
      }
    }
  }
  context.globalThis = context
  runInNewContext(source, context)
  return { state: exported, events, hide }
}

test('pending page-action picker wins over an in-flight global hide', async () => {
  const { state, events, hide } = loadState()
  const tabId = 7
  state.pageActionVisibility.usedTabs.add(tabId)

  const hiding = state.pageActionVisibility.setHidden(true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(events.length, 1)
  assert.equal(events[0][0], 'hide')
  assert.equal(events[0][1], tabId)

  state.pendingPicker.set(tabId, { mode: 'pageAction' })
  const showing = state.pageActionVisibility.reconcile(tabId)
  hide.resolve()
  await Promise.all([hiding, showing])

  assert.ok(events.length >= 2)
  assert.equal(events.at(-1)[0], 'show')
  assert.equal(events.at(-1)[1], tabId)
  state.pendingPicker.delete(tabId)
  await state.pageActionVisibility.reconcile(tabId)
  assert.equal(events.at(-1)[0], 'hide')
  assert.equal(events.at(-1)[1], tabId)
})
