// packages/web/src/lib/audio/modules/warrenspectrum.ts
//
// WARRENSPECTRUM — stereo 8-band resonator bank with vactrol-style ping
// excitation, per-band sends/returns, and an acidwarp video visualization.
//
// Audio: 8 bandpass resonators, tuned either as octave-spaced log bands
// (80..10240 Hz, the legacy "spectral EQ" behavior) or as harmonic
// partials (f[i] = rootHz * (i+1)) selected by the `tuning_mode` param.
// `root` (MIDI note) sets the fundamental in harmonic mode (default
// MIDI 60 = middle C). Each band has its own ping gate; rising edges
// distribute excitation across n±2 bands via a bleed matrix (scaled by
// the `bleed` knob) into a vactrol-style envelope (soft attack 10-30ms
// ±10% jitter, exp decay 100-800ms ±10% jitter, tanh-saturated). The
// envelope simultaneously injects a brief impulse into the bandpass
// input (filter rings at its center freq) and pumps the band's
// post-filter gain slightly. Per-band stereo pan is derived from the
// `spread` knob.
//
// Per-band sends + returns: each band has a mono audio output (the
// internal filtered signal, post-envelope, post-level) and a mono audio
// input. When a return is patched, that band's contribution to the
// stereo mix becomes the return signal (replace, not sum) — letting you
// route each partial through an external effect. The host watches
// livePatch.edges and posts a 'returnMask' message to the worklet
// whenever the set of patched returns changes.
//
// Video: viz_out is a mono-video cross-domain bridge driving the same
// acidwarp EQ-curve renderer used by the on-card canvas.
//
// Inputs:
//   in_l / in_r (audio): stereo input feeding all 8 bandpass resonators.
//   level{1..8}_cv (cv, linear, paramTarget=level{N}): per-band level CV.
//   ping{1..8} (gate): per-band excitation gates; rising edge fires a vactrol-ping into band N (+bleed to N±2).
//   global_ping (gate): fires ALL bands at once.
//   viznoise_cv (cv, linear, paramTarget=viznoise): displaces the visualizer hue/noise mix.
//   root_cv (cv, linear, paramTarget=root): displaces the harmonic-mode fundamental.
//   spread_cv (cv, linear, paramTarget=spread): displaces the stereo pan spread.
//   q_cv (cv, linear, paramTarget=q): displaces the resonator Q.
//   decay_cv (cv, linear, paramTarget=ping_decay): displaces the vactrol decay.
//   band{1..8}_in (audio): per-band SEND input — patch here to insert per-band processing.
//
// Outputs:
//   out_l / out_r (audio): stereo mix bus.
//   viz_out (mono-video): the EQ-curve visualization (acidwarp-style render).
//   band{1..8}_out (audio): per-band RETURN tap; pair with the matching `band{N}_in` send for per-band FX.
//
// Params:
//   level{1..8} (linear 0..2, default 1.0): per-band level.
//   master (linear 0..2, default 1.0): master output gain.
//   viznoise (linear 0..1, default 0.3): visualizer hue/noise amount.
//   ping_decay (linear 0..1, default 0.5): vactrol envelope decay.
//   tuning_mode (discrete 0..1, default 0): 0 = octave-spaced log bands, 1 = harmonic partials.
//   root (linear 24..108, default 60): harmonic-mode fundamental MIDI note.
//   q (linear 1..40, default 6): resonator Q.
//   spread (linear 0..1, default 0): stereo-pan width.
//   bleed (linear 0..1, default 1): per-ping cross-band bleed.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import { isInputPortConnected } from './transport-helpers';
import workletUrl from '@patchtogether.live/dsp/dist/warrenspectrum.js?url';
import { drawWarrenspectrum, type WarrenspectrumSnapshot } from './warrenspectrum-draw';

const NUM_BANDS = 8;

const loadedContexts = new WeakSet<BaseAudioContext>();

export interface WarrenspectrumSnapshotMessage {
  type: 'snapshot';
  wave: Float32Array;
  flash: Float32Array;
}

export const warrenspectrumDef: AudioModuleDef = {
  type: 'warrenspectrum',
  palette: { top: 'Hybrid', sub: 'Hybrid' },
  domain: 'audio',
  // v2 adds: tuning_mode, root, q, spread, bleed params; 8 band returns
  // (band1_in..band8_in audio inputs); 8 per-band sends (band1_out..
  // band8_out audio outputs); root_cv / spread_cv / q_cv CV inputs;
  // global_ping gate input.
  label: 'warrenspectrum',
  category: 'effects',
  schemaVersion: 2,
  stereoPairs: [
    ['in_l', 'in_r'],
    ['out_l', 'out_r'],
  ],

  inputs: [
    { id: 'in_l', type: 'audio' },
    { id: 'in_r', type: 'audio' },
    // Per-band level CV → AudioParam fast path (linear ±1cv = ±1.0).
    { id: 'level1_cv', type: 'cv', paramTarget: 'level1', cvScale: { mode: 'linear' } },
    { id: 'level2_cv', type: 'cv', paramTarget: 'level2', cvScale: { mode: 'linear' } },
    { id: 'level3_cv', type: 'cv', paramTarget: 'level3', cvScale: { mode: 'linear' } },
    { id: 'level4_cv', type: 'cv', paramTarget: 'level4', cvScale: { mode: 'linear' } },
    { id: 'level5_cv', type: 'cv', paramTarget: 'level5', cvScale: { mode: 'linear' } },
    { id: 'level6_cv', type: 'cv', paramTarget: 'level6', cvScale: { mode: 'linear' } },
    { id: 'level7_cv', type: 'cv', paramTarget: 'level7', cvScale: { mode: 'linear' } },
    { id: 'level8_cv', type: 'cv', paramTarget: 'level8', cvScale: { mode: 'linear' } },
    // Per-band ping gates.
    { id: 'ping1', type: 'gate' },
    { id: 'ping2', type: 'gate' },
    { id: 'ping3', type: 'gate' },
    { id: 'ping4', type: 'gate' },
    { id: 'ping5', type: 'gate' },
    { id: 'ping6', type: 'gate' },
    { id: 'ping7', type: 'gate' },
    { id: 'ping8', type: 'gate' },
    // Global ping — host fans this gate out to all 8 ping channels of
    // the worklet's ping bus.
    { id: 'global_ping', type: 'gate' },
    // viznoise CV: hue-cycle speed for the visualizer.
    { id: 'viznoise_cv', type: 'cv', paramTarget: 'viznoise', cvScale: { mode: 'linear' } },
    // Tuning + topology CV.
    { id: 'root_cv',   type: 'cv', paramTarget: 'root',   cvScale: { mode: 'linear' } },
    { id: 'spread_cv', type: 'cv', paramTarget: 'spread', cvScale: { mode: 'linear' } },
    { id: 'q_cv',      type: 'cv', paramTarget: 'q',      cvScale: { mode: 'linear' } },
    { id: 'decay_cv',  type: 'cv', paramTarget: 'ping_decay', cvScale: { mode: 'linear' } },
    // Per-band audio returns. When patched, that band's mix is the
    // external return (post-effects); when unpatched, internal is used.
    { id: 'band1_in', type: 'audio' },
    { id: 'band2_in', type: 'audio' },
    { id: 'band3_in', type: 'audio' },
    { id: 'band4_in', type: 'audio' },
    { id: 'band5_in', type: 'audio' },
    { id: 'band6_in', type: 'audio' },
    { id: 'band7_in', type: 'audio' },
    { id: 'band8_in', type: 'audio' },
  ],
  outputs: [
    { id: 'out_l',   type: 'audio' },
    { id: 'out_r',   type: 'audio' },
    { id: 'viz_out', type: 'mono-video' },
    // Per-band mono sends (pre-pan, post-envelope, post-level).
    { id: 'band1_out', type: 'audio' },
    { id: 'band2_out', type: 'audio' },
    { id: 'band3_out', type: 'audio' },
    { id: 'band4_out', type: 'audio' },
    { id: 'band5_out', type: 'audio' },
    { id: 'band6_out', type: 'audio' },
    { id: 'band7_out', type: 'audio' },
    { id: 'band8_out', type: 'audio' },
  ],
  params: [
    { id: 'level1',     label: 'B1',   defaultValue: 1.0, min: 0,  max: 2,   curve: 'linear' },
    { id: 'level2',     label: 'B2',   defaultValue: 1.0, min: 0,  max: 2,   curve: 'linear' },
    { id: 'level3',     label: 'B3',   defaultValue: 1.0, min: 0,  max: 2,   curve: 'linear' },
    { id: 'level4',     label: 'B4',   defaultValue: 1.0, min: 0,  max: 2,   curve: 'linear' },
    { id: 'level5',     label: 'B5',   defaultValue: 1.0, min: 0,  max: 2,   curve: 'linear' },
    { id: 'level6',     label: 'B6',   defaultValue: 1.0, min: 0,  max: 2,   curve: 'linear' },
    { id: 'level7',     label: 'B7',   defaultValue: 1.0, min: 0,  max: 2,   curve: 'linear' },
    { id: 'level8',     label: 'B8',   defaultValue: 1.0, min: 0,  max: 2,   curve: 'linear' },
    { id: 'master',     label: 'Mas',  defaultValue: 1.0, min: 0,  max: 2,   curve: 'linear' },
    { id: 'viznoise',   label: 'Hue',  defaultValue: 0.3, min: 0,  max: 1,   curve: 'linear' },
    { id: 'ping_decay', label: 'Dcy',  defaultValue: 0.5, min: 0,  max: 1,   curve: 'linear' },
    // 0 = log (octave-spaced), 1 = harm (harmonic partials).
    { id: 'tuning_mode', label: 'Mode', defaultValue: 0,  min: 0,  max: 1,   curve: 'discrete' },
    // MIDI note number; 60 = middle C. Used only in harmonic mode.
    { id: 'root',        label: 'Root', defaultValue: 60, min: 24, max: 108, curve: 'linear' },
    { id: 'q',           label: 'Q',    defaultValue: 6,  min: 1,  max: 40,  curve: 'linear' },
    { id: 'spread',      label: 'Spd',  defaultValue: 0,  min: 0,  max: 1,   curve: 'linear' },
    { id: 'bleed',       label: 'Bld',  defaultValue: 1,  min: 0,  max: 1,   curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // Worklet topology:
    //   inputs:  0=in_l, 1=in_r, 2=pings(8ch), 3=returns(8ch)
    //   outputs: 0=out_l, 1=out_r, 2=bandOut(8ch)
    const workletNode = new AudioWorkletNode(ctx, 'warrenspectrum', {
      numberOfInputs: 4,
      numberOfOutputs: 3,
      outputChannelCount: [1, 1, NUM_BANDS],
    });

    // ---- Ping bus (input #2) ----
    const pingMerger = ctx.createChannelMerger(NUM_BANDS);
    pingMerger.connect(workletNode, 0, 2);

    // Per-channel silence sources keep the merger's channels allocated
    // even when no edges are patched.
    const silenceSources: ConstantSourceNode[] = [];
    for (let i = 0; i < NUM_BANDS; i++) {
      const sil = ctx.createConstantSource();
      sil.offset.value = 0;
      sil.start();
      sil.connect(pingMerger, 0, i);
      silenceSources.push(sil);
    }

    // Per-band ping fan-in.
    const pingGains: GainNode[] = [];
    for (let i = 0; i < NUM_BANDS; i++) {
      const g = ctx.createGain();
      g.gain.value = 1;
      g.connect(pingMerger, 0, i);
      pingGains.push(g);
    }

    // Global ping: fan out to all 8 ping merger channels.
    const globalPingGain = ctx.createGain();
    globalPingGain.gain.value = 1;
    for (let i = 0; i < NUM_BANDS; i++) {
      globalPingGain.connect(pingMerger, 0, i);
    }

    // ---- Returns bus (input #3) ----
    const returnsMerger = ctx.createChannelMerger(NUM_BANDS);
    returnsMerger.connect(workletNode, 0, 3);
    const returnSilence: ConstantSourceNode[] = [];
    const returnGains: GainNode[] = [];
    for (let i = 0; i < NUM_BANDS; i++) {
      const sil = ctx.createConstantSource();
      sil.offset.value = 0;
      sil.start();
      sil.connect(returnsMerger, 0, i);
      returnSilence.push(sil);
      const g = ctx.createGain();
      g.gain.value = 1;
      g.connect(returnsMerger, 0, i);
      returnGains.push(g);
    }

    // ---- Per-band sends (output #2 → splitter → individual GainNodes) ----
    const bandSplitter = ctx.createChannelSplitter(NUM_BANDS);
    workletNode.connect(bandSplitter, 2, 0);
    const bandOutGains: GainNode[] = [];
    for (let i = 0; i < NUM_BANDS; i++) {
      const g = ctx.createGain();
      g.gain.value = 1;
      // Splitter channel i → individual mono output node.
      bandSplitter.connect(g, i, 0);
      bandOutGains.push(g);
    }

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;

    // Initialize all AudioParams from node.params (defaults for new
    // params apply when node.params is missing them).
    const nodeParams = node.params ?? {};
    for (let i = 1; i <= NUM_BANDS; i++) {
      const k = `level${i}`;
      params.get(k)?.setValueAtTime(nodeParams[k] ?? 1.0, ctx.currentTime);
    }
    params.get('master')?.setValueAtTime(nodeParams.master ?? 1.0, ctx.currentTime);
    params.get('pingDecay')?.setValueAtTime(nodeParams.ping_decay ?? 0.5, ctx.currentTime);
    params.get('tuningMode')?.setValueAtTime(nodeParams.tuning_mode ?? 0, ctx.currentTime);
    params.get('root')?.setValueAtTime(nodeParams.root ?? 60, ctx.currentTime);
    params.get('q')?.setValueAtTime(nodeParams.q ?? 6, ctx.currentTime);
    params.get('spread')?.setValueAtTime(nodeParams.spread ?? 0, ctx.currentTime);
    params.get('bleed')?.setValueAtTime(nodeParams.bleed ?? 1, ctx.currentTime);

    const vizParams: Record<string, number> = {
      viznoise:   nodeParams.viznoise   ?? 0.3,
      ping_decay: nodeParams.ping_decay ?? 0.5,
    };

    // ---- Snapshot pipe ----
    let latestWave: Float32Array = new Float32Array(256);
    const latestFlash = new Float32Array(NUM_BANDS);
    const displayFlash = new Float32Array(NUM_BANDS);
    let frameCounter = 0;
    workletNode.port.onmessage = (e: MessageEvent) => {
      const m = e.data as WarrenspectrumSnapshotMessage | undefined;
      if (!m || m.type !== 'snapshot') return;
      latestWave = new Float32Array(m.wave);
      for (let i = 0; i < NUM_BANDS; i++) {
        latestFlash[i] = Math.max(latestFlash[i]!, m.flash[i]!);
      }
    };

    // ---- Return-mask watcher ----
    // Poll livePatch.edges on each snapshot post (~30Hz). When the set
    // of patched band returns changes, post a 'returnMask' message so
    // the worklet swaps internal-vs-external for each band.
    const lastMask = new Array<boolean>(NUM_BANDS).fill(false);
    function updateReturnMask(): void {
      const edges = Object.values(livePatch.edges);
      let changed = false;
      const next = new Array<boolean>(NUM_BANDS);
      for (let i = 0; i < NUM_BANDS; i++) {
        const patched = isInputPortConnected(edges, node.id, `band${i + 1}_in`);
        next[i] = patched;
        if (patched !== lastMask[i]) changed = true;
      }
      if (changed) {
        for (let i = 0; i < NUM_BANDS; i++) lastMask[i] = next[i]!;
        try {
          workletNode.port.postMessage({ type: 'returnMask', mask: next });
        } catch { /* worklet may be torn down */ }
      }
    }
    // Push once at startup so the initial state is correct.
    updateReturnMask();

    function getLevels(): number[] {
      const out: number[] = [];
      for (let i = 1; i <= NUM_BANDS; i++) {
        const p = params.get(`level${i}`);
        out.push(p?.value ?? 1);
      }
      return out;
    }

    function readSnapshot(): WarrenspectrumSnapshot {
      frameCounter = (frameCounter + 1) >>> 0;
      // Refresh return-mask on every snapshot read (cheap; only posts
      // a message when actually changed).
      updateReturnMask();
      if ((frameCounter & 1) === 0) {
        for (let i = 0; i < NUM_BANDS; i++) {
          latestFlash[i] = latestFlash[i]! * 0.92;
          if (latestFlash[i]! < 1e-3) latestFlash[i] = 0;
          displayFlash[i] = latestFlash[i]!;
        }
      }
      return {
        wave: latestWave,
        flash: Array.from(displayFlash),
        levels: getLevels(),
        frame: frameCounter,
        viznoise: vizParams.viznoise!,
      };
    }

    function drawFrame(canvas: OffscreenCanvas | HTMLCanvasElement): void {
      const ctx2d = canvas.getContext('2d') as
        | CanvasRenderingContext2D
        | OffscreenCanvasRenderingContext2D
        | null;
      if (!ctx2d) return;
      const snap = readSnapshot();
      drawWarrenspectrum(ctx2d, snap, canvas.width, canvas.height);
    }

    const outBus = ctx.createGain();
    outBus.gain.value = 1;
    workletNode.connect(outBus, 0);
    workletNode.connect(outBus, 1);
    const vizAnalyser = ctx.createAnalyser();
    vizAnalyser.fftSize = 2048;
    outBus.connect(vizAnalyser);

    const inputs = new Map<string, { node: AudioNode; input: number; param?: AudioParam }>();
    inputs.set('in_l', { node: workletNode, input: 0 });
    inputs.set('in_r', { node: workletNode, input: 1 });
    for (let i = 1; i <= NUM_BANDS; i++) {
      const p = params.get(`level${i}`)!;
      inputs.set(`level${i}_cv`, { node: workletNode, input: 0, param: p });
    }
    for (let i = 0; i < NUM_BANDS; i++) {
      inputs.set(`ping${i + 1}`, { node: pingGains[i]!, input: 0 });
    }
    inputs.set('global_ping', { node: globalPingGain, input: 0 });
    for (let i = 0; i < NUM_BANDS; i++) {
      inputs.set(`band${i + 1}_in`, { node: returnGains[i]!, input: 0 });
    }
    inputs.set('viznoise_cv', { node: outBus, input: 0, param: outBus.gain });
    inputs.set('root_cv',     { node: workletNode, input: 0, param: params.get('root')! });
    inputs.set('spread_cv',   { node: workletNode, input: 0, param: params.get('spread')! });
    inputs.set('q_cv',        { node: workletNode, input: 0, param: params.get('q')! });
    inputs.set('decay_cv',    { node: workletNode, input: 0, param: params.get('pingDecay')! });

    const outputs = new Map<string, { node: AudioNode; output: number }>();
    outputs.set('out_l', { node: workletNode, output: 0 });
    outputs.set('out_r', { node: workletNode, output: 1 });
    for (let i = 0; i < NUM_BANDS; i++) {
      outputs.set(`band${i + 1}_out`, { node: bandOutGains[i]!, output: 0 });
    }

    return {
      domain: 'audio',
      inputs,
      outputs,
      videoSources: new Map([
        ['viz_out', { analyser: vizAnalyser, sampleRate: ctx.sampleRate, drawFrame }],
      ]),
      setParam(paramId, value) {
        if (paramId === 'viznoise') {
          vizParams.viznoise = value;
          return;
        }
        if (paramId === 'ping_decay') {
          vizParams.ping_decay = value;
          params.get('pingDecay')?.setValueAtTime(value, ctx.currentTime);
          return;
        }
        if (paramId === 'tuning_mode') {
          params.get('tuningMode')?.setValueAtTime(value, ctx.currentTime);
          return;
        }
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        if (paramId === 'viznoise') return vizParams.viznoise;
        if (paramId === 'ping_decay') return vizParams.ping_decay;
        if (paramId === 'tuning_mode') return params.get('tuningMode')?.value;
        return params.get(paramId)?.value;
      },
      read(key) {
        if (key === 'snapshot') return readSnapshot();
        if (key === 'levels') return getLevels();
        return undefined;
      },
      dispose() {
        try { workletNode.port.onmessage = null; } catch { /* ignore */ }
        for (const s of silenceSources) {
          try { s.stop(); } catch { /* */ }
          s.disconnect();
        }
        for (const s of returnSilence) {
          try { s.stop(); } catch { /* */ }
          s.disconnect();
        }
        for (const g of pingGains) g.disconnect();
        for (const g of returnGains) g.disconnect();
        for (const g of bandOutGains) g.disconnect();
        globalPingGain.disconnect();
        pingMerger.disconnect();
        returnsMerger.disconnect();
        bandSplitter.disconnect();
        outBus.disconnect();
        vizAnalyser.disconnect();
        workletNode.disconnect();
      },
    };
  },
};
