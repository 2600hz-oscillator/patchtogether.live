// packages/web/src/lib/video/vfpga/specs/smpte-frag.ts
//
// The SMPTE-bars generator fragment — the SINGLE source of truth for the
// pattern GLSL, shared by BOTH authoring surfaces of the smpte-bars VFPGA:
//   - the legacy hand-authored `effect` (the escape-hatch reference), and
//   - the fabric path's `clb:smpte` generator cell (the dogfood — design §4.2/§5
//     P1: re-express smpte-bars as a 1-tile generator fabric to exercise P&R).
//
// Both consume this EXACT string, so the fabric-routed pass renders BYTE-IDENTICAL
// to the legacy effect (the P1 correctness anchor: no intended visual change).
//
// The fragment reads three host-bound uniforms (`uShift` CV role, `uBrightness`
// + `uSaturation` param slots) — the host's setAllUniforms writes them by name
// from the spec's cvRoles/params, identically whichever authoring surface is live.

/** The pattern-shift CV-role uniform (0..7 columns). */
export const SMPTE_UNIFORM_SHIFT = 'uShift';
/** The brightness param-slot uniform (0.5..1.0). */
export const SMPTE_UNIFORM_BRIGHTNESS = 'uBrightness';
/** The saturation param-slot uniform (0..1). */
export const SMPTE_UNIFORM_SATURATION = 'uSaturation';

/** Every host-set uniform the SMPTE generator reads, in pass-declaration order. */
export const SMPTE_UNIFORMS: readonly string[] = [
  SMPTE_UNIFORM_SHIFT,
  SMPTE_UNIFORM_BRIGHTNESS,
  SMPTE_UNIFORM_SATURATION,
];

/** The SMPTE-bars #version 300 es fragment (see specs/smpte-bars.ts header for
 *  the layout). 0 video in, 1 video out. Deterministic (no uTime in the colour
 *  math) so the CPU-snapshot preview + a frozen-CV VRT scene stay pixel-stable. */
export const SMPTE_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

// Pattern-shift CV role (0..7): cyclically rotates the 7 top bars left.
uniform float uShift;
// Param slots:
uniform float uBrightness; // p1: 0.5 (75% bars) .. 1.0 (100% bars) overall scale
uniform float uSaturation; // p2: 0 (mono) .. 1 (full chroma)

// The 7 top bars at 75% amplitude (EG 1-1990), index 0=grey .. 6=blue.
vec3 topBar(int i) {
  // 0.75 amplitude white = 0.75 in each channel; the chroma bars toggle
  // channels between 0 and 0.75.
  if (i == 0) return vec3(0.75, 0.75, 0.75); // grey
  if (i == 1) return vec3(0.75, 0.75, 0.0);  // yellow
  if (i == 2) return vec3(0.0,  0.75, 0.75); // cyan
  if (i == 3) return vec3(0.0,  0.75, 0.0);  // green
  if (i == 4) return vec3(0.75, 0.0,  0.75); // magenta
  if (i == 5) return vec3(0.75, 0.0,  0.0);  // red
  return vec3(0.0, 0.0, 0.75);               // blue
}

// The reverse castellation row beneath the top bars.
vec3 midBar(int i) {
  if (i == 0) return vec3(0.0,  0.0,  0.75); // blue
  if (i == 1) return vec3(0.0);              // black
  if (i == 2) return vec3(0.75, 0.0,  0.75); // magenta
  if (i == 3) return vec3(0.0);              // black
  if (i == 4) return vec3(0.0,  0.75, 0.75); // cyan
  if (i == 5) return vec3(0.0);              // black
  return vec3(0.75, 0.75, 0.75);             // grey
}

// PLUGE / lower band. Split into the conventional unequal columns.
vec3 plugeBar(float x) {
  // Columns measured as fractions of width (approx EG 1-1990 proportions).
  // -I (0..1/6), white 100% (1/6..2/6), +Q (2/6..3/6), black (3/6..4/6),
  // PLUGE triplet (4/6..5/6) split into sub-black / black / super-black,
  // black (5/6..1).
  if (x < 1.0/6.0)  return vec3(0.0, 0.0, 0.30);   // -I (blue-ish)
  if (x < 2.0/6.0)  return vec3(1.0);              // 100% white
  if (x < 3.0/6.0)  return vec3(0.18, 0.0, 0.34);  // +Q (purple-ish)
  if (x < 4.0/6.0)  return vec3(0.0);              // black
  if (x < 5.0/6.0) {
    float t = (x - 4.0/6.0) * 18.0; // three sub-columns within this sixth
    if (t < 1.0) return vec3(0.035); // sub-black (-4 IRE ≈ just below black)
    if (t < 2.0) return vec3(0.0);   // black (0 IRE)
    return vec3(0.075);              // super-black (+4 IRE ≈ just above black)
  }
  return vec3(0.0); // black
}

void main() {
  // GL texture origin is bottom-left; author the pattern top-down.
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);

  // Band split (top 67% / mid 8% / bottom 25%).
  float yTopEnd = 0.67;
  float yMidEnd = 0.75;

  vec3 col;
  if (uv.y < yTopEnd) {
    // Top 7 bars, cyclically shifted by uShift columns.
    int idx = int(floor(uv.x * 7.0));
    int s = int(floor(uShift + 0.5));
    int shifted = ((idx + s) % 7 + 7) % 7;
    col = topBar(shifted);
  } else if (uv.y < yMidEnd) {
    int idx = int(floor(uv.x * 7.0));
    col = midBar(idx);
  } else {
    col = plugeBar(uv.x);
  }

  // p2 SATURATION: desaturate toward Rec.601 luma.
  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(luma), col, clamp(uSaturation, 0.0, 1.0));

  // p1 BRIGHTNESS: 0.5 keeps 75% bars; 1.0 scales them to 100% amplitude.
  // Map the 0.5..1.0 knob to a 1.0..1.3333 gain (0.75 * 1.3333 = 1.0).
  float gain = mix(1.0, 1.0/0.75, clamp((uBrightness - 0.5) * 2.0, 0.0, 1.0));
  col = clamp(col * gain, 0.0, 1.0);

  outColor = vec4(col, 1.0);
}`;
