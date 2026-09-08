# `.myrobots/` retirement — execution plan (repo-grounded, PLANNING ONLY)

Status: PLAN (not yet executed). The plan itself is landed as this document; the
migration it describes is **not** run here and is still sequenced **after** the
`feat/native-preflight` → `main` merge (its base `feat/device-slots` #2361 is an
ancestor of `feat/native-preflight`, so one merge lands both). Every number below
was measured from `origin/main` (`370014a168…`, HEAD at authoring) via
`flox activate -- git …`, never from the stale primary checkout.

Home: `docs/migrations/myrobots-retirement-plan.md`. This is authority tier 4
(a durable decision under `docs/`) per AGENTS.md; it is **not** authored into
`.myrobots/`.

All four open decisions from the draft are **owner-approved (2026-09-07)** and
folded in: (1) `audio-runtime` becomes a 4th shared skill; (2) the canonical
"explicitly consumed" definition gates package deletion; (3) the BLOOD finding is
**archived, not** promoted to a prohibition; (4) this plan lives in `docs/`.

---

## 0. What the assumed pre-flight merge actually changes

`feat/native-preflight` is **not** a bulk-relocation branch and touches
`.myrobots/` only lightly:

- vs `main` it **adds no net `.myrobots` files** — the 7
  `.myrobots/2026-09-03-legacy-removal-plan-v2/{ci-first-signal,s0,s2..s6}.md`
  files it introduces relative to the merge-base are **already on `main`**
  (added there independently). The set-difference `main \ native-preflight` is a
  single file (`.myrobots/2026-09-06-samsloop-load-silence-and-fleet-audit.md`,
  main-only, survives the merge). `native-preflight \ main` is empty.
- Its only `.myrobots` content change is a **modification** of
  `.myrobots/2026-09-04-native-shell-plan/interruption-matrix.md`.
- It **deletes nothing** under `.myrobots/` (name-status shows only `A`/`M`).

**Therefore post-merge `main` has the same `.myrobots` shape as `main` today:
303 tracked files, 9.09 MB.** All stage counts below use 303. The native-shell
work "consuming" specs means the code now implements them; consistent with the
AGENTS.md boundary, the spec package is **not** deleted by the merge — it becomes
a Stage-3/4 extraction+archive candidate once the shell ships and is explicitly
consumed.

---

## 1. Corrected facts table (claim → verified)

| # | Owner claim (@ `fd0f88c5`) | Verified value (`origin/main` `370014a1`, post-merge unchanged unless noted) |
|---|---|---|
| 1 | checkout clean at `fd0f88c5` | Primary checkout **is** at `fd0f88c52d` on `review/slots-in-shell` (the "264 ahead/5 behind" bulk-relocation-unfriendly branch; git-status snapshot's `fix/inventory-regen-2` was stale). Measure from `origin/main` = `370014a168`. |
| 2 | `.myrobots` = 302 tracked files | **303** on `main`; **303** post-merge (native-preflight adds 0 net). Off-by-one is main drift since `fd0f88c5`. |
| 3 | 9.7 MB | **9.09 MB** (9,534,081 bytes). |
| 4 | 213 md / 83 html / 4 png / 1 tsv / 1 extensionless | **214** md / 83 html / 4 png / 1 tsv / 1 extensionless. Extensionless = `.myrobots/FABLE_PERF_PLAN`. |
| 5 | 118 files outside `.myrobots` cite it | **122** files. Breakdown: 63 `packages/` (52 `packages/web`, 11 `packages/dsp`), 45 `art/` (38 `art/scenarios`, 6 `art/setup`, 1 `build_gallery.py`), 6 `scripts/`, and 1 each in `e2e/`, `docs/adr/`, `Taskfile.yml`, `AGENTS.md`, `.gitignore`, `.github/`, `.dockerignore`, `.claude/skills/`. |
| 6 | 9 internal `.myrobots→.myrobots` refs point at ABSENT files | **9 — exact** (list in §2). |
| 7 | 4 of them have no history in local refs | **4 — exact**: `plans/4090-gh-runner-investigation-2026-06-23.md`, `plans/song-mode-arranger-2026-06-16.md`, `plans/test-stability-restoration.md`, `plans/webgl-attestation-semaphore.md`. The other 5 **are recoverable** (see §2 — 4 of the 5 recover from a single stash the owner did not know still held them). |
| 8 | `.myrobots/MOOG/` package missing | **Confirmed missing everywhere** (no ref, reflog, stash, or worktree). Cited by **27 `packages/dsp/moog*.ts`** files as the clone-initiative source, incl. `.myrobots/MOOG/LICENSING.md` (clean-room "own-code only" provenance) and "`.myrobots/MOOG/ spec Fig 9`". **Not locally recoverable.** |
| 9 | 42 bespoke-wave + face-spec modules all in `STRICT_FACES` | **Exact**: 35 bespoke-wave module dirs + 7 `face-specs/*.html` = **42 unique**, and **all 42 are in `STRICT_FACES`** (194 members total). Zero missing. |
| 10 | `face-specs/INDEX.html` still says 10 faces unbuilt | **Confirmed stale**: §2.2 header reads "SPEC EXISTS, FACE NOT BUILT — 10 modules with wave-5/6/7 packages". Contradicted by `STRICT_FACES`; **code wins**. |
| 11 | `module-face-lint` passes 65 tests | **65** `it/test` blocks in `packages/web/src/lib/ui/workflow/module-face-lint.test.ts`. |
| 12 | Only 3 shared skills, hard-coded in `agent-context.test.ts` + Codex symlink | **Confirmed**. `.claude/skills` = 4 (`brief-replies` [Claude-only], `deploy`, `module-surfaces`, `renderer-tests`). `.agents/skills` = 3 symlinks (shared subset). The gate hard-codes `toEqual(['brief-replies','deploy','module-surfaces','renderer-tests'])` and derives Codex = `claude.filter(!CLAUDE_ONLY)` + asserts each `.agents/skills/*` is a symlink `realpath`-equal to its `.claude/skills` twin. Adding a 4th shared skill edits the array **and** creates the symlink. |
| 13 | Non-empty `.myrobots` secret scan | **Confirmed**. `agent-context.test.ts` scans **all** tracked `.myrobots` records against 6 `SECRET_TOPOLOGY` patterns, with a non-vacuity guard ("if `.myrobots` is gone for good, DELETE this gate") and a two-direction negative control that plants `.myrobots/CANARY.md` / `.myrobots/BENIGN.md`. |
| 14 | (implied current state) legacy card UI lives behind `?shell=legacy` | **FALSE on real `main`.** AGENTS.md Product-state: "`ModuleShell` face is the **ONLY** module UI. There is no legacy card, no `?shell=legacy`, no fallback renderer." `docs/design/face-migration.generated.md` is **deleted**. (The system-prompt AGENTS.md snapshot is stale — MEMORY already flags this.) Consequence: the face program's remaining debt is **purely package consumption**, not module migration. |

Extra structural facts the plan relies on:

- **Tree-wide citation gate is already DELETED (2026-08-23)** with a tombstone
  comment in `scripts/agent-context.test.ts` explaining it "reddened CI on
  paperwork, not on an event" (blocked green PR #2133). **This is the
  owner's "dead comment blocks every merge" REJECTED gate — do not resurrect.**
  The KEPT leg is the standing-docs pointer check (corpus = CLAUDE.md /
  AGENTS.md / README / `.claude/skills` / `docs` / `runbooks`), which does **not**
  scan `.myrobots→.myrobots` — hence the 9 dead internal refs go ungated today.
- **Tracked-path denylist gate = `scripts/no-scratch-tracked.test.ts`** — a
  `DENY` array of regexes over `git ls-files` + a negative control. Stage-6's
  "add `.myrobots/` to the denylist" is a one-line pattern add here plus its
  matching synthetic sample. (Owner-sanctioned by Stage 6; not a new gate.)
- Routing homes already exist: `docs/adr/` (7 ADRs + `README.md`), `runbooks/`
  (15 files incl. `secrets-and-accounts.md`, the single secret-topology home),
  `docs/design/` (3 files). **No `evidence/` tree exists yet.**
- Corpus shape: `plans/` = 118 files (largest bucket), 33 loose top-level
  session files, bespoke-wave1..7 (the 42-module packages), `native-shell-plan`
  (9), `face-specs` (8), `legacy-removal-plan-v2` (7), plus `mockups`,
  `blind_analysis_findings`, `stereo-audio-plan`, `mixmstrs…`,
  `clip-menu-proof`, `quadralogical-face-mocks`.

---

## 2. The 9 dead internal references + recoverability

Cited inside `.myrobots` records, absent from the tracked corpus:

| Dead path | Recoverable from | How |
|---|---|---|
| `2026-08-31-native-shell-spec.md` (native-shell source spec) | **`stash@{0}`** | `git show 'stash@{0}^3:.myrobots/2026-08-31-native-shell-spec.md'` (untracked-tree parent of the stash) |
| `2026-09-03-legacy-removal-plan-v2/plan.md` (legacy-removal master plan) | **`stash@{0}`** | same, that path |
| `2026-09-04-desktop-review-APPROVED.md` (approved desktop review) | **`stash@{0}`** | same, that path |
| `2026-08-21-batch-22-video-thin-tail-derivation.md` | **`stash@{0}`** + reflog commit `d98063c95c` | stash path, or `git show d98063c95c:<path>` |
| `plans/face-redo-sixstrum.md` | **git history** | `git show d58a450851^:.myrobots/plans/face-redo-sixstrum.md` (deleted in triage #1362) |
| `plans/4090-gh-runner-investigation-2026-06-23.md` | **nowhere local** | owner's machine / unfetched GitHub branch only |
| `plans/song-mode-arranger-2026-06-16.md` | **nowhere local** | " |
| `plans/test-stability-restoration.md` | **nowhere local** | " |
| `plans/webgl-attestation-semaphore.md` | **nowhere local** | " |

**5 recoverable, 4 truly gone** — matching the owner's "four have no history."

> ⚠ **P0 preservation risk.** Four of the five recovery copies exist ONLY inside
> `stash@{0}`, whose message is **"disposable pre-slots-review state
> (fix/inventory-regen-2)."** `git stash` is **shared across all worktrees**
> (8 live worktrees exist). A single `git stash drop`/`clear` — or whoever owns
> the slots-review branch deciding that state is "disposable" — destroys the
> only copies. **Stage 1 must materialize `stash@{0}`'s `.myrobots` subtree into
> the preservation tag before any other work, and before anyone touches the
> stash.** (`git stash show --include-untracked --name-only 'stash@{0}'` lists
> 40+ `.myrobots` paths captured there, including the 3 owner-named records.)

### `.myrobots/MOOG/` (separate, external-cited)

Cited by **27 `packages/dsp/moog*.ts`** files (29 textual refs). Absent from all
refs/reflog/stashes/worktrees. Two of the citations are **legally load-bearing**:
`moog902.ts` grounds the clean-room claim ("NOT a port of any Moog schematic or
copyleft source — `.myrobots/MOOG/LICENSING.md`: permissive / own-code only")
and "`.myrobots/MOOG/ spec Fig 9`" anchors a gain law. The 25 `moogXXX` modules
have **shipped** (all in `STRICT_FACES`). Recovery is owner-side only; if it
cannot be recovered, the provenance must be **reconstructed** into an ADR before
the 27 citations are rewritten — do not silently drop a licensing attestation.

---

## 3. Hard boundaries this plan operates under (cited)

1. **AGENTS.md authority order**: (1) code/artifacts, (2) AGENTS.md, (3) skill,
   (4) `docs/`+`runbooks/`, (5) `.myrobots/` as **evidence, not instruction**.
   When prose disagrees with the tree, **code wins** (INDEX.html §2.2 and the
   stale system-prompt AGENTS.md are both overridden by the tree).
2. **AGENTS.md package boundary** (verbatim): "do not delete, move, or rename a
   spec/mock package until its module has shipped **and** the package has been
   **explicitly consumed**." Shipping (in `STRICT_FACES`) is necessary but **not
   sufficient**; consumption is a separate, recorded act (Stage 4).
3. **`.myrobots` is evidence; owner REJECTED status metadata on it.** The
   manifest therefore lives **outside** `.myrobots` (Stage 2), and the
   destination `evidence/` tree is **explicitly non-authoritative** (below tier 5).
4. **NOBODY opens GitHub issues** (owner ruling). Defects found mid-migration are
   fixed in the coherent PR or reported to the owner — never filed.
5. **No new CI gates without owner discussion**, and the tree-wide
   "dead-`.myrobots`-pointer blocks every merge" gate was **already tried and
   deleted (2026-08-23)** — the citation audit (Stage 5) is a **one-time script**,
   not a standing gate.
6. **Measure from `origin/main`**, never the stale primary checkout.
7. **NEVER touch DOOM.** `doom` is in `STRICT_FACES` and DOOM narrative records
   exist under `.myrobots` (e.g. multiplayer/collab-attest notes). Exclude every
   DOOM record/spec/wait/budget by name from every sweep and state why; DOOM
   extraction, if ever, is a separate owner-approved action.
8. **Linux CI authors the single VRT baseline set** — any face-consumption
   verification (Stage 4) uses scoped `GREP=<module> task vrt:commit`, never a
   locally captured baseline.

---

## 4. The staged plan (grounded)

### Stage 1 — Recover + freeze (do FIRST, before the stash can rot)

1. **Confirm the base.** Verify `feat/native-preflight` (+ `feat/device-slots`
   #2361) is merged and `main` is green; branch all migration work from that
   green `main`. Do **not** run the migration on `review/slots-in-shell`.
2. **Rescue the at-risk stash — ✅ DONE (2026-09-07).** The owner pinned
   `stash@{0}` (the 41-file "disposable pre-slots-review state" stash that held
   the 4 otherwise-unrecoverable records — native-shell source spec,
   legacy-removal master plan, approved desktop review, batch-22 derivation) to
   the annotated tag **`myrobots-evidence-rescue-2026-09-07`** and pushed it to
   `origin`. The P0 loss window is closed; the stash may now be dropped without
   losing those records. When the migration runs, materialize the needed records
   from that tag rather than from the (now-expendable) stash:
   ```sh
   flox activate -- git show 'myrobots-evidence-rescue-2026-09-07^{tree}'   # inventory
   flox activate -- git show 'myrobots-evidence-rescue-2026-09-07:.myrobots/2026-08-31-native-shell-spec.md'
   ```
   `face-redo-sixstrum.md` still recovers from `d58a450851^`; the batch-22
   record also exists at `d98063c95c` and inside the rescue tag.
3. **Create the *second* tag — the pre-migration corpus snapshot (PENDING).**
   Distinct from the rescue tag above: this pins the last pre-migration `main`
   commit so the full tracked corpus (303 files, 9.09 MB) is immutably
   retained. **Create it only once the pre-flight is merged to `main`:**
   ```sh
   flox activate -- git tag -a myrobots-preserved-2026-09 <green-main-sha> \
     -m 'Immutable snapshot of .myrobots/ before retirement (303 files, 9.09 MB).'
   flox activate -- git push origin myrobots-preserved-2026-09
   ```
4. **MOOG remains unrecoverable locally — flag owner-side recovery.**
   `.myrobots/MOOG/` (with `LICENSING.md`) is absent from every ref, reflog,
   stash, and worktree, and is **not** in the rescue tag. Before Stage 5 rewrites
   the 27 DSP citations, the owner checks their machine / any unfetched GitHub
   branch; if it cannot be recovered, its clean-room provenance is
   **reconstructed into an ADR** (Stage 5). The 4 lost `plans/*` records
   (`4090-gh-runner-investigation`, `song-mode-arranger`,
   `test-stability-restoration`, `webgl-attestation-semaphore`) are accepted as
   lost unless the owner still holds them.
5. **Freeze**: stop creating new `.myrobots` records; allow only
   recovery/status/consumption edits for the duration. (This is a working
   convention, not a CI gate — no new gate.)

### Stage 2 — Mechanical ledger (manifest OUTSIDE `.myrobots`)

Build a generated manifest (e.g. `evidence/MANIFEST.tsv` or a scratch file the
owner later places) with **one row per tracked `.myrobots` path**, columns:
`path, sha256, category, current|stale, canonical_destination,
external_citers, shipped_evidence, open_owner_decisions, consumed_by(commit/PR),
archive_disposition`. Generator sketch (deterministic, never hand-maintained):

```sh
flox activate -- git ls-tree -r --name-only origin/main -- .myrobots \
| while read -r p; do
    sha=$(flox activate -- git show "origin/main:$p" | shasum -a 256 | cut -d' ' -f1)
    citers=$(flox activate -- git grep -l -F "$p" origin/main -- ':!.myrobots' | wc -l | tr -d ' ')
    printf '%s\t%s\t%s\n' "$p" "$sha" "$citers"
  done
```

Category is derived from the path prefix (bespoke-wave*/native-shell-plan/… =
package; `plans/` = investigation; loose dated `.md` = session narrative;
`face-specs/` = spec; `mockups`/`*-face-mocks` = mock). **Both-direction gate**
(as a one-time check, not a standing CI gate): every manifest row maps to a
tracked path AND every tracked path has exactly one row —
```sh
comm -3 <(cut -f1 MANIFEST.tsv | sort) \
        <(flox activate -- git ls-tree -r --name-only origin/main -- .myrobots | sort)
# must be empty in both columns
```
DOOM records are listed but flagged `DOOM — excluded, owner-only`.

### Stage 3 — Extract durable knowledge by DOMAIN (progressive disclosure)

Route content, do **not** copy plans wholesale into skills. Concrete routes
grounded in what exists:

| Domain | Destination | Notes |
|---|---|---|
| Surface/runtime lessons (bespoke-wave READMEs, wave-7 `SURFACES.md`, the "6 gates a face PR satisfies", typed-entry `mountsTypedEntry` trap, testid-census-is-not-affordance-census) | `.claude/skills/module-surfaces` **references/** (a new `references/consumption-checklist.md` + distilled bespoke lessons) | Keep module-specific mocks OUT. No SKILL.md count change → **no `agent-context.test.ts` edit**. |
| Renderer/testing (sustained-negative polling, dead-selector subjects, required-vs-non-required VRT coverage) | `.claude/skills/renderer-tests/references/silent-failures.md` (extend) | **BLOOD finding: ARCHIVE only** (owner-approved 2026-09-07) — it goes to `evidence/archive/2026/` as evidence, and is **not** promoted to a permanent prohibition in this skill. |
| Audio invariants (stereo/dual-mono ownership, trigger/gate/edge `createEdgeCounter` seam, factory-vs-DSP blindness, poly/MIDI audible-output) | **new `audio-runtime` shared skill** (owner-approved 2026-09-07) + `docs/adr/` for the "why" | These four topics are the recurring category that justifies the skill (see the audio-runtime creation steps below). AGENTS.md boundaries #7/#8 keep the *rule*; the ADR keeps the *why*; the skill carries the *reusable judgment*. |
| Native-shell lifetime/interruption (`native-shell-plan/*`, `interruption-matrix.md`) | `docs/adr/` + `docs/design/` | Architecture/product decision, **not** the audio-runtime skill (owner: keep native-shell in ADRs/design docs). |
| Ops (build/deploy fragments, CI notes) | `runbooks/` (+ `deploy` skill for deploy/build ops only) | Secret topology → `runbooks/secrets-and-accounts.md` only. |
| Repo-wide safety invariant | AGENTS.md (short) | Only if it changes future decisions and isn't already there. |

References are **pointers with the durable fact inlined**, then the raw plan is
archived (Stage 4/6) — never the full plan pasted into a skill.

#### Stage 3a — Create the `audio-runtime` skill (owner-approved)

`audio-runtime` becomes the **4th shared skill** (raising the shared set from 3
to 4; `.claude/skills` from 4 to 5 counting Claude-only `brief-replies`). Because
`scripts/agent-context.test.ts` hard-codes the exact skill roster and enforces
the Codex symlink, creation is a precise, gated sequence:

1. **Package the skill**: `.claude/skills/audio-runtime/SKILL.md` (+ any
   `references/`). Scope it to exactly the four recurring audio topics, each a
   short reusable-judgment reference that points at the ADR/boundary for detail:
   - **stereo / dual-mono ownership** — who owns the second channel; the
     double-patch-missing-half / Deluge-model pitfalls.
   - **trigger / gate / edge semantics** — the shared `createEdgeCounter` seam;
     no hand-rolled whole-buffer `AnalyserNode` rescans (double-counts the edge);
     gate consumers stay level-sensitive (AGENTS.md #7).
   - **factory-vs-DSP test blindness** — an engine-direct/factory test can pass
     while the shipped DSP path is silent; assert the real chain.
   - **poly / MIDI audible-output** — a poly/MIDI module ships an e2e wiring the
     real default-mode source through the module to an audible-output assertion
     (AGENTS.md #8).
   Keep module-specific mocks and native-shell architecture **out**.
2. **Edit the hard-coded roster** in `scripts/agent-context.test.ts`: the array
   `['brief-replies','deploy','module-surfaces','renderer-tests']` becomes
   `['audio-runtime','brief-replies','deploy','module-surfaces','renderer-tests']`
   (the assertion is sorted, so `audio-runtime` sorts first). The Codex leg
   derives `claude.filter(!CLAUDE_ONLY)` automatically — no edit there beyond the
   symlink in step 3.
3. **Create the Codex symlink**: `.agents/skills/audio-runtime` →
   `../../.claude/skills/audio-runtime` (a real symlink; the gate asserts
   `lstat().isSymbolicLink()` and `realpath` equality with the `.claude` twin —
   never a copied directory).
4. **List it in AGENTS.md's Skills section** alongside `module-surfaces` /
   `renderer-tests` / `deploy`, one line.
5. Run the focused gate: `flox activate -- task test:one -- agent-context`
   (`REPEAT=3`) — it proves both discovery paths and the roster.

This is the one sanctioned skill-count change; `module-surfaces` /
`renderer-tests` reference additions (above) do **not** touch the roster and so
need no `agent-context.test.ts` edit.

### Stage 4 — Consume the 42 face packages, wave by wave

For each of the 42 modules (35 bespoke-wave dirs + 7 face-spec html), per wave:

1. Re-read `def / factory / face / extension / tests` in `packages/web` against
   the package's `spec.md` + mock HTML.
2. Verify the **load-bearing affordances survived** promotion (the specs' own
   §-numbered checklists — e.g. `optionsExhaustive` rosters, `noUserControl`
   writer anchors, typed-entry routing). Confirm the module is in `STRICT_FACES`
   (all 42 already are) **and** that visual review happened (scoped VRT).
3. **Record the consuming commit/PR** for that package (this is the "explicitly
   consumed" act the AGENTS.md boundary and the owner both require — shipping
   alone is insufficient). The manifest row's `consumed_by` is filled here.
4. Extract any reusable lesson (Stage 3), then **archive the mock/spec** to
   `evidence/archive/2026/…` and drop the package from `.myrobots`.

**Canonical "explicitly consumed" definition (owner-approved 2026-09-07 — this
is the gate that finally permits deleting the 42 face packages):** a package is
consumed when **all three** hold —
1. its module is in `STRICT_FACES`, **and**
2. a named consuming commit/PR is recorded in the manifest's `consumed_by`, **and**
3. `module-face-lint` **and** scoped VRT (`GREP=<module> task vrt:commit`) are
   green for it.

`STRICT_FACES` membership **alone is not consumption** — all three legs are
required before a package may be moved/deleted (this is the AGENTS.md boundary's
"shipped AND explicitly consumed" made operational). Two packages take explicit
non-standard dispositions instead of the standard gate: **`clipplayer`** (owner
chose "card stays, no face"; the `NON_SHELL_LANE_TYPES` carve-out is the shipped
design — archive its spec as a decision record, do not treat as a missing face)
and **`joystick`** (generic-face candidate blocked on a platform decision, not a
spec gap — **do not mark consumed**; it waits on a lane-capable pad / glyph
binding / `EMPTY_LANE_OK` ruling).

### Stage 5 — Rewrite the 122 external citations by intent (one-time)

A single migration-audit script classifies each of the 122 citers and routes:

| Citer class (count) | Rewrite target |
|---|---|
| `packages/dsp/moog*.ts` → `.myrobots/MOOG/…` (27 files, dead) | **Reconstruct provenance into an ADR** (`docs/adr/00X-moog-clone-provenance.md`, incl. the "own-code / not-copyleft" LICENSING attestation) and repoint the comments there. Blocked on Stage-1 recovery attempt. |
| `art/scenarios` + `art/setup` provenance (44) → `.myrobots/plans/art-backfill…` etc. | Repoint to `evidence/archive/…` where the record lands, or drop to a bare "(provenance archived)" note. |
| `packages/web` design-rationale comments (52) → `.myrobots/plans/…`, `.myrobots/stereo-audio-plan/plan.md` (live) | Repoint to the ADR/design doc the rationale moves to; keep as code comments. |
| `Taskfile.yml`, `scripts/` operational refs (7) | Repoint to `runbooks/` or an AGENTS.md invariant. |
| `AGENTS.md`, `.claude/skills` (2) | Repoint to maintained references only. |
| `.gitignore`, `.dockerignore`, `.github`, `docs/adr` structural refs | Keep/adjust as structural (these legitimately name `.myrobots/` to ignore/exclude it). |

The audit runs **once** and reports; it is **not** wired into CI (the deleted
2026-08-23 gate stays deleted). Dead `.md/.html` external citations today are
only the 2 synthetic test canaries (`CANARY.md`/`BENIGN.md`), so real code
comments already resolve; the live work is the `MOOG/` dir cluster.

### Stage 6 — Retire

Only once every manifest row is consumed / canonicalized / archived:

1. Remove `.myrobots/` from the tree.
2. Update **AGENTS.md**: replace tier-5 ("`.myrobots/` as evidence, not
   instruction") and the package-queue sentence with the new
   **`evidence/` authority** statement (evidence/ is non-authoritative, below
   tier 5; active vs archive subtrees). Ground this on the **real** main
   AGENTS.md (legacy already gone; no `?shell=legacy`).
3. Update `docs/adr/README.md` to index the new provenance/audio/native-shell
   ADRs created in Stages 3/5.
4. **Replace the secret scan**: in `scripts/agent-context.test.ts`, repoint
   `myrobotsRecords()` / `surfaceDocs` / the `CANARY`/`BENIGN` fixtures from
   `.myrobots/` to the active-evidence path so the scan covers `evidence/active/`
   (its non-vacuity guard explicitly says: if `.myrobots` is gone, either move
   the scan or DELETE the gate — moving it is the intent). No new gate; the
   existing one changes its corpus.
5. **Add `.myrobots/` to the tracked-path denylist**: append
   `{ re: /(^|\/)\.myrobots\//, why: 'retired agent-evidence tree — archived under evidence/' }`
   to the `DENY` array in `scripts/no-scratch-tracked.test.ts`, and add a
   matching synthetic sample to its negative-control list. (Owner-sanctioned by
   this stage.)
6. **Verify zero remaining `.myrobots` references**:
   `flox activate -- git grep -l '\.myrobots' -- ':!scripts/no-scratch-tracked.test.ts'`
   returns nothing but the denylist pattern itself and the `.gitignore`/ignore
   entries you choose to keep.
7. Run focused gates `REPEAT=3` (`agent-context`, `no-scratch-tracked`,
   `module-face-lint`, `vrt-gallery`) + `task typecheck` + the appropriate full
   suite. Merge only when this PR's exact final commit is green.

---

## 5. Sequencing / dependency shape

```
pre-flight → main (assumed)  ─┐
                              ▼
Stage 1 Recover+freeze  ── stash RESCUED (tag myrobots-evidence-rescue-2026-09-07);
                           corpus preservation tag pending pre-flight merge
                              ▼
Stage 2 Manifest (both-way gate, outside .myrobots)
                              ▼
Stage 3 Extract by domain ──► feeds Stage 4/5 targets (ADRs, skill refs, runbooks)
                              ▼
Stage 4 Consume 42 faces, wave by wave ──► fills consumed_by, archives packages
                              ▼
Stage 5 Rewrite 122 citations by intent (one-time audit; MOOG provenance ADR)
                              ▼
Stage 6 Retire: remove .myrobots, AGENTS.md/ADR-README, move secret scan,
        denylist add, zero-ref verify, REPEAT=3 + typecheck + full suite
```

PRs are batched but small; each wave in Stage 4 can be its own PR (never touches
shared list files without a local `origin/main` merge — AGENTS.md #6). No PR
requires an issue; the PR body is the searchable record.

---

## 6. Top risks + open owner decisions the plan surfaces

**Risks**
1. **~~P0 — the disposable stash~~ — CLOSED (2026-09-07).** The 4-of-5 recovery
   copies that lived only in the "disposable pre-slots-review state" stash are
   now pinned to annotated tag `myrobots-evidence-rescue-2026-09-07` on `origin`.
   The stash may be dropped without loss. Residual: only the *corpus* preservation
   tag remains pending (Stage 1 step 3, after the pre-flight merge).
2. **MOOG licensing provenance — OPEN, owner-side.** 27 DSP files ground a
   clean-room "own-code, not copyleft" claim on `.myrobots/MOOG/LICENSING.md`,
   unrecoverable locally and **not** in the rescue tag. Rewriting those citations
   without reconstructing the attestation would delete a legal record. Owner
   attempts recovery from their machine / unfetched branch; failing that, Stage 5
   reconstructs it into an ADR before repointing the comments.
3. **Consumption ≠ shipping.** All 42 modules are in `STRICT_FACES`, but the
   AGENTS.md boundary forbids deleting the packages until *explicitly consumed*
   (canonical 3-leg definition now in Stage 4). Archiving on `STRICT_FACES`
   membership alone would violate the boundary and lose the spec's load-bearing
   §-checklists.
4. **Stale prose still being read as truth.** `face-specs/INDEX.html` says 10
   faces unbuilt; the system-prompt AGENTS.md says legacy still exists. Both are
   false vs the tree. Any agent seeded from them mis-plans — the manifest's
   `current|stale` column must mark these explicitly.
5. **Gate-shape regression.** Re-introducing tree-wide dead-pointer enforcement
   (rejected/deleted 2026-08-23) would re-block green PRs on paperwork. Keep the
   citation audit a one-time script.
6. **`audio-runtime` skill-roster edit is a shared/gated file.** Adding it edits
   the hard-coded array in `scripts/agent-context.test.ts` and the
   `.agents/skills` symlink set — a merge-conflict-prone shared file. Follow
   AGENTS.md #6 (merge `origin/main` locally, verify both sides) and never
   `gh pr update-branch` it.

**Owner decisions — RESOLVED (2026-09-07)**
- ✅ **`audio-runtime` IS a 4th shared skill.** Scoped to the four recurring
  audio topics (stereo/dual-mono ownership, trigger/gate/edge semantics,
  factory-vs-DSP test blindness, poly/MIDI audible-output). Native-shell
  architecture stays in ADRs/design docs, **not** this skill. Creation steps:
  Stage 3a.
- ✅ **"Explicitly consumed" = `STRICT_FACES` AND recorded consuming commit/PR
  AND green `module-face-lint`/VRT** — the canonical 3-leg gate that permits
  deleting the 42 face packages (Stage 4). `clipplayer` (card-stays) and
  `joystick` (platform-blocked) take non-standard dispositions and are not marked
  consumed by the standard gate.
- ✅ **BLOOD finding: ARCHIVE only** to `evidence/archive/2026/`; **not** promoted
  to a permanent `renderer-tests` prohibition (Stage 3 renderer row).
- ✅ **This plan lives in `docs/`** — landed at `docs/migrations/myrobots-retirement-plan.md`.

**Still open (owner-side, not blocking this doc)**
- **MOOG package + the 4 lost `plans/*` records** — recover from owner's machine /
  unfetched branch, or accept loss (the 4 `plans/*` were never committed, so
  acceptance = permanent loss; MOOG provenance is otherwise reconstructed into an
  ADR in Stage 5).
- **Exact `evidence/` authority wording** to add to AGENTS.md in Stage 6.
