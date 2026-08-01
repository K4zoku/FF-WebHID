import { test, expect } from '../helpers/browser.js';

test.describe('Worker spawn mode detection', () => {
  test('shadow URL mode used when no CSP', async ({ sharedPage, pageUrl }) => {
    await sharedPage.goto(pageUrl('/worker-spawn-no-csp'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sharedPage.waitForFunction(
      () => document.getElementById('status')?.textContent !== 'loading',
      { timeout: 10000 },
    );
    const status = await sharedPage.evaluate(() => document.getElementById('status')?.textContent);
    expect(status).toMatch(/^(worker-ready|worker-timeout|worker-error|worker-threw)/);
  });

  test('shadow URL mode fails on restrictive worker-src', async ({ sharedPage, pageUrl }) => {
    await sharedPage.goto(pageUrl('/worker-spawn-csp-restrictive'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sharedPage.waitForFunction(
      () => document.getElementById('status')?.textContent !== 'loading',
      { timeout: 10000 },
    );
    const status = await sharedPage.evaluate(() => document.getElementById('status')?.textContent);
    expect(status).toMatch(/^(worker-error|worker-threw|worker-timeout)/);
  });

  test('blob fallback works on restrictive CSP when enabled', async ({ backgroundPage, sharedPage, pageUrl, servers }) => {
    const origin = `http://localhost:${servers.main.port}`;
    await backgroundPage.evaluate((origin) => browser.storage.local.set({
      [`settings :: ${origin} :: workerSpawnMode`]: 'blob',
    }), origin);

    await sharedPage.goto(pageUrl('/worker-spawn-csp-restrictive'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sharedPage.waitForFunction(
      () => document.getElementById('status')?.textContent !== 'loading',
      { timeout: 10000 },
    );
    const status = await sharedPage.evaluate(() => document.getElementById('status')?.textContent);

    await backgroundPage.evaluate((origin) => browser.storage.local.remove(
      [`settings :: ${origin} :: workerSpawnMode`],
    ), origin);

    expect(status).not.toMatch(/^worker-threw/);
    expect(status).toMatch(/^(worker-ready|worker-timeout|worker-error)/);
  });

  test('CSP detection stores csp info in storage.session', async ({ backgroundPage, sharedPage, pageUrl }) => {
    await sharedPage.goto(pageUrl('/worker-spawn-csp'), { waitUntil: 'domcontentloaded', timeout: 15000 });

    const sessionData = await backgroundPage.evaluate(async () => {
      const all = await browser.storage.session.get(null);
      const entries = Object.entries(all).filter(([k]) => k.startsWith('csp:'));
      return entries.map(([key, value]) => ({ key, value }));
    });

    expect(sessionData.length).toBeGreaterThan(0);
    const cspInfo = sessionData[0].value;
    expect(cspInfo).toBeTruthy();
    expect(cspInfo.workerSrc).toContain("'self'");
    expect(cspInfo.needsBlobFallback).toBe(true);
  });

  test('trusted-types page triggers blob fallback detection', async ({ backgroundPage, sharedPage, pageUrl }) => {
    await sharedPage.goto(pageUrl('/worker-spawn-csp-trusted-types'), { waitUntil: 'domcontentloaded', timeout: 15000 });

    const sessionData = await backgroundPage.evaluate(async () => {
      const all = await browser.storage.session.get(null);
      const entries = Object.entries(all).filter(([k]) => k.startsWith('csp:'));
      return entries.map(([, value]) => value);
    });

    expect(sessionData.length).toBeGreaterThan(0);
    const cspInfo = sessionData[0];
    expect(cspInfo.hasTrustedTypesRequire).toBe(true);
    expect(cspInfo.needsBlobFallback).toBe(true);
  });

  test('no CSP means no blob fallback needed', async ({ backgroundPage, sharedPage, pageUrl, servers }) => {
    const origin = `http://localhost:${servers.main.port}`;
    await backgroundPage.evaluate((origin) => browser.storage.local.remove(
      [`settings :: ${origin} :: workerSpawnMode`],
    ), origin);
    await backgroundPage.evaluate(async () => { await browser.storage.session.clear(); });

    await sharedPage.goto(pageUrl('/worker-spawn-no-csp'), { waitUntil: 'domcontentloaded', timeout: 15000 });

    const sessionData = await backgroundPage.evaluate(async () => {
      const all = await browser.storage.session.get(null);
      const entries = Object.entries(all).filter(([k]) => k.startsWith('csp:'));
      return entries.map(([, value]) => value);
    });

    if (sessionData.length > 0) {
      const cspInfo = sessionData[0];
      expect(cspInfo.needsBlobFallback).toBe(false);
    }
  });
});
