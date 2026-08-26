---
name: renderer-tests
description: Work on Playwright E2E, WebGL/video rendering, VRT scenes, renderer-dependent waits, flakes, and snapshot baselines. Use before changing waits, render resolution, VRT scope, or baseline workflows.
---

# Renderer tests

## Stop at DOOM

DOOM is outside ordinary cleanup. Do not change its code, specs, waits, budgets,
ledger rows, or sweep behavior without explicit owner approval. When a broad
sweep could include it, exclude DOOM by name and record the reason.

## Test the renderer, not elapsed time

- Use repository Taskfile entry points, not ad-hoc Playwright commands.
- Outside DOOM, wait for observable state or drive/count rendered frames. A
  wall-clock timeout may bound failure but must not define readiness.
- Use the shared frame helper or engine stepping seam; do not hand-roll another
  polling loop.
- Diagnose slow versus different under SwiftShader before changing a budget.
- Run every new or materially changed focused test locally with `REPEAT=3`.
- Before changing waits, resolution, or capture behavior, read
  [silent failures](references/silent-failures.md).

## VRT

- Linux CI authors the single baseline set. Local VRT is diagnostic only.
- Dispatch the narrowest explicit scope with `task vrt:commit`; use `ALL=1`
  only for a deliberate full sweep.
- The capture path intentionally uses `--update-snapshots=all` with zero
  tolerance. Do not restore `=changed`, widen tolerance/scope, or rely on the
  CLI default.
- Predict which files should move, compare that with the bot commit, and inspect
  the images. An unexplained zero or extra file is a failed instrument check.
- A baseline matching current output proves equality, not correctness. Fix a
  frozen, blank, stale, or nondeterministic render; never recapture it away.
- Check `git status` after any run around missing/deleted snapshots.

## Real-GPU attestation

WebGL-path and renderer-toolchain changes can move the content hash verified by
CI. Read `ci-webgl-attest/README.md` and the current attest scripts, inspect the
hash basis, then use `task webgl:attest` on the trusted real-GPU machine. Never
weaken coverage or bless unreviewed code merely to satisfy the hash.

Do not create an issue unless the owner explicitly approves it. A PR does not
need an issue.
