// packages/web/src/lib/audio/modules/warrenspectrum.ts
//
// WARRENSPECTRUM — stereo 8-band filterbank with vactrol-style ping
// excitation and an acidwarp video visualization.
//
// Audio: 8 octave-spaced bandpass filters (80, 160, 320, 640, 1280,
// 2560, 5120, 10240 Hz) at Q=6. Each band has its own ping gate input;
// rising edges distribute excitation across n±2 bands via a bleed
// matrix (1.0 / 0.35 / 0.12) into a vactrol-style envelope (soft
// attack 10-30 ms ±10% jitter, exponential decay 100-800 ms ±10%
// jitter, tanh-saturated). The envelope simultaneously injects a brief
// impulse into the bandpass input (filter rings at its center freq)
// and pumps the band's post-filter gain slightly.
//
// Video: viz_out is a mono-video cross-domain bridge. The card renders
// an EQ-curve overlay (8 bars connected by a Catmull-Rom spline) with
// a semi-transparent audio waveform trace, cycling hue palette
// (acidwarp), and ping-flash columns for each band. Same drawFrame
// pattern as SCOPE — drawWarrenspectrum is the shared renderer, called
// both by the on-card canvas effect AND the audio→video bridge.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
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
  domain: 'audio',
  label: 'WARRENSPECTRUM',
  category: 'effects',
  schemaVersion: 1,
  stereoPairs: [
    ['in_l', 'in_r'],
    ['out_l', 'out_r'],
  ],

  // 19 inputs: stereo audio in + 8 level CV + 8 ping gates + 1 viznoise CV.
  // 3 outputs: stereo audio + mono-video viz.
  inputs: [
    { id: 'in_l', type: 'audio' },
    { id: 'in_r', type: 'audio' },
    // Per-band level CV. CV → AudioParam (level1..level8) via the engine's
    // standard CV→param fast path. Linear scaling: ±1 cv = ±1.0 (full
    // 0..2 sweep) — see .myrobots/plans/cv-range-standard.md.
    { id: 'level1_cv', type: 'cv', paramTarget: 'level1', cvScale: { mode: 'linear' } },
    { id: 'level2_cv', type: 'cv', paramTarget: 'level2', cvScale: { mode: 'linear' } },
    { id: 'level3_cv', type: 'cv', paramTarget: 'level3', cvScale: { mode: 'linear' } },
    { id: 'level4_cv', type: 'cv', paramTarget: 'level4', cvScale: { mode: 'linear' } },
    { id: 'level5_cv', type: 'cv', paramTarget: 'level5', cvScale: { mode: 'linear' } },
    { id: 'level6_cv', type: 'cv', paramTarget: 'level6', cvScale: { mode: 'linear' } },
    { id: 'level7_cv', type: 'cv', paramTarget: 'level7', cvScale: { mode: 'linear' } },
    { id: 'level8_cv', type: 'cv', paramTarget: 'level8', cvScale: { mode: 'linear' } },
    // 8 ping gates — rising-edge triggered per band.
    { id: 'ping1', type: 'gate' },
    { id: 'ping2', type: 'gate' },
    { id: 'ping3', type: 'gate' },
    { id: 'ping4', type: 'gate' },
    { id: 'ping5', type: 'gate' },
    { id: 'ping6', type: 'gate' },
    { id: 'ping7', type: 'gate' },
    { id: 'ping8', type: 'gate' },
    // viznoise CV: speed of the acidwarp hue cycle.
    { id: 'viznoise_cv', type: 'cv', paramTarget: 'viznoise', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out_l',   type: 'audio' },
    { id: 'out_r',   type: 'audio' },
    { id: 'viz_out', type: 'mono-video' },
  ],
  params: [
    { id: 'level1',    label: 'B1',   defaultValue: 1.0, min: 0,   max: 2,   curve: 'linear' },
    { id: 'level2',    label: 'B2',   defaultValue: 1.0, min: 0,   max: 2,   curve: 'linear' },
    { id: 'level3',    label: 'B3',   defaultValue: 1.0, min: 0,   max: 2,   curve: 'linear' },
    { id: 'level4',    label: 'B4',   defaultValue: 1.0, min: 0,   max: 2,   curve: 'linear' },
    { id: 'level5',    label: 'B5',   defaultValue: 1.0, min: 0,   max: 2,   curve: 'linear' },
    { id: 'level6',    label: 'B6',   defaultValue: 1.0, min: 0,   max: 2,   curve: 'linear' },
    { id: 'level7',    label: 'B7',   defaultValue: 1.0, min: 0,   max: 2,   curve: 'linear' },
    { id: 'level8',    label: 'B8',   defaultValue: 1.0, min: 0,   max: 2,   curve: 'linear' },
    { id: 'master',    label: 'Mas',  defaultValue: 1.0, min: 0,   max: 2,   curve: 'linear' },
    { id: 'viznoise',  label: 'Hue',  defaultValue: 0.3, min: 0,   max: 1,   curve: 'linear' },
    { id: 'ping_decay',label: 'Dcy',  defaultValue: 0.5, min: 0,   max: 1,   curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // Worklet has 3 inputs:
    //   0 — in_l (mono)
    //   1 — in_r (mono)
    //   2 — pings (8 channels, one per band)
    // and 2 outputs: out_l, out_r.
    const workletNode = new AudioWorkletNode(ctx, 'warrenspectrum', {
      numberOfInputs: 3,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });

    // Ping merger: collects the 8 ping inputs into a single 8-channel
    // bus that feeds worklet input #2.
    const pingMerger = ctx.createChannelMerger(NUM_BANDS);
    pingMerger.connect(workletNode, 0, 2);

    // Per-ping silence sources so each channel is always active (mirrors
    // the mixmstrs / filter pattern — without this, channels with no
    // edge would idle at 0 but the channel itself wouldn't be allocated).
    const silenceSources: ConstantSourceNode[] = [];
    for (let i = 0; i < NUM_BANDS; i++) {
      const sil = ctx.createConstantSource();
      sil.offset.value = 0;
      sil.start();
      sil.connect(pingMerger, 0, i);
      silenceSources.push(sil);
    }

    // Per-ping fan-in gain nodes. Each ping_n input goes to a dedicated
    // GainNode (1×) which connects to pingMerger channel n. This gives
    // each ping input a stable AudioNode pin for the engine to hand
    // back in the inputs map.
    const pingGains: GainNode[] = [];
    for (let i = 0; i < NUM_BANDS; i++) {
      const g = ctx.createGain();
      g.gain.value = 1;
      g.connect(pingMerger, 0, i);
      pingGains.push(g);
    }

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    // Worklet param names: level1..level8, master, pingDecay. Card param
    // ids map level*/master 1:1; viznoise + ping_decay are handle-local
    // (viznoise affects only display; ping_decay is mapped to the
    // worklet's pingDecay param by setParam).
    for (let i = 1; i <= NUM_BANDS; i++) {
      const k = `level${i}`;
      const v = (node.params ?? {})[k] ?? 1.0;
      params.get(k)?.setValueAtTime(v, ctx.currentTime);
    }
    {
      const v = (node.params ?? {}).master ?? 1.0;
      params.get('master')?.setValueAtTime(v, ctx.currentTime);
    }

    // viznoise + ping_decay live as a handle-local cache. ping_decay is
    // mirrored into the worklet's pingDecay AudioParam below.
    const vizParams: Record<string, number> = {
      viznoise:   (node.params ?? {}).viznoise   ?? 0.3,
      ping_decay: (node.params ?? {}).ping_decay ?? 0.5,
    };

    params.get('pingDecay')?.setValueAtTime(vizParams.ping_decay, ctx.currentTime);

    // ---- Visualization snapshot pipe ----
    // The worklet posts { wave, flash } at ~30Hz. We cache the latest
    // snapshot here so both the on-card draw effect AND the cross-domain
    // drawFrame can read it without re-posting.
    let latestWave: Float32Array = new Float32Array(256);
    const latestFlash = new Float32Array(NUM_BANDS);
    let frameCounter = 0;
    workletNode.port.onmessage = (e: MessageEvent) => {
      const m = e.data as WarrenspectrumSnapshotMessage | undefined;
      if (!m || m.type !== 'snapshot') return;
      // Copy into a fresh ArrayBuffer-backed Float32Array so the type
      // matches our `let` (TS distinguishes <ArrayBuffer> from
      // <ArrayBufferLike> after the lib.dom 2025 update).
      latestWave = new Float32Array(m.wave);
      // Worklet sends absolute flash values; we max(local, sent) so the
      // local-decay per frame doesn't fight the worklet's snapshot.
      for (let i = 0; i < NUM_BANDS; i++) {
        latestFlash[i] = Math.max(latestFlash[i]!, m.flash[i]!);
      }
    };

    function getLevels(): number[] {
      const out: number[] = [];
      for (let i = 1; i <= NUM_BANDS; i++) {
        const p = params.get(`level${i}`);
        out.push(p?.value ?? 1);
      }
      return out;
    }

    function readSnapshot(): WarrenspectrumSnapshot {
      // Frame counter drives hue cycle; viznoise speed maps to
      // (1 + viznoise*8) frames/hue-degree. Saved as a derived field so
      // the renderer is dumb about counter math.
      frameCounter = (frameCounter + 1) >>> 0;
      // Decay flash per draw call (matches the spec's 0.92/frame).
      for (let i = 0; i < NUM_BANDS; i++) {
        latestFlash[i] = latestFlash[i]! * 0.92;
        if (latestFlash[i]! < 1e-3) latestFlash[i] = 0;
      }
      return {
        wave: latestWave,
        flash: Array.from(latestFlash),
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

    // ---- Output bus + analyser (legacy field for getVideoSource) ----
    const outBus = ctx.createGain();
    outBus.gain.value = 1;
    workletNode.connect(outBus, 0);
    workletNode.connect(outBus, 1);
    const vizAnalyser = ctx.createAnalyser();
    vizAnalyser.fftSize = 2048;
    outBus.connect(vizAnalyser); // sink — analyser doesn't connect onward.

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
    // viznoise_cv: use the worklet's outputBus.gain as a sink AudioParam so
    // the engine's per-param tap analyser still picks up modulation for
    // motorized-fader feedback. setParam(viznoise) does the actual update.
    inputs.set('viznoise_cv', { node: outBus, input: 0, param: outBus.gain });

    return {
      domain: 'audio',
      inputs,
      outputs: new Map([
        ['out_l', { node: workletNode, output: 0 }],
        ['out_r', { node: workletNode, output: 1 }],
      ]),
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
          // Mirror into the worklet's pingDecay AudioParam.
          params.get('pingDecay')?.setValueAtTime(value, ctx.currentTime);
          return;
        }
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        if (paramId === 'viznoise') return vizParams.viznoise;
        if (paramId === 'ping_decay') return vizParams.ping_decay;
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
          try { s.stop(); } catch { /* already stopped */ }
          s.disconnect();
        }
        for (const g of pingGains) g.disconnect();
        pingMerger.disconnect();
        outBus.disconnect();
        vizAnalyser.disconnect();
        workletNode.disconnect();
      },
    };
  },
};
