import { test, expect } from '../helpers/browser.js';

interface TtResults {
  hasTrustedTypes: boolean;
  skipped?: boolean;
  extCreated?: string;
  collision?: string;
  swallowedType?: string;
  swallowedChain?: string;
  secondCall?: string;
  defaultCreated?: string;
  defaultDup?: string;
}

test.describe('Trusted Types policy handling', () => {
  let raw: TtResults | null = null;

  test.beforeAll(async ({ sharedPage, pageUrl }) => {
    await sharedPage.goto(pageUrl('/tt-policy'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    await sharedPage.waitForFunction(
      () =>
        (window as unknown as { tests?: { results?: TtResults } }).tests?.results
          ?.hasTrustedTypes !== undefined,
      { timeout: 10000 },
    );
    raw = await sharedPage.evaluate(
      () =>
        (window as unknown as { tests: { results: TtResults } }).tests.results,
    );
  });

  test('browser exposes Trusted Types', () => {
    expect(raw?.hasTrustedTypes).toBe(true);
  });

  test('extension policy is created first under the CSP-allowed name', () => {
    test.skip(!raw?.hasTrustedTypes, 'browser lacks Trusted Types');
    expect(raw?.extCreated).toBe('ok');
  });

  test('page createPolicy with the claimed name throws', () => {
    test.skip(!raw?.hasTrustedTypes, 'browser lacks Trusted Types');
    expect(raw?.collision).toBe('TypeError');
  });

  test('first page call is swallowed and returns a working policy', () => {
    test.skip(!raw?.hasTrustedTypes, 'browser lacks Trusted Types');
    expect(raw?.swallowedType).toBe('function');
  });

  test('page rules chain through the wrapper', () => {
    test.skip(!raw?.hasTrustedTypes, 'browser lacks Trusted Types');
    expect(raw?.swallowedChain).toBe('https://x/worker.js#page');
  });

  test('second page call with the claimed name throws', () => {
    test.skip(!raw?.hasTrustedTypes, 'browser lacks Trusted Types');
    expect(raw?.secondCall).toBe('TypeError');
  });

  test('default policy can be created', () => {
    test.skip(!raw?.hasTrustedTypes, 'browser lacks Trusted Types');
    expect(raw?.defaultCreated).toBe('ok');
  });

  test('duplicate default policy creation throws', () => {
    test.skip(!raw?.hasTrustedTypes, 'browser lacks Trusted Types');
    expect(raw?.defaultDup).toBe('TypeError');
  });
});
