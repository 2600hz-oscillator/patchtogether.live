// packages/web/src/lib/video/modules/freezeframe.ts
//
// FREEZEFRAME — video SAMPLE & HOLD with per-channel posterize.
//
// Two behaviours fused into one module:
//
//   1. SAMPLE & HOLD (the "freeze frame"):
//      - When NOTHING is patched to `gate_in`, the input video passes
//        through CONTINUOUSLY (live). This mirrors the audio S&H
//        convention where an unpatched gate means "track" / passthrough.
//      - When SOMETHING IS patched to `gate_in`, the module captures the
//        CURRENT input frame into a hold buffer ONLY WHILE the gate is
//        HIGH, and FREEZES the last-captured frame whenever the gate is
//        LOW. So:
//          * a continuously-high gate  → continuous update (looks live);
//          * an LFO square on the gate → plays while the gate is open,
//            freezes the instant it drops.
//        This is "capture-on-open-gate" sample & hold for video.
//
//      How we know whether `gate_in` is PATCHED: the cross-domain CV
//      bridge writes the gate level into our `gateLevel` param via
//      setParam EVERY FRAME while an edge exists (see VideoEngine.
//      tickCvBridges). When nothing is patched, setParam('gateLevel') is
//      never called. We record the engine frame index on each gate write
//      and compare it to the current draw frame: if the gate was written
//      within the last GATE_PATCH_GRACE frames we treat it as patched.
//      This is the video-domain analogue of the "fall back to a default
//      when the input is unpatched" pattern (SKIFREE's mouse fallback for
//      an unpatched X/Y — here the fallback is "live passthrough").
//
//   2. PER-CHANNEL POSTERIZE (colour-depth reducer):
//      Four QUANT knobs (quant_r / quant_g / quant_b / quant_luma) each
//      reduce the colour depth of ONE channel. The knob sweep maps to a
//      quantization step count:
//          7:00 / min (0.0)   → 256 levels (passthrough, full depth)
//          midway     (0.5)   → 32 levels
//          max        (1.0)   → 2 levels (on/off)
//      With all four at max the combined image is ~posterized to a few
//      bits per channel. The mapping is geometric in log2(levels) so the
//      step count is STRICTLY monotonic-decreasing across the sweep and
//      hits 256 / 32 / 2 exactly at 0 / 0.5 / 1.
//
// Outputs (all video):
//   video_out : the R/G/B channels recombined WITH their per-channel
//               quantization applied (the QUANT-luma knob ALSO applies to
//               the combined output as an overall luma posterize, so the
//               luma knob isn't a dead control on `video_out`).
//   r_out / g_out / b_out : the single quantized channel rendered as an
//               intensity image (grey: that channel in all three RGB).
//   luma_out  : the quantized Rec.601 luma rendered as an intensity image.
//
// Inputs:
//   video_in (video) : the source frame.
//   gate_in (gate)   : sample-&-hold gate. Unpatched = live passthrough.
//
// Params:
//   quant_r / quant_g / quant_b / quant_luma (linear 0..1): per-channel
//     posterize amount (0 = full depth, 1 = 2 levels). See QUANT mapping.
//   gateLevel (hidden, linear 0..1): synthetic param the CV bridge drives
//     with the live gate value. Not a knob — rendered only as the cv jack.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

// ----------------------------------------------------------------------
// Pure math — exported for unit tests (no GL).
// ----------------------------------------------------------------------

/** Full 8-bit colour depth. */
export const QUANT_MAX_LEVELS = 256;
/** Mid-sweep level count (knob = 0.5). */
export const QUANT_MID_LEVELS = 32;
/** Minimum level count (knob = max): on/off. */
export const QUANT_MIN_LEVELS = 2;

/** Rec.601 luma weights — same as LUMA / the GLSL `dot()` below. */
export const LUMA_WEIGHTS = { r: 0.299, g: 0.587, b: 0.114 } as const;

/**
 * Map a QUANT knob value (0..1) to a quantization STEP COUNT.
 *
 * Geometric in log2(levels) so the result is strictly monotonic and lands
 * on the spec's anchor points exactly:
 *     knob 0.0 → 256 levels  (log2 = 8)
 *     knob 0.5 →  32 levels  (log2 = 5)
 *     knob 1.0 →   2 levels  (log2 = 1)
 * Two linear segments in log2 space (8→5 over [0,0.5], 5→1 over [0.5,1]).
 *
 * The returned value is a continuous (non-integer) level count: the GLSL
 * `floor(c * levels) / (levels - 1)` posterizer accepts any real ≥ 2, and
 * keeping it continuous makes a CV sweep of the knob smooth. Callers that
 * need an integer step count (display / discrete tests) can round it.
 */
export function quantLevels(knob: number): number {
  const k = Math.min(1, Math.max(0, knob));
  const LOG_MAX = Math.log2(QUANT_MAX_LEVELS); // 8
  const LOG_MID = Math.log2(QUANT_MID_LEVELS); // 5
  const LOG_MIN = Math.log2(QUANT_MIN_LEVELS); // 1
  let logLevels: number;
  if (k <= 0.5) {
    // 0..0.5 : 8 → 5
    logLevels = LOG_MAX + (LOG_MID - LOG_MAX) * (k / 0.5);
  } else {
    // 0.5..1 : 5 → 1
    logLevels = LOG_MID + (LOG_MIN - LOG_MID) * ((k - 0.5) / 0.5);
  }
  return Math.pow(2, logLevels);
}

/**
 * Posterize a single normalized channel value (0..1) to `levels` steps.
 * Mirrors the GLSL `floor(c * levels) / (levels - 1)` with the same
 * clamping. `levels` is clamped to ≥ 2 so we never divide by 0.
 *
 * At levels = 256 this is effectively identity for 8-bit input (the only
 * difference is values land on the 256-step grid, which 8-bit input
 * already sits on). At levels = 2 it's a hard threshold to {0, 1}.
 */
export function posterizeChannel(value: number, levels: number): number {
  const v = Math.min(1, Math.max(0, value));
  const n = Math.max(2, levels);
  // floor(v * n) ranges 0..n (n only at v===1). Clamp the index to n-1 so
  // a full-white input maps to the top bucket, then normalize by n-1 so
  // the output spans the full 0..1 range.
  const idx = Math.min(n - 1, Math.floor(v * n));
  return idx / (n - 1);
}

/** Rec.601 luma of a normalized RGB triplet (each 0..1). */
export function lumaOf(r: number, g: number, b: number): number {
  return LUMA_WEIGHTS.r * r + LUMA_WEIGHTS.g * g + LUMA_WEIGHTS.b * b;
}

/** Gate threshold for "open" (capture) vs "closed" (freeze). */
export const GATE_HIGH_THRESHOLD = 0.5;

/**
 * Pure sample-&-hold decision: should THIS frame capture the live input
 * into the hold buffer (true) or freeze the last-held frame (false)?
 *
 *   - gate UNPATCHED → always capture (live passthrough);
 *   - gate PATCHED   → capture only while the gate is HIGH (level >= 0.5);
 *   - first frame    → always capture so the hold buffer seeds with real
 *     content (a frozen-on-spawn gate would otherwise show black).
 *
 * Exported so the freeze logic is unit-testable without a GL context.
 */
export function shouldCapture(
  gatePatched: boolean,
  gateLevel: number,
  holdSeeded: boolean,
): boolean {
  if (!holdSeeded) return true;       // seed the buffer on the first frame
  if (!gatePatched) return true;      // unpatched = live passthrough
  return gateLevel >= GATE_HIGH_THRESHOLD; // patched = capture while high
}

// ----------------------------------------------------------------------
// GLSL — combined + per-channel/luma isolate passes share one shader.
// `uMode` selects which output FBO this draw is producing.
// ----------------------------------------------------------------------

const MODE_COMBINED = 0; // recombined R/G/B, each channel posterized
const MODE_R = 1;        // R channel only, as intensity (grey)
const MODE_G = 2;        // G channel only
const MODE_B = 3;        // B channel only
const MODE_LUMA = 4;     // Rec.601 luma, posterized, as intensity (grey)

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform float uHasInput;
uniform float uMode;       // 0 combined, 1 R, 2 G, 3 B, 4 luma
uniform float uLevelsR;    // quant step count for R    (>= 2)
uniform float uLevelsG;    // quant step count for G
uniform float uLevelsB;    // quant step count for B
uniform float uLevelsLuma; // quant step count for luma

// Posterize one normalized channel to N levels. Matches posterizeChannel().
float posterize(float c, float levels) {
  float n = max(2.0, levels);
  float idx = min(n - 1.0, floor(c * n));
  return idx / (n - 1.0);
}

void main() {
  if (uHasInput < 0.5) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  vec3 src = texture(uTex, vUv).rgb;

  if (uMode < 0.5) {
    // Combined: each channel posterized at its own step count, then the
    // overall luma posterized too so QUANT LUMA shapes the combined out.
    vec3 q = vec3(
      posterize(src.r, uLevelsR),
      posterize(src.g, uLevelsG),
      posterize(src.b, uLevelsB)
    );
    // Apply the luma-depth reduction as a ratio so it can't shift hue.
    float luma = dot(q, vec3(0.299, 0.587, 0.114));
    float lumaSafe = max(luma, 1e-5);
    float lq = posterize(luma, uLevelsLuma);
    vec3 outRgb = clamp(q * (lq / lumaSafe), 0.0, 1.0);
    outColor = vec4(outRgb, 1.0);
    return;
  }
  if (uMode < 1.5) {
    float r = posterize(src.r, uLevelsR);
    outColor = vec4(r, r, r, 1.0);
    return;
  }
  if (uMode < 2.5) {
    float g = posterize(src.g, uLevelsG);
    outColor = vec4(g, g, g, 1.0);
    return;
  }
  if (uMode < 3.5) {
    float b = posterize(src.b, uLevelsB);
    outColor = vec4(b, b, b, 1.0);
    return;
  }
  // luma
  float luma = dot(src, vec3(0.299, 0.587, 0.114));
  float lq = posterize(luma, uLevelsLuma);
  outColor = vec4(lq, lq, lq, 1.0);
}`;

// Copy shader for the HOLD buffer: when the gate is HIGH (or unpatched →
// live), we capture the current input into the hold FBO; when LOW we skip
// the copy so the hold FBO retains its last contents (the "frozen" frame).
const COPY_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform float uHasInput;
void main() {
  outColor = uHasInput > 0.5 ? vec4(texture(uTex, vUv).rgb, 1.0)
                             : vec4(0.0, 0.0, 0.0, 1.0);
}`;

interface FreezeframeParams {
  quant_r: number;
  quant_g: number;
  quant_b: number;
  quant_luma: number;
  /** Hidden synthetic param driven by the gate CV bridge. */
  gateLevel: number;
}

const DEFAULTS: FreezeframeParams = {
  quant_r: 0,
  quant_g: 0,
  quant_b: 0,
  quant_luma: 0,
  gateLevel: 0,
};

/** How many engine frames a gate write stays "fresh" before we decide the
 *  gate input is unpatched again. 1 would be enough (the bridge writes
 *  every frame while patched) but a tiny grace absorbs a single dropped
 *  rAF tick so passthrough doesn't flicker on a momentary stall. */
export const GATE_PATCH_GRACE = 3;

export const freezeframeDef: VideoModuleDef = {
  type: 'freezeframe',
  palette: { top: 'Video modules', sub: 'Processors' },
  domain: 'video',
  label: 'freezeframe',
  category: 'effects',
  inputs: [
    { id: 'video_in', type: 'video' },
    // Gate input. paramTarget routes the gate CV through the cross-domain
    // bridge into setParam('gateLevel') every frame while patched — that
    // per-frame write is ALSO how we detect the gate is connected at all.
    { id: 'gate_in', type: 'gate', paramTarget: 'gateLevel' },
  ],
  outputs: [
    { id: 'video_out', type: 'video' },
    { id: 'r_out',     type: 'video' },
    { id: 'g_out',     type: 'video' },
    { id: 'b_out',     type: 'video' },
    { id: 'luma_out',  type: 'video' },
  ],
  params: [
    { id: 'quant_r',    label: 'QUANT R',    defaultValue: DEFAULTS.quant_r,    min: 0, max: 1, curve: 'linear' },
    { id: 'quant_g',    label: 'QUANT G',    defaultValue: DEFAULTS.quant_g,    min: 0, max: 1, curve: 'linear' },
    { id: 'quant_b',    label: 'QUANT B',    defaultValue: DEFAULTS.quant_b,    min: 0, max: 1, curve: 'linear' },
    { id: 'quant_luma', label: 'QUANT LUMA', defaultValue: DEFAULTS.quant_luma, min: 0, max: 1, curve: 'linear' },
    // Hidden synthetic gate param — the cv jack renders but no knob.
    { id: 'gateLevel',  label: 'GATE',       defaultValue: 0, min: 0, max: 1, curve: 'linear' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation: "FREEZEFRAME fuses two video effects in one card. First, a SAMPLE & HOLD \"freeze\": with nothing patched to GATE the source passes through live; patch a gate and the module captures the current frame only while the gate is HIGH (level >= 0.5) and FREEZES the last-captured frame whenever it drops low — so an LFO square plays while open and stutter-freezes the instant it closes (a continuously-high gate looks live). The first frame always captures so the buffer seeds with real content instead of black. Second, a PER-CHANNEL POSTERIZE: four QUANT knobs each reduce one channel's colour depth, mapping the sweep geometrically in log2 from 256 levels (full depth) at min, through 32 at midway, to 2 (on/off) at max — crank all four for a hard few-bit posterized look. The shader posterizes each channel with floor(c*levels)/(levels-1); the combined output also applies the QUANT-luma reduction as a hue-preserving luma ratio so that knob still shapes the main out. Five outputs let you tap the recombined image, each isolated channel as a grey intensity image, or the Rec.601 luma. Usage hint: drive GATE from an LFO or clock to strobe/freeze a video feed, then dial the QUANT knobs for VHS/8-bit colour crushing; fan the R/G/B/LUMA taps into separate processors for channel-split effects.",
    inputs: {
      video_in: "The source video frame fed into the sample-and-hold buffer and posterizer.",
      gate_in: "Sample-and-hold gate. Unpatched = continuous live passthrough; patched = captures a fresh frame only while the gate is HIGH (>= 0.5) and freezes the held frame while it is LOW. Reads on both edges as a gate, not a one-shot trigger.",
    },
    outputs: {
      video_out: "The recombined R/G/B image with each channel's posterize applied, plus the QUANT-LUMA reduction as a hue-preserving luma ratio. The card's on-screen preview shows this output.",
      r_out: "The posterized RED channel alone, rendered as a grey intensity image (R copied to all three channels).",
      g_out: "The posterized GREEN channel alone, rendered as a grey intensity image.",
      b_out: "The posterized BLUE channel alone, rendered as a grey intensity image.",
      luma_out: "The Rec.601 luma (0.299R+0.587G+0.114B), posterized by QUANT LUMA, rendered as a grey intensity image.",
    },
    controls: {
      quant_r: "QUANT R — posterize amount for the red channel. min = 256 levels (full depth / passthrough), midway = 32 levels, max = 2 levels (on/off). Affects video_out and r_out.",
      quant_g: "QUANT G — posterize amount for the green channel, 256 levels at min down to 2 at max. Affects video_out and g_out.",
      quant_b: "QUANT B — posterize amount for the blue channel, 256 levels at min down to 2 at max. Affects video_out and b_out.",
      quant_luma: "QUANT LUMA — posterize amount for the Rec.601 luma, 256 levels at min down to 2 at max. Drives luma_out and applies an overall luma-depth reduction to video_out as a hue-preserving ratio.",
      gateLevel: "GATE — hidden synthetic param the cross-domain CV bridge writes from gate_in every frame; it carries the live gate level into the sample-and-hold decision (and its per-frame write is how the module detects the gate is patched). Exposed only as the gate cv jack, not as a knob.",
    },
  },
  // docs-hash-ignore:end
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);
    const copyProgram = ctx.compileFragment(COPY_FRAG_SRC);

    const uTex        = gl.getUniformLocation(program, 'uTex');
    const uHasInput   = gl.getUniformLocation(program, 'uHasInput');
    const uMode       = gl.getUniformLocation(program, 'uMode');
    const uLevelsR    = gl.getUniformLocation(program, 'uLevelsR');
    const uLevelsG    = gl.getUniformLocation(program, 'uLevelsG');
    const uLevelsB    = gl.getUniformLocation(program, 'uLevelsB');
    const uLevelsLuma = gl.getUniformLocation(program, 'uLevelsLuma');

    const cTex = gl.getUniformLocation(copyProgram, 'uTex');
    const cHas = gl.getUniformLocation(copyProgram, 'uHasInput');

    // Hold buffer — the sample-&-hold frame store. We capture the input
    // into here while the gate is open (or always, when unpatched), then
    // all five output passes read FROM the hold buffer. Freezing is just
    // "skip the capture this frame".
    const hold = ctx.createFbo();

    // One FBO per output port.
    const fboCombined = ctx.createFbo();
    const fboR        = ctx.createFbo();
    const fboG        = ctx.createFbo();
    const fboB        = ctx.createFbo();
    const fboLuma     = ctx.createFbo();

    // 1×1 black sentinel for the unpatched-input case (so we never bind a
    // null sampler / our own output as input → GL feedback loop).
    const emptyTex = gl.createTexture();
    if (!emptyTex) throw new Error('FREEZEFRAME: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const params: FreezeframeParams = { ...DEFAULTS, ...(node.params as Partial<FreezeframeParams>) };

    // Gate connection + level tracking.
    //   gateWriteFrame : the draw-frame index at which setParam('gateLevel')
    //                    last fired. Compared against the current frame in
    //                    draw() to decide "is gate_in patched?".
    //   currentFrame   : last frame index seen in draw() (so setParam,
    //                    which runs OUTSIDE draw, can stamp gateWriteFrame
    //                    with the right frame).
    let gateWriteFrame = -1_000_000;
    let currentFrame = -1;
    let holdSeeded = false; // has the hold buffer ever been captured?

    function levelsFor(knob: number): number {
      return quantLevels(knob);
    }

    /** Render one output pass into `target` with the given mode, reading
     *  from the hold buffer texture. */
    function renderPass(target: { fbo: WebGLFramebuffer }, mode: number, hasInput: boolean): void {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, ctx.res.width, ctx.res.height);
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, hasInput ? hold.texture : emptyTex);
      gl.uniform1i(uTex, 0);
      gl.uniform1f(uHasInput, hasInput ? 1.0 : 0.0);
      gl.uniform1f(uMode, mode);
      gl.uniform1f(uLevelsR,    levelsFor(params.quant_r));
      gl.uniform1f(uLevelsG,    levelsFor(params.quant_g));
      gl.uniform1f(uLevelsB,    levelsFor(params.quant_b));
      gl.uniform1f(uLevelsLuma, levelsFor(params.quant_luma));
      ctx.drawFullscreenQuad();
    }

    const surface: VideoNodeSurface = {
      fbo: fboCombined.fbo,
      texture: fboCombined.texture,
      draw(frame) {
        currentFrame = frame.frame;
        const inputTex = frame.getInputTexture(node.id, 'video_in');
        const hasInput = !!inputTex;

        // Deterministic test hook (e2e / VRT): when globalThis.
        // __freezeframeForceGate is a number, treat the gate as PATCHED and
        // use that number as the gate level. Mirrors NIBBLES'
        // __nibblesForceLength — lets the harness pin freeze-vs-live state
        // without a timing-flaky real LFO. No-op in production (global
        // unset). undefined / non-number means "use the real CV path".
        const forced = (globalThis as unknown as { __freezeframeForceGate?: number | undefined })
          .__freezeframeForceGate;
        const forcedGate = typeof forced === 'number' && Number.isFinite(forced)
          ? forced
          : null;

        // Is the gate patched? The CV bridge writes gateLevel every frame
        // while an edge exists; if we've seen a write within the grace
        // window, the gate is connected. The forced-gate hook also counts
        // as patched.
        const gatePatched = forcedGate !== null
          || (currentFrame - gateWriteFrame) <= GATE_PATCH_GRACE;
        // Capture decision:
        //   unpatched gate → always capture (live passthrough);
        //   patched gate   → capture only while HIGH (level >= 0.5).
        //   Always capture the very first frame so a frozen-on-spawn gate
        //   still has SOMETHING in the hold buffer (else black).
        const gateLevel = forcedGate !== null ? forcedGate : params.gateLevel;
        const capture = shouldCapture(gatePatched, gateLevel, holdSeeded);

        // ---- HOLD pass: copy input → hold buffer (only when capturing) ----
        if (capture) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, hold.fbo);
          gl.viewport(0, 0, ctx.res.width, ctx.res.height);
          gl.useProgram(copyProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, inputTex ?? emptyTex);
          gl.uniform1i(cTex, 0);
          gl.uniform1f(cHas, hasInput ? 1.0 : 0.0);
          ctx.drawFullscreenQuad();
          if (hasInput) holdSeeded = true;
        }

        // ---- OUTPUT passes: read hold buffer, posterize per mode ----
        // `hasInput` here means "the hold buffer carries real content" —
        // true once we've ever captured a real frame, even if the live
        // input later disconnects (we keep showing the frozen frame).
        const showContent = holdSeeded || hasInput;
        renderPass(fboCombined, MODE_COMBINED, showContent);
        renderPass(fboR,        MODE_R,        showContent);
        renderPass(fboG,        MODE_G,        showContent);
        renderPass(fboB,        MODE_B,        showContent);
        renderPass(fboLuma,     MODE_LUMA,     showContent);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      },
      dispose() {
        for (const f of [hold, fboCombined, fboR, fboG, fboB, fboLuma]) {
          gl.deleteFramebuffer(f.fbo);
          gl.deleteTexture(f.texture);
        }
        gl.deleteTexture(emptyTex);
        gl.deleteProgram(program);
        gl.deleteProgram(copyProgram);
      },
    };

    return {
      domain: 'video',
      surface,
      setParam(paramId, value) {
        if (paramId === 'gateLevel') {
          params.gateLevel = value;
          // Stamp the current frame so draw() can detect "patched".
          gateWriteFrame = currentFrame;
          return;
        }
        if (paramId in params) {
          (params as unknown as Record<string, number>)[paramId] = value;
        }
      },
      readParam(paramId) {
        return (params as unknown as Record<string, number>)[paramId];
      },
      read(key) {
        // Per-output texture lookup (multi-output escape hatch — see
        // VideoEngine.lookupInput). surface.texture already exposes
        // video_out for legacy single-texture consumers; the rest need
        // this hook.
        if (key === 'outputTexture:video_out') return fboCombined.texture;
        if (key === 'outputTexture:r_out')     return fboR.texture;
        if (key === 'outputTexture:g_out')     return fboG.texture;
        if (key === 'outputTexture:b_out')     return fboB.texture;
        if (key === 'outputTexture:luma_out')  return fboLuma.texture;
        // Test/diagnostic reads.
        if (key === 'gatePatched') return (currentFrame - gateWriteFrame) <= GATE_PATCH_GRACE;
        if (key === 'holdSeeded')  return holdSeeded;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
