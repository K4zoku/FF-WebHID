import { type Page } from "@playwright/test";

const VID = 0x1234;
const PID = 0x5678;

/**
 * Grant device permission by driving the real picker UI via keyboard.
 *
 * Why keyboard instead of dispatching `webhid-device-selected` directly?
 * The picker uses a closed Shadow DOM, so Playwright CSS selectors cannot
 * pierce into it. But `page.keyboard.press()` dispatches OS-level key
 * events that the browser routes through the shadow boundary normally
 * (dialog focus traversal is part of the platform, not the page).
 *
 * Tab order inside the picker `<dialog>` (verified manually):
 *   1. Tab → first device label (tabindex=0)
 *   2. Tab → Cancel button
 *   3. Tab → Connect button
 *
 * Flow:
 *   1. Trigger `requestDevice` from page → picker.show() opens the dialog
 *   2. Tab → device label gets focus
 *   3. Space → browser activates the label, which forwards the click to
 *      the wrapped `<input type="radio">`, checking it. Picker's `change`
 *      listener then enables the Connect button.
 *   4. Tab → Cancel button
 *   5. Tab → Connect button (now enabled)
 *   6. Enter → form submits with `value="selected"` → `<dialog>.close()`
 *      fires → picker dispatches `webhid-device-selected` with REAL device
 *      data (deviceId, vendorId, productId, collections, productName, ...)
 *      pulled from the daemon's enumerate response — no faked fields.
 *   7. `requestDevice` Promise resolves with the real HIDDevice list.
 *
 * This replaces the previous implementation which hardcoded
 * `deviceId = 48125337` and faked the collections / VID / PID. The
 * deviceId happened to match a real mock device on one developer's
 * machine, but the rest of the device info was fabricated, masking
 * real bugs (e.g. descriptor parsing, hot-plug events) that the E2E
 * tests are supposed to catch.
 */
export async function grantDevicePermission(
  page: Page,
  filters: any[] = [{ vendorId: VID, productId: PID }],
): Promise<any[]> {
  // 1. Trigger requestDevice — picker dialog opens. The Promise below
  //    resolves only after the dialog closes (user selects or cancels).
  const requestPromise = page.evaluate((flt) => {
    return (window as any).__webhidTest.requestDevice(flt);
  }, filters);

  await page.waitForTimeout(500);

  // 2. Focus on dialog
  await page.keyboard.press("Tab");
  await page.waitForTimeout(50);

  // 3. First device item
  await page.keyboard.press("Tab");
  await page.waitForTimeout(50);
  await page.keyboard.press("Space");
  await page.waitForTimeout(50);

  // 4. Focus on dialog footer
  await page.keyboard.press("Tab");
  await page.waitForTimeout(50);

  // 5. Cancel button
  await page.keyboard.press("Tab");
  await page.waitForTimeout(50);

  // 6. Connect button
  await page.keyboard.press("Tab");
  await page.waitForTimeout(50);
  await page.keyboard.press("Enter");

  // 7. Wait for the requestDevice Promise to resolve with real device data
  const devices = await requestPromise;
  if (!Array.isArray(devices) || devices.length === 0) {
    throw new Error(
      "grantDevicePermission: requestDevice resolved with no devices. " +
        "Picker may have cancelled or no device matched the filter.",
    );
  }
  console.log('devices:', JSON.stringify(devices))
  return devices;
}

/**
 * Ensure a device is paired. If `getDevices()` already returns one
 * (from a previous grantDevicePermission call in the same browser
 * session), reuse it. Otherwise grant fresh permission.
 */
export async function ensureDevicePaired(
  page: Page,
  testApi: { getDevices: () => Promise<any[]> },
): Promise<any[]> {
  const devices = await testApi.getDevices();
  if (devices.length > 0) return devices;
  return grantDevicePermission(page);
}
