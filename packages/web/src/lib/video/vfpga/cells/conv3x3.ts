// packages/web/src/lib/video/vfpga/cells/conv3x3.ts
//
// DSP cell `conv3x3(a, k00..k22, divisor, bias)` — a 3×3 spatial convolution (the
// heavier MAC kernel a `dsp` tile runs, design §1.3). Reads the 3×3 neighbourhood
// of input `a` (one texel step from `uResolution`), multiplies by the nine tap
// knobs, divides by `divisor` and adds `bias` — the generic blur / sharpen / edge
// / emboss filter. ONE input (a), eleven knobs (k00..k22 + divisor + bias).
//
// The taps are KNOBS (float uniforms) not the `config.taps[]` array: a cell kernel
// is parameterised only through knobs (the kernel signature gets uTexFor/uniformFor,
// not the tile config), so every tap is a host-bindable / const-settable knob —
// the same uniform-binding channel mix/threshold use. `uResolution` (always host-
// provided) gives the per-texel step so the kernel is resolution-correct.

import { type VfpgaCell } from './types';

/** The 9 tap-knob names, row-major (k<row><col>). Default = a 3×3 box blur (all
 *  1, divisor 9) so an unconfigured tile is a sane neutral-ish smoother. */
const TAP_NAMES = ['k00', 'k01', 'k02', 'k10', 'k11', 'k12', 'k20', 'k21', 'k22'] as const;

export const conv3x3Cell: VfpgaCell = {
  type: 'dsp',
  op: 'conv3x3',
  inputs: ['a'],
  knobs: [
    ...TAP_NAMES.map((name) => ({
      name,
      uniform: `uTap_${name}`,
      // Default kernel = 3×3 box blur (all taps 1, divisor 9).
      defaultValue: 1,
      label: name.toUpperCase(),
      doc: `Convolution tap at row ${name[1]}, col ${name[2]} of the 3×3 kernel.`,
    })),
    {
      name: 'divisor',
      uniform: 'uConvDivisor',
      defaultValue: 9,
      label: 'DIV',
      doc: 'Divides the weighted sum (kernel normaliser; box blur = 9).',
    },
    {
      name: 'bias',
      uniform: 'uConvBias',
      defaultValue: 0,
      label: 'BIAS',
      doc: 'Added to each channel after the divide (e.g. 0.5 for signed edge kernels).',
    },
  ],
  doc: '3×3 spatial convolution (blur / sharpen / edge / emboss) of input a.',
  kernel({ uTexFor, uniformFor }) {
    const a = uTexFor('a');
    const taps = TAP_NAMES.map((n) => uniformFor(n));
    const divisor = uniformFor('divisor');
    const bias = uniformFor('bias');
    return `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D ${a};
uniform vec2 uResolution;
uniform float ${taps[0]};
uniform float ${taps[1]};
uniform float ${taps[2]};
uniform float ${taps[3]};
uniform float ${taps[4]};
uniform float ${taps[5]};
uniform float ${taps[6]};
uniform float ${taps[7]};
uniform float ${taps[8]};
uniform float ${divisor};
uniform float ${bias};
void main() {
  vec2 px = 1.0 / max(uResolution, vec2(1.0));
  vec3 acc = vec3(0.0);
  acc += texture(${a}, vUv + vec2(-px.x,  px.y)).rgb * ${taps[0]};
  acc += texture(${a}, vUv + vec2( 0.0,   px.y)).rgb * ${taps[1]};
  acc += texture(${a}, vUv + vec2( px.x,  px.y)).rgb * ${taps[2]};
  acc += texture(${a}, vUv + vec2(-px.x,  0.0 )).rgb * ${taps[3]};
  acc += texture(${a}, vUv + vec2( 0.0,   0.0 )).rgb * ${taps[4]};
  acc += texture(${a}, vUv + vec2( px.x,  0.0 )).rgb * ${taps[5]};
  acc += texture(${a}, vUv + vec2(-px.x, -px.y)).rgb * ${taps[6]};
  acc += texture(${a}, vUv + vec2( 0.0,  -px.y)).rgb * ${taps[7]};
  acc += texture(${a}, vUv + vec2( px.x, -px.y)).rgb * ${taps[8]};
  float d = abs(${divisor}) < 1.0e-6 ? 1.0 : ${divisor};
  vec3 col = clamp(acc / d + ${bias}, 0.0, 1.0);
  outColor = vec4(col, texture(${a}, vUv).a);
}`;
  },
};
