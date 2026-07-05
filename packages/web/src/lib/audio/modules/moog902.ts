// packages/web/src/lib/audio/modules/moog902.ts
//
// MOOG 902 — Voltage Controlled Amplifier (slice 3 of the Moog System
// 55 / 35 clone initiative, .myrobots/MOOG/). The classic Moog differential
// VCA: a manual GAIN pot, summing CONTROL INPUTS, a SIGNAL input, and TWO
// complementary outputs (the differential pair — the normal output + its
// phase-inverted twin), with a LINEAR / EXPONENTIAL response switch.
//
// The 902 appears in BOTH systems (S35×3, S55×5) → shared → categorized
// under Ports → moogafakkin (the shared bucket, mirroring the 921 VCO + 904A VCF).
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
  palette: { top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' },
  card: 'Moog902VcaCard',
  domain: 'audio',
  label: '902 vca',
  category: 'utilities',

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

  docs: {
    explanation:
      "A clean-room recreation of the Moog 902 Voltage Controlled Amplifier — the System 35/55 VCA that turns a control voltage into level. The signal you feed in is amplified by a gain that is the SUM, in volts, of the manual GAIN pot plus the two summing CONTROL INPUTS (CV scaled by the CV-depth knob, and FCV added straight). Overall gain reaches ×2 (+6 dB) when that control sum hits 6 V and tops out at a ×3 ceiling around 7.5 V. A RESPONSE switch picks the gain law: LINEAR rises straight to ×2 at 6 V, EXPONENTIAL passes through the same ×2 at 6 V but climbs faster toward the ceiling. Like the hardware it has a true differential output pair — the normal output and its phase-inverted twin. Patch an envelope or LFO into CV to shape dynamics or tremolo; leave everything unpatched and the GAIN pot is a static volume.",
    inputs: {
      audio: "The SIGNAL input — the audio to be amplified by the VCA.",
      cv: "Summing CONTROL INPUT to gain (audio-rate). It is scaled by the CV-depth knob and added, in volts, to the control sum the worklet maps through the gain law, so an envelope here makes the VCA an amplitude shaper and an LFO makes tremolo. Bipolar CV with a negative CV-depth can duck the signal.",
      fcv: "A second summing CONTROL INPUT to gain — a fixed-control-voltage bias added straight onto the control sum (no depth knob). Use it to offset the operating point, or to sum a second modulation source alongside CV.",
    },
    outputs: {
      audio: "The amplified signal — the input scaled by the gain the control sum produces.",
      audio_inv: "The differential − output: a sample-accurate phase-inverted twin of the main output (the same level, 180° out of phase). Handy for difference patches or driving a balanced pair.",
    },
    controls: {
      gain: "The manual GAIN pot (the spec's fixed control voltage), mapped across 0..6 V of the control sum — at the top it alone gives ×2 (+6 dB). Its volts add to whatever CV/FCV contribute. Defaults to 0.5 (mid).",
      cvAmount: "Depth and SIGN of the CV control input: it scales how much the CV jack moves the gain. Full right (+1) is full positive depth, center is none, full left (−1) inverts the CV so a rising envelope ducks instead of opening. Defaults to +1.",
      mode: "RESPONSE switch — the gain law. LINEAR rises straight to ×2 at a 6 V control sum; EXPONENTIAL passes through that same ×2 at 6 V then climbs faster toward the ×3 ceiling (~7.5 V), the more musical curve for envelope-shaped amplitude. Defaults to LINEAR.",
    },
  },

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
