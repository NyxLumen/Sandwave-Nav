export const clamp = (v, min, max) => Math.min(Math.max(v, min), max)

export const lerp = (a, b, t) => a + (b - a) * t

export function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function onReducedMotionChange(handler) {
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
  const fn = (e) => handler(e.matches)
  mq.addEventListener('change', fn)
  return () => mq.removeEventListener('change', fn)
}

/** Width of the classic scrollbar, or 0 on overlay-scrollbar platforms. */
export function scrollbarWidth() {
  return Math.max(0, window.innerWidth - document.documentElement.clientWidth)
}

export function debounce(fn, wait) {
  let id
  return (...args) => {
    clearTimeout(id)
    id = setTimeout(() => fn(...args), wait)
  }
}

export function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}
