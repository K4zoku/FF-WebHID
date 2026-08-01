;(function () {
  const BUNDLE_FILES = {
    worker: [
      'js/utils/bootstrap.js',
      'js/utils/logger.js',
      'js/utils/settings.js',
      'js/utils/websocket.js',
      'js/content/isolated/worker/index.js'
    ],
    polyfill: [
      'js/utils/bootstrap.js',
      'js/utils/logger.js',
      'js/utils/http.js',
      'js/utils/settings.js',
      'js/utils/device.js',
      'js/content/main/index.js'
    ],
    main: [
      'js/utils/bootstrap.js',
      'js/utils/i18n.js',
      'js/utils/resource.js',
      'js/utils/http.js',
      'js/utils/logger.js',
      'js/utils/device.js',
      'js/utils/descriptor-tlv.js',
      'js/utils/settings.js',
      'js/content/main/index.js'
    ]
  }
  webhid.export('bundleFiles', BUNDLE_FILES)
})()
