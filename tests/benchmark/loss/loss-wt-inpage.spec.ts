import { test, expect } from '../../helpers/e2e.js'
import { benchmarkLoss, printLossResults } from './loss-utils.js'

test('input-report loss benchmark wt in-page (useWorker off) @ 8000Hz', async ({
  harnessCtx,
  backgroundPage,
  vendorDevice,
  httpPort,
  daemonMode
}) => {
  const result = await benchmarkLoss(
    { harnessCtx, backgroundPage, vendorDevice, httpPort, daemonMode },
    'wt',
    { inPage: true }
  )
  expect(result.runs.length).toBeGreaterThan(0)
  printLossResults('wt-inpage', result)
  expect(
    result.wtStreamAttached,
    'the in-page WT never logged a stream attach: the spawn degraded to NM ' +
      '(page-context WebTransport must not be intercepted by Playwright routing; ' +
      'see tests/helpers/e2e.ts).'
  ).toBe(true)
  expect(result.fallbacks, 'unexpected data-plane fallback messages').toEqual([])
})
