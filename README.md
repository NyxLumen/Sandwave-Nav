# SANDWAVE

An experimental navigation interaction where opening the nav feels like a wave of sand sweeping across the entire site — transforming the page rather than simply covering it.

## Overview

SANDWAVE demonstrates a premium navigation transition using WebGL displacement and GSAP animation. Instead of a conventional sidebar slide, clicking the menu button triggers a fluid distortion wave that travels from right to left across the viewport, progressively darkening and displacing the underlying content. The effect reads as one continuous material transformation rather than two separate layers.

**[Live Demo](http://localhost:4173/)** (when preview server is running)

## Key Features

- **WebGL displacement shader** — Turbulent wave front with organic dune-like character, driven by layered noise and incommensurate sine waves
- **Single reversible timeline** — Opens forward, closes backward via GSAP's `reverse()`, guaranteeing exact restoration and handling interrupts cleanly
- **Scroll-aware rasterization** — Idle prewarm + per-scroll-offset caching keeps the first click instant
- **Responsive** — Adapts layout and type scale for mobile viewports while preserving the wave concept
- **Accessible** — Respects `prefers-reduced-motion` with a CSS cross-fade fallback (no WebGL context built)
- **Production-ready** — Verified across repeated cycles, interrupts, mobile layout, reduced motion, and production builds

## Tech Stack

- **Vite** 5.4.21 — dev server + build tool
- **GSAP** 3.15.0 — animation orchestration and timeline management
- **html2canvas** 1.4.1 — rasterizes the live page into a WebGL texture
- **Vanilla JavaScript** — ES modules, no framework

## Project Structure

```
src/
├── main.js                 # Entry point
├── styles/
│   ├── tokens.css         # Color palettes (paper/night)
│   ├── page.css           # Editorial demo site styles
│   └── nav.css            # Dark navigation overlay styles
├── content/
│   └── navItems.js        # Navigation links and metadata
└── nav/
    ├── SandwaveNav.js     # Public component API
    ├── WaveRenderer.js    # WebGL context owner
    ├── snapshot.js        # html2canvas wrapper
    ├── timeline.js        # GSAP animation choreography
    ├── utils.js           # Shared utilities
    └── gl/
        ├── shaders.js     # Vertex + fragment shader source
        └── program.js     # WebGL program compiler
```

## Installation

```bash
npm install
```

## Development

```bash
npm run dev
```

Opens dev server at `http://localhost:5173/`

## Build

```bash
npm run build
npm run preview
```

Production build outputs to `dist/`. Preview server runs at `http://localhost:4173/`

## Usage

The component is constructed and prewarmed automatically in `src/main.js`:

```js
import { SandwaveNav } from './nav/SandwaveNav.js'

const nav = new SandwaveNav({
  trigger: '#nav-trigger',  // existing button
  page: '#page',            // site wrapper to rasterize
  amplitude: 0.055,         // displacement strength
  prewarm: true,            // rasterize during idle
  lockScroll: true,         // freeze scroll while open
})

nav.prewarm()  // optional: warm the cache immediately
window.sandwaveNav = nav
```

### API

```js
nav.open()       // open the navigation
nav.close()      // close the navigation
nav.toggle()     // toggle open/close
nav.invalidate() // drop the cached snapshot, re-rasterize on next open
nav.prewarm()    // rasterize now (async, returns Promise<boolean>)
nav.dispose()    // clean up (kills timeline, removes canvas, unbinds events)
```

## Architecture Notes

### Why WebGL?

The alternative — SVG `feDisplacementMap` over the live DOM — cannot express a *traveling*, turbulence-shaped wave front without re-rasterizing an SVG filter over the entire document every frame, which is far slower than one full-screen quad. WebGL is justified here because the shader does real work: a per-pixel displacement field evaluated against a rasterized copy of the page.

### Why one reversible timeline?

Writing separate open/close timelines would mean two sets of easings to keep in sync and an interrupt handler that has to reconcile them. Instead, there is one timeline: `open()` plays it forward via `play()`, and `close()` reverses it via `reverse()`. This buys three things for free:

1. **Interrupts are exact** — clicking mid-transition reverses from precisely where the playhead is, with no reconciliation code
2. **Restoration is guaranteed** — the playhead ends at time 0, which is the page's resting state by construction
3. **The close is a true mirror** — it cannot drift from the open

**Critical:** Use GSAP's own `play()` / `reverse()` methods to control direction. Do NOT use `timeScale(-1).play()` — `play()` is `reversed(false).paused(false)`, so it clears the reversed flag you just set and the playhead never moves.

### Rasterization cost

html2canvas is the one genuinely expensive part of the technique. Three strategies make it reliable:

1. **Idle prewarm** — the first rasterization runs during `requestIdleCallback`, so the first click gets a wave rather than a stall
2. **Per-scroll-offset caching** — a texture captured at the top of the page is wrong once the user scrolls; the component caches per scroll position
3. **Debounced scroll-end re-prewarm** — once scrolling settles (420ms debounce), the component re-rasterizes for wherever the user actually is

### Direction smoothing for interrupts

The `_dir` state (which controls the horizontal displacement direction in the shader) eases toward `_dirTarget` with a 0.16 lerp, snapping below 0.002. When the user interrupts mid-transition, this smoothing collapses the crest through zero rather than mirroring the displacement in one frame — which would read as a jolt.

## Browser Support

- Modern browsers with WebGL 1.0 support
- Gracefully degrades to CSS cross-fade when `prefers-reduced-motion: reduce` is set (no WebGL context built)

## Performance

- **Fill-rate budget:** 3.4M pixels max (viewport dynamically scaled on high-DPI displays)
- **Render loop:** Runs on `gsap.ticker`, only active while the transition is in flight
- **Memory:** WebGL context released on dispose; canvas removed from DOM when not rendering

## Known Limitations

- **html2canvas compatibility:** Modern CSS features like `oklch()` and `color-mix()` render as black in the snapshot — use plain hex/rgb for anything under `#page`
- **Scroll performance:** Heavy distortion during scroll can drop frames on lower-end devices; reduced on mobile via `amplitude` tuning
- **Stacking contexts:** The masthead must sit at z-index 60+ to keep the close button above the canvas — a lower z-index traps the button inside its own stacking context

## License

MIT

## Credits

Built as a demonstration of portfolio-quality web animation and shader-based interaction design.
