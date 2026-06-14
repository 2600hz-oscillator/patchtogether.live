// packages/web/src/lib/video/vfpga/cells/tmdsbend.ts
//
// CLB cell `tmdsbend(a, disparity, slip, leak, seed)` — HDMI/DVI TMDS link
// corruption (the tmds-sparkle bend, design §3.6). Models a marginal HDMI cable on
// the early-HD digital link: the per-pixel BIT-FLIP "sparkle" half lives UPSTREAM
// in the literal LUT16 tile (tmds-sparkle wires lut16 → tmdsbend); THIS cell adds
// the rest of the bent-link artifacts that are spatial, not pure logic:
//
//   disparity DC-BALANCE BREAK: TMDS 8b/10b keeps a running disparity; a broken
//             link lets it drift → horizontal BANDING (a per-line brightness ramp).
//   slip      CHARACTER-BOUNDARY SLIP: the 10-bit char clock loses lock → a per-
//             line horizontal pixel SHEAR (the picture tears sideways per scanline).
//   leak      CONTROL-PERIOD LEAK: HDMI sync/control characters bleed into active
//             video → seeded coloured SPECKLE (the control-period-in-pixels look).
//   seed      re-rollable error seed (a cable-wiggle gate advances it → a burst).
//
// All "random" terms are DETERMINISTIC (frame + uv + seed hashed, VRT-safe). The
// look is logic/integer-domain (no float-precision asserts), so it is CI-SwiftShader
// tolerant. ONE input (a), three knobs + the shared seed. CV binds onto disparity
// (or the spec drives the error rate); an error-burst gate binds onto seed.

import { type VfpgaCell } from './types';
import { BEND_SEED_GLSL, BEND_SEED_UNIFORM } from './bend-seed';

export const tmdsBendCell: VfpgaCell = {
  type: 'clb',
  op: 'tmdsbend',
  inputs: ['a'],
  knobs: [
    { name: 'disparity', uniform: 'uTmdsDisparity', defaultValue: 0.0, label: 'DISP', doc: 'DC-balance break → running-disparity drift → horizontal banding.' },
    { name: 'slip', uniform: 'uTmdsSlip', defaultValue: 0.0, label: 'SLIP', doc: 'Char-boundary slip → per-line horizontal pixel shear.' },
    { name: 'leak', uniform: 'uTmdsLeak', defaultValue: 0.0, label: 'LEAK', doc: 'Control-period leak → coloured sync-char speckle in active video.' },
    { name: 'seed', uniform: BEND_SEED_UNIFORM, defaultValue: 0, label: 'SEED', doc: 'Re-rollable error seed (a cable-wiggle gate advances it for a burst).' },
  ],
  doc: 'HDMI/TMDS link corruption: disparity banding / char-slip shear / control-period speckle (tmds-sparkle).',
  kernel({ uTexFor, uniformFor }) {
    const a = uTexFor('a');
    const disparity = uniformFor('disparity');
    const slip = uniformFor('slip');
    const leak = uniformFor('leak');
    const seed = uniformFor('seed');
    return `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D ${a};
uniform vec2 uResolution;
uniform float uTime;
uniform float ${disparity};
uniform float ${slip};
uniform float ${leak};
uniform float ${seed};
${BEND_SEED_GLSL}
void main() {
  float seedOff = ${seed} * 0.0191;
  vec2 res = max(uResolution, vec2(1.0));
  float line = floor(vUv.y * res.y);
  // CHAR-BOUNDARY SLIP: the 10-bit char clock loses lock → each scanline shears
  // sideways by a seeded amount (the horizontal pixel slip).
  float sh = (bendHash(vec2(line, seedOff + 1.3)) - 0.5) * ${slip};
  float x = fract(vUv.x + sh);
  vec3 col = texture(${a}, vec2(x, vUv.y)).rgb;
  // DC-BALANCE BREAK: a drifting running-disparity → a per-line brightness ramp
  // (horizontal banding) that crawls over time.
  float band = sin(vUv.y * 90.0 + uTime * 2.0 + bendHash(vec2(line, seedOff)) * 6.283);
  col += band * ${disparity} * 0.5;
  // CONTROL-PERIOD LEAK: unlucky pixels read a sync/control character (a seeded
  // saturated colour) instead of active video → coloured speckle.
  float roll = bendHash(vec2(floor(x * res.x), line) + seedOff + uTime * 0.013);
  if (roll < ${leak}) {
    float h = bendHash(vec2(line + 0.5, floor(x * res.x) + seedOff));
    // a few saturated TMDS control-char colours.
    vec3 ctrl = h < 0.33 ? vec3(0.0, 1.0, 1.0) : (h < 0.66 ? vec3(1.0, 0.0, 1.0) : vec3(1.0, 1.0, 0.0));
    col = ctrl;
  }
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;
  },
};
