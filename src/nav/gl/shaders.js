/* ---------------------------------------------------------------------------
   SANDWAVE shaders.

   WebGL is doing real work here, not decoration: the whole effect is a
   displacement field evaluated per-pixel against a rasterised copy of the
   page. The alternative (SVG feDisplacementMap over the live DOM) was the
   "lighter" option but cannot express a *travelling*, turbulence-shaped front
   without re-rasterising an SVG filter over the entire document every frame,
   which is far slower than one full-screen quad.

   One quad, one texture, ~4 octaves of noise. Cheap enough to hold 60fps on
   a phone.
   --------------------------------------------------------------------------- */

export const VERT_SRC = /* glsl */ `
attribute vec2 aPos;
varying vec2 vUv;

void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`

export const FRAG_SRC = /* glsl */ `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

varying vec2 vUv;

uniform sampler2D uTex;      // rasterised page
uniform sampler2D uGrain;    // tiling noise
uniform vec2  uRes;          // css pixel size
uniform float uProgress;     // 0 = page at rest, 1 = fully swept
uniform float uTime;         // drives the living crest
uniform float uIntensity;    // distortion gain (0 while settled)
uniform float uDark;         // darkness gain (0 while settled)
uniform float uGrainAmt;
uniform float uDir;          // +1 opening (drag left), -1 closing (drag right)
uniform float uAmp;          // displacement amplitude, in uv units

// --- value noise -----------------------------------------------------------

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * vnoise(p);
    p = p * 2.03 + 17.1;
    a *= 0.5;
  }
  return v;
}

// --- the crest -------------------------------------------------------------
//
// Incommensurate sines plus a slow noise term. Deliberately NOT a single sine:
// the frequencies are mutually irrational so the crest never visibly repeats,
// and the noise term gives it the lopsided, drifting profile of a dune edge
// rather than a clean mathematical wave.

float crestOffset(float y, float t) {
  float s = sin(y * 6.1 + t * 0.85) * 0.020;
  s += sin(y * 11.3 - t * 1.47) * 0.009;
  s += sin(y * 19.7 + t * 2.10) * 0.004;
  s += (fbm(vec2(y * 2.6, t * 0.30)) - 0.5) * 0.052;
  return s;
}

void main() {
  // --- wave front ----------------------------------------------------------
  // Travelling right -> left as uProgress goes 0 -> 1. The margins push the
  // front fully off both edges so the resting states are perfectly clean.
  const float MARGIN = 0.08;
  float frontX = mix(1.0 + MARGIN, -MARGIN, uProgress) + crestOffset(vUv.y, uTime * 0.55);

  // Signed distance from the front. t > 0 is behind it (already swept).
  float t = vUv.x - frontX;

  // Which side of the front has been passed. Soft over BAND_W so the boundary
  // reads as material rather than a clipped edge — but only just. A wide ramp
  // here is what turns the whole effect into a lighting gradient.
  const float BAND_W = 0.095;
  float swept = smoothstep(-BAND_W * 0.5, BAND_W * 0.5, t);

  // Distortion envelope — a gaussian riding the crest. Tight, so that the
  // crest reads as a crest rather than a smear.
  const float SIGMA = 0.062;
  float band = exp(-(t * t) / (SIGMA * SIGMA));

  // Residual drag trailing behind the crest, decaying into the swept region,
  // so material feels pushed and then left settled rather than snapping back.
  float trail = exp(-max(t, 0.0) / 0.16) * step(0.0, t);

  // --- displacement --------------------------------------------------------
  // Low frequency in y: the push should read as one sheet of material being
  // moved, not as independent per-row wobble.
  float turb = fbm(vec2(vUv.y * 3.0, uTime * 0.45));
  // Frequency is a legibility decision, not a taste one: this noise shears
  // horizontally as it varies in y, so too high a frequency puts several
  // oscillations inside a single glyph and the text stops reading as dragged
  // and starts reading as shredded. At 17 the whole crest band carries about
  // one cycle per line of type.
  float fine = vnoise(vec2(vUv.y * 17.0, uTime * 1.30));

  float amp = uAmp * uIntensity;

  vec2 disp;
  // Horizontal drag — the dominant motion, strongest at the crest.
  disp.x = -(band * (0.70 + 0.70 * turb) + trail * 0.20) * amp * uDir;
  // A little roll as material is pushed aside. Deliberately much smaller than
  // the drag: past about 1.0 the page appears to melt rather than to move.
  disp.y = band * (turb - 0.5) * 0.85 * amp * uDir;
  // Grain-scale jitter riding the crest: this is what stops it reading as a
  // smooth warp and starts it reading as sand.
  disp.x += band * (fine - 0.5) * 0.55 * amp;
  disp.y += band * (vnoise(vec2(vUv.x * 34.0, uTime * 1.10)) - 0.5) * 0.55 * amp;

  // Ambient fluid motion for the settled/open state:
  // Gives the darkened background page a subtle living breath and organic dune drift
  float ambientWave = sin(vUv.y * 3.2 + uTime * 0.35) * cos(vUv.x * 2.8 - uTime * 0.25);
  vec2 ambientDisp = vec2(
    ambientWave * 0.0035 + (fbm(vec2(vUv.x * 2.0 + uTime * 0.04, vUv.y * 3.0)) - 0.5) * 0.004,
    cos(vUv.x * 3.5 + uTime * 0.3) * 0.002
  ) * swept * uDark;

  vec2 uv = clamp(vUv + disp + ambientDisp, vec2(0.0), vec2(1.0));

  // --- sample, with a trace of chromatic separation at the crest -----------
  // Kept very low. The text on this site is near-black on near-white, which is
  // the worst case for a split: past roughly 0.0006 the fringing stops reading
  // as refraction through a wave and starts reading as anaglyph glasses.
  float ca = (band * 0.00045 * uIntensity) + (swept * uDark * 0.00015 * sin(uTime * 0.5 + vUv.y * 4.0));
  vec3 col;
  col.r = texture2D(uTex, clamp(uv + vec2(ca, 0.0), vec2(0.0), vec2(1.0))).r;
  col.g = texture2D(uTex, uv).g;
  col.b = texture2D(uTex, clamp(uv - vec2(ca, 0.0), vec2(0.0), vec2(1.0))).b;

  // --- grade ---------------------------------------------------------------
  float darkAmt = swept * uDark;

  // Pull the colour out of the swept region before crushing it down.
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, vec3(lum), swept * 0.38 * uDark);

  // Not quite to black — the page stays faintly legible underneath, which is
  // what makes it feel transformed rather than replaced.
  vec3 night = vec3(0.043, 0.039, 0.035);
  col = mix(col, night, darkAmt);

  // --- living sand atmosphere ----------------------------------------------
  // Dynamic multi-scale grain with slow ambient drift
  vec2 gUv1 = (vUv * uRes / 220.0) + vec2(uTime * 0.012, uTime * 0.006);
  vec2 gUv2 = (vUv * uRes / 160.0) + vec2(-uTime * 0.008, uTime * 0.015);
  float g1 = texture2D(uGrain, gUv1).r;
  float g2 = texture2D(uGrain, gUv2).r;
  float g = mix(g1, g2, 0.5 + 0.5 * sin(uTime * 0.8 + vUv.y * 3.0));
  col += (g - 0.5) * uGrainAmt * (0.18 + 0.82 * swept);

  // Ambient dune wind currents drifting across the darkness
  float duneBreeze = fbm(vec2(vUv.x * 2.4 - uTime * 0.06, vUv.y * 3.8 + uTime * 0.03));
  float microCurrent = sin(vUv.x * 12.0 + vUv.y * 8.0 - uTime * 0.7) * 0.015;
  col += (duneBreeze - 0.5) * 0.045 * swept * uDark;
  col += vec3(0.08, 0.045, 0.02) * (duneBreeze * 0.06 + microCurrent) * swept * uDark;

  // Streaks drawn out along the direction of travel during crest.
  float streak = fbm(vec2(vUv.x * 2.2 + uTime * 0.55, vUv.y * 22.0));
  col += band * (streak - 0.5) * 0.075 * uIntensity;

  // A faint lit lip on the leading edge — the dune crest catching light. Kept
  // low deliberately: this is the difference between a crest and a glow, and
  // past about 0.07 it reads as the latter.
  float lip = exp(-pow((t - 0.008) / 0.017, 2.0));
  col += lip * 0.05 * uIntensity * vec3(1.0, 0.92, 0.82);

  // --- vignette with subtle organic breathing ------------------------------
  vec2 p = vUv - 0.5;
  p.x *= uRes.x / max(uRes.y, 1.0);
  float vig = 1.0 - dot(p, p) * (0.34 + 0.03 * sin(uTime * 0.45));
  col *= mix(1.0, vig, 0.25 + 0.75 * swept);

  gl_FragColor = vec4(col, 1.0);
}
`
