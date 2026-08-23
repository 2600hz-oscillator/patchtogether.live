// packages/web/src/lib/audio/modules/moog-cp3.ts
//
// MOOG CP3 / CP3A CONSOLE PANEL (mixer) — a slice of the Moog System 55 / 35
// clone initiative (.myrobots/MOOG/). The CP3 is the console's multi-function
// mixer: a 4×1 summing mixer that also presents a (−) inverted output, an
// attenuated 4th external input, a 1→3 MULTIPLE, and ±reference trunk jacks.
// Shared by SYS55 + SYS35 (categorized under Ports → moogafakkin per the plan's
// resolved Q4).
//
// DSP: own-code (packages/dsp/src/moog-cp3.ts + lib/moog-cp3-dsp.ts) — a
// forked + expanded version of the repo's `mixer`, permissive, not a port of
// any Moog schematic or copyleft source.
//
// Inputs (the mixer accepts audio AND cv — the per-sample sum is DC- and
// polarity-transparent, so it mixes AC and/or DC voltages):
//   in1..in3 (audio): mixer channels 1–3.
//   in4 (audio): mixer channel 4 (panel jack).
//   ext4 (cv): the 4th input's EXTERNAL jack. Summed with in4, then scaled
//     by the 4th-input ATTENUATOR (at "10"/1.0 = unity, direct patch passes
//     unaltered). PASSTHROUGH: it's the signal being attenuated, summed at
//     audio-rate in the worklet — not a knob modulator, so no cvScale.
//
// Outputs:
//   out_positive (audio): the (+) summed bus.
//   out_negative (audio): the (−) phase-inverted summed bus.
//   multiple_one / multiple_two / multiple_three (audio): the MULTIPLE —
//     in1 fanned out unaltered to three passthrough outs (1 → 3).
//   plus_twelve (cv): constant +12 V trunk reference (normalized).
//   minus_six (cv): constant −6 V trunk reference (normalized).
//
// Params:
//   ch1..ch4 (linear 0..1, default 1): per-channel level (0..×2 gain;
//     0.5 = unity, 1.0 = ×2). 25K-LIN feel, shown 0..10 on the faceplate.
//   attenuator4 (linear 0..1, default 1): 4th-input attenuator; 1.0 = unity.
//
// Deferred (v1): the trunk/routing-switch MATRIX (the CP3A's switchable
// trunk routing) is omitted — v1 focuses on the mixer + (−) output + the
// attenuated 4th + the 1→3 multiple + the ±ref outs. The reference jacks
// are modeled as constant sources; the switch matrix can land as a
// follow-up (noted in the PR).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/moog-cp3.js?url';

import { createWorkletNode } from '$lib/audio/worklet-guard';
// Per-context cache so addModule isn't called twice on the same context.
const loadedContexts = new WeakSet<BaseAudioContext>();

export const moogCp3Def: AudioModuleDef = {
  type: 'moogCp3',
  palette: { top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' },
  card: 'MoogCp3MixerCard',
  domain: 'audio',
  label: 'cp3 mixer',
  category: 'utilities',

  inputs: [
    { id: 'in1',  type: 'audio' },
    { id: 'in2',  type: 'audio' },
    { id: 'in3',  type: 'audio' },
    { id: 'in4',  type: 'audio' },
    // ext4 is the 4th-input external jack — an audio-rate signal summed with
    // in4 then attenuated. It's the SIGNAL being mixed (cv-or-audio), not a
    // knob modulator, so no cvScale (PASSTHROUGH_BY_DESIGN — see
    // cv-scale-registry.test.ts, same shape as slewSwitch.in1).
    { id: 'ext4', type: 'cv' },
  ],
  outputs: [
    { id: 'out_positive',   type: 'audio' },
    { id: 'out_negative',   type: 'audio' },
    { id: 'multiple_one',   type: 'audio' },
    { id: 'multiple_two',   type: 'audio' },
    { id: 'multiple_three', type: 'audio' },
    { id: 'plus_twelve',    type: 'cv' },
    { id: 'minus_six',      type: 'cv' },
  ],
  params: [
    { id: 'ch1',         label: 'Ch1',   defaultValue: 1, min: 0, max: 1, curve: 'linear' },
    { id: 'ch2',         label: 'Ch2',   defaultValue: 1, min: 0, max: 1, curve: 'linear' },
    { id: 'ch3',         label: 'Ch3',   defaultValue: 1, min: 0, max: 1, curve: 'linear' },
    { id: 'ch4',         label: 'Ch4',   defaultValue: 1, min: 0, max: 1, curve: 'linear' },
    { id: 'attenuator4', label: 'Att 4', defaultValue: 1, min: 0, max: 1, curve: 'linear' },
  ],

  // ── THE FACEPLATE (PF-20) ────────────────────────────────────────────────
  //
  // WHAT THE CP3 IS FOR. It is the console: four things in, one bus out, plus
  // the same bus inverted, plus a splitter, plus two fixed reference voltages.
  // The verb is BALANCING. What it does that `attenumix` does not: it can
  // BOOST — its knobs are gain, not attenuation — and it publishes the inverted
  // bus at the same time.
  //
  // ⚠ THE MERIT IS THE READOUT, NOT THE RANKING, and this comment says so
  // plainly rather than dressing a channel-numbered mixer's channel order up as
  // a redesign. `order` IS declaration order. Channel identity is the only
  // ordering a mixer has, and inventing another would make the face disagree
  // with the panel for no gain. The one thing worth adding is that CH 1 is rank
  // 1 on merit and not merely on being first: IN 1 is ALSO the MULTIPLE source
  // — measured, `multiple_one/two/three` are bit-identical to each other and to
  // `in1` (max abs diff 0.000000000000) — so channel 1 is the only channel with
  // a second job.
  //
  // THE NUMBER THE FACE EXISTS TO PRINT. Measured on the SHIPPING worklet with
  // a 1 kHz sine, Hann-windowed single-bin DFT past the 80 Hz knob smoother
  // (instrument controls first: a known 0.5 sine reads 0.500000 at its own bin
  // and 0.000000 at a wrong one, and a zero-crossing estimate agrees):
  //
  //   ch1 0.00 -> 0.00000      ch1 0.75 -> 1.50000  (+3.522 dB)
  //   ch1 0.25 -> 0.50000      ch1 1.00 -> 2.00000  (+6.021 dB)  <- the DEFAULT
  //   ch1 0.50 -> 1.00000  (UNITY — the dial's MIDPOINT)
  //
  // `cp3ChannelGain(k) = clamp(k,0,1)·2`, so UNITY IS AT THE MIDPOINT AND ALL
  // FIVE KNOBS SHIP AT MAX. Four correlated unity inputs at the shipped
  // defaults sum to a bus peak of 8.0000 — +18.062 dB over full scale, 10.0000
  // with EXT 4 also patched — and there is NO CLAMP OR SATURATOR anywhere in
  // the path (checked: peak > 1 is true). Nothing in the app said this.
  //
  // TIER LADDER AS A SENTENCE. `primaryAudioOutPortId` resolves to
  // `out_positive`, so the glyph BINDS as `{kind:'live-audio'}` on the (+) BUS
  // — and naming WHICH tap matters (#1692 / Q20). It is the right one: the
  // meter is the surface that shows the +18 dB while it is happening. Compact
  // cap is therefore LANE_ROW_MAX_CELLS_WITH_GLYPH = 2: at mini CH 1; at
  // compact CH 1 + CH 2 beside the live bus meter; at plate and dock all five.
  //
  // PAGES (2): `channels` = ch1..ch4 · `4th input` = attenuator4. The second
  // page is ONE control and earns its header on identity — the attenuated
  // external 4th is the CP3's distinguishing feature and the reason this module
  // is not just `attenumix`.
  //
  // ⚠ AND THE FACE IS DRAWN AGAINST TODAY'S CODE, WHICH SHIPS A REDUNDANT
  // CONTROL DIMENSION. `cp3Mix` applies `(in4+ext4)·atten4·g4`, so the bus sees
  // only the PRODUCT of CH 4 and ATT 4 — the two knobs are BIT-EXACTLY
  // INTERCHANGEABLE. Measured with different signals on the two jacks (300 Hz
  // on IN 4, 700 Hz on EXT 4), swapping the pair at (0.5,1), (0.25,0.8),
  // (0.2,0.9) and (0,1): bit-identical every time, max abs diff
  // 0.000000000000. NEGATIVE CONTROL on a genuinely non-interchangeable pair
  // (CH 1 vs CH 4): not bit-identical, max abs diff 2.106857. ⚠ This CORRECTS
  // the earlier reading that the two "look the same and are not" — they look
  // the same and ARE. #1884 proposes changing the equation so they are not; that
  // is AUDIBLE on any saved rack with IN 4 patched and ATT 4 off unity and it
  // moves `art/baselines/moog-cp3/out_positive.f32`, so it is deliberately NOT
  // in this PR. The page for ATT 4 is honest either way — it is the 4th input's
  // trim — and the redundancy is stated here rather than hidden.
  //
  // NO `bareCells`: under a `channels` heading `Ch1`..`Ch4` are the only thing
  // separating four identical linear knobs (the tidyVco A/D/S/R case).
  // NO SIDEBAR: it is the one contract-projected `face` field and everything a
  // sidebar would say here is one number.
  face: {
    order: ['ch1', 'ch2', 'ch3', 'ch4', 'attenuator4'],

    pages: [
      {
        id: 'channels',
        label: 'channels',
        hint: 'four gains into one bus — unity is the MIDPOINT, and they ship at max',
        controls: ['ch1', 'ch2', 'ch3', 'ch4'],
      },
      {
        id: 'fourth',
        label: '4th input',
        hint: 'trims IN 4 + EXT 4 before the channel gain',
        controls: ['attenuator4'],
      },
    ],

    // The live (+) BUS. Named rather than assumed: `primaryAudioOutPortId`
    // takes the first `audio` output, which is `out_positive` — the tap that
    // carries the mix. Silent at spawn (nothing patched → the bus is
    // bit-exactly zero), which is the mixer/reverb determinism case the VRT
    // roster already names, NOT the analogVco free-running one: it needs no
    // mask and no freeze argument.
    glyph: 'meter',


    // ⚠ THE REAR CARD IS AUTHORED HERE BECAUSE THE DERIVED DEFAULT WOULD SPLIT
    // BY CABLE DOMAIN, and the domains are not what a player needs to know.
    // Measured bit-exactly: sweeping EVERY one of the five knobs 1.0 → 0.0
    // leaves `multiple_one`, `multiple_two`, `multiple_three`, `plus_twelve`
    // and `minus_six` BIT-IDENTICAL. So of seven jacks, TWO carry the mix,
    // THREE are one passthrough of IN 1 copied three times, and TWO are
    // constants (+2.400000 and −1.200000, ratio exactly −2 — i.e. 240 % and
    // 120 % of the rack's own ±1 full-scale CV convention, on no dial). A rail
    // grouped by domain would put the bus and the splitter in one section and
    // send someone hunting for the knob that changes a multiple. These three
    // groups say which jacks the panel controls and which it does not.
    rear: {
      groups: [
        { id: 'bus', label: 'bus', direction: 'output', ports: ['out_positive', 'out_negative'] },
        { id: 'multiple', label: 'multiple (in 1)', direction: 'output', ports: ['multiple_one', 'multiple_two', 'multiple_three'] },
        { id: 'reference', label: 'reference', direction: 'output', ports: ['plus_twelve', 'minus_six'] },
      ],
    },
  },

  docs: {
    explanation:
      "A clean-room recreation of the Moog CP3 / CP3A Console Panel mixer — the System's multi-function summing mixer. Four channels (IN 1–4) each have their own level fader and are summed to a (+) OUTPUT; a (−) OUTPUT carries the same mix phase-inverted (for difference/cancellation patches or feeding a second chain out of phase). The 4th channel adds an EXTERNAL jack (EXT 4) that's summed with IN 4 then trimmed by its own attenuator. The panel also provides a 1→3 MULTIPLE (IN 1 fanned, unaltered, to three jacks for splitting a signal) and two constant trunk reference voltages (+12 V and −6 V, normalized) for offsetting CVs. It mixes audio AND CV transparently (the sum is DC- and polarity-correct). Mental model: a four-into-one mixer with a built-in inverter, a signal splitter, and a couple of fixed-voltage 'rails' on the side.",
    inputs: {
      in1: "Mixer channel 1 input — scaled by the CH1 fader and summed into both the (+) and (−) outputs. (This is also the signal fed to the 1→3 MULTIPLE.)",
      in2: "Mixer channel 2 input — scaled by CH2 and summed into the output buses.",
      in3: "Mixer channel 3 input — scaled by CH3 and summed into the output buses.",
      in4: "Mixer channel 4 (panel jack) — summed with the EXT 4 jack, trimmed by ATT 4, then scaled by CH4 into the output buses.",
      ext4:
        "The 4th channel's EXTERNAL input jack — summed with IN 4 and scaled by the ATT 4 attenuator (at unity it passes a direct patch unaltered). Accepts audio or CV; it's the signal being attenuated, not a knob modulator.",
    },
    outputs: {
      out_positive: "The (+) summed mix bus: CH1·in1 + CH2·in2 + CH3·in3 + CH4·(in4 + ext4·ATT4). The main mixer output.",
      out_negative: "The (−) output: the same mix, phase-inverted. Use it for cancellation/difference patches or to feed a parallel chain out of phase.",
      multiple_one: "MULTIPLE tap 1 — IN 1 passed through unaltered (the 1→3 signal splitter, independent of the CH1 fader).",
      multiple_two: "MULTIPLE tap 2 — a second unaltered copy of IN 1.",
      multiple_three: "MULTIPLE tap 3 — a third unaltered copy of IN 1.",
      plus_twelve: "A constant +12 V reference trunk (normalized): a fixed positive CV for offsetting/biasing other control voltages.",
      minus_six: "A constant −6 V reference trunk (normalized): a fixed negative CV offset.",
    },
    controls: {
      ch1: "Channel 1 level (0..×2 gain; ~0.5 is unity, 1.0 is ×2), shown 0–10 on the faceplate — how much of IN 1 reaches the output buses.",
      ch2: "Channel 2 level (0..×2; ~0.5 unity, 1.0 ×2).",
      ch3: "Channel 3 level (0..×2; ~0.5 unity, 1.0 ×2).",
      ch4: "Channel 4 level (0..×2; ~0.5 unity, 1.0 ×2) — applied to the summed IN 4 + EXT 4 signal.",
      attenuator4: "The 4th input's EXTERNAL attenuator: trims the EXT 4 jack before it joins IN 4 (1.0 = unity, a direct patch passes unaltered).",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = createWorkletNode(node, ctx, 'moog-cp3', {
      numberOfInputs: 5,
      numberOfOutputs: 7,
      outputChannelCount: [1, 1, 1, 1, 1, 1, 1],
    });

    // Feed silence into every input so the node stays in the active
    // processing graph even when nothing's externally patched (mirrors the
    // 921 VCO + analogVco silence-keepalive pattern).
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    for (let i = 0; i < 5; i++) silence.connect(workletNode, 0, i);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of moogCp3Def.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['in1',  { node: workletNode, input: 0 }],
        ['in2',  { node: workletNode, input: 1 }],
        ['in3',  { node: workletNode, input: 2 }],
        ['in4',  { node: workletNode, input: 3 }],
        ['ext4', { node: workletNode, input: 4 }],
      ]),
      outputs: new Map([
        ['out_positive',   { node: workletNode, output: 0 }],
        ['out_negative',   { node: workletNode, output: 1 }],
        ['multiple_one',   { node: workletNode, output: 2 }],
        ['multiple_two',   { node: workletNode, output: 3 }],
        ['multiple_three', { node: workletNode, output: 4 }],
        ['plus_twelve',    { node: workletNode, output: 5 }],
        ['minus_six',      { node: workletNode, output: 6 }],
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
