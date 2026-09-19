/* ---------------------------------------------------------------------------
   Choreography.

   Every timing decision in the transition lives in this file. Nothing here
   touches the DOM directly and nothing sets a timeout: the component hands in
   a `state` object (which the shader reads) and a `targets` object (which the
   timeline animates), and gets back a paused timeline it can play forward,
   play backward, or abandon mid-flight.

   WHY ONE REVERSIBLE TIMELINE
   ---------------------------
   Opening and closing are the same transition. Writing two timelines would
   mean two sets of easings to keep in sync and an interrupt handler that has
   to reconcile them. Instead there is one timeline; `open()` plays it forward
   and `close()` reverses it — via gsap's own `play()` / `reverse()`, which own
   the direction flag. (Do not reach for `timeScale(-1).play()`: `play()` is
   `reversed(false).paused(false)`, so it clears the flag you just set and the
   playhead never moves.) That buys three things for free:

     · Interrupts are exact. Clicking mid-transition reverses from precisely
       where the playhead is, with no reconciliation code.
     · Restoration is guaranteed. The playhead ends at time 0, which is the
       page's resting state by construction — not by a cleanup pass that might
       miss something.
     · The close is a true mirror, so it cannot drift from the open.

   Reading it forward, the shape is:

       CLICK
         → initial response        crest forms, intensity attacks in
         → the wave accelerates    sweep phase A  (power2.in)
         → distortion peaks        intensity holds at the crest
         → the wave settles        sweep phase B  (power4.out)
         → typography arrives      masked reveal, staggered behind the crest

   The two-phase sweep is the point of the whole thing. A single ease cannot
   both leave rest *and* arrive at rest while still peaking fast enough to feel
   physical; splitting it lets phase A accelerate off the right edge and phase
   B spend that momentum settling against the left.

   The "+" button is deliberately NOT in this timeline — see morphTrigger().
   --------------------------------------------------------------------------- */

import gsap from 'gsap'

/** All durations in seconds. Tune here, not in the component. */
export const TIMING = {
  // Right → left. 0.92s of travel: inside the 700–1200ms window, with the tail
  // of phase B being where the wave spends itself.
  sweepA: 0.34,
  sweepAPortion: 0.58,
  sweepB: 0.58,

  // Distortion attacks almost immediately and dies before the sweep ends, so
  // the settled state is perfectly crisp and the restoration is exact.
  intensityIn: 0.12,
  intensityHold: 0.46,
  intensityOut: 0.4,

  darkRamp: 0.5,
  grainRamp: 0.55,

  navStart: 0.52,
  navStagger: 0.07,
  navDuration: 0.65,
  navInsetDelay: 0.2,
  navInsetDuration: 0.6,

  // Trigger morph runs on its own tween, not the wave timeline.
  triggerMorph: 0.42,
  triggerDelayClose: 0.46,
}

/** Motion budget when prefers-reduced-motion is set. */
export const REDUCED_TIMING = {
  duration: 0.3,
  stagger: 0.04,
}

/** Peak darkness. Short of 1.0 so the page stays faintly legible underneath. */
export const DARK_MAX = 0.93
/** Grain once the wave has settled — enough to feel tactile, not noisy. */
export const GRAIN_MAX = 0.3

/**
 * The single object the shader reads. GSAP tweens these numbers; the render
 * loop reads them every frame. Keeping it a plain object (rather than tweening
 * GL uniforms directly) means the loop is the only thing that talks to WebGL.
 */
export function createShaderState() {
  return { progress: 0, intensity: 0, dark: 0, grain: 0, dir: 1 }
}

/** The page completely at rest. Anything else would leave the site altered. */
export function resetShaderState(state) {
  state.progress = 0
  state.intensity = 0
  state.dark = 0
  state.grain = 0
}

// ---------------------------------------------------------------------------
// The transition
// ---------------------------------------------------------------------------

/**
 * Build the wave timeline. Caller owns the playhead.
 *
 * @param {object} state   shader state, tweened in place
 * @param {object} targets nav DOM to animate
 * @returns {gsap.core.Timeline} paused
 */
export function buildWaveTimeline(state, targets) {
  const T = TIMING
  const tl = gsap.timeline({ paused: true })

  // Resting state, applied at time 0. Re-applied harmlessly on every reopen,
  // and the anchor that makes "reversed to the end" identical to "never
  // opened".
  tl.set(state, { progress: 0, intensity: 0, dark: 0, grain: 0 }, 0)

  // The labels start below their masks and rise into view. Setting these
  // unconditionally is safe: at yPercent ±118 a label is fully outside its
  // mask, so the jump is never visible even when the playhead is mid-flight.
  tl.set(
    targets.items.map((i) => i.label),
    { yPercent: 118 },
    0,
  )
  tl.set(
    targets.items.map((i) => i.index),
    { opacity: 0, y: 8 },
    0,
  )
  tl.set([targets.eyebrow, targets.foot], { opacity: 0, y: 12 }, 0)
  if (targets.veil) {
    tl.set(targets.veil, { opacity: 1 }, 0)
    tl.to(targets.veil, { opacity: 0, duration: T.darkRamp, ease: 'power2.out' }, 0.04)
  }

  // --- the wave ------------------------------------------------------------
  // Phase A: accelerate off the right edge.
  tl.to(state, { progress: T.sweepAPortion, duration: T.sweepA, ease: 'power2.in' }, 0)
  // Phase B: spend the momentum and settle against the left edge.
  tl.to(state, { progress: 1, duration: T.sweepB, ease: 'power4.out' }, T.sweepA)

  // --- grade ---------------------------------------------------------------
  // Darkness ramps early because the *spatial* progression is already handled
  // in the shader by the swept term; this is only the global gain.
  tl.to(state, { dark: DARK_MAX, duration: T.darkRamp, ease: 'power2.out' }, 0.06)
  tl.to(state, { grain: GRAIN_MAX, duration: T.grainRamp, ease: 'power2.out' }, 0.1)

  // --- distortion envelope -------------------------------------------------
  tl.to(state, { intensity: 1, duration: T.intensityIn, ease: 'power2.out' }, 0)
  tl.to(
    state,
    { intensity: 0, duration: T.intensityOut, ease: 'power2.inOut' },
    T.intensityIn + T.intensityHold,
  )

  // --- typography ----------------------------------------------------------
  // Timed so the items land just as the crest reaches the left edge, rather
  // than after a dead beat.
  tl.to(
    targets.items.map((i) => i.label),
    {
      yPercent: 0,
      duration: T.navDuration,
      ease: 'power3.out',
      stagger: T.navStagger,
    },
    T.navStart,
  )
  tl.to(
    targets.items.map((i) => i.index),
    {
      opacity: 1,
      y: 0,
      duration: T.navDuration * 0.8,
      ease: 'power3.out',
      stagger: T.navStagger,
    },
    T.navStart + 0.06,
  )
  tl.to(
    targets.eyebrow,
    { opacity: 1, y: 0, duration: T.navInsetDuration, ease: 'power3.out' },
    T.navStart - 0.12,
  )
  tl.to(
    targets.foot,
    { opacity: 1, y: 0, duration: T.navInsetDuration, ease: 'power3.out' },
    T.navStart + T.navInsetDelay,
  )

  return tl
}

/**
 * Reduced-motion / no-WebGL transition. Same contract, no shader: the nav
 * layer carries its own background (`.is-solid`) and the state change is a
 * plain cross-fade. Reversible in exactly the same way.
 */
export function buildReducedTimeline(targets) {
  const T = REDUCED_TIMING
  const tl = gsap.timeline({ paused: true })

  if (targets.veil) {
    tl.fromTo(
      targets.veil,
      { opacity: 1 },
      { opacity: 0, duration: T.duration, ease: 'power2.out' },
      0,
    )
  }

  tl.fromTo(
    targets.layer,
    { opacity: 0 },
    { opacity: 1, duration: T.duration, ease: 'power2.out' },
    0,
  )
  tl.set(
    targets.items.map((i) => i.index),
    { opacity: 1 },
    0,
  )
  tl.fromTo(
    targets.items.map((i) => i.label),
    { yPercent: 55, opacity: 0 },
    {
      yPercent: 0,
      opacity: 1,
      duration: T.duration * 1.5,
      ease: 'power2.out',
      stagger: T.stagger,
    },
    0,
  )
  tl.fromTo(
    [targets.eyebrow, targets.foot],
    { opacity: 0 },
    { opacity: 1, duration: T.duration, ease: 'power2.out' },
    0.05,
  )

  return tl
}

// ---------------------------------------------------------------------------
// The trigger
// ---------------------------------------------------------------------------

let triggerTween = null

/**
 * Morph the "+" pill into a circular close button, or back.
 *
 * Deliberately outside the wave timeline. The button is direct manipulation
 * feedback: it has to answer the click immediately in *both* directions, which
 * a reversible playhead cannot do (reversed, an early morph would fire at the
 * end of the close, and a late one would leave the open feeling dead).
 *
 * The label is clipped by the button's own overflow:hidden as the width
 * collapses, and the icon is absolutely positioned against the right edge of a
 * 44px-tall box, so it stays optically centred once the button is a circle.
 * Rotating the glyph 45° turns the plus into a cross without swapping markup.
 *
 * @param {object} targets
 * @param {boolean} opening
 * @param {number} [delay]
 */
export function morphTrigger(targets, opening, delay = 0) {
  const { el, labelEl, iconEl, width } = targets.trigger
  if (!el) return

  const circle = el.offsetHeight || 44
  const duration = TIMING.triggerMorph

  triggerTween?.kill()
  triggerTween = gsap
    .timeline({ delay })
    .to(el, { width: opening ? circle : width, duration, ease: 'power3.inOut' }, 0)
    .to(
      iconEl,
      { rotation: opening ? 45 : 0, duration, ease: 'power3.inOut', transformOrigin: '50% 50%' },
      0,
    )

  if (labelEl) {
    triggerTween.to(
      labelEl,
      opening
        ? { opacity: 0, x: -10, duration: duration * 0.45, ease: 'power2.in' }
        : { opacity: 1, x: 0, duration: duration * 0.55, ease: 'power2.out' },
      opening ? 0 : duration * 0.35,
    )
  }
}
