// packages/web/src/lib/audio/modules/moog902.ts
//
// MOOG 902 — Voltage Controlled Amplifier (slice 3 of the Moog System
// 55 / 35 clone initiative, .myrobots/MOOG/). The classic Moog differential
// VCA: a manual GAIN pot, summing CONTROL INPUTS, a SIGNAL input, and TWO
// complementary outputs (the differential pair — the normal output + its
// phase-inverted twin), with a LINEAR / EXPONENTIAL response switch.
//
// The 902 appears in BOTH systems (S35×3, S55×5) → shared → categorized
// under Clones → moogafakkin (the shared bucket, mirroring the 921 VCO + 904A VCF).
//
// GAIN LAW: gain is driven by a control sum in volts —
//   control = gainKnob(0..6 V) + fcv (fixed-control-voltage bias) +
//             cvAmount * cv (summing CONTROL INPUT).
// Overall gain is ×2 (+6 dB) at pot=max (6 V) OR at CV=6 V, and tops out at
// the ×3 ceiling near a control sum of ~7.5 V. LINEAR mode rises linearly
// (6 V → ×2); EXPONENTIAL mode passes through the same ×2 at 6 V then climbs
// faster, hitting ×3 near ~7.5 V. (Full law in packages/dsp/src/moog902.ts.)
//
// DSP: own-code amplifier gain law forked from the repo's own existing `vca`
// (packages/dsp/src/vca.dsp), re-implemented as a TS worklet with the added
// EXPONENTIAL branch + the Moog ×2-at-6V / ×3-ceiling scaling. NOT a port of
// any Moog schematic or copyleft source (.myrobots/MOOG/LICENSING.md:
// permissive / own-code only).
//
// Inputs:
//   audio (audio): the SIGNAL input — the audio to be amplified.
//   cv (cv, paramTarget=gain): summing CONTROL INPUT → gain, audio-rate,
//     scaled by cvAmount + summed onto the control sum per-sample in the
//     worklet (PASSTHROUGH — the worklet owns the gain-law map + clamp).
//   fcv (cv, paramTarget=gain): a second summing CONTROL INPUT — the
//     fixed-control-voltage bias added straight onto the control sum
//     (audio-rate, PASSTHROUGH).
//
// Outputs:
//   audio (audio): the amplified signal.
//   audio_inv (audio): the phase-inverted twin (differential − output).
//
// Params:
//   gain (linear 0..1, default 0.5): the GAIN pot, mapped to 0..6 V of the
//     control sum (the spec's "fixed control voltage" pot; ×2 at max).
//   cvAmount (linear -1..1, default 1): depth/sign of the cv CONTROL INPUT.
//   mode (discrete 0..1, default 0): RESPONSE switch — 0 LINEAR / 1 EXPONENTIAL.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/moog902.js?url';

// Per-context cache so addModule isn't called twice on the same context.
const loadedContexts = new WeakSet<BaseAudioContext>();

export const moog902Def: AudioModuleDef = {
  type: 'moog902',
  palette: { top: 'Clones', sub: 'moogafakkin' },
  card: 'Moog902VcaCard',
  domain: 'audio',
  label: 'moogafakkin 902 VCA',
  category: 'utilities',
  schemaVersion: 1,

  inputs: [
    { id: 'audio', type: 'audio' },
    // cv + fcv are audio-rate summing CONTROL INPUTS (the worklet sums knob +
    // cv*cvAmount + fcv per-sample, then applies the gain-law map + clamp), so
    // they don't go through the CV→AudioParam fast path. paramTarget keeps
    // docs labelling correct; no cvScale (PASSTHROUGH_BY_DESIGN, like the
    // 921's width_cv + the 904A's cutoff_cv/reso_cv).
    { id: 'cv', type: 'cv', paramTarget: 'gain' },
    { id: 'fcv', type: 'cv', paramTarget: 'gain' },
  ],
  outputs: [
    { id: 'audio', type: 'audio' },
    // The differential − output: a phase-inverted twin of `audio`, computed
    // sample-accurately in the worklet (NOT a separate GainNode tap).
    { id: 'audio_inv', type: 'audio' },
  ],
  params: [
    { id: 'gain',     label: 'Gain', defaultValue: 0.5, min: 0,  max: 1, curve: 'linear' },
    { id: 'cvAmount', label: 'CV',   defaultValue: 1,   min: -1, max: 1, curve: 'linear' },
    { id: 'mode',     label: 'Mode', defaultValue: 0,   min: 0,  max: 1, curve: 'discrete' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'moog902', {
      numberOfInputs: 3,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });

    // Feed silence into every input so the node stays in the active
    // processing graph even when nothing's externally patched (mirrors the
    // 921 VCO + 904A VCF + analogVco silence-keepalive pattern).
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(workletNode, 0, 0);
    silence.connect(workletNode, 0, 1);
    silence.connect(workletNode, 0, 2);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of moog902Def.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['audio', { node: workletNode, input: 0 }],
        ['cv', { node: workletNode, input: 1 }],
        ['fcv', { node: workletNode, input: 2 }],
      ]),
      outputs: new Map([
        ['audio', { node: workletNode, output: 0 }],
        ['audio_inv', { node: workletNode, output: 1 }],
      ]),
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
