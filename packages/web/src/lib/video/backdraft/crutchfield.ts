import type { VideoEngineContext } from '../engine';

/** Crutchfield (1984), pp.235–236 and Appendix A: spatial diffusion,
 * camera charge storage, separate display persistence, nonlinear capture,
 * and coupled colour channels. This is an engineering approximation of that
 * chain, not a calibration of the Sony equipment used in the paper.
 *
 * Every draw advances one virtual 60 Hz field, like Backdraft's delay ring.
 * The two histories have different coordinate systems: phosphor is attached
 * to the MONITOR; stored charge is attached to the CAMERA. Neither is a
 * cosmetic filter applied after the feedback tap.
 */
export interface CrutchfieldParams {
  focus: number;
  sensorLag: number;
  tubeDecay: number;
  exposure: number;
  blackLevel: number;
  contrast: number;
  sensorVariation: number;
  sensorSeed: number;
}

export const CRUTCHFIELD_DEFAULTS: CrutchfieldParams = {
  focus: 0.15, sensorLag: 0.333, tubeDecay: 0.025,
  exposure: 2, blackLevel: 0.08, contrast: 1.2,
  sensorVariation: 0.15, sensorSeed: 167,
};
export const SENSOR_SEED_MAX = 65535;

export function sensorSeed(value: number): number {
  return Math.round(Math.max(0, Math.min(SENSOR_SEED_MAX, Number.isFinite(value) ? value : CRUTCHFIELD_DEFAULTS.sensorSeed)));
}

/** A full-period permutation: every reroll differs, including at the wrap.
 * Randomness is in the manufactured camera profile, not in when it is drawn. */
export function nextSensorSeed(value: number): number {
  return (Math.imul(sensorSeed(value), 25173) + 13849) & SENSOR_SEED_MAX;
}

/** Stable, CPU-generated profile coefficients; no driver-dependent sine hash. */
export function sensorProfile(value: number): Float32Array {
  let state = sensorSeed(value) + 1;
  const result = new Float32Array(16);
  for (let i = 0; i < result.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    result[i] = 2 * (state / 4294967296) - 1;
  }
  return result;
}

export function fieldResidual(seconds: number, channel = 1): number {
  return seconds > 0 ? Math.exp(-1 / (60 * seconds * channel)) : 0;
}

const HEADER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
`;

const DISPLAY = HEADER + `
uniform sampler2D uSignal;
uniform sampler2D uOld;
uniform vec3 uDecay;
uniform vec3 uRgb;
uniform float uLuma, uChroma, uContrast, uBlack, uFeedback;
uniform float uBeam, uRefresh;
const float PI = 3.141592653589793;
void main() {
  vec3 signal = texture(uSignal, vUv).rgb * uRgb * uLuma;
  float y = dot(signal, vec3(0.299, 0.587, 0.114));
  signal = vec3(y) + (signal - vec3(y)) * uChroma;
  // Contrast amplifies AC around mid-grey; brightness adds DC. CRT gamma
  // 2.2 is our chosen tube model, not a value measured in this paper.
  vec3 voltage = clamp((signal * uFeedback - 0.5) * uContrast + 0.5 + uBlack, 0.0, 1.0);
  vec3 emission = pow(voltage, vec3(2.2));
  // Finite-width scan lines and RGB triads belong to the monitor, and are
  // photographed through the lens on EVERY pass. Analytic pixel integration
  // attenuates the carrier when the raster is smaller than a display pixel.
  float lines = min(240.0, float(textureSize(uOld, 0).y) * 0.4);
  float linePhase = vUv.y * lines;
  float lineWidth = max(fwidth(linePhase), 0.0001);
  float aa = sin(PI * lineWidth) / (PI * lineWidth);
  float scan = 0.88 + 0.12 * aa * cos(2.0 * PI * linePhase);
  vec3 triad = 0.96 + 0.04 * cos(2.0 * PI * (vUv.x * lines + vec3(0.0, 0.333333, 0.666667)));
  emission *= scan * triad;
  vec3 old = texture(uOld, vUv).rgb;
  // At refresh OFF this is the field-averaged emitter. With refresh ON,
  // below-beam rows are still decaying from the preceding field.
  float refreshed = mix(1.0, 1.0 - smoothstep(uBeam - 0.012, uBeam + 0.012, vUv.y), uRefresh);
  outColor = vec4(old * uDecay + emission * (1.0 - uDecay) * refreshed, 1.0);
}`;

const CAMERA = HEADER + `
uniform sampler2D uDisplay, uOld, uA, uB, uLighten, uDarken;
uniform mat3 uCamera;
uniform vec4 uProfile[4];
uniform vec3 uLag;
uniform vec2 uOffset;
uniform float uAspect, uBezel, uShape, uRoom, uMix, uExposure, uFocus, uVariation;
uniform float uMirrorX, uMirrorY, uPixelate, uLight, uDark;
const float PI = 3.141592653589793;

// Float textures use NEAREST on GPUs without float-linear support. Explicit
// bilinear interpolation makes the diffusion/projection portable either way.
vec3 sampleLinear(sampler2D t, vec2 uv) {
  vec2 size = vec2(textureSize(t, 0));
  vec2 p = uv * size - 0.5;
  ivec2 lo = ivec2(floor(p));
  ivec2 hi = ivec2(size) - 1;
  vec2 f = fract(p);
  return mix(mix(texelFetch(t, clamp(lo, ivec2(0), hi), 0).rgb,
                 texelFetch(t, clamp(lo + ivec2(1,0), ivec2(0), hi), 0).rgb, f.x),
             mix(texelFetch(t, clamp(lo + ivec2(0,1), ivec2(0), hi), 0).rgb,
                 texelFetch(t, clamp(lo + ivec2(1,1), ivec2(0), hi), 0).rgb, f.x), f.y);
}

float screenDistance(vec2 p) {
  int shape = int(uShape + 0.5);
  if (shape == 0) {
    vec2 e = abs(p) - vec2(uAspect * 0.5, 0.5);
    return length(max(e, 0.0)) + min(max(e.x, e.y), 0.0);
  }
  if (shape == 1) return length(p) - 0.5;
  float n = shape == 2 ? 5.0 : (shape == 3 ? 3.0 : 8.0);
  float seg = 2.0 * PI / n;
  float angle = atan(p.x, p.y);
  return cos(seg * floor(0.5 + angle / seg) - angle) * length(p) - 0.5 * cos(PI / n);
}

vec3 scene(vec2 uv) {
  vec2 q = (uv - 0.5) * vec2(uAspect, 1.0) - uOffset;
  // A stable, weak lens distortion around a seeded optical centre.
  vec2 lens = q - uVariation * uProfile[0].xy * 0.04;
  q += lens * dot(lens, lens) * uProfile[0].z * uVariation * 0.025;
  vec3 hp = uCamera * vec3(q, 1.0);
  vec2 p = hp.xy / max(hp.z, 0.0001);
  vec2 tap = p / vec2(uAspect, 1.0) + 0.5;
  float d = hp.z > 0.0001 ? screenDistance(p) : 1.0;
  // No edge clamping from the display into the room (Dirichlet boundary).
  vec3 light = d < 0.0 ? sampleLinear(uDisplay, tap) : vec3(0.0);
  vec2 sourceUv = uv;
  if (uPixelate > 0.0) {
    float cells = max(1.0, mix(float(textureSize(uOld, 0).x), 1.0, uPixelate));
    sourceUv = (floor(uv * cells) + 0.5) / cells;
  }
  vec3 room = uRoom * (0.95 * mix(texture(uA, sourceUv).rgb, texture(uB, sourceUv).rgb, uMix) + 0.05);
  // Reflected room light can seed a dark screen, like the paper's flashlight.
  if (d < 0.0) return light + room * 0.12;
  return d < uBezel ? vec3(0.045) * uRoom : room;
}

void main() {
  vec2 uv = vUv;
  if (uMirrorX > 0.5) uv.x = min(uv.x, 1.0 - uv.x);
  if (uMirrorY > 0.5) uv.y = max(uv.y, 1.0 - uv.y);
  // Nine-tap Gaussian approximation in CAMERA coordinates. Every tap goes
  // through the homography: rotating the camera also rotates what it blurs.
  // The intrinsic ~300-line pickup limit remains at FOCUS=0 (Appendix A).
  float radius = (0.7 + 7.0 * uFocus * uFocus) / 300.0;
  vec2 dx = vec2(radius / uAspect, 0.0), dy = vec2(0.0, radius);
  vec3 incoming = scene(uv) * 0.25;
  incoming += (scene(uv+dx) + scene(uv-dx) + scene(uv+dy) + scene(uv-dy)) * 0.125;
  incoming += (scene(uv+dx+dy) + scene(uv+dx-dy) + scene(uv-dx+dy) + scene(uv-dx-dy)) * 0.0625;
  // Fixed-pattern sensitivity AND gamma, attached to the sensor. The profile
  // has no clock input, so changing frame count cannot reroll the camera.
  vec2 q = (vUv - 0.5) * 2.0;
  vec3 field = uProfile[1].xyz * q.x + uProfile[2].xyz * q.y
             + uProfile[3].xyz * (q.x*q.y) + uProfile[0].xyz * dot(q,q) * 0.5;
  vec3 gain = 1.0 + uVariation * 0.12 * field;
  vec3 gamma = clamp(0.75 + uVariation * 0.06 * field, 0.6, 0.9);
  incoming *= uExposure * gain;
  // Imperfect colour separation couples channels before nonlinear capture.
  incoming = mix(incoming, incoming.gbr, 0.025);
  vec3 capture = pow(max(incoming, 0.0), gamma);
  capture = capture / (1.0 + 0.25 * capture); // saturating pickup response
  float keyed = clamp(1.0 + uLight * dot(texture(uLighten, uv).rgb, vec3(0.333333))
                         - uDark * dot(texture(uDarken, uv).rgb, vec3(0.333333)), 0.0, 4.0);
  capture = clamp(capture * keyed, 0.0, 1.0);
  // Stored charge stays at the SAME sensor site, with different RGB lifetimes.
  vec3 charge = mix(capture, sampleLinear(uOld, vUv), uLag);
  outColor = vec4(charge, 1.0);
}`;

const COPY = HEADER + `
uniform sampler2D uImage;
void main() { outColor = vec4(texture(uImage, vUv).rgb, 1.0); }
`;

type Target = { fbo: WebGLFramebuffer; texture: WebGLTexture };
export interface CrutchfieldFrame extends CrutchfieldParams {
  signal: WebGLTexture;
  a: WebGLTexture; b: WebGLTexture;
  lighten: WebGLTexture; darken: WebGLTexture;
  destination: Target;
  camera: readonly number[];
  feedback: number; luma: number; chroma: number; r: number; g: number; bGain: number;
  room: number; bezel: number; shape: number; mix: number;
  offsetX: number; offsetY: number; mirrorX: number; mirrorY: number;
  pixelate: number; light: number; dark: number;
  refresh: boolean; beam: number;
}

/** Lazy-owned by the Backdraft factory. No component state or GPU readbacks. */
export function createCrutchfield(ctx: VideoEngineContext) {
  const gl = ctx.gl;
  const display = ctx.compileFragment(DISPLAY);
  const camera = ctx.compileFragment(CAMERA);
  const copy = ctx.compileFragment(COPY);
  const uniforms = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  function u(program: WebGLProgram, name: string) {
    let cache = uniforms.get(program);
    if (!cache) { cache = new Map(); uniforms.set(program, cache); }
    if (!cache.has(name)) cache.set(name, gl.getUniformLocation(program, name));
    return cache.get(name)!;
  }
  let targets: Target[] = [];
  let width = 0, height = 0, head = 0;
  function release() {
    for (const t of targets) { gl.deleteFramebuffer(t.fbo); gl.deleteTexture(t.texture); }
    targets = [];
    width = height = 0;
    head = 0;
  }
  function bind(program: WebGLProgram, name: string, texture: WebGLTexture, unit: number) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(u(program, name), unit);
  }
  function scalar(program: WebGLProgram, name: string, value: number) { gl.uniform1f(u(program, name), value); }
  let profileSeed = -1;
  let profile = sensorProfile(CRUTCHFIELD_DEFAULTS.sensorSeed);
  return {
    draw(p: CrutchfieldFrame) {
      if (width !== ctx.res.width || height !== ctx.res.height) {
        release();
        width = ctx.res.width; height = ctx.res.height;
        if (!ctx.createFloatFbo) throw new Error('Backdraft Crutchfield requires float-target allocation');
        for (let i = 0; i < 4; i++) targets.push(ctx.createFloatFbo(width, height, { filter: 'nearest' }));
      }
      const oldDisplay = targets[head]!, newDisplay = targets[head ^ 1]!;
      const oldCamera = targets[head + 2]!, newCamera = targets[(head ^ 1) + 2]!;
      gl.viewport(0, 0, width, height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, newDisplay.fbo);
      gl.useProgram(display);
      bind(display, 'uSignal', p.signal, 0); bind(display, 'uOld', oldDisplay.texture, 1);
      gl.uniform3f(u(display, 'uDecay'), fieldResidual(p.tubeDecay, 1.1), fieldResidual(p.tubeDecay), fieldResidual(p.tubeDecay, 0.8));
      gl.uniform3f(u(display, 'uRgb'), p.r, p.g, p.bGain);
      for (const [name, value] of Object.entries({ uLuma:p.luma, uChroma:p.chroma, uContrast:p.contrast, uBlack:p.blackLevel, uFeedback:p.feedback, uBeam:p.beam, uRefresh:p.refresh ? 1 : 0 })) scalar(display, name, value);
      ctx.drawFullscreenQuad();

      gl.bindFramebuffer(gl.FRAMEBUFFER, newCamera.fbo);
      gl.useProgram(camera);
      bind(camera, 'uDisplay', newDisplay.texture, 0); bind(camera, 'uOld', oldCamera.texture, 1);
      bind(camera, 'uA', p.a, 2); bind(camera, 'uB', p.b, 3);
      bind(camera, 'uLighten', p.lighten, 4); bind(camera, 'uDarken', p.darken, 5);
      gl.uniform3f(u(camera, 'uLag'), fieldResidual(p.sensorLag, 1.05), fieldResidual(p.sensorLag), fieldResidual(p.sensorLag, 0.9));
      gl.uniform2f(u(camera, 'uOffset'), p.offsetX * width / height, p.offsetY);
      const m = p.camera;
      gl.uniformMatrix3fv(u(camera, 'uCamera'), false, new Float32Array([m[0]!,m[3]!,m[6]!,m[1]!,m[4]!,m[7]!,m[2]!,m[5]!,m[8]!]));
      const seed = sensorSeed(p.sensorSeed);
      if (seed !== profileSeed) { profile = sensorProfile(seed); profileSeed = seed; }
      gl.uniform4fv(u(camera, 'uProfile[0]'), profile);
      for (const [name, value] of Object.entries({ uAspect:width/height, uBezel:p.bezel, uShape:p.shape, uRoom:p.room, uMix:p.mix, uExposure:p.exposure, uFocus:p.focus, uVariation:p.sensorVariation, uMirrorX:p.mirrorX, uMirrorY:p.mirrorY, uPixelate:p.pixelate, uLight:p.light, uDark:p.dark })) scalar(camera, name, value);
      ctx.drawFullscreenQuad();

      // Only the published delay ring is quantized; charge/decay retain their
      // float histories, avoiding the stuck dark tails of an 8-bit accumulator.
      gl.bindFramebuffer(gl.FRAMEBUFFER, p.destination.fbo);
      gl.useProgram(copy);
      bind(copy, 'uImage', newCamera.texture, 0);
      ctx.drawFullscreenQuad();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      head ^= 1;
    },
    reset: release,
    dispose() { release(); gl.deleteProgram(display); gl.deleteProgram(camera); gl.deleteProgram(copy); },
  };
}
