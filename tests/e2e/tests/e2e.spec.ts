import { test, expect } from "../helpers/fixtures.js";
import {
  grantDevicePermission,
  ensureDevicePaired,
} from "../helpers/devices.js";
import { sendInput, waitForOutputReport } from "../helpers/process.js";

// Nintendo Switch Pro Controller constants
const VID = 0x16c0;
const PID = 0x0001;

// Full 64-byte input report packet: 0x30 (report ID) + 63 bytes payload.
// We use a generic mock VID/PID (0x16C0/0x0001) that does NOT match any
// real kernel HID driver, so no kernel driver binds to the uhid device.
// This avoids interference from e.g. hid-nintendo which would claim the
// Switch Pro VID/PID (0x057E/0x2009) and send GET_REPORT/SET_REPORT
// requests that must be replied to.
// Collection parsing is covered by a Rust unit test
// (crates/webhid-daemon/src/descriptor.rs: test_switchpro_descriptor).
const PACKET_SIZE = 64;

test.describe.serial("Switch Pro Gamepad E2E", () => {
  test.beforeEach(async ({ testApi }) => {
    await testApi.resetDeviceState();
    await testApi.getDevices();
  });

  test("navigator.hid is polyfilled", async ({ testApi }) => {
    expect(await testApi.isPolyfillLoaded()).toBe(true);
  });

  test("grant permission and verify VID/PID, collections", async ({ sharedPage }) => {
    const devices = await grantDevicePermission(sharedPage);
    expect(devices.length).toBe(1);
    const device = devices[0];
    expect(device.vendorId).toBe(VID);
    expect(device.productId).toBe(PID);
    expect(device.collections.length).toBe(1);
  });

  test("sendReport fails before open", async ({ testApi }) => {
    let failed = false;
    try {
      await testApi.sendReport(0, 0x01, new Array(63).fill(0));
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  test("open and close device", async ({ testApi }) => {
    const devices = await testApi.getDevices();
    expect(devices.length).toBe(1);
    await testApi.open(devices[0].index);
    await testApi.close(devices[0].index);
  });

  test("open and close multiple times", async ({ testApi }) => {
    const devices = await testApi.getDevices();
    for (let i = 0; i < 3; i++) {
      await testApi.open(0);
      await testApi.close(0);
    }
  });

  test("receive 64-byte input packet", async ({
    sharedPage,
    uhidMock,
    testApi,
  }) => {
    const devices = await ensureDevicePaired(sharedPage, testApi);
    await testApi.open(devices[0].index);

    const reportPromise = testApi.onInputReport(devices[0].index);
    await new Promise(resolve => setTimeout(resolve, 200));
    // Send raw packet: 0x30 (report ID) + 63 zero bytes
    sendInput(uhidMock, 0x30, new Array(PACKET_SIZE).fill(0));

    const event = await reportPromise;
    expect(event.reportId).toBe(0x30);
    expect(event.data.length).toBe(PACKET_SIZE);
  });

  test("receive input packet with button press", async ({
    sharedPage,
    uhidMock,
    testApi,
  }) => {
    const devices = await ensureDevicePaired(sharedPage, testApi);
    await testApi.open(devices[0].index);

    // Raw packet: byte 0 = report ID (0x30), byte 1 = buttons 1-8
    const packet = new Array(PACKET_SIZE).fill(0);
    packet[0] = 0x30;  // report ID (treated as data by daemon)
    packet[1] = 0xff;  // buttons 1-8 pressed

    const reportPromise = testApi.onInputReport(devices[0].index);
    await new Promise(resolve => setTimeout(resolve, 200));
    sendInput(uhidMock, 0x30, packet);

    const event = await reportPromise;
    expect(event.reportId).toBe(0x30);
    expect(event.data.length).toBe(PACKET_SIZE);
    expect(event.data[0]).toBe(0x30);
    expect(event.data[1]).toBe(0xff);
  });

  test("sendReport succeeds with output report ID after open", async ({
    sharedPage,
    uhidMock,
    testApi,
  }) => {
    const devices = await ensureDevicePaired(sharedPage, testApi);
    await testApi.open(devices[0].index);

    // Switch Pro descriptor has vendor-defined output report ID 0x01 (63 bytes)
    const reportData = new Array(63).fill(0x42);
    const outputPromise = waitForOutputReport(uhidMock);
    await new Promise(resolve => setTimeout(resolve, 200));
    await testApi.sendReport(0, 0x01, reportData);
    const output = await outputPromise;
    // Daemon prepends report ID (0x01) to payload when writing
    expect(output.data[0]).toBe(0x01);
  });
});
