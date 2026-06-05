// TOYBOX multi-buffer IMAGE — peak-grow raymarched terrain + weather
//
// Reads the growable heightmap (Buffer A, iChannel0) and raymarches it into a
// weather sky: day<->night gradient, drifting clouds, distance fog and rain.
// As Buffer A grows the rendered peak rises; clicking the preview grows it
// faster (the click bump propagates through Buffer A into this raymarch).
//
// Authored clean-room for TOYBOX — original height-field tracer + weather; no
// third-party source text. Standard fixed-step height tracing only.

// Sample the buffer height at world (x,z). World maps to buffer uv 0..1 across a
// fixed footprint centred at the origin.
float heightAt(vec2 xz) {
  vec2 q = xz * 0.12 + 0.5; // world -> buffer uv
  if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) return 0.0;
  return texture(iChannel0, q).r * 2.2;
}

float cloudBand(vec2 uv, float t) {
  float c = 0.0, amp = 0.5;
  vec2 p = uv * 3.0 + vec2(t * 0.05, 0.0);
  for (int i = 0; i < 4; i++) { c += amp * vnoise(p); p *= 2.03; amp *= 0.5; }
  return c;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec2 p = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
  float t = iTime;

  // animated day/night phase.
  float phase = clamp(0.5 + 0.45 * sin(t * 0.1), 0.0, 1.0);

  vec3 night = vec3(0.02, 0.03, 0.09);
  vec3 noon  = vec3(0.35, 0.55, 0.85);
  vec3 lowSky  = mix(night, vec3(0.55, 0.3, 0.25), smoothstep(0.0, 0.5, phase));
  lowSky = mix(lowSky, noon, smoothstep(0.5, 1.0, phase));
  vec3 highSky = mix(vec3(0.01, 0.01, 0.05), vec3(0.10, 0.28, 0.6), phase);
  vec3 col = mix(lowSky, highSky, clamp(uv.y * 1.1, 0.0, 1.0));

  // stars at night.
  float star = step(0.996, hash21(floor(fragCoord * 0.5))) * smoothstep(0.5, 0.0, phase);
  col += star * 0.7;

  // raymarch the height field.
  vec3 ro = vec3(0.0, 1.6, 4.4);
  vec3 rd = normalize(vec3(p.x, p.y - 0.12, -1.0));
  float hit = -1.0;
  vec3 hp = vec3(0.0);
  float hh = 0.0;
  float tt = 0.1;
  for (int i = 0; i < 96; i++) {
    vec3 pos = ro + rd * tt;
    float h = heightAt(pos.xz);
    if (pos.y < h) { hit = tt; hp = pos; hh = h; break; }
    tt += 0.05 + tt * 0.012;
    if (tt > 16.0) break;
  }

  if (hit > 0.0) {
    float e = 0.05;
    float hx = heightAt(hp.xz + vec2(e, 0.0)) - hh;
    float hz = heightAt(hp.xz + vec2(0.0, e)) - hh;
    vec3 n = normalize(vec3(-hx, e, -hz));
    vec3 sunDir = normalize(vec3(0.5, mix(0.2, 0.9, phase), 0.4));
    float diff = clamp(dot(n, sunDir), 0.0, 1.0);
    float alt = clamp(hh / 2.0, 0.0, 1.0);
    vec3 rock = vec3(0.28, 0.24, 0.22), grass = vec3(0.15, 0.30, 0.14), snow = vec3(0.93, 0.96, 1.0);
    vec3 terr = mix(grass, rock, smoothstep(0.25, 0.6, alt));
    terr = mix(terr, snow, smoothstep(0.7, 0.92, alt));
    vec3 lit = terr * (0.25 + 0.85 * diff) * (0.4 + 0.6 * phase);
    float fog = 1.0 - exp(-hit * 0.12);
    col = mix(lit, lowSky, clamp(fog, 0.0, 1.0));
  }

  // clouds over the sky.
  float skyMask = (hit > 0.0) ? 0.0 : 1.0;
  float cl = cloudBand(uv + vec2(0.0, -0.1), t);
  cl = smoothstep(0.5, 0.95, cl) * smoothstep(0.05, 0.4, uv.y);
  col = mix(col, mix(vec3(0.5), vec3(1.0), phase), cl * 0.5 * skyMask);

  // rain.
  vec2 rp = uv * vec2(130.0, 48.0); rp.y += t * 24.0; rp.x += t * 3.0;
  float rain = step(0.987, hash21(floor(rp)));
  col += vec3(0.55, 0.6, 0.7) * rain * 0.4;

  // vignette + tonemap.
  col *= mix(0.72, 1.0, smoothstep(1.3, 0.3, length(p)));
  col = col / (col + 0.6);
  col = pow(clamp(col, 0.0, 1.0), vec3(0.85));

  fragColor = vec4(col, 1.0);
}
