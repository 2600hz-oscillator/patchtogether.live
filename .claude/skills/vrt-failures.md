---
name: vrt-failures
description: How to triage VRT (visual regression test) failures. Open the diff PNGs, classify expected vs unexpected, never blanket-recapture, ask the user when unsure.
---

# VRT failure triage

## The rule

VRT failures are NEVER auto-OK. Each failure is either:

- **Expected** — this PR deliberately changed the UI in that region; the
  baseline update is the correct response.
- **Unexpected** — this PR shouldn't have touched that region; this is a
  real regression, fix the code, do NOT update the baseline.

If you cannot decide which category a failure falls into, **stop and ask the
user**. Blanket `vrt:update` would silently land regressions.

## Where the artifacts live

After a failed `task vrt` run, Playwright writes:
- `e2e/test-results/<spec-name>/` — `*-expected.png`, `*-actual.png`,
  `*-diff.png` for each failing case.
- The diff PNG highlights the changed pixels in red.

For CI runs, the same artifacts are uploaded under the workflow's "Artifacts"
section — download the `playwright-report` zip from the failing job.

## Triage workflow

1. **Open the diff PNG.** Identify the affected region.
2. **Map the region to your code change.** Did this PR touch the shader / CSS /
   layout / data that drives the changed pixels?
3. **If yes, expected.** Confirm the change is what you intended (right
   shape, right color, right place). If yes, recapture only that file:
   ```sh
   flox activate -- task vrt:update -- --grep "<spec-name>"
   ```
   Commit the new baseline PNG (LFS-tracked per `.gitattributes`) with a
   note in the commit body about what visual change you intended.
4. **If no, unexpected.** Don't recapture. Investigate why your change had
   side effects you didn't anticipate. Fix the code. Re-run VRT. The diff
   should disappear.

## Common false-positive flavors

- **Font hinting drift** between machines — usually means the test ran on a
  different OS than the baseline was captured on. Solution: per-platform
  baselines (already in place; if you see this, it's because a baseline
  needs darwin/linux recapture).
- **Anti-alias edge differences** — small, scattered red pixels along curve
  edges. Often legitimate (a 1-pixel-shift element actually moved); rarely
  noise.
- **Animation timing** — if a test captures during an animated state, the
  diff varies per run. Solution: pause the animation in the test setup, or
  add the module to `EXEMPT_BASELINE_PAIRS` if its render can't be made
  deterministic (e.g., wavesculpt's animated 3D camera + CRT feedback).

## Stuff to never do

- Don't run `task vrt:update` without `--grep` unless every module's UI
  changed (almost never true).
- Don't commit baseline PNGs without looking at them.
- Don't add a module to the exempt list to silence a failure without
  understanding why it's non-deterministic.
- Don't run `task vrt:update` to "make CI green" if you can't articulate the
  change in 1 sentence.

## The user has explicitly asked for this discipline

The user has been burned by blanket recaptures hiding regressions. They have
asked, in plain text: "any time VRTs fail you need to examine them to see
expected vs unexpected change and if you are not sure you need to ask me."
This skill exists because of that ask. Honor it.
