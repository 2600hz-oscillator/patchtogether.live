// packages/web/src/lib/audio/modules/synesthesia.ts
//
// SYNESTHESIA — web module def + factory. Two independent copies (A/B) of a
// 4-band audio-analysis circuit. Each copy: mono in → 4 spectral bands
// (0–200 / 200–500 / 500–2000 / 2000+) → per-band gain (master floor + band) →
// per-band audio, slow (500 ms) + fast (50 ms) envelope-follower CV, and a
// gate. A 10-bar VU meter per band is driven by a `snapshot` posted from the
// worklet. DSP lives in packages/dsp/src/synesthesia.ts.
//
// Worklet I/O (see packages/dsp/src/synesthesia.ts):
//   inputs:  0 = copy A in, 1 = copy B in   (mono)
//   outputs: 0=audioA 1=audioB 2=slowA 3=slowB 4=fastA 5=fastB 6=gateA 7=gateB
//            (each 4 channels = the 4 bands)
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
];

const PARAM_DEFAULTS: Record<string, number> = {};
for (const c of COPIES) {
  PARAM_DEFAULTS[`${c}_master`] = 1;
  PARAM_DEFAULTS[`${c}_mode`] = 0; // 0 = AUDIO (spectral bands), 1 = VIDEO (R/G/B/Luma)
  for (const b of BANDS) PARAM_DEFAULTS[`${c}_gain${b}`] = 1;
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
  schemaVersion: 1,

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
  // 2 copies × 4 bands × {audio, env_slow, env_fast, gate, raster} = 40 outputs.
  // Written as a literal list (not a flatMap) so the docs module-manifest's
  // static literal-array port extractor stays in sync (see module-manifest.ts).
  outputs: [
    // ---- Copy A ----
    { id: 'a_band1_audio',    type: 'audio' },
    { id: 'a_band1_env_slow', type: 'cv' },
    { id: 'a_band1_env_fast', type: 'cv' },
    { id: 'a_band1_gate',     type: 'gate' },
    { id: 'a_band1_raster',   type: 'mono-video' },
    { id: 'a_band2_audio',    type: 'audio' },
    { id: 'a_band2_env_slow', type: 'cv' },
    { id: 'a_band2_env_fast', type: 'cv' },
    { id: 'a_band2_gate',     type: 'gate' },
    { id: 'a_band2_raster',   type: 'mono-video' },
    { id: 'a_band3_audio',    type: 'audio' },
    { id: 'a_band3_env_slow', type: 'cv' },
    { id: 'a_band3_env_fast', type: 'cv' },
    { id: 'a_band3_gate',     type: 'gate' },
    { id: 'a_band3_raster',   type: 'mono-video' },
    { id: 'a_band4_audio',    type: 'audio' },
    { id: 'a_band4_env_slow', type: 'cv' },
    { id: 'a_band4_env_fast', type: 'cv' },
    { id: 'a_band4_gate',     type: 'gate' },
    { id: 'a_band4_raster',   type: 'mono-video' },
    // ---- Copy B ----
    { id: 'b_band1_audio',    type: 'audio' },
    { id: 'b_band1_env_slow', type: 'cv' },
    { id: 'b_band1_env_fast', type: 'cv' },
    { id: 'b_band1_gate',     type: 'gate' },
    { id: 'b_band1_raster',   type: 'mono-video' },
    { id: 'b_band2_audio',    type: 'audio' },
    { id: 'b_band2_env_slow', type: 'cv' },
    { id: 'b_band2_env_fast', type: 'cv' },
    { id: 'b_band2_gate',     type: 'gate' },
    { id: 'b_band2_raster',   type: 'mono-video' },
    { id: 'b_band3_audio',    type: 'audio' },
    { id: 'b_band3_env_slow', type: 'cv' },
    { id: 'b_band3_env_fast', type: 'cv' },
    { id: 'b_band3_gate',     type: 'gate' },
    { id: 'b_band3_raster',   type: 'mono-video' },
    { id: 'b_band4_audio',    type: 'audio' },
    { id: 'b_band4_env_slow', type: 'cv' },
    { id: 'b_band4_env_fast', type: 'cv' },
    { id: 'b_band4_gate',     type: 'gate' },
    { id: 'b_band4_raster',   type: 'mono-video' },
  ],
  params: [
    // Per-copy MODE: 0 = AUDIO (spectral bands), 1 = VIDEO (R/G/B/Luma). Each
    // copy switches independently. Discrete 0/1 (a toggle on the card).
    { id: 'a_mode', label: 'A Mode', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
    { id: 'b_mode', label: 'B Mode', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
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
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'synesthesia', {
      numberOfInputs: 2,
      numberOfOutputs: 8,
      outputChannelCount: [4, 4, 4, 4, 4, 4, 4, 4],
    });

    // Keep-alive: an AudioWorkletNode only runs process() while it has a path
    // to ctx.destination. SYNESTHESIA is an analyser — its outputs are often
    // unpatched — so without this the worklet would never process: no VU
    // levels, envelopes, or gates (the DOOM audio_l/audio_r orphan-silent
    // class of bug; same fix samsloop's record tap uses). Route through a
    // muted gain so it always runs but is inaudible.
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
          const drawFrame = (canvas: OffscreenCanvas | HTMLCanvasElement): void => {
            const c2d = canvas.getContext('2d') as
              | CanvasRenderingContext2D
              | OffscreenCanvasRenderingContext2D
              | null;
            if (!c2d) return;
            analyser.getFloatTimeDomainData(buf);
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
