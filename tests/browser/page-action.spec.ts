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
          .requestDevice()
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
          .requestDevice()
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
