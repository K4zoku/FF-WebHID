import { test, expect } from '../helpers/fixtures.js';
import { grantDevicePermission, ensureDevicePaired } from '../helpers/devices.js';
import { sendInput, waitForOutputReport } from '../helpers/process.js';

test.describe.serial('FF-WebHID E2E', () => {
  // ── handshake ──────────────────────────────────────────────────────────

  test('navigator.hid is polyfilled', async ({ testApi }) => {
    expect(await testApi.isPolyfillLoaded()).toBe(true);
  });

  test('getDevices is a function', async ({ sharedPage }) => {
    expect(await sharedPage.evaluate(() => typeof navigator.hid.getDevices === 'function')).toBe(true);
  });

  test('getDevices returns an array', async ({ testApi }) => {
    expect(Array.isArray(await testApi.getDevices())).toBe(true);
  });

  test('requestDevice is a function', async ({ sharedPage }) => {
    expect(await sharedPage.evaluate(() => typeof navigator.hid.requestDevice === 'function')).toBe(true);
  });

  // ── enumeration ────────────────────────────────────────────────────────

  test('getDevices returns empty before permission', async ({ testApi }) => {
    expect(await testApi.getDevices()).toEqual([]);
  });

  test('grant permission via requestDevice', async ({ sharedPage, testApi }) => {
    const devices = await grantDevicePermission(sharedPage);
    expect(devices.length).toBeGreaterThanOrEqual(1);
    const info = await testApi.deviceInfo(devices[0].index);
    expect(info.vendorId).toBe(0x1234);
    expect(info.productId).toBe(0x5678);
  });

  test('getDevices returns permitted device', async ({ testApi }) => {
    expect(await testApi.getDevices()).toHaveLength(1);
  });

  test('device has expected collections from mouse descriptor', async ({ testApi }) => {
    const info = await testApi.deviceInfo(0);
    expect(info.collections.length).toBeGreaterThanOrEqual(1);
    expect(info.collections[info.collections.length - 1].usagePage).toBe(1);
    expect(info.collections[info.collections.length - 1].usage).toBe(2);
  });

  // ── close after enumeration (device opened by grantDevicePermission) ──

  test('close device opened by enumeration', async ({ testApi }) => {
    const devices = await testApi.getDevices();
    expect(devices.length).toBeGreaterThanOrEqual(1);
    await testApi.open(devices[0].index);
    await testApi.close(devices[0].index);
  });

  // ── open / close ───────────────────────────────────────────────────────

  test('open a device succeeds', async ({ testApi }) => {
    const devices = await testApi.getDevices();
    expect(devices.length).toBeGreaterThanOrEqual(1);
    await testApi.open(devices[0].index);
  });

  test('close a device succeeds', async ({ testApi }) => {
    const devices = await testApi.getDevices();
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
    let failed = false;
    try {
      await testApi.sendReport(0, 0, [1, 2, 3]);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  // ── input report ───────────────────────────────────────────────────────

  test('receive input report from uhid-mock', async ({ sharedPage, uhidMock, testApi }) => {
    const devices = await ensureDevicePaired(sharedPage, testApi);
    const idx = devices[0].index;
    await testApi.open(idx);

    const reportPromise = testApi.onInputReport(idx);
    sendInput(uhidMock, 1, [0xAB, 0xCD, 0xEF]);

    const event = await reportPromise;
    expect(event.reportId).toBe(0);
    expect(event.data).toEqual([0xAB, 0xCD, 0xEF]);
    expect(event.device.vendorId).toBe(0x1234);
    expect(event.device.productId).toBe(0x5678);
  });

  test('receive input report without report ID', async ({ sharedPage, uhidMock, testApi }) => {
    const devices = await ensureDevicePaired(sharedPage, testApi);
    const idx = devices[0].index;
    await testApi.open(idx);

    const reportPromise = testApi.onInputReport(idx);
    sendInput(uhidMock, undefined, [0x01, 0x02]);

    const event = await reportPromise;
    expect(event.reportId).toBe(0);
    expect(event.data).toEqual([0x01, 0x02]);
  });

  test('receive multiple input reports', async ({ sharedPage, uhidMock, testApi }) => {
    const devices = await ensureDevicePaired(sharedPage, testApi);
    const idx = devices[0].index;
    await testApi.open(idx);

    for (let i = 0; i < 3; i++) {
      const reportPromise = testApi.onInputReport(idx);
      sendInput(uhidMock, 1, [i, i + 1, i + 2]);
      const event = await reportPromise;
      expect(event.reportId).toBe(0);
      expect(event.data[0]).toBe(i);
    }
  });

  // ── send report ────────────────────────────────────────────────────────

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

    await testApi.sendReport(idx, 0, [0x01]);
    await testApi.sendReport(idx, 0, [0x10, 0x20, 0x30, 0x40]);
  });

  test('sendReport resolves on completion', async ({ uhidMock, testApi }) => {
    const devices = await testApi.getDevices();
    const idx = devices[0].index;
    await testApi.open(idx);

    await testApi.sendReport(idx, 0, [0xDE, 0xAD, 0xBE, 0xEF]);
  });
});
