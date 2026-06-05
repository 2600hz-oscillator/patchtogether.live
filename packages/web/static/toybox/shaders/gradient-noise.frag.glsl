#version 300 es
// TOYBOX GEN — gradient-noise
//
// Smooth value-gradient (Perlin-style) noise turbulence, ramped to a soft
// nebula gradient. A grid of pseudo-random gradient vectors is interpolated
// with the quintic fade curve, summed over octaves (turbulence = sum of
// |noise|), giving billowing cloud-like structure. Distinct from noise-fbm
// (Ashima SIMPLEX): this is the classic VALUE/GRADIENT-grid construction.
//
// Re-authored (clean-room, MIT) from:
//   * Inigo Quilez — "gradient noise" 2D (hash-gradient dot + quintic fade).
//     https://iquilezles.org/articles/gradientnoise/  (technique, MIT)
// The hash, gradient dot, quintic fade and octave sum are the standard
// formulation transcribed into GLSL ES 300; no third-party source was pasted.
//
// Uniforms: iTime, iResolution, plus declared floats: scale, speed, gain.

precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform float iTime;
uniform vec2  iResolution;

uniform float scale; // base feature scale
uniform float speed; // animation rate
uniform float gain;  // per-octave amplitude falloff (turbulence richness)

// 2D gradient hash → a unit-ish vector in [-1,1]^2.
vec2 grad(vec2 p) {
  float h = fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  float a = h * 6.2831853;
  return vec2(cos(a), sin(a));
}

// IQ gradient noise: bilinear blend of corner gradient dots, quintic fade.
float gnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0); // quintic
  float a = dot(grad(i + vec2(0.0, 0.0)), f - vec2(0.0, 0.0));
  float b = dot(grad(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
  float c = dot(grad(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
  float d = dot(grad(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Turbulence: octave sum of |gnoise| (sharper, cloud-like ridges).
float turb(vec2 p, float g) {
  float sum = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  for (int i = 0; i < 5; i++) {
    sum += amp * abs(gnoise(p * freq));
    freq *= 2.0;
    amp  *= clamp(g, 0.3, 0.75);
  }
  return sum;
}

void main() {
  vec2 uv = vUv;
  vec2 p = (uv - 0.5) * vec2(iResolution.x / iResolution.y, 1.0);
  float s = max(0.1, scale);
  float t = iTime * speed;

  float n = turb(p * s + vec2(t * 0.2, -t * 0.13), gain);
  float v = clamp(n * 1.3, 0.0, 1.0);

  // Soft nebula ramp: deep indigo → magenta → pale gold at the crests.
  vec3 a = vec3(0.03, 0.02, 0.12);
  vec3 b = vec3(0.45, 0.10, 0.45);
  vec3 c = vec3(0.98, 0.85, 0.55);
  vec3 col = mix(a, b, smoothstep(0.0, 0.55, v));
  col = mix(col, c, smoothstep(0.55, 1.0, v));

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
