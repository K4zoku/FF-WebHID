import { test, expect } from '../helpers/browser.js'

test.describe('settings scope', () => {
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
    // Seed non-first-option GLOBAL values so the default-value assertions are
    // meaningful (a dead page would show the first <option> either way).
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

    // tabs.create lands the popup tab in the content page's window with
    // active:false. The harness reports tab active state unreliably, but the
    // popup's `tabs.query({active:true, currentWindow:true})[0]` resolves to the
    // content tab, so the popup picks up the content origin.
    const popupUrl = await backgroundPage.evaluate(() =>
      browser.runtime.getURL('js/internal/pages/popup/index.html')
    )
    await backgroundPage.evaluate((url) => browser.tabs.create({ url, active: false }), popupUrl)

    const popupPage = harnessCtx.pages().find((p) => p.url().includes('/popup/index.html'))
    expect(popupPage).toBeTruthy()
    await popupPage.waitForSelector('#devicePickerMode')
    await popupPage.waitForSelector('#workerSpawnMode')

    await expect.poll(() => popupPage.inputValue('#devicePickerMode')).toBe('pageAction')
    await expect.poll(() => popupPage.inputValue('#workerSpawnMode')).toBe('blob')
    expect(await popupPage.$('#daemonAsNmHost')).toBeNull()

    await popupPage.selectOption('#devicePickerMode', 'window')
    await popupPage.selectOption('#workerSpawnMode', 'shadow')

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
    // Restore defaults rather than remove: the background's storage.onChanged
    // applies `change.newValue` (undefined for removals) into its store, which
    // would poison `settings.workerSpawnMode` for later specs sharing this
    // worker-scoped context.
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
