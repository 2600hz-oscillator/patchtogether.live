// TOYBOX GEN — warp-terrain (scrolling fBm contour terrain, SHADERTOY single-pass)
//
// A top-down procedural TERRAIN map: domain-warped fBm value-noise read as a
// height field, contour-banded into elevation lines and colour-ramped through a
// water → sand → grass → rock → snow gradient. The whole field scrolls so it
// reads as flying over endless generated land. Generative, no scene input.
//
// === LICENSE / PROVENANCE ===
// Original clean-room TOYBOX shader. Standard value-noise fBm + iterative domain
// warp (IQ "warp" technique, public) + elevation contour banding via fract(). No
// third-party / Shadertoy source text copied.
//
// Manifest: shadertoy:true, input:none (GEN). Params:
//   scale — terrain feature scale
//   speed — scroll/fly rate
//   warp  — domain-warp strength (ruggedness)

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i + vec2(0.0, 0.0));
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 6; i++) { s += a * vnoise(p); p = p * 2.01 + vec2(1.3, 7.1); a *= 0.5; }
  return s;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec2 p = uv * (1.5 + scale * 2.0);
  float t = iTime * (0.1 + speed * 0.3);
  p += vec2(t * 0.6, t * 0.2);  // scroll

  // domain warp → rugged terrain.
  float w = max(0.0, warp);
  vec2 q = vec2(fbm(p), fbm(p + vec2(5.2, 1.3)));
  float h = fbm(p + (1.5 + w) * q);  // height field 0..1

  // elevation colour ramp.
  vec3 col;
  if      (h < 0.35) col = mix(vec3(0.02, 0.10, 0.30), vec3(0.05, 0.30, 0.55), h / 0.35);        // deep→shallow water
  else if (h < 0.45) col = mix(vec3(0.80, 0.75, 0.50), vec3(0.55, 0.65, 0.30), (h - 0.35) / 0.10); // sand→grass
  else if (h < 0.70) col = mix(vec3(0.25, 0.50, 0.20), vec3(0.40, 0.35, 0.25), (h - 0.45) / 0.25); // grass→rock
  else               col = mix(vec3(0.40, 0.35, 0.25), vec3(0.95, 0.97, 1.00), (h - 0.70) / 0.30); // rock→snow

  // contour elevation lines.
  float line = abs(fract(h * 14.0) - 0.5);
  col *= 0.7 + 0.3 * smoothstep(0.0, 0.08, line);
  // shoreline shimmer.
  col += vec3(0.4, 0.7, 0.9) * smoothstep(0.36, 0.34, h) * smoothstep(0.30, 0.35, h);

  // soft top-down lighting from the height gradient.
  float e = 0.01;
  float dx = fbm(p + (1.5 + w) * q + vec2(e, 0.0)) - h;
  float dy = fbm(p + (1.5 + w) * q + vec2(0.0, e)) - h;
  float shade = clamp(0.5 + (dx + dy) * 6.0, 0.4, 1.3);
  col *= shade;

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
