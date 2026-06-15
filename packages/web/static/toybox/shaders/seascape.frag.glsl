// TOYBOX GEN — seascape (rolling-water ocean, SHADERTOY single-pass)
//
// An animated raymarched OCEAN: a heightfield sea (summed gerstner-ish octaves)
// is sphere-traced under a sky, with fresnel reflection, a sun specular and
// distance fog. The look is the classic "Seascape" rolling-water demo.
//
// === LICENSE / PROVENANCE — READ ===
// The canonical Shadertoy "Seascape" by TDM (Alexander Alekseev, 2014,
// https://www.shadertoy.com/view/Ms2SD1) is licensed CC BY-NC-SA 3.0 — a
// NON-COMMERCIAL licence. patchtogether.live ships only permissively-licensed
// content (CC0 / builtin / clean-room MIT), so this file is NOT a paste of the
// TDM source: it is an ORIGINAL, clean-room ocean authored for TOYBOX using only
// standard, widely-documented techniques (value-noise heightfield, fixed-step
// height tracer, Schlick fresnel, sun specular, distance fog). No third-party /
// CC-BY-NC-SA source text was copied. Inspired-by attribution to TDM's Seascape;
// technique references: iquilezles.org distance-functions + raymarching articles.
//
// Manifest: shadertoy:true, input:none (GEN — generative, no scene input).
// Params: speed (wave animation rate), choppy (wave sharpness), height (swell).

// ---- value noise (this project's own constants) ----
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

// Sea heightfield: a few octaves of directional value-noise, sharpened by
// `choppy` to mimic cresting swells. Returns a signed height around 0.
float seaHeight(vec2 p, float t, float choppy) {
  float amp = 0.6;
  float freq = 0.4;
  float h = 0.0;
  vec2 dir = vec2(0.8, 0.4);
  for (int i = 0; i < 4; i++) {
    float n = vnoise(p * freq + dir * t);
    // sharpen toward crests
    n = pow(abs(n), mix(1.0, 0.5, clamp(choppy, 0.0, 1.0)));
    h += (n - 0.5) * amp;
    p = mat2(1.6, 1.2, -1.2, 1.6) * p; // rotate+scale each octave
    amp *= 0.5;
    freq *= 1.9;
    t *= 1.1;
  }
  return h;
}

vec3 skyColor(vec3 rd) {
  float up = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 horizon = vec3(0.72, 0.82, 0.92);
  vec3 zenith = vec3(0.18, 0.36, 0.62);
  return mix(horizon, zenith, up);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 p = (2.0 * fragCoord - iResolution.xy) / iResolution.y;
  float t = iTime * (0.4 + speed) ;

  // camera looking down toward the sea
  vec3 ro = vec3(0.0, 2.2, t * 0.6);
  vec3 ta = ro + vec3(0.0, -0.55, 1.0);
  vec3 cw = normalize(ta - ro);
  vec3 cu = normalize(cross(cw, vec3(0.0, 1.0, 0.0)));
  vec3 cv = cross(cu, cw);
  vec3 rd = normalize(p.x * cu + p.y * cv + 1.6 * cw);

  vec3 sky = skyColor(rd);
  vec3 col = sky;

  // sun
  vec3 sunDir = normalize(vec3(0.3, 0.18, 0.9));
  float sun = pow(clamp(dot(rd, sunDir), 0.0, 1.0), 280.0);
  col += vec3(1.0, 0.85, 0.6) * sun;

  // fixed-step height-field trace (only below the horizon)
  if (rd.y < -0.01) {
    float swell = 0.6 + height;
    float tt = 0.0;
    float hit = -1.0;
    vec3 pos = ro;
    for (int i = 0; i < 90; i++) {
      pos = ro + rd * tt;
      float h = seaHeight(pos.xz, t, choppy) * swell;
      if (pos.y < h) { hit = tt; break; }
      tt += max(0.05, (pos.y - h) * 0.5);
      if (tt > 60.0) break;
    }
    if (hit > 0.0) {
      // normal from finite differences of the heightfield
      float e = 0.15;
      float swl = swell;
      float h0 = seaHeight(pos.xz, t, choppy) * swl;
      float hx = seaHeight(pos.xz + vec2(e, 0.0), t, choppy) * swl;
      float hz = seaHeight(pos.xz + vec2(0.0, e), t, choppy) * swl;
      vec3 n = normalize(vec3(h0 - hx, e, h0 - hz));

      vec3 refl = reflect(rd, n);
      vec3 reflCol = skyColor(refl);
      float fres = pow(clamp(1.0 + dot(rd, n), 0.0, 1.0), 5.0);
      fres = mix(0.05, 1.0, fres);

      vec3 deep = vec3(0.0, 0.09, 0.18);
      vec3 shallow = vec3(0.10, 0.42, 0.55);
      float crest = clamp(h0 * 1.5 + 0.5, 0.0, 1.0);
      vec3 water = mix(deep, shallow, crest);

      // sun specular off the waves
      float spec = pow(clamp(dot(refl, sunDir), 0.0, 1.0), 60.0);
      vec3 surf = mix(water, reflCol, fres) + vec3(1.0, 0.9, 0.7) * spec;

      // distance fog into the sky
      float fog = 1.0 - exp(-hit * 0.018);
      col = mix(surf, sky, clamp(fog, 0.0, 1.0));
    }
  }

  // tonemap + gamma
  col = col / (col + 0.7);
  col = pow(clamp(col, 0.0, 1.0), vec3(0.85));
  fragColor = vec4(col, 1.0);
}
