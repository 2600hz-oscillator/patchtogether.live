// packages/web/src/lib/video/modules/mapper.ts
//
// MAPPER — per-frame video KEYER / MATTE processor.
//
// Shows a `video` input ONLY where a `key` input is active, BLACK
// everywhere else. This GENERALISES the OUTLINES module's `mapped` output
// (which showed the video input only where ≥2 shapes overlapped) to an
// ARBITRARY key input: instead of "≥2 shapes overlap" the gate is "key
// LUMINANCE ≥ threshold".
//
// MAPPER is STATELESS per frame — the keyed region moves/transforms live
// with the key source (no feedback, no history), so it's a pure function
// of the current `video` frame, the current `key` frame, and the
// THRESHOLD knob.
//
// ── Algorithm ─────────────────────────────────────────────────────────
// For each output texel:
//   1. Sample the KEY input's Rec. 601 LUMINANCE (the same luma weights
//      LUMA / EDGES / LUMAKEY use, so "luminance" is consistent across
//      the video modules). A mono-video key (white-on-black) upcasts to
//      `video` for free — its three channels carry the same value, so the
//      luminance == that value.
//   2. mask = smoothstep(threshold - EDGE, threshold + EDGE, lumaKey).
//      A tiny soft EDGE band around the threshold avoids the 1-texel
//      aliasing a hard step produces on a moving key. The mask is still
//      effectively a crisp key (EDGE is sub-pixel-small): mask → 1 well
//      above threshold, 0 well below.
//   3. out = video * mask. Where the key is active (luma ≥ threshold) the
//      video shows through; below threshold it fades to black.
//
//   * THRESHOLD (0..1, default 0.5): the key cutoff. RAISING it shrinks
//     the keyed area (only the brightest parts of the key pass); LOWERING
//     it grows it (dimmer key regions pass too). This is the exact knob
//     OUTLINES.mapped hard-coded to "≥2 overlaps".
//
// ── Half-patched behaviour ────────────────────────────────────────────
//   * No video input  → black (nothing to show).
//   * No key input    → black (no key region → matte everything out). This
//     mirrors OUTLINES.mapped (unpatched video → black) — a MAPPER with
//     only one of the two inputs patched is intentionally a black hole, so
//     a half-built chain reads as "not done yet" rather than passing the
//     raw video through unkeyed.
//
// Inputs:
//   video (video): the RGB source shown in the keyed region.
//   key   (video): the matte. Use its LUMINANCE as the mask. Declared
//                  `video` (not `mono-video`) so BOTH a colour `video`
//                  source AND a `mono-video` source (which upcasts to
//                  `video` via canConnect) can drive it — the spec's "also
//                  accept video via the engine's upcast". A mono-video key
//                  is the common case (SHAPES / LINES / EDGES output).
//   threshold (cv, paramTarget='threshold'): per-param CV (port id == param id).
//
// Outputs:
//   out (video): the video shown where key-luma ≥ threshold, black below.
//
// Params:
//   threshold (linear 0..1): the key cutoff (default 0.5).

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

/** Rec. 601 luma weights — same as LUMA / EDGES / LUMAKEY so "luminance"
 *  is consistent across the video modules. */
export const MAPPER_LUMA_WEIGHTS: readonly [number, number, number] = [0.299, 0.587, 0.114];

/** Half-width of the soft key edge (in luma units). Sub-pixel-small so the
 *  key stays effectively crisp (mask ≈ 1 well above threshold, ≈ 0 well
 *  below) while smoothstep removes the 1-texel aliasing a hard step shows on
 *  a moving key. Shared by the shader + the pure CPU mirror. */
export const MAPPER_EDGE = 0.03;

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uVideo;     // the RGB source to show
uniform sampler2D uKey;       // the matte; luminance is the mask
uniform float uHasVideo;      // 1 when the video input is patched, else 0
uniform float uHasKey;        // 1 when the key input is patched, else 0
uniform float uThreshold;     // 0..1 key cutoff

const float LUMA_R = ${MAPPER_LUMA_WEIGHTS[0]};
const float LUMA_G = ${MAPPER_LUMA_WEIGHTS[1]};
const float LUMA_B = ${MAPPER_LUMA_WEIGHTS[2]};
const float EDGE   = ${MAPPER_EDGE.toFixed(4)};

void main() {
  // A half-patched MAPPER (missing video OR key) is black — same as
  // OUTLINES.mapped's unpatched-video behaviour.
  if (uHasVideo < 0.5 || uHasKey < 0.5) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  float keyLuma = dot(texture(uKey, vUv).rgb, vec3(LUMA_R, LUMA_G, LUMA_B));
  float t = clamp(uThreshold, 0.0, 1.0);
  // Soft key around the threshold (sub-pixel-small EDGE → effectively crisp).
  float mask = smoothstep(t - EDGE, t + EDGE, keyLuma);

  vec3 vid = texture(uVideo, vUv).rgb;
  outColor = vec4(vid * mask, 1.0);
}`;

export interface MapperParams {
  threshold: number; // 0..1 key cutoff
}

export const MAPPER_DEFAULTS: MapperParams = {
  // 0.5 — keys on the upper half of the key's luminance range, the natural
  // "show where the key is bright" default. A mono-video key (white-on-black)
  // passes its white region (luma 1) and mattes its black region (luma 0).
  threshold: 0.5,
};

const PARAM_IDS: ReadonlySet<string> = new Set(Object.keys(MAPPER_DEFAULTS));

/**
 * Pure Rec. 601 luminance of an RGB triple (each channel 0..1). Exported so
 * the unit tests share the shader's definition of "luminance".
 */
export function mapperLuma(r: number, g: number, b: number): number {
  return (
    r * MAPPER_LUMA_WEIGHTS[0] + g * MAPPER_LUMA_WEIGHTS[1] + b * MAPPER_LUMA_WEIGHTS[2]
  );
}

/**
 * Pure CPU mirror of the shader's per-texel KEY MASK — the single source of
 * truth shared by the unit tests + the GLSL `smoothstep(...)`. Given a key
 * texel's RGB (0..1) and the threshold, returns the 0..1 mask the video is
 * multiplied by (1 = full video, 0 = black). The soft EDGE band matches
 * MAPPER_EDGE so a key luma well above threshold → 1, well below → 0, and
 * exactly at threshold → 0.5.
 */
export function mapperMask(
  keyR: number,
  keyG: number,
  keyB: number,
  threshold: number,
): number {
  const keyLuma = mapperLuma(keyR, keyG, keyB);
  const t = Math.max(0, Math.min(1, threshold));
  const lo = t - MAPPER_EDGE;
  const hi = t + MAPPER_EDGE;
  // smoothstep(lo, hi, x)
  if (hi <= lo) return keyLuma >= t ? 1 : 0; // degenerate band → hard step
  const e = Math.max(0, Math.min(1, (keyLuma - lo) / (hi - lo)));
  return e * e * (3 - 2 * e);
}

/**
 * Pure CPU mirror of the FULL per-texel MAPPER decision: video * keyMask.
 * Returns the output RGB triple. Shared by the unit tests so the JS + GLSL
 * agree on the keyer algorithm.
 *
 * `hasVideo` / `hasKey` mirror the shader's half-patched guards: with either
 * missing the output is black.
 */
export function mapperPixel(
  video: readonly [number, number, number],
  key: readonly [number, number, number],
  threshold: number,
  hasVideo = true,
  hasKey = true,
): [number, number, number] {
  if (!hasVideo || !hasKey) return [0, 0, 0];
  const m = mapperMask(key[0], key[1], key[2], threshold);
  return [video[0] * m, video[1] * m, video[2] * m];
}

export const mapperDef: VideoModuleDef = {
  type: 'mapper',
  palette: { top: 'Video modules', sub: 'Processors' },
  domain: 'video',
  label: 'mapper',
  category: 'effects',
  inputs: [
    { id: 'video', type: 'video' },
    // The KEY/matte. Declared `video` so BOTH a colour video source AND a
    // mono-video source (mono-video → video upcast in canConnect) can drive
    // it — the spec's "key is mono-video; also accept video via upcast". We
    // use its LUMINANCE as the mask in the shader.
    { id: 'key',   type: 'video' },
    // Per-param CV input — port id == param id (the cross-domain CV bridge
    // routes audio-side cv onto VideoEngine.setParam(portId)).
    { id: 'threshold', type: 'cv', paramTarget: 'threshold', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    { id: 'threshold', label: 'Thresh', defaultValue: MAPPER_DEFAULTS.threshold, min: 0, max: 1, curve: 'linear' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation:
      "MAPPER is a per-frame video keyer / matte processor. It shows the VID source only where the KEY input is bright, and paints black everywhere else. For each output texel the shader reads the KEY frame's Rec. 601 luminance (0.299 R + 0.587 G + 0.114 B), builds a mask = smoothstep(threshold - 0.03, threshold + 0.03, keyLuma), and outputs video * mask — so above the cutoff the video shows through, below it fades to black, with a sub-pixel soft edge that kills 1-texel aliasing on a moving key. It is STATELESS per frame: no feedback, no history, so the keyed region tracks the key source live. This generalises OUTLINES' hard-coded \"mapped\" output (video where >=2 shapes overlap) to an arbitrary luminance gate. A mono-video key (white-on-black from SHAPES / LINES / EDGES) is the common matte. Usage: patch a moving picture into VID, a white-on-black shape/mask into KEY, and turn Thresh to trim how much of the matte passes. Note: it is intentionally a black hole when half-patched — with either VID or KEY missing the output is solid black.",
    inputs: {
      video: "VID — the RGB source shown inside the keyed region. Its pixels appear wherever the key passes; with this input unpatched the whole output is black.",
      key: "KEY — the matte. The shader takes this frame's Rec. 601 luminance as the mask, so bright key pixels reveal the video and dark ones matte it to black. Commonly a white-on-black mono-video shape (SHAPES / LINES / EDGES), but a colour video source works too via the engine upcast. Unpatched KEY makes the whole output black.",
      threshold: "CV input that modulates the Thresh control. Linear-scaled per-param CV (port id equals the param id) driving the key cutoff over its 0..1 range, so you can sweep how much of the matte passes from another modulation source.",
    },
    outputs: {
      out: "OUT — the keyed video: the VID source shown where key luminance is at or above the threshold, and black below it. A pure video output (solid black when either input is unpatched).",
    },
    controls: {
      threshold: "Thresh (0..1, linear, default 0.5) — the key luminance cutoff. Raising it shrinks the keyed area so only the brightest parts of the key pass; lowering it grows the keyed area so dimmer key regions show video too. A sub-pixel soft edge (+/-0.03 luma) around the cutoff keeps the key crisp while removing aliasing on a moving matte.",
    },
  },
  // docs-hash-ignore:end
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uVideo     = gl.getUniformLocation(program, 'uVideo');
    const uKey       = gl.getUniformLocation(program, 'uKey');
    const uHasVideo  = gl.getUniformLocation(program, 'uHasVideo');
    const uHasKey    = gl.getUniformLocation(program, 'uHasKey');
    const uThreshold = gl.getUniformLocation(program, 'uThreshold');

    const { fbo, texture } = ctx.createFbo();

    // Sentinel 1×1 black texture for unbound inputs — same pattern as
    // LUMAKEY / CHROMAKEY / V-MIXER.
    const emptyTex = gl.createTexture();
    if (!emptyTex) throw new Error('MAPPER: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Strip stray non-numeric / unknown keys so they can't bleed in.
    const rawParams = node.params as Record<string, unknown>;
    const filtered: Record<string, number> = {};
    for (const [k, v] of Object.entries(rawParams)) {
      if (PARAM_IDS.has(k) && typeof v === 'number') filtered[k] = v;
    }
    const params: MapperParams = { ...MAPPER_DEFAULTS, ...(filtered as Partial<MapperParams>) };

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);

        const videoTex = frame.getInputTexture(node.id, 'video');
        const keyTex   = frame.getInputTexture(node.id, 'key');

        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, videoTex ?? emptyTex);
        g.uniform1i(uVideo, 0);
        g.uniform1f(uHasVideo, videoTex ? 1.0 : 0.0);

        g.activeTexture(g.TEXTURE1);
        g.bindTexture(g.TEXTURE_2D, keyTex ?? emptyTex);
        g.uniform1i(uKey, 1);
        g.uniform1f(uHasKey, keyTex ? 1.0 : 0.0);

        g.uniform1f(uThreshold, Math.max(0, Math.min(1, params.threshold)));

        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);
        g.activeTexture(g.TEXTURE0);
      },
      dispose() {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
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
      dispose() { surface.dispose(); },
    };
  },
};
