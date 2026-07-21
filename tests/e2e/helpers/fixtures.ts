import { test as base, type Page, type BrowserContext, firefox, expect } from '@playwright/test';
import { withExtension } from 'playwright-webextext';
import { mkdtempSync } from 'fs';
import { rm } from 'fs/promises';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { startServer } from './serve.mjs';
import {
  startDaemon, stopDaemon,
  startUhidMock, stopUhidMock,
  installNmManifest, uninstallNmManifest, DEFAULT_SOCKET,
  type DaemonProcess, type UhidMockProcess,
} from './process.js';
import type { WebHidTestAPI } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ADDON_PATH = resolve(__dirname, '..', '..', '..', 'addon');

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

export const test = base.extend<{
  daemon: DaemonProcess;
  uhidMock: UhidMockProcess;
  httpPort: number;
  browserCtx: BrowserContext;
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

  browserCtx: [async ({}, use) => {
    await installNmManifest(DEFAULT_SOCKET);
    const profileDir = mkdtempSync(join(os.tmpdir(), 'webhid-e2e-'));
    const browserType = withExtension(firefox, ADDON_PATH);
    const ctx = await browserType.launchPersistentContext(profileDir, { headless: false });
    await use(ctx);
    await ctx.close();
    try { await rm(profileDir, { recursive: true, force: true }); } catch {}
    uninstallNmManifest();
  }, { scope: 'worker' }],

  sharedPage: [async ({ browserCtx, httpPort }, use) => {
    const pages = browserCtx.pages();
    const page = (pages.length == 0) ? await browserCtx.newPage() : pages[0];
    const url = `http://localhost:${httpPort}/tests/e2e/test-page.html`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForFunction(
      () => typeof (window as any).__webhidTest !== 'undefined',
      { timeout: 15000 },
    );
    await use(page);
  }, { scope: 'worker' }],

  testApi: [async ({ sharedPage }, use) => {
    await use(createTestApi(sharedPage));
  }, { scope: 'worker' }],

  beforeEach: [async ({ testApi }, use) => {
    await use();
  }, { scope: 'worker', auto: true }],
});

export { expect };
