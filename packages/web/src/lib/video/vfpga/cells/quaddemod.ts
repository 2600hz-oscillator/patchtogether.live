// packages/web/src/lib/video/vfpga/cells/quaddemod.ts
//
// DSP cell `quadDemod(i, q, gain)` — a quadrature demodulator (design §1.3):
// treats inputs `i` and `q` as the in-phase / quadrature channels of a complex
// signal (each centred at 0.5 → signed [-0.5,0.5]) and emits, per pixel:
//   R = magnitude  sqrt(i² + q²) * gain      (the AM envelope / chroma amplitude)
//   G = phase      atan(q, i) mapped 0..1     (the FM angle / chroma hue)
//   B = magnitude (replicated for a usable luma)
// The video-synth analogue of the colour-subcarrier demod (separate chroma into
// amplitude + phase). Two inputs (i, q), one knob (gain, default 1).

import { type VfpgaCell } from './types';

export const quadDemodCell: VfpgaCell = {
  type: 'dsp',
  op: 'quadDemod',
  inputs: ['i', 'q'],
  knobs: [
    {
      name: 'gain',
      uniform: 'uDemodGain',
      defaultValue: 1,
      label: 'GAIN',
      doc: 'Scales the demodulated magnitude (R/B channels).',
    },
  ],
  doc: 'Quadrature demod of (i, q): R=magnitude, G=phase(0..1), B=magnitude.',
  kernel({ uTexFor, uniformFor }) {
    const i = uTexFor('i');
    const q = uTexFor('q');
    const gain = uniformFor('gain');
    return `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D ${i};
uniform sampler2D ${q};
uniform float ${gain};
const float TWO_PI = 6.28318530718;
void main() {
  // Centre each channel at 0 → signed I/Q (luma of the input is the carrier).
  float si = dot(texture(${i}, vUv).rgb, vec3(0.299, 0.587, 0.114)) - 0.5;
  float sq = dot(texture(${q}, vUv).rgb, vec3(0.299, 0.587, 0.114)) - 0.5;
  float mag = clamp(length(vec2(si, sq)) * 2.0 * ${gain}, 0.0, 1.0);
  // atan range (-PI..PI] → 0..1.
  float phase = (atan(sq, si) + 3.14159265359) / TWO_PI;
  outColor = vec4(mag, phase, mag, 1.0);
}`;
  },
};
