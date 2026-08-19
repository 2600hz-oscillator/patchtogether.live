// packages/web/src/lib/audio/modules/moog911.ts
//
// MOOG 911 ENVELOPE GENERATOR — Moog System 55/35 contour generator.
//
// Slice of the Moog System 55 / 35 clone initiative (.myrobots/MOOG/),
// after the 921 VCO. The 911 ships in BOTH systems (S35 ×3, S55 ×6), so
// like the 921 it's categorized under Ports → moogafakkin (the shared bucket).
//
// NOT a literal ADSR — the 911 is a three-time-constant CONTOUR generator
// with a single sustain LEVEL:
//   On S-trigger (gate high): ATTACK over T1 to peak (1.0) → INITIAL DECAY
//   over T2 down to Esus → hold at Esus while the gate is held.
//   On release (gate low): FINAL DECAY over T3. Trigger-close forces T3
//   regardless of the current stage.
//
// DSP: own-code exponential-segment contour generator
// (packages/dsp/src/moog911.ts) — permissive, not a port of any Moog
// schematic or copyleft source. Loosely
// modelled on the repo's `adsr` (gate-driven, unipolar 0..1, +inverted tap)
// but with the 911's T1→peak / T2→Esus / T3 contour, not A-D-S-R.
//
// Inputs:
//   gate (gate): S-trigger. Rising edge = ATTACK; falling edge = FINAL DECAY (T3).
//   t1_cv (cv, log, paramTarget=t1): scales the attack-time param symmetrically.
//   t2_cv (cv, log, paramTarget=t2): scales the initial-decay-time param.
//   esus_cv (cv, linear, paramTarget=esus): displaces the sustain level (0..1).
//   t3_cv (cv, log, paramTarget=t3): scales the final-decay-time param.
//
// Outputs:
//   env (cv): the contour, 0..1.
//   env_inv (cv): 1 - env — the inverted tap for ducking / sidechain use.
//
// Params:
//   t1   (log 1e-4..10s, default 0.01): ATTACK time in seconds.
//   t2   (log 1e-4..10s, default 0.2):  INITIAL DECAY time in seconds.
//   esus (linear 0..1, default 0.6):    SUSTAIN level.
//   t3   (log 1e-4..10s, default 0.4):  FINAL DECAY time in seconds.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/moog911.js?url';

import { createWorkletNode } from '$lib/audio/worklet-guard';
// Per-context cache so addModule isn't called twice on the same context.
const loadedContexts = new WeakSet<BaseAudioContext>();

export const moog911Def: AudioModuleDef = {
  type: 'moog911',
  palette: { top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' },
  domain: 'audio',
  label: '911 eg',
  category: 'modulation',

  inputs: [
    { id: 'gate', type: 'gate', edge: 'gate' },
    // CV inputs route to the corresponding AudioParam with engine-level
    // scaling (cvScale), so a -1..+1 LFO sweeps each param's full natural
    // range centered on the user's knob position (see .myrobots/plans/
    // cv-range-standard.md). T-times use log scaling (their range spans
    // log decades); Esus is unipolar 0..1 so it uses linear scaling.
    { id: 't1_cv',   type: 'cv', paramTarget: 't1',   cvScale: { mode: 'log' } },
    { id: 't2_cv',   type: 'cv', paramTarget: 't2',   cvScale: { mode: 'log' } },
    { id: 'esus_cv', type: 'cv', paramTarget: 'esus', cvScale: { mode: 'linear' } },
    { id: 't3_cv',   type: 'cv', paramTarget: 't3',   cvScale: { mode: 'log' } },
  ],
  outputs: [
    { id: 'env',     type: 'cv' },
    // Inverted contour: 1 - env. Standard Eurorack semantic for unipolar
    // envelopes — ducking, reverse-modulation, "sidechain"-style use.
    // Computed per-sample in the worklet (outputs[1]).
    { id: 'env_inv', type: 'cv' },
  ],
  params: [
    { id: 't1',   label: 'T1',   defaultValue: 0.01, min: 0.0001, max: 10, curve: 'log', units: 's' },
    { id: 't2',   label: 'T2',   defaultValue: 0.2,  min: 0.0001, max: 10, curve: 'log', units: 's' },
    { id: 'esus', label: 'Esus', defaultValue: 0.6,  min: 0,      max: 1,  curve: 'linear' },
    { id: 't3',   label: 'T3',   defaultValue: 0.4,  min: 0.0001, max: 10, curve: 'log', units: 's' },
  ],

  // ── THE FACEPLATE (PF-20) ────────────────────────────────────────────────
  //
  // WHAT THE 911 IS FOR. It is the rack's only THREE-TIME-CONSTANT contour
  // generator: not attack-decay-sustain-release but rise -> settle -> (hold) ->
  // fall, where the level it settles to is its own control. The verb a player
  // performs is SHAPING THE FRONT OF A NOTE — how fast it arrives, how fast it
  // backs off, and where it sits while the key is down. The one thing it does
  // that `adsr` does not: its settle TIME and its sustain LEVEL are COUPLED, so
  // moving the level re-times the stage.
  //
  // THE RANKING, and it is a measurement rather than a preference. Every number
  // is from the SHIPPING worklet class at 48 kHz, held gate, read at the exact
  // sample each stage's own exit condition latches (#1889;
  // art/scenarios/moog911/face-audit.test.ts is the permanent anchor):
  //
  //   1 T1    UNCONDITIONAL APPLICABILITY. Every gate, however short, runs
  //           ATTACK. Under a TRIGGER-length gate — 1 ms, which is exactly what
  //           this module's own bank-mate the 911A emits — the contour never
  //           reaches peak, so DECAY never runs at all and T1 is the only time
  //           control shaping anything before the release. Peak from a 1 ms
  //           pulse: 1.0000 / 0.9933 / 0.3935 / 0.0488 / 0.0050 at T1 =
  //           0.0007238 / 0.001 / 0.01 (the DEFAULT) / 0.1 / 1. Full opening
  //           needs T1 <= 0.724 ms — the bottom 17.2 % of a five-decade dial.
  //   2 ESUS  THE ONLY CONTROL THAT CHANGES THE MEANING OF ANOTHER CONTROL.
  //           Holding T2 at its default and sweeping ESUS moves the delivered
  //           decay 276.313 -> 262.063 -> 239.667 -> 92.104 -> 0.021 ms while
  //           the T2 dial reads 200.000 at every one of them, and it alone
  //           picks the contour's shape class (pluck at 0, plateau at 1).
  //           ⚠ THE SAME ARGUMENT WOULD BE WRONG FOR `adsr`, which is what
  //           makes it an argument: `adsr.dsp:13` is `en.adsr(...)`, the Faust
  //           stdlib's LINEAR-segment envelope, whose decay segment takes
  //           exactly `decay` seconds at any sustain level. The coupling is a
  //           property of THIS module's exponential-with-fixed-threshold
  //           design, not of envelopes.
  //   3 T2    the settle slope — real, and second to the level that re-times it.
  //   4 T3    last, because it is the only control that needs the gate to have
  //           already FALLEN. Nothing it does is visible while a key is held.
  //
  // ⚠ INERTNESS CANNOT DISCRIMINATE THIS RANKING, and saying so is part of the
  // audit rather than an omission from it. With the `gate` jack unpatched,
  // sweeping EACH of the four across its full declared range leaves BOTH
  // outputs BIT-IDENTICAL to the default render — all four are dead at spawn,
  // so #1758's "sample AT the declared value" habit finds four dead knobs here
  // and separates none of them. Positive control: with the gate held, T1, T2
  // and ESUS all move the output and T3 correctly does not.
  //
  // TIER LADDER AS A SENTENCE. With `glyph: 'none'` the compact cap is
  // LANE_ROW_MAX_CELLS = 3, so: at mini you get the ATTACK; at compact the
  // attack, the level and the settle; at plate and dock all four. Ranks 1-3 are
  // the entire lane budget and T3 is effectively dock-only.
  //
  // ⚠ `order` AND `pages` DISAGREE, DELIBERATELY. `order` is PRIORITY, so it
  // interleaves the level between the times (T1, ESUS, T2, T3) — that is the
  // sequence the tiers truncate. `pages` is SIGNAL ORDER, so it separates by
  // KIND: three log seconds in one band, one linear ratio in the other. The
  // `level` band is a single control and earns its header on the skill's "1
  // that is the module's identity" clause — three time constants and ONE level
  // is what a 911 IS, and it is the whole difference from an ADSR.
  //
  // GLYPH: 'none', and it is the only correct declaration rather than a
  // shrug. `primaryAudioOutPortId` matches `type === 'audio'` and BOTH of this
  // module's outputs are `cv`, so it returns null and every glyph kind except
  // 'envelope' falls through to `{kind:'static'}` — the dead-glyph state.
  // ⚠ AND 'envelope' DOES NOT RESCUE IT: `glyphBinding` resolves `env-params`
  // only for a def carrying four params literally NAMED attack/decay/sustain/
  // release, and this module's are t1/t2/esus/t3 BY DESIGN. Renaming them to
  // satisfy the resolver is CLAUDE.md's "check the consumer reads it" inverted.
  // Filed as #1888 — an ENABLER, not a blocker. ⚠ Read the comment on that
  // issue before implementing it: a role mapping ALONE would feed the drawing
  // the DIAL times, and `envelopeCurvePoints` normalises to their sum, so the
  // picture would restate exactly the defect the readouts below exist to
  // expose (at ESUS 0.999 it would draw a settle ramp a quarter of the screen
  // wide for a stage that lasts 0.021 ms).
  //
  // NO SIDEBAR, decided rather than skipped: `face.sidebar` is the one
  // contract-PROJECTED field of `face`, and it is also what scales
  // `faceplate-platform.spec.ts`'s `sweepBudgetMs(adopterCount)`. Everything a
  // sidebar would say here is a number, and a number belongs in the readout row.
  //
  // NO `bareCells`: under a `times` heading, T1/T2/T3 are the ONLY thing
  // separating three identical log knobs — the tidyVco A/D/S/R case the owner
  // explicitly KEPT, not the mixmstrs `1LO..8LO` case he removed.
  //
  // REAR CARD: checked against `rearFieldPlan` rather than authored. The four
  // `_cv` holes carry `paramTarget`, so each lands in its own param's page
  // section; `gate` has no `paramTarget` and therefore takes the VOICE/SIGNAL
  // slot, which is the derived default and not an orphan. Both outputs are one
  // cable domain, so the outputs take their derived single section too. Nothing
  // to declare — `face.rear.groups` would only restate it.
  face: {
    order: ['t1', 'esus', 't2', 't3'],

    pages: [
      {
        id: 'times',
        label: 'times',
        hint: 'rise, settle and fall — each a TIME CONSTANT, not a duration',
        controls: ['t1', 't2', 't3'],
      },
      {
        id: 'level',
        label: 'level',
        hint: 'where the contour sits while the gate is held — and it re-times T2 and T3',
        controls: ['esus'],
      },
    ],

    glyph: 'none',

    // THE HERO: three derived readouts and NO promoted control — the readouts
    // ARE the finding, and promoting T1 out of `times` would split the three
    // dials whose side-by-side disagreement with these three numbers is the
    // whole point. (The readouts-only hero is the `moog914` / `moog907a` /
    // `attenumix` shape, and two of those are this module's own bank.)
    //
    // Each prints what its dial does NOT: the delivered duration, in a
    // five-decade ladder. At the defaults `13.83 ms / 240 ms / 696 ms` against
    // dials reading 10 / 200 / 400, summing to 949 ms against 610.
    //
    // The three are EACH OTHER'S negative controls on every render, which is
    // what makes this more than a relabelled knob: `rise` is EXACTLY invariant
    // to ESUS (its gap ratio is a constant 1000) while `settle` and `fall` are
    // both functions of it. The permanent legs live in
    // moog911-face-model.test.ts, and the closed forms are re-derived from the
    // shipping DSP in art/scenarios/moog911/face-audit.test.ts.
    hero: {
      readouts: [
        { label: 'rise', valueId: 'moog911-rise' },
        { label: 'settle', valueId: 'moog911-settle' },
        { label: 'fall', valueId: 'moog911-fall' },
      ],
    },
  },

  docs: {
    explanation:
      "A clean-room recreation of the Moog 911 Envelope Generator — the classic Moog 'contour generator', NOT a literal ADSR. It's a unipolar (0..1) envelope shaped by three time constants and one sustain LEVEL: when the TRIG gate goes high it rises to full over the ATTACK time (T1), then falls to the SUSTAIN level over the INITIAL-DECAY time (T2) and holds there for as long as the gate stays high; when the gate falls it returns to zero over the FINAL-DECAY time (T3). So the contour is attack → initial-decay-to-sustain → (hold) → final-decay, rather than A-D-S-R. Patch the OUT envelope into a VCA or filter cutoff to shape a note, and use the inverted OUT to duck or sidechain. Mental model: a transient-shaping contour fired by a gate, with separate up/settle/release slopes and a held middle.",
    inputs: {
      gate:
        "The trigger/sustain gate (an S-trigger). A rising edge starts the contour (ATTACK → INITIAL DECAY → hold at SUSTAIN); the envelope holds at the sustain level while the gate stays high, and the falling edge starts the FINAL DECAY (T3) back to zero. A short gate that falls before settling still triggers a clean release.",
      t1_cv:
        "CV that scales the ATTACK time (T1) around the knob setting: a positive voltage lengthens the rise, a negative one shortens it (log-scaled, so the full natural decade range sweeps centered on where you set the knob).",
      t2_cv:
        "CV that scales the INITIAL-DECAY time (T2) — how fast the envelope falls from its peak down to the sustain level — around the knob setting (log-scaled).",
      esus_cv:
        "CV that displaces the SUSTAIN LEVEL (Esus, 0..1) up or down from the knob position, changing the level the contour holds at while the gate is held (linear, unipolar).",
      t3_cv:
        "CV that scales the FINAL-DECAY time (T3) — the release slope back to zero after the gate falls — around the knob setting (log-scaled).",
    },
    outputs: {
      env:
        "The contour itself, a unipolar 0..1 control voltage. Patch it into a VCA's gain or a filter's cutoff to shape each note's loudness/brightness over time.",
      env_inv:
        "The inverted contour (1 − env): high when the envelope is low and vice-versa. The standard Eurorack ducking/sidechain tap — patch it into a VCA to pull a level DOWN whenever the envelope fires. Note that it therefore SITS AT FULL SCALE (exactly 1.0) at rest, with nothing patched and no gate — measured bit-exactly over a full unpatched second — so it is a live DC source the moment you patch it, not a silent jack waiting for a trigger.",
    },
    controls: {
      t1: "ATTACK time (T1): how fast the envelope rises when the gate opens — from an instant click to a slow ~10 s swell (log taper). ⚠ It is a TIME CONSTANT, not the stage's duration: the rise actually completes in T1 × 1.38, so the 10 ms default delivers 13.8 ms. It also decides whether a short TRIGGER opens the envelope at all — a 1 ms pulse (what the 911A emits) reaches only 39 % of full scale at the default, and needs T1 at or below about 0.7 ms to open the contour fully.",
      t2: "INITIAL-DECAY time (T2): how fast the envelope settles from its peak onto the SUSTAIN level after the attack completes (log taper). ⚠ Its real duration is set by SUSTAIN LEVEL as much as by this dial, because the stage ends when the envelope gets within 0.001 of the shelf: at T2 = 0.2 s the settle takes 276 ms at Esus 0, 240 ms at the 0.6 default and 92 ms at Esus 0.99, and above Esus 0.999 the contour is already there — the stage is skipped and this dial does nothing at all.",
      esus: "SUSTAIN LEVEL (Esus): the level the envelope holds at while the gate is held, from 0 (decays all the way to silence, an AD-style pluck) to 1 (holds at full, no initial decay). ⚠ It is the module's only control that changes what ANOTHER control does: it sets how far both the initial decay and the final decay have to travel, so it re-times T2 and T3 without either of those dials moving.",
      t3: "FINAL-DECAY time (T3): the release — how fast the envelope falls back to zero after the gate falls (log taper). A trigger close forces T3 from whatever stage the contour was in. ⚠ Like T2 its real duration depends on SUSTAIN LEVEL, because that is the height it falls FROM: at T3 = 0.4 s a release off the shelf takes 640 ms at Esus 0.3, 696 ms at the 0.6 default and 737 ms at Esus 1, and at Esus 0 there is nothing left on the shelf to decay (a release caught mid-attack still uses T3 normally).",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = createWorkletNode(node, ctx, 'moog911', {
      numberOfInputs: 1,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });

    // Feed silence into the gate input so the node stays in the active
    // processing graph even when nothing's externally patched (mirrors the
    // 921 / analogVco silence-keepalive pattern).
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(workletNode, 0, 0);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of moog911Def.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['gate', { node: workletNode, input: 0 }],
        // CV → AudioParam fast-path; engine sums the scaled CV into these.
        ['t1_cv',   { node: workletNode, input: 0, param: params.get('t1')!   }],
        ['t2_cv',   { node: workletNode, input: 0, param: params.get('t2')!   }],
        ['esus_cv', { node: workletNode, input: 0, param: params.get('esus')! }],
        ['t3_cv',   { node: workletNode, input: 0, param: params.get('t3')!   }],
      ]),
      outputs: new Map([
        ['env',     { node: workletNode, output: 0 }],
        ['env_inv', { node: workletNode, output: 1 }],
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
