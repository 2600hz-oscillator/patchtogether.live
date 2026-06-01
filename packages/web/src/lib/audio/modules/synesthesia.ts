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
// The factory fans each 4-channel output through a ChannelSplitter into 4 mono
// GainNodes so every band/kind is an individually-patchable port.
//
// NOTE: per-band mono-video "rasterize" outputs (the audio→video bridge) are a
// follow-up slice — see .myrobots/SYNESTHESIA/PLAN.md.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/synesthesia.js?url';

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
  for (const b of BANDS) PARAM_DEFAULTS[`${c}_gain${b}`] = 1;
}

const loadedContexts = new WeakSet<BaseAudioContext>();

export interface SynesthesiaSnapshot {
  levelsA: number[];
  levelsB: number[];
}

export const synesthesiaDef: AudioModuleDef = {
  type: 'synesthesia',
  domain: 'audio',
  label: 'SYNESTHESIA',
  category: 'hybrid',
  schemaVersion: 1,

  inputs: [
    { id: 'a_in', type: 'audio' },
    { id: 'b_in', type: 'audio' },
  ],
  // 2 copies × 4 bands × {audio, env_slow, env_fast, gate} = 32 outputs.
  outputs: COPIES.flatMap((c) =>
    BANDS.flatMap((b) => [
      { id: `${c}_band${b}_audio`,    type: 'audio' as const },
      { id: `${c}_band${b}_env_slow`, type: 'cv' as const },
      { id: `${c}_band${b}_env_fast`, type: 'cv' as const },
      { id: `${c}_band${b}_gate`,     type: 'gate' as const },
    ]),
  ),
  params: [
    // Master gain: 0.5×@7:00 → 1.5×@5:00 (unity at 12:00) — raises/lowers floor.
    { id: 'a_master', label: 'A Mas', defaultValue: 1, min: 0.5, max: 1.5, curve: 'linear' },
    { id: 'b_master', label: 'B Mas', defaultValue: 1, min: 0.5, max: 1.5, curve: 'linear' },
    // Per-band gain: 1×@7:00 → 2×@5:00.
    ...COPIES.flatMap((c) =>
      BANDS.map((b) => ({
        id: `${c}_gain${b}`,
        label: `${c.toUpperCase()}${b}`,
        defaultValue: 1,
        min: 1,
        max: 2,
        curve: 'linear' as const,
      })),
    ),
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
    const outputs = new Map<string, { node: AudioNode; output: number }>();

    // Fan each 4-channel worklet output out into 4 mono GainNodes (one per band).
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
      dispose() {
        try { workletNode.port.onmessage = null; } catch { /* ignore */ }
        for (const g of outGains) g.disconnect();
        for (const s of splitters) s.disconnect();
        keepAlive.disconnect();
        workletNode.disconnect();
      },
    };
  },
};
