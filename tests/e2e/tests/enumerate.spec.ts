import { test, expect } from '../helpers/fixtures.js';
import { grantDevicePermission } from '../helpers/devices.js';

test.describe('Device enumeration', () => {
  test('getDevices returns empty before permission', async ({ testApi }) => {
    const devices = await testApi.getDevices();
    expect(Array.isArray(devices)).toBe(true);
    expect(devices.length).toBe(0);
  });

  test('grant permission via requestDevice', async ({ sharedPage, testApi }) => {
    const devices = await grantDevicePermission(sharedPage);
    expect(devices.length).toBeGreaterThanOrEqual(1);

    const info = await testApi.deviceInfo(devices[0].index);
    expect(info.vendorId).toBe(0x1234);
    expect(info.productId).toBe(0x5678);
  });

  test('getDevices returns permitted device', async ({ sharedPage, testApi }) => {
    await grantDevicePermission(sharedPage);

    const devices = await testApi.getDevices();
    expect(devices.length).toBeGreaterThanOrEqual(1);
  });

  test('device has expected collections from mouse descriptor', async ({ sharedPage, testApi }) => {
    const devices = await grantDevicePermission(sharedPage);
    const info = await testApi.deviceInfo(devices[0].index);

    expect(info.collections.length).toBeGreaterThanOrEqual(1);
    const app = info.collections[info.collections.length - 1];
    expect(app.usagePage).toBe(1);
    expect(app.usage).toBe(2);
  });
});
