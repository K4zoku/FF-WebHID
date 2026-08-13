import { test } from '@playwright/test'
import { runChromiumAddonBenchmark } from './benchmark-addon-common.js'

test('image pipeline benchmark chromium addon (wt data plane)', async () => {
  await runChromiumAddonBenchmark('wt', 'addon-chromium-wt')
})
