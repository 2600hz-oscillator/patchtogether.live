# The branch's FIRST CI signal, and what it actually found

**Status:** ⚠ EVIDENCE, NOT INSTRUCTION (`.myrobots/` per AGENTS.md). IN PROGRESS.
**Run:** 33884715624 on `feat/legacy-removal` @ `3a3985c33` (draft PR #2349).
**Read this before re-triaging any red job on this branch.**

## The headline: nine red e2e shards were not nine bugs

| job | verdict |
|---|---|
| `lint` | ONE condition. 12 `preserve-caught-error` are STAGED debt (blocking findings: 0); the only failure was **1 stale row** in `e2e/waitfortimeout-ledger.generated.txt` naming `sticky-note.spec.ts`, which the group slice deleted. `task lint:waits:accept` — one line removed. |
| `collab` | ⚠ **NOT vacuous** — the job ran against a real `DATABASE_URL` (postgres service, `apply-db-schema.sh` step present in the log). Two REAL failures, both DOOM. See below. |
| `e2e` 2,3,5,6,7,8,9,11,12 | Several distinct classes; **shard 8's 25 failures were ONE cause**. |

## Shard 8: 25 of 26 failures were one dead testid

Every video module's emit leg failed with `acidwarp.out: video-out canvas present … Received: 0`.
`data-testid="video-out-canvas"` is emitted by **`VideoOutCard.svelte` and nothing else**
(`grep` over `packages/web/src`, one hit). The sweep boots the default shell now, so
there is no card, so the locator resolves nothing — and `toHaveCount(0)` is what an
ABSENT SURFACE looks like. It says nothing about the port.

Successor: the lane tile's `VideoTileThumb` — a 160x120 2D canvas fed from the same
central engine frame the card canvas took, stamped `data-thumb-node="<nodeId>"`. Three
files read the dead testid; all three re-pointed:
`per-module-per-port-outputs.spec.ts`, `per-module-per-port-behavioral.spec.ts`
(`VIDEO_SINK_CANVAS` → `videoSinkCanvas(sink.node.id)`), `lushgarden.spec.ts`.

Naming the sink by node id also retires the `.last()` heuristic that existed only
because a videoOut SUT painted a second card canvas.

## ⚠ AND THE SWEEP'S VIDEO HALF WAS VACUOUS, ON BOTH SURFACES

Re-pointing it exposed the reason it had been green. MEASURED 2026-09-04, a videoOut
spawned with **NO edge into it**:

| surface | nonBlackFrac | variance | old floors (`>0.001`, `>0.5`) |
|---|---:|---:|---|
| shell tile thumb | 1.0000 | 1.50 | **both pass** |
| legacy card canvas | 1.0000 | 22.82 | **both pass** |

An unpatched videoOut paints its own dark-blue idle gradient (10,15,27..37), and the
card's variance came from the **card CHROME** around the frame — the card canvas is
340x304, not a video aspect. So "the port emits a measurable signal" was never what
this branch measured, on either shell. The vacuity is PRE-EXISTING; the flip only
stopped it being green.

Repair (same test, same subject, non-vacuous): a **differential against the sink's own
idle picture** — one 16x12 luma grid, measured once per worker from a rack holding only
a videoOut, cached, required to differ in ≥8 cells by >4 luma. Two traps found while
building it, both recorded at the call site:

1. The tile is `VideoTileThumb`, whose canvas is **transparent black before its first
   tick** — and transparent black differs from the idle gradient in EVERY cell, so a
   naive predicate ends the poll on the emptiest possible read. Fixed by waiting on the
   component's own `data-thumb-painted` **and** refusing to count an ink-less frame.
2. `SINK_CELL_DELTA` 12 rejected loopback's real picture (mean 25.1 vs idle 19.0). 4 is
   the measured compromise; the idle shader is deterministic so the floor is 8-bit
   rounding, not noise.

Result on the 25: **21 green**, and the residue is listed below — each one a port that
delivers nothing on a bare spawn and was called green by card chrome.

## FOXY IS SILENT ON THE SHELL PLAYERS ALREADY HAVE

The one shard-8 failure that was NOT the testid. Measured, same patch, both shells:

```
FOXY -> SCOPE.ch1 :  ?shell=legacy  maxPeak 1.0000
                     default shell  maxPeak 0.0000   (6 s window, 201 readings)
```

Cause: FOXY's `wavecel` worklet plays a wavetable that only the factory's
`bridgeTick()` rebuilds. Nothing calls `bridgeTick()` directly — it runs as a SIDE
EFFECT of `read(node,'rasterImageData*')`, and the only caller was `FoxyCard.svelte`'s
rAF, under a comment that says so ("Drive the bridge once, then read the cached
previews"). So the module's SOUND had a card's lifetime: #1587's exact class, missed by
S1's producer extraction.

⚠ **This is a live production defect, not a consequence of the removal.** The default
shell is what players get today; a rack with a FOXY in it makes no sound. It was only
ever invisible because every test that could have seen it booted the card.

Fixed by `FOXY_FRAME_PRODUCER` in `lib/ui/media/frame-producers.ts` — one read per
frame on the node ticker, the picture deliberately dropped. Which read: measured, not
guessed — pumping `wavetableFrames` or `xyzField` leaves maxPeak 0.0000; pumping
`rasterImageDataA` gives 1.0000.

## The lane tile clipped its own DOCK BUTTON on two modules

`io-spec-consistency`'s tile sweep, reproduced locally: seqtris 11.9 CSS px and skifree
19.9 CSS px of BOTTOM overflow, offender `[lane-jack-rail]`. Reading the DOM: the rail
**and `shell-open-dock`** both sit below the 192x180 tile, and `module-shell` is
`overflow: hidden` — so on those two tiles the affordance that OPENS THE DOCK was
unreachable, not merely ugly.

Both tile bodies were sized 104 px against the legacy card's 260 px of height ("MEASURED
against `_card-overflow`, not guessed", says seqtris' comment — measured against the
wrong box). Now 88 (seqtris) / 80 (skifree). ⚠ This moves those two modules' face VRT
scenes and is a LOOK CHANGE: owner preview + bot recapture.

⚠ `EXEMPT_CONTROL_OVERFLOW` in `_card-overflow.ts` is entirely CARD-era (clipplayer,
cloudseed, graphicEq, ruttetra, synesthesia, wavesculpt — all quoted against 360x540 /
720x540 tiers). Every row of it is stale for the tile sweep and dies with the fleet.

## Collab: two DOOM failures, and they are NOT in the approved edit scope

`doom-mp-lockstep-sharedstate.spec.ts` — two tests, both on the OVERLAP guard:

```
P1 and P2 must share enough overlapping tics … p1Tics=16 p2Tics=16 advanceA=125 advanceB=125
```

Both peers sampled 16 distinct tics each while advancing 125, and shared ZERO. That is
`sampleSharedTics` sampling SPARSELY (≈8 tics between samples — one `checksumAt` round
trip per ~750 ms on the CI runner) against two sims holding a small constant tic offset:
any offset below the sampling stride yields no overlap at all. The instrument, not the
lockstep — the checksum-equality oracle never got to run.

⚠ **NOT TOUCHED, DELIBERATELY.** The owner's DOOM approval on this branch covers the
14 spec re-points and (separately, ruling 29) the `data-viz-passthrough` attribute.
`sampleSharedTics` is a DOOM wait/budget; changing its sampling density is outside both
grants. Reported for a decision. The file's own history says this is not the first time
(`fc0b9608ef fix(doom-mp): harden flaky @collab lockstep overlap-window assertion`).

## The 3 "reasonless skips" in shard 2 are not skips

`gibribbon evt_fire / evt_kill / evt_gameover` reported as reasonless runtime skips.
They are the tail of the file: `evt_hit` flaked, `evt_miss` failed, and the remaining
three "did not run". Fix the gibribbon gate-bridge failure and the budget violation
goes with it — there is no `test.skip` anywhere in that file.

## What was FIXED, and what it cost

| finding | resolution |
|---|---|
| `lint` stale ledger row | `task lint:waits:accept` — one line |
| shard 8, 24 legs | sink read re-pointed to `VideoTileThumb` by node id |
| the sweep's video half was vacuous | differential against the sink's own idle picture, measured once per worker |
| FOXY silent on the shell | `FOXY_FRAME_PRODUCER` + the fixture `card-producer-lifetime` demands |
| seqtris/skifree clipped dock button | tile bodies 104 -> 88 / 80 px. ⚠ LOOK CHANGE — owner preview + bot recapture |
| `cameraInput.out`, `mandleblot.color_out` | `EXEMPT_OUTPUT_EMIT` with the both-shells measurement; pinned in the same commit |
| bluebox BLUEBOX/REDBOX silent | `Button.svelte` `setPointerCapture` guarded — a PRODUCT fix, see below |
| painter "second stroke drops" | the drag never reached the canvas; `scrollIntoViewIfNeeded` + a hit-test guard |

### ⚠ THE BUTTON BUG IS THE ONE TO REMEMBER

`Button.svelte`'s `pointerdown` set `pressed = true`, called
`setPointerCapture(e.pointerId)` UNGUARDED, then dispatched the gate. A capture
that throws skips the dispatch — so the pad paints itself held and the engine
hears nothing. `bluebox.spec.ts` dispatches `pointerId: 1` on its digit leg
(Chrome's live mouse pointer, capturable) and `pointerId: 2` on the BLUEBOX and
REDBOX legs (not capturable): the digit sounded, the other two read 0.0000 at
every band with `aria-pressed="true"`. Fixed in the PRODUCT, not the test —
re-numbering the pointer would have hidden every real capture failure.

## Still open

| subject | state |
|---|---|
| `@collab` DOOM ×2 | `sampleSharedTics` under-samples (16 samples across 125 tics, so any constant tic offset gives zero overlap). It is a DOOM wait: OUTSIDE every grant on this branch. Owner decision needed. |
| `loopback.out` | passes in isolation, times out under 3-worker load. Watch it on the next run rather than exempting. |
| the timeout class | `backdraft`, `videovarispeed-perfzip`, `toybox-presets-io`, `chromaconsole`, `picturebox-limits`, `bentbox`, `card-drop-patch`, `gibribbon`, `fader`, `fader-midi-assign` are ALL GREEN LOCALLY (29/29 and 20/20). Their CI failures are test-timeout shaped — the fixture/contention class this branch was warned to expect, because ~400 specs were re-pointed onto a slower boot while `e2e-timings.generated.json` still carries main's costs. The S5 cost-artifact loop is the designed answer. |
| S3, S4, S5 | NOT STARTED. S3 is mapped in `s3-vrt-map.md`; note its interlock is wider than that file's "47 files" — a grep for the four exemption tables alone reaches 48 files, led by `vrt-meta.test.ts` (50 refs) and `_shell-faces.ts` (44). |

## ⚠ THE BRANCH GOT NO SECOND CI RUN

Two pushes (`95e4a80aa7`, `d2e0914954`) moved the PR head — `gh pr view 2349`
confirms `headRefOid` — and NEITHER produced a workflow run:
`actions/runs?head_sha=...` returns `total_count: 0` for both, and
`gh pr checks 2349` lists only CodeRabbit. `ci.yml` fires on
`pull_request: [opened, synchronize, reopened]`, so a push to the head branch
should have fired one. Whatever the cause (queue, draft handling, an org
setting), **do not read the absence of a red as a green** — the fixes above are
verified locally and have never been exercised by CI.
