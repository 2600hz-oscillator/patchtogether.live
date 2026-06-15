// TOYBOX GEN — warp-tunnel (infinite flying tunnel, SHADERTOY single-pass)
//
// A classic demoscene TUNNEL: each pixel's polar coordinates index a scrolling
// texture-space (angle → u, 1/radius → v) so the screen reads as an infinite
// pipe rushing toward the camera. A procedural checker/stripe pattern + a cosine
// palette + distance fog give the flying-through-a-wormhole look. The tunnel
// mouth swirls slowly. Generative, no scene input.
//
// === LICENSE / PROVENANCE ===
// Original clean-room TOYBOX shader. Standard polar tunnel mapping (u=angle,
// v=1/r) — a widely-published demoscene technique — with an original procedural
// wall pattern + palette. No third-party / Shadertoy source text copied.
//
// Manifest: shadertoy:true, input:none (GEN). Params:
//   speed — fly-through rate
//   twist — angular swirl of the tunnel
//   fog   — distance fog amount (0 clear → 1 thick)

vec3 palette(float t) {
  vec3 a = vec3(0.5), b = vec3(0.5);
  vec3 c = vec3(1.0);
  vec3 d = vec3(0.0, 0.20, 0.55);
  return a + b * cos(6.28318 * (c * t + d));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 p = (2.0 * fragCoord - iResolution.xy) / iResolution.y;
  float t = iTime * (0.3 + speed);

  float r = length(p);
  float a = atan(p.y, p.x);

  // polar tunnel mapping: v rushes inward as 1/r, u wraps with the angle.
  float v = 0.30 / (r + 0.05) + t;        // depth coordinate (flies forward)
  float u = a / 6.28318 + twist * t * 0.1 + 0.10 * sin(v * 1.5); // swirling walls

  // procedural wall pattern: checker × stripes.
  float checker = step(0.5, fract(u * 8.0)) * step(0.5, fract(v * 4.0));
  float stripe = 0.5 + 0.5 * sin(v * 12.0 + u * 6.28318);
  float pat = mix(stripe, 1.0 - stripe, checker);

  vec3 col = palette(v * 0.15 + u + iTime * 0.03);
  col *= 0.4 + 0.8 * pat;

  // distance fog: far (small r → deep) fades to dark; a bright tunnel rim.
  float depth = clamp(r * 1.4, 0.0, 1.0);
  col = mix(vec3(0.0), col, mix(1.0, depth, fog));
  col += vec3(0.8, 0.9, 1.0) * exp(-r * 8.0) * 0.6; // glowing centre

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
