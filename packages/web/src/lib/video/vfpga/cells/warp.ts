// packages/web/src/lib/video/vfpga/cells/warp.ts
//
// CLB cell `warp(a, zoom, rot, hue, gain)` — a centre UV zoom + rotate + per-pass
// hue-rotate + gain (the frame-store HOWL recirculation transform, design §3.3).
// On its own it is a generic geometric/colour transform; wired so its input is a
// register's `:prev` (last-frame) buffer it becomes the howl-around feedback warp:
// each frame the recirculated picture is zoomed/rotated/hue-spun/decayed before
// being re-mixed with the live input. ONE input (a), four knobs.
//
//   zoom  per-pass scale about centre (>1 zoom IN → runaway tunnel; <1 zoom out).
//   rot   per-pass rotation about centre (radians) → spiral howl.
//   hue   per-pass hue rotation (0..1 wheel) → rainbow howl.
//   gain  per-pass amplitude (the feedback DECAY: <1 trails fade, >1 runs away).
//
// uResolution gives the aspect correction so the rotation is circular, not
// sheared. No seeded rng here (the howl's motion is the deterministic transform);
// CV binds onto zoom, a freeze/clear gate binds onto gain (gain→0 clears).

import { type VfpgaCell } from './types';

export const warpCell: VfpgaCell = {
  type: 'clb',
  op: 'warp',
  inputs: ['a'],
  knobs: [
    { name: 'zoom', uniform: 'uWarpZoom', defaultValue: 1.0, label: 'ZOOM', doc: 'Per-pass scale about centre (>1 zoom in → tunnel howl).' },
    { name: 'rot', uniform: 'uWarpRot', defaultValue: 0.0, label: 'ROT', doc: 'Per-pass rotation about centre (radians) → spiral howl.' },
    { name: 'hue', uniform: 'uWarpHue', defaultValue: 0.0, label: 'HUE', doc: 'Per-pass hue rotation (0..1 colour wheel) → rainbow howl.' },
    { name: 'gain', uniform: 'uWarpGain', defaultValue: 1.0, label: 'GAIN', doc: 'Per-pass amplitude = feedback decay (<1 fade, >1 runaway, 0 clear).' },
    { name: 'clear', uniform: 'uWarpClear', defaultValue: 0.0, label: 'CLEAR', doc: 'A held clear: 1 zeroes the recirculation (wipes the frame-store).' },
  ],
  doc: 'Centre zoom + rotate + hue-spin + gain — the frame-store howl recirculation warp.',
  kernel({ uTexFor, uniformFor }) {
    const a = uTexFor('a');
    const zoom = uniformFor('zoom');
    const rot = uniformFor('rot');
    const hue = uniformFor('hue');
    const gain = uniformFor('gain');
    const clear = uniformFor('clear');
    return `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D ${a};
uniform vec2 uResolution;
uniform float ${zoom};
uniform float ${rot};
uniform float ${hue};
uniform float ${gain};
uniform float ${clear};
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
void main() {
  // centre + aspect-correct so rotation is circular.
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = (vUv - 0.5) * vec2(aspect, 1.0);
  float z = abs(${zoom}) < 1.0e-4 ? 1.0e-4 : ${zoom};
  p /= z;
  float s = sin(${rot}), c = cos(${rot});
  p = mat2(c, -s, s, c) * p;
  vec2 uv = p / vec2(aspect, 1.0) + 0.5;
  vec3 col = texture(${a}, uv).rgb;
  // out-of-bounds reads decay to black so trails don't smear edge garbage.
  float inB = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  col *= inB;
  // per-pass hue spin.
  vec3 hsv = rgb2hsv(col);
  hsv.x = fract(hsv.x + ${hue});
  col = hsv2rgb(hsv);
  // per-pass gain = the feedback decay; a held clear wipes it to black.
  col *= ${gain} * (1.0 - clamp(${clear}, 0.0, 1.0));
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;
  },
};
