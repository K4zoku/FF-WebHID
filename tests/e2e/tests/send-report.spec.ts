import { test, expect } from '../helpers/fixtures.js';
import { grantDevicePermission } from '../helpers/devices.js';
import { waitForOutputReport } from '../helpers/process.js';

test.describe('Send report flow', () => {
  test.beforeEach(async ({ sharedPage }) => {
    await grantDevicePermission(sharedPage);
  });

  test('sendReport reaches uhid-mock', async ({ uhidMock, testApi }) => {
    const devices = await testApi.getDevices();
    const idx = devices[0].index;
    await testApi.open(idx);

    const outputPromise = waitForOutputReport(uhidMock);
    await testApi.sendReport(idx, 0, [0xAA, 0xBB, 0xCC]);

    const output = await outputPromise;
    expect(Array.isArray(output.data)).toBe(true);
    expect(output.data).toEqual([0xAA, 0xBB, 0xCC]);
  });

  test('sendReport with different payload sizes', async ({ uhidMock, testApi }) => {
    const devices = await testApi.getDevices();
    const idx = devices[0].index;
    await testApi.open(idx);

    const output1 = waitForOutputReport(uhidMock);
    await testApi.sendReport(idx, 0, [0x01]);
    await output1;

    const output2 = waitForOutputReport(uhidMock);
    await testApi.sendReport(idx, 0, [0x10, 0x20, 0x30, 0x40]);
    await output2;
  });

  test('sendReport resolves on completion', async ({ uhidMock, testApi }) => {
    const devices = await testApi.getDevices();
    const idx = devices[0].index;
    await testApi.open(idx);

    await testApi.sendReport(idx, 0, [0xDE, 0xAD, 0xBE, 0xEF]);
  });
});
