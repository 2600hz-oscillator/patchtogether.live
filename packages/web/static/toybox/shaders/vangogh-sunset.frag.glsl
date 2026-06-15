// TOYBOX GEN — vangogh-sunset (painterly swirling sunset, SHADERTOY single-pass)
//
// A "Starry-Night"-flavoured sunset: a warm sky gradient with a sinking sun,
// brushed over by swirling impasto strokes (domain-warped flow lines) that drag
// the colour into Van-Gogh-style curls. Generative, no scene input.
//
// === LICENSE / PROVENANCE ===
// Titled after the "Van Gogh sunset" Shadertoy look (Noztol; itself derived from
// "bitless"). This is an ORIGINAL, clean-room TOYBOX implementation — a sky
// gradient + sun disc + a domain-warped value-noise flow that smears the palette
// into painterly swirls. Standard techniques only (value-noise fBm, iterative
// domain warp, directional smear); no third-party source text copied.
//
// Manifest: shadertoy:true, input:none (GEN). Params:
//   speed   — how fast the brushwork swirls
//   swirl   — strength of the painterly warp (curl amount)
//   warmth  — sky warmth (0 cool dusk → 1 fiery sunset)

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
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.02 + 3.1; a *= 0.5; }
  return s;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec2 p = (2.0 * fragCoord - iResolution.xy) / iResolution.y;
  float t = iTime * (0.3 + speed);

  // --- sky gradient (sunset) ---
  vec3 top = mix(vec3(0.10, 0.14, 0.40), vec3(0.25, 0.10, 0.42), warmth);
  vec3 mid = mix(vec3(0.85, 0.45, 0.25), vec3(1.00, 0.40, 0.15), warmth);
  vec3 low = mix(vec3(0.98, 0.78, 0.40), vec3(1.00, 0.85, 0.45), warmth);
  vec3 sky = mix(low, mid, smoothstep(0.0, 0.5, uv.y));
  sky = mix(sky, top, smoothstep(0.45, 1.0, uv.y));

  // --- sinking sun ---
  vec2 sunP = vec2(0.0, -0.15 + 0.05 * sin(t * 0.2));
  float sd = length(p - sunP);
  float sun = smoothstep(0.34, 0.30, sd);
  float halo = smoothstep(0.9, 0.0, sd) * 0.5;
  sky += vec3(1.0, 0.8, 0.5) * halo;
  vec3 col = mix(sky, vec3(1.0, 0.92, 0.7), sun);

  // --- painterly swirl (domain-warped flow that smears the palette) ---
  float sw = max(0.0, swirl);
  vec2 q = vec2(fbm(p * 1.5 + t * 0.1), fbm(p * 1.5 + vec2(5.2, 1.3) - t * 0.12));
  vec2 r = vec2(fbm(p * 1.5 + 2.0 * q + vec2(1.7, 9.2)),
                fbm(p * 1.5 + 2.0 * q + vec2(8.3, 2.8)));
  float brush = fbm(p * 1.5 + (2.0 + sw) * r);
  // brush direction → smear the colour along the flow
  vec2 dir = normalize(r - 0.5 + 1e-4);
  vec3 smeared = mix(col,
    mix(col, low + vec3(0.1, 0.05, 0.0), brush),
    clamp(0.4 + 0.6 * sw, 0.0, 1.0));
  // impasto stroke highlights (thin bright crests of the brush field)
  float crest = smoothstep(0.55, 0.75, brush) - smoothstep(0.75, 0.95, brush);
  smeared += vec3(1.0, 0.9, 0.6) * crest * (0.3 + 0.4 * sw);

  col = mix(col, smeared, 0.85);

  // gentle vignette + gamma
  col *= mix(0.7, 1.05, smoothstep(1.4, 0.2, length(p)));
  col = pow(clamp(col, 0.0, 1.0), vec3(0.9));
  fragColor = vec4(col, 1.0);
}
