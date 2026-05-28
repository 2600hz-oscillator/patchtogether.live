// packages/web/src/lib/audio/modules/foxy.ts
//
// FOXY — HYBRID audio-visual module. A single card that hides a whole
// signal chain inside one box:
//
//   mini SWOLEVCO  →  internal RASTERIZE  →  256×256 downsample  →
//   simplified RUTTETRA ("XYZ" window)  →  realtime XYZ→wavetable  →
//   internal WAVECEL wavetable VCO  →  the module's audio + video outputs.
//
// The wavetable is REGENERATED in realtime from the evolving XYZ field, so
// WAVECEL's on-card 3D wavetable display visibly ANIMATES.
//
// ── Why this is built the way it is (design decisions, flagged) ───────────
//
// • The video stages (RASTERIZE + RUTTETRA) run ON THE MAIN THREAD as pure
//   CPU code, NOT via the WebGL VideoEngine. FOXY is an AUDIO module; the
//   audio engine has no GL context, and standing up a private VideoEngine
//   inside an audio node would be heavy + fragile. We REUSE the existing
//   pure helpers instead: RasterPainter (rasterize-draw.ts) for the raster,
//   and shapedRamp + a CPU height-field mirror (foxy-map.ts) for the
//   simplified RUTTETRA. The look matches; the cost is bounded + throttled.
//
// • Only the WAVECEL stage uses a real AudioWorklet (reused verbatim from
//   wavecel.ts's DSP — we instantiate the 'wavecel' processor internally and
//   feed it our ANIMATED table via port.postMessage({type:'loadWavetable'}),
//   exactly the runtime-upload path WAVECEL already supports). The mini
//   SWOLEVCO is pure Web Audio nodes (reusing swolevco.ts's helper math).
//
// • The bridge (field → wavetable) is THROTTLED to ~24 Hz and uses a small
//   64×256 table (foxy-map.ts) so we never post 65k numbers at 60fps.
//
// ── Surface ────────────────────────────────────────────────────────────
// FOXY exposes ALL of WAVECEL's params + IO (tune/fine/morph/spread/fold;
// pitch/fm + morph_cv/spread_cv/fold_cv; out_l/out_r + scope_out +
// wave3d_out) PLUS a small set of mini-SWOLEVCO source controls
// (src_tune/src_fine/src_timbre/src_symmetry/src_fold) and the XYZ window
// controls (xyz_xshape/xyz_yshape/xyz_ydisp). The WAVECEL params keep their
// original ids so the card + MIDI-learn surface match WAVECEL exactly.

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
  boxHeightfield,
  boxToField,
  fieldToWavetable,
  wavetableSignature,
  type FoxyXyzParams,
  type FoxyFieldRow,
  type FoxyBox,
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
    // ── mini SWOLEVCO source B controls (drive raster B — the Z height) ──
    { id: 'src2_tune',     label: 'S2.Tune', defaultValue: 7,   min: -36, max: 36, curve: 'linear', units: 'st' },
    { id: 'src2_fine',     label: 'S2.Fine', defaultValue: 0,   min: -100, max: 100, curve: 'linear', units: '¢' },
    { id: 'src2_timbre',   label: 'S2.Tbr',  defaultValue: 0.5, min: 0,   max: 1,  curve: 'linear' },
    { id: 'src2_symmetry', label: 'S2.Sym',  defaultValue: 0.3, min: 0,   max: 1,  curve: 'linear' },
    { id: 'src2_fold',     label: 'S2.Fold', defaultValue: 0.4, min: 0,   max: 1,  curve: 'linear' },
    // ── simplified RUTTETRA "XYZ" controls ──
    { id: 'xyz_xshape', label: 'X Shp', defaultValue: FOXY_XYZ_DEFAULTS.xShape, min: 0,  max: 1, curve: 'linear' },
    { id: 'xyz_yshape', label: 'Y Shp', defaultValue: FOXY_XYZ_DEFAULTS.yShape, min: 0,  max: 1, curve: 'linear' },
    { id: 'xyz_ydisp',  label: 'Y Dsp', defaultValue: FOXY_XYZ_DEFAULTS.yDisp,  min: -1, max: 1, curve: 'linear' },
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

    // ───────────────────────── internal RASTERIZE (×2) ───────────────
    // Two RasterPainters at the 256×256 field resolution. Painter A draws
    // raster A (terrain), painter B draws raster B (Z-height). We paint a
    // fixed run of source samples per bridge tick; the cursor drifts (wrap
    // mode) like the standalone RASTERIZE.
    const painterA = new RasterPainter(RASTER_W, RASTER_H);
    const painterB = new RasterPainter(RASTER_W, RASTER_H);
    const rasterParamsA: RasterizeDrawParams = {
      cursor: 0,
      // ~1.25 frames-worth so the banding drifts but the whole 256×256 fills
      // within a couple of seconds. (256×256 = 65536 px; 6000/tick fills in
      // ~11 ticks ≈ 0.5s.)
      samplesPerFrame: 6000,
      gain: 1,
      wrap: 0,
    };
    // B uses a different paint stride so its banding drifts out of phase with
    // A — that desync is what gives the Box real, non-correlated relief.
    const rasterParamsB: RasterizeDrawParams = {
      cursor: 0,
      samplesPerFrame: 4500,
      gain: 1,
      wrap: 0,
    };

    // ───────────────────────── simplified RUTTETRA + bridge ──────────
    const xyz: FoxyXyzParams = {
      xShape: num('xyz_xshape', FOXY_XYZ_DEFAULTS.xShape),
      yShape: num('xyz_yshape', FOXY_XYZ_DEFAULTS.yShape),
      yDisp:  num('xyz_ydisp',  FOXY_XYZ_DEFAULTS.yDisp),
    };
    // Latest computed Box + field + table, cached so the card can read them
    // back without recomputing (the bridge owns the compute).
    let box: FoxyBox | null = null;
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
    // different frames. With TWO rasters + the Box that drift exceeds the
    // VRT pixel tolerance. When the VRT harness sets `__foxyVrtSeed`, we paint
    // both rasters ONCE from fixed synthetic waveforms (independent of the
    // analyser / wall clock) → a pixel-stable Box + wavetable across runs.
    let vrtSeeded = false;
    function vrtSeedActive(): boolean {
      return !!(globalThis as unknown as { __foxyVrtSeed?: boolean }).__foxyVrtSeed;
    }
    function paintSeeded(): void {
      // Two fixed band-limited waveforms (A: tri-ish, B: a phase-shifted mix)
      // — deterministic, no analyser. Reset both cursors so the SAME pixels
      // land every run.
      const n = swoleA.buf.length;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        swoleA.buf[i] = Math.sin(2 * Math.PI * 3 * t) * 0.7 + Math.sin(2 * Math.PI * 7 * t) * 0.3;
        swoleB.buf[i] = Math.sin(2 * Math.PI * 5 * t + 1.1) * 0.6 + Math.sin(2 * Math.PI * 2 * t) * 0.4;
      }
      rasterParamsA.cursor = 0;
      rasterParamsB.cursor = 0;
      // Paint enough samples to fully fill 256×256 deterministically.
      const full = RASTER_W * RASTER_H;
      const pa: RasterizeDrawParams = { ...rasterParamsA, samplesPerFrame: full };
      const pb: RasterizeDrawParams = { ...rasterParamsB, samplesPerFrame: full };
      // Repeat the synthetic buffer to cover the whole field.
      const repeatA = new Float32Array(full);
      const repeatB = new Float32Array(full);
      for (let i = 0; i < full; i++) { repeatA[i] = swoleA.buf[i % n]!; repeatB[i] = swoleB.buf[i % n]!; }
      painterA.paint(repeatA, pa);
      painterB.paint(repeatB, pb);
      const imgA = painterA.imageData();
      const imgB = painterB.imageData();
      box = boxHeightfield(imgA.data, imgB.data, RASTER_W, RASTER_H, FOXY_FIELD_SIZE);
      field = boxToField(box, xyz);
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

      // 1. RASTERIZE ×2: pull each block's newest samples, paint both frames.
      swoleA.analyser.getFloatTimeDomainData(swoleA.buf);
      const countA = Math.max(1, Math.min(swoleA.buf.length, Math.floor(rasterParamsA.samplesPerFrame)));
      painterA.paint(swoleA.buf.subarray(swoleA.buf.length - countA), rasterParamsA);
      swoleB.analyser.getFloatTimeDomainData(swoleB.buf);
      const countB = Math.max(1, Math.min(swoleB.buf.length, Math.floor(rasterParamsB.samplesPerFrame)));
      painterB.paint(swoleB.buf.subarray(swoleB.buf.length - countB), rasterParamsB);

      // 2. Box 3D heightfield: combine the two rasters (A = terrain base,
      //    B luma = Z height) → then the simplified RUTTETRA field reads the
      //    Box (so the XYZ stage gets REAL height relief, not a flat luma map).
      const imgA = painterA.imageData();
      const imgB = painterB.imageData();
      box = boxHeightfield(imgA.data, imgB.data, RASTER_W, RASTER_H, FOXY_FIELD_SIZE);
      field = boxToField(box, xyz);

      // 3. XYZ → wavetable (64×256), change-detect, post to WAVECEL.
      const plain = fieldToWavetable(field, FOXY_WT_FRAMES, FOXY_WT_SAMPLES);
      const sig = wavetableSignature(plain);
      if (sig !== wtSignature) {
        wtSignature = sig;
        wtFrames = plain.map((f) => new Float32Array(f));
        wave.port.postMessage({ type: 'loadWavetable', frames: plain });
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
          // mini-SWOLEVCO source B params (raster B — the Z height).
          case 'src2_tune': swoleB.params.tune = value; swoleB.setTune(); return;
          case 'src2_fine': swoleB.params.fine = value; swoleB.setTune(); return;
          case 'src2_timbre': swoleB.params.timbre = value; swoleB.setTimbre(value); return;
          case 'src2_symmetry': swoleB.params.symmetry = value; swoleB.setSymmetry(value); return;
          case 'src2_fold': swoleB.params.fold = value; swoleB.setFold(value); return;
          // XYZ window params.
          case 'xyz_xshape': xyz.xShape = value; return;
          case 'xyz_yshape': xyz.yShape = value; return;
          case 'xyz_ydisp':  xyz.yDisp = value; return;
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
          case 'xyz_xshape': return xyz.xShape;
          case 'xyz_yshape': return xyz.yShape;
          case 'xyz_ydisp': return xyz.yDisp;
          default: return undefined;
        }
      },
      read(key) {
        // The card calls these each rAF to drive + read the preview state.
        if (key === 'tick') { bridgeTick(); return undefined; }
        if (key === 'rasterImageData') { bridgeTick(); return painterA.imageData(); }
        if (key === 'rasterImageDataA') { bridgeTick(); return painterA.imageData(); }
        if (key === 'rasterImageDataB') { bridgeTick(); return painterB.imageData(); }
        if (key === 'box') return box;
        if (key === 'xyzField') return field;
        if (key === 'wavetableFrames') return wtFrames;
        if (key === 'activeFrame') return readActiveFrame();
        return undefined;
      },
      dispose() {
        swoleA.dispose();
        swoleB.dispose();
        try { wave.disconnect(vizAnalyser); } catch { /* */ }
        try { vizAnalyser.disconnect(); } catch { /* */ }
        wave.disconnect();
      },
    };
  },
};
