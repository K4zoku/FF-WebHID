import { test, expect } from '../helpers/browser.js'

interface ActivationResult {
  ok: boolean
  count?: number
  name?: string
  message?: string
}

interface ProbeResult {
  syncActive: boolean
  expiredActive: boolean
}

test.describe('requestDevice user-activation gate', () => {
  let origin: string
  const settingKey = () => `settings :: ${origin} :: allowActivationlessRequestDevice`

  test.beforeAll(async ({ backgroundPage, servers }) => {
    origin = `http://localhost:${servers.main.port}`
    await backgroundPage.evaluate((key) => browser.storage.local.remove(key), settingKey())
  })

  test('PROBE: activation expires after the ~5s window', async ({ sharedPage, pageUrl }) => {
    await sharedPage.goto(pageUrl('/self-script'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    const result: ProbeResult = await sharedPage.evaluate(async () => {
      const syncActive = navigator.userActivation ? navigator.userActivation.isActive : false
      const { promise, resolve } = Promise.withResolvers<ProbeResult>()
      setTimeout(() => {
        const expiredActive = navigator.userActivation ? navigator.userActivation.isActive : false
        resolve({ syncActive, expiredActive })
      }, 6000)
      return promise
    })
    expect(result.syncActive).toBe(true)
    expect(result.expiredActive).toBe(false)
  })

  test('default: requestDevice() without a user gesture rejects with SecurityError', async ({
    sharedPage,
    pageUrl
  }) => {
    await sharedPage.goto(pageUrl('/activation'), { waitUntil: 'domcontentloaded', timeout: 15000 })
    const result: ActivationResult = await sharedPage.evaluate(() =>
      window.tests!.helper!.requestDeviceWithoutGesture!(6000)
    )
    expect(result.ok).toBe(false)
    expect(result.name).toBe('SecurityError')
    expect(result.message).toContain('user gesture')
  })

  test('allowActivationlessRequestDevice: no SecurityError without a gesture', async ({
    backgroundPage,
    sharedPage,
    pageUrl
  }) => {
    await backgroundPage.evaluate((key) => browser.storage.local.set({ [key]: true }), settingKey())
    await sharedPage.goto(pageUrl('/activation'), { waitUntil: 'domcontentloaded', timeout: 15000 })
    const result = await sharedPage.evaluate(async () => {
      let settled: string | null = null
      void window.tests!.helper!.requestDeviceWithoutGesture!(6000).then((r: ActivationResult) => {
        settled = r.ok ? 'resolved' : 'rejected:' + r.name
      })
      await new Promise((r) => setTimeout(r, 6800))
      return { settled }
    })
    expect(result.settled ?? '').not.toContain('SecurityError')
    await sharedPage.keyboard.press('Escape')
  })

  test('forged MAIN-world userActivation does not open the picker (ISOLATED rechecks)', async ({
    backgroundPage,
    sharedPage,
    pageUrl
  }) => {
    await backgroundPage.evaluate((key) => browser.storage.local.remove(key), settingKey())
    await sharedPage.goto(pageUrl('/activation'), { waitUntil: 'domcontentloaded', timeout: 15000 })
    const result: ActivationResult = await sharedPage.evaluate(() => {
      try {
        Object.defineProperty(navigator, 'userActivation', {
          value: { isActive: true },
          configurable: true
        })
      } catch {}
      return window.tests!.helper!.requestDeviceWithoutGesture!(6000)
    })
    expect(result.ok).toBe(true)
    expect(result.count).toBe(0)
  })

  test.afterAll(async ({ backgroundPage }) => {
    await backgroundPage.evaluate((key) => browser.storage.local.remove(key), settingKey())
  })
})
