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
// Overall gain is ×2 (+6 dB) at pot=max (6 V) OR at CV=6 V, and tops out at a
// ×3 ceiling whose VOLTAGE DEPENDS ON THE MODE. LINEAR mode rises linearly
// (6 V → ×2) and reaches ×3 at 9 V; EXPONENTIAL passes through the same ×2 at
// 6 V then climbs faster, reaching ×3 at 7.5 V.
// (Full law in packages/dsp/src/moog902.ts.)
//
// ⚠ THIS COMMENT USED TO SAY "~7.5 V" FOR BOTH MODES (#1912). Bisected against
// the shipping worklet the ceiling is 9.000000 V in LINEAR — the SHIPPED
// DEFAULT mode — and 7.499999 V in EXPONENTIAL; at 7.5 V LINEAR delivers only
// ×2.500000. The old figure was the EXPONENTIAL arm's anchor, stated
// unconditionally, so it was wrong by 1.5 V for the mode a bare 902 spawns in.
// The faceplate now PRINTS the mode's real ceiling (`moog902-ceiling`).
//
// DSP: own-code amplifier gain law forked from the repo's own existing `vca`
// (packages/dsp/src/vca.dsp), re-implemented as a TS worklet with the added
// EXPONENTIAL branch + the Moog ×2-at-6V / ×3-ceiling scaling. NOT a port of
// any Moog schematic or copyleft source (// permissive / own-code only).
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
import type { ParamOption } from '$lib/graph/types';
import workletUrl from '@patchtogether.live/dsp/dist/moog902.js?url';

import { createWorkletNode } from '$lib/audio/worklet-guard';
// Per-context cache so addModule isn't called twice on the same context.
const loadedContexts = new WeakSet<BaseAudioContext>();

/**
 * The RESPONSE switch's two positions.
 *
 * ⚠ THESE TWO STRINGS USED TO EXIST NOWHERE BUT THE LEGACY CARD.
 * `Moog902VcaCard.svelte` built its `role="radiogroup"` from a local
 * `MODE_POS` array, so `LIN` and `EXP` were card-only literals and the def
 * knew the param only as a bare 0..1 discrete. Promoting the module to a
 * def-driven faceplate would have deleted the only names the mode has, which
 * is the STOP 2 loss the faceplate skill exists to catch. Declared here they
 * survive the card, and the segmented cell the dock renders is built from the
 * contract instead of from a duplicate list.
 *
 * `title` carries the LEVEL consequence, because the names do not: the two
 * laws agree only at 0 V and at the 6 V anchor, and everywhere between them
 * this switch moves the output level (−2.9841 dB at the shipped default) while
 * the GAIN dial does not move. `options` is cosmetic in the contract
 * projection, so declaring it costs no `contract-lock` line.
 */
export const MOOG902_MODE_OPTIONS: readonly ParamOption[] = [
  { value: 0, label: 'LIN', title: 'linear — gain rises straight to ×2 at a 6 V control sum, and reaches the ×3 ceiling at 9 V' },
  { value: 1, label: 'EXP', title: 'exponential — through the same ×2 at 6 V, then steeper: the ×3 ceiling arrives at 7.5 V, and every setting below the anchor is quieter than LINEAR' },
];

export const moog902Def: AudioModuleDef = {
  type: 'moog902',
  palette: { top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' },
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
    { id: 'mode',     label: 'Resp', defaultValue: 0,   min: 0,  max: 1, curve: 'discrete', options: MOOG902_MODE_OPTIONS },
  ],

  // ── THE FACE ────────────────────────────────────────────────────────────────
  //
  // WHAT IT IS FOR, MUSICALLY: this is the rack's only DIFFERENTIAL VCA — level
  // as a VOLTAGE, with a phase-inverted twin on a second jack. The verb is
  // SHAPING LOUDNESS FROM A CONTROL VOLTAGE: an envelope into CV for dynamics,
  // an LFO for tremolo. What the plain `vca` does not do is land TWO summing
  // control jacks on ONE gain (`cv` scaled by a depth knob, `fcv` straight) and
  // sum them in VOLTS rather than in a 0..1 amount.
  //
  // ⚠ THE RANK ARGUMENT, AND THE MIDDLE ONE IS THE DEFENSIBLE PART. Measured on
  // the SHIPPING worklet at 48 kHz, 220 Hz sine at amplitude 0.5, read at steady
  // state with a CHANNEL-AWARE probe (the same probe fed one signal to all three
  // inputs first, and reported four confident wrong numbers — a multi-input
  // worklet driven with "the same signal everywhere" is a PATCHED module, not a
  // bare one):
  //
  //   gain      the whole level, 0 → ×3. Its shipped default is EXACTLY unity:
  //             bisected, LINEAR crosses ×1 at knob 0.499999985 (= 3.000000 V),
  //             and `gain = 0` is true silence (bit-exact zero 10375 samples =
  //             216.146 ms after spawn).
  //   mode      A LEVEL CONTROL WEARING A CHARACTER SWITCH'S CLOTHES. The two
  //             laws agree ONLY at the two anchors — 0 V and 6 V — so between
  //             them the switch moves the output and the dial does not:
  //
  //               knob 0.05 (0.30 V)   LIN −20.0000 dB   EXP −25.4525 dB   −5.4525
  //               knob 0.25 (1.50 V)   LIN  −6.0206 dB   EXP −10.4018 dB   −4.3812
  //               knob 0.50 (3.00 V)   LIN   0.0000 dB   EXP  −2.9841 dB   −2.9841
  //               knob 0.75 (4.50 V)   LIN  +3.5218 dB   EXP  +1.9986 dB   −1.5232
  //               knob 1.00 (6.00 V)   LIN  +6.0206 dB   EXP  +6.0206 dB    0.0000
  //
  //             Unity itself moves with it: knob 0.499999985 in LINEAR,
  //             0.641521305 in EXPONENTIAL. ⚠ THIS ARGUMENT WOULD BE WRONG FOR
  //             MOST MODE SWITCHES, which are level-matched by design — that is
  //             exactly why it is defended by the measurement and not by "a
  //             switch outranks a knob".
  //   cvAmount  BIT-EXACTLY INERT AT SPAWN. With `cv` unpatched, 41 of 41
  //             sampled positions across −1…1 render BIT-IDENTICALLY over 24064
  //             samples. Positive control: with `cv` held at 1 V the same knob
  //             moves the gain to ×0.666667 / ×1.000000 / ×1.166667 / ×1.333333
  //             at −1 / 0 / 0.5 / 1. Negative control ON THE INSTRUMENT: nudging
  //             `gain` 0.5 → 0.6 is correctly NOT bit-identical, so the probe
  //             can see a change when there is one.
  //
  // Tier ladder as a sentence: a glyph BINDS, so the compact cap is
  // LANE_ROW_MAX_CELLS_WITH_GLYPH = 2 — mini shows GAIN, compact adds RESP
  // beside the meter, and plate and dock add CV. Rank 3 is effectively
  // plate-and-up, which is right for the one control that does bit-exactly
  // nothing until a cable arrives.
  //
  // ⚠ `order` and `pages` DISAGREE DELIBERATELY. `order` is PRIORITY, so the
  // level-moving switch is second; `pages` is KIND, so the two continuous level
  // controls sit together and the law selector stands alone. The `response`
  // page is a one-control band and earns its header on the skill's "1 that is
  // the module's identity" clause — a 902 IS its LIN/EXP law.
  face: {
    order: ['gain', 'mode', 'cvAmount'],

    pages: [
      {
        id: 'gain',
        label: 'gain',
        hint: 'the manual pot in volts, and how hard the CV jack pushes it',
        controls: ['gain', 'cvAmount'],
      },
      {
        id: 'response',
        label: 'response',
        hint: 'the gain law — and it is a level control: the two laws agree only at 0 V and at the 6 V anchor',
        controls: ['mode'],
      },
    ],

    // ⚠ IT RESOLVES, AND THE RESOLVER NAMES THE TAP — SAY WHICH.
    // `primaryAudioOutPortId` takes the FIRST `type: 'audio'` output, and this
    // def declares `audio` before `audio_inv`, so `glyphBinding` returns
    // `{ kind: 'live-audio', portId: 'audio' }` — the trace is the MAIN output,
    // never the differential twin. Both `'meter'` and `'waveform'` resolve to
    // that same tap, so the choice between them is editorial and `'meter'` is
    // the honest pick: a VCA's entire job is level, and this module\'s sharpest
    // defect is a switch that moves level silently — which is precisely what a
    // meter shows and a waveform does not.
    //
    // ⚠ AND PICKING THE OTHER JACK WOULD HAVE COST NOTHING VISIBLE: `audio_inv`
    // is bit-exactly `−audio` (worst |a+b| = 0 across 24064 samples), so a
    // meter on the twin reads identically. The port is named here so that a
    // future output re-order is a REVIEWABLE change rather than a silent one.
    glyph: 'meter',

    // THE HERO: the level pot, plus the two numbers this module publishes that
    // none of its controls can print. Their reach is DISJOINT, which is what
    // makes each the other's permanent control:
    //
    //   gain     moves on BOTH the pot and the switch — it is what the
    //            amplifier is actually doing (0.0 dB at the defaults, −3.0 dB
    //            on a switch flip that leaves the dial where it was).
    //   ceiling  moves ONLY on the switch and is INVARIANT to the pot — the
    //            control-sum voltage where the amplifier stops rising, 9.0 V in
    //            LINEAR and 7.5 V in EXPONENTIAL.
    //
    // ⚠ NO HEADROOM READOUT, deliberately, and it was drafted before it was
    // dropped: headroom-in-dB is `20·log10(3) − gainDb`, an AFFINE FUNCTION of
    // the readout above it. It would move on every input the first one moves on,
    // by the same amount with the sign flipped — a live number that carries no
    // information the row does not already have. The VOLTS to the ceiling is a
    // different quantity, and it is the one the docs got wrong (#1912).
    hero: {
      control: 'gain',
    },
  },

  docs: {
    explanation:
      "A clean-room recreation of the Moog 902 Voltage Controlled Amplifier — the System 35/55 VCA that turns a control voltage into level. The signal you feed in is amplified by a gain that is the SUM, in volts, of the manual GAIN pot plus the two summing CONTROL INPUTS (CV scaled by the CV-depth knob, and FCV added straight). Overall gain reaches ×2 (+6 dB) when that control sum hits 6 V, and tops out at a ×3 ceiling whose voltage depends on which gain law is selected: 9 V in LINEAR, 7.5 V in EXPONENTIAL. A RESPONSE switch picks that law: LINEAR rises straight to ×2 at 6 V, EXPONENTIAL passes through the same ×2 at 6 V but climbs faster and hits the ceiling sooner. Be aware that the switch is also a LEVEL control — the two laws cross only at 0 V and at that 6 V anchor, so everywhere between them EXPONENTIAL is quieter for the same knob position (2.98 dB quieter at the factory setting, and up to 5.45 dB near the bottom of the pot). Like the hardware it has a true differential output pair — the normal output and a bit-exact phase-inverted twin. Patch an envelope or LFO into CV to shape dynamics or tremolo; leave everything unpatched and the GAIN pot is a static volume, sitting at exactly unity as shipped.",
    inputs: {
      audio: "The SIGNAL input — the audio to be amplified by the VCA.",
      cv: "Summing CONTROL INPUT to gain (audio-rate). It is scaled by the CV-depth knob and added, in volts, to the control sum the worklet maps through the gain law, so an envelope here makes the VCA an amplitude shaper and an LFO makes tremolo. Bipolar CV with a negative CV-depth can duck the signal.",
      fcv: "A second summing CONTROL INPUT to gain — a fixed-control-voltage bias added straight onto the control sum (no depth knob). Use it to offset the operating point, or to sum a second modulation source alongside CV.",
    },
    outputs: {
      audio: "The amplified signal — the input scaled by the gain the control sum produces.",
      audio_inv: "The differential − output: a phase-inverted twin of the main output (the same level, 180° out of phase). Handy for difference patches or driving a balanced pair. The inversion is BIT-EXACT, not merely sample-accurate — measured across 24064 samples of a rendered tone the worst |OUT + OUT−| is 0, so summing the two jacks cancels to digital silence rather than to a residue.",
    },
    controls: {
      gain: "The manual GAIN pot (the spec's fixed control voltage), mapped across 0..6 V of the control sum — at the top it alone gives ×2 (+6 dB). Its volts add to whatever CV/FCV contribute. Defaults to 0.5 (mid), which in the shipped LINEAR mode is 3 V and therefore EXACTLY unity gain: a bare 902 passes a patched signal at precisely the level it arrived. Fully closed is true silence, not merely a very small gain.",
      cvAmount: "Depth and SIGN of the CV control input: it scales how much the CV jack moves the gain. Full right (+1) is full positive depth, center is none, full left (−1) inverts the CV so a rising envelope ducks instead of opening. Defaults to +1. NOTE it does nothing at all until something is patched to the CV jack — with that jack empty, every position of this knob renders bit-identically, because it has nothing to scale.",
      mode: "RESPONSE switch — the gain law. LINEAR rises straight to ×2 at a 6 V control sum and reaches the ×3 ceiling at 9 V; EXPONENTIAL passes through that same ×2 at 6 V then climbs faster, reaching ×3 at 7.5 V, and is the more musical curve for envelope-shaped amplitude. ⚠ It is ALSO a level control, which the two names do not suggest: the laws coincide only at 0 V and at the 6 V anchor, so at every setting between them EXPONENTIAL is the quieter of the two — 2.98 dB down at the factory pot setting, 5.45 dB down near the bottom of the dial — with no dial movement at all. Unity gain moves with it too, from pot 0.500 in LINEAR to pot 0.642 in EXPONENTIAL. Defaults to LINEAR.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = createWorkletNode(node, ctx, 'moog902', {
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
