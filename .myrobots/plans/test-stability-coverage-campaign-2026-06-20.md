# Test-Stability + Coverage Campaign — Rollout Plan

**Date:** 2026-06-20
**Owner:** test-infra lead (executed INCREMENTALLY by the owner — one or two files per step,
green-on-CI between steps)
**Supersedes:** `.myrobots/plans/test-stability-restoration.md` (2026-06-07). That plan was the
post-#662 recovery doc; this one is the current, ground-truth-verified campaign and replaces it.
(That file no longer exists — removed in the 117→40 corpus triage, **#1175**.)

> **TRIAGE 2026-08-04 — KEEP FOR THE OWNER DIRECTIVE; THE §1 SCORECARD IS STALE
> AND SHOULD NOT BE READ AS CURRENT.**
> The four-point **owner directive of 2026-06-20** (no informational lanes; every
> disabled test is FIX-or-DELETE with no permanent exempt bucket; re-enable
> slowly; retries → 0) is the durable content and is why this file survives — it
> is the origin of the `reconcile-means-fix-or-delete` and
> `never-quarantine-fix-the-test` standards.
> Against the tree today, the §1 table is wrong in several rows:
> - **e2e-video** is not "DISABLED (dispatch-only)" — the lane was **DELETED on
>   2026-06-20 (#839)**, the same day this was written. Anything listed as
>   "excluded to e2e-video" now has **no PR coverage at all**.
> - **behavioral** is no longer purely informational: **#986** added a REQUIRED
>   `behavioral-smoke` subset. Its exempt counts moved 63 → **77** module and
>   160 → **113** sweep.
> - **The VRT "linux baseline backlog → 0" END-STATE goal was met by DELETING
>   THE DIMENSION.** #1458 collapsed `{platform}`: there is now ONE baseline set,
>   authored by linux CI, and the four gap-declaration mechanisms plus their
>   ratchets are gone. Anything below about linux/darwin pairs is void.
> - **retries → 0 was never done** — `e2e/playwright.config.ts:130` is unchanged
>   (`process.env.CI ? 1 : 0`).
> - ⚠ **§5 "legit-permanent-exempt" directly contradicts directive point 2** ("no
>   permanent exempt bucket"). The directive is the one the repo standards
>   inherited; §5 is the compromise this plan proposed and never got ruled on.
> Re-derive any number before using it; the directive, not the scorecard, is the
> reason to keep this.

## Owner directive (2026-06-20)

1. **No informational / flaky lanes at all.** Every lane is either a trustworthy **REQUIRED** gate
   or it is **removed**. (Nightly *canaries* like `collab-nightly` are diagnostics, not PR checks —
   they do not count as informational lanes.)
2. **Reconcile every disabled/exempt test = FIX (assert real behavior) or DELETE (worthless).**
   There is **no permanent "exempt" bucket** (`reconcile-means-fix-or-delete`,
   `never-quarantine-fix-the-test`).
3. **Re-enable SLOWLY** — a file or two at a time, let it run + be GREEN on CI between steps.
4. **retries → 0** everywhere (a retry == a tolerated flake).

> Capability/renderer-dependent tests pass 3× locally yet fail on CI (SwiftShader software renderer,
> no OS H.264 encoder). VERIFY green **on a contended CI runner**, not just locally. Read failures via
> job-scoped check-run annotations or `playwright-test-results-*` artifacts — **NEVER**
> `gh run view --log-failed` (wedges the shell). Every command runs through `flox activate -- …`.

---

## 1. Scorecard

### Gate status TODAY — TABLE DELETED 2026-08-12

The per-lane scorecard was a snapshot of 2026-06-20 and **every row had drifted**
(it still listed `e2e-video` as dormant rather than deleted, behavioral as purely
informational, and per-platform VRT baseline pairs that no longer exist). It was
the single most likely thing in this file to be quoted as current. Read the lane
truth off `ci.yml` + the ruleset; read this file for the DIRECTIVE and the END
STATE below.

### END STATE

- **Exactly ONE trustworthy REQUIRED collab gate**, zero green-but-vacuous skips, retries=0. No
  `collab`/`collab-attest` lane that "runs but doesn't block."
- **behavioral REQUIRED + per-PR + retries=0**; exempt count driven toward ~0 (only DELETE-with-
  rationale true-sinks + a SMALL hardware-device list, each carrying a concrete re-enable path).
- **e2e retries=0**; all `test.skip(true,'…flake')` escape hatches deleted (converted to asserts).
- **webgl-attest stays required retries=0**; toybox-draw gap closed; smoke floor at retries=0.
- **VRT: linux baseline backlog → 0** (capture on linux CI), deterministic cards **promoted into
  STRICT** (the required gate), the **4 darwin flakes root-caused or deleted**.
- **e2e-video**: either resharded into a per-PR required lane OR formally deleted (no dormant lane).
- **ART**: unchanged (already clean); keep the SHA-pin discipline.
- disabled/quarantined count → **near-0**, with the residual permanent list short + justified (§5).

---

## 2. Sequenced backlog (lowest-risk first; interleaved across suites)

Rule: **each step is 1-2 files.** Run the verify command locally; the named CI check must be GREEN
on the **final commit** before starting the next step. New/changed tests get a `REPEAT=3` flake-check
(repo standard #565) before the MR. The collab track (§3) runs as a parallel first-class lane; its
steps are tagged **[C-n]** and interleaved by risk below.

### Phase A — Quick wins (safe confidence-builders, no infra)

**Step 1 — Delete the contradictory behavioral "GATED" comment.** *(docs-only, zero risk)*
- File: `.github/workflows/ci.yml` (lines ~1796-1799).
- Action: remove the false "behavioral-coverage … is now GATED too (2026-06-03)" block (it is
  contradicted 20 lines later + by the actual `if [[ ]]`). Leaves one truthful statement: behavioral
  is informational, to be gated after a 3× flake-purge (Step 12).
- Verify: `flox activate -- task lint:actions` (actionlint).  **CI green: `actionlint`.**

**Step 2 — Fix the dead/contradictory in-card-title test.** *(1 file)*
- File: `e2e/tests/in-card-title.spec.ts` — remove the outer `test.fixme` (line 106) so the wave-3
  re-enabled body actually runs on the COLLAB_JOB lane (the inner `test.skip(!CI||!COLLAB_JOB)` is
  the correct partition); delete the stale "QUARANTINED pending #101" comment.
- Verify: `COLLAB_JOB=1 REPEAT=3 flox activate -- task e2e:one -- in-card-title` (needs DB+relay).
- **CI green: `collab (@collab multi-context)`** — so do this AFTER [C-1] re-attest so the hash is fresh.
  Editing this @collab spec changes the collab-attest basis → re-run `task collab:attest` + commit
  `ci-collab-attest/<hash>.json` in the same PR.

**Step 3 — Promote 1-2 deterministic no-canvas VRT cards into STRICT.** *(quick win, high payoff)*
- Files: `e2e/vrt/vrt-exemptions.ts` + the captured baselines. Start with TWO simple knob/fader
  cards from the "baseline pending — deterministic card, no canvas" set (e.g. `moog902`, `attenumix`).
- Action: run linux capture (Step 7 unblocks the bulk; for this step do darwin+linux for just these
  two), drop their `EXEMPT_FROM_VRT`/`EXEMPT_BASELINE_PAIRS` rows, add to `STRICT_VRT_MODULES`.
- Verify: `flox activate -- task vrt:one -- moog902` (and the strict subset run);
  `flox activate -- task test:one -- vrt-meta` (the consistency guard in the required `unit` job).
- **CI green: `vrt-strict` + `unit`.**

### Phase B — Collab de-flake (the informational-lane killer; see §3 for the full track)

**Step 4 [C-0] — Unblock #837: re-attest + fix the unrelated ART failure.** *(merge prep)*
- Files: `ci-collab-attest/<hash>.json` (regenerate); separately, the stale ART `.sha` pin causing
  the `art` FAILURE (re-pin `.sha` LAST, confirm only `.sha` changed — `art-sha-pin-regenerate-last`).
- Action: `flox activate -- task collab:attest` against a fresh dedicated relay+DB; commit the new
  hash file WITH the branch. The collab-attest FAILURE on #837 is just the stale hash.
- Verify: `flox activate -- task collab:attest` exits 0 locally.
- **CI green on #837: `collab-attest` + `art`.** (Do NOT merge #837 on the `collab` FAILURE — see C-1.)

**Step 5 [C-1] — Land #837's SYNC_BUDGET_MS fix in BATCHES of 2-3 non-DOOM specs.** *(the 15 specs)*
- Files: `e2e/tests/_collab-helpers.ts` (the `SYNC_BUDGET_MS=20_000` + `SYNC_POLL_INTERVALS` primitive)
  + 2-3 of the 15 changed specs per batch (awareness / collab / duplicate-module first — smallest diffs).
- Action: do NOT flip all 15 at once. Land 2-3, get `collab` green on CI, then the next batch. If a
  batch is still red, pull the `playwright-test-results-collab` artifact to see whether it's a real
  timeout (budget too low) or a vacuity skip (Phase C).
- Verify per batch: `COLLAB_JOB=1 REPEAT=3 flox activate -- task e2e:one -- awareness` etc.
- **CI green per batch: `collab (@collab multi-context)`.** Re-attest at the END of the last batch.

### Phase C — Kill the DOOM green-but-vacuous skips (the real trust blocker)

The 16 `test.skip(true,'…relay flake / did not deliver / roster sync did not seat / mpLive sync')`
silently report GREEN when sync doesn't converge — a "green" collab run proves nothing. Convert each
`if(!converged) test.skip(true,'relay flake')` → `await expect.poll(fn,{timeout:SYNC_BUDGET_MS,
intervals:SYNC_POLL_INTERVALS}).toBe(...)` so non-convergence is a FAILURE. **Oracle:** after each
spec, `grep -nE "relay flake|did not (deliver|reach|seat)|roster sync|mplive sync|node sync" <spec>`
returns zero — and `RELAY_VACUITY_MARKERS` in collab-attest then hard-fails any survivor.

**Step 6 [C-2] — doom-mp-real.spec.ts (6 skips → asserts).** *(highest-value spec, fix don't delete)*
- Verify: `COLLAB_JOB=1 REPEAT=3 flox activate -- task e2e:one -- doom-mp-real`. Keep the WASM/WAD-
  missing skips (legit asset gates). **CI green: `collab`** (re-attest after — changes the basis).

**Step 7 (parallel infra, no CI risk) — Capture the 104 linux/* VRT baselines.** *(mechanical)*
- Files: `e2e/vrt/vrt-exemptions.ts` (drop the linux/* `EXEMPT_BASELINE_PAIRS` after capture).
- Action: `vrt-update.yml` `workflow_dispatch` on **linux CI** to capture pending linux PNGs; drop
  the entries in batches (one module family per push). This is pure capture backlog, low risk.
- Verify: `flox activate -- task test:one -- vrt-meta`. **CI green: `vrt-strict` + `unit`.**

**Step 8 [C-3] — doom-mp-lockstep-sharedstate.spec.ts (4) + doom-mp-latejoin-freeze.spec.ts (2).**
- Both repro owner-confirmed real bugs (lockstep starvation / I_Error host-freeze) — **fix, don't
  delete.** The C-side `lockstep-barrier.acceptance.mjs` (ci.yml step 1060) proves bit-exact lockstep
  deterministically; the e2e here is the relay-path proof.
- Verify: `COLLAB_JOB=1 REPEAT=3 flox activate -- task e2e:one -- doom-mp-lockstep`. **CI green: `collab`.**

**Step 9 [C-4] — doom-late-join / doom-identity-crossview / doom-launch (1 mid-test skip each).**
- COLLAB_JOB gating is already correct on these; just convert the inner skip to an assert.
- Verify: per-spec `COLLAB_JOB=1 REPEAT=3 … e2e:one`. **CI green: `collab`.**

**Step 10 [C-5] — Resurrect or delete the two DEAD-on-CI specs.** *(owner decision — see §6)*
- Files: `doom-4context.spec.ts` (2 vacuity skips + `test.skip(!!process.env.CI)` = dead even on the
  collab job) and `doom-instance-model.spec.ts` (1 vacuity skip + dead-on-CI).
- Action: either change `!!process.env.CI` → `!COLLAB_JOB` gate (like siblings) + assert convergence,
  OR **DELETE** if redundant (4-context is heaviest/least-reliable; instance-model overlaps
  doom-identity-crossview). Owner call before executing.
- Verify: `COLLAB_JOB=1 … e2e:one`. **CI green: `collab`.**

### Phase D — retries → 0 (after collab is zero-flake)

**Step 11 [C-6] — Prove zero-flake + drop collab retries to 0.**
- Action: with vacuity skips gone (Phase C) + budgets generous, run the full `collab` lane ≥5×
  green-in-a-row at `--workers=1` via `collab-nightly.yml` `workflow_dispatch` (or no-op PRs). Then
  set the collab job `--retries=0`. Any red = root-cause (no re-run-to-green).
- **CI green: `collab` ×5 consecutive.**

**Step 12 — Drop e2e/webgl-smoke retries 1→0 file-by-file via the purge harness.**
- Files: `e2e/playwright.config.ts` (`retries: process.env.CI ? 1 : 0` → `0`) + the webgl-smoke
  `--retries=1` in ci.yml. Use the existing `e2e-flake-purge.yml` (already retries=1 gate-realistic)
  to prove zero-flake at 0 BEFORE flipping.
- Verify: dispatch `e2e-flake-purge.yml`; confirm 0 flakes. **CI green: `e2e` + `webgl-smoke`.**

### Phase E — Flip collab to REQUIRED (see §3 for the exact ruleset edits)

**Step 13 [C-7] — Promote ONE collab gate to REQUIRED + remove "informational".**

### Phase F — behavioral becomes a real gate, then burn down exempts

**Step 14 — Make behavioral RUN per-PR + 3× flake-purge + flip REQUIRED.**
- Files: `.github/workflows/ci.yml` — drop the `push/dispatch/labeled-only` `if:` (lines 1297/1449)
  so it runs per-PR; add `behavioral-coverage` to umbrella `needs:`, `env:` (`BEHAVIORAL=…`), AND the
  `if [[ ]]`; drop `continue-on-error`.
- **Pre-req:** 3× flake-purge first (it was prematurely 1×-gated in #562 and flaked on moog911 next
  PR). Confirm CI wall-time delta (6 shards) — if >2 min, **owner sign-off** (CLAUDE.md).
- Verify: `flox activate -- task behavioral` locally + 3× purge. **CI green: the umbrella `ci`.**

**Step 15+ — Burn down BEHAVIORAL_MODULE_EXEMPT (63) + BEHAVIORAL_SWEEP_EXEMPT (160), one module/PR.**
Driven by the in-file reconciliation doctrine (lines 577-604) + the CHANGELOG cadence. The harness
capabilities each cluster needs (build these as small enabling PRs first):
  - **(i) per-port-CALIBRATED delta / pitch-zc / per-transient-PEAK metric** → unlocks the entire
    near-threshold Class-A wave (cube/hypercube, chowkick ~20, treeohvox 7, elements ~12, rings 4,
    warrenspectrum, macrooscillator, dx7) — the **largest single reconcilable cluster**.
  - **(ii) per-CHANNEL sink driver** → mixmstrs / aquaTank / multiplex (4plexvid, fourplexer,
    unityscalemathematik, shapedramps, slewSwitch) + independent-output ports.
  - **(iii) longer / spawn-once observation window** → buggles / atlantisCatalyst / MI state machines
    (marbles, stages, symbiote, tides2) / timelorde.
  - **(iv) subset-under-budget runner** → foxy / mandelbulb / mixmstrs (wall-clock-blown).
  - **(v) fixture file/route-mocked stream + populated-slot seeding** → samsloop/twotracks/videobox/
    videovarispeed/archivist/picturebox/tvLibrarian/peertube + drumseqz/polyseqz/hydrogen/macseq/
    score/kria/clipplayer + sequencer/writeseq queue ports.

### Phase G — Real-GPU-blocked re-enables (highest risk — needs infra OR renderer-tolerant rewrites)

These pass on a real GPU and time out / go non-deterministic on CI SwiftShader. Two unblock paths:
(a) a **real-GPU CI runner** (unblocks ~15+ at once) or (b) **renderer-tolerant rewrites** per spec.

**Step 16 — Close the toybox-draw gap (webgl-attest).** *(low risk — the attest runs on the M5 GPU)*
- Files: `scripts/webgl-attest.ts` (set `FULL_TOYBOX_CONTENT=1` in Pass-A env) — bakes the 23 un-drawn
  GEN/FRAG shaders' real GPU compile+draw into the gate. Measure the wall-time delta (attest is only
  ~150s; confirm <2 min add). If it blows budget, instead DELETE the `FULL_TOYBOX_CONTENT` branch and
  add renderer-tolerant per-shader compile asserts to the `@webgl-smoke` floor. Either way the dead
  env var is reconciled (wired or removed) — no no-op escape hatch.
- Verify: `flox activate -- task webgl:attest` on the M5; confirm 0 flaky + count delta.
- **CI green: `webgl-attest`** (the new hash must match).

**Step 17 — Reconcile the two CI-conditional heavies + modules.spec toybox fixme.**
- `multi-video-playback.spec.ts` (scale-10) + `wavesculpt-camera-cv.spec.ts` (histogram #108): both
  already RUN in the attest (CI unset). DELETE the now-dead `!!process.env.CI` skip on scale-10 (the
  attest is the trusted run). For wavesculpt histogram, make the assert renderer-tolerant (poll for
  any non-bin-0 content) so it can also run the SwiftShader floor, then drop the skip.
- `modules.spec.ts` toybox `test.fixme` (#102): give it `HEAVY_TEST_TIMEOUT` (90s, the pattern
  already used for b3ntb0x/mandelbulb in that file) + renderer-tolerant structural assert and
  un-fixme; OR delete the row and document the heavy lane owns toybox render. No permanent fixme.
- Verify: `flox activate -- task webgl:attest` + `task e2e:one -- modules`. **CI green: `webgl-attest`,`e2e`.**

**Step 18 — Root-cause the 4 darwin/* VRT flake quarantines (#198 rasterize, #202 ×3 wavesculpt).**
- These VIOLATE no-flake-tolerance (admitted unowned flakes on the HOME platform). FIX via a
  deterministic render-freeze hook (the `__*VrtFreeze` seed pattern toybox/wavesculpt already use) OR
  DELETE the scenes. Not parkable.
- Verify: `REPEAT=3 flox activate -- task vrt:one -- rasterize` (and the 3 wavesculpt-blink scenes).
  **CI green: `vrt-strict`.**

**Step 19 — DECIDE e2e-video's fate + the real-GPU-blocked behavioral/per-port video class.** *(§6)*
- Either land the 3-way shard so `e2e-video` is per-PR REQUIRED again, OR formally DELETE the dormant
  job and accept webgl-attest+webgl-smoke as its permanent replacement (no disabled lane left). The
  real-GPU runner is the en-masse unblocker for the VIDEO_SINK_SWIFTSHADER behavioral class
  (edges/cellshade/chromakey/outlines), mandelbulb, edges-THICKNESS (#106), and wavesculpt-camera
  histogram (#108).

**Step 20 — Build the input-injection driver for doom-audio-output (#78) + recorderbox fragment gate.**
- `doom-audio-output.spec.ts` (2 fixme): needs a driver that waits for WASM-ready + injects a keypress
  to fire `S_StartSound` (idle E1M1 nomonsters emits no PCM). Re-enable when #78 lands.
- `recorderbox.spec.ts` (#105): gate on **actual encoded fragment output** (≥1 moof), not
  `isConfigSupported()` — adopt the tv-librarian/peertube capability-probe model (the CORRECT pattern).
- Verify: per-spec `e2e:one`. **CI green: `e2e`.**

**Step 21 — Reconcile the ~330 generated sweep exemptions, a file or two at a time.**
- DELETE-from-sweep the ~45 DOOM `evt_kill_*/evt_p*_dies/evt_gun_*` per-port rows (game-event outputs
  the bare-spawn sweep can't drive by design; already covered by `forcePulse` e2e + engine-bridge unit
  sweep). FIX the DC-rail rows (moogCp3 ±refs, midiLane.poly, nibbles.length_cv) with a **DC-aware
  sink** (not an AC-peak scope). WIDEN the sweep window for period-too-long (timelorde 1/8…1/64). FIX
  the real test-bugs: numpadPlus/slewSwitch/qbert "driver hangs under CI load" (8×20s budget).
- Verify: `flox activate -- task e2e:one -- per-module-per-port --grep <module>`. **CI green: `e2e`.**

---

## 3. First-class track: KILL the informational collab lane

1. **De-flake the non-DOOM half (#837).** Re-attest [C-0/Step 4] to clear the stale-hash
   collab-attest FAILURE + fix the unrelated stale ART `.sha`. Then land `SYNC_BUDGET_MS` across the
   15 specs in **batches of 2-3** [C-1/Step 5], `collab` green on CI between batches — do NOT merge
   #837 whole (its `collab` lane is RED today). #837 does **not** touch the DOOM vacuity skips.
2. **Kill the 16 DOOM green-but-vacuous skips** [C-2…C-5 / Steps 6,8,9,10]. Convert each
   `test.skip(true,'…relay flake')` → `expect.poll(…,{timeout:SYNC_BUDGET_MS}).toBe(…)`. Oracle =
   `RELAY_VACUITY_MARKERS` (a grep returning zero). Resurrect-or-delete the 2 dead-on-CI specs.
3. **Prove zero-flake + retries 0** [C-6/Step 11]: full `collab` ≥5× green at `--workers=1`, retries=0.
4. **Flip ONE collab gate REQUIRED + drop "informational"** [C-7/Step 13]. **Recommended = promote
   `collab-attest`** (deterministic ~2 min, no relay; its meaningfulness now rests on a zero-vacuity
   local run): add it to ruleset **16042163** required-status-checks + THREE ci.yml umbrella edits
   (`needs:`, `env: ATTEST=${{needs.collab-attest.result}}`, the failing `if [[ ]]`), and drop its
   `continue-on-error`. (Option B: once Step 11 proves it, gate the REAL `collab` job instead.)
   Then **negative-test the gate** (break a sync path → confirm it goes RED). Keep `collab-nightly`
   at `--workers=2` as the under-load canary (a diagnostic, not an informational PR check). Re-attest
   whenever any COLLAB_PATHS file changes.

---

## 4. DELETE these (worthless / redundant / true-sink) — separate from re-enable

| Item | Why |
|---|---|
| **behavioral: `videoOut`, `scope`** (MODULE_EXEMPT) | passthrough sink / canonical receiver — can NEVER show an input-delta by construction (file doctrine lines 587-597). Same class as the already-mechanically-deleted zero-output sinks. |
| **behavioral SWEEP: `recorderbox.audio_l/audio_r`** | audio goes to the MP4, never reaches the observed video-out by construction. |
| **behavioral SWEEP: independent-output ports** (`synesthesia.b_in/*_video_in`, `moog921a.width_cv`, `moog921b.width_bus`, `moog993.env_in1/2/trig_from2`, `moog961.v_in_*`, `moog911a.trig2`, `peaks.gate1/mode1_cv/k1_1_cv/k2_1_cv`) | feed a DIFFERENT output than the sweep's first-output by design — correct no-op. DELETE-with-rationale (or re-admit only with a per-output sink). They're currently SILENTLY filtered — surface them so the count is honest. |
| **per-port sweep: ~45 DOOM `evt_kill_*/evt_p*_dies/evt_gun_*`** | game-event outputs the bare-spawn sweep cannot drive; fully covered by `forcePulse` e2e + engine-bridge `.each` unit sweep. Move the assertion fully to the dedicated specs; DELETE from the sweep. |
| **`doom-4context.spec.ts` / `doom-instance-model.spec.ts`** | candidates to delete if redundant with doom-mp-real + doom-late-join + doom-identity-crossview (owner call, §6 — else resurrect). |
| **`FULL_TOYBOX_CONTENT` env branch** (if Step 16 budget blows) | a no-op coverage escape hatch set nowhere; delete the branch + cover shaders via smoke-floor compile asserts. |
| **dead `!!process.env.CI` skips** on `multi-video-playback` scale-10 (the attest already runs it) | the skip only fired in the now-disabled e2e-video lane. |
| **4 darwin/* VRT flake scenes** (#198/#202) — *delete IF not root-caused* | admitted unowned flakes; fix-or-delete, never park. |

---

## 5. Legit-permanent-exempt (keep SMALL + each carries a concrete re-enable path)

These are real capability/device gates, NOT quarantines. Per the no-permanent-exempt standard, each
keeps a CONCRETE re-enable path (a fixture / freeze hook / capability probe) noted on it.

- **Asset/ROM-gated** (qbert, snes9x, DOOM WASM+WAD, samsloop opt-in bench): gitignored user assets;
  CI build-web bakes DOOM WASM+WAD so those RUN on CI; the no-ROM path runs, ROM path skips cleanly.
  *Re-enable path: a committed test fixture/mock for the loaded path.*
- **Codec-capability** (tv-librarian-audio, peertube — `state!=='playing'` decode probe): this is the
  CORRECT model recorderbox must adopt. *Already a proper probe — keep.*
- **WebGL2 probe** (vfpga-p2-cells, vfpga-patchpanel-presets): belt-and-suspenders; SwiftShader
  provides WebGL2 so they RUN on CI.
- **Hardware-device** behavioral/VRT (gamepad, joystick, numpadPlus, cameraInput, midi*, audioIn,
  controlSurface, launchpad*): no physical IO in CI. *Re-enable path: a fake-device/getUserMedia
  fixture — track as backlog, do not force-enable.*
- **Structural-spawn** (group needs data.children; helm hides MIDI panel; cadillac is a 0-port overlay
  sprite): covered by dedicated specs. *Confirm each dedicated spec actually asserts render.*
- **`doom-mp-probe` / `samsloop-memory-bench` / DOOM_PROBE**: opt-in diagnostics, not tagged `@collab`,
  off by default. *Relocate out of `tests/` so they don't read as disabled tests.*
- **`livecode`/`clockedRunner` VRT** (CodeMirror caret blink): *re-enable path = mask the editor region
  (like the canvas masks) + gate surrounding chrome — promote from full-exempt to masked.*
- **`e2e-video` lane**: justified architectural exemption (24-27 min at workers=1 on SwiftShader);
  per-PR role replaced by webgl-attest + webgl-smoke. *Re-enable the day a real-GPU CI runner lands —
  but per §6, decide now whether to reshard-required or DELETE so no dormant lane lingers.*

---

## 6. Decisions the owner must make BEFORE step 1

1. **Collab gate choice (blocks Phase E / Step 13):** promote **`collab-attest`** to REQUIRED
   (recommended — deterministic, fast, no relay) OR gate the **real `collab` job** after the 5×-green
   proof. The plan assumes collab-attest unless you say otherwise.
2. **doom-4context + doom-instance-model (Step 10):** resurrect (gate to COLLAB_JOB + assert) OR
   DELETE as redundant. 4-context is the heaviest/least-reliable (4-up relay) — likely flaky even
   after #837; multi-user cap is 4 (owner+3) so coverage *matters*. Your call.
3. **e2e-video (Step 19):** reshard into a per-PR REQUIRED lane, OR formally DELETE the dormant job
   and bless webgl-attest+webgl-smoke as the permanent replacement. (No dormant lane may linger.)
4. **Real-GPU CI runner — yes/no?** It is the single en-masse unblocker for ~15+ video/shader
   exemptions (VIDEO_SINK_SWIFTSHADER behavioral class, edges-THICKNESS #106, wavesculpt histogram
   #108, mandelbulb, multi-video scale). If "no", those get individual renderer-tolerant rewrites
   (slower, per-spec) and stay on the long tail.
5. **CI wall-time (Step 14):** behavioral = 6 shards; if the per-PR add is >2 min, it needs your
   explicit OK (CLAUDE.md). Same check for Step 16 if `FULL_TOYBOX_CONTENT` adds >~2 min to the attest.
