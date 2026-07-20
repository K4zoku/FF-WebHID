import { test, expect } from '../helpers/fixtures.js';
import { grantDevicePermission } from '../helpers/devices.js';

test.describe('Device open/close', () => {
  test.beforeEach(async ({ sharedPage }) => {
    await grantDevicePermission(sharedPage);
  });

  test('open a device succeeds', async ({ testApi }) => {
    const devices = await testApi.getDevices();
    expect(devices.length).toBeGreaterThanOrEqual(1);
    await testApi.open(devices[0].index);
  });

  test('close a device succeeds', async ({ testApi }) => {
    const devices = await testApi.getDevices();
    await testApi.open(devices[0].index);
    await testApi.close(devices[0].index);
  });

  test('open and close multiple times', async ({ testApi }) => {
    const devices = await testApi.getDevices();
    for (let i = 0; i < 3; i++) {
      await testApi.open(devices[0].index);
      await testApi.close(devices[0].index);
    }
  });

  test('sendReport fails before open', async ({ testApi }) => {
    const devices = await testApi.getDevices();
    let failed = false;
    try {
      await testApi.sendReport(devices[0].index, 0, [1, 2, 3]);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});
