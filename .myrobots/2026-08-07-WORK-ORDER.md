# 2026-08-07 — WORK ORDER (owner-set)

> **2026-08-12 janitorial sweep: ~115 lines DELETED.** The four-phase ordering
> this file set has been overtaken by events on three of its four phases, and the
> phase-1 defect dossier it quoted was already marked FIXED when it was written
> (that misread is the lesson at the bottom). Only the phase-3 entry is still
> live work. The owner ordering itself also lives in the memory
> `work-queue-2026-08-07`.

| # | phase | state 2026-08-12 |
|---|---|---|
| 1 | silent-OUT-R + `cube` / `cloudseed` | **DONE** — #1343 (the five-module stereo-silence class), plus `cube.base_vol` defaulting to 0 and `cloudseed`'s explicit `silentL`/`silentR` cross-fill |
| 2 | stereo normalization | **CORE COMPLETE** — #1397, #1402, #1404, #1407, #1408 (DUAL-MONO), #1409 (THE FLIP), #1426 (per-leg patching). Remaining: **PR-5** (declared-pairs parity + attest batch) and **PR-6** (mixmstrs per-channel pan) — `stereo-audio-plan/plan.md` |
| 3 | **Light Mode for `?shell=1`** | **STILL NOT STARTED.** No plan doc, no PR, no theme module anywhere under `packages/web/src` — the only `prefers-color-scheme` handling in the tree is on published/rendered surfaces, not the rack UI. **The one phase with zero motion.** |
| 4 | faceplates | **PAUSED by owner directive.** 32 modules now carry a `face` (`STRICT_FACES`); the specs for the rest are banked, not cancelled |

## Phase 3 — the two constraints worth knowing before anyone starts

The **current theme is DARK mode** — Light Mode is additive, not a re-theme.

1. **Expect the real work to be TOKEN EXTRACTION, not CSS authoring.** The rack
   UI has no theme layer at all to extend.
2. **Expect VRT churn across every card baseline.** Plan the baseline strategy
   *before* writing styles — and note that the strategy changed under this file:
   there is now ONE baseline set, authored by linux CI (#1458), so a re-pin is
   one dispatch rather than a per-platform matrix.

## The lesson this file is kept for

I put phase 1 first on a MISREAD. The inventory table I quoted sits under the
heading **"THE STEREO-SILENCE CLASS — five modules, FIXED in #1343"**; I read the
measured `0.0000e+0` values and the module list without the heading above them,
and ordered a whole phase of work that was already done.

**A table of measured failure values reads as a bug list even when its heading
says FIXED. State the status in the ROW, not only in the section heading** — a
row that says `0.0000e+0 → 0.858524 fixed` is ambiguous about which number is
current.
