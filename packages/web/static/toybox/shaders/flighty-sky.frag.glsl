#version 300 es
// TOYBOX GEN — flighty-sky
//
// A drifting DAYTIME sky: a vertical azure→warm-haze gradient, a soft sun disc
// with a wide halo, and two parallax layers of domain-warped fBm cumulus that
// scroll horizontally on iTime. Purpose-built as the backdrop for the FLIGHTY
// preset (a bird flapping over open sky) — unlike GROWING MOUNTAIN it has NO
// foreground to occlude the bird, and unlike STAR-FIELD it reads as day, not
// space. Single-pass + generative (no scene input).
//
// Authored clean-room for TOYBOX — original GLSL. Standard, widely-published
// value-noise + fBm octave-sum (the same formulation already credited for
// noise-fbm — MIT, this project); the gradient ramp, sun placement, cloud
// thresholding and palette are this project's own. No third-party source pasted.
//
// Uniforms: iTime, iResolution, plus declared floats: speed, cover, sun.

precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform float iTime;
uniform vec2  iResolution;

uniform float speed; // cloud drift rate
uniform float cover; // cloud cover / density (0 clear .. 1 overcast)
uniform float sun;   // sun height / time-of-day warmth (0 low+cool .. 1 high+warm)

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1, 0));
  float c = hash21(i + vec2(0, 1)), d = hash21(i + vec2(1, 1));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p = p * 2.02 + 11.3;
    a *= 0.5;
  }
  return s;
}

void main() {
  vec2 uv = vUv;                       // 0..1, y up
  float aspect = iResolution.x / max(iResolution.y, 1.0);

  // 1) Vertical gradient: deep azure zenith → pale warm haze at the horizon.
  vec3 zenith  = vec3(0.16, 0.42, 0.78);
  vec3 hazeCool = vec3(0.74, 0.83, 0.92);
  vec3 hazeWarm = vec3(0.99, 0.85, 0.66);
  vec3 horizon = mix(hazeCool, hazeWarm, sun);        // warmer as the sun rises
  vec3 col = mix(horizon, zenith, smoothstep(0.0, 0.95, uv.y));

  // 2) Sun disc + wide halo, placed high-right; warmth + height ride `sun`.
  vec2 sp = vec2(0.72, 0.55 + 0.22 * sun);
  vec2 auv = vec2(uv.x * aspect, uv.y);
  vec2 asp = vec2(sp.x * aspect, sp.y);
  float d = distance(auv, asp);
  vec3 sunCol = mix(vec3(1.0, 0.86, 0.66), vec3(1.0, 0.97, 0.86), sun);
  col += sunCol * smoothstep(0.055, 0.0, d);           // bright disc
  col += sunCol * 0.40 * exp(-d * 5.5);                // soft halo
  col += sunCol * 0.10 * exp(-d * 1.6);                // broad glow wash

  // 3) Two drifting cloud layers (domain-warped fBm), soft-thresholded cumulus.
  //    The far layer scrolls slower + sits smaller → parallax depth.
  float t = iTime * speed;
  for (int L = 0; L < 2; L++) {
    float fl = float(L);
    float sc = 3.0 + fl * 2.6;
    vec2 q = uv * vec2(2.2, 1.0) * sc + vec2(t * (0.5 + 0.5 * fl), 0.0);
    float n = fbm(q + fbm(q * 0.5));                   // domain warp
    float thresh = mix(0.78, 0.34, cover);             // more cover → lower bar
    float cloud = smoothstep(thresh, thresh + 0.20, n) * (0.9 - 0.28 * fl);
    // Lit cumulus tops, faintly warmed by the sun; fade clouds into the horizon.
    vec3 lit = mix(vec3(0.86, 0.88, 0.93), vec3(1.0, 0.98, 0.94), 0.35 + 0.4 * sun);
    vec3 shade = vec3(0.62, 0.66, 0.74);
    vec3 cloudCol = mix(shade, lit, smoothstep(thresh, thresh + 0.35, n));
    float band = smoothstep(0.08, 0.42, uv.y);         // keep clouds off the base
    col = mix(col, cloudCol, cloud * band);
  }

  // 4) Subtle horizon haze lift so the base reads as distant, hazy air.
  col = mix(col, horizon, smoothstep(0.22, 0.0, uv.y) * 0.55);

  // 5) Gentle vignette to seat the frame.
  vec2 cv = (uv - 0.5) * vec2(aspect, 1.0);
  col *= 1.0 - 0.18 * dot(cv, cv);

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
