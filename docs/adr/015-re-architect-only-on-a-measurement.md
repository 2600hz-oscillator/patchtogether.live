# ADR-015: Re-architect only on a measurement

- Status: Accepted
- Date: 2026-09-08 (records the 2026-07 stack study and its 2026-08 reversal)
- Deciders: project owner; this ADR documents the decisions
- Tags: architecture, performance, video, process

## Context

Two independent pressures pushed toward re-architecting for performance.

**The external one.** A functional spec was extracted from the shipped product
and three outside designs were produced blind from it — a React/Next stack with
a Rust DSP core, a monolithic Rust/WASM audio core with a wgpu render graph, and
a local-first Solid stack with a single rack-processor worklet over SharedArray
rings. Each was then compared adversarially against the real codebase.

The headline finding was convergence, not divergence: all three were largely
clean-room re-derivations of decisions already shipped here, often down to exact
constants. The genuine disagreements reduced to framework swaps, Rust cores,
managed collab backends, worker-first video and SAB control planes.

**The internal one.** The confirmed real-hardware defect — audio glitching while
video controls are used — has a known mechanism: the audio scheduler dispatches
on the main thread, so main-thread video work delays sequencing directly. All
three outside designs independently attacked it by moving rendering off the main
thread, and the study ranked "finish the video worker hoist" its number-one
item, calling deferral indefensible.

## Decision

**Keep the stack. Adopt the specific wins in place. And before executing a
performance re-architecture, build the instrument and let it decide.**

1. **The rewrite is refused.** No proposal identified a capability the current
   stack lacks, and none replicated — or recognised the need for — the quality
   machinery that is the actual moat: SHA-pinned ART audio goldens
   (`packages/web/src/lib/art/fingerprints.generated.json`, 134 committed `.f32`
   baselines), the cross-platform VRT baseline set, the contract lock
   (`packages/web/src/lib/docs/contract-lock.txt`), the GPU attest, hundreds of
   shipped modules, and hardware integrations verified against physical gear. A
   rewrite forfeits all of it, re-steps on every fenced landmine, freezes a
   daily-shipping product for a year or more, and delivers at best behavioural
   parity. Every genuine gain is adoptable in place at a small fraction of the
   cost.
2. **Adopt in place.** Sink-driven pull evaluation
   (`packages/web/src/lib/video/pull-eval.ts` — each frame the engine draws only
   the reverse-reachable subgraph from the frame's roots, making laziness an
   engine invariant instead of per-module discipline), the relay operations
   bundle, and the client-side local replica all landed on that basis.
3. **The worker hoist is opt-in per module and DERIVED, never a name list.**
   `renderLocus: 'worker'` is a per-def opt-in, and
   `packages/web/src/lib/video/worker/worker-eligibility.ts` computes each
   module's disposition from its own I/O contract plus the derived lane sets —
   the worker's `getInputTexture` always returns null, so a module with a video
   input would render as if unpatched, which is a different picture rather than
   a degradation.
4. **Then measure, and let the measurement overturn the ranking.** The
   in-page accumulators (`packages/web/src/lib/video/render-cost.ts` plus the
   scheduler's own tick-latency recorder) measured the **cause** rather than the
   consequence, and the answer contradicted the study: a queued WebGL call was
   never main-thread CPU in the first place, a worker round trip *adds* a
   per-frame image upload, and the real bill is the per-surface `drawImage`
   synchronisation. The number-one recommendation was therefore **measured and
   rejected**, and video rendering stays on the main thread by default — one
   module opts into the worker today.

**The instrument rules that came out of it, and that make the reversal
trustworthy:** the accumulator lives **in the page**, because a Playwright-side
poll loop is a round trip on the same main thread as the subject, so a loaded
runner starves both and "frozen" is indistinguishable from "never looked". Every
field carries its unit in its name. `samples` is reported alongside percentiles
so "0.0 ms because it is cheap" is distinguishable from "0.0 ms because it never
ran". The spec gates the **instrument**, not a wall-clock budget — a threshold
would be a different assertion on every machine and would end up permanently red
or permanently vacuous — and its negative control perturbs the measured quantity
in **both** directions, because a probe that can only go up is satisfied by a
counter that never resets.

## Consequences

**Good:**

- The most expensive proposal in the shortlist was retired by evidence, in
  weeks, for the price of an instrument that is still earning its keep.
- Because eligibility is derived from the def, the worker roster cannot go stale
  when a module is added, and the gate asserts the computation against the live
  registry in both directions.
- Convergence is itself a result: three independent teams reasoning from the
  spec alone reproduced most of this architecture, which is the strongest
  external validation it could get.

**Bad / load-bearing:**

- **The study's actionable half is stale and must not be re-mined as a
  worklist.** Its ranking predates the measurement that reversed its top item,
  and several of its figures drifted. The verdict is durable; the shortlist is
  not.
- The instrument's own filename is load-bearing: it was renamed off a
  `video-*` prefix because that glob enrolled it in the real-GPU attest, where
  its deliberate core-pinning negative control was a contention source for every
  co-tenant spec. A spec's lane is decided by its name.
- Items the study raised that are still genuinely open: relay-side edge-legality
  validation of incoming updates, CRDT tombstone compaction, a consolidated
  device-permission gate, and an N-client randomised-interleaving harness.
- Video work that changes what the picture looks like still goes to the owner
  before merge; this decision is about where rendering runs, not about how it
  looks.

## References

- `packages/web/src/lib/video/render-cost.ts`,
  `e2e/tests/main-thread-cost.spec.ts` — the instrument and its gate.
- `packages/web/src/lib/video/worker/worker-eligibility.ts`,
  `packages/web/src/lib/video/worker/worker-engine.ts` — the derived
  disposition and the worker's contract.
- `packages/web/src/lib/video/pull-eval.ts`,
  `packages/web/src/lib/multiplayer/local-replica.ts` — two adopted items whose
  headers cite the study by name.
- ADR-010 — the audio-health taxonomy the same instrument discipline produced.
- Provenance: preserved in the `myrobots-preserved-2026-09` tag snapshot, as
  `stack-study-executive-report.md` and
  `plans/fixe-video-offload-shoes1-2026-07-01.md` (paths relative to the
  retired agent-evidence tree in that snapshot, not to the worktree).
