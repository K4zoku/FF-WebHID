import type { Page } from '@playwright/test';

export async function getPermResult(page: Page) {
  return page.evaluate<{
    isTop: boolean;
    isCrossOrigin: boolean;
    hidAllowed: boolean;
    queryHid: string;
    queryCamera: string;
    policySource: string;
    hidUndefined: boolean;
    getDevices: { ok: boolean; count?: number; name?: string; message?: string };
  } | null>(() => {
    const el = document.getElementById('__perm-result');
    if (!el || !el.dataset.json) return null;
    try { return JSON.parse(el.dataset.json) as { isTop: boolean; isCrossOrigin: boolean; hidAllowed: boolean; queryHid: string; queryCamera: string; policySource: string; hidUndefined: boolean; getDevices: { ok: boolean; count?: number; name?: string; message?: string }; }; } catch { return null; }
  });
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
  return page.evaluate<{
    hasNavigatorHid: boolean;
    polyfillInjected: boolean;
  } | null>(() => {
    const el = document.getElementById('__worker-result');
    if (!el || !el.textContent) return null;
    try { return JSON.parse(el.textContent) as { hasNavigatorHid: boolean; polyfillInjected: boolean; }; } catch { return null; }
  });
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
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.name : String(e), message: e instanceof Error ? e.message : String(e) };
    }
  });
}

export async function waitForWorkerResultElement(page: Page, elementId: string, timeout = 10000) {
  await page.waitForFunction(
    (id) => {
      const el = document.getElementById(id);
      return el && el.textContent && el.textContent !== 'waiting...';
    },
    elementId,
    { timeout },
  );
}

export async function parseElementJson<T>(page: Page, elementId: string) {
  return page.evaluate<T | null, string>((id) => {
    const el = document.getElementById(id);
    if (!el || !el.textContent) return null;
    try { return JSON.parse(el.textContent) as T; } catch { return null; }
  }, elementId);
}
