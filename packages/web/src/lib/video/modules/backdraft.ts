// packages/web/src/lib/video/modules/backdraft.ts
//
// BACKDRAFT — video feedback generator.
//
// A "source" image is crossfaded between two video inputs (in_a / in_b)
// by MIX, then composited with a PROCESSED copy of BACKDRAFT's OWN
// previous output. The fed-back frame is delayed by a frame-ring tap
// (DELAY, 0..100ms), colour-processed (LUMA / CHROMA / per-channel R/G/B
// gain, each -100%..+200%), and scaled per-pixel by two key masks
// (LIGHTEN boosts the feedback effect where bright, DARKEN reduces it).
//
// ── Feedback loop + 1-frame lag ───────────────────────────────────────
// Like FEEDBACK / VDELAY, we resolve the cycle internally: BACKDRAFT
// reads its OWN previous output from a ring of FBO textures it wrote on
// past frames — never sampling the texture it's writing this frame (no
// GL feedback loop). The published surface.texture is the just-written
// output, so downstream modules see frame N while BACKDRAFT's feedback
// tap reads frame N-1..N-7. This is the same 1-frame-lag cycle the
// engine's topo fallback tolerates (id-order on cycles).
//
// ── DELAY as a frame ring ─────────────────────────────────────────────
// We keep a small ring of recent OUTPUT frames (BUFFER_FRAMES). DELAY is
// a knob in milliseconds (0..100). At ~60fps, 100ms ≈ 6 frames; we size
// the ring to MAX_DELAY_FRAMES+slop. The tap is NEAREST-frame:
// frames = round(delayMs / 1000 * 60), clamped to [1, ring-1] (always at
// least 1 so feedback genuinely lags and we never read the slot we're
// about to overwrite). No interpolation — nearest is visually
// indistinguishable at video rate and keeps the shader to one sample.
//
// ── Colour math on the fed-back frame ────────────────────────────────
//   * Per-channel R/G/B gain: rgb *= vec3(R, G, B). 1.0 = neutral.
//   * LUMA gain: scales the pixel's overall brightness about black:
//       rgb *= luma (so >1 brightens, <1 darkens, <0 inverts-ish).
//   * CHROMA gain: scales SATURATION about the pixel's own luma:
//       rgb = lum + (rgb - lum) * chroma   (1.0 = neutral, 0 = greyscale,
//       2.0 = double saturation, <0 = hue-inverted). "Chroma" here means
//       colourfulness/saturation gain (resolved ambiguity — see report).
//   Order: per-channel gain → luma → chroma. All three default to 1.0.
//
// ── Mask combine (LIGHTEN / DARKEN) ───────────────────────────────────
// Each mask is a key (black = no effect, sentinel when unpatched). The
// per-pixel feedback EFFECT scale is the additive, order-independent:
//
//   effectScale = clamp(1 + lightenKnob*lightenMask - darkenKnob*darkenMask,
//                       0, MAX_EFFECT_SCALE)
//
// LIGHTEN turns the feedback UP where its mask is bright; DARKEN turns it
// DOWN where its mask is bright; a pixel in BOTH gets both contributions
// (they cancel/stack additively, independent of order). Knobs are 0..1.
//
//   feedbackContribution = processedFedBack * FEEDBACK * effectScale
//   out = clamp(source + feedbackContribution, 0, 1)
//
// FEEDBACK max is 1.5 (>1 allowed for runaway trails; bounded so a hot
// source + max feedback can't NaN the accumulator — the shader clamps to
// [0,1] each frame anyway).
//
// ── FREEZE (VRT determinism) ──────────────────────────────────────────
// `freeze` param (0/1): when >=0.5, draw() is a no-op — the ring + output
// hold their last contents, so the on-card / output pixels are stable
// across rAF ticks. Feedback is time-evolving by nature; the VRT scene
// settles the loop, then sets freeze=1 to pin a deterministic frame.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

/** Assumed engine frame rate for the ms→frames delay mapping. The engine
 *  drives one step per rAF (~60fps); we document nearest-frame semantics. */
export const BACKDRAFT_FPS = 60;
/** Max DELAY knob value in milliseconds. */
export const BACKDRAFT_MAX_DELAY_MS = 100;
/** Ring depth: enough frames to cover MAX_DELAY_MS at FPS, plus headroom
 *  so the tap (>=1 behind head) never aliases the slot we overwrite. */
export const BACKDRAFT_BUFFER_FRAMES =
  Math.ceil((BACKDRAFT_MAX_DELAY_MS / 1000) * BACKDRAFT_FPS) + 2; // = 8
/** Upper bound on the per-pixel feedback effect scale after mask combine. */
export const BACKDRAFT_MAX_EFFECT_SCALE = 4;
/** FEEDBACK knob ceiling (>1 = runaway trails). */
export const BACKDRAFT_MAX_FEEDBACK = 1.5;

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uA;        // in_a
uniform sampler2D uB;        // in_b
uniform sampler2D uFb;       // delayed previous OUTPUT (the feedback tap)
uniform sampler2D uLighten;  // lighten key mask
uniform sampler2D uDarken;   // darken key mask
uniform float uHasA;
uniform float uHasB;
uniform float uHasFb;
uniform float uHasLighten;
uniform float uHasDarken;

uniform float uMix;        // 0..1 crossfade in_a -> in_b
uniform float uFeedback;   // 0..1.5 overall feedback amount
uniform float uLuma;       // -1..+2 luma gain   (1 = neutral)
uniform float uChroma;     // -1..+2 chroma/sat  (1 = neutral)
uniform float uR;          // -1..+2 red gain
uniform float uG;          // -1..+2 green gain
uniform float uBlue;       // -1..+2 blue gain
uniform float uLightenKnob; // 0..1
uniform float uDarkenKnob;  // 0..1

const float MAX_EFFECT_SCALE = ${BACKDRAFT_MAX_EFFECT_SCALE.toFixed(1)};

float luma(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

void main() {
  // Source = crossfade of the two inputs (zero where unpatched).
  vec3 a = uHasA > 0.5 ? texture(uA, vUv).rgb : vec3(0.0);
  vec3 b = uHasB > 0.5 ? texture(uB, vUv).rgb : vec3(0.0);
  vec3 source = mix(a, b, clamp(uMix, 0.0, 1.0));

  // Fed-back frame (delayed previous output). Zero on cold start.
  vec3 fb = uHasFb > 0.5 ? texture(uFb, vUv).rgb : vec3(0.0);

  // Per-channel gain.
  fb *= vec3(uR, uG, uBlue);
  // Luma gain about black.
  fb *= uLuma;
  // Chroma (saturation) gain about the pixel's own luma.
  float l = luma(fb);
  fb = vec3(l) + (fb - vec3(l)) * uChroma;

  // Mask combine — additive, order-independent. Masks read as luma so a
  // colour mask still keys on brightness. Unpatched mask => 0 (neutral).
  float lm = uHasLighten > 0.5 ? luma(texture(uLighten, vUv).rgb) : 0.0;
  float dm = uHasDarken  > 0.5 ? luma(texture(uDarken,  vUv).rgb) : 0.0;
  float effectScale = clamp(
    1.0 + uLightenKnob * lm - uDarkenKnob * dm,
    0.0, MAX_EFFECT_SCALE);

  vec3 contribution = fb * uFeedback * effectScale;
  vec3 outc = source + contribution;
  outColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
}`;

export interface BackdraftParams {
  mix: number;       // 0..1
  feedback: number;  // 0..BACKDRAFT_MAX_FEEDBACK
  delay: number;     // 0..BACKDRAFT_MAX_DELAY_MS (ms)
  luma: number;      // -1..+2
  chroma: number;    // -1..+2
  r: number;         // -1..+2
  g: number;         // -1..+2
  b: number;         // -1..+2
  lighten: number;   // 0..1
  darken: number;    // 0..1
  freeze: number;    // 0/1 (VRT determinism)
}

const DEFAULTS: BackdraftParams = {
  mix: 0.5,
  feedback: 0.85,
  delay: 16,    // ~1 frame at 60fps — a tight, lively trail by default
  luma: 1.0,
  chroma: 1.0,
  r: 1.0,
  g: 1.0,
  b: 1.0,
  lighten: 1.0,
  darken: 1.0,
  freeze: 0,
};

/**
 * Pure DELAY-knob → ring-tap-frame mapping. NEAREST-frame: round the ms
 * delay to whole frames at BACKDRAFT_FPS, then clamp to [1, ringSize-1]
 * so the tap always lags by at least one frame and never aliases the
 * head slot we're about to overwrite. Exported for unit tests + the
 * draw() tap math share one source of truth.
 */
export function backdraftDelayFrames(
  delayMs: number,
  ringSize: number,
  fps: number = BACKDRAFT_FPS,
): number {
  if (ringSize < 2) return 1;
  const raw = Math.round((Math.max(0, delayMs) / 1000) * fps);
  return Math.max(1, Math.min(ringSize - 1, raw));
}

/**
 * Pure ring tap index: the slot `frames` behind `head` (the slot draw()
 * is about to write). Mirror of vdelayTapIndex; kept local so the two
 * modules can diverge later.
 */
export function backdraftTapIndex(head: number, frames: number, size: number): number {
  if (size <= 0) throw new Error('backdraftTapIndex: size must be positive');
  const f = Math.max(1, Math.min(size - 1, Math.floor(frames)));
  return ((head - f) % size + size) % size;
}

/**
 * Pure mask-combine math (per-pixel). additive + order-independent:
 *   clamp(1 + lightenKnob*lightenMask - darkenKnob*darkenMask, 0, max)
 * All inputs in [0,1] (masks) / [0,1] (knobs). Returns the effect scale.
 */
export function backdraftEffectScale(
  lightenMask: number,
  darkenMask: number,
  lightenKnob: number,
  darkenKnob: number,
  maxScale: number = BACKDRAFT_MAX_EFFECT_SCALE,
): number {
  const raw = 1 + lightenKnob * lightenMask - darkenKnob * darkenMask;
  return Math.max(0, Math.min(maxScale, raw));
}

export const backdraftDef: VideoModuleDef = {
  type: 'backdraft',
  domain: 'video',
  label: 'BACKDRAFT',
  category: 'effects',
  schemaVersion: 1,
  inputs: [
    { id: 'in_a',    type: 'video' },
    { id: 'in_b',    type: 'video' },
    // KEY masks. 'video' so any source (LINES / SHAPES / a key) patches in.
    { id: 'lighten', type: 'video' },
    { id: 'darken',  type: 'video' },
    // CV inputs — port id == param id; linear cvScale (bipolar where the
    // param range is signed: luma/chroma/r/g/b span -1..+2).
    { id: 'mix',         type: 'cv', paramTarget: 'mix',      cvScale: { mode: 'linear' } },
    { id: 'feedback',    type: 'cv', paramTarget: 'feedback', cvScale: { mode: 'linear' } },
    { id: 'delay',       type: 'cv', paramTarget: 'delay',    cvScale: { mode: 'linear' } },
    { id: 'luma',        type: 'cv', paramTarget: 'luma',     cvScale: { mode: 'linear' } },
    { id: 'chroma',      type: 'cv', paramTarget: 'chroma',   cvScale: { mode: 'linear' } },
    { id: 'r',           type: 'cv', paramTarget: 'r',        cvScale: { mode: 'linear' } },
    { id: 'g',           type: 'cv', paramTarget: 'g',        cvScale: { mode: 'linear' } },
    { id: 'b',           type: 'cv', paramTarget: 'b',        cvScale: { mode: 'linear' } },
    { id: 'lighten_cv',  type: 'cv', paramTarget: 'lighten',  cvScale: { mode: 'linear' } },
    { id: 'darken_cv',   type: 'cv', paramTarget: 'darken',   cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    { id: 'mix',      label: 'Mix',      defaultValue: DEFAULTS.mix,      min: 0,  max: 1,                     curve: 'linear' },
    { id: 'feedback', label: 'Feedback', defaultValue: DEFAULTS.feedback, min: 0,  max: BACKDRAFT_MAX_FEEDBACK, curve: 'linear' },
    { id: 'delay',    label: 'Delay',    defaultValue: DEFAULTS.delay,    min: 0,  max: BACKDRAFT_MAX_DELAY_MS, curve: 'linear' },
    { id: 'luma',     label: 'Luma',     defaultValue: DEFAULTS.luma,     min: -1, max: 2,                     curve: 'linear' },
    { id: 'chroma',   label: 'Chroma',   defaultValue: DEFAULTS.chroma,   min: -1, max: 2,                     curve: 'linear' },
    { id: 'r',        label: 'R',        defaultValue: DEFAULTS.r,        min: -1, max: 2,                     curve: 'linear' },
    { id: 'g',        label: 'G',        defaultValue: DEFAULTS.g,        min: -1, max: 2,                     curve: 'linear' },
    { id: 'b',        label: 'B',        defaultValue: DEFAULTS.b,        min: -1, max: 2,                     curve: 'linear' },
    { id: 'lighten',  label: 'Lighten',  defaultValue: DEFAULTS.lighten,  min: 0,  max: 1,                     curve: 'linear' },
    { id: 'darken',   label: 'Darken',   defaultValue: DEFAULTS.darken,   min: 0,  max: 1,                     curve: 'linear' },
    // freeze is a hidden VRT/determinism toggle — no card control.
    { id: 'freeze',   label: 'Freeze',   defaultValue: DEFAULTS.freeze,   min: 0,  max: 1,                     curve: 'linear' },
  ],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const u = (name: string): WebGLUniformLocation | null => gl.getUniformLocation(program, name);
    const uA = u('uA');
    const uB = u('uB');
    const uFb = u('uFb');
    const uLighten = u('uLighten');
    const uDarken = u('uDarken');
    const uHasA = u('uHasA');
    const uHasB = u('uHasB');
    const uHasFb = u('uHasFb');
    const uHasLighten = u('uHasLighten');
    const uHasDarken = u('uHasDarken');
    const uMix = u('uMix');
    const uFeedback = u('uFeedback');
    const uLuma = u('uLuma');
    const uChroma = u('uChroma');
    const uR = u('uR');
    const uG = u('uG');
    const uBlue = u('uBlue');
    const uLightenKnob = u('uLightenKnob');
    const uDarkenKnob = u('uDarkenKnob');

    // Ring buffer of OUTPUT frames + a dedicated current-output FBO. We
    // render the composite into ring[head] (which IS this frame's output),
    // and publish ring[head].texture downstream. The feedback tap reads
    // ring[head - delayFrames] — a frame we wrote on a PAST step, so we
    // never sample the texture being written this frame.
    const ring: { fbo: WebGLFramebuffer; texture: WebGLTexture }[] = [];
    for (let i = 0; i < BACKDRAFT_BUFFER_FRAMES; i++) ring.push(ctx.createFbo());

    // 1×1 black sentinel for unbound inputs / cold-start tap. Black =
    // no-effect (zero source, zero feedback, zero mask). Same pattern as
    // V-MIXER / VDELAY: never bind our own output as a spare sampler.
    const emptyTex = gl.createTexture();
    if (!emptyTex) throw new Error('BACKDRAFT: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const params: BackdraftParams = { ...DEFAULTS, ...(node.params as Partial<BackdraftParams>) };
    let head = 0;
    let framesElapsed = 0;

    const surface: VideoNodeSurface = {
      fbo: ring[0]!.fbo,
      texture: ring[0]!.texture,
      draw(frame) {
        // FREEZE: hold last output (ring + surface.texture unchanged) so
        // the feedback render is pixel-stable for deterministic VRT.
        if (params.freeze >= 0.5) return;

        const g = frame.gl;
        const aTex = frame.getInputTexture(node.id, 'in_a');
        const bTex = frame.getInputTexture(node.id, 'in_b');
        const lightenTex = frame.getInputTexture(node.id, 'lighten');
        const darkenTex = frame.getInputTexture(node.id, 'darken');

        const delayFrames = backdraftDelayFrames(params.delay, BACKDRAFT_BUFFER_FRAMES);
        const tapIdx = backdraftTapIndex(head, delayFrames, BACKDRAFT_BUFFER_FRAMES);
        // Cold start: until we've written at least `delayFrames` frames the
        // tap slot is still its cleared (black) initial state — read the
        // sentinel so the loop starts from zero feedback.
        const fbTex = framesElapsed >= delayFrames ? ring[tapIdx]!.texture : emptyTex;

        const dst = ring[head]!;
        g.bindFramebuffer(g.FRAMEBUFFER, dst.fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);

        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, aTex ?? emptyTex);
        g.uniform1i(uA, 0);
        g.uniform1f(uHasA, aTex ? 1.0 : 0.0);

        g.activeTexture(g.TEXTURE1);
        g.bindTexture(g.TEXTURE_2D, bTex ?? emptyTex);
        g.uniform1i(uB, 1);
        g.uniform1f(uHasB, bTex ? 1.0 : 0.0);

        g.activeTexture(g.TEXTURE2);
        g.bindTexture(g.TEXTURE_2D, fbTex);
        g.uniform1i(uFb, 2);
        g.uniform1f(uHasFb, framesElapsed >= delayFrames ? 1.0 : 0.0);

        g.activeTexture(g.TEXTURE3);
        g.bindTexture(g.TEXTURE_2D, lightenTex ?? emptyTex);
        g.uniform1i(uLighten, 3);
        g.uniform1f(uHasLighten, lightenTex ? 1.0 : 0.0);

        g.activeTexture(g.TEXTURE4);
        g.bindTexture(g.TEXTURE_2D, darkenTex ?? emptyTex);
        g.uniform1i(uDarken, 4);
        g.uniform1f(uHasDarken, darkenTex ? 1.0 : 0.0);

        g.uniform1f(uMix,         Math.max(0, Math.min(1, params.mix)));
        g.uniform1f(uFeedback,    Math.max(0, Math.min(BACKDRAFT_MAX_FEEDBACK, params.feedback)));
        g.uniform1f(uLuma,        params.luma);
        g.uniform1f(uChroma,      params.chroma);
        g.uniform1f(uR,           params.r);
        g.uniform1f(uG,           params.g);
        g.uniform1f(uBlue,        params.b);
        g.uniform1f(uLightenKnob, Math.max(0, Math.min(1, params.lighten)));
        g.uniform1f(uDarkenKnob,  Math.max(0, Math.min(1, params.darken)));

        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);

        // Publish the just-written output, then advance the ring head.
        surface.texture = dst.texture;
        surface.fbo = dst.fbo;
        head = (head + 1) % BACKDRAFT_BUFFER_FRAMES;
        framesElapsed++;
      },
      dispose() {
        for (const r of ring) {
          gl.deleteFramebuffer(r.fbo);
          gl.deleteTexture(r.texture);
        }
        gl.deleteTexture(emptyTex);
        gl.deleteProgram(program);
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
        if (key === 'fboTexture') return surface.texture;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
