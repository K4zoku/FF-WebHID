import { test, expect } from '../helpers/browser.js';
import type { Page } from '@playwright/test';

type BackgroundPage = { evaluate: Page['evaluate'] };

interface CspInfo {
  workerSrc?: string;
  connectSrc?: string;
  workerSrcBlocked: boolean;
  connectSrcBlocked: boolean;
  hasTrustedTypesRequire: boolean;
  shadowBlocked: boolean;
  headerShadowBlocked?: boolean;
  metaShadowBlocked?: boolean;
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
    expect(cspInfo.workerSrcBlocked).toBe(true);
    expect(cspInfo.connectSrcBlocked).toBe(true);
    expect(cspInfo.headerShadowBlocked).toBe(true);
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
    expect(cspInfo.metaShadowBlocked).toBe(true);
    expect(cspInfo.headerShadowBlocked).toBeFalsy();
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

  test('default-src none: worker and connect both blocked via fallback', async ({ backgroundPage, sharedPage, pageUrl }) => {
    await clearSession(backgroundPage);
    await sharedPage.goto(pageUrl('/worker-spawn-csp-default-none'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const entries = await readCspEntries(backgroundPage);
    const cspInfo = entries[0];
    expect(cspInfo.workerSrcBlocked).toBe(true);
    expect(cspInfo.connectSrcBlocked).toBe(true);
    expect(cspInfo.needsBlobFallback).toBe(true);
  });

  test('script-src none: worker blocked via script-src fallback, connect unrestricted', async ({ backgroundPage, sharedPage, pageUrl }) => {
    await clearSession(backgroundPage);
    await sharedPage.goto(pageUrl('/worker-spawn-csp-script-none'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const entries = await readCspEntries(backgroundPage);
    const cspInfo = entries[0];
    expect(cspInfo.workerSrcBlocked).toBe(true);
    expect(cspInfo.connectSrcBlocked).toBe(false);
    expect(cspInfo.needsBlobFallback).toBe(true);
  });

  test('default-src self: worker allowed, connect blocked', async ({ backgroundPage, sharedPage, pageUrl }) => {
    await clearSession(backgroundPage);
    await sharedPage.goto(pageUrl('/worker-spawn-csp-default-self'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const entries = await readCspEntries(backgroundPage);
    const cspInfo = entries[0];
    expect(cspInfo.workerSrcBlocked).toBe(false);
    expect(cspInfo.connectSrcBlocked).toBe(true);
    expect(cspInfo.needsBlobFallback).toBe(true);
  });

  test('worker-src none alone: worker blocked only', async ({ backgroundPage, sharedPage, pageUrl }) => {
    await clearSession(backgroundPage);
    await sharedPage.goto(pageUrl('/worker-spawn-csp-worker-none'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const entries = await readCspEntries(backgroundPage);
    const cspInfo = entries[0];
    expect(cspInfo.workerSrcBlocked).toBe(true);
    expect(cspInfo.connectSrcBlocked).toBe(false);
    expect(cspInfo.needsBlobFallback).toBe(true);
  });

  test('report-only CSP is ignored', async ({ backgroundPage, sharedPage, pageUrl }) => {
    await clearSession(backgroundPage);
    await sharedPage.goto(pageUrl('/worker-spawn-csp-report-only'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const count = await backgroundPage.evaluate(async () => {
      const all = await browser.storage.session.get(null);
      return Object.keys(all).filter((k) => k.startsWith('csp:')).length;
    });
    expect(count).toBe(0);
  });

  test('multiple CSP headers: a resource must pass every policy', async ({ backgroundPage, sharedPage, pageUrl }) => {
    await clearSession(backgroundPage);
    await sharedPage.goto(pageUrl('/worker-spawn-csp-multi'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const entries = await readCspEntries(backgroundPage);
    const cspInfo = entries[0];
    expect(cspInfo.workerSrcBlocked).toBe(false);
    expect(cspInfo.connectSrcBlocked).toBe(true);
    expect(cspInfo.needsBlobFallback).toBe(true);
  });

  test('duplicate directive: first occurrence wins', async ({ backgroundPage, sharedPage, pageUrl }) => {
    await clearSession(backgroundPage);
    await sharedPage.goto(pageUrl('/worker-spawn-csp-dup'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const entries = await readCspEntries(backgroundPage);
    const cspInfo = entries[0];
    expect(cspInfo.workerSrcBlocked).toBe(false);
    expect(cspInfo.needsBlobFallback).toBe(false);
  });

  test('wildcard and ws: scheme sources: no fallback needed', async ({ backgroundPage, sharedPage, pageUrl }) => {
    for (const route of ['/worker-spawn-csp-star', '/worker-spawn-csp-ws-scheme']) {
      await clearSession(backgroundPage);
      await sharedPage.goto(pageUrl(route), { waitUntil: 'domcontentloaded', timeout: 15000 });
      const entries = await readCspEntries(backgroundPage);
      expect(entries[0].needsBlobFallback).toBe(false);
    }
  });

  test('rewrite creates worker-src from the script-src fallback', async ({ backgroundPage, sharedPage, pageUrl }) => {
    await clearSession(backgroundPage);
    await sharedPage.goto(pageUrl('/worker-spawn-csp-rewrite-script'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const entries = await readCspEntries(backgroundPage);
    const cspInfo = entries[0];
    expect(cspInfo.needsBlobFallback).toBe(true);
    if (await isMv2(backgroundPage)) {
      expect(cspInfo.rewrittenCsp).toBeTruthy();
      const rewritten = cspInfo.rewrittenCsp![0];
      expect(rewritten).toContain("worker-src 'self' blob:");
      expect(rewritten).toContain("script-src 'self'");
      expect(rewritten).not.toContain("script-src 'self' blob:");
      expect(rewritten).toContain("connect-src 'self' ws://127.0.0.1:*");
    } else {
      expect(cspInfo.rewrittenCsp).toBeUndefined();
    }
  });

  test('rewrite creates worker-src and connect-src from the default-src fallback', async ({ backgroundPage, sharedPage, pageUrl }) => {
    await clearSession(backgroundPage);
    await sharedPage.goto(pageUrl('/worker-spawn-csp-rewrite-default'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const entries = await readCspEntries(backgroundPage);
    const cspInfo = entries[0];
    expect(cspInfo.needsBlobFallback).toBe(true);
    if (await isMv2(backgroundPage)) {
      expect(cspInfo.rewrittenCsp).toBeTruthy();
      const rewritten = cspInfo.rewrittenCsp![0];
      expect(rewritten).toContain("worker-src 'self' blob:");
      expect(rewritten).toContain("connect-src 'self' ws://127.0.0.1:*");
      expect(rewritten).toContain("default-src 'self'");
      expect(rewritten).not.toContain("default-src 'self' blob:");
    } else {
      expect(cspInfo.rewrittenCsp).toBeUndefined();
    }
  });

  test('rewrite is a no-op when the policy already allows blob and the daemon WS', async ({ backgroundPage, sharedPage, pageUrl, servers }) => {
    const origin = `http://localhost:${servers.main.port}`;
    const siteKey = `settings :: ${origin} :: workerSpawnMode`;
    await clearSession(backgroundPage);
    await backgroundPage.evaluate((key) => browser.storage.local.set({ [key]: 'blob' }), siteKey);

    await sharedPage.goto(pageUrl('/worker-spawn-csp-allowing'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const entries = await readCspEntries(backgroundPage);

    await backgroundPage.evaluate((key) => browser.storage.local.remove([key]), siteKey);

    const cspInfo = entries[0];
    expect(cspInfo.needsBlobFallback).toBe(true);
    expect(cspInfo.rewrittenCsp).toBeUndefined();
  });

  test('rewrite appends webhid-worker to an existing trusted-types list', async ({ backgroundPage, sharedPage, pageUrl }) => {
    await clearSession(backgroundPage);
    await sharedPage.goto(pageUrl('/worker-spawn-csp-tt-append'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const entries = await readCspEntries(backgroundPage);
    const cspInfo = entries[0];
    expect(cspInfo.hasTrustedTypesRequire).toBe(true);
    if (await isMv2(backgroundPage)) {
      expect(cspInfo.rewrittenCsp).toBeTruthy();
      expect(cspInfo.rewrittenCsp![0]).toContain('trusted-types foo webhid-worker');
    } else {
      expect(cspInfo.rewrittenCsp).toBeUndefined();
    }
  });

  test('rewrite adds a trusted-types directive when absent', async ({ backgroundPage, sharedPage, pageUrl }) => {
    await clearSession(backgroundPage);
    await sharedPage.goto(pageUrl('/worker-spawn-csp-tt-new'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const entries = await readCspEntries(backgroundPage);
    const cspInfo = entries[0];
    expect(cspInfo.hasTrustedTypesRequire).toBe(true);
    if (await isMv2(backgroundPage)) {
      expect(cspInfo.rewrittenCsp).toBeTruthy();
      expect(cspInfo.rewrittenCsp![0]).toContain('trusted-types webhid-worker');
    } else {
      expect(cspInfo.rewrittenCsp).toBeUndefined();
    }
  });

  test('header and meta CSP together: flags merged', async ({ backgroundPage, sharedPage, pageUrl }) => {
    await clearSession(backgroundPage);
    await sharedPage.goto(pageUrl('/worker-spawn-csp-both'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const entries = await readCspEntries(backgroundPage);
    const cspInfo = entries[0];
    expect(cspInfo.workerSrcBlocked).toBe(true);
    expect(cspInfo.connectSrcBlocked).toBe(true);
    expect(cspInfo.headerShadowBlocked).toBe(true);
    expect(cspInfo.metaShadowBlocked).toBe(true);
    const blobStatus = await waitForStatus(sharedPage, 'blob-status');
    expect(blobStatus).toBe('blob-ready');
  });

  test('navigating from a CSP page to a no-CSP page clears the entry', async ({ backgroundPage, sharedPage, pageUrl }) => {
    await clearSession(backgroundPage);
    await sharedPage.goto(pageUrl('/worker-spawn-csp'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    await readCspEntries(backgroundPage);
    await sharedPage.goto(pageUrl('/worker-spawn-no-csp'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    await expect.poll(() => backgroundPage.evaluate(async () => {
      const all = await browser.storage.session.get(null);
      return Object.keys(all).filter((k) => k.startsWith('csp:')).length;
    }), { timeout: 5000 }).toBe(0);
  });
});
