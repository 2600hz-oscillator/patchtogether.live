// TOYBOX GEN — vangogh-sunset (Van Gogh "Starry Night" swirling impasto, SHADERTOY single-pass)
//
// A "Starry-Night"-flavoured night sky: a deep warm-blue field churned by big
// flowing CURL-NOISE swirls (the painting's signature spiralling sky), broken up
// by thick DIRECTIONAL brush-stroke texture that follows the flow, with luminous
// yellow stars + a glowing crescent moon sitting in haloed impasto rings. The
// palette is Van Gogh's: ultramarine / cobalt blues warmed toward teal, with
// chrome-yellow and cream highlights. Generative, no scene input.
//
// === LICENSE / PROVENANCE ===
// ORIGINAL, clean-room TOYBOX implementation. Standard, individually-public
// techniques only: value-noise fBm, the curl-of-a-scalar-potential trick
// (perpendicular gradient → divergence-free flow), iterative domain warp, and a
// directional brush-stroke modulation sampled ALONG the flow direction. No
// third-party / Shadertoy source text was copied. Titled after Vincent van
// Gogh's public-domain painting "The Starry Night" (1889); no image asset used.
//
// Manifest: shadertoy:true, input:none (GEN). Params:
//   speed   — how fast the sky swirls drift
//   swirl   — strength of the curl/vortex flow (the spiralling)
//   warmth  — palette warmth (0 cool ultramarine night → 1 warmer teal+gold)

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
  float s = 0.0, a = 0.55;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.02 + vec2(3.1, 1.7); a *= 0.5; }
  return s;
}
// Curl of a scalar potential = perpendicular of its gradient → divergence-free
// swirling flow. This is what gives the Starry-Night spirals their rotation.
vec2 curl(vec2 p, float t) {
  float e = 0.04;
  float n1 = fbm(p + vec2(0.0, e) + t);
  float n2 = fbm(p - vec2(0.0, e) + t);
  float n3 = fbm(p + vec2(e, 0.0) + t);
  float n4 = fbm(p - vec2(e, 0.0) + t);
  return vec2(n1 - n2, -(n3 - n4)) / (2.0 * e);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec2 p = (2.0 * fragCoord - iResolution.xy) / iResolution.y;
  float t = iTime * (0.15 + speed * 0.4);
  float sw = 0.4 + max(0.0, swirl);

  // --- the swirling sky FLOW: integrate a short streamline through the curl
  //     field so the colour is dragged into big rotating Starry-Night vortices.
  vec2 flow = p;
  vec2 v = vec2(0.0);
  for (int i = 0; i < 8; i++) {
    v = curl(flow * 0.9, t * 0.5) * sw;
    flow += v * 0.08;
  }
  // domain-warped noise sampled at the swept position → the churning sky body.
  float churn = fbm(flow * 1.6 + vec2(0.0, t * 0.3));
  vec2 dir = normalize(v + vec2(1e-4));      // local brush direction (= the flow)

  // --- Van Gogh palette: deep ultramarine night warmed toward cobalt/teal ---
  vec3 deep = mix(vec3(0.03, 0.06, 0.22), vec3(0.04, 0.10, 0.20), warmth); // shadow blue
  vec3 cobalt = mix(vec3(0.10, 0.24, 0.55), vec3(0.10, 0.32, 0.52), warmth); // mid sky
  vec3 teal = mix(vec3(0.15, 0.42, 0.55), vec3(0.20, 0.50, 0.48), warmth);   // swirl crest
  vec3 sky = mix(deep, cobalt, smoothstep(0.2, 0.7, churn));
  sky = mix(sky, teal, smoothstep(0.6, 0.95, churn));

  // --- thick DIRECTIONAL brush strokes that follow the flow (impasto ridges) ---
  // sample a high-freq noise ALONG the brush direction → ridged stroke texture.
  vec2 along = dir * 7.0;
  vec2 across = vec2(-dir.y, dir.x) * 14.0;
  float stroke = fbm(p.x * across + p.y * across + flow * 3.0 + dir * t);
  // alternative simpler stroke field keyed to the across-direction phase:
  float ridge = sin(dot(p, across) * 0.9 + churn * 6.0 + dot(p, along) * 0.3);
  ridge = abs(ridge);
  float impasto = mix(stroke, ridge, 0.5);
  // crests of the brush field = bright cream paint catching the light.
  float crest = smoothstep(0.55, 0.85, impasto);
  sky += vec3(0.9, 0.85, 0.55) * crest * (0.12 + 0.18 * sw);
  // troughs = darker paint between ridges (gives the thick texture).
  sky *= mix(0.78, 1.08, impasto);

  // --- luminous yellow STARS sitting in haloed swirl rings ---
  vec3 col = sky;
  vec3 starWarm = vec3(1.0, 0.88, 0.45);
  for (int s = 0; s < 6; s++) {
    float fs = float(s);
    // star centres drift slowly with the sky; spread across the frame.
    vec2 sc = vec2(
      0.9 * sin(fs * 2.3 + 1.0) ,
      0.55 * cos(fs * 1.7 + 0.5) + 0.15
    );
    sc += 0.05 * vec2(sin(t * 0.5 + fs), cos(t * 0.4 + fs));
    float sd = length(p - sc);
    // concentric impasto halo rings around each star (Starry-Night glow).
    float ring = 0.5 + 0.5 * sin(sd * 26.0 - t * 2.0);
    float glow = exp(-sd * 3.5);
    float core = smoothstep(0.05, 0.0, sd);
    col += starWarm * (core * 1.2 + glow * (0.35 + 0.35 * ring));
  }

  // --- glowing crescent MOON upper-right (big haloed yellow disc) ---
  vec2 mc = vec2(0.95, 0.62);
  float md = length(p - mc);
  // crescent = disc minus an offset disc.
  float disc = smoothstep(0.20, 0.17, md);
  float bite = smoothstep(0.18, 0.15, length(p - (mc + vec2(0.07, 0.04))));
  float crescent = clamp(disc - bite, 0.0, 1.0);
  float moonHalo = exp(-md * 2.2);
  col += vec3(1.0, 0.92, 0.6) * (crescent * 1.4 + moonHalo * (0.5 + 0.3 * sin(md * 30.0 - t)));

  // --- finish: gentle vignette + tone map + gamma ---
  col *= mix(0.65, 1.05, smoothstep(1.6, 0.1, length(p)));
  col = col / (col + 0.75);                 // soft tone map (keeps paint glow)
  col = pow(clamp(col, 0.0, 1.0), vec3(0.92));
  fragColor = vec4(col, 1.0);
}
