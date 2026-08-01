import { test, expect } from '../helpers/browser.js';
import type { Page } from '@playwright/test';

type BackgroundPage = { evaluate: Page['evaluate'] };

interface CspInfo {
  workerSrcBlocked: boolean;
  connectSrcBlocked: boolean;
  hasTrustedTypesRequire: boolean;
  shadowWorkerBlocked: boolean;
}

async function readCspEntries(backgroundPage: BackgroundPage): Promise<CspInfo[]> {
  await expect.poll(() => backgroundPage.evaluate(async () => {
    const all: Record<string, unknown> = await browser.storage.session.get(null);
    return Object.keys(all).filter((k) => k.startsWith('csp:')).length;
  }), { timeout: 5000 }).toBeGreaterThan(0);
  return backgroundPage.evaluate(async () => {
    const all: Record<string, unknown> = await browser.storage.session.get(null);
    return Object.entries(all)
      .filter(([k]) => k.startsWith('csp:'))
      .map(([, v]) => v)
      .filter((v): v is CspInfo => typeof v === 'object' && v !== null && 'shadowWorkerBlocked' in v);
  });
}

async function clearSession(backgroundPage: BackgroundPage): Promise<void> {
  await backgroundPage.evaluate(async () => { await browser.storage.session.clear(); });
}

test.describe('CSP shadow-worker detection', () => {
  test('no CSP: no csp session entry', async ({ backgroundPage, sharedPage, pageUrl }) => {
    await clearSession(backgroundPage);
    await sharedPage.goto(pageUrl('/worker-spawn-no-csp'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const count = await backgroundPage.evaluate(async () => {
      const all: Record<string, unknown> = await browser.storage.session.get(null);
      return Object.keys(all).filter((k) => k.startsWith('csp:')).length;
    });
    expect(count).toBe(0);
  });

  test('restrictive CSP: both worker-src and connect-src blocked', async ({ backgroundPage, sharedPage, pageUrl }) => {
    await clearSession(backgroundPage);
    await sharedPage.goto(pageUrl('/worker-spawn-csp-restrictive'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const entries = await readCspEntries(backgroundPage);
    expect(entries.length).toBeGreaterThan(0);
    const cspInfo = entries[0];
    expect(cspInfo.workerSrcBlocked).toBe(true);
    expect(cspInfo.connectSrcBlocked).toBe(true);
    expect(cspInfo.shadowWorkerBlocked).toBe(true);
  });

  test('worker-src self + connect-src self: blocked by connect-src only', async ({ backgroundPage, sharedPage, pageUrl }) => {
    await clearSession(backgroundPage);
    await sharedPage.goto(pageUrl('/worker-spawn-csp'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const entries = await readCspEntries(backgroundPage);
    expect(entries.length).toBeGreaterThan(0);
    const cspInfo = entries[0];
    expect(cspInfo.workerSrcBlocked).toBe(false);
    expect(cspInfo.connectSrcBlocked).toBe(true);
    expect(cspInfo.shadowWorkerBlocked).toBe(true);
  });

  test('connect-src-only CSP blocks the daemon WS', async ({ backgroundPage, sharedPage, pageUrl }) => {
    await clearSession(backgroundPage);
    await sharedPage.goto(pageUrl('/worker-spawn-csp-connect'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const entries = await readCspEntries(backgroundPage);
    expect(entries.length).toBeGreaterThan(0);
    const cspInfo = entries[0];
    expect(cspInfo.connectSrcBlocked).toBe(true);
    expect(cspInfo.workerSrcBlocked).toBe(false);
    expect(cspInfo.shadowWorkerBlocked).toBe(true);
  });

  test('allowing CSP: shadow worker not blocked', async ({ backgroundPage, sharedPage, pageUrl }) => {
    await clearSession(backgroundPage);
    await sharedPage.goto(pageUrl('/worker-spawn-csp-allowing'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const entries = await readCspEntries(backgroundPage);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].shadowWorkerBlocked).toBe(false);
  });

  test('require-trusted-types-for script blocks the shadow worker', async ({ backgroundPage, sharedPage, pageUrl }) => {
    await clearSession(backgroundPage);
    await sharedPage.goto(pageUrl('/worker-spawn-csp-trusted-types'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const entries = await readCspEntries(backgroundPage);
    expect(entries.length).toBeGreaterThan(0);
    const cspInfo = entries[0];
    expect(cspInfo.hasTrustedTypesRequire).toBe(true);
    expect(cspInfo.shadowWorkerBlocked).toBe(true);
  });
});
