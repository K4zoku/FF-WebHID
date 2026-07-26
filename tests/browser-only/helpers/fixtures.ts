import { test as base, type Page, type BrowserContext, firefox, expect } from '@playwright/test';
import { withExtension } from 'playwright-webextext';
import { mkdtempSync } from 'fs';
import { rm } from 'fs/promises';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { startServer } from '../serve.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ADDON_PATH = resolve(__dirname, '..', '..', '..', 'addon');
const MAIN_PORT = 3080;
const CROSS_PORT = 3081;

type Servers = { main: { port: number; server: any }; cross: { port: number; server: any } };

export const test = base.extend<{
  servers: Servers;
  browserCtx: BrowserContext;
  mainPage: Page;
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

  browserCtx: [async ({}, use) => {
    const profileDir = mkdtempSync(join(os.tmpdir(), 'webhid-browser-'));
    const browserType = withExtension(firefox, ADDON_PATH);
    const ctx = await browserType.launchPersistentContext(profileDir, { headless: true });
    await use(ctx);
    await ctx.close();
    try { await rm(profileDir, { recursive: true, force: true }); } catch {}
  }, { scope: 'worker' }],

  mainPage: [async ({ browserCtx }, use) => {
    const pages = browserCtx.pages();
    const page = pages.length === 0 ? await browserCtx.newPage() : pages[0];
    await use(page);
  }, { scope: 'worker' }],

  pageUrl: [async ({}, use) => {
    await use((path: string) => `http://localhost:${MAIN_PORT}${path}`);
  }, { scope: 'worker' }],

  crossUrl: [async ({}, use) => {
    await use((path: string) => `http://localhost:${CROSS_PORT}${path}`);
  }, { scope: 'worker' }],
});

export { expect };
