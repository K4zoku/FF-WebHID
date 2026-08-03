import { test, expect } from '../../helpers/e2e.js'
import { benchmarkLoss, printLossResults } from './loss-utils.js'

test('input-report loss benchmark wt @ 8000Hz', async ({
  harnessCtx,
  backgroundPage,
  vendorDevice,
  httpPort,
  daemonMode
}) => {
  const result = await benchmarkLoss(
    { harnessCtx, backgroundPage, vendorDevice, httpPort, daemonMode },
    'wt'
  )
  expect(result.runs.length).toBeGreaterThan(0)
  printLossResults('wt', result)
  if (result.fallbacks.length > 0) {
    test.skip(
      true,
      `wt loss benchmark degraded to NM fallback: ${result.fallbacks.join(' | ')}. ` +
        'The numbers would measure NM, not wt.'
    )
  }
})
