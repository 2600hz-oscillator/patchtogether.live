// packages/web/src/lib/audio/modules/moog904c.ts
//
// MOOG 904C — Voltage Controlled Filter Coupler (slice of the Moog System
// 55 / 35 clone initiative, .myrobots/MOOG/). The 904C couples a 904A-style
// transistor-ladder LOW-pass with a 904B-style HIGH-pass around one shared
// CUTOFF so the pair tracks together as a single voltage-controlled
// BAND-PASS (LP above the cutoff, HP below it). A MODE control crossfades
// that band-pass to its complement (a band-REJECT / notch).
//
// The 904C is the System-55 coupler → categorized under Moog → SYS55 (the
// shared bucket, mirroring the 904A LPF + 904B HPF).
//
// DSP: own-code, CLEAN-ROOM transistor-ladder core
// (packages/dsp/src/moog904c.ts + lib/moog-ladder-dsp.ts) — the SAME ladder
// the 904A (.lp4 tap) + 904B (hpDerive tap) consume. Series LP→HP = the
// band-pass; mode=1 subtracts the band from the input for the notch. NOT a
// port of the LGPLv3 Huovilainen code, the CC-BY-SA musicdsp model, or any
// Moog schematic (.myrobots/MOOG/LICENSING.md: permissive / own-code only).
//
// Inputs:
//   audio (audio): signal to be band-passed.
//   cutoff_cv (cv, paramTarget=cutoff, cvScale log): CV → cutoff. Wired into
//     the worklet's `cutoff` AudioParam by the factory (the same fast-path
//     resofilter uses for its cutoff_cv); cvScale:{mode:'log'} maps the
//     bipolar ±1 CV across the cutoff's full octave span.
//
// Outputs:
//   audio (audio): band-passed (or band-rejected at mode=1) output.
//
// Params:
//   cutoff (log 20..20000 Hz, default 800): band centre.
//   width  (linear 0..1, default 0.5): LP/HP spread around cutoff.
//   mode   (linear 0..1, default 0): 0 = band-pass, 1 = band-reject (notch).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/moog904c.js?url';

const PROCESSOR_NAME = 'moog904c';
// Per-context cache so addModule isn't called twice on the same context.
const loadedContexts = new WeakSet<BaseAudioContext>();

export const moog904cDef: AudioModuleDef = {
  type: 'moog904c',
  palette: { top: 'Moog', sub: 'SYS55' },
  card: 'Moog904cCard',
  domain: 'audio',
  label: '904C Voltage Controlled Filter Coupler',
  category: 'filters',
  schemaVersion: 1,

  inputs: [
    { id: 'audio', type: 'audio' },
    // cutoff_cv routes into the `cutoff` AudioParam (same wiring as
    // resofilter's cutoff_cv). cvScale:{mode:'log'} so the bipolar ±1 CV
    // sweeps the cutoff across its full octave span.
    { id: 'cutoff_cv', type: 'cv', paramTarget: 'cutoff', cvScale: { mode: 'log' } },
  ],
  outputs: [{ id: 'audio', type: 'audio' }],
  params: [
    { id: 'cutoff', label: 'Cutoff', defaultValue: 800, min: 20, max: 20000, curve: 'log', units: 'Hz' },
    { id: 'width', label: 'Width', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'mode', label: 'Mode', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    // Keep the node alive in the processing graph when nothing is patched in
    // (mirrors resofilter / the 904A keepalive).
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(workletNode, 0, 0);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of moog904cDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['audio', { node: workletNode, input: 0 }],
        // cutoff_cv sums into the `cutoff` AudioParam (resofilter's pattern).
        ['cutoff_cv', { node: workletNode, input: 0, param: params.get('cutoff')! }],
      ]),
      outputs: new Map([['audio', { node: workletNode, output: 0 }]]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try { silence.stop(); } catch { /* already stopped */ }
        try { silence.disconnect(); } catch { /* */ }
        try { workletNode.disconnect(); } catch { /* */ }
      },
    };
  },
};
