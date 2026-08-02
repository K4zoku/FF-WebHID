(function () {
  const webhid = globalThis.webhid

  /**
   * @param {Element} [target]
   * @returns {Promise<void>}
   */
  async function syncBrowserTheme(target) {
    if (typeof browser === 'undefined' || !browser.theme) return
    const theme = await browser.theme.getCurrent()
    if (!theme.colors) return

    const root = target || document.documentElement
    const map = {
      '--bg': theme.colors.popup ?? theme.colors.frame,
      '--text': theme.colors.popup_text ?? theme.colors.tab_background_text,
      '--accent': theme.colors.frame
    }
    for (const [prop, value] of Object.entries(map)) {
      if (value) root.style.setProperty(prop, value)
    }
  }

  webhid.export('syncBrowserTheme', syncBrowserTheme)
})()
