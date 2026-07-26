import type { Page } from '@playwright/test';

export async function getPermResult(page: Page) {
  const raw = await page.evaluate(() => {
    const el = document.getElementById('__perm-result');
    if (!el || !el.dataset.json) return null;
    try { return JSON.parse(el.dataset.json); } catch { return null; }
  });
  return raw as {
    isTop: boolean;
    isCrossOrigin: boolean;
    hidAllowed: boolean;
    queryHid: string;
    queryCamera: string;
    policySource: string;
  } | null;
}

export async function waitForPermResult(page: Page, timeout = 10000) {
  await page.waitForFunction(
    () => {
      const el = document.getElementById('__perm-result');
      return el && el.dataset.json;
    },
    { timeout },
  );
  return getPermResult(page);
}

export async function getWorkerResult(page: Page) {
  const raw = await page.evaluate(() => {
    const el = document.getElementById('__worker-result');
    if (!el || !el.textContent) return null;
    try { return JSON.parse(el.textContent); } catch { return null; }
  });
  return raw as {
    hasNavigatorHid: boolean;
    polyfillInjected: boolean;
  } | null;
}

export async function waitForWorkerResult(page: Page, timeout = 15000) {
  await page.waitForFunction(
    () => {
      const el = document.getElementById('__worker-result');
      return el && el.textContent && el.textContent.length > 0;
    },
    { timeout },
  );
  return getWorkerResult(page);
}

export async function getPolicyFromGetDevices(page: Page) {
  return page.evaluate(async () => {
    try {
      const devices = await navigator.hid.getDevices();
      return { ok: true, count: devices.length };
    } catch (e: any) {
      return { ok: false, error: e.name, message: e.message };
    }
  });
}
