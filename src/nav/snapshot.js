/* ---------------------------------------------------------------------------
   Rasterise the live page into a canvas, so it can be handed to the shader as
   a texture.

   This is the one genuinely awkward part of the technique: WebGL cannot sample
   DOM. Everything else in the system is cheap; this is the cost of being able
   to displace real page content rather than a picture of it.

   Two things make it reliable here:
     1. The page is scroll-locked (body position:fixed) *before* capture, so
        the viewport maps to a known, stable crop.
     2. Anything that must not appear in the texture carries
        `data-sandwave-ignore` — the nav layer, the canvas itself, and the "+"
        trigger (which stays live on top of the canvas).

   The caller is expected to fall back to the CSS transition if this returns
   null.
   --------------------------------------------------------------------------- */

import html2canvas from 'html2canvas'

/**
 * @param {HTMLElement} element      usually document.body
 * @param {object} opts
 * @param {number} opts.scale        device pixels per CSS pixel
 * @param {number} opts.width        viewport width in CSS px
 * @param {number} opts.height       viewport height in CSS px
 * @param {number} [opts.scrollY]    document scroll offset to crop at
 * @param {string} [opts.backgroundColor]
 * @returns {Promise<HTMLCanvasElement|null>}
 */
export async function capturePage(element, opts) {
  const {
    scale,
    width,
    height,
    scrollY = 0,
    backgroundColor = null,
  } = opts

  try {
    // Web fonts change metrics; capturing before they settle produces a
    // texture whose text does not line up with the live page.
    if (document.fonts?.ready) await document.fonts.ready

    const canvas = await html2canvas(element, {
      backgroundColor,
      scale,
      width,
      height,
      // `x`/`y` are element-local. The viewport begins `scrollY` down the
      // document, so that is the crop — and scrollX/scrollY are pinned to 0 so
      // html2canvas renders the element from its own origin rather than
      // pre-scrolling the clone and double-counting the offset.
      x: 0,
      y: scrollY,
      windowWidth: width,
      windowHeight: height,
      scrollX: 0,
      scrollY: 0,
      useCORS: true,
      allowTaint: false,
      logging: false,
      removeContainer: true,
      ignoreElements: (el) =>
        el instanceof HTMLElement && 'sandwaveIgnore' in el.dataset,
      // Last line of defence: force the transitional layers out of the clone
      // even if ignoreElements misses them.
      onclone: (doc) => {
        doc.querySelectorAll('[data-sandwave-ignore]').forEach((el) => el.remove())
      },
    })

    if (!canvas || !canvas.width || !canvas.height) {
      console.warn('[sandwave] snapshot produced an empty canvas.')
      return null
    }

    if (!isProbablyRendered(canvas)) {
      console.warn('[sandwave] snapshot looks blank — falling back to CSS transition.')
      return null
    }

    return canvas
  } catch (err) {
    console.warn('[sandwave] snapshot failed — falling back to CSS transition.', err)
    return null
  }
}

/**
 * html2canvas fails *quietly* in several situations (unsupported CSS, a
 * stylesheet it cannot read, a tainted image). When it does, it hands back a
 * fully transparent canvas — which would read on screen as the whole site
 * vanishing. Sampling for opacity catches that.
 */
function isProbablyRendered(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return true

  const { width, height } = canvas
  // A coarse grid is plenty; we only care about "did anything draw".
  const stepX = Math.max(1, Math.floor(width / 24))
  const stepY = Math.max(1, Math.floor(height / 24))
  const sample = ctx.getImageData(0, 0, width, height).data
  let opaque = 0
  let total = 0

  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const alpha = sample[(y * width + x) * 4 + 3]
      if (alpha > 8) opaque++
      total++
    }
  }

  return total === 0 || opaque / total > 0.5
}
