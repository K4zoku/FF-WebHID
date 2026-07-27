import { test, expect } from '../../helpers/browser.js';

test.describe('Worker injection', () => {

  test('arm + filterResponseData is NOT yet implemented', async () => {
    // The arm mechanism (content script patches Worker constructor,
    // background pre-arms URL, filterResponseData injects polyfill preamble)
    // was verified experimentally in /tmp/opencode/perm-policy-test/
    // but NOT yet ported to the codebase.
    // The existing filterResponseData only intercepts redirect workers
    // (`new Worker(location.href)`) for the WS data plane, which requires
    // the daemon to function. See EXPERIMENTAL.md for the experiment.
    expect(true).toBe(true);
  });

});
