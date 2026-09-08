# ADR-008: Model stereo as dual mono

- Status: Accepted (two module groups deliberately deferred)
- Date: 2026-09-08 (records the owner decision of 2026-08-07)
- Deciders: project owner; this ADR documents the decision
- Tags: audio, dsp, graph, stereo

## Context

Most modules in the rack are mono DSP — a Faust `process(audio)` worklet, an
`outputChannelCount: [1]` node, a single `GainNode`. The graph, however, carries
stereo: sources emit `out_l`/`out_r`, and the terminal sink is a stereo pair.

The original design summed a stereo signal to mono the first time it met a mono
module, so patching a stereo source through a filter silently destroyed the
image. The owner reversed that on 2026-08-07: *"if we pass a stereo signal
through a module which is, at present, mono, we do not want to lose the stereo
data."*

Three options were on the table:

1. **Sum to mono** — cheapest, and the behaviour being rejected.
2. **Detect at runtime** — ask "are these two channels really the same signal?"
   and branch. This is a heuristic that fails silently and is unfalsifiable from
   the output; it was ruled out by name.
3. **Always run the DSP twice**, one instance per channel, chosen by what the
   module *is* rather than by what is flowing through it.

## Decision

**Option 3. A module with exactly ONE audio-typed input is classified in a named
ledger, and a `dual-mono` module's DSP is instantiated twice — one instance per
channel — at 2× CPU, accepted deliberately.**

Three pieces carry it, and each is a single source of truth:

- **The classification** — `packages/web/src/lib/audio/dual-mono.ts`
  (`DUAL_MONO_LEDGER`, `SCOPE`). One NAMED entry per module with a `why`, never
  a filename and never a predicate. The population is derived from the live
  registry, so an entry naming a module that no longer has exactly one audio
  input goes red like a stale VRT exemption. Six classes: `dual-mono`,
  `mono-fanout`, `native-stereo`, `sum`, `deferred`, `video-domain`.
- **The wiring** — `packages/web/src/lib/graph/stereo-autowire.ts` is the one
  commit planner every audio cable goes through. The owner-locked matrix:
  stereo→stereo writes L→L and R→R; **mono→stereo double-patches** the single
  output into both legs; **stereo→mono sends BOTH legs in** — not a sum, not
  one; mono→mono writes one leg. A writer that bypasses the planner ships
  half-patched cables.
- **The pairing** — `packages/web/src/lib/graph/stereo-pairs.ts` answers "are
  these two ports one L/R pair?" for the whole app: declared `stereoPairs` ∪ an
  id-token fallback, **audio-typed ports only**, resolved **per direction**.
  Five call sites used to answer it five different ways.

There is **no runtime stereo detection anywhere**, and
`stereo-autowire.test.ts` asserts its absence rather than only asserting the
presence of the right behaviour.

## Consequences

**Good:**

- A mono patch is untouched: the `sum` down-mix is a no-op on a 1-channel input,
  and dual-mono's up-mix passes a 1-channel signal through as before.
- The reversal deleted a whole class of code, not just changed a branch: the
  pre-reversal design carried a "same source round-tripped into a mono input"
  special case to avoid a +6 dB correlated sum. Dual-mono never sums, so the
  guard — itself a runtime correlation heuristic — was deliberately **not**
  ported.
- The hazard is pinned, not remembered: `ChannelSplitter` is spec'd
  `channelInterpretation: 'discrete'`, and **discrete up-mix zero-fills**, so a
  1-channel signal fed straight to a splitter measures L 0.5 / R 0 — how a whole
  rack becomes left-only. The fix is a `speakers`-law `GainNode` pinned to
  `channelCount = 2` *before* the splitter, and **both** legs (correct and
  buggy) are asserted permanently in `art/scenarios/stereo-dual-mono/`.

**Bad / load-bearing:**

- **2× CPU** on every wrapped module, by design.
- **The engine seam is invisible to two whole test lanes.** ART's
  `renderOfflineDef` and any unit test calling `def.factory(...)` bypass the
  wrapper entirely, so neither can catch a dual-mono regression. The ledger gate
  and the ART stereo scenario own that coverage — see the `audio-runtime` skill.
- **`mono-fanout` exists because a module's own noise can defeat dual mono.**
  `moog904a` bootstraps self-oscillation from per-sample `Math.random()` thermal
  dither, so two instances share a frequency with **independent phase**; every
  meter in the app is an `AnalyserNode`, which mono-down-mixes to
  `A·|cos(Δφ/2)|` — a fresh draw per spawn (measured: 0.0449…1.0592 built twice
  vs 1.0622 ± 7e-7 built once). Owner ruling 2026-09-04: build once and fan out.
  Reclassifying it back to `dual-mono` restores **decorrelation, not an image**.
- **Groups D and E are deferred, not solved.** Multi-tap outputs that are
  variants rather than L/R (`vca`, `moog902`, `rings`, `moog923`) and existing
  mono→stereo wideners (`resofilter`, `warrensspectrum`, plus the hybrid
  `rasterize`) are `cls: 'deferred'` — byte-identical to pre-decision behaviour
  and awaiting an owner call. `vca` is the most common module in any patch, so
  leaving it untouched is the deliberate choice, not an oversight.
- A genuinely stereo reverb/delay (cross-feedback rather than two independent
  mono instances) remains a separate deferred option, per module and with owner
  ears.

## References

- `packages/web/src/lib/audio/dual-mono.ts` — `DUAL_MONO_LEDGER`, `SCOPE`, the
  discrete-up-mix hazard note.
- `packages/web/src/lib/graph/stereo-autowire.ts` — the leg-group commit planner
  and the owner-locked policy matrix.
- `packages/web/src/lib/graph/stereo-pairs.ts` — `allStereoPairs` /
  `derivedStereoPairs`, `COLLAPSE_EXEMPT`, `MONO_AUDIO_POINT_MODULES`.
- `art/scenarios/stereo-dual-mono/dual-mono-signal.test.ts` — the permanent
  both-directions negative control.
- `.claude/skills/audio-runtime` — the reusable judgement for anyone changing a
  factory, an input contract, or the tests over them.
- ADR-004 — CV range convention (the `cv` cable is unaffected by this decision;
  `stereovca`'s `strength_l`/`strength_r` are cv inputs and deliberately not a
  pair).
- Provenance: the planning package is preserved at the
  `myrobots-preserved-2026-09` tag (`.myrobots/stereo-audio-plan/`). Where that
  prose and the tree disagree, the tree is right.
