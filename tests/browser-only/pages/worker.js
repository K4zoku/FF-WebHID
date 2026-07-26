self.postMessage({
  type: 'result',
  hasNavigatorHid: typeof navigator !== 'undefined' && 'hid' in navigator,
  polyfillInjected: self.__polyfillInjected === true,
});
