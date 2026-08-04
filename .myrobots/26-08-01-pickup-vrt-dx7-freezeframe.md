# Pick-up note — 2026-08-01 (VRT hardening · DX7 complete · freezeframe)

> ## ⚠ MOSTLY DISCHARGED — re-verified 2026-08-04
>
> Everything this note left pending has landed **except §4**. Kept for that one
> item and for the two still-open VRT observations; the rest is history.
>
> | this note said | 2026-08-04 |
> |---|---|
> | §2 font-settle sweep — "PUSHED, NO PR YET", branch `test/vrt-font-settle-sweep` | **MERGED as #1279**, including the 24 linux baselines. Branch gone from `origin`. |
> | §2 finding **(A)** the required lane pins a STALE CABLE PALETTE | **FIXED — #1281**, 76 baselines + a pixel-side gate |
> | §2 finding **(B)** the linux-deficit ratchet is blind to 62 of 151 gaps | **FIXED** — `e2e/vrt/vrt-platform-gaps.ts` now enumerates all four mechanisms and `vrt-meta.test.ts` ratchets the total in both directions (see CLAUDE.md) |
> | §2 "12 legacy uncompanioned VRT masks" | **LARGELY DRAINED** — 10 were **dead selectors** masking nothing and were deleted; 6 migrated to `e2e/vrt/vrt-live-surfaces.ts` with measured companions + a per-run negative control. ~17 uncompanioned entries remain in `VRT_MODULE_MASKS`. Still a live class, smaller. |
> | §2 the `combine-editor` fresh-spawn collapse | **NOT re-verified.** Believed still open. |
> | §3 FREEZEFRAME, "FIXED but NOT MERGED", branch `fix/freezeframe-gate-trigger` | **MERGED as #1274** — trigger + the FRAMETABLE sibling + a CI lane + a structural guard. All four listed blockers were closed in it. Branch gone from `origin`. |
> | **§4 `feat/tidyvco-sine-tri-square`** | **STILL UNMERGED — the only live item here.** Branch is on `origin` at `30a5e8b6`, **no PR was ever opened**, and it is now **85 commits behind `main`**. Still needs owner ears. |
> | §5 standing constraints | All now in `CLAUDE.md` / project memory. |
>
> Later handoffs supersede everything else here: `2026-08-03-SESSION-STATE.md`.

Shut down mid-campaign. `main` is GREEN and everything below is either merged
or on a pushed branch. Nothing is lost on disk only.

**main @ `77cd1bbc`** — `feat(dx7): the operator map + detail panel (DX7 PR 6)`

---

## 1. Merged today — 8 PRs

| PR | what |
|---|---|
| #1262 | P0 triage: the patch-load DOM leak was a DEV-SERVER artifact |
| #1263 | recorderbox crash-recovery prompt was clipped OUT of the card |
| #1265 | dx7 PR 3 — pure model layer |
| #1266 | dx7 PR 5 — voice edit buffer + preset STAMP |
| #1267 | **VRT: tighten tolerance + regenerate the LINUX baselines** |
| #1268 | dx7 PR 4 — algorithm glyph + 32-diagram picker |
| #1269 | VRT: settle webfonts in `vrt-composite-coverage` |
| #1270 | **dx7 PR 6 — operator map + detail panel** |

### DX7 IS DONE — 8 of 8
PR 0, 0b, 1, 2 landed earlier; 3, 4, 5, 6 landed today. The module now matches
its spec: algorithm glyph, 32-diagram picker, operator map with carrier rail,
detail panel with draggable EG + ghost curves, patch-safety cluster
(dirty ✱ / REVERT / STORE / INIT).

Program plan: `.myrobots/plans/dx7-and-faces-design-program-2026-07-27.md`.

**⚠ The plan's "pasteable" §3.2 `face.pages` block is WRONG and stays wrong.**
It uses `{ id: 'voice' }` for the first page; that id collides with the rear
group's own `voice` id, renders the band TWICE and turns the rear-derivation
totality gate red (`hole count 7 ≠ declared port count 4`). The def uses
`id: 'patch'` with `label: 'voice'`. That block predates the discovery — do not
"fix" the def to match the plan.

---

## 2. VRT campaign — where it actually stands

### The REQUIRED gate is DONE
`vrt-strict` (linux, REQUIRED) passes 48/48. All 48 `STRICT_VRT_MODULES` have
baselines on BOTH platforms. Audited count: **280 darwin vs 129 linux**.

### What #1267 changed
`threshold` 0.2 → **0.1**, `maxDiffPixelRatio` 0.05 → **0.01**. 117 darwin +
54 linux baselines re-pinned. Root cause of the drift: **#1159 (2026-07-22)
shipped a repo-wide palette change and re-pinned NOTHING** — at
`threshold: 0.2` a jack glyph going amber→cyan did not count as a differing
pixel, so it was invisible on both platforms for weeks.

**34 of 48 required-gate linux baselines (71%) were genuinely stale.**

### PUSHED, NO PR YET — the font-settle sweep
**Branch `test/vrt-font-settle-sweep`, commit `93a16e37`, 117 files.**

It was committed AT SHUTDOWN to preserve it: the agent had 117 files dirty and
ZERO commits when the session ended, so all of this existed only on disk.
**Verify runs 1 and 2 were clean (264 passed each); run 3 was IN FLIGHT.**
Re-run the 3× verification before opening a PR — two green runs do not prove
stability any more than one does.

- 20 specs / 31 navigation sites now call `pinVrtFonts` + `awaitVrtFonts`.
- 80 darwin baselines regenerated; **49 changed DIMENSIONS** — Playwright
  hard-fails a size mismatch BEFORE computing a ratio, so those could never
  have matched a differently-fonted machine at ANY tolerance.
- **Negative control held**: `vrt.spec.ts` (114 baselines, already pinned) and
  `vrt-toybox.spec.ts` (27, WebGL) regenerated **ZERO**. That is what makes
  the other 80 trustworthy.
- Verify run 1 clean (264 passed / 9 skipped); runs 2–3 were in flight.
- **The linux dispatch did NOT happen.** 24 PNGs with COMMITTED linux baselines
  (`playhead` 9, `vrt-composite` 6, `vrt-karplus-tomtom-states` 6, `vrt-clap` 3)
  will MISMATCH on CI. Dispatch before merge:
  `flox activate -- gh workflow run vrt-update.yml -f ref=test/vrt-font-settle-sweep -f platform=linux`
  ⚠ UNSCOPED — never pass `-f grep=…` (the run dies as `startup_failure`).
  ⚠ First check `EXEMPT_BASELINE_PAIRS` for any `linux/<scene>` among them: a
  still-exempt pair is `test.skip()`-ed unconditionally, so the regen writes
  NOTHING and comes back green having captured zero. Drain those pairs (and
  lower the vrt-meta ratchet by the same count, same commit) FIRST.
  ⚠ The bot's push lands follow-on runs in `action_required`, not `queued` —
  approve them. Then VERIFY the bot actually committed PNGs; a green dispatch
  that committed nothing is a red flag, never "nothing to do".

  This matters because the `vrt` lane is `continue-on-error: true` and sits
  outside the `ci` umbrella's `needs` — it CANNOT block a merge, so a red there
  is easy to skip past and those 24 baselines would just go dark.

**Do not restart this work — it is on the branch above.**

### 🔴 TWO REAL FINDINGS — NOT fixed, each needs its own PR

**(A) The required lane renders a STALE CABLE PALETTE.**
#1159 recoloured `--cable-*` and regenerated only 9 PNGs. **19 of 34
token-pinned stripes in `vrt.spec.ts/linux` are off-palette, 8 of them inside
`STRICT_VRT_MODULES`.** Confirmed by eye: `linux/adsr.png` has a salmon
`#f87171` stripe where `darwin/adsr.png` has amber `#f2c14e` — same card, two
palette generations.

Why it is invisible, and why the 2026-07-31 tightening does NOT catch it: the
stripe is ~2px ≈ **0.8% of the card, under the 1% `maxDiffPixelRatio`**. So the
gate PASSES *and* `--update-snapshots` refuses to rewrite it (Playwright only
rewrites on FAILURE). **This is the A2/#1213 hole live in the required lane.**
Fix: `git rm` the affected baselines, then regenerate.

**(B) The linux-deficit ratchet is blind to 62 of 151 gaps.**
Gaps are declared through FOUR mechanisms; `vrt-meta` counts ONE. Worse, **15
counted entries name modules whose linux baseline IS committed but is never
compared** — a `linux/<m>` pair still `test.skip()`s them. Coverage that was
paid for is sitting dark.

### Also still open
- **12 legacy uncompanioned VRT masks**, deleting 9.9%–31.8% of their cards.
- The `combine-editor` product bug: the toybox node-editor panel silently
  collapses to minimum on fresh spawn (a layout↔state feedback loop). Its
  baseline has been oscillating dimensions for ~7 weeks with byte-identical
  source, laundered by every re-pin.

---

## 3. 🔴 FREEZEFRAME — owner-reported, FIXED but NOT MERGED

Owner report: *"freezeframe seems broken. with the gate patched, the image
should be frozen and it should update once on a trigger, or continuously on a
held gate."*

**Branch `fix/freezeframe-gate-trigger`, pushed, 1 commit `9be2146e`.
NO PR OPEN. This is the highest-value unmerged work.**

### It was reproduced first, off real rendered frames (FREEZEFRAME's own `video_out` FBO)

| state | frames changed | verdict |
|---|---|---|
| nothing patched | 239/239 | live passthrough OK |
| held gate | 23/23 | continuous OK |
| **trigger train** | **0/23** | **PERMANENTLY FROZEN** |

### Root cause
`shouldCapture` was a pure LEVEL test read at DRAW time. But the cross-domain
gate bridge (`PatchEngine.installGateDispatch`) does not stream the waveform —
it counts rising edges on the audio thread and REPLAYS them on the ~25 ms
scheduler tick as `setParam(0); setParam(1)` per edge, then `setParam(level)`.
Logged byte-for-byte off the live chain (SEQUENCER.clock → FREEZEFRAME.gate_in),
one trigger arrives as three writes in the SAME millisecond:

```
3221:0   3221:1   3221:0
```

so `params.gateLevel` is 0 at every draw and the trigger is **invisible**. When
a tick's tail sample happened to land inside the 5–10 ms pulse, the level stuck
high for a whole tick and 1–2 frames were captured instead — the classic
nondeterministic zero-one-or-two (measured: 7–14 updates for ~18 pulses).

### The semantics rule the fix establishes
- Every **RISING EDGE** arms a ONE-SHOT LATCH, detected in `setParam` (off the
  draw clock, so a sub-frame pulse cannot be missed) and consumed by the next
  draw. **Boolean, not a counter** — N edges inside one frame interval still
  update exactly ONE frame.
- The **LEVEL** counts as a HELD gate only once it has stood `HOLD_QUALIFY_MS`
  (2 scheduler ticks) since the edge that raised it. Below that it is
  indistinguishable from a trigger's one-tick staircase echo — both arrive as
  `0, 1, 1`, and the first discriminating byte is the NEXT bridge write. One
  tick is the information-theoretic floor, not a shortcut.

In one line: **HELD = "still high one bridge write after the edge that raised
it"; TRIGGER = "an edge happened and it was low again by then."**

### ⚠ Blockers to check before merging — ALL still open
1. **WebGL re-attest required.** Owner has given standing authorization
   ("gpu is yours for any attests"). Run
   `env WEBGL_ATTEST_ALLOW_BUSY=1 flox activate -- task webgl:attest` on the
   trusted machine. First kill anything on 5173/4173 and clear
   `node_modules/.vite` — a stale dev server causes a FALSE refusal.
2. **`HOLD_QUALIFY_MS` collides with `DEFAULT_GATE_LEN_S`.**
   `gate-trigger.ts:40` pins `DEFAULT_GATE_LEN_S = 0.05` (50 ms) and the
   qualify window is 2 scheduler ticks ≈ 50 ms. A *derived* gate of exactly the
   default length sits right on the boundary — resolve deliberately, do not
   leave it at the tie.
3. **`freezeframe.spec.ts` runs in NO CI lane.** It is listed in
   `e2e/webgl-heavy-globs.ts:86`, so the fix is currently unguarded on CI.
   Either give it a lane or accept it knowingly.
4. **Sibling bug at `frametable.ts:760`** — same level-read-at-draw-time
   pattern, not yet fixed.

---

## 4. Other pushed-but-unmerged work

- **`feat/tidyvco-sine-tri-square`** — SHAPE morph now sine→triangle→square.
  Spectrally verified. **Needs owner ears (audio-affecting).** Known: the alias
  gate is blind to the dominant images; PW/PWM inert across the lower half of
  SHAPE.

---

## 5. Standing constraints (do not re-learn these)

- Owner runs a dev server on **port 5173** — never touch it. Boot your own on a
  dedicated port; kill only your own PIDs.
- **NEVER `git stash`** — it is repo-wide, not per-worktree.
- **Never `gh pr update-branch`** on shared registry files — merge
  `origin/main` locally and diff.
- **Never `gh run view --log-failed`** — wedges the shell.
- Every command through **`flox activate -- <cmd>`**.
- **Worktree cap 10.** Run `task worktree:guard` before creating one.
- **`--repeat-each=N` is ONE browser process, not N trials.** For a real
  flake-check, run N separate processes.
- Look- and audio-affecting changes are **owner-preview-before-merge**.
