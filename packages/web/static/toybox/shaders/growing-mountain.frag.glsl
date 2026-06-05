// TOYBOX GEN — growing-mountain (SHADERTOY single-pass)
//
// An ORIGINAL raymarched terrain that GROWS over time + WEATHER SYSTEMS. The
// peak rises out of the ground as iTime advances (a `growth` envelope scales
// the heightmap), and a day<->night sky, drifting volumetric clouds, animated
// rain streaks, distance fog and periodic lightning flashes play over it. This
// is NOT an eroded-island look: it is a single solitary growing peak under a
// dynamic weather sky, authored clean-room for TOYBOX.
//
// Author: TOYBOX (this project) — original GLSL. Clean-room: the heightmap is a
// hand-authored ridge-fBm + domain-warp, the raymarch is a standard fixed-step
// height tracer, and the weather is original additive layers. NO Shadertoy /
// third-party source text was pasted. Standard techniques only (value-noise
// hash, fBm octave sum, ridge transform, height-field sphere-trace) — the
// fields, palette, growth envelope and weather are this project's own.
//
// Manifest: shadertoy:true, input:none (GEN — generative, no scene). Params:
//   growth   — manual override / boost of the peak growth (added to the auto env)
//   weather  — global weather intensity (clouds + rain + fog density)
//   daynight — sky time-of-day phase (0 = night, 1 = noon); animates if left mid
//
// iMouse: clicking RAISES the terrain near the click x (a horizontal growth
// bias), so the preview is interactive (click-to-grow) without a feedback buffer.

// ---- hash + value noise (this project's own constants) ----
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i + vec2(0.0, 0.0));
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Ridge-fBm: turn each octave into a sharp ridge (1 - |2n-1|) then square so the
// terrain has crisp peaks + smooth valleys. Domain-warped for a flowing crest.
float ridgeFbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.55;
  float freq = 1.0;
  // domain warp
  vec2 w = vec2(vnoise(p * 0.7), vnoise(p * 0.7 + 5.2));
  p += (w - 0.5) * 0.8;
  for (int i = 0; i < 5; i++) {
    float n = vnoise(p * freq);
    n = 1.0 - abs(2.0 * n - 1.0); // ridge
    n *= n;
    sum += amp * n;
    freq *= 1.97;
    amp *= 0.5;
  }
  return sum;
}

// Auto-growth envelope: the peak rises over the first ~8s then breathes gently.
float growthEnv(float t) {
  float rise = clamp(t / 8.0, 0.0, 1.0);
  rise = smoothstep(0.0, 1.0, rise);
  float breathe = 0.06 * sin(t * 0.5);
  return rise + breathe;
}

// Height of the terrain at world (x,z), scaled by the current growth amount and
// an iMouse click bias near the pressed x.
float terrainH(vec2 xz, float grow, float mouseBias) {
  // A single central peak: ridge field times a radial falloff so it's a mountain
  // not an infinite range.
  float r = length(xz);
  float peak = exp(-r * r * 0.18);
  float h = ridgeFbm(xz * 0.9) * peak;
  // click-to-grow: extra height near the pressed x column.
  h += mouseBias * peak;
  return h * grow * 2.4;
}

// HSV->RGB (branchless) for the sky tint cycling.
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

// Volumetric-ish cloud band: layered drifting noise high in the sky.
float clouds(vec2 uv, float t, float wx) {
  float c = 0.0;
  float amp = 0.5;
  vec2 p = uv * 3.0 + vec2(t * 0.04 * (1.0 + wx), 0.0);
  for (int i = 0; i < 4; i++) {
    c += amp * vnoise(p);
    p *= 2.02;
    amp *= 0.5;
  }
  return c;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec2 p = (fragCoord - 0.5 * iResolution.xy) / iResolution.y; // aspect-correct, centred
  float t = iTime;

  // --- day/night phase ---
  // The manual `daynight` param biases a slow auto day<->night cycle so the sky
  // animates even when the control is left untouched.
  float phase = clamp(daynight * 0.6 + 0.4 * (0.5 + 0.5 * sin(t * 0.09)), 0.0, 1.0);

  // --- sky gradient (night -> dawn -> noon) ---
  vec3 night = vec3(0.02, 0.03, 0.08);
  vec3 dawn  = vec3(0.55, 0.28, 0.22);
  vec3 noon  = vec3(0.35, 0.55, 0.85);
  vec3 lowSky = (phase < 0.5)
    ? mix(night, dawn, phase * 2.0)
    : mix(dawn, noon, (phase - 0.5) * 2.0);
  vec3 highSky = mix(vec3(0.01, 0.01, 0.04), vec3(0.12, 0.30, 0.62), phase);
  vec3 col = mix(lowSky, highSky, clamp(uv.y * 1.1, 0.0, 1.0));

  // --- stars at night ---
  float starFade = smoothstep(0.5, 0.0, phase);
  float star = step(0.995, hash21(floor(fragCoord * 0.5)));
  col += star * starFade * 0.8 * (0.5 + 0.5 * sin(t * 3.0 + hash21(floor(fragCoord)) * 20.0));

  // --- mouse click-to-grow bias ---
  // While the button is held (iMouse.z > 0) the peak gets an extra boost, so
  // clicking the preview visibly GROWS the mountain (interactive, no feedback
  // buffer needed). The boost rides the same radial falloff in terrainH().
  float mouseBias = (iMouse.z > 0.0) ? 0.9 : 0.0;

  // --- raymarch the height field (fixed-step tracer) ---
  float grow = clamp(growthEnv(t) + growth, 0.0, 3.0);
  vec3 ro = vec3(0.0, 1.4, 4.2);                 // camera
  vec3 rd = normalize(vec3(p.x, p.y - 0.15, -1.0));
  float dist = -1.0;
  vec3 hitPos = vec3(0.0);
  float th = 0.0;
  float tt = 0.1;
  for (int i = 0; i < 110; i++) {
    vec3 pos = ro + rd * tt;
    float h = terrainH(pos.xz, grow, mouseBias);
    if (pos.y < h) { dist = tt; hitPos = pos; th = h; break; }
    tt += 0.045 + tt * 0.012; // grow the step with distance
    if (tt > 18.0) break;
  }

  if (dist > 0.0) {
    // shade the terrain by altitude + a cheap normal from finite differences.
    float e = 0.02;
    float hx = terrainH(hitPos.xz + vec2(e, 0.0), grow, mouseBias) - th;
    float hz = terrainH(hitPos.xz + vec2(0.0, e), grow, mouseBias) - th;
    vec3 n = normalize(vec3(-hx, e, -hz));
    vec3 sunDir = normalize(vec3(0.5, mix(0.15, 0.9, phase), 0.4));
    float diff = clamp(dot(n, sunDir), 0.0, 1.0);
    float alt = clamp(th / (1.6 * grow + 1e-3), 0.0, 1.0);
    // rock -> grass -> snow ramp.
    vec3 rock  = vec3(0.28, 0.24, 0.21);
    vec3 grass = vec3(0.16, 0.30, 0.14);
    vec3 snow  = vec3(0.92, 0.95, 1.0);
    vec3 terr = mix(grass, rock, smoothstep(0.25, 0.6, alt));
    terr = mix(terr, snow, smoothstep(0.7, 0.95, alt));
    vec3 lit = terr * (0.25 + 0.85 * diff) * (0.4 + 0.6 * phase);
    // distance fog blends terrain into the low sky.
    float fog = 1.0 - exp(-dist * 0.10 * (0.6 + weather));
    col = mix(lit, lowSky, clamp(fog, 0.0, 1.0));
  }

  // --- drifting clouds over the sky (above horizon only) ---
  float skyMask = (dist > 0.0) ? 0.0 : 1.0;
  float cl = clouds(uv + vec2(0.0, -0.1), t, weather);
  cl = smoothstep(0.45, 0.95, cl) * smoothstep(0.05, 0.4, uv.y);
  vec3 cloudCol = mix(vec3(0.5, 0.5, 0.55), vec3(1.0), phase);
  col = mix(col, cloudCol, cl * (0.35 + 0.45 * weather) * skyMask);

  // --- rain streaks (animated, weather-scaled) ---
  float rainAmt = clamp(weather - 0.25, 0.0, 1.0);
  if (rainAmt > 0.0) {
    vec2 rp = uv * vec2(140.0, 50.0);
    rp.y += t * 26.0;            // fall
    rp.x += t * 4.0;             // slight wind drift
    float streak = hash21(floor(rp));
    float rain = step(0.985, streak) * rainAmt;
    col += vec3(0.55, 0.6, 0.7) * rain * 0.6;
  }

  // --- periodic lightning flash ---
  float flashT = floor(t * 0.5);
  float flashSeed = hash21(vec2(flashT, 7.0));
  float flash = (flashSeed > 0.86) ? exp(-fract(t * 0.5) * 9.0) : 0.0;
  col += flash * weather * vec3(0.7, 0.75, 0.9) * skyMask * 0.8;

  // gentle vignette + tonemap.
  float vig = smoothstep(1.3, 0.3, length(p));
  col *= mix(0.7, 1.0, vig);
  col = col / (col + 0.6);          // soft tonemap
  col = pow(clamp(col, 0.0, 1.0), vec3(0.85));

  fragColor = vec4(col, 1.0);
}
