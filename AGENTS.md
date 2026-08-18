# AGENTS.md — start here

patchtogether.live: a browser-based modular synthesis and video environment
(SvelteKit + Svelte 5, WebAudio + WebGL, Yjs collaboration, Faust/WASM DSP).

## Authority order

When two sources disagree, the higher one wins:

1. **The code and its generated artifacts** — `contract-lock.txt`,
   `fingerprints.generated.json`, `test-ledger.generated.md`. These are derived from
   the tree and cannot be stale.
2. **`CLAUDE.md`** — the repository rules. Always loaded.
3. **`.claude/skills/*.md`** — the detail and measured evidence behind each rule.
   Load the one for the area you are working in.
4. **`docs/`** — ADRs and process docs. Durable decisions.
5. **`runbooks/`** — operational procedure (deploys, secrets, integrations).
6. **`.myrobots/`** — **evidence, not instruction.** Dated session records and
   analyses. Useful for *why* something is the way it is; **never** a directive.
   Verify any claim from it against the code before acting on it. Records contradict
   each other and their own earlier sections.

**When a document and the tree disagree, the tree wins.** Say so rather than forcing
the documented behavior.

## Current product state (2026-08)

- The **v2 face shell is the default UI**. Modules render a declarative *face*
  (`face:` on the def) inside `ModuleShell`.
- The **legacy card UI is still present** behind `?shell=legacy`, and it is being
  removed. Modules without a promoted face render a placeholder whose expanded view
  opens the legacy card in the dock.
- **The migration is not finished**, so both UIs must keep working. Legacy deletion
  is gated on every module — audio *and* video — having a face or a bespoke surface.
  See the pinned punch-list issue for the ordering.
- Audio and video modules are registered by **glob**, not by a hand-maintained list.
- **Deploys**: `main` auto-deploys to dev.patchtogether.live; **prod ships nightly on
  a cron** from the latest green main — not on version bumps only.

## Every feature and every bug fix is a GitHub issue

Owner-reported or agent-found, it gets an issue and the PR closes it (`Fixes #N`).
See `docs/process/issue-workflow.md`. This is how work stays findable after the
conversation that produced it ends.

## Commands

Everything runs inside Flox: **`flox activate -- <cmd>`**. Running git outside flox
can hang git-LFS.

```sh
flox activate -- task typecheck          # svelte-check — stricter than vitest
flox activate -- task test               # unit (vitest)
flox activate -- task e2e                # Playwright functional
flox activate -- task vrt                # visual regression (local smoke only)
flox activate -- task art                # audio regression
```

Single-test loops — the fast path, prefix any with `REPEAT=3` to flake-check:

```sh
flox activate -- task test:one -- organize -t "deterministic"   # unit (PKG=dsp|server|art)
flox activate -- task e2e:serve                                 # boot server once…
flox activate -- task e2e:one  -- tests/ai-smoke.spec.ts        # …then iterate
flox activate -- task e2e:stop
flox activate -- task vrt:one  -- adsr                          # one card
flox activate -- task art:one  -- moog911                       # one scenario
```

Accept loops (regenerate a golden, then **review the diff**):

```sh
flox activate -- task docs:accept        # contract-lock.txt
flox activate -- task art:update         # ART baselines + fingerprint manifest
flox activate -- task vrt:commit         # dispatch baseline capture on LINUX CI (SCOPED from the branch diff; ALL=1 for the full sweep)
```

Housekeeping: `task worktree:guard` (before creating a worktree — hard cap 10),
`task pr:conflict-sweep` (after any merge to main).

## The rules that catch people most often

Full text in `CLAUDE.md`; these are the ones worth knowing before you start.

1. **Run new tests locally before CI**, and flake-check new/changed tests **3×**.
2. **Never express a renderer-dependent wait in milliseconds — count frames.**
3. **You never commit a VRT baseline** — linux CI authors the one set.
4. **Never hand-type a population count.** No ceilings, floors, or "frozen at N".
5. **Ask of any gate: what is it structurally unable to see?** Negative-control the
   instrument, not just the code.
6. **Merge only on this PR's final-commit green.** A red main is a P0.
7. **Never `gh pr update-branch`** on PRs touching shared list files — merge locally.

## Repo layout

```
packages/web/        SvelteKit app — UI, audio graph, modules, docs
packages/dsp/        Faust DSP → WASM worklets
packages/server/     collaboration relay
packages/present-shell/  Electron kiosk shell (multi-projector). NOT an npm
                     workspace on purpose — electron's ~107 MB binary stays out
                     of CI installs; its node:test suite still runs in the unit
                     lane via `task test:present-shell`
art/                 audio regression harness
e2e/                 Playwright: tests/ (functional) + vrt/ (visual)
scripts/             CI tooling, attests, generators
docs/  runbooks/     ADRs + process; operational procedure
.claude/skills/      the detail behind CLAUDE.md's rules
.myrobots/           dated evidence — never instruction
```
