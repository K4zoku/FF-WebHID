import { test, expect } from '../../helpers/browser.js';
import { waitForPermResult } from '../../helpers/browser-utils.js';
import type { Page, Frame } from '@playwright/test';

test.describe('Permissions Policy', () => {

  test('B33: no header allows same-origin', async ({ mainPage, pageUrl }) => {
    await mainPage.goto(pageUrl('/policy-check'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const r = await waitForPermResult(mainPage);
    expect(r).not.toBeNull();
    expect(r!.isTop).toBe(true);
    expect(r!.isCrossOrigin).toBe(false);
    expect(r!.queryHid).toBe('granted');
    expect(r!.getDevices.ok).toBe(true);
  });

  test('B1/B3: hid=() blocks getDevices', async ({ mainPage, pageUrl }) => {
    await mainPage.goto(pageUrl('/policy-check-blocked'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const r = await waitForPermResult(mainPage);
    expect(r).not.toBeNull();
    expect(r!.queryHid).toBe('denied');
    expect(r!.getDevices.ok).toBe(false);
    expect(r!.getDevices.name).toBe('SecurityError');
    expect(r!.getDevices.message).toContain('Permissions Policy');
  });

  test('hid=self allows same-origin', async ({ mainPage, pageUrl }) => {
    await mainPage.goto(pageUrl('/policy-check-allowed-self'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const r = await waitForPermResult(mainPage);
    expect(r).not.toBeNull();
    expect(r!.queryHid).toBe('granted');
    expect(r!.getDevices.ok).toBe(true);
  });

  test('hid=* allows same-origin', async ({ mainPage, pageUrl }) => {
    await mainPage.goto(pageUrl('/policy-check-allowed-all'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const r = await waitForPermResult(mainPage);
    expect(r).not.toBeNull();
    expect(r!.queryHid).toBe('granted');
    expect(r!.getDevices.ok).toBe(true);
  });

  test('navigator.permissions.query passes through non-hid features', async ({ mainPage, pageUrl }) => {
    await mainPage.goto(pageUrl('/policy-check'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const r = await waitForPermResult(mainPage);
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

  test('cross-origin iframe without allow="hid" is denied', async ({ mainPage, pageUrl }) => {
    const logs: string[] = [];
    mainPage.on('console', msg => logs.push(msg.text()));
    await mainPage.goto(pageUrl('/iframe-parent'), { waitUntil: 'domcontentloaded', timeout: 15000 });

    const childFrame = await waitForFrame(mainPage, '/iframe-child-no-allow');
    await childFrame.locator('#__start-marker').waitFor({ state: 'attached', timeout: 10000 });
    console.log('start-marker found');
    const dbgLogs = logs.filter(l => l.startsWith('DEBUG['));
    console.log('dbg logs:', dbgLogs.join('\n'));

    // Now wait for the result
    try {
      await childFrame.locator('#__perm-result').waitFor({ state: 'attached', timeout: 5000 });
    } catch {
      console.log('perm-result not found after 5s');
      console.log('all debug logs:', dbgLogs.join('\n'));
      const el = await childFrame.evaluate(() => document.getElementById('__perm-result')?.dataset.json || null);
      console.log('element now:', el);
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

  test('cross-origin iframe with allow="hid" is allowed', async ({ mainPage, pageUrl }) => {
    await mainPage.goto(pageUrl('/iframe-parent'), { waitUntil: 'domcontentloaded', timeout: 15000 });

    const childFrame = await waitForFrame(mainPage, '/iframe-child-with-allow');
    const noAllowFrame = await waitForFrame(mainPage, '/iframe-child-no-allow');

    await childFrame.locator('#__perm-result').waitFor({ state: 'attached', timeout: 10000 });
    await noAllowFrame.locator('#__perm-result').waitFor({ state: 'attached', timeout: 10000 });

    // Check policyLog from BOTH frames to see if they share the same _policyLog
    interface WindowWithPolicyLog extends Window {
      __webhidPolicyLog?: () => unknown[];
    }
    const logFromWith = await childFrame.evaluate(() => {
      const w = window as WindowWithPolicyLog;
      const f = typeof w.__webhidPolicyLog === 'function'
        ? w.__webhidPolicyLog : () => [];
      return { url: location.href, log: f() };
    });
    const logFromNoAllow = await noAllowFrame.evaluate(() => {
      const w = window as WindowWithPolicyLog;
      const f = typeof w.__webhidPolicyLog === 'function'
        ? w.__webhidPolicyLog : () => [];
      return { url: location.href, log: f() };
    });
    console.log('DEBUG logFromWith:', JSON.stringify(logFromWith));
    console.log('DEBUG logFromNoAllow:', JSON.stringify(logFromNoAllow));

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
