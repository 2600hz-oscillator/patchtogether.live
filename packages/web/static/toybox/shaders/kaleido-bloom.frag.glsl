#version 300 es
// TOYBOX GEN — kaleido-bloom
//
// A generative KALEIDOSCOPE mandala: polar coordinates folded into N mirrored
// wedges, then a layered radial pattern (rings + petals) coloured by a cosine
// palette and slowly rotated. Unlike the FRAG kaleido (which folds the layer
// below) this synthesises its own pattern, so it is a stand-alone GEN backdrop.
// Single-pass + generative (no scene input).
//
// === LICENSE / PROVENANCE ===
// MIT — Original clean-room TOYBOX shader. Standard polar-fold kaleidoscope
// (mod the angle into a wedge + mirror) + IQ cosine palette; original radial
// pattern. No third-party source text copied.
//
// Uniforms: iTime, iResolution, plus declared floats: segments, spin, hue.

precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform float iTime;
uniform vec2  iResolution;

uniform float segments; // mirrored wedge count
uniform float spin;     // rotation rate
uniform float hue;      // palette rotation

vec3 palette(float t) {
  vec3 a = vec3(0.5), b = vec3(0.5);
  vec3 c = vec3(1.0);
  vec3 d = vec3(0.10, 0.40, 0.75);
  return a + b * cos(6.28318 * (c * t + d));
}

void main() {
  vec2 uv = vUv;
  vec2 p = (uv - 0.5) * vec2(iResolution.x / iResolution.y, 1.0);
  float t = iTime;

  float r = length(p);
  float a = atan(p.y, p.x);

  // fold into N mirrored wedges + slow spin.
  float n = max(2.0, floor(segments + 0.5));
  float wedge = 6.28318 / n;
  a = mod(a, wedge);
  a = abs(a - 0.5 * wedge);
  a += t * spin * 0.4;

  // radial petal/ring pattern in the folded space.
  float petal = sin(a * n * 0.5 + r * 10.0 - t);
  float rings = sin(r * 22.0 - t * 2.0);
  float pat = 0.5 + 0.5 * petal * rings;

  vec3 col = palette(pat + hue + r * 0.3 + t * 0.05);
  // central bloom + outward falloff.
  col *= smoothstep(1.2, 0.0, r) * (0.6 + 0.6 * pat);
  col += vec3(1.0, 0.9, 0.7) * exp(-r * 6.0) * 0.5; // bright core

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
