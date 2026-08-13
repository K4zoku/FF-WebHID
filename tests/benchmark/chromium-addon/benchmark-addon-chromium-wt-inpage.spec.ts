import { test } from '@playwright/test'
import { runChromiumAddonBenchmark } from './benchmark-addon-common.js'

test('image pipeline benchmark chromium addon (wt-inpage data plane)', async () => {
  await runChromiumAddonBenchmark('wt-inpage', 'chr-wt-inpage')
})
