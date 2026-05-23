// packages/web/src/lib/video/modules/acidwarp.ts
//
// ACIDWARP — 320×240 plasma video source with scene cycler.
//
// Algorithm port of Noah Spurrier's ACIDWARP (1992-1993, GPL) by way of
// Steven Wills (Linux) + Boris Gjenero (SDL). Math is re-expressed in TS
// against modern Math primitives; visual output matches the original.
// Project license: AGPL-3.0-or-later (GPL-compatible). Pattern generators
// + palette construction live in `acidwarp-patterns.ts`.
//
// Render pipeline:
//   - JS side: generate one Uint8Array of pattern indices per scene
//     (recomputed only when scene changes). Build a base palette per
//     paletteType (recomputed only when paletteType changes). Rotate the
//     palette by `paletteOffset` slots each frame at a rate scaled by
//     the speed knob.
//   - GL side: two textures — pattern (R8, 320×240) sampled per pixel for
//     the colour index, palette (RGB, 256×1) sampled with that index for
//     the final colour. One trivial fragment shader.
//
// Internal resolution is fixed at 320×240 (NTSC 4:3); upsampled to the
// video engine's framebuffer size by GL's linear filter. BENTBOX
// downstream sees a 4:3 frame, no aspect distortion.
//
// Controls:
//   - SCENE button on the card / `scene_cv` gate input → advance scene
//   - FREEZE button on the card → halts auto scene-change (palette still rotates)
//   - SPEED knob (also speed_cv): 0% (still) … 50% (1×) … 100% (4×)

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface, VideoEngineContext } from '$lib/video/engine';
import {
  generatePattern,
  buildPalette,
  rotatePalette,
  SCENE_COUNT,
  PALETTE_COUNT,
  type PaletteType,
} from './acidwarp-patterns';

const INTERNAL_W = 320;
const INTERNAL_H = 240;
/** Mean seconds between auto scene changes at speed = 1.0 (the dead-centre
 *  knob position). At speed = 4 (knob max) this becomes 2 s; at speed = 0
 *  the cycler is fully paused. */
const SCENE_PERIOD_NORMAL_S = 8;
/** Palette rotation slots per second at speed = 1.0. The original Acidwarp
 *  ran rotation tied to a ~70 Hz refresh; we target a similar visual cadence
 *  at our rAF rate. */
const PALETTE_ROT_PER_SEC = 10;

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uPattern;
uniform sampler2D uPalette;
uniform float uHasPattern;

void main() {
  if (uHasPattern < 0.5) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  // Flip Y: GL texture origin is bottom-left, our pattern buffer is top-down.
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  // Pattern R8 sample: 0..1 in red. We sample the palette texture (256×1)
  // at the same index — the .x coordinate IS the palette slot.
  float idx = texture(uPattern, uv).r;
  vec3 col = texture(uPalette, vec2(idx, 0.5)).rgb;
  outColor = vec4(col, 1.0);
}`;

interface AcidwarpParams {
  speed: number;        // 0..1 — knob position (0.5 = 1× speed)
  freeze: number;       // 0/1 — pause auto scene cycle
  scene: number;        // 0..SCENE_COUNT-1 — current scene index (persisted)
  paletteType: number;  // 0..PALETTE_COUNT-1
  sceneTrig: number;    // CV-driven; rising-edge advances scene
}

const DEFAULTS: AcidwarpParams = {
  speed: 0.5,
  freeze: 0,
  scene: 0,
  paletteType: 0,
  sceneTrig: 0,
};

/** Map the user-facing speed knob (0..1) to a real speed multiplier.
 *  Piecewise linear so dead-centre = 1× (normal Acidwarp cadence).
 *    0     →  0× (still)
 *    0.5   →  1×
 *    1.0   →  4×
 */
export function speedKnobToMultiplier(knob: number): number {
  const k = Math.max(0, Math.min(1, knob));
  return k < 0.5 ? k * 2 : 1 + (k - 0.5) * 6;
}

export const acidwarpDef: VideoModuleDef = {
  type: 'acidwarp',
  domain: 'video',
  label: 'ACIDWARP',
  category: 'sources',
  schemaVersion: 1,
  inputs: [
    { id: 'speed_cv', type: 'cv', paramTarget: 'speed',     cvScale: { mode: 'linear' } },
    // scene_cv is a gate; the engine's cv-bridge writes its value into
    // params.sceneTrig and the factory's draw() detects rising edges.
    { id: 'scene_cv', type: 'cv', paramTarget: 'sceneTrig' },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    { id: 'speed',       label: 'Speed',   defaultValue: DEFAULTS.speed,       min: 0, max: 1, curve: 'linear' },
    { id: 'freeze',      label: 'Freeze',  defaultValue: DEFAULTS.freeze,      min: 0, max: 1, curve: 'discrete' },
    { id: 'scene',       label: 'Scene',   defaultValue: DEFAULTS.scene,       min: 0, max: SCENE_COUNT - 1,   curve: 'discrete' },
    { id: 'paletteType', label: 'Palette', defaultValue: DEFAULTS.paletteType, min: 0, max: PALETTE_COUNT - 1, curve: 'discrete' },
    { id: 'sceneTrig',   label: 'Trig',    defaultValue: DEFAULTS.sceneTrig,   min: 0, max: 1, curve: 'linear' },
  ],

  factory(ctx: VideoEngineContext, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);
    const uPattern    = gl.getUniformLocation(program, 'uPattern');
    const uPalette    = gl.getUniformLocation(program, 'uPalette');
    const uHasPattern = gl.getUniformLocation(program, 'uHasPattern');
    const { fbo, texture } = ctx.createFbo();

    const params: AcidwarpParams = { ...DEFAULTS, ...(node.params as Partial<AcidwarpParams>) };

    // ---------------- Pattern texture (R8, 320×240) ----------------
    const patternTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, patternTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    let patternReady = false;

    // ---------------- Palette texture (RGB8, 256×1) ----------------
    const paletteTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, paletteTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // ---------------- Live JS state ----------------
    let lastSceneCommitted = -1;          // forces a pattern build on first draw
    let lastPaletteTypeCommitted = -1;
    let lastTime = -1;                    // for elapsed dt
    let sceneAccumS = 0;                  // seconds toward next auto scene change
    let paletteAccumSlots = 0;            // fractional palette rotation accumulator
    let basePalette: Uint8Array | null = null;
    let prevSceneTrig = 0;
    let snapshotImageData: ImageData | null = null;

    function rebuildPattern() {
      const sceneIdx = Math.max(0, Math.min(SCENE_COUNT - 1, Math.round(params.scene)));
      const buf = generatePattern({ scene: sceneIdx, width: INTERNAL_W, height: INTERNAL_H });
      gl.bindTexture(gl.TEXTURE_2D, patternTex);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.R8,
        INTERNAL_W, INTERNAL_H, 0,
        gl.RED, gl.UNSIGNED_BYTE, buf,
      );
      patternReady = true;
      lastSceneCommitted = sceneIdx;
      // The card snapshot mirrors the pattern × palette for its on-card
      // display; rebuild when either changes.
      snapshotImageData = null;
    }

    function rebuildBasePalette() {
      const type = Math.max(0, Math.min(PALETTE_COUNT - 1, Math.round(params.paletteType))) as PaletteType;
      basePalette = buildPalette(type);
      lastPaletteTypeCommitted = type;
      snapshotImageData = null;
    }

    rebuildPattern();
    rebuildBasePalette();

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;

        // ----- Tick: advance scene cycler + palette rotation -----
        const tNow = frame.time;
        const dt = lastTime < 0 ? 0 : Math.max(0, tNow - lastTime);
        lastTime = tNow;

        const speed = speedKnobToMultiplier(params.speed);

        // Auto scene advance (skipped while frozen OR when speed = 0).
        if (params.freeze < 0.5 && speed > 0) {
          sceneAccumS += dt;
          const period = SCENE_PERIOD_NORMAL_S / speed;
          if (sceneAccumS >= period) {
            sceneAccumS = 0;
            params.scene = (Math.round(params.scene) + 1) % SCENE_COUNT;
          }
        }

        // sceneTrig CV rising-edge → advance scene (works regardless of freeze).
        const trig = params.sceneTrig;
        if (trig > 0.5 && prevSceneTrig <= 0.5) {
          params.scene = (Math.round(params.scene) + 1) % SCENE_COUNT;
          sceneAccumS = 0;
        }
        prevSceneTrig = trig;

        // Rebuild pattern texture if scene or paletteType changed since last draw.
        if (Math.round(params.scene) !== lastSceneCommitted) rebuildPattern();
        if (Math.round(params.paletteType) !== lastPaletteTypeCommitted) rebuildBasePalette();

        // Advance palette rotation accumulator. Palette keeps rotating
        // even while frozen — the visual life of the patch comes from
        // the cycling colours, not the pattern changes.
        paletteAccumSlots += dt * PALETTE_ROT_PER_SEC * speed;
        const rotOffset = Math.floor(paletteAccumSlots);

        // Build the rotated palette and upload. Cheap — 256 × 3 bytes.
        if (basePalette) {
          const rotated = rotatePalette(basePalette, rotOffset);
          g.bindTexture(g.TEXTURE_2D, paletteTex);
          g.texImage2D(g.TEXTURE_2D, 0, g.RGB, 256, 1, 0, g.RGB, g.UNSIGNED_BYTE, rotated);
        }

        // ----- Render -----
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);
        g.uniform1f(uHasPattern, patternReady ? 1.0 : 0.0);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, patternTex);
        g.uniform1i(uPattern, 0);
        g.activeTexture(g.TEXTURE1);
        g.bindTexture(g.TEXTURE_2D, paletteTex);
        g.uniform1i(uPalette, 1);
        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
        gl.deleteTexture(patternTex);
        gl.deleteTexture(paletteTex);
        gl.deleteProgram(program);
      },
    };

    /** CPU-side preview the card uses to draw the on-card 320×240 viewport.
     *  Combines the cached pattern with the current rotated palette without
     *  hitting GL — avoids the cost of an OffscreenCanvas readback. */
    function buildCardSnapshot(): ImageData | null {
      if (!basePalette || !patternReady) return null;
      const rot = rotatePalette(basePalette, Math.floor(paletteAccumSlots));
      const px = new Uint8ClampedArray(INTERNAL_W * INTERNAL_H * 4);
      // Re-generate the pattern indices for the snapshot only — we don't
      // keep them around in JS once they're in the GL R8 texture. Cheap.
      const pat = generatePattern({
        scene: Math.max(0, Math.min(SCENE_COUNT - 1, Math.round(params.scene))),
        width: INTERNAL_W,
        height: INTERNAL_H,
      });
      for (let i = 0; i < pat.length; i++) {
        const idx = pat[i]!;
        const p = i * 4;
        px[p]     = rot[idx * 3]!;
        px[p + 1] = rot[idx * 3 + 1]!;
        px[p + 2] = rot[idx * 3 + 2]!;
        px[p + 3] = 255;
      }
      return new ImageData(px, INTERNAL_W, INTERNAL_H);
    }

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
        if (key === 'scene') return Math.round(params.scene);
        if (key === 'speed') return params.speed;
        if (key === 'frozen') return params.freeze >= 0.5;
        if (key === 'paletteType') return Math.round(params.paletteType);
        // Build the snapshot only when the card asks; cache until next
        // scene/palette change invalidates it.
        if (key === 'snapshot') {
          if (!snapshotImageData) snapshotImageData = buildCardSnapshot();
          return snapshotImageData;
        }
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
