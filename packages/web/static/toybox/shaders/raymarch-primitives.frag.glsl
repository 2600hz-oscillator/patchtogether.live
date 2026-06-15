// TOYBOX GEN — raymarch-primitives (SDF primitives gallery, SHADERTOY single-pass)
//
// A raymarched gallery of signed-distance PRIMITIVES (sphere, rounded box,
// torus, capsule, cone) arranged on a checkerboard floor, orbited by the camera,
// with soft shadows, ambient occlusion and a sky-fog backdrop — the classic
// "Raymarching - Primitives" teaching scene.
//
// === LICENSE / PROVENANCE — READ ===
// The canonical Shadertoy "Raymarching - Primitives" by Inigo Quilez (Xds3zN) is
// licensed CC BY-NC-SA 3.0 (NON-COMMERCIAL) on Shadertoy — NOT MIT (a user
// comment claims MIT but the page licence is CC-BY-NC-SA). patchtogether.live
// ships only permissive content, so this is an ORIGINAL, clean-room scene that
// uses only the standard, individually-public SDF primitive formulas + the
// standard sphere-tracing / soft-shadow / AO loop, all documented at
// iquilezles.org/articles/distfunctions and /articles/raymarchingdf (techniques,
// not copyrightable code). No third-party source text was copied.
//
// HW_PERFORMANCE: defined below so a pasted shader expecting it compiles. AA is
// fixed to 1 (no per-pixel supersample) — heavy AA loops blow CI's SwiftShader
// software-renderer WebGL timeouts (ci-swiftshader discipline).
//
// Manifest: shadertoy:true, input:none (GEN). Params:
//   spin  — camera orbit speed
//   zoom  — camera distance (smaller = closer)
//   light — key-light intensity

#ifndef HW_PERFORMANCE
#define HW_PERFORMANCE 0
#endif
// AA must stay 1 on the software renderer (CI). Do NOT raise without re-checking
// the e2e WebGL timeout budget.
#define AA 1

// ---- SDF primitives (standard public formulas) ----
float sdSphere(vec3 p, float r) { return length(p) - r; }
float sdRoundBox(vec3 p, vec3 b, float r) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}
float sdTorus(vec3 p, vec2 t) {
  vec2 q = vec2(length(p.xz) - t.x, p.y);
  return length(q) - t.y;
}
float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}
float sdCone(vec3 p, vec2 c, float h) {
  // c = normalized (sin,cos) of the cone angle, h = height
  float q = length(p.xz);
  return max(dot(c, vec2(q, p.y)), -h - p.y);
}

// Scene map → (distance, materialId).
vec2 opU(vec2 a, vec2 b) { return (a.x < b.x) ? a : b; }

vec2 map(vec3 p) {
  // checker floor (y = 0)
  vec2 res = vec2(p.y, 1.0);
  res = opU(res, vec2(sdSphere(p - vec3(-1.6, 0.5, 0.0), 0.5), 2.0));
  res = opU(res, vec2(sdRoundBox(p - vec3(-0.5, 0.45, 0.0), vec3(0.4), 0.08), 3.0));
  res = opU(res, vec2(sdTorus(p - vec3(0.6, 0.45, 0.0), vec2(0.4, 0.16)), 4.0));
  res = opU(res, vec2(sdCapsule(p, vec3(1.6, 0.15, 0.0), vec3(1.6, 0.85, 0.0), 0.22), 5.0));
  res = opU(res, vec2(sdCone(p - vec3(2.7, 0.9, 0.0), vec2(0.6, 0.8), 0.45), 6.0));
  return res;
}

vec2 castRay(vec3 ro, vec3 rd) {
  float t = 0.5, m = -1.0;
  for (int i = 0; i < 80; i++) {
    vec3 pos = ro + rd * t;
    vec2 h = map(pos);
    if (h.x < 0.001 || t > 22.0) break;
    t += h.x;
    m = h.y;
  }
  if (t > 22.0) m = -1.0;
  return vec2(t, m);
}

vec3 calcNormal(vec3 p) {
  vec2 e = vec2(0.001, 0.0);
  return normalize(vec3(
    map(p + e.xyy).x - map(p - e.xyy).x,
    map(p + e.yxy).x - map(p - e.yxy).x,
    map(p + e.yyx).x - map(p - e.yyx).x));
}

float softShadow(vec3 ro, vec3 rd, float mint, float tmax) {
  float res = 1.0, t = mint;
  for (int i = 0; i < 24; i++) {
    float h = map(ro + rd * t).x;
    res = min(res, 8.0 * h / t);
    t += clamp(h, 0.02, 0.20);
    if (h < 0.001 || t > tmax) break;
  }
  return clamp(res, 0.0, 1.0);
}

float calcAO(vec3 p, vec3 n) {
  float occ = 0.0, sca = 1.0;
  for (int i = 0; i < 5; i++) {
    float hr = 0.01 + 0.12 * float(i) / 4.0;
    float dd = map(p + n * hr).x;
    occ += -(dd - hr) * sca;
    sca *= 0.95;
  }
  return clamp(1.0 - 3.0 * occ, 0.0, 1.0);
}

vec3 matColor(float m, vec3 pos) {
  if (m < 1.5) {
    // checker floor
    float f = mod(floor(2.0 * pos.x) + floor(2.0 * pos.z), 2.0);
    return vec3(0.2 + 0.12 * f);
  }
  // primitives get distinct hues
  return 0.45 + 0.35 * cos(vec3(0.0, 1.0, 2.0) + m * 1.1);
}

vec3 render(vec3 ro, vec3 rd) {
  vec3 sky = mix(vec3(0.7, 0.85, 1.0), vec3(0.35, 0.5, 0.8), clamp(rd.y, 0.0, 1.0));
  vec2 res = castRay(ro, rd);
  float t = res.x, m = res.y;
  if (m < -0.5) return sky;

  vec3 pos = ro + rd * t;
  vec3 nor = calcNormal(pos);
  vec3 col = matColor(m, pos);

  vec3 lig = normalize(vec3(0.6, 0.8, 0.4));
  float dif = clamp(dot(nor, lig), 0.0, 1.0) * softShadow(pos, lig, 0.02, 6.0);
  float amb = 0.4 + 0.6 * clamp(0.5 + 0.5 * nor.y, 0.0, 1.0);
  float occ = calcAO(pos, nor);
  vec3 ref = reflect(rd, nor);
  float spe = pow(clamp(dot(ref, lig), 0.0, 1.0), 24.0);

  float key = 0.5 + light;
  vec3 lit = col * (amb * occ * vec3(0.45, 0.55, 0.7) + key * dif * vec3(1.0, 0.95, 0.8));
  lit += spe * dif * vec3(1.0) * 0.7;

  // distance fog into sky
  lit = mix(lit, sky, 1.0 - exp(-0.0012 * t * t));
  return lit;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec3 tot = vec3(0.0);
  float ang = iTime * (0.2 + spin);
  float dist = clamp(6.0 - zoom, 2.5, 8.0);
  vec3 ta = vec3(0.4, 0.5, 0.0);
  vec3 ro = ta + vec3(dist * cos(ang), 1.6, dist * sin(ang));
  vec3 cw = normalize(ta - ro);
  vec3 cu = normalize(cross(cw, vec3(0.0, 1.0, 0.0)));
  vec3 cv = cross(cu, cw);

  // AA==1 → single sample (cheap on SwiftShader). The loop is kept so raising
  // AA on a real GPU supersamples without code change.
  for (int j = 0; j < AA; j++)
  for (int i = 0; i < AA; i++) {
    vec2 o = (AA > 1) ? (vec2(float(i), float(j)) / float(AA) - 0.5) : vec2(0.0);
    vec2 p = (2.0 * (fragCoord + o) - iResolution.xy) / iResolution.y;
    vec3 rd = normalize(p.x * cu + p.y * cv + 2.2 * cw);
    tot += render(ro, rd);
  }
  tot /= float(AA * AA);
  tot = pow(clamp(tot, 0.0, 1.0), vec3(0.4545));
  fragColor = vec4(tot, 1.0);
}
