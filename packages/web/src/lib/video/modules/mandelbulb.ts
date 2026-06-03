// packages/web/src/lib/video/modules/mandelbulb.ts
//
// MANDELBULB — WebGL2 GLSL ray-marched 3D Mandelbulb fractal VIDEO source.
//
// A procedural video-engine module (sibling of MANDLEBLOT / ACIDWARP): a
// single full-screen-quad fragment shader ray-marches the Mandelbulb
// distance estimate, shades it with finite-difference normals + diffuse +
// Phong specular + soft shadows, and emits a `video_out` mono-video cross-
// domain port. EVERY spatial control is exposed BOTH as a card KNOB AND a
// CV input port (the user's explicit requirement: "zoom and spatial
// controls under cv and knobs").
//
// Algorithm references (translated to OUR raw WebGL2 — no Three.js dep):
//   - github.com/royvanrijn/mandelbulb.js (CPU raymarcher; POWER 8, ~20
//     fractal iterations, bailout 2.5, DE = 0.5*log(r)*r/dr come from it)
//   - sbcode.net/tsl/mandelbulb (Three.js TSL GPU version, for look/controls)
//
// The standard Mandelbulb DE (per-pixel, in the fragment shader):
//   for ~POWER-8, ~ITER fractal iterations:
//     r = length(z); if (r > BAILOUT) break;
//     theta = acos(z.z / r); phi = atan(z.y, z.x);
//     dr = pow(r, power-1) * power * dr + 1;
//     zr = pow(r, power);
//     theta *= power; phi *= power;
//     z = zr * vec3(sin(theta)cos(phi), sin(theta)sin(phi), cos(theta)) + pos;
//   distance = 0.5 * log(r) * r / dr;
// (jsDistanceEstimate below is the pure-TS port the unit suite exercises so
//  the algebra is verified outside GL, which jsdom can't render.)
//
// PERF (mirrors the CUBE v4 screen-off gate, adapted to a video-engine
// module): the heavy raymarch runs inside the module's draw(). When the
// SCRN toggle is OFF (`screen_on` param = 0) AND `video_out` is unpatched,
// draw() skips the raymarch entirely — the biggest perf win — while still
// keeping a valid (last-rendered or cleared) frame in the FBO. The engine
// passes `frame.isOutputConnected(nodeId)` so the module can detect a
// downstream consumer; absent (older test mocks) is treated as "connected"
// so the module never wrongly goes dark. A scene-dirty throttle skips the
// re-render when neither the params nor (for auto-spin) the clock moved.
//
// Output:
//   video_out (mono-video): the shaded Mandelbulb render (4:3, 640×480).
//
// Controls — EACH is a KNOB + a CV input port (zoom + spatial):
//   zoom      (zoom_cv)      camera dolly  0.3..3
//   rotate_x  (rotate_x_cv)  orbit pitch   -π..π
//   rotate_y  (rotate_y_cv)  orbit yaw     -π..π
//   power     (power_cv)     fractal power  1..12   (default 8)
//   detail    (detail_cv)    fractal iters  4..30   (default 20, discrete)
//   hue       (hue_cv)       palette shift  0..1
// View-only (no CV): autospin (toggle), screen_on (SCRN perf toggle).

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

// ----------------------------------------------------------------------
// Pure-TS reference of the Mandelbulb distance estimate (DE).
//
// Identical algebra to the GLSL `mandelbulbDE` below — the only port is
// syntax (Math.* vs GLSL builtins). Unit-tested so the iteration math is
// verified outside GL. Returns the signed-distance estimate from `p` to
// the Mandelbulb surface for the given power + iteration budget.
// ----------------------------------------------------------------------

export const MANDELBULB_BAILOUT = 2.5;

/**
 * Mandelbulb distance estimate at point p=(px,py,pz).
 *   - power:   the fractal exponent (8 = the classic Mandelbulb).
 *   - iters:   fractal iteration budget (~20).
 * Standard DE: 0.5 * log(r) * r / dr.
 */
export function jsDistanceEstimate(
  px: number,
  py: number,
  pz: number,
  power: number,
  iters: number,
): number {
  let zx = px;
  let zy = py;
  let zz = pz;
  let dr = 1.0;
  let r = 0.0;
  for (let i = 0; i < iters; i++) {
    r = Math.sqrt(zx * zx + zy * zy + zz * zz);
    if (r > MANDELBULB_BAILOUT) break;
    // Convert to polar.
    let theta = Math.acos(zz / r);
    let phi = Math.atan2(zy, zx);
    dr = Math.pow(r, power - 1.0) * power * dr + 1.0;
    // Scale + rotate the point.
    const zr = Math.pow(r, power);
    theta *= power;
    phi *= power;
    // Convert back to cartesian + translate by the original point.
    const sinTheta = Math.sin(theta);
    zx = zr * sinTheta * Math.cos(phi) + px;
    zy = zr * sinTheta * Math.sin(phi) + py;
    zz = zr * Math.cos(theta) + pz;
  }
  // 0.5 * log(r) * r / dr. Guard r=0 (a point exactly at origin never
  // escapes; log(0) = -inf) by clamping r to a tiny epsilon.
  const rr = Math.max(r, 1e-12);
  return (0.5 * Math.log(rr) * rr) / dr;
}

/**
 * Map the camera-zoom knob (0.3..3) to the eye distance from the bulb.
 * Larger zoom ⇒ closer eye ⇒ smaller distance. Base eye distance ~2.2
 * (per the references); zoom=1 reproduces it.
 */
export function jsEyeDistanceFromZoom(zoom: number): number {
  const z = Math.max(0.3, Math.min(3, zoom));
  return 2.2 / z;
}

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform vec2  uResolution;   // engine framebuffer res
uniform float uEyeDist;      // camera distance from the bulb (post-zoom map)
uniform float uRotX;         // orbit pitch (radians)
uniform float uRotY;         // orbit yaw (radians)
uniform float uPower;        // fractal power (1..12, 8 = classic)
uniform float uIterations;   // fractal iteration budget (4..30)
uniform float uHue;          // palette shift 0..1

const float BAILOUT  = ${MANDELBULB_BAILOUT.toFixed(1)};
const int   MAX_ITER = 30;     // upper bound for the fractal loop (uIterations gates it)
const int   MAX_STEP = 192;    // raymarch step budget
const float MAX_DIST  = 6.0;   // far plane
const float SURF_EPS  = 0.0008; // hit epsilon (~half-pixel at this res)

// Mandelbulb distance estimate (mirrors jsDistanceEstimate in TS).
float mandelbulbDE(vec3 pos) {
  vec3 z = pos;
  float dr = 1.0;
  float r = 0.0;
  for (int i = 0; i < MAX_ITER; i++) {
    if (float(i) >= uIterations) break;
    r = length(z);
    if (r > BAILOUT) break;
    float theta = acos(z.z / r);
    float phi   = atan(z.y, z.x);
    dr = pow(r, uPower - 1.0) * uPower * dr + 1.0;
    float zr = pow(r, uPower);
    theta *= uPower;
    phi   *= uPower;
    float sinTheta = sin(theta);
    z = zr * vec3(sinTheta * cos(phi), sinTheta * sin(phi), cos(theta)) + pos;
  }
  return 0.5 * log(max(r, 1e-12)) * max(r, 1e-12) / dr;
}

// Finite-difference surface normal.
vec3 calcNormal(vec3 p) {
  vec2 e = vec2(0.0015, 0.0);
  return normalize(vec3(
    mandelbulbDE(p + e.xyy) - mandelbulbDE(p - e.xyy),
    mandelbulbDE(p + e.yxy) - mandelbulbDE(p - e.yxy),
    mandelbulbDE(p + e.yyx) - mandelbulbDE(p - e.yyx)
  ));
}

// Soft shadow march toward the light.
float softShadow(vec3 ro, vec3 rd) {
  float res = 1.0;
  float t = 0.02;
  for (int i = 0; i < 48; i++) {
    if (t > 3.0) break;
    float h = mandelbulbDE(ro + rd * t);
    if (h < 0.0008) return 0.0;
    res = min(res, 8.0 * h / t);
    t += clamp(h, 0.01, 0.2);
  }
  return clamp(res, 0.0, 1.0);
}

// hue (0..1) → RGB (compact HSV→RGB, full saturation + value).
vec3 hue2rgb(float h) {
  return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
}

void main() {
  // Square-aspect uv centred at origin (divide by Y so X stretches with
  // the aspect ratio + the frame stays uncropped).
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;

  // Orbit camera: spherical eye position around the bulb at uEyeDist.
  float cx = cos(uRotX), sx = sin(uRotX);
  float cy = cos(uRotY), sy = sin(uRotY);
  vec3 eye = uEyeDist * vec3(cy * cx, sx, sy * cx);
  // Build a look-at basis (target = origin).
  vec3 fwd = normalize(-eye);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));
  vec3 up = cross(fwd, right);
  vec3 rd = normalize(uv.x * right + uv.y * up + 1.4 * fwd);
  vec3 ro = eye;

  // Raymarch.
  float t = 0.0;
  bool hit = false;
  for (int i = 0; i < MAX_STEP; i++) {
    vec3 p = ro + rd * t;
    float d = mandelbulbDE(p);
    if (d < SURF_EPS) { hit = true; break; }
    t += d;
    if (t > MAX_DIST) break;
  }

  vec3 col;
  if (hit) {
    vec3 p = ro + rd * t;
    vec3 n = calcNormal(p);
    vec3 lightDir = normalize(vec3(0.6, 0.7, -0.4));
    float diff = max(dot(lightDir, n), 0.0);
    // Phong specular (exp ~35).
    vec3 viewDir = normalize(-rd);
    vec3 refl = reflect(-lightDir, n);
    float spec = pow(max(dot(viewDir, refl), 0.0), 35.0);
    float sh = softShadow(p + n * 0.002, lightDir);
    diff *= sh;
    // Brightness term b drives both shading + the iteration-count colour.
    float b = clamp(0.15 + diff, 0.0, 1.0);
    // Reference colour ramp from royvanrijn/mandelbulb.js:
    //   r = 10 + 380*b, g = 10 + 280*b, b = 180*b  (then normalize to 0..1)
    vec3 base = vec3(10.0 + 380.0 * b, 10.0 + 280.0 * b, 180.0 * b) / 255.0;
    // Fold in the HUE control as a tint rotation so the palette can shift.
    vec3 tint = hue2rgb(uHue);
    col = mix(base, base * (0.4 + 0.6 * tint) + tint * 0.15, 0.5);
    col += spec * sh * vec3(1.0);
  } else {
    // Sky / background from the ray direction — a subtle vertical gradient
    // tinted by the hue control (so the bg also responds to HUE).
    float sky = 0.5 + 0.5 * rd.y;
    vec3 skyTint = mix(vec3(0.02, 0.03, 0.06), 0.18 * hue2rgb(uHue) + 0.04, sky);
    col = skyTint;
  }

  // Gamma.
  col = pow(clamp(col, 0.0, 1.0), vec3(0.4545));
  outColor = vec4(col, 1.0);
}`;

interface MandelbulbParams {
  zoom: number;       // 0.3..3   — camera dolly (mapped via jsEyeDistanceFromZoom)
  rotate_x: number;   // -π..π    — orbit pitch
  rotate_y: number;   // -π..π    — orbit yaw
  power: number;      // 1..12    — fractal power (8 = classic)
  detail: number;     // 4..30    — fractal iteration budget (discrete)
  hue: number;        // 0..1     — palette shift
  autospin: number;   // 0/1      — auto-rotate the yaw (view-only, discrete)
  screen_on: number;  // 0/1      — SCRN perf gate (view-only, discrete)
}

const DEFAULTS: MandelbulbParams = {
  zoom: 1,
  rotate_x: 0.5,
  rotate_y: 0.6,
  power: 8,
  detail: 20,
  hue: 0.55,
  autospin: 1,
  screen_on: 1,
};

export const MANDELBULB_DEFAULTS: Readonly<MandelbulbParams> = DEFAULTS;

/** Auto-spin yaw rate, radians/sec (the reference auto-rotates). */
export const AUTOSPIN_RATE = 0.25;

export const mandelbulbDef: VideoModuleDef = {
  type: 'mandelbulb',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'MANDELBULB',
  category: 'sources',
  schemaVersion: 1,
  inputs: [
    // EVERY spatial / zoom control gets a CV input (user requirement).
    // Continuous targets carry a cvScale hint so a ±1 source sweeps the
    // full param range (see cv-bridge-map.ts).
    { id: 'zoom_cv',     type: 'cv', paramTarget: 'zoom',     cvScale: { mode: 'linear' } },
    { id: 'rotate_x_cv', type: 'cv', paramTarget: 'rotate_x', cvScale: { mode: 'linear' } },
    { id: 'rotate_y_cv', type: 'cv', paramTarget: 'rotate_y', cvScale: { mode: 'linear' } },
    { id: 'power_cv',    type: 'cv', paramTarget: 'power',    cvScale: { mode: 'linear' } },
    { id: 'detail_cv',   type: 'cv', paramTarget: 'detail',   cvScale: { mode: 'linear' } },
    { id: 'hue_cv',      type: 'cv', paramTarget: 'hue',      cvScale: { mode: 'linear' } },
  ],
  outputs: [
    // Mono-video cross-domain out (like CUBE.video_out / ACIDWARP.out).
    { id: 'video_out', type: 'mono-video' },
  ],
  params: [
    { id: 'zoom',      label: 'Zoom',  defaultValue: DEFAULTS.zoom,      min: 0.3,            max: 3,             curve: 'log' },
    { id: 'rotate_x',  label: 'Rot X', defaultValue: DEFAULTS.rotate_x,  min: -Math.PI,       max: Math.PI,       curve: 'linear' },
    { id: 'rotate_y',  label: 'Rot Y', defaultValue: DEFAULTS.rotate_y,  min: -Math.PI,       max: Math.PI,       curve: 'linear' },
    { id: 'power',     label: 'Power', defaultValue: DEFAULTS.power,     min: 1,              max: 12,            curve: 'linear' },
    { id: 'detail',    label: 'Detail',defaultValue: DEFAULTS.detail,    min: 4,              max: 30,            curve: 'discrete' },
    { id: 'hue',       label: 'Hue',   defaultValue: DEFAULTS.hue,       min: 0,              max: 1,             curve: 'linear' },
    { id: 'autospin',  label: 'Spin',  defaultValue: DEFAULTS.autospin,  min: 0,              max: 1,             curve: 'discrete' },
    { id: 'screen_on', label: 'Screen',defaultValue: DEFAULTS.screen_on, min: 0,              max: 1,             curve: 'discrete' },
  ],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);
    const uResolution = gl.getUniformLocation(program, 'uResolution');
    const uEyeDist    = gl.getUniformLocation(program, 'uEyeDist');
    const uRotX       = gl.getUniformLocation(program, 'uRotX');
    const uRotY       = gl.getUniformLocation(program, 'uRotY');
    const uPower      = gl.getUniformLocation(program, 'uPower');
    const uIterations = gl.getUniformLocation(program, 'uIterations');
    const uHue        = gl.getUniformLocation(program, 'uHue');

    const { fbo, texture } = ctx.createFbo();

    const params: MandelbulbParams = { ...DEFAULTS, ...(node.params as Partial<MandelbulbParams>) };

    // Auto-spin accumulator + scene-dirty throttle state.
    let spinPhase = 0;
    let lastTime = -1;
    let lastSceneSig = '';
    let renderedOnce = false;

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;

        // --- tick auto-spin ---
        const tNow = frame.time;
        const dt = lastTime < 0 ? 0 : Math.max(0, tNow - lastTime);
        lastTime = tNow;
        const spinning = params.autospin >= 0.5;
        if (spinning) spinPhase += dt * AUTOSPIN_RATE;

        // --- PERF gate (mirrors CUBE v4 screen-off gate) ---
        // Skip the raymarch when SCRN is OFF *and* video_out is unpatched.
        // isOutputConnected is optional (older engine/test mocks omit it);
        // when absent, assume connected so the module never wrongly blanks.
        const screenOn = params.screen_on >= 0.5;
        const outConnected = frame.isOutputConnected
          ? frame.isOutputConnected(node.id)
          : true;
        if (!screenOn && !outConnected) {
          // Render nothing this frame — leave the FBO holding whatever it
          // last had (or its cleared init). Biggest perf win at idle.
          return;
        }

        // Resolve shader inputs from the live params.
        const eyeDist = jsEyeDistanceFromZoom(params.zoom);
        const rotX = params.rotate_x;
        const rotY = params.rotate_y + (spinning ? spinPhase : 0);
        const power = Math.max(1, Math.min(12, params.power));
        const iter = Math.max(4, Math.min(30, Math.round(params.detail)));
        const hue = ((params.hue % 1) + 1) % 1;

        // --- scene-dirty throttle: skip the re-render when nothing the
        //     picture depends on changed since the last rendered frame.
        //     Auto-spin keeps the scene perpetually dirty (rotY moves), so
        //     a spinning bulb always re-renders; a parked bulb idles. ---
        const q = (v: number) => Math.round(v * 1000);
        const sceneSig =
          `${q(eyeDist)}|${q(rotX)}|${q(rotY)}|${q(power)}|${iter}|${q(hue)}`;
        if (renderedOnce && sceneSig === lastSceneSig) return;
        lastSceneSig = sceneSig;

        g.useProgram(program);
        g.uniform2f(uResolution, ctx.res.width, ctx.res.height);
        g.uniform1f(uEyeDist, eyeDist);
        g.uniform1f(uRotX, rotX);
        g.uniform1f(uRotY, rotY);
        g.uniform1f(uPower, power);
        g.uniform1f(uIterations, iter);
        g.uniform1f(uHue, hue);

        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);
        renderedOnce = true;
      },
      dispose() {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
        gl.deleteProgram(program);
      },
    };

    return {
      domain: 'video',
      surface,
      setParam(paramId, value) {
        if (paramId in params) {
          (params as unknown as Record<string, number>)[paramId] = value;
          // Any param change re-dirties the scene so the throttle re-renders.
          lastSceneSig = '';
        }
      },
      readParam(paramId) {
        return (params as unknown as Record<string, number>)[paramId];
      },
      read(key) {
        if (key === 'eyeDist') return jsEyeDistanceFromZoom(params.zoom);
        if (key === 'screenOn') return params.screen_on >= 0.5;
        if (key === 'autospin') return params.autospin >= 0.5;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
