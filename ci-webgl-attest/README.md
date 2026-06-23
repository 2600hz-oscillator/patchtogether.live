# `ci-webgl-attest/` — WebGL local-GPU test attestations ("semaphore")

This folder holds **owner self-attestations** that the full WebGL/video test set
was run **on a real GPU locally** for a given WebGL-content state. Each file is
named by the deterministic **WebGL content-hash** and is committed alongside the
PR that changed the WebGL surface.

## Why this exists

CI's only WebGL renderer is **SwiftShader** (software ANGLE). The WebGL-heavy
e2e lane (`e2e-video`) is disabled on PRs because it ran 24–27 min at
`--workers=1` and intermittently timed out on the software renderer. So the
heavy WebGL e2e suite does **not** run on PRs — a coverage hole.

This scheme fills that hole **without a GPU runner**: the owner runs the full
WebGL set on this Mac's real GPU via `flox activate -- task webgl:attest`. On a
fully-green run it writes `ci-webgl-attest/<hash>.json`. CI's `webgl-attest` job
recomputes the same content-hash and checks the file exists:

- **match** → the WebGL surface is unchanged-or-attested → CI skips the heavy
  WebGL lane, trusting the local real-GPU run.
- **no match** → a WebGL/video path changed without re-attesting → CI **fails**
  with `run: flox activate -- task webgl:attest`.

## What is HONEST about this (read before trusting it)

The **one robust property** is: *editing a hashed WebGL file forces a re-attest
or CI fails* — i.e. it removes the "I edited a shader and forgot to re-test"
**accidental-staleness** failure mode for in-basis files.

It is **NOT anti-forgery and NOT a security control.** Every field in the JSON
is hand-writable; `bash scripts/webgl-attest-hash.sh` + a hand-written
`<hash>.json` passes CI with zero tests run. The renderer/Playwright "sanity
hints" in the verify script catch the *lazy/accidental* SwiftShader-or-stale
case only; they raise the bar ~zero against a deliberate forger.

This is acceptable **because the repo is contribution-locked to the owner**
(owner-only merge; fork-PR Actions require owner approval). So no untrusted code
runs CI and no one but the owner lands code → this is an **owner self-attestation
= single-trusted-actor model**. "The owner can fabricate their own attestation on
their own locked repo" is an accepted property, not a hole.

## The content-hash basis

Computed by `scripts/webgl-attest-hash.sh` (→ `scripts/webgl-attest-lib.ts`)
over the **WebGL-relevant source/spec/toolchain paths only** — NOT `git HEAD`,
so it survives squash-merge / rebase / amend (same content → same hash) and is
unaffected by docs/audio-only commits. The basis (`WEBGL_PATHS`):

- `packages/web/src/lib/video/**` **except `**/*.test.ts`** (engine, GL libs,
  the render worker, every video module def).
- Every **card** whose source creates a real WebGL context (CUBE / HYPERCUBE /
  WAVESCULPT) — derived mechanically, not hand-listed.
- Those cards' **audio-domain module defs** (flagged `rendersWebGL: true`).
- The heavy WebGL **specs** (resolved from the exported `e2e/webgl-heavy-globs.ts`)
  + the Pass-B leaker specs + the Pass-C camera spec + the shared e2e helpers.
- **Toolchain pins** (`e2e/package.json`, `packages/web/package.json`,
  `.flox/env/manifest.toml`) — a Playwright/bundler bump can change shader emission.

The **fail-closed coverage guard** (`packages/web/src/lib/video/webgl-attest-coverage.test.ts`,
a REQUIRED unit test) FAILS the build if any source file that creates a WebGL
context is not covered by `WEBGL_PATHS` — so the basis can't silently miss a
WebGL file.

## How to (re-)attest

```sh
flox activate -- task webgl:attest:check    # do I even need to re-attest?
flox activate -- task webgl:attest          # full real-GPU run; writes <hash>.json
git add ci-webgl-attest/<hash>.json && git commit   # commit it WITH your PR
```

The runner refuses to run on SwiftShader, runs three passes (heavy / leakers /
camera) with `retries=0`, and **refuses to write** unless every pass is green
AND the measured spec-file counts match the derived expected sets.

## Do NOT hand-edit these files

They are machine-written. Hand-editing defeats even the accidental-staleness
property. The only file that MUST exist for main CI to stay green is the one
matching main's current `WEBGL_PATHS` hash.

**Pruning (2026-06-23):** `task webgl:attest` now prunes superseded `<hash>.json`
files when it writes the new one, so the working tree holds **only the live
hash** (git retains the full history). This kills the old unbounded growth + the
manual "git rm the old one" step. The prune runs **only in the LOCAL writer**
(committed atomically with the new hash, in the same PR) — there is still **no
auto-prune on the CI push critical path** (that could race a merge and delete the
file main needs). Across two concurrently-merging WebGL PRs the dir can
transiently hold 2 hashes; the next attest re-prunes to 1.

## Migration / retirement

This whole scheme is **retired the day a real-GPU CI runner lands**: re-enable
`e2e-video` on that runner, add it to the `ci` umbrella, then delete the
`webgl-attest` job, `scripts/webgl-attest*`, the `webgl:attest*` Taskfile
targets, and this folder (one cleanup PR). The umbrella name never changed, so
retirement needs no ruleset edit. See
`.myrobots/plans/webgl-attestation-semaphore.md` §11.
