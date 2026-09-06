# Repository instructions

patchtogether.live is a browser modular-synthesis and video environment built
with SvelteKit/Svelte 5, WebAudio/WebGL, Yjs, and Faust/WASM.

## Authority

When sources disagree, use this order:

1. Code and generated artifacts in the current tree.
2. This file.
3. The relevant repository skill.
4. Durable decisions in `docs/` and procedures in `runbooks/`.
5. `.myrobots/` as evidence, not instruction.

Say when prose disagrees with the tree. Do not force code to match stale prose.
`.myrobots/` also contains the active face-program work queue: do not delete,
move, or rename a spec/mock package until its module has shipped and the package
has been explicitly consumed.

## Product state

- The `ModuleShell` face is the ONLY module UI. There is no legacy card, no
  `?shell=legacy`, and no fallback renderer: a lane node resolves to the
  faceplate, the dock stub, or — for the one organizational-native type — to
  nothing at all. A module ships a `face`; `module-face-lint` is the gate.
- `STRICT_FACES` is the promoted set. Derive any module count from it or from the
  registry — never hand-type one and never keep a parallel list.
- Module registries are glob-derived. Never maintain a parallel population list
  or hand-type a module count; derive it from the registry or generated artifact.
- Pushes to `main` deploy dev/autotest. Production is shipped nightly from the
  latest green `main`; verify the live workflow files before any deploy action.

## Workflow

Run every command through Flox: `flox activate -- <cmd>`. In particular, never
run git outside Flox; git-LFS can hang.

```sh
flox activate -- task setup
flox activate -- task build
flox activate -- task typecheck
flox activate -- task test
flox activate -- task e2e
flox activate -- task vrt
flox activate -- task art
```

Use focused loops first:

```sh
flox activate -- task test:one -- <filter>
flox activate -- task e2e:serve
flox activate -- task e2e:one -- tests/<spec>.spec.ts
flox activate -- task e2e:stop
flox activate -- task vrt:one -- <module>
flox activate -- task art:one -- <scenario>
```

For new or materially changed tests, run the focused test locally and then
flake-check it with `REPEAT=3`. Run `task typecheck` for Svelte/TypeScript
changes; Vitest is less strict.

Golden updates are explicit accept loops. Review every generated diff:

```sh
flox activate -- task docs:accept
flox activate -- task art:update
flox activate -- task vrt:commit
```

For `art:update`, attribute every fingerprint entry before re-pinning: a
peak/RMS-only move is a level change, a spectrum/feature move is timbral. An
entry you cannot attribute to an intended change is an audio regression — stop
and report it instead of re-pinning, because re-pinning is what turns it green.

Before creating a worktree, run `task worktree:guard`; preserve dirty work and
remember that git stash is shared by all worktrees. After a merge to `main`,
run `task pr:conflict-sweep`.

## Issues and pull requests

- Agents do not create or reopen GitHub issues without explicit owner approval.
- PRs do not require a matching issue. If an approved/existing issue is resolved,
  use `Fixes #N`; otherwise make the PR body the searchable record.
- Fix a discovered defect in the current PR when it is coherent with the work.
  If it is not, report it to the owner instead of silently filing an issue.
- Automated alert issues keep their workflow-owned lifecycle.

## Non-negotiable boundaries

1. **DOOM requires explicit owner approval.** Do not touch DOOM code, specs,
   waits, budgets, ledger entries, or sweep behavior. Exclude it by name from a
   broad sweep and state why.
2. Outside DOOM, express renderer-dependent readiness as frames or observable
   state, never an arbitrary millisecond delay.
3. Linux CI authors the single VRT baseline set. Never commit a locally captured
   baseline; use a scoped `task vrt:commit` and review the bot's exact diff.
4. Ask what every gate is structurally unable to see. Negative-control the
   instrument as well as the code.
5. Merge only when this PR's exact final commit is green. A red `main` is P0.
6. Never use `gh pr update-branch` on PRs that touch shared list/generated
   files; merge `origin/main` locally and verify both sides survived.
7. **Main-thread trigger detection goes through the shared `createEdgeCounter`
   seam.** Never hand-roll a whole-buffer rising-edge rescan of an
   `AnalyserNode` buffer — the ring overlaps the scheduler tick and counts the
   same edge twice. Worklet consumers are exempt; per-sample compare is correct
   by construction. Gate consumers stay level-sensitive — do not convert one to
   edge-only.
8. **A poly or MIDI module ships an e2e wiring the real default-mode source
   through the module to an audible-output assertion.** Driving the engine class
   directly, or asserting only that an edge materializes, has shipped modules
   that were green and silent.

## Skills

- `module-surfaces`: module faces, bespoke surfaces, legacy parity, and cleanup.
- `renderer-tests`: Playwright/WebGL waits, VRT, renderer flakes, and baselines.
- `deploy`: releases, environments, workflows, incidents, and secrets.

Claude Code reads the canonical packages from `.claude/skills/`; Codex sees the
shared packages through `.agents/skills/`.
