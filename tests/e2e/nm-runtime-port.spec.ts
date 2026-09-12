import { test, expect } from '../helpers/e2e.js'
import { grantDevicePermission, mockIdFor } from '../helpers/e2e-devices.js'
import { sendInput } from '../helpers/e2e-process.js'

const VENDOR = mockIdFor('vendor')
const PACKET = [0x10, 0x20, 0x30, 0x40, 0x50].concat(new Array(59).fill(0))

test.describe.serial('Exact frame endpoint fanout', () => {
  test('background fanout survives one frame teardown', async ({
    sharedPage,
    backgroundPage,
    vendorDevice
  }) => {
    const origin = new URL(sharedPage.url()).origin
    const settingKey = `settings :: ${origin} :: dataPlane`
    const previous = await backgroundPage.evaluate(
      (key: string) => browser.storage.local.get(key),
      settingKey
    )
    await backgroundPage.evaluate((key: string) => {
      return browser.storage.local.set({ [key]: 'nm' })
    }, settingKey)
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
        window.postMessage(
          { type: 'startFanout', iframeCount: 1, includeWorker: false },
          location.origin
        )
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
      await expect
        .poll(
          () =>
            backgroundPage.evaluate(async () => {
              const tabs = await browser.tabs.query({ active: true, currentWindow: true })
              const tab = tabs[0]
              if (!tab || tab.id == null) return 0
              const status = (await browser.tabs.sendMessage(tab.id, {
                action: 'getDataPlaneStatus'
              })) as { planes?: unknown[] } | null
              return status?.planes?.length || 0
            }),
          { timeout: 15000 }
        )
        .toBe(1)
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
      await expect(sharedPage.evaluate(() => window.tests?.results?.fanoutCounts)).resolves.toEqual(
        {
          page: 2,
          'iframe-0': 1
        }
      )
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
      await backgroundPage.evaluate(
        ({ key, values }) => {
          const missing = !(key in values)
          return browser.storage.local
            .remove(missing ? [key] : [])
            .then(() => (missing ? undefined : browser.storage.local.set(values)))
        },
        { key: settingKey, values: previous }
      )
      await sharedPage.goto(`${origin}/tests/test-page.html`, { waitUntil: 'domcontentloaded' })
    }
  })
})
