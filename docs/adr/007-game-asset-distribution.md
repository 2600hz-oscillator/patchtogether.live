# ADR-007: Game-asset distribution — what ships in-repo, what the user supplies

- Status: **Accepted for the tree as it stands, with ONE OPEN OWNER DECISION** —
  the committed Blood shareware data has **no affirmative redistribution grant**
  (see "The open owner decision" below). This ADR records what the repository
  actually does and why; it does **not** assert that the Blood data is freely
  redistributable.
- Date: 2026-08-13
- Deciders: project owner (the decision to bundle the Blood shareware);
  this ADR documents it
- Tags: licensing, game-modules, assets, ci
- Supersedes: `packages/web/native/nblood/PHASE0-STATUS.md` §3 ("assets are
  user-supplied"), which describes a policy the tree stopped following.

## Context

Two game modules ship third-party game data, and until this ADR the repository
described them in **four mutually contradicting places**:

| Source | Claimed | Actually true |
| --- | --- | --- |
| `Taskfile.yml` `setup:blood` | Blood data is "PROPRIETARY + user-provided (NOT freely redistributable, unlike the DOOM shareware WAD)"; "these files are .gitignored" | The shareware subset **is committed**, and `setup:blood` copies **over** it |
| `.gitignore` | un-ignores the shareware set, "the owner explicitly authorised shipping the shareware" | true |
| `packages/web/native/nblood/PHASE0-STATUS.md` §3 | "we treat **all** Blood data … as not redistributable by us. The project never ships or auto-fetches it" | the policy was reversed; §3 was never updated |
| 4 e2e coverage exemptions | Blood data is "user-supplied, non-redistributable … gitignored, absent in CI" | every clause false — see "Consequence 3" |

The inversion nobody had written down: **the game whose shareware carries an
explicit free-redistribution grant (DOOM) is the one we do NOT commit, and the
game whose shareware carries no such grant (Blood) is the one we DO commit.**
Both choices are defensible on their own terms, but only if stated — the
contradiction had already propagated into skipped test coverage (#1548).

### What is actually committed

`git ls-files packages/web/static/blood/ packages/web/static/doom/` is the
authority. Sizes are the Git-LFS pointer `size` fields at `origin/main`.

Blood, data (all Git-LFS except `BLOOD.INI`):

| File | Size | Shareware evidence |
| --- | --- | --- |
| `BLOOD.RFF` | 3 253 424 B | the shareware main resource; the full game's is ~10 MB+ |
| `SOUNDS.RFF` | 14 965 703 B | sound resources |
| `GUI.RFF` | 5 608 B | UI resources |
| `SHARE000.ART` | 16 031 592 B | **`SHARE000`, not the full game's `TILES000.ART`** — the filename itself is the shareware marker |
| `SURFACE.DAT` | 4 096 B | engine surface/material table |
| `TABLES.DAT` | 8 448 B | engine lookup tables |
| `VOXEL.DAT` | 8 192 B | engine voxel table |
| `BLOOD.INI` | plain text, ordinary git | episode descriptor — **authored here**, see below |

Three further in-tree facts corroborate "this is the shareware set, not the full
game", each independently checkable:

1. `SHARE000.ART` is the shareware tile-art filename; the retail game ships
   `TILES000.ART`. `bpt_init` aliases the former (see `blood-mount.spec.ts`).
2. The bundled `BLOOD.RFF` holds exactly the 8 episode-1 maps `E1M1`–`E1M8`
   (verified from the RFF directory when `BLOOD.INI` was authored).
3. The bundled `BLOOD.RFF` holds QAV ids `0..112` + `512..515` only; the
   full-game weapon QAVs `113..124` and the choke overlay `518` are **absent**,
   which is why `build-blood-wasm.sh` carries shareware-tolerant patches to
   `weapon.cpp` / `choke.cpp` (`PHASE1-STATUS.md` §0.2).

`BLOOD.INI` is **not** a redistributed original: it is a small plain-text
episode table authored in this repo (its own header says so). It restates the
stock shareware episode-1 titles and adds `Song=` lines pointing at MIDIs
already inside `SOUNDS.RFF`, because the stock file's CD-audio `Track=` refs
play nothing without a CD.

Blood, non-data (carry no game IP): `blood.js`, `blood.wasm` (built from NBlood
at a pinned commit by `build-blood-wasm.sh`), `blood-pcm-worklet.js`, `README.md`.

DOOM: `DOWNLOAD_INSTRUCTIONS.md` + `doom-pcm-worklet.js`. **No `DOOM1.WAD`, no
`doom.js`/`doom.wasm`** — the WAD is fetched by CI from a mirror and built
locally by contributors.

### The licence position, stated without softening

- **DOOM shareware (`DOOM1.WAD`)** — id Software's shareware licence
  **explicitly permits free redistribution**. We could commit it and choose not
  to, for a size/history reason only (~4.2 MB of binary in git history).
- **Blood shareware ("The Way of All Flesh")** — **no affirmative
  redistribution grant exists.** The IP is Warner Bros.' (via Monolith); no
  source or data was ever officially released; the 1997 shareware circulates in
  a legally-grey abandonware status and period shareware licences commonly
  *restricted* third-party redistribution. This research is
  `PHASE0-STATUS.md` §1/§3 and **nothing in this ADR rebuts it**.

What changed between `PHASE0-STATUS.md` §3 and the tree was **not** the legal
analysis. It was an owner risk decision: ship the shareware anyway so the BLOOD
card boots out-of-box. That is a legitimate call for an owner to make. It is
**not** the same statement as "the shareware is redistributable", and the tree
had been quietly conflating the two.

## Decision

1. **One canonical answer lives here.** Every other place that used to explain
   game-asset provenance points at this ADR and stops arguing.

2. **DOOM ships no game data in-repo.** `DOOM1.WAD` is fetched (CI: from the
   Slitaz mirror pinned in `ci.yml`; contributors: per
   `static/doom/DOWNLOAD_INSTRUCTIONS.md`). Reason: **size, not licence** — it
   is redistributable, we just do not want 4.2 MB of binary in history.

3. **Blood ships the 1997 shareware subset in-repo**, exactly the files in the
   allowlist below, via Git LFS, un-ignored file-by-file in `.gitignore`. The
   BLOOD card therefore boots out-of-box with episode 1. **Reason: an owner
   decision to accept the risk**, recorded as such — not a redistribution grant.

4. **Full-game Blood data is never shipped and never auto-fetched.** It is the
   user-supplied override only: `task setup:blood BLOOD_ASSETS=…` locally, or
   the in-card "Load full Blood data…" picker (cached in IndexedDB by
   `blood-data-store.ts`). `packages/web/static/blood/*` stays ignored by
   default so a user's `TILES000.ART` etc. cannot be committed by accident.

5. **A new game asset cannot enter the tree silently.**
   `scripts/game-asset-distribution.test.ts` reads `git ls-files` and asserts
   set-equality, in both directions, against the allowlist in this file, plus a
   deny-by-default extension sweep over all of `packages/web/static/`. Adding a
   `.wad`/`.rff`/`.grp`/`.pk3`/… without amending this ADR is RED.

6. **No test or comment may justify itself with "the Blood data is
   user-supplied / gitignored / absent in CI."** All three clauses are false;
   the real reasons are in "Consequence 3".

### Allowlist — the governed scope

The two blocks below are **machine-read** by
`scripts/game-asset-distribution.test.ts`. Editing the tree without editing them
(or the reverse) fails that test. Keep the fences.

<!-- game-asset-scope:begin -->
```
packages/web/static/blood/
packages/web/static/doom/
```
<!-- game-asset-scope:end -->

Every committed file under those prefixes, with its class and why it is there.
Classes: `shareware-data` (third-party game data we ship), `authored-data`
(data authored in this repo), `engine` (built from source, no game IP),
`runtime` (our own code), `doc`.

<!-- game-asset-allowlist:begin -->
| path | class | why |
| --- | --- | --- |
| `packages/web/static/blood/BLOOD.RFF` | shareware-data | 1997 Blood shareware main resource (episode 1); REQUIRED — the engine's resource loader aborts without it |
| `packages/web/static/blood/GUI.RFF` | shareware-data | 1997 Blood shareware UI resources; REQUIRED by the resource loader |
| `packages/web/static/blood/SOUNDS.RFF` | shareware-data | 1997 Blood shareware sound resources + the embedded MIDIs the OPL3 synth renders; REQUIRED |
| `packages/web/static/blood/SHARE000.ART` | shareware-data | shareware tile art (the full game ships TILES000.ART instead); without it the main menu renders ~black |
| `packages/web/static/blood/SURFACE.DAT` | shareware-data | Build engine surface/material table read at boot |
| `packages/web/static/blood/TABLES.DAT` | shareware-data | Build engine lookup tables read at boot |
| `packages/web/static/blood/VOXEL.DAT` | shareware-data | Build engine voxel table read at boot |
| `packages/web/static/blood/BLOOD.INI` | authored-data | episode/level descriptor authored HERE (stock shareware episode-1 values + Song= refs into SOUNDS.RFF); the engine aborts at levels.cpp:71 without it, and it is not inside BLOOD.RFF |
| `packages/web/static/blood/blood.js` | engine | emcc ES-module glue for blood.wasm, built by build-blood-wasm.sh from NBlood at a pinned commit; carries no game IP |
| `packages/web/static/blood/blood.wasm` | engine | the NBlood WASM build (GPL-2.0 game code + BUILDLIC Build engine, aggregated at runtime — PHASE0-STATUS.md §1); carries no game IP |
| `packages/web/static/blood/blood-pcm-worklet.js` | runtime | our AudioWorklet that de-interleaves the engine PCM ring into audio_l/audio_r; a 404 here silently kills BLOOD audio |
| `packages/web/static/blood/README.md` | doc | what is bundled, where it came from, and the legal status; points here |
| `packages/web/static/doom/doom-pcm-worklet.js` | runtime | our AudioWorklet for the DOOM PCM ring; same role as the Blood one |
| `packages/web/static/doom/DOWNLOAD_INSTRUCTIONS.md` | doc | how to obtain DOOM1.WAD + its SHA-1; the WAD itself is deliberately NOT committed |
<!-- game-asset-allowlist:end -->

## Consequences

### 1. The out-of-box claim is real, and CI depends on it

`ci.yml`'s `build-web` job runs `git lfs pull --include="packages/web/static/blood/**"`
with 5 retries and **fails the build** if it cannot materialise them, because
`vite build` bakes `static/` into the preview bundle that every e2e shard
downloads. A `checkout` with `lfs: false` and no materialise step would embed
LFS *pointer text* and `blood.js` would throw `Unexpected identifier 'https'`.

Consequently the data **is present on CI**, and four dedicated specs exercise it
there: `blood-mount.spec.ts` (boots out-of-box; asserts the "data missing"
prompt does **not** appear), `blood-ingame.spec.ts`, `blood-keyboard.spec.ts`,
`blood-audio-output.spec.ts` (real chain → SCOPE peak > 0.01).

### 2. The bytes are public, which the old rationale did not account for

`static/blood/README.md` justified bundling with "everything here is beta-gated
/ pre-public / non-commercial". The **deploys** are beta-gated. The
**repository is public** (`gh repo view … --json visibility` → `PUBLIC`), so
anyone can `git clone` the shareware data or fetch the LFS objects directly. The
risk-acceptance is therefore broader than the sentence that recorded it, and
this ADR says so rather than repeating it.

### 3. The coverage exemptions must state their REAL reason

The generic sweeps exempt BLOOD for reasons that have nothing to do with data
availability:

- **Boot cost.** The dedicated specs allow **20–25 s** for `blood-ready` (a
  5.9 MB ASYNCIFY WASM through the whole Build engine init). The generic
  sweeps' windows are ~800 ms (per-module alive smoke) and ~2 s (per-port emit).
  A 25 s boot does not fit a 2 s window; that is the whole reason.
- **Menu ≠ gameplay.** After boot the engine sits in the main menu.
  `audio_l`/`audio_r` carry the mixer, but the level music and SFX that make it
  audible require driving the menu into a level (8 scancodes) and firing —
  which `blood-audio-output.spec.ts` does and the generic sweep cannot.
- **Renderer sensitivity.** The Build boot path is heap/renderer-sensitive, so
  even the dedicated specs `test.skip` when `blood-ready` never appears on
  CI's SwiftShader. Those are **skips, not passes** — the audio proof is
  capability-gated by design, which is a reason to keep the dedicated spec
  honest, not a reason to claim the sweep is covered.
- **VRT** additionally: the menu **animates by design** (the engine clock fix
  in `PHASE1-STATUS.md` §3), so a live game-loop framebuffer defeats
  deterministic capture regardless of data.

### 4. `setup:blood` overwrites the bundled shareware, on purpose

Running `task setup:blood` copies a user's full-game files into
`packages/web/static/blood/`, replacing the bundled shareware **on disk**. A
copied file whose name is *not* in the allowlist (e.g. `TILES000.ART`) is
ignored and invisible to git — but one that *shares* a bundled name is a
**tracked file, now modified**, and `.gitignore` has no say over tracked files.
`git checkout -- packages/web/static/blood/` restores the shareware; the task
now prints exactly which files it dirtied (asking git, not restating a list).

This is also why the conformance test reads `git ls-files` and not the
filesystem: a filesystem listing cannot tell a committed shareware file from a
developer's full-game copy sitting at the same path, so it would read green
while looking at entirely different bytes.

### 5. The open owner decision

**This ADR does not resolve, and cannot resolve, whether we should keep shipping
the Blood shareware data.** What it does is stop the tree from asserting a
permission that was never obtained. Two items remain for the owner:

1. **Blood shareware redistribution.** No affirmative grant exists (§ "The
   licence position"). Options: (a) keep it and accept the risk explicitly, now
   that the public-repo scope in Consequence 2 is on the record; (b) stop
   committing it and return to the picker/`setup:blood` path — the card already
   supports both, so this is a data decision, not a code one. **Nothing was
   deleted by the PR that introduced this ADR**; changing what is committed is
   an owner call, and a history scrub would be a separate, explicit decision.
2. **BUILDLIC non-commercial condition** (`PHASE0-STATUS.md` §1, still open):
   confirm patchtogether.live will not charge for the Blood module, and ship
   `packages/web/native/nblood/NOTICE.md` (GPLv2 game code + BUILDLIC engine +
   the EDuke32 linking exception + attribution), which `PHASE1-STATUS.md` §5.6
   lists as still not done.

## References

- `packages/web/static/blood/README.md` — bundle contents, source, legal status
- `packages/web/native/nblood/PHASE0-STATUS.md` §1 (engine licence, BUILDLIC),
  §3 (the superseded "user-supplied only" policy)
- `packages/web/native/nblood/PHASE1-STATUS.md` §0, §2, §3 (shareware-tolerance
  patches, the real-frame kill-gate, the boot faults)
- `packages/web/static/doom/DOWNLOAD_INSTRUCTIONS.md` — the DOOM WAD path
- `.github/workflows/ci.yml` — `build-web` LFS materialise step (do not edit
  from an unrelated PR)
- `scripts/game-asset-distribution.test.ts` — the conformance gate for the
  allowlist above
- Issue #1497 (this ADR), #1548 (the coverage exemptions that cited the stale
  story as fact)
