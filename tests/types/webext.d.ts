// Minimal WebExtension types for browser.storage.local used in worker-polyfill tests
// The full WebExtension API is not declared; only what the tests use.

declare namespace browser.storage {
  interface StorageArea {
    set(items: Record<string, unknown>): Promise<void>;
    get(keys?: string | string[] | Record<string, unknown>): Promise<Record<string, unknown>>;
  }
  var local: StorageArea;
}

declare var browser: typeof browser;
