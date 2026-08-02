import { type Page } from '@playwright/test'
import type { DeviceFilter } from './e2e-types.js'

export type { DeviceFilter }

// Single source of truth for the multi-device e2e harness. Each generated
// descriptor is its own mock device with a unique PID (all at a generic VID
// that no kernel HID driver claims). The PID is a per-descriptor constant,
// not worker-indexed: every worker's Firefox sees only its own daemon's
// devices, so the only uniqueness required is across the concurrently
// spawned devices within one Firefox.
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
      }
      results?: Record<string, unknown>
    }
  }
}

async function attemptGrant(page: Page, filters: DeviceFilter[]): Promise<number> {
  // The shim needs a synthetic click (user activation) to open the picker;
  // it resolves with the number of granted devices once the picker closes.
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
  // The picker flow is keyboard-timing based; under parallel CPU load the
  // device list may not be populated within the fixed waits, so retry the
  // whole flow a few times instead of lengthening the sleeps.
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