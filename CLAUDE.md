# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SANDWAVE is an experimental navigation interaction where opening the nav triggers a wave of sand-like distortion that sweeps across the entire viewport, transforming the page rather than simply covering it. Built with Vite, GSAP, WebGL, and vanilla JavaScript.

## Common Commands

```bash
# Development
npm run dev          # Start dev server at http://localhost:5173/

# Production
npm run build        # Build to dist/
npm run preview      # Preview production build at http://localhost:4173/
```

## Architecture

### Core Components

**SandwaveNav** (`src/nav/SandwaveNav.js`)
- Public API: `open()`, `close()`, `toggle()`, `prewarm()`, `invalidate()`, `dispose()`
- Lifecycle owner: manages render loop, rasterization, scroll lock, inert state
- Switches between WebGL and CSS fallback based on `prefers-reduced-motion`
- Exposes itself as `window.sandwaveNav` for dev/debug

**WaveRenderer** (`src/nav/WaveRenderer.js`)
- WebGL context owner
- Fill-rate budget: 3.4M pixels (dynamically scaled on high-DPI)
- Handles context loss, resize, texture upload
- Styled as `position: fixed; inset: 0; z-index: 30`

**Timeline** (`src/nav/timeline.js`)
- Single reversible GSAP timeline
- Opens via `timeline.play()`, closes via `timeline.reverse()`
- **Critical:** Do NOT use `timeScale(-1).play()` — `play()` clears the reversed flag
- Two-phase sweep: phase A `power2.in` (accelerate), phase B `power4.out` (settle)
- Separate trigger morph tween (independent of wave timeline)

**Shaders** (`src/nav/gl/shaders.js`)
- Full-screen quad fragment shader
- Turbulent wave front: layered sines + fbm noise for organic dune character
- Signed-distance from wave front with gaussian distortion band
- Darkness/grain/chromatic-aberration grade
- Fine noise frequency tuned to 17 (one cycle per line of type) — higher values shred letterforms

**Snapshot** (`src/nav/snapshot.js`)
- html2canvas wrapper
- Awaits `document.fonts.ready` before capture
- Scroll-offset-aware cropping
- Blank-canvas detector (html2canvas fails silently on unsupported CSS)

### Key Architectural Decisions

1. **WebGL is justified** — SVG feDisplacementMap cannot express a traveling turbulence-shaped front without re-rasterizing a filter over the whole document every frame (far slower than one full-screen quad)

2. **One reversible timeline** — guarantees exact interrupts, exact restoration, and no open/close drift. The trigger morph is separate because it needs immediate feedback in both directions

3. **Rasterization cost** solved with:
   - Idle prewarm (`requestIdleCallback`)
   - Per-scroll-offset caching (texture is wrong once scrolled)
   - Debounced scroll-end re-prewarm (420ms)

4. **Direction smoothing** — `_dir` eases toward `_dirTarget` with 0.16 lerp, so interrupts collapse the crest through zero rather than mirroring displacement in one frame

5. **Stacking contexts matter** — `.masthead` is `position: fixed; z-index: 60` to keep the close button above the canvas (z-30) and nav layer (z-40). A positioned element with z-index creates a stacking context, trapping child z-index values inside it

## Important Constraints

### html2canvas Compatibility

Modern CSS features like `oklch()`, `color()`, `color-mix()`, and `lab()` render as **black** in the snapshot. Use plain hex/rgb for anything under `#page`.

See the header comment in `src/styles/tokens.css` for the full list.

### Scroll Lock Implementation

The component uses `body { position: fixed; top: -scrollY }` for scroll lock. It compensates for scrollbar width on `body.paddingRight` and `trigger.marginRight` so the page doesn't reflow wider when the scrollbar disappears.

Unlock MUST happen while the canvas still covers the page, then `await nextFrame()` before hiding the canvas — otherwise the scroll restore is visible.

### Reduced-Motion Path

When `prefers-reduced-motion: reduce` is detected:
- No WebGL context is built (`this.renderer = null`)
- `.sandwave-nav` gets `.is-solid` class (solid background)
- A simpler GSAP timeline cross-fades the nav layer
- Works exactly like the wave path (same open/close API, same restoration guarantee)

### Shader Tuning Guidelines

- **Fine noise frequency** — currently 17 (one cycle per line of type). Higher values shred letterforms into flag-like ripple
- **Chromatic aberration** — currently 0.00045. This site is near-black on near-white (worst case for RGB split); past ~0.0006 it reads as anaglyph fringing
- **Crest lip glow** — currently 0.05. Past ~0.07 it reads as glow rather than a dune crest catching light
- **Distortion amplitude** — currently 0.055. Increase cautiously; vertical displacement past ~1.0 makes the page appear to melt rather than move

## Development Tips

- **Debug the wave mid-transition:** `window.sandwaveNav._timeline.pause()`, then `._timeline.time(0.5)` to seek
- **Force a re-rasterization:** `window.sandwaveNav.invalidate()`
- **Measure trigger width:** The component calls `_measureTrigger()` on init and resize, which temporarily sets `width: auto` to get the intrinsic width
- **Verify restoration:** After a close, check `document.body.className`, `document.body.style`, `document.documentElement.style`, `document.querySelectorAll('[inert]')`, `window.scrollY`

## Known Issues / Gotchas

1. **`position: sticky` not supported** — html2canvas doesn't implement sticky positioning. The masthead is `position: fixed` instead, and `#page` has `padding-top: 80px` to clear it

2. **Focus management** — Focus moves into the first nav item 350ms after open. The page behind is `inert` (except the branch containing the trigger), so Tab cycles between nav items and the close button without needing a focus trap

3. **Context loss** — If the WebGL context is lost mid-transition, the component switches to the CSS fallback via `_switchToFallback()`

4. **Foot clips below viewport** — At certain viewport heights (e.g. 895px), the nav foot extends slightly below the fold. This is expected given the design's `justify-content: space-between` with four large nav items

## Testing Checklist

When making changes, verify:
- [ ] Open/close cycles work repeatedly (at least 3×)
- [ ] Interrupting mid-open works (click close while wave is traveling)
- [ ] Interrupting a close by reopening works
- [ ] Close restores the page exactly (no leftover styles/classes/inert/scroll offset)
- [ ] Mobile layout (375×667 or similar)
- [ ] Reduced-motion path (emulate `prefers-reduced-motion: reduce`)
- [ ] Production build (`npm run build && npm run preview`)

## File Naming Conventions

- Component files: PascalCase (e.g. `SandwaveNav.js`, `WaveRenderer.js`)
- Utility files: camelCase (e.g. `snapshot.js`, `timeline.js`, `utils.js`)
- Directories: kebab-case (e.g. `gl/`, `nav/`)
- CSS files: kebab-case (e.g. `tokens.css`, `page.css`, `nav.css`)
