import { test, expect } from '../helpers/browser.js'

test.describe('settings scope', () => {
  test('applyMarkdown renders bold, code, and line breaks as DOM nodes', async ({
    backgroundPage
  }) => {
    const children = await backgroundPage.evaluate(() => {
      const w = globalThis.webhid as { import(name: string): unknown }
      const applyMarkdown = w.import('applyMarkdown') as (el: HTMLElement, text: string) => void
      const el = document.createElement('p')
      applyMarkdown(el, '**Bold** and `code` here\n**Next**: line')
      return Array.from(el.childNodes).map((n) => `${n.nodeName}:${n.textContent ?? ''}`)
    })
    expect(children).toEqual([
      'STRONG:Bold',
      '#text: and ',
      'CODE:code',
      '#text: here',
      'BR:',
      'STRONG:Next',
      '#text:: line'
    ])
    const literal = await backgroundPage.evaluate(() => {
      const w = globalThis.webhid as { import(name: string): unknown }
      const applyMarkdown = w.import('applyMarkdown') as (el: HTMLElement, text: string) => void
      const el = document.createElement('p')
      applyMarkdown(el, 'unmatched ** stays literal')
      return el.textContent
    })
    expect(literal).toBe('unmatched ** stays literal')
  })
  test('SITE_SETTING_NAMES excludes daemonAsNmHost; loadSiteSettings ignores site daemonAsNmHost', async ({
    backgroundPage,
    pageUrl
  }) => {
    const origin = pageUrl('').replace(/\/$/, '')
    const keys = [
      `settings :: ${origin} :: daemonAsNmHost`,
      `settings :: ${origin} :: dataPlane`,
      `settings :: ${origin} :: devicePickerMode`,
      `settings :: ${origin} :: workerSpawnMode`,
      `settings :: ${origin} :: logLevel`,
      `settings :: ${origin} :: workerPolyfillEnabled`
    ]
    await backgroundPage.evaluate(async (o) => {
      await browser.storage.local.set({
        [`settings :: ${o} :: daemonAsNmHost`]: true,
        [`settings :: ${o} :: dataPlane`]: 'nm',
        [`settings :: ${o} :: devicePickerMode`]: 'window',
        [`settings :: ${o} :: workerSpawnMode`]: 'blob',
        [`settings :: ${o} :: logLevel`]: 3,
        [`settings :: ${o} :: workerPolyfillEnabled`]: true
      })
      const w = globalThis.webhid as { import(name: string): unknown }
      const names = w.import('SITE_SETTING_NAMES') as string[]
      const site = await (
        w.import('loadSiteSettings') as (o: string) => Promise<Record<string, unknown>>
      )(o)
      ;(globalThis as { __smoke?: unknown }).__smoke = { names, site }
    }, origin)
    const { names, site } = (await backgroundPage.evaluate(
      () => (globalThis as { __smoke?: unknown }).__smoke
    )) as {
      names: string[]
      site: Record<string, unknown>
    }
    expect(names).toEqual([
      'dataPlane',
      'logLevel',
      'devicePickerMode',
      'workerPolyfillEnabled',
      'workerSpawnMode'
    ])
    expect(names).not.toContain('daemonAsNmHost')
    expect(site.daemonAsNmHost).toBeUndefined()
    expect(site.dataPlane).toBe('nm')
    expect(site.devicePickerMode).toBe('window')
    expect(site.workerSpawnMode).toBe('blob')
    expect(site.logLevel).toBe(3)
    expect(site.workerPolyfillEnabled).toBe(true)
    await backgroundPage.evaluate((k) => browser.storage.local.remove(k), keys)
  })

  test('popup renders + persists per-site devicePickerMode and workerSpawnMode; no daemonAsNmHost control', async ({
    backgroundPage,
    harnessCtx,
    pageUrl
  }) => {
    await backgroundPage.evaluate(() =>
      browser.storage.local.set({
        'settings :: devicePickerMode': 'pageAction',
        'settings :: workerSpawnMode': 'blob'
      })
    )

    const contentPage = await harnessCtx.newPage()
    await contentPage.goto(pageUrl('/worker-check'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })

    const popupUrl = await backgroundPage.evaluate(() =>
      browser.runtime.getURL('js/internal/pages/popup/index.html')
    )
    const created = await backgroundPage.evaluate(
      async (arg: { url: string; contentUrl: string }) => {
        const ts = await browser.tabs.query({})
        const content = ts.find((t) => t.url === arg.contentUrl)
        if (!content || content.windowId === undefined) return false
        await browser.tabs.create({ url: arg.url, active: false, windowId: content.windowId })
        return true
      },
      { url: popupUrl, contentUrl: pageUrl('/worker-check') }
    )
    expect(created).toBe(true)

    const popupPage = harnessCtx.pages().find((p) => p.url().includes('/popup/index.html'))
    expect(popupPage).toBeTruthy()
    await popupPage!.waitForSelector('#devicePickerMode')
    await popupPage!.waitForSelector('#workerSpawnMode')

    await expect.poll(() => popupPage!.inputValue('#devicePickerMode')).toBe('pageAction')
    await expect.poll(() => popupPage!.inputValue('#workerSpawnMode')).toBe('blob')
    expect(await popupPage!.$('#daemonAsNmHost')).toBeNull()

    await popupPage!.selectOption('#devicePickerMode', 'window')
    await popupPage!.selectOption('#workerSpawnMode', 'shadow')

    const origin = pageUrl('').replace(/\/$/, '')
    const siteKeys = [
      `settings :: ${origin} :: devicePickerMode`,
      `settings :: ${origin} :: workerSpawnMode`
    ]
    await expect
      .poll(() =>
        backgroundPage.evaluate(async (k) => {
          const r = await browser.storage.local.get(k)
          return `${String(r[k[0]])}|${String(r[k[1]])}`
        }, siteKeys)
      )
      .toBe('window|shadow')

    await backgroundPage.evaluate((k) => browser.storage.local.remove(k), siteKeys)
    await backgroundPage.evaluate(async () => {
      const w = globalThis.webhid as { import(name: string): unknown }
      const defaults = w.import('GLOBAL_DEFAULTS') as {
        devicePickerMode: string
        workerSpawnMode: string
      }
      await browser.storage.local.set({
        'settings :: devicePickerMode': defaults.devicePickerMode,
        'settings :: workerSpawnMode': defaults.workerSpawnMode
      })
    })
  })
})
