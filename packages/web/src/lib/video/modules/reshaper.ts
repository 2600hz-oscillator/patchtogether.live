// packages/web/src/lib/video/modules/reshaper.ts
//
// RESHAPER — fragment-shader raster-scan-coordinate REMAP.
//
// (Formerly shipped as RUTTETRA. Renamed when the AUTHENTIC forward-
// scatter Rutt-Etra scope — real line geometry — took over the
// `ruttetra` type id. RESHAPER is the coordinate-remap effect; its
// behaviour is unchanged. Persisted `ruttetra` nodes saved before the
// rename load as `reshaper` via the migration in graph/persistence.ts.)
//
// Conceptually: a CRT raster scan draws each pixel at coordinate (h, v)
// where h, v ramp linearly across the screen and luma at (h, v) sets the
// pixel brightness. RESHAPER replaces the linear (h, v) ramps with
// patchable signals — when X is folded, mirrored, or radial, the source
// video gets remapped into the deformed coordinate system.
//
//   x = X_function(u, v)           // patched in via X (mono-video coord field)
//   y = Y_function(u, v)           // patched in via Y (mono-video coord field)
//   z = source video               // patched in via Z
//   draw_point(x, y, brightness=z)
//
// In our pipeline, ramps are video-rate textures: each pixel of the X
// or Y texture stores the coordinate value at that screen position. The
// fragment shader samples X at the current output pixel (u, v) to get
// the new u-coordinate, samples Y to get the new v-coordinate, then
// samples Z at (newU, newV).
//
// When X is the identity horizontal ramp (R = u) and Y the identity
// vertical ramp (R = v), output equals input — clean raster passthrough.
// When X is folded / triangle / radial via SHAPEDRAMPS, the source is
// remapped into a folded / mirrored / circular coordinate system.
//
// Defaults when X/Y are unpatched: identity ramps. So an unpatched
// RESHAPER with a Z source still acts like a regular display.
//
// CHAINABLE OUTPUT — exposes its rendered FBO texture via the standard
// `out` port (same texture the on-card preview reads via blitOutputTo-
// DrawingBuffer). This lets users chain RESHAPER into downstream video
// modules (e.g. LINES → RESHAPER → MONOGLITCH → OUTPUT). The card still
// blits to its visible canvas the same way as before; the new port just
// publishes the same texture for graph consumers.
//
// Inputs:
//   x (mono-video): X-coordinate field (replaces the linear h ramp).
//   y (mono-video): Y-coordinate field (replaces the linear v ramp).
//   z (video): source video to be remapped.
//   intensity / xDisp / yDisp (cv, linear, paramTarget=…): per-param CV.
//
// Outputs:
//   out (video): remapped RGB output.
//
// Params:
//   intensity (linear 0..2): how strongly X/Y bend the coordinate field.
//   xDisp / yDisp (linear -1..1): static coordinate displacement.
//   tintR / tintG / tintB (linear 0..1): tint applied to the output.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uX;       // mono-video horizontal coordinate field
uniform sampler2D uY;       // mono-video vertical coordinate field
uniform sampler2D uZ;       // source video
uniform float uHasX;
uniform float uHasY;
uniform float uHasZ;
uniform float uIntensity;
uniform float uXDisp;
uniform float uYDisp;
uniform float uTintR;
uniform float uTintG;
uniform float uTintB;

float luma(vec3 rgb) {
  return dot(rgb, vec3(0.299, 0.587, 0.114));
}

void main() {
  // Identity ramps when X/Y unpatched: rampX = u, rampY = v → no remap.
  float rampX = uHasX > 0.5 ? texture(uX, vUv).r : vUv.x;
  float rampY = uHasY > 0.5 ? texture(uY, vUv).r : vUv.y;

  // Re-read luma at the SAME screen position as the ramp lookup (per
  // spec). The displacement is "what the source video says is bright at
  // this screen location" not "what's bright at the displaced location."
  vec3 srcHere = uHasZ > 0.5 ? texture(uZ, vUv).rgb : vec3(0.5);
  float lumaHere = luma(srcHere);

  // Luma → coordinate displacement. xDisp + yDisp mirror the classic
  // Rutt/Etra "raised terrain" effect: bright pixels lift / push.
  float finalU = rampX + (lumaHere - 0.5) * uXDisp;
  float finalV = rampY + (lumaHere - 0.5) * uYDisp;

  // Sample the source at the deformed coordinate. Default mid-grey when
  // Z unpatched so the card isn't a black void on cold-spawn.
  vec3 rgb = uHasZ > 0.5 ? texture(uZ, vec2(finalU, finalV)).rgb : vec3(0.5);

  vec3 col = rgb * uIntensity * vec3(uTintR, uTintG, uTintB);
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

interface ReshaperParams {
  intensity: number;
  xDisp: number;
  yDisp: number;
  tintR: number;
  tintG: number;
  tintB: number;
}

const DEFAULTS: ReshaperParams = {
  intensity: 1.0,
  xDisp: 0,
  yDisp: 0,
  tintR: 1.0,
  tintG: 1.0,
  tintB: 1.0,
};

export const reshaperDef: VideoModuleDef = {
  type: 'reshaper',
  palette: { top: 'Video modules', sub: 'Processors' },
  domain: 'video',
  label: 'reshaper',
  category: 'output',
  schemaVersion: 1,
  inputs: [
    // Coordinate fields. mono-video so SHAPEDRAMPS h_*/v_* outputs
    // patch in cleanly without an upcast detour.
    { id: 'x',         type: 'mono-video' },
    { id: 'y',         type: 'mono-video' },
    // Source video. Polymorphic 'video' so users can patch
    // mono-video / image / keys via the engine's implicit upcasts.
    { id: 'z',         type: 'video' },
    // CV inputs. port id == param id so the cross-domain CV bridge
    // routes audio cv → setParam(portId).
    { id: 'intensity', type: 'cv', paramTarget: 'intensity', cvScale: { mode: 'linear' } },
    { id: 'xDisp',     type: 'cv', paramTarget: 'xDisp',     cvScale: { mode: 'linear' } },
    { id: 'yDisp',     type: 'cv', paramTarget: 'yDisp',     cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    { id: 'intensity', label: 'Intensity', defaultValue: DEFAULTS.intensity, min: 0,  max: 2, curve: 'linear' },
    { id: 'xDisp',     label: 'X Disp',    defaultValue: DEFAULTS.xDisp,     min: -1, max: 1, curve: 'linear' },
    { id: 'yDisp',     label: 'Y Disp',    defaultValue: DEFAULTS.yDisp,     min: -1, max: 1, curve: 'linear' },
    { id: 'tintR',     label: 'Tint R',    defaultValue: DEFAULTS.tintR,     min: 0,  max: 1, curve: 'linear' },
    { id: 'tintG',     label: 'Tint G',    defaultValue: DEFAULTS.tintG,     min: 0,  max: 1, curve: 'linear' },
    { id: 'tintB',     label: 'Tint B',    defaultValue: DEFAULTS.tintB,     min: 0,  max: 1, curve: 'linear' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation: "RESHAPER is a coordinate-remap video processor that emulates a CRT raster scan whose horizontal and vertical sweeps are patchable instead of fixed. For every output pixel it reads a horizontal coordinate from the X field and a vertical coordinate from the Y field (the red channel of each mono-video texture), then samples the Z source video at that remapped position. With X and Y unpatched it falls back to identity ramps (screen-u, screen-v), so Z passes straight through like a normal display. Feed X/Y from shaped ramps (e.g. SHAPEDRAMPS folds, triangles, or radial fields) and the source video is rebuilt inside that deformed coordinate space — folded, mirrored, or circularised. On top of the field remap, the source's own brightness at each screen pixel pushes the lookup: luma above mid-grey lifts, below pushes back, scaled by X Disp / Y Disp — the classic Rutt/Etra \"raised terrain\" displacement. The final color is multiplied by Intensity and the R/G/B tint. Usage: patch a video into Z for a quick scanline display; drive X and/or Y from a ramp generator to warp it, or just dial X Disp / Y Disp for a luma-relief effect from Z alone. Output is a standard video texture, so chain it downstream (e.g. LINES into RESHAPER into MONOGLITCH). The card shows a live preview of the remapped output; in hide-controls mode the preview becomes a resizable screen (drag the bottom-right corner; double-click the frame to restore defaults).",
    inputs: {
      x: "X — mono-video horizontal coordinate field. Its red channel replaces the linear horizontal scan ramp, so each output pixel reads its source u from this texture. Unpatched, it defaults to the identity ramp (no horizontal remap); patch a shaped ramp here to fold, mirror, or warp the image along X.",
      y: "Y — mono-video vertical coordinate field. Its red channel replaces the linear vertical scan ramp, supplying the source v for each output pixel. Unpatched, it defaults to the identity ramp (no vertical remap); patch a shaped ramp here to deform the image along Y.",
      z: "Z — source video to be remapped (polymorphic video; mono-video, image, or keys upcast in cleanly). It is sampled at the remapped (X, Y) coordinate. Unpatched, RESHAPER shows flat mid-grey rather than black so a cold-spawned card isn't a void.",
      intensity: "intensity — CV input that modulates the Intensity control (linear), scaling the output brightness/contribution of the remapped video.",
      xDisp: "xDisp — CV input that modulates the X Disp control (linear), driving the horizontal luma-displacement amount from automation or another module.",
      yDisp: "yDisp — CV input that modulates the Y Disp control (linear), driving the vertical luma-displacement amount from automation or another module.",
    },
    outputs: {
      out: "out — the remapped RGB video (the rendered FBO texture, same image shown in the on-card preview). Chain it into any downstream video module.",
    },
    controls: {
      intensity: "Intensity (0..2, default 1) — overall output gain on the remapped video; 0 blacks the output, 1 is unity, above 1 boosts toward clipping (the result is clamped).",
      xDisp: "X Disp (-1..1, default 0) — horizontal luma displacement. Each pixel's source u is shifted by (sourceLuma − 0.5) × this amount, so bright areas of Z push one way and dark areas the other (Rutt/Etra raised-terrain); 0 disables horizontal displacement.",
      yDisp: "Y Disp (-1..1, default 0) — vertical luma displacement. Each pixel's source v is shifted by (sourceLuma − 0.5) × this amount, lifting bright pixels and pushing dark ones vertically; 0 disables vertical displacement.",
      tintR: "Tint R (0..1, default 1) — multiplies the red channel of the output; lower to remove red from the tint.",
      tintG: "Tint G (0..1, default 1) — multiplies the green channel of the output; lower to remove green from the tint.",
      tintB: "Tint B (0..1, default 1) — multiplies the blue channel of the output; lower to remove blue from the tint.",
    },
  },
  // docs-hash-ignore:end
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uX         = gl.getUniformLocation(program, 'uX');
    const uY         = gl.getUniformLocation(program, 'uY');
    const uZ         = gl.getUniformLocation(program, 'uZ');
    const uHasX      = gl.getUniformLocation(program, 'uHasX');
    const uHasY      = gl.getUniformLocation(program, 'uHasY');
    const uHasZ      = gl.getUniformLocation(program, 'uHasZ');
    const uIntensity = gl.getUniformLocation(program, 'uIntensity');
    const uXDisp     = gl.getUniformLocation(program, 'uXDisp');
    const uYDisp     = gl.getUniformLocation(program, 'uYDisp');
    const uTintR     = gl.getUniformLocation(program, 'uTintR');
    const uTintG     = gl.getUniformLocation(program, 'uTintG');
    const uTintB     = gl.getUniformLocation(program, 'uTintB');

    // Per-instance FBO — same pattern as videoOut / monoglitch. Card
    // calls blitOutputToDrawingBuffer(nodeId) before its drawImage blit.
    const { fbo, texture } = ctx.createFbo();

    // Sentinel 1×1 black texture for unbound video inputs. Same reason
    // as V-MIXER: avoid GL feedback loops by NOT binding our own output.
    const emptyTex = gl.createTexture();
    if (!emptyTex) throw new Error('RESHAPER: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const params: ReshaperParams = { ...DEFAULTS, ...(node.params as Partial<ReshaperParams>) };

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;
        const xTex = frame.getInputTexture(node.id, 'x');
        const yTex = frame.getInputTexture(node.id, 'y');
        const zTex = frame.getInputTexture(node.id, 'z');

        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);

        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, xTex ?? emptyTex);
        g.uniform1i(uX, 0);
        g.uniform1f(uHasX, xTex ? 1.0 : 0.0);

        g.activeTexture(g.TEXTURE1);
        g.bindTexture(g.TEXTURE_2D, yTex ?? emptyTex);
        g.uniform1i(uY, 1);
        g.uniform1f(uHasY, yTex ? 1.0 : 0.0);

        g.activeTexture(g.TEXTURE2);
        g.bindTexture(g.TEXTURE_2D, zTex ?? emptyTex);
        g.uniform1i(uZ, 2);
        g.uniform1f(uHasZ, zTex ? 1.0 : 0.0);

        g.uniform1f(uIntensity, params.intensity);
        g.uniform1f(uXDisp,     params.xDisp);
        g.uniform1f(uYDisp,     params.yDisp);
        g.uniform1f(uTintR,     params.tintR);
        g.uniform1f(uTintG,     params.tintG);
        g.uniform1f(uTintB,     params.tintB);

        ctx.drawFullscreenQuad();
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
      read(key) {
        if (key === 'fboTexture') return texture;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
