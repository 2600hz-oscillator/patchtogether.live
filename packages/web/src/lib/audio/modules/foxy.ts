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
  simplifiedRuttetraField,
  fieldToWavetable,
  wavetableSignature,
  type FoxyXyzParams,
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
    // ── mini SWOLEVCO source controls (drive the raster) ──
    { id: 'src_tune',     label: 'S.Tune', defaultValue: 0,   min: -36, max: 36, curve: 'linear', units: 'st' },
    { id: 'src_fine',     label: 'S.Fine', defaultValue: 0,   min: -100, max: 100, curve: 'linear', units: '¢' },
    { id: 'src_timbre',   label: 'S.Tbr',  defaultValue: 0.3, min: 0,   max: 1,  curve: 'linear' },
    { id: 'src_symmetry', label: 'S.Sym',  defaultValue: 0.5, min: 0,   max: 1,  curve: 'linear' },
    { id: 'src_fold',     label: 'S.Fold', defaultValue: 0.2, min: 0,   max: 1,  curve: 'linear' },
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

    // ───────────────────────── mini SWOLEVCO ─────────────────────────
    // A compact version of swolevco.ts: 3 shape oscillators (saw/tri/sqr)
    // crossfaded by symmetry, audio-rate FM from a sine modulator (timbre),
    // and a wavefolder. Drives the raster analyser ONLY (it is NOT one of
    // FOXY's audio outputs — the audio you hear is WAVECEL).
    const src = {
      tune:     num('src_tune', 0),
      fine:     num('src_fine', 0),
      timbre:   num('src_timbre', 0.3),
      symmetry: num('src_symmetry', 0.5),
      fold:     num('src_fold', 0.2),
    };
    const baseHz = tuneFineToHz(src.tune, src.fine);
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
    const sg = symmetryGains(src.symmetry);
    const gSaw = ctx.createGain(); gSaw.gain.value = sg.saw;
    const gTri = ctx.createGain(); gTri.gain.value = sg.triangle;
    const gSqr = ctx.createGain(); gSqr.gain.value = sg.square;
    oscSaw.connect(gSaw); oscTri.connect(gTri); oscSqr.connect(gSqr);
    const primaryBus = ctx.createGain();
    gSaw.connect(primaryBus); gTri.connect(primaryBus); gSqr.connect(primaryBus);
    const folder = ctx.createWaveShaper();
    folder.oversample = '4x';
    folder.curve = buildFoldCurve(src.fold);
    primaryBus.connect(folder);
    // Sine modulator → timbre FM.
    const modOsc = ctx.createOscillator();
    modOsc.type = 'sine';
    modOsc.frequency.setValueAtTime(baseHz, ctx.currentTime);
    modOsc.start();
    const timbreGain = ctx.createGain();
    timbreGain.gain.setValueAtTime(src.timbre * TIMBRE_MAX_HZ, ctx.currentTime);
    modOsc.connect(timbreGain);
    timbreGain.connect(oscSaw.frequency);
    timbreGain.connect(oscTri.frequency);
    timbreGain.connect(oscSqr.frequency);
    // Source analyser — the raster reads its time-domain samples each frame.
    const srcAnalyser = ctx.createAnalyser();
    srcAnalyser.fftSize = 2048;
    srcAnalyser.smoothingTimeConstant = 0;
    folder.connect(srcAnalyser);
    const srcBuf = new Float32Array(srcAnalyser.fftSize);

    function recomputeSrcHz(): void {
      const bh = tuneFineToHz(src.tune, src.fine);
      oscSaw.frequency.setValueAtTime(bh, ctx.currentTime);
      oscTri.frequency.setValueAtTime(bh, ctx.currentTime);
      oscSqr.frequency.setValueAtTime(bh, ctx.currentTime);
      modOsc.frequency.setValueAtTime(bh, ctx.currentTime);
    }

    // ───────────────────────── internal RASTERIZE ────────────────────
    // RasterPainter at the 256×256 field resolution. We paint a fixed run
    // of source samples per bridge tick; the cursor drifts (wrap mode) like
    // the standalone RASTERIZE.
    const painter = new RasterPainter(RASTER_W, RASTER_H);
    const rasterParams: RasterizeDrawParams = {
      cursor: 0,
      // ~1.25 frames-worth so the banding drifts but the whole 256×256 fills
      // within a couple of seconds. (256×256 = 65536 px; 6000/tick fills in
      // ~11 ticks ≈ 0.5s.)
      samplesPerFrame: 6000,
      gain: 1,
      wrap: 0,
    };

    // ───────────────────────── simplified RUTTETRA + bridge ──────────
    const xyz: FoxyXyzParams = {
      xShape: num('xyz_xshape', FOXY_XYZ_DEFAULTS.xShape),
      yShape: num('xyz_yshape', FOXY_XYZ_DEFAULTS.yShape),
      yDisp:  num('xyz_ydisp',  FOXY_XYZ_DEFAULTS.yDisp),
    };
    // Latest computed field + table, cached so the card can read them back
    // without recomputing (the bridge owns the compute).
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

    // ── The realtime bridge tick: paint raster → compute field → build +
    //    post the wavetable (throttled, change-detected). ──
    let lastBridgeMs = -1;
    function bridgeTick(): void {
      // Freeze when the context is suspended (VRT freeze + tab-hidden): no
      // fresh audio, so don't drift the cursor / re-post.
      if (ctx.state === 'suspended') return;
      const now =
        typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? performance.now()
          : Date.now();
      if (now - lastBridgeMs < BRIDGE_MS) return;
      lastBridgeMs = now;

      // 1. RASTERIZE: pull the newest run of source samples, paint a frame.
      srcAnalyser.getFloatTimeDomainData(srcBuf);
      const count = Math.max(1, Math.min(srcBuf.length, Math.floor(rasterParams.samplesPerFrame)));
      painter.paint(srcBuf.subarray(srcBuf.length - count), rasterParams);

      // 2. Simplified RUTTETRA field from the 256×256 raster buffer.
      const img = painter.imageData();
      field = simplifiedRuttetraField(img.data, RASTER_W, RASTER_H, xyz);

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
          // mini-SWOLEVCO source params.
          case 'src_tune': src.tune = value; recomputeSrcHz(); return;
          case 'src_fine': src.fine = value; recomputeSrcHz(); return;
          case 'src_timbre':
            src.timbre = value;
            timbreGain.gain.setValueAtTime(value * TIMBRE_MAX_HZ, ctx.currentTime);
            return;
          case 'src_symmetry': {
            src.symmetry = value;
            const g = symmetryGains(value);
            gSaw.gain.setValueAtTime(g.saw, ctx.currentTime);
            gTri.gain.setValueAtTime(g.triangle, ctx.currentTime);
            gSqr.gain.setValueAtTime(g.square, ctx.currentTime);
            return;
          }
          case 'src_fold':
            src.fold = value;
            folder.curve = buildFoldCurve(value);
            return;
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
          case 'src_tune': return src.tune;
          case 'src_fine': return src.fine;
          case 'src_timbre': return src.timbre;
          case 'src_symmetry': return src.symmetry;
          case 'src_fold': return src.fold;
          case 'xyz_xshape': return xyz.xShape;
          case 'xyz_yshape': return xyz.yShape;
          case 'xyz_ydisp': return xyz.yDisp;
          default: return undefined;
        }
      },
      read(key) {
        // The card calls these each rAF to drive + read the preview state.
        if (key === 'tick') { bridgeTick(); return undefined; }
        if (key === 'rasterImageData') { bridgeTick(); return painter.imageData(); }
        if (key === 'xyzField') return field;
        if (key === 'wavetableFrames') return wtFrames;
        if (key === 'activeFrame') return readActiveFrame();
        return undefined;
      },
      dispose() {
        try { oscSaw.stop(); } catch { /* */ }
        try { oscTri.stop(); } catch { /* */ }
        try { oscSqr.stop(); } catch { /* */ }
        try { modOsc.stop(); } catch { /* */ }
        oscSaw.disconnect(); oscTri.disconnect(); oscSqr.disconnect();
        gSaw.disconnect(); gTri.disconnect(); gSqr.disconnect();
        primaryBus.disconnect(); folder.disconnect();
        modOsc.disconnect(); timbreGain.disconnect();
        srcAnalyser.disconnect();
        try { wave.disconnect(vizAnalyser); } catch { /* */ }
        try { vizAnalyser.disconnect(); } catch { /* */ }
        wave.disconnect();
      },
    };
  },
};
