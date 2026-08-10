;(function () {
  const webhid = globalThis.webhid

  /**
   * @param {string} key
   * @param {string|string[]} [subs]
   * @returns {string}
   */
  function t(key, subs) {
    if (typeof browser !== 'undefined' && browser.i18n) {
      const msg = browser.i18n.getMessage(key, subs)
      if (msg) return msg
    }
    return key
  }

  /**
   * Applies a minimal markdown subset to an element: **bold**, `code`, and
   * newlines as <br>. Builds DOM nodes directly (no innerHTML).
   * @param {Element} el
   * @param {string} text
   * @returns {void}
   */
  function applyMarkdown(el, text) {
    el.textContent = ''
    const parts = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`|\n)/g)
    for (const part of parts) {
      if (part === '') continue
      if (part === '\n') {
        el.appendChild(document.createElement('br'))
      } else if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
        const strong = document.createElement('strong')
        strong.textContent = part.slice(2, -2)
        el.appendChild(strong)
      } else if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
        const code = document.createElement('code')
        code.textContent = part.slice(1, -1)
        el.appendChild(code)
      } else {
        el.appendChild(document.createTextNode(part))
      }
    }
  }

  /**
   * @param {Element|Document} [root]
   * @returns {void}
   */
  function localizeHTML(root) {
    const scope = root || document
    scope.querySelectorAll('[data-i18n-md]').forEach((el) => {
      applyMarkdown(el, t(el.getAttribute('data-i18n-md')))
    })
    scope.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n')
      const subs = el.getAttribute('data-i18n-subs')
      const msg = subs ? t(key, subs.split(',')) : t(key)
      el.textContent = msg
    })
    scope.querySelectorAll('[data-i18n-attr]').forEach((el) => {
      const pairs = el.getAttribute('data-i18n-attr').split(';')
      for (const pair of pairs) {
        const [attr, key] = pair.split(':')
        if (attr && key) el.setAttribute(attr.trim(), t(key.trim()))
      }
    })
  }

  webhid.export('t', t)
  webhid.export('localizeHTML', localizeHTML)
})()
