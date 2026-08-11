import { test, expect } from '../../helpers/e2e.js'
import { benchmarkLoss, printLossResults } from './loss-utils.js'
import { skipOnFallback } from '../benchmark-utils.js'

test('input-report loss benchmark ws @ 8000Hz', async ({
  harnessCtx,
  backgroundPage,
  vendorDevice,
  httpPort,
  daemonMode,
  rdpPort
}) => {
  const result = await benchmarkLoss(
    { harnessCtx, backgroundPage, vendorDevice, httpPort, daemonMode, rdpPort },
    'ws'
  )
  expect(result.runs.length).toBeGreaterThan(0)
  printLossResults('ws', result)
  skipOnFallback(result, 'ws')
})
