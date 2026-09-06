import { test, expect } from '../helpers/e2e.js'
import { grantDevicePermission, mockIdFor } from '../helpers/e2e-devices.js'
import { sendInput } from '../helpers/e2e-process.js'
import { sleep } from '../helpers/test-utils.js'

const VENDOR = mockIdFor('vendor')
const PACKET = [0x10, 0x20, 0x30, 0x40, 0x50].concat(new Array(59).fill(0))

test.describe.serial('NM runtime port topology', () => {
  test('shared NM port survives one frame teardown', async ({
    sharedPage,
    backgroundPage,
    vendorDevice
  }) => {
    const origin = new URL(sharedPage.url()).origin
    await backgroundPage.evaluate((siteOrigin: string) => {
      return browser.storage.local.set({ [`settings :: ${siteOrigin} :: dataPlane`]: 'nm' })
    }, origin)
    try {
      await sharedPage.goto(`${origin}/tests/test-page.html`, { waitUntil: 'domcontentloaded' })
      await sharedPage.waitForFunction(() => typeof navigator.hid !== 'undefined', {
        timeout: 15000
      })
      expect(await grantDevicePermission(sharedPage, [VENDOR])).toBe(1)
      await sharedPage.goto(`${origin}/tests/pages/input-report-fanout.html`, {
        waitUntil: 'domcontentloaded'
      })
      await sharedPage.evaluate(() => {
        window.postMessage({ type: 'startFanout', iframeCount: 1, includeWorker: false }, location.origin)
      })
      await sharedPage.waitForFunction(
        () => {
          const results = window.tests?.results
          const error = results?.fanoutError
          if (typeof error === 'string') throw new Error(error)
          return results?.fanoutReady === true
        },
        { timeout: 15000 }
      )
      await sleep(300)
      sendInput(vendorDevice, 1, PACKET)
      await sharedPage.waitForFunction(
        () => {
          const testResults = window.tests!.results as unknown as {
            fanoutCounts?: Record<string, number>
          }
          const counts = testResults.fanoutCounts
          return counts?.page === 1 && counts['iframe-0'] === 1
        },
        { timeout: 15000 }
      )
      await sharedPage.evaluate(() => document.querySelector('iframe')?.remove())
      await sleep(500)
      sendInput(vendorDevice, 1, PACKET)
      await sharedPage.waitForFunction(
        () => {
          const testResults = window.tests!.results as unknown as {
            fanoutCounts?: Record<string, number>
          }
          return testResults.fanoutCounts?.page === 2
        },
        { timeout: 15000 }
      )
      await expect(sharedPage.evaluate(() => window.tests?.results?.fanoutCounts)).resolves.toEqual({
        page: 2,
        'iframe-0': 1
      })
    } finally {
      await sharedPage.evaluate(async () => {
        for (const device of await navigator.hid.getDevices()) {
          if (device.opened) await device.close()
          await device.forget()
        }
      })
      await sharedPage.waitForFunction(
        async () => (await navigator.hid.getDevices()).length === 0,
        { timeout: 15000 }
      )
      await backgroundPage.evaluate((siteOrigin: string) => {
        return browser.storage.local.set({ [`settings :: ${siteOrigin} :: dataPlane`]: 'nm' })
      }, origin)
      await sharedPage.goto(`${origin}/tests/test-page.html`, { waitUntil: 'domcontentloaded' })
    }
  })
})
