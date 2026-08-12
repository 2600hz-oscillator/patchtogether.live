# Blind Analysis Findings — comment-stripped corpus, contextless agents

**Date:** 2026-07-02
**Method:** The repo (origin/main) was exported via `git archive` (tracked files only — no git history, no ignored files), then purged of ALL context: `.myrobots/`, `.claude/`, every `*.md` file (README, docs, plans), and 8.6 MB of comments stripped from 2,462 code files (TypeScript-parser-based for TS/JS/Svelte incl. GLSL-in-template-literals; state machines for C/GLSL/CSS; line rules for shell/YAML). Parse-verified: 1,828 TS/JS files + 262 Svelte script blocks all still parse. Corpus: `~/Documents/workspace/subject-a` (kept for reproduction).
**Analysts:** six fresh headless `claude -p` processes launched *from inside the corpus* — no CLAUDE.md on their path, no project memory (verified no CLAUDE.md exists anywhere above the corpus), read-only tool allowlist. One question each: identity / testing / correctness bugs / lifecycle bugs / performance / stability.
**Adversaries:** one equally blind process per report, instructed to independently locate every citation and rule CONFIRMED / REFUTED / UNVERIFIABLE.
**Raw outputs:** ~~`raw/<lane>.analysis.md` + `raw/<lane>.verification.md` in this directory.~~
⚠ **2026-08-04: the `raw/` directory does not exist and was never committed** — this
directory contains only `REPORT.md` and `DSP_BUGS_OWNER_DECISION.md`. The twelve raw
analyst + verifier transcripts are gone; the same applies to §8's closing sentence.
This report and the decision doc are the only surviving artifacts of the exercise, which
is why they are kept rather than trimmed. The corpus (`~/Documents/workspace/subject-a`)
was outside the repo and its existence today is unverified.

> **STATUS 2026-08-04.** This is a *findings* record, not a plan — kept as the provenance
> for the decision doc beside it. §5's action plan has aged: several targets no longer
> exist (`helm`, `elements` and 13 other modules were deleted in #1013/#1033), and several
> items shipped by other routes (video sink-driven pull eval #1045; reconciler/engine
> hardening in part). The **live** residue is tracked per-item in
> `DSP_BUGS_OWNER_DECISION.md`, which was re-verified against `origin/main` on the same
> date — read that for current status, not the table in §7 below.

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
2. ~~**CI applies an incomplete DB schema.**~~ **FIXED — and the blind lane under-called it.** All 14 sites hand-copied a `psql -f …` list; `002`, `003` **and** `004` were in none of them, so the whole journal/replay durability feature was exercised by ZERO CI runs while every `@collab` test passed (`journal.ts` catches 42P01, warns once and degrades to snapshot-only). Plain `psql -f a -f b` also exits 0 on a file error, so the step went green on a half-applied schema. Replaced by `scripts/apply-db-schema.sh`, which reads the DIRECTORY with `ON_ERROR_STOP=1` and refuses to report success on an empty glob; `scripts/ci-db-schema.test.ts` asserts every caller targets a localhost `*_test` database.
3. ~~`vrt-strict` is absent from the aggregate `needs`~~ — **RESOLVED: branch protection does cover it.** Ruleset 16042163 requires `vrt-strict (visual regression — strict subset)` by literal name; CLAUDE.md's docs-only-gate section is built on that fact.
4. **The in-repo `/docs/testing` page is STILL stale, and 2026-08-12 found WHY.** It is not merely out of date — its auto-detect looks in the wrong place. `+page.svelte:170` branches on `data.vrtImplemented`, and the probe is for a repo-root `vrt/` directory that has never existed; the harness is at **`e2e/vrt/`**. So the page has printed *"Status: planned, not yet implemented … the harness directory `vrt/` does not exist yet"* (`:175-179`) through the entire life of the VRT system, and the intro at `:36` says the same. **Cheap fix, and it is the "auto-detected" wording that made it invisible** — a probe that answers honestly about the wrong path reads exactly like a fact.
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

## 5) Recommended action plan — DELETED 2026-08-12

**The ranked P0–P3 table was deleted in the janitorial sweep.** It had aged out
in three different directions at once and was the most likely thing in this file
to send someone at already-finished work:

- Its P0 `$COLLAB_ATTEST` row was **already wrong when written** — §2 item 1 in
  this same file explains the omission is deliberate.
- Its P0 relay-persist row, its P1 relay-hardening row and its P2 video rows
  were largely delivered by the 2026-07-10/11 burst (#1043–#1047: update
  journal, R2 snapshot blobs, relay CD, sink-driven pull eval, y-indexeddb local
  replica). `stack-study-executive-report.md` §3 carries the current scoreboard
  for exactly that set and is maintained; this table was not.
- Its remaining rows (meter-frame adoption wave, per-frame reflect-write audit,
  livecode execution budget, recorderbox roll-path, DOOM peer re-key, the stale
  `/docs/testing` page) are still live and are stated in §3 and §4 above, where
  the evidence is.

⚠ The `db.ts` swallow is **still there** and now carries a comment arguing it is
deliberate (`packages/server/src/db.ts:207-228`): a persist failure must not
crash the relay, and Hocuspocus re-fires the debounced store on the next edit or
disconnect. The blind lane's specific scenario — LAST client leaves, that store
fails, doc unloads — is the one that comment does not answer. The update journal
is the mitigation that landed; nobody has re-measured the residual window.

## 6) Meta-observations (what this exercise measured)

- **Comments were not load-bearing for comprehension** — identity, architecture, deploy story, and test philosophy were all recovered from code + tests + configs alone. The naming discipline and test co-location are doing the documentation work.
- **The blind bug lanes converged on the same hotspots we found from the inside** (reconciler fragility, meter-frame under-adoption, store write-storms, recorderbox edges) — independent replication that these are the real weak points, not observer bias.
- **The highest-severity NEW discoveries were in the seams we never look at**: the CI aggregation expression, the relay's failure paths, and cross-subsystem cleanup ordering. Adversarial verification killed or trimmed ~10% of claims — mostly overclaimed triggers ("per pointermove", "undetectable worker death") — while every mechanism-level claim survived.

## 7) Correctness bugs (blind lane + independent verifier: 7 confirmed, 0 refuted, 1 downgraded)

All 7 were concrete DSP defects in shipped modules — each cited to exact lines with a reachable trigger, and each independently re-confirmed by a second blind reviewer ("all citations accurate to the line; nothing misread the code or ignored a guard").

**Re-checked against the tree 2026-08-12. ONE of the seven is still live.**

| # | Where | Bug | 2026-08-12 |
|---|---|---|---|
| 2 | `dsp/src/macrooscillator.ts` (hihat) | Phase wrap uses a single `-= 1`; above ~5.4 kHz × ratio the increment exceeds 1, phase drifts unbounded and the square latches to constant −1 → high-ratio partials collapse to DC | **STILL OPEN** — `if (this.phases[i]! >= 1) this.phases[i]! -= 1;` is unchanged at `packages/dsp/src/macrooscillator.ts:1038` |
| 1, 4 | `dsp/src/helm.ts` (block-rate LFO/glide; the 7th voice silent + leaked) | — | **MOOT — the file is gone.** `helm` was deleted in the #1013/#1033 module cull |
| 3, 5 | `dsp/src/elements.ts` (`rawBuffer` never written; `setMeta` clamps against the wrong bound) | — | **MOOT — the file is gone**, same cull |
| 7 | `web/.../video/toybox-combine-graph.ts` (`wouldCreateCycle`) | valid forward wiring falsely rejected as `'cycle'` | **FIXED** — feedback taps are now excluded by `wouldCreateCycle` itself (`toybox-combine-graph.ts:980`) |
| 8 | `web/.../audio/modules/wavesculpt.ts` (`master_gain`) | dead knob | **FIXED** — `busL/busR.gain` are now driven from `master_gain` (`wavesculpt.ts:1115-1116`) |
| 6 | `dsp/src/lib/rbj-biquad.ts` `updatePeaking` caching on (fc, dbGain) but not Q — downgraded to MINOR at the time because no caller varied Q | — | **FIXED** — the cache-key rule is now stated and enforced in the file (`rbj-biquad.ts:28`) |

The one-line lesson the table keeps: **four of the seven were retired by deleting
the module, not by fixing it.** A defect ledger that outlives its subject reads as
six open bugs when it is one.

## 8) Overall verdict

The blind exercise worked: contextless agents, given only comment-stripped code, produced findings that survived independent adversarial verification at ~90% (roughly 47 confirmed mechanisms across the six lanes vs ~5 refuted/downgraded — all refutations being overclaimed *triggers*, never the mechanism). The highest-value output is not any single bug but the pattern: **the seams we never look at** (relay failure paths, CI aggregation expressions, cross-subsystem teardown, block-vs-sample rate boundaries) are where the real defects live, and a stranger with no priors finds them faster than we do because they have no "it's always worked" prior. Full raw analyst + verifier transcripts are in `raw/`.
