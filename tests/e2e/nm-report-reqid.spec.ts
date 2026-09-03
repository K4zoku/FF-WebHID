import { test, expect } from '../helpers/e2e.js'
import { grantDevicePermission, mockIdFor } from '../helpers/e2e-devices.js'
import type { Page } from '@playwright/test'

const VENDOR = mockIdFor('vendor')

async function closeDevice(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const device = (await navigator.hid.getDevices())[0]
    if (!device) return
    if (device.opened) await device.close()
    await device.forget()
  })
}

test.describe.serial('NM report request routing', () => {
  test('routes concurrent reports from page contexts independently', async ({
    sharedPage,
    backgroundPage,
    vendorDevice: _vendorDevice
  }) => {
    const origin = new URL(sharedPage.url()).origin
    await backgroundPage.evaluate((siteOrigin: string) => {
      return browser.storage.local.set({ [`settings :: ${siteOrigin} :: dataPlane`]: 'nm' })
    }, origin)
    await sharedPage.goto(`${origin}/tests/test-page.html`, { waitUntil: 'domcontentloaded' })
    await sharedPage.waitForFunction(() => typeof navigator.hid !== 'undefined', { timeout: 15000 })
    await sharedPage.evaluate(async () => {
      for (const device of await navigator.hid.getDevices()) {
        if (device.opened) await device.close()
        await device.forget()
      }
    })
    expect(await grantDevicePermission(sharedPage, [VENDOR])).toBe(1)
    await sharedPage.goto(`${origin}/tests/pages/nm-report-reqid.html`, {
      waitUntil: 'domcontentloaded'
    })
    await sharedPage.waitForFunction(() => typeof navigator.hid !== 'undefined', { timeout: 15000 })

    await sharedPage.evaluate(() => {
      window.postMessage({ type: 'start' }, location.origin)
    })
    await sharedPage.waitForFunction(
      () => {
        const results = window.tests?.results
        if (typeof results?.reportError === 'string') throw new Error(results.reportError)
        return results?.reportResults !== undefined
      },
      { timeout: 15000 }
    )

    await expect(sharedPage.evaluate(() => window.tests?.results?.reportResults)).resolves.toEqual({
      first: 'ok',
      second: 'ok'
    })
    await closeDevice(sharedPage)
    await sharedPage.goto(`${origin}/tests/test-page.html`, { waitUntil: 'domcontentloaded' })
  })
})
