// packages/web/src/lib/video/modules/chromakey.ts
//
// CHROMAKEY — proper 2-input chroma-key compositor (green-screen style).
//
// Inputs: `fg` (foreground), `bg` (background). Output: composited video.
//
// Built on the SHARED KEYING CORE ($lib/video/keying-core — kcChromaMask /
// kcDespill / kcComposite; design: .myrobots/plans/keyer-framework-2026-07-11.md
// §4 + §11). Per-pixel algorithm:
//   1. alpha = kcChromaMask(fg, key, thr, soft): distance between the pixel
//      and the key colour IN THE CHROMA PLANE (full-swing Rec. 601 CbCr),
//      normalized by the key's own chroma magnitude — the industry-standard
//      (Vlahos-family) metric. 0 at the key colour; EXACTLY 1.0 for any
//      neutral gray vs a saturated key, so shadows/highlights and low-chroma
//      subject pixels survive WITHOUT a bolted-on saturation gate. alpha =
//      smoothstep(thr, thr + soft, d): alpha 0 -> background, 1 -> keep fg.
//      (Replaces the old hue-angle + satGate metric, which keyed out mildly
//      green-cast SUBJECT pixels — finding F-C1.)
//   2. Spill suppression: fg' = kcDespill(fg, key, spill) — limit the key's
//      dominant channel (green key: g' = min(g, max(r, b)), lerped by
//      spill). Acts on KEPT pixels — where spill is actually visible.
//      EXACT identity at spill = 0. (Replaces the old (1-alpha)-scaled edge
//      desaturation, which could never touch an alpha=1 pixel — finding F-C2.)
//   3. Composite: kcComposite(bg, fg', alpha) = mix(bg, fg', alpha).
//
// DEFAULT THRESHOLD 0.5 (was 0.15 under the old hue metric — a deliberate
// re-calibration, §11 change 2): chroma-plane distance scales with pixel
// BRIGHTNESS (a half-brightness key green sits at d = 0.5 from the key), so
// the default must key real-world screen variation, not just near-pure key
// pixels. Calibration probes (normalized d vs the pure green key):
//   pure key (0,1,0)                 d = 0.000  -> keyed
//   realistic screen (0.2,0.8,0.3)   d = 0.454  -> keyed at default
//   half-brightness key (0,0.5,0)    d = 0.500  -> keyed at default
//   green-cast subject (0.6,0.75,0.55) d = 0.828 -> KEPT (the F-C1 pixel)
//   any neutral gray                 d = 1.000  -> KEPT
// Pinned by keying-core.test.ts (probes) + keyer-functional.spec.ts (e2e).
//
// ACHROMATIC KEYS: a neutral key colour (black/white/gray) has ~zero chroma;
// with the floored normalizer ALL neutrals then measure as "at the key" and
// key out together regardless of luma. Use LUMAKEY for black/white backdrops.
//
// CV inputs declare paramTarget == port id (PR #264 convention) so the
// cross-domain bridge writes them correctly.
//
// Inputs:
//   fg (video): foreground (the layer with the key colour).
//   bg (video): background (composited where the key matches).
//   keyR / keyG / keyB (cv, paramTarget=…): displaces the key-colour components.
//   threshold (cv, paramTarget=threshold): displaces the chroma-distance threshold.
//   softness (cv, paramTarget=softness): displaces the smoothstep softness.
//   spillSuppress (cv, paramTarget=spillSuppress): displaces the despill amount.
//
// Outputs:
//   out (video): composited RGB.
//
// Params:
//   keyR / keyG / keyB (linear 0..1): key colour components.
//   threshold (linear 0..1): normalized chroma distance below which fg is keyed.
//   softness (linear 0..0.5): edge feathering.
//   spillSuppress (linear 0..1): dominant-channel despill amount on the kept fg.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import { GLSL_KEY_HELPERS } from '$lib/video/keying-core';

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uFg;
uniform sampler2D uBg;
uniform float uHasFg;
uniform float uHasBg;
uniform float uKeyR;
uniform float uKeyG;
uniform float uKeyB;
uniform float uThreshold;
uniform float uSoftness;
uniform float uSpillSuppress;
${GLSL_KEY_HELPERS}
void main() {
  vec3 fg = uHasFg > 0.5 ? texture(uFg, vUv).rgb : vec3(0.0);
  vec3 bg = uHasBg > 0.5 ? texture(uBg, vUv).rgb : vec3(0.0);

  // Without a foreground, there's nothing to key — show the background
  // directly (so a half-patched chain isn't a black hole).
  if (uHasFg < 0.5) {
    outColor = vec4(bg, 1.0);
    return;
  }

  vec3 key = vec3(uKeyR, uKeyG, uKeyB);
  // thr/soft/spill are clamped to their declared ranges INSIDE the core
  // helpers (ydoc params are not range-validated; CV writes are).
  float alpha = kcChromaMask(fg, key, uThreshold, uSoftness, 0.0);
  fg = kcDespill(fg, key, uSpillSuppress);

  // alpha = 0 -> BG only, alpha = 1 -> FG only.
  outColor = vec4(kcComposite(bg, fg, alpha), 1.0);
}`;

interface ChromakeyParams {
  keyR: number;
  keyG: number;
  keyB: number;
  threshold: number;
  softness: number;
  spillSuppress: number;
}

const DEFAULTS: ChromakeyParams = {
  keyR: 0.0,
  keyG: 1.0,  // green-screen default
  keyB: 0.0,
  threshold: 0.5, // keys shaded/realistic screen variation (see header calibration)
  softness: 0.08,
  spillSuppress: 0.5,
};

export const chromakeyDef: VideoModuleDef = {
  type: 'chromakey',
  palette: { top: 'Video modules', sub: 'Processors' },
  domain: 'video',
  label: 'chromakey',
  category: 'effects',
  inputs: [
    { id: 'fg',            type: 'video' },
    { id: 'bg',            type: 'video' },
    { id: 'keyR',          type: 'cv', paramTarget: 'keyR', cvScale: { mode: 'linear' } },
    { id: 'keyG',          type: 'cv', paramTarget: 'keyG', cvScale: { mode: 'linear' } },
    { id: 'keyB',          type: 'cv', paramTarget: 'keyB', cvScale: { mode: 'linear' } },
    { id: 'threshold',     type: 'cv', paramTarget: 'threshold', cvScale: { mode: 'linear' } },
    { id: 'softness',      type: 'cv', paramTarget: 'softness', cvScale: { mode: 'linear' } },
    { id: 'spillSuppress', type: 'cv', paramTarget: 'spillSuppress', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    { id: 'keyR',          label: 'R',    defaultValue: DEFAULTS.keyR,          min: 0, max: 1,   curve: 'linear' },
    { id: 'keyG',          label: 'G',    defaultValue: DEFAULTS.keyG,          min: 0, max: 1,   curve: 'linear' },
    { id: 'keyB',          label: 'B',    defaultValue: DEFAULTS.keyB,          min: 0, max: 1,   curve: 'linear' },
    { id: 'threshold',     label: 'Thr',  defaultValue: DEFAULTS.threshold,     min: 0, max: 1,   curve: 'linear' },
    { id: 'softness',      label: 'Soft', defaultValue: DEFAULTS.softness,      min: 0, max: 0.5, curve: 'linear' },
    { id: 'spillSuppress', label: 'Spill',defaultValue: DEFAULTS.spillSuppress, min: 0, max: 1,   curve: 'linear' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation: "chromakey is a two-input green-screen compositor: it takes a foreground video (the layer shot against a key colour) and a background video, and replaces every foreground pixel that is chromatically close to the chosen key colour with the matching background pixel. Per pixel it measures the DISTANCE IN THE CHROMA PLANE (full-swing Rec. 601 Cb/Cr) between the pixel and the key colour, normalized by the key's own chroma strength — the industry-standard keying metric — and builds an alpha via smoothstep over the thr/soft window (alpha 0 = show background, alpha 1 = keep foreground). A neutral gray always sits at exactly distance 1.0 from a saturated key, so shadows, highlights and low-saturation subject pixels survive the key without any special gating. Spill suppression then limits the key colour's dominant channel on the KEPT foreground (for a green key: green is pulled down toward max(red, blue)), removing green contamination from the subject itself — not just from the matte edge. Pick the key colour with the swatch (defaults to pure green), then tune thr: the default 0.5 keys real-world screen variation (shading, off-tint) while keeping subjects; lower it toward 0.15 to key only near-pure key pixels, raise soft to feather the matte edge, and raise spill to remove key-colour fringing from the subject. If no foreground is patched it just passes the background through. Note: an achromatic (black/white/gray) key colour has no chroma to measure against, so ALL neutral pixels key out together regardless of brightness — for keying off a black or white backdrop use lumakey instead.",
    inputs: {
      fg: "Foreground video frame — the layer shot against the key colour that gets keyed out where its chroma matches.",
      bg: "Background video frame — composited in wherever the foreground is keyed out; shown directly if no foreground is patched.",
      keyR: "CV input that modulates the R control — the red component of the key colour (linear 0..1).",
      keyG: "CV input that modulates the G control — the green component of the key colour (linear 0..1).",
      keyB: "CV input that modulates the B control — the blue component of the key colour (linear 0..1).",
      threshold: "CV input that modulates the Thr control — how chromatically close a pixel must be to the key to be removed (linear 0..1).",
      softness: "CV input that modulates the Soft control — the feathering width of the matte edge (linear 0..0.5).",
      spillSuppress: "CV input that modulates the Spill control — how strongly the key colour's dominant channel is limited on the kept foreground (linear 0..1).",
    },
    outputs: {
      out: "The composited RGB video frame: foreground over background with the key colour replaced and key-colour spill suppressed on the kept subject.",
    },
    controls: {
      keyR: "R — red channel of the key colour, set via the colour-picker swatch (0..1); part of the chroma being matched, default 0 for the green-screen default.",
      keyG: "G — green channel of the key colour, set via the colour-picker swatch (0..1); default 1 so the keyer starts on a green screen.",
      keyB: "B — blue channel of the key colour, set via the colour-picker swatch (0..1); default 0 for the green-screen default.",
      threshold: "Thr fader — the normalized chroma-plane distance from the key colour below which a pixel is keyed out (0..1, default 0.5). The scale: 0 = only the key colour itself, 0.5 = shaded/off-tint screen variation drops out (a half-brightness key green sits at exactly 0.5), 1 = even neutral grays (distance 1.0) reach the edge of the key band. Lower it to key only near-pure key pixels; raise it if screen shading survives the key.",
      softness: "Soft fader — smoothstep feathering of the matte edge over the chroma-distance band (0..0.5, default 0.08); 0 = hard cutoff, higher = softer, more gradual key edge.",
      spillSuppress: "Spill fader — dominant-channel despill on the kept foreground (0..1, default 0.5): for a green key the green channel is pulled toward max(red, blue) by this amount, removing key-colour contamination from the subject itself. 0 = exactly off (bit-identical passthrough), 1 = full limit.",
    },
  },
  // docs-hash-ignore:end
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uFg            = gl.getUniformLocation(program, 'uFg');
    const uBg            = gl.getUniformLocation(program, 'uBg');
    const uHasFg         = gl.getUniformLocation(program, 'uHasFg');
    const uHasBg         = gl.getUniformLocation(program, 'uHasBg');
    const uKeyR          = gl.getUniformLocation(program, 'uKeyR');
    const uKeyG          = gl.getUniformLocation(program, 'uKeyG');
    const uKeyB          = gl.getUniformLocation(program, 'uKeyB');
    const uThreshold     = gl.getUniformLocation(program, 'uThreshold');
    const uSoftness      = gl.getUniformLocation(program, 'uSoftness');
    const uSpillSuppress = gl.getUniformLocation(program, 'uSpillSuppress');

    const { fbo, texture } = ctx.createFbo();

    // Sentinel 1x1 black texture for unbound inputs — same pattern as MIXER.
    // We can't re-bind our own FBO texture as a "spare" sampler input
    // because that creates a feedback loop GL silently fills with garbage.
    const emptyTex = gl.createTexture();
    if (!emptyTex) throw new Error('CHROMAKEY: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const params: ChromakeyParams = { ...DEFAULTS, ...(node.params as Partial<ChromakeyParams>) };

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);

        const fgTex = frame.getInputTexture(node.id, 'fg');
        const bgTex = frame.getInputTexture(node.id, 'bg');
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, fgTex ?? emptyTex);
        g.uniform1i(uFg, 0);
        g.uniform1f(uHasFg, fgTex ? 1.0 : 0.0);
        g.activeTexture(g.TEXTURE1);
        g.bindTexture(g.TEXTURE_2D, bgTex ?? emptyTex);
        g.uniform1i(uBg, 1);
        g.uniform1f(uHasBg, bgTex ? 1.0 : 0.0);

        g.uniform1f(uKeyR,          params.keyR);
        g.uniform1f(uKeyG,          params.keyG);
        g.uniform1f(uKeyB,          params.keyB);
        g.uniform1f(uThreshold,     params.threshold);
        g.uniform1f(uSoftness,      params.softness);
        g.uniform1f(uSpillSuppress, params.spillSuppress);

        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);
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
