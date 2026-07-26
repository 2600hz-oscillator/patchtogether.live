# `?shell=1` UI refactor — state + resume plan (2026-07-26)

Written at shutdown. This is the file to read first when picking the work back up.

---

## Where things stand

Main is `2392dac7`. Three PRs merged overnight, each green on its own final commit, each
auto-deployed to dev:

| PR | contents |
|---|---|
| **#1169** | Batch 1 — rear-card flip (TAB), side-by-side 50/50 dock, 6 faces (adsr, cloudseed, kickdrum, lfo, tidyVco, vca), the `?shell=1` no-video P0, menu viewport-clamp at 12 sites, render-parity + pitch-accuracy gates |
| **#1171** | Batch 2 — dx7, sixstrum, snaredrum, tomtom, shimmershine, qbrt + `shell-cells.ts` (real interactive family/static cells), `face.momentary`, `faceTierCap` |
| **#1173** | Two load-induced e2e flake fixes (`clipplayer-rate-reset`, `clip-automation`) |

**12 modules are faced and live on dev.**

### Still open at shutdown

- **#1174 — batch 3** (karplus, filter, mixer, delay, reverb). Built, all five individually green.
  Its integrator agent was still working the attest gates: ART re-pinned (delay's fix moved the
  baseline, expected), collab re-attest in progress, and it needed `origin/main` merged in to pick up
  #1173. **DO NOT MERGE — the owner reviews the faces.**
- **#1172 — the frametable hot-loop fix.** Main merged in at `05dd23a6` to pick up the flake fixes;
  its only failures were the two specs #1173 fixed. Should go green; safe to merge on green.
- **#1008** — `feat/mobile-view`, a draft untouched since 2026-07-03, CONFLICTING. Revive or close.

---

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

## NEXT UP

1. **Land #1174** once its agent finishes (main merged, collab re-attested, CI green on the final
   commit). Owner previews the faces first.
2. **Revisit the dx7 face — owner: "looks nothing like its mock."** The mock was produced as part of
   this process. Known gap: the mock's OP1–6 pages need ~78 new params, which is a MODULE REWORK, not a
   face. Decide: ship patch-driven with a preset picker, or schedule the rework. The mocks themselves
   were lost in a crash (they lived in a wiped scratchpad) — regenerate or recover them first.
   NOTE: `.myrobots/` is GITIGNORED, so anything saved there is local-only.
3. **Batch 4 shortlist:** timelorde (master clock, high traffic); a "visualizers" batch (scope +
   dockscope + spectrograph — glyph-dominated faces); sequencer; noise; sampleHold.
4. **Platform gaps found during batch 3**, both of which will recur on every future face:
   - `ParamDef` has no enum/options field, so a `curve:'discrete'` param renders as a bare detented
     knob with NO option labels (filter's MODE shows no LP/HP/BP). The legacy card's labelled buttons
     were strictly more legible. Wants a Segmented/Selector cell — the machinery exists in batch 2's
     `shell-cells.ts`.
   - `PortDef` has no `label` field, yet `rear-card-model`'s `RearPortLike` and `patch-panel-labels`'
     `PortDescriptor` both already declare `label?` and `resolveVerboseLabel` honours it. ~6 lines,
     additive, contract-transparent. (This is why mixer's rear holes read `IN1..IN4`, not `CH1..CH4`.)
   - Rear/lane jack labels double their suffix (`TRIGGER IN`, `ACCENT IN`). Fix is a one-line
     `_in`/`_out` rule in the shared `patch-panel-labels.ts` — global, moves existing rear baselines.
5. **karplus's PLUCK button is unreachable in the shell face** — it uses the `manualTrigger` seam, not
   a param, so it can't be ranked and `faces-parity` rejects dead cells. Fix: adopt tomtom's `strike`
   press-param (discrete 0/1, OR'd with `trigger_in`). Costs a 9th param ⇒ contract-lock diff + ART
   re-pin. Batch 2 already built the momentary control kind this needs.
6. **A 4th clipplayer-family flake**, `clipplayer-queue-boundary.spec.ts:127/:148`, blocked #1174's
   shard 2/10. Also `clip-automation.spec.ts:428` ("module-assign + per-lane arm") times out under
   saturation on unmodified main. Both need the same treatment as #1173.

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
