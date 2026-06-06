#version 300 es
// TOYBOX GEN — interference
//
// Overlapping circular wavefronts (point-source ripples) that interfere into a
// shifting moiré of bright crests + dark troughs, hue-cycled. Generative,
// single-pass, no scene input.
//
// Authored clean-room for TOYBOX — original GLSL. Standard wave-superposition
// (sum of sin(distance·k − ωt) from moving sources); no third-party source text
// pasted. The source motion, summation and palette are this project's own.
//
// Uniforms: iTime, iResolution, plus declared floats: sources, freq, hue.

precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform float iTime;
uniform vec2  iResolution;

uniform float sources; // number of wave sources (discrete-ish)
uniform float freq;    // spatial frequency of each wavefront
uniform float hue;     // base hue offset

vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

void main() {
  vec2 uv = vUv;
  vec2 p = (uv - 0.5) * vec2(iResolution.x / iResolution.y, 1.0);
  float t = iTime;

  int n = int(clamp(sources, 1.0, 8.0));
  float sum = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= n) break;
    float a = float(i) / float(n) * 6.2831853;
    // each source orbits slowly on its own radius/phase.
    vec2 src = 0.6 * vec2(cos(a + t * 0.3), sin(a * 1.3 - t * 0.25));
    float d = length(p - src);
    sum += sin(d * freq - t * 2.0 + a);
  }
  sum /= float(n);

  // Map the interference value (−1..1) to brightness + hue cycling.
  float v = sum * 0.5 + 0.5;
  vec3 col = hsv2rgb(vec3(fract(hue + v * 0.5 + t * 0.03), 0.85, 1.0));
  col *= 0.35 + 0.9 * smoothstep(0.4, 0.95, v); // bright crests, dark troughs
  // faint dark interference nodes.
  col *= 0.6 + 0.4 * abs(sum);

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
