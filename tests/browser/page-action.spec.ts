import { test, expect } from '../helpers/browser.js'
import type { FirefoxBgPage } from '../helpers/harness.js'

async function activePageActionShown(backgroundPage: FirefoxBgPage): Promise<boolean> {
  return backgroundPage.evaluate(async () => {
    const tabs = await browser.tabs.query({ active: true })
    const tab = tabs.find((entry) => entry.url && /^https?:/.test(entry.url))
    return tab && tab.id != null ? browser.pageAction.isShown({ tabId: tab.id }) : false
  })
}
const HIDE_PAGE_ACTION_KEY = 'settings :: hidePageAction'

test.describe('extension action surfaces', () => {
  test.beforeAll(async ({ backgroundPage }) => {
    await backgroundPage.evaluate(
      (key) => browser.storage.local.set({ [key]: false }),
      HIDE_PAGE_ACTION_KEY
    )
  })

  test.afterAll(async ({ backgroundPage }) => {
    await backgroundPage.evaluate(
      (key) => browser.storage.local.set({ [key]: false }),
      HIDE_PAGE_ACTION_KEY
    )
  })

  test('page action is hidden until a page uses WebHID', async ({
    backgroundPage,
    sharedPage,
    pageUrl
  }) => {
    await sharedPage.goto(pageUrl('/self-script'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    await expect.poll(() => activePageActionShown(backgroundPage)).toBe(false)

    await sharedPage.evaluate(async () => {
      try {
        await navigator.hid.getDevices()
      } catch {}
    })

    await expect.poll(() => activePageActionShown(backgroundPage)).toBe(true)
  })

  test('global hide page action setting suppresses the icon and selects devices', async ({
    backgroundPage,
    sharedPage,
    pageUrl
  }) => {
    await backgroundPage.evaluate(
      (settingKey) => browser.storage.local.set({ [settingKey]: true }),
      HIDE_PAGE_ACTION_KEY
    )
    try {
      const settingsUrl = await backgroundPage.evaluate(() =>
        browser.runtime.getURL('js/internal/pages/settings/index.html')
      )
      await sharedPage.goto(settingsUrl, { waitUntil: 'domcontentloaded', timeout: 15000 })
      await expect(sharedPage.locator('#hidePageAction')).toBeChecked()
      await sharedPage.goto(pageUrl('/self-script'), {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      })
      await expect.poll(() => activePageActionShown(backgroundPage)).toBe(false)
      await sharedPage.evaluate(async () => {
        try {
          await navigator.hid.getDevices()
        } catch {}
      })
      await expect.poll(() => activePageActionShown(backgroundPage)).toBe(false)

      const popupUrl = await backgroundPage.evaluate(() =>
        browser.runtime.getURL('js/internal/pages/popup/index.html')
      )
      await sharedPage.goto(`${popupUrl}#settings`, {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      })
      await expect(sharedPage.locator('#view-devices')).toBeVisible()
      await expect(sharedPage.locator('#view-settings')).toBeHidden()
    } finally {
      await backgroundPage.evaluate(
        (key) => browser.storage.local.set({ [key]: false }),
        HIDE_PAGE_ACTION_KEY
      )
      await sharedPage.goto('about:blank')
    }
  })

  test('browser action popup opens on the settings view', async ({
    backgroundPage,
    sharedPage
  }) => {
    const popupUrl = await backgroundPage.evaluate(() =>
      browser.runtime.getURL('js/internal/pages/popup/index.html')
    )
    await sharedPage.goto(`${popupUrl}#settings`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    expect(sharedPage.url()).toContain('#settings')
    await expect(sharedPage.locator('#view-settings')).toBeVisible()
    await expect(sharedPage.locator('#view-devices')).toBeHidden()
  })

  test('page action popup opens on the devices view', async ({ backgroundPage, sharedPage }) => {
    const popupUrl = await backgroundPage.evaluate(() =>
      browser.runtime.getURL('js/internal/pages/popup/index.html')
    )
    await sharedPage.goto(popupUrl, { waitUntil: 'domcontentloaded', timeout: 15000 })
    await expect(sharedPage.locator('#view-devices')).toBeVisible()
    await expect(sharedPage.locator('#view-settings')).toBeHidden()
  })
})
