// TOYBOX GEN — doom-spectrum (audio-reactive hell spectrum, SHADERTOY single-pass)
//
// A 90s-FPS audio visualiser: a row of spectrum BARS rising out of a hellish
// fire pit. Six band levels (band1..band6, low→high) drive the bar heights and
// are meant to be patched from AUDIO via the TOYBOX cv ports (the engine
// envelope-follows an audio cable into each cv input), so the bars PUMP with the
// music. The backdrop is an animated flame field (upward-scrolling value-noise
// fire) under a blood-red sky; the bar tips glow white-hot. Generative, no scene
// input.
//
// Inspired by the SPECTRUM-mode visual of the local `doom_viz` JUCE plugin
// (an audio-spectrum analyser with a DOOM aesthetic). doom_viz ships no source /
// shaders / sprites that were copied — this is an original clean-room take on the
// "audio spectrum under a hellish palette" idea. NO copyrighted DOOM content.
//
// === LICENSE / PROVENANCE ===
// MIT — Original clean-room TOYBOX shader. Standard value-noise fire + bar-graph
// construction. No third-party / Shadertoy source text copied; no game assets.
//
// Manifest: shadertoy:true, input:none (GEN). Params (all 0..1, audio-driven):
//   band1..band6 — spectrum band levels, low→high, mapped across the bar row.

// value-noise hash + bilinear lookup (cheap fire field).
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Smoothly interpolate the six band levels across x in 0..1.
float bandAt(float x) {
  float s = clamp(x, 0.0, 1.0) * 5.0; // 0..5 across the 6 bands
  float w1 = max(0.0, 1.0 - abs(s - 0.0));
  float w2 = max(0.0, 1.0 - abs(s - 1.0));
  float w3 = max(0.0, 1.0 - abs(s - 2.0));
  float w4 = max(0.0, 1.0 - abs(s - 3.0));
  float w5 = max(0.0, 1.0 - abs(s - 4.0));
  float w6 = max(0.0, 1.0 - abs(s - 5.0));
  float ws = w1 + w2 + w3 + w4 + w5 + w6 + 1e-4;
  return (band1 * w1 + band2 * w2 + band3 * w3 + band4 * w4 + band5 * w5 + band6 * w6) / ws;
}

// hell heat ramp: dark maroon → red → orange → yellow → white.
vec3 heat(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c = vec3(0.10, 0.0, 0.0);
  c = mix(c, vec3(0.65, 0.05, 0.0), smoothstep(0.0, 0.4, t));
  c = mix(c, vec3(1.0, 0.45, 0.0), smoothstep(0.35, 0.7, t));
  c = mix(c, vec3(1.0, 0.95, 0.55), smoothstep(0.7, 0.95, t));
  c = mix(c, vec3(1.0), smoothstep(0.92, 1.0, t));
  return c;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy; // 0..1, y up
  float t = iTime;

  // --- hellish backdrop: blood sky + rising flames ---
  vec3 sky = mix(vec3(0.18, 0.02, 0.02), vec3(0.02, 0.0, 0.0), uv.y);
  float fire = vnoise(vec2(uv.x * 6.0, uv.y * 4.0 - t * 1.6));
  fire += 0.5 * vnoise(vec2(uv.x * 12.0 + 3.0, uv.y * 8.0 - t * 2.7));
  fire /= 1.5;
  // flames hug the bottom and lick upward.
  float flameMask = pow(1.0 - uv.y, 2.2) * smoothstep(0.15, 0.7, fire);
  vec3 col = sky + heat(flameMask * 1.4) * flameMask * 1.3;

  // --- spectrum bars ---
  const float NBARS = 24.0;
  float floorY = 0.12;          // bars stand on this hell-floor
  float bx = uv.x * NBARS;
  float cell = fract(bx);
  float barCenter = (floor(bx) + 0.5) / NBARS;
  float gap = smoothstep(0.06, 0.12, cell) * smoothstep(0.06, 0.12, 1.0 - cell);
  float lvl = bandAt(barCenter);
  // a little idle shimmer so the bars live even with no audio patched.
  lvl = clamp(lvl + 0.06 * vnoise(vec2(barCenter * 9.0, t * 1.3)), 0.0, 1.0);
  float top = floorY + lvl * 0.78;
  float inBar = step(floorY, uv.y) * step(uv.y, top) * gap;
  float h = clamp((uv.y - floorY) / max(top - floorY, 1e-3), 0.0, 1.0);
  vec3 barCol = heat(0.25 + 0.75 * h);
  // hot cap glow at the very tip of each bar.
  float cap = smoothstep(top - 0.02, top, uv.y) * step(uv.y, top + 0.005);
  col = mix(col, barCol, inBar);
  col += vec3(1.0, 0.9, 0.6) * cap * gap * 1.5;

  // glowing floor line.
  col += heat(0.7) * smoothstep(0.012, 0.0, abs(uv.y - floorY)) * 0.8;

  // vignette.
  vec2 d = uv - 0.5;
  col *= 1.0 - 0.6 * dot(d, d);

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
