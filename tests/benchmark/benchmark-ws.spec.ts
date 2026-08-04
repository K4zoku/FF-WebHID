import { test, expect } from '../helpers/e2e.js'
import { benchmarkMode, printResults, skipOnFallback } from './benchmark-utils.js'

test('image pipeline benchmark ws', async ({
  harnessCtx,
  backgroundPage,
  vendorDevice,
  httpPort,
  daemonMode,
  rdpPort
}) => {
  const result = await benchmarkMode(
    { harnessCtx, backgroundPage, vendorDevice, httpPort, daemonMode, rdpPort },
    'ws'
  )
  expect(result.runs.length).toBeGreaterThan(0)
  printResults('ws', result)
  skipOnFallback(result, 'ws')
})
