// packages/web/src/lib/audio/modules/foxy.ts
//
// FOXY — HYBRID audio-visual module. A single card that hides a whole
// signal chain inside one box:
//
//   3× mini SWOLEVCO  →  3× internal RASTERIZE  →  volumetric Box (A+B+C)
//   →  realtime wavetable build  →  internal WAVECEL wavetable VCO  →
//   the module's audio + video outputs.
//
// The wavetable is REGENERATED in realtime from the evolving rasters, so
// WAVECEL's on-card 3D wavetable display visibly ANIMATES.
//
// ── v4: volumetric 3-axis (C warps A + adds Z) ───────────────────────────
//
// v3's rank-1 separable model (outer-sum of two 1-D distributions, shaped
// by a Z LUT) collapsed structure to a FLAT profile — no genuine 3D relief
// could survive the projection. v4 throws that out and builds a real
// volumetric construction on top of v2's Box heightfield:
//
//   • Raster A → BASE / terrain pattern (luma)
//   • Raster B → PRIMARY Z height (luma)
//   • Raster C → DUAL contributor:
//       1. Lateral WARP on A's lookup — bright C cells pull the A sample
//          sideways, twisting the heightfield in the XY plane
//       2. Secondary Z height — C's luma additively combines with B's to
//          drive Z displacement
//
// v2-degeneracy: when C is flat gray (luma 0.5), warpAmt = 0 + heightC = 0,
// so v4 reproduces v2's `boxToField` output EXACTLY. v4 is strictly more
// expressive than v2 — pinned by test.
//
// Math (per cell, see foxy-map.ts `boxToField3d` for details):
//
//   warpAmt    = (C - 0.5) * warpAmount
//   srcCol'    = h0 * (srcW-1) + warpAmt * srcW * 0.15
//   srcRow'    = v0 * (srcH-1) + warpAmt * srcH * 0.15
//   baseA      = lumaA at the C-warped (srcCol', srcRow')
//   heightC_d  = (C - 0.5) * secondaryHeight
//   y          = v + (heightB - 0.5) * yDisp + heightC_d * yDisp
//
// Two new user controls expose the v4 effects directly:
//   xyz_warp    (0..1, default 0.25) — lateral warp strength
//   xyz_zheight (0..1, default 0.5)  — secondary height strength
//
// ── Why this is built the way it is (design decisions, flagged) ───────────
//
// • The video stages (RASTERIZE) run ON THE MAIN THREAD as pure CPU code,
//   NOT via the WebGL VideoEngine. FOXY is an AUDIO module; the audio
//   engine has no GL context, and standing up a private VideoEngine inside
//   an audio node would be heavy + fragile. We REUSE the existing pure
//   helpers instead: RasterPainter (rasterize-draw.ts) for each raster and
//   axisDistribution + threeAxisWavetable (foxy-map.ts) for the math.
//   The look matches; the cost is bounded + throttled.
//
// • Only the WAVECEL stage uses a real AudioWorklet (reused verbatim from
//   wavecel.ts's DSP — we instantiate the 'wavecel' processor internally and
//   feed it our ANIMATED table via port.postMessage({type:'loadWavetable'}),
//   exactly the runtime-upload path WAVECEL already supports). The mini
//   SWOLEVCO is pure Web Audio nodes (reusing swolevco.ts's helper math).
//
// • The bridge (rasters → distributions → wavetable) is THROTTLED to ~24 Hz
//   and uses a small 64×256 table (foxy-map.ts) so we never post 65k
//   numbers at 60fps. The 3-axis path is O(frames + samples) (vs. the v2
//   Box's O(rows × cols)) — so the per-tick cost actually drops, even with
//   the third source.
//
// ── Surface ────────────────────────────────────────────────────────────
// FOXY exposes ALL of WAVECEL's params + IO (tune/fine/morph/spread/fold;
// pitch/fm + morph_cv/spread_cv/fold_cv; out_l/out_r + scope_out +
// wave3d_out) PLUS THREE sets of mini-SWOLEVCO source controls
// (src_*/src2_*/src3_*) and the legacy XYZ window controls
// (xyz_xshape/xyz_yshape/xyz_ydisp — used only by the on-card scope draw).
// The WAVECEL params keep their original ids so the card + MIDI-learn
// surface match WAVECEL exactly.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/wavecel.js?url';
import { buildFoldCurve } from '$lib/audio/fold-curve';
import { symmetryGains, tuneFineToHz } from './swolevco';
import { RasterPainter, type RasterizeDrawParams } from './rasterize-draw';
import { drawWave3D, drawWaveScope } from './wavecel-draw';
import {
  FOXY_FIELD_SIZE,
  FOXY_WT_FRAMES,
  FOXY_WT_SAMPLES,
  FOXY_XYZ_DEFAULTS,
  FOXY_XYZ_3D_DEFAULTS,
  boxHeightfield3d,
  boxToField3d,
  fieldToWavetable,
  wavetableSignature,
  type FoxyXyz3dParams,
  type FoxyFieldRow,
} from './foxy-map';

const loadedContexts = new WeakSet<BaseAudioContext>();

/** Bridge update throttle. ~24 Hz (well under 60fps) keeps the
 *  loadWavetable posts + the field recompute cheap. */
const BRIDGE_MS = 42;

/** SWOLEVCO timbre→FM-deviation scaling (mirrors swolevco.ts TIMBRE_MAX_HZ). */
const TIMBRE_MAX_HZ = 200;

/** Internal raster resolution. We paint at the 256×256 the spec mandates
 *  (RASTERIZE's own 640×360 default is downsampled to this), so the painter
 *  buffer IS the 256×256 field source — no extra downsample pass needed. */
const RASTER_W = FOXY_FIELD_SIZE;
const RASTER_H = FOXY_FIELD_SIZE;

export const foxyDef: AudioModuleDef = {
  type: 'foxy',
  domain: 'audio',
  label: 'FOXY',
  category: 'sources',
  schemaVersion: 1,
  // WAVECEL's stereo pair carries through unchanged.
  stereoPairs: [['out_l', 'out_r']],

  inputs: [
    // ── WAVECEL IO (verbatim) ──
    { id: 'pitch',     type: 'pitch' },
    { id: 'fm',        type: 'audio' },
    { id: 'morph_cv',  type: 'cv', paramTarget: 'morph',  cvScale: { mode: 'linear' } },
    { id: 'spread_cv', type: 'cv', paramTarget: 'spread', cvScale: { mode: 'linear' } },
    { id: 'fold_cv',   type: 'cv', paramTarget: 'fold',   cvScale: { mode: 'linear' } },
  ],
  outputs: [
    // ── WAVECEL IO (verbatim) ──
    { id: 'out_l',      type: 'audio' },
    { id: 'out_r',      type: 'audio' },
    { id: 'scope_out',  type: 'mono-video' },
    { id: 'wave3d_out', type: 'video' },
  ],
  params: [
    // ── WAVECEL controls (verbatim ids/ranges) ──
    { id: 'tune',   label: 'Tune',  defaultValue: 0, min: -36,  max: 36,  curve: 'linear', units: 'st' },
    { id: 'fine',   label: 'Fine',  defaultValue: 0, min: -100, max: 100, curve: 'linear', units: '¢' },
    { id: 'morph',  label: 'Morph', defaultValue: 0, min: 0,    max: 1,   curve: 'linear' },
    { id: 'spread', label: 'Sprd',  defaultValue: 1, min: 1,    max: 5,   curve: 'linear' },
    { id: 'fold',   label: 'Fold',  defaultValue: 0, min: 0,    max: 1,   curve: 'linear' },
    // ── mini SWOLEVCO source A controls (drive raster A — the terrain) ──
    { id: 'src_tune',     label: 'S.Tune', defaultValue: 0,   min: -36, max: 36, curve: 'linear', units: 'st' },
    { id: 'src_fine',     label: 'S.Fine', defaultValue: 0,   min: -100, max: 100, curve: 'linear', units: '¢' },
    { id: 'src_timbre',   label: 'S.Tbr',  defaultValue: 0.3, min: 0,   max: 1,  curve: 'linear' },
    { id: 'src_symmetry', label: 'S.Sym',  defaultValue: 0.5, min: 0,   max: 1,  curve: 'linear' },
    { id: 'src_fold',     label: 'S.Fold', defaultValue: 0.2, min: 0,   max: 1,  curve: 'linear' },
    // ── mini SWOLEVCO source B controls (drive raster B — Y row distribution) ──
    { id: 'src2_tune',     label: 'S2.Tune', defaultValue: 7,   min: -36, max: 36, curve: 'linear', units: 'st' },
    { id: 'src2_fine',     label: 'S2.Fine', defaultValue: 0,   min: -100, max: 100, curve: 'linear', units: '¢' },
    { id: 'src2_timbre',   label: 'S2.Tbr',  defaultValue: 0.5, min: 0,   max: 1,  curve: 'linear' },
    { id: 'src2_symmetry', label: 'S2.Sym',  defaultValue: 0.3, min: 0,   max: 1,  curve: 'linear' },
    { id: 'src2_fold',     label: 'S2.Fold', defaultValue: 0.4, min: 0,   max: 1,  curve: 'linear' },
    // ── mini SWOLEVCO source C controls (drive raster C — Z amplitude LUT) ──
    { id: 'src3_tune',     label: 'S3.Tune', defaultValue: -12, min: -36, max: 36, curve: 'linear', units: 'st' },
    { id: 'src3_fine',     label: 'S3.Fine', defaultValue: 0,   min: -100, max: 100, curve: 'linear', units: '¢' },
    { id: 'src3_timbre',   label: 'S3.Tbr',  defaultValue: 0.4, min: 0,   max: 1,  curve: 'linear' },
    { id: 'src3_symmetry', label: 'S3.Sym',  defaultValue: 0.7, min: 0,   max: 1,  curve: 'linear' },
    { id: 'src3_fold',     label: 'S3.Fold', defaultValue: 0.3, min: 0,   max: 1,  curve: 'linear' },
    // ── v4 volumetric 3-axis XYZ controls ────────────────────────────
    { id: 'xyz_xshape',  label: 'X Shp', defaultValue: FOXY_XYZ_DEFAULTS.xShape, min: 0,  max: 1, curve: 'linear' },
    { id: 'xyz_yshape',  label: 'Y Shp', defaultValue: FOXY_XYZ_DEFAULTS.yShape, min: 0,  max: 1, curve: 'linear' },
    { id: 'xyz_ydisp',   label: 'Y Dsp', defaultValue: FOXY_XYZ_DEFAULTS.yDisp,  min: -1, max: 1, curve: 'linear' },
    // v4: C warps A's lookup laterally → tunnel-like XY twist on the surface.
    { id: 'xyz_warp',    label: 'Warp', defaultValue: FOXY_XYZ_3D_DEFAULTS.warpAmount,      min: 0, max: 1, curve: 'linear' },
    // v4: C adds a SECONDARY Z height on top of B's primary heightmap.
    { id: 'xyz_zheight', label: 'Z Ht', defaultValue: FOXY_XYZ_3D_DEFAULTS.secondaryHeight, min: 0, max: 1, curve: 'linear' },
    // Freeze toggles (0 = live, 1 = frozen). FREEZE RASTER A/B/C hold each
    // raster's current frame so the source SWOLEVCOs no longer drive that
    // axis of the wavetable. FREEZE TABLE holds the wavetable: stops
    // re-posting to WAVECEL so the internal oscillator keeps reading the
    // last-pushed table no matter how the rasters continue to evolve.
    { id: 'freezeRasterA', label: 'FrA', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
    { id: 'freezeRasterB', label: 'FrB', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
    { id: 'freezeRasterC', label: 'FrC', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
    { id: 'freezeTable',   label: 'FrT', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }
    const p0 = node.params ?? {};
    const num = (k: string, d: number): number =>
      typeof p0[k] === 'number' ? (p0[k] as number) : d;

    // ───────────────────────── mini SWOLEVCO (×2) ────────────────────
    // A compact version of swolevco.ts: 3 shape oscillators (saw/tri/sqr)
    // crossfaded by symmetry, audio-rate FM from a sine modulator (timbre),
    // and a wavefolder. Each block drives ONE raster analyser ONLY (neither
    // is a FOXY audio output — the audio you hear is WAVECEL). FOXY v2 runs
    // TWO independent blocks: A paints raster A (the terrain pattern), B
    // paints raster B (whose luma becomes the Box Z-height).
    interface SwoleParams { tune: number; fine: number; timbre: number; symmetry: number; fold: number }
    interface SwoleBlock {
      params: SwoleParams;
      analyser: AnalyserNode;
      buf: Float32Array<ArrayBuffer>;
      setTune(): void;
      setTimbre(v: number): void;
      setSymmetry(v: number): void;
      setFold(v: number): void;
      dispose(): void;
    }
    function makeSwole(p: SwoleParams): SwoleBlock {
      const baseHz = tuneFineToHz(p.tune, p.fine);
      function mkOsc(type: OscillatorType): OscillatorNode {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.setValueAtTime(baseHz, ctx.currentTime);
        o.start();
        return o;
      }
      const oscSaw = mkOsc('sawtooth');
      const oscTri = mkOsc('triangle');
      const oscSqr = mkOsc('square');
      const sg = symmetryGains(p.symmetry);
      const gSaw = ctx.createGain(); gSaw.gain.value = sg.saw;
      const gTri = ctx.createGain(); gTri.gain.value = sg.triangle;
      const gSqr = ctx.createGain(); gSqr.gain.value = sg.square;
      oscSaw.connect(gSaw); oscTri.connect(gTri); oscSqr.connect(gSqr);
      const primaryBus = ctx.createGain();
      gSaw.connect(primaryBus); gTri.connect(primaryBus); gSqr.connect(primaryBus);
      const folder = ctx.createWaveShaper();
      folder.oversample = '4x';
      folder.curve = buildFoldCurve(p.fold);
      primaryBus.connect(folder);
      const modOsc = ctx.createOscillator();
      modOsc.type = 'sine';
      modOsc.frequency.setValueAtTime(baseHz, ctx.currentTime);
      modOsc.start();
      const timbreGain = ctx.createGain();
      timbreGain.gain.setValueAtTime(p.timbre * TIMBRE_MAX_HZ, ctx.currentTime);
      modOsc.connect(timbreGain);
      timbreGain.connect(oscSaw.frequency);
      timbreGain.connect(oscTri.frequency);
      timbreGain.connect(oscSqr.frequency);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0;
      folder.connect(analyser);
      return {
        params: p,
        analyser,
        buf: new Float32Array(analyser.fftSize),
        setTune(): void {
          const bh = tuneFineToHz(p.tune, p.fine);
          oscSaw.frequency.setValueAtTime(bh, ctx.currentTime);
          oscTri.frequency.setValueAtTime(bh, ctx.currentTime);
          oscSqr.frequency.setValueAtTime(bh, ctx.currentTime);
          modOsc.frequency.setValueAtTime(bh, ctx.currentTime);
        },
        setTimbre(v: number): void { timbreGain.gain.setValueAtTime(v * TIMBRE_MAX_HZ, ctx.currentTime); },
        setSymmetry(v: number): void {
          const g = symmetryGains(v);
          gSaw.gain.setValueAtTime(g.saw, ctx.currentTime);
          gTri.gain.setValueAtTime(g.triangle, ctx.currentTime);
          gSqr.gain.setValueAtTime(g.square, ctx.currentTime);
        },
        setFold(v: number): void { folder.curve = buildFoldCurve(v); },
        dispose(): void {
          try { oscSaw.stop(); } catch { /* */ }
          try { oscTri.stop(); } catch { /* */ }
          try { oscSqr.stop(); } catch { /* */ }
          try { modOsc.stop(); } catch { /* */ }
          oscSaw.disconnect(); oscTri.disconnect(); oscSqr.disconnect();
          gSaw.disconnect(); gTri.disconnect(); gSqr.disconnect();
          primaryBus.disconnect(); folder.disconnect();
          modOsc.disconnect(); timbreGain.disconnect();
          analyser.disconnect();
        },
      };
    }

    const swoleA = makeSwole({
      tune:     num('src_tune', 0),
      fine:     num('src_fine', 0),
      timbre:   num('src_timbre', 0.3),
      symmetry: num('src_symmetry', 0.5),
      fold:     num('src_fold', 0.2),
    });
    const swoleB = makeSwole({
      tune:     num('src2_tune', 7),
      fine:     num('src2_fine', 0),
      timbre:   num('src2_timbre', 0.5),
      symmetry: num('src2_symmetry', 0.3),
      fold:     num('src2_fold', 0.4),
    });
    // C reads as a contrasting source out of the box: an octave-low tune
    // (-12) + brighter symmetry / timbre, so the Z LUT carries different
    // banding than A's column / B's row distributions.
    const swoleC = makeSwole({
      tune:     num('src3_tune', -12),
      fine:     num('src3_fine', 0),
      timbre:   num('src3_timbre', 0.4),
      symmetry: num('src3_symmetry', 0.7),
      fold:     num('src3_fold', 0.3),
    });

    // ───────────────────────── internal RASTERIZE (×3) ───────────────
    // Three RasterPainters at the 256×256 field resolution — one per
    // wavetable axis (A→X column distribution, B→Y row distribution, C→Z
    // amplitude LUT). Each paints a fixed run of source samples per bridge
    // tick; the cursors drift (wrap mode) like the standalone RASTERIZE.
    // Each painter uses a DIFFERENT paint stride so the three banding
    // patterns desync from each other → uncorrelated axis distributions.
    const painterA = new RasterPainter(RASTER_W, RASTER_H);
    const painterB = new RasterPainter(RASTER_W, RASTER_H);
    const painterC = new RasterPainter(RASTER_W, RASTER_H);
    const rasterParamsA: RasterizeDrawParams = {
      cursor: 0,
      // ~1.25 frames-worth so the banding drifts but the whole 256×256 fills
      // within a couple of seconds. (256×256 = 65536 px; 6000/tick fills in
      // ~11 ticks ≈ 0.5s.)
      samplesPerFrame: 6000,
      gain: 1,
      wrap: 0,
    };
    const rasterParamsB: RasterizeDrawParams = {
      cursor: 0,
      samplesPerFrame: 4500,
      gain: 1,
      wrap: 0,
    };
    const rasterParamsC: RasterizeDrawParams = {
      cursor: 0,
      // A third stride keeps C's banding from re-syncing with A or B.
      samplesPerFrame: 5200,
      gain: 1,
      wrap: 0,
    };

    // ───────────────────────── v4 volumetric bridge ──────────────────
    // The XYZ params now ACTIVELY drive the wavetable math (v4 reads the
    // 3 rasters into a volumetric Box → boxToField3d → fieldToWavetable).
    // xyz_warp + xyz_zheight are the two new v4 knobs (see foxy-map.ts
    // header for the design).
    const xyz: FoxyXyz3dParams = {
      xShape:          num('xyz_xshape',  FOXY_XYZ_3D_DEFAULTS.xShape),
      yShape:          num('xyz_yshape',  FOXY_XYZ_3D_DEFAULTS.yShape),
      yDisp:           num('xyz_ydisp',   FOXY_XYZ_3D_DEFAULTS.yDisp),
      warpAmount:      num('xyz_warp',    FOXY_XYZ_3D_DEFAULTS.warpAmount),
      secondaryHeight: num('xyz_zheight', FOXY_XYZ_3D_DEFAULTS.secondaryHeight),
    };
    // Latest computed field + table, cached so the card can read them back
    // without recomputing (the bridge owns the compute). `field` is now
    // derived from the 3-axis wavetable for display, not from a separate
    // heightfield pass.
    let field: FoxyFieldRow[] = [];
    let wtFrames: Float32Array[] = [];
    let wtSignature = '';

    // ───────────────────────── internal WAVECEL worklet ──────────────
    const wave = new AudioWorkletNode(ctx, 'wavecel', {
      numberOfInputs: 5,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });
    const wParams = wave.parameters as unknown as Map<string, AudioParam>;
    const wIds = ['tune', 'fine', 'morph', 'spread', 'fold'] as const;
    for (const id of wIds) {
      const def = foxyDef.params.find((p) => p.id === id)!;
      wParams.get(id)?.setValueAtTime(num(id, def.defaultValue), ctx.currentTime);
    }
    const pMorph = wParams.get('morph')!;
    const pSpread = wParams.get('spread')!;
    const pFold = wParams.get('fold')!;

    // Viz analyser the cross-domain bridge needs (ignored when drawFrame is
    // set — same contract as wavecel.ts).
    const vizAnalyser = ctx.createAnalyser();
    vizAnalyser.fftSize = 256;
    vizAnalyser.smoothingTimeConstant = 0;
    wave.connect(vizAnalyser, 0);

    function readActiveFrame(): number {
      const fc = wtFrames.length;
      if (fc <= 1) return 0;
      return Math.max(0, Math.min(fc - 1, Math.round(pMorph.value * (fc - 1))));
    }

    // ── DETERMINISTIC VRT SEED ───────────────────────────────────────
    // The live raster fill drifts with wall-clock timing (how many bridge
    // ticks land before the VRT freeze), so two runs freeze on slightly
    // different frames. With THREE rasters + the 3-axis math that drift
    // exceeds the VRT pixel tolerance. When the VRT harness sets
    // `__foxyVrtSeed`, we paint all three rasters ONCE from fixed synthetic
    // waveforms (independent of the analyser / wall clock) → a pixel-stable
    // wavetable across runs.
    let vrtSeeded = false;
    function vrtSeedActive(): boolean {
      return !!(globalThis as unknown as { __foxyVrtSeed?: boolean }).__foxyVrtSeed;
    }
    function paintSeeded(): void {
      // Three fixed band-limited waveforms — deterministic, no analyser.
      // Reset all cursors so the SAME pixels land every run.
      const n = swoleA.buf.length;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        swoleA.buf[i] = Math.sin(2 * Math.PI * 3 * t) * 0.7 + Math.sin(2 * Math.PI * 7 * t) * 0.3;
        swoleB.buf[i] = Math.sin(2 * Math.PI * 5 * t + 1.1) * 0.6 + Math.sin(2 * Math.PI * 2 * t) * 0.4;
        swoleC.buf[i] = Math.sin(2 * Math.PI * 4 * t + 0.5) * 0.5 + Math.sin(2 * Math.PI * 9 * t) * 0.4;
      }
      rasterParamsA.cursor = 0;
      rasterParamsB.cursor = 0;
      rasterParamsC.cursor = 0;
      // Paint enough samples to fully fill 256×256 deterministically.
      const full = RASTER_W * RASTER_H;
      const pa: RasterizeDrawParams = { ...rasterParamsA, samplesPerFrame: full };
      const pb: RasterizeDrawParams = { ...rasterParamsB, samplesPerFrame: full };
      const pc: RasterizeDrawParams = { ...rasterParamsC, samplesPerFrame: full };
      // Repeat the synthetic buffer to cover the whole field.
      const repeatA = new Float32Array(full);
      const repeatB = new Float32Array(full);
      const repeatC = new Float32Array(full);
      for (let i = 0; i < full; i++) {
        repeatA[i] = swoleA.buf[i % n]!;
        repeatB[i] = swoleB.buf[i % n]!;
        repeatC[i] = swoleC.buf[i % n]!;
      }
      painterA.paint(repeatA, pa);
      painterB.paint(repeatB, pb);
      painterC.paint(repeatC, pc);
      const imgA = painterA.imageData();
      const imgB = painterB.imageData();
      const imgC = painterC.imageData();
      // v4 volumetric construction: A+B+C → boxHeightfield3d → boxToField3d
      // (with C warping A's lookup + adding secondary Z) → fieldToWavetable.
      const box3 = boxHeightfield3d(imgA.data, imgB.data, imgC.data, RASTER_W, RASTER_H);
      field = boxToField3d(box3, imgA.data, RASTER_W, RASTER_H, xyz);
      const plain = fieldToWavetable(field, FOXY_WT_FRAMES, FOXY_WT_SAMPLES);
      wtSignature = wavetableSignature(plain);
      wtFrames = plain.map((f) => new Float32Array(f));
      wave.port.postMessage({ type: 'loadWavetable', frames: plain });
    }

    // ── The realtime bridge tick: paint raster → compute field → build +
    //    post the wavetable (throttled, change-detected). ──
    let lastBridgeMs = -1;
    function bridgeTick(): void {
      // VRT determinism: once the harness flags seed mode, paint a fixed
      // deterministic field ONCE and stop drifting (so the freeze frame is
      // identical run-to-run).
      if (vrtSeedActive()) {
        if (!vrtSeeded) { vrtSeeded = true; paintSeeded(); }
        return;
      }
      // Freeze when the context is suspended (VRT freeze + tab-hidden): no
      // fresh audio, so don't drift the cursor / re-post.
      if (ctx.state === 'suspended') return;
      const now =
        typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? performance.now()
          : Date.now();
      if (now - lastBridgeMs < BRIDGE_MS) return;
      lastBridgeMs = now;

      // Read the freeze toggles each tick (cheap; params.get is cached).
      const freezeA = num('freezeRasterA', 0) >= 0.5;
      const freezeB = num('freezeRasterB', 0) >= 0.5;
      const freezeC = num('freezeRasterC', 0) >= 0.5;
      const freezeT = num('freezeTable',   0) >= 0.5;

      // 1. RASTERIZE ×3: pull each block's newest samples, paint each frame.
      //    Skip the paint for a frozen raster — its imageData stays as
      //    whatever was last drawn, so that axis of the wavetable holds
      //    while the others keep evolving.
      if (!freezeA) {
        swoleA.analyser.getFloatTimeDomainData(swoleA.buf);
        const countA = Math.max(1, Math.min(swoleA.buf.length, Math.floor(rasterParamsA.samplesPerFrame)));
        painterA.paint(swoleA.buf.subarray(swoleA.buf.length - countA), rasterParamsA);
      }
      if (!freezeB) {
        swoleB.analyser.getFloatTimeDomainData(swoleB.buf);
        const countB = Math.max(1, Math.min(swoleB.buf.length, Math.floor(rasterParamsB.samplesPerFrame)));
        painterB.paint(swoleB.buf.subarray(swoleB.buf.length - countB), rasterParamsB);
      }
      if (!freezeC) {
        swoleC.analyser.getFloatTimeDomainData(swoleC.buf);
        const countC = Math.max(1, Math.min(swoleC.buf.length, Math.floor(rasterParamsC.samplesPerFrame)));
        painterC.paint(swoleC.buf.subarray(swoleC.buf.length - countC), rasterParamsC);
      }

      // 2. v4 volumetric construction. Combine A+B+C into the volumetric
      //    Box (A = base terrain, B = primary Z, C = warps A's lookup AND
      //    adds secondary Z), then convert into the XYZ scanline field.
      const imgA = painterA.imageData();
      const imgB = painterB.imageData();
      const imgC = painterC.imageData();
      const box3 = boxHeightfield3d(imgA.data, imgB.data, imgC.data, RASTER_W, RASTER_H);
      // Re-read the v4 knobs in case they changed since module init
      // (setParam updates `xyz` in place — see below — but the bridge
      // also picks up live knob drags via the same field).
      field = boxToField3d(box3, imgA.data, RASTER_W, RASTER_H, xyz);

      // 3. Build the wavetable (64×256), change-detect, post to WAVECEL.
      //    The field carries volumetric relief (B's height + C's secondary
      //    height + C-warped A samples) → fieldToWavetable reads the
      //    displaced Y values, so the audio wavetable HAS 3D shape.
      //    When FREEZE TABLE is on, the field can keep updating (so the
      //    XYZ display still animates) but we don't push the new table to
      //    the audio worklet — it keeps reading the last-pushed table.
      const plain = fieldToWavetable(field, FOXY_WT_FRAMES, FOXY_WT_SAMPLES);
      if (!freezeT) {
        const sig = wavetableSignature(plain);
        if (sig !== wtSignature) {
          wtSignature = sig;
          wtFrames = plain.map((f) => new Float32Array(f));
          wave.port.postMessage({ type: 'loadWavetable', frames: plain });
        }
      }
    }

    // The card drives bridgeTick() via read('tick') each rAF; the video-out
    // drawFrame also nudges it so wave3d_out animates even with no card open.
    function drawScopeFrame(canvas: OffscreenCanvas | HTMLCanvasElement): void {
      bridgeTick();
      const c2d = canvas.getContext('2d') as
        | CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (!c2d || wtFrames.length === 0) return;
      drawWaveScope(c2d, wtFrames, canvas.width, canvas.height, { activeFrame: readActiveFrame() });
    }
    function drawWave3DFrame(canvas: OffscreenCanvas | HTMLCanvasElement): void {
      bridgeTick();
      const c2d = canvas.getContext('2d') as
        | CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (!c2d || wtFrames.length === 0) return;
      drawWave3D(c2d, wtFrames, canvas.width, canvas.height, { activeFrame: readActiveFrame() });
    }

    return {
      domain: 'audio',
      inputs: new Map([
        ['pitch',     { node: wave, input: 0 }],
        ['fm',        { node: wave, input: 1 }],
        ['morph_cv',  { node: wave, input: 2, param: pMorph }],
        ['spread_cv', { node: wave, input: 3, param: pSpread }],
        ['fold_cv',   { node: wave, input: 4, param: pFold }],
      ]),
      outputs: new Map([
        ['out_l', { node: wave, output: 0 }],
        ['out_r', { node: wave, output: 1 }],
      ]),
      videoSources: new Map([
        ['scope_out',  { analyser: vizAnalyser, sampleRate: ctx.sampleRate, drawFrame: drawScopeFrame }],
        ['wave3d_out', { analyser: vizAnalyser, sampleRate: ctx.sampleRate, drawFrame: drawWave3DFrame }],
      ]),
      setParam(paramId, value) {
        switch (paramId) {
          // WAVECEL params → worklet.
          case 'tune': case 'fine': case 'morph': case 'spread': case 'fold':
            wParams.get(paramId)?.setValueAtTime(value, ctx.currentTime);
            return;
          // mini-SWOLEVCO source A params (raster A — the terrain).
          case 'src_tune': swoleA.params.tune = value; swoleA.setTune(); return;
          case 'src_fine': swoleA.params.fine = value; swoleA.setTune(); return;
          case 'src_timbre': swoleA.params.timbre = value; swoleA.setTimbre(value); return;
          case 'src_symmetry': swoleA.params.symmetry = value; swoleA.setSymmetry(value); return;
          case 'src_fold': swoleA.params.fold = value; swoleA.setFold(value); return;
          // mini-SWOLEVCO source B params (raster B — Y row distribution).
          case 'src2_tune': swoleB.params.tune = value; swoleB.setTune(); return;
          case 'src2_fine': swoleB.params.fine = value; swoleB.setTune(); return;
          case 'src2_timbre': swoleB.params.timbre = value; swoleB.setTimbre(value); return;
          case 'src2_symmetry': swoleB.params.symmetry = value; swoleB.setSymmetry(value); return;
          case 'src2_fold': swoleB.params.fold = value; swoleB.setFold(value); return;
          // mini-SWOLEVCO source C params (raster C — Z amplitude LUT).
          case 'src3_tune': swoleC.params.tune = value; swoleC.setTune(); return;
          case 'src3_fine': swoleC.params.fine = value; swoleC.setTune(); return;
          case 'src3_timbre': swoleC.params.timbre = value; swoleC.setTimbre(value); return;
          case 'src3_symmetry': swoleC.params.symmetry = value; swoleC.setSymmetry(value); return;
          case 'src3_fold': swoleC.params.fold = value; swoleC.setFold(value); return;
          // v4 volumetric XYZ params — actively drive the bridge math.
          case 'xyz_xshape':  xyz.xShape = value; return;
          case 'xyz_yshape':  xyz.yShape = value; return;
          case 'xyz_ydisp':   xyz.yDisp = value; return;
          case 'xyz_warp':    xyz.warpAmount = value; return;
          case 'xyz_zheight': xyz.secondaryHeight = value; return;
        }
      },
      readParam(paramId) {
        switch (paramId) {
          case 'tune': case 'fine': case 'morph': case 'spread': case 'fold':
            return wParams.get(paramId)?.value;
          case 'src_tune': return swoleA.params.tune;
          case 'src_fine': return swoleA.params.fine;
          case 'src_timbre': return swoleA.params.timbre;
          case 'src_symmetry': return swoleA.params.symmetry;
          case 'src_fold': return swoleA.params.fold;
          case 'src2_tune': return swoleB.params.tune;
          case 'src2_fine': return swoleB.params.fine;
          case 'src2_timbre': return swoleB.params.timbre;
          case 'src2_symmetry': return swoleB.params.symmetry;
          case 'src2_fold': return swoleB.params.fold;
          case 'src3_tune': return swoleC.params.tune;
          case 'src3_fine': return swoleC.params.fine;
          case 'src3_timbre': return swoleC.params.timbre;
          case 'src3_symmetry': return swoleC.params.symmetry;
          case 'src3_fold': return swoleC.params.fold;
          case 'xyz_xshape':  return xyz.xShape;
          case 'xyz_yshape':  return xyz.yShape;
          case 'xyz_ydisp':   return xyz.yDisp;
          case 'xyz_warp':    return xyz.warpAmount;
          case 'xyz_zheight': return xyz.secondaryHeight;
          default: return undefined;
        }
      },
      read(key) {
        // The card calls these each rAF to drive + read the preview state.
        if (key === 'tick') { bridgeTick(); return undefined; }
        if (key === 'rasterImageData') { bridgeTick(); return painterA.imageData(); }
        if (key === 'rasterImageDataA') { bridgeTick(); return painterA.imageData(); }
        if (key === 'rasterImageDataB') { bridgeTick(); return painterB.imageData(); }
        if (key === 'rasterImageDataC') { bridgeTick(); return painterC.imageData(); }
        // v4 keeps the box reading available (the volumetric Box3 with
        // A/B/C luma per cell). Card uses xyzField for display, this is
        // for any future diagnostic / introspection callers.
        if (key === 'box') {
          bridgeTick();
          return boxHeightfield3d(
            painterA.imageData().data, painterB.imageData().data,
            painterC.imageData().data, RASTER_W, RASTER_H,
          );
        }
        if (key === 'xyzField') return field;
        if (key === 'wavetableFrames') return wtFrames;
        if (key === 'activeFrame') return readActiveFrame();
        return undefined;
      },
      dispose() {
        swoleA.dispose();
        swoleB.dispose();
        swoleC.dispose();
        try { wave.disconnect(vizAnalyser); } catch { /* */ }
        try { vizAnalyser.disconnect(); } catch { /* */ }
        wave.disconnect();
      },
    };
  },
};
