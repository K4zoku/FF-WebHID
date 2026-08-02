import { test, expect } from '../helpers/browser.js';
import { waitForPermResult } from '../helpers/browser-utils.js';
import type { Page, Frame } from '@playwright/test';

test.describe('Permissions Policy', () => {
  test.describe.configure({ mode: 'parallel' });

  test('B33: no header allows same-origin', async ({ page, pageUrl }) => {
    await page.goto(pageUrl('/policy-check'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const r = await waitForPermResult(page);
    expect(r).not.toBeNull();
    expect(r!.isTop).toBe(true);
    expect(r!.isCrossOrigin).toBe(false);
    expect(r!.queryHid).toBe('granted');
    expect(r!.hidUndefined).toBe(false);
  });

  test('B1/B3: hid=() blocks hid', async ({ page, pageUrl }) => {
    await page.goto(pageUrl('/policy-check-blocked'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const r = await waitForPermResult(page);
    expect(r).not.toBeNull();
    expect(r!.queryHid).toBe('denied');
    expect(r!.hidUndefined || r!.getDevices?.ok === false).toBe(true);
  });

  test('hid=self allows same-origin', async ({ page, pageUrl }) => {
    await page.goto(pageUrl('/policy-check-allowed-self'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const r = await waitForPermResult(page);
    expect(r).not.toBeNull();
    expect(r!.queryHid).toBe('granted');
    expect(r!.hidUndefined).toBe(false);
  });

  test('hid=* allows same-origin', async ({ page, pageUrl }) => {
    await page.goto(pageUrl('/policy-check-allowed-all'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const r = await waitForPermResult(page);
    expect(r).not.toBeNull();
    expect(r!.queryHid).toBe('granted');
    expect(r!.hidUndefined).toBe(false);
  });

  test('navigator.permissions.query passes through non-hid features', async ({ page, pageUrl }) => {
    await page.goto(pageUrl('/policy-check'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const r = await waitForPermResult(page);
    expect(r).not.toBeNull();
    expect(r!.queryCamera).toBe('prompt');
  });

});

test.describe('Cross-origin iframe', () => {
  async function waitForFrame(p: Page, urlSubstring: string, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const frame = p.frames().find((f: Frame) => f.url().includes(urlSubstring));
      if (frame) return frame;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('Frame with URL containing "' + urlSubstring + '" not found');
  }

interface PermResult {
  isTop: boolean;
  isCrossOrigin: boolean;
  hidAllowed: boolean;
  queryHid: string;
  queryCamera: string;
  policySource: string;
  hidUndefined: boolean;
  getDevices: { ok: boolean; count?: number; name?: string; message?: string };
}

  async function readIframeResult(p: Page, urlSubstring: string) {
    const childFrame = await waitForFrame(p, urlSubstring);
    await childFrame.waitForFunction(
      () => {
        const r = (window as unknown as { tests?: { results?: Record<string, unknown> } }).tests?.results?.perm;
        return r !== null && typeof r === 'object';
      },
      { timeout: 10000 },
    );
    const raw = await childFrame.evaluate<PermResult | null>(() => {
      const r = (window as unknown as { tests?: { results?: Record<string, unknown> } }).tests?.results?.perm;
      return r && typeof r === 'object' ? (r as PermResult) : null;
    });
    return raw;
  }

  test.beforeAll(async ({ sharedPage, pageUrl, crossUrl }) => {
      await sharedPage.goto(pageUrl('/iframe-parent'), { waitUntil: 'domcontentloaded', timeout: 15000 });
      await sharedPage.evaluate((crossUrl) => {
        const noAllow = document.createElement('iframe');
        noAllow.id = 'no-allow';
        noAllow.src = crossUrl + '/iframe-child-no-allow';
        document.body.appendChild(noAllow);
        const withAllow = document.createElement('iframe');
        withAllow.id = 'with-allow';
        withAllow.src = crossUrl + '/iframe-child-with-allow';
        withAllow.allow = 'hid';
        document.body.appendChild(withAllow);
      }, crossUrl(''));
    });

  test('cross-origin iframe without allow="hid" is denied', async ({ sharedPage }) => {
    const raw = await readIframeResult(sharedPage, '/iframe-child-no-allow');
    expect(raw).not.toBeNull();
    expect(raw!.isCrossOrigin).toBe(true);
    expect(raw!.queryHid).toBe('denied');
    expect(raw!.hidUndefined).toBe(false);
  });

  test('cross-origin iframe with allow="hid" is allowed', async ({ sharedPage }) => {
    const raw = await readIframeResult(sharedPage, '/iframe-child-with-allow');
    expect(raw).not.toBeNull();
    expect(raw!.isCrossOrigin).toBe(true);
    expect(raw!.queryHid).toBe('granted');
    expect(raw!.hidUndefined).toBe(false);
  });
});
