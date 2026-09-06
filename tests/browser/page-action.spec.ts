import { test, expect } from '../helpers/browser.js'
import type { Page } from '@playwright/test'
import type { FirefoxBgPage } from '../helpers/harness.js'

async function activePageActionShown(backgroundPage: FirefoxBgPage): Promise<boolean> {
  return backgroundPage.evaluate(async () => {
    const tabs = await browser.tabs.query({ active: true })
    const tab = tabs.find((entry) => entry.url && /^https?:/.test(entry.url))
    return tab && tab.id != null ? browser.pageAction.isShown({ tabId: tab.id }) : false
  })
}
const HIDE_PAGE_ACTION_KEY = 'settings :: hidePageAction'
interface PendingPicker {
  requestId: string | number
  tabId: number
  mode: 'pageAction'
}

function isPendingPicker(value: unknown): value is PendingPicker {
  if (value == null || typeof value !== 'object') return false
  if (!('requestId' in value) || !('tabId' in value) || !('mode' in value)) return false
  return (
    (typeof value.requestId === 'string' || typeof value.requestId === 'number') &&
    typeof value.tabId === 'number' &&
    value.mode === 'pageAction'
  )
}

async function readPendingPicker(page: Page): Promise<PendingPicker> {
  const pending: unknown = await page.evaluate(() =>
    browser.runtime.sendMessage({ action: 'getPendingPicker' })
  )
  if (!isPendingPicker(pending)) throw new Error('page-action picker is not pending')
  return pending
}

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

  test('settings localize the page action control and document metadata', async ({
    backgroundPage,
    sharedPage
  }) => {
    const settingsUrl = await backgroundPage.evaluate(() =>
      browser.runtime.getURL('js/internal/pages/settings/index.html')
    )
    await sharedPage.goto(settingsUrl, { waitUntil: 'domcontentloaded', timeout: 15000 })
    await expect(sharedPage.locator('#settingsHidePageAction')).toHaveText('Hide Page Action')
    await expect(sharedPage.locator('[data-i18n-md="settingsHidePageActionDesc"]')).toHaveText(
      'Keep the page action hidden when a site uses the WebHID API. The browser action still opens the device view by default.'
    )
    const expectedLanguage = await sharedPage.evaluate(() =>
      browser.i18n.getUILanguage().replaceAll('_', '-')
    )
    await expect(sharedPage.locator('html')).toHaveAttribute('lang', expectedLanguage)
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
  test('popup scopes status requests to its selected origin', async ({
    backgroundPage,
    sharedPage,
    page,
    pageUrl
  }) => {
    const activeOrigin = new URL(pageUrl('/')).origin
    const selectedOrigin = `${activeOrigin}-selected`
    await sharedPage.goto(pageUrl('/test-page.html'), { waitUntil: 'domcontentloaded' })
    await page.addInitScript((origin) => {
      const calls: Array<{ action: string; origin: unknown }> = []
      Object.defineProperty(globalThis, '__popupStatusCalls', { value: calls })
      const runtimeSendMessage = browser.runtime.sendMessage as unknown as (
        message: unknown
      ) => Promise<unknown>
      const tabsSendMessage = browser.tabs.sendMessage as unknown as (
        tabId: number,
        message: unknown
      ) => Promise<unknown>
      browser.runtime.sendMessage = async (message) => {
        const request = message as { action?: unknown }
        if (request.action === 'getFrameOrigins')
          return { origins: [origin.active, origin.selected] }
        if (request.action === 'getBackendStatus')
          return { nmConnected: true, daemonReachable: true, hidPermission: 0 }
        if (request.action === 'getPairedDevices') return { success: true, hashes: ['1'] }
        return runtimeSendMessage(message)
      }
      browser.tabs.sendMessage = async (tabId, message) => {
        const request = message as { action?: unknown; origin?: unknown }
        const action = typeof request.action === 'string' ? request.action : ''
        if (action === 'getDataPlaneStatus' || action === 'getOpenDeviceIds')
          calls.push({ action, origin: request.origin })
        if (action === 'getDataPlaneStatus') {
          return request.origin === origin.selected
            ? { planes: [{ deviceId: '1', plane: 'ws', mode: 'worker' }], defaultPlane: 'nm' }
            : { planes: [], defaultPlane: 'nm' }
        }
        if (action === 'getOpenDeviceIds')
          return request.origin === origin.selected ? { ids: ['1'] } : { ids: [] }
        return tabsSendMessage(tabId, message)
      }
    }, { active: activeOrigin, selected: selectedOrigin })
    const popupUrl = await backgroundPage.evaluate(() =>
      browser.runtime.getURL('js/internal/pages/popup/index.html')
    )
    await page.goto(popupUrl, { waitUntil: 'domcontentloaded', timeout: 15000 })
    const before = await page.evaluate(() => {
      const value = (globalThis as unknown as { __popupStatusCalls?: unknown }).__popupStatusCalls
      return Array.isArray(value) ? value.length : 0
    })
    await page.locator('#site-name').click()
    await page.locator('#origin-list li').nth(1).click()
    await expect(page.locator('#site-name-text')).toHaveText(selectedOrigin)
    await expect(page.locator('#status')).toHaveClass(/state-warn/)
    await page.waitForFunction(
      ({ start, origin }) => {
        const calls = (globalThis as unknown as { __popupStatusCalls?: unknown }).__popupStatusCalls
        if (!Array.isArray(calls)) return false
        const after = calls.slice(start)
        return (
          after.some((entry) => {
            const call = entry as { action?: unknown; origin?: unknown }
            return call.action === 'getDataPlaneStatus' && call.origin === origin
          }) &&
          after.some((entry) => {
            const call = entry as { action?: unknown; origin?: unknown }
            return call.action === 'getOpenDeviceIds' && call.origin === origin
          })
        )
      },
      { start: before, origin: selectedOrigin },
      { timeout: 15000 }
    )
    const calls = await page.evaluate(() => {
      const value = (globalThis as unknown as { __popupStatusCalls?: unknown }).__popupStatusCalls
      return Array.isArray(value)
        ? (value as Array<{ action: string; origin: unknown }>)
        : []
    })
    const afterSelection = calls.slice(before)
    expect(afterSelection).toEqual(
      expect.arrayContaining([
        { action: 'getDataPlaneStatus', origin: selectedOrigin },
        { action: 'getOpenDeviceIds', origin: selectedOrigin }
      ])
    )
  })
  test('hidden page action stays visible during its pending picker', async ({
    backgroundPage,
    sharedPage,
    page,
    pageUrl
  }) => {
    const origin = new URL(pageUrl('/')).origin
    const sitePickerKey = `settings :: ${origin} :: devicePickerMode`
    const siteActivationKey = `settings :: ${origin} :: allowActivationlessRequestDevice`
    await backgroundPage.evaluate(
      ({ sitePickerKey, siteActivationKey }) =>
        browser.storage.local.set({
          'settings :: hidePageAction': true,
          [sitePickerKey]: 'pageAction',
          [siteActivationKey]: true
        }),
      { sitePickerKey, siteActivationKey }
    )
    try {
      await sharedPage.goto(pageUrl('/self-script'), {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      })
      await sharedPage.evaluate(() => {
        const state = window as unknown as { pickerState?: string }
        state.pickerState = 'pending'
        navigator.hid
          .requestDevice({ filters: [] })
          .then(() => {
            state.pickerState = 'settled'
          })
          .catch(() => {
            state.pickerState = 'settled'
          })
      })
      await expect.poll(() => activePageActionShown(backgroundPage)).toBe(true)

      const pickerUrl = await backgroundPage.evaluate(() =>
        browser.runtime.getURL('js/internal/pages/picker/index.html')
      )
      await page.goto(pickerUrl, { waitUntil: 'domcontentloaded', timeout: 15000 })
      const pending = await readPendingPicker(page)
      await page.evaluate(
        (request) =>
          browser.runtime.sendMessage({
            action: 'pickerResult',
            requestId: request.requestId,
            tabId: request.tabId,
            selected: false
          }),
        pending
      )
      await expect
        .poll(() =>
          sharedPage.evaluate(() => {
            const value = 'pickerState' in window ? window.pickerState : undefined
            return typeof value === 'string' ? value : undefined
          })
        )
        .toBe('settled')
      await expect.poll(() => activePageActionShown(backgroundPage)).toBe(false)
    } finally {
      await backgroundPage.evaluate(
        (keys) => browser.storage.local.remove(keys),
        ['settings :: hidePageAction', sitePickerKey, siteActivationKey]
      )
    }
  })

  test('enabling hide page action during a picker keeps it visible until finish', async ({
    backgroundPage,
    sharedPage,
    page,
    pageUrl
  }) => {
    const origin = new URL(pageUrl('/')).origin
    const hideKey = 'settings :: hidePageAction'
    const sitePickerKey = `settings :: ${origin} :: devicePickerMode`
    const siteActivationKey = `settings :: ${origin} :: allowActivationlessRequestDevice`
    await backgroundPage.evaluate(
      ({ hideKey, sitePickerKey, siteActivationKey }) =>
        browser.storage.local.set({
          [hideKey]: false,
          [sitePickerKey]: 'pageAction',
          [siteActivationKey]: true
        }),
      { hideKey, sitePickerKey, siteActivationKey }
    )
    try {
      await sharedPage.goto(pageUrl('/self-script'), {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      })
      await sharedPage.evaluate(() => {
        const state = window as unknown as { pickerState?: string }
        state.pickerState = 'pending'
        navigator.hid
          .requestDevice({ filters: [] })
          .then(() => {
            state.pickerState = 'settled'
          })
          .catch(() => {
            state.pickerState = 'settled'
          })
      })
      await expect.poll(() => activePageActionShown(backgroundPage)).toBe(true)

      await backgroundPage.evaluate((key) => browser.storage.local.set({ [key]: true }), hideKey)
      await expect.poll(() => activePageActionShown(backgroundPage)).toBe(true)

      const pickerUrl = await backgroundPage.evaluate(() =>
        browser.runtime.getURL('js/internal/pages/picker/index.html')
      )
      await page.goto(pickerUrl, { waitUntil: 'domcontentloaded', timeout: 15000 })
      const pending = await readPendingPicker(page)
      await page.evaluate(
        (request) =>
          browser.runtime.sendMessage({
            action: 'pickerResult',
            requestId: request.requestId,
            tabId: request.tabId,
            selected: false
          }),
        pending
      )
      await expect
        .poll(() =>
          sharedPage.evaluate(() => {
            const value = 'pickerState' in window ? window.pickerState : undefined
            return typeof value === 'string' ? value : undefined
          })
        )
        .toBe('settled')
      await expect.poll(() => activePageActionShown(backgroundPage)).toBe(false)
    } finally {
      await backgroundPage.evaluate(
        (keys) => browser.storage.local.remove(keys),
        [hideKey, sitePickerKey, siteActivationKey]
      )
    }
  })
})
