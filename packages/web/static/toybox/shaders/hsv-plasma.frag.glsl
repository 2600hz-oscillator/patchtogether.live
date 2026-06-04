#version 300 es
// TOYBOX FX — hsv-plasma
//
// Classic animated sine-interference plasma, coloured by rotating through
// HSV hue then converting to RGB. The full-saturation HSV path gives the
// vivid, looping rainbow that flat sine-RGB plasmas can't.
//
// Re-authored (clean-room, MIT) from:
//   * glsl-hsv2rgb — the branchless hsv2rgb() conversion.
//     https://github.com/hughsk/glsl-hsv2rgb  (MIT)
// The hsv2rgb() helper is the well-known Sam Hocevar / IQ formulation
// transcribed into GLSL ES 300; the plasma field itself is original.
//
// Uniforms: iTime, iResolution, plus declared floats: speed, hue, sat.

precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform float iTime;
uniform vec2  iResolution;

uniform float speed; // plasma evolution rate
uniform float hue;   // base hue offset (0..1 around the wheel)
uniform float sat;   // saturation (0 = greyscale, 1 = vivid)

// Branchless HSV→RGB (re-authored hsv2rgb convention).
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  vec3 rgb = clamp(p - 1.0, 0.0, 1.0);
  // Smooth the bands slightly so the hue ramp doesn't show facets.
  rgb = rgb * rgb * (3.0 - 2.0 * rgb);
  return c.z * mix(vec3(1.0), rgb, c.y);
}

void main() {
  // Aspect-correct, centred coordinates scaled into the plasma's domain.
  vec2 uv = (vUv - 0.5) * vec2(iResolution.x / iResolution.y, 1.0) * 6.0;
  float t = iTime * speed;

  // Sum of moving sine waves at different angles + a radial ripple — the
  // canonical plasma interference field.
  float v = 0.0;
  v += sin(uv.x + t);
  v += sin(0.5 * (uv.y + t)) + sin(0.5 * (uv.x + uv.y + t));
  vec2 c = uv + 2.0 * vec2(sin(t * 0.33), cos(t * 0.27));
  v += sin(sqrt(dot(c, c) + 1.0) + t);
  v *= 0.25; // back to ~[-1,1]

  // Map the field to a hue rotation; brightness pumps gently with the field.
  float h = fract(hue + 0.5 + 0.5 * v + t * 0.05);
  float bright = 0.55 + 0.45 * (0.5 + 0.5 * v);
  vec3 col = hsv2rgb(vec3(h, clamp(sat, 0.0, 1.0), bright));

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
