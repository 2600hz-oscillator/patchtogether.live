#version 300 es
// TOYBOX FX — cos-gradient
//
// Iñigo Quílez's cosine colour-palette technique: each channel is a cosine
// of a position parameter, so a single 1D ramp produces smooth, loopable
// multi-hue gradients. Here the ramp parameter is an animated radial+angular
// field, giving slowly rotating concentric colour rings.
//
// Re-authored (clean-room, MIT) from:
//   * glsl-cos-palette — palette(t,a,b,c,d) = a + b*cos(2pi*(c*t+d)).
//     https://github.com/Jam3/glsl-cos-palette  (MIT, IQ technique)
// The palette() function is the standard IQ cosine-palette formula
// transcribed into GLSL ES 300; the driving field is original.
//
// Uniforms: iTime, iResolution, plus declared floats: speed, phase, scale.

precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform float iTime;
uniform vec2  iResolution;

uniform float speed; // ring scroll rate
uniform float phase; // hue phase offset around the palette
uniform float scale; // ring frequency (how many bands across the frame)

// IQ cosine palette (re-authored): a + b * cos(2*pi*(c*t + d)).
vec3 palette(float t, vec3 a, vec3 b, vec3 c, vec3 d) {
  return a + b * cos(6.28318530718 * (c * t + d));
}

void main() {
  vec2 uv = (vUv - 0.5) * vec2(iResolution.x / iResolution.y, 1.0);
  float r = length(uv);
  float a = atan(uv.y, uv.x);
  float t = iTime * speed;

  // Ramp parameter: radial bands that scroll, gently swirled by the angle.
  float k = r * max(0.5, scale) + 0.15 * sin(a * 3.0 + t) - t;

  // A pleasing warm/cool IQ palette; `phase` rotates the per-channel offset.
  vec3 col = palette(
    k,
    vec3(0.5, 0.5, 0.5),
    vec3(0.5, 0.5, 0.5),
    vec3(1.0, 1.0, 1.0),
    vec3(0.0, 0.33, 0.67) + phase
  );

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
