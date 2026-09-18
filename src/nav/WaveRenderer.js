/* ---------------------------------------------------------------------------
   WaveRenderer — owns the WebGL context and nothing else.

   It knows how to draw a displaced, darkened, grained copy of a rasterised
   page. It does not know what navigation is, when to open, or how long a
   transition should take. All of that arrives as a plain state object.
   --------------------------------------------------------------------------- */

import { createProgram, createNoiseTexture } from './gl/program.js'
import { VERT_SRC, FRAG_SRC } from './gl/shaders.js'

/** Fill-rate budget, in device pixels. Above this we stop increasing scale. */
const MAX_PIXELS = 3_400_000

export class WaveRenderer {
  /**
   * @param {object} [opts]
   * @param {number} [opts.amplitude] Displacement amplitude in uv units.
   * @param {number} [opts.maxDpr]    Hard ceiling on device pixel ratio.
   */
  constructor({ amplitude = 0.055, maxDpr = 2 } = {}) {
    this.amplitude = amplitude
    this.maxDpr = maxDpr

    this.canvas = document.createElement('canvas')
    this.canvas.className = 'sandwave-canvas'
    this.canvas.setAttribute('data-sandwave-ignore', '')
    Object.assign(this.canvas.style, {
      position: 'fixed',
      inset: '0',
      width: '100%',
      height: '100%',
      zIndex: '30',
      pointerEvents: 'none',
      display: 'block',
      // The canvas is a full opaque copy of the page; promote it so the
      // compositor keeps it on its own layer.
      willChange: 'transform',
    })

    this.gl = null
    this.program = null
    this.pageTexture = null
    this.grainTexture = null
    this.quad = null
    this.uniforms = null
    this.textureWidth = 0
    this.textureHeight = 0
    this.cssWidth = 0
    this.cssHeight = 0
    this.pixelScale = 1
    this.disposed = false
    this.contextLost = false

    this._init()
  }

  get supported() {
    return Boolean(this.gl && this.program) && !this.contextLost
  }

  // --- setup ---------------------------------------------------------------

  _init() {
    const attrs = {
      alpha: false,
      antialias: false, // nothing to antialias: one quad, no geometry edges
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
    }

    const gl =
      this.canvas.getContext('webgl', attrs) ||
      this.canvas.getContext('experimental-webgl', attrs)

    if (!gl) {
      console.warn('[sandwave] WebGL unavailable — falling back to CSS transition.')
      return
    }
    this.gl = gl

    // If the GPU process dies we cannot recover mid-transition; the component
    // listens for this and swaps to the CSS path.
    this._onContextLost = (e) => {
      e.preventDefault()
      this.contextLost = true
      this.onContextLost?.()
    }
    this.canvas.addEventListener('webglcontextlost', this._onContextLost, false)

    this.program = createProgram(gl, VERT_SRC, FRAG_SRC)
    if (!this.program) return

    // Full-screen triangle pair.
    this.quad = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    )

    const aPos = gl.getAttribLocation(this.program, 'aPos')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

    this.grainTexture = createNoiseTexture(gl)

    const names = [
      'uTex',
      'uGrain',
      'uRes',
      'uProgress',
      'uTime',
      'uIntensity',
      'uDark',
      'uGrainAmt',
      'uDir',
      'uAmp',
    ]
    this.uniforms = {}
    for (const name of names) this.uniforms[name] = gl.getUniformLocation(this.program, name)

    gl.useProgram(this.program)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.BLEND)
    // Sampled uv is clamped in the shader, so edge clamping here never shows.
    gl.clearColor(0.043, 0.039, 0.035, 1)
  }

  // --- sizing --------------------------------------------------------------

  /**
   * Pick a render scale that keeps the drawing buffer under budget. Mirrors
   * the snapshot scale so the texture is never upscaled.
   */
  computePixelScale(cssWidth, cssHeight) {
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxDpr)
    const budgetScale = Math.sqrt(MAX_PIXELS / Math.max(cssWidth * cssHeight, 1))
    return Math.max(1, Math.min(dpr, budgetScale))
  }

  /**
   * Resize the drawing buffer. Does not touch the page texture.
   * @returns {boolean} whether the size actually changed
   */
  resize(cssWidth, cssHeight, pixelScale = this.computePixelScale(cssWidth, cssHeight)) {
    if (!this.gl) return false
    if (
      cssWidth === this.cssWidth &&
      cssHeight === this.cssHeight &&
      Math.abs(pixelScale - this.pixelScale) < 0.001
    ) {
      return false
    }

    this.cssWidth = cssWidth
    this.cssHeight = cssHeight
    this.pixelScale = pixelScale

    const w = Math.max(1, Math.round(cssWidth * pixelScale))
    const h = Math.max(1, Math.round(cssHeight * pixelScale))
    this.canvas.width = w
    this.canvas.height = h
    this.gl.viewport(0, 0, w, h)
    return true
  }

  // --- texture -------------------------------------------------------------

  /**
   * Upload a rasterised page. The source is expected to have the same aspect
   * as the viewport.
   * @param {HTMLCanvasElement} source
   */
  setPageTexture(source) {
    const gl = this.gl
    if (!gl) return

    if (!this.pageTexture) this.pageTexture = gl.createTexture()

    gl.bindTexture(gl.TEXTURE_2D, this.pageTexture)
    // html2canvas writes top-row-first; GL wants bottom-row-first.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)

    // Non-power-of-two: clamp + linear, no mipmaps.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.bindTexture(gl.TEXTURE_2D, null)

    this.textureWidth = source.width
    this.textureHeight = source.height
  }

  // --- draw ----------------------------------------------------------------

  /**
   * @param {object} s
   * @param {number} s.progress  0..1
   * @param {number} s.time      seconds
   * @param {number} s.intensity distortion gain
   * @param {number} s.dark      darkness gain
   * @param {number} s.grain     grain gain
   * @param {number} s.dir       +1 opening, -1 closing
   */
  render(s) {
    const gl = this.gl
    if (!gl || !this.program || this.contextLost || !this.pageTexture) return

    const u = this.uniforms
    gl.useProgram(this.program)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.pageTexture)
    gl.uniform1i(u.uTex, 0)

    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.grainTexture)
    gl.uniform1i(u.uGrain, 1)

    gl.uniform2f(u.uRes, this.cssWidth, this.cssHeight)
    gl.uniform1f(u.uProgress, s.progress)
    gl.uniform1f(u.uTime, s.time)
    gl.uniform1f(u.uIntensity, s.intensity)
    gl.uniform1f(u.uDark, s.dark)
    gl.uniform1f(u.uGrainAmt, s.grain)
    gl.uniform1f(u.uDir, s.dir)
    gl.uniform1f(u.uAmp, this.amplitude)

    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  // --- teardown ------------------------------------------------------------

  dispose() {
    if (this.disposed) return
    this.disposed = true

    const gl = this.gl
    if (gl) {
      if (this._onContextLost) {
        this.canvas.removeEventListener('webglcontextlost', this._onContextLost, false)
      }
      if (this.pageTexture) gl.deleteTexture(this.pageTexture)
      if (this.grainTexture) gl.deleteTexture(this.grainTexture)
      if (this.quad) gl.deleteBuffer(this.quad)
      if (this.program) gl.deleteProgram(this.program)

      // Ask the driver to release the context now rather than at GC time.
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }

    this.pageTexture = null
    this.grainTexture = null
    this.quad = null
    this.program = null
    this.gl = null

    this.canvas.remove()
  }
}
