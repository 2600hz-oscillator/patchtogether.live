#version 300 es
// TOYBOX GEN — flow-field
//
// An animated curl-style flow field: particles-as-pixels trace a divergence-free
// vector field derived from value-noise, leaving glowing streamlines colour-
// ramped by flow speed. Single-pass + generative (no scene input).
//
// Authored clean-room for TOYBOX — original GLSL. Standard value-noise + the
// curl-of-a-scalar-potential trick (perpendicular gradient) only; no third-party
// source text pasted. The field, streamline integration and palette are this
// project's own.
//
// Uniforms: iTime, iResolution, plus declared floats: scale, speed, swirl.

precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform float iTime;
uniform vec2  iResolution;

uniform float scale;  // field feature scale
uniform float speed;  // animation rate
uniform float swirl;  // curl strength (how much the flow rotates)

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1, 0));
  float c = hash21(i + vec2(0, 1)), d = hash21(i + vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// Curl of a scalar potential = perpendicular of its gradient → divergence-free.
vec2 curl(vec2 p, float t) {
  float e = 0.05;
  float n1 = vnoise(p + vec2(0.0, e) + t);
  float n2 = vnoise(p - vec2(0.0, e) + t);
  float n3 = vnoise(p + vec2(e, 0.0) + t);
  float n4 = vnoise(p - vec2(e, 0.0) + t);
  return vec2((n1 - n2), -(n3 - n4)) / (2.0 * e);
}

void main() {
  vec2 uv = vUv;
  vec2 p = (uv - 0.5) * vec2(iResolution.x / iResolution.y, 1.0);
  float t = iTime * speed;
  float s = max(0.2, scale);

  // Integrate a short streamline through the curl field, accumulating intensity.
  vec2 pos = p * s;
  float intensity = 0.0;
  float spd = 0.0;
  for (int i = 0; i < 24; i++) {
    vec2 v = curl(pos * 0.5, t * 0.3) * (0.5 + swirl);
    spd = length(v);
    pos += v * 0.06;
    intensity += exp(-float(i) * 0.12) * (0.4 + 0.6 * vnoise(pos * 2.0 + t));
  }
  intensity /= 6.0;

  // Colour-ramp by speed: cool slow → hot fast streamlines.
  vec3 cool = vec3(0.05, 0.20, 0.45);
  vec3 warm = vec3(1.0, 0.55, 0.15);
  vec3 col = mix(cool, warm, clamp(spd * 0.6, 0.0, 1.0));
  col *= intensity * 1.6;
  col += vec3(0.10, 0.05, 0.20) * intensity; // ambient glow

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
