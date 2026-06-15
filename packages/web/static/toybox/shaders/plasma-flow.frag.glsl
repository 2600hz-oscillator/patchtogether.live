#version 300 es
// TOYBOX GEN — plasma-flow
//
// Classic demoscene PLASMA: several superposed sine fields (axis-aligned, radial
// and a moving-centre ripple) summed into a smooth scalar, then colour-cycled
// through a cosine palette. Warps gently over time for a flowing liquid-light
// look. Single-pass + generative (no scene input).
//
// === LICENSE / PROVENANCE ===
// MIT — Original clean-room TOYBOX shader. Standard demoscene sine-plasma
// construction (sum of sin() of x, y, distance and a moving centre) + the IQ
// cosine-palette technique (a*b*cos(6.283*(c*t+d))) for the colour ramp. No
// third-party source text copied.
//
// Uniforms: iTime, iResolution, plus declared floats: speed, scale, hue.

precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform float iTime;
uniform vec2  iResolution;

uniform float speed;  // animation rate
uniform float scale;  // plasma feature frequency
uniform float hue;    // palette rotation

vec3 palette(float t) {
  // IQ cosine palette (technique, public): warm/cool rainbow.
  vec3 a = vec3(0.5), b = vec3(0.5);
  vec3 c = vec3(1.0, 1.0, 1.0);
  vec3 d = vec3(0.0, 0.33, 0.67);
  return a + b * cos(6.28318 * (c * t + d));
}

void main() {
  vec2 uv = vUv;
  vec2 p = (uv - 0.5) * vec2(iResolution.x / iResolution.y, 1.0);
  float t = iTime * (0.3 + speed);
  float s = 2.0 + scale * 3.0;

  vec2 q = p * s;
  // sum of sine fields → smooth plasma scalar.
  float v = 0.0;
  v += sin(q.x + t);
  v += sin(q.y * 0.9 + t * 1.3);
  v += sin((q.x + q.y) * 0.7 + t * 0.7);
  // moving radial centre.
  vec2 ctr = vec2(sin(t * 0.6), cos(t * 0.5)) * 0.8;
  v += sin(length(q - ctr * s) * 0.8 - t * 1.5);
  // second drifting centre for interference.
  vec2 ctr2 = vec2(cos(t * 0.4), sin(t * 0.7)) * 0.6;
  v += sin(length(q - ctr2 * s) * 1.1 + t);

  v *= 0.2; // normalise the 5-term sum toward [-1,1]

  vec3 col = palette(v + hue + t * 0.05);
  // brighten the crests a touch for depth.
  col *= 0.75 + 0.45 * (0.5 + 0.5 * sin(v * 6.28318));

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
