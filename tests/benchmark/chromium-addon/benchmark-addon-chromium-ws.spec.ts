import { test } from '@playwright/test'
import { runChromiumAddonBenchmark } from './benchmark-addon-common.js'

test('image pipeline benchmark chromium addon (ws data plane)', async () => {
  await runChromiumAddonBenchmark('ws', 'addon-chromium-ws')
})
