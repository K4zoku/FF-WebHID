;(function () {
  const webhid = globalThis.webhid
  const SUPPORTED_LOCALES = new Set([
    'af-ZA',
    'ar-SA',
    'ca-ES',
    'cs-CZ',
    'da-DK',
    'de-DE',
    'el-GR',
    'en-US',
    'es-ES',
    'fi-FI',
    'fr-FR',
    'he-IL',
    'hu-HU',
    'it-IT',
    'ja-JP',
    'ko-KR',
    'nl-NL',
    'no-NO',
    'pl-PL',
    'pt-BR',
    'pt-PT',
    'ro-RO',
    'ru-RU',
    'sr-SP',
    'sv-SE',
    'tr-TR',
    'uk-UA',
    'vi-VN',
    'zh-CN',
    'zh-TW'
  ])

  /**
   * @param {string} locale
   * @returns {string[]}
   */
  function localeCandidates(locale) {
    const parts = locale.split('-')
    const candidates = [locale]
    for (let end = parts.length - 1; end > 1; end--) {
      candidates.push(parts.slice(0, end).join('-'))
    }
    const scriptIndex = parts.findIndex((part, index) => index > 0 && /^[A-Za-z]{4}$/.test(part))
    if (scriptIndex > 0) {
      candidates.push(parts.filter((_, index) => index !== scriptIndex).join('-'))
    }
    candidates.push(parts[0])
    return candidates
  }

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
   * @param {string} locale
   * @returns {string}
   */
  function normalizeDocumentLanguage(locale) {
    const normalized = String(locale || '').replace(/_/g, '-')
    if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(normalized)) return ''
    return normalized
      .split('-')
      .map((part, index) => {
        if (index === 0) return part.toLowerCase()
        if (/^[A-Za-z]{4}$/.test(part)) {
          return part[0].toUpperCase() + part.slice(1).toLowerCase()
        }
        if (/^(?:[A-Za-z]{2}|\d{3})$/.test(part)) return part.toUpperCase()
        return part
      })
      .join('-')
  }

  /**
   * @param {string} locale
   * @returns {string}
   */
  function resolveDocumentLanguage(locale) {
    const normalized = normalizeDocumentLanguage(locale)
    if (!normalized) return 'en'
    return (
      localeCandidates(normalized).find((candidate) => SUPPORTED_LOCALES.has(candidate)) || 'en'
    )
  }

  /**
   * @returns {void}
   */
  function localizeDocumentMetadata() {
    if (
      typeof document === 'undefined' ||
      typeof browser === 'undefined' ||
      !browser.i18n ||
      !document.documentElement
    ) {
      return
    }
    document.documentElement.lang = resolveDocumentLanguage(browser.i18n.getUILanguage())
    const direction = browser.i18n.getMessage('@@bidi_dir')
    if (direction === 'ltr' || direction === 'rtl') document.documentElement.dir = direction
  }

  /**
   * @param {Element|Document} [root]
   * @returns {void}
   */
  function localizeHTML(root) {
    const scope = root || document
    if (scope === document) localizeDocumentMetadata()
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
