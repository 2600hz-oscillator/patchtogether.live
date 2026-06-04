#version 300 es
// TOYBOX GEN — worley-cells
//
// Animated Worley (cellular) noise: feature points jitter inside a grid,
// and each pixel is shaded by its distance to the nearest point (F1) plus
// the gap to the second-nearest (F2-F1) for crisp cell edges.
//
// Re-authored (clean-room, MIT) from:
//   * glsl-worley — the 3x3 neighbour-cell F1/F2 search convention.
//     https://github.com/Erkaman/glsl-worley  (MIT)
// The hash + neighbour-scan is the standard Worley formulation transcribed
// into GLSL ES 300; no third-party source text was pasted.
//
// Uniforms: iTime, iResolution, plus declared floats: density, edge, speed.

precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform float iTime;
uniform vec2  iResolution;

uniform float density; // cells per axis (grid density)
uniform float edge;    // edge sharpness (F2-F1 contribution)
uniform float speed;   // point-jitter animation rate

// 2D hash → 2D point in [0,1] (re-authored; standard fract-sin hash).
vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)),
           dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453123);
}

void main() {
  vec2 uv = vUv;
  vec2 p = uv * vec2(iResolution.x / iResolution.y, 1.0);
  float d = max(1.0, density);
  p *= d;

  vec2 cell = floor(p);
  vec2 f = fract(p);

  float t = iTime * speed;
  float f1 = 8.0; // nearest distance
  float f2 = 8.0; // second nearest

  // 3x3 neighbour-cell scan for the two closest feature points.
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = hash2(cell + g);
      // Animate the feature point with a per-point phase so cells breathe.
      o = 0.5 + 0.5 * sin(t + 6.2831853 * o);
      vec2 r = g + o - f;
      float dist = dot(r, r); // squared distance (cheaper; monotonic)
      if (dist < f1) { f2 = f1; f1 = dist; }
      else if (dist < f2) { f2 = dist; }
    }
  }
  f1 = sqrt(f1);
  f2 = sqrt(f2);

  // Cell body brightness falls off with F1; edges glow where F2-F1 is small.
  float body = 1.0 - smoothstep(0.0, 1.0, f1);
  float border = 1.0 - smoothstep(0.0, max(0.001, 0.15 / max(0.01, edge)), f2 - f1);

  vec3 cellCol = mix(vec3(0.02, 0.04, 0.08), vec3(0.15, 0.85, 0.75), body);
  vec3 col = cellCol + vec3(0.9, 0.95, 1.0) * border * edge;

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
