// packages/web/src/lib/audio/modules/gatemaiden.ts
//
// GATEMAIDEN — single-input gate↔trigger converter. ONE generic CV input → a
// GATE output AND a TRIGGER output, derived from the input's level + rising
// edges (no mode switch). The convenience utility for the trigger/gate model:
//
//   - trigger in  → `trig` passes through (one pulse per input pulse); `gate`
//                   emits a short gate (>= gateLen) starting at the strike.
//   - gate in     → `gate` passes through (held while high); `trig` fires once
//                   per gate START (rising edge → one trigger).
//
// DSP lives in packages/dsp/src/gatemaiden.ts (custom JS AudioWorklet); the
// per-sample logic is pure + unit-tested in dsp/src/lib/gatemaiden-dsp.ts.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/gatemaiden.js?url';

import { createWorkletNode } from '$lib/audio/worklet-guard';
const loadedContexts = new WeakSet<BaseAudioContext>();

/**
 * THE ONE COPY of the derived-gate length range.
 *
 * Exported so `GatemaidenCard.svelte` can BIND it instead of re-typing it (the
 * backdraft class: a card that restates a range can silently disagree with the
 * def, and every def-reading gate is blind to the divergence). It matters more
 * from the moment this module is faced, because the dock then renders LEN
 * straight off the `ParamDef` while the card renders whatever it typed — one
 * control with two travels depending on which surface you reach it through.
 *
 * ⚠ These two numbers ALSO exist in `packages/dsp/src/lib/gatemaiden-dsp.ts`
 * (`GATE_LEN_MIN` / `GATE_LEN_MAX`), which clamps to them per sample. They are
 * kept in lockstep BY VALUE rather than by import because a `packages/dsp`
 * module cannot be imported from the web side (the same boundary `GATE_HI`
 * documents there). The clamp is the backstop, not the contract.
 */
export const GATEMAIDEN_GATE_LEN_RANGE = { min: 0.005, max: 2 } as const;

export const gatemaidenDef: AudioModuleDef = {
  type: 'gatemaiden',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'gatemaiden',
  category: 'utility',
  inputs: [
    // Generic CV input: accepts a gate OR a trigger and derives both outputs.
    // Declared `edge: 'gate'` because it READS the input level (for the gate
    // passthrough) while internally also edge-detecting for the trigger — the
    // one principled converter exception to "one input = one semantic".
    { id: 'in', type: 'gate', edge: 'gate', accepts: ['cv', 'pitch'] },
  ],
  outputs: [
    { id: 'gate', type: 'gate', edge: 'gate' },     // held square, min width gateLen
    { id: 'trig', type: 'gate', edge: 'trigger' },  // short pulse per rising edge
  ],
  params: [
    {
      id: 'gateLen',
      label: 'Len',
      defaultValue: 0.05,
      min: GATEMAIDEN_GATE_LEN_RANGE.min,
      max: GATEMAIDEN_GATE_LEN_RANGE.max,
      curve: 'log',
      units: 's',
    },
    {
      id: 'trigShape',
      label: 'Shape',
      defaultValue: 0,
      min: 0,
      max: 1,
      curve: 'discrete',
      // ── THE STATE NAMES LIVE HERE, NOT ON THE CARD ────────────────────────
      // They used to be `const shapeLabels = ['△ TRI', '▭ SQR']` inside
      // GatemaidenCard, which made them CARD-ONLY: a faceplate resolved this
      // param through `looksLikeToggle` and painted an ANONYMOUS two-state
      // switch, so the only thing distinguishing the states died with the card
      // the promotion stops rendering (#2025).
      //
      // A declared roster outranks `looksLikeToggle` in `paramCellKind`, so the
      // dock now resolves `segmented` (2 ≤ SEGMENTED_MAX_OPTIONS) — two
      // captioned buttons, both states visible and one click away, where the
      // card needed a click to even discover the other one — and every lane
      // tier resolves `knob`, painting the NAME through `paintsReadout`.
      //
      // ⚠ THE NAMES ARE ASCII ON PURPOSE. The card draws a leading shape glyph
      // (△ / ▭) and still does; it is card-local decoration and stays there.
      // It is NOT in the roster because the VRT font pin (`e2e/vrt/_fonts.ts`)
      // bundles ~230-codepoint Latin SUBSETS of Inter and JetBrains Mono, and
      // U+25B3/U+25AD are in NEITHER — such a glyph renders through an
      // unpinned fontconfig fallback, which is the exact per-run font
      // nondeterminism that file exists to remove. Putting one in a roster
      // would bake that dependency into this face's new baselines.
      options: [
        {
          value: 0,
          label: 'TRI',
          title:
            'Triangle — ramps up and back down over the pulse. Half the area of SQR, and it crosses the 0.5 gate threshold for only half as long.',
        },
        {
          value: 1,
          label: 'SQR',
          title: 'Square — full level for the whole pulse. Twice TRI’s area, and the stronger choice into a threshold-sensitive input.',
        },
      ],
    },
  ],

  docs: {
    explanation:
      "The convenience converter between the two interpretations of the unified gate cable: a TRIGGER (a brief blip that fires once on each rising edge — a clock tick, a strike) and a GATE (a held level that stays high while something is on — a note being held, an envelope's sustain). One generic input feeds BOTH outputs simultaneously, with no mode switch: GATE reads the input's level (and a passing trigger is widened into a minimum-width gate set by LEN), while TRIG fires one short pulse on every rising edge of the input (so a held gate becomes a single trigger at its start). Use it to make an external clock open an ADSR's sustain, or to turn a long held gate back into a one-shot strike, or just to fan one signal out as both shapes at once.",
    inputs: {
      in: "The signal to convert (accepts a gate, a trigger, or any CV/pitch). Its level drives the GATE output while its rising edges drive the TRIG output. A trigger arriving here is stretched up to LEN on GATE; a held gate here passes through on GATE and emits one trigger on TRIG when it goes high.",
    },
    outputs: {
      gate: "A held gate that stays high while the input is high, but never shorter than the LEN time — so even a momentary trigger on the input produces a usably-wide held gate here. Patch it into anything level-sensitive (an ADSR sustain, a VCA hold).",
      trig: "A short fixed-width pulse that fires once on each rising edge of the input — the trigger form. A long held gate on the input yields a single trigger here at its start, not a continuous level.",
    },
    controls: {
      gateLen: "The minimum width of the GATE output (5 ms to 2 s, log), used when the input is a short trigger: the gate is held at least this long after the strike. With a genuinely held input gate this just sets the floor; the gate otherwise follows the input level.",
      trigShape: "The waveform of the TRIG output pulse — a short triangle (TRI, the default) or a hard square (SQR). Both fire exactly once per rising edge and both occupy the same 5 ms envelope, but they are NOT interchangeable and the difference is not cosmetic: TRI ramps 0→1→0 across the pulse, so it carries HALF the area of SQR, and because it only exceeds the 0.5 threshold that every gate/trigger consumer in the rack compares against for the middle half of its envelope, a downstream input sees TRI as a 2.5 ms pulse where it sees SQR as 5 ms. TRI is the gentler strike into anything level-sensitive; reach for SQR when a downstream trigger input is missing edges or responding weakly.",
    },
  },

  // ── THE FACEPLATE ─────────────────────────────────────────────────────────
  //
  // WHAT IT IS FOR: one ragged gate in, two clean things out. GATE is the input
  // re-squared and held for at least LEN; TRIG is one short shaped pulse per
  // rising edge. The verb is "convert" — the player patches this in when the
  // signal they have is the wrong one of the two interpretations the unified
  // gate cable carries.
  //
  // MERIT, stated plainly because two params is where STOP 1 says to refuse.
  // The tier arithmetic really is trivial: glyph `'none'` → compact cap 3, two
  // params, so every tier from mini up shows everything and nothing is ever
  // truncated. What carries it is not the ladder, it is that BOTH controls are
  // mis-rendered today and the module is the cheapest place in the registry to
  // prove the pair (#2025):
  //
  //   · `trigShape`'s only two names lived in the card as string literals, so a
  //     faceplate resolved an ANONYMOUS switch. They are now `options` above.
  //   · `gateLen` is drawn as a THROW on the card and nothing in a `ParamDef`
  //     says so, so the shell would have substituted a dial. `paramCells` below.
  //
  // And the promotion pays a real defect rather than only re-skinning: the
  // card's shape button wrote `node.params.trigShape` RAW — not undoable, not
  // synced to collaborators — which is why this module carried a `debt` entry
  // in `raw-write-ledger.ts`. That write now goes through the tracked path and
  // the ledger entry is deleted with it.
  //
  // RANK: `gateLen` first. It is the module's whole job — the minimum width is
  // the thing that turns an unusable 1-sample trigger into a gate something can
  // sustain on — and it is the only control that changes what the GATE jack
  // does. `trigShape` second: it never changes WHETHER TRIG fires (one pulse
  // per rising edge, always), only how hard that pulse lands. The argument
  // would come out the other way on a module whose shape choice gated the
  // output at all, which is the test for whether a rank was defended.
  //
  // TIER LADDER AS A SENTENCE: mini shows LEN; compact shows LEN and SHAPE;
  // plate and dock show the same two, because two is under every cap.
  //
  // ONE PAGE, and its label is doing real work rather than restating the id —
  // the `adsr` precedent. `Len` and `Shape` are honest captions that still do
  // not say WHICH JACK each one steers, and on a module whose entire point is
  // that it drives two different outputs that is the one thing a player needs.
  // The section label says it in the permitted vocabulary (a section label),
  // costs no derived-state text, and uses U+00B7 — which IS in the pinned VRT
  // font subsets, unlike the arrow `adsr`'s label happens to use.
  //
  // NO HERO: promoting either key would empty the only band (the `noise` case,
  // where `heroFacePlan` drops an emptied band), trading a labelled section for
  // a bigger dial on a two-control module. NO READOUT, NO SIDEBAR — the fields
  // are deleted platform-wide. `glyph: 'none'` is FORCED, not chosen: run on
  // the live def, `primaryAudioOutPortId` returns null (the ports are `gate`,
  // not `audio`), so every other kind resolves `{kind:'static'}` and reddens
  // the dead-glyph clause. ⚠ Related trap: this face renders `.faceplate.gate`,
  // NOT `.faceplate.audio` — the class comes from the CABLE TYPE.
  face: {
    order: ['gateLen', 'trigShape'],

    // LEN IS A THROW, NOT A DIAL. `NeonFader` is what `GatemaidenCard` has
    // always drawn for it, and nothing in a `ParamDef` separates "a level" from
    // any other continuous scalar — `0.005..2 log` is the same shape as a
    // filter cutoff — so the shell cannot infer it and the module has to say
    // so. Silently substituting a dial is a real regression even though the
    // value semantics are identical (the `noise` ruling, 2026-08-10).
    paramCells: { gateLen: 'fader' },

    glyph: 'none',

    pages: [
      {
        id: 'outputs',
        label: 'gate width · trig shape',
        hint:
          'Both jacks fire from the same input. LEN is the floor on how long GATE stays high after a rising edge — raise it when a short trigger is not opening a sustain; it does nothing extra while the input is genuinely held. SHAPE only changes how hard TRIG lands: TRI carries half the area of SQR and clears the 0.5 threshold for half as long, so SQR is the one to reach for when a downstream trigger input is missing edges.',
        controls: ['gateLen', 'trigShape'],
      },
    ],
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = createWorkletNode(node, ctx, 'gatemaiden', {
      numberOfInputs: 1,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of gatemaidenDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map([
        ['in', { node: workletNode, input: 0 }],
      ]),
      outputs: new Map([
        ['gate', { node: workletNode, output: 0 }],
        ['trig', { node: workletNode, output: 1 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        workletNode.disconnect();
      },
    };
  },
};
