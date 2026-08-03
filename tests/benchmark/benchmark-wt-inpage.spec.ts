import { test, expect } from '../helpers/e2e.js'
import { benchmarkMode, printResults } from './benchmark-utils.js'

test('image pipeline benchmark wt in-page (useWorker off)', async ({
  harnessCtx,
  backgroundPage,
  vendorDevice,
  httpPort,
  daemonMode
}) => {
  const result = await benchmarkMode(
    { harnessCtx, backgroundPage, vendorDevice, httpPort, daemonMode },
    'wt',
    { inPage: true }
  )
  expect(result.runs.length).toBeGreaterThan(0)
  printResults('wt-inpage', result)
  expect(
    result.wtStreamAttached,
    'the in-page WT never logged a stream attach: the spawn degraded to NM ' +
      '(page-context WebTransport to 127.0.0.1 is gated in the harness Firefox). ' +
      'These numbers measure NM, not in-page WT. Run on real Firefox after allowing ' +
      'the local-network prompt once.'
  ).toBe(true)
  expect(result.fallbacks, 'unexpected data-plane fallback messages').toEqual([])
})
