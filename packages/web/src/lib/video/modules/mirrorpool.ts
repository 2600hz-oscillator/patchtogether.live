// packages/web/src/lib/video/modules/mirrorpool.ts
//
// MIRRORPOOL — a WebGL2 VIDEO source: a hemisphere pool of liquid inside a
// box, viewed by a full-PTZ camera moving within it. Looking INTO the pool,
// the underwater view (the `pool` input, surface-mapped to the inside of the
// hemisphere) is distorted by refraction + caustics; the SURFACE carries a
// reflection of the surroundings (the `scene` input, reflected as an overhead
// backdrop). Real physical fidelity, per the brief + adversarial reviews:
//
//   - A single interactive HEIGHT FIELD (wind-driven directional swell +
//     one-shot rain-impact impulses) drives ONE composite surface NORMAL,
//     reconstructed by finite differences — NOT a flat normal-map fake.
//     Bigger ripples are genuinely TALLER (swell amplitude ∝ wavelength,
//     dispersion ω=√(gk)), so they refract/reflect more.
//   - That normal drives a Schlick FRESNEL reflect/refract split. Refract
//     mode = reflected scene on top + refracted pool beneath; Mirror mode =
//     a near-full mirror of the sky/scene, broken by the ripple normals. The
//     two ends are one continuous `surface_mode` scalar (CV-friendly, no
//     branch).
//   - The rain wave sim runs as a float ping-pong wave-equation FBO when the
//     GPU exposes renderable float targets; on renderers that can't
//     (`isFloat===false`, e.g. some SwiftShader configs) it falls back to an
//     ANALYTIC expanding-ring model in the render shader, so rain is never a
//     dead 0.0 field. Determinism for VRT rides a seeded Poisson scheduler.
//
// The physics lives in a pure, jsdom-testable core (mirrorpool-core.ts); the
// GLSL below mirrors it. Reduced-res render (RENDER_SCALE 0.5) + deferred
// shader compile + the mandelbulb perf discipline keep it in the CI budget on
// the software renderer.
//
// I/O:
//   pool  (video)  — underwater view, mapped to the hemisphere interior.
//   scene (video)  — surroundings, reflected on the surface.
//   video_out (video) — the rendered scene from the PTZ camera.
//   + a CV input per control (wind/rain/brightness/surface_mode + camera PTZ +
//     bipolar Pos X/Y/Z that translate the eye ±2R in world space).
//
// NOTE (owner): this def lives in the WebGL attest basis by construction
// (resolveWebglBasis sweeps lib/video/). Its real shader/def flips
// computeWebglHash → a ONE-TIME re-attest on a trusted GPU is required; the
// co-located docs below are wrapped in docs-hash-ignore markers so DOC edits
// stay hash-transparent. Do NOT auto-merge (maximally look-affecting).

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import {
  WATER_ETA,
  WATER_F0,
  POOL_RADIUS,
  WORLD_SCALE,
  cameraBasis,
  spawnDrops,
  clampCfl,
} from '$lib/video/mirrorpool-core';

// Reduced render resolution (software-GL feasibility — the mandelbulb pattern).
const RENDER_SCALE = 0.5;
// Height-field sim resolution (aspect-independent — a fixed 256² grid).
const SIM_RES = 256;
// Wave-equation constants (CFL-clamped; velocity-form leapfrog).
const SIM_C2 = clampCfl(0.24);
const SIM_DAMP = 0.994;
// Rain ring history (fallback path) + one-shot impulse (sim path) caps.
const MAX_RINGS = 8;
const MAX_IMPACTS = 12;
const RING_LIFETIME_S = 2.4; // analytic rings older than this are dropped

// ── Sim pass: velocity-form wave equation, one-shot rain impulses ────────────
// State texel = (R = height, G = velocity). Rain impulses are added to the
// VELOCITY on their spawn frame ONLY (review fix #6), then the wave eq expands
// each dimple into a real propagating ring. NEAREST filtering (SwiftShader
// lacks float-linear + the Laplacian needs exact texels).
const SIM_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uState;
uniform vec2 uTexel;
uniform float uC2;
uniform float uDamp;
uniform vec3 uImpacts[${MAX_IMPACTS}];   // xy = uv centre, z = signed amplitude
uniform int uImpactCount;
void main() {
  vec2 dx = vec2(uTexel.x, 0.0);
  vec2 dy = vec2(0.0, uTexel.y);
  float h  = texture(uState, vUv).r;
  float v  = texture(uState, vUv).g;
  float hL = texture(uState, vUv - dx).r;
  float hR = texture(uState, vUv + dx).r;
  float hD = texture(uState, vUv - dy).r;
  float hU = texture(uState, vUv + dy).r;
  float lap = (hL + hR + hD + hU) - 4.0 * h;
  v += uC2 * lap;
  v *= uDamp;
  // one-shot rain impulses (this frame's drops only) — dynamic bound so at
  // Rain=0 (uImpactCount=0) the loop is zero cost (review R3).
  for (int i = 0; i < ${MAX_IMPACTS}; i++) {
    if (i >= uImpactCount) break;
    vec3 imp = uImpacts[i];
    vec2 dv = vUv - imp.xy;
    float d2 = dot(dv, dv);
    v += imp.z * exp(-d2 / (2.0 * 0.0009));
  }
  h += v;
  h = clamp(h, -0.5, 0.5);   // keep half-float precision sane
  outColor = vec4(h, v, 0.0, 1.0);
}`;

// ── Render pass: the optical stack (one camera ray per pixel) ────────────────
const RENDER_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform vec3  uEye, uForward, uRight, uUp;
uniform float uTanHalf, uAspect;
uniform sampler2D uPool, uScene, uState;
uniform float uHasPool, uHasScene, uHasSim, uAnalytic;
uniform vec2  uTexel;
uniform float uTime;
uniform float uWindDir, uWindSpeed;
uniform float uRain, uBrightness, uSurfaceMode;
uniform vec3  uSkyColor;
uniform vec4  uRings[${MAX_RINGS}];   // xy = centre (world), z = amp, w = spawnTime
uniform int   uRingCount;

const float R = ${POOL_RADIUS.toFixed(1)};
const float WORLD_SCALE = ${WORLD_SCALE.toFixed(1)};
const float PI = 3.14159265359;
const float ETA = ${WATER_ETA.toFixed(6)};
const float F0 = ${WATER_F0.toFixed(4)};
const float SWELL_G = 3.0;
const float SWELL_A0 = 0.012;

// Ambient sky gradient (horizon→zenith) from a ray direction. Brightness is
// applied ONCE at the very end (review fix #2), so this returns the raw tint.
vec3 skyTint(vec3 dir) {
  float up = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
  return mix(uSkyColor * 0.55, uSkyColor, up);
}

// Scene reflected as an OVERHEAD backdrop (planar-ish, not a lat-long smear —
// review fix #3): project the reflected ray up to the box-ceiling plane and
// sample 'scene' there, so a camera pan slides a RECOGNISABLE image and the
// ripple normal in reflect() breaks it believably. Sky tint when no scene.
vec3 sceneReflect(vec3 P, vec3 Rr) {
  if (uHasScene < 0.5) return skyTint(Rr);
  if (Rr.y > 1e-3) {
    float th = (2.2 - P.y) / Rr.y;         // backdrop plane at box ceiling
    vec3 B = P + Rr * th;
    vec2 uv = B.xz * 0.35 + 0.5;
    return texture(uScene, clamp(uv, 0.0, 1.0)).rgb;
  }
  return skyTint(Rr);
}

// Analytic directional swell — mirrors swellField() in the core. Returns world
// height + world gradient (∂h/∂x, ∂h/∂z), same sign convention as the sim.
void swell(vec2 pos, out float height, out vec2 grad) {
  height = 0.0; grad = vec2(0.0);
  float spd = clamp(uWindSpeed, 0.0, 1.0);
  if (spd <= 0.0) return;
  float lam[4] = float[4](2.0, 1.3, 0.8, 0.5);
  float spr[4] = float[4](0.0, 0.5, -0.35, 0.8);
  for (int i = 0; i < 4; i++) {
    float k = 6.2831853 / lam[i];
    float omega = sqrt(SWELL_G * k);
    float amp = SWELL_A0 * spd * lam[i];
    float ang = uWindDir + spr[i];
    vec2 d = vec2(cos(ang), sin(ang));
    float ph = k * dot(d, pos) - omega * uTime + float(i) * 1.7;
    height += amp * sin(ph);
    grad += amp * k * d * cos(ph);
  }
}

// Analytic expanding rain rings (fallback path only — uAnalytic gate). Each is
// a gaussian band whose radius grows with age, with an EXACT gradient.
void rings(vec2 pos, out float height, out vec2 grad) {
  height = 0.0; grad = vec2(0.0);
  if (uAnalytic < 0.5) return;
  for (int i = 0; i < ${MAX_RINGS}; i++) {
    if (i >= uRingCount) break;
    vec4 r = uRings[i];
    float age = uTime - r.w;
    if (age < 0.0) continue;
    vec2 dv = pos - r.xy;
    float dist = length(dv) + 1e-5;
    float radius = 1.2 * age;
    float w = 0.06;
    float d = dist - radius;
    float A = r.z * exp(-age * 2.2);
    float g = exp(-d * d / (2.0 * w * w));
    height += A * g;
    grad += (A * g * (-d / (w * w))) * (dv / dist);
  }
}

vec3 background(vec3 rd) { return skyTint(rd) * uBrightness; }

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rd = normalize(uForward + ndc.x * uAspect * uTanHalf * uRight + ndc.y * uTanHalf * uUp);
  vec3 ro = uEye;

  // horizon / degenerate-ray guard (review fix #10): abs(rd.y)~0 → NaN t.
  if (abs(rd.y) < 1e-5) { outColor = vec4(background(rd), 1.0); return; }
  float t = -ro.y / rd.y;
  if (t <= 0.0) { outColor = vec4(background(rd), 1.0); return; }
  vec3 S = ro + rd * t;
  if (length(S.xz) > R) { outColor = vec4(background(rd), 1.0); return; }

  // ── height + gradient at the surface point S (swell + sim OR rings) ──
  float hSwell; vec2 gSwell; swell(S.xz, hSwell, gSwell);
  float hRing;  vec2 gRing;  rings(S.xz, hRing, gRing);
  float dhdx = gSwell.x + gRing.x;
  float dhdz = gSwell.y + gRing.y;
  float lap = 0.0;
  if (uHasSim > 0.5) {
    vec2 uv = S.xz * 0.5 + 0.5;               // world → height-field uv
    vec2 dx = vec2(uTexel.x, 0.0), dy = vec2(0.0, uTexel.y);
    float hC = texture(uState, uv).r;
    float hL = texture(uState, uv - dx).r;
    float hR = texture(uState, uv + dx).r;
    float hD = texture(uState, uv - dy).r;
    float hU = texture(uState, uv + dy).r;
    // texel diff → WORLD slope (÷ 2·texel·WORLD_SCALE); same sign as swell.
    dhdx += (hR - hL) / (2.0 * uTexel.x * WORLD_SCALE);
    dhdz += (hU - hD) / (2.0 * uTexel.y * WORLD_SCALE);
    lap = (hL + hR + hD + hU) - 4.0 * hC;
  }

  // reconstructed normal (single sign convention — review fix #1).
  vec3 N = normalize(vec3(-dhdx, 1.0, -dhdz));
  vec3 V = -rd;
  float cth = clamp(dot(N, V), 0.0, 1.0);
  float F = F0 + (1.0 - F0) * pow(1.0 - cth, 5.0);   // Schlick

  // ── reflection (scene overhead backdrop / sky) ──
  vec3 Rr = reflect(rd, N);
  vec3 reflCol = sceneReflect(S, Rr);

  // ── refraction into the hemisphere bowl → sample 'pool' ──
  vec3 Tr = refract(rd, N, ETA);
  vec3 poolCol;
  if (dot(Tr, Tr) < 1e-4) {
    poolCol = reflCol;                          // numerical guard
  } else {
    float b = dot(S, Tr);
    float cc = dot(S, S) - 1.0;
    float th = -b + sqrt(max(b * b - cc, 0.0)); // exit at inner bowl wall
    vec3 B = S + Tr * th;                        // hemisphere interior, B.y<=0
    vec2 uvPool = vec2(atan(B.z, B.x) / (2.0 * PI) + 0.5, B.y + 1.0);
    float depth = clamp(-B.y, 0.0, 1.0);        // 0 rim → 1 pole
    vec2 dsp = N.xz * 0.02 * depth;             // chromatic dispersion
    vec3 base = (uHasPool > 0.5)
      ? vec3(texture(uPool, uvPool + dsp).r, texture(uPool, uvPool).g, texture(uPool, uvPool - dsp).b)
      : skyTint(vec3(0.0, -1.0, 0.0)) * 0.4;    // no pool → murky floor
    base *= exp(-vec3(0.45, 0.15, 0.08) * depth * 0.8);  // Beer–Lambert
    float caustic = pow(max(-lap, 0.0), 1.5) * 6.0;      // −Laplacian focus
    poolCol = base + caustic * uSkyColor;
  }

  // ── mode blend (continuous Refract↔Mirror) — single scalar, no branch ──
  float mirror = F + (1.0 - F) * 0.98;          // near-full mirror ceiling (#7)
  float reflectivity = mix(F, mirror, clamp(uSurfaceMode, 0.0, 1.0));
  vec3 col = mix(poolCol, reflCol, reflectivity);

  // implicit-sun glitter (no disc drawn): a tight specular lobe on the sky-up
  // half vector — pre-brightness so the final multiply scales it ONCE (#2).
  vec3 hlf = normalize(vec3(0.0, 1.0, 0.0) + V);
  col += pow(max(dot(N, hlf), 0.0), 200.0) * 0.5;

  col *= uBrightness;                            // brightness applied ONCE
  outColor = vec4(clamp(col, 0.0, 4.0), 1.0);
}`;

interface MirrorpoolParams {
  wind_speed: number;
  wind_dir: number;
  rain: number;
  brightness: number;
  surface_mode: number;
  cam_x: number;
  cam_y: number;
  cam_z: number;
  pan: number;
  tilt: number;
  zoom: number;
  // Bipolar position: translates the camera EYE in world space (±1 → ±2R),
  // ON TOP of the PTZ framing. Default 0 = current framing (unchanged).
  pos_x: number;
  pos_y: number;
  pos_z: number;
}

const DEFAULTS: MirrorpoolParams = {
  wind_speed: 0.3,
  wind_dir: 0,
  rain: 0.2,
  brightness: 1,
  surface_mode: 0,
  cam_x: 0,
  cam_y: 1.3,
  cam_z: 1.6,
  pan: 0,
  tilt: -0.6,
  zoom: 0.5,
  pos_x: 0,
  pos_y: 0,
  pos_z: 0,
};

export const MIRRORPOOL_DEFAULTS: Readonly<MirrorpoolParams> = DEFAULTS;
/** Ambient "virtual-sun" sky colour (no sun disc drawn yet — Brightness only). */
const SKY_COLOR: [number, number, number] = [0.35, 0.55, 0.82];

/** Allocate an arbitrary-size RGBA8 render target (LINEAR upscale by the copy
 *  shader), cleared to opaque black so frame 0 (pre-compile) is clean. */
function createRenderTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): { fbo: WebGLFramebuffer; texture: WebGLTexture } {
  const tex = gl.createTexture();
  if (!tex) throw new Error('mirrorpool: createTexture failed');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  if (!fbo) { gl.deleteTexture(tex); throw new Error('mirrorpool: createFramebuffer failed'); }
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteTexture(tex); gl.deleteFramebuffer(fbo);
    throw new Error(`mirrorpool: framebuffer incomplete: 0x${status.toString(16)}`);
  }
  gl.viewport(0, 0, width, height);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, texture: tex };
}

export const mirrorpoolDef: VideoModuleDef = {
  type: 'mirrorpool',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'mirrorpool',
  category: 'sources',
  // Real-time sim: draw() advances the wave field, so it must not be paused
  // while unobserved (it exposes no audioSources/pulse marker of its own).
  pullExempt: true,
  inputs: [
    // TWO video inputs (typed `video` so canConnect upcasts image/mono-video).
    { id: 'pool', type: 'video' },
    { id: 'scene', type: 'video' },
    // Every control = knob + CV (cvScale REQUIRED by cv-scale-registry).
    { id: 'wind_speed_cv', type: 'cv', paramTarget: 'wind_speed', cvScale: { mode: 'linear' } },
    { id: 'wind_dir_cv', type: 'cv', paramTarget: 'wind_dir', cvScale: { mode: 'linear' } },
    { id: 'rain_cv', type: 'cv', paramTarget: 'rain', cvScale: { mode: 'linear' } },
    { id: 'brightness_cv', type: 'cv', paramTarget: 'brightness', cvScale: { mode: 'linear' } },
    { id: 'surface_mode_cv', type: 'cv', paramTarget: 'surface_mode', cvScale: { mode: 'linear' } },
    { id: 'cam_x_cv', type: 'cv', paramTarget: 'cam_x', cvScale: { mode: 'linear' } },
    { id: 'cam_y_cv', type: 'cv', paramTarget: 'cam_y', cvScale: { mode: 'linear' } },
    { id: 'cam_z_cv', type: 'cv', paramTarget: 'cam_z', cvScale: { mode: 'linear' } },
    { id: 'pan_cv', type: 'cv', paramTarget: 'pan', cvScale: { mode: 'linear' } },
    { id: 'tilt_cv', type: 'cv', paramTarget: 'tilt', cvScale: { mode: 'linear' } },
    { id: 'zoom_cv', type: 'cv', paramTarget: 'zoom', cvScale: { mode: 'linear' } },
    // Bipolar camera POSITION CV: translate the eye ±2R per axis (on top of PTZ).
    { id: 'pos_x_cv', type: 'cv', paramTarget: 'pos_x', cvScale: { mode: 'linear' } },
    { id: 'pos_y_cv', type: 'cv', paramTarget: 'pos_y', cvScale: { mode: 'linear' } },
    { id: 'pos_z_cv', type: 'cv', paramTarget: 'pos_z', cvScale: { mode: 'linear' } },
  ],
  outputs: [{ id: 'video_out', type: 'video' }],
  params: [
    { id: 'wind_speed', label: 'Wind', defaultValue: DEFAULTS.wind_speed, min: 0, max: 1, curve: 'linear' },
    { id: 'wind_dir', label: 'Dir', defaultValue: DEFAULTS.wind_dir, min: -Math.PI, max: Math.PI, curve: 'linear' },
    { id: 'rain', label: 'Rain', defaultValue: DEFAULTS.rain, min: 0, max: 1, curve: 'linear' },
    { id: 'brightness', label: 'Bright', defaultValue: DEFAULTS.brightness, min: 0, max: 2, curve: 'linear' },
    { id: 'surface_mode', label: 'Mode', defaultValue: DEFAULTS.surface_mode, min: 0, max: 1, curve: 'linear' },
    { id: 'cam_x', label: 'Cam X', defaultValue: DEFAULTS.cam_x, min: -1.6, max: 1.6, curve: 'linear' },
    { id: 'cam_y', label: 'Cam Y', defaultValue: DEFAULTS.cam_y, min: 0.15, max: 2.2, curve: 'linear' },
    { id: 'cam_z', label: 'Cam Z', defaultValue: DEFAULTS.cam_z, min: -1.6, max: 1.6, curve: 'linear' },
    { id: 'pan', label: 'Pan', defaultValue: DEFAULTS.pan, min: -Math.PI, max: Math.PI, curve: 'linear' },
    { id: 'tilt', label: 'Tilt', defaultValue: DEFAULTS.tilt, min: -Math.PI, max: Math.PI, curve: 'linear' },
    { id: 'zoom', label: 'Zoom', defaultValue: DEFAULTS.zoom, min: 0, max: 1, curve: 'linear' },
    // Bipolar position: ±1 → ±2R world translation of the eye. Default 0 = the
    // current PTZ framing (existing patches unchanged). Pos Y+ lifts ABOVE water.
    { id: 'pos_x', label: 'Pos X', defaultValue: DEFAULTS.pos_x, min: -1, max: 1, curve: 'linear' },
    { id: 'pos_y', label: 'Pos Y', defaultValue: DEFAULTS.pos_y, min: -1, max: 1, curve: 'linear' },
    { id: 'pos_z', label: 'Pos Z', defaultValue: DEFAULTS.pos_z, min: -1, max: 1, curve: 'linear' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation: "mirrorpool renders a hemisphere pool of liquid sitting in a box, viewed by a full-PTZ camera you fly around inside it. Two video inputs feed the optics: POOL is surface-mapped to the INSIDE of the hemisphere (the underwater view you see refracted through the water) and SCENE is the surroundings, reflected off the surface as an overhead backdrop. A single real height field drives everything: WIND raises a set of directional swell waves (bigger waves are genuinely taller and travel faster — dispersion, not a flat normal-map trick) and RAIN spawns raindrop impacts that punch one-shot dimples which expand into propagating rings, denser and deeper from drizzle up to a downpour. The surface normal reconstructed from that height field drives a physically-based Fresnel split: in the default REFRACT mode you see the reflected scene layered over the refracted, caustic-lit, colour-absorbed pool beneath; sweep MODE toward MIRROR and the surface becomes a near-full mirror of the sky/scene that the ripples shatter and distort. BRIGHT is a virtual sun that scales overall scene light (no sun disc is drawn yet). The camera is full PTZ — Cam X/Y/Z position plus Pan/Tilt/Zoom — clamped inside the box and gimbal-safe. Every control has a matching CV input, so patch an LFO into pan_cv for a slow orbit, a noise source into rain_cv to gust the storm, or an envelope into surface_mode_cv to melt between a clear refractive pool and a hard mirror. With nothing patched it still renders a live procedural sky + water, so it works as a standalone generative source.",
    inputs: {
      pool: "The underwater view, surface-mapped to the inside of the hemisphere bowl. Sampled along the refracted ray (with Beer-Lambert depth absorption + chromatic dispersion), so it appears distorted beneath the rippling surface. Unpatched, the pool floor falls back to a murky tinted shade.",
      scene: "The surroundings, reflected on the water surface as an overhead backdrop. Sampled along the reflected ray so a camera pan slides a recognisable image and the ripples break it. Unpatched, the reflection falls back to the ambient virtual-sun sky.",
      wind_speed_cv: "Modulates Wind: linear CV sweeps the swell amplitude/steepness over 0..1 — higher CV builds bigger, faster waves (taller ripples refract and reflect more).",
      wind_dir_cv: "Modulates Dir: linear CV sweeps the wind/swell propagation direction over -pi..pi, rotating which way the wave crests travel.",
      rain_cv: "Modulates Rain: linear CV sweeps the storm intensity over 0..1 — 0 is still, rising through drizzle and rainy to a dense downpour of expanding-ring impacts.",
      brightness_cv: "Modulates Bright (the virtual sun): linear CV sweeps overall scene brightness over 0..2. Higher CV brightens the reflection, caustics and glitter together (no sun disc is drawn).",
      surface_mode_cv: "Modulates Mode: linear CV blends continuously from Refract (0) to Mirror (1) by raising the surface reflectivity, so an envelope can melt a clear pool into a hard mirror.",
      cam_x_cv: "Modulates Cam X: linear CV slides the camera left/right within the box over -1.6..1.6.",
      cam_y_cv: "Modulates Cam Y: linear CV raises/lowers the camera height over 0.15..2.2 (kept above the pool rim).",
      cam_z_cv: "Modulates Cam Z: linear CV dollies the camera forward/back within the box over -1.6..1.6.",
      pan_cv: "Modulates Pan: linear CV sweeps the camera yaw over -pi..pi. Patch a slow LFO here for an orbit.",
      tilt_cv: "Modulates Tilt: linear CV sweeps the camera pitch over -pi..pi (clamped to +/-85 degrees to dodge the straight-down gimbal).",
      zoom_cv: "Modulates Zoom: linear CV narrows the field of view from 70 degrees (0) to 20 degrees (1), zooming the camera in.",
      pos_x_cv: "Modulates Pos X: bipolar linear CV translates the camera eye left/right in world space; full-scale +/-1 moves it +/-2R (2 pool-radii = 10 ft) on top of the PTZ framing.",
      pos_y_cv: "Modulates Pos Y: bipolar linear CV lifts/lowers the camera eye in world space; full-scale +/-1 moves it +/-2R. Positive raises the eye ABOVE the water plane so it looks down onto the pool.",
      pos_z_cv: "Modulates Pos Z: bipolar linear CV dollies the camera eye forward/back in world space; full-scale +/-1 moves it +/-2R on top of the PTZ framing.",
    },
    outputs: {
      video_out: "The rendered pool scene from the PTZ camera (rendered at half engine resolution and LINEAR-upscaled). Always live: even with no inputs patched it shows a procedural sky + rippling water, so it doubles as a standalone generative source.",
    },
    controls: {
      wind_speed: "Wind (0..1, default 0.3): the directional swell strength. 0 is a glassy pool; raising it builds a set of 4 dispersive waves whose amplitude grows with wavelength, so bigger, faster crests that tilt the surface normals and break the reflection.",
      wind_dir: "Dir (-pi..pi, default 0): the direction the swell crests propagate.",
      rain: "Rain (0..1, default 0.2): storm intensity from still to downpour. Drives a seeded Poisson scheduler that spawns raindrop impacts — sparse shallow dimples at drizzle, dense deep craters at downpour — each expanding into a propagating ring.",
      brightness: "Bright (0..2, default 1): the virtual-sun scene brightness. Scales the whole render (reflection, caustics, glitter and sky) uniformly. No sun disc is drawn yet.",
      surface_mode: "Mode (0..1, default 0): the continuous Refract -> Mirror blend. 0 = Fresnel refract/reflect (scene over the refracted pool); 1 = a near-full mirror of the sky/scene broken by the ripple normals.",
      cam_x: "Cam X (-1.6..1.6, default 0): camera left/right position in the box.",
      cam_y: "Cam Y (0.15..2.2, default 1.3): camera height, kept above the pool rim.",
      cam_z: "Cam Z (-1.6..1.6, default 1.6): camera forward/back position in the box.",
      pan: "Pan (-pi..pi, default 0): camera yaw. pan=0, tilt=0 looks straight along -z.",
      tilt: "Tilt (-pi..pi, default -0.6): camera pitch, clamped to +/-85 degrees so it never hits the straight-down gimbal degeneracy. Default looks down into the pool.",
      zoom: "Zoom (0..1, default 0.5): maps to a 70..20 degree vertical field of view; higher zooms the camera in.",
      pos_x: "Pos X (-1..1, default 0): bipolar position that TRANSLATES the camera eye left/right in world space, on top of the PTZ framing. Full-scale +/-1 shifts the eye +/-2R (2 pool-radii = 10 ft, the pool being 5 ft in radius); the mapped shift is capped at +/-2R. 0 leaves the current framing unchanged.",
      pos_y: "Pos Y (-1..1, default 0): bipolar position that lifts/lowers the camera eye in world space. Positive raises the eye ABOVE the water plane (out of the pool) so the default downward tilt looks straight down onto the water; full-scale +/-1 moves the eye +/-2R (capped). 0 leaves the current framing unchanged.",
      pos_z: "Pos Z (-1..1, default 0): bipolar position that dollies the camera eye forward/back in world space, on top of the PTZ framing. Full-scale +/-1 shifts the eye +/-2R (capped). 0 leaves the current framing unchanged.",
    },
  },
  // docs-hash-ignore:end

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;

    // Reduced-res render target (managed:false — module owns its resize).
    let renderW = Math.max(1, Math.round(ctx.res.width * RENDER_SCALE));
    let renderH = Math.max(1, Math.round(ctx.res.height * RENDER_SCALE));
    let renderTarget = createRenderTarget(gl, renderW, renderH);

    // Height-field ping-pong (float; degrades to RGBA8 with isFloat=false on
    // renderers lacking EXT_color_buffer_float → analytic-ring fallback).
    const createFloatFbo = ctx.createFloatFbo?.bind(ctx);
    const simA = createFloatFbo?.(SIM_RES, SIM_RES, { filter: 'nearest' }) ?? null;
    const simB = createFloatFbo?.(SIM_RES, SIM_RES, { filter: 'nearest' }) ?? null;
    const isFloat = !!(simA?.isFloat && simB?.isFloat);
    let simFrontIsA = true;
    let simCleared = false;

    // Deferred programs (compiled on first draw — the mandelbulb CI discipline).
    let simProgram: WebGLProgram | null = null;
    let renderProgram: WebGLProgram | null = null;
    let glFailed = false;
    const sU: Record<string, WebGLUniformLocation | null> = {};
    const rU: Record<string, WebGLUniformLocation | null> = {};

    function ensurePrograms(): boolean {
      if (renderProgram) return true;
      if (glFailed) return false;
      try {
        renderProgram = ctx.compileFragment(RENDER_FRAG);
        if (isFloat) simProgram = ctx.compileFragment(SIM_FRAG);
      } catch {
        glFailed = true;
        return false;
      }
      for (const k of ['uState', 'uTexel', 'uC2', 'uDamp', 'uImpacts', 'uImpactCount']) {
        sU[k] = simProgram ? gl.getUniformLocation(simProgram, k) : null;
      }
      for (const k of [
        'uEye', 'uForward', 'uRight', 'uUp', 'uTanHalf', 'uAspect',
        'uPool', 'uScene', 'uState', 'uHasPool', 'uHasScene', 'uHasSim', 'uAnalytic',
        'uTexel', 'uTime', 'uWindDir', 'uWindSpeed', 'uRain', 'uBrightness',
        'uSurfaceMode', 'uSkyColor', 'uRings', 'uRingCount',
      ]) {
        rU[k] = gl.getUniformLocation(renderProgram, k);
      }
      return true;
    }

    const params: MirrorpoolParams = { ...DEFAULTS, ...(node.params as Partial<MirrorpoolParams>) };

    // Black 1×1 sentinel for unpatched input samplers.
    const emptyTex = gl.createTexture();
    if (!emptyTex) throw new Error('mirrorpool: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // Active analytic rings (fallback path): world centre + amp + spawnTime.
    const activeRings: { cx: number; cz: number; amp: number; spawn: number }[] = [];
    let frameIndex = 0;
    const startWallMs = typeof performance !== 'undefined' ? performance.now() : Date.now();

    // A test seam pins the clock (VRT determinism, mirrors b3ntb0x). Seed too.
    function seed(): number {
      const s = (globalThis as unknown as { __mirrorpoolVrtSeed?: number }).__mirrorpoolVrtSeed;
      return typeof s === 'number' && Number.isFinite(s) ? s : 0x1a2b3c;
    }
    function forceAnalytic(): boolean {
      return !!(globalThis as unknown as { __mirrorpoolForceAnalytic?: boolean }).__mirrorpoolForceAnalytic;
    }

    const surface: VideoNodeSurface = {
      get fbo() { return renderTarget.fbo; },
      get texture() { return renderTarget.texture; },
      draw(frame) {
        const g = frame.gl;
        if (!ensurePrograms() || !renderProgram) return;

        const freezeT = (globalThis as unknown as { __videoEngineFreezeTime?: number }).__videoEngineFreezeTime;
        const tSec = typeof freezeT === 'number' && Number.isFinite(freezeT)
          ? freezeT
          : ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - startWallMs) / 1000;

        const useSim = isFloat && !forceAnalytic() && simA && simB && simProgram;

        // Spawn this frame's rain drops (deterministic in seed+frame).
        const drops = spawnDrops(params.rain, seed(), frameIndex, MAX_IMPACTS);

        if (useSim) {
          // Clear both float buffers to a flat field once.
          if (!simCleared) {
            for (const f of [simA!, simB!]) {
              g.bindFramebuffer(g.FRAMEBUFFER, f.fbo);
              g.viewport(0, 0, SIM_RES, SIM_RES);
              g.clearColor(0, 0, 0, 1);
              g.clear(g.COLOR_BUFFER_BIT);
            }
            simCleared = true;
          }
          // ── Sim pass: read front, write back ──
          const read = simFrontIsA ? simA! : simB!;
          const write = simFrontIsA ? simB! : simA!;
          g.bindFramebuffer(g.FRAMEBUFFER, write.fbo);
          g.viewport(0, 0, SIM_RES, SIM_RES);
          g.useProgram(simProgram!);
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, read.texture);
          g.uniform1i(sU.uState, 0);
          g.uniform2f(sU.uTexel, 1 / SIM_RES, 1 / SIM_RES);
          g.uniform1f(sU.uC2, SIM_C2);
          g.uniform1f(sU.uDamp, SIM_DAMP);
          const impacts = new Float32Array(MAX_IMPACTS * 3);
          const n = Math.min(drops.length, MAX_IMPACTS);
          for (let i = 0; i < n; i++) {
            impacts[i * 3] = drops[i].x;
            impacts[i * 3 + 1] = drops[i].y;
            impacts[i * 3 + 2] = drops[i].amp;
          }
          g.uniform3fv(sU.uImpacts, impacts);
          g.uniform1i(sU.uImpactCount, n);
          ctx.drawFullscreenQuad();
          simFrontIsA = !simFrontIsA;
        } else {
          // Fallback: maintain the analytic-ring history from the same drops.
          for (const d of drops) {
            activeRings.push({ cx: (d.x - 0.5) * WORLD_SCALE, cz: (d.y - 0.5) * WORLD_SCALE, amp: d.amp, spawn: tSec });
          }
          while (activeRings.length > MAX_RINGS) activeRings.shift();
          for (let i = activeRings.length - 1; i >= 0; i--) {
            if (tSec - activeRings[i].spawn > RING_LIFETIME_S) activeRings.splice(i, 1);
          }
        }

        // ── Render pass ──
        // cameraBasis folds the bipolar position (pos_*) into the eye (±2R per
        // axis), so uEye already carries the translation — the render shader
        // consumes uEye directly (no separate eye math), keeping core+shader in
        // lockstep by construction.
        const cam = cameraBasis({
          camX: params.cam_x, camY: params.cam_y, camZ: params.cam_z,
          pan: params.pan, tilt: params.tilt, zoom: params.zoom,
          posX: params.pos_x, posY: params.pos_y, posZ: params.pos_z,
        });
        const poolTex = frame.getInputTexture(node.id, 'pool');
        const sceneTex = frame.getInputTexture(node.id, 'scene');

        g.bindFramebuffer(g.FRAMEBUFFER, renderTarget.fbo);
        g.viewport(0, 0, renderW, renderH);
        g.useProgram(renderProgram);
        g.uniform3f(rU.uEye, cam.eye[0], cam.eye[1], cam.eye[2]);
        g.uniform3f(rU.uForward, cam.forward[0], cam.forward[1], cam.forward[2]);
        g.uniform3f(rU.uRight, cam.right[0], cam.right[1], cam.right[2]);
        g.uniform3f(rU.uUp, cam.up[0], cam.up[1], cam.up[2]);
        g.uniform1f(rU.uTanHalf, cam.tanHalf);
        g.uniform1f(rU.uAspect, ctx.res.width / Math.max(1, ctx.res.height));
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, poolTex ?? emptyTex);
        g.uniform1i(rU.uPool, 0);
        g.activeTexture(g.TEXTURE1);
        g.bindTexture(g.TEXTURE_2D, sceneTex ?? emptyTex);
        g.uniform1i(rU.uScene, 1);
        g.activeTexture(g.TEXTURE2);
        const stateTex = useSim ? (simFrontIsA ? simA! : simB!).texture : emptyTex;
        g.bindTexture(g.TEXTURE_2D, stateTex);
        g.uniform1i(rU.uState, 2);
        g.uniform1f(rU.uHasPool, poolTex ? 1 : 0);
        g.uniform1f(rU.uHasScene, sceneTex ? 1 : 0);
        g.uniform1f(rU.uHasSim, useSim ? 1 : 0);
        g.uniform1f(rU.uAnalytic, useSim ? 0 : 1);
        g.uniform2f(rU.uTexel, 1 / SIM_RES, 1 / SIM_RES);
        g.uniform1f(rU.uTime, tSec);
        g.uniform1f(rU.uWindDir, params.wind_dir);
        g.uniform1f(rU.uWindSpeed, params.wind_speed);
        g.uniform1f(rU.uRain, params.rain);
        g.uniform1f(rU.uBrightness, params.brightness);
        g.uniform1f(rU.uSurfaceMode, params.surface_mode);
        g.uniform3f(rU.uSkyColor, SKY_COLOR[0], SKY_COLOR[1], SKY_COLOR[2]);
        const rings = new Float32Array(MAX_RINGS * 4);
        const rn = useSim ? 0 : Math.min(activeRings.length, MAX_RINGS);
        for (let i = 0; i < rn; i++) {
          rings[i * 4] = activeRings[i].cx;
          rings[i * 4 + 1] = activeRings[i].cz;
          rings[i * 4 + 2] = activeRings[i].amp;
          rings[i * 4 + 3] = activeRings[i].spawn;
        }
        g.uniform4fv(rU.uRings, rings);
        g.uniform1i(rU.uRingCount, rn);
        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);
        frameIndex++;
      },
      resize(w, h) {
        // Rebuild the unmanaged render target at the new engine res. The 256²
        // sim grid is aspect-independent, so it is NOT rebuilt.
        gl.deleteFramebuffer(renderTarget.fbo);
        gl.deleteTexture(renderTarget.texture);
        renderW = Math.max(1, Math.round(w * RENDER_SCALE));
        renderH = Math.max(1, Math.round(h * RENDER_SCALE));
        renderTarget = createRenderTarget(gl, renderW, renderH);
      },
      dispose() {
        gl.deleteFramebuffer(renderTarget.fbo);
        gl.deleteTexture(renderTarget.texture);
        gl.deleteTexture(emptyTex);
        for (const f of [simA, simB]) {
          if (f) { gl.deleteFramebuffer(f.fbo); gl.deleteTexture(f.texture); }
        }
        if (simProgram) gl.deleteProgram(simProgram);
        if (renderProgram) gl.deleteProgram(renderProgram);
      },
    };

    return {
      domain: 'video',
      surface,
      setParam(paramId, value) {
        if (paramId in params) (params as unknown as Record<string, number>)[paramId] = value;
      },
      readParam(paramId) {
        return (params as unknown as Record<string, number>)[paramId];
      },
      read(key) {
        if (key === 'isFloat') return isFloat;      // card "reduced precision" badge
        if (key === 'frameIndex') return frameIndex;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
