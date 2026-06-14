// packages/web/src/lib/video/vfpga/cells/chromarot.ts
//
// CLB cell `chromaRot(a, phase, gain, iqmix, crawl)` — composite CHROMA / colour-
// burst corruption (the chroma-rot bend, design §3.2). Models a bent chroma
// demodulator: it separates input `a` into luma + a YIQ chroma vector, then
// MIS-PHASES that chroma — global hue spin (burst-phase offset), chroma gain
// overdrive (oversaturation bleed), an I/Q swap/mix, and a comb-filter-defeat dot-
// crawl (a per-line chroma shimmer). Pure per-pixel YIQ round-trip of `a`.
//
//   phase  burst-phase offset → rotates the I/Q chroma vector (global hue spin).
//   gain   chroma amplitude → oversaturation bleed (>1 overdrive).
//   iqmix  0 = normal, 1 = I/Q swapped (held gate toggles it); mixes between.
//   crawl  dot-crawl amount: a per-line/time chroma jitter (comb-filter defeat).
//
// One input (a), four knobs. CV binds onto phase (continuous spin); a held gate
// binds onto iqmix (I/Q swap). uTime drives the dot-crawl shimmer.

import { type VfpgaCell } from './types';

export const chromaRotCell: VfpgaCell = {
  type: 'clb',
  op: 'chromaRot',
  inputs: ['a'],
  knobs: [
    { name: 'phase', uniform: 'uBurstPhase', defaultValue: 0.0, label: 'PHASE', doc: 'Burst-phase offset → rotates chroma (global hue spin, 0..1 wheel).' },
    { name: 'gain', uniform: 'uChromaGain', defaultValue: 1.0, label: 'GAIN', doc: 'Chroma amplitude (>1 = oversaturation bleed overdrive).' },
    { name: 'iqmix', uniform: 'uIqMix', defaultValue: 0.0, label: 'I/Q', doc: '0 = normal, 1 = I/Q swapped (a held gate toggles the swap).' },
    { name: 'crawl', uniform: 'uDotCrawl', defaultValue: 0.0, label: 'CRAWL', doc: 'Dot-crawl: a per-line/time chroma shimmer (comb-filter defeat).' },
  ],
  doc: 'Composite chroma corruption: burst-phase hue spin / overdrive / I-Q swap / dot-crawl (chroma-rot).',
  kernel({ uTexFor, uniformFor }) {
    const a = uTexFor('a');
    const phase = uniformFor('phase');
    const gain = uniformFor('gain');
    const iqmix = uniformFor('iqmix');
    const crawl = uniformFor('crawl');
    return `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D ${a};
uniform vec2 uResolution;
uniform float uTime;
uniform float ${phase};
uniform float ${gain};
uniform float ${iqmix};
uniform float ${crawl};
const float TWO_PI = 6.28318530718;
// Rec.601 RGB<->YIQ (the composite luma + I/Q chroma basis).
const mat3 RGB2YIQ = mat3(
  0.299,  0.587,  0.114,
  0.596, -0.274, -0.322,
  0.211, -0.523,  0.312);
const mat3 YIQ2RGB = mat3(
  1.0,  0.956,  0.619,
  1.0, -0.272, -0.647,
  1.0, -1.106,  1.703);
void main() {
  vec4 src = texture(${a}, vUv);
  vec3 yiq = RGB2YIQ * src.rgb;
  float y = yiq.x;
  vec2 iq = yiq.yz;
  // I/Q swap mix (held gate): blend toward the swapped vector.
  vec2 swapped = vec2(iq.y, iq.x);
  iq = mix(iq, swapped, clamp(${iqmix}, 0.0, 1.0));
  // dot-crawl: a per-scanline + time chroma phase wobble (comb defeat).
  float line = floor(vUv.y * max(uResolution.y, 1.0));
  float crawlPh = ${crawl} * 0.5 * sin(line * 2.39996 + uTime * 6.0);
  // burst-phase rotation of the I/Q chroma vector (global hue spin).
  float ang = (${phase} + crawlPh) * TWO_PI;
  float s = sin(ang), c = cos(ang);
  iq = mat2(c, -s, s, c) * iq;
  // chroma gain overdrive.
  iq *= ${gain};
  vec3 rgb = YIQ2RGB * vec3(y, iq);
  outColor = vec4(clamp(rgb, 0.0, 1.0), src.a);
}`;
  },
};
