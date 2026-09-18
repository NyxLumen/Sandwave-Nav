/* ---------------------------------------------------------------------------
   Minimal WebGL plumbing. No framework, no dependency.
   --------------------------------------------------------------------------- */

function compile(gl, type, src) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, src)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('[sandwave] shader compile failed:\n' + gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    return null
  }
  return shader
}

export function createProgram(gl, vertSrc, fragSrc) {
  const vs = compile(gl, gl.VERTEX_SHADER, vertSrc)
  if (!vs) return null
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc)
  if (!fs) {
    gl.deleteShader(vs)
    return null
  }

  const program = gl.createProgram()
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)

  // Shaders can be flagged for deletion immediately after linking.
  gl.deleteShader(vs)
  gl.deleteShader(fs)

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('[sandwave] program link failed:\n' + gl.getProgramInfoLog(program))
    gl.deleteProgram(program)
    return null
  }
  return program
}

/** A 256x256 tile of fine monochrome noise, used as the sand grain. */
export function createNoiseTexture(gl, size = 256) {
  const data = new Uint8Array(size * size)
  for (let i = 0; i < data.length; i++) {
    // Slightly biased toward mid-grey so the grain reads as tooth on the
    // surface rather than as static.
    data[i] = 110 + Math.random() * 92
  }

  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  // Single-channel would be ideal but LUMINANCE is not guaranteed readable on
  // every mobile driver; RGBA is universally safe and this is 256KB.
  const rgba = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    const v = data[i]
    rgba[i * 4] = v
    rgba[i * 4 + 1] = v
    rgba[i * 4 + 2] = v
    rgba[i * 4 + 3] = 255
  }
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.bindTexture(gl.TEXTURE_2D, null)
  return tex
}
