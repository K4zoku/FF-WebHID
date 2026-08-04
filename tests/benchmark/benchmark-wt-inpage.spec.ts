import { test, expect } from '../helpers/e2e.js'
import { benchmarkMode, printResults } from './benchmark-utils.js'

test('image pipeline benchmark wt in-page (useWorker off)', async ({
  harnessCtx,
  backgroundPage,
  vendorDevice,
  httpPort,
  daemonMode,
  rdpPort
}) => {
  const result = await benchmarkMode(
    { harnessCtx, backgroundPage, vendorDevice, httpPort, daemonMode, rdpPort },
    'wt',
    { inPage: true }
  )
  expect(result.runs.length).toBeGreaterThan(0)
  printResults('wt-inpage', result)
  expect(
    result.wtStreamAttached,
    'the in-page WT never logged a stream attach: the spawn degraded to NM ' +
      '(page-context WebTransport must not be intercepted by Playwright routing; ' +
      'Juggler interception breaks the WebTransport channel. See tests/helpers/e2e.ts).'
  ).toBe(true)
  expect(result.fallbacks, 'unexpected data-plane fallback messages').toEqual([])
})
