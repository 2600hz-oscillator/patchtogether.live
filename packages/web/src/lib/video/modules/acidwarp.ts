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
//
// Inputs:
//   speed_cv (cv, linear, paramTarget=speed): displaces the palette-rotation speed.
//   scene_cv (cv, paramTarget=sceneTrig): rising-edge advances to the next scene.
//
// Outputs:
//   out (video): the plasma render (320×240 internal, 4:3 letterboxed).
//
// Params:
//   speed (linear 0..1): palette rotation speed (0.5 = native 1× rate).
//   freeze (discrete 0..1): pauses the palette rotation.
//   scene (discrete 0..SCENE_COUNT): scene picker.
//   paletteType (discrete 0..PALETTE_COUNT): palette picker.
//   sceneTrig (linear 0..1): one-shot scene-advance trigger.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface, VideoEngineContext } from '$lib/video/engine';
import {
  generatePattern,
  buildPalette,
  ACIDWARP_PALETTE_OPTIONS,
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
 *  ran rotation tied to a ~70 Hz refresh on a 256-slot palette; one step
 *  per ~14 ms = ~70 slots/s. We target the same so the visual cadence
 *  feels right at 1× speed. The card preview polls at 30 Hz, so this gives
 *  ~2 palette steps per visible frame at 1× — fluid scrolling. */
const PALETTE_ROT_PER_SEC = 60;

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
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'acidwarp',
  category: 'sources',
  // Fix E Phase 1 — acidwarp is the first module opted into the off-main-thread
  // render worker, and (PR V2) the first PARITY-COMPLETE one: the worker path
  // is used BY DEFAULT (kill switch: `?videoworker=0` / `__videoWorkerEnabled
  // = false`). It's a pure-GL plasma SOURCE with a DOM-free factory; its only
  // inputs are CV (speed_cv → speed, scene_cv → sceneTrig), which flow through
  // setParam — the proxy handle forwards those over the worker RPC channel, so
  // no SAB CV ingress is needed. The on-card preview uses the standard
  // blit-from-engine path (AcidwarpCard), which samples the proxy's worker
  // texture like any downstream consumer — no CPU snapshot poll, so the proxy
  // never materializes a main-thread fallback (`read('snapshot')` remains for
  // tests). See module-registry.ts `renderLocus`.
  renderLocus: 'worker',
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
    // ⚠ TWO LANDMARKS, AND THEY REPLACE A DELETED READOUT RATHER THAN DECORATE
    // THE DIAL. `AcidwarpCard.svelte` printed the LIVE MULTIPLIER under this
    // knob (`STOPPED`, `2.4×`) — resting derived text, which the 2026-08-19
    // ruling removes from a faceplate. Deleting it silently would lose a fact
    // the ParamDef does not otherwise carry: `speedKnobToMultiplier` is
    // `k < 0.5 ? k*2 : 1 + (k-0.5)*6`, so NATIVE 1x sits at the knob's MIDPOINT,
    // not at the top. A bare 0..1 dial gives a player no way to find it.
    //
    // Landmarks are the mechanism for exactly this shape — named waypoints on a
    // CONTINUOUS param that morphs through its range — and a landmark NAME is
    // permitted resting text where a number is not.
    //
    // ⚠ THE TOP END IS DELIBERATELY NOT A LANDMARK. `4×` would be a NUMERIC
    // label: `face-readout-source`'s `paintableLabels()` sweeps landmarks as
    // well as options, and its `looksNumeric` matches a digit plus a `×`, so it
    // would need a NUMERIC_LABEL_EXEMPTIONS entry. It also buys nothing a dial
    // does not already say — "fully clockwise is fastest" is legible from the
    // control. Both names here come from the def's OWN docs ("0 = still,
    // 0.5 = native 1x"), so nothing is invented and no exemption is spent.
    {
      id: 'speed', label: 'Speed', defaultValue: DEFAULTS.speed, min: 0, max: 1, curve: 'linear',
      landmarks: [
        { value: 0, label: 'STILL' },
        { value: 0.5, label: 'NATIVE' },
      ],
    },
    { id: 'freeze',      label: 'Freeze',  defaultValue: DEFAULTS.freeze,      min: 0, max: 1, curve: 'discrete' },
    // ⚠ NO `options` ON `scene`, AND THAT IS A DECISION. Forty-one states, and
    // the module names NONE of them — the card printed `SCENE n/41`, an index.
    // Inventing forty-one names would be fabricating semantics the module does
    // not have, which `param-vocabulary`'s own reasoning forbids. It stays a
    // numeric discrete control, and its value lives in `aria-valuetext`.
    { id: 'scene',       label: 'Scene',   defaultValue: DEFAULTS.scene,       min: 0, max: SCENE_COUNT - 1,   curve: 'discrete' },
    // The eight palette names, DERIVED from the `type & 3` / `type & 4`
    // encoding in acidwarp-patterns rather than transcribed. Until now they
    // existed only inside the card, so no consumer but that card could name a
    // palette: a faceplate would have painted an anonymous eight-position dial.
    { id: 'paletteType', label: 'Palette', defaultValue: DEFAULTS.paletteType, min: 0, max: PALETTE_COUNT - 1, curve: 'discrete', options: ACIDWARP_PALETTE_OPTIONS },
    { id: 'sceneTrig',   label: 'Trig',    defaultValue: DEFAULTS.sceneTrig,   min: 0, max: 1, curve: 'linear' },
  ],

  noUserControl: [
    {
      param: 'sceneTrig',
      writer: 'cv-port',
      why:
        'written by the `scene_cv` bridge (the port declares `paramTarget: sceneTrig`), and the '
        + "draw loop EDGE-DETECTS it: a low->high crossing above 0.5 advances the scene once per "
        + 'pulse. It is a trigger, not a value — and it is declared `linear`, so a rendered cell '
        + 'would be a continuous rotary over a gate edge, inviting a player to park it at 0.7 '
        + 'where it fires never again. The scene is advanced by the SCENE control and by this '
        + 'CV; nothing hand-turns the trigger itself. Same shape as milkdrop `nextTrig`.',
    },
  ],

  docs: {
    explanation: "acidwarp is a pure-GPU plasma SOURCE — it has no video input, it synthesizes its picture from math. It is a faithful port of Noah Spurrier's 1992-93 ACIDWARP demo: a 320x240 (NTSC 4:3) buffer of 8-bit palette indices is generated once per scene by a per-pixel formula (distance + angle + scaled sin/cos modulators, plus a few XOR scenes and recursive \"rain\" noise scenes), then every frame a 256-entry color palette is rotated by one or more slots and sampled per pixel. The scrolling palette is what makes the pattern appear to flow and pulse, even though the underlying index field is static until the scene changes. There are 41 scenes (concentric rings, simple rays, peacock, five-arm star, interference fields, rain/noise, interlaced two-screen variants, etc.) and 8 palettes (RGBW rainbow, greyscale, half-grey, pastel — each with an optional sparkle/\"lightning\" variant that brightens every 4th slot). Use it as a generative video bed: patch OUT into a mixer/feedback/output card, ride SPEED for the cycling rate, and nudge SCENE by hand or with a clock into scene_cv for rhythmic pattern changes. Slot 0 is reserved black, so palette rotation cycles only the 255 non-black colors.",
    inputs: {
      speed_cv: "CV in that modulates the Speed control (linear): it displaces the palette-rotation rate and, while not frozen, the auto scene-change cadence. Same mapping as the knob — 0 = still, 0.5 = native 1x, 1.0 = 4x.",
      scene_cv: "CV in that modulates the hidden sceneTrig control; the draw loop edge-detects it, so a rising edge (crossing above 0.5) advances to the NEXT scene once per pulse — it behaves as a trigger. Works whether or not FREEZE is on; patch a clock here for rhythmic scene changes.",
    },
    outputs: {
      out: "Video out: the rendered plasma frame (320x240 internal, 4:3), linearly upsampled to the engine framebuffer. The only output — acidwarp is a generator with no audio path.",
    },
    controls: {
      speed: "Speed knob (linear 0..1, default 0.5). Maps piecewise to a rate multiplier: 0 = stopped, 0.5 = native 1x, 1.0 = 4x — so NATIVE SPEED IS THE MIDPOINT of the dial, not the top. Scales both palette-rotation speed and the auto scene-change interval (~8s at 1x, halving as speed rises). Two landmarks name the non-obvious positions (STILL at 0, NATIVE at 0.5); the exact multiplier at any position is spoken by the control rather than printed on the panel.",
      freeze: "Freeze toggle (discrete 0/1, default 0). When on, halts only the automatic scene cycler — the palette keeps rotating, so colors still scroll. Advancing the scene by hand, or by a scene_cv rising edge, still works while frozen. It LATCHES: switch it on and it stays on until you switch it off.",
      scene: "Scene index (discrete 0..40, default 0). Picks which of the 41 per-pixel pattern formulas is generated. Advanced automatically (unless frozen, and only while speed > 0), by the SCENE control, or by a scene_cv rising edge. The 41 scenes have no names — this is an index, and it is spoken rather than printed. Persisted with the patch.",
      paletteType: "Palette picker (discrete 0..7, default 0). Selects one of 4 base palettes — RGBW rainbow, GREY, HALF-grey, PASTEL — each with an optional sparkle/lightning variant (base id + 4), shown with a sparkle mark. All 8 are named states you pick directly.",
      sceneTrig: "One-shot scene-advance trigger (linear 0..1, default 0). Driven by the scene_cv input; the draw loop edge-detects it (a low->high crossing above 0.5 fires once, advancing the scene). Not a hand-turned control — it is the CV-fed trigger that bumps the scene index, and the faceplate gives it no cell.",
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // THE FACEPLATE — five params, but FOUR DISTINCT CONTROL SHAPES over one
  // picture, which is what put this module on the complex side of the owner's
  // batch split and sent it out alone.
  //
  // WHAT IT IS FOR. ACIDWARP is a pure-GPU plasma SOURCE — no input, it
  // synthesizes its picture from math, a faithful port of Spurrier's 1992-93
  // demo. The index field is STATIC until the scene changes; what makes the
  // picture appear to flow is the PALETTE ROTATING under it. So the verb is not
  // "shape a signal", it is CHOOSE AND PACE: pick a pattern, pick a colour
  // world, and set how fast the colours scroll through it. Every rank below
  // descends from that.
  //
  // THE TIER LADDER, read back as a sentence: at mini you get SPEED — the one
  // control that decides whether anything appears to move at all, and the only
  // continuous one on the module. At compact, SPEED and PALETTE — pace plus
  // colour world, which between them account for everything a viewer notices
  // from across a room. SCENE and FREEZE are dock-only: SCENE because a
  // 41-position numeric stepper is unreadable in a 46 px lane column, FREEZE
  // because it does nothing to the picture's LOOK (it stops the cycler; the
  // palette keeps rotating either way). MEASURED through `curatedFace` in
  // `acidwarp-face-model.test.ts`, never inferred from LANE_PLATE_MAX_CELLS.
  //
  // ⚠ LANDMARKS COST LANE HEIGHT. `speed` now declares two, which makes
  // `paintsReadout` true and adds `LANE_KNOB_READOUT_H` to its cell — so the
  // lane fit plan sees a TALLER first cell than it did before the face. That is
  // measured rather than assumed, in the same test.
  face: {
    // ⚠ MANDATORY for a video def, and counter-intuitively so: the live picture
    // does NOT arrive through the glyph. `primaryAudioOutPortId` matches
    // `type === 'audio'` and this def has none, so any other literal resolves to
    // a dead static glyph. The tile picture comes from `hasVideoSurface(def)`.
    glyph: 'none',

    // The bespoke screen — see $lib/ui/modules/acidwarp/. Promotion is what
    // stops BOTH surfaces rendering `AcidwarpCard.svelte`, and that card owns
    // the module's only picture, so without this file the promotion would
    // delete the display from a module that IS a display (#1928).
    extension: 'acidwarp',

    order: [
      // 1. The only continuous control, and the only one that decides whether
      //    the picture appears to move. Its landmarks carry the fact the
      //    deleted readout used to: NATIVE is the midpoint.
      'speed',
      // 2. The colour world. Eight named states, so it reads at a glance and
      //    changes the picture more than anything except the scene itself —
      //    but unlike the scene it is a SMALL, NAMED set a player can hold in
      //    their head.
      'paletteType',
      // ── dock-only from here ──
      // 3. Forty-one unnamed states. It changes the picture MOST, and it ranks
      //    below palette anyway: a 41-position numeric stepper is not operable
      //    in a lane knob column, and picking a specific one of forty-one
      //    unnamed patterns is browsing, not performing.
      'scene',
      // 4. Stops the auto-cycler and NOTHING else — the palette keeps rotating,
      //    so the picture still moves. Lowest rank of the four real controls
      //    because it is the only one that changes no pixel directly.
      'freeze',
    ],

    // FOUR controls over ONE picture, in two honest ideas: what is on screen,
    // and how it moves. Two bands, so no tab rail (DOCK_TAB_MIN_BANDS = 7) —
    // correct for a module whose whole surface is a display plus four knobs.
    pages: [
      { id: 'pattern', label: 'pattern', controls: ['scene', 'paletteType'] },
      { id: 'motion', label: 'motion', controls: ['speed', 'freeze'] },
    ],
  },
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

    // Pre-allocated buffers — avoid per-frame GC churn. The card snapshot
    // polls at ~30 Hz; each rebuild allocates a 256×3 rotated palette + a
    // 320×240×4 RGBA ImageData, so without pooling we'd burn ~2 MB / s of
    // garbage just on the card preview.
    let patternBuf: Uint8Array | null = null;  // cached pattern indices (320×240)
    const rotatedPaletteBuf = new Uint8Array(256 * 3);
    const snapshotPx = new Uint8ClampedArray(INTERNAL_W * INTERNAL_H * 4);
    const snapshotImage = new ImageData(snapshotPx, INTERNAL_W, INTERNAL_H);
    // Prefill alpha — it never changes.
    for (let i = 3; i < snapshotPx.length; i += 4) snapshotPx[i] = 255;

    function rebuildPattern() {
      const sceneIdx = Math.max(0, Math.min(SCENE_COUNT - 1, Math.round(params.scene)));
      patternBuf = generatePattern({ scene: sceneIdx, width: INTERNAL_W, height: INTERNAL_H });
      gl.bindTexture(gl.TEXTURE_2D, patternTex);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.R8,
        INTERNAL_W, INTERNAL_H, 0,
        gl.RED, gl.UNSIGNED_BYTE, patternBuf,
      );
      patternReady = true;
      lastSceneCommitted = sceneIdx;
    }

    function rebuildBasePalette() {
      const type = Math.max(0, Math.min(PALETTE_COUNT - 1, Math.round(params.paletteType))) as PaletteType;
      basePalette = buildPalette(type);
      lastPaletteTypeCommitted = type;
    }

    /** Fill `rotatedPaletteBuf` in place with `basePalette` shifted by
     *  `offset` slots. Slot 0 stays black. Avoids the per-frame allocation
     *  that rotatePalette() would do. */
    function rotateInPlace(offset: number): void {
      if (!basePalette) return;
      const cycle = 255;
      const o = ((offset % cycle) + cycle) % cycle;
      rotatedPaletteBuf[0] = 0; rotatedPaletteBuf[1] = 0; rotatedPaletteBuf[2] = 0;
      for (let i = 1; i < 256; i++) {
        const src = ((i - 1 + o) % cycle) + 1;
        rotatedPaletteBuf[i * 3]     = basePalette[src * 3]!;
        rotatedPaletteBuf[i * 3 + 1] = basePalette[src * 3 + 1]!;
        rotatedPaletteBuf[i * 3 + 2] = basePalette[src * 3 + 2]!;
      }
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

        // Rotate palette in place + upload. Cheap — 256 × 3 bytes; zero alloc.
        if (basePalette) {
          rotateInPlace(rotOffset);
          g.bindTexture(g.TEXTURE_2D, paletteTex);
          g.texImage2D(g.TEXTURE_2D, 0, g.RGB, 256, 1, 0, g.RGB, g.UNSIGNED_BYTE, rotatedPaletteBuf);
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
      if (!basePalette || !patternReady || !patternBuf) return null;
      // Reuse the cached pattern + pre-allocated rotation + snapshot buffers
      // — the card polls at 30 Hz so any per-poll allocation churns GC.
      // Re-rotating in place gives the card live palette animation without
      // needing to invalidate-then-rebuild the snapshot.
      rotateInPlace(Math.floor(paletteAccumSlots));
      const pat = patternBuf;
      const px = snapshotPx;
      const rot = rotatedPaletteBuf;
      const n = pat.length;
      for (let i = 0; i < n; i++) {
        const idx = pat[i]!;
        const p = i * 4;
        px[p]     = rot[idx * 3]!;
        px[p + 1] = rot[idx * 3 + 1]!;
        px[p + 2] = rot[idx * 3 + 2]!;
        // alpha pre-filled to 255 at module init — never changes
      }
      return snapshotImage;
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
        // Rebuild the snapshot on every poll — the card's putImageData
        // happily consumes our reused buffer, and the pattern is cached
        // so the per-poll cost is just the palette × pattern map.
        if (key === 'snapshot') return buildCardSnapshot();
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
