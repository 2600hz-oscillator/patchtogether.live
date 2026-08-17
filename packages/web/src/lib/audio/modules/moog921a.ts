// packages/web/src/lib/audio/modules/moog921a.ts
//
// MOOG 921A OSCILLATOR DRIVER — Moog System 55/35 clone (batch 1, shipped
// with the 921B oscillator). A CV PROCESSOR, not a sound source: it
// generates the two CONTROL VOLTAGES on a bus that drive N slaved 921B's.
// Shared by SYS55 + SYS35 → categorized under Ports → moogafakkin (the shared
// bucket, mirroring the 921 VCO + 904A).
//
// CV-ONLY: NO audio inputs, NO audio outputs. The two outputs (freq_bus,
// width_bus) are CV cables that feed a 921B's freq_bus / width_bus inputs.
//
// DSP: own-code pure CV math (packages/dsp/src/moog921a.ts) —
// exponential frequency mapping (the freq_bus CV encodes pitch in V/oct;
// the freqRange switch sets the FREQUENCY pot's compass) + width
// passthrough. Permissive, not a port of any Moog schematic / copyleft
// source.
//
// Inputs:
//   freq_cv (pitch, paramTarget=frequency): summing frequency CONTROL INPUT
//     — V/oct, audio-rate, summed onto the freq bus in the worklet
//     (PASSTHROUGH — the worklet sums knob + CV per-sample).
//   width_cv (cv, paramTarget=width): summing width CONTROL INPUT — audio-
//     rate, summed onto the width bus per-sample in the worklet
//     (PASSTHROUGH).
//
// Outputs:
//   freq_bus (cv): V/oct frequency control voltage → 921B.freq_bus.
//   width_bus (cv): 0..1 pulse-width control voltage → 921B.width_bus.
//
// Params:
//   frequency (linear -1..1, default 0): FREQUENCY pot (normalized; the
//     freqRange switch maps it onto V/oct).
//   freqRange (discrete 1..2, default 1): RANGE switch — 1 = SEMITONE
//     (2-oct compass) / 2 = OCTAVE (12-oct compass).
//   width (linear 0..1, default 0.5): pulse width passed onto width_bus.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import type { ParamOption } from '$lib/graph/types';
import workletUrl from '@patchtogether.live/dsp/dist/moog921a.js?url';

import { createWorkletNode } from '$lib/audio/worklet-guard';
// Per-context cache so addModule isn't called twice on the same context.
const loadedContexts = new WeakSet<BaseAudioContext>();

/**
 * The RANGE switch's two named states (PF-1).
 *
 * ⚠ THIS VOCABULARY EXISTED ONLY IN CARD MARKUP until the faceplate landed
 * (`Moog921aCard.svelte`'s private `RANGE_POS` array), so a def-driven surface
 * had no way to see it and rendered a rotary printing `1.00` over a two-state
 * switch. Declared here, the dock paints a `SEMI | OCT` Segmented and every
 * lane tier's dial earns a persistent readout naming the state
 * (`paramCellKind`, `shell-control-kind.ts`). Exported so `face.sidebar`'s two
 * comparison rows are LABELLED FROM THE ROSTER rather than re-typing the words
 * a third time.
 *
 * Cosmetic by construction: `contract-signature.ts` projects only
 * id/min/max/curve/defaultValue/units, so naming a value cannot move
 * `contract-lock.txt` — the value→meaning mapping is DSP and is already pinned
 * by `min`/`max`/`curve` (see `ParamOption`).
 */
export const MOOG921A_RANGE_OPTIONS: readonly ParamOption[] = [
  { value: 1, label: 'SEMI', title: 'the FREQUENCY pot spans ±1 octave (a 2-octave fine-tune compass)' },
  { value: 2, label: 'OCT', title: 'the FREQUENCY pot spans ±6 octaves (a 12-octave coarse compass)' },
];

export const moog921aDef: AudioModuleDef = {
  type: 'moog921a',
  palette: { top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' },
  domain: 'audio',
  label: '921a driver',
  category: 'modulation',

  inputs: [
    // freq_cv + width_cv are audio-rate summing CONTROL INPUTS (the worklet
    // sums knob + CV per-sample), so they don't go through the CV→AudioParam
    // fast path. paramTarget keeps docs labelling correct; no cvScale
    // (PASSTHROUGH_BY_DESIGN, like the 921 VCO's width_cv / the 904A's
    // cutoff_cv). freq_cv is a pitch cable (V/oct).
    { id: 'freq_cv',  type: 'pitch', paramTarget: 'frequency' },
    { id: 'width_cv', type: 'cv',    paramTarget: 'width' },
  ],
  outputs: [
    // CV bus outputs — NO audio. These feed N 921B oscillators.
    { id: 'freq_bus',  type: 'cv' },
    { id: 'width_bus', type: 'cv' },
  ],
  params: [
    { id: 'frequency', label: 'Freq',  defaultValue: 0,   min: -1, max: 1, curve: 'linear' },
    { id: 'freqRange', label: 'Range', defaultValue: 1,   min: 1,  max: 2, curve: 'discrete', options: MOOG921A_RANGE_OPTIONS },
    { id: 'width',     label: 'Width', defaultValue: 0.5, min: 0,  max: 1, curve: 'linear' },
  ],

  // THE FACE. Authored as ONE design with the 921B — see
  // `$lib/ui/modules/moog921-face-model` — because the two modules ARE one
  // instrument split across two defs, and the number that matters is a product
  // of both faces.
  //
  // ── THE RANK, AND ITS SECOND PLACE IS THE MEASURED ONE ─────────────────────
  //
  //   1 FREQ   the only continuous control on the module, and the only one that
  //            moves the pitch bus. Full travel is ±1200 cents at the shipped
  //            RANGE and ±7200 at the other.
  //   2 RANGE  ⚠ BIT-EXACTLY INERT AT SPAWN, which is why it is not the hero
  //            even though it carries 6× FREQ's authority. `frequency` defaults
  //            to 0 and the worklet computes `frequency × octSpan`
  //            (moog921a.ts:138), so 0 × 1 and 0 × 6 are the same 0 V: flipping
  //            RANGE on a freshly spawned module changes nothing at all. It is
  //            a SCALE for rank 1, and it ranks directly under what it scales.
  //   3 WIDTH  the SECOND, independent bus. It reaches only a slaved 921B's
  //            rectangular tap — sine, triangle and saw are untouched by it —
  //            and its declared MINIMUM lands on the MIDPOINT result (#1791).
  //
  // Tier ladder, read back as a sentence: mini = FREQ; compact = all three
  // (there is no glyph to take the third slot — see below); plate and dock =
  // the same three plus the hero and the two-row comparison.
  //
  // ── NO PAGES ───────────────────────────────────────────────────────────────
  // Three controls over two buses. A `pitch` band of one cell (RANGE, after the
  // hero takes FREQ) and a `width` band of one more would buy ~162 px of
  // headers on a dock that folds at 720p to say what two control labels already
  // say. The two buses are named by the READOUTS instead.
  face: {
    order: ['frequency', 'freqRange', 'width'],

    // ⚠ 'none', AND THE REASON IS THE POINT OF PAIRING THIS WITH THE 921B.
    // Both outputs are `type: 'cv'`, so `primaryAudioOutPortId` returns NULL and
    // EVERY glyph but 'none' would resolve to `{ kind: 'static' }` — the
    // live-looking readout of nothing that marbles shipped through three passes
    // (#1692). The 921B, whose four outputs are `audio`, correctly declares one.
    // Two halves of one instrument, two different right answers; authoring them
    // apart is how one of them would have been wrong. Asserted for BOTH modules,
    // with a negative control, in moog921-face-model.test.ts.
    glyph: 'none',

    // THE HERO: the one continuous dial, plus the three numbers this module
    // publishes that none of its knobs can print. Each is negative-controlled
    // PERMANENTLY on the input a knob readback is blind to
    // (moog921-face-model.test.ts):
    //
    //   bus   the volts on `freq_bus`: `frequency × octSpan`. The FREQ knob
    //         readback is EXACTLY INVARIANT to RANGE, which multiplies the
    //         answer by six — the same dial position is +0.5 V or +3.0 V.
    //   span  the whole compass the dial can reach in the current position:
    //         130.81…523.25 Hz (SEMI) against 4.09 Hz…16.74 kHz (OCT).
    //         Invariant to FREQ by construction (it reads the endpoints), so it
    //         and `bus` are each other's control on every run.
    //   duty  what a slaved 921B's rectangular tap ACTUALLY renders. This one
    //         applies a law that lives in the OTHER module, deliberately: the
    //         921A has no pulse in it, so this is the only surface on either
    //         panel that can say what WIDTH does. ⚠ It prints `norm 50 %` at
    //         the declared MINIMUM — measured 49.85 % duty through the real
    //         worklet chain, bit-identical to no cable at all (#1791, filed not
    //         fixed). A bare `50 %` there would read like the dial working.
    hero: {
      control: 'frequency',
      readouts: [
        { label: 'bus', valueId: 'moog921a-bus' },
        { label: 'span', valueId: 'moog921a-span' },
        { label: 'duty', valueId: 'moog921a-duty' },
      ],
    },

    // THE COMPARISON — the pair's headline fact, as two rows: the pitch this
    // dial position encodes in EACH range position, both live, side by side. At
    // `frequency = +0.50` they read `370.00 Hz` and `2.09k`, a factor of 5.66
    // from a two-state switch; at the shipped `frequency = 0` they are the same
    // number, which is the inertness argument above made visible rather than
    // asserted. LABELLED FROM `MOOG921A_RANGE_OPTIONS` so the switch's names
    // have exactly one copy.
    sidebar: [
      {
        kind: 'readouts',
        label: 'at this dial',
        entries: MOOG921A_RANGE_OPTIONS.map((o) => ({
          label: o.label,
          valueId: `moog921a-pitch-${o.value}`,
        })),
      },
    ],
  },

  docs: {
    explanation:
      "A clean-room recreation of the Moog 921A Oscillator Driver — the master half of the System 55/35 two-part oscillator. It is NOT a sound source: it makes no audio of its own. Instead it generates the two CONTROL VOLTAGES — a 1V/oct pitch bus and a pulse-width bus — that drive one or more slaved 921B oscillators, so a whole bank of 921Bs tracks one set of FREQUENCY/RANGE/WIDTH knobs (and one pitch CV) in perfect unison. Mental model: it is the pitch+width 'brain' you patch into every 921B's FREQ BUS and WIDTH BUS so they play together; tune here, hear it on the 921Bs. THE FREQUENCY DIAL IS DIMENSIONLESS AND THE RANGE SWITCH IS ITS SCALE: the pot runs -1..+1 and the switch decides whether that span is ONE octave (SEMI) or SIX (OCT), so the same dial position is two different pitches. At +0.50 a slaved 921B sitting at its own defaults sings 370.00 Hz (F#4) in SEMI and 2093.01 Hz (C7) in OCT — a factor of 5.66 from a two-state switch — while the whole dial reaches 130.81..523.25 Hz in SEMI and 4.09 Hz..16.74 kHz in OCT. At the shipped FREQUENCY of 0 both positions are 0 V and the switch does nothing at all, which is why the faceplate prints the compass rather than the switch position. The FREQ CONTROL INPUT is summed AFTER that multiply, so a cable is 1V/oct in BOTH positions while the pot is one octave or six: the jack and the knob beside it have different authorities, six to one. The faceplate's `bus` and `span` readouts are those two facts; `duty` is what a slaved 921B's rectangular tap actually renders from the width bus.",
    inputs: {
      freq_cv:
        "1V/oct pitch CV summed onto the FREQ knob (and the RANGE compass) per sample, then sent out on the freq bus — patch a keyboard or sequencer here to play every slaved 921B at once.",
      width_cv:
        "Pulse-width CV summed onto the WIDTH knob per sample and passed through to the width bus, so an LFO here animates the pulse width of every 921B driven by this module simultaneously (ganged PWM). At the shipped WIDTH of 0.5 a full-scale +/-1 modulator drives the sum past both ends of the 0..1 clamp, and the bottom of its swing lands on the 921B's 'no cable' normal rather than on a narrow pulse — so a full-scale LFO here is NOT a monotonic duty sweep. See issue #1791.",
    },
    outputs: {
      freq_bus:
        "The 1V/oct frequency control voltage. Patch it into each 921B's FREQ BUS input so they all follow this module's pitch (knob + freq_cv).",
      width_bus:
        "The 0..1 pulse-width control voltage. Patch it into each 921B's WIDTH BUS input so their rectangular outputs share one width (knob + width_cv, clamped to 0..1). Note that a 921B reads any value at or below 0.02 on this cable as 'nothing patched' and substitutes a 50% square, so the bottom of the range does not reach a narrow pulse — see the WIDTH control note and issue #1791.",
    },
    controls: {
      frequency: "The FREQUENCY pot, a normalized -1..1 that the RANGE switch maps onto the pitch bus — the coarse tuning for every 921B this driver feeds. It carries no unit of its own: the volts it puts on the bus are this number times the RANGE compass (1 octave in SEMI, 6 in OCT), so +0.50 is +0.5 V or +3.0 V depending on the switch. The faceplate's `bus` readout is that product; the dial alone cannot print it.",
      freqRange:
        "RANGE switch: 1 = SEMITONE (the FREQUENCY pot spans a narrow ~2-octave window for fine tuning) / 2 = OCTAVE (the pot spans a wide ~12-octave compass for big sweeps). It is a SCALE for the FREQUENCY pot and does nothing on its own — at the shipped FREQUENCY of 0 both positions put 0 V on the bus, so flipping it on a freshly spawned module is bit-exactly inert. It does NOT scale the FREQ CONTROL INPUT, which is summed after the multiply and stays 1V/oct in both positions.",
      width: "Pulse width sent on the width bus, driving the rectangular output of every 921B that reads this bus (the sine, triangle and saw taps are untouched by it). WHAT A SLAVED 921B DOES WITH IT IS NOT A STRAIGHT 0..1: it treats any bus value at or below 0.02 as 'no cable' and substitutes a 50% square, then clamps the rest to a 2%..98% duty. So the declared MINIMUM of this knob produces the MIDPOINT result — measured 49.85% duty at the rect tap, the same as leaving the cable unpatched — the bottom of the travel is a flat plateau ending in a jump to 2%, and everything above 0.98 is dead. See issue #1791; the faceplate's `duty` readout prints the real answer and says `norm` when the bus is being ignored.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = createWorkletNode(node, ctx, 'moog921a', {
      numberOfInputs: 2,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });

    // Feed silence into every input so the node stays in the active
    // processing graph even when nothing's externally patched (mirrors the
    // 921 VCO / 904A / analogVco silence-keepalive pattern).
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(workletNode, 0, 0);
    silence.connect(workletNode, 0, 1);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of moog921aDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['freq_cv',  { node: workletNode, input: 0 }],
        ['width_cv', { node: workletNode, input: 1 }],
      ]),
      outputs: new Map([
        ['freq_bus',  { node: workletNode, output: 0 }],
        ['width_bus', { node: workletNode, output: 1 }],
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
