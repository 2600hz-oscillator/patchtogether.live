# ADR-009: Let a gate carry timing only, and own a voice by note identity

- Status: Accepted (later phases of the model unbuilt — see Consequences)
- Date: 2026-09-08 (records the owner-approved model of 2026-07-01)
- Deciders: project owner; this ADR documents the decision
- Tags: audio, dsp, semantics, poly, midi

## Context

In Eurorack a gate and a trigger are the *same* binary CV. The only difference
is time: a **trigger** is a short pulse that starts an event and the receiver
fires once on the rising edge; a **gate** is held high for as long as the event
is active and the receiver acts *while* the level is high, reacting to both
edges. The cable is identical — the consumer's interpretation differs.

Our graph had that distinction nowhere. Every module re-derived it: thresholds
were bare `0.5` literals, pulse widths were per-module constants, and "does this
port mean trigger or gate?" was answered by reading the factory. Two concrete
failures followed:

1. **Double-counted edges.** The scheduler tick is ~25 ms; an `AnalyserNode`
   ring is 2048 samples (~42 ms at 48 kHz). A consumer that re-scanned the whole
   buffer each tick re-presented the same rising edge on the next tick, so one
   clock pulse advanced a sequencer two steps.
2. **Voice glitching.** Live-keyboard voices were packed positionally into lanes
   `0..n-1` and rebuilt on every key edge, so releasing a low note shifted the
   remaining notes down a lane and rewrote pitch on a still-sounding voice.

## Decision

**A gate-typed port carries timing only. The declared semantic says how a
consumer must read it, and a voice is owned by note identity, never by lane
position.**

- **One semantic model, declared on the port.** `PortDef.edge` is
  `'trigger' | 'gate'` (`packages/web/src/lib/graph/types.ts`). It does **not**
  restrict connections — the unified `gate` cable stays cross-patchable with
  `cv`/`pitch`, because it *is* just CV. It is documentation that is lintable
  (`packages/web/src/lib/docs/module-docs-lint.test.ts` asserts each documented
  port against its declared edge vocabulary) and that the flip-side jack field
  renders as a ▲ / ▬ glyph (`packages/web/src/lib/ui/workflow/RearCard.svelte`).
  **Interpretation, not routing.**
- **One set of constants.** `packages/web/src/lib/audio/gate-trigger.ts` owns
  `GATE_HI` / `GATE_LO` (0.5), `TRIGGER_PULSE_S` (5 ms, inside the real-hardware
  1–5 ms band) and `DEFAULT_GATE_LEN_S` (50 ms for a trigger→gate widening). A
  bare `0.5` in a DSP file is a mirror-by-value that drifts.
- **One main-thread edge seam.** `packages/web/src/lib/audio/edge-detect.ts`
  `createEdgeCounter` owns the window math — it scans only the
  `elapsed × sampleRate` samples that arrived since the previous poll, so the
  ring/tick overlap cannot re-present an edge. Worklet consumers are exempt:
  per-sample compare is correct by construction. **A `gate` consumer stays
  level-sensitive** and is never converted to edge-only. This is AGENTS.md
  boundary 7; this ADR is its *why*.
- **Ownership by identity.** `packages/web/src/lib/audio/poly-alloc.ts`:
  `noteOn(key)` assigns the lowest free lane and keeps it (a re-`noteOn` of an
  owned key returns the same lane and refreshes recency); `noteOff(key)` frees
  only that note's *current* lane. On overflow the allocator LRU-steals. The
  critical edge case is release-after-steal: `noteOff` of a note whose lane was
  stolen returns `null` and the caller writes **nothing** — naively "freeing
  lane 2" would kill the stealer.

## Consequences

**Good:**

- The double-count bug class is closed at the seam rather than per module: a
  consumer cannot get the window math wrong because it no longer writes it.
- Because `edge` is interpretation and not routing, adding it to a port was
  behaviour-neutral — no existing patch changed, and the model became lintable
  (each port's docs sentence is checked against a trigger/gate vocabulary).
- Voice allocation is pure and engine-free, so the ownership map is unit-tested
  with zero Web Audio.

**Bad / load-bearing:**

- **The model is only partly built.** Phase 2b (per-voice gate-off rather than
  one `gateOffSec` for a whole poly step) is open; `packages/web/src/lib/audio/
  poly.ts` still takes a single `gateOffSec`. Phase 3 (an explicit per-lane
  voice mode, with LEGATO as the default) is unbuilt — there is no `voiceMode`
  or `'legato'` symbol anywhere in `packages/web/src`. Phase 4 (one shared pulse
  width) is unbuilt: `GATE_PULSE_S` is still re-declared per module — eight
  sites across audio and video today
  (`git grep 'GATE_PULSE_S = ' -- packages/web/src`), e.g. `modules/frogger.ts`,
  `NOTE_GATE_PULSE_S` in `modules/midi-lane.ts`, `modules/midiclock.ts`, and
  `video/modules/nibbles.ts`.
- **Two of the model's later phases lost their subject.** Its front-card glyph
  work and its step-sequencer length/tie work named modules and card components
  that no longer exist. Re-scoping those phases is an owner call, not a
  mechanical port.
- A trigger's pulse width is a real contract, not a cosmetic: a 5 ms triangle
  exceeds 0.5 for only its middle ~2.5 ms ≈ 120 samples, under one 128-frame
  render quantum, so a per-block main-thread reader can miss it entirely. The
  operational consequences of that live in the `audio-runtime` skill.
- Poly and MIDI modules therefore ship an e2e that wires the **real default-mode
  source** through the module to an audible-output assertion (AGENTS.md boundary
  8). Asserting that an edge materialises is not the same as asserting a sound.

## References

- `packages/web/src/lib/audio/gate-trigger.ts` — the semantic model and the
  canonical thresholds/waveforms.
- `packages/web/src/lib/audio/edge-detect.ts` — `createEdgeCounter`, the window
  math, and the overlap double-count it exists to prevent.
- `packages/web/src/lib/graph/types.ts` — `PortDef.edge`.
- `packages/web/src/lib/audio/poly-alloc.ts` — stable per-voice allocation and
  the release-after-steal case.
- `.claude/skills/audio-runtime` — trigger/gate judgement for a change in
  flight; AGENTS.md boundaries 7 and 8 — the rules this ADR explains.
- Provenance: the model is preserved in the `myrobots-preserved-2026-09` tag
  snapshot, as `plans/gate-heldnote-model-2026-07-01.md` (paths relative to
  the retired agent-evidence tree in that snapshot, not to the worktree).
