import { test } from '@playwright/test'
import { runChromiumAddonBenchmark } from './benchmark-addon-common.js'

test('image pipeline benchmark chromium addon (nm data plane)', async () => {
  await runChromiumAddonBenchmark('nm', 'chr-nm')
})
