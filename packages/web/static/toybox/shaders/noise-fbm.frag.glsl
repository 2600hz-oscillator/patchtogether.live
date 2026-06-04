#version 300 es
// TOYBOX GEN — noise-fbm
//
// A domain-warped fractal-Brownian-motion field of 2D simplex noise,
// colour-ramped to a cool→warm gradient.
//
// Re-authored (clean-room, MIT) from:
//   * stegu / webgl-noise — Ashima 2D simplex noise (snoise).
//     https://github.com/stegu/webgl-noise  (MIT)
//   * glsl-fbm — fbm() octave-sum convention.
//     https://github.com/yiwenl/glsl-fbm    (MIT)
// The simplex permutation/gradient math is the standard Ashima formulation
// transcribed into GLSL ES 300; no third-party source text was pasted.
//
// Uniforms: iTime, iResolution, plus declared floats: scale, speed, warp.

precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform float iTime;
uniform vec2  iResolution;

uniform float scale;  // base feature scale (zoom of the noise field)
uniform float speed;  // animation rate
uniform float warp;   // domain-warp strength (0 = none)

// ---- Ashima 2D simplex noise (re-authored) ----
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }

float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187,   // (3-sqrt(3))/6
                      0.366025403784439,    // 0.5*(sqrt(3)-1)
                     -0.577350269189626,    // -1 + 2*C.x
                      0.024390243902439);   // 1 / 41
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
                          + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x  = 2.0 * fract(p * C.www) - 1.0;
  vec3 h  = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x  = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

// ---- FBM octave sum (glsl-fbm convention, re-authored) ----
float fbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  for (int i = 0; i < 5; i++) {
    sum += amp * snoise(p * freq);
    freq *= 2.0;
    amp  *= 0.5;
  }
  return sum;
}

void main() {
  vec2 uv = vUv;
  // 4:3 aspect-correct sampling coordinates centred on origin.
  vec2 p = (uv - 0.5) * vec2(iResolution.x / iResolution.y, 1.0);
  float s = max(0.1, scale);
  float t = iTime * speed;

  // Domain warp: offset the sample point by a slow secondary FBM field.
  vec2 q = vec2(fbm(p * s + vec2(0.0, t)),
                fbm(p * s + vec2(5.2, 1.3 - t)));
  vec2 warped = p * s + warp * q;

  float n = fbm(warped + vec2(t * 0.5, -t * 0.3));
  // Map noise (-1..1-ish) into 0..1.
  float v = clamp(n * 0.5 + 0.5, 0.0, 1.0);

  // Cool→warm ramp built from the field value + the warp magnitude.
  vec3 cool = vec3(0.05, 0.12, 0.35);
  vec3 warm = vec3(0.95, 0.55, 0.15);
  vec3 col  = mix(cool, warm, v);
  // Brighten ridges (high |q|) so the warp reads as glowing veins.
  col += vec3(0.25, 0.18, 0.30) * smoothstep(0.6, 1.2, length(q)) * warp;

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
