#version 300 es
// TOYBOX GEN — truchet
//
// Animated Truchet tiling: each grid cell randomly hosts one of the two
// quarter-arc orientations, and the arcs join across cells into a flowing maze
// of interlocking curves. The arc phase scrolls with iTime so the lines appear
// to flow through the maze. Pure generative pattern (no scene input).
//
// Re-authored (clean-room, MIT) from:
//   * The classic Truchet-tile construction (Cyril Stanley Smith / Smith
//     tiles): per-cell coin-flip selects which pair of opposite corners the two
//     quarter circles connect; the arc SDF is distance-to-circle of radius 0.5
//     centred on the chosen corners. Widely published technique (e.g. IQ /
//     Shane Truchet tutorials). Original GLSL ES 300 implementation; no
//     third-party source text was pasted. Colour ramp is this project's own.
//
// Uniforms: iTime, iResolution, plus declared floats: scale, width, flow.

precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform float iTime;
uniform vec2  iResolution;

uniform float scale; // tiles across the frame
uniform float width; // arc line thickness
uniform float flow;  // along-arc scroll speed

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
  vec2 uv = (vUv - 0.5) * vec2(iResolution.x / iResolution.y, 1.0) + 0.5;
  float t = iTime;
  vec2 p = uv * max(1.0, scale);

  vec2 id = floor(p);
  vec2 f = fract(p);

  // Coin flip per cell selects the arc orientation. If flipped, mirror x so the
  // two quarter-arcs connect the OTHER diagonal pair of corners.
  float flip = step(0.5, hash21(id));
  if (flip > 0.5) f.x = 1.0 - f.x;

  // Two quarter-circle arcs of radius 0.5 centred on opposite corners.
  float d0 = abs(length(f - vec2(0.0, 0.0)) - 0.5);
  float d1 = abs(length(f - vec2(1.0, 1.0)) - 0.5);
  float d = min(d0, d1);

  float w = 0.06 * max(0.2, width);
  float line = smoothstep(w, 0.0, d);

  // Flow: parameterise position along the nearer arc by the angle, scroll it.
  vec2 c = d0 < d1 ? vec2(0.0) : vec2(1.0);
  float ang = atan(f.y - c.y, f.x - c.x);
  float stripes = 0.5 + 0.5 * sin(ang * 18.0 - t * (1.0 + flow * 3.0));

  vec3 bg = vec3(0.03, 0.05, 0.09);
  vec3 lineCol = mix(vec3(0.15, 0.55, 0.85), vec3(0.95, 0.85, 0.35), stripes);
  vec3 col = mix(bg, lineCol, line);

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
