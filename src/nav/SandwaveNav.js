/* ---------------------------------------------------------------------------
   SandwaveNav — the public surface.

   Owns the navigation state machine, the nav DOM, and the render loop. It
   delegates the three things it should not know about:

     visual distortion  →  WaveRenderer (+ shaders)
     animation timing   →  timeline.js
     navigation content →  content/navItems.js

   Everything it does itself is lifecycle: locking the page, rasterising it,
   running the ticker, and knowing whether the thing is open, closed, or in
   between.
   --------------------------------------------------------------------------- */

import gsap from 'gsap'

import { WaveRenderer } from './WaveRenderer.js'
import { capturePage } from './snapshot.js'
import {
  buildWaveTimeline,
  buildReducedTimeline,
  createShaderState,
  resetShaderState,
  morphTrigger,
  TIMING,
} from './timeline.js'
import {
  prefersReducedMotion,
  onReducedMotionChange,
  scrollbarWidth,
  debounce,
  nextFrame,
} from './utils.js'
import { navItems, navSocial, navMeta } from '../content/navItems.js'

const IDLE = window.requestIdleCallback?.bind(window) ?? ((fn) => setTimeout(fn, 200))
const CANCEL_IDLE = window.cancelIdleCallback?.bind(window) ?? clearTimeout

export class SandwaveNav {
  /**
   * @param {object} [opts]
   * @param {string|HTMLElement} [opts.trigger] the existing "+" button
   * @param {string|HTMLElement} [opts.page]    the site wrapper
   * @param {Array}  [opts.items]   nav links
   * @param {Array}  [opts.social]  secondary links
   * @param {object} [opts.meta]
   * @param {number} [opts.amplitude] displacement strength, uv units
   * @param {boolean}[opts.prewarm] rasterise during idle so the first click is instant
   * @param {boolean}[opts.lockScroll]
   */
  constructor(opts = {}) {
    this.opts = {
      trigger: '#nav-trigger',
      page: '#page',
      amplitude: 0.055,
      prewarm: true,
      lockScroll: true,
      ...opts,
    }

    this.trigger = resolve(this.opts.trigger)
    this.page = resolve(this.opts.page)
    this.veil = document.querySelector('.masthead__veil')
    this.items = opts.items ?? navItems
    this.social = opts.social ?? navSocial
    this.meta = opts.meta ?? navMeta

    this.state = createShaderState()
    this.state.time = 0

    this._open = false
    this._started = false
    this._disposed = false
    this._locked = false
    this._scrollY = 0
    this._prepared = null
    this._loopRunning = false
    // Smoothed drag direction. Snapping this between +1 and -1 the instant the
    // user interrupts would mirror the displacement in one frame, which reads
    // as a jolt; easing it through zero collapses the crest and releases it.
    this._dir = 1
    this._dirTarget = 1
    this._t0 = performance.now()

    this._tick = this._tick.bind(this)

    this._build()
    this._initRenderer()
    this._initTimeline()
    this._bind()
  }

  // --- public --------------------------------------------------------------

  async open() {
    if (this._open || this._disposed) return
    this._open = true

    // Direct-manipulation feedback has to be immediate, before any awaiting.
    morphTrigger(this.targets, true, 0)
    this._dirTarget = 1
    this.trigger?.setAttribute('aria-expanded', 'true')
    document.body.classList.add('is-nav-open')
    this.layer.classList.add('is-open')
    this._setPageInert(true)
    this._lock()

    if (this._fallback) {
      this._start()
      return
    }

    const ready = await this._ensurePrepared()
    // The user may have closed again while we were rasterising.
    if (!this._open) return
    if (!ready) {
      console.warn('[sandwave] no page texture — running the reduced transition.')
      this._switchToFallback()
    }
    this._start()
  }

  close() {
    if (!this._open || this._disposed) return
    this._open = false

    // Only defer the button on a real close; if we are still rasterising there
    // is no wave to wait for, so it should snap back at once.
    morphTrigger(this.targets, false, this._started ? TIMING.triggerDelayClose : 0)
    this.trigger?.setAttribute('aria-expanded', 'false')

    if (!this._started) {
      this._teardown()
      return
    }
    // `reverse()` rather than `timeScale(-1).play()`. GSAP's play() is
    // `reversed(false).paused(false)` — it *clears* the reversed flag, so
    // setting a negative timeScale and then calling play() silently does
    // nothing and leaves the playhead parked at the end. Let the timeline own
    // its own direction.
    this._timeline.reverse()
  }

  toggle() {
    return this._open ? this.close() : this.open()
  }

  /** Drop the cached snapshot and re-rasterise on the next open. */
  invalidate() {
    this._prepared = null
    this._preparedScrollY = null
    this._preparePromise = null
    if (this.opts.prewarm && !this._disposed) IDLE(() => this._ensurePrepared())
  }

  /**
   * Rasterise the page now rather than on first click. Safe to call at any
   * time; resolves false in the reduced-motion / no-WebGL path.
   * @returns {Promise<boolean>}
   */
  prewarm() {
    if (this._fallback || this._disposed) return Promise.resolve(false)
    return this._ensurePrepared()
  }

  dispose() {
    if (this._disposed) return
    this._disposed = true

    this._timeline?.kill()
    this._stopLoop()
    this._unbind()
    if (this._locked) this._unlock()

    this.renderer?.dispose()
    this.layer.remove()
    if (this._idleHandle !== undefined) CANCEL_IDLE(this._idleHandle)
  }

  // --- setup ---------------------------------------------------------------

  _build() {
    const layer = document.createElement('div')
    layer.className = 'sandwave-nav'
    layer.id = 'sandwave-nav'
    // Keeps the layer, and the canvas, out of the rasterised snapshot.
    layer.setAttribute('data-sandwave-ignore', '')

    const eyebrow = document.createElement('p')
    eyebrow.className = 'sandwave-nav__eyebrow'
    eyebrow.textContent = this.meta.eyebrow ?? 'Navigation'
    layer.appendChild(eyebrow)

    const list = document.createElement('nav')
    list.className = 'sandwave-nav__list'
    list.setAttribute('aria-label', 'Primary')

    const itemTargets = this.items.map((item, i) => {
      const a = document.createElement('a')
      a.className = 'sandwave-nav__item'
      a.href = item.href ?? '#'

      // The mask is what makes the reveal read as typography being *drawn up*
      // rather than sliding: the glyphs are clipped by their own leading edge.
      const mask = document.createElement('span')
      mask.className = 'sandwave-nav__mask'
      const label = document.createElement('span')
      label.className = 'sandwave-nav__label'
      label.textContent = item.label
      mask.appendChild(label)

      const index = document.createElement('span')
      index.className = 'sandwave-nav__index'
      index.textContent = String(i + 1).padStart(2, '0')

      const rule = document.createElement('span')
      rule.className = 'sandwave-nav__rule'
      rule.setAttribute('aria-hidden', 'true')

      a.append(mask, index, rule)
      a.addEventListener('click', () => this.close())
      list.appendChild(a)

      return { el: a, label, index, rule }
    })
    layer.appendChild(list)

    const foot = document.createElement('div')
    foot.className = 'sandwave-nav__foot'

    const social = document.createElement('div')
    social.className = 'sandwave-nav__social'
    for (const s of this.social) {
      const a = document.createElement('a')
      a.href = s.href ?? '#'
      a.textContent = s.label
      social.appendChild(a)
    }

    const meta = document.createElement('p')
    meta.className = 'sandwave-nav__meta'
    meta.textContent = this.meta.note ?? ''

    foot.append(social, meta)
    layer.appendChild(foot)

    document.body.appendChild(layer)

    this.layer = layer
    this.targets = {
      layer,
      items: itemTargets,
      eyebrow,
      foot,
      trigger: {
        el: this.trigger,
        labelEl: this.trigger?.querySelector('.nav-trigger__label') ?? null,
        iconEl: this.trigger?.querySelector('.nav-trigger__icon') ?? null,
        width: 0,
      },
    }

    this._measureTrigger()
  }

  _initRenderer() {
    // Under reduced motion we never build a context at all: allocating one and
    // then declining to draw would be a waste of a GPU context slot.
    if (prefersReducedMotion()) {
      this.renderer = null
      this._fallback = true
    } else {
      this.renderer = new WaveRenderer({ amplitude: this.opts.amplitude })
      this._fallback = !this.renderer.supported

      if (this.renderer.supported) {
        // A lost context mid-transition cannot be recovered; drop to CSS rather
        // than leaving a frozen frame on screen.
        this.renderer.onContextLost = () => this._switchToFallback()
        document.body.appendChild(this.renderer.canvas)
        this._hideCanvas()
      }
    }

    this._stopReducedMotionWatch = onReducedMotionChange((reduced) => {
      if (this._disposed || this._open) return
      if (reduced && !this._fallback) this._switchToFallback()
      else if (!reduced && this._fallback && this.renderer?.supported) this._switchToWave()
    })
  }

  _initTimeline() {
    this._timeline?.kill()
    this._timeline = this._fallback
      ? buildReducedTimeline(this.targets)
      : buildWaveTimeline(this.state, this.targets)

    this.layer.classList.toggle('is-solid', this._fallback)

    this._timeline.eventCallback('onReverseComplete', () => {
      this._started = false
      this._teardown()
    })
  }

  _bind() {
    this._onTriggerClick = (e) => {
      e.preventDefault()
      this.toggle()
    }
    this.trigger?.addEventListener('click', this._onTriggerClick)

    this._onKeydown = (e) => {
      if (e.key === 'Escape' && this._open) {
        e.preventDefault()
        this.close()
      }
    }
    document.addEventListener('keydown', this._onKeydown)

    this._onResize = debounce(() => this._handleResize(), 180)
    window.addEventListener('resize', this._onResize)
    window.addEventListener('orientationchange', this._onResize)

    // Once scrolling settles, re-rasterise for wherever the user actually is.
    // The texture is cached per scroll offset, so this is what keeps the click
    // instant on a page that has been scrolled — Deferred to idle so it can
    // never compete with scrolling itself.
    this._onScrollSettle = debounce(() => {
      if (this._disposed || this._open || this._fallback || !this.opts.prewarm) return
      IDLE(() => this._ensurePrepared())
    }, 420)
    window.addEventListener('scroll', this._onScrollSettle, { passive: true })
  }

  _unbind() {
    this.trigger?.removeEventListener('click', this._onTriggerClick)
    document.removeEventListener('keydown', this._onKeydown)
    window.removeEventListener('resize', this._onResize)
    window.removeEventListener('orientationchange', this._onResize)
    window.removeEventListener('scroll', this._onScrollSettle)
    this._stopReducedMotionWatch?.()
  }

  // --- snapshot ------------------------------------------------------------

  _captureScrollY() {
    // While locked the document has no scroll extent, so the saved offset is
    // the only correct answer.
    return this._locked ? this._scrollY : window.scrollY
  }

  /**
   * Rasterise the page and hand it to the renderer.
   *
   * Cached per scroll offset: a texture captured at the top of the page is
   * wrong the moment the user scrolls, and rendering it would show the wrong
   * part of the site frozen under the wave.
   *
   * @returns {Promise<boolean>} whether a texture is ready
   */
  async _ensurePrepared() {
    if (this._prepared && this._preparedScrollY === this._captureScrollY()) return true
    if (this._preparePromise) return this._preparePromise

    this._preparePromise = (async () => {
      try {
        const w = window.innerWidth
        const h = window.innerHeight
        const scrollY = this._captureScrollY()
        this.renderer.resize(w, h)

        const canvas = await capturePage(this.page, {
          scale: this.renderer.pixelScale,
          width: w,
          height: h,
          scrollY,
          // Explicit, so the gradient on #page is not the only thing keeping
          // the texture opaque.
          backgroundColor: '#efeae3',
        })

        if (!canvas) return false

        this.renderer.setPageTexture(canvas)
        this._prepared = true
        this._preparedScrollY = scrollY
        return true
      } catch (err) {
        console.warn('[sandwave] preparation failed.', err)
        return false
      } finally {
        this._preparePromise = null
      }
    })()

    return this._preparePromise
  }

  // --- transition ----------------------------------------------------------

  _start() {
    this._started = true
    // Draw the resting frame before revealing the canvas, so it is never
    // briefly visible empty.
    this.renderer?.render(this.state)
    this._showCanvas()
    this._startLoop()
    this._timeline.play()

    // Focus moves into the nav; the page behind is inert, so Tab cycles
    // between the nav and the trigger without a trap.
    gsap.delayedCall(0.35, () => {
      if (this._open) this.targets.items[0]?.el.focus({ preventScroll: true })
    })
  }

  /** Reverse-complete teardown, or the abort path when nothing ever started. */
  async _teardown() {
    this._started = false

    const hadFocus = this.layer.contains(document.activeElement)

    this.layer.classList.remove('is-open')
    document.body.classList.remove('is-nav-open')
    this._setPageInert(false)
    resetShaderState(this.state)

    // Release the scroll lock while the canvas still covers the page, so the
    // jump back to the saved offset is never visible. Then wait a frame before
    // removing the cover.
    this._unlock()
    await nextFrame()
    if (this._disposed) return
    this._hideCanvas()
    this._stopLoop()

    if (hadFocus) this.trigger?.focus({ preventScroll: true })
  }

  _handleResize() {
    if (this._disposed) return

    this._measureTrigger()

    if (this._fallback) return

    this.renderer.resize(window.innerWidth, window.innerHeight)

    // The texture is viewport-shaped; it is now the wrong shape.
    this._prepared = null
    this._preparePromise = null

    if (this._started) {
      this._ensurePrepared().then((ok) => {
        if (!ok) this._switchToFallback()
      })
    } else if (this.opts.prewarm) {
      IDLE(() => this._ensurePrepared())
    }
  }

  _switchToFallback() {
    if (this._fallback) return
    this._fallback = true
    this._hideCanvas()
    this._stopLoop()
    this._initTimeline()
  }

  _switchToWave() {
    if (!this._fallback || !this.renderer?.supported) return
    this._fallback = false
    this._initTimeline()
  }

  // --- render loop ---------------------------------------------------------

  _startLoop() {
    if (this._loopRunning || this._fallback || this._disposed) return
    this._loopRunning = true
    gsap.ticker.add(this._tick)
  }

  _stopLoop() {
    if (!this._loopRunning) return
    this._loopRunning = false
    gsap.ticker.remove(this._tick)
  }

  _tick() {
    const s = this.state
    s.time = (performance.now() - this._t0) / 1000

    const d = this._dirTarget - this._dir
    this._dir = Math.abs(d) < 0.002 ? this._dirTarget : this._dir + d * 0.16
    s.dir = this._dir

    this.renderer.render(s)
  }

  // --- chrome --------------------------------------------------------------

  _showCanvas() {
    if (this.renderer?.canvas) this.renderer.canvas.style.display = 'block'
    // Hide the live masthead veil while the WebGL canvas is displayed so the
    // gradient/blur is not rendered twice (the canvas already contains it from
    // the snapshot).
    if (this.veil) this.veil.style.opacity = '0'
  }

  _hideCanvas() {
    if (this.renderer?.canvas) this.renderer.canvas.style.display = 'none'
    // Restore the live masthead veil when the normal DOM becomes visible again.
    if (this.veil) this.veil.style.opacity = ''
  }

  /**
   * Inert everything under the page wrapper except the branch holding the
   * trigger — inverting the whole page would make the close button itself
   * unreachable.
   */
  _setPageInert(on) {
    if (!this.page) return
    for (const child of this.page.children) {
      if (child === this.layer) continue
      if (this.trigger && child.contains(this.trigger)) continue
      if (on) child.setAttribute('inert', '')
      else child.removeAttribute('inert')
    }
  }

  _measureTrigger() {
    const el = this.trigger
    if (!el) return 0

    // Measuring with width:auto sidesteps the fact that the button is a circle
    // for most of its life. The label is flex:none, so it reports its intrinsic
    // width even while the parent clips it.
    const prev = el.style.width
    el.style.width = 'auto'
    const natural = Math.ceil(el.getBoundingClientRect().width)
    el.style.width = prev || `${natural}px`

    this.targets.trigger.width = natural
    return natural
  }

  _lock() {
    if (!this.opts.lockScroll || this._locked) return
    this._locked = true
    this._scrollY = window.scrollY

    // Compensating for the scrollbar keeps the page from reflowing wider the
    // instant we hide it — which would desync the snapshot from the live page.
    const sbw = scrollbarWidth()
    if (sbw > 0) {
      document.body.style.paddingRight = `${sbw}px`
      if (this.trigger) this.trigger.style.marginRight = `${sbw}px`
    }

    document.body.style.top = `-${this._scrollY}px`
    document.body.classList.add('is-locked')
    document.documentElement.style.overflow = 'hidden'
  }

  _unlock() {
    if (!this._locked) return
    this._locked = false

    document.body.classList.remove('is-locked')
    document.body.style.top = ''
    document.body.style.paddingRight = ''
    document.documentElement.style.overflow = ''
    if (this.trigger) this.trigger.style.marginRight = ''

    window.scrollTo(0, this._scrollY)
  }
}

function resolve(target) {
  if (!target) return null
  return typeof target === 'string' ? document.querySelector(target) : target
}
