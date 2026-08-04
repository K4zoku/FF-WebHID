import { test, expect } from '../helpers/browser.js';

test.describe('shadow-URL gating', () => {
  test('page <script> whose URL equals the document URL is not hijacked', async ({
    sharedPage,
    pageUrl,
  }) => {
    await sharedPage.goto(pageUrl('/self-script'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const ran = await sharedPage.evaluate(
      () =>
        (window as unknown as { tests?: { results?: { selfScriptRan?: boolean } } }).tests?.results
          ?.selfScriptRan === true,
    );
    expect(ran).toBe(true);
  });

  test('page subresource with SRI integrity is byte-identical (not rewritten)', async ({
    sharedPage,
    pageUrl,
  }) => {
    // sri-check.html loads sri-test.js with an SRI integrity attribute. If the
    // addon modified the response body in any way (prefix injection, header
    // rewrite changing bytes), Firefox blocks the script and sriTestRan stays
    // false. Passing proves the gating never touches page subresources.
    await sharedPage.goto(pageUrl('/sri-check'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const ran = await sharedPage.evaluate(
      () => (window as unknown as { sriTestRan?: boolean }).sriTestRan === true,
    );
    expect(ran).toBe(true);
  });
});
