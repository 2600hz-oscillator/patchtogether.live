# DOOM multiplayer verification + local multi-browser harness — plan

**Date:** 2026-09-01
**Status:** ⚠ **EVIDENCE, NOT INSTRUCTION.** Per `AGENTS.md`, `.myrobots/` is evidence.
Nothing here is an approved decision. Every gating/CI/Taskfile item is presented as an
OWNER DECISION with costs.
**Basis:** investigations ran against `origin/main` @ `326f257ed`; spot re-verified by me
at `origin/main` @ `2e2f0c185` (2026-09-01 15:30 -0400, #2292 trails).
⚠ **Every line number below was true when read and MUST be re-verified before acting.**
Several citations in the source investigations were already off by 1–15 lines; I corrected
the ones I re-read and flagged the ones I did not.

**Authorisation note.** `AGENTS.md` boundary 1 requires explicit owner approval to touch
DOOM. The owner gave it on 2026-09-01 for *investigation* and for *building multiplayer
testing*. It does **not** extend to weakening DOOM coverage, deleting DOOM specs, or moving
budgets/ledger entries to make something pass.

---

## 1. What DOOM verification exists TODAY

### 1.1 Headline

**DOOM multiplayer testing was NOT lost.** The owner's premise ("if we have totally lost
our multiplayer DOOM testing") is false. What was deleted on 2026-08-17 was
`collab-attest` — a cheap content-hash *semaphore*, not a test lane. The lane that actually
runs two-peer DOOM (`collab` in `ci.yml`) survived that deletion deliberately and was green
today.

The real problem is not coverage. It is **detectability**: every mechanism that would tell
you this coverage had quietly stopped working is absent for DOOM.

### 1.2 The four live DOOM signals (all verified running)

| # | Signal | Where | Gating? |
|---|---|---|---|
| 1 | **11 genuine two-peer browser tests** | job `collab`, `ci.yml:1471` (`collab (@collab multi-context)`) | **NO** — off the umbrella |
| 2 | **Bit-exact C lockstep oracle**, 2 *and* 4 sims × 200 tics | `ci.yml:1630` → `packages/web/native/doomgeneric/tests/lockstep-barrier.acceptance.mjs` | **NO** — runs *inside* job `collab` |
| 3 | **Nightly full `@collab` lane**, 4 shards, 09:00 UTC | `.github/workflows/collab-nightly.yml` | backstop only |
| 4 | **18 DOOM vitest files** (netcode, lockstep, host-authority, roster, presence, player-identity) | `packages/web/src/lib/doom/*.test.ts` | **YES** — in the required `unit` job. Single-process logic only, no peers. |

**Signal 1, measured non-vacuous.** Run `33537312141` (main, `326f257ed`), job `99955891365`:
`50 passed · 1 skipped (4.7m) · 0 flaky`. The skip was `in-card-title.spec.ts:109`, not DOOM.
The eleven DOOM two-peer tests that passed:

| spec:line | what it asserts |
|---|---|
| `doom-identity-crossview.spec.ts:205` | slot badge + colour; A moving changes B's POV (11.7 s) |
| `doom-late-join.spec.ts:248` | B joins mid-level, hot-drops as player 1 (7.2 s) |
| `doom-launch.spec.ts:271` | arbiter launches coop E1M1; both peers move their own marine (9.8 s) |
| `doom-mp-latejoin-freeze.spec.ts:211` | host keeps playing past the consistency-check boundary (20.2 s) |
| `doom-mp-lockstep-sharedstate.spec.ts:406` | **two peers share IDENTICAL gamestate (checksums match)** (23.3 s) |
| `doom-mp-lockstep-sharedstate.spec.ts:691` | per-player CV drives its OWN slot, no freeze (11.8 s) |
| `doom-mp-real.spec.ts:312` | owner hosts P1, guest one-click hot-joins P2 (9.8 s) |
| `doom-mp-real.spec.ts:747` | exactly one host, never split-brain (3.9 s) |
| `doom-mp-real.spec.ts:812` | host picks non-default difficulty by MOUSE (3.1 s) |
| `doom-mp-real.spec.ts:887` | anon guest hot-joins into the CURRENT map (7.0 s) |
| `doom-multiplayer.spec.ts:163` | host migration: host leaves → spectator becomes host (5.2 s) |

**Signal 2 is the strongest determinism evidence in the repo** and needs no browser and no
relay: it boots N independent WASM sims through the real `dgpt_set_lockstep` +
`dgpt_receive_ticset` barrier and asserts byte-identical state for 200 tics, plus that a
withheld TicSet **pauses rather than spins**. 4-player is invoked at
`lockstep-barrier.acceptance.mjs:400` (`runBarrierLockstep(wad,{numPlayers:4,tics:200,seed:0xBA221E2,label:'4p-live-barrier'})`);
there is also a `2p-real-input` case driving 150 tics from real
`gamekeydown[] → G_BuildTiccmd → readLocalTiccmdAt`. ~56 s on CI.

### 1.3 What `collab-attest` actually was, and what was lost

`collab-attest` was a **job inside `ci.yml`**, never a workflow file. Introduced `38cd262d2`
(#798), armed required `223dbc07d` (#847), deleted `8f9ce3ea8` on 2026-08-17 11:50:41 -0400
("DELETE nine non-gating jobs"), merged `3d393c8e7`/`d16e4d4d8` as **PR #1778** at 13:59:10.
The only workflow *files* ever deleted in this repo are `docs-only-gate.yml` and `pages.yml`
(the latter restored).

On CI it **ran no test**. It recomputed a content hash of the collab surface
(`scripts/collab-attest-hash.sh`) and asserted `ci-collab-attest/<hash>.json` existed. The
real run happened locally via `task collab:attest` → `scripts/collab-attest.ts` (624 lines).

⚠ The deleted job's own header said "GATING (armed 2026-06-20)". **That was false at
deletion time** — `30fcb7f22` (#1505, 2026-08-14) had already removed it from the umbrella's
`needs:`. So the deletion cost **zero gating power**. It cost discipline.

**Precisely what was lost — four things, none replaced:**

1. **Deny-by-default skip classification.** Any skip was a HARD FAILURE unless a named
   `BENIGN_SKIPS` rule claimed it. "A body that did not run cannot back an attestation that
   says it did." Plus an explicit **DOOM/SNES asset pre-flight** so asset skips could not fire.
2. **An explicit refusal if the DB or relay were not actually up** — the anti-vacuity check.
3. **An honest `retries=0` run**, so flakes surfaced instead of being absorbed.
4. **`collab-attest-basis.test.ts` (218 lines)** — the only thing running in the *required*
   `unit` job that asserted the collab surface had not been silently narrowed.

The hash basis named **nine DOOM sync files** explicitly — `doom-netcode.ts`,
`doom-lockstep.ts`, `doom-roster.ts`, `doom-presence.ts`, `doom-session.ts`,
`doom-host-authority.ts`, `doom-awareness-signature.ts`, `doom-gating.ts`,
`doom-player-identity.ts` — deliberately excluding non-sync DOOM files. All nine still exist
on main. Deleted with the job: `collab-attest.ts` (−624), `collab-attest-lib.ts` (−400),
`collab-attest-verify.sh` (−91), `collab-attest.sh` (−22), `collab-attest-hash.sh` (−18),
`collab-attest-hash.ts` (−18), `collab-attest-basis.test.ts` (−218), the
`ci-collab-attest/` directory, and `.claude/skills/collab-attest.md`. Nothing survives:
`git ls-files | grep -i 'collab.*attest'` is empty; there is no `collab:attest` Taskfile
target.

### 1.4 ⚠ The four blind spots (this is the actual finding)

1. **The collab lane's skips are NOT audited.** `scripts/e2e-skip-budget.mjs:47` —
   `AUDITED_LANES = ['e2e','behavioral']`. The collab job's audit call (`ci.yml:1660-1666`)
   passes `--fail-on-flaky` with **no `--lane`**, and `e2e-report-audit.mjs:238` computes
   violations only when `--lane` is given. ⚠ Worse than "not passed": `--lane collab` is
   **rejected** — `e2e-report-audit.mjs:232-233` throws
   `--lane must be one of e2e|behavioral`. The budget file *does* carry named DOOM MP
   entries with `homeLane:'collab'` (four of them, ~lines 100–158), but with `lanes: []`, so
   they only fire as leak detectors on the audited lanes.
   **Net: if the DOOM WASM/WAD provisioning broke on CI, all eleven DOOM MP tests would skip
   and the lane would report green.** This is exactly the shape that already shipped once —
   `82928b07e` (#1594, 2026-08-13): "the attest's skip classifier ALLOWED BY DEFAULT — a dead
   DOOM 2-user gate minted a green attestation."
2. **DOOM is excluded BY NAME from the flake gate on EVERY lane — including the required
   `e2e` lane.** `e2e-report-audit.mjs:52` `DOOM_SPEC = /(^|\/)doom-[^/]*\.spec\.ts$/`;
   `partitionFlaky` (`:64-69`) routes matches to `doomReserved`, which emits a `::notice`
   (`:270`) and **never sets `fail`**. All 7 DOOM MP spec files match. So the repo standard
   "a recovered flake reds the PR" has a standing DOOM-shaped hole, and `--fail-on-flaky`
   compensates for **exactly nothing** in the only population the collab lane exists for.
3. **`collab-nightly.yml` has ZERO audit instrumentation** — no `json` reporter, no
   `e2e-report-audit.mjs`, no `--fail-on-flaky`, no `--lane`. The backstop has *strictly
   less* instrumentation than the per-PR lane. It is genuinely running all 11 DOOM MP tests
   today (`33491432797`: shard 2 = 8, shard 3 = 3), but nothing would say when that stopped.
4. **No teeth.** `collab` is off the umbrella (`ci.yml:2179` `# informational-off-umbrella: collab`;
   `:2180` `needs:` omits it; `:2212` echoes "temporarily un-gated, task #69") and off the
   only branch ruleset. Ruleset `16042163` ("main: green PRs only", enforcement `active`)
   requires exactly two contexts: `typecheck + unit + ART + E2E` and
   `vrt-strict (visual regression — strict subset)`.
   ⚠ **This contradicts the standing memory `project_behavioral_collab_gating`
   ("@collab … REQUIRED"). That memory is STALE.**
   Note `daily-prod-deploy.yml` *does* inspect every job's conclusion, so a red `collab`
   disqualifies the SHA from the nightly prod ship while still permitting the merge.

**Clock fact the owner should weigh:** `daily-prod-deploy.yml` fires at **04:00 UTC**;
`collab-nightly.yml` at **09:00 UTC**. A multiplayer regression that lands on main reaches
**production five hours before the (uninstrumented) nightly backstop looks at it**, and the
only pre-merge multiplayer signal cannot fail the merge.

### 1.5 Two facts closed from the open list

- **There is no `collab-flake-purge` workflow.** Only `e2e-flake-purge.yml` and
  `behavioral-flake-purge.yml` exist; `flake-check-3x.yml` offers a `collab` *choice* but is
  a single-test 3× dispatch. So the blocker `ci.yml:2212` names ("pending the 5x
  collab-flake-purge") has **no machinery and cannot have run**. The stated reason for
  un-gating is unfalsifiable prose, and the lane is 9/9 green in the runs cited plus 8–10
  consecutive green nightlies.
- **`ci.yml:99` is stale prose** — it says "the branch ruleset REQUIRES four contexts". It
  requires two. Same ungated-prose drift as the `collab-attest` header.

---

## 2. Does anything run when DOOM code changes?

**YES — everything runs, on every change.** `ci.yml` has **no `paths` / `paths-ignore`
filter at all**; `ci.yml:93-109` documents the deliberate 2026-08-23 removal ("Deleting the
filter deletes the trap"). Triggers (`ci.yml:110-127`): `push: [main, first-mvp]`,
`pull_request: [opened, synchronize, reopened] → main`, `workflow_dispatch`. The `collab`
job carries **no `if:`**. So editing `packages/web/src/lib/doom/**` fires the two-peer DOOM
lane plus the C oracle, measured 8 m 23 s on run `33537312141`.

Path filters exist in only three workflows and **none matches any doom path**:
`art-gallery.yml:31-34`, `pages.yml:33-42`, `vrt-changeset-gallery.yml:34-35`.

**But the headline is the qualified version:**

> DOOM multiplayer tests RUN on every DOOM change. They cannot FAIL the change — the lane is
> informational — and if they silently stopped running, nothing would say so.

Also verified: **DOOM is not in the WebGL attest basis** (`scripts/webgl-attest-lib.ts` has
zero `doom` matches) and not in `WEBGL_HEAVY_GLOBS`, so a DOOM edit forces no re-attest and
there is no lane-orphan risk from the existing spec names.

---

## 3. The local multi-browser Playwright multiplayer design

### 3.0 What already exists — do not rebuild it

| Piece | Location | State |
|---|---|---|
| 2-context peer boot (own cookie jar / localStorage / Y.Doc) | `doom-mp-lockstep-sharedstate.spec.ts:93-133` (`boot()`), **byte-identical copies** at `doom-mp-real.spec.ts:110-150` and `doom-mp-latejoin-freeze.spec.ts:64-104` | works |
| Cross-peer determinism oracle | `dgpt_state_checksum` → `DoomCard.svelte:2062` → spec `:573-582` | works, 2 peers |
| Browser lockstep barrier | `packages/web/src/lib/doom/doom-lockstep.ts` (`LockstepTransport`, Y.Array append-log + consolidation) | works |
| C barrier | `packages/web/native/doomgeneric/doomgeneric/d_loop.c` `GetLowTic` clamp, `DGPT_LoopReceiveTicSet` | works |
| Browserless N-sim bit-exact oracle | `tests/lockstep-barrier.acceptance.mjs` | works, **already 4-player** |

**The genuine gaps are four:** >2 peers; a non-self-starving instrument; a positive control;
and a starvation-vs-desync classifier.

### 3.1 Contexts — ⚠ the obvious design is WRONG

The intuitive design ("one browser per peer, with anti-backgrounding flags, because
backgrounded contexts throttle rAF") is **refuted by measurement**:

- Playwright 1.59.1 **already passes** `--disable-background-timer-throttling`,
  `--disable-backgrounding-occluded-windows`, and `--disable-renderer-backgrounding`
  (`node_modules/playwright-core/lib/server/chromium/chromiumSwitches.js:57`). Adding them is
  a **no-op**.
- Measured, 4 peers, torn down cleanly:
  `idle → 4 contexts/1 browser: 482 482 482 481 frames / 4003 ms; 4 separate browsers:
  481 481 482 480 / 4002 ms`. Under 6 ms CPU per frame in all four simultaneously:
  `603 603 602 602 / 5004 ms` vs `601 601 601 600 / 5008 ms`. All pages
  `visibilityState = visible`.

**Headless pages in separate contexts are never hidden and rAF is not throttled**, loaded or
idle. Separate browser *processes* buy nothing and cost ~250–400 MB RSS each.

⚠ **The tree's own prose is wrong in three places** and must not be trusted:
`doom-mp-real.spec.ts:547` ("a backgrounded second context (which this is) rAF is throttled
hard"), `:711`, and `_doom-helpers.ts:~97`. Per `AGENTS.md` authority ordering, measurement
beats comments — fix the comments in whatever PR touches this.

**Design decision: N contexts on ONE browser**, exactly like the existing 2-peer specs.
The real 4-peer risk is **CPU contention among four WASM sims plus four render loops**, and
that is worse with N browsers, not better.

**Hard ceilings, which coincide at 4:**
- `packages/server/src/capacity.ts:17` `RACKSPACE_MAX_CONNECTIONS = 4`, enforced in
  `onAuthenticate` (`index.ts:180-186`); overflow surfaces as `rackspace-full` from
  `__attachProvider` (`+layout.svelte:185`). A not-yet-released socket from a closed context
  poisons the next join — **use a fresh random rackId per test, never reuse**.
- DOOM's own `MAXPLAYERS` is **4**. There is no 5-peer design to have.

### 3.2 What is shared vs stubbed

| Thing | Shared? | Evidence |
|---|---|---|
| rackspace id (Hocuspocus `documentName`) | **yes**, one random id per test | `__attachProvider(id)` (`+layout.svelte:158`) |
| the relay on `ws://localhost:1235` | **yes**, one process | `playwright.config.ts:293-310`; port rationale `packages/server/src/index.ts:42-45` (Bitwig owns 1234) |
| the DOOM node id | **yes** — host adds it, guests receive via Yjs | `doom-mp-real.spec.ts:333-357` |
| `INVITE_SECRET` | must agree app↔relay | `packages/server/src/auth.ts:34-45`, mirrored in `lib/server/invites.ts` |
| `DATABASE_URL` | **NOT required** — relay falls to in-memory snapshots, and that is intentional for exactly this suite | `packages/server/src/db.ts:58-68` |
| Clerk | **NOT required** — anon HMAC invite; `checkRackAccess` bypasses rack-exists outside prod | `index.ts:157-168`, `auth.ts:102-119` |

**Real and must stay real:** DOOM WASM + `DOOM1.WAD`, the Hocuspocus relay, the Y.Doc/Y.Array
transport, the C barrier, `G_BuildTiccmd` local input.

**Stubbed / bypassed, deliberately:**
- **Keyboard focus** — only one page holds `document.activeElement`. Use
  `forceClaimKeyboard()` (`DoomCard.svelte:2040`) + poll `getState().shouldClaimKey`, as
  `doom-mp-real.spec.ts:280-305` does. A real click cannot work here.
- **Mouse hit-testing** — the auto-spawned TIMELORDE canvas overlaps the DOOM card, so the
  specs use `dispatchEvent('click')` (`doom-mp-real.spec.ts:489-498`).
- **WebRTC** — `doom-netcode.ts:788` creates a `doom-tics` data channel, but
  `doom-lockstep.ts:19-28` states the Y.Array log **is the sole transport** for P1, WebRTC a
  `TODO(P4)`. **Build no assertion on WebRTC transport state.**

### 3.3 ⚠ Precondition: assets, and it must FAIL not SKIP

DOOM assets are gitignored (`packages/web/.gitignore:27,30`). A fresh worktree has only
`doom-pcm-worklet.js` + `DOWNLOAD_INSTRUCTIONS.md` under `static/doom/`; the primary
checkout has the real files. Every DOOM spec's `assetsPresent()` guard
(`doom-mp-lockstep-sharedstate.spec.ts:135-145`) then fires `test.skip(...)` → **green while
asserting nothing**. Skips are not passes.

Harness step 0 must therefore **fail loudly** on missing assets. Cheapest correct answer in
a worktree: symlink from the primary checkout —
`static/doom/{doom.js, doom.wasm, DOOM1.WAD, doom-mp-node.js, doom-mp-node.wasm}`.
⚠ **The last two are required by the C oracle** and are easy to forget.

### 3.4 ⚠ Build asymmetry the harness must not paper over (NEW, verified today)

The browser's shipped `doom.wasm` is built **without** `FEATURE_MULTIPLAYER`
(`packages/web/native/build-doom-wasm.sh:294-296` gates `-DFEATURE_MULTIPLAYER` behind
`DOOM_MP=1`). The C oracle's artifact **is** built with it
(`lockstep-barrier.acceptance.mjs:64`, `DOOM_MP:'1', DOOM_OUT:'doom-mp-node'`).

Consequence, verified in
`packages/web/native/doomgeneric/doomgeneric/d_loop.c`: the non-`FEATURE_MULTIPLAYER` `#else`
at `:663`/`:668` sets `new_sync = 0`, and the P1 input-delay build-ahead clamp at `:363-388`
sits **inside `if (new_sync)`**. The reachable `else` branch is
`if (maketic - gameticdiv >= 5) return false;`.

**So `DoomCard.svelte`'s `setInputDelay(6)` writes a variable the browser build never reads**;
effective build-ahead is <5 tics, not 6. Two implications:

1. There is **less latency hiding in the browser than the card believes**, so a 4-peer
   barrier stalls more readily than a 2-peer one. This — not backgrounding — is the real
   scaling risk.
2. **The C oracle and the browser are not the same build.** The oracle is excellent evidence
   for the barrier algorithm and worthless as evidence about the browser's `new_sync` path.
   Say so in any PR that cites it.

### 3.5 The assertion that is genuinely about MULTIPLAYER

**The property:** for every gametic `T` that two or more peers both reached,
`dgpt_state_checksum()` at `T` is identical on all of them.

`dgpt_state_checksum` folds, per in-game slot, mobj `x,y,z,angle,momx,momy,momz,health` +
player health, plus `leveltime` and **both RNG indices**
(`doomgeneric_patchtogether.c:671-686`). The RNG indices are the canary — a divergence in
monster AI or a damage roll moves them before any position drift is visible.

**Three assertions in the current specs that are NOT this, and must not be mistaken for it:**

- **(a) The consistency-abort assertion is structurally vacuous.**
  `doom-mp-lockstep-sharedstate.spec.ts:589-590` and `:839-840` assert no
  `/consistency failure/i` console line. It can never fire on the lockstep path:
  `DGPT_LoopReceiveTicSet` stamps **every** slot with
  `G_ConsistancyForSlot(i, tic % BACKUPTICS)` (`d_loop.c:1219-1220`), which returns the
  **locally computed** `consistancy[slot][buf]` (`g_game.c:611-616`), which `G_Ticker` then
  compares back (`g_game.c:966-971`). Equal by construction, for `ticdup == 1`.
  The remaining hole — that this only holds while `recvtic − gametic < BACKUPTICS (128)` —
  is closed by the reachable `BuildNewTic` branch capping the lead at **<5** (§3.4).
  It is also only checked at all when `gametic > BACKUPTICS`, so the first 128 tics are
  unchecked regardless. And the assertion reads **`p1Console` only** — P2's console is never
  captured; since `I_Error` ends in `exit(-1)`, the real both-peer detector is the
  `aEnd/bEnd … not.toBeNull()` pair at `:587-588`.
  ⚠ **Prose disagrees with the tree.** `d_loop.c:1055` ("genuine cross-peer state — our live
  divergence oracle") and `:1189` ("it stays a real divergence oracle") are both wrong.
  *(The source investigation mis-anchored these as `:1044-1046` and `:1174-1181` — do not
  paste those into a PR.)* **Report this; do not carry the vacuous assertion into a new spec.**
- **(b) `canvasHash` (`doom-mp-real.spec.ts:230-250`) is a single-peer rendering assertion.**
  Well built — it carries its own all-black negative control — but "both windows painted" is
  not multiplayer. Keep it as a liveness leg only.
- **(c) "A moving changes B's view"** (`doom-mp-real.spec.ts:698-724`) is a real cross-peer
  assertion but a weak one: it passes on the pre-P1 free-run overlay model, which is exactly
  the model P1 replaced. Checksum equality is strictly stronger.

### 3.6 ⚠ The instrument must move INTO the page

`sampleSharedTics` (`doom-mp-lockstep-sharedstate.spec.ts:357-399`) runs a **Playwright-side
loop** issuing `Promise.all([checksumAt(A), checksumAt(B)])` every ~8 ms (`:380-384`). That is
two CDP round trips per 8 ms, each landing a `page.evaluate` **on the same main thread as the
sim it measures**. This is the repo's documented "Playwright poll starves its own subject"
shape; `_doom-helpers.ts:141-146` names the rule it violates.

At 2 peers it is survivable (the spec compensates with adaptive sampling, `:344-356`). At 4
peers the cost scales linearly **and** — because of the barrier — starving any one peer
throttles all of them. It becomes the dominant term.

**Design: one `page.evaluate` per peer for the whole burst, rAF-paced, drained once, and
issued CONCURRENTLY across peers.**

```ts
// Per peer, ONE evaluate. Paced exactly like waitTics (_doom-helpers.ts:150-188).
const record = (page, id) => page.evaluate(async ([nid, wantTics, capMs]) => {
  const c = globalThis.__doomCards[nid];
  const out: [number, number][] = [];
  const start = c.getTics().gametic;
  const deadline = performance.now() + capMs;
  let last = -1;
  for (;;) {
    const t = c.getTics();
    if (t.gametic !== last) { out.push([t.gametic, c.stateChecksum() >>> 0]); last = t.gametic; }
    if (t.gametic - start >= wantTics) break;
    if (performance.now() >= deadline) break;
    await new Promise<void>(r => { let d = false; const f = () => { if (!d) { d = true; r(); } };
      requestAnimationFrame(f); setTimeout(f, 50); });
  }
  return out;
}, [id, TICS, SIM_BUDGET_MS]);

const logs = await Promise.all(pages.map((p, i) => record(p, NODE_ID)));  // ⚠ Promise.all, NOT sequential
```

⚠ **`Promise.all` is mandatory, not an optimisation.** Sequential `await` gives peer B a
recording window that starts after peer A's ended, collapsing shared-tic overlap to ~zero.
(It would fail loudly on the overlap assertion rather than silently — but it is still a
defect.) The same applies to any `waitTics` fan-out: under the barrier, A cannot advance
until B appends, so `await waitTics(A); await waitTics(B)` **deadlocks by construction**.

Sampling **every gametic** (not every 8 ms) also removes the "did the windows overlap?"
problem: under the barrier all peers traverse the same tic sequence, and with the ≤4-tic lead
from §3.4 the overlap is ~100% by construction. A collapsed overlap then becomes a genuine
finding rather than a timing artifact.

### 3.7 The assertion set (N peers)

1. **Liveness, per peer:** `advance_i ≥ MIN_TICS`, from the recorder's own first/last sample.
   Anti-vacuity for #3.
2. **Overlap, non-vacuity:** `|⋂ᵢ tics_i| ≥ MIN_SHARED` — should be ≈ `min(advance_i)`.
3. **THE MULTIPLAYER ASSERTION:** for every `T ∈ ⋂ᵢ tics_i`, `checksum_i(T)` equal for all
   `i`. Report the first mismatching `(T, checksums…)` and each peer's `getState().mySlot`.
4. **Per-peer identity:** `mySlot` distinct per peer, and the rack owner is slot 0 / host /
   net-arbiter regardless of lexicographic ordering (`doom-mp-real.spec.ts:376-380` proves the
   historical bug — keep it).
5. **Bounded log:** `getLockstepLogSize() < LOG_BOUND`, floor **derived** from the bound.
   ⚠ `MIN_GAMETIC = ceil(LOG_BOUND/N) + slack` is arithmetically right, **but `LOG_BOUND = 256`
   is itself justified "for 2 players"** (`doom-mp-lockstep-sharedstate.spec.ts:75-76`).
   Generalising the floor by N while leaving the bound at a 2-player constant is exactly the
   "derived, not typed" failure that comment warns about. **Both must move together.**

### 3.8 Positive controls — REINTRODUCE THE DEFECT

Repo standard: prefer a POSITIVE control over a passing negative control.

**PC-1 — free-run divergence. ⚠ NOT free, and NOT the historical defect as stated.**
The tempting version is "flip the pre-P1 free-run path back on". It is **not reachable**:
`setupLockstep` takes the free-run branch only when `numPlayers <= 1`
(`DoomCard.svelte:524-531`), and the `__doomCards` hook surface (`:2022-2080`) exposes no
`setLockstep`/`setInputDelay`. It needs a **new dev-only hook** either way. And the naive
fallback — forcing `numPlayers = 1` — also calls `DGPT_LoopSetNetgamePlayers(1)`
(`d_loop.c:239`), disabling the cross-feed entirely: that produces **two unrelated
single-player games**, so a red result would prove "two unrelated sims diverge", not "the
pre-P1 coalescing transport diverges". **Label it a synthetic control or drop it.**

**PC-2 — inject a one-tic divergence. THE SHARPEST CONTROL; make this the primary.**
Dev-only `__doomCards[id].debugPerturbTicSet(tic, slot, dAngle)`: on **one peer only**, add
`dAngle` to one slot's `angleturn` in the consolidated TicSet just before
`extras.receiveTicSet(...)` (`DoomCard.svelte:650-652`).
*Expected:* all peers keep advancing at full rate (the TicSet is still **complete**, so the
barrier never stalls), and checksums diverge at `tic` and stay diverged.
⚠ **This also proves §3.5(a):** the engine's own `I_Error` will **not** fire, because
`receiveTicSet` stamps consistancy locally. A builder expecting the engine to catch this
would wrongly conclude nothing broke.

**PC-3 — starve one peer. Controls the CLASSIFIER, not divergence.**
Dev-only `__doomCards[id].debugStopAppending(true)` — skip `lockstep.appendLocal(...)`
(`DoomCard.svelte:642`) on one peer for K tics, then resume.
*Expected:* **no** checksum mismatch; instead every peer's `gametic` pins at `recvtic`, then
all resume together. **If this produces a mismatch, the divergence oracle is mis-wired.**

All hooks live inside the existing dev-only `__doomCards[id]` object
(`DoomCard.svelte:2014-2131`), stripped in prod. They touch DOOM code — permitted by the
2026-09-01 approval — and must be **purely additive**, never altering the non-debug path.
**A harness whose controls have never been fired is not evidence.** Record all verdicts in
the PR body.

### 3.9 Frame-based readiness — no flat ms delays anywhere

| Wait | Unit | Primitive | Bound |
|---|---|---|---|
| page boot / first paint | observable state | `waitForFunction(__attachProvider)`, `cardHookReady` | `BOOT_MS` / `SLOW_BOOT_TEST_TIMEOUT_MS`, `e2e/_helpers/boot-budget.ts:83,110` |
| relay convergence (A mutates → B observes) | observable state | `expect.poll` on `__patch.nodes`, `getState().memberIds.length`, `mySlot` | `SYNC_BUDGET_MS = 20_000`, `_collab-helpers.ts:36` |
| anything the **sim** must run | **game tics** | `waitTics(page, nodeId, n, cap)` | `SIM_BUDGET_MS = 60_000`, `_doom-helpers.ts:107` |
| N-peer rendezvous | **game tics, all peers** | new `waitAllTics` = `Promise.all` of `waitTics`, then assert each advance **by name** | `SIM_BUDGET_MS` scaled by N |

`waitTics` (`_doom-helpers.ts:150-188`) is already the right primitive: one `page.evaluate`,
rAF-paced (a rAF *is* a tic under the pump at
`node-doom-session-registry.svelte.ts:358-361` → `DoomCard.svelte:1777`), racing a 50 ms timer
so a fully stalled renderer still reaches the cap, and **returning the actual advance
observed** so the cap **bounds the failure rather than gating it**.

⚠ Note `SIM_BUDGET_MS` is *not* from `e2e/_helpers/boot-budget.ts` — that file is boot /
first-paint only. Using `SIM_BUDGET_MS` for sim work is still correct.

⚠ **Budgets must scale with N.** `SIM_BUDGET_MS`, `SYNC_BUDGET_MS`, `BOOT_MS` are flat. Under
a barrier the game runs at the min rAF rate across peers and the relay fans N× the writes;
the repo standard is to scale by input count, never flat. **Naming a new shared constant is a
decision I am flagging, not taking** — changing the shared constants would move budgets under
the existing 2-peer specs too. Prefer a **harness-local** `nPeerBudget(base, n)` ≈
`base × ceil(n/2)`.

Healthy steady state for the triple `(maketic, gametic, recvtic)`
(`DoomCard.svelte:2066-2071` → `dgpt_get_maketic/gametic/recvtic`, `recvtic` being the barrier
ceiling): all three climbing, `gametic ≈ recvtic`, and `maketic − gametic` **< 5** (§3.4 —
*not* `+6`, despite `DEFAULT_INPUT_DELAY_TICS`).

### 3.10 ⚠ Real desync vs starved runner — they ARE distinguishable

The premise "a freeze is a consistency abort, #345" is **no longer true on the lockstep
path**, and that is good news.

- **Mechanism 1 — consistency abort (#345).** `I_Error("consistency failure …")` → `exit(-1)`
  → whole WASM runtime aborts. **Unreachable under lockstep** (§3.5(a)), and also defused on
  the free-run path by `DGPT_OverlayRemoteCmds`.
- **Mechanism 2 — barrier stall (the live one).** `GetLowTic` clamps `lowtic` to
  `dgpt_recvtic`; `TryRunTics` returns rather than spinning. `gametic` stops; **the runtime is
  alive**. The C oracle already asserts its pause/resume semantics.

**The classifier.** Sample per peer per gametic: `(gametic, recvtic, maketic, checksum)` plus
`getLockstepLogSize()`.

| Observation | Diagnosis |
|---|---|
| All peers advancing; ∃ shared `T` with unequal checksums | **REAL DESYNC.** Report `T`, all checksums, all `mySlot`. |
| `gametic == recvtic` pinned, `maketic` still climbing, **on every peer** | **BARRIER STALL — some peer is not appending.** Not a desync. Name the slot (below). |
| `gametic` pinned **and** `maketic` pinned on peer *i*, others healthy | **PEER i's PUMP IS NOT RUNNING** — rAF starved / page frozen. **Instrument or environment fault, not a product fault.** This is the "starved runner" verdict. |
| `stateChecksum()` throws / checksum reads `null` | **WASM ABORT.** `checksumAt` already returns `null` on throw (`doom-mp-lockstep-sharedstate.spec.ts:223-239`); pair with a `pageerror` listener **on every peer** (⚠ none of the three current MP specs has one on P2). |
| `logSize` growing unbounded while `gametic` pinned | A wedged peer is pinning the barrier floor; `pruneBelowFloor`'s `MAX_KEEP_TICS_HARD_CAP = 1050` (`doom-lockstep.ts:103`) will force-drop and that peer must resync. |

**Name the culprit slot.** `LockstepTransport.drainReady` (`doom-lockstep.ts:211-232`) already
computes exactly this — it breaks at the first tic where some live slot has no entry — and
then discards it. Add a read-only diagnostic:

```ts
/** Diagnostic: the tic the barrier is blocked on, and which slots are missing. */
blockedAt(fromTic: number): { tic: number; missing: number[] } | null
```

surfaced as `__doomCards[id].getBarrierBlock()`. A stall failure then reads
*"peer P2 (slot 1) has not appended tic 412; P1 recvtic=412 gametic=412 maketic=415"*
instead of *"timed out"*. **This is the single highest-value diagnostic in the design** — it
turns the one failure mode that looks like everything else into a named, actionable one.
Verify it with **PC-3**, and assert it reports *stall with slot i missing* and specifically
**not** a checksum mismatch.

⚠ **Starvation already masquerades as coverage today.** `doom-late-join.spec.ts:258` and
`doom-identity-crossview.spec.ts:215` `skip` with `'DOOM runtime failed to load on A within
25s'`. On the un-audited collab lane that is indistinguishable from a real regression **and
produces a green job**. The new harness must **fail loudly on a slow runner, never skip**.

---

## 4. Runtime, flake risk, invocation

### 4.1 Runtime

Measured anchors: CI job `collab` total **417–500 s** against a 40-min cap; ~3.2 min fixed
setup within it, of which the C oracle ≈ **56 s**.

⚠ **No per-spec cost data exists for any `doom-mp-*` spec.**
`e2e/e2e-timings.generated.json` carries `doom-aspect` (32.8 s) … `doom-wasm` (12.6 s) but
**no** `doom-mp-*` / `doom-multiplayer` entries — @collab specs are grep-inverted out of the
lane that produces timings. This is a genuine measurement gap; closing it means running the
lane locally.

**Estimate on this machine** (real GPU, no SwiftShader): boot ≈ 25–35 s (N cold WASM instances
+ a 4 MB WAD each), launch/join/synchronised restart ≈ 10–20 s, a 200–400-tic burst at ~35 Hz
≈ 6–12 s, plus teardown. **2 peers ≈ 60–90 s; 4 peers ≈ 2–4 min**, dominated by boot and by
whichever peer's rAF is slowest. The current 2-peer spec sets `test.setTimeout(180_000)`; a
4-peer test wants **300–360 s**.

### 4.2 Flake risks, ranked

1. **Instrument-induced starvation** (§3.6). Highest; fully removable.
2. **CPU contention among 4 WASM sims** + the barrier's min-rate coupling, made worse by the
   inert build-ahead buffer (§3.4). Not removable — budget for it.
3. **Relay single-process contention.** One in-memory Node process; it **deadlocks at >1
   Playwright worker** (`ci.yml:1443-1445`, the #97 flake; repeated in `collab-nightly.yml`).
   **Any local invocation must be `--workers=1`.**
   ⚠ **Prose/tree disagreement:** `Taskfile.yml:1383-1387` `task collab` still runs
   `--workers=2` and its `desc` still argues for it, contradicting both CI files and the
   memory `relay-single-process-and-drift`. **Do not route an MP harness through `task
   collab` as it stands.**
4. **Stale `e2e:serve`.** `task e2e:serve` → `scripts/dev-server.sh cmd_start` starts **only
   the app** (`:246-256`); it never starts the relay. So `task e2e:one` (which sets
   `E2E_SKIP_WEBSERVER=1`) leaves @collab specs with **no relay on 1235**. The harness must go
   through a path that lets `playwright.config.ts:280-311` boot both webServers.
5. **Capacity cap** (§3.1) — a leaked socket poisons the next run.
6. **Recovered flakes.** CI runs `retries: 1` (`playwright.config.ts:150`); the collab lane's
   `--fail-on-flaky` **exempts DOOM by name** (§1.4 #2), so a recovered DOOM flake is a
   notice, not a red. Locally, run with `retries=0`.

### 4.3 Teardown — non-negotiable

Close every context in a `finally` (the existing specs do:
`doom-mp-lockstep-sharedstate.spec.ts:670-672`). After **any** local run:
`flox activate -- task e2e:stop`, then verify `pgrep -fl chrome-headless-shell` returns
nothing.

### 4.4 Invocation — OPTIONS WITH COSTS (owner decides)

| Option | What | Cost | Notes |
|---|---|---|---|
| **A. No new machinery** | `flox activate -- npx --workspace e2e playwright test --workers=1 tests/doom-mp-nplayer.spec.ts` | zero | Playwright boots app + relay itself. Verbose; `--workers=1` and the asset check are on the operator. |
| **B. Existing `task e2e`** | `flox activate -- task e2e -- --workers=1 tests/doom-mp-nplayer.spec.ts` | zero | Works today; same two footguns. |
| **C. New `task doom:mp`** | Taskfile target: assert assets present (**fail, not skip**), pin `--workers=1` and `retries=0`, run the spec, then `e2e:stop` + a leftover-process check | **machinery** — one new Taskfile target | Real ergonomic win; encodes all three footguns. ⚠ **OWNER DECISION.** |
| **D. Fix `task collab` to `--workers=1`** | one-line change + desc rewrite | small, but touches a shared target | Corrects a live prose/tree disagreement (4.2 #3); changes behaviour for every local @collab run. ⚠ **OWNER DECISION.** |
| **E. Any new CI job / gate / permanent lane** | — | **Out of scope for an agent** per the standing rulings. | See §4.5. |

Always cheap, always first — no relay, no browser, already 4-player:
```
flox activate -- node packages/web/native/doomgeneric/tests/lockstep-barrier.acceptance.mjs
```
⚠ It exits **0** when `DOOM1.WAD` is absent (`:168-173`) — another "skips are not passes"
edge to assert around locally.

### 4.5 Gating — OPTIONS WITH COSTS (owner decides; nothing taken)

| Option | Change | Cost | Effect |
|---|---|---|---|
| **G1. Audit collab's skips** | add `'collab'` to `AUDITED_LANES` (`e2e-skip-budget.mjs:47`), pass `--lane collab` at `ci.yml:~1665`, set `lanes:['collab']` on the DOOM MP budget entries | 3 files, no wall-time | Closes the largest blind spot: the lane reds the moment DOOM assets vanish. ⚠ Arming an existing gate on a new lane — **owner decision**. |
| **G2. Un-exempt DOOM from the flake gate** | narrow/remove `DOOM_SPEC` in `e2e-report-audit.mjs:52` | 1 file | Ends a standing exception to "a recovered flake reds the PR" — on the **required** `e2e` lane too. Highest blast radius of the four. ⚠ **owner decision**. |
| **G3. Put `collab` on the umbrella** | 3 coordinated edits (`needs:` + `env:` + failing `if`), enforced by `scripts/ci-umbrella-parity.test.ts` | ≈0 added merge latency (417–500 s runs parallel to the ~13–17 min `e2e` critical path) | Makes DOOM multiplayer a merge gate. Risk: historical contention flake now reds PRs. ⚠ **owner decision**. |
| **G4. Require the context in ruleset `16042163`** | repo settings only | no tree change, no parity coupling | Same gating effect as G3, different lever. ⚠ **owner decision**. |
| **G5. Instrument `collab-nightly`** | add the `json` reporter + audit step it currently lacks | 1 file | Makes the backstop able to notice anything. ⚠ **owner decision**. |
| **G6. Status quo + local ritual** | run the N-peer harness before merging any DOOM change; document it | zero CI change | Honours "no new gates" completely; relies on discipline. |

---

## 5. Build order for an executor

1. **Assets.** Symlink/build `static/doom/{doom.js, doom.wasm, DOOM1.WAD, doom-mp-node.js,
   doom-mp-node.wasm}`. Verify `assetsPresent()` is true before anything else.
2. **C oracle first, always.** `node …/lockstep-barrier.acceptance.mjs`. 4-sim bit-exactness
   and pause/resume at zero browser cost. If it is red, no browser harness will make sense.
3. **`e2e/tests/_doom-mp-helpers.ts`** — extract the byte-identical `boot` / `assetsPresent` /
   `cardHookReady` / `getState` / `waitForSlot` / `waitForLevel` triplicated across three
   spec files, and generalise `boot` to **N contexts on one browser** (§3.1).
4. **In-page recorder + `waitAllTics`** (§3.6, §3.9). Prove them against the **existing**
   2-peer scenario first: identical verdict, materially lower instrument cost.
5. **Diagnostics:** `LockstepTransport.blockedAt()` + `__doomCards[id].getBarrierBlock()`.
6. **Debug hooks:** `debugPerturbTicSet`, `debugStopAppending` (and `debugForceFreeRun` only
   if the owner wants the synthetic PC-1), all additive inside `__doomCards`.
7. **`e2e/tests/doom-mp-nplayer.spec.ts`** — N=4, `@collab`-tagged, `test.setTimeout(360_000)`,
   `pageerror` guard on **every** peer.
   ⚠ **Filename matters.** `e2e/webgl-heavy-globs.ts` matches spec files **by prefix**; a name
   colliding with a heavy module's prefix can land the spec in **no CI job**, green forever.
   Check the chosen name against that file before committing.
8. **Fire all controls** and record verdicts in the PR body.
9. **Flake-check `REPEAT=3`**, then `task e2e:stop` + `pgrep -fl chrome-headless-shell` empty.
10. **Fix the false prose** you relied on: `doom-mp-real.spec.ts:547`, `:711`,
    `_doom-helpers.ts:~97` (backgrounding), `d_loop.c:1055` and `:1189` (divergence oracle),
    `ci.yml:99` (four contexts). Per `AGENTS.md`, say when prose disagrees with the tree.

---

## 6. Open questions for the owner

1. **Gating.** Which of **G1–G6** (§4.5), if any? G1 is the cheapest and closes the largest
   blind spot. G2 has the widest blast radius because it touches the **required** `e2e` lane.
   G3/G4 make multiplayer a merge gate. **Nothing has been done.**
2. **Why is `collab` still un-gated?** `ci.yml:2212` blames "task #69" and a pending "5×
   collab-flake-purge" that **has no machinery and cannot have run**. The lane is 9/9 green in
   the runs cited plus 8–10 green nightlies. Is the blocker still real?
3. **The DOOM flake exemption (`DOOM_SPEC`).** Was it a deliberate standing exception, or
   scaffolding that outlived its reason? It currently silences DOOM flakes on the required
   lane.
4. **The 5-hour window.** Prod deploys at 04:00 UTC; the multiplayer backstop runs at 09:00
   UTC and is uninstrumented. Acceptable, or should one of them move?
5. **New Taskfile target** (`task doom:mp`, option C) — yes or no? And should `task collab`'s
   `--workers=2` be corrected to `--workers=1` (option D), given it contradicts both CI files?
6. **Is a 4-peer spec wanted on CI at all**, or is the N-peer harness a **local-only ritual**
   (G6)? The owner's own message leaned local, and the wall-time delta on a shared lane needs
   sign-off regardless.
7. **`setInputDelay` is inert in the browser build** (§3.4). Is that intended (the P1 work
   landing ahead of `FEATURE_MULTIPLAYER` in the browser), or a real latency-hiding bug worth
   a separate fix? It materially affects 4-peer stall behaviour.
8. **PC-1.** Do you want a synthetic free-run control at all, given it is not the historical
   defect and needs a new hook either way? PC-2 is strictly sharper.

---

## 7. What this plan cannot see

1. No `doom-mp-*` spec has ever been cost-measured; §4.1 runtimes are estimates from a job
   total, not measurements.
2. Nobody ran the @collab lane locally on this machine in the course of this investigation —
   no local run artifacts were inspected.
3. `deriveAnonToken`'s **client-side** call path (`+layout.svelte:167`) was not traced. If a
   local harness fails at `__attachProvider` with `unauthorized`, look there first.
4. `ticdup` is assumed `== 1` everywhere (§3.5(a) depends on it). No site setting otherwise
   was found, but it was not exhaustively proved.
5. Whether the deleted `BENIGN_SKIPS` rule set had drifted relative to today's spec text
   before deletion — the classifier's *purpose* was read, not a rule-by-rule audit.
6. The real invite/anon **product** flow is bypassed by `__attachProvider`. The harness will
   not cover it.
