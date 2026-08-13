window.tests = window.tests || { helper: {}, results: {} }
window.tests.results.cspProbe = {
  hidUnderStrictCsp: typeof navigator.hid === 'undefined' ? 'absent' : 'present'
}
