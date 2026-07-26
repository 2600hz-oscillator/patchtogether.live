# VRT golden-image CI flow — proposal (2026-06-29)

Goal (owner): adopt a golden-images CI flow — **VRT changes FAIL a job → a
results artifact makes it easy to see what changed (A vs B side-by-side + a
slider/onion-skin diff) → a `vrt:commit` job can be run → that commits the new
baselines.** Research prior art, minimum adverse wall-time, propose.

## TL;DR — ~80% already exists; close 3 small gaps at ~0 per-PR wall-time

This repo already implements most of the canonical golden-image loop. The
proposal is mostly **wiring + two small enhancements**, not new infrastructure.

### What already exists (verified)
- **Playwright native diff viewer** — `toHaveScreenshot` (threshold 0.2,
  maxDiffPixelRatio 0.05) writes `*-expected.png` / `*-actual.png` / `*-diff.png`
  on a mismatch; the **HTML report has the built-in Actual / Expected / Diff +
  draggable SLIDER + onion-skin** viewer. Already produced and uploaded as
  `vrt-playwright-report` (full lane) and `vrt-strict-playwright-report`
  artifacts. *Gap: it's a download (`npx playwright show-report ./extract`), not
  browsable inline.*
- **Per-PR changeset gallery** — `.github/workflows/vrt-changeset-gallery.yml`
  + `scripts/vrt-changeset-gallery.mjs`: on a PR that changes
  `e2e/vrt/__screenshots__/**`, renders OLD/NEW/DIFF triptychs of ONLY the
  changed baselines (sharp + pixelmatch), deploys to **Cloudflare Pages**, and
  **upserts a PR comment with the link**. (Task #141.) *Gaps: (a) static
  side-by-side, no slider/onion-skin; (b) git-diff-driven — only fires when the
  PR ALREADY contains changed PNGs, not when a code change SHIFTS a render with
  no baseline update.*
- **`vrt-update.yml`** (the "vrt:commit" job) — `workflow_dispatch -f ref=<branch>
  [-f platform] [-f grep]`: regenerates baselines on linux + darwin runners,
  commits to the PR branch via `.github/scripts/vrt-commit-baselines.sh`, then
  close/reopens the PR to re-fire required checks. *Gap: not discoverable from
  the PR; regenerates all/grep, not "accept exactly this run's diffs".*
- **Full catalog gallery** on GitHub Pages (`pages.yml` + `build_gallery.py`).
- **Gating split**: `vrt-strict` (deterministic pure-DOM subset) is REQUIRED;
  the full `vrt` lane is `continue-on-error: true` (informational, because the
  canvas/animated specs flake). 293 baselines (202 darwin / 91 linux), LFS,
  cached (~95% bandwidth saved).

### The 3 gaps vs the owner's golden-image flow
1. **"VRTs change → FAIL a job"** — only the narrow `vrt-strict` subset fails;
   a composite/animated diff lands in the informational lane and is easy to
   miss (continue-on-error swallows the red).
2. **Slider diff inline** — Playwright's slider is a download; the inline CF
   Pages gallery is static side-by-side.
3. **The accept loop isn't a discoverable cycle** — pieces exist but a code
   change that shifts a render (no pre-committed PNGs) fails CI with the diff
   only in the downloadable report; the gallery doesn't fire, and there's no
   one-click "accept baselines" from the PR.

## Prior art (the canonical loop these all implement)
Argos-CI, Chromatic, Percy, reg-suit, jest-image-snapshot `--ci`: **fail on
diff → hosted review UI (side-by-side + slider/onion-skin) → human approves →
baseline updates**. Playwright's own report is the slider/onion-skin reference.
The repo already mirrors this (CF Pages gallery + vrt-update accept job); the
proposal aligns the remaining edges with the Argos/Chromatic UX.

## Proposal — 3 pieces, all ~0 per-PR wall-time

### Piece A — Diff gallery from the FAILING run (the missing half)
Add an `--from-results` mode to `vrt-changeset-gallery.mjs` that builds the
OLD/NEW/DIFF cards from Playwright's `e2e/vrt/{test-results,report}` output
(`*-expected.png` = OLD, `*-actual.png` = NEW, `*-diff.png` = DIFF) instead of
`git diff`. Wire it into the `vrt` + `vrt-strict` jobs to run **only on failure**
(`if: failure()`), publishing to the SAME CF Pages project + upserting the SAME
PR comment. Now a render-shifting code change (no pre-committed PNGs) gets the
same inline A/B review as a baseline edit. Reuses all existing infra.
- Cost: builds only on a diff (same as today's gallery trigger). <2 min, off the
  green path. **Zero added wall-time on passing PRs.**

### Piece B — Slider + onion-skin in the gallery
The gallery HTML already loads OLD + NEW per card. Add a "Slider" view: a
draggable clip-divider over the two images (standard before/after slider) + an
onion-skin opacity slider. ~40 lines vanilla CSS/JS, no deps.
- Cost: static HTML enhancement. **Zero CI cost.**

### Piece C — Make the failure loud + the accept loop one-click
- Keep `vrt-strict` REQUIRED (unchanged — the deterministic gate).
- The PR comment (Piece A) leads with: `⚠️ N VRT baselines changed — review the
  gallery, then accept:` + the gallery link + the accept command.
- Turn `vrt-update.yml` into the discoverable "vrt:commit button": add a small
  `issue_comment`-triggered workflow so a maintainer commenting **`/vrt-accept`**
  on the PR dispatches `vrt-update.yml` for that PR's branch (regen both
  platforms → commit → close/reopen to re-fire checks). Opt-in compute only.
- Optional later: flip the full `vrt` lane from informational to a real gate
  ONLY after the composite/animated flake is driven to 0 (separate effort; not
  in this proposal — would reintroduce flake-gating today). **Owner approval
  required for any required-check/ruleset change.**

## Wall-time accounting
- Passing PR: **+0** (no new required job; galleries build only on diff).
- Diffing PR: one <2-min CF Pages gallery build on failure (already the pattern).
- `/vrt-accept`: opt-in dispatch, only when a human asks.
No change to the required-check set without explicit owner sign-off.

## Suggested build order (each its own small PR)
1. Piece A (`--from-results` + failure-trigger wiring) — the core "fail → see it".
2. Piece B (slider/onion-skin) — the requested diff UX.
3. Piece C (`/vrt-accept` + loud comment) — the one-click accept.

## Open questions for owner
- OK to keep the full `vrt` lane informational (flake reality) and rely on the
  loud PR comment + gallery, rather than making it a required failing gate now?
- `/vrt-accept` comment-trigger gated to maintainers (write access) — acceptable?
