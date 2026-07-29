import { test, expect } from '../helpers/browser.js';
import { waitForPermResult } from '../helpers/browser-utils.js';
import type { Page, Frame } from '@playwright/test';

test.describe('Permissions Policy', () => {

  test('B33: no header allows same-origin', async ({ sharedPage, pageUrl }) => {
    await sharedPage.goto(pageUrl('/policy-check'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const r = await waitForPermResult(sharedPage);
    expect(r).not.toBeNull();
    expect(r!.isTop).toBe(true);
    expect(r!.isCrossOrigin).toBe(false);
    expect(r!.queryHid).toBe('granted');
    expect(r!.getDevices.ok).toBe(true);
  });

  test('B1/B3: hid=() blocks getDevices', async ({ sharedPage, pageUrl }) => {
    await sharedPage.goto(pageUrl('/policy-check-blocked'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const r = await waitForPermResult(sharedPage);
    expect(r).not.toBeNull();
    expect(r!.queryHid).toBe('denied');
    expect(r!.getDevices.ok).toBe(false);
    expect(r!.getDevices.name).toBe('SecurityError');
    expect(r!.getDevices.message).toContain('Permissions Policy');
  });

  test('hid=self allows same-origin', async ({ sharedPage, pageUrl }) => {
    await sharedPage.goto(pageUrl('/policy-check-allowed-self'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const r = await waitForPermResult(sharedPage);
    expect(r).not.toBeNull();
    expect(r!.queryHid).toBe('granted');
    expect(r!.getDevices.ok).toBe(true);
  });

  test('hid=* allows same-origin', async ({ sharedPage, pageUrl }) => {
    await sharedPage.goto(pageUrl('/policy-check-allowed-all'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const r = await waitForPermResult(sharedPage);
    expect(r).not.toBeNull();
    expect(r!.queryHid).toBe('granted');
    expect(r!.getDevices.ok).toBe(true);
  });

  test('navigator.permissions.query passes through non-hid features', async ({ sharedPage, pageUrl }) => {
    await sharedPage.goto(pageUrl('/policy-check'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const r = await waitForPermResult(sharedPage);
    expect(r).not.toBeNull();
    expect(r!.queryCamera).toBe('prompt');
  });

});

test.describe('Cross-origin iframe', () => {

  async function waitForFrame(page: Page, urlSubstring: string, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const frame = page.frames().find((f: Frame) => f.url().includes(urlSubstring));
      if (frame) return frame;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('Frame with URL containing "' + urlSubstring + '" not found');
  }

  async function readIframeResult(page: Page, urlSubstring: string) {
    const childFrame = await waitForFrame(page, urlSubstring);
    await childFrame.locator('#__perm-result').waitFor({ state: 'attached', timeout: 10000 });
    const raw = await childFrame.evaluate(() => {
      const el = document.getElementById('__perm-result');
      if (!el || !el.dataset.json) return null;
      try { return JSON.parse(el.dataset.json); } catch { return null; }
    });
    return raw;
  }

  test('cross-origin iframe without allow="hid" is denied', async ({ sharedPage, pageUrl, crossUrl }) => {
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
    }, crossUrl('/'));

    const childFrame = await waitForFrame(sharedPage, '/iframe-child-no-allow');
    await childFrame.locator('#__start-marker').waitFor({ state: 'attached', timeout: 10000 });

    // Now wait for the result
    try {
      await childFrame.locator('#__perm-result').waitFor({ state: 'attached', timeout: 5000 });
    } catch {
      throw new Error('element not found');
    }

    const raw = await childFrame.evaluate(() => {
      const el = document.getElementById('__perm-result');
      if (!el || !el.dataset.json) return null;
      try { return JSON.parse(el.dataset.json); } catch { return null; }
    });
    expect(raw).not.toBeNull();
    expect(raw!.isCrossOrigin).toBe(true);
    expect(raw!.queryHid).toBe('denied');
    expect(raw!.getDevices.ok).toBe(false);
    expect(raw!.getDevices.name).toBe('SecurityError');
  });

  test('cross-origin iframe with allow="hid" is allowed', async ({ sharedPage, pageUrl, crossUrl }) => {
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
    }, crossUrl('/'));

    const childFrame = await waitForFrame(sharedPage, '/iframe-child-with-allow');
    const noAllowFrame = await waitForFrame(sharedPage, '/iframe-child-no-allow');

    await childFrame.locator('#__perm-result').waitFor({ state: 'attached', timeout: 10000 });
    await noAllowFrame.locator('#__perm-result').waitFor({ state: 'attached', timeout: 10000 });

    const raw = await childFrame.evaluate(() => {
      const el = document.getElementById('__perm-result');
      if (!el || !el.dataset.json) return null;
      try { return JSON.parse(el.dataset.json); } catch { return null; }
    });
    expect(raw).not.toBeNull();
    expect(raw!.isCrossOrigin).toBe(true);
    expect(raw!.queryHid).toBe('granted');
    expect(raw!.getDevices.ok).toBe(true);
  });

});
