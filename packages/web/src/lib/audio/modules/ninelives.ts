// packages/web/src/lib/audio/modules/ninelives.ts
//
// NINE LIVES — a low-frequency oscillator fanned out to NINE CV outputs on a
// geometric ⅓ rate ladder, all sharing one waveform, with a RESET trigger.
// DSP is a custom JS AudioWorklet (packages/dsp/src/ninelives.ts → the pure
// core packages/dsp/src/lib/ninelives-dsp.ts).
//
//   out1 runs at the `rate` knob. Each subsequent output runs at ⅓ the rate of
//   the one before it:  out_n = rate × (1/3)^(n-1).  So:
//     out2 = rate/3,  out3 = rate/9,  …  out9 = (1/3)^8 = rate/6561 (≈ 0.0001524×).
//   Nine slowly-detuning modulation taps off a single knob, from the set rate
//   down to a ~once-every-many-minutes drift.
//
//   MEASURED (art/scenarios/ninelives/ladder.test.ts, through THIS factory in a
//   real OfflineAudioContext, port id by port id): every rung lands within
//   2.5e-7 relative of `rate × (1/3)^(n-1)`. The ladder is exactly as described.
//
// ⚠ "IDENTICAL TO A NORMAL LFO" IS TRUE AT ONE SETTING, AND THE FILE USED TO
//   SAY IT UNQUALIFIED — three times, plus the module manifest. The LFO scales
//   its output by `depth · 2` (packages/dsp/src/lfo.ts) and NINE LIVES HAS NO
//   DEPTH CONTROL, so out1 is bit-identical to `lfo.out0` at the LFO's shipped
//   `depth` default (0.5 → unity) and at no other depth; at depth 1 the LFO
//   swings ±2 while every tap here stays ±1. Both halves are permanent legs of
//   the ART scenario. The nine taps are therefore FIXED full-scale bipolar CV —
//   attenuate downstream, there is nothing on this panel to turn them down.
//   (The other difference is not audible from one rack: the LFO anchors its
//   phase to the shared multiplayer clock via `init`/`resync` port messages;
//   this module free-runs from phase 0 per client, so two clients' ladders
//   drift apart. RESET is the only re-sync it has.)
//
// Inputs:
//   reset (gate, edge:'trigger'): rising edge re-zeroes every phase so all nine
//     outputs snap back to phase 0 together (a hard re-sync of the whole ladder).
//
// Outputs:
//   out1 … out9 (cv): the nine bipolar LFO taps on the ⅓ ladder (out1 fastest).
//
// Params:
//   rate (log 0.01..100 Hz, default 1): out1 frequency — reuses the LFO's rate
//     range + log curve verbatim.
//   shape (linear 0..2, default 0): the SHARED waveform morph (sine→saw→square)
//     applied to all nine outputs.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/ninelives.js?url';

import { createWorkletNode } from '$lib/audio/worklet-guard';
// The LADDER LENGTH comes from the DSP core the worklet is BUILT FROM, by a
// RELATIVE path (not the `@patchtogether.live/dsp/src/...` alias) for the reason
// `sidecar-face-model.ts` / `resofilter-face-model.ts` document: a worktree may
// not symlink the workspace package under node_modules, and the TS path-alias
// rules do not reliably resolve TS source out of there.
//
// ⚠ IT USED TO BE A SECOND COPY. This file declared `const OUT_COUNT = 9`
// while `ninelives-dsp.ts` declared `NINE_LIVES_OUTPUT_COUNT = 9` and sized the
// processor's per-sample loop off THAT. Nothing joined them: if either moved,
// the factory would build a node with fewer outputs than the processor writes
// (or more), and no gate anywhere would notice. `OUT_COUNT` — the number the
// FACTORY sizes the worklet node with — is now the DSP's own constant, and a
// hand-typed population count is gone.
//
// ⚠ THE `outputs` ROSTER BELOW STAYS A LITERAL, deliberately. See the comment
// on it: `buildModuleManifest` regex-parses the SOURCE of every audio def, so a
// derived roster empties the module's docs page. The two are joined by an
// assertion in `ninelives.test.ts` instead.
import { NINE_LIVES_OUTPUT_COUNT } from '../../../../../dsp/src/lib/ninelives-dsp';

const PROCESSOR_NAME = 'ninelives';
const OUT_COUNT = NINE_LIVES_OUTPUT_COUNT;
const loadedContexts = new WeakSet<BaseAudioContext>();

/** The tap port ids, in ladder order — `out1` is the fastest rung. Used ONLY to
 *  generate the face's sidebar rows (which the manifest parser does not read),
 *  so the table cannot name a port the ladder does not have. The `outputs`
 *  roster is asserted equal to this population in `ninelives.test.ts`. */
const TAP_PORT_IDS: readonly string[] = Array.from(
  { length: OUT_COUNT },
  (_, n) => `out${n + 1}`,
);

export const ninelivesDef: AudioModuleDef = {
  type: 'ninelives',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'nine lives',
  category: 'modulation',

  inputs: [
    // RESET is a TRIGGER (fires once per rising edge): re-syncs the whole
    // ladder. Flows through the unified `gate` cable (cross-patchable with cv).
    { id: 'reset', type: 'gate', edge: 'trigger' },
  ],
  // The nine bipolar CV taps, one per ladder rung.
  //
  // ⚠ THIS LITERAL CANNOT BE DERIVED, AND THAT IS A PLATFORM CONSTRAINT RATHER
  // THAN A PREFERENCE. `buildModuleManifest` (module-manifest.ts:1262) reads
  // `extractArray(src, 'outputs')` — it REGEX-PARSES THE SOURCE TEXT of every
  // audio def, because it runs at build time over a `?raw` glob and never
  // imports the registry. This roster was briefly written as
  // `TAP_PORT_IDS.map(...)`, which is correct TypeScript, produces the
  // identical def object, and left the parser with an EMPTY match: the
  // module's entire Inputs & Outputs docs section vanished. Caught by
  // `module-manifest.test.ts` ("ninelives output ids: expected [] to deeply
  // equal [ Array(9) ]"), which walks every registered audio def — a real gate
  // doing exactly its job. Keep the literal.
  //
  // The join to the DSP is therefore an ASSERTION rather than a construction:
  // `ninelives.test.ts` pins this roster against `NINE_LIVES_RATE_MULTIPLIERS`
  // in BOTH directions, and the ART ladder scenario measures each declared port
  // through the real factory. `OUT_COUNT` below — the number the FACTORY sizes
  // the worklet with — is still imported, so the two places that decide "how
  // many outputs" can only disagree in the direction a test is watching.
  outputs: [
    { id: 'out1', type: 'cv' },
    { id: 'out2', type: 'cv' },
    { id: 'out3', type: 'cv' },
    { id: 'out4', type: 'cv' },
    { id: 'out5', type: 'cv' },
    { id: 'out6', type: 'cv' },
    { id: 'out7', type: 'cv' },
    { id: 'out8', type: 'cv' },
    { id: 'out9', type: 'cv' },
  ],
  params: [
    // rate: log (0.01..100Hz), the SAME definition the LFO uses for its rate.
    // (`ninelives.test.ts` asserts the five fields against `lfoDef` rather than
    // restating them, so the two cannot drift.)
    { id: 'rate',  label: 'Rate',     defaultValue: 1, min: 0.01, max: 100, curve: 'log', units: 'Hz' },
    // shape: linear (0..2 morph axis), the shared waveform for all nine taps.
    { id: 'shape', label: 'Waveform', defaultValue: 0, min: 0,    max: 2,   curve: 'linear' },
  ],

  // THE FACEPLATE (queue Q11). Two params, one input, nine outputs — and §1 of
  // the queue ranked the pool by PARAM COUNT, on which measure this is a
  // rejection. It is the `noise` case exactly: one knob, promoted because
  // several stated facts about its taps were unprintable from it.
  //
  // WHAT THE RATE DIAL CANNOT SAY. It prints ONE frequency for NINE outputs
  // that are 6561× apart. Measured through THIS factory, port id by port id
  // (art/scenarios/ninelives/ladder.test.ts), at the shipped Rate of 1 Hz:
  //
  //   out1 1.00 s · out2 3.00 s · out3 9.00 s · out4 27.0 s · out5 1.4 min
  //   out6 4.1 min · out7 12.2 min · out8 36.5 min · out9 1.8 h
  //
  // and at the bottom of the dial (0.01 Hz) out9's cycle is 7.6 DAYS. That is
  // the module's entire behaviour and none of it is on the dial. So the face is
  // the READOUTS: the two ends of the ladder in the hero, the nine cycle times
  // in the sidebar.
  //
  // ⚠ THE GLYPH TAPS NOTHING, AND THAT IS THE ANSWER TO THE `noise` HAZARD
  // RATHER THAN AN OVERSIGHT. With nine outputs, any analyser-backed glyph
  // reads exactly ONE of them and paints it as the module — `noise`'s lane
  // meter resolves `primaryAudioOutPortId`, the FIRST declared AUDIO output,
  // and reads a tap 7.1 dB from what the player hears. Here that resolver
  // returns NULL: every output is `cv`, so there is no audio output to pick.
  // `glyph: 'meter'` would therefore resolve `{ kind: 'static' }`, hand
  // `<VuMeter>` no tap at all, and paint twelve segments that can never light —
  // the marbles defect, verbatim. `'waveform'` resolves `{ kind: 'wave-morph' }`
  // instead: a PARAM-DERIVED single cycle of the `shape` morph, which is
  // honest here for a reason specific to this module — the waveform is
  // genuinely SHARED by all nine taps, so a picture of it is a picture of every
  // output rather than of one of them. Both halves are permanent legs of
  // `ninelives-face-model.test.ts`.
  //
  // No `glyphDepthGain`: there is no depth param, so `wave-morph` draws at
  // amplitude 1 — which is what the taps actually are.
  face: {
    // 1 — RATE. It moves all nine at once and nothing else on the module
    // changes a rate. 2 — WAVEFORM, shared by all nine and ORTHOGONAL to the
    // ladder: `shape` chooses what is read off the accumulators, never how fast
    // they advance. Measured on the shipping worklet at two shapes through two
    // DIFFERENT estimators (saw phase-slope and sine zero-crossing count), so
    // the claim does not rest on one code path.
    //
    // ⚠ RANK 1 EQUALS DECLARATION ORDER HERE, and that is stated rather than
    // dressed up: the promotion moves the Push 2 card GENERIC → FACE and the
    // encoders do NOT move. `push-card-schema.test.ts` records it, because
    // "the card did not move" and "nobody looked" must not be one green.
    order: ['rate', 'shape'],

    // PARAM-DERIVED, taps no output. See the ⚠ above.
    glyph: 'waveform',

    // No `pages`: two keys, one of them promoted to the hero, so the remaining
    // band is WAVEFORM alone. A page here would buy an ~81 px band to put an
    // editorial word over a single fader. The page-less `__all` band renders
    // unlabelled, which is the honest shape.
    //
    // No `title`, no `hint`, no band hints — owner ruling 2026-08-11
    // (marbles / resofilter): plain labels and values on the face; the
    // explanation lives in `docs`, one right-click away.
    hero: {
      control: 'rate',
      readouts: [
        // BOTH ENDS OF THE LADDER as cycle times, which is the one string the
        // dial is structurally unable to produce: it is a single number and
        // this is a span of 6561×. Negative-controlled on WAVEFORM, which must
        // not move it.
        { label: 'ladder', valueId: 'ninelives-ladder-span' },
        // WHICH TAPS STILL READ AS MOVEMENT — the taps whose cycle is a minute
        // or less. It is `out 1–4` at the shipped Rate and NONE below
        // Rate 0.0167, where the fastest output takes longer than a minute to
        // come round. A dial stepping 0.02 → 0.016 Hz looks like nothing.
        { label: '≤ 1 min', valueId: 'ninelives-fast-taps' },
        // The WAVEFORM the 0..2 dial cannot name. RATE-invariant — the two
        // above are WAVEFORM-invariant, so each is the other's negative
        // control on every run.
        { label: 'wave', valueId: 'ninelives-wave' },
      ],
    },

    // THE TABLE. One row per declared tap, GENERATED from the ladder rather
    // than typed nine times — the ids come from the same `TAP_PORT_IDS` the
    // `outputs` roster is built from, so a row can never name a port that does
    // not exist and a port can never go missing a row.
    sidebar: [
      {
        kind: 'readouts',
        label: 'cycle time',
        entries: TAP_PORT_IDS.map((id, n) => ({
          label: `out ${n + 1}`,
          valueId: `ninelives-tap-${n + 1}`,
        })),
      },
    ],
  },

  docs: {
    explanation:
      "Nine LFOs in one — a single oscillator fanned out to NINE bipolar CV outputs whose rates form a geometric ⅓ ladder. OUT 1 runs at the Rate knob (the same 0.01–100 Hz log range and the same sine→saw→square waveform a normal LFO has). Each output below it runs at one-THIRD the rate of the one above, so OUT 2 = Rate/3, OUT 3 = Rate/9, and the slowest, OUT 9 = (1/3)^8 = Rate/6561 (about 0.0001524×). All nine taps share ONE Waveform shape. It's a quick way to get a spread of slowly-detuning modulators — clock-like at the top, glacial at the bottom — from one knob. RESET re-syncs the whole stack: each rising edge snaps all nine phases back to 0 at once so they restart together. Two things to know before you patch it. First, THE BOTTOM OF THE LADDER IS SLOWER THAN IT SOUNDS: at the shipped Rate of 1 Hz, OUT 5 takes 1.4 minutes per cycle, OUT 8 takes 36 minutes and OUT 9 takes 1.8 hours — and at the bottom of the Rate dial (0.01 Hz) OUT 9's cycle is 7.6 DAYS, so a scope on the slow taps looks like a stationary DC level rather than a modulator. That is the module working, not a dead jack; measured on the shipping worklet through this module's own factory (art/scenarios/ninelives/ladder.test.ts). Second, THERE IS NO DEPTH CONTROL: every tap is a fixed full-scale ±1, so attenuate downstream (ATTENUMIX, ILLOGIC) rather than here. OUT 1 is bit-identical to a normal LFO's output only at the LFO's default Depth of 0.5, which is where an LFO's own scaling reaches unity — at Depth 1 the LFO swings ±2 and this module still swings ±1.",
    inputs: {
      reset:
        "A trigger input: each rising edge (crossing above 0.5) re-zeroes all nine phase accumulators at once, so every output restarts from phase 0 together (a hard re-sync of the whole ladder). Edge-triggered — it fires once per rising edge and ignores how long the level stays high, so holding it high does not freeze the outputs. Patch a clock or gate here to lock the stack's restart to a tempo.",
    },
    outputs: {
      out1: "The fastest tap: a bipolar ±1 LFO at the full Rate knob frequency, and the reference rate the rest of the ladder divides down from. Bit-identical to a normal LFO at the same Rate and Waveform when that LFO's Depth is at its default 0.5 (where an LFO's Depth×2 scaling reaches unity) — at Depth 1 the LFO swings ±2 and this tap still swings ±1. One cycle takes 1.00 s at the shipped Rate of 1 Hz.",
      out2: "Rate ÷ 3 — one third the speed of OUT 1, same shared waveform. 3.00 s per cycle at Rate 1 Hz.",
      out3: "Rate ÷ 9 — (1/3)^2 of OUT 1. 9.00 s per cycle at Rate 1 Hz.",
      out4: "Rate ÷ 27 — (1/3)^3 of OUT 1. 27.0 s per cycle at Rate 1 Hz.",
      out5: "Rate ÷ 81 — (1/3)^4 of OUT 1. 1.4 minutes per cycle at Rate 1 Hz: this is the first tap that no longer reads as movement on a scope you are watching, and the first one a patcher is likely to mistake for a dead jack.",
      out6: "Rate ÷ 243 — (1/3)^5 of OUT 1. 4.1 minutes per cycle at Rate 1 Hz.",
      out7: "Rate ÷ 729 — (1/3)^6 of OUT 1. 12.2 minutes per cycle at Rate 1 Hz.",
      out8: "Rate ÷ 2187 — (1/3)^7 of OUT 1. 36.5 minutes per cycle at Rate 1 Hz.",
      out9: "The slowest tap: Rate ÷ 6561 — (1/3)^8 of OUT 1 (≈ 0.0001524×). At Rate 1 Hz that is one sweep every 1.8 hours (6561 s); at the bottom of the Rate dial (0.01 Hz) it is 7.6 DAYS and at the top (100 Hz) it is 65.6 s. Over any session you will see a slow one-way ramp, not a cycle — which is the point of it, and also why it looks like DC.",
    },
    controls: {
      rate: "Sets OUT 1's frequency from 0.01 Hz (one sweep per 100 s) to 100 Hz, on a log fader — the same range and curve as the LFO. Every other output tracks it on the fixed ⅓ ladder (OUT n = Rate × (1/3)^(n-1)), so this one knob speeds up or slows down the entire stack together. What the number on the fader cannot tell you is what it did to the BOTTOM of the stack: it prints one frequency for nine outputs that are 6561× apart, so 1.00 Hz here means OUT 9 sweeps once every 1.8 hours, and 0.10 Hz means once every 18 hours. The faceplate prints both ends of the ladder and the nine cycle times beside it for that reason.",
      shape: "The shared waveform for all nine outputs: morphs continuously across 0–2 (0 = sine, 1 = saw, 2 = square), with smooth crossfades in between (e.g. 0.5 = halfway sine↔saw). The fader's glyphs mark sine / saw / square.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = createWorkletNode(node, ctx, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: OUT_COUNT,
      outputChannelCount: Array.from({ length: OUT_COUNT }, () => 1),
    });

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of ninelivesDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    const outputs = new Map<string, { node: AudioNode; output: number }>();
    for (let n = 0; n < OUT_COUNT; n++) {
      outputs.set(`out${n + 1}`, { node: workletNode, output: n });
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['reset', { node: workletNode, input: 0 }],
      ]),
      outputs,
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try {
          workletNode.disconnect();
        } catch {
          /* already disconnected */
        }
        try {
          workletNode.port.close();
        } catch {
          /* port may already be closed */
        }
      },
    };
  },
};
