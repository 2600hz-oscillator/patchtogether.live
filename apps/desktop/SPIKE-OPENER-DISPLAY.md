# SPIKE — opener→popup DOM access + cross-display blit (the P4 gate)

**Status: awaiting one run on the owner's dual-monitor rig.** This is the
"spike result recorded" that `.myrobots/2026-09-04-native-shell-plan/plan.md`
§1.2 ("main ↔ output windows" — the HIGHEST-RISK display assumption) and the
P2/P4 phase table require before any P4 window-manager code.

## The question

P4's whole output design is: the MAIN window's renderer `window.open`s a
same-origin `/present` popup onto a SECOND physical display (through
`security.ts`'s `setWindowOpenHandler`), keeps opener→popup DOM access, and
the popup's own rAF pulls an opener-realm blit closure into the popup's canvas
(#2235 — the sink owns the clock). The fallback design (`captureStream`)
rendered **BLACK on real dual-monitor hardware**, and the 2026-09-03 hour-one
probe (p2-notes.md) validated opener DOM access on **one** display only — so
the cross-display half of the assumption has never been tested. This harness
tests it, end to end, on the shell's real wiring: `server.ts` (loopback +
COOP/COEP), `security.ts` (the shipped window-open/permission policy),
`HARDENED_WEB_PREFERENCES` + the built preload, and the real `/present` sink
page from the web bundle. No product code is modified.

## Run it (owner, dual-monitor rig)

```sh
# once per checkout:
flox activate -- task desktop:install
flox activate -- task desktop:build:web

# the spike (two physical displays connected, mirroring OFF):
flox activate -- task desktop:spike
```

Two windows appear for ~15 s: the rack on the primary display, a magenta
`/present` popup with a small flickering counter square on display 2. The
verdict prints to stdout and a JSON record lands in
`apps/desktop/spike-results/` (gitignored — paste the verdict below).

Optional extras:

```sh
flox activate -- task desktop:spike -- --crash-probe   # + row-1 observation (see below)
flox activate -- task desktop:spike -- --dry-run       # wiring check on ANY machine — NOT the spike result
```

## The five steps and what each result means

| # | step | PASS means | FAIL means |
|---|---|---|---|
| 1 | `displays` | Electron sees ≥2 displays (count + bounds printed) | Not the spike's hardware — connect the second display, disable mirroring, rerun. The harness refuses (exit 1) rather than degrade silently |
| 2 | `placement` | The renderer-opened popup sits on display 2 (the harness records whether the `window.open` features string alone landed it there, or MAIN had to `setBounds` — both are fine and P4 wants to know which) | Survivable alone: P4's display map positions from MAIN anyway. Record it; steps 3–5 still ran and their answers still count |
| 3 | `domAccess` | The MAIN window's renderer reached `popup.document`, found the real `[data-testid="present-canvas"]`, got its 2D context, and installed `__presentFrame` opener-realm | **The P4 premise is dead.** Re-plan output windows (main-process `BrowserWindow`s + a push transport, interruption-matrix §2 option (a)) BEFORE any window-manager code |
| 4 | `blitPixels` | A pixel read back **inside the popup** (`getImageData`, in the popup's own renderer, on display 2) is the magenta the opener blitted — non-black, correct color | **The captureStream failure mode reproduced on the DOM path** — cross-display compositing is eating the blit. Same re-plan as step 3 |
| 5 | `motion` | Two samples ≥3 sink-pulls apart show the counter square advancing — a live blit, not one frozen frame | A stale-single-frame link: the sink pulled once and stalled. Treat as step 4 failing (a frozen projector is the owner-P0 failure shape) |

**PASS on all five → P4 is unblocked on the `window.open` +
`setWindowOpenHandler` architecture.** FAIL on 3, 4, or 5 on real
dual-monitor hardware → P4 re-plans first. A dry-run result never unblocks
anything, and the harness says so itself.

### `--crash-probe` (optional, observation only — never a step)

Interruption-matrix §2's free add-on: after the five steps, the harness
force-crashes the OPENER's renderer and records what happens to the popup
under the shipped bare `{action:'allow'}` (no `outlivesOpener`). On the
dev machine the popup died with the opener (`render-process-gone: killed`,
window closed) — consistent with §2's same-renderer-process analysis. The
owner-hardware record feeds row 1's pending output-window-fate decision; the
`outlivesOpener:true` variant is a P4-re-plan experiment, deliberately not
wired here (it would mean overriding the shipped handler).

## Why you can trust the harness on the machine it refuses to run on

- The display-bounds math, placement matcher, pixel predicates, pattern
  contract, and verdict rules are pure (`src/spike/opener-display-logic.ts`)
  and unit-tested (`npm run spike:unit`, 12 tests, run automatically at the
  start of `task desktop:spike`). The draw code injected into the opener is
  generated from the same `counterColor` the readback asserts against, so the
  two halves cannot drift.
- The verdict cannot go vacuously green: a missing/NOT-RUN/DRY step fails real
  mode, and a dry-run still requires steps 3–5 to actually pass.
- Verified on a single-display dev machine 2026-09-06 (Electron 44.1.1):
  dry-run green ×3 (domAccess/blitPixels/motion all PASS, magenta
  `[255,0,255,255]`, counter advancing, exit 0), real mode refuses with the
  dual-monitor message and exit 1, zero leaked Electron processes.

## Results (filled in by the owner)

```
date:                 ____________          electron: 44.1.1 (from the JSON record)
displays (count + bounds line from step 1):
  __________________________________________________________________

1 displays    PASS / FAIL   detail: ______________________________________
2 placement   PASS / FAIL   features-string landed on display 2: YES / NO
                            corrected from MAIN via setBounds:   YES / NO
3 domAccess   PASS / FAIL   detail: ______________________________________
4 blitPixels  PASS / FAIL   background pixel readback: [ ___, ___, ___, ___ ]
                            (expected ≈ [255, 0, 255, 255]; black = the failure)
5 motion      PASS / FAIL   counter pixel A → B: [ ___,___,___ ] → [ ___,___,___ ]
                            painted A → B: ____ → ____

crash probe run: YES / NO   popup outcome: ______________________________

VERDICT:  P4 UNBLOCKED on window.open architecture   /   P4 RE-PLANS
JSON record path: ________________________________________________________
```

Paste the filled block (or the JSON) into the plan package alongside
`p2-notes.md`, and update plan.md §1.2's "main ↔ output windows" row from
"scheduled" to the recorded result.
