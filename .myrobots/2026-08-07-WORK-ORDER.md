# 2026-08-07 — WORK ORDER (owner-set)

> ## STATUS (2026-08-09) — verified against the merge log, not against this doc
>
> | # | phase | 2026-08-09 |
> |---|---|---|
> | 1 | silent-R + cube/cloudseed | **DONE** (was already done when this file was written — see the banner below) |
> | 2 | stereo normalization | **CORE COMPLETE.** PR-0→PR-4 all merged: #1397, #1402, #1404, #1407 (leg-group planner), #1408 (DUAL-MONO), #1409 (THE FLIP), plus follow-on #1426 (per-leg patching). Remaining backlog: PR-5 (declared-pairs parity + attest batch) and PR-6 (mixmstrs per-channel pan) — see `stereo-audio-plan/plan.md`. |
> | 3 | Light Mode for `?shell=1` | **STILL NOT STARTED** — no plan doc, no PR. Now the only phase with zero motion. |
> | 4 | faceplates | **RESUMED and moving.** Merged: analogVco #1416, meowbox #1417, vca re-do #1429, filter re-do #1430, bluebox #1431; batch-4 specs #1433. In flight: macrooscillator #1432 (open). Phase 4 started ahead of phase 3 in practice; the ordering below is the 2026-08-07 statement. |
>
> Nothing below this block is edited; it is the 2026-08-07 record.

Four phases, **in this order**. Set by the owner on 2026-08-07 after a review of
everything `.myrobots` had on the table. Do not jump ahead: phase 4 is blocked
behind phase 1 for a substantive reason, not just preference.

> ## ⚠ PHASE 1 IS ALREADY DONE — VERIFIED 2026-08-07, AFTER THIS FILE WAS WRITTEN
>
> I put phase 1 first on a MISREAD. The inventory table I quoted sits under the
> heading **"THE STEREO-SILENCE CLASS — five modules, FIXED in #1343"**; I read
> the measured `0.0000e+0` values and the module list without the heading above
> them. Re-verified against the tree, item by item:
>
> | item | actual state |
> |---|---|
> | 5 silent-OUT-R modules | **FIXED in #1343.** `mono-normal-not-defeated.test.ts` passes 41/41 and is a strong gate — def-anchored, ratcheted BOTH ways, negative-controlled per spelling, with an explicit "states what it CANNOT see" section |
> | `cube` envelope bypass | **FIXED.** `base_vol` now defaults to **0** (`cube.ts:279`), and the doc string documents the 0-default behaviour |
> | `cloudseed` third stereo-silence mechanism | **FIXED.** `packages/dsp/src/cloudseed.ts:1540-43` now has the explicit normal (`silentL`/`silentR` → cross-fill), the exact thing the ledger said was missing |
> | samsloop fader cross-clamp | **playback is safe** — `clampWindow` forces `end ≥ start + 1` (`samsloop.ts:795`). What remains is UX only: the faders permit an inverted drag with no on-screen explanation. Was always flagged as "a behaviour call for the owner", not a defect |
>
> **Nothing in phase 1 needs code.** The queue moves to phase 2.
>
> The lesson worth keeping: a table of measured failure values reads as a bug
> list even when its heading says FIXED. State the status in the ROW, not only
> in the section heading — a row that says `0.0000e+0 → 0.858524 fixed` is
> ambiguous about which number is current.

| # | phase | state |
|---|---|---|
| 1 | Silent right channels + `cube` / `cloudseed` | **DONE — already fixed before this file was written** |
| 2 | Stereo audio normalization (7 PRs) | **NEXT** — ready, 0 landed |
| 3 | Light Mode for `?shell=1` | not started, no plan yet |
| 4 | Faceplate programme | blocked behind (1) |

**Why this order.** The faceplate programme has audited 18 of the 99 face-less
audio modules and promoted **zero**, because the audits kept finding modules
that *do not work* rather than modules that look wrong. Putting a face on a
module whose right channel is silent is decoration over a broken module. So the
audited defects are cleared first, and that unblocks (4).

---

## Phase 1 — the audited audio defects

Evidence: `2026-08-03-MODULE-AUDIT-INVENTORY.md` (measured numbers, not
inspection) and `2026-08-03-SESSION-STATE.md` §6b (the carried-forward ledger).

### 1a. Silent OUT R — four modules, ONE mechanism

`charlottes-echos`, `cofefve`, `clouds`, `shimmershine`. The module factory pins
a silent `ConstantSource` onto input channel 1, which **overwrites** the DSP's
own `inputs[1] ?? inputs[0]` mono normal — so the normal can never fire and the
right channel renders exactly `0.0000e+0`. Measured fixed values are in the
inventory (e.g. charlottes-echos → `0.858524`, clouds → `6.8858e-1`,
shimmershine → `4.4212e-1`).

⚠ `shimmershine`'s own source header **already documented this** as "DEAD in
practice… Verified in Chrome" — it was written down and never fixed, which is
the same failure mode as the GL feedback loop (a known defect with nothing red).

### 1b. Silent OUT R — `resofilter`, a DIFFERENT mechanism

`channelInterpretation: 'discrete'` zero-fills channel 1, so the DSP's fallback
can never fire even though the fallback is present and correct. Same symptom,
different cause — do **not** apply the 1a fix blindly here.

### 1c. `cube` — wavecel's exact envelope bypass

`cube.ts:405` `base_vol` defaults to 1; `:753` multiplies `readFrame(…) *
baseVol * level`. Deliberately left untouched when wavecel was fixed, because
the shared helper `poly-osc-sum.ts` also feeds `dx7` and `pentemelodica` and the
blast radius had to be enumerated first. **Enumerate it before touching the
helper**; a per-module fix may be the correct smaller move.

### 1d. `cloudseed` — a THIRD stereo-silence mechanism

`cloudseed.ts:1510-11` reads `inputs[0]`/`inputs[1]` with **no `??` at all**, so
a mono patch leaves `inR` undefined. This is a *missing* normal, not a defeated
one. It changes audio behaviour → needs an owner ear **and** an ART re-pin, so
it is the one item here that cannot be silently shipped.

### Standing traps for this phase

- **Poly/chord or cable-width changes → run the FULL `task art` suite**; ART
  pins exact voicing.
- **Any fix that changes audio → the `.f32` moves**, and the fingerprint
  manifest must be re-pinned in the same commit (`task art:update` chains it).
  Review the manifest diff entry by entry; a labels-only move is a LEVEL change,
  a spectrum move is TIMBRAL.
- **Adding CV ports → run the FULL web unit suite** (cv-scale-registry +
  frozen-contract only fail in that lane).
- These modules are `packages/dsp` Faust sources in some cases and TS factories
  in others — check which before assuming a `.dsp` edit is needed.

---

## Phase 2 — stereo normalization

`.myrobots/stereo-audio-plan/plan.md`. FINAL, all 7 owner questions answered,
re-verified 2026-08-04 as still accurate: **0 of 7 PRs have landed**,
`stereovca` is still the module id everywhere, and `reconciler.ts:143`'s
`await engine.addNode(node)` is still unguarded exactly as PR-0 describes.

Phase 1 is deliberately upstream of this: several of the silent-R defects are
the *same* mono/stereo normalization confusion this plan generalises, so fixing
them first informs the plan rather than colliding with it.

---

## Phase 3 — Light Mode for `?shell=1`

Not started; no plan doc exists yet. The **current theme is DARK mode** — Light
Mode is additive, not a re-theme.

Known constraint from this repo: published/rendered surfaces already handle
`prefers-color-scheme`, but the rack UI does not. Expect the real work to be
token extraction rather than CSS authoring, and expect **VRT churn across every
card baseline** — plan the baseline strategy before writing styles.

---

## Phase 4 — faceplates

Resume the programme. 99 of 120 audio modules have no face. Method and the two
STOP gates: `.claude/skills/module-adversarial-audit.md` and
`.claude/skills/module-faceplates.md`. `face-specs-round-2-2026-08-01.md` is
kept as a **defect list, never as a design**.
