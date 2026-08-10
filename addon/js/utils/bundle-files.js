;(function () {
  /**
   * worker: data worker spawned per device (shadow URL or blob fallback).
   * workerPolyfill: WebHID polyfill injected into page-created workers.
   * mv2MainWorld: MAIN-world page polyfill, used only by the MV2 injector
   * (js/content/isolated/inject.js); MV3 loads the same scripts via the
   * "world": "MAIN" content script instead.
   */
  const BUNDLE_FILES = {
    worker: [
      'js/utils/bootstrap.js',
      'js/utils/logger.js',
      'js/utils/settings.js',
      'js/utils/websocket.js',
      'js/utils/webtransport.js',
      'js/content/isolated/worker/index.js'
    ],
    workerPolyfill: [
      'js/utils/bootstrap.js',
      'js/utils/logger.js',
      'js/utils/http.js',
      'js/utils/settings.js',
      'js/utils/device.js',
      'js/utils/webtransport.js',
      'js/content/main/index.js'
    ],
    mv2MainWorld: [
      'js/utils/bootstrap.js',
      'js/utils/i18n.js',
      'js/utils/resource.js',
      'js/utils/http.js',
      'js/utils/logger.js',
      'js/utils/device.js',
      'js/utils/descriptor-tlv.js',
      'js/utils/settings.js',
      'js/utils/webtransport.js',
      'js/content/main/index.js'
    ]
  }
  webhid.export('bundleFiles', BUNDLE_FILES)
})()
