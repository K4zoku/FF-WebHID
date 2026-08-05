(function () {
  const webhid = globalThis.webhid

  /**
   * Wires up the (i) buttons next to setting titles. The description block
   * (`.info-popover`) is a floating bubble anchored under the title; it opens
   * on hover (with a short close delay so moving from the icon to the bubble
   * does not flicker), toggles on click for touch/keyboard, and closes on
   * Escape or clicking elsewhere. Only one bubble is open at a time. The
   * description content stays in the DOM with its `data-i18n-md` key, so
   * `localizeHTML` fills it before this runs.
   * @param {Element|Document} [root]
   * @returns {void}
   */
  function initInfoPopovers(root) {
    const scope = root || document
    const t = webhid.import('t')
    const moreLabel = t('infoPopoverMore')
    /** @type {ReturnType<typeof setTimeout>|null} */
    let closeTimer = null

    /** @returns {void} */
    function closeAll() {
      if (closeTimer) {
        clearTimeout(closeTimer)
        closeTimer = null
      }
      scope.querySelectorAll('.setting-info.open').forEach((el) => {
        el.classList.remove('open')
        const btn = el.querySelector('.info-popover-btn')
        if (btn) btn.setAttribute('aria-expanded', 'false')
      })
    }

    /**
     * @param {Element} info
     * @returns {void}
     */
    function open(info) {
      scope.querySelectorAll('.setting-info.open').forEach((el) => {
        if (el === info) return
        el.classList.remove('open')
        const b = el.querySelector('.info-popover-btn')
        if (b) b.setAttribute('aria-expanded', 'false')
      })
      info.classList.add('open')
      const btn = info.querySelector('.info-popover-btn')
      if (btn) btn.setAttribute('aria-expanded', 'true')
    }

    scope.querySelectorAll('.setting-info').forEach((info) => {
      if (info.querySelector('.info-popover-btn')) return
      const h3 = info.querySelector('h3')
      const desc = info.querySelector('[data-i18n-md]')
      if (!h3 || !desc) return
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'info-popover-btn'
      btn.setAttribute('aria-label', moreLabel)
      btn.setAttribute('aria-expanded', 'false')
      btn.textContent = 'i'
      h3.parentNode.insertBefore(btn, h3.nextSibling)
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        if (btn.getAttribute('aria-expanded') === 'true') {
          closeAll()
        } else {
          open(info)
        }
      })
      // Hover opens only over the (i) button itself, not the whole label row;
      // the bubble stays open while the pointer moves from the icon down into
      // it (its own enter handler cancels the pending close).
      btn.addEventListener('mouseenter', () => {
        if (closeTimer) {
          clearTimeout(closeTimer)
          closeTimer = null
        }
        open(info)
      })
      btn.addEventListener('mouseleave', () => {
        closeTimer = setTimeout(closeAll, 200)
      })
      const bubble = info.querySelector('.info-popover')
      if (bubble) {
        bubble.addEventListener('mouseenter', () => {
          if (closeTimer) {
            clearTimeout(closeTimer)
            closeTimer = null
          }
        })
        bubble.addEventListener('mouseleave', () => {
          closeTimer = setTimeout(closeAll, 200)
        })
      }
    })

    scope.addEventListener('click', (e) => {
      if (!e.target.closest('.setting-info')) closeAll()
    })
    scope.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAll()
    })
  }

  webhid.export('initInfoPopovers', initInfoPopovers)
})()
