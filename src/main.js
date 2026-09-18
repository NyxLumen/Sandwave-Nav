import './styles/tokens.css'
import './styles/page.css'
import './styles/nav.css'

import { SandwaveNav } from './nav/SandwaveNav.js'

const nav = new SandwaveNav({
  trigger: '#nav-trigger',
  page: '#page',
})

// Rasterising the page takes a few hundred milliseconds. Doing it up front,
// while the browser is idle, means the first click gets a wave instead of a
// stall.
if (nav.opts.prewarm) {
  const idle = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 300))
  idle(() => nav.prewarm())
}

// Handy while experimenting.
window.sandwaveNav = nav

export default nav
