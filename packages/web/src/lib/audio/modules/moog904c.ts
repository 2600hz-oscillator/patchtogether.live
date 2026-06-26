// packages/web/src/lib/audio/modules/moog904c.ts
//
// MOOG 904C — Voltage Controlled Filter Coupler (slice of the Moog System
// 55 / 35 clone initiative, .myrobots/MOOG/). The 904C couples a 904A-style
// transistor-ladder LOW-pass with a 904B-style HIGH-pass around one shared
// CUTOFF so the pair tracks together as a single voltage-controlled
// BAND-PASS (LP above the cutoff, HP below it). A MODE control crossfades
// that band-pass to its complement (a band-REJECT / notch).
//
// The 904C is the System-55 coupler → categorized under Ports → moogafakkin (the
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
  palette: { top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' },
  card: 'Moog904cCard',
  domain: 'audio',
  label: '904c voltage controlled filter coupler',
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

  docs: {
    explanation:
      "A clean-room recreation of the Moog 904C Voltage Controlled Filter Coupler — a single module that couples a 904A-style low-pass and a 904B-style high-pass around ONE shared cutoff, so the pair tracks together as a voltage-controlled BAND-PASS: the low-pass keeps the lows under the corner, the high-pass keeps the highs over it, and you hear the band between them. WIDTH spreads the two corners apart (a wide, gentle band) or pulls them together (a narrow, vocal peak), and MODE crossfades the whole thing from band-PASS to its complement, a band-REJECT notch that scoops out the band instead. A single CV input sweeps the band centre. It is built on the same transistor-ladder core as the 904A and 904B, so the band has the Moog ladder's character.",
    inputs: {
      audio: "The signal to be band-passed (or band-rejected at MODE = 1).",
      cutoff_cv: "CV → the band CENTRE (cutoff). Wired through the worklet's cutoff AudioParam with a log scaling, so a bipolar ±1 CV sweeps the band across its full octave span — patch an envelope or LFO here to make the band-pass move (a wah, a vowel sweep).",
    },
    outputs: {
      audio: "The band-passed output (or, at MODE = 1, the band-rejected / notched output).",
    },
    controls: {
      cutoff: "The band CENTRE frequency, 20 Hz to 20 kHz on a log taper — where the low-pass and high-pass meet, i.e. the centre of the pass band (or the notch). CV adds on top of this. Defaults to 800 Hz.",
      width: "How far the low-pass and high-pass corners are spread around the centre. Low = the corners pull together for a narrow, resonant, vocal band; high = a wide, gentle band that passes more of the spectrum. Defaults to 0.5.",
      mode: "Crossfade from band-PASS (0) to band-REJECT / notch (1). At 0 you hear only the band; at 1 the band is subtracted from the input so it is scooped OUT; in between is a partial blend. Defaults to 0 (band-pass).",
    },
  },

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
