// packages/web/src/lib/audio/modules/moog911a.ts
//
// MOOG 911A DUAL TRIGGER DELAY — Moog System 55/35 clone (batch 5 utility
// cluster). Two independent trigger delays with a coupling MODE. A gate on an
// input is detected on its RISING edge; after a programmed delay the matching
// output emits a short (~1 ms) gate pulse. Categorized under Ports → moogafakkin.
//
// DSP: own-code pure timing (packages/dsp/src/lib/trigger-delay-dsp.ts —
// DualTriggerDelay) wrapped by the worklet packages/dsp/src/moog911a.ts.
// Permissive, not a port of any Moog schematic / copyleft source.
//
// Inputs (gates):
//   trig1 (gate): trigger input for delay 1 (and the master trigger in
//     PARALLEL / SERIES modes).
//   trig2 (gate): trigger input for delay 2 (used only in OFF mode).
// Outputs (gates):
//   out1 (gate): delayed pulse from channel 1.
//   out2 (gate): delayed pulse from channel 2.
//
// Params:
//   delay1 (log seconds, 0.002..10, default 0.1): channel-1 delay time.
//   delay2 (log seconds, 0.002..10, default 0.1): channel-2 delay time.
//   mode   (discrete 0..2, default 0): coupling —
//     0 = OFF (independent), 1 = PARALLEL (trig1 fires both),
//     2 = SERIES (out1 re-triggers delay2).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/moog911a.js?url';

import { createWorkletNode } from '$lib/audio/worklet-guard';
// Human-readable MODE names, indexed by the `mode` param value 0..2. The card
// renders MODE_NAMES[mode] next to the MODE knob.
export const MOOG911A_MODE_NAMES = ['OFF', 'PARALLEL', 'SERIES'] as const;
export const MOOG911A_MODE_COUNT = MOOG911A_MODE_NAMES.length;
export const MOOG911A_MAX_MODE = MOOG911A_MODE_COUNT - 1;

// Per-context cache so addModule isn't called twice on the same context.
const loadedContexts = new WeakSet<BaseAudioContext>();

export const moog911aDef: AudioModuleDef = {
  type: 'moog911a',
  palette: { top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' },
  card: 'Moog911aCard',
  domain: 'audio',
  label: '911a trig delay',
  category: 'modulation',

  inputs: [
    // Gate triggers — rising-edge detected in the worklet (PASSTHROUGH, not a
    // knob modulator → no cvScale / paramTarget).
    { id: 'trig1', type: 'gate', edge: 'trigger' },
    { id: 'trig2', type: 'gate', edge: 'trigger' },
  ],
  outputs: [
    // Delayed gate pulses — NOT audio.
    { id: 'out1', type: 'gate', edge: 'trigger' },
    { id: 'out2', type: 'gate', edge: 'trigger' },
  ],
  params: [
    // Delay times — log fader, 2 ms .. 10 s, default 100 ms.
    { id: 'delay1', label: 'Delay 1', defaultValue: 0.1, min: 0.002, max: 10, curve: 'log', units: 's' },
    { id: 'delay2', label: 'Delay 2', defaultValue: 0.1, min: 0.002, max: 10, curve: 'log', units: 's' },
    // Coupling mode — discrete picker.
    //
    // ⚠ THE `options` ROSTER IS THE STOP-2 FIX FOR PROMOTION, not decoration.
    // `Moog911aCard.svelte:94` renders a live three-state NAME under the knob
    // (`OFF` / `PARALLEL` / `SERIES`) built from `MOOG911A_MODE_NAMES` — an
    // exported const the SHELL never reads. Promotion replaces that card at the
    // dock, so a def-driven face would have printed `0.00` and the vocabulary
    // would have been lost: a functional-parity regression, which is a hard
    // requirement rather than a trade. Declaring the roster here brings the
    // names back FROM THE DECLARATION instead of from card markup, so both
    // surfaces read one source. `curve` is already `'discrete'`, so this needs
    // no other change; three options is inside SEGMENTED_MAX_OPTIONS = 6, so
    // the dock renders a segmented picker and the lane tiers a knob whose
    // readout paints the NAME.
    //
    // ⚠ AND PROMOTION IS BEHAVIOUR-PRESERVING ON THIS PARAM, which was checked
    // rather than assumed. `Knob.svelte` has no `discrete` branch and
    // `DualTriggerDelay.step` clamps with `mode <= 0 ? Off : mode >= 2 ?
    // Series : Parallel` — composed, that predicts PARALLEL over the whole open
    // interval and the card's `Math.round` name disagreeing over HALF the dial.
    // Measured on the shipping worklet: 0 of 41 sampled dial positions
    // disagree, because the WORKLET rounds first (`moog911a.ts:92`), so the
    // effective boundaries bisect to 0.4999999851 and 1.4999999404 — exactly
    // `Math.round`, exactly what the card prints. The lib's clamp is dead code
    // for this caller. ⚠ The identical-looking reasoning is CORRECT for
    // `moog921b.range`, whose DSP smooths the value as a float: same
    // declaration, opposite answer, and only reading the consumer separates
    // them.
    {
      id: 'mode', label: 'Mode', defaultValue: 0, min: 0, max: MOOG911A_MAX_MODE, curve: 'discrete',
      options: [
        { value: 0, label: 'OFF', title: 'Independent — TRIG 1 drives OUT 1, TRIG 2 drives OUT 2, and neither channel touches the other' },
        { value: 1, label: 'PARALLEL', title: 'TRIG 1 fires BOTH delays at once — one trigger in, two staggered triggers out. TRIG 2 is ignored' },
        { value: 2, label: 'SERIES', title: 'Chained — OUT 1 re-triggers delay 2, so OUT 2 lands delay1 + delay2 after the original trigger. TRIG 2 is ignored' },
      ],
    },
  ],

  // ── THE FACEPLATE (PF-20) ────────────────────────────────────────────────
  //
  // WHAT THE 911A IS FOR. It is the rack's only TIME-SHIFTER FOR EVENTS: a
  // trigger goes in, the same trigger comes out later. The verb is OFFSETTING A
  // HIT — a flam, a second voice a beat behind, a delayed strike. Its siblings
  // shift SIGNAL; this one shifts WHEN.
  //
  // THE MERIT IS ONE NUMBER THE MODULE CANNOT CURRENTLY PRINT: the clock rate
  // above which the channel emits NOTHING AT ALL. There is no trigger queue —
  // a rising edge inside a running countdown RE-ARMS it rather than being
  // stacked — so a clock at or above `1/delay` never lets a countdown finish.
  // Measured on the SHIPPING worklet, `delay1` at its 0.1 s default, counting
  // rising edges on `out1` over a 3.0 s render: 4 Hz -> 12/12, 8 Hz -> 24/24,
  // 9.9 Hz -> 29/30, and then 10 Hz -> 0/30, 16 Hz -> 0/48, 32 Hz -> 0/96. A
  // CLIFF, not a rolloff, and bisected to 9.998958 Hz against a predicted
  // 1/0.1 = 10.000000. Positive control: the same 16 and 32 Hz clocks at the
  // 0.002 s minimum give 48/48 and 96/96, so it is the delay and not the clock.
  // The `max rate` readout below IS that number. Filed as #1886 — the behaviour
  // is not changed here (adding a queue is an audio-semantics decision for the
  // owner's ears), it is made VISIBLE and documented.
  //
  // THE RANKING, from the DSP rather than from declaration order.
  //
  //   1 DELAY 1  UNCONDITIONAL APPLICABILITY, measured. In all three modes
  //              `trig1 -> delay1 -> out1`. Driving TRIG 2 ALONE: OFF gives 1
  //              pulse on out2; PARALLEL gives 0; SERIES gives 0. So the second
  //              channel's input is switched off in two modes of three while
  //              the first is never conditional on anything.
  //   2 MODE     because it TURNS A JACK ON AND OFF — the measurement above is
  //              the whole argument, and it is what makes MODE rank above the
  //              knob it gates. ⚠ This would be the WRONG argument for a module
  //              whose mode merely re-voices a filter; it is right here because
  //              the mode decides whether TRIG 2 and DELAY 2 mean anything.
  //   3 DELAY 2  third, for exactly that reason.
  //
  // ⚠ ALL THREE ARE BIT-EXACTLY INERT AT SPAWN (both TRIG jacks unpatched):
  // every output stays bit-identical across each param's full declared range.
  // Positive control: one trigger on TRIG 1 with `delay1` at 0.1 vs 1.0 s is
  // not bit-identical. So, as on the 911, inertness cannot discriminate the
  // ranking and the argument rests on the mode gating instead.
  //
  // TIER LADDER AS A SENTENCE. `glyph: 'none'` — both outputs are `gate`, so
  // `primaryAudioOutPortId` returns null and every other glyph kind resolves to
  // the dead `{kind:'static'}`. The compact cap is therefore
  // LANE_ROW_MAX_CELLS = 3, and the module has exactly three controls: every
  // tier from COMPACT up shows all of them. The only tier decision this face
  // makes is MINI, and mini is DELAY 1.
  //
  // PAGES (2): `delays` = delay1, delay2 · `coupling` = mode. MODE is
  // categorically different — a switch among log-time knobs — and it gates the
  // other two. That is a different IDEA, not a header for its own sake, which
  // is the bar a second page has to clear.
  //
  // NO SIDEBAR (it is the one contract-projected `face` field, and it scales
  // faceplate-platform's sweep budget). NO `bareCells`: `Delay 1` / `Delay 2`
  // are the only thing separating two identical log knobs.
  //
  // REAR CARD: neither input carries `paramTarget` — they are passthrough gate
  // jacks, not knob modulators — so both take the VOICE/SIGNAL slot and both
  // outputs take their derived single section. Checked against `rearFieldPlan`
  // rather than authored; `face.rear.groups` would only restate it.
  face: {
    order: ['delay1', 'mode', 'delay2'],

    pages: [
      {
        id: 'delays',
        label: 'delays',
        hint: 'how long after its trigger each channel fires — 2 ms to 10 s',
        controls: ['delay1', 'delay2'],
      },
      {
        id: 'coupling',
        label: 'coupling',
        hint: 'which jack drives channel 2 — its own, TRIG 1, or OUT 1',
        controls: ['mode'],
      },
    ],

    glyph: 'none',

    // THE HERO: two derived readouts and no promoted control. Both are joins
    // that no knob readback can perform, and the first is the module's entire
    // merit argument.
    //
    //   max rate  the clock ABOVE WHICH THIS CHANNEL EMITS NOTHING, 1/delay1.
    //             10.0 Hz at the shipped default, and the measured cliff sits
    //             at 9.998958 Hz. It is invariant to DELAY 2 and to MODE, which
    //             is what makes it the other readout's negative control.
    //   last out  when the LAST output fires after one trigger on TRIG 1 — and
    //             it needs all THREE params, because the mode decides which
    //             outputs fire at all: OFF -> delay1 (out2 never fires from
    //             TRIG 1, measured), PARALLEL -> max(delay1, delay2), SERIES ->
    //             delay1 + delay2. Sweeping MODE with both dials held moves it
    //             100 -> 100 -> 200 ms while NEITHER dial moves.
    //
    // The permanent negative controls are in moog911a-face-model.test.ts and
    // the closed forms are re-derived from the shipping worklet in
    // art/scenarios/moog911a/face-audit.test.ts.
    hero: {
      readouts: [
        { label: 'max rate', valueId: 'moog911a-max-rate' },
        { label: 'last out', valueId: 'moog911a-last-out' },
      ],
    },
  },

  docs: {
    explanation:
      "A clean-room recreation of the Moog 911A Dual Trigger Delay — two independent timers that each take an incoming trigger and re-emit it a programmed time later. A rising edge on a TRIG input starts that channel's countdown; when the DELAY time elapses the matching OUT emits a short (~1 ms) trigger pulse. The MODE switch couples the two channels: OFF runs them as two separate delays (each its own trigger in/out), PARALLEL fans one trigger into BOTH delays at once (one input fires two outputs, useful for staggered double-hits), and SERIES chains them so OUT 1 re-triggers delay 2 (the total delay before OUT 2 fires is delay1 + delay2). Mental model: a pair of 'echo' timers for gates/triggers — patch a clock or strike in, get a time-shifted copy out, to offset a second voice or build rhythmic delays of events (not audio).",
    inputs: {
      trig1:
        "Trigger input for delay 1, and the master trigger in PARALLEL and SERIES modes. A rising edge here starts delay 1's countdown (and, in PARALLEL, delay 2's too); it fires once per edge, not while held. ⚠ There is NO QUEUE: an edge arriving while a countdown is already running RE-ARMS it from zero rather than stacking behind it, so a clock at or above 1/DELAY never lets a countdown finish and the output goes silent completely. At the 100 ms default that ceiling is 10 Hz — a 9.9 Hz clock passes 29 of 30 triggers, a 10 Hz clock passes none at all. The MAX RATE readout on the faceplate prints this limit live.",
      trig2:
        "Trigger input for delay 2 — used only in OFF mode (where the two delays are independent). In PARALLEL and SERIES this input is ignored because delay 2 is driven from TRIG 1 / OUT 1 instead.",
    },
    outputs: {
      out1:
        "Delay 1's output: a trigger pulse emitted once, DELAY 1 seconds after its trigger arrived — measured exact to the sample at 2 ms, 10 ms, 100 ms, 500 ms, 1 s and 10 s. The pulse is 1.0000 ms wide (48 samples at 48 kHz) and that width is FIXED — it is on no dial, so it is half the period at the 2 ms minimum delay and a hundredth of a percent at the 10 s maximum. In SERIES mode this pulse also re-triggers delay 2.",
      out2:
        "Delay 2's output: a trigger pulse, DELAY 2 seconds after delay 2 was triggered — from TRIG 2 in OFF, from TRIG 1 in PARALLEL, or from OUT 1 in SERIES. In SERIES the wait from the original trigger is delay1 + delay2 plus ONE SAMPLE (20.83 µs at 48 kHz), because the chain reads OUT 1 from the previous sample to stay causal; measured at three delay pairs. ⚠ In OFF mode this output does not respond to TRIG 1 at all — the two channels are fully independent, so a patch that drives only TRIG 1 leaves OUT 2 silent until the MODE switch moves.",
    },
    controls: {
      delay1: "Delay time for channel 1: how long after its trigger before OUT 1 fires, from 2 ms up to 10 s (log taper), delivered exact to the sample. ⚠ It is read ONLY at the instant a trigger arrives — arm a countdown at 100 ms, turn the knob to 2 s 40 ms later, and the pulse still lands at 100 ms. It also sets this channel's maximum trigger RATE, because there is no queue: above 1/DELAY the output stops entirely (10 Hz at the default).",
      delay2: "Delay time for channel 2: how long before OUT 2 fires, from 2 ms up to 10 s (log taper). In SERIES this stacks on top of delay 1. Same two properties as DELAY 1 — read only at the triggering edge, and its own 1/DELAY rate ceiling. ⚠ It does nothing at all in whichever modes leave channel 2 untriggered by your patch: with only TRIG 1 connected it is silent in OFF.",
      mode: "Coupling between the two delays, and the one control that turns another JACK on and off. OFF = independent, each with its own trigger in and out. PARALLEL = TRIG 1 fires both delays at once (one in, two staggered outs). SERIES = OUT 1 re-triggers delay 2 so the two times add up. ⚠ TRIG 2 is LIVE ONLY IN OFF — measured: a trigger on TRIG 2 alone produces one pulse in OFF and none at all in PARALLEL or SERIES, so leaving this switch up silently disconnects an input jack.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = createWorkletNode(node, ctx, 'moog911a', {
      numberOfInputs: 2,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });

    // Feed silence into every input so the node stays in the active
    // processing graph even when nothing's externally patched (mirrors the
    // 921 VCO / CP3 silence-keepalive pattern).
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(workletNode, 0, 0);
    silence.connect(workletNode, 0, 1);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of moog911aDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['trig1', { node: workletNode, input: 0 }],
        ['trig2', { node: workletNode, input: 1 }],
      ]),
      outputs: new Map([
        ['out1', { node: workletNode, output: 0 }],
        ['out2', { node: workletNode, output: 1 }],
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
