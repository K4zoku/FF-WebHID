import { type Page } from "@playwright/test";
import type { DeviceInfo, DeviceFilter, WebHidTestAPI } from './e2e-types.js';

const VID = 0x16c0;
const PID = 0x0001;

export async function grantDevicePermission(
  page: Page,
  filters: DeviceFilter[] = [{ vendorId: VID, productId: PID }],
): Promise<DeviceInfo[]> {
  const requestPromise = page.evaluate((flt: DeviceFilter[]) => {
    return (window as unknown as Window & { __webhidTest: WebHidTestAPI }).__webhidTest.requestDevice(flt);
  }, filters);

  await page.waitForTimeout(500);

  await page.keyboard.press("Tab");
  await page.waitForTimeout(50);

  await page.keyboard.press("Tab");
  await page.waitForTimeout(50);
  await page.keyboard.press("Space");
  await page.waitForTimeout(50);

  await page.keyboard.press("Tab");
  await page.waitForTimeout(50);

  await page.keyboard.press("Tab");
  await page.waitForTimeout(50);

  await page.keyboard.press("Tab");
  await page.waitForTimeout(50);
  await page.keyboard.press("Enter");

  const devices = await requestPromise;
  if (!Array.isArray(devices) || devices.length === 0) {
    throw new Error(
      "grantDevicePermission: requestDevice resolved with no devices. " +
        "Picker may have cancelled or no device matched the filter.",
    );
  }
  return devices;
}

export async function ensureDevicePaired(
  page: Page,
  testApi: { getDevices: () => Promise<DeviceInfo[]> },
): Promise<DeviceInfo[]> {
  const devices = await testApi.getDevices();
  if (devices.length > 0) return devices;
  return grantDevicePermission(page);
}
