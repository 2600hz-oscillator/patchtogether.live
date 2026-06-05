#version 300 es
// TOYBOX GEN — hex-grid
//
// A hexagonal-tiling field: every pixel is mapped to its nearest hex-cell
// centre, the distance to the cell BOUNDARY draws crisp honeycomb borders, and
// a per-cell hash drives an animated brightness pulse so the comb shimmers.
// Pure generative pattern (no scene input).
//
// Re-authored (clean-room, MIT) from:
//   * The standard axial/cube hex-distance construction (round-to-nearest of
//     the two candidate hex centres in a skewed lattice) — a widely published
//     technique (e.g. Red Blob Games hex grids, IQ hex tutorials). No
//     third-party source text was pasted; this is an original GLSL ES 300
//     implementation of the public construction.
//
// Uniforms: iTime, iResolution, plus declared floats: scale, pulse, edge.

precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform float iTime;
uniform vec2  iResolution;

uniform float scale; // hex cells across the frame
uniform float pulse; // per-cell brightness animation depth
uniform float edge;  // border sharpness

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// Map a point to hex-cell-local coords + the cell id. Returns vec4(local.xy, id.xy).
// Uses the two-candidate flat-top hex construction.
vec4 hexCell(vec2 p) {
  const vec2 s = vec2(1.0, 1.7320508); // (1, sqrt(3))
  // Two candidate centres (the offset-row staggering of a hex lattice).
  vec4 hC = floor(vec4(p, p - vec2(0.5, 1.0)) / s.xyxy) + 0.5;
  vec4 h = vec4(p - hC.xy * s, p - (hC.zw + 0.5) * s);
  // Pick whichever candidate is closer.
  return dot(h.xy, h.xy) < dot(h.zw, h.zw)
    ? vec4(h.xy, hC.xy)
    : vec4(h.zw, hC.zw + 0.5);
}

// Distance from a hex-local point to the nearest of the 3 edge directions.
float hexDist(vec2 p) {
  p = abs(p);
  return max(dot(p, vec2(0.8660254, 0.5)), p.x); // hex half-width metric
}

void main() {
  vec2 uv = (vUv - 0.5) * vec2(iResolution.x / iResolution.y, 1.0);
  float t = iTime;
  vec2 p = uv * max(1.0, scale);

  vec4 hc = hexCell(p);
  vec2 local = hc.xy;
  vec2 id = hc.zw;

  float dBorder = hexDist(local);
  // Honeycomb border: bright thin line near the cell boundary (~0.5 metric).
  float w = 0.04 / max(0.25, edge);
  float border = smoothstep(0.5, 0.5 - w, dBorder);

  // Per-cell animated pulse from the cell hash.
  float seed = hash21(id);
  float beat = 0.5 + 0.5 * sin(t * (0.6 + seed) + seed * 6.2831853);
  float fill = mix(1.0 - clamp(pulse, 0.0, 1.0), 1.0, beat);

  vec3 cellCol = mix(vec3(0.05, 0.10, 0.16), vec3(0.10, 0.55, 0.60), fill) * border;
  vec3 lineCol = vec3(0.85, 0.95, 1.0) * (1.0 - border) * 0.0; // borders are the gaps
  vec3 col = cellCol + lineCol + vec3(0.02, 0.03, 0.05);

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
