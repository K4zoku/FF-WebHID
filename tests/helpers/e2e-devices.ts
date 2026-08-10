import { type Page } from '@playwright/test'
import type { DeviceFilter } from './e2e-types.js'

export const DEVICES = {
  vendor: { vid: 0x16c0, pid: 0x0001, descriptor: 'vendor.bin' },
  gamepad: { vid: 0x16c0, pid: 0x0002, descriptor: 'gamepad.bin' },
  mouse: { vid: 0x16c0, pid: 0x0003, descriptor: 'mouse.bin' },
  keyboard: { vid: 0x16c0, pid: 0x0004, descriptor: 'keyboard.bin' }
} as const

export type DeviceKey = keyof typeof DEVICES

export function mockIdFor(which: DeviceKey): DeviceFilter {
  return { vendorId: DEVICES[which].vid, productId: DEVICES[which].pid }
}

declare global {
  interface Window {
    tests?: {
      helper?: {
        requestDevice?: (filters: DeviceFilter[]) => Promise<number>
        requestDeviceWithoutGesture?: (delayMs: number) => Promise<{
          ok: boolean
          count?: number
          name?: string
          message?: string
        }>
      }
      results?: Record<string, unknown>
    }
  }
}

async function attemptGrant(page: Page, filters: DeviceFilter[]): Promise<number> {
  const requestPromise = page.evaluate(
    (flt: DeviceFilter[]) => window.tests!.helper!.requestDevice!(flt),
    filters
  )

  await page.waitForTimeout(500)

  await page.keyboard.press('Tab')
  await page.waitForTimeout(50)

  await page.keyboard.press('Tab')
  await page.waitForTimeout(50)
  await page.keyboard.press('Space')
  await page.waitForTimeout(50)

  await page.keyboard.press('Tab')
  await page.waitForTimeout(50)

  await page.keyboard.press('Tab')
  await page.waitForTimeout(50)

  await page.keyboard.press('Tab')
  await page.waitForTimeout(50)
  await page.keyboard.press('Enter')

  return requestPromise
}

export async function grantDevicePermission(page: Page, filters: DeviceFilter[]): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const count = await attemptGrant(page, filters)
    if (count > 0) return count
    await page.waitForTimeout(500)
  }
  throw new Error(
    'grantDevicePermission: requestDevice resolved with no devices after 3 attempts. ' +
      'Picker may have cancelled or no device matched the filter.'
  )
}
