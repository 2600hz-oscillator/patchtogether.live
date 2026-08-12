# `?shell=1` UI refactor — state + resume plan (2026-07-26)

Written at shutdown. This is the file to read first when picking the work back up.

> **TRIAGE 2026-08-04 — the OWNER DECISIONS section is still authoritative; the
> "NEXT UP" list is SPENT and must not be worked from.**
> **Keep this file for §"OWNER DECISIONS — recorded 2026-07-26"** (reverb's hot
> wet path left as-is; delay's equal-power fix approved; filter's two
> attenuverters approved; the catalogue-overlap note; the dock full-view gating
> ruling "SETTLED — leave as is") **and for §"Hard-won lessons"** — both are the
> only record of those calls. Everything else below has been overtaken:
>
> - **"12 modules are faced"** → **18 faceplates ship** today (`STRICT_FACES` has
>   21 entries), and all 18 were then RE-SPECCED against the corrected platform
>   (`face-redo-*`). Read the batch tables as history.
> - **NEXT UP 2 (dx7 face / "looks nothing like its mock")** → resolved by
>   running the whole DX7 program: **#1187, #1190, #1210** (engine) then
>   **#1265, #1266, #1268, #1270** (UI, PR3–PR6). See
>   `dx7-and-faces-design-program-2026-07-27.md`.
> - **NEXT UP 4 (platform gaps)** → `PortDef.label` shipped
>   (`packages/web/src/lib/graph/types.ts:268`); the labelled-selector gap was
>   addressed in the batch-D/E face wave.
> - **NEXT UP 5 (karplus's PLUCK unreachable)** → fixed by **#1289** ("KARPLUS
>   face — the PLUCK reaches the dock"); the general fix became the required
>   `ShellActionCell.probe` + audition-ledger rule now in CLAUDE.md.
> - **#1008 (`feat/mobile-view`) "revive or close"** → **CLOSED 2026-07-29.**
> - The `?shell=1`-vs-dock gating background is superseded by the memory
>   `shell-flag-not-a-complete-gate`.

---

> **2026-08-12 janitorial sweep:** the "Where things stand" and "NEXT UP"
> sections were DELETED — both were spent, and the 2026-08-04 triage banner
> above already itemises what replaced each entry. What follows is the two
> sections that are the ONLY record of their content.
>
> ⚠ **Decision 5's MECHANISM is obsolete even though the RULING stands.**
> `?shell=1` is gone: the shell is the default and `?shell=legacy` is the escape
> hatch (#1459 killed dawless mode). `shellPreview` was renamed `shellFaces` and
> the predicate is now `if (!i.shellFaces || !i.hasCard) return 'legacy'`
> (`legacy-fallback.ts:109`, with the rename recorded at `:81-82`). Read the
> ruling ("leave as is; do not add a gate conjunction there"), not the citations.

## OWNER DECISIONS — recorded 2026-07-26

1. **Reverb's hot wet path: LEAVE AS IS for now.** (Measured +11.4 dB at defaults, wet peak +21.2 dB
   over dry, clipping downstream — Faust's `mono_freeverb` sums 8 combs with no output scaling.
   Documented honestly; not fixed. Revisit later; the fix re-SHAs the wasm, moves every ART baseline
   and makes existing patches ~10 dB quieter.)
2. **Delay's equal-power dry/wet fix: APPROVED.** (Factory initialised linearly while `setParam` and
   `readParam` used the √ law — the first MIX touch jumped the level and `readParam('mix')` returned
   `wet²` = 0.1225 instead of 0.35. Slightly changes default audible output.)
3. **Filter's two attenuverters: APPROVED.** (`cutoff_cv_amt`, `res_cv_amt` — the cutoff jack maps
   ±5 octaves with no depth trim, so a plain envelope pinned the corner at 20 kHz. GainNodes in the
   existing CV path; identity at the `+1` default; ART profile unmoved.)
4. **Catalogue overlap: NOTED, future work.** filter/resofilter (near strict superset),
   reverb/cloudseed/shimmershine/moog905, delay/cofefve/charlottesEchos, and a FOUR-way split of
   "add signals together" (mixer/attenumix/moogCp3/mixmstrs). Plus `ringback` is mis-filed as a delay
   (it's a bitcrusher), and `attenumix.ts` still has ~8 lines of prose comparing itself to VEILS,
   which is not a registered module.

5. **Dock full-view gating: SETTLED — leave as is. No change needed.** Owner's ruling: the dock
   showing the new faceplates is fine, *provided* the old view still shows the old full cards in the
   workspace and they still flip on TAB. **Both verified in code on `2392dac7`:**
   - `legacy-fallback.ts:108` — `if (!i.workflowMode || !i.shellPreview || !i.hasCard) return 'legacy'`
     returns BEFORE consulting face membership, so with the flag off every workspace module renders its
     verbatim legacy card.
   - `Canvas.svelte:7229` `isFlip()` — the canvas TAB handler is unchanged and only defers when
     `dockStore.fullViewNodeIds.length !== 0`, i.e. gated on dock OCCUPANCY, not on faces or the flag.
     Its own comment: "With the full-view CLOSED, Tab keeps its original canvas-wide behavior."
     (That guard is the double-handler fix — one keystroke used to toggle both `fullViewFlipped` and
     the canvas `rearView`, and the two states phase-diverged.)

   So the dock is the ONLY surface where the new faceplates appear with the flag off, and that is
   intended. Do not add a `shellPreview &&` conjunction there.

### Background on that decision (kept for context)

**The dock full-view is not gated by `?shell=1`.** `Canvas.svelte:7843` passes
`migrated={migrated(fv.node.type)}` with no `shellPreview` conjunction, while `shellPreview` itself is
`workflowMode && shell === '1'` (line 492). Lane tiles ARE correctly gated via `laneRenderKind`; the
dock is not. So all 12 faced modules show the RACKLINE faceplate in the bottom drawer regardless of the
flag — live on dev now. May well be intentional (`DockFullView`'s own header comment frames the split as
un-migrated→legacy card / migrated→ModuleShell, never mentioning the flag). If the flag should be a true
gate: `migrated={shellPreview && migrated(fv.node.type)}` plus a regression test asserting the flag-off
dock renders the legacy card. **VRT would not have caught this** — faced modules tend to be in
`EXEMPT_FROM_VRT`, so there is often no legacy-card baseline to move.

---

## Hard-won lessons worth not relearning

- **A flaky test can be UNSOUND, not merely under-budgeted.** `clipplayer-rate-reset` PASSED at
  +6000 ms and +14000 ms of injected latency **via a natural 128-step loop wrap, with no reset having
  occurred at all**. It had been "hardened" twice against the wrong variable because each
  investigation only asked why it FAILED. When you root-cause a flake, sweep the failure parameter
  across a RANGE — a non-monotone pass/fail pattern is the signature of an unsound assertion — and add
  a negative control (remove the triggering action; the test must fail).
- **`git stash` is REPO-WIDE, not per-worktree.** Two parallel agents stashed concurrently and one
  popped the other's stash into the wrong worktree. Nothing was lost, but parallel worktree agents must
  never stash — use a scratch commit on their own branch.
- **Check the primary checkout for uncommitted work before assuming it's a clean base.** It had drifted
  11 commits behind main while holding work that was NOT in main. Preserved as
  `origin/wip/landing-new-rack-tiles` (landing "new … rack" tiles routing to `/rack?new=1`, plus ~280
  lines of Launchpad spec). **Untested and unreviewed — still needs a home.**
- **Scale e2e budgets by the work the test does, not a flat number.** `faces-parity` ran on the 30 s
  default while driving every cell of every faced module; the four CI failures were exactly the four
  biggest faces (clean cutoff between 19 and 22 cells). Fixed by deriving each face's ceiling from its
  own cell count — a flat bump would have re-broken as soon as batch 3 added five more faces.
- **Agents should verify instructions, not just follow them.** Two of mine were wrong: 512-step clips
  are rejected (`MAX_CLIP_STEPS = 128`, clamped on the read path), and a prescribed poll would have read
  through the same slow transport it was meant to escape. Both were caught and corrected by the agent.
- Roughly **25 authored docs claims were wrong** when checked against the real DSP across 11 modules.
  Assume any un-fact-checked module doc is wrong until verified against the code.
