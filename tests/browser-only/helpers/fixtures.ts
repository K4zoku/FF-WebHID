import { test as base, expect } from '@playwright/test';
import { createRequire } from 'module';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { startServer } from '../serve.mjs';

const require = createRequire(import.meta.url);
const { applyFirefoxHarness } = require('firefox-webext-playwright-harness');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ADDON_PATH = resolve(__dirname, '..', '..', '..', 'addon');
const MAIN_PORT = 3080;
const CROSS_PORT = 3081;

type Servers = { main: { port: number; server: any }; cross: { port: number; server: any } };

const harnessTest = applyFirefoxHarness(base, {
  defaultRouteHandler: (route: any) => route.continue(),
});

export const test = harnessTest.extend<{
  servers: Servers;
  mainPage: any;
  pageUrl: (path: string) => string;
  crossUrl: (path: string) => string;
}>({
  servers: [async ({}, use) => {
    const main = await startServer(MAIN_PORT);
    const cross = await startServer(CROSS_PORT);
    const s: Servers = { main, cross };
    await use(s);
    main.server.close();
    cross.server.close();
  }, { scope: 'worker', auto: true }],

  mainPage: [async ({ page }, use) => {
    await use(page);
  }, { scope: 'test' }],

  pageUrl: [async ({}, use) => {
    await use((path: string) => `http://localhost:${MAIN_PORT}${path}`);
  }, { scope: 'worker' }],

  crossUrl: [async ({}, use) => {
    await use((path: string) => `http://localhost:${CROSS_PORT}${path}`);
  }, { scope: 'worker' }],
});

export { expect };
