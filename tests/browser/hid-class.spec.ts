import { test, expect } from '../helpers/browser.js'
import { navigateToPolicyCheck } from '../helpers/browser-utils.js'

test.describe('HID class and navigator.hid', () => {
  test.beforeEach(async ({ sharedPage, pageUrl }) => {
    await navigateToPolicyCheck(sharedPage, pageUrl)
  })

  test('navigator.hid exists in secure context', async ({ sharedPage }) => {
    const exists = await sharedPage.evaluate(() => typeof navigator.hid !== 'undefined')
    expect(exists).toBe(true)
  })

  test('navigator.hid is SameObject', async ({ sharedPage }) => {
    const same = await sharedPage.evaluate(() => navigator.hid === navigator.hid)
    expect(same).toBe(true)
  })

  test('navigator.hid instanceof HID', async ({ sharedPage }) => {
    const result = await sharedPage.evaluate(() => navigator.hid instanceof HID)
    expect(result).toBe(true)
  })

  test('navigator.hid instanceof EventTarget', async ({ sharedPage }) => {
    const result = await sharedPage.evaluate(() => navigator.hid instanceof EventTarget)
    expect(result).toBe(true)
  })

  test('navigator.hid.toString() returns [object HID]', async ({ sharedPage }) => {
    const str = await sharedPage.evaluate(() =>
      (navigator.hid as { toString(): string }).toString()
    )
    expect(str).toBe('[object HID]')
  })

  test('HID constructor throws TypeError (Illegal constructor)', async ({ sharedPage }) => {
    const result = await sharedPage.evaluate(() => {
      try {
        new HID()
        return { ok: true, name: '' } as const
      } catch (e: unknown) {
        return { ok: false, name: e instanceof Error ? e.name : String(e) } as const
      }
    })
    expect(result.ok).toBe(false)
    expect(result.name).toBe('TypeError')
  })

  test('onconnect and ondisconnect event handler attributes can be assigned', async ({
    sharedPage
  }) => {
    const result = await sharedPage.evaluate(() => {
      const fn = () => {}
      navigator.hid.onconnect = fn
      const a = navigator.hid.onconnect === fn
      navigator.hid.ondisconnect = fn
      const b = navigator.hid.ondisconnect === fn
      return { onconnect: a, ondisconnect: b }
    })
    expect(result.onconnect).toBe(true)
    expect(result.ondisconnect).toBe(true)
  })

  test('EventTarget addEventListener/removeEventListener works on navigator.hid', async ({
    sharedPage
  }) => {
    const result = await sharedPage.evaluate(() => {
      let called = false
      const handler = () => {
        called = true
      }
      navigator.hid.addEventListener('connect', handler)
      navigator.hid.dispatchEvent(new CustomEvent('connect'))
      navigator.hid.removeEventListener('connect', handler)
      return called
    })
    expect(result).toBe(true)
  })
})
