import { test, expect } from '../helpers/e2e.js'
import { benchmarkMode, printResults, skipOnFallback } from './benchmark-utils.js'

test('image pipeline benchmark nm', async ({
  harnessCtx,
  backgroundPage,
  vendorDevice,
  httpPort,
  daemonMode,
  rdpPort
}) => {
  const result = await benchmarkMode(
    { harnessCtx, backgroundPage, vendorDevice, httpPort, daemonMode, rdpPort },
    'nm'
  )
  expect(result.runs.length).toBeGreaterThan(0)
  printResults('nm', result)
  skipOnFallback(result, 'nm')
})
