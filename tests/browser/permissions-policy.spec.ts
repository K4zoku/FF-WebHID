import { test, expect } from '../helpers/browser.js'
import { waitForPermResult } from '../helpers/browser-utils.js'
import type { Page, Frame } from '@playwright/test'

test.describe('Permissions Policy', () => {
  test.describe.configure({ mode: 'parallel' })

  test('B33: no header allows same-origin', async ({ page, pageUrl }) => {
    await page.goto(pageUrl('/policy-check'), { waitUntil: 'domcontentloaded', timeout: 15000 })
    const r = await waitForPermResult(page)
    expect(r).not.toBeNull()
    expect(r!.isTop).toBe(true)
    expect(r!.isCrossOrigin).toBe(false)
    expect(r!.queryHid).toBe('granted')
    expect(r!.hidUndefined).toBe(false)
  })

  test('B1/B3: hid=() blocks hid', async ({ page, pageUrl }) => {
    await page.goto(pageUrl('/policy-check-blocked'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    const r = await waitForPermResult(page)
    expect(r).not.toBeNull()
    expect(r!.queryHid).toBe('denied')
    expect(r!.hidUndefined || r!.getDevices?.ok === false).toBe(true)
  })

  test('hid=self allows same-origin', async ({ page, pageUrl }) => {
    await page.goto(pageUrl('/policy-check-allowed-self'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    const r = await waitForPermResult(page)
    expect(r).not.toBeNull()
    expect(r!.queryHid).toBe('granted')
    expect(r!.hidUndefined).toBe(false)
  })

  test('hid=* allows same-origin', async ({ page, pageUrl }) => {
    await page.goto(pageUrl('/policy-check-allowed-all'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    const r = await waitForPermResult(page)
    expect(r).not.toBeNull()
    expect(r!.queryHid).toBe('granted')
    expect(r!.hidUndefined).toBe(false)
  })

  test('navigator.permissions.query passes through non-hid features', async ({ page, pageUrl }) => {
    await page.goto(pageUrl('/policy-check'), { waitUntil: 'domcontentloaded', timeout: 15000 })
    const r = await waitForPermResult(page)
    expect(r).not.toBeNull()
    expect(r!.queryCamera).toBe('prompt')
  })
})

test('same-origin document policies stay isolated across tabs', async ({ page, pageUrl }) => {
  const sibling = await page.context().newPage()
  try {
    await page.goto(pageUrl('/policy-check'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    await sibling.goto(pageUrl('/policy-check-blocked'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    const top = await waitForPermResult(page)
    const blocked = await waitForPermResult(sibling)
    expect(top?.queryHid).toBe('granted')
    expect(blocked?.queryHid).toBe('denied')
  } finally {
    await sibling.close()
  }
})

test.describe('Cross-origin iframe', () => {
  async function waitForFrame(p: Page, urlSubstring: string, timeout = 10000) {
    await expect
      .poll(() => p.frames().some((frame: Frame) => frame.url().includes(urlSubstring)), {
        timeout
      })
      .toBe(true)
    const frame = p.frames().find((candidate: Frame) => candidate.url().includes(urlSubstring))
    if (!frame) throw new Error('Frame with URL containing "' + urlSubstring + '" not found')
    return frame
  }

  interface PermResult {
    isTop: boolean
    isCrossOrigin: boolean
    hidAllowed: boolean
    queryHid: string
    queryCamera: string
    policySource: string
    hidUndefined: boolean
    getDevices: { ok: boolean; count?: number; name?: string; message?: string }
  }

  async function readIframeResult(p: Page, urlSubstring: string) {
    const childFrame = await waitForFrame(p, urlSubstring)
    await childFrame.waitForFunction(
      () => {
        const r = (window as unknown as { tests?: { results?: Record<string, unknown> } }).tests
          ?.results?.perm
        return r !== null && typeof r === 'object'
      },
      { timeout: 10000 }
    )
    const raw = await childFrame.evaluate<PermResult | null>(() => {
      const r = (window as unknown as { tests?: { results?: Record<string, unknown> } }).tests
        ?.results?.perm
      return r && typeof r === 'object' ? (r as PermResult) : null
    })
    return raw
  }
  async function readFrameResult(frame: Frame) {
    await expect
      .poll(
        () =>
          frame
            .evaluate(() => {
              const pageState = window as unknown as {
                tests?: { results?: Record<string, unknown> }
              }
              const result = pageState.tests?.results?.perm
              return result && typeof result === 'object' ? result : null
            })
            .catch(() => null),
        { timeout: 10000 }
      )
      .not.toBeNull()
    return frame.evaluate<PermResult | null>(() => {
      const pageState = window as unknown as {
        tests?: { results?: Record<string, unknown> }
      }
      const result = pageState.tests?.results?.perm
      return result && typeof result === 'object' ? (result as PermResult) : null
    })
  }
  async function frameWithId(p: Page, id: string, urlSubstring: string) {
    await expect
      .poll(
        async () => {
          for (const frame of p.frames()) {
            if (!frame.url().includes(urlSubstring)) continue
            const element = await frame.frameElement().catch(() => null)
            if (element && (await element.getAttribute('id')) === id) return true
          }
          return false
        },
        { timeout: 10000 }
      )
      .toBe(true)
    for (const frame of p.frames()) {
      if (!frame.url().includes(urlSubstring)) continue
      const element = await frame.frameElement().catch(() => null)
      if (element && (await element.getAttribute('id')) === id) return frame
    }
    throw new Error('Frame #' + id + ' not found')
  }

  test.beforeAll(async ({ sharedPage, pageUrl, crossUrl }) => {
    await sharedPage.goto(pageUrl('/iframe-parent'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    await sharedPage.evaluate((crossUrl) => {
      const noAllow = document.createElement('iframe')
      noAllow.id = 'no-allow'
      noAllow.src = crossUrl + '/iframe-child-no-allow'
      document.body.appendChild(noAllow)
      const withAllow = document.createElement('iframe')
      withAllow.id = 'with-allow'
      withAllow.src = crossUrl + '/iframe-child-with-allow'
      withAllow.allow = 'hid'
      document.body.appendChild(withAllow)
    }, crossUrl(''))
  })

  test('cross-origin iframe without allow="hid" is denied', async ({ sharedPage }) => {
    const raw = await readIframeResult(sharedPage, '/iframe-child-no-allow')
    expect(raw).not.toBeNull()
    expect(raw!.isCrossOrigin).toBe(true)
    expect(raw!.queryHid).toBe('denied')
    expect(raw!.hidUndefined).toBe(false)
  })

  test('cross-origin iframe with allow="hid" is allowed', async ({ sharedPage }) => {
    const raw = await readIframeResult(sharedPage, '/iframe-child-with-allow')
    expect(raw).not.toBeNull()
    expect(raw!.isCrossOrigin).toBe(true)
    expect(raw!.queryHid).toBe('granted')
    expect(raw!.hidUndefined).toBe(false)
  })

  test('cross-origin iframe cannot forge a sibling allow="hid" src', async ({
    sharedPage,
    crossUrl
  }) => {
    await sharedPage.evaluate((crossUrl) => {
      const forge = document.createElement('iframe')
      forge.id = 'forge'
      forge.src = crossUrl + '/iframe-child-forge'
      document.body.appendChild(forge)
    }, crossUrl(''))
    const raw = await readIframeResult(sharedPage, '/iframe-child-forge')
    expect(raw).not.toBeNull()
    expect(raw!.isCrossOrigin).toBe(true)
    expect(raw!.queryHid).toBe('denied')
    expect(raw!.hidUndefined).toBe(false)
  })

  test('B2: top-level hid=() denies a delegated cross-origin child', async ({
    page,
    pageUrl,
    crossUrl
  }) => {
    // Deny dominates: an allow="hid" attribute on the iframe cannot grant
    // what an ancestor's Permissions-Policy: hid=() already denied.
    await page.goto(pageUrl('/iframe-parent-blocked'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    await page.evaluate((crossUrl) => {
      const withAllow = document.createElement('iframe')
      withAllow.id = 'with-allow'
      withAllow.src = crossUrl + '/iframe-child-with-allow'
      withAllow.allow = 'hid'
      document.body.appendChild(withAllow)
    }, crossUrl(''))
    const raw = await readIframeResult(page, '/iframe-child-with-allow')
    expect(raw).not.toBeNull()
    expect(raw!.isCrossOrigin).toBe(true)
    expect(raw!.queryHid).toBe('denied')
    expect(raw!.hidUndefined).toBe(false)
  })

  test('cross-origin iframe worker cannot bypass policy without delegation', async ({
    page,
    pageUrl,
    crossUrl,
    backgroundPage
  }) => {
    await backgroundPage.evaluate(
      (origin) =>
        browser.storage.local.set({
          [`settings :: ${origin} :: workerPolyfillEnabled`]: true
        }),
      crossUrl('')
    )
    await page.goto(pageUrl('/iframe-parent'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    await page.evaluate((crossUrl) => {
      const iframe = document.createElement('iframe')
      iframe.src = crossUrl + '/iframe-worker-policy'
      document.body.appendChild(iframe)
    }, crossUrl(''))
    const childFrame = await waitForFrame(page, '/iframe-worker-policy')
    await childFrame.waitForFunction(
      () => {
        const result = (window as unknown as { tests?: { results?: Record<string, unknown> } })
          .tests?.results?.workerPolicy
        return result !== null && typeof result === 'object'
      },
      { timeout: 15000 }
    )
    const result = await childFrame.evaluate<{
      queryHid?: string
      getDevices?: { ok: boolean; name?: string }
      error?: string
    } | null>(() => {
      const result = (window as unknown as { tests?: { results?: Record<string, unknown> } }).tests
        ?.results?.workerPolicy
      return result && typeof result === 'object' ? result : null
    })
    expect(result).not.toBeNull()
    expect(result!.error).toBeUndefined()
    expect(result!.queryHid).toBe('denied')
    expect(result!.getDevices).toEqual(
      expect.objectContaining({ ok: false, name: 'SecurityError' })
    )
  })
  test('duplicate bootstrap cannot replace the live document context', async ({
    page,
    pageUrl
  }) => {
    await page.goto(pageUrl('/policy-check'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    expect((await waitForPermResult(page))?.queryHid).toBe('granted')
    await page.evaluate(() => {
      const channel = new MessageChannel()
      window.top!.postMessage(null, '*', [channel.port2])
    })
    const state = await page.evaluate(async () => {
      const result = await navigator.permissions.query({ name: 'hid' })
      return result.state
    })
    expect(state).toBe('granted')
  })

  test('new document lifetime bootstraps after navigation', async ({ page, pageUrl }) => {
    await page.goto(pageUrl('/policy-check'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    expect((await waitForPermResult(page))?.queryHid).toBe('granted')
    await page.goto(pageUrl('/policy-check-blocked'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    expect((await waitForPermResult(page))?.queryHid).toBe('denied')
  })

  test('same URL siblings keep independent iframe delegation', async ({
    page,
    pageUrl,
    crossUrl
  }) => {
    await page.goto(pageUrl('/iframe-parent'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    await page.evaluate((src) => {
      const allowed = document.createElement('iframe')
      allowed.id = 'same-url-allowed'
      allowed.src = src
      allowed.allow = 'hid'
      document.body.appendChild(allowed)
      const denied = document.createElement('iframe')
      denied.id = 'same-url-denied'
      denied.src = src
      document.body.appendChild(denied)
    }, crossUrl('/iframe-child-no-allow'))
    await expect
      .poll(() => page.frames().filter((f) => f.url().includes('/iframe-child-no-allow')).length)
      .toBe(2)
    const allowedFrame = await frameWithId(page, 'same-url-allowed', '/iframe-child-no-allow')
    const deniedFrame = await frameWithId(page, 'same-url-denied', '/iframe-child-no-allow')
    expect((await readFrameResult(allowedFrame))?.queryHid).toBe('granted')
    expect((await readFrameResult(deniedFrame))?.queryHid).toBe('denied')
  })

  test('recreated and navigated frames do not inherit delegation', async ({
    page,
    pageUrl,
    crossUrl
  }) => {
    await page.goto(pageUrl('/iframe-parent'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    await page.evaluate((src) => {
      const frame = document.createElement('iframe')
      frame.id = 'recreated'
      frame.src = src
      frame.allow = 'hid'
      document.body.appendChild(frame)
    }, crossUrl('/iframe-child-no-allow'))
    await expect
      .poll(() => page.frames().filter((f) => f.url().includes('/iframe-child-no-allow')).length)
      .toBe(1)
    const initial = await frameWithId(page, 'recreated', '/iframe-child-no-allow')
    expect((await readFrameResult(initial))?.queryHid).toBe('granted')
    await page.evaluate((src) => {
      const frame = document.querySelector('#recreated')
      if (!(frame instanceof HTMLIFrameElement)) throw new Error('recreated frame missing')
      frame.allow = ''
      frame.src = src
    }, crossUrl('/iframe-child-no-allow?navigation=1'))
    await expect
      .poll(() => page.frames().filter((f) => f.url().includes('/iframe-child-no-allow')).length)
      .toBe(1)
    const navigated = await frameWithId(page, 'recreated', '/iframe-child-no-allow')
    expect((await readFrameResult(navigated))?.queryHid).toBe('denied')
    await page.evaluate((src) => {
      document.querySelector('#recreated')?.remove()
      const frame = document.createElement('iframe')
      frame.id = 'recreated'
      frame.src = src
      document.body.appendChild(frame)
    }, crossUrl('/iframe-child-no-allow?recreated=1'))
    await expect
      .poll(() => page.frames().filter((f) => f.url().includes('/iframe-child-no-allow')).length)
      .toBe(1)
    const recreated = await frameWithId(page, 'recreated', '/iframe-child-no-allow')
    expect((await readFrameResult(recreated))?.queryHid).toBe('denied')
  })
})
