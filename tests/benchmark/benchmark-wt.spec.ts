import { test, expect } from '../helpers/e2e.js'
import { benchmarkMode, printResults, skipOnFallback } from './benchmark-utils.js'

test('image pipeline benchmark wt', async ({
  harnessCtx,
  backgroundPage,
  vendorDevice,
  httpPort,
  daemonMode,
  rdpPort
}) => {
  const result = await benchmarkMode(
    { harnessCtx, backgroundPage, vendorDevice, httpPort, daemonMode, rdpPort },
    'wt'
  )
  expect(result.runs.length).toBeGreaterThan(0)
  printResults('wt', result)
  skipOnFallback(result, 'wt')
})
