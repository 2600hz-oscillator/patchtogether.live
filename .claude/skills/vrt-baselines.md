# VRT baselines: there is ONE SET and LINUX CI AUTHORS IT

Everything about how a baseline comes into existence, the three hazards that
survive the platform collapse, and the two ways a capture job still misleads.
The RULE lives in CLAUDE.md; this is the detail.

### VRT baselines: there is ONE SET and LINUX CI AUTHORS IT

`snapshotPathTemplate` has **no `{platform}` segment** (`e2e/vrt/vrt.config.ts`).
A baseline is one PNG at `__screenshots__/<spec>/<scene>.png`, written by the
`vrt-update.yml` capture job on ubuntu-latest. **You never commit a baseline.**

```sh
flox activate -- task vrt:commit          # dispatch the capture for THIS branch
flox activate -- task vrt                 # local smoke test: does it render, does it throw
flox activate -- task vrt:docker          # OPTIONAL pixel-exact local loop (needs Docker)
```

- **A local macOS run is not a verification.** It compares Metal-rendered text
  against a linux baseline, so it reports AA/font drift that is not a
  regression. That is the honest reading and it always was: before 2026-08-10 a
  Mac dev's green came from comparing against a `darwin/` set **CI never read**.
- `task vrt:docker` runs the suite in `mcr.microsoft.com/playwright:<pinned>-noble`
  — the image tag is derived from `e2e/package.json`'s `@playwright/test` pin, so
  a different Playwright means a different Chromium means different pixels.
  Docker is **optional**; nothing in the repo requires it.
- An intentional render change is reviewed as a **PR diff** through the
  changeset gallery ci.yml posts (OLD / NEW / DIFF with a slider), not by
  looking at PNG bytes.

**Why it was ever otherwise, and what it cost.** `{platform}` resolves on the
RUNNING machine, so a Mac dev wrote `darwin/` and CI read `linux/`. Two
populations, therefore divergence, therefore an apparatus to track divergence:
four gap-declaration mechanisms, three ratchets, a 617-line enumerator, a
per-platform capture matrix and a merge-collision surface. Measured on `main`
the day it was removed: **300 darwin PNGs, 156 linux, 146 darwin scenes with NO
linux sibling** — 146 scenes that looked covered everywhere and were never
diffed on the platform that gates. All of it is deleted; the sections that
documented drain order, the four mechanisms, and the dispatch gotchas went with
it. If you find a reference to `EXEMPT_BASELINE_PAIRS`, `darwinOnly`,
`VRT_PLATFORM`, `vrt-platform-gaps.ts` or `task vrt:audit`, it is stale prose.

**Three hazards survive the collapse — they were never about platforms:**

- ⚠ **`--update-snapshots` CANNOT regenerate a PASSING-but-stale baseline.**
  Playwright only rewrites on a FAILING comparison, so a scene genuinely out of
  date still commits **nothing** if its diff lands under tolerance. Found on A2
  (#1213): swapping filter's MODE from a bare detented knob to a labelled
  Segmented moved the dock face by **865 px** — a whole primitive swap — and the
  dispatch committed zero files, twice. **Fix: `git rm` the stale baseline
  first**; Playwright always writes a MISSING snapshot (`updateSnapshots`
  defaults to `'missing'`, and `'changed'` — what `task vrt:update` passes —
  explicitly creates missing ones too). The same arithmetic means the ordinary
  VRT gate would not have flagged that swap either. **Treat a green dispatch
  that committed nothing as a RED FLAG, never as "nothing to do", and COUNT the
  files the bot commits against what you predicted.**
- ⚠ **A `git rm`-ed baseline is SILENTLY RECREATED by the next plain VRT run.**
  `'missing'` *creates* an absent snapshot. The test still fails — *"A snapshot
  doesn't exist …, writing actual"* — so it is loud in the RUN OUTPUT and
  completely silent in the **tree**: what lands is an untracked PNG that no gate
  reads and that a `git add -A` will happily commit. **`git status` for
  untracked PNGs after EVERY VRT run in a window where you have deleted a
  baseline** — including read-only "did it still render?" runs you did not think
  of as captures. Measured on vca (#1429) before the collapse; the mechanism is
  unchanged, only the path is.
- ⚠ **Bare `--update-snapshots` is `=all` in Playwright 1.59** and had already
  rewritten 22 unrelated baselines once. `task vrt:update` passes `=changed`.
  The flag lives in the **Taskfile**, not in `e2e/package.json` — that file is a
  `TOOLCHAIN_PIN_FILE` in the WebGL attest basis.

**Two things the capture job can still get wrong, both worth knowing:**

- **The sweep is ONE job.** A single scene that cannot settle aborts the whole
  capture and nothing is committed. This is live: the 2026-08-09 darwin regen
  died on `face-mixer-compact` and `face-ringback-dock`, both tripping #1420's
  `AudioContext is 'running', not 'suspended', at CAPTURE time` guard. **The
  guard is correct** — a face glyph is an AnalyserNode view, and baselining it
  off a running graph is baselining a moving target — so the fix belongs in
  whatever leaves the context running.
- **A capture that rewrote nothing still SUCCEEDS.** `vrt-commit-baselines.sh`
  emits `pushed=false` and a `::warning::` for exactly that case, and
  `revalidate` reads it so an unchanged branch does not burn a close+reopen
  cycle. (`revalidate` exists because a GITHUB_TOKEN push does not fire CI and a
  `workflow_dispatch` run does not count toward a required-status gate —
  confirmed on #524.)


### ⚠ The close+reopen re-fire is NOT reliable — and it used to report success anyway

#1694. When the baseline bot's commit is the PR's HEAD and the `reopened` event
is not delivered, **no `ci.yml` run is ever created for that SHA**: the PR sits
`BLOCKED` with zero failures, which is #1184's deadlock by a different route.
Measured over every 2026-08-15 dispatch that reached the close+reopen — #1677 ✓,
#1689 ✓, #1692 ✗. The step reported SUCCESS all three times because it never
looked.

It now verifies its own effect (`scripts/vrt-revalidate-gate.mjs`), retries, and
**fails red with a PR comment** if no run appears. So:

- **A red `revalidate` job means the PR is deadlocked, not that the capture
  failed.** The baselines are already pushed. The remedy is one commit: push any
  non-bot commit on top — the `git merge origin/main` the PR owes anyway.
- **The whole class disappears if the push stops being a `GITHUB_TOKEN` push.**
  Set the optional repo secret `VRT_BASELINE_PUSH_TOKEN` (fine-grained PAT or
  App installation token; Contents + Pull requests, read+write) and the push
  fires `pull_request: synchronize` by itself — no re-fire, no race. Absent, the
  workflow behaves as before; the verification is what makes that safe.

⚠ **`?head_sha=` MATCHES THE FULL 40-CHAR SHA ONLY.** An abbreviated SHA does
not error — it returns `total_count: 0`, which reads exactly like "no run
exists". Measured: `?head_sha=022c6cc23` → 0 and
`?head_sha=022c6cc23ad64028f5549359f2f65695541e3a25` → 1, for the same commit.
**Resolve the SHA before you believe the number** (`gh api repos/OWNER/REPO/commits/<short> --jq .sha`,
or `node scripts/vrt-revalidate-gate.mjs probe --repo OWNER/REPO --sha <any>`,
which resolves for you).


### A FOOTER can move every dock baseline — the mechanism is HEIGHT, not pixels

Added 2026-08-09 (#1425). A new footer readout re-pinned **133** baselines
(two platform sets then; one now) and made `vrt-strict` red on a *different card each cycle*
(15 → 2 → 2 → 1). It looked like a card-render bistability. It was arithmetic.

Measured at the VRT viewport (1280 CSS px, AudioContext booted — the state the
scenes actually capture): `.status` 545.063 px + `.cable-legend` 547.625 px +
35 px padding leaves **147.313 px** of free space. The readout wanted 295 px.
`.cable-legend` compressed until its `li` text wrapped, the bottombar went
**32.375 px → 41 px**, and the canvas lost the same 8.6 px. Every dock and
faceplate scene is laid out *inside* that canvas.

- **Chrome that is not in frame can still move a baseline** — through the
  layout, not the pixels. Before adding anything to the topbar or footer,
  measure the row's free space and the bar's height with and without it.
- **Re-pinning is the wrong response.** It re-pins whichever scenes happened to
  land on the wrong side of the tip *this run*, so the failure appears to move.
  Restore the baselines and fix the layout: with bar height back to main's,
  `vrt-strict` went green with **zero** re-pins, and the only baselines that
  legitimately moved were the **7** page-level captures with the footer in
  frame (`workflow-shell-zoom` ×3 per platform, `workflow-dock-composite` ×1 —
  counted across the two baseline sets that existed then).
- **Gate it in a browser.** A unit test cannot see a flex row wrap, and *where*
  it wraps depends on platform font metrics. `audio-health-readout.spec.ts`
  hides the element and asserts the bottombar height does not move, with a
  second leg asserting the row DOES get narrower so the first cannot pass
  against an out-of-flow element.


### ⚠ `task vrt` / `vrt:update` used to ignore `E2E_PORT` — a green sweep of the WRONG BRANCH

Same day, same PR, and the more transferable half. `vrt.config.ts` reads only
`E2E_BASE_URL`, defaults to `http://localhost:5173`, and sets
`reuseExistingServer: true`. The full-sweep tasks never derived that from
`E2E_PORT` (only `e2e:one` and `vrt:one` had been hardened), so a
`E2E_PORT=5251 task vrt` in an isolated worktree returned **"276 passed, 1
failed" in 11.5 minutes having never loaded the branch under test** — it
rendered the primary checkout's `main` server while comparing against this
worktree's baselines. Three scenes that `vrt:one` had just failed at ~3200 px
each came back green.

Fixed in the Taskfile (all three route through `vrt:run`), but the rule
generalises: **an isolation mechanism that only half the entry points honour is
not isolation.** When you add an `E2E_PORT`-style knob, grep every caller — and
prefer failing loudly over silently falling back to a shared default.

Two more from the same session, both cheap:

- **A toolchain PIN file hashed WHOLESALE makes every unrelated edit a
  re-attest.** `e2e/package.json` is in `TOOLCHAIN_PIN_FILES`
  (`scripts/webgl-attest-lib.ts`) because it pins `@playwright/test` — the
  renderer version. The basis used to hash the whole file, so changing one
  unrelated npm-script string moved the WebGL hash `620fa1b3…` → `ad300c3e…`
  and turned `webgl-attest` red, demanding a trusted-machine GPU re-attest for
  a one-word CLI flag. **FIXED 2026-08-09**: package.json pins are now hashed by
  their dependency/config surface only (`NON_CODE_PACKAGE_JSON_FIELDS` in
  `scripts/attest-code-basis.ts`), so scripts and prose are free while a dep
  bump still counts. `.flox/env/manifest.toml` IS still hashed wholesale —
  before editing it, run `bash scripts/webgl-attest-hash.sh` before and after.
  The hash cannot tell a pin bump from a comment there; only you can.
- **Screenshot the thing and look at it.** `display: inline-flex` on a label +
  value pair drops the whitespace-only anonymous flex item, so the footer read
  `lat13.3/40.0ms drop0/0.0ms tick9ms`. Every text assertion still passed —
  `toContainText(/drop \d+\/\d/)` matches `drop0/0.0ms` perfectly well.

