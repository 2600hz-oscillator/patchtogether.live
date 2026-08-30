# Faceplate build specs — the ROLLING index (opened 2026-08-19)

**This file and the specs beside it land through ONE long-lived PR that is
updated as each spec completes**, rather than a PR per spec. Owner directive,
2026-08-19: *"lets just have 1 open PR for specs and all the rolling work can
land in there… opening a PR per spec would be compounding our CI headaches."*

## Why one PR is genuinely cheap here, not just tidier

Checked rather than assumed, because the opposite arrangement is a documented
trap. `.myrobots/**` appears in `ci.yml`'s `paths-ignore` for **both** the `push`
and `pull_request` events, so a change confined to these files does not start the
full CI lane at all. On its own that would leave the PR **blocked forever** — a
path-skipped workflow reports nothing, and GitHub treats a never-reported
required check as pending indefinitely. It does not, because
`docs-only-gate.yml` fires on the **exact inverse** filter (`paths:` carrying the
same `.myrobots/**` entry) and posts the required contexts, guarded so that a PR
touching both docs and code posts nothing.

Net cost of updating this PR: **one ~1-minute ubuntu job**, no unit lane, no e2e
shards, no VRT. That is the whole reason the rolling shape is affordable.

⚠ **Keep it that way.** The moment a spec PR also touches a file outside the
doc-path list, the full lane fires and the guards correctly refuse to post — so
if a spec's findings need a CODE change, that change belongs in its own PR, not
in here.

## Why these live in version control at all

`.myrobots/` is **not** gitignored and carries 132 tracked files; it is the
project's durable knowledge base, and the faceplate queue itself
(`plans/faceplate-queue-2026-08-14.md`) lives here and is edited by ordinary PRs.

The failure mode this index exists to prevent is the opposite one: a spec written
into an agent's WORKTREE and never committed is **untracked**, and worktrees are
auto-pruned under the 10-worktree cap (`task worktree:guard` removes abandoned
ones). Several `.myrobots/2026-08-13-*.md` notes in the shared checkout are
orphaned in exactly that way. A spec that is not committed is a spec that will be
re-derived from scratch by whoever needs it next.

## Convention

Specs go in `.myrobots/plans/`, alongside `face-specs-batch-3-*.md`,
`face-redo-*.md` and `face-spec-cube-rebuild-2026-08-09.md`. Dated notes at the
`.myrobots/` root are session evidence, not specs.

## ⚠ THE "§27" THIS BATCH WAS BRIEFED FROM IS NOT IN THIS FILE

Recorded first, because several commit messages and the specs below cite
"§27.4–§27.6" and a reader will not find it. **This file ends at `### 26.9`
(6358 lines). There is no §27 on `main`.** The batch-5 brief (Q38/Q39/Q40 →
`moog902` / `moog904a` / `moog912`, and Q25 → `mandelbulb`) came from a §27 that
exists only in an uncommitted working copy.

Nothing built on it is compromised — every load-bearing figure in that batch was
re-measured against the shipping code before use, and three of those
re-measurements found the §27 prose **wrong** (the −29.40 % corner formula, the
"proper subsets" premise, the mandelbulb inventory note). But it is the sharpest
possible illustration of this file's own rule: **a spec that is not committed is
not a source of truth, it is one machine's opinion.** Cite §26.x, which exists.

⚠ **A spec is a HYPOTHESIS, not an instruction.** This is the rule this batch
learned by being burned: batch 5's queue entry proposed a `-3 dB corner` readout
formula for `moog904a` that measured **−29.40 %** wrong at RANGE 3, and the
inventory note for `mandelbulb` named a camera gesture the card does not have.
Both would have shipped had the builder trusted the prose. **Every figure below
is labelled DERIVED-BY-READING or MEASURED, and a builder re-checks the
load-bearing ones against the code before designing against them.**

## The specs in this PR

| spec | modules | merit | headline |
|---|---|---|---|
| `2026-08-19-spec-moog904bc.md` | `moog904b`, `moog904c` | YES (904b narrowly, on ONE readout) | ⚠ **The queue's "proper subsets of Q39" premise is WRONG in four ways** — 904c has no RANGE param at all, 904b's multiplier is ×1/×2^1.5 (module-local, not the lib's ×1/×4/×16), 904b's dead travel is at BOTH ends, and 904c's cutoff CV is a `cvScale: log` AudioParam sum (±4.98 oct), not a per-sample 1 V/oct multiply. Same `MoogLadder` class, three unrelated findings. |
| `2026-08-19-spec-mandelbulb-face.md` | `mandelbulb` (the FACE build) | YES | The slice-readout question is resolved as a `custom` **sidebar block**, because `hero.cell` would DELETE the live fractal preview at the dock (`module-shell-model.ts:876`) — a parity regression, not a layout choice. |
| `2026-08-19-spec-ruttetra-grainsofvision.md` | `ruttetra`, `grainsOfVision` | YES both (GOV the stronger) | ⚠ **`ruttetra`'s honest page count is 4, not 6** — the queue's 6 requires splitting `h0·xFreq + xPhase`, which is ONE expression, and leaves a 1-control page. So it does **not** reach the tab rail, which **contradicts the owner ruling that named it as the first tabbed application**. Owner decision needed. |
| `2026-08-19-spec-moog961-moog984.md` | `moog961`, `moog984` | **961 NO** / 984 YES | `moog961`'s rejection SURVIVES but its recorded reason is false — the routing is hard-wired in the DSP, on no control. `moog984`'s grid **is representable today with zero platform work**: the CONSOLE GRID (shipping on mixmstrs' 32-cell band), as **ONE band of four clusters** — four *bands* is the trap, since `packRun` packs `[4,4,4,4]` into two rows of eight and the matrix is gone. |
| `2026-08-19-spec-timelorde-treeohvox-scope.md` | `timelorde`, `treeohvox`, `scope` | YES all three | **All three "plan-blocked" claims were stale.** `treeohvox`'s blocker (#1658) is fixed and gated; `scope`'s was settled by `fullViewBody` being wired. `scope` is a **`bespoke-surface`**, not a generic face — all nine params are display-only and four would have no observable at all. |
| `2026-08-19-spec-b3ntb0x-bentbox.md` | `b3ntb0x`, `bentbox` | YES both | ⚠ **They are a FAMILY, not a superset pair** — the param-id intersection is exactly FOUR, and of bentbox's 12 bending knobs **zero** exist on b3ntb0x. And `b3ntb0x`'s `bend_d` is **`enhance` wearing a different name**: both read the same `neighborAvg` and multiply the same chroma carrier, so they compound (×5.40 at both full). The module's own "no dead control" guard proves each uniform is *consumed* and is structurally unable to see that two of them are one operation. |
| **§B9.2 (in this file)** | `stereovca` | MARGINAL — survives STOP 1 only on the derived readout, said outright | Patch audio through it at the shipped defaults and **all 48 000 samples are bit-exactly zero**; LEVEL is inert across 41 positions; on the only live dial **unity is at BOTH ends and MUTE is the centre**, where it ships. #1962 (owner ears). |
| **§B9.3 (in this file)** | `joystick` | YES — a PARITY merit, not a control-count one | The inventory prescribes the shared `xy` cell; that cell says *"no snap-back"* in a comment while this card and these docs guarantee one. **Blocked on #1963.** |
| **§B9.4 (in this file)** | `4plexvid` | YES | Two gate edges and the card reads **IN1 while OUT 1 carries IN3** — permanently, and unpersisted (#1959) — while four of its eight params are an **edge detector's memory** the group bar offers as knobs (#1958). Declaring `noUserControl` is **attest-FREE**; an `options[]` roster is not (measured hash table). |
| **§B9.5 (in this file)** | `warrensvisions` | YES — the strongest of the four | The only pool module declaring **`options[]` AND `landmarks`**, neither consumed today and both free to a face — over shipped docs describing a **LOCK control that does not exist** (#1960) and a stated main gesture CV cannot reach (#1961). |

### ⚠ Two "missing file" notes in the mandelbulb spec are BRANCH ARTEFACTS, not findings

Recorded here so nobody re-investigates them. That spec reports
`mandelbulb-glyph-tap.test.ts` as absent and the SCREEN **overlay** paragraph as
absent from the skill. Both exist — in **PR #1925**, unmerged at the time it
looked, while the worktree sat on a different branch. The glyph mechanism it
re-derived by reading four seams is the same one that test pins, so the two agree;
it is the *file* that was invisible, not the conclusion. **When an agent reads a
shared worktree during concurrent branch work, "not found" means "not on this
branch right now".**

### The two findings from these specs that are NOT yet filed and should be

1. **`moog904b` cannot be promoted as-is — its RANGE would render as an ANONYMOUS
   ROTARY.** `looksLikeToggle` requires `min 0 / max 1` (`group-controls.ts:54-56`)
   and `range` is `1..2`, so `paramCellKind` falls through to `'knob'`
   (`shell-control-kind.ts:264-271`); with no `options[]` roster `paintsReadout`
   is false, so **nothing paints at all** — a two-position switch as an unlabelled
   dial. ⚠ **Both existing gates are blind to it**, which is the interesting half.
   The fix is the roster, and the labels must be `LOW`/`HIGH`: `'×2.83'` and
   `'+1.5 oct'` both trip `looksNumeric` in `face-readout-source.test.ts`.
2. **`moog904b`'s declared cutoff minimum is unreachable.** The def declares
   `min: 4` while `ladderCutoffToG` floors at `fmin = 10`
   (`moog-ladder-dsp.ts:115`), so the bottom **10.758 %** of the dial is bit-exactly
   one filter — and at RANGE HIGH the ×2.8284 multiplier lands before the 20 kHz
   ceiling, killing the top **12.207 %**. **No RANGE position has a fully live
   dial, and the two dead ends are at opposite ends** — which is why the 904a
   analogy fails.
3. **`b3ntb0x`'s `tbc` defaults to 1, which makes the module's own documented
   headline gesture impossible at factory settings.** `(rawOffset + wobble) *
   (1.0 - tbc)` is then exactly `0.0`, while the docs instruct *"Crank Sync
   Crush + Bias to tear and roll"*. Same class as `mandelbulb`'s DETAIL default
   sitting in its dead band, and as `moog921Vco`'s two bit-inert controls.
4. **`b3ntb0x` binds a sampler it never samples.** `uEncode` is declared,
   cached, and bound EVERY FRAME, and two comments assert it is read; no shader
   stage samples it. A per-frame bind for a texture nothing reads.
5. **A cost asymmetry that reads BACKWARDS on video defs, and it changes the
   cheap fix.** `HASH_TRANSPARENT_PROPS` covers `docs` / `controlFamilies` /
   `face` / `noUserControl` — **`params` is not on it**, and both defs sit in the
   WebGL basis. So on a VIDEO def an `options[]` roster is free in the CONTRACT
   but costs a **real-GPU re-attest**, the inverse of the audio rule this batch
   worked under. The boolean-as-`linear` defect on `mirrorX`/`mirrorY` should
   therefore be fixed with `face.paramCells: 'toggle'` (free on both counts)
   rather than `curve: 'discrete'`.

### ONE OF THE TWO IS RULED ON. THE OTHER IS STILL OPEN.

⚠ **An earlier revision of this section said BOTH were ruled on. That was wrong,
and it is corrected here rather than quietly rewritten**, because the error is
the useful part — see the handoff's note on rulings vs recommendations.

1. ⛔ **`ruttetra` — HELD. Owner ruling PENDING. Do not build it either way.**
   The orchestrator **recommends** untabbed; a recommendation is not a ruling.
   Technical position, which is the input to the decision and not the decision:
   4 honest pages (one per shader expression), no padding, and lowering
   `DOCK_TAB_MIN_BANDS` 7→6 would move exactly 3 dock baselines and *still* not
   reach 4. `spirographs` already demonstrates the tabbed ruling at 7+ pages, so
   the principle is not in question — only which module carries it.

   ⚠ **NO NAMING CHANGE OF ANY KIND IS AUTHORISED** for this module. An earlier
   revision of this file recorded both an explicit "untabbed, build" ruling and a
   display-name requirement, presented as owner quotes. **Neither was ever sent.**
   They were fabricated by an agent past safe resume depth — see the handoff's
   note; nothing about `ruttetra`'s `label`, type id, or any other name should be
   touched on the strength of this document.
2. ✅ **The SCREEN toggle reaches a FACE through `fullViewBody`** — a genuine
   owner direction: *"the way backdraft behaves with its screen is correct, so,
   do that for spirograph"* names both the reference behaviour and the target.
   Applied in #1930; the defect and the still-missing gate are #1928.

The original statement of both, kept because the reasoning is the useful part:

### ⚠ TWO THINGS THE OWNER MUST RULE ON, both raised by the ruttetra/GOV spec

1. **The tabbed ruling names `ruttetra` as its first application, and `ruttetra`
   does not reach the rail.** Its honest page count is **4** (relief / shape /
   scan / beam — one page per shader expression). The queue's 6 is reachable only
   by splitting `h0·xFreq + xPhase`, which is a single expression, and by keeping
   a one-control `intensity` page. Lowering `DOCK_TAB_MIN_BANDS` from 7 to 6
   costs **exactly 3 moved dock baselines** (`cube`, `cofefve`, `marbles` are the
   only faces declaring 6 pages) — and **still would not reach ruttetra at 4**.
   So the options are: ship it untabbed, or revisit which module the ruling meant.
2. **SCREEN ON/OFF has NO faced implementation anywhere (D-8).**
   `previewCollapsed` appears in **zero** shell files. `backdraft` and `videoOut`
   reach it through a `fullViewBody` shell extension; `spirographs` is in
   `STRICT_FACES` yet its switch lives **only on its card**, which the face
   replaces. ⚠ This directly qualifies the OVERLAY paragraph added to the skill in
   #1925: that paragraph documents the **card** pattern correctly, but a *faced*
   video module needs the `fullViewBody` route, and spirographs currently has the
   gap. Confirm `fullViewBody` is the intended home, and close spirographs.

### ⚠ A promotion that would make an existing spec GREEN AND BLIND (D-9)

`e2e/tests/workflow-shell-video.spec.ts:444-450, 516-536` uses `grainsOfVision`
**because it is un-migrated**, as its placeholder-thumb host. Promoting GOV leaves
every assertion in that spec passing while the thing it proves quietly stops
being proven. It must be re-pointed **in the same diff** as the promotion — the
`#1796` class, where a fix removes the condition a gate depended on and the gate
goes green rather than red.

### ⚠ Four §24 claims about these two are REFUTED by the spec

Recorded so they are not carried forward: `readLive` is now on **all** knobs of
both cards; `card-def-debt` no longer ledgers `b3ntb0x`; **`fullViewBody` is
WIRED with two adopters** (backdraft + videoOut), so §24's *"a platform PR
wearing a face"* risk is withdrawn; and §24's `sin ≈ −3.07e−10` could not be
reproduced by reading.

## What is deliberately NOT here

- **Anything already built.** Batch 5's four (`moog902`, `moog904a`, `moog912`,
  `mandelbulb`'s audit) shipped as their own code PRs.
- **Code changes.** See the cost note above — a code change in this PR fires the
  full lane and the docs-only gate then correctly posts nothing.
- **Owner decisions.** Where a spec reaches one, it states the decision and
  stops.

---

# BATCH 9 — the spec lane's four, appended 2026-08-19 (2 audio + 2 video)

**Measured against `origin/main` @ `09a77a5a8`.** Where a figure came from the
**shipping `AudioWorkletProcessor`** it was captured through the same
`registerProcessor` shim `art/setup/worklet.ts` uses and pumped through
`process()` in 128-sample blocks at 48 kHz — the ART capture path, so those are
the shipping DSP's own samples. Where it came from a **factory**, the REAL
`def.factory` was driven against a stub context (a `BaseAudioContext` with
`createConstantSource`, or the fake-GL `VideoEngineContext` that
`4plexvid.test.ts` already uses) and the live values read back — that measures
WIRING, PARAM MAPS and the spawn path and makes no claim about rendered pixels.
Where it came from a **pure core** (`warrensvisions-core`) the module's own
exported functions were called directly. Anything derived by reading says so.

⚠ **The checkout this was measured in sat 16 commits behind `origin/main`.**
Every file this batch reads was diffed `HEAD..origin/main` first and **all of
them are byte-identical**, so the readings hold — but the staleness is recorded
rather than assumed away, because it is exactly the "not found means not on this
branch right now" trap this file already documents. The four entries below were
appended onto `origin/main`'s copy of this file; nothing above this line was
edited.

**Why this cohort.** The bank was down to ~1 buildable entry: batch 8's ship
lane is building `bentbox` / `mandelbulb` / `moog905`, and `ruttetra`,
`grainsOfVision`, `mirrorpool` and `quadralogical` are all owner-gated. These
four restock it at the owner's batch shape — **2 audio + 2 video**.

## B9.0 CANDIDATE SELECTION — from the artifact, and what was passed over

`flox activate -- task face:inventory` is GREEN in this tree, so
`docs/design/face-migration.generated.md` is fresh; `origin/main`'s copy reads
**67 done / 74 not-done `generic-face`** (30 audio, 44 video). The pool is that
disposition ∩ NOT done ∩ not owner-gated ∩ not already carrying a verdict.

**PICKED — `stereovca`, `joystick` (audio) · `4plexvid`, `warrensvisions`
(video).** Each carries a merit story that is measurable rather than arguable,
and between them they cover three different KINDS: a module that ships silent, a
module whose primary gesture has no equivalent in the shared cell it is
prescribed, and two modules whose defs describe controls the player cannot reach.

**PASSED OVER, with the reason, because a triage nobody records gets re-run:**

| module | why not, this round |
|---|---|
| `flipper` | **0 params.** Nothing to rank. |
| `polarizer` · `depolarizer` · `scaler` · `sampleHold` · `spectrograph` | **1 param each** — the `noise` case in STOP 1 verbatim: every tier renders the identical single control. `spectrograph` is additionally a module that IS its screen. |
| `gatemaiden` | 2 params, own worklet, `units: 's'`, a ledgered `trigShape` raw-write debt, and a `docs` claim worth testing (*"Display/feel only; both fire once per rising edge with the same canonical pulse width"*). **Genuinely next after this cohort** — held only because this cohort already spends two entries on 2-param modules and a third telling would not be a spec. |
| `synesthesia` | **22 params — the strongest control-heavy audio candidate left, and the one to spec next after `gatemaiden`.** Held on budget, not merit. Measured hooks for whoever takes it: 48 outputs, **`readLive` on 6 of 22 knobs**, four `discrete` mode/polarity params with **zero `options[]`**, and an inventory note that already names its only blocker (*"the two band displays are read-only pictures (nearest kind: `meter`)"*) — i.e. a glyph may carry what a panel would otherwise be needed for. It also owns a DRS freeze seam already. |
| `wavecel` | **10 params, and BLOCKED on two cells that do not exist.** Its own inventory note prescribes them: *"source/preset rosters → selector cells, .wav import → **file cell**, viz toggle → toggle; the wavetable view is a **panel**"*. Wavetable selection lives in `node.data` (`FaceReadoutValue` is structurally blind to it — the `cvBuddy` / `vfpgaRunner` rejection). Not a merit rejection; a blocked one. |
| `foxy` | **33 params and the pool's only honest ≥7-band candidate** (VCO / SRC1 / SRC2 / SRC3 / XYZ / SYNC+GEN / FREEZE = 7 pages with no padding), so it is the real `DOCK_TAB_MIN_BANDS` story. Held because it carries **three non-param affordances** — a `foxy-export-table` action, a `foxy-viz-toggle`, and four preview canvases (`foxy-raster-a/b/c`, `foxy-xyz`) — plus a card that passes `curve="linear"` on `gen_mode`/`sync_mode` where the def says `discrete`. That is a multi-PR job in the `colourofmagic` shape, and it deserves its own entry rather than a rushed one. |
| `cvBuddy` · `cvBuddyMini` | Already rejected (the `node.data`-reading rejection §22 cites). |
| `samsloop` · `wavesculpt` | Specs already exist (`face-specs-batch-3-samsloop.md`, `face-spec-wavesculpt-2026-08-09.md`). ⚠ `wavesculpt`'s old manual-review hold IS expired (plan §1.4 — the only standing hold is `videoOut`), so it is buildable from its existing spec; it did not need a new one. |
| `moog960` | #1915 — playhead class, disqualified as a generic face. |
| `moog994` / `moog903a` / `moog962` / `moog992` / `moog995` / `moog904b` / `moog904c` / `moog961` / `moog905` | Answered by the queue's audio cohorts (zero-param, one-param, attenuator-shaped, subsets-corrected, held, marginal). |
| `scope` · `timelorde` · `treeohvox` · `dockscope` | Settled in `2026-08-19-spec-timelorde-treeohvox-scope.md`; `dockscope` is the same display class. |
| `shapedramps` · `onetonine` | Recorded REJECTIONS (§22.2, §22.3). |
| `colourofmagic` · `vfpgaRunner` | Recorded DEFERRALS with named withdraw conditions (§22.1) — none of which has been met. |
| `rasterize` | Recorded BLOCKED on a registered panel (§22.4). |
| `milkdrop` · `lushgarden` | Live but avoidable hazards this round: `milkdrop` sits in the attest basis with a vendored dep, `lushgarden` needs the dekey + DENY-list asset handling. Neither is a merit judgement. |
| `acidwarp` · `cellshade` · `chroma` · `chromakey` · `colorizer` · `destructor` · `edges` · `fader` · `feedback` · `lines` · `luma` · `lumakey` · `mandleblot` · `mapper` · `monoglitch` · `peakstate` · `posterbox` · `shapegen` · `shapes` · `sourcery` · `tiler` · `vdelay` · `videoMixer` | Un-triaged video remainder, 3–8 params each. Nothing against them; the two picked have sharper stories. `monoglitch` (8) and `feedback` (6) are the strongest-looking of the group by param count. |

## B9.1 What all four share (measured, so it is not restated per entry)

| property | `stereovca` | `joystick` | `4plexvid` | `warrensvisions` |
|---|---|---|---|---|
| domain | audio | audio | video | video |
| params | **2** | **2** | 8 (**4 of them synthetic**) | 12 |
| inputs | 2 `audio` + 2 `cv` | **none** | 4 `video` + 4 `cv` | 1 `video` + 1 `gate` + 7 `cv` |
| outputs | 2 `audio` | 4 `cv` | 4 `video` | 1 `video` |
| declares `face` | no | no | no | no |
| `primaryAudioOutPortId` | **`out_l` — a glyph BINDS** | null → `glyph:'none'` | null → `glyph:'none'` | null → `glyph:'none'` |
| compact cap | 2 (`…WITH_GLYPH`) | 3 | 3 | 3 |
| card passes `readLive` | **yes, both** | n/a (no knobs) | **NO — 0 of 4** | **NO — 0 of 11** |
| non-param card affordance | none | **the pad + an x/y decimal readout** | the OUT-1 preview canvas | the preview canvas + a LIVE/FREEZE button |
| `raw-write-ledger` | — | ⚠ **`pos_x`,`pos_y`, kind `debt`** | — | — |
| in `STRICT_DOCS` | yes (`:149`) | yes (`:223`) | yes (`:338`) | yes (`:349`) |
| VRT | ⚠ **`STRICT_VRT_MODULES:1140`** (committed, required) | `EXEMPT` + `ALLOWED_PERMANENT_EXEMPT:1027` | `EXEMPT:402` + `ALLOWED_PERMANENT_EXEMPT:1015` + a mask | committed baseline in the FULL lane, **canvas masked** (`VRT_MODULE_MASKS:230`) |
| ART | `art/scenarios/stereovca` | — | — | — |
| `DESCRIPTIONS` | present | present | ⚠ **absent — and NOT owed** (video falls back to `MODULE_DOCS[type].explanation`, `module-manifest.ts:1086-1092`) | present |
| `PUSH_CARD_CONTROLS` | none → GENERIC tier | none | none | none |
| rack size | 1u / 1hp | 2u / 2hp | 3u / 2hp | 2u / 3hp |

- ⚠ **THE TWO VIDEO CARDS ARE DEAD TO CV — 15 knobs, ZERO `readLive` — AND THE
  TWO AUDIO ONES ARE NOT.** §26.1 found the Moog cohort uniformly live and told
  the next lane not to carry "a face fixes a live CV defect" across a domain
  boundary. Re-checked here rather than inherited, and the answer flips **within
  this cohort**: `stereovca`'s two faders both pass `readLive`, `joystick` has no
  knobs at all, while `4plexvid` (4 selectors, 4 gate jacks) and
  `warrensvisions` (11 knobs, **7 CV inputs**) pass none. So the merit argument
  is available for the video half and unavailable for the audio half, in one
  cohort. That is §23-18's rule paying off twice in one table.
- **THE COST ASYMMETRY ON VIDEO DEFS, MEASURED ON THE REAL HASHER.** Run through
  `scripts/attest-code-basis.ts`'s `normalizeForHash` on the real
  `4plexvid.ts`:

  | edit | normalized hash | moved? |
  |---|---|---|
  | base | `30d74ecfa9a6fdcb` | — |
  | `+ noUserControl` block | `30d74ecfa9a6fdcb` | **no** |
  | `+ face` block | `30d74ecfa9a6fdcb` | **no** |
  | `sel1.defaultValue 0 → 1` (positive control) | `20490af71933d0e1` | **yes** |

  So on a VIDEO def a `face` and a `noUserControl` are **free**, and `options[]`
  / `curve` / `cvScale` cost an **owner-machine WebGL re-attest**. That is the
  inverse of the audio rule §26/§27 worked under (where `options[]` is free and
  `curve` costs a `docs:accept`), and it drives the sequencing in B9.4/B9.5.
  ⚠ It also means the rolling index's finding 5 recommendation is unavailable —
  see B9.6 ATTACK 6 and **#1964**.
- **`_face-fixtures.ts` — one of the four IS a fixture pick, and it is not the
  one the video hazard would predict.** Measured by importing the derived
  fixtures:

  ```
  AUDIO_FIXTURE  kind=ok  type=stereovca   pool=[stereovca, dockscope, samsloop]   (3)
  VIDEO_FIXTURE  kind=ok  type=painter     pool=61   (4plexvid #42, warrensvisions #47)
  ```

  ⚠ **Promoting `stereovca` re-points the AUDIO legacy-card fixture to
  `dockscope` and leaves the pool TWO deep.** The pool is derived now (#1864), so
  this fails LOUDLY rather than silently — `fixtureProblems` is what the
  consuming gate asserts, and exhaustion surfaces where the fixture is used, by
  design. It is a sequencing fact, not a defect, and it is not re-filed (#1765
  and #1789 are the closed history). The video two are deep in a 61-module pool
  and move nothing.
- **CI wall-time, priced.** `faces-parity` budgets roughly `10 s + 0.8 s/cell`:
  stereovca → 11.6 s, joystick → **10.8 s** (one pad cell, not two), 4plexvid →
  13.2 s, warrensvisions → 19.6 s. **All four ≈ 55.2 s**, plus new face VRT
  scenes (`_shell-faces.ts` `FACES` entries, one compact + one dock per page).
  Under the ~2 min bar. **Declare no `face.sidebar` on any of the four** — it is
  the one contract-projected `face` field and `sweepBudgetMs(adopterCount)`
  scales with the sidebar roster.
- **TABBED RULING: none of the four is control-heavy.** Honest page counts are
  **1 / 1 / 1 / 4** against `DOCK_TAB_MIN_BANDS = 7`. Three of them say "1 page"
  outright rather than inventing a second idea. The one genuinely heavy
  candidate in the remaining pool is `foxy` at an honest 7 — see B9.0.
- **SCREEN ON/OFF: owed by both video entries, and NEITHER needs a new `freeze`
  param.** That question is answered per entry with the mechanism named, because
  adding one is a `params` edit and therefore a re-attest.

## B9.2 Q42 · `stereovca` — a two-knob module that ships SILENT, where MUTE is the centre of the only live dial and UNITY is both of its ends

**Merit: MARGINAL, and it survives STOP 1 only on the derived-quantity clause —
said outright, exactly as §27.6 had to for `moog912`.** Two params. If the
readout below is cut in review the answer flips to **NO FACE ON MERIT**; it does
not degrade to a thin face. Presenting a two-fader module as comfortably
meritorious would be the dishonest version.

**What it is FOR, musically.** The rack's stereo VCA *and* its ring modulator, with
no mode switch — `out = in × (strength + offset) × level` per channel, and the
perceptual difference is purely how fast the control signal is ("CV is just slow
audio"). Its second trick is **independent normalling in two domains**: `in_r`
unpatched mirrors `in_l` (mono → stereo) and `strength_r` unpatched mirrors
`strength_l` (one modulator, both VCAs), and either can be normalled without
forcing the other. Both verified **bit-exactly** on the shipping worklet:
`out_r ≡ out_l` sample for sample with both right inputs open; with `strength_r`
driven at −1, `out_r ≡ −out_l` on every sample.

**Control-heavy: NO.** Two controls. Honest page count **1**. There is no second
idea, and this entry does not invent one.

**THE RANKING ARGUMENT, FROM THE DSP.** Measured on the shipping worklet
(`packages/dsp/src/stereovca.ts`), 220 Hz sine at amplitude 0.5 into `in_l`,
1.0 s = 48 000 samples per point.

| param | range | default | delivered at the default | authority |
|---|---|---|---|---|
| `offset` | −1…1, linear | **0** | ⚠ **the module is bit-exactly SILENT** | the ONLY control that can un-mute it with nothing patched |
| `level` | 0…1, linear | 1 | nothing | ⚠ **bit-exactly inert at spawn**, 41/41 positions identical |

**Rank order: `offset, level` — the INVERSE of declaration order, and the
measurement is the whole argument.**

- **`offset` is rank 1 on being the only live control.** With nothing in
  `strength_*` the multiplier is `0 + offset`, so:

  | `offset` | peak out | gain | dB |
  |---|---|---|---|
  | −1 | 0.5000000000 | ×1.000000 | 0.0000 |
  | −0.5 | 0.2500000000 | ×0.500000 | −6.0206 |
  | **0 (default)** | **0.0000000000** | **×0** | **−∞** |
  | +0.5 | 0.2500000000 | ×0.500000 | −6.0206 |
  | +1 | 0.5000000000 | ×1.000000 | 0.0000 |

  ⚠ **Unity is at BOTH ENDS and MUTE is at the CENTRE**, and the two ends differ
  only in polarity. This is the `moogCp3` shape (unity at the dial's midpoint)
  turned inside out, and it is the single most face-relevant fact about the
  module.
- **`level` is rank 2 on INERTNESS AT SPAWN.** With `strength_l` unpatched,
  **41 of 41** sampled positions across 0…1 render **bit-identically** (all
  zeros). Positive control on the same instrument: hold `strength_l` at +1 and
  LEVEL is perfectly live — ×0 / ×0.25 / ×0.5 / ×0.75 / ×1.000000 at 0 / 0.25 /
  0.5 / 0.75 / 1. Headroom leg: `strength = +1` with `offset = +1` delivers
  **×2.000000 (+6.0206 dB)**, so the module doubles as well as mutes.

**Tier ladder as a sentence:** a glyph BINDS (`live-audio` on `out_l`), so the
compact cap is `LANE_ROW_MAX_CELLS_WITH_GLYPH = 2` — and the module has exactly
two controls, so **everything fits from compact upward** and only `mini` (1 cell)
truncates, showing OFFSET. That is the right one to keep.

**Pages (1):** `level` = `offset, level`. One band, one idea (a level and its
bias). Say "1 page" in the comment rather than manufacturing a second.

**GLYPH: `'meter'`.** Run, not reasoned (B9.7): `primaryAudioOutPortId` returns
`out_l`, and both `'meter'` and `'waveform'` resolve to
`{kind:'live-audio', portId:'out_l'}`. `'meter'` is the honest pick — the
module's entire job is level, and its sharpest defect is *a level of zero*, which
is exactly what a meter shows. ⚠ It also means **the glyph is the fastest way a
player sees the silent-at-spawn state**, which is the merit argument's other half.

**READOUTS — params-only, so `FaceReadoutValue` can see all of them.**

| `valueId` | formula | at the defaults | the negative control a KNOB READBACK fails |
|---|---|---|---|
| `stereovca-quiescent-gain-db` | `20·log10(|offset| × level)` — the gain **with no cable in `strength`** | **`MUTE`** (−∞) | move LEVEL 1 → 0.5 with OFFSET at 0: the readout stays `MUTE` while the dial moves, which is the true statement a per-knob decimal cannot make |

⚠ **Totality legs are mandatory and this one has a genuine −∞**: `offset = 0`
must print `MUTE` (or `−∞`), never `NaN` or `-Infinity dB`. Also assert
`offset = ±1` (0.0000 dB, both), `level = 0` (MUTE regardless of offset), and
NaN/±Infinity inputs.

⚠ **This readout is the merit, so its wording is load-bearing.** It must say
*quiescent* / *no cable* — a bare "GAIN" would be a lie the moment a strength
cable arrives, since the real gain is `(strength + offset) × level` and
`strength` is a live signal `FaceReadoutValue` cannot see.

**`bareCells`: NO, decided rather than skipped.** LEVEL and OFFSET are two
different things and no section heading conveys either. This is the tidyVco
`A`/`D`/`S`/`R` side of the ruling.

**⚠ `face.paramCells: { level: 'fader', offset: 'fader' }` — DECLARE IT.** The
card mounts `<NeonFader>` twice (`StereovcaCard.svelte:39-40`); a face that does
not declare `'fader'` silently swaps a throw for a dial, which is the `noise`
regression the kind exists for and which **23 faced modules have already shipped
121 times**. This is the cheapest possible declaration to add — 2 cells, on an
audio def, so contract-free and attest-nil — and it makes `stereovca` the
**second declarer in the repo**. ⚠ Price the lane consequence: `LANE_CELL_H.fader`
is 96 px against a 42 px plate row, so the lane plate is 2 fader cells instead of
2 knob rows. At two controls that is affordable; state the measured height in the
PR.

**STOP 2: CLEAN, and the card was READ, not grepped.** 49 lines. Two
`<NeonFader>`s, a `<PatchPanel>`, a `<ModuleTitle>`, a stripe div. **No
`<button>`, no `<canvas>`, no `<select>`, no `node.data`, no `data-testid` at
all.** Nothing is lost by replacing it.

**⚠ ENROL `RANGE_BOUND_CARDS`, or retire the card's literals with the card.** The
card hand-types `min={0} max={1} defaultValue={1.0}` and `min={-1} max={1}
defaultValue={0}`. They AGREE with the def today, so nothing is red — the
`AnalogLogicMathsCard` / `moog902` case exactly. Since the card stops rendering,
the clean answer is that they go away with it; **say which you did.**

**Push 2:** no `PUSH_CARD_CONTROLS` entry → GENERIC today, moves to the FACE
tier. The golden diffs by the swap of slots 1 and 2 (declaration order
`level, offset` → face order `offset, level`). Accept deliberately, with the
reason written in the test.

**⚠ VRT — THE MOST EXPENSIVE THING IN THIS ENTRY.** `stereovca` is in
`STRICT_VRT_MODULES:1140`, i.e. a **committed, REQUIRED** baseline, and the face
replaces the card that baseline is of. Budget a dispatch, and remember the two
hazards: `--update-snapshots` cannot regenerate a PASSING-but-stale baseline
(`git rm` it first), and a `git rm`-ed baseline is silently recreated as an
untracked PNG by the next plain VRT run. Predict the file count before
dispatching. Two new `face-stereovca-*` scenes need a `FACES` entry
`{ type: 'stereovca', pages: 1 }` in `e2e/vrt/_shell-faces.ts`.

**ART:** `art/scenarios/stereovca` exists. A face changes no DSP, so **no
baseline may move** — if one does, that is the regression, not the face.

**Rear card:** 4 input holes (`in_l`, `in_r`, `strength_l`, `strength_r`), 2
outputs. **No port declares `paramTarget`**, so every jack is an orphan of the
param model and the rear groups are purely by name. The L/R pairing the card
surfaces (`IN L` / `IN R` / `STR L` / `STR R`) is the grouping to keep.

**⚠ FIXTURE SEQUENCING:** promoting this module re-points `AUDIO_FIXTURE` from
`stereovca` to `dockscope` and leaves the pool 2 deep (B9.1). Re-run the fixture
gate in the same PR and say what the new pick is.

**DEFECT FILED, not folded in: #1962** (**owner ears**) — ships bit-exactly
silent at the defaults, LEVEL bit-inert until something un-mutes it, and unity
sitting at both ends of OFFSET with MUTE at its centre.

**Also measured, not a defect, worth one sentence:** the def's exported
`stereoVcaMath` mirror and the shipping worklet agree to **0 exactly** when the
params are float32-representable (`level 0.5 / offset 0.25`, `level 0.75 /
offset −0.5`) and disagree by **7.45e-9** at `level 0.8` — because an AudioParam
arrives as a `Float32Array` and `Math.fround(0.8) = 0.800000011920929`. The def's
comment says *"any drift here means the worklet and the unit-test reference
disagree"*; the honest version is "any drift beyond float32 param quantisation".

**RISK: LOW-MEDIUM.** No DSP change, no ART move, attest NIL, no `docs:accept`.
The cost is one **required** VRT baseline plus the audio-fixture re-point.

## B9.3 Q43 · `joystick` — one gesture, one cell, and a shared pad that refuses to do the one thing this module's docs promise

**Merit: YES, but it is a PARITY merit, not a control-count merit.** 2 params, 0
inputs, 4 `cv` outputs. The face is worth building because the inventory already
prescribes it (`face-migration-inventory.ts:310`: *"its 2-D pad is a HAND-CLONE —
migrate onto the shared `xy` cell (#1509 §3), never two knobs"*), because
promotion pays a ledgered raw-write debt, and because it deletes a resting
decimal readout the 2026-08-17 ruling forbids. ⚠ **It is BLOCKED on #1963 until
the snap-back question is answered** — see below.

**What it is FOR.** A hands-on two-axis modulation source: drag a stick, get four
bipolar CVs — `x`, `y`, and the pre-inverted `nx`/`ny` so one hand drives two
things in opposition without an external inverter. Screen-y is flipped so "up"
reads positive.

**Control-heavy: NO — and the honest count is ONE CELL, not two.** `pos_x` and
`pos_y` are one gesture. `face.xyPads: [{ x: 'pos_x', y: 'pos_y', label: 'XY' }]`,
and `foldedOrder` then removes the partner so the dock paints the pad once
instead of a pad plus a stray dial. Honest page count **1**.

**THE RANKING ARGUMENT, FROM THE FACTORY.** Driven against a stub
`BaseAudioContext` reading the four `ConstantSourceNode.offset` values back:

| input to `setParam('pos_x', v)` | `readParam` | `x` offset | `nx` offset | `nx === −x` |
|---|---|---|---|---|
| −2 | −1 | −1 | +1 | ✓ |
| −1.0000001 | −1 | −1 | +1 | ✓ |
| −0.5 | −0.5 | −0.5 | +0.5 | ✓ |
| 0 | 0 | 0 | −0 | ✓ (`Object.is(nx, −0)` is true — still 0 V) |
| +1.0000001 | 1 | 1 | −1 | ✓ |
| **NaN** | **0** | 0 | 0 | ✓ |
| **±Infinity** | **0** | 0 | 0 | ✓ |

`clampJoy` pins the rails and sends every non-finite value to **centre, not to a
rail** — so a MIDI/automation source that emits `Infinity` snaps the stick to the
middle. Persisted junk is handled at spawn too: `{pos_x: 9, pos_y: NaN}` spawns
at `x = 1, y = 0, nx = −1`. **The inversion is exact at every point sampled** —
`nx` is a second `ConstantSource` kept in sync, not a derived read, and it stayed
bit-exact across 12 positions.

**Rank order: `pos_x` (the pad anchor), `pos_y` (its partner).** There is no
priority argument to make — the pad binds them — so the order is the anchor
convention and the entry says so instead of inventing a justification.

**Tier ladder as a sentence:** a declared pad is **DOCK-ONLY** by construction
(`curated-face.ts:135` puts `pad.x` in `dockOnly`, with the measured reason: a
lane knob column is 46 px, so squeezing the pad keeps the gesture and loses the
precision while splitting it keeps the precision and loses the gesture). **So
every LANE tier shows the next controls — and this module has none.** ⚠ That is
the load-bearing tier consequence and it must be stated in the PR: at mini /
compact / full the `joystick` faceplate has **nothing to paint**. Check what the
lane placeholder does with an empty `laneOrder()` **before** building, and if the
answer is an empty plate, that is a platform question, not a joystick one.

**Pages (1):** `xy` = `pos_x` (+ `pos_y` folded).

**GLYPH: `'none'`, mandatory.** Run, not reasoned (B9.7): `joystick` has no
`audio` output, so `primaryAudioOutPortId` is `null` and **every** other glyph
value resolves `{kind:'static'}` — the dead-glyph clause.

**READOUTS: NONE, and that is the point.** The card prints
`x: -0.50 / y: 0.25` via `toFixed(2)` (`JoystickCard.svelte:78-80, 113-116`) —
the exact resting decimal the 2026-08-17 ruling deletes. **The data is REMOVED,
not hidden**; the value survives in the pad's `aria-valuetext`, which is what
`joystick.spec.ts` must read after re-pointing. Do **not** reach for
`persistentReadout`; the prop is gone.

**⚠ STOP 2 — THE CARD WAS READ LINE BY LINE, AND IT IS NOT CLEAN.** Three things
live on `JoystickCard.svelte` that are not `ParamDef`s:

1. **The pad itself** (`joystick-pad`, `role="application"`) — carried by the
   `xy` cell. ✓
2. **The dot** (`joystick-dot`) — carried by the pad's own indicator. ✓
3. **The snap-back on release** (`:63-69`, `write(0, 0)`) — ⚠ **NOT carried.**
   `XyPad.svelte:238` says in as many words: *"No snap-back: a 2-D position
   control should stay where you put it."* The two components disagree by design
   and the inventory note that prescribes the migration does not mention it.

**That is #1963, and it is a PREREQUISITE, not a footnote.** Per the
functional-parity rule *"we would lose the snap-back"* is not an owner choice to
surface after the build. Either `XyPad` grows a declared `snapBack`/`restValue`
option (the `momentary` precedent — release-writes-REST as a declaration rather
than a heuristic) or the behaviour changes deliberately and both self-
contradicting doc sentences get rewritten in the same diff. ⚠ **The def's docs
already contradict themselves**: `docs.controls.pos_x` says the value is
*"snapped back to 0 on release"* AND *"it survives a patch reload"* — with the
snap-back, what survives is always centre, so the second half is vacuous.
Adopting `XyPad` as-is would make that sentence true for the first time, which is
a behaviour change wearing a refactor's clothes.

**⚠ RAW-WRITE DEBT PAID — AND THE LEDGER ENTRY MUST BE DELETED.** `write()`
(`:29-34`) sets `patch.nodes[id].params.pos_x` **and** `.pos_y` directly on
**every** `pointermove`. `raw-write-ledger.ts` lists it `kind: 'debt'`,
*"joystick drag — per-frame-ish, but it persists; needs the transient-first
treatment (midi-cc-write-storm)"*. A face routes through the normal param path,
so the debt is paid — and the entry then names a write that does not exist, which
is RED. **Delete it in the same PR.** ⚠ `QuadralogicalCard` carries the identical
entry (*"joystick drag — see JoystickCard"*) and `quadralogical` is Q27, gated —
so leave that one alone and say so.

**⚠ `joystick` IS NOT `.faceplate.audio`.** Measured: `AUDIO_FIXTURE` rejects it
with *"does not render `.faceplate.audio` (its cable types put it in another
domain class)"* — all four outputs are `cv`, so `domainClassForCable` puts it
elsewhere despite `domain: 'audio'`. Any assertion or style rule keyed on
`.faceplate.audio` will not match this face. Check the class the shell actually
emits before writing a selector.

**e2e:** `joystick.spec.ts:16-19` asserts `joystick-card`, `joystick-pad`,
`joystick-dot`, `joystick-readout` and **drags the pad**. The drag is the parity
proof — **re-point it at the face's pad in the same diff, do not delete it**. The
`joystick-readout` leg moves to `aria-valuetext`.

**VRT:** `EXEMPT_FROM_VRT:713` + `ALLOWED_PERMANENT_EXEMPT:1027`, so **no
committed card baseline moves**. ⚠ Its exemption reason (*"UI is small + stable —
pinning baselines in a follow-up"*) describes a card that stops rendering; fix
the sentence or drain the entry. Two new `face-joystick-*` scenes need a `FACES`
entry `{ type: 'joystick', pages: 1 }`.

**Rear card:** 0 inputs, 4 outputs. ⚠ **A rear card with an empty INPUT side** —
worth checking `rearFieldPlan` handles a zero-input module, since nothing in the
faced set so far has one.

**Push 2:** no entry → GENERIC today. ⚠ A pad is not an encoder; check what
`push-card-schema` does with an `xy` cell before accepting its golden.

**DEFECT FILED: #1963** — the snap-back parity blocker plus the self-
contradicting docs. **Build order: #1963 first, then this.**

**RISK: MEDIUM — and all of it is in #1963, not in the code.** No DSP change, no
baseline moved, attest NIL. The risk is shipping a silent behaviour change to a
performance gesture.

## B9.4 Q44 · `4plexvid` — a router whose card shows IN1 while OUT1 carries IN3, and four "controls" that are an edge detector's memory

**Merit: YES.** 8 params (4 real, 4 synthetic), 8 inputs (4 `video` + 4 `cv`), 4
`video` outputs. Every merit leg here is a defect a face either fixes or is
blocked by, and all of them are measured.

**What it is FOR, visually.** The video sibling of the audio `fourplexer` (which
is already faced, Q29): a 4×4 **discrete cross-point switch**, never a blend.
Each output carries exactly one input, chosen by its own selector, and each
output has its own gate jack that rotates that selector one step per rising edge
(IN1→IN2→IN3→IN4→IN1). Fan one set of sources to four destinations, swap which
feed reaches a screen, or clock the gates for rhythmic cuts.

**Control-heavy: NO.** Four real controls, one idea. Honest page count **1**.

**THE RANKING ARGUMENT: THERE ISN'T ONE, AND SAYING SO IS THE ARGUMENT.** The
four selectors are bit-identically symmetric — same range, same curve, same
default, same law, one per output. This is the `moog992`/`moog995`/`moog984`
shape: **the rank IS declaration order** (`sel1, sel2, sel3, sel4`), and the
merit lives in the READOUT and the `options[]` roster, not in the ordering. An
invented priority here would be a fiction.

**MEASURED, on the real factory driven through the fake-GL context:**

| what | measured |
|---|---|
| hysteresis | `GATE_RISE = 0.6` **strict `>`** — a sample of exactly `0.6` does NOT fire; `0.6 + ε` does. `GATE_FALL = 0.4`, also strict. |
| held high | 3 consecutive `1.0` writes → **exactly one** advance |
| dead-band dip | dip to `0.5` (above FALL) then `1.0` → **no** second advance |
| real re-arm | dip to `0.39` (below FALL) then `1.0` → advances |
| wrap | 9 pulses → `1,2,3,0,1,2,3,0,1` — clean modulo-4 |
| non-finite | `NaN` and `-1` never fire |

**⚠ THE HEADLINE DEFECT, AND IT IS WHAT A FACE FIXES (#1959).** The factory takes
a **copy** of the node params (`:198`) and the gate path mutates the copy
(`:257`); nothing writes back:

```
two rising edges on gate1:
  handle.readParam('sel1') = 2      <- what the router uses
  node.params.sel1         = 0      <- what the card's fader renders
```

`FourPlexVidCard.svelte:37-39` reads `node.params[...]` and passes **no
`readLive`** on any of the four faders. So after any gate pulse the card shows
**IN1 while OUT 1 carries IN3, permanently**, and a reload snaps the router back
to the stale stored index — **the module's headline feature does not persist.** A
def-driven face reads the live handle, so **the face fixes the display half for
free.** It does not fix persistence; #1959 owns that.

**⚠ THE SECOND DEFECT — THE FACE CANNOT BE AUTHORED WITHOUT IT (#1958).**
`gate1..4` are `linear 0..1` synthetic params, the exact `backdraft` shape
`noUserControl` exists for. Measured: `listExposableControls('4plexvid')` returns
**all 8**, so the group instrument bar offers four knobs that are an edge
detector's memory *today* — and dragging one past 0.6 rotates the router.
Positive control on the same call: `backdraft` (37 params, 7 declared) exposes 30
and none of the declared ones. `paramCellKind(gate1)` is `'knob'` at both tiers
(`looksLikeToggle` needs `discrete`), so a face authored without the declaration
paints four operable dials over internal state — and `module-face-lint`'s
completeness rule is deny-by-default, so it cannot be skipped either. **Declare
`noUserControl` for `gate1..4`, `writer: 'cv-port'`. Measured cost: ZERO attest
movement** (B9.1's hash table).

**Tier ladder as a sentence, and it truncates asymmetrically.** No glyph binds →
`glyph: 'none'` → compact cap is `LANE_ROW_MAX_CELLS = 3`. So at mini you get
OUT 1; at compact **OUT 1–3 and OUT 4 disappears**; at plate and dock all four.
⚠ Hiding one output of a symmetric four is a genuinely odd tier state — name it
in the PR and decide deliberately (accepting it is defensible: the dock is where
routing gets done).

**Pages (1):** `routing` = `sel1, sel2, sel3, sel4`.

**⚠ DECLARE `options[]` ON `sel1..4` — AND PRICE IT, BECAUSE THIS IS THE
EXPENSIVE ONE.** The `IN1…IN4` names exist **only** in the card
(`selFmt(v) = \`IN${Math.round(v)+1}\``, `:46-48`); the def has no roster, so
promotion deletes the names and paints a 4-position anonymous dial. With
`options[]` (4 ≤ `SEGMENTED_MAX_OPTIONS` = 6) the dock renders a **`segmented`**
row and the lane renders a knob with a persistent readout naming the state —
`paintsReadout` is true for a bare `options` roster with no `format`. ⚠ **On a
video def that roster is a `params` edit → an owner-machine WebGL re-attest**
(measured, B9.1). Batch it with the `noUserControl` declaration in ONE PR so the
re-attest is paid once, and say in the PR body that the `face` and
`noUserControl` halves were free and the roster was not.

**GLYPH: `'none'`, mandatory** (B9.7 — every other value resolves
`{kind:'static'}`).

**READOUTS.** The per-selector state name comes free from `options[]`. One
derived readout is worth adding and it is the one the defect argues for:

| `valueId` | formula | at the defaults | the negative control |
|---|---|---|---|
| `4plexvid-routing` | the four **live** indices as one string, e.g. `1·1·1·1` → `1·3·1·1` | `1·1·1·1` | pulse `gate2` with no dial movement: the string must change `1·1·1·1 → 1·2·1·1` **while every fader stays put** — which is precisely the state today's card cannot show |

⚠ That readout is only truthful if it reads the LIVE handle. If `FaceReadoutValue`
resolves from stored params it reproduces the bug; **verify which it reads before
promising this**, and if it reads stored params, say so and drop the readout
rather than shipping a second copy of #1959.

**`bareCells`: NO.** `OUT1…OUT4` are four different outputs; the captions are not
restating a section heading.

**⚠ FADER vs SEGMENTED — a real choice, stated.** The card mounts four
`<NeonFader>`s. `face.paramCells: 'fader'` preserves the throw; an `options[]`
roster gives named buttons at the dock. **They are mutually exclusive**
(`paramCellKind` returns the declared cell before it looks at `options`), and the
names are worth more than the throw for a router. Recommend `options[]`, and say
in the PR that the fader affordance was traded for the names deliberately.

**STOP 2 — the card was READ, not grepped.** 163 lines. Four `<NeonFader>`s, a
`<PatchPanel>`, a `<ModuleTitle>`, and one **live OUT-1 preview canvas**
(`fourplexvid-preview`, 160×90, driven by `blitOutputForPreview(id)` in a rAF
loop). No `<button>`, no `<select>`, no `node.data`. **Only the preview needs a
home** — that is the SCREEN cell.

**SCREEN ON/OFF + FREEZE — answered, and the answer is that it needs NO new
param.** Structurally measured on the def: `uTime`, `Date.now`,
`performance.now`, `Math.random`, `frame.time`, `frame.frameIndex`, `elapsed`,
`accum` — **zero occurrences of each**, and `FRAG_SRC` declares exactly two
uniforms, `uTex` and `uHas`. There is no accumulation and no clock, so a
`4plexvid` **cannot** be non-deterministic on its own: its output is a pure
function of its inputs and its four indices. **Its determinism comes from its
SOURCE, not from a freeze param** — so the face's VRT scene must either leave the
inputs unpatched (constant black, deterministic but a poor baseline) or patch a
module that is itself pinned. ⚠ **Do not add a `freeze` param here**: it would be
a `params` edit (a re-attest) buying nothing, and `spirographs` already showed
that a new `noUserControl` freeze param renders as a fader row on the legacy card
that still exists during the transition. The SCREEN toggle reaches the face
through **`fullViewBody`** (#1930's template, gated by #1935), not through the
card.

**VRT:** `EXEMPT_FROM_VRT:402` + `ALLOWED_PERMANENT_EXEMPT:1015` + a
`VRT_MODULE_MASKS:200` canvas mask held for a future promotion, so **no committed
card baseline moves**. ⚠ Two stale sentences to fix while you are there: the
exemption says *"capture **darwin/linux** baselines"* (there is one set and linux
CI authors it), and the mask comment describes *"4 selector knobs"* on a card
that stops rendering. Two new `face-4plexvid-*` scenes need a `FACES` entry
`{ type: '4plexvid', pages: 1 }`.

**`DESCRIPTIONS`: NOT owed** — measured: `4plexvid` has no entry and does not need
one, because `describeModule` falls back to `MODULE_DOCS[type].explanation` for
video modules (`module-manifest.ts:1086-1092`). What the PR owes is docs
ACCURACY, and #1958/#1959 are where the inaccuracies are.

**Rear card:** 8 input holes, 4 outputs. ⚠ **The four `gate*` inputs declare
`paramTarget` pointing at their OWN id** — check `rearFieldPlan` renders a jack
whose target is a `noUserControl` param sensibly (it should: the jack is the
whole point, the knob is not).

**e2e:** `4plexvid.spec.ts` locates `.svelte-flow__node-4plexvid`, which
survives promotion. Nothing else keys on card internals.

**Push 2:** no entry → GENERIC today. ⚠ With `noUserControl` declared, the four
gate params become ineligible for an encoder (`push-card-schema` reads the
declaration), so the golden **should** change from 8 candidates to 4. Assert that
rather than accepting it silently — it is the cheapest available proof the
declaration is being consumed.

**DEFECTS FILED, not folded in: #1958** (the synthetic gate params are offered as
knobs, and turning one rotates the router) · **#1959** (the card/engine
divergence, the non-persisting rotate, and a persisted `NaN`/`Infinity` selector
that blacks an output forever — `Math.round(Infinity) % 4` is `NaN`, and
`INPUT_IDS[NaN]` is `undefined`, so the shader takes its `uHas < 0.5` branch).

**RISK: LOW-MEDIUM.** No DSP change, no baseline moved, no ART. The cost is one
owner-machine re-attest for the `options[]` roster — pay it once, batched.

## B9.5 Q45 · `warrensvisions` — the pool's only module with a declared vocabulary nothing reads, and a documented control that does not exist

**Merit: YES, and it is the strongest of this cohort.** 12 params, 9 inputs (1
`video` + 1 `gate` + 7 `cv`), 1 `video` output. A 2D spectral video
resynthesizer: FFT a 128² luma plane, track the strongest wavevector peaks as
gratings, replay everything unclaimed as 16 log-spaced residual rings, sum it
back through an inverse FFT and composite against the source.

**Four things make it unusual, and three of them are what the face is FOR:**

1. **It is the only module in the pool that declares `options[]` AND
   `landmarks`, and NEITHER is consumed today.** `engineFreeze` declares
   `LIVE`/`FREEZE` with `title` tooltips; `visionsShape` declares
   `0 SINE / 0.5 SAW / 1 SQUARE`. The card re-types `'FREEZE'`/`'LIVE'` as string
   literals (`WarrensvisionsCard.svelte:130`) and never passes the landmarks to
   its `<Knob>`. **A face consumes both** — measured with the real predicates:
   `paramCellKind(engineFreeze, dock)` → **`segmented`**, at lane → `knob`;
   `paintsReadout` → **true** for both params; `knobNameReadout` prints
   `SINE / SINE / SAW / SAW / SQUARE` across the shape dial and
   `LIVE / LIVE / FREEZE / FREEZE` across the freeze param. ⚠ And
   `contract-lock.txt` records neither `options` nor `landmarks`, so a pool
   derived from the lock alone is structurally blind to both.
2. **It carries FIVE real units over a video module** — `dB`, `fr` (×2), `s`,
   `ct` — which is unique in the video pool.
3. **All 11 knobs are dead to CV against SEVEN CV inputs** (`readLive` count: 0).
4. `maxInstances: 1`, ⚠ **and the palette HIDES the module once one exists** — so
   a VRT scene that tries to spawn two silently gets one.

**Control-heavy: NO — 12 controls, honest page count 4, and the rail is not
reached.** `DOCK_TAB_MIN_BANDS = 7`. Per the 2026-08-18 ruling: **do not pad
pages to force the rail.** There is no honest 5th–7th idea here, and unlike
`ruttetra` this module was never named as the tabbed application, so there is
nothing to escalate.

**THE PAGES (4), and they are the def's own structure:**

| page | controls | the one idea |
|---|---|---|
| `analysis` | `visionsSlice`, `visionsFloor`, `visionsStability`, `visionsComponents` | which gratings earn a slot, and how often we look |
| `motion` | `visionsCoherence`, `visionsDrift`, `visionsSlew` | how the bank behaves over time |
| `grating` | `visionsShape`, `visionsCenter` | what each individual grating looks like |
| `output` | `visionsResidual`, `visionsMix`, `engineFreeze` | what reaches the screen |

**THE RANKING ARGUMENT — THE DEF ALREADY MADE IT, IN A COMMENT.**
`warrensvisions.ts:314-315`: *"COHERENCE first: it is the control that changes the
module's identity, and no other control on it moves more."* So
**`face.order` starts `visionsCoherence, visionsComponents, visionsMix, …`** and
follows declaration order thereafter; any deviation from the def's own stated
priority has to be argued, and this entry does not deviate. ⚠ Note `order` and
`pages` therefore DISAGREE deliberately — `order` ranks by priority for the lane,
`pages` groups by kind for the dock. Say so in the comment.

**MEASURED — the CV reach, with the real `scaleCv`** (the same function
`mapCvBridgeValue` calls), at each param's shipped default:

| port | param | default | reach with a ±1 cable | % of travel |
|---|---|---|---|---|
| `coherence_cv` | `visionsCoherence` | **1 = MAX** | 0.5000 … 1.0000 | **50 %** |
| `mix_cv` | `visionsMix` | **1 = MAX** | 0.5000 … 1.0000 | **50 %** |
| `shape_cv` | `visionsShape` | **0 = MIN** | 0.0000 … 0.5000 | **50 %** |
| `drift_cv` | `visionsDrift` | **0 = MIN** | 0.0000 … 0.5000 | **50 %** |
| `components_cv` | `visionsComponents` | 64 | 1.0000 … **191.5** of 256 | 74.7 % |
| `residual_cv` | `visionsResidual` | 0.5 | 0.0000 … 1.5000 | 75.0 % |
| `center_cv` | `visionsCenter` | **0 = CENTRE** | −3600 … +3600 | **100 %** |

`center_cv` is **the module's own positive control** — same code path, same hint,
full travel, because its default is centred. That is the strongest available form
of the instrument check and it is why the other six rows are believable.

⚠ **Two §22.7 claims are CORRECTED by this measurement, and the corrections
matter**: `shape_cv` was recorded as *"never reaches SAW"* — it reaches **exactly
0.5000, which IS the SAW landmark**, and never gets past it toward SQUARE;
`drift_cv` was recorded as *"never half scale"* — it reaches **exactly 0.5000,
which IS half scale**. The `coherence_cv` / `mix_cv` / `components_cv` claims
stand as recorded. A spec is a hypothesis.

**MEASURED — SHAPE, through the module's own `wvHarmonicWeight`:**

| n | shape 0 | 0.2501 | **0.5** | 0.7499 | 1 |
|---|---|---|---|---|---|
| 2 | 0.000000 | 0.250100 | **0.500000** | 0.250100 | 0.000000 |
| 3 | 0.000000 | 0.166733 | **0.333333** | 0.333333 | 0.333333 |
| 4 | 0.000000 | 0.125050 | **0.250000** | 0.125050 | 0.000000 |

`max |w(n, shape) − 1/n|` over n = 2…8 is **0.000000 at shape 0.5** and
**0.249900** at 0.2501 — i.e. the morph is an *exact* ideal saw at exactly the
declared landmark. ⚠ **And the face's readout will print `SAW` across the whole
(0.25, 0.75] half of the dial**, because `knobNameReadout` is nearest-match by
design (`knob-vocabulary-model.ts` says so explicitly, and ties resolve to the
earlier entry — measured: exactly 0.25 prints `SINE`). **That is platform
behaviour, not a defect, and it is NOT filed** — but it is worth one sentence in
the PR so nobody reads the readout as a claim about the harmonic series.

**Tier ladder as a sentence:** no glyph binds → `glyph: 'none'` → compact cap 3.
At mini you get COHERENCE; at compact COHERENCE, COMPONENTS and MIX — which is a
genuinely playable subset and is the def's own priority order paying off. Plate
and dock carry all 12.

**GLYPH: `'none'`, mandatory** (B9.7).

**READOUTS — three, all derivable from params alone.**

| `valueId` | formula | at the defaults | the negative control |
|---|---|---|---|
| `warrensvisions-center-zoom` | `2^(cents/1200)` | **×1.000000** | the panel prints `ct` on a **video** module; the readout prints the ZOOM, and at ±3600 ct it is **×8.000000 / ×0.125000** — a number the dial cannot express |
| `warrensvisions-slice-hz` | `60 / slice` | 30.0 Hz at the default SLICE 2 | move SLICE 2 → 16 and it reads 3.75 Hz — *"how often the picture is re-analysed"*, which `fr` does not say |
| `warrensvisions-shape` | the landmark name | `SINE` | free from `landmarks`; see the nearest-match caveat above |

⚠ Totality legs: `visionsCenter` at both rails, `visionsSlice` at 1 and 16, plus
NaN/±Infinity. `visionsFloor` is already in dB and declares `units`, so **do not
add a fourth readout for it** — a `format`-bearing param paints nothing by
design.

**`bareCells`: NO.** Twelve differently-named controls across four sections;
every caption disambiguates.

**STOP 2 — the card was READ, not grepped.** 339 lines. Eleven `<Knob>`s that
already read their ranges from `WARRENSVISIONS_RANGES` via `spec(...)` (so
**no hand-typed literals and no `RANGE_BOUND_CARDS` question**), one
`<PatchPanel>`, one **live preview canvas** (`warrensvisions-canvas`), and one
`<button class="freeze">` (`warrensvisions-freeze`, `aria-pressed`) whose label
re-types `'FREEZE'`/`'LIVE'`. The button writes through `set('engineFreeze')`,
i.e. the normal param path — **no raw-write debt** (confirmed: the ledger has no
`WarrensvisionsCard` entry). So exactly two things need a home: **the canvas**
(the SCREEN cell) and **the freeze names** (the def's own `options[]`, free).

**SCREEN ON/OFF + FREEZE — answered, and there is a trap in the answer.**

- ⚠ **`engineFreeze` is NOT a determinism freeze. Do not tick the freeze-param
  box with it.** It is a musical control: it stops the ANALYSIS, and the docs say
  so — *"the bank keeps slewing, drifting and rendering, only the analysis
  stops"*. Output still moves.
- **The real determinism seam is the ENGINE clock, and it is already wired.**
  `warrensvisions.ts:563-576` reads `dt` from **`frame.time`** — the simulation
  clock `__videoEngineFreezeTime` pins — and explicitly NOT from
  `frame.timeDelta` (which is `performance.now()`-derived), with the reason
  written on the line: under the DRS harness wall-clock `dt` collapses to ~0 and
  SLEW/DRIFT would never advance. The residual RNG is a fixed seed
  (`WV_NOISE_SEED = 0x9e3779b9`). **So every envelope is a function of the frame
  count the test drove, on any renderer** — which is exactly what the
  frames-not-milliseconds rule wants, and it means **no new param, no re-attest.**
- ⚠ **Its committed baseline masks the canvas** (`VRT_MODULE_MASKS:230`), so the
  picture is not gated today at all. A face's SCREEN cell inherits that choice —
  decide deliberately whether to keep the mask (cheap, gates chrome only) or drop
  it and lean on the clock pin (stronger, and the honest test of the seam above).
  It is in `HEAVY_RENDER` (`io-spec-consistency.spec.ts:181`), so price the scene.
- The SCREEN toggle reaches the face through **`fullViewBody`** (#1930's
  template, gated by #1935), never through the card.

**GLSL-delivered claims — what the #1909 harness CAN verify at build time.** The
harness reduces a node's output texture to a circular-mean hue plus saturation.
For `warrensvisions` the honest scope is narrow and should be stated rather than
oversold: the module **resynthesizes LUMA and recombines the SOURCE's chroma**,
so a hue measurement is a test of the *compositor*, not of the resynthesis.
⚠ Two claims it CAN carry, each with the mandatory positive control:

1. *"With nothing patched into VIDEO IN the output is black"* — `qualifying` must
   be ~0 and `val` ≈ 0; positive control, patch a saturated source and both move.
2. *"MIX crossfades against the source"* and *"chroma follows the input"* — sweep
   `visionsMix` 1 → 0 with a single-hue source and assert `hueDeg` stays within a
   stated tolerance in DEGREES while `val` moves; the negative control is a
   second source hue, which must move `hueDeg` and nothing else.

**What the harness structurally CANNOT see here, per its own list:** the
COHERENCE behaviour (a geometry claim, not a colour one), the residual rings
(spatial detail below the sample stride), and anything about component count.
Those stay `warrensvisions-core.test.ts`'s job — the pure core is fully drivable
in node, as every number in this entry demonstrates.

**Rear card:** 9 input holes, 1 output. ⚠ The `gate` input declares
`paramTarget: 'engineFreeze'` with **no `cvScale`**, which
`buildCvBridgeMapping` treats as raw passthrough (gate semantics) — correct by
construction, since the module reads `engineFreeze >= 0.5`. Check `rearFieldPlan`
groups a `gate`-typed jack that targets a `segmented` param sensibly; nothing in
the faced set has that combination yet.

**Push 2:** no entry → GENERIC today, moves to the FACE tier. 12 params over 8
encoders means the tier rules truncate — accept the golden deliberately.

**`DESCRIPTIONS`: present** — and it contains the LOCK sentence that #1960 is
about. The face PR does not own that fix; it owns not repeating it.

**DEFECTS FILED, not folded in: #1960** (the shipped docs describe a `LOCK`
control that does not exist — the core's `lock` is pinned at `0.5`, worth a
**×2.5** salience bonus on a lattice fundamental and a **halfway** wavevector
snap, both measured through the module's own `wvPeakSalience` with two negative
controls; plus the SLEW/rings and CPU-figure contradictions) · **#1961** (5 of 7
CV inputs cannot reach the behaviour their docs promise at the shipped defaults).

**Also measured, not a defect, worth one sentence of boy-scout docs:** the SLEW
dial and the residual rings coincide at **exactly one** point of a 0.02–4 s
travel. At 60 fps the ring coefficient is a fixed **0.283469** (`1 − exp(−dt/0.05)`,
hard-coded) while the component coefficient runs **0.565402** (SLEW min) to
**0.004158** (SLEW max) — so the rings are **0.50× to 68.17×** the component rate
and match it only at SLEW = 0.05 s.

**RISK: MEDIUM.** No DSP change, no ART, no committed *required* baseline (the
full-lane baseline does move). The face itself is a pure surface addition and is
attest-FREE; **#1960 and #1961 are the ones that cost a re-attest**, so land them
separately and do not fold either into the face PR.

## B9.6 THE ADVERSARIAL PASS — what I attacked in my own spec, and what survived

Per `module-adversarial-audit.md`. Recorded because *"verified X by measuring Y"*
beats *"X is true"* — and because **four of these attacks succeeded against me,
one of them against a claim in this file.**

**⚠ ATTACK 1 — SUCCEEDED, and it would have produced a FALSE DEFECT REPORT.** My
`stereovca` probe fed `NaN` / `Infinity` straight into the worklet's `level` and
`offset` `Float32Array`s and watched `NaN` propagate to every output sample. I
was one paragraph from filing "stereovca has no NaN guard". **It cannot happen in
a browser**: `StereoVcaProcessor.parameterDescriptors` declares
`minValue`/`maxValue` on both params, so Web Audio clamps before `process()` ever
runs, and my probe was bypassing the AudioParam entirely by constructing the
arrays by hand. **A worklet driven through the registerProcessor shim is missing
the descriptor clamp, and that absence looks exactly like a missing guard in the
DSP.** The NaN legs are therefore reported in this spec as a READOUT
requirement (the face must not print `NaN dB`), not as a DSP defect.

**⚠ ATTACK 2 — SUCCEEDED against my own instrument, and the positive control is
what settled it.** The `stereovca` mirror (`stereoVcaMath`) and the shipping
worklet disagreed by **1.49e-8** over 512 samples, which reads like a real drift
between a DSP and its unit-test reference — and the def's own comment invites
that reading (*"any drift here means the worklet and the unit-test reference
disagree"*). Re-run with params that ARE exactly representable in float32
(`level 0.5`, `level 0.75`): the difference is **0 exactly**. The gap is
`Math.fround(0.8) = 0.800000011920929`, i.e. the AudioParam's float32 storage,
not the arithmetic. **"The DSP disagrees with its mirror" and "my probe passed a
float64 where the browser passes a float32" are the same reading from the output
alone.**

**⚠ ATTACK 3 — SUCCEEDED against §22.7, twice, in the same direction.** The
queue's `warrensvisions` note recorded *"`shape_cv` never reaches SAW"* and
*"`drift_cv` never half scale"*. Run through the real `scaleCv`, both reach
**exactly 0.5000** — which IS the SAW landmark and IS half scale. The claims are
off by the boundary case, and the boundary case is the whole claim. The other
five rows of that note survive verbatim. Recorded so the corrections travel with
the numbers rather than being silently better.

**⚠ ATTACK 4 — SUCCEEDED against a recommendation in THIS FILE (#1964).** The
rolling index's finding 5 ends *"should therefore be fixed with
`face.paramCells: 'toggle'` (free on both counts)"*. `AuthoredParamCell` is
`'grid' | 'color' | 'fader'` — **`'toggle'` does not typecheck**, and the only
thing that produces a Toggle is `looksLikeToggle`, verified with the real
predicate: `discrete 0..1 → true`, **`linear 0..1 → false`**, `discrete 1..2 →
false`. So the cheap fix that finding promises does not exist, and the only route
is `curve: 'discrete'` — the `params` edit and the re-attest it was trying to
avoid. Filed as #1964 because a build lane is on those modules right now.

**ATTACK 5 — "the `4plexvid` card/engine divergence is theoretical; surely
something syncs it back." DISPROVEN by holding the node object.** The factory's
`{ ...DEFAULTS, ...node.params }` is a fresh object; two gate pulses leave
`handle.readParam('sel1') = 2` and `node.params.sel1 = 0`, and the card reads the
latter with no `readLive`. The existing unit test cannot see it because it
asserts through `readParam` — **the same copy that is wrong**. This is the claim
in this cohort a builder should re-check first.

**ATTACK 6 — "`stereovca` and `joystick` are one entry: both 2-param audio
utilities in the same batch."** Attacked with Q28's pairing test rather than by
taste. Shared DSP? No — one is a worklet, the other four `ConstantSourceNode`s.
Cross-references either way? Zero. The same merit argument? **No** — stereovca's
is that the module ships silent and its rank order inverts; joystick's is that
its one gesture has no equivalent in the cell it is prescribed. Two entries.

**ATTACK 7 — "`4plexvid` needs a `freeze` param like every other video face."
FALSE, and checked structurally rather than assumed.** Eight time/RNG tokens
scanned, **zero occurrences of each**, and `FRAG_SRC` declares exactly `uTex` and
`uHas`. Its output is a pure function of its inputs and indices; its determinism
comes from its SOURCE. Adding a param would cost a re-attest and buy nothing.
⚠ The inverse trap is in the other entry: `warrensvisions` **has** a param called
`engineFreeze`, and it is *not* a determinism freeze — it stops analysis while
drift, slew and rings keep rendering. **"Has a freeze param" and "is
deterministic" are independent, in both directions.**

**ATTACK 8 — "promoting one of these empties a `_face-fixtures` pool (#1864
again)."** Half right, and the half that is right is the one nobody would have
predicted. The VIDEO pool is 61 deep and both video picks sit mid-list, so they
move nothing. But **`AUDIO_FIXTURE.type` IS `stereovca`**, with a pool of exactly
three (`stereovca, dockscope, samsloop`). Promoting it re-points the fixture and
leaves two. It fails LOUDLY by design now (`fixtureProblems` is the assertion), so
it is a sequencing note, not a re-filed defect — but it is why B9.2 tells the
builder to re-run the fixture gate in the same PR.

**ATTACK 9 — "all four cards are dead to CV, like §25.1's video four."** **False,
and checked before it was written.** The two video cards pass `readLive` on none
of their 15 knobs; the two audio ones pass it on all of theirs. The answer flips
inside one cohort, which is exactly why §23-18 says to re-verify rather than
inherit.

**ATTACK 10 — "the `warrensvisions` SAW landmark printing across half the dial is
a defect."** Measured, then NOT filed. `knobNameReadout` is documented
nearest-match and ties resolve to the earlier entry (verified: exactly 0.25
prints `SINE`). The morph IS an exact ideal saw at exactly 0.5. The readout is
behaving as specified; the spec just needs to say so before someone reads it as a
harmonic claim.

**WHAT I DID NOT MEASURE — stated so a builder knows the edges of this spec:**

- **Nothing was rendered in a browser.** No dock layout, no band packing, no tier
  truncation, no VRT pixel, no GLSL. Every page count, cap consequence and
  readout claim is DERIVED-BY-READING `curated-face.ts`, `dock-row-plan.ts`,
  `dock-tabs-model.ts` and `shell-control-kind.ts`, or measured through those
  files' own exported pure functions in node.
- **NO PIXELS WERE MEASURED FOR EITHER VIDEO MODULE.** `4plexvid`'s factory was
  driven against a **fake GL context** — that measures the selector law, the edge
  detector and the param plumbing and **nothing about what is drawn**.
  `warrensvisions`' numbers come from its **pure core**, not from its GL wiring.
  The #1909 harness legs proposed in B9.5 are a PLAN, not a result.
- **`FaceReadoutValue`'s resolution source was not verified.** B9.4's routing
  readout is only truthful if it reads the LIVE handle; if it reads stored params
  it reproduces #1959. **Check before promising it.**
- **The lane tier of a pad-only face was not exercised.** B9.3 predicts
  `laneOrder()` returns EMPTY for `joystick` (the pad is dock-only and there is
  nothing else). That is read off `curated-face.ts:135`, not observed.
- **Push 2 goldens are predicted from `push-card-config.ts`'s tier rules**, not
  computed by running `push-card-schema.test.ts`.
- **No module was driven through a real engine graph** — only through its factory,
  its worklet class, or its pure core. Cable types line up on paper.
- **`warrensvisions`' analysis path was never fed a real frame.** Every core
  number here comes from exported pure functions (`wvHarmonicWeight`,
  `wvPeakSalience`) and from arithmetic on the coefficients the core computes; no
  FFT was run over an image.

## B9.7 GLYPH RESOLUTION — RUN, NOT REASONED

§23-15's rule is *"a glyph that resolves is not a glyph that reads"*. Every glyph
claim in B9.2–B9.5 was **run through the real resolver**
(`$lib/ui/workflow/shell-glyph-live`) on the live defs.

| def | `primaryAudioOutPortId` | `'meter'` | `'waveform'` | `'envelope'` | `'algorithm'` |
|---|---|---|---|---|---|
| `stereovca` | **`out_l`** | `live-audio`:`out_l` | `live-audio`:`out_l` | `static` | `static` |
| `joystick` | **null** | `static` | `static` | `static` | `static` |
| `4plexvid` | **null** | `static` | `static` | `static` | `static` |
| `warrensvisions` | **null** | `static` | `static` | `static` | `static` |

(`'none'` returns `{kind:'none'}` on all four, as the first arm.)

Three consequences, all measured rather than derived:

1. **`stereovca` BINDS and the resolver names the port — `out_l`.** That answers
   the #1692 / Q20 *"say WHICH tap"* warning from the code rather than from the
   def's output list, and it fixes its compact cap at
   `LANE_ROW_MAX_CELLS_WITH_GLYPH = 2` — which is exactly its control count.
2. **The other three MUST declare `glyph: 'none'`.** Every other value resolves
   `{kind:'static'}`, which reddens the dead-glyph clause. Their compact cap is
   `LANE_ROW_MAX_CELLS = 3`, which is why `4plexvid` truncates one of its four
   symmetric selectors at compact and why `warrensvisions` shows its top three.
3. **`joystick` is a third witness for the "visibly X, resolves static" class.**
   It is a CV source with four live outputs and no glyph can show any of them,
   because the resolver keys on an `audio` output. `moog911` and `moog912` were
   the first two (#1888).

⚠ **What this still does not prove**: that `stereovca`'s tap MOVES. `stereovca`
is an audio node so the `mandelbulb` failure mode is structurally absent — but
*"resolves"* and *"reads"* remain two questions and only the first is answered
here. The second needs a browser. ⚠ And note the tap would read **exactly zero**
at spawn (B9.2), so a live-glyph assertion on `stereovca` must drive
`offset` or patch `strength_l` first or it will be asserting on silence.

## B9.8 THE COHORT AT A GLANCE

| Q | module | dom | par | pages | why it earns a face, in one line |
|---|---|---|---|---|---|
| **Q42** | `stereovca` | A | 2 | 1 | Patch audio through it at the shipped defaults and **every one of 48 000 samples is bit-exactly zero** — its LEVEL knob is inert across 41 positions, and on the one live dial **unity sits at BOTH ENDS with MUTE at the centre**, where it ships (#1962, **owner ears**). |
| **Q43** | `joystick` | A | 2 → **1 cell** | 1 | The inventory prescribes the shared `xy` cell, and that cell says *"no snap-back"* in a comment while this module's card and docs guarantee one — a prescribed migration that **silently deletes a performance gesture** (#1963), over a card that raw-writes both axes on every pointermove. |
| **Q44** | `4plexvid` | V | 8 (4 real) | 1 | Two rising edges and the card reads **IN1 while OUT 1 carries IN3**, permanently and unpersisted (#1959) — while four of its eight "params" are an **edge detector's memory** that the group bar offers as knobs, where turning one rotates the router (#1958). |
| **Q45** | `warrensvisions` | V | 12 | 4 | The only pool module declaring **`options[]` AND `landmarks`**, neither consumed by its card and both free to a face — over a module whose shipped docs describe a **LOCK control that does not exist** (pinned at 0.5, worth ×2.5 salience — #1960) and whose stated main gesture **cannot be reached by CV** at the defaults (#1961). |

**Issues filed by this lane:** #1958 (4plexvid synthetic gate params, with the
measured attest-transparency table) · #1959 (4plexvid card/engine divergence +
the `NaN` selector that blacks an output) · #1960 (warrensvisions LOCK + two docs
contradictions) · #1961 (warrensvisions CV reach) · #1962 (stereovca ships
silent — **owner ears**) · #1963 (joystick snap-back parity — **prerequisite for
Q43**) · #1964 (this file's `face.paramCells: 'toggle'` recommendation does not
typecheck — **affects the b3ntb0x/bentbox build in flight**).

**Build order, if the wave is taken as one: Q44 → Q45 → Q42 → Q43.**
Q44 pays one owner-machine re-attest (batch `noUserControl` + `options[]` into
ONE PR) and moves no committed baseline. Q45 is attest-FREE as a face and moves
only a full-lane baseline — but keep #1960/#1961 out of it, since those DO cost a
re-attest. Q42 moves a **required** `STRICT_VRT_MODULES` baseline and re-points
`AUDIO_FIXTURE`, so it wants a clear window. Q43 is **blocked on #1963** and
should not start until that is answered.

**Next after this cohort, in order:** `gatemaiden` (2 params, own worklet,
`units: 's'`, a ledgered `trigShape` debt, and a testable docs claim) ·
`synesthesia` (22 params, the last genuinely control-heavy audio candidate, and
its only blocker may be a `meter` glyph) · `foxy` (33 params, an honest **7**
pages — the real `DOCK_TAB_MIN_BANDS` story — but three non-param affordances,
so a multi-PR job in the `colourofmagic` shape) · then the un-triaged video
remainder, `monoglitch` (8) and `feedback` (6) first.

**BANK AFTER THIS SECTION, re-derived from `origin/main`'s generated artifact**
(an entry is in the bank when its module is NOT `done` in
`docs/design/face-migration.generated.md`):

| domain | buildable now | held / in flight |
|---|---|---|
| **video** | **2** — Q44 `4plexvid` · Q45 `warrensvisions` | `bentbox` + `b3ntb0x` (Q24, **being built now**) · `mandelbulb` (Q25, **being built now**) · `ruttetra` (owner tabbed ruling) · `grainsOfVision` (owner) · `mirrorpool` (owner look, #1936) · `quadralogical` (Q27, gated) |
| **audio** | **1** — Q42 `stereovca` | Q43 `joystick` (**blocked on #1963**) · `moog905` (Q21, **being built now**) · `wavesculpt` (spec exists, hold EXPIRED — buildable, just not new) · `samsloop` (batch-3 spec exists) |
| **total** | **3 buildable + 1 unblockable-in-one-decision, 4 spec'd** | |

Before this section the unbuilt-ungated bank was effectively **zero** — batch 8
took the last three and every remaining video entry was owner-gated. That is the
gap this section exists to close.
