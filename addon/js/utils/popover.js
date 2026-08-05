;(function () {
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
    /** @type {(() => void)|null} */
    let repositionHandler = null

    /** @returns {void} */
    function disableReposition() {
      if (!repositionHandler) return
      window.removeEventListener('resize', repositionHandler)
      document.removeEventListener('scroll', repositionHandler, true)
      repositionHandler = null
    }

    /**
     * Anchors the bubble to the (i) button in viewport coordinates, flips it
     * above the button when there is no room below, and points the arrow at
     * the button. Fixed positioning floats the bubble above the settings
     * grid instead of being sized by it.
     * @param {Element} info
     * @returns {void}
     */
    function positionPopover(info) {
      const btn = info.querySelector('.info-popover-btn')
      const pop = info.querySelector('.info-popover')
      if (!btn || !pop) return
      const btnRect = btn.getBoundingClientRect()
      const popW = pop.offsetWidth
      const popH = pop.offsetHeight
      const gap = 8
      const margin = 8
      let top = btnRect.bottom + gap
      let arrowPos = 'top'
      if (top + popH + margin > window.innerHeight) {
        top = btnRect.top - popH - gap
        arrowPos = 'bottom'
      }
      pop.style.top = Math.max(margin, top) + 'px'
      const left = Math.max(margin, Math.min(btnRect.left, window.innerWidth - popW - margin))
      pop.style.left = left + 'px'
      pop.dataset.arrowPos = arrowPos
      const btnCenter = btnRect.left + btnRect.width / 2
      const arrowLeft = Math.max(6, Math.min(btnCenter - left - 4, popW - 14))
      pop.style.setProperty('--arrow-left', arrowLeft + 'px')
    }

    /**
     * Keeps the open bubble anchored while the window resizes or the page
     * scrolls (capture catches scrolls inside overflow containers).
     * @param {Element} info
     * @returns {void}
     */
    function enableReposition(info) {
      disableReposition()
      repositionHandler = () => positionPopover(info)
      window.addEventListener('resize', repositionHandler)
      document.addEventListener('scroll', repositionHandler, true)
    }

    /** @returns {void} */
    function closeAll() {
      disableReposition()
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
      positionPopover(info)
      enableReposition(info)
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
