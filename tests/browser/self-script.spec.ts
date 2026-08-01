import { test, expect } from '../helpers/browser.js';

test.describe('shadow-URL gating', () => {
  test('page <script> whose URL equals the document URL is not hijacked', async ({
    sharedPage,
    pageUrl,
  }) => {
    await sharedPage.goto(pageUrl('/self-script'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const ran = await sharedPage.evaluate(
      () => (window as unknown as { selfScriptRan?: boolean }).selfScriptRan === true,
    );
    expect(ran).toBe(true);
  });
});
