import { test, expect } from '../helpers/fixtures.js';
import { grantDevicePermission } from '../helpers/devices.js';
import { sendInput } from '../helpers/process.js';

test.describe('Input report flow', () => {
  test('receive input report from uhid-mock', async ({ sharedPage, uhidMock, testApi }) => {
    const devices = await grantDevicePermission(sharedPage);
    const idx = devices[0].index;
    await testApi.open(idx);

    const reportPromise = testApi.onInputReport(idx);
    sendInput(uhidMock, 1, [0xAB, 0xCD, 0xEF]);

    const event = await reportPromise;
    expect(event.reportId).toBe(1);
    expect(event.data).toEqual([0xAB, 0xCD, 0xEF]);
    expect(event.device.vendorId).toBe(0x1234);
    expect(event.device.productId).toBe(0x5678);
  });

  test('receive input report without report ID', async ({ sharedPage, uhidMock, testApi }) => {
    const devices = await grantDevicePermission(sharedPage);
    const idx = devices[0].index;
    await testApi.open(idx);

    const reportPromise = testApi.onInputReport(idx);
    sendInput(uhidMock, undefined, [0x01, 0x02]);

    const event = await reportPromise;
    expect(event.reportId).toBe(0);
    expect(event.data).toEqual([0x01, 0x02]);
  });

  test('receive multiple input reports', async ({ sharedPage, uhidMock, testApi }) => {
    const devices = await grantDevicePermission(sharedPage);
    const idx = devices[0].index;
    await testApi.open(idx);

    for (let i = 0; i < 3; i++) {
      const reportPromise = testApi.onInputReport(idx);
      sendInput(uhidMock, 1, [i, i + 1, i + 2]);
      const event = await reportPromise;
      expect(event.reportId).toBe(1);
      expect(event.data[0]).toBe(i);
    }
  });
});
