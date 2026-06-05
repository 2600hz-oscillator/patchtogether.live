#version 300 es
// TOYBOX GEN — spiral-bloom
//
// A logarithmic-spiral "bloom": polar petals swept by an Archimedean/log spiral,
// pulsing open + closed and hue-cycled — a feedback-friendly mandala source.
// Generative, single-pass, no scene input.
//
// Authored clean-room for TOYBOX — original GLSL. Standard polar-coordinate +
// log-spiral construction (r,theta petals); no third-party source text pasted.
//
// Uniforms: iTime, iResolution, plus declared floats: arms, twist, speed.

precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform float iTime;
uniform vec2  iResolution;

uniform float arms;   // number of spiral arms / petals
uniform float twist;  // spiral tightness
uniform float speed;  // rotation rate

vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

void main() {
  vec2 uv = vUv;
  vec2 p = (uv - 0.5) * vec2(iResolution.x / iResolution.y, 1.0);
  float t = iTime * speed;

  float r = length(p);
  float a = atan(p.y, p.x);

  // log-spiral phase: theta plus a twist that grows with log(radius).
  float spiral = a * max(1.0, arms) + log(r + 0.05) * twist * 4.0 - t;
  float petal = 0.5 + 0.5 * cos(spiral);
  petal = pow(petal, 3.0);

  // radial pulse so the bloom opens and closes.
  float pulse = 0.5 + 0.5 * sin(t * 1.5 - r * 6.0);
  float ring = smoothstep(0.9, 0.2, r) * pulse;

  float v = petal * ring;
  vec3 col = hsv2rgb(vec3(fract(a / 6.2831853 + r - t * 0.05), 0.8, 1.0));
  col *= 0.2 + 1.4 * v;
  col += vec3(0.05, 0.02, 0.10) * smoothstep(0.9, 0.0, r); // core glow

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
