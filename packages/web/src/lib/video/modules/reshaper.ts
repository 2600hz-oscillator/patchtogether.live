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

  // ── THE FACEPLATE ────────────────────────────────────────────────────────
  //
  // WHAT IT IS. RESHAPER is a CRT raster whose two SWEEPS ARE CABLES. For every
  // output pixel it reads a horizontal coordinate from the X field and a
  // vertical one from the Y field and samples Z there, so patching a shaped ramp
  // into X or Y rebuilds the picture inside a deformed coordinate space. Its
  // siblings do neighbouring things with internal generators — `ruttetra`
  // scatters a grid into 3D relief, `monoglitch` bends a stack of drawn
  // scanlines — and the thing only this one does is let the SAMPLING GRID come
  // from outside. The verb is REMAP.
  //
  // ⚠ THE MODULE'S HEADLINE FEATURE HAS NO CONTROL ON THIS FACE, and that is
  // correct rather than an omission. The X and Y ramps are `mono-video` INPUTS
  // with no `ParamDef` behind them: `rampX` is `texture(uX, vUv).r` or the
  // identity `vUv.x`, and nothing on a panel can substitute for a patched field.
  // So the whole warp gesture lives on the REAR card, and every ranked control
  // here is downstream of it. A face cannot rank what a def does not declare —
  // saying so is what keeps the ladder below from reading as the module's
  // priorities.
  //
  // THE TIER LADDER, MEASURED through `curatedFace` rather than inferred from
  // `LANE_PLATE_MAX_CELLS`: mini 1 (X DISP) · compact 2 (the displacement PAIR,
  // which is the entire luma-relief effect) · plate 2 · dock all six.
  //
  // ⚠ THE PLATE TIER SHOWS THE SAME TWO AS COMPACT, AND THAT SURPRISED THIS
  // AUTHOR. `FACE_TIER_CAPS.full` is `LANE_PLATE_MAX_CELLS` = 6, but the cap is
  // not that constant — `faceTierCap` runs `laneBodyPlan`, which fits CELLS INTO
  // GEOMETRY, and a `fader` is a TALL cell. With the video surface taking its
  // share, six fader columns do not fit the 3x2 plate grid and the honest answer
  // is two. Measured identically on `monoglitch` (8 params) and `ruttetra` (12):
  // every video fader face resolves plate = compact = 2. So there is no tier at
  // which "most of the controls" appear between the lane tile and the dock, and
  // a ladder sentence that implies one is wrong however plausible it reads.
  // Pinned in `reshaper-face-model.test.ts` against the real resolver.
  //
  // ⚠ THE RANK-1 TIE IS BROKEN BY THE SHADER, NOT BY PREFERENCE. `xDisp` and
  // `yDisp` are symmetric in every respect the def can express — same range,
  // same default, same expression — so there is no ranking signal of the kind
  // `ruttetra` has (its `yDisp` is the one param it ships off identity). The
  // tie-break is evaluation order: `finalU` is computed before `finalV`, and the
  // def declares `xDisp` first. That invents nothing.
  //
  // ⚠ EVERY PARAM SHIPS AT IDENTITY, which is worth stating because it is what
  // makes the face scenes deterministic at rest and the module a pass-through on
  // spawn: disp 0/0 (no displacement), intensity 1 and tints 1/1/1 (unity
  // colour). With X/Y/Z unpatched the shader takes its mid-grey branch and
  // paints a flat field — a pure function of params with no time term anywhere.
  face: {
    order: ['xDisp', 'yDisp', 'intensity', 'tintR', 'tintG', 'tintB'],

    // Two pages, one per STAGE of the fragment shader that has params at all
    // (the ramp stage has none — see above). Two bands is far below
    // `DOCK_TAB_MIN_BANDS = 7`, so this renders as one column; six controls is
    // under `DOCK_ROW_MAX_CONTROLS = 10`, so PF-21 packs both bands into a
    // single row.
    pages: [
      {
        id: 'warp',
        label: 'warp',
        hint: 'the (luma - 0.5) x disp term - how far the source\'s own brightness pushes the sampling coordinate away from the ramp. At 0/0 the lookup is the ramp itself and the module is a pass-through',
        controls: ['xDisp', 'yDisp'],
      },
      {
        id: 'colour',
        label: 'colour',
        hint: 'the whole of the final colour expression - the sampled pixel multiplied by the gain and the R/G/B tint, then clamped. Disjoint from the geometry above: these four move colour and nothing else',
        controls: ['intensity', 'tintR', 'tintG', 'tintB'],
      },
    ],

    // ⚠ MANDATORY FOR A VIDEO DEF — `primaryAudioOutPortId` needs a
    // `type: 'audio'` output and this def has none, so any other glyph literal
    // falls through `glyphBinding` to `{kind:'static'}` and reddens
    // module-face-lint's dead-glyph clause. The live picture arrives from
    // `hasVideoSurface(def)` at the lane and the `fullViewBody` extension at the
    // dock, so assert THAT, never this declaration.
    glyph: 'none',

    // SCREEN ON/OFF, the MONITOR toggle and the corner resize all arrive through
    // this slot (#1928 / #2009) — promotion stops both surfaces rendering
    // `ReshaperCard.svelte`, which is their only home today.
    extension: 'reshaper',

    // ⚠ MONITOR MODE — the third of the five cards #2009 named, after `ruttetra`
    // proved the seam and `monoglitch` inherited it. VERIFIED AGAINST THE CARD:
    // `ReshaperCard.svelte` mounts `hideControls`, the corner resize over
    // `resizedWidth`/`resizedHeight`, and the double-click restore. The def's
    // `docs` describe the gesture too, but prose on a def is the thing that lies
    // in this bug class — the card is what established it.
    monitor: {
      why:
        'RESHAPER\'s output is a REMAPPED PICTURE, and the thing a player is judging is whether '
        + 'the deformed coordinate space still reads as the source image or has folded into '
        + 'abstraction — a question about the whole frame that no control reports. Its warp comes '
        + 'from PATCHED FIELDS rather than from any dial here, so the working loop is patch a ramp '
        + 'into X or Y, then LOOK: the picture is the only place the field\'s shape becomes '
        + 'visible at all. Its docs have advertised the monitor since it shipped.',
    },

    // The card draws all six as `<NeonFader>` THROWS, and nothing in a ParamDef
    // separates "a throw" from any other continuous scalar — so undeclared, the
    // face would repaint every one as a dial. No param here declares `landmarks`
    // or `options`, so unlike `ruttetra` there is no carve-out to make: a blanket
    // `fader` deletes nothing.
    paramCells: {
      xDisp: 'fader', yDisp: 'fader', intensity: 'fader',
      tintR: 'fader', tintG: 'fader', tintB: 'fader',
    },

    // ⚠ NO `bareCells`. The `colour` heading says these are the colour stage; it
    // does NOT say which channel is which, and R/G/B are the only thing telling
    // three otherwise-identical faders apart — the tidyVco side of that ruling.
    //
    // ⚠ NO `hero`, NO READOUT, NO SIDEBAR — the 2026-08-19 rulings removed the
    // shapes. Naming the finding that lost its surface: the module is a
    // PASS-THROUGH at its shipped defaults (disp 0/0, gain 1, tint 1/1/1), so
    // "this module is currently doing nothing to the picture" is a real derived
    // state a readout could have shown. It has no home now; it survives in
    // `docs.controls`, where each entry names its identity value.
  },

  docs: {
    explanation: "RESHAPER is a coordinate-remap video processor that emulates a CRT raster scan whose horizontal and vertical sweeps are patchable instead of fixed. For every output pixel it reads a horizontal coordinate from the X field and a vertical coordinate from the Y field (the red channel of each mono-video texture), then samples the Z source video at that remapped position. With X and Y unpatched it falls back to identity ramps (screen-u, screen-v), so Z passes straight through like a normal display. Feed X/Y from shaped ramps (e.g. SHAPEDRAMPS folds, triangles, or radial fields) and the source video is rebuilt inside that deformed coordinate space — folded, mirrored, or circularised. On top of the field remap, the source's own brightness at each screen pixel pushes the lookup: luma above mid-grey lifts, below pushes back, scaled by X Disp / Y Disp — the classic Rutt/Etra \"raised terrain\" displacement. The final color is multiplied by Intensity and the R/G/B tint. Usage: patch a video into Z for a quick scanline display; drive X and/or Y from a ramp generator to warp it, or just dial X Disp / Y Disp for a luma-relief effect from Z alone. Output is a standard video texture, so chain it downstream (e.g. LINES into RESHAPER into MONOGLITCH). There is a live preview screen showing the remapped output, and two switches beside it that do opposite things: SCREEN turns the preview off to reclaim its space (the module goes on rendering either way), and MONITOR hides the control bands so the picture has the whole plate to itself - drag the bottom-right corner to size it, and click MONITOR again to bring the controls back. Either way it is a viewport only; neither changes the output resolution.",
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
