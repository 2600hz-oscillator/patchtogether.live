# Stack Study — Executive Report

> ## STATUS 2026-08-04 — KEPT. The verdict stands; the shortlist is a live scoreboard.
>
> Re-verified against `origin/main`. **The rewrite verdict ("no, three times") is
> unchanged and nothing since contradicts it.** What has moved is §3's adoption
> shortlist, which is the actionable half of this document:
>
> | # | item | 2026-08-04 |
> |---|---|---|
> | 1 | video pull-eval + worker hoist | **PARTIAL — and this is the finding.** Pull eval LANDED (#1045). The worker hoist landed the *mechanism* (#1047, default ON) then **stalled at 1 of 67 video modules**: only `acidwarp` is `renderLocus:'worker'`; toybox/vfpga are `'worker-experimental'`; and **every video module shipped since is main-thread** (backdraft, frametable, videocube declare no `renderLocus`). The study's own #1-ranked item, aimed at the confirmed real-hardware defect, is the one that stopped. |
> | 2 | relay ops bundle (CD + R2 + journal + alarms) | **LANDED — all four.** `deploy.yml:687-794` relay CD; `server/src/journal.ts` + `db/schema/004_rack_update_journal.sql` (#1043/#1044); `server/src/r2-sigv4.ts` + `snapshot-store.ts`; `rack-accounting.ts` alarms. Hocuspocus kept, as recommended. |
> | 3 | y-indexeddb local replica | **LANDED** — #1046, `multiplayer/local-replica.ts` (its header cites this study by name). |
> | 4 | headless CRDT + DOOM lockstep harnesses | **OPEN** — no N-client randomized-interleaving harness; `doom-lockstep.ts` is production transport, not a sim harness. |
> | 5 | pinned software rasterizer as the declared baseline | **PARTIAL** — SwiftShader is the de-facto CI floor, but `webgl-attest` is still the real-GPU gate. The treadmill was not retired. |
> | 6 | worklet-clock migration | **PARTIAL, no movement since.** The four named modules use the **Worker** scheduler tick, not audio-thread time; only `gate-edge-worklet.ts` genuinely owns time. SAB rings not attempted. |
> | 7 | per-module perf budgets in CI | **OPEN** — no render-cost sweep, no per-worklet self-timing. |
> | 8 | relay admission hardening | **PARTIAL** — membership enforced (predates the study); **edge-legality validation of relay updates is still absent**, so the poisoned-client hole is open, and the cap is still in-memory with no DB constraint. |
> | 9 | snapshot compaction + doc telemetry | **PARTIAL** — telemetry landed (`/metrics`); compaction covers the **journal**, not Yjs tombstones. The stated scale risk is unaddressed. |
> | 10 | CI wall-time delta report | **OPEN** — still the CLAUDE.md honor rule. |
> | 11 | `new-module` scaffolder | **LANDED** — `scripts/new-module.ts`, actively maintained. |
> | 12 | small wins | **SPLIT** — OPFS recorder scratch LANDED; DOOM WAD cache LANDED; **DeviceGate OPEN** (device permission calls still scattered across ~20 files). |
>
> **Scorecard: 4 landed, 5 partial, 3 open.** The legible pattern: essentially the
> whole delivered set shipped in the 48-hour burst of 2026-07-10/11 (#1043–#1047),
> and the shortlist has not moved since.
>
> **Re-spot-checked 2026-08-12 — item 1 has gone BACKWARD in adoption terms and
> nothing else moved.** The worker hoist is still `acidwarp` alone on
> `renderLocus:'worker'` (toybox + vfpga-runner on `'worker-experimental'`), and
> every video module shipped in the year since declares main-thread or nothing —
> including the newest, `warrensvisions`, whose own test *asserts* `'main'`
> (`warrensvisions.test.ts:43`). The study's #1-ranked item, aimed at the one
> confirmed real-hardware defect, is the one that stopped, and new work is now
> being pinned to the side it was supposed to move off.
>
> Two figures in §5 have drifted and understate the moat rather than overstating it:
> **ART goldens are 136 `.f32` files, not 84**, and **the "170 audio modules" the
> rewrite math rests on is really ~119 defs** (see the correction banner on
> `stack-study-functional-spec.md`) — which cuts the porting estimate ~40 % without
> changing the conclusion.

## 1. Summary (one page)

**Method.** A functional spec was extracted from the shipped product (patchtogether.live). Three outside designs were produced blind from that spec — **A-velocity** (React/Next/Vercel, Rust DSP, Liveblocks), **B-native-performance** (SolidJS-adjacent shell, monolithic Rust/WASM audio core, wgpu render graph, Yrs relay), **C-local-first** (SolidJS, single rack-processor worklet + SAB rings, Durable-Object-per-rack relay, y-indexeddb replica). Each was then adversarially compared against the actual codebase.

**Headline finding.** All three designs are **65–75% clean-room re-derivations of decisions we already shipped** — often down to exact constants (500 ms undo capture window, consistency-byte lockstep, COEP `credentialless`, two-lane param writes, timestamp-projected MIDI, docs-outside-the-pin-hash, 3× flake policy). Three independent teams reasoning from the spec alone converged on our stack. That is the strongest external validation the current architecture could receive: the decisions are principled, not incidental.

**The real disagreement is small.** Once convergence is netted out, the deltas reduce to: framework swaps (React or Solid vs Svelte 5), Rust DSP cores, managed/rearchitected collab backends, worker-first video, and SAB control planes. Of these, only two survive scrutiny as genuinely superior architecture — and both target wounds our own incident history documents:

1. **Video rendering on the main thread starves audio.** All three proposals independently attack this. Our confirmed #1 real-hardware defect (drag-glitch = output-buffer underrun; video saturates at ~21 fps idle) is exactly the failure their worker-first, pull-based, sink-driven designs make structurally impossible. We spiked the fix (Fix E: GO) and deferred it. They were right; we were slow.
2. **The relay is a pet.** Single process, in-memory authority, pinned to one machine, no CD (drifts stale), an OOM that went unalerted, no local replica anywhere in the client. All three proposals — Liveblocks, journaled Yrs relay, DO-per-rack + y-indexeddb — are different answers to the same correct diagnosis.

**The rewrite verdict is no, three times, decisively.** No proposal identifies a capability the current stack lacks. None of them replicates — or even recognizes the need for — the quality machinery that is our real moat: 84 SHA-pinned ART audio goldens, cross-platform VRT baselines, contract-lock + docs ratchet, the GPU/collab attest system, ~430 shipped module implementations, and hardware integrations verified against physical gear. A rewrite forfeits all of it, re-steps on every landmine we already fenced (#345, #566, #674, #719, #720), freezes a daily-shipping product for **12–30 months**, and delivers at best behavioral parity. Every genuine gain the proposals offer is adoptable in place at **1–10% of rewrite cost**.

**Action.** Convert the study into the adoption shortlist below. Items 1–3 (video pull/worker pipeline, relay ops hardening, local replica) should land this quarter. Reject all platform swaps.

---

## 2. Verdict table

| Design | Better overall? | Best parts | Adoptable without rewrite | Rewrite cost / benefit |
|---|---|---|---|---|
| **A-velocity** (React/Next/Vercel, Rust DSP, Liveblocks) | **No.** ~70% rediscovery; React is *worse* for 218 per-frame-reactive cards; Rust solves a determinism problem ART already solves; Liveblocks puts a vendor inside a required CI gate. | Managed-collab ops posture; worker-first video as default; per-module render-cost budget; CI wall-time report; token-mint admission control; scaffolder CLI. | Everything of value: worker hoist, R2 snapshot backup + relay CD, perf budgets, wall-time gate, scaffolder, admission endpoint. | 250–500 eng-days of catalog porting after an 8-week foundation; 12–18 months to parity at ~7 FTE. Only non-adoptable gain is React hiring pool — irrelevant to a one-owner-plus-agents team. **Break-even: never.** |
| **B-native-performance** (monolithic Rust worklet, wgpu, Yrs) | **No.** Its Rust unification solves a client/relay drift problem our single-TS-workspace doesn't have; its fault-isolation subsystem rebuilds what per-node Web Audio gives us free; byte-identical native↔WASM equivalence is a research project sold as a gate. | Pull-based sink-driven video; audio thread owns time (whole-graph); pinned software rasterizer as declared CI baseline; headless lockstep sim; update journal + unacked replay; per-module cycle metering. | All six best parts, none requiring Rust: pull eval in the existing WebGL2 engine, worklet-clock migration (already in flight), lavapipe/SwiftShader-pinned baseline, DOOM sim harness, relay journal, worklet self-metering. | 14 weeks engine+SDK before any module, then ~1.5–3 senior-years porting 170 audio modules alone; every ART golden and VRT baseline invalidated by construction. 18–30 months frozen. **Break-even: only if incremental fixes fail to clear the underrun ceiling — measure first; evidence says they will clear it.** |
| **C-local-first** (Solid, rack-processor worklet + SAB, DO-per-rack, y-indexeddb) | **No.** ~70% is a description of our shipped code; SolidJS-over-Svelte-5-runes is a parity rewrite of 467 UI files for zero capability gain. But it has the best deltas of the three. | y-indexeddb local replica + client re-seed; DO-per-rack relay isolation; snapshot compaction + doc budgets; headless CRDT property tests; single rack-processor worklet as the audio end-state; DeviceGate. | Local replica (~1 wk), property harness (days), compaction (~1 wk), R2 blobs + relay CD (~1 wk) with an optional later DO port, worklet-clock continuation, DeviceGate. | Proposal's own math: 9–11 people, 4–5 months of substrate, then 8–14 person-months of catalog; 12–18+ months for our actual team. **Break-even: never** — module authoring is already our zero-contention parallel lane, which removes the rewrite's scaling argument. |

---

## 3. Adoption shortlist (merged, deduped, ranked)

Ranked by convergence across proposals × documented pain ÷ effort. None require a framework, language, or vendor swap.

| # | Item | Sources | Effort | Payoff |
|---|---|---|---|---|
| 1 | **Video pipeline: sink-driven pull evaluation + finish the worker hoist.** Walk backward from watched outputs/recorders so unwatched nodes cost zero; land the Fix E "texture co-processor" slice (flag and bridge already exist, spike passed). | A, B, C (3/3 — unanimous) | 2–4 wks total | Directly attacks the #1 confirmed real-hardware defect (drag-glitch underrun from ~21 fps idle saturation). Highest-value item in the study. |
| 2 | **Relay ops bundle: CD for `packages/server`, snapshot blobs → R2 with Postgres pointer, per-update append journal + client unacked-replay, per-rack memory alarms.** Keep Hocuspocus. | A, B, C (3/3) | ~2 wks total | Kills the documented pet-server failure modes (drift, unalerted OOM, 2–5 s data-loss window) and buys ~80% of Liveblocks/DO value with zero migration and a hermetic collab gate. |
| 3 | **y-indexeddb local replica + re-seed-from-local.** | C | ~1 wk | We have nothing here. Converts "relay outage = product outage" into "relay outage = sync outage"; the single biggest durability win at any price. |
| 4 | **Headless deterministic harnesses:** (a) CRDT property tests — N simulated Yjs clients, randomized interleavings/partitions, convergence + undo-locality + cap assertions; (b) DOOM lockstep sim — thousands of tics, scripted ticcmds, consistency-byte asserts. Unit-lane speed. | B, C | ~2 wks | Replaces our most fragile, DB-dependent confidence source (@collab e2e, historically vacuous without DATABASE_URL) with fast, hermetic gates. Do (b) before BLOOD MP so it inherits the harness. |
| 5 | **Pinned software rasterizer as the declared VRT/attest baseline platform;** real-GPU demoted to informational. | B | 1–2 wks + one re-baseline | Retires the attest treadmill and the current `webgl:attest` blockage; cleaner than exemption lists. |
| 6 | **Continue the worklet-clock migration** (drumseqz/polyseqz/score/cartesian per the queued PR-C+ plan), then **measure** whether SAB param rings add anything over the shipped two-lane batching (`crossOriginIsolated` is already true). | B, C | ongoing, weeks | This *is* the "audio thread owns time" end-state all three proposals endorse, adopted organ by organ. Retires the double-count edge bug class at the root. |
| 7 | **Per-module performance budgets in CI:** render-cost sweep (banded for SwiftShader variance) + per-worklet quantum self-timing with bypass-and-badge. | A, B | ~2 wks | Stops the aggregate frame-cost creep that produced idle saturation; "degrade, never silence" at module granularity. |
| 8 | **Relay input + admission hardening:** import the existing TS edge-legality function into a relay hook (drop malformed updates per-item); consolidate room-cap/membership into the token-mint path with a DB uniqueness constraint. | A, B | ~1 wk | Closes the poisoned-client hole; makes cap enforcement race-safe at one seam. |
| 9 | **Snapshot compaction + doc-size telemetry.** | C | ~1 wk | Our only unmitigated scale risk (years of tombstones); current answer is nothing. |
| 10 | **CI wall-time delta report per PR** (mechanical, comments the diff vs main baseline). | A | ~1 day | Converts the CLAUDE.md >2-min honor rule into a gate. |
| 11 | **`new-module` scaffolder** (def + docs + core stub + card + STRICT_DOCS + enrollment checklist). | A | 2–3 days | Shaves remaining per-module boilerplate in our highest-throughput lane. |
| 12 | **Small wins:** DeviceGate permission chokepoint; OPFS recorder scratch (crash recovery) + WAD cache. | B, C | 2–3 days each | Cheap, isolated hardening. |

**Explicitly rejected:** React/Next/Vercel, SolidJS, Turborepo (lateral or worse), Rust DSP cores (ART already delivers offline determinism; revisit per-kernel only where Faust loses), Liveblocks (vendor inside a required gate), WebGPU-first (WebGL2 remains the load-bearing fallback anyway), SAB CV tap and CBOR patch files (no demonstrated defect; measure first).

---

## 4. The rewrite question, head-on

**Should we rewrite on any of these stacks? No. Not now, not incrementally-toward, not "when we scale."**

- **No capability gap exists.** Across three adversarial designs, not one names something the product cannot do on the current stack. Both real insights the study produced — worker/pull video and relay ops — are architecture-local changes *inside* our stack (shortlist items 1–3).
- **The cost is dominated by assets the proposals can't see.** ~430 module implementations; 84 ART `.f32` goldens that any new DSP engine invalidates by construction (each needing human ear re-review, not mechanical re-pin); full VRT baseline sets invalidated by any new UI framework; the attest corpora, regenerable only on real GPU hardware; hardware integrations debugged against a physical Electra One, FTDI monome grid, and ES-9; and encoded root-causes (DOOM consistency bytes, Yjs already-integrated corruption, CV write-storms, silent-poly, MIDI projection drift) that a greenfield team re-purchases at full price. The pinning culture the proposals praise is precisely what makes rip-and-replace ruinous.
- **The math never closes.** Using the proposals' own estimates against our surface area: 12–30 months to parity for a team we don't have, delivering a product that at best behaves identically — while the current stack ships multiple attested PRs per day. Every adoptable gain costs 1–10% of that.
- **The only conditional:** B's monolithic-audio-core argument earns a checkpoint, not a rewrite. If, after sink-driven eval + worker hoist + completed worklet-clock migration, a large rack still underruns on the owner's hardware, revisit the rack-processor end-state — reachable by continued organ transplant, not by teardown.

---

## 5. What the study says about the current stack

**Genuine strengths — now externally confirmed:**

1. **The core decisions are convergent truths.** Three blind teams independently derived Yjs + awareness + local-origin undo, Clerk, CF edge + Fly, xyflow-vendor canvas, one pure edge-legality module, WebCodecs recording with capability probes, consistency-byte lockstep, glob-driven registries, and our exact testing constitution. These weren't lucky picks; they're what the spec forces.
2. **The quality machinery is the moat, and it is unmatched.** No proposal replicated — or budgeted for — the attest system, the contract-lock/docs ratchet, source-SHA-pinned audio goldens, or auto-enrolled per-module sweeps. That infrastructure is what lets one owner plus agents ship ~430 pinned modules; it is the single strongest reason the incumbents win.
3. **Module economics already deliver the proposals' promised end-state.** "Marginal module costs days" is their week-14 aspiration and our current reality, in the language (TypeScript) agents write fastest.
4. **The hard bugs are already paid for** and fenced with gates, not folklore.

**Genuine weaknesses — three independent auditors agree, and our own incident log concurs:**

1. **Video rendering shares the main thread with the audio scheduler.** Unanimous finding, confirmed by real-hardware root-cause. We validated the fix and deferred it. Indefensible to defer further — shortlist item 1.
2. **The relay is a single-process pet with no local fallback.** Unanimous in substance. No CD, in-memory authority, one machine, an unalerted OOM in its history, and zero client-side replica. Items 2–3.
3. **Time is not yet fully owned by the audio thread.** The edge-double-count bug class recurred enough to earn a standing CLAUDE.md rule; the worklet migration is correct but piecemeal. Item 6 finishes it.
4. **No per-module performance governance** — aggregate frame cost crept to idle saturation with no gate to catch it. Item 7.
5. **Collab confidence rests on the most fragile lane** — DB/relay-dependent e2e with a history of vacuous passes. Item 4 gives it a fast hermetic core.
6. **Unbounded doc growth** has no compaction story. Item 9.

**Net position:** the study cost us nothing and functioned as three free external audits. They validate ~70% of the stack, correctly identify its two real wounds, and supply a dozen incremental fixes worth roughly a quarter of engineering — against a rewrite that would burn one to two years re-earning pins we already own. Take the shortlist. Keep the stack.