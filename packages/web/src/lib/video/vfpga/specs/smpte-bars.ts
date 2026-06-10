// packages/web/src/lib/video/vfpga/specs/smpte-bars.ts
//
// smpte-bars — the FIRST bundled VFPGA: a pure pattern GENERATOR that renders
// SMPTE-style colour bars (0 video in → 1 video out). Generic test-pattern
// generator; "SMPTE" names the public ANSI/SMPTE EG 1-1990 test-pattern
// STANDARD (a measurement layout in the public domain), not any trademarked
// product.
//
// Layout (classic 3-band EG 1-1990 75% bars):
//   - TOP band (top ~67% of frame): 7 main bars at 75% amplitude —
//     grey, yellow, cyan, green, magenta, red, blue.
//   - MIDDLE band (~next 8%): the reverse "castellation" row —
//     blue, black, magenta, black, cyan, black, grey.
//   - BOTTOM band (remaining ~25%): the PLUGE row — -I, white(100%), +Q,
//     black, then the sub-black / black / super-black PLUGE triplet, then
//     black.
//
// One CV role: PATTERN SHIFT (uShift) cyclically rotates the 7 top bars left
// (so a slow LFO scrolls the bars — handy as a moving deterministic source for
// downstream effect bring-up). The shift is purely a horizontal column remap;
// at uShift=0 the output is the textbook bars.
//
// Pure GL, deterministic (no uTime in the colour math — the only time-varying
// input is the CV), so its CPU-snapshot preview + a frozen-CV VRT scene are
// pixel-stable.

import type { VfpgaSpec } from '$lib/video/vfpga/types';

const SMPTE_FRAG = `#version 300 es
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

export const smpteBarsSpec: VfpgaSpec = {
  id: 'smpte-bars',
  name: 'SMPTE bars',
  doc:
    'A pure pattern generator that renders SMPTE-style colour bars (the public ' +
    'SMPTE EG 1-1990 test-pattern layout): a top band of seven 75%-amplitude ' +
    'bars (grey, yellow, cyan, green, magenta, red, blue), a reverse ' +
    'castellation row, and a PLUGE / sub-black row. Zero video inputs, one ' +
    'video output — a deterministic, always-on reference source for bringing up ' +
    'and calibrating downstream video effects.',
  docSlug: 'smpte-bars',
  videoIn: 0,
  videoOut: 1,
  cvRoles: [
    {
      slot: 1,
      label: 'SHIFT',
      uniform: 'uShift',
      doc: 'Cyclically rotates the seven top bars left (0..7 columns); a slow LFO scrolls the bars to make a moving deterministic source.',
    },
  ],
  params: [
    {
      slot: 1,
      label: 'BRIGHT',
      uniform: 'uBrightness',
      min: 0.5,
      max: 1.0,
      defaultValue: 0.5,
      curve: 'linear',
      doc: '0.5 = textbook 75% bars; 1.0 scales the bars to 100% amplitude.',
    },
    {
      slot: 2,
      label: 'SAT',
      uniform: 'uSaturation',
      min: 0,
      max: 1,
      defaultValue: 1,
      curve: 'linear',
      doc: 'Chroma saturation: 0 collapses the bars to greyscale (luma), 1 = full colour.',
    },
  ],
  effect: {
    passes: [
      {
        frag: SMPTE_FRAG,
        target: 'output',
        uniforms: ['uShift', 'uBrightness', 'uSaturation'],
      },
    ],
    outputs: { vout1: 'output' },
  },
};
