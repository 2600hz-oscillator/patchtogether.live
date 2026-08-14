// packages/web/src/lib/audio/modules/cube.ts
//
// CUBE — 3D wavetable-navigator oscillator (slice 3): the web AudioModuleDef +
// factory. for the design.
//
// CUBE builds a 3D scalar field out of THREE e352 wavetables (FLOOR / WALL /
// CEILING) and reads an arbitrary planar slice through it as the played
// waveform (surface-height scan). It's a pitched V/oct oscillator whose L and R
// taps read planes up to ±18% of the march depth apart (CUBE_SPREAD_DEPTH — a
// real offset, but a narrow image). The pure field/slice DSP lives in
// packages/dsp/src/lib/cube-dsp.ts; the AudioWorklet that runs it is
// packages/dsp/src/cube.ts (registerProcessor('cube', …)).
//
// Wavetable selection rides node.data (per slot: cubeFloor / cubeWall /
// cubeCeiling, each { source, frames?, label? } like WAVESCULPT's per-osc data).
// The factory polls livePatch.nodes[id].data and reposts changed tables to the
// worklet via { type:'loadWavetable', slot, frames }. Defaults on spawn:
//   FLOOR=basic-shapes, WALL=pwm-sweep, CEILING=harmonic-sweep.
// ALL THREE must differ or one control dies by arithmetic — see the
// CUBE_DEFAULT_TABLES comment for which one, per coincidence.
//
// Params (LITERAL arrays — the module-manifest static extractor can't read
// computed/spread arrays): see `params` below + PLAN §6.
//
// Inputs:  pitch (V/oct node) + CV→AudioParam for slice_y/rx/ry/rz, morph_fc,
//          connect, crush, tune + poly (10-channel polyPitchGate chord bus).
//          When the poly bus carries any gate, CUBE renders one phase
//          accumulator per gated lane through the SAME posted slice waves at
//          that lane's pitch and SUMS them — polyphonic. Unpatched (or no gate)
//          → the mono `pitch` path runs unchanged (back-compat).
// Outputs: SEPARATE L and R audio ports (issue #1) — the worklet's 2-channel
//          output 0 is fanned out through a ChannelSplitter(2) so the ±SPREAD
//          stereo width survives downstream (a single stereo port downmixes to
//          mono into a mono input, erasing the spread). Plus a SYNC port — a
//          pure sine at the playback fundamental, phase-locked to the slice
//          readout (the worklet's mono output 1), exposed directly for
//          hard-syncing other oscillators or a clean reference / sub.
//
// OFF-THREAD SLICE COMPUTE (issue #4): the expensive SURFACE-HEIGHT SCAN
//   (sampleSlice) runs HERE on the main thread, not on the audio thread. On
//   init the factory tells the worklet to go off-thread; the worklet then posts
//   `paramsChanged` (cheap CV-summed scalars) whenever the slice needs a redo,
//   the factory renders the L/R/center waveforms and posts them back via
//   setWave. The audio thread only phase-accumulates → no dropouts. See the
//   worklet header in packages/dsp/src/cube.ts for the protocol.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import workletUrl from '@patchtogether.live/dsp/dist/cube.js?url';
import {
  framesToPlain,
  framesFromPlain,
  getFactoryTable,
  DEFAULT_FACTORY_TABLE_ID,
} from '$lib/audio/wavetable-factory-tables';
// Pure field/slice DSP — imported via a RELATIVE path (not the `@patchtogether
// .live/dsp/src/...` alias) for the same reason bluebox.ts does: worktrees may
// not symlink the workspace package under node_modules, and the worklet asset
// pipeline / TS path-alias rules don't reliably resolve TS source out of
// node_modules/@patchtogether.live/dsp/src. sampleSlice here is the IDENTICAL
// function the (fallback) worklet + node-ART run, so the off-thread waveform is
// byte-for-byte what the on-thread path would have produced.
import {
  sampleSlice,
  applyFold,
  spreadDepthOffset,
  isDegenerateWave,
  type SliceParams,
  type Material,
} from '../../../../../dsp/src/lib/cube-dsp';

const PROCESSOR_NAME = 'cube';
const POLL_MS = 200;
const loadedContexts = new WeakSet<BaseAudioContext>();

// ---------- surface → module frame-drawer registry (video_out) ----------
//
// The 3D CUBE WebGL render lives in CubeVizSurface.svelte (the surface owns the
// GL context + offscreen canvas), which the legacy card and the faceplate hero
// both mount. The cross-domain video_out bridge needs a drawFrame(canvas)
// callback; the surface installs one here keyed by node id (the SAME pattern
// WAVESCULPT uses for its video_out). When nothing is installed (nothing
// mounted / GL unavailable) the module's drawFrame paints black so the bridge
// always has a valid frame.
type FrameDrawer = (canvas: OffscreenCanvas | HTMLCanvasElement) => void;
const FRAME_DRAWERS: Map<string, FrameDrawer> = new Map();
export function installCubeFrameDrawer(nodeId: string, fn: FrameDrawer): void {
  FRAME_DRAWERS.set(nodeId, fn);
}
/**
 * Remove a node's frame drawer.
 *
 * ⚠ `fn` IS A COMPARE-AND-DELETE, not decoration. Two surfaces can hold the
 * same node briefly while one is being swapped for the other (the canvas card
 * unmounting as the shell faceplate mounts), and the loser's `onDestroy` runs
 * AFTER the winner's install. A bare delete would then unregister the LIVE
 * drawer and drop `video_out` to black with nothing to re-install it. Passing
 * the function makes the removal a no-op unless the caller still owns the slot.
 * Omitted = force-remove (the pre-existing call shape).
 */
export function uninstallCubeFrameDrawer(nodeId: string, fn?: FrameDrawer): void {
  if (fn && FRAME_DRAWERS.get(nodeId) !== fn) return;
  FRAME_DRAWERS.delete(nodeId);
}

export type CubeSlot = 'floor' | 'wall' | 'ceiling';
export const CUBE_SLOTS: readonly CubeSlot[] = ['floor', 'wall', 'ceiling'];

/** Per-slot wavetable defaults (PLAN §4).
 *
 *  ⚠ ALL THREE SLOTS MUST DIFFER, AND UNTIL `pwm-sweep` EXISTED THAT WAS
 *  IMPOSSIBLE. The field is
 *  `f3 = (1−morph)·occ(z, floorH, wallH) + morph·occ(z, ceilH, wallH)` and
 *  `columnHeights` reads every slot at the SAME (x, y), so each pair that
 *  coincides kills a different control:
 *
 *    floor ≡ ceiling → `dF ≡ dC`, so MORPH is inert: (1−m)·dF + m·dF = dF.
 *    floor ≡ wall    → the floor connector hits `occ`'s degenerate branch
 *                      (`span ≤ 1e-9` → a hard step), so CONNECT and CONNECT
 *                      STRENGTH are bit-exactly dead at morph = 0.
 *    ceiling ≡ wall  → the same, dead at morph = 1.
 *
 *  THREE slots, and for a long time only TWO factory tables — so by pigeonhole
 *  SOME pair always collided and SOME control was always dead. #1314 fixed the
 *  first case by moving CEILING off `basic-shapes`, which silently created the
 *  third: on the shipped defaults CONNECT and CONNECT STRENGTH were dead at
 *  morph = 1 with `maxAbsDiff` EXACTLY 0.000e+0. All six two-table assignments
 *  were measured and every one of them has exactly one dead control. That is
 *  not a defaults bug to be re-arranged; it is a counting problem, and the fix
 *  is the third table.
 *
 *  Measured on this assignment (`maxAbsDiff` vs the control at 0):
 *    MORPH 0→1 rmsΔ 0.17786 · CONNECT 0.31624 @m=0 / 0.22450 @m=1
 *                            · CNCT STR 0.21741 @m=0 / 0.15306 @m=1
 *  — nothing dead, and CONNECT's weakest leg is 2.4× the old best (0.09221).
 *  WALL takes the new table because BOTH connectors read it, so the most
 *  distinct shape there lifts both at once. `cube-morph-default.test.ts` holds
 *  all three pairs. */
export const CUBE_DEFAULT_TABLES: Record<CubeSlot, string> = {
  floor: 'basic-shapes',
  wall: 'pwm-sweep',
  ceiling: 'harmonic-sweep',
};

/** Per-slot wavetable selection, persisted on node.data. Mirrors WAVESCULPT's
 *  WavesculptOscData shape. `source` is 'factory:<id>' or 'user'. */
export interface CubeSlotData {
  source?: string;
  frames?: number[][];
  label?: string;
}
export interface CubeData {
  floor?: CubeSlotData;
  wall?: CubeSlotData;
  ceiling?: CubeSlotData;
}

interface ResolvedFrames {
  frames: Float32Array[];
  label: string;
  signature: string;
}

/** Resolve a slot's frames from its node.data entry, falling back to the
 *  slot's default factory table. Reuses the SAME factory-table + frame-plain
 *  helpers as WAVESCULPT (no duplication). */
export function resolveSlotFrames(
  slot: CubeSlot,
  slotData: CubeSlotData | undefined,
): ResolvedFrames {
  const src = slotData?.source ?? `factory:${CUBE_DEFAULT_TABLES[slot]}`;
  if (src === 'user' && Array.isArray(slotData?.frames) && slotData!.frames!.length > 0) {
    return {
      frames: framesFromPlain(slotData!.frames!),
      label: slotData?.label ?? 'USER',
      signature: `user:${slotData!.frames!.length}:${slotData?.label ?? ''}`,
    };
  }
  if (src.startsWith('factory:')) {
    const id = src.slice('factory:'.length);
    const t = getFactoryTable(id) ?? getFactoryTable(CUBE_DEFAULT_TABLES[slot]);
    if (t) {
      return {
        frames: t.frames.map((f) => new Float32Array(f)),
        label: t.label,
        signature: `factory:${t.id}`,
      };
    }
  }
  const t = getFactoryTable(CUBE_DEFAULT_TABLES[slot]) ?? getFactoryTable(DEFAULT_FACTORY_TABLE_ID)!;
  return {
    frames: t.frames.map((f) => new Float32Array(f)),
    label: t.label,
    signature: `factory:${t.id}`,
  };
}

export const cubeDef: AudioModuleDef = {
  type: 'cube',
  palette: { top: 'Hybrid', sub: 'Hybrid' },
  domain: 'audio',
  label: 'cube',
  category: 'sources',
  // CubeCard renders the 3D wavetable cube via a real WebGL2 context → this
  // audio-domain module is a GPU render path. The marker mechanically pulls
  // cube.ts into the WebGL content-hash basis + is cross-checked against the
  // card's getContext('webgl2') by the §12 coverage guard.
  rendersWebGL: true,

  inputs: [
    // V/oct pitch — the only audio-rate MONO node input the worklet reads directly.
    { id: 'pitch', type: 'cv' },
    // Polyphonic chord bus (5 voice pairs of pitch+gate over 10 channels). When
    // gated, CUBE renders one phase accumulator per lane → polyphonic; the mono
    // `pitch` input is the fallback when nothing is patched here. Engine routes
    // this 10-channel cable to ONE worklet input (index 1) — same shape as
    // DX7.poly. Listed right after `pitch` so it reads as the pitch family.
    { id: 'poly', type: 'polyPitchGate' },
    // Mono TRIGGER gate (per-voice-ADSR feature). A level gate (not a pulse) so
    // note-off→release is expressible. The FIRST rising edge ever seen turns CUBE
    // into a gated voice (lane-0 envelope shapes the mono oscillator); before any
    // note (and when unpatched) CUBE free-runs as a drone. Routes to worklet
    // input 2 (a node connection, not a CV→AudioParam target).
    { id: 'trigger', type: 'gate', edge: 'gate' },
    // CV → AudioParam (summed into the worklet param by the engine).
    { id: 'slice_y',  type: 'cv', paramTarget: 'slice_y',  cvScale: { mode: 'linear' } },
    { id: 'slice_rx', type: 'cv', paramTarget: 'slice_rx', cvScale: { mode: 'linear' } },
    { id: 'slice_ry', type: 'cv', paramTarget: 'slice_ry', cvScale: { mode: 'linear' } },
    { id: 'slice_rz', type: 'cv', paramTarget: 'slice_rz', cvScale: { mode: 'linear' } },
    { id: 'morph_fc', type: 'cv', paramTarget: 'morph_fc', cvScale: { mode: 'linear' } },
    { id: 'connect',  type: 'cv', paramTarget: 'connect',  cvScale: { mode: 'linear' } },
    { id: 'connect_strength', type: 'cv', paramTarget: 'connect_strength', cvScale: { mode: 'linear' } },
    { id: 'crush',    type: 'cv', paramTarget: 'crush',    cvScale: { mode: 'linear' } },
    { id: 'space_crush',   type: 'cv', paramTarget: 'space_crush',   cvScale: { mode: 'linear' } },
    { id: 'space_diffuse', type: 'cv', paramTarget: 'space_diffuse', cvScale: { mode: 'linear' } },
    { id: 'fold_cv',  type: 'cv', paramTarget: 'fold',     cvScale: { mode: 'linear' } },
    { id: 'tune',     type: 'cv', paramTarget: 'tune',     cvScale: { mode: 'linear' } },
  ],
  // SEPARATE L / R audio out (issue #1). The worklet's single 2-channel output
  // is split by a ChannelSplitter(2) in the factory so each port carries one
  // channel — patching L and R into mono inputs preserves the ±SPREAD width
  // (a single stereo port would downmix to mono and erase it). LITERAL array —
  // the module-manifest static extractor reads this directly.
  outputs: [
    { id: 'L', type: 'audio' },
    { id: 'R', type: 'audio' },
    // SYNC — a pure SINE at the playback fundamental, PHASE-LOCKED to the L/R
    // slice readout (the worklet reads it off the SAME phase accumulator). Hard-
    // sync other oscillators to CUBE or use it as a clean reference / sub. Mono;
    // mapped from the worklet's 2nd output (index 1). Additive — the L/R slice
    // audio is byte-identical to before.
    { id: 'sync', type: 'audio' },
    // Cross-domain mono-video out (issue: video out of the 3D CUBE view). The
    // card installs a frame-drawer that renders its live WebGL 3D cube into the
    // bridge's canvas each video frame; patch this into VIDEOOUT / any video
    // module. Mirrors WAVESCULPT.video_out + WARRENSPECTRUM.viz_out.
    { id: 'video_out', type: 'mono-video' },
  ],
  // LITERAL array — the module-manifest static extractor reads this directly.
  params: [
    { id: 'tune',     label: 'Tune',    defaultValue: 0,   min: -36,  max: 36,  curve: 'linear', units: 'st' },
    { id: 'fine',     label: 'Fine',    defaultValue: 0,   min: -100, max: 100, curve: 'linear', units: '¢' },
    { id: 'morph_fc', label: 'Morph',   defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' },
    { id: 'connect',  label: 'Connect', defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' },
    // CONNECT STRENGTH — overshoot the connector's interior control point "out of
    // the cube" for a dramatic base swell (0 = today's exact shape). Lives next
    // to CONNECT. CV via the connect_strength input.
    { id: 'connect_strength', label: 'Cnct Str', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    { id: 'crush',    label: 'Crush',   defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' },
    // SPACE CRUSH — independent spatial voxelization of the FIELD lookup coords
    // (chunky voxels, 0 = transparent). SPACE DIFFUSE — gravity pulling the
    // sample cloud toward the cube's emptiest wall (0 = off). Both CV-routed.
    { id: 'space_crush',   label: 'Space Crush',  defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    { id: 'space_diffuse', label: 'Space Diffuse', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    // FOLD — West-coast wavefolder on the output (0 = pass-through, max = hard
    // fold, adds harmonics). Applied in cube-dsp.applyFold after the slice is
    // sampled, before LEVEL, on both L and R. CV via the fold_cv input.
    { id: 'fold',     label: 'Fold',    defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' },
    { id: 'spread',   label: 'Spread',  defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' },
    { id: 'slice_y',  label: 'Y',       defaultValue: 0.5, min: 0,    max: 1,   curve: 'linear' },
    { id: 'slice_rx', label: 'Rot X',   defaultValue: 0,   min: -3.1416, max: 3.1416, curve: 'linear' },
    { id: 'slice_ry', label: 'Rot Y',   defaultValue: 0,   min: -3.1416, max: 3.1416, curve: 'linear' },
    { id: 'slice_rz', label: 'Rot Z',   defaultValue: 0,   min: -3.1416, max: 3.1416, curve: 'linear' },
    { id: 'level',    label: 'Level',   defaultValue: 1,   min: 0,    max: 2,   curve: 'linear' },
    // Per-voice amplitude ADSR (per-voice-ADSR feature). A single A/D/S/R set
    // feeds all 5 lane envelopes (poly) + lane-0 (mono TRIGGER). Defaults are
    // ~pass-through so an untouched ADSR + an ungated/unpatched TRIGGER keeps
    // CUBE's legacy free-running drone byte-identical. The envelope only shapes
    // amplitude once a poly lane or the TRIGGER fires.
    { id: 'attack',  label: 'A', defaultValue: 0.001, min: 0.001, max: 5, curve: 'log', units: 's' },
    { id: 'decay',   label: 'D', defaultValue: 0.1,   min: 0.001, max: 5, curve: 'log', units: 's' },
    { id: 'sustain', label: 'S', defaultValue: 1,     min: 0,     max: 1, curve: 'linear' },
    { id: 'release', label: 'R', defaultValue: 0.005, min: 0.001, max: 5, curve: 'log', units: 's' },
    // BASE VOL — per-voice VCA FLOOR the ADSR rides on top of: gain =
    // base + (1-base)*env per ACTIVE voice. Sits next to the ADSR. 0 (the
    // DEFAULT) → pure ADSR; 0.5 → floors at 0.5 and rises to 1.0 as the env
    // peaks; 1 → gain=1 and the env does nothing.
    // ⚠ The default WAS 1, which made the entire amp ADSR a no-op out of the box
    // (gain = 1 + 0·env) — the same defect #1350 fixed in WAVECEL and explicitly
    // flagged here. Measured through the real worklet: identical rise-to-90 %
    // (1.33 ms) at ATTACK 1 ms and ATTACK 2 s in BOTH the mono-TRIG and the poly
    // path, a gated render BYTE-IDENTICAL to the undriven drone over the
    // gate-high window, and a 0.505 (mono) / 0.426 (poly) full-scale note-off cut
    // against a 0.028 in-note slope. The raw-VCO drone that the default of 1
    // existed to preserve is now preserved DIRECTLY in the worklet's unpatched
    // branch (verified byte-identical), so the two no longer trade off. Must stay
    // in step with the `base_vol` AudioParam descriptor in packages/dsp/src/
    // cube.ts — joined by cube-envelope.test.ts.
    { id: 'base_vol', label: 'Base', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    // Toggles (discrete). wrap: 0=silent-outside, 1=mirror-fold. material:
    // 0=SMOOTH (continuous density), 1=HARD (binary solid).
    { id: 'wrap',     label: 'Wrap',     defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
    { id: 'material', label: 'Material', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
    // View-only (NOT audio): WebGL camera transform. CV-not-routed (no
    // paramTarget input) and ignored by the worklet — the card reads them.
    // ⚠ There is no `view_rot_z`. It shipped as a def param, a card knob and a
    // documented sentence ("orbits the 3D view") and was read by NOTHING:
    // `renderGl` takes only zoom/rot_x/rot_y, the eye vector is built from
    // vrx/vry alone, and `sceneSig` omitted it — so turning it could not even
    // schedule a repaint. Removed rather than implemented; VIDEOCUBE, which has
    // a real camera roll, keeps its own `view_rot_z` and is unaffected.
    { id: 'view_zoom',  label: 'Zoom',  defaultValue: 1, min: 0.3, max: 3, curve: 'log' },
    { id: 'view_rot_x', label: 'View X', defaultValue: 0.6, min: -3.1416, max: 3.1416, curve: 'linear' },
    { id: 'view_rot_y', label: 'View Y', defaultValue: 0.7, min: -3.1416, max: 3.1416, curve: 'linear' },
    // SCREEN on/off (view-only, NOT audio): 1 = the 3D viz screen renders,
    // 0 = the screen is OFF. When OFF *and* video_out is unpatched the card
    // skips ALL visual computation (the rAF render loop + the display-only
    // field/slice/wave draws) — the biggest perf win for CUBE — while audio
    // keeps running untouched. Discrete; ignored by the worklet (the card reads
    // it). Persisted on node.params so the toggle survives reload. (v4 perf.)
    { id: 'screen_on',  label: 'Screen', defaultValue: 1, min: 0, max: 1, curve: 'discrete' },
  ],
  // The TWO controls with no backing ParamDef, declared as one-member families
  // so `face.order` can RANK them, `docs.controls` can key prose to them and
  // shell-cells can name the component (the kickdrum/macrooscillator
  // precedent). Neither writes a param; neither emits a `control-<paramId>`
  // testid.
  controlFamilies: [
    // THE PICTURE. Promoted into the faceplate's hero slot — the volume render,
    // the 2-D slice cross-section and the output wave, i.e. the SAME three
    // surfaces the legacy card paints, from the same component. It is the only
    // surface anywhere that shows the CUT inside the SOLID, which is the whole
    // instrument.
    { id: 'cube-view', label: 'Cube view', kind: 'cell', testidPrefix: 'cube-view' },
    // THE THREE WAVETABLE SLOTS as one panel. Nine DOM-only controls on the
    // legacy card (three selects, three preset selects, three loaders) for
    // THREE decisions; the second dropdown per slot is a Svelte-binding
    // workaround, not a second choice. Folded here so the shell face can reach
    // them at all — the DX7 shipped with its voice unreachable under `?shell=1`
    // for exactly this reason.
    { id: 'cube-table-stack', label: 'Table stack', kind: 'cell', testidPrefix: 'cube-table-stack' },
  ],

  // ── THE FACEPLATE ─────────────────────────────────────────────────────────
  //
  // ⚠ SIX BANDS IS LOAD-BEARING. `DOCK_TAB_MIN_BANDS` is 7, and a seventh band
  // flips the whole face to a TAB RAIL: row packing stops and every band hint
  // below stops painting. Add a CLUSTER, never a seventh page.
  //
  // THE PARADIGM. cube has two nouns — the SOLID you build and the SLICE you
  // read it with — and the measurement says the SLICE owns the timbre by 5×
  // (`slice_ry` 0.885 rmsΔ over its travel against `morph_fc`'s 0.178), so the
  // slice comes first. That is the exact INVERSE of the def's own param order
  // and of the legacy card, both of which lead with TUNE / FINE / MORPH /
  // CONNECT and bury the three rotations 12th–14th of 15. Everything after the
  // two nouns is post-processing, playback and the camera.
  //
  // Numbers cited here are re-measured on the SHIPPED default tables
  // (basic-shapes / pwm-sweep / harmonic-sweep) — they are NOT the pre-#1448
  // figures, and three of that era's headline defects are simply gone: CRUSH
  // and SPACE DIFFUSE no longer collapse to DC at their maximum (`acRms`
  // 0.5528 and 0.2450 where both once read 0.000000), and the two-table
  // pigeonhole that killed CONNECT is fixed by the third table.
  face: {
    order: [
      // RANKS 1-6 — the LANE budget (`faceTierCap('full')` is 6). Every one of
      // these is top-6 measured, except `slice_y`, which is ranked on what it
      // does ONCE RANKS 1-2 ARE USED (0.115 flat, 0.759 at rx 0.8) — which is
      // the point of seating it beside them.
      'slice_ry', 'slice_rz', 'slice_y', 'wrap', 'morph_fc', 'fold',
      // 7+ — dock only.
      // `slice_rx` measures 0.403 (5th) and is deliberately NOT in the lane:
      // f(rx) ≡ f(rx ± π) BIT-EXACTLY (rmsΔ 0.000e+0 at six angles, with ROT Y
      // as the live control at 0.29–0.78), so half its declared travel is a
      // duplicate and a lane cell should not be 50 % redundant.
      'slice_rx',
      'connect', 'connect_strength', 'material',
      'crush', 'space_crush', 'space_diffuse',
      'tune', 'fine', 'spread', 'level',
      'attack', 'decay', 'sustain', 'release', 'base_vol',
      'view_zoom', 'view_rot_x', 'view_rot_y', 'screen_on',
      // The two PANELS rank LAST so neither can ever land inside the 6-cell
      // lane plate (a 300 px picture in a 192 px tile). The dock promotes
      // `cube-view` into the hero regardless of its rank.
      'cube-table-stack-{n}', 'cube-view-{n}',
    ],
    glyph: 'scope',

    // ⚠ ANNOTATION ONLY — `facePageHeader(def, annotations = false)` returns
    // null before it reads anything, so NOTHING load-bearing lives here. Every
    // fact a player needs at rest is on a band label, a readout, a preset note
    // or the hero caption, all of which paint unconditionally.
    title: 'Solid & slice',
    hint:
      'A static 3-D density field, read by one movable plane. The 256 samples that plane reads ARE ' +
      'the waveform — so the rotation knobs are the timbre controls and the pitch knobs only decide ' +
      'how fast that cycle repeats.',

    hero: {
      cell: 'cube-view-{n}',
      control: 'slice_ry',
      // No `action`: cube has no audition seam. Its handle exposes only
      // `snapshot`/`live`/`tableLabels`/`frames`, so a hero button would be a
      // `toBeEnabled()`-passing dead control — exactly the class
      // `ShellActionCell.probe` is required for.
      //
      // ⚠ ALL FOUR READOUTS ARE DERIVED, and each because the nearest knob is
      // BLIND to something that changes the answer:
      //   cut    — no knob shows the plane's TILT; it is all three rotations at
      //            once, and it is the quantity `Y` depends on.
      //   Y      — the module's single most important fact. `slice_y` is a real
      //            control that is inert in exactly ONE state: the state it
      //            spawns in. A `paramId: 'slice_y'` readout prints 0.50 in
      //            both, which is the whole problem.
      //   levels — CRUSH's top 0.8 % is a flat detent; the knob keeps climbing
      //            while the quantiser has stopped moving.
      //   width  — SPREAD's real depth, from the DSP constant. Five doc strings
      //            said ±5 % against a shipped 0.18 because the number was
      //            re-typed; this one imports it.
      readouts: [
        { label: 'cut', valueId: 'cube-cut-tilt' },
        { label: 'Y', valueId: 'cube-y-live' },
        { label: 'levels', valueId: 'cube-crush-levels' },
        { label: 'width', valueId: 'cube-spread-depth' },
      ],
    },

    pages: [
      {
        id: 'slice',
        // ⚠ THE LABEL CARRIES THE IDEA AT REST — hints are annotation and OFF
        // by default, so a band leaning on its hint says nothing to the player
        // who never turns them on.
        label: '1 · the slice — this is the timbre',
        hint:
          'Where the plane sits, and what happens where it leaves the solid. ROT Y and ROT Z are the ' +
          'two strongest controls on the module (0.885 / 0.877), but they are not the same KIND of ' +
          'control: ROT X and ROT Y TILT the plane, while ROT Z spins the scan line inside it and ' +
          'leaves the plane where it was. Y only does anything once the plane is genuinely tilted — ' +
          'flat, it slides along its own normal and the ray window slides with it.',
        controls: ['cube-view-{n}', 'slice_ry', 'slice_rz', 'slice_rx', 'slice_y', 'wrap'],
      },
      {
        id: 'solid',
        label: '2 · the solid — three tables stacked',
        hint:
          'MORPH cross-fades FLOOR↔CEILING through WALL. All three slots must hold DIFFERENT tables ' +
          'or one control dies by arithmetic: floor = ceiling makes MORPH inert, and either connector ' +
          'slot matching WALL kills CONNECT outright. The panel draws the three and names the casualty.',
        controls: ['cube-table-stack-{n}', 'morph_fc', 'connect', 'connect_strength', 'material'],
      },
      {
        id: 'grain',
        label: '3 · grain',
        hint:
          'Quantise the value, then the lookup coordinates. CRUSH bit-reduces the read-out wave; SPACE ' +
          'CRUSH voxelises the 3-D lookup; SPACE DIFFUSE pulls the sample cloud at the emptiest wall — ' +
          'and is NOT monotonic (its audio thins to 0.081 acRms around 0.9 and returns by 1.0).',
        controls: ['crush', 'space_crush', 'space_diffuse', 'fold'],
      },
      {
        id: 'pitch',
        label: '4 · pitch · out',
        hint:
          'The table is always 256 samples, so this is a plain wavetable oscillator with NO ' +
          'band-limiting. SPREAD reads the L and R planes ±18 % of the march depth apart — a real ' +
          'offset, but a narrow image (−36 dB side against mid at the stop).',
        controls: ['tune', 'fine', 'spread', 'level'],
      },
      {
        id: 'env',
        label: '5 · voice envelope',
        hint:
          'Shapes a note only when POLY or TRIG is patched — unpatched, cube free-runs at full level ' +
          'and none of these five do anything.',
        controls: ['attack', 'decay', 'sustain', 'release', 'base_vol'],
        clusters: [{ label: 'VCA floor', controls: ['base_vol'] }],
      },
      {
        id: 'view',
        label: 'view',
        hint:
          'Camera only — none of these touch a sample. Dragging the hero picture writes the same two ' +
          'angles. SCREEN off (with VIDEO unpatched) skips all visual computation.',
        controls: ['view_zoom', 'view_rot_x', 'view_rot_y', 'screen_on'],
      },
    ],

    // The one rear override. Every CV jack here except `pitch` is summed into
    // an AudioParam the worklet reads ONCE PER BLOCK (~375 Hz), quantised to
    // 1/512 of range and smoothed at an 80 Hz corner — so they are CONTROL-rate
    // inputs wearing an audio-rate cable, and an audio-rate LFO into `morph_fc`
    // will alias rather than FM. This tick is the only place that is visible.
    rear: { audioRate: ['pitch'] },

    sidebar: [
      {
        // ⚠ THIS BLOCK IS THE FACE'S BEST WORK, and it is four param writes.
        // cube's default state HIDES ITS OWN STRONGEST INTERACTION: at spawn
        // the plane is flat, so Y slides along its own normal and does almost
        // nothing (0.115), and one nudge of ROT X makes it a 0.759 control.
        // `FacePreset.note` paints unconditionally, so this is where that fact
        // can live — one click, and the readout above flips `asleep` → `live`.
        kind: 'presets',
        label: 'set the plane',
        entries: [
          { id: 'flat', label: 'flat scan', note: 'Y asleep', values: { slice_rx: 0, slice_ry: 0, slice_rz: 0, slice_y: 0.5, wrap: 0 } },
          { id: 'tilted', label: 'tilted', note: 'Y × 6.6', values: { slice_rx: 0.8, slice_ry: 0, slice_rz: 0, slice_y: 0.5 } },
          { id: 'quarter', label: 'quarter turn', note: '⚠ flattens', values: { slice_rx: 0, slice_ry: 1.5708, slice_rz: 0 } },
          { id: 'mirror', label: 'mirror', note: 'DC 1.06→0.07×', values: { wrap: 1, slice_rx: 0, slice_ry: 0, slice_rz: 0 } },
        ],
      },
      {
        kind: 'readouts',
        label: 'this plane',
        // ⚠ EVERY VALUE STAYS SHORT. The sidebar content column is 258 px and a
        // longer value pushes the dock past its right edge; the formatter's
        // width is asserted across the whole param space in the model test.
        entries: [
          { label: 'f0 (knobs)', valueId: 'cube-f0-knobs' },
          { label: 'harmonics', valueId: 'cube-harmonics' },
          { label: 'fold drive', valueId: 'cube-fold-drive' },
          { label: 'CV rate', text: '≈375 Hz · 1/512' },
          { label: 'band-limiting', text: 'none — it aliases' },
        ],
      },
    ],
  },

  docs: {
    explanation:
      "A 3D wavetable-terrain oscillator. CUBE stacks THREE e352-style wavetables — FLOOR, WALL, and CEILING (each chosen from a factory table, a baked preset, or a loaded .wav) — into a solid 3D scalar field, then plays the heightmap of an arbitrary flat plane sliced through that field as its waveform. You aim the slicing plane with one height knob (Y) and three rotation knobs (Rot X / Y / Z); as the plane tilts and rises it carves a different surface contour, so sweeping those knobs (or their CV inputs) morphs the timbre continuously. MORPH cross-fades the floor↔ceiling layers, CONNECT (with CONNECT STRENGTH) bulges the field's interior, CRUSH bit-reduces the read-out waveform while SPACE CRUSH voxelizes and SPACE DIFFUSE warps the 3D lookup coordinates, and FOLD is a west-coast wavefolder on the output — together they sculpt the slice from clean to mangled. It is a pitched V/oct oscillator with a stereo SPREAD that reads the L and R planes up to ±18% of the march depth apart (the shared CUBE_SPREAD_DEPTH constant — the offset is real but the resulting image is narrow, about -36 dB of side against mid at the stop) and an internal per-voice A/D/S/R envelope that shapes amplitude once a note arrives on the poly bus or the TRIG gate, riding on top of a BASE volume floor: at the default BASE of 0 the envelope has full control of each note, and turning BASE up floors the voice so the envelope only swells it the rest of the way. With nothing patched into POLY or TRIG there is no note to shape and CUBE free-runs as a continuous full-level drone. A live WebGL 3D render of the cube, the cut plane, the slice cross-section, and the output waveform is shown on the card and can be sent out the VIDEO port; the screen can be switched off to save GPU when you only want sound.",
    inputs: {
      pitch:
        "Mono V/oct pitch control voltage — the standard 1V-per-octave oscillator pitch input, read directly by the worklet, and the ONLY audio-rate input on the module: every other CV jack here is summed into an AudioParam the worklet samples once per block (~375 Hz), quantised to 1/512 of the param range and smoothed at an 80 Hz corner, so an audio-rate source into one of them aliases rather than modulates. This is the fallback voice when nothing is patched into POLY; summed with the TUNE and FINE offsets to set the playback fundamental.",
      poly:
        "Polyphonic chord bus (the 10-channel pitch+gate cable from MIDI LANE in poly mode or POLYSEQZ). Each gated lane renders its own phase accumulator through the same sliced waveform at that lane's pitch and they sum — so CUBE plays a whole chord. While any lane is gated this bus drives the voices; with nothing patched here the mono PITCH path runs instead (back-compat).",
      trigger:
        "Mono gate for the per-voice amplitude envelope: while the level is high the ADSR holds open (attack→decay→sustain) and on the falling edge it releases. PATCHING it turns CUBE into a gated voice shaped by the lane-0 envelope: it is silent until the first gate and then follows every one. When this input (and POLY) is unpatched the amplitude env has nothing to shape and CUBE free-runs as a continuous drone.",
      slice_y:
        "CV that offsets the Y param — raises or lowers the slicing plane's height through the cube, scanning it across the floor→ceiling stack.",
      slice_rx:
        "CV that offsets the Rot X param — tilts the slicing plane about the X axis (±π), changing the surface contour it reads.",
      slice_ry:
        "CV that offsets the Rot Y param — tilts the slicing plane about the Y axis (±π).",
      slice_rz:
        "CV that offsets the Rot Z param — rotates the slicing plane about the Z axis (±π).",
      morph_fc:
        "CV that offsets the Morph param, cross-fading the floor↔ceiling wavetable layers of the field.",
      connect:
        "CV that offsets the Connect param, blending the floor and ceiling into a connected interior shape.",
      connect_strength:
        "CV that offsets the Connect Strength param, pushing the connector's interior control point further out for a more dramatic swell.",
      crush:
        "CV that offsets the Crush param, driving the bit/sample reduction applied to the slice's read-out waveform.",
      space_crush:
        "CV that offsets the Space Crush param, quantizing (voxelizing) the 3D field-lookup coordinates into chunky blocks.",
      space_diffuse:
        "CV that offsets the Space Diffuse param, warping the lookup coordinates toward the cube's emptiest wall.",
      fold_cv:
        "CV that offsets the Fold param, modulating the output wavefolder depth (added harmonics).",
      tune:
        "CV that offsets the Tune param, shifting pitch in semitones around the base note (summed with the PITCH input and the FINE knob).",
    },
    outputs: {
      L: "Left audio channel of the sliced oscillator, including the −5% SPREAD plane offset, post-FOLD and post-LEVEL. Split out as its own mono port so the stereo width survives even when patched into a mono input.",
      R: "Right audio channel, including the +5% SPREAD plane offset (the partner of L). Together L and R carry the spread stereo image; pan/mix them to keep the width.",
      sync:
        "A pure SINE at the playback fundamental, phase-locked to the L/R slice read-out (it reads off the same phase accumulator). Use it to hard-sync another oscillator to CUBE, or as a clean reference / sub-oscillator tone. ⚠ It is NOT scaled by LEVEL and it is HOTTER than the audio: SYNC leaves at -3.01 dBFS against the L/R pair's -9.14 dBFS at the default knobs, so mixing SYNC alongside L and R is a +6.1 dB step, and turning LEVEL down does not touch it.",
      video_out:
        "A mono-video output carrying a live render of the 3D cube view — the translucent field volume, the cut plane positioned by Y + the rotation knobs, and the output waveform. Patch it into VIDEOOUT or any video module; it keeps emitting frames even when the on-card SCREEN is switched off.",
    },
    controls: {
      tune: "Coarse pitch in semitones (−36..+36), summed with the FINE offset and the PITCH/TUNE CV to set the oscillator fundamental.",
      fine: "Fine pitch trim in cents (−100..+100) for tuning between the semitone steps of TUNE.",
      morph_fc: "Cross-fades the FLOOR↔CEILING wavetable layers of the 3D field (0 = floor, 1 = ceiling), reshaping the terrain the plane slices through.",
      connect: "Blends the floor and ceiling layers into a single connected interior shape (0 = today's separate shape, 1 = fully connected); CV via the CONNECT input.",
      connect_strength: "Overshoots the connector's interior control point 'out of the cube' for a dramatic base swell (0 = the exact CONNECT shape, max = pushed furthest out). Works alongside CONNECT.",
      crush: "Bit/sample reduction applied to the slice's read-out waveform (0 = clean, max = heavily crushed) for digital grit.",
      space_crush: "Voxelizes the 3D field-lookup coordinates into chunky blocks (0 = transparent/smooth, max = blocky), aliasing the spatial sampling for a chunkier timbre.",
      space_diffuse: "Adds a 'gravity' that pulls the field sample cloud toward the cube's emptiest wall (0 = off), smearing the lookup coordinates.",
      fold: "West-coast wavefolder on the output (0 = pass-through, max = hard fold), applied after the slice is sampled and before LEVEL on both L and R, adding harmonics; CV via the FOLD input.",
      spread: "Stereo width: at higher values the L and R taps read planes offset by up to ±18% of the ray-march depth (CUBE_SPREAD_DEPTH), so the two channels diverge (0 = mono, both channels identical). Measured, the resulting image is narrow — about -36 dB of side against mid at the stop, and the two channels stay 0.99998 correlated — so treat it as a widener, not a stereo field.",
      slice_y: "Height of the slicing plane through the cube (0..1) — scans the cut from the floor up to the ceiling. CV via the Y input. ⚠ ITS AUTHORITY DEPENDS ENTIRELY ON THE PLANE'S ORIENTATION, and it is at its WEAKEST in the state CUBE spawns in. The ray march integrates over a fixed ±√3/2 window CENTRED ON THE RAY ORIGIN, so sliding the plane along its own normal moves the window and its contents together — very nearly a no-op — and at spawn the normal IS the z axis, which is the direction this knob translates along. Measured max rmsΔ across the whole of Y: 0.115 flat, 0.317 at ROT X 0.4, 0.759 at ROT X 0.8. Tilt the plane first and Y becomes one of the strongest controls on the module; the faceplate prints 'asleep' or 'live' beside it for this reason.",
      slice_rx: "Rotation of the slicing plane about the X axis (±π radians), tilting which surface contour it reads. CV via the ROT X input. ⚠ HALF THIS TRAVEL IS A DUPLICATE: at SPREAD 0 the waveform is bit-exactly π-periodic in this knob (rmsΔ between a and a−π is 0.000e+0 at every angle measured), because the scan offset is built from a vector with y = z = 0 and the X rotation is applied first, so ROT X only ever flips the plane normal — and the ray march window is symmetric about the origin. It is not EVEN, though: f(a) ≠ f(−a). Above SPREAD 0 the ±depth offset rides the normal, so a and a+π swap L and R instead of being identical.",
      slice_ry: "Rotation of the slicing plane about the Y axis (±π radians). CV via the ROT Y input.",
      slice_rz: "Rotation of the slicing plane about the Z axis (±π radians). CV via the ROT Z input. ⚠ IT DOES NOT TILT THE PLANE — it spins the SCAN LINE inside it. A Z rotation cannot move a vector lying on the Z axis, and the plane's normal at rest IS the Z axis, so this knob re-aims which line across the cut is read out while leaving the cut itself exactly where it was. That is why it is the module's second strongest control (0.877 rmsΔ over its travel) and yet leaves Y asleep: Y is still sliding along the plane's own normal. ROT X or ROT Y first, then Y.",
      level: "Output gain on the sliced audio (0..2, applied after FOLD); 1 = unity, above 1 boosts.",
      attack: "Per-voice amplitude envelope ATTACK time (0.001..5 s, log) — how long each note takes to rise to full from note-on. Drives both the poly lane envelopes and the mono TRIG voice.",
      decay: "Per-voice envelope DECAY time (0.001..5 s, log) — how long the level falls from the attack peak down to the SUSTAIN level.",
      sustain: "Per-voice envelope SUSTAIN level (0..1) — the level held while the note's gate stays high after the decay stage.",
      release: "Per-voice envelope RELEASE time (0.001..5 s, log) — how long the level fades to silence after the note's gate falls.",
      base_vol: "Per-voice VCA floor the ADSR rides on top of (gain = base + (1−base)·env): at 0 (default) the envelope has full control of every note and the voice is silent between notes; 0.5 floors each voice at half and the env swells it up to full on note-on; at 1 gain is always full while a voice is active, so the envelope does nothing. It only applies to GATED voices — with nothing patched into POLY or TRIG, CUBE free-runs at full level whatever this is set to.",
      wrap: "What happens when the slicing plane reads outside the cube: OFF = those regions are silent, ON = the coordinates mirror-fold back inside so the slice stays full.",
      material: "Field density model: SMOOTH (0) = continuous density gradients, HARD (1) = a binary solid (sharp inside/outside), which makes the sliced waveform edgier.",
      view_zoom: "Visualization-only camera zoom for the 3D cube view (does not affect the sound or the selected slice).",
      view_rot_x: "Visualization-only camera rotation about X — orbits the 3D view (no effect on audio).",
      view_rot_y: "Visualization-only camera rotation about Y — orbits the 3D view (no effect on audio).",
      screen_on: "Turns the on-card 3D viz screen on/off. When OFF and the VIDEO output is unpatched, the card skips all visual computation (the render loop and the field/slice/wave draws) to save GPU — audio keeps running untouched. A patched VIDEO output still receives live frames even with the screen off.",
      // The two controls with NO backing ParamDef — declared as one-member
      // control families above and keyed here as `<familyId>-{n}`.
      "cube-view-{n}":
        "The faceplate's hero picture, and the SAME renderer the card uses rather than a reduction of it. Three surfaces: the rotatable WebGL2 VOLUME (the density field as a stack of alpha-blended Z-slices, the cube wireframe, and the live slicing plane sitting exactly where Y and ROT X/Y/Z put it), the 2-D SLICE cross-section (the field the plane actually cuts, as a heatmap across all three tables), and the OUTPUT waveform (the 256 samples the scan read, which ARE one cycle of the sound). Drag the volume to orbit the camera — it writes the same VIEW X / VIEW Y params the knobs in the VIEW band write, and the printed angle beside it is how you can tell a live drag from a dead one. Two caption numbers exist because no knob on the module shows them: how much SOLID the plane cut through, and the wave's DC against its audio — CUBE's L and R carry more DC than signal at the defaults (|DC| is 1.06x the AC RMS), and WRAP is the only control that re-centres it. The third, the count of distinct sample values, is there because RMS is the wrong instrument for MATERIAL: SMOOTH to HARD moves RMS by 0.040, last of thirteen, while the distinct-value count falls 180 to 28.",
      "cube-table-stack-{n}":
        "All three wavetable slots in one panel: FLOOR, WALL and CEILING drawn as heightfield strips in stack order, each with its roster of factory tables, the baked-preset list and a .WAV loader. It replaces nine controls on the legacy card that expressed three decisions — the per-slot preset dropdown there is a workaround for a Svelte binding that will not re-fire on an unchanged value, not a second choice. The panel also names the casualty of a slot COINCIDENCE, which is the one way this module can still be silenced by arithmetic rather than by a knob: the field is a morph between the floor-to-wall and ceiling-to-wall occupancies, so FLOOR = CEILING makes MORPH inert, and either connector slot matching WALL sends the occupancy function into its degenerate hard-step branch and kills CONNECT and CONNECT STRENGTH outright. The shipped defaults are three distinct tables and nothing is dead; you are one pick away from that not being true, so the panel says so while it is happening rather than afterwards.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const initialParams = (node.params ?? {}) as Record<string, number>;
    const live: Record<string, number> = {};
    for (const p of cubeDef.params) live[p.id] = initialParams[p.id] ?? p.defaultValue;

    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // Two outputs: output 0 = the stereo L/R slice audio (fanned into separate
    // L/R ports via the ChannelSplitter below), output 1 = the mono SYNC sine
    // (a phase-locked reference, exposed directly as the `sync` port). Node
    // inputs: input 0 = mono pitch (the CV→AudioParam inputs also sum into
    // input 0's AudioParams via the engine), input 1 = the 10-channel poly bus.
    // channelCountMode defaults to 'max', so the 10-channel poly source passes
    // through to the worklet intact.
    const workletNode = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      // 3 inputs: pitch (input 0, also CV→AudioParam sum target), poly (input 1,
      // 10-channel bus), trigger (input 2, mono gate for the per-voice ADSR).
      numberOfInputs: 3,
      numberOfOutputs: 2,
      outputChannelCount: [2, 1],
    });
    const params = workletNode.parameters as unknown as Map<string, AudioParam>;

    // Fan the worklet's 2-channel output into SEPARATE L / R node ports (issue
    // #1) so the spread survives downstream. Each port carries one channel from
    // the splitter (output 0 = L, output 1 = R). WAVESCULPT uses the same
    // ChannelSplitter(2) → per-channel-port pattern.
    const splitter = ctx.createChannelSplitter(2);
    workletNode.connect(splitter, 0); // output 0 = stereo L/R slice audio

    // Video-out analyser tap (cross-domain mono-video). The bridge ignores the
    // analyser when a drawFrame is supplied, but the videoSources contract still
    // requires an AnalyserNode handle; tap the worklet's stereo output for it.
    const videoAnalyser = ctx.createAnalyser();
    videoAnalyser.fftSize = 256;
    workletNode.connect(videoAnalyser, 0); // output 0 = stereo L/R slice audio

    // Mirror initial knob values into worklet params (only the ones the
    // worklet actually declares; view_* + spread/fine handled below).
    for (const def of cubeDef.params) {
      const ap = params.get(def.id);
      if (ap) ap.setValueAtTime(live[def.id] ?? def.defaultValue, ctx.currentTime);
    }

    // Keep the worklet alive even with nothing patched into pitch.
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(workletNode, 0, 0);

    // Per-voice-ADSR: a 0-offset keep-alive on the TRIGGER input (input 2) so it
    // schedules when unpatched (0 gate = "no note"). Feeds ONLY the trigger input,
    // never pitch. NOTE: because this ConstantSource is always connected, the
    // worklet CANNOT tell from bus presence whether the TRIGGER is actually
    // patched — so connectedness is pushed explicitly via the params below.
    const trigSilence = ctx.createConstantSource();
    trigSilence.offset.value = 0;
    trigSilence.start();
    trigSilence.connect(workletNode, 0, 2);

    // ── CONNECTEDNESS (no-stray-drone fix) ──
    // The GATING MODE (gated vs. continuous raw VCO) is decided by whether the
    // `poly` / `trigger` ports are PATCHED — read from the live patch EDGES (the
    // engine's source of truth), NOT from bus presence (the trigger keep-alive
    // above masks it). Push the two flags as k-rate worklet params; refreshed on
    // init + every poll so connecting / disconnecting a cable flips the mode.
    const pPolyConn = params.get('poly_connected');
    const pTrigConn = params.get('trigger_connected');
    let lastPolyConn = -1;
    let lastTrigConn = -1;
    function pushConnectedness(): void {
      let poly = 0;
      let trig = 0;
      for (const id in livePatch.edges) {
        const e = livePatch.edges[id];
        if (!e || e.target.nodeId !== node.id) continue;
        if (e.target.portId === 'poly') poly = 1;
        else if (e.target.portId === 'trigger') trig = 1;
      }
      if (poly !== lastPolyConn) { lastPolyConn = poly; pPolyConn?.setValueAtTime(poly, ctx.currentTime); }
      if (trig !== lastTrigConn) { lastTrigConn = trig; pTrigConn?.setValueAtTime(trig, ctx.currentTime); }
    }
    pushConnectedness();

    // ---------------- per-slot wavetable resolution + poll ----------------
    const resolvedSigs: Record<CubeSlot, string> = { floor: '', wall: '', ceiling: '' };
    const resolvedFrames: Record<CubeSlot, Float32Array[]> = {
      floor: [], wall: [], ceiling: [],
    };
    const resolvedLabels: Record<CubeSlot, string> = { floor: '', wall: '', ceiling: '' };

    function resolveAndPostAll(): void {
      const data = (livePatch.nodes[node.id]?.data ?? {}) as CubeData;
      for (const slot of CUBE_SLOTS) {
        const next = resolveSlotFrames(slot, data[slot]);
        resolvedFrames[slot] = next.frames;
        resolvedLabels[slot] = next.label;
        if (next.signature !== resolvedSigs[slot]) {
          resolvedSigs[slot] = next.signature;
          try {
            workletNode.port.postMessage({
              type: 'loadWavetable',
              slot,
              frames: framesToPlain(next.frames),
            });
          } catch (err) {
            console.error('[cube] loadWavetable post failed', err);
          }
        }
      }
    }
    resolveAndPostAll();

    // ---------------- OFF-THREAD slice compute (issue #4) ----------------
    //
    // The worklet posts `paramsChanged` (cheap CV-summed scalars) when the slice
    // needs a fresh render; we run the SURFACE-HEIGHT SCAN here on the main
    // thread (identical sampleSlice math) and post the L/R/center waveforms
    // back. The audio thread never touches the field math → no dropouts. We keep
    // the last non-silent center wave for the viz too.
    let lastSnapshot: Float32Array | null = null;
    let lastCenterNonSilent: Float32Array | null = null;

    function renderAndPostSlice(p: {
      sliceY: number; rx: number; ry: number; rz: number;
      morphFC: number; connect: number; crush: number; spread: number;
      fold: number; material: number; wrap: number;
      spaceCrush?: number; spaceDiffuse?: number; connectStrength?: number;
    }): void {
      // All three tables must be loaded (resolveAndPostAll seeds defaults on
      // spawn, so this is true almost immediately).
      const floor = resolvedFrames.floor;
      const wall = resolvedFrames.wall;
      const ceiling = resolvedFrames.ceiling;
      if (!floor.length || !wall.length || !ceiling.length) return;
      const sp: SliceParams = {
        sliceY: p.sliceY, rx: p.rx, ry: p.ry, rz: p.rz,
        morphFC: p.morphFC, connect: p.connect, crush: p.crush,
        spaceCrush: p.spaceCrush ?? 0,
        spaceDiffuse: p.spaceDiffuse ?? 0,
        connectStrength: p.connectStrength ?? 0,
        material: (p.material >= 0.5 ? 'hard' : 'smooth') as Material,
        wrap: p.wrap >= 0.5,
      };
      const fold = p.fold ?? 0;
      const dL = spreadDepthOffset(p.spread, -1);
      const dR = spreadDepthOffset(p.spread, +1);
      const center = sampleSlice(floor, wall, ceiling, sp, 0);
      const waveL = dL === 0 ? center : sampleSlice(floor, wall, ceiling, sp, dL);
      const waveR = dR === 0 ? center : sampleSlice(floor, wall, ceiling, sp, dR);
      // FOLD (West-coast wavefolder): AFTER the slice is sampled + BEFORE LEVEL,
      // on BOTH L and R (and the center viz wave so the WAVEFORM view shows the
      // FOLDED wave). In-place + identity at fold=0. waveL/waveR may alias
      // `center` at spread=0, so fold center first then only the distinct ones.
      applyFold(center, fold);
      if (waveL !== center) applyFold(waveL, fold);
      if (waveR !== center && waveR !== waveL) applyFold(waveR, fold);
      // Cache a non-silent center for the viz (the worklet handles the audio
      // keep-last-non-silent rule itself).
      if (!isDegenerateWave(center)) lastCenterNonSilent = center;
      lastSnapshot = lastCenterNonSilent ?? center;
      try {
        workletNode.port.postMessage({ type: 'setWave', waveCenter: center, waveL, waveR });
      } catch (err) {
        console.error('[cube] setWave post failed', err);
      }
    }

    workletNode.port.onmessage = (e: MessageEvent) => {
      const m = e.data as
        | { type?: string; wave?: Float32Array }
        | (Parameters<typeof renderAndPostSlice>[0] & { type?: string });
      if (!m || typeof m !== 'object') return;
      if (m.type === 'paramsChanged') {
        renderAndPostSlice(m as Parameters<typeof renderAndPostSlice>[0]);
      } else if (m.type === 'snapshot' && (m as { wave?: Float32Array }).wave) {
        // Fallback viz source (only if the worklet ever runs on-thread — it
        // won't in production, but harmless to keep wired).
        lastSnapshot = (m as { wave: Float32Array }).wave;
      }
    };

    // Switch the worklet to off-thread compute. Defer slightly so the
    // loadWavetable posts above are processed first (the worklet needs frames
    // before its first paramsChanged → our render → setWave round-trip).
    try { workletNode.port.postMessage({ type: 'offThread' }); } catch { /* */ }

    let alive = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    function poll(): void {
      if (!alive) return;
      resolveAndPostAll();
      pushConnectedness();
      pollTimer = setTimeout(poll, POLL_MS);
    }
    pollTimer = setTimeout(poll, POLL_MS);

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['pitch',    { node: workletNode, input: 0 }],
        // Poly bus → worklet input 1 (a node connection, not an AudioParam).
        ['poly',     { node: workletNode, input: 1 }],
        // Mono TRIGGER gate → worklet input 2 (a node connection).
        ['trigger',  { node: workletNode, input: 2 }],
        ['slice_y',  { node: workletNode, input: 0, param: params.get('slice_y')! }],
        ['slice_rx', { node: workletNode, input: 0, param: params.get('slice_rx')! }],
        ['slice_ry', { node: workletNode, input: 0, param: params.get('slice_ry')! }],
        ['slice_rz', { node: workletNode, input: 0, param: params.get('slice_rz')! }],
        ['morph_fc', { node: workletNode, input: 0, param: params.get('morph_fc')! }],
        ['connect',  { node: workletNode, input: 0, param: params.get('connect')! }],
        ['connect_strength', { node: workletNode, input: 0, param: params.get('connect_strength')! }],
        ['crush',    { node: workletNode, input: 0, param: params.get('crush')! }],
        ['space_crush',   { node: workletNode, input: 0, param: params.get('space_crush')! }],
        ['space_diffuse', { node: workletNode, input: 0, param: params.get('space_diffuse')! }],
        ['fold_cv',  { node: workletNode, input: 0, param: params.get('fold')! }],
        ['tune',     { node: workletNode, input: 0, param: params.get('tune')! }],
      ]),
      outputs: new Map([
        ['L', { node: splitter, output: 0 }],
        ['R', { node: splitter, output: 1 }],
        // SYNC sine: the worklet's 2nd output (index 1), mono, exposed directly
        // (no splitter — it's already single-channel). Phase-locked reference.
        ['sync', { node: workletNode, output: 1 }],
      ]),
      // Cross-domain mono-video: the bridge owns an OffscreenCanvas, calls
      // drawFrame each video frame, then uploads the pixels to a GL texture for
      // downstream video modules. drawFrame delegates to the card's installed
      // 3D-cube frame-drawer (FRAME_DRAWERS); when none is installed it paints
      // black so the bridge always has a valid frame.
      videoSources: new Map([
        ['video_out', {
          analyser: videoAnalyser,
          sampleRate: ctx.sampleRate,
          drawFrame(canvas: OffscreenCanvas | HTMLCanvasElement) {
            const fn = FRAME_DRAWERS.get(node.id);
            if (fn) {
              try { fn(canvas); return; } catch { /* fall through to black */ }
            }
            const c2d = canvas.getContext('2d') as
              | CanvasRenderingContext2D
              | OffscreenCanvasRenderingContext2D
              | null;
            if (!c2d) return;
            c2d.fillStyle = '#000';
            c2d.fillRect(0, 0, canvas.width, canvas.height);
          },
        }],
      ]),
      setParam(paramId, value) {
        live[paramId] = value;
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return live[paramId];
      },
      read(key) {
        if (key === 'snapshot') return lastSnapshot;
        if (key === 'live') return { ...live };
        if (key === 'tableLabels') return { ...resolvedLabels };
        if (key === 'frames') {
          return {
            floor: resolvedFrames.floor,
            wall: resolvedFrames.wall,
            ceiling: resolvedFrames.ceiling,
          };
        }
        return undefined;
      },
      dispose() {
        alive = false;
        if (pollTimer !== null) clearTimeout(pollTimer);
        try { silence.stop(); } catch { /* */ }
        try { silence.disconnect(); } catch { /* */ }
        try { trigSilence.stop(); } catch { /* */ }
        try { trigSilence.disconnect(); } catch { /* */ }
        try { workletNode.port.onmessage = null; } catch { /* */ }
        try { workletNode.disconnect(); } catch { /* */ }
        try { splitter.disconnect(); } catch { /* */ }
        try { videoAnalyser.disconnect(); } catch { /* */ }
      },
    };
  },
};
