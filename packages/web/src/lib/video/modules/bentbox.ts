// packages/web/src/lib/video/modules/bentbox.ts
//
// BENTBOX — CRT display output that simulates an NTSC composite signal
// fed through an Archer-Video-Enhancer-style "AVEmod" bending circuit.
//
// Spec aesthetic (from user brief 2026-05-18):
//   - A virtual CRT being driven by a hand-bent analog composite line.
//   - Composite glitches are TIMING glitches, not pixel glitches: encode
//     the input to a fake composite signal, distort the timing/phase,
//     decode back to RGB, then render through a CRT phosphor mask with
//     scanline gaps + bloom.
//   - 240p source field per 60Hz output (480i interlaced visually);
//     resizeable card (mirror VIDEOOUT's resize plumbing). The card
//     ALWAYS displays at 4:3 letterboxed inside its resizable bounds.
//   - 12 CV-controllable bending knobs (timing, chroma, feedback, CRT).
//
// Pipeline (single fragment shader, one pass):
//   1. Resample input to a 240-line raster (snap-to-line via floor()).
//   2. Per-line horizontal offset (hsync_drift, hsync_loss, scan_wobble).
//   3. Convert sampled RGB → YIQ (NTSC analog colorspace).
//   4. Modulate Q+I onto a virtual 3.579545 MHz chroma subcarrier (we
//      model phase only, not the literal carrier — this is the math
//      that gives convincing chroma corruption when phase is wiggled).
//   5. Wavefolding waveshaper on the composite voltage — overdrives
//      gain stages and folds back, creating ghosting + color tearing.
//   6. Demodulate back to YIQ → RGB, with a chroma_phase rotation.
//   7. Mix with previous frame texture (ping-pong feedback) for
//      recursive image accumulation.
//   8. Apply CRT effects: scanline gap mask, phosphor RGB-triad mask,
//      bloom on bright pixels, mild Gaussian-ish blur for "soft pixels".
//
// Pure-math helpers (rgbToYiq / yiqToRgb / wavefold) are unit-tested.
// The shader is the only renderer; it ports the same math to GLSL.
//
// Field interlace:
//   The visual model: each 60Hz tick draws ONE field (odd or even
//   scanlines). The shader takes a uFieldParity uniform (0 or 1) and
//   shifts the scanline mask phase by half a line. At rest this looks
//   like a single 240p frame; under hsync_loss the two fields decouple
//   and "tear" against each other — same as a real CRT losing vlock.
//
// Attribution: the YIQ matrix + 3.579545 MHz NTSC subcarrier constant
// are public-domain physics. Algorithm shape inspired by LMP88959's
// MIT-licensed NTSC-CRT (https://github.com/LMP88959/NTSC-CRT) and the
// classic Blargg ntsc filter (MIT, ~2003), but no code copied — both
// referenced for the chroma demod approach (sin/cos at carrier
// frequency, then low-pass on Y).

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

// ---------- pure helpers (unit-testable) ----------

/** RGB (0..1) -> YIQ (Y in 0..1; I and Q roughly in [-0.6, 0.6]).
 *  Standard NTSC matrix from FCC RS-170A. */
export function rgbToYiq(r: number, g: number, b: number): { y: number; i: number; q: number } {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const i = 0.596 * r - 0.274 * g - 0.322 * b;
  const q = 0.211 * r - 0.523 * g + 0.312 * b;
  return { y, i, q };
}

/** YIQ -> RGB (clamped to 0..1). Inverse of rgbToYiq. */
export function yiqToRgb(y: number, i: number, q: number): { r: number; g: number; b: number } {
  const r = y + 0.956 * i + 0.621 * q;
  const g = y - 0.272 * i - 0.647 * q;
  const b = y - 1.106 * i + 1.703 * q;
  return {
    r: Math.max(0, Math.min(1, r)),
    g: Math.max(0, Math.min(1, g)),
    b: Math.max(0, Math.min(1, b)),
  };
}

/** Wavefolding waveshaper. Standard Buchla-style triangle fold:
 *  for amount > 0, voltages above 1 (or below -1) fold back. At
 *  amount=0 it's identity. Used both on luma (creates ghost edges)
 *  and on the modeled composite waveform (the AVEmod aesthetic). */
export function wavefold(v: number, amount: number): number {
  if (amount <= 0) return v;
  // Scale voltage up by (1 + amount * 3) so even modest amount values
  // push the signal past unity and start folding. Then triangle-fold
  // back into [-1, 1] using the sawtooth-of-sin trick.
  const scaled = v * (1 + amount * 3);
  // Triangle wave from sawtooth: 4*|x/2 - floor(x/2 + 0.5)| - 1 maps
  // sawtooth → triangle. We want the unfolded portion to stay linear,
  // so use a piecewise: identity in [-1,1], fold above.
  const t = ((((scaled + 1) % 4) + 4) % 4) - 1; // map to [-1, 3) then shift
  return t > 1 ? 2 - t : t < -1 ? -2 - t : t;
}

/** Soft-clip via tanh approximation. Used on the final composite
 *  signal voltage to keep wavefolded values from blowing past +/-1
 *  in a way that decodes as white-clipping rather than musical
 *  saturation. */
export function softClip(v: number): number {
  // tanh approximation that's monotonic + smooth + cheap.
  const v2 = v * v;
  return v * (27 + v2) / (27 + 9 * v2);
}

// ---------- shader ----------

// All-in-one fragment shader. Takes the input texture, previous-frame
// feedback texture, and 12 uniforms for the bending params. Outputs
// the final CRT-rendered RGB.
const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uIn;
uniform sampler2D uPrev;
uniform float     uHasInput;
uniform float     uTime;          // seconds, for noise drift
uniform float     uFieldParity;   // 0 or 1 — odd/even field this frame

// Timing
uniform float uHsyncDrift;        // 0..1
uniform float uHsyncLoss;         // 0..1
uniform float uVsyncDrift;        // 0..1
uniform float uScanWobble;        // 0..1

// Chroma
uniform float uChromaPhase;       // -1..+1 (radians/2π scale)
uniform float uChromaInstability; // 0..1

// Feedback / wavefolding
uniform float uFeedbackGain;      // 0..1
uniform float uFeedbackDelay;     // 0..1 (sub-frame: shifts which lines/fields are recirculated)
uniform float uWavefold;          // 0..1

// CRT
uniform float uBloom;             // 0..1
uniform float uNoise;             // 0..1
uniform float uMasterGain;        // 0..2

const float LINES = 240.0;        // 240p effective vertical resolution
const float TWO_PI = 6.2831853;

// Cheap deterministic noise. Not a hash function — good enough for
// per-line jitter that animates with uTime.
float hash11(float n) {
  return fract(sin(n * 78.233) * 43758.5453);
}
float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

vec3 rgb2yiq(vec3 c) {
  return vec3(
    0.299 * c.r + 0.587 * c.g + 0.114 * c.b,
    0.596 * c.r - 0.274 * c.g - 0.322 * c.b,
    0.211 * c.r - 0.523 * c.g + 0.312 * c.b
  );
}
vec3 yiq2rgb(vec3 c) {
  return clamp(vec3(
    c.x + 0.956 * c.y + 0.621 * c.z,
    c.x - 0.272 * c.y - 0.647 * c.z,
    c.x - 1.106 * c.y + 1.703 * c.z
  ), 0.0, 1.0);
}

// Triangle wavefolder applied per-channel to a composite-ish voltage.
float wavefold(float v, float amt) {
  if (amt <= 0.0) return v;
  float s = v * (1.0 + amt * 3.0);
  float t = mod(s + 1.0, 4.0) - 1.0;
  if (t > 1.0) return 2.0 - t;
  if (t < -1.0) return -2.0 - t;
  return t;
}

float softClip(float v) {
  float v2 = v * v;
  return v * (27.0 + v2) / (27.0 + 9.0 * v2);
}

void main() {
  if (uHasInput < 0.5) {
    // Idle pattern when nothing is patched in: a dim sweeping color
    // bar field so the user sees BENTBOX is alive. Matches VIDEOOUT's
    // pattern aesthetic.
    float v = vUv.y * 0.05;
    outColor = vec4(0.04, 0.06, 0.10 + v, 1.0);
    return;
  }

  // ---- Snap to scanline ----
  // 240p effective vertical resolution. Round vUv.y down to the
  // nearest scanline center so subsequent per-line distortions all
  // share the same line index.
  float lineIdx = floor(vUv.y * LINES);
  float lineY = (lineIdx + 0.5) / LINES;

  // ---- Per-line horizontal sync drift ----
  // The signal source is fine; the CRT's beam-position-vs-time tracking
  // wanders. Each scanline starts at a slightly different X. Combined
  // hsync_drift (high-freq, per-line) + scan_wobble (low-freq, swept).
  float driftRand = (hash11(lineIdx + floor(uTime * 12.0)) - 0.5) * 2.0;
  float hWobble = sin(lineIdx * 0.21 + uTime * 1.7) * uScanWobble * 0.06;
  float hOffset = driftRand * uHsyncDrift * 0.12 + hWobble;

  // ---- Hsync loss: random scanlines lose lock entirely, displacing
  // far. Acts as discrete tears rather than smooth drift. ----
  float lossRoll = hash11(lineIdx * 1.913 + floor(uTime * 3.7));
  if (lossRoll < uHsyncLoss * 0.18) {
    hOffset += (hash11(lineIdx * 7.91 + uTime) - 0.5) * 0.6;
  }

  // ---- Vsync drift: vertical scroll over time ----
  float vOff = sin(uTime * 0.7) * uVsyncDrift * 0.4
             + (uTime * uVsyncDrift * 0.05);
  // Y-flip the input-texture sample so the CRT renders upstream video
  // right-side up. WebGL FBOs have a bottom-left origin and BentboxCard's
  // 2D-canvas blit applies a Y-flip; sampling the input at (1 - lineY)
  // keeps that final blit upright. Internal FBO state (uPrev / scanline
  // mask) is unaffected because it's all expressed in vUv space.
  vec2 sampleUv = vec2(fract(vUv.x + hOffset), fract(1.0 - lineY - vOff));

  // ---- Sample input ----
  vec3 srcRgb = texture(uIn, sampleUv).rgb;

  // ---- Convert to YIQ (NTSC analog colorspace) ----
  vec3 yiq = rgb2yiq(srcRgb);

  // ---- Chroma phase rotation: hue shift in IQ plane.
  // Constant rotation (chroma_phase) + per-line noise (instability). ----
  float phaseNoise = (hash11(lineIdx * 2.31 + uTime * 0.9) - 0.5) * uChromaInstability;
  float ang = (uChromaPhase + phaseNoise) * TWO_PI;
  float ca = cos(ang);
  float sa = sin(ang);
  vec2 iq = vec2(yiq.y * ca - yiq.z * sa, yiq.y * sa + yiq.z * ca);
  yiq.y = iq.x;
  yiq.z = iq.y;

  // ---- Composite "voltage" = Y + chroma carrier (modeled as scalar).
  // Wavefolding operates on this composite voltage — that's the AVEmod
  // signature: overdriving the signal stage folds the wave back,
  // creating harmonic-rich ghost edges that decode as color tearing. ----
  float comp = yiq.x + (iq.x + iq.y) * 0.5;
  comp = wavefold(comp, uWavefold);
  comp = softClip(comp * uMasterGain);

  // Reconstruct Y by subtracting the (un-folded) chroma estimate. The
  // missing high-frequency content from wavefolding leaks INTO Y, which
  // is the desired "white smear" effect. We blend old yiq.x with comp
  // proportionally to wavefold so the effect ramps in cleanly.
  yiq.x = mix(yiq.x, comp - (iq.x + iq.y) * 0.5, uWavefold * 0.7 + uMasterGain * 0.1);

  vec3 decoded = yiq2rgb(yiq);

  // ---- Feedback: blend previous frame.
  // Delay shifts the sampling Y position so larger delay values pull
  // from previous scanlines, creating line-level vs field-level
  // recursion (the analog feedback is "alive" because the delay isn't
  // exactly one frame). ----
  vec2 prevUv = vec2(sampleUv.x, fract(sampleUv.y + uFeedbackDelay * 0.04 - 0.02));
  vec3 prev = texture(uPrev, prevUv).rgb;
  decoded = mix(decoded, max(decoded, prev), uFeedbackGain);

  // ---- CRT bloom on bright pixels (cheap luma-weighted boost) ----
  if (uBloom > 0.0) {
    float luma = dot(decoded, vec3(0.299, 0.587, 0.114));
    float bloomBoost = smoothstep(0.6, 1.0, luma) * uBloom * 0.5;
    decoded += bloomBoost;
  }

  // ---- Scanline gap mask (240p look). Field parity offsets the gap
  // by half a line so interlaced fields don't both darken the same
  // pixels. ----
  float lineFrac = fract(vUv.y * LINES + uFieldParity * 0.5);
  float scanDark = 0.4 + 0.6 * smoothstep(0.0, 0.4, lineFrac) *
                                  smoothstep(1.0, 0.6, lineFrac);
  decoded *= scanDark;

  // ---- Phosphor RGB-triad mask. Every 3rd subpixel column favors a
  // primary, giving the soft-pixel CRT triad look at high resolutions. ----
  float col = floor(vUv.x * 240.0 * 3.0);
  float phase = mod(col, 3.0);
  vec3 mask = vec3(
    phase < 0.5 ? 1.15 : 0.85,
    phase >= 0.5 && phase < 1.5 ? 1.15 : 0.85,
    phase >= 1.5 ? 1.15 : 0.85
  );
  decoded *= mask;

  // ---- RF/film grain noise added LAST so it isn't soaked by the
  // feedback path (otherwise noise self-reinforces into a haze). ----
  if (uNoise > 0.0) {
    float n = hash21(vUv * vec2(740.0, 421.0) + uTime) - 0.5;
    decoded += vec3(n) * uNoise * 0.18;
  }

  outColor = vec4(clamp(decoded, 0.0, 1.0), 1.0);
}`;

// ---------- module def ----------

interface BentboxParams {
  hsync_drift: number;
  hsync_loss: number;
  vsync_drift: number;
  chroma_phase: number;
  chroma_instability: number;
  feedback_gain: number;
  feedback_delay: number;
  wavefold: number;
  scan_wobble: number;
  bloom: number;
  noise: number;
  master_gain: number;
}

const DEFAULTS: BentboxParams = {
  hsync_drift: 0,
  hsync_loss: 0,
  vsync_drift: 0,
  chroma_phase: 0,
  chroma_instability: 0,
  feedback_gain: 0,
  feedback_delay: 0,
  wavefold: 0,
  scan_wobble: 0,
  bloom: 0.4,        // mild glow even at rest — CRTs always have some
  noise: 0.05,       // tiny baseline grain
  master_gain: 1,
};

export const bentboxDef: VideoModuleDef = {
  type: 'bentbox',
  domain: 'video',
  label: 'BENTBOX',
  category: 'output',
  schemaVersion: 1,
  inputs: [
    { id: 'in',                   type: 'video' },
    { id: 'hsync_drift_cv',       type: 'cv', paramTarget: 'hsync_drift',        cvScale: { mode: 'linear' } },
    { id: 'hsync_loss_cv',        type: 'cv', paramTarget: 'hsync_loss',         cvScale: { mode: 'linear' } },
    { id: 'vsync_drift_cv',       type: 'cv', paramTarget: 'vsync_drift',        cvScale: { mode: 'linear' } },
    { id: 'chroma_phase_cv',      type: 'cv', paramTarget: 'chroma_phase',       cvScale: { mode: 'linear' } },
    { id: 'chroma_instability_cv',type: 'cv', paramTarget: 'chroma_instability', cvScale: { mode: 'linear' } },
    { id: 'feedback_gain_cv',     type: 'cv', paramTarget: 'feedback_gain',      cvScale: { mode: 'linear' } },
    { id: 'feedback_delay_cv',    type: 'cv', paramTarget: 'feedback_delay',     cvScale: { mode: 'linear' } },
    { id: 'wavefold_cv',          type: 'cv', paramTarget: 'wavefold',           cvScale: { mode: 'linear' } },
    { id: 'scan_wobble_cv',       type: 'cv', paramTarget: 'scan_wobble',        cvScale: { mode: 'linear' } },
    { id: 'bloom_cv',             type: 'cv', paramTarget: 'bloom',              cvScale: { mode: 'linear' } },
    { id: 'noise_cv',             type: 'cv', paramTarget: 'noise',              cvScale: { mode: 'linear' } },
    { id: 'master_gain_cv',       type: 'cv', paramTarget: 'master_gain',        cvScale: { mode: 'linear' } },
  ],
  outputs: [
    // Chainable pass-through of the bent CRT image, so users can stack
    // BENTBOX → another video processor (FEEDBACK, VDELAY, etc.).
    { id: 'out', type: 'video' },
  ],
  params: [
    { id: 'hsync_drift',        label: 'HS Drift',  defaultValue: DEFAULTS.hsync_drift,        min: 0,  max: 1, curve: 'linear' },
    { id: 'hsync_loss',         label: 'HS Loss',   defaultValue: DEFAULTS.hsync_loss,         min: 0,  max: 1, curve: 'linear' },
    { id: 'vsync_drift',        label: 'VS Drift',  defaultValue: DEFAULTS.vsync_drift,        min: 0,  max: 1, curve: 'linear' },
    { id: 'scan_wobble',        label: 'Wobble',    defaultValue: DEFAULTS.scan_wobble,        min: 0,  max: 1, curve: 'linear' },
    { id: 'chroma_phase',       label: 'Hue',       defaultValue: DEFAULTS.chroma_phase,       min: -1, max: 1, curve: 'linear' },
    { id: 'chroma_instability', label: 'Shimmer',   defaultValue: DEFAULTS.chroma_instability, min: 0,  max: 1, curve: 'linear' },
    { id: 'feedback_gain',      label: 'Feedback',  defaultValue: DEFAULTS.feedback_gain,      min: 0,  max: 1, curve: 'linear' },
    { id: 'feedback_delay',     label: 'Delay',     defaultValue: DEFAULTS.feedback_delay,     min: 0,  max: 1, curve: 'linear' },
    { id: 'wavefold',           label: 'Wavefold',  defaultValue: DEFAULTS.wavefold,           min: 0,  max: 1, curve: 'linear' },
    { id: 'bloom',              label: 'Bloom',     defaultValue: DEFAULTS.bloom,              min: 0,  max: 1, curve: 'linear' },
    { id: 'noise',              label: 'Noise',     defaultValue: DEFAULTS.noise,              min: 0,  max: 1, curve: 'linear' },
    { id: 'master_gain',        label: 'Gain',      defaultValue: DEFAULTS.master_gain,        min: 0,  max: 2, curve: 'linear' },
  ],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    // Uniform locations cached up front.
    const uIn          = gl.getUniformLocation(program, 'uIn');
    const uPrev        = gl.getUniformLocation(program, 'uPrev');
    const uHasInput    = gl.getUniformLocation(program, 'uHasInput');
    const uTime        = gl.getUniformLocation(program, 'uTime');
    const uFieldParity = gl.getUniformLocation(program, 'uFieldParity');

    const uHsyncDrift        = gl.getUniformLocation(program, 'uHsyncDrift');
    const uHsyncLoss         = gl.getUniformLocation(program, 'uHsyncLoss');
    const uVsyncDrift        = gl.getUniformLocation(program, 'uVsyncDrift');
    const uScanWobble        = gl.getUniformLocation(program, 'uScanWobble');
    const uChromaPhase       = gl.getUniformLocation(program, 'uChromaPhase');
    const uChromaInstability = gl.getUniformLocation(program, 'uChromaInstability');
    const uFeedbackGain      = gl.getUniformLocation(program, 'uFeedbackGain');
    const uFeedbackDelay     = gl.getUniformLocation(program, 'uFeedbackDelay');
    const uWavefold          = gl.getUniformLocation(program, 'uWavefold');
    const uBloom             = gl.getUniformLocation(program, 'uBloom');
    const uNoise             = gl.getUniformLocation(program, 'uNoise');
    const uMasterGain        = gl.getUniformLocation(program, 'uMasterGain');

    // Ping-pong FBOs for frame feedback. Each draw writes to the
    // "back" buffer, sampling the "front" as uPrev, then swaps. The
    // surface.texture pointer is updated at the end of draw() so
    // downstream modules sample the just-written frame.
    const fboA = ctx.createFbo();
    const fboB = ctx.createFbo();
    let frontIsA = true; // which FBO will be SAMPLED on the next draw

    // Tiny black sentinel for the cold-start case (avoids feedback
    // loops binding our own output as input).
    const emptyTex = gl.createTexture();
    if (!emptyTex) throw new Error('BENTBOX: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const params: BentboxParams = { ...DEFAULTS, ...(node.params as Partial<BentboxParams>) };
    let framesElapsed = 0;
    const startWallMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    const surface: VideoNodeSurface = {
      // surface.texture must be live — point it at whichever FBO holds
      // the most-recently-drawn frame. We update this AFTER draw().
      get fbo() { return frontIsA ? fboA.fbo : fboB.fbo; },
      get texture() { return frontIsA ? fboA.texture : fboB.texture; },
      draw(frame) {
        const g = frame.gl;
        const inputTex = frame.getInputTexture(node.id, 'in');

        // Read the front buffer (last frame's output) as uPrev, write
        // into the back buffer. Cold-start binds the empty sentinel.
        const writeTarget = frontIsA ? fboB : fboA;
        const prevTex = framesElapsed > 0 ? (frontIsA ? fboA.texture : fboB.texture) : emptyTex;

        g.bindFramebuffer(g.FRAMEBUFFER, writeTarget.fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);

        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, inputTex ?? emptyTex);
        g.uniform1i(uIn, 0);

        g.activeTexture(g.TEXTURE1);
        g.bindTexture(g.TEXTURE_2D, prevTex);
        g.uniform1i(uPrev, 1);

        g.uniform1f(uHasInput, inputTex ? 1.0 : 0.0);
        const tSec = ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - startWallMs) / 1000;
        g.uniform1f(uTime, tSec);
        g.uniform1f(uFieldParity, framesElapsed & 1 ? 1.0 : 0.0);

        const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
        const clampSym = (v: number) => Math.max(-1, Math.min(1, v));
        g.uniform1f(uHsyncDrift,        clamp01(params.hsync_drift));
        g.uniform1f(uHsyncLoss,         clamp01(params.hsync_loss));
        g.uniform1f(uVsyncDrift,        clamp01(params.vsync_drift));
        g.uniform1f(uScanWobble,        clamp01(params.scan_wobble));
        g.uniform1f(uChromaPhase,       clampSym(params.chroma_phase));
        g.uniform1f(uChromaInstability, clamp01(params.chroma_instability));
        g.uniform1f(uFeedbackGain,      clamp01(params.feedback_gain));
        g.uniform1f(uFeedbackDelay,     clamp01(params.feedback_delay));
        g.uniform1f(uWavefold,          clamp01(params.wavefold));
        g.uniform1f(uBloom,             clamp01(params.bloom));
        g.uniform1f(uNoise,             clamp01(params.noise));
        g.uniform1f(uMasterGain,        Math.max(0, Math.min(2, params.master_gain)));

        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);

        // The buffer we just wrote becomes the new front — that's what
        // surface.texture (via the getter) now points to, and what the
        // next draw will sample as uPrev.
        frontIsA = !frontIsA;
        framesElapsed++;
      },
      dispose() {
        gl.deleteFramebuffer(fboA.fbo);
        gl.deleteTexture(fboA.texture);
        gl.deleteFramebuffer(fboB.fbo);
        gl.deleteTexture(fboB.texture);
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
        if (key === 'hasInput') return framesElapsed > 0;
        if (key === 'fboTexture') return frontIsA ? fboA.texture : fboB.texture;
        if (key === 'framesElapsed') return framesElapsed;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
