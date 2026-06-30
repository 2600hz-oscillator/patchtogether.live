// packages/web/src/lib/video/vfpga/cells/chromarot.ts
//
// CLB cell `chromaRot(a, b, phase, gain, iqmix, crawl, cxfer)` — composite CHROMA /
// colour-burst corruption (the chroma-rot bend, design §3.2). Models a bent chroma
// demodulator: it separates input `a` into luma + a YIQ chroma vector, then
// MIS-PHASES that chroma — global hue spin (burst-phase offset), chroma gain
// overdrive (oversaturation bleed), an I/Q swap/mix, and a comb-filter-defeat dot-
// crawl (a per-line chroma shimmer).
//
// Y/C TRANSPLANT (the multi-input upgrade, design research 2026-06-30 §2): composite
// separates luma (Y) from chroma (C), so the bend can take Y from one source and C
// from another — a colour transplant that is impossible single-source. Luma is
// ALWAYS from `a` (IIN1); the chroma vector is `mix(C_of_a, C_of_b, cxfer)` where
// `b` is the chroma source (IIN2). cxfer=0 → A's own chroma (byte-for-byte the
// original single-source bend); cxfer=1 → B's chroma riding on A's luma. When IIN2
// is UNPATCHED `b` reads the 1×1 transparent-black fallback → C_of_b=0, so at the
// default cxfer=0 it is exactly the original cell.
//
//   phase  burst-phase offset → rotates the I/Q chroma vector (global hue spin).
//   gain   chroma amplitude → oversaturation bleed (>1 overdrive).
//   iqmix  0 = normal, 1 = I/Q swapped (held gate toggles it); mixes between.
//   crawl  dot-crawl amount: a per-line/time chroma jitter (comb-filter defeat).
//   cxfer  Y/C transplant: blend the chroma from `b` (IIN2) onto `a`'s luma.
//
// Two inputs (a = luma+default chroma, b = transplant chroma source), five knobs. CV
// binds onto phase (continuous spin); a held gate binds onto iqmix (I/Q swap). uTime
// drives the dot-crawl shimmer.

import { type VfpgaCell } from './types';

export const chromaRotCell: VfpgaCell = {
  type: 'clb',
  op: 'chromaRot',
  inputs: ['a', 'b'],
  knobs: [
    { name: 'phase', uniform: 'uBurstPhase', defaultValue: 0.0, label: 'PHASE', doc: 'Burst-phase offset → rotates chroma (global hue spin, 0..1 wheel).' },
    { name: 'gain', uniform: 'uChromaGain', defaultValue: 1.0, label: 'GAIN', doc: 'Chroma amplitude (>1 = oversaturation bleed overdrive).' },
    { name: 'iqmix', uniform: 'uIqMix', defaultValue: 0.0, label: 'I/Q', doc: '0 = normal, 1 = I/Q swapped (a held gate toggles the swap).' },
    { name: 'crawl', uniform: 'uDotCrawl', defaultValue: 0.0, label: 'CRAWL', doc: 'Dot-crawl: a per-line/time chroma shimmer (comb-filter defeat).' },
    { name: 'cxfer', uniform: 'uCRotXfer', defaultValue: 0.0, label: 'CXFER', doc: 'Y/C transplant: blend the chroma from the SECOND input (IIN2) onto this luma. 0 = own chroma.' },
  ],
  doc: 'Composite chroma corruption: burst-phase hue spin / overdrive / I-Q swap / dot-crawl, plus a two-source Y/C chroma transplant (chroma-rot).',
  kernel({ uTexFor, uniformFor }) {
    const a = uTexFor('a');
    const b = uTexFor('b');
    const phase = uniformFor('phase');
    const gain = uniformFor('gain');
    const iqmix = uniformFor('iqmix');
    const crawl = uniformFor('crawl');
    const cxfer = uniformFor('cxfer');
    return `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D ${a};
uniform sampler2D ${b};
uniform vec2 uResolution;
uniform float uTime;
uniform float ${phase};
uniform float ${gain};
uniform float ${iqmix};
uniform float ${crawl};
uniform float ${cxfer};
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
  float y = yiq.x; // luma ALWAYS from A (IIN1)
  vec2 iq = yiq.yz;
  // Y/C TRANSPLANT: blend in the SECOND source's chroma (IIN2). At cxfer=0 this is
  // A's own chroma (identical to the single-source bend); an unpatched IIN2 reads
  // transparent black → its chroma is 0, so the default is a no-op.
  vec2 iqB = (RGB2YIQ * texture(${b}, vUv).rgb).yz;
  iq = mix(iq, iqB, clamp(${cxfer}, 0.0, 1.0));
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
