// packages/web/src/lib/audio/modules/synesthesia.ts
//
// SYNESTHESIA — web module def + factory. Two independent copies (A/B) of a
// 4-band audio-analysis circuit. Each copy: mono in → 4 MUSICAL bands
// (bass 20–200 / low-mid 200–1k / high-mid 1k–4k / treble 4k+) → per-band gain
// (master floor + band) → per-band audio, slow (500 ms) + fast (50 ms)
// envelope-follower CV, a hysteresis gate, and a per-band BEAT TRIGGER
// (spectral-flux onset → ~10 ms pulse, LZX-Sensory-Translator style). A 10-bar
// VU meter per band is driven by a `snapshot` posted from the worklet. DSP
// lives in packages/dsp/src/synesthesia.ts.
//
// Worklet I/O (see packages/dsp/src/synesthesia.ts):
//   inputs:  0 = copy A in, 1 = copy B in   (mono)
//   outputs: 0=audioA 1=audioB 2=slowA 3=slowB 4=fastA 5=fastB 6=gateA 7=gateB
//            8=trigA 9=trigB   (each 4 channels = the 4 bands)
//
// VIDEO mode (per copy, independent): a_mode/b_mode params (0=AUDIO, 1=VIDEO).
// In VIDEO mode the 4 lanes become R/G/B/Luma of the patched frame: the CARD
// reads the incoming video frame's pixels (only the DOM has the canvas; the
// worklet can't), averages them to 4 channel levels via videoChannelLevels(),
// and writes them to the worklet via handle.write('video_levels_a'|'_b', …)
// each frame. The worklet sample-and-holds the levels through the same env/
// gate/meter stage. The cross-domain video inputs a_video_in/b_video_in are
// consumed card-side (WAVESCULPT wall precedent) — the engine ignores the
// audio↔audio video-frame edge.
// The factory fans each 4-channel output through a ChannelSplitter into 4 mono
// GainNodes so every band/kind is an individually-patchable port. Each band's
// AUDIO tap also feeds a per-band mono-video "rasterize" output (audio→video):
// an AnalyserNode → drawBandRaster() painting the band's samples as a raster.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/synesthesia.js?url';
import { drawBandRaster } from './synesthesia-draw';

// ---- DETERMINISTIC render-smoke (DRS) seam — zero production impact ----
// The per-band `*_raster` video output paints the band's LIVE analyser
// time-domain window (drawBandRaster) each frame. That window carries whatever
// the audio thread last DMA'd in, which varies by tens of microseconds (= many
// audio samples) run-to-run — the exact non-determinism class wavesculpt's
// __wavesculptVrtFreeze cures. There is NO wall-clock / time / accumulation term
// in the raster draw (it's a stateless function of the current analyser buffer),
// so the seam is NOT a clock-freeze: when the flag is set we OVERRIDE the live
// analyser readout with a FIXED synthetic per-band waveform so the rastered frame
// is byte-stable across runs (non-black + spatially structured by construction).
// The flag is never set in production; the audio/env/gate/meter path is untouched
// (only the raster's source buffer is swapped). Parallels wavesculpt's scope
// freeze + b3ntb0x/bentbox's clock-freeze test seams.
function synesthesiaVrtFrozen(): boolean {
  return (
    (globalThis as unknown as { __synesthesiaVrtFreeze?: boolean }).__synesthesiaVrtFreeze === true
  );
}

/** Fill `buf` with a FIXED synthetic per-band waveform (deterministic raster
 *  source under the VRT-freeze flag). `band` (0..3) picks distinct cycle counts
 *  so the four bands' rasters are visually distinguishable + non-trivially
 *  structured; amplitude 0.6 clears drawBandRaster's ×3 → near-full-scale green
 *  without saturating, so nonZeroFrac + variance floors both hold. */
function fillFrozenBand(buf: Float32Array, band: number): void {
  const cycles = (band + 1) * 1.5; // 1.5 / 3 / 4.5 / 6 cycles across the window
  const amp = 0.6;
  const n = buf.length;
  for (let i = 0; i < n; i++) buf[i] = amp * Math.sin((i / n) * Math.PI * 2 * cycles);
}

const COPIES = ['a', 'b'] as const;
const BANDS = [1, 2, 3, 4] as const;

// Output streams, in worklet-output order. Each entry is one 4-channel worklet
// output (channel index = band index). `port` is the per-band port-id kind.
const OUT_STREAMS: Array<{ outIndex: number; copy: 'a' | 'b'; kind: string; type: 'audio' | 'cv' | 'gate' }> = [
  { outIndex: 0, copy: 'a', kind: 'audio',    type: 'audio' },
  { outIndex: 1, copy: 'b', kind: 'audio',    type: 'audio' },
  { outIndex: 2, copy: 'a', kind: 'env_slow', type: 'cv' },
  { outIndex: 3, copy: 'b', kind: 'env_slow', type: 'cv' },
  { outIndex: 4, copy: 'a', kind: 'env_fast', type: 'cv' },
  { outIndex: 5, copy: 'b', kind: 'env_fast', type: 'cv' },
  { outIndex: 6, copy: 'a', kind: 'gate',     type: 'gate' },
  { outIndex: 7, copy: 'b', kind: 'gate',     type: 'gate' },
  // Per-band beat triggers (spectral-flux onset; ~10 ms pulse). Worklet
  // outputs 8/9; fanned into 4 per-band gate ports each, same as `gate`.
  { outIndex: 8, copy: 'a', kind: 'trig',     type: 'gate' },
  { outIndex: 9, copy: 'b', kind: 'trig',     type: 'gate' },
];

const PARAM_DEFAULTS: Record<string, number> = {};
for (const c of COPIES) {
  PARAM_DEFAULTS[`${c}_master`] = 1;
  PARAM_DEFAULTS[`${c}_mode`] = 0; // 0 = AUDIO (spectral bands), 1 = VIDEO (R/G/B/Luma)
  PARAM_DEFAULTS[`${c}_bipolar`] = 0; // 0 = UNIPOLAR env CV [0,1], 1 = BIPOLAR [-1,+1]
  for (const b of BANDS) {
    PARAM_DEFAULTS[`${c}_gain${b}`] = 1;
    // Per-band ENV-OUTPUT depth: scales BOTH env CV outputs (env_slow +
    // env_fast) for that band. Default 1.0 = unchanged.
    PARAM_DEFAULTS[`${c}_envdepth${b}`] = 1;
  }
}

const loadedContexts = new WeakSet<BaseAudioContext>();

export interface SynesthesiaSnapshot {
  levelsA: number[];
  levelsB: number[];
}

export const synesthesiaDef: AudioModuleDef = {
  type: 'synesthesia',
  palette: { top: 'Hybrid', sub: 'Hybrid' },
  domain: 'audio',
  label: 'synesthesia',
  category: 'hybrid',

  inputs: [
    { id: 'a_in', type: 'audio' },
    { id: 'b_in', type: 'audio' },
    // Cross-domain VIDEO inputs (one per copy). In VIDEO mode the card reads
    // the patched frame's pixels and writes R/G/B/Luma channel levels to the
    // worklet. The frame handoff is done card-side (the engine ignores an
    // audio↔audio video-frame edge — see PatchEngine.addEdge), matching
    // WAVESCULPT's wall inputs.
    { id: 'a_video_in', type: 'video' },
    { id: 'b_video_in', type: 'video' },
  ],
  // 2 copies × 4 bands × {audio, env_slow, env_fast, gate, trig, raster} = 48
  // outputs. Written as a literal list (not a flatMap) so the docs
  // module-manifest's static literal-array port extractor stays in sync (see
  // module-manifest.ts). `trig` is the per-band beat trigger (spectral-flux onset).
  outputs: [
    // ---- Copy A ----
    { id: 'a_band1_audio',    type: 'audio' },
    { id: 'a_band1_env_slow', type: 'cv' },
    { id: 'a_band1_env_fast', type: 'cv' },
    { id: 'a_band1_gate',     type: 'gate' },
    { id: 'a_band1_trig',     type: 'gate' },
    { id: 'a_band1_raster',   type: 'mono-video' },
    { id: 'a_band2_audio',    type: 'audio' },
    { id: 'a_band2_env_slow', type: 'cv' },
    { id: 'a_band2_env_fast', type: 'cv' },
    { id: 'a_band2_gate',     type: 'gate' },
    { id: 'a_band2_trig',     type: 'gate' },
    { id: 'a_band2_raster',   type: 'mono-video' },
    { id: 'a_band3_audio',    type: 'audio' },
    { id: 'a_band3_env_slow', type: 'cv' },
    { id: 'a_band3_env_fast', type: 'cv' },
    { id: 'a_band3_gate',     type: 'gate' },
    { id: 'a_band3_trig',     type: 'gate' },
    { id: 'a_band3_raster',   type: 'mono-video' },
    { id: 'a_band4_audio',    type: 'audio' },
    { id: 'a_band4_env_slow', type: 'cv' },
    { id: 'a_band4_env_fast', type: 'cv' },
    { id: 'a_band4_gate',     type: 'gate' },
    { id: 'a_band4_trig',     type: 'gate' },
    { id: 'a_band4_raster',   type: 'mono-video' },
    // ---- Copy B ----
    { id: 'b_band1_audio',    type: 'audio' },
    { id: 'b_band1_env_slow', type: 'cv' },
    { id: 'b_band1_env_fast', type: 'cv' },
    { id: 'b_band1_gate',     type: 'gate' },
    { id: 'b_band1_trig',     type: 'gate' },
    { id: 'b_band1_raster',   type: 'mono-video' },
    { id: 'b_band2_audio',    type: 'audio' },
    { id: 'b_band2_env_slow', type: 'cv' },
    { id: 'b_band2_env_fast', type: 'cv' },
    { id: 'b_band2_gate',     type: 'gate' },
    { id: 'b_band2_trig',     type: 'gate' },
    { id: 'b_band2_raster',   type: 'mono-video' },
    { id: 'b_band3_audio',    type: 'audio' },
    { id: 'b_band3_env_slow', type: 'cv' },
    { id: 'b_band3_env_fast', type: 'cv' },
    { id: 'b_band3_gate',     type: 'gate' },
    { id: 'b_band3_trig',     type: 'gate' },
    { id: 'b_band3_raster',   type: 'mono-video' },
    { id: 'b_band4_audio',    type: 'audio' },
    { id: 'b_band4_env_slow', type: 'cv' },
    { id: 'b_band4_env_fast', type: 'cv' },
    { id: 'b_band4_gate',     type: 'gate' },
    { id: 'b_band4_trig',     type: 'gate' },
    { id: 'b_band4_raster',   type: 'mono-video' },
  ],
  params: [
    // Per-copy MODE: 0 = AUDIO (spectral bands), 1 = VIDEO (R/G/B/Luma). Each
    // copy switches independently. Discrete 0/1 (a toggle on the card).
    { id: 'a_mode', label: 'A Mode', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
    { id: 'b_mode', label: 'B Mode', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
    // Per-copy POLARITY of the env CV outputs: 0 = UNIPOLAR [0,1] (default,
    // preserves existing patches), 1 = BIPOLAR [-1,+1]. Bipolar makes a strong
    // kick sweep the FULL destination range through the knob-centered cv→video
    // bridge instead of just the upper half. Discrete 0/1 (a toggle on the card).
    { id: 'a_bipolar', label: 'A Polarity', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
    { id: 'b_bipolar', label: 'B Polarity', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
    // Master gain: 0.5×@7:00 → 1.5×@5:00 (unity at 12:00) — raises/lowers floor.
    { id: 'a_master', label: 'A Mas', defaultValue: 1, min: 0.5, max: 1.5, curve: 'linear' },
    { id: 'b_master', label: 'B Mas', defaultValue: 1, min: 0.5, max: 1.5, curve: 'linear' },
    // Per-band gain: 1×@7:00 → 2×@5:00.
    { id: 'a_gain1', label: 'A1', defaultValue: 1, min: 1, max: 2, curve: 'linear' },
    { id: 'a_gain2', label: 'A2', defaultValue: 1, min: 1, max: 2, curve: 'linear' },
    { id: 'a_gain3', label: 'A3', defaultValue: 1, min: 1, max: 2, curve: 'linear' },
    { id: 'a_gain4', label: 'A4', defaultValue: 1, min: 1, max: 2, curve: 'linear' },
    { id: 'b_gain1', label: 'B1', defaultValue: 1, min: 1, max: 2, curve: 'linear' },
    { id: 'b_gain2', label: 'B2', defaultValue: 1, min: 1, max: 2, curve: 'linear' },
    { id: 'b_gain3', label: 'B3', defaultValue: 1, min: 1, max: 2, curve: 'linear' },
    { id: 'b_gain4', label: 'B4', defaultValue: 1, min: 1, max: 2, curve: 'linear' },
    // Per-band ENV-OUTPUT DEPTH (8 = 2 copies × 4 bands). Each knob scales BOTH
    // env CV outputs (env_slow + env_fast) for that copy/band — the source-side
    // modulation-depth control. 0×@7:00 (silenced) → 2×@5:00 (doubled, clamped
    // to the 0..1 CV ceiling); default 1.0 (unity) at 12:00 = unchanged.
    { id: 'a_envdepth1', label: 'a1 dpt', defaultValue: 1, min: 0, max: 2, curve: 'linear' },
    { id: 'a_envdepth2', label: 'a2 dpt', defaultValue: 1, min: 0, max: 2, curve: 'linear' },
    { id: 'a_envdepth3', label: 'a3 dpt', defaultValue: 1, min: 0, max: 2, curve: 'linear' },
    { id: 'a_envdepth4', label: 'a4 dpt', defaultValue: 1, min: 0, max: 2, curve: 'linear' },
    { id: 'b_envdepth1', label: 'b1 dpt', defaultValue: 1, min: 0, max: 2, curve: 'linear' },
    { id: 'b_envdepth2', label: 'b2 dpt', defaultValue: 1, min: 0, max: 2, curve: 'linear' },
    { id: 'b_envdepth3', label: 'b3 dpt', defaultValue: 1, min: 0, max: 2, curve: 'linear' },
    { id: 'b_envdepth4', label: 'b4 dpt', defaultValue: 1, min: 0, max: 2, curve: 'linear' },
  ],

  docs: (() => {
    const BAND_NAMES: Record<number, string> = {
      1: 'bass (20–200 Hz)',
      2: 'low-mid (200 Hz–1 kHz)',
      3: 'high-mid (1–4 kHz)',
      4: 'treble (4 kHz+)',
    };
    const outputs: Record<string, string> = {};
    const controls: Record<string, string> = {};
    for (const c of COPIES) {
      const C = c.toUpperCase();
      controls[`${c}_mode`] = `Copy ${C} MODE — AUDIO (analyse the audio input into 4 spectral bands) vs VIDEO (the 4 lanes become R / G / B / Luma of the patched ${c}_video_in frame, sampled card-side). Toggle on the card.`;
      controls[`${c}_bipolar`] = `Copy ${C} env POLARITY — UNIPOLAR (env CV outputs run 0..1, the default) vs BIPOLAR (−1..+1, so a strong onset sweeps a destination's FULL range through a knob-centred CV→video bridge). Toggle on the card.`;
      controls[`${c}_master`] = `Copy ${C} MASTER gain (0.5×..1.5×, unity at noon) — raises or lowers the floor of all four of copy ${C}'s bands together.`;
      for (const b of BANDS) {
        controls[`${c}_gain${b}`] = `Copy ${C} band ${b} GAIN (1×..2×) — boosts the ${BAND_NAMES[b]} band's level for copy ${C} (affects its audio tap + how hard it drives the envelopes/gate/meter).`;
        controls[`${c}_envdepth${b}`] = `Copy ${C} band ${b} ENV DEPTH (0×..2×, unity at noon) — scales BOTH env CV outputs (slow + fast) for copy ${C}'s ${BAND_NAMES[b]} band; 0 silences that band's modulation, 2 doubles it (clamped to the CV ceiling).`;
        outputs[`${c}_band${b}_audio`] = `Copy ${C} band ${b} AUDIO — the isolated ${BAND_NAMES[b]} band of copy ${C}'s input (post gain). Patch it as a band-split audio signal.`;
        outputs[`${c}_band${b}_env_slow`] = `Copy ${C} band ${b} SLOW envelope CV — a ~500 ms envelope-follower tracking the ${BAND_NAMES[b]} band's level; smooth modulation that rides the band's overall energy. Polarity set by copy ${C}'s POLARITY.`;
        outputs[`${c}_band${b}_env_fast`] = `Copy ${C} band ${b} FAST envelope CV — a ~50 ms envelope-follower on the ${BAND_NAMES[b]} band; snappier modulation that tracks transients. Polarity set by copy ${C}'s POLARITY.`;
        outputs[`${c}_band${b}_gate`] = `Copy ${C} band ${b} GATE — goes high while the ${BAND_NAMES[b]} band's level is above a hysteresis threshold and low when it falls below; a level-sensitive gate that follows energy in that band.`;
        outputs[`${c}_band${b}_trig`] = `Copy ${C} band ${b} TRIGGER — a short ~10 ms pulse on each spectral-flux onset (beat) detected in the ${BAND_NAMES[b]} band (LZX-Sensory-Translator style). Patch into envelopes/drum voices to fire on that band's hits.`;
        outputs[`${c}_band${b}_raster`] = `Copy ${C} band ${b} RASTER — a mono-video output painting the ${BAND_NAMES[b]} band's live waveform as a raster (audio→video), for patching into video destinations.`;
      }
    }
    return {
      explanation:
        "SYNESTHESIA is a dual 4-band audio analyser + envelope/gate/trigger generator — an audio-reactive modulation source. It holds TWO independent copies (A and B); each takes a mono input and splits it into four MUSICAL bands (bass / low-mid / high-mid / treble). For every band of every copy it emits a rich fan of outputs: the isolated band audio, a SLOW (~500 ms) and a FAST (~50 ms) envelope-follower CV, a hysteresis GATE that opens while the band is loud, a beat TRIGGER fired on each spectral-flux onset in that band, and a mono-video RASTER of the band's waveform — 4 bands × 6 kinds × 2 copies = 48 outputs. Each copy can instead run in VIDEO mode, where the 4 lanes become R/G/B/Luma of a patched video frame (sampled card-side) and flow through the same envelope/gate/meter stage. Per-band GAIN, per-copy MASTER, an env-output DEPTH per band, and a UNIPOLAR/BIPOLAR polarity switch shape the modulation; a 10-bar VU meter per band is drawn on the card.",
      inputs: {
        a_in: 'Copy A audio input — the mono signal copy A splits into its 4 spectral bands (in AUDIO mode).',
        b_in: 'Copy B audio input — the mono signal copy B splits into its 4 spectral bands (in AUDIO mode).',
        a_video_in: "Copy A video input — used only when copy A is in VIDEO mode: the card reads this frame's pixels, averages them to R/G/B/Luma levels, and feeds those through copy A's 4 lanes (the frame handoff happens card-side, not as an audio edge).",
        b_video_in: 'Copy B video input — the VIDEO-mode frame source for copy B (same card-side handoff as copy A).',
      },
      outputs,
      controls,
    };
  })(),

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'synesthesia', {
      numberOfInputs: 2,
      numberOfOutputs: 10, // +2: per-band beat-trigger streams (trig A / trig B)
      outputChannelCount: [4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
    });

    // Keep-alive: an AudioWorkletNode only runs process() while it has a path
    // to ctx.destination. SYNESTHESIA is an analyser — its outputs are often
    // unpatched — so without this the worklet would never process: no VU
    // levels, envelopes, gates, OR per-band beat triggers (the DOOM
    // audio_l/audio_r orphan-silent class of bug; same fix samsloop's record
    // tap uses). connect() with no output index pulls worklet output 0, which
    // keeps the WHOLE processor (all 10 outputs incl. the new trig 8/9)
    // running every quantum even while their fan-out ports sit unpatched.
    // Route through a muted gain so it always runs but is inaudible.
    const keepAlive = ctx.createGain();
    keepAlive.gain.value = 0;
    workletNode.connect(keepAlive);
    keepAlive.connect(ctx.destination);

    const splitters: ChannelSplitterNode[] = [];
    const outGains: GainNode[] = [];
    const rasterAnalysers: AnalyserNode[] = [];
    const outputs = new Map<string, { node: AudioNode; output: number }>();
    const videoSources = new Map<
      string,
      { analyser: AnalyserNode; sampleRate: number; drawFrame: (c: OffscreenCanvas | HTMLCanvasElement) => void }
    >();

    // Fan each 4-channel worklet output into 4 mono GainNodes (one per band).
    // For the two AUDIO streams (copy A / B) we ALSO tap each band into an
    // analyser feeding a per-band mono-video "rasterize" output (audio→video).
    for (const stream of OUT_STREAMS) {
      const splitter = ctx.createChannelSplitter(4);
      workletNode.connect(splitter, stream.outIndex, 0);
      splitters.push(splitter);
      for (let b = 0; b < BANDS.length; b++) {
        const g = ctx.createGain();
        g.gain.value = 1;
        splitter.connect(g, b, 0);
        outGains.push(g);
        outputs.set(`${stream.copy}_band${b + 1}_${stream.kind}`, { node: g, output: 0 });

        if (stream.kind === 'audio') {
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 2048;
          analyser.smoothingTimeConstant = 0;
          g.connect(analyser);
          // Route the analyser through the muted keep-alive so it stays pulled
          // (and keeps filling) even when the raster output isn't patched.
          analyser.connect(keepAlive);
          rasterAnalysers.push(analyser);
          const buf = new Float32Array(analyser.fftSize);
          const bandIdx = b; // 0..3, captured per band for the deterministic seam
          const drawFrame = (canvas: OffscreenCanvas | HTMLCanvasElement): void => {
            const c2d = canvas.getContext('2d') as
              | CanvasRenderingContext2D
              | OffscreenCanvasRenderingContext2D
              | null;
            if (!c2d) return;
            // DRS seam: under __synesthesiaVrtFreeze paint a FIXED synthetic
            // waveform (deterministic raster); otherwise the LIVE analyser window.
            if (synesthesiaVrtFrozen()) fillFrozenBand(buf, bandIdx);
            else analyser.getFloatTimeDomainData(buf);
            drawBandRaster(c2d, buf, canvas.width, canvas.height);
          };
          videoSources.set(`${stream.copy}_band${b + 1}_raster`, {
            analyser,
            sampleRate: ctx.sampleRate,
            drawFrame,
          });
        }
      }
    }

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    const nodeParams = node.params ?? {};
    for (const name of Object.keys(PARAM_DEFAULTS)) {
      params.get(name)?.setValueAtTime(nodeParams[name] ?? PARAM_DEFAULTS[name]!, ctx.currentTime);
    }

    // ---- VU snapshot pipe ----
    let levelsA: number[] = [0, 0, 0, 0];
    let levelsB: number[] = [0, 0, 0, 0];
    workletNode.port.onmessage = (e: MessageEvent) => {
      const m = e.data as { type?: string; levelsA?: Float32Array; levelsB?: Float32Array } | undefined;
      if (!m || m.type !== 'snapshot') return;
      if (m.levelsA) levelsA = Array.from(m.levelsA);
      if (m.levelsB) levelsB = Array.from(m.levelsB);
    };

    const inputs = new Map<string, { node: AudioNode; input: number; param?: AudioParam }>();
    inputs.set('a_in', { node: workletNode, input: 0 });
    inputs.set('b_in', { node: workletNode, input: 1 });

    return {
      domain: 'audio',
      inputs,
      outputs,
      videoSources,
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      read(key) {
        if (key === 'snapshot') return { levelsA, levelsB } satisfies SynesthesiaSnapshot;
        return undefined;
      },
      // VIDEO mode: the card reads the patched frame's pixels, computes the
      // R/G/B/Luma channel levels, and writes them here each video frame. We
      // forward to the worklet, which sample-and-holds them across the quantum.
      // Keys: 'video_levels_a' / 'video_levels_b'; value is a length-4 array.
      write(key, value) {
        const copy = key === 'video_levels_b' ? 'b' : key === 'video_levels_a' ? 'a' : null;
        if (!copy || !Array.isArray(value)) return;
        try {
          workletNode.port.postMessage({ type: 'video', copy, levels: value as number[] });
        } catch {
          /* port may be closed during teardown */
        }
      },
      dispose() {
        try { workletNode.port.onmessage = null; } catch { /* ignore */ }
        for (const g of outGains) g.disconnect();
        for (const a of rasterAnalysers) a.disconnect();
        for (const s of splitters) s.disconnect();
        keepAlive.disconnect();
        workletNode.disconnect();
      },
    };
  },
};
