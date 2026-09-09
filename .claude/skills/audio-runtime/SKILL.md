---
name: audio-runtime
description: Audio-graph invariants for stereo/dual-mono ownership, trigger/gate/edge semantics, factory-vs-DSP test blindness, poly/MIDI audible-output proof, and the saved-rack param contract. Use before changing a module factory, a ParamDef, a DSP input contract, an edge/gate consumer, or the tests that cover them.
---

# Audio runtime

Recurring ways an audio change ships green and wrong. Read the seam named in
each section before changing it; the code carries the derivation, and the ADR
named at the head of a section carries the why.

## Stereo and dual-mono ownership

The why is `docs/adr/008-stereo-as-dual-mono.md`.

- A def with exactly ONE audio-typed input is wrapped: the engine runs its DSP
  TWICE, one instance per channel, so stereo survives a mono module. 2× CPU is
  the accepted price. Classification is by what a module IS
  (`dualMonoClassOf` / `SCOPE` in `packages/web/src/lib/audio/dual-mono.ts`),
  never a runtime "is this really stereo?" guess — that heuristic is banned by
  name and its removal is asserted, not just its absence.
- `ChannelSplitter` is `channelInterpretation: 'discrete'`, and discrete up-mix
  ZERO-FILLS. A 1-channel signal straight into a splitter measures L 0.5 / R 0,
  which is how a whole rack becomes left-only. Put the `speakers`-law upmix
  GainNode before the splitter; both legs are pinned permanently in
  `art/scenarios/stereo-dual-mono/`.
- `mono-fanout` keeps its leg inputs for LEVEL, not width: one instance still
  needs the two cables of a stereo→mono patch on separate legs, or Web Audio
  sums them to L+R instead of (L+R)/2 — up to 6 dB hot.
- Every audio cable is a leg group and one planner writes it:
  `packages/web/src/lib/graph/stereo-autowire.ts`. Owner-locked matrix — mono→
  stereo DOUBLE-PATCHES the single out into both legs; stereo→mono sends BOTH
  legs in (never a sum, never one). A gesture that writes edges without this
  planner ships the half-patched cable. Pairing comes from
  `$lib/graph/stereo-pairs`, which answers TWO questions through two entry
  points that must not be merged: COLLAPSE (`derivedStereoPairs` /
  `stereoPairForPort`, exemptions APPLIED — "render as one jack?") and WIRING
  (`allStereoPairs` / `wiringPairForPort`, exemptions NOT applied — "does
  patching this port imply a second cable?", the one `stereo-autowire.ts`
  reads). Never re-derive a pair from a port name, and read BOTH exemption
  lists: `COLLAPSE_EXEMPT` (rings `odd+even` are two timbre taps, not one
  image — spectrally disjoint combs, 84 dB apart at the worst measured bin per
  `packages/web/src/lib/ui/workflow/strict-faces.ts:594`, which corrects the
  spec's "116 dB, every bin"; two jacks, but the declared tuple still
  autowires) and `MONO_AUDIO_POINT_MODULES` (the ES-9's independent physical
  jacks take at most one leg).
- Two output PortDefs must not share one 2-channel node. Map them to
  `createChannelSplitter(2)` outputs 0 and 1; a shared node collapses both jacks
  to mono, and a mono source makes that inaudible.

## Trigger, gate and edge semantics

The rule is AGENTS.md boundary 7; the why is
`docs/adr/009-gate-carries-timing-only.md`.

- AGENTS.md boundary 7. Main-thread edge detection goes through
  `createEdgeCounter` (`packages/web/src/lib/audio/edge-detect.ts`), which owns
  the window math: the scheduler tick is ~25 ms and an `AnalyserNode` ring is
  2048 samples (~42 ms @ 48 kHz), so a whole-buffer rescan re-presents the same
  edge on the next tick and one clock pulse advances a sequencer two steps.
  Worklet consumers are exempt (per-sample compare is correct by construction).
  Gate consumers stay level-sensitive — never convert one to edge-only.
- `edge-detect-guard.test.ts` scans exactly one module file
  (`for (const file of ['numpad-plus.ts'])`). It is a regression guard, not a
  census: hand-rolled analyser scans still exist elsewhere —
  `packages/web/src/lib/audio/modules/score.ts` taps its external clock
  directly and gets the window math right (`start = clockInBuffer.length -
  newSamples`, cursor advanced at the end of the scan), but it is outside the
  seam, so the guard says nothing about it. Grep before assuming coverage, and
  check each hand-roll's `start` rather than its existence.
- Thresholds are named constants in `packages/web/src/lib/audio/gate-trigger.ts`
  (`GATE_HI`/`GATE_LO` 0.5, `TRIGGER_PULSE_S` 5 ms, `DEFAULT_GATE_LEN_S`). A
  bare `0.5` in a DSP file is a mirror-by-value that drifts.
- Pulse width is a contract. A triangle trigger exceeds 0.5 for only the middle
  half of its envelope (~2.5 ms of 5 ms ≈ 120 samples), which is under one
  128-sample render quantum — a per-block main-thread reader can miss it
  entirely, and anything level-sensitive sees half the area of a square.
- Where the envelope is Faust `en.adsr`, timing is gate-LEVEL dependent: a short
  gate truncates the decay, so gate length IS note length and an audition seam
  must take the DSP's edge shape (a held `manualGate`, not a trigger blip).
- Do not derive gate width from the scheduler tick or from a `bpm` param while
  an external clock is driving; both are live defects today
  (`packages/web/src/lib/audio/modules/cartesian.ts`
  `gateDur = Math.max(0.01, elapsed)`,
  `packages/web/src/lib/audio/modules/kria.ts` `stepDur = 60/bpm/4`)
  and fixing either changes the sound of saved racks — owner audition first.
- Per-sample edge detection is right for COUNTING and insufficient for a
  LATCHING consumer: a `max(a, b)` OR of two sources discards overlapping edges
  and a single `wasHigh` latch jams on a held gate.
- `PortDef.edge` is only `'trigger' | 'gate'`; the docs sentence for each port is
  lint-enforced per-port against `TRIGGER_VOCAB`/`GATE_VOCAB` in
  `packages/web/src/lib/docs/module-docs-lint.test.ts`.

## Factory-vs-DSP test blindness

The engine wrapper and the module factory are two different layers, and most
lanes see only one of them. Before trusting a green suite, name which layer it
drove — then read [measuring audio](references/measuring-audio.md).

- ART's `renderOfflineDef`, unit tests calling `def.factory(...)`, and the video
  worker proxy all bypass `AudioEngine.addNode`, so none of them can observe
  dual-mono (`SCOPE.bypassedBy` states this in the source).
- ART scenarios that instantiate the processor class or a pure-TS mirror bypass
  the FACTORY, so none of them can observe a factory that defeats its own DSP.
  Five modules declared a mono normal (`inputs[1]?.[0] ?? inputs[0]?.[0]`) and
  killed it in the factory — four by pinning a 0-valued "liveness"
  ConstantSource to worklet input 1, because a connected input is never absent
  and the `??` can never fall through. OUT R read exactly 0.0000.
  `e2e/tests/stereo-mono-normal.spec.ts` is the only place the real factory,
  real worklet and a real cable meet; `mono-normal-not-defeated.test.ts` is its
  source-level counterpart.
- Before adding a keep-alive pin, check what presence check it makes inert.
  Pin the minimum — `packages/web/src/lib/audio/modules/shimmershine.ts` (the
  FACTORY, not the `packages/dsp/src/shimmershine.ts` worklet of the same name)
  pins input 0 ONLY, deliberately.
- A hand-written mirror of a worklet is not a control for it. Where a mirror
  exists (`ringsMath` and friends), either pin mirror↔worklet parity or say in
  the test that users hear the other one.
- Presence is not liveness across a save/load either: assert audio at the jack
  after a load (`e2e/tests/samsloop-load-audible.spec.ts`), not that a node
  exists.

## Poly and MIDI audible output

The rule is AGENTS.md boundary 8; the why is
`docs/adr/009-gate-carries-timing-only.md`.

- AGENTS.md boundary 8. Ship an e2e that wires the REAL default-mode source
  through the module to an audible-output assertion. The rule exists because a
  poly module shipped green and silent: ART, behavioural and per-port coverage
  all drove the engine class with a synthetic note source while the real
  MIDI-lane→module chain was dead.
- The rule forbids engine-direct testing, not a particular cable. For a module
  with no `poly` port whose voices are struck by trigger edges, the real source
  is a real sequencer's trigger output — see
  `e2e/tests/samsloop-poly-source-chain.spec.ts`, which also carries the
  permanent negative control (no cable → must read zero), without which "the
  module sounds" and "the meter is stuck high" print identically.
- Observation is a bounded condition, not a fixed window. A gated voice cannot
  sound until the main-thread step scheduler ticks past its lookahead, and the
  tick count inside a wall-clock window is a property of the runner; observe
  UNTIL audible with a cap that bounds the failure, and sample inside the page
  (`e2e/tests/adsr-poly-midilane.spec.ts` records a 600 ms "window" collapsing
  to one 42 ms peek, twice, from a Playwright-side poll loop).
- Overlapping voices are resolved at scheduling time by voice ownership
  (`assignPolyLanes` / `PolyLaneBook` in
  `packages/web/src/lib/audio/modules/clip-types.ts`), not by a playback-time
  guess. Live audition, recording and playback must share one gate model.

## Changing a ParamDef changes every saved rack

A saved rack is a bare `Record<string, number>` with no migration substrate, so
every param edit is a silent rewrite of racks you cannot see. ADDING a param is
safe only where its default reproduces today's behaviour.

- Never RENUMBER a discrete selector. Every saved rack silently repatches and
  nothing can detect it — append and grow the max instead
  (`packages/web/src/lib/audio/modules/macro-engine-roster.ts:69`, whose
  `MACRO_MAX_MODEL` derives from the roster length; `warrensspectrum.ts:549`
  applies the same rule to a two-position engine switch).
- Never NARROW a range: the AudioParam clamps in silence, so a saved 0.9 opens
  as 0.5 with no marker. Widen only.
- Never RE-INTERPRET an existing id. The value is legal, so nothing clamps and
  nothing warns — only the sound changes. A param that silently re-interprets a
  saved value is worse than one that resets; ship a new id whose default
  reproduces today.

Do not create an issue unless the owner explicitly approves it.
