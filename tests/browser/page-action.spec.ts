import { test, expect } from '../helpers/browser.js'
import type { FirefoxBgPage } from '../helpers/harness.js'

async function activePageActionShown(backgroundPage: FirefoxBgPage): Promise<boolean> {
  return backgroundPage.evaluate(async () => {
    const tabs = await browser.tabs.query({ active: true })
    const tab = tabs.find((entry) => entry.url && /^https?:/.test(entry.url))
    return tab && tab.id != null ? browser.pageAction.isShown({ tabId: tab.id }) : false
  })
}

test.describe('extension action surfaces', () => {
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
