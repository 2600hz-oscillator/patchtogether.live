#version 300 es
// TOYBOX GEN — voronoi-edges
//
// Animated Voronoi (cellular) diagram drawn as glowing cell BORDERS: feature
// points jitter inside a grid, and each pixel is shaded by its distance to the
// nearest EDGE (the perpendicular bisector between the two closest points) —
// the classic "cracked-glass / dragonfly-wing" Voronoi-border look. Distinct
// from worley-cells (which shades by F1/F2 distance fields): this measures the
// edge distance directly, so the borders stay a constant crisp width.
//
// Re-authored (clean-room, MIT) from:
//   * Inigo Quilez — "Voronoi - distances" technique (the second-pass edge
//     distance: min over neighbours of dot(midpoint, direction)).
//     https://iquilezles.org/articles/voronoilines/  (technique, MIT)
// The hash + two-pass neighbour scan is the standard formulation transcribed
// into GLSL ES 300; no third-party source text was pasted. The colour ramp is
// this project's own.
//
// Uniforms: iTime, iResolution, plus declared floats: density, edge, speed.

precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform float iTime;
uniform vec2  iResolution;

uniform float density; // cells per axis (grid density)
uniform float edge;    // border thickness / glow
uniform float speed;   // point-jitter animation rate

// 2D hash → 2D point in [0,1] (standard fract-sin hash).
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

  // Pass 1: find the nearest feature point + the offset to it.
  vec2 mr = vec2(0.0);
  float md = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = hash2(cell + g);
      o = 0.5 + 0.5 * sin(t + 6.2831853 * o);
      vec2 r = g + o - f;
      float dd = dot(r, r);
      if (dd < md) { md = dd; mr = r; }
    }
  }

  // Pass 2: distance to the nearest CELL EDGE = min over OTHER points of the
  // distance from the midpoint to f along the bisector direction.
  float medge = 8.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = hash2(cell + g);
      o = 0.5 + 0.5 * sin(t + 6.2831853 * o);
      vec2 r = g + o - f;
      vec2 diff = r - mr;
      if (dot(diff, diff) > 1e-4) {
        // Perpendicular distance from f to the bisector of (mr, r).
        medge = min(medge, dot(0.5 * (mr + r), normalize(diff)));
      }
    }
  }

  // Border glow: bright where medge (edge distance) is small.
  float w = 0.02 * max(0.25, edge);
  float border = 1.0 - smoothstep(0.0, w, medge);
  // Cell interior tint from the nearest-point distance for subtle body shading.
  float body = smoothstep(0.0, 1.0, sqrt(md));

  vec3 interior = mix(vec3(0.06, 0.02, 0.12), vec3(0.20, 0.10, 0.35), body);
  vec3 col = interior + vec3(0.55, 0.85, 1.0) * border * (0.6 + 0.6 * edge);

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
