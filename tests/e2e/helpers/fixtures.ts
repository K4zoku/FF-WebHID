import { test as base, type Page, expect } from '@playwright/test';
import { createRequire } from 'module';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { startServer } from './serve.mjs';
import {
  startDaemon, stopDaemon,
  startUhidMock, stopUhidMock,
  installNmManifest, uninstallNmManifest, DEFAULT_SOCKET,
  type DaemonProcess, type UhidMockProcess,
} from './process.js';
import type { WebHidTestAPI } from './types.js';

const require = createRequire(import.meta.url);
const { applyFirefoxHarness } = require('firefox-webext-playwright-harness');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function createTestApi(page: Page): WebHidTestAPI {
  return {
    isPolyfillLoaded: () =>
      page.evaluate(() => (window as any).__webhidTest.isPolyfillLoaded()),
    getDevices: () =>
      page.evaluate(() => (window as any).__webhidTest.getDevices()),
    requestDevice: (filters?: any[]) =>
      page.evaluate((f: any[]) => (window as any).__webhidTest.requestDevice(f), filters),
    deviceInfo: (index: number) =>
      page.evaluate((i: number) => (window as any).__webhidTest.deviceInfo(i), index),
    open: (index: number) =>
      page.evaluate((i: number) => (window as any).__webhidTest.open(i), index),
    close: (index: number) =>
      page.evaluate((i: number) => (window as any).__webhidTest.close(i), index),
    sendReport: (index: number, reportId: number, data: number[]) =>
      page.evaluate(
        (args: { i: number; rId: number; arr: number[] }) =>
          (window as any).__webhidTest.sendReport(args.i, args.rId, args.arr),
        { i: index, rId: reportId, arr: data },
      ),
    onInputReport: (index: number) =>
      page.evaluate((i: number) => (window as any).__webhidTest.onInputReport(i), index),
    resetDeviceState: () =>
      page.evaluate(() => (window as any).__webhidTest.resetDeviceState()),
  };
}

const harnessTest = applyFirefoxHarness(base, {
  defaultRouteHandler: (route: any) => route.continue(),
});

export const test = harnessTest.extend<{
  daemon: DaemonProcess;
  uhidMock: UhidMockProcess;
  httpPort: number;
  sharedPage: Page;
  testApi: WebHidTestAPI;
}>({
  daemon: [async ({}, use) => {
    const d = await startDaemon();
    await use(d);
    stopDaemon(d);
  }, { scope: 'worker', auto: true }],

  uhidMock: [async ({}, use) => {
    const m = await startUhidMock('switchpro-gamepad.bin', 0x16c0, 0x0001);
    await m.ready;
    await use(m);
    stopUhidMock(m);
  }, { scope: 'worker', auto: true }],

  httpPort: [async ({}, use) => {
    const { port, server } = await startServer();
    await use(port);
    server.close();
  }, { scope: 'worker', auto: true }],

  nmManifest: [async ({}, use) => {
    await installNmManifest(DEFAULT_SOCKET);
    await use();
    uninstallNmManifest();
  }, { scope: 'worker', auto: true }],

  sharedPage: [async ({ page, httpPort }, use) => {
    const url = `http://localhost:${httpPort}/tests/e2e/test-page.html`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForFunction(
      () => typeof (window as any).__webhidTest !== 'undefined',
      { timeout: 15000 },
    );
    await use(page);
  }, { scope: 'test' }],

  testApi: [async ({ sharedPage }, use) => {
    await use(createTestApi(sharedPage));
  }, { scope: 'test' }],

  beforeEach: [async ({ testApi }, use) => {
    await use();
  }, { scope: 'test', auto: true }],
});

export { expect };
