import type { Page } from '@playwright/test';

// Page-published test results live on `window.tests.results.<key>` (never in
// the DOM). Shared reader helpers for the subset of keys more than one spec
// consumes. Page-side writers bootstrap the namespace in each page template
// (`window.tests = window.tests || { helper: {}, results: {} }`).

export interface PermResult {
  isTop?: boolean;
  isCrossOrigin?: boolean;
  hidAllowed?: boolean;
  queryHid?: string;
  queryCamera?: string;
  policySource?: string;
  hidUndefined?: boolean;
  getDevices?: { ok: boolean; count?: number; name?: string; message?: string };
}

interface WindowWithTests {
  tests?: {
    results: Record<string, unknown>;
  };
}

export async function getPermResult(page: Page): Promise<PermResult | null> {
  return page.evaluate((): PermResult | null => {
    const r = (window as unknown as WindowWithTests).tests?.results?.perm;
    if (r && typeof r === 'object') return r as PermResult;
    return null;
  });
}

export async function waitForPermResult(page: Page, timeout = 10000): Promise<PermResult | null> {
  await page.waitForFunction(
    (): boolean => {
      const r = (window as unknown as WindowWithTests).tests?.results?.perm;
      return r !== null && typeof r === 'object';
    },
    { timeout }
  );
  return getPermResult(page);
}