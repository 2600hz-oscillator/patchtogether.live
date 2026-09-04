// packages/web/src/lib/audio/modules/slewswitch.ts
//
// SLEWSWITCH — quad slew limiter + 4→1 sequential CV switch.
// One of the three ATLANTIS-PATCH support modules; useful far beyond
// the Atlantis demo as a general CV smoother + router.
//
// DSP lives in packages/dsp/src/slewswitch.ts (custom JS AudioWorklet).
//
// Inputs:
//   in1..in4 (cv): four CV inputs for the per-channel slew limiter.
//   step_clock (gate): rising edge advances the 4→1 sequential switch index.
//   reset (gate): rising edge resets the switch index to 0.
//   slew1..slew4_cv (cv, log, paramTarget=slew{N}): per-channel slew-time CV.
//
// Outputs:
//   out1..out4 (cv): per-channel slewed direct outputs.
//   switched (cv): the slewed signal at the currently-selected index (4→1 sequential switch).
//   step_idx (cv): the current switch index, spread evenly over -1..+1 across
//     the ACTIVE channels — (idx/(len-1))*2-1, so at the default length 4 the
//     four steps read -1 / -0.3333 / +0.3333 / +1, and at length 1 it is 0.
//   eoc (gate): one-pulse end-of-cycle when the switch wraps.
//
// Params:
//   slew1..slew4 (log 0.001..5 s, default 0.5): per-channel one-pole TIME
//     CONSTANT (tau), NOT the arrival time — 63% of the way in tau, ~99% in 5x
//     tau. Measured across the whole range: t99/tau = 4.605 (= ln 100). #1712.
//   mode (discrete 0..2, default 0): switch mode (forward / pendulum / random).
//   length (discrete 1..4, default 4): active switch length.
//   xfadeTime (log 0.001..2 s, default 0.05): smoothing on the switch index crossfade.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/slewswitch.js?url';

import { createWorkletNode } from '$lib/audio/worklet-guard';
const loadedContexts = new WeakSet<BaseAudioContext>();

/**
 * THE OUTPUT TABLE ROSTER — one row per declared jack, so the face answers
 * "which of the seven does the picture show" with "all of them, as numbers".
 *
 * ⚠ IT LIVES HERE, NOT IN THE FACE MODEL, AND IT IS A LITERAL. The face model
 * imports this def (it reads the param ranges), so generating the roster there
 * would close an import cycle; and a `.map()` over the params would put the
 * port ids behind a call the module-manifest docs parser cannot read — it
 * matches on the def's SOURCE, and a computed roster leaves it with an empty
 * match (the ninelives finding). Both reasons point the same way: a literal,
 * here. Same shape and same argument as `BUGGLES_OUTPUT_READOUTS`.
 *
 * ⚠ ANCHORED RATHER THAN TRUSTED. This is a SECOND declaration of the port ids,
 * so `slewswitch-face-model.test.ts` asserts it EQUALS `outputs` in BOTH
 * directions and in order: a row can never name a jack that does not exist, and
 * a jack can never go missing a row. There is no count anywhere in the pair.
 *
 * Each row reads a DIFFERENT subset of the dials — see the `sidebar` note on
 * the face below, where the full reach matrix is described and asserted.
 */
export const SLEWSWITCH_OUTPUT_READOUTS: readonly {
  readonly port: string;
  readonly valueId: string;
}[] = [
  { port: 'out1',     valueId: 'slewswitch-slew1-settle' },
  { port: 'out2',     valueId: 'slewswitch-slew2-settle' },
  { port: 'out3',     valueId: 'slewswitch-slew3-settle' },
  { port: 'out4',     valueId: 'slewswitch-slew4-settle' },
  { port: 'switched', valueId: 'slewswitch-switched' },
  { port: 'step_idx', valueId: 'slewswitch-step-idx' },
  // Deliberately the SAME id the hero's `lap` row prints: the EOC period IS the
  // lap, and publishing it twice under two names would be two copies of one
  // derivation (the buggles `woggle` precedent, which shares an id likewise).
  { port: 'eoc',      valueId: 'slewswitch-lap' },
];

export const slewSwitchDef: AudioModuleDef = {
  type: 'slewSwitch',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'slewswitch',
  category: 'utility',
  inputs: [
    { id: 'in1',        type: 'cv' },
    { id: 'in2',        type: 'cv' },
    { id: 'in3',        type: 'cv' },
    { id: 'in4',        type: 'cv' },
    { id: 'step_clock', type: 'gate', edge: 'trigger' },
    { id: 'reset',      type: 'gate', edge: 'trigger' },
    // CV → AudioParam routings (engine sums the cv into these AudioParams).
    // slew*: log because time constants span 3 decades (1ms..5s).
    { id: 'slew1_cv',   type: 'cv', paramTarget: 'slew1', cvScale: { mode: 'log' } },
    { id: 'slew2_cv',   type: 'cv', paramTarget: 'slew2', cvScale: { mode: 'log' } },
    { id: 'slew3_cv',   type: 'cv', paramTarget: 'slew3', cvScale: { mode: 'log' } },
    { id: 'slew4_cv',   type: 'cv', paramTarget: 'slew4', cvScale: { mode: 'log' } },
  ],
  outputs: [
    { id: 'out1',     type: 'cv' },
    { id: 'out2',     type: 'cv' },
    { id: 'out3',     type: 'cv' },
    { id: 'out4',     type: 'cv' },
    { id: 'switched', type: 'cv' },
    { id: 'step_idx', type: 'cv' },
    { id: 'eoc',      type: 'gate', edge: 'trigger' },
  ],
  params: [
    { id: 'slew1',     label: 'S1',    defaultValue: 0.5,  min: 0.001, max: 5,   curve: 'log',      units: 's' },
    { id: 'slew2',     label: 'S2',    defaultValue: 0.5,  min: 0.001, max: 5,   curve: 'log',      units: 's' },
    { id: 'slew3',     label: 'S3',    defaultValue: 0.5,  min: 0.001, max: 5,   curve: 'log',      units: 's' },
    { id: 'slew4',     label: 'S4',    defaultValue: 0.5,  min: 0.001, max: 5,   curve: 'log',      units: 's' },
    // ⚠ THE TWO ROSTERS ARE THE STOP-2 ANSWER, not decoration (PF-1). Both of
    // these are cycling BUTTONS on the legacy card, and their captions
    // (`['→ FWD', '⇄ PND', '? RND']`, `LEN n`) were hardcoded in card markup
    // the migrated shell cannot see. `ParamDef.options` is the documented cure
    // for exactly that — "the mode 0/1/2 → LP/HP/BP mapping the legacy cards
    // hardcoded in their own markup and the migrated shell had no way to see,
    // so a filter's type read as a rotary printing 0.00". Without these,
    // promoting this module would have replaced three NAMED scan patterns with
    // an unlabelled 0..2 dial.
    //
    // VERIFIED AT THE CONSUMER rather than assumed (CLAUDE.md: "before fixing a
    // declaration to satisfy a gate, check the consumer reads it"):
    // `paramCellKind` returns 'segmented' for a roster of <= 6 at the DOCK tier
    // and 'knob' at every lane tier, and ModuleShell's `segmented` branch
    // renders `<Segmented segments={pd.options ?? []}>`. So these paint, and
    // they paint only where there is room.
    //
    // Cosmetic, NOT contract: `contract-signature.ts` projects only
    // id/min/max/curve/defaultValue/units, so naming a value cannot move
    // contract-lock.txt. Confirmed — `task docs:check` is unchanged by this.
    {
      id: 'mode', label: 'Mode', defaultValue: 0, min: 0, max: 2, curve: 'discrete',
      options: [
        { value: 0, label: 'FWD', title: 'Forward — 0→1→2→3→0…, wrapping at the top' },
        { value: 1, label: 'PND', title: 'Pendulum (ping-pong) — 0→1→2→3→2→1→0…, turning around at both ends' },
        { value: 2, label: 'RND', title: 'Random — a fresh channel on every clock, never repeating the previous one' },
      ],
    },
    {
      id: 'length', label: 'Len', defaultValue: 4, min: 1, max: 4, curve: 'discrete',
      options: [
        { value: 1, label: '1', title: 'Hold channel 1 — the switch stops scanning' },
        { value: 2, label: '2', title: 'Scan channels 1–2' },
        { value: 3, label: '3', title: 'Scan channels 1–3' },
        { value: 4, label: '4', title: 'Scan all four channels' },
      ],
    },
    { id: 'xfadeTime', label: 'Xfd',   defaultValue: 0.05, min: 0.001, max: 2,   curve: 'log',      units: 's' },
  ],

  face: {
    // THE RANKING, and it would be wrong for a different module.
    //
    // ⚠ THE FOUR SLEW DIALS LOOK INTERCHANGEABLE AND ARE NOT, which is the one
    // thing that makes this ranking defensible rather than declaration order
    // with a story attached. `advance()` scans channels 0..length-1, so LENGTH
    // decides which channels are in the lap at all — and it counts UP from
    // channel 1. Channel 1 is in the scan at ALL FOUR length settings, channel
    // 2 at three of them, channel 3 at two, channel 4 only at length 4. RESET
    // also returns to channel 1, and length 1 HOLDS channel 1. So the channels
    // carry a real, measured inclusion order and the ranking is that order —
    // not a coin toss dressed up. (fourplexer's four inputs genuinely ARE
    // symmetric: it has no LENGTH, so this argument does not transfer, which is
    // the test of whether it is an argument at all.)
    //
    //   1-4 S1..S4 — the slew half. It is UNCONDITIONALLY APPLICABLE: the four
    //     lag processors run on whatever is patched, with no other cable
    //     required, and out1..out4 are live regardless of the switch. Each dial
    //     reaches exactly one channel and nothing else — measured through the
    //     def's own factory, slew1_cv moves out1 by 1.1156e+0 and out2/out3/out4
    //     by 0.0000e+0. Ranked above the whole switch half for the reason
    //     below.
    //   5 LENGTH — the first switch control, and the most consequential: it is
    //     the only one that can stop the scan entirely (at 1 the switch holds
    //     channel 1 and EOC never fires), it decides which channels are in the
    //     rotation, and it rescales `step_idx` — measured 4 levels at length 4,
    //     3 at 3, 2 at 2, and a flat 0 at 1.
    //   6 MODE — the scan PATTERN. Below LENGTH because LENGTH can make MODE
    //     irrelevant and not the reverse: at length 1 all three modes hold
    //     channel 1. Measured over 19 clocks at length 4: forward 4 EOC,
    //     pendulum 3 (period 6, not 4), random 19.
    //   7 XFADE — last, and it is the only rank here that is about REACH rather
    //     than importance. It touches ONE of the seven jacks (`switched`), it
    //     shapes nothing within a channel and nothing about the scan, and it is
    //     doubly enabler-gated: inert without a clock AND inert at length 1,
    //     because with nothing to hand off to there is no hand-off to shape.
    //
    // ⚠ THE WHOLE SWITCH HALF IS ENABLER-GATED ON A CABLE. `step_clock` is an
    // external input — this module has no internal clock — so with nothing
    // patched there, MODE, LENGTH and XFADE change nothing that leaves the box
    // (the docs say so: "Leave unpatched and the switch holds on its current
    // channel"). The slew half needs no such cable. That asymmetry is the
    // argument for ranks 1-4 over 5-7, and it is asserted rather than asserted
    // about (slewswitch-face-model.test.ts).
    //
    // Read back as a sentence: MINI gives you S1, the one channel every LENGTH
    // setting includes; COMPACT adds S2 and S3 (three cells, because this face
    // declares no glyph); the six-cell lane plate reaches S4 and LENGTH; and
    // only the DOCK shows MODE and the crossfade.
    order: ['slew1', 'slew2', 'slew3', 'slew4', 'length', 'mode', 'xfadeTime'],

    // TWO PAGES, and this is the genuine two-engine split the module is named
    // for: the slew half acts WITHIN one channel, the switch half acts BETWEEN
    // channels. Nothing on page 1 changes which channel you hear and nothing on
    // page 2 changes what any channel does.
    //
    // ⚠ `order` AND `pages` PRODUCE THE SAME SEQUENCE HERE, and that is stated
    // rather than dressed up as a designed tension (the buggles precedent).
    // Priority and signal order coincide because the module's signal order IS
    // "condition the four voltages, then scan them" — the same fact that ranks
    // the unconditional half above the cable-gated one.
    //
    // ROW PLAN, predicted from `cellWidthClass`: `switch` carries two
    // `segmented` cells (LENGTH and MODE both declare an `options` roster) and
    // segmented is classified WIDE, so that band is SOLO and the two bands take
    // two rows. That is a consequence of the rosters, not a layout choice — the
    // classifier reads the same declaration the shell renders from.
    pages: [
      { id: 'slew', label: 'slew', controls: ['slew1', 'slew2', 'slew3', 'slew4'] },
      { id: 'switch', label: 'switch', controls: ['length', 'mode', 'xfadeTime'] },
    ],

    // ⚠ NO GLYPH, AND IT IS A MEASUREMENT RATHER THAN AN OMISSION — the
    // ninelives hazard on a module with SEVEN jacks.
    //
    // `glyphBinding` resolves the tap from the def alone, and every route ends
    // in the same place here. `primaryAudioOutPortId` is "the first declared
    // `audio` output"; this module declares SIX `cv` outputs and ONE `gate`,
    // and NO `audio` output at all, so it returns NULL — the ninelives case
    // exactly. With no audio out, the `if (audioOut) return live-audio`
    // short-circuit never fires, and the remaining branches each need a param
    // this module does not have: 'envelope' wants attack/decay/sustain/release,
    // 'algorithm' wants an `algorithm` param, and 'waveform' wants a param
    // literally named `shape` spanning 0..2 (MODE spans 0..2 and is named
    // `mode`, so it does not match — and it should not: MODE is a switch, not a
    // morph). So 'scope', 'meter', 'waveform', 'envelope' and 'algorithm' ALL
    // resolve `{ kind: 'static' }` — a deterministic fake trace, tapping
    // nothing, that is not this module. ninelives at least had a `shape` param
    // to make a `wave-morph` honest; here there is no honest picture available.
    //
    // Every branch is a permanent leg of `slewswitch-face-model.test.ts`,
    // including the control that each candidate glyph WOULD have resolved
    // `static`, so the 'none' is a decision rather than an omission. It also
    // buys a cell: `faceTierCap` gives compact 2 WITH a glyph and 3 without, so
    // declining the picture is what puts S3 on the tile.
    glyph: 'none',



    // No `title`, no `hint`, no band hints — owner ruling 2026-08-11: plain
    // labels and values on the face; the explanation lives in `docs`, one
    // right-click away.

    // REAR CARD — a PROJECTION of `face.pages`, re-derived on paper. The four
    // `slew<N>_cv` holes have stem `slew<N>`, which ARE params on the `slew`
    // page, so they land in that band on their own. Everything else is an
    // orphan — `in1..in4`, `step_clock` and `reset` have no param of that name
    // — and would all fall together into one leading band, which mixes the two
    // things a patcher most needs to tell apart here.
    //
    // The two curated groups split them by WHAT THE HOLE IS, and the split is
    // the audit's own finding: `in1..in4` are the SIGNALS being smoothed, not
    // knob modulators. They publish a raw node input with NO AudioParam behind
    // them (verified off the live handle, not assumed), which is why they are a
    // named `PASSTHROUGH_BY_DESIGN` entry in cv-scale-registry while the four
    // `slew<N>_cv` holes carry `cvScale`. Two jacks that both take a cv cable
    // and mean completely different things by it.
    //
    // ⚠ A CURATED GROUP MUST CLAIM THE LEADING SLOT OR NAME A REAL PAGE — a
    // third id appends as a STRAY band after every page, where the totality
    // gate cannot see it (module-face-lint says so by name). So there are
    // exactly two: `signal` takes the leading slot for the four smoothed
    // inputs, and the two triggers join the `switch` PAGE band, which is where
    // they belong anyway — `step_clock` and `reset` are the only two holes that
    // drive the scan, and the scan's three dials are already that band.
    rear: {
      groups: [
        { id: 'signal', label: 'smoothed, not scaled', ports: ['in1', 'in2', 'in3', 'in4'] },
        { id: 'switch', label: 'drives the scan', ports: ['step_clock', 'reset'] },
      ],
    },
  },

  docs: {
    explanation:
      "Two CV utilities in one: a four-channel SLEW LIMITER and a 4-to-1 sequential SWITCH. The slew side smooths each of the four CV inputs independently — its per-channel slew time is the TIME CONSTANT of a one-pole glide, so the output covers 63% of the distance to a new value in that time and settles (99%) in about five times it (a portamento / lag for pitch, an envelope-rounder for gates, a smoother for any steppy CV). The switch side scans those same four slewed channels one at a time: each rising edge at the CLOCK input advances the selection, and the SWITCHED output carries whichever channel is currently chosen (with an equal-gain crossfade between channels, so the hand-off moves straight from one level to the other without overshooting either). The scan can run forward, pendulum (ping-pong) or random, over a settable length of 1-4 steps; a STEP IDX output and an end-of-cycle pulse round it out. The four direct OUT jacks are always live regardless of the switch. The slew + switch math runs in a DSP worklet.",
    inputs: {
      in1: "Channel 1 CV input into the slew limiter (smoothed by the S1 time). Available at OUT 1 and selectable by the switch.",
      in2: "Channel 2 CV input into the slew limiter (smoothed by S2).",
      in3: "Channel 3 CV input into the slew limiter (smoothed by S3).",
      in4: "Channel 4 CV input into the slew limiter (smoothed by S4).",
      step_clock: "The switch advance clock — each rising edge steps the 4-to-1 sequential switch to the next channel (per the Mode and Len settings). Leave unpatched and the switch holds on its current channel.",
      reset: "Resets the switch index back to channel 0 on each rising edge, re-syncing the scan to the start of its cycle.",
      slew1_cv: "CV that sums into the S1 slew-time amount (log-scaled), modulating how fast channel 1 glides.",
      slew2_cv: "CV that sums into the S2 slew-time amount (log-scaled).",
      slew3_cv: "CV that sums into the S3 slew-time amount (log-scaled).",
      slew4_cv: "CV that sums into the S4 slew-time amount (log-scaled).",
    },
    outputs: {
      out1: "Channel 1 slewed CV — in1 smoothed by the S1 slew time. Always live, independent of the switch.",
      out2: "Channel 2 slewed CV (in2 smoothed by S2).",
      out3: "Channel 3 slewed CV (in3 smoothed by S3).",
      out4: "Channel 4 slewed CV (in4 smoothed by S4).",
      switched: "The 4-to-1 switch output: the slewed signal of the currently-selected channel, with an equal-gain crossfade (the Xfd time) on each switch so transitions don't click. Equal-GAIN rather than equal-power because these are CV levels, not uncorrelated audio: the two channels' voltages are interpolated straight from one to the other, so the hand-off never reaches a value neither channel carried, and two channels sitting at the same level hand off perfectly flat.",
      step_idx: "The current switch index as a CV, mapped to -1..+1 across the active channels — for driving a display or for downstream addressing of the scan position.",
      eoc: "End-of-cycle: a short (~5 ms) gate pulse each time the switch WRAPS back to channel 0 (in random mode it pulses on every step). Chain it to another clock/reset to daisy-chain cycles.",
    },
    controls: {
      slew1: "Channel 1 slew TIME CONSTANT, log 0.001..5 s (default 0.5 s). It is the tau of a one-pole glide, not the arrival time: OUT 1 covers 63% of the distance to a new value in this time, 90% in 2.3x it, and settles (99%) in about 5x it — so the shipped 0.5 s reaches its target in ~2.3 s and the 5 s maximum takes ~23 s. Short = snappy/near-instant, long = a slow lag/portamento. Sums with the S1 CV input.",
      slew2: "Channel 2 slew time constant, log 0.001..5 s (default 0.5 s) — the same one-pole tau as S1 (63% in tau, ~99% in 5x tau). Sums with the S2 CV input.",
      slew3: "Channel 3 slew time constant, log 0.001..5 s (default 0.5 s) — the same one-pole tau as S1. Sums with the S3 CV input.",
      slew4: "Channel 4 slew time constant, log 0.001..5 s (default 0.5 s) — the same one-pole tau as S1. Sums with the S4 CV input.",
      mode: "The switch scan pattern (a cycling button on the faceplate): FWD = forward 0→1→2→3→0…, PND = pendulum / ping-pong 0→1→2→3→2→1→0…, RND = random (a new channel each clock, never repeating the previous). Default FWD.",
      length: "How many channels the switch scans, 1-4 (a cycling LEN button). A length of 2, for example, ping-pongs/cycles only channels 0-1 and ignores 2-3. Default 4.",
      xfadeTime: "The equal-gain crossfade time applied to the SWITCHED output when the selection changes, log 0.001..2 s (default 0.05 s). Short = a tight switch, long = a slow morph between the two channels' values. It is the only control that shapes what happens BETWEEN two channels rather than within one.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // Seed each instance's PRNG from a hash of node.id so two SLEWSWITCH
    // instances in the same patch make independent (deterministic) random
    // selections — same precedent BUGGLES uses.
    let seed = 0;
    for (let i = 0; i < node.id.length; i++) {
      seed = ((seed << 5) - seed + node.id.charCodeAt(i)) | 0;
    }
    seed = (seed >>> 0) || 1;

    const workletNode = createWorkletNode(node, ctx, 'slewswitch', {
      numberOfInputs: 6,
      numberOfOutputs: 7,
      outputChannelCount: [1, 1, 1, 1, 1, 1, 1],
      processorOptions: { seed },
    });

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of slewSwitchDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map([
        ['in1',        { node: workletNode, input: 0 }],
        ['in2',        { node: workletNode, input: 1 }],
        ['in3',        { node: workletNode, input: 2 }],
        ['in4',        { node: workletNode, input: 3 }],
        ['step_clock', { node: workletNode, input: 4 }],
        ['reset',      { node: workletNode, input: 5 }],
        // CV → AudioParam fast paths.
        ['slew1_cv',   { node: workletNode, input: 0, param: params.get('slew1')! }],
        ['slew2_cv',   { node: workletNode, input: 0, param: params.get('slew2')! }],
        ['slew3_cv',   { node: workletNode, input: 0, param: params.get('slew3')! }],
        ['slew4_cv',   { node: workletNode, input: 0, param: params.get('slew4')! }],
      ]),
      outputs: new Map([
        ['out1',     { node: workletNode, output: 0 }],
        ['out2',     { node: workletNode, output: 1 }],
        ['out3',     { node: workletNode, output: 2 }],
        ['out4',     { node: workletNode, output: 3 }],
        ['switched', { node: workletNode, output: 4 }],
        ['step_idx', { node: workletNode, output: 5 }],
        ['eoc',      { node: workletNode, output: 6 }],
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
