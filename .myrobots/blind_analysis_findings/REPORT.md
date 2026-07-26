# Blind Analysis Findings — comment-stripped corpus, contextless agents

**Date:** 2026-07-02
**Method:** The repo (origin/main) was exported via `git archive` (tracked files only — no git history, no ignored files), then purged of ALL context: `.myrobots/`, `.claude/`, every `*.md` file (README, docs, plans), and 8.6 MB of comments stripped from 2,462 code files (TypeScript-parser-based for TS/JS/Svelte incl. GLSL-in-template-literals; state machines for C/GLSL/CSS; line rules for shell/YAML). Parse-verified: 1,828 TS/JS files + 262 Svelte script blocks all still parse. Corpus: `~/Documents/workspace/subject-a` (kept for reproduction).
**Analysts:** six fresh headless `claude -p` processes launched *from inside the corpus* — no CLAUDE.md on their path, no project memory (verified no CLAUDE.md exists anywhere above the corpus), read-only tool allowlist. One question each: identity / testing / correctness bugs / lifecycle bugs / performance / stability.
**Adversaries:** one equally blind process per report, instructed to independently locate every citation and rule CONFIRMED / REFUTED / UNVERIFIABLE.
**Raw outputs:** `raw/<lane>.analysis.md` + `raw/<lane>.verification.md` in this directory.

---

## Headline: what survived adversarial review

The blind reports were **unusually accurate**. Verification scoreboards:

| Lane | Confirmed | Refuted | Notes |
|---|---|---|---|
| lifecycle bugs | **12/12** (2 minor) | 0 | every cited line matched |
| stability | **14/16** | 2 sub-claims | citations "line-accurate almost everywhere" |
| performance | **12/12 mechanisms** | 1 sub-claim (drag-write trigger) | counts loose, verdicts solid |
| testing | ~41/45 claims accurate | 3 wrong counts | verifier found 2 NEW gaps itself |
| identity | ~40/45 accurate | 4 bookkeeping errors | full product identity recovered from code alone |
| correctness bugs | **7/8** confirmed | 0 refuted, 1 downgraded to minor | verifier: "all citations accurate to the line" |

---

## 1) What is this? (blind identity, fact-checked)

The blind analyst fully identified the product from code alone: *"a multiplayer, browser-native modular synthesizer — a collaborative Eurorack-style environment"* — including the audio/video dual-domain engine, MI ports, the vFPGA video glitch synth, game-emulators-as-modules, Yjs/Hocuspocus collab, Electra/monome/Launchpad hardware control, the attestation trust model, the Electron present-shell, and the full deploy topology (CF Pages + Fly relay + daily green-main prod deploy + hourly chaos + 10-min smoke). What it got wrong: workspace membership bookkeeping, "every server file has a sibling test" (index.ts and boot-id.ts don't), migration enumeration, and it framed the beta gate as preview-only (prod is gated too).

**Takeaway:** identity is not protectable by comment removal — names + tests + configs carry it. More usefully: a competent stranger can build an accurate mental model of this codebase *without any docs*, which speaks well of its structure.

## 2) How is it tested? (blind, fact-checked) — plus two REAL CI holes the exercise surfaced

The blind analyst reconstructed the whole estate: unit (web 493 / dsp 37 / server 9 test files), 321 e2e specs, VRT dual-lane with strict subset, ART golden `.f32` baselines with SHA pins, chaos fuzz bot, attestation model, flake-purge/REPEAT=3 discipline, daily-green-prod-deploy. Its wrong claims were counting errors (VRT 43→22 specs; ART 78→28 baseline dirs).

**⚠️ ACTION ITEMS — real, verified, ours to fix:**

1. **`collab-attest` does not gate the merge umbrella** — the blind agent flagged this as a P0 bug, but checking our actual `ci.yml` shows it is **INTENTIONAL, not a bug**: the failing-test block explicitly omits `$COLLAB_ATTEST` with a comment ("collab-attest UN-GATED 2026-06-28: rolled back the #847 gating") because the local-relay attest was a merge-blocking treadmill (flakiest DOOM-MP specs fail at retries=0 off the owner's box). It sits informational alongside the un-gated `collab` + `behavioral` lanes, pending a CI-native re-gate (Wave-2). *The blind agent correctly read the code; it just lacked the context that the omission is deliberate.* No action — it's a known parked state (task #158).
2. **CI applies an incomplete DB schema.** All 11 schema-apply steps across workflows run only `001_init.sql`; `002_feedback.sql` + `003_saved_groups.sql` are never applied in CI — while `collab-attest.ts` applies 001+003 locally. CI and the local attest environment run different schemas; feedback/saved-groups DB paths in CI are untested-or-vacuous. **P1.**
3. `vrt-strict` is absent from the aggregate `needs` while the PR comment claims it's required (branch-protection may cover it — verify ruleset, cf. task #67).
4. The in-repo `/docs/testing` page is stale ("VRT … not yet implemented") — it predates the VRT system.
5. Attestation bus-factor: the current WebGL attestation is one person, one machine, one day old — noted as a trust-model observation.

## 3) Confirmed bugs (lifecycle + stability lanes, 26 findings confirmed)

**The reconciler/engine teardown cluster (highest value):**
- **Reconciler wedge on failed module load** — `reconciler.ts:92-93`: `await engine.addNode()` unguarded (edge loop IS guarded — the asymmetry is the bug). One failing factory permanently bricks reconciliation for that client; error swallowed (`:134`). *(stability #1, high)*
- **Unguarded edge `disconnect()` closure** — `engine.ts:268`: the only unguarded teardown in the file; a spec-mandated `InvalidAccessError` wedges the reconciler retry loop AND aborts full teardown (`engine.ts:451-2`). The one regression test stubs `disconnect` to a no-op. *(lifecycle #1, high)*
- **`maxInstances` eviction leaks edges/knobs/taps** (`engine.ts:126-134`) — and is the realistic trigger for the above. `removeNode` also leaks `this.edges` + `paramTapEdges`. *(lifecycle #2, high)*
- **`PatchEngine.removeNode` orphans applied bridges** (`engine.ts:558-571`) — analyser polls persist per-frame for removed source nodes. *(lifecycle #8)*
- **AudioContext + WebGL context leak per Canvas mount** — no `.close()` anywhere; `/r/[id]` remounts accumulate contexts. *(lifecycle #7)*
- Related present-tense evidence from our own mobile build yesterday: undo-of-first-param-write leaves engine stale (reconciler re-applies only present keys). Same subsystem. **Recommendation: one hardening PR for the whole cluster.**

**One throwing video `draw()` kills all video output** — `video/engine.ts:502-506` unguarded in the rAF loop; loop re-arms only after `step()` returns. (Verifier nuance: next `addNode` restarts it; a deterministically-throwing module re-kills per frame.) Worker-side death is NOT undetectable (refuted): `worker-bridge.ts:73-76,181-190` auto-falls-back to main thread. *(lifecycle #3 / stability #5)*

**Relay data-loss + resilience set (all confirmed):**
- **Silent permanent document loss on failed Postgres persist** — `db.ts:103-114` swallows, logs "will retry" **with no retry existing**, `unloadImmediately: true` unloads the doc, and introspection counts the write as healthy. Last-client-leaves + one failed write = rack gone, dashboards green. **This is the single worst finding of the exercise. P0.**
- DB pool has **no connect/statement timeouts** → hung DB hangs `onAuthenticate`.
- `Server.listen()` rejection unhandled + process guards never exit → zombie relay possible.
- Clerk outage → bare `catch { return null }` → every user "unauthorized" with no discrimination.
- No payload/doc-size limits at the relay trust boundary (member-authenticated, but unbounded).
- Unguarded `loadSnapshot`/`Y.applyUpdate` on the read path (corrupt row = crash) — glaringly inconsistent with the swallowed write path.

**Livecode can freeze every client** — user source → `new Function` → synchronous run on the shared clock tick, on every client's main thread, no loop budget anywhere. One collaborator's `while(true)` hangs the whole room. Feeds the already-queued LIVECODE rewrite. *(stability #3, high)*

**DOOM netcode peer re-keying** — index-derived peer IDs never re-key survivors on membership change; live packets transmit over the wrong user's channel; relay seq state corrupts. A correctness bug in MP, not just a leak. *(lifecycle #6)*

**Recorderbox roll-path races** — `abandon()` doesn't await an in-flight chunk roll (orphans an OPFS worker + manifest); `rollChunk` has no catch (dead "recording" state); a crashed OPFS worker leaves `write()` promises unsettled → `stop()` hangs forever. *(lifecycle #4,5,10 + stability below-cut)*

**Device-driver phantoms** — Launchpad unplug leaves phantom-connected state (writes into empty catch); monome self-heals on first write (report's "zero signal" half refuted). Hydrogen kit sample fetch memoizes rejections forever. Present-shell has zero load-failure handling.

## 4) Performance (12 mechanisms confirmed)

Ranked by verified severity:
1. **warrenspectrum builds a template string per band per sample on the audio thread** (`warrenspectrum.ts:345`; 8 bands × 48k ≈ 384k string+hash lookups/sec in a worklet). Trivial hoist.
2. **Video engine does O(edges) scan + array alloc + `localeCompare` sort per input, per node, per rAF frame** (`video/engine.ts:811-856`); `topoStale` hook already exists for an O(1) prebuilt map.
3. **Dozens of ungated per-card 60fps rAF loops** doing full-res GPU blits regardless of visibility — while our purpose-built `meter-frame.ts` gate is adopted by exactly **5** cards. (The blind agents independently rediscovered and validated the #996 meter-frame campaign — the migration should continue.)
4. **Per-frame engine→store Y.Doc reflect writes** (`BentboxCard.svelte:158`, `B3ntb0xCard`, `BackdraftCard`) drive whole-doc snapshot rebuilds + wake every whole-doc `ydoc.on('update')` card subscription (20 files). This is exactly the TOYBOX #719 write-storm class — the audit we recorded but never did. (Their "node dragging" trigger claim was refuted — drags commit once on dragstop; the reflect writes are the real driver.)
5. **Reconciler JSON-deep-clones every node's data every pass** even when params didn't change (`reconciler.ts:152`).
6. twotracks allocates 4 Float32Arrays per 128-sample block; layout writes trigger pointless full snapshot rebuilds (snapshot reads only nodes/edges); worker toybox allocates ~8+ mat4s per layer per frame; sync GPU→CPU readbacks per frame in Synesthesia card; shapegen regenerates per frame when no clock patched.

## 5) Recommended action plan (my synthesis, ranked)

| P | Action | Source |
|---|---|---|
| P0 | ci.yml: add `$COLLAB_ATTEST` to the aggregate failure condition (+ audit `vrt-strict` requiredness) | testing verify |
| P0 | Relay: real retry/backoff on failed persist + do-not-unload-on-failed-store + Better Stack alert on store failure (the "will retry" lie) | stability #2 |
| P1 | Reconciler/engine hardening PR: guard `addNode`, guard the `engine.ts:268` disconnect closure, purge edges/taps on eviction & removeNode, close AudioContext on Canvas destroy, un-stub the disconnect regression test | lifecycle 1/2/7, stability #1 |
| P1 | Video engine: try/catch around `handle.surface.draw` + re-arm policy | lifecycle #3 |
| P1 | CI: apply all three schema files everywhere | testing verify |
| P1 | Relay: pool timeouts, listen().catch, guard loadSnapshot, Clerk-outage discrimination | stability 4/6/10 |
| P2 | warrenspectrum + twotracks worklet hoists (ART-covered, safe) | perf 5/6 |
| P2 | Video engine O(1) input maps behind `topoStale` | perf #4 |
| P2 | meter-frame adoption wave (60 rAF files → gated) | perf #7 |
| P2 | Per-frame reflect-write audit (bentbox/b3ntb0x/backdraft → render-local, #719 pattern) | perf 1/2 |
| P2 | Livecode execution budget (fold into queued rewrite); recorderbox roll-path fixes; DOOM re-key fix | stability #3, lifecycle 4/5/6/10 |
| P3 | Stale /docs/testing page; docs/adr+design dirs empty; hydrogen rejection cache; present-shell load-failure handling | misc |

## 6) Meta-observations (what this exercise measured)

- **Comments were not load-bearing for comprehension** — identity, architecture, deploy story, and test philosophy were all recovered from code + tests + configs alone. The naming discipline and test co-location are doing the documentation work.
- **The blind bug lanes converged on the same hotspots we found from the inside** (reconciler fragility, meter-frame under-adoption, store write-storms, recorderbox edges) — independent replication that these are the real weak points, not observer bias.
- **The highest-severity NEW discoveries were in the seams we never look at**: the CI aggregation expression, the relay's failure paths, and cross-subsystem cleanup ordering. Adversarial verification killed or trimmed ~10% of claims — mostly overclaimed triggers ("per pointermove", "undetectable worker death") — while every mechanism-level claim survived.

## 7) Correctness bugs (blind lane + independent verifier: 7 confirmed, 0 refuted, 1 downgraded)

All 7 are concrete DSP defects in shipped modules — each cited to exact lines with a reachable trigger, and each independently re-confirmed by a second blind reviewer ("all citations accurate to the line; nothing misread the code or ignored a guard").

| # | Where | Bug | Sev |
|---|---|---|---|
| 1 | `dsp/src/helm.ts` (Lfo.tick + step-glide) | **LFO & glide advance once per BLOCK, not per sample** — `phase += freqHz/sr` and `exp(-1/(sr·tau))` are per-sample rates but `lfo1/lfo2.tick`+`seq.smooth` run outside the `i<blockLen` loop → every LFO runs ~`blockLen`× too slow (a "4 Hz" LFO ≈ 0.03 Hz) | **HIGH** |
| 2 | `dsp/src/macrooscillator.ts` (hihat) | Phase wrap uses a single `-= 1`; above ~5.4 kHz × ratio the increment exceeds 1, phase drifts unbounded and the square latches to constant −1 → high-ratio partials collapse to DC | MED |
| 3 | `dsp/src/elements.ts` (`rawBuffer`) | `rawBuffer` allocated + read but **never written** (grep-proven); at `space ≤ 0.05` (`rawGain=1`) the aux crossfade zeroes the entire aux channel | MED |
| 4 | `dsp/src/helm.ts` (voices) | `allocateVoice(MAX_VOICES=8)` hands out 8 slots but render/free only cover `vi<voiceCount` (default 6) → the 7th held note is **silent AND permanently leaks its slot** | MED |
| 5 | `dsp/src/elements.ts` (`setMeta`) | Clamps against global `EXCITER_MODEL_NOISE`(6) instead of the `last` arg(4); at max strike (`strikeMeta=1.0`) selects model 5 (FLOW), past the intended PARTICLES(4) range | MED |
| 7 | `web/.../video/toybox-combine-graph.ts` (`wouldCreateCycle`) | Cycle check loads **all** edges incl. layer-input feedback edges, which `topoSort`/`validateConnect` exempt → a valid forward wiring is falsely rejected as `'cycle'` (self-contradiction: topoSort accepts what validateConnect rejects) | MED |
| 8 | `web/.../audio/modules/wavesculpt.ts` (`master_gain`) | **Dead knob**: declared 0..2 "overall output level", stored by setParam, but `busL/busR.gain` pinned to 1 and never updated, `tick()` never reads it → moving it neither mutes nor boosts | MED |

**Downgraded to MINOR (real smell, no reachable trigger):**
- #6 `dsp/src/lib/rbj-biquad.ts` `updatePeaking` caches on (fc, dbGain) but not Q → a Q-only change would early-return stale coefficients. *This is my own kick-drum code.* The verifier correctly downgraded it: both production callers (`kickdrum-dsp.ts:385-386`) pass Q as a hardcoded constant, so no caller varies Q → no reachable bug today. Worth a one-line fix (add Q to the cache key) as a latent-defect guard before anyone reuses the helper with a dynamic Q, but not urgent.

**Recommended:** finding #1 (helm LFO block-rate) is HIGH and airtight — it means every Helm patch's modulation has been running two orders of magnitude too slow, likely long-masked because users just turn the LFO rate up to compensate. Worth a dedicated fix PR with an ART/unit test pinning LFO cycle length. Findings #3, #4, #8 are each a small, self-contained fix with an obvious test. These are excellent candidates for a "blind-found DSP bugs" cleanup batch.

## 8) Overall verdict

The blind exercise worked: contextless agents, given only comment-stripped code, produced findings that survived independent adversarial verification at ~90% (roughly 47 confirmed mechanisms across the six lanes vs ~5 refuted/downgraded — all refutations being overclaimed *triggers*, never the mechanism). The highest-value output is not any single bug but the pattern: **the seams we never look at** (relay failure paths, CI aggregation expressions, cross-subsystem teardown, block-vs-sample rate boundaries) are where the real defects live, and a stranger with no priors finds them faster than we do because they have no "it's always worked" prior. Full raw analyst + verifier transcripts are in `raw/`.
