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
- Never sample a page-side quantity with a Playwright-side poll loop. Each sample
  is a round trip that runs on the same main thread as the subject, so a loaded
  runner starves both — and a frozen subject and a test that never looked print
  the same result. Move the accumulator into the page, make a zero-sample run
  throw, and report the sample count and elapsed time in the assertion message.
  `scripts/e2e-observation-window.test.ts` enforces this at the source.
- Diagnose slow versus different under SwiftShader before changing a budget, and
  scale a budget by the thing that actually drives its cost — input count,
  capture count, frames — never by raising a flat number. A flat bump buys one
  green run and hides the next regression behind the same wait.
- A passing negative control proves the probe can move, not that it measures the
  right thing. Where the outcome matters, prefer a positive control: reintroduce
  the defect and confirm the test fails.
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
