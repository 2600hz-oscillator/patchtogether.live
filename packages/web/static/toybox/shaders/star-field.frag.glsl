#version 300 es
// TOYBOX GEN — star-field
//
// A parallax starfield warping toward the viewer: layered grids of hashed star
// points stream outward from the centre with depth-scaled speed + brightness,
// giving the classic "hyperspace / flying through stars" look. Pure generative
// pattern (no scene input).
//
// Re-authored (clean-room, MIT) from:
//   * The standard layered-grid star technique: per-cell hash places a point,
//     a soft radial falloff draws the star, and several layers at increasing
//     scroll speed give parallax. Widely published; original GLSL ES 300
//     implementation, no third-party source text pasted. Colour is this
//     project's own.
//
// Uniforms: iTime, iResolution, plus declared floats: density, speed, warp.

precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform float iTime;
uniform vec2  iResolution;

uniform float density; // stars per layer (grid density)
uniform float speed;   // forward fly speed
uniform float warp;    // outward radial streaking strength

vec2 hash22(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453123);
}
float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// One depth layer of stars; `z` (0..1) scales scroll + size.
vec3 layer(vec2 uv, float z, float t, float dens) {
  // Radial coordinate centred — stars stream OUT from the centre.
  vec2 dir = uv;
  float r = length(dir) + 1e-3;
  // Forward motion: pull the sample inward over time (so points appear to fly
  // toward the viewer), modulated per layer by depth.
  float fly = t * (0.15 + 0.85 * z) * speed;
  vec2 p = uv * (dens) + dir / r * fly * warp;

  vec2 cell = floor(p);
  vec2 f = fract(p) - 0.5;
  vec2 jit = hash22(cell) - 0.5;
  float d = length(f - jit * 0.7);
  float twinkle = 0.6 + 0.4 * sin(t * 3.0 + hash21(cell) * 6.2831853);

  float star = smoothstep(0.06, 0.0, d) * twinkle;
  // Brighter near the centre (closer in the warp), tinted slightly cool→warm.
  float depthBright = mix(0.4, 1.0, z) * smoothstep(1.2, 0.1, r);
  vec3 tint = mix(vec3(0.7, 0.8, 1.0), vec3(1.0, 0.95, 0.85), hash21(cell + 1.7));
  return star * depthBright * tint;
}

void main() {
  vec2 uv = (vUv - 0.5) * vec2(iResolution.x / iResolution.y, 1.0);
  float t = iTime;
  float dens = max(2.0, density);

  vec3 col = vec3(0.01, 0.012, 0.03); // deep space
  // Three parallax depth layers.
  col += layer(uv, 0.25, t, dens * 0.6);
  col += layer(uv, 0.55, t, dens);
  col += layer(uv, 0.9,  t, dens * 1.6);

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
