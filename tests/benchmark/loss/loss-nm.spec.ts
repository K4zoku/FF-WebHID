import { test, expect } from '../../helpers/e2e.js'
import { benchmarkLoss, printLossResults } from './loss-utils.js'

test('input-report loss benchmark nm @ 8000Hz', async ({
  harnessCtx,
  backgroundPage,
  vendorDevice,
  httpPort,
  daemonMode,
  rdpPort
}) => {
  const result = await benchmarkLoss(
    { harnessCtx, backgroundPage, vendorDevice, httpPort, daemonMode, rdpPort },
    'nm'
  )
  expect(result.runs.length).toBeGreaterThan(0)
  printLossResults('nm', result)
  if (result.fallbacks.length > 0) {
    test.skip(
      true,
      `nm loss benchmark degraded to NM fallback: ${result.fallbacks.join(' | ')}. ` +
        'The numbers would measure NM, not nm.'
    )
  }
})
