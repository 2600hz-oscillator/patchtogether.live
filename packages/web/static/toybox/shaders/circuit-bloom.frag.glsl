#version 300 es
// TOYBOX GEN — circuit-bloom
//
// A glowing PCB / circuit-board pattern: a grid of cells each picks a random
// L-shaped trace (a "Truchet" wire tile), the wires light up and pulse with
// travelling signals, with solder-pad bloom at the junctions. Single-pass +
// generative (no scene input).
//
// Authored clean-room for TOYBOX — original GLSL. Standard Truchet hashing +
// SDF line segments + an animated pulse along arc-length; no third-party source
// text pasted.
//
// Uniforms: iTime, iResolution, plus declared floats: scale, pulse, glow.

precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform float iTime;
uniform vec2  iResolution;

uniform float scale; // grid density
uniform float pulse; // travelling-signal rate
uniform float glow;  // trace glow strength

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}

// distance to a segment a→b
float seg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

void main() {
  float t = iTime;
  float s = max(1.0, scale);
  vec2 uv = (vUv - 0.5) * vec2(iResolution.x / iResolution.y, 1.0);
  vec2 gp = uv * s;
  vec2 cell = floor(gp);
  vec2 f = fract(gp) - 0.5;

  float h = hash21(cell);
  // pick one of two L-trace orientations per cell (Truchet).
  vec2 a, b, c;
  if (h < 0.5) { a = vec2(0.0, -0.5); b = vec2(0.0, 0.0); c = vec2(0.5, 0.0); }
  else         { a = vec2(0.0, -0.5); b = vec2(0.0, 0.0); c = vec2(-0.5, 0.0); }

  float d = min(seg(f, a, b), seg(f, b, c));
  // also a vertical-through trace some of the time for variety
  if (hash21(cell + 7.3) < 0.45) d = min(d, seg(f, vec2(0.0, -0.5), vec2(0.0, 0.5)));

  float wire = smoothstep(0.06, 0.03, d);
  float bloom = exp(-d * (10.0 - 6.0 * clamp(glow, 0.0, 1.0)));

  // travelling signal: a bright dot that runs along the trace, phased per cell
  float phase = fract(t * (0.2 + pulse) + h);
  float sig = smoothstep(0.08, 0.0, abs(fract(d * 4.0 - phase * 2.0) - 0.5) - 0.02);

  // solder pad at the junction
  float pad = smoothstep(0.12, 0.08, length(f - b)) * 0.6;

  vec3 board = vec3(0.02, 0.05, 0.04);
  vec3 trace = vec3(0.1, 0.9, 0.6);
  vec3 hot   = vec3(0.7, 1.0, 0.9);

  vec3 col = board;
  col += trace * (wire * 0.6 + bloom * 0.5 * (0.5 + glow));
  col += hot * sig * (0.6 + pulse);
  col += vec3(0.9, 0.8, 0.3) * pad;

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
