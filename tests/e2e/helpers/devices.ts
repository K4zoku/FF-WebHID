import { type Page } from '@playwright/test';

const VID = 0x1234;
const PID = 0x5678;

export async function grantDevicePermission(
  page: Page,
  filters: any[] = [{ vendorId: VID, productId: PID }],
): Promise<any[]> {
  const deviceId = 48125337;
  const requestDevicesPromise = page.evaluate((flt) => {
    return (window as any).__webhidTest.requestDevice(flt);
  }, filters);

  await page.waitForTimeout(500);

  const collections = [{
    usagePage: 1,
    usage: 2,
    type: 1,
  }];

  await page.evaluate(({ deviceId, VID, PID, collections }) => {
    window.dispatchEvent(new CustomEvent('webhid-device-selected', {
      detail: {
        devices: [{
          deviceId,
          vendorId: VID,
          productId: PID,
          collections,
        }],
      },
    }));
  }, { deviceId, VID, PID, collections });

  return requestDevicesPromise;
}

export async function ensureDevicePaired(
  page: Page,
  testApi: { getDevices: () => Promise<any[]> },
): Promise<any[]> {
  const devices = await testApi.getDevices();
  if (devices.length > 0) return devices;
  return grantDevicePermission(page);
}
