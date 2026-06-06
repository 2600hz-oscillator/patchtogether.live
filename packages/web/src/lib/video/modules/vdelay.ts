// packages/web/src/lib/video/modules/vdelay.ts
//
// VDELAY — video delay + feedback echo. Visual analog to CHARLOTTE'S
// ECHOS for the audio domain.
//
// Model:
//   - Pre-allocates BUFFER_FRAMES + 1 RGBA8 framebuffer textures arranged as
//     a ring. Each frame, a "write" pass renders into the head slot:
//
//         buffer[head] = input + buffer[head - delayTime] * feedback
//
//     i.e. each slot is the input plus a feedback-attenuated copy of the
//     slot one delayTime ago. Read tap is buffer[head - delayTime] —
//     same slot the write pass mixed in. The visible output is then:
//
//         out = mix(input, delayed_tap, mix_amount)
//
//     Two passes per frame: WRITE (input + feedback echo into ring head),
//     COMPOSE (input + delayed_tap → output FBO). The compose pass also
//     applies optional per-echo color tint (colorShift) by lerping the
//     delayed sample's hue toward a fixed target — visual interest knob.
//
// Why a ring + feedback-into-head (not a separate accumulator):
//   - Discrete-frame delay semantics: at delayTime=N, the visible echo
//     is exactly N frames old. A pure feedback accumulator smears
//     across all frames; the user wants "this frame, then N frames
//     later, then 2N, then 3N..." which is what feedback-into-ring
//     gives.
//   - Memory bound: BUFFER_FRAMES textures × 640×480×4B ≈ 1.2MB per
//     slot, ~40 MB total. Well under modest GPU budgets.
//
// CV inputs:
//   - time_cv     -1..+1 sweeps full delayTime range (1..MAX_FRAMES)
//   - feedback_cv -1..+1 sweeps 0..0.95 (capped below 1 to avoid runaway)
//   - mix_cv      -1..+1 sweeps 0..1 (dry → wet)
//
// CV scaling: cvScale 'linear' on each input — bridge maps -1..+1 to the
// target param's full natural range and sums it on top of the knob.
//
// Inputs:
//   in (video): RGB source.
//   time_cv / feedback_cv / mix_cv (cv, linear, paramTarget=…): per-param CV.
//
// Outputs:
//   out (video): wet + dry mix.
//
// Params:
//   delayTime (linear 1..VDELAY_MAX_DELAY frames): delay in frames.
//   feedback (linear 0..0.95): feedback ratio (capped below 1).
//   mix (linear 0..1): dry/wet mix.
//   colorShift (linear 0..1): per-tap colour shift on the feedback path.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import {
  BUFFER_RES_SD,
  BUFFER_RES_1080,
  clampBufferResValue,
  effectiveBufferDims,
} from '$lib/video/buffer-res';

/** Ring buffer depth. 32 frames at 60fps = ~533ms max delay. Fits on a
 *  modest GPU at 640×480 (≈ 40 MB total — see header). */
export const VDELAY_BUFFER_FRAMES = 32;
export const VDELAY_MAX_DELAY = VDELAY_BUFFER_FRAMES; // user-facing cap

const WRITE_FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uIn;       // current input
uniform sampler2D uTap;      // ring slot at (head - delayTime)
uniform float uHasInput;
uniform float uFeedback;     // 0..0.95
uniform float uColorShift;   // 0..1 — blend each echo's color toward target

void main() {
  vec3 src = uHasInput > 0.5 ? texture(uIn, vUv).rgb : vec3(0.0);
  vec3 echo = texture(uTap, vUv).rgb * uFeedback;

  // Tint the echo slightly to give "color shift each repeat". Target is
  // a warm magenta — chosen for visual interest, not a science.
  vec3 tintTarget = vec3(0.9, 0.3, 0.7);
  echo = mix(echo, echo * tintTarget, clamp(uColorShift, 0.0, 1.0));

  // Slot value = input + echoed-and-tinted previous tap. Clamped so a
  // feedback near 1 + bright source doesn't blow past 1.0 on the slot.
  vec3 acc = src + echo;
  outColor = vec4(clamp(acc, 0.0, 1.0), 1.0);
}`;

const COMPOSE_FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uIn;
uniform sampler2D uTap;
uniform float uHasInput;
uniform float uMix;          // 0..1 — dry→wet

void main() {
  vec3 src = uHasInput > 0.5 ? texture(uIn, vUv).rgb : vec3(0.0);
  vec3 echo = texture(uTap, vUv).rgb;
  vec3 mixed = mix(src, echo, clamp(uMix, 0.0, 1.0));
  outColor = vec4(clamp(mixed, 0.0, 1.0), 1.0);
}`;

interface VdelayParams {
  delayTime: number;   // 1..VDELAY_MAX_DELAY frames
  feedback: number;    // 0..0.95
  mix: number;         // 0..1
  colorShift: number;  // 0..1
}

const DEFAULTS: VdelayParams = {
  delayTime: 8,
  feedback: 0.4,
  mix: 0.5,
  colorShift: 0,
};

/**
 * Pure ring-buffer math. Used in unit tests to verify the index logic
 * without booting a GL context.
 *
 * Returns the slot index that should be SAMPLED at the given head /
 * delayTime. Caller writes to `head` next, so the read tap is always
 * `(head - delayTime + size) % size` — clamped delayTime to [1, size-1]
 * so we never alias a tap onto the slot we're about to overwrite.
 */
export function vdelayTapIndex(head: number, delayTime: number, size: number): number {
  if (size <= 0) throw new Error('vdelayTapIndex: size must be positive');
  const dt = Math.max(1, Math.min(size - 1, Math.floor(delayTime)));
  return ((head - dt) % size + size) % size;
}

/**
 * Pure feedback math: given an input level + previous tap level (both
 * 0..1), returns the slot value that the WRITE pass would produce.
 * Mirrors the shader's clamp at 1.0.
 */
export function vdelaySlotValue(input: number, tap: number, feedback: number): number {
  const fb = Math.max(0, Math.min(0.95, feedback));
  return Math.min(1, Math.max(0, input + tap * fb));
}

/**
 * Pure dry/wet mix: returns mix(input, tap, mixAmount).
 */
export function vdelayMix(input: number, tap: number, mixAmount: number): number {
  const m = Math.max(0, Math.min(1, mixAmount));
  return input * (1 - m) + tap * m;
}

export const vdelayDef: VideoModuleDef = {
  type: 'vdelay',
  palette: { top: 'Video modules', sub: 'Processors' },
  domain: 'video',
  label: 'VDELAY',
  category: 'effects',
  schemaVersion: 1,
  inputs: [
    { id: 'in',          type: 'video' },
    { id: 'time_cv',     type: 'cv', paramTarget: 'delayTime', cvScale: { mode: 'linear' } },
    { id: 'feedback_cv', type: 'cv', paramTarget: 'feedback',  cvScale: { mode: 'linear' } },
    { id: 'mix_cv',      type: 'cv', paramTarget: 'mix',       cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    { id: 'delayTime',  label: 'Time',     defaultValue: DEFAULTS.delayTime,  min: 1, max: VDELAY_MAX_DELAY, curve: 'linear' },
    { id: 'feedback',   label: 'Feedback', defaultValue: DEFAULTS.feedback,   min: 0, max: 0.95,             curve: 'linear' },
    { id: 'mix',        label: 'Mix',      defaultValue: DEFAULTS.mix,        min: 0, max: 1,                curve: 'linear' },
    { id: 'colorShift', label: 'Color',    defaultValue: DEFAULTS.colorShift, min: 0, max: 1,                curve: 'linear' },
    // HD per-module heavy-buffer res (0=SD/1=720p/2=1080p). Default SD even in
    // HD; 720/1080 only honored when global HD is on locally (hd-toggle §4.5).
    { id: 'bufferRes',  label: 'Res',      defaultValue: BUFFER_RES_SD,       min: BUFFER_RES_SD, max: BUFFER_RES_1080, curve: 'linear' },
  ],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const writeProgram   = ctx.compileFragment(WRITE_FRAG_SRC);
    const composeProgram = ctx.compileFragment(COMPOSE_FRAG_SRC);

    const wIn         = gl.getUniformLocation(writeProgram, 'uIn');
    const wTap        = gl.getUniformLocation(writeProgram, 'uTap');
    const wHas        = gl.getUniformLocation(writeProgram, 'uHasInput');
    const wFeedback   = gl.getUniformLocation(writeProgram, 'uFeedback');
    const wColorShift = gl.getUniformLocation(writeProgram, 'uColorShift');

    const cIn  = gl.getUniformLocation(composeProgram, 'uIn');
    const cTap = gl.getUniformLocation(composeProgram, 'uTap');
    const cHas = gl.getUniformLocation(composeProgram, 'uHasInput');
    const cMix = gl.getUniformLocation(composeProgram, 'uMix');

    // Heavy-buffer res: the ring (the VRAM-hungry part — 32 RGBA8 frames) is
    // sized at the per-module bufferRes, clamped to SD whenever global HD is off
    // locally (hd-toggle §4.5). Output stays engine-res; the ring is upscaled on
    // read via UV sampling. Read once at construction (a change re-adds the node,
    // like any ring-size change). createSizedFbo is optional on the interface —
    // a test mock without it falls back to engine-res createFbo.
    const bufferRes = clampBufferResValue(node.params?.bufferRes);
    const bufDims = effectiveBufferDims(bufferRes, ctx.hdActive ?? false, ctx.res);
    const makeRingFbo = ctx.createSizedFbo
      ? () => ctx.createSizedFbo!(bufDims.width, bufDims.height)
      : () => ctx.createFbo();

    // Ring buffer of FBOs (at bufferRes).
    const ring: { fbo: WebGLFramebuffer; texture: WebGLTexture }[] = [];
    for (let i = 0; i < VDELAY_BUFFER_FRAMES; i++) ring.push(makeRingFbo());

    // Output FBO — what surface.texture publishes to downstream modules.
    const out = ctx.createFbo();

    // 1×1 black sentinel — bound when the ring slot we'd read is itself
    // empty (cold start). Avoids GL feedback loops by NOT binding our
    // own output as input.
    const emptyTex = gl.createTexture();
    if (!emptyTex) throw new Error('VDELAY: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const params: VdelayParams = { ...DEFAULTS, ...(node.params as Partial<VdelayParams>) };
    let head = 0;
    let framesElapsed = 0;

    const surface: VideoNodeSurface = {
      fbo: out.fbo,
      texture: out.texture,
      draw(frame) {
        const g = frame.gl;
        const inputTex = frame.getInputTexture(node.id, 'in');

        const dt = Math.max(1, Math.min(VDELAY_BUFFER_FRAMES - 1, Math.floor(params.delayTime)));
        const tapIdx = vdelayTapIndex(head, dt, VDELAY_BUFFER_FRAMES);

        // Cold-start guard: when the buffer hasn't been written enough
        // frames to fill the tap distance, the tap slot is still its
        // initial cleared state (transparent black), which reads as zero
        // — no echo until the buffer fills. That's correct behavior; we
        // just bind the empty sentinel until the first real write.
        const tapTexture = framesElapsed > 0 ? ring[tapIdx]!.texture : emptyTex;

        // ---- WRITE pass: ring[head] = input + feedback*tap ----
        // Rendered at the ring's bufferRes (not engine res) — the ring slots are
        // bufDims-sized; the input/tap textures are sampled by UV so size
        // differences upscale/downscale cleanly.
        const writeSlot = ring[head]!;
        g.bindFramebuffer(g.FRAMEBUFFER, writeSlot.fbo);
        g.viewport(0, 0, bufDims.width, bufDims.height);
        g.useProgram(writeProgram);

        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, inputTex ?? emptyTex);
        g.uniform1i(wIn, 0);
        g.uniform1f(wHas, inputTex ? 1.0 : 0.0);

        g.activeTexture(g.TEXTURE1);
        g.bindTexture(g.TEXTURE_2D, tapTexture);
        g.uniform1i(wTap, 1);

        g.uniform1f(wFeedback,   Math.max(0, Math.min(0.95, params.feedback)));
        g.uniform1f(wColorShift, Math.max(0, Math.min(1, params.colorShift)));

        ctx.drawFullscreenQuad();

        // ---- COMPOSE pass: out = mix(input, tap, mix) ----
        g.bindFramebuffer(g.FRAMEBUFFER, out.fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(composeProgram);

        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, inputTex ?? emptyTex);
        g.uniform1i(cIn, 0);
        g.uniform1f(cHas, inputTex ? 1.0 : 0.0);

        g.activeTexture(g.TEXTURE1);
        g.bindTexture(g.TEXTURE_2D, tapTexture);
        g.uniform1i(cTap, 1);

        g.uniform1f(cMix, Math.max(0, Math.min(1, params.mix)));

        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);

        head = (head + 1) % VDELAY_BUFFER_FRAMES;
        framesElapsed++;
      },
      dispose() {
        for (const r of ring) {
          gl.deleteFramebuffer(r.fbo);
          gl.deleteTexture(r.texture);
        }
        gl.deleteFramebuffer(out.fbo);
        gl.deleteTexture(out.texture);
        gl.deleteTexture(emptyTex);
        gl.deleteProgram(writeProgram);
        gl.deleteProgram(composeProgram);
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
      dispose() { surface.dispose(); },
    };
  },
};
