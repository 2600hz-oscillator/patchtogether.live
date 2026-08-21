// packages/web/src/lib/audio/modules/moog962.ts
//
// MOOG 962 SEQUENTIAL SWITCH — Moog System 55 clone (batch 5 utility
// cluster). A gate-advanced signal selector: up to three signal inputs
// (in1..in3) feed a single output (out), and a rising edge on the SHIFT gate
// steps the selector to the next input (1→2→3→1, or 1↔2 when STAGES=2). This
// is the 4PLEXER's gate-advanced selector trimmed to 3-in / 1-out.
//
// Signal ports are declared `cv` so the CV family (cv / pitch / gate) is
// first-class in the patch-to menu; the underlying Web Audio substrate is
// identical for audio + cv, so an AUDIO cable patches in (and routes) just the
// same — the engine connects node→node regardless of cable type (see the
// routing note in fourplexer.ts).
//
// DSP lives in packages/dsp/src/moog962.ts (custom JS AudioWorklet) wrapping
// the pure, unit-tested Moog962Switch in packages/dsp/src/lib/moog962-dsp.ts.
//
// Inputs:
//   in1..in3 (cv): three signal inputs (audio routes identically via the engine).
//   shift (gate): rising edge advances the selector to the next input.
//
// Outputs:
//   out (cv): carries the currently-selected input.
//
// Params:
//   stages (discrete 2..3, default 3): how many inputs to cycle through.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/moog962.js?url';

import { createWorkletNode } from '$lib/audio/worklet-guard';
const PROCESSOR_NAME = 'moog962';
const loadedContexts = new WeakSet<BaseAudioContext>();

export const moog962Def: AudioModuleDef = {
  type: 'moog962',
  palette: { top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' },
  card: 'Moog962Card',
  domain: 'audio',
  label: '962 seq switch',
  // 'utilities' to bucket alongside the sibling Moog routing/utility modules
  // (CP3 / 902 / 961 / 984 / 994 / 995) in the palette tree.
  category: 'utilities',

  inputs: [
    // Signal inputs — audio OR cv route identically through the engine.
    { id: 'in1',   type: 'cv' },
    { id: 'in2',   type: 'cv' },
    { id: 'in3',   type: 'cv' },
    // SHIFT advance gate — rising edge steps the selector.
    { id: 'shift', type: 'gate', edge: 'trigger' },
  ],
  outputs: [
    { id: 'out', type: 'cv' },
  ],
  params: [
    // STAGES — how many inputs to cycle through. Discrete 2..3 (UI shows the
    // raw count). Default 3 = full 1→2→3→1 rotation.
    {
      id: 'stages',
      label: 'Stages',
      defaultValue: 3,
      min: 2,
      max: 3,
      curve: 'discrete',
      // A TWO-STATE PARAM NEEDS A TWO-STATE CONTROL, and this roster is the
      // only mechanism that gets one (`paramCellKind` derives `'segmented'`
      // from `options`; `face.paramCells` has no segmented kind to declare).
      //
      // ⚠ THIS ROSTER WAS ORIGINALLY REFUSED AND faces-parity CAUGHT THE
      // MISTAKE: *"moog962 cell 'stages' (param/knob): dragging the knob
      // commits a param change into the graph"* failed both attempts. A
      // `2..3 discrete` param rendered as a KNOB has exactly two reachable
      // positions across the dial's whole travel, so an ordinary drag quantises
      // straight back to the value it started on and the control reads as
      // INERT. That is a real usability defect, not a test artifact — the
      // legacy card has it too, since it draws the same bare `<Knob>`.
      //
      // ⚠ AND IT IS NOT A COUNTER-EXAMPLE TO "NEVER INVENT NAMES" (see
      // `sampleHold`, whose ten scale names were PROMOTED because they already
      // existed). The distinction is between naming and SELECTABILITY: a roster
      // exists to make each state directly reachable, and these two states are
      // literally quantities, so labelling them with their own values invents
      // nothing. What the rule forbids is fabricating SEMANTIC names a module
      // does not have.
      options: [
        { value: 2, label: '2', title: 'Alternate IN 1 ↔ IN 2, ignoring IN 3' },
        { value: 3, label: '3', title: 'Rotate IN 1 → IN 2 → IN 3 → IN 1' },
      ],
    },
  ],

  docs: {
    explanation:
      "A clean-room recreation of the Moog 962 Sequential Switch — a gate-advanced signal selector (a routing 'rotary' driven by a clock). Up to three inputs (IN 1–3) feed a single OUTPUT, and exactly one input is connected at a time; each rising edge on the SHIFT gate steps the selector to the next input (1 → 2 → 3 → 1, or 1 ↔ 2 when STAGES is set to 2). It is the 4-plexer's selector trimmed to three inputs and one output. The ports are typed as CV but route audio identically (the engine connects node-to-node regardless of cable type), so it works as a clocked source-switcher for either audio or CV: feed three oscillators (or three CVs) and clock SHIFT to cycle which one reaches the output. Mental model: a one-pole, up-to-3-throw rotary switch advanced by a trigger.",
    inputs: {
      in1: "Signal input 1 (audio or CV) — selected and passed to the output when the selector is on position 1.",
      in2: "Signal input 2 — passed to the output when the selector is on position 2.",
      in3: "Signal input 3 — passed to the output when the selector is on position 3 (used only when STAGES = 3).",
      shift:
        "The advance gate: each rising edge steps the selector to the next input (wrapping after the last active stage). Patch a clock/trigger here to cycle the inputs in time; it acts once per edge, not while held.",
    },
    outputs: {
      out: "Carries whichever input is currently selected — a single output that jumps from input to input on each SHIFT pulse.",
    },
    controls: {
      stages:
        "How many inputs the selector cycles through: 2 (alternate IN 1 ↔ IN 2, ignoring IN 3) or 3 (rotate IN 1 → 2 → 3 → 1). Default 3.",
    },
  },

  // ONE PARAM, ONE RANK, ONE BAND. STAGES renders as a SEGMENTED pair, derived
  // from the `options` roster on the param above — see the note there for why
  // the roster exists, and for the faces-parity failure that proved a bare
  // two-position KNOB is an inert control rather than a minimal one.
  //
  // ⚠ THE PAIRING WITH `sampleHold` IN THIS BATCH STILL HOLDS, but it is about
  // LABELS, not about whether a roster exists. sampleHold's ten scale names
  // were PROMOTED because they already existed card-side and the shell had no
  // way to reach them. Here the two states are quantities and are labelled with
  // their own values, which invents nothing. The rule is: a roster makes states
  // SELECTABLE, and its labels must be the module's real names where it has
  // them — never fabricated semantics.
  //
  // `glyph: 'none'` is RUN, not argued: the single output is `type: 'cv'`, so
  // `primaryAudioOutPortId` is null and any glyph would resolve to a dead
  // `static` binding.
  face: {
    order: ['stages'],
    glyph: 'none',
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = createWorkletNode(node, ctx, PROCESSOR_NAME, {
      numberOfInputs: 4,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    // Feed silence into every input so the node stays in the active processing
    // graph even when nothing's externally patched (mirrors the 921 VCO /
    // CP3 silence-keepalive pattern).
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    for (let i = 0; i < 4; i++) silence.connect(workletNode, 0, i);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of moog962Def.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['in1',   { node: workletNode, input: 0 }],
        ['in2',   { node: workletNode, input: 1 }],
        ['in3',   { node: workletNode, input: 2 }],
        ['shift', { node: workletNode, input: 3 }],
      ]),
      outputs: new Map([
        ['out', { node: workletNode, output: 0 }],
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
