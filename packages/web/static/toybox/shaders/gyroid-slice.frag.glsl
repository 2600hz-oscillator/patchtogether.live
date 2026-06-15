// TOYBOX GEN — gyroid-slice (animated gyroid cross-section, SHADERTOY single-pass)
//
// A moving 2D SLICE through a 3D GYROID (a triply-periodic minimal surface:
// sin x cos y + sin y cos z + sin z cos x = 0). As the slice plane sweeps along
// z over time, the iso-surface contours morph into endlessly reconfiguring
// organic labyrinth/lattice bands, shaded by the field gradient and colour-ramped
// through a cosine palette. Generative, no scene input.
//
// === LICENSE / PROVENANCE ===
// Original clean-room TOYBOX shader. The gyroid is a standard, public minimal-
// surface formula; the slice/contour/shading construction is original. No
// third-party / Shadertoy source text copied.
//
// Manifest: shadertoy:true, input:none (GEN). Params:
//   scale — lattice cell frequency
//   speed — slice-sweep rate
//   hue   — palette rotation

vec3 palette(float t) {
  vec3 a = vec3(0.5), b = vec3(0.5);
  vec3 c = vec3(1.0);
  vec3 d = vec3(0.55, 0.30, 0.10);
  return a + b * cos(6.28318 * (c * t + d));
}

float gyroid(vec3 p) {
  return sin(p.x) * cos(p.y) + sin(p.y) * cos(p.z) + sin(p.z) * cos(p.x);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = (2.0 * fragCoord - iResolution.xy) / iResolution.y;
  float t = iTime * (0.2 + speed * 0.4);
  float s = 3.0 + scale * 3.0;

  // a slowly-rotating, z-sweeping slice plane.
  float ca = cos(t * 0.15), sa = sin(t * 0.15);
  vec2 r = vec2(uv.x * ca - uv.y * sa, uv.x * sa + uv.y * ca);
  vec3 P = vec3(r * s, t * 1.2);

  float g = gyroid(P);
  // iso-contour bands of the gyroid field.
  float band = abs(fract(g * 1.5 + 0.5) - 0.5) * 2.0;
  float surf = smoothstep(0.0, 0.18, band);

  // field gradient → fake lighting.
  float e = 0.05;
  float gx = gyroid(P + vec3(e, 0.0, 0.0)) - g;
  float gy = gyroid(P + vec3(0.0, e, 0.0)) - g;
  vec3 nrm = normalize(vec3(-gx, -gy, e));
  float diff = clamp(dot(nrm, normalize(vec3(0.5, 0.7, 0.6))), 0.0, 1.0);

  vec3 col = palette(g * 0.25 + hue + t * 0.05);
  col *= 0.35 + 0.65 * surf;       // dark lattice gaps, lit struts
  col *= 0.5 + 0.7 * diff;         // shading
  col += vec3(1.0, 0.95, 0.85) * pow(diff, 8.0) * surf * 0.5; // highlight

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
