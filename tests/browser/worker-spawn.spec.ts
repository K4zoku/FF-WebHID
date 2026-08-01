import { test, expect } from '../helpers/browser.js';
import type { Page } from '@playwright/test';

type BackgroundPage = { evaluate: Page['evaluate'] };

interface CspInfo {
  workerSrc?: string;
  connectSrc?: string;
  workerSrcBlocked: boolean;
  connectSrcBlocked: boolean;
  hasTrustedTypesRequire: boolean;
  needsBlobFallback: boolean;
  rewrittenCsp?: string[];
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
      .filter((v): v is CspInfo => typeof v === 'object' && v !== null && 'needsBlobFallback' in v);
  });
}

async function clearSession(backgroundPage: BackgroundPage): Promise<void> {
  await backgroundPage.evaluate(async () => { await browser.storage.session.clear(); });
}

async function isMv2(backgroundPage: BackgroundPage): Promise<boolean> {
  return backgroundPage.evaluate(() => browser.runtime.getManifest().manifest_version === 2);
}

async function waitForStatus(sharedPage: Page, id: string): Promise<string | null | undefined> {
  await sharedPage.waitForFunction(
    (elId) => document.getElementById(elId)?.textContent !== 'loading',
    id,
    { timeout: 10000 },
  );
  return sharedPage.evaluate((elId) => document.getElementById(elId)?.textContent, id);
}

test.describe('Worker spawn mode detection', () => {
  test('no CSP: blob worker allowed, no csp session entry', async ({ backgroundPage, sharedPage, pageUrl }) => {
    await clearSession(backgroundPage);
    await sharedPage.goto(pageUrl('/worker-spawn-no-csp'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const status = await waitForStatus(sharedPage, 'blob-status');
    expect(status).toBe('blob-ready');
    const count = await backgroundPage.evaluate(async () => {
      const all = await browser.storage.session.get(null);
      return Object.keys(all).filter((k) => k.startsWith('csp:')).length;
    });
    expect(count).toBe(0);
  });

  test('restrictive CSP: rewrite allows blob worker, same-origin still blocked', async ({ backgroundPage, sharedPage, pageUrl }) => {
    await clearSession(backgroundPage);
    await sharedPage.goto(pageUrl('/worker-spawn-csp-restrictive'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const entries = await readCspEntries(backgroundPage);
    expect(entries.length).toBeGreaterThan(0);
    const cspInfo = entries[0];
    expect(cspInfo.needsBlobFallback).toBe(true);
    if (await isMv2(backgroundPage)) {
      expect(cspInfo.rewrittenCsp).toBeTruthy();
      const rewritten = cspInfo.rewrittenCsp![0];
      expect(rewritten).toContain("worker-src 'none' blob:");
      expect(rewritten).toContain("connect-src 'none' ws://127.0.0.1:*");
      expect(rewritten).not.toContain('script-src');
      expect(rewritten).not.toContain('default-src');
    } else {
      expect(cspInfo.rewrittenCsp).toBeUndefined();
    }
    const sameOriginStatus = await waitForStatus(sharedPage, 'same-origin-status');
    expect(sameOriginStatus).toMatch(/^same-origin-(error|threw|timeout)/);
  });

  test('worker-src self + connect-src self: fallback triggered by connect-src only', async ({ backgroundPage, sharedPage, pageUrl }) => {
    await clearSession(backgroundPage);
    await sharedPage.goto(pageUrl('/worker-spawn-csp'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const entries = await readCspEntries(backgroundPage);
    expect(entries.length).toBeGreaterThan(0);
    const cspInfo = entries[0];
    expect(cspInfo.workerSrcBlocked).toBe(false);
    expect(cspInfo.connectSrcBlocked).toBe(true);
    expect(cspInfo.needsBlobFallback).toBe(true);
  });

  test('connect-src-only CSP triggers fallback', async ({ backgroundPage, sharedPage, pageUrl }) => {
    await clearSession(backgroundPage);
    await sharedPage.goto(pageUrl('/worker-spawn-csp-connect'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const entries = await readCspEntries(backgroundPage);
    expect(entries.length).toBeGreaterThan(0);
    const cspInfo = entries[0];
    expect(cspInfo.connectSrcBlocked).toBe(true);
    expect(cspInfo.workerSrcBlocked).toBe(false);
    expect(cspInfo.needsBlobFallback).toBe(true);
  });

  test('allowing CSP: no fallback needed', async ({ backgroundPage, sharedPage, pageUrl }) => {
    await clearSession(backgroundPage);
    await sharedPage.goto(pageUrl('/worker-spawn-csp-allowing'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const entries = await readCspEntries(backgroundPage);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].needsBlobFallback).toBe(false);
    const status = await waitForStatus(sharedPage, 'blob-status');
    expect(status).toBe('blob-ready');
  });

  test('trusted-types page triggers fallback detection', async ({ backgroundPage, sharedPage, pageUrl }) => {
    await clearSession(backgroundPage);
    await sharedPage.goto(pageUrl('/worker-spawn-csp-trusted-types'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const entries = await readCspEntries(backgroundPage);
    expect(entries.length).toBeGreaterThan(0);
    const cspInfo = entries[0];
    expect(cspInfo.hasTrustedTypesRequire).toBe(true);
    expect(cspInfo.needsBlobFallback).toBe(true);
  });

  test('meta CSP: rewritten via StreamFilter, blob worker runs', async ({ backgroundPage, sharedPage, pageUrl }) => {
    await clearSession(backgroundPage);
    await sharedPage.goto(pageUrl('/worker-spawn-csp-meta'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const entries = await readCspEntries(backgroundPage);
    expect(entries.length).toBeGreaterThan(0);
    const cspInfo = entries[0];
    expect(cspInfo.workerSrcBlocked).toBe(true);
    expect(cspInfo.connectSrcBlocked).toBe(true);
    expect(cspInfo.needsBlobFallback).toBe(true);
    const blobStatus = await waitForStatus(sharedPage, 'blob-status');
    expect(blobStatus).toBe('blob-ready');
    const sameOriginStatus = await waitForStatus(sharedPage, 'same-origin-status');
    expect(sameOriginStatus).toMatch(/^same-origin-(error|threw|timeout)/);
  });

  test('site setting blob forces fallback and rewrite', async ({ backgroundPage, sharedPage, pageUrl, servers }) => {
    const origin = `http://localhost:${servers.main.port}`;
    const siteKey = `settings :: ${origin} :: workerSpawnMode`;
    await clearSession(backgroundPage);
    await backgroundPage.evaluate((key) => browser.storage.local.set({ [key]: 'blob' }), siteKey);

    await sharedPage.goto(pageUrl('/worker-spawn-csp'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const entries = await readCspEntries(backgroundPage);

    await backgroundPage.evaluate((key) => browser.storage.local.remove([key]), siteKey);

    expect(entries.length).toBeGreaterThan(0);
    const cspInfo = entries[0];
    expect(cspInfo.needsBlobFallback).toBe(true);
    if (await isMv2(backgroundPage)) {
      expect(cspInfo.rewrittenCsp).toBeTruthy();
      const rewritten = cspInfo.rewrittenCsp![0];
      expect(rewritten).toContain("worker-src 'self' blob:");
      expect(rewritten).toContain("connect-src 'self' ws://127.0.0.1:*");
    } else {
      expect(cspInfo.rewrittenCsp).toBeUndefined();
    }
  });
});
