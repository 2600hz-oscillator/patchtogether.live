# FACE SPEC — `clipplayer` (batch 7)

## 0. STATUS AND VERDICT

**Authored 2026-08-11 against `main` at `2af79daf`.** Nothing here is
implemented; no def, card, engine or test file is touched. **This module is the
owner's own instrument and is used heavily, so the first half of this document
is an inventory of what the card DOES TODAY (§1) and the standing instruction is
that none of it changes.**

**Verdict: DO NOT PROMOTE — and specifically, not in a face batch.** This is not
a close call and it is not my judgement: **the platform already ruled on it, in
code, with the reason written down.** `clipplayer` is on
`NON_SHELL_LANE_TYPES` (`legacy-fallback.ts:70`), whose header says:

> *"clipplayer + the MIDI control surfaces — **SNOWFLAKES whose lane face is a
> grid / launcher / mapper, not a ranked-knob skeleton (plan §6): they get
> bespoke faces in a later spike, and stay on the verbatim legacy card until
> then rather than a lossy placeholder**"*
> (`legacy-fallback.ts:41-45`)

A ranked-knob face is the thing that list exists to refuse. §2 shows that
promoting it anyway would put the platform into a **split-brain state that no
gate would catch**. §5 prices the bespoke spike the list is waiting for, so the
next agent does not have to re-derive it.

**What SHOULD ship instead:** §4's defect list. One of them (§4-A) is a live
doc/behaviour divergence in a `STRICT_DOCS` module, costs one PR, changes no
audio and moves no baseline.

archetype: **the clip launcher.** 8 instrument lanes × 8 on-card slots (64
scenes per lane in storage), locked to TIMELORDE, with a piano-roll editor, a
song/arrangement timeline, per-clip automation recording, and monome + Launchpad
hardware bindings.

Registry position: **not** in `STRICT_FACES`; no `face:` block. In
`NON_SHELL_LANE_TYPES` (`legacy-fallback.ts:70`). In `STRICT_DOCS`
(`strict-docs.ts:239`, as a deliberately STATIC doc face). In `DOCKABLE_TYPES`
(`dockable.ts:39`). Pinnable (`workflow-pins.ts:102`, key `c`). **Not** in
`PUSH_CARD_CONTROLS`. **Not** in `STRICT_VRT_MODULES`, though it has an
informational `vrt.spec.ts/clipplayer.png`. `rack-sizes.ts:38` and the def
itself both say `3u / hp 2`.

---

## 1. WHAT THE CARD DOES TODAY — the inventory, so nothing is respec'd by accident

`ClipplayerCard.svelte` is **3356 lines**. Everything below is current
behaviour, read off the tree; it is here to be preserved, not proposed.

### 1a. Four views, one card

`cardView` is card-LOCAL `$state` (`:253`) — `'grid' | 'clip' | 'arranger' |
'control'` — driven by an 8-button CONTROL STRIP (`:1618-1697`,
`clipplayer-strip-{1..8}-{id}`) that mirrors the Launchpad's permanent top row
CC 91–98. The same eight actions are on computer keys **1–8**, claimed through
window-level capture listeners that self-gate on **focus-within**, not on
xyflow selection (`:611-617`, `:664-716`) — the fix for a selected-but-unfocused
card starving NUMPAD+, Blood and Score of their digits. Key 8 is a hold-only
shift with force-release on blur / pointercancel / visibilitychange.

### 1b. The launch grid (`cardView === 'grid'`)

**Columns are the 8 instrument LANES; rows are the 8 clip SLOTS (the scenes).**
Flat index is `clipIndex(slot, lane)`.

- **Channel header** — a `<input type="color">` per column
  (`clipplayer-color-{lane}`, the single source of `--lane-color`) over the
  **MONO/POLY badge** (§1e).
- **Pads** — `clipplayer-pad-{idx}`, `data-state` ∈ `empty | loaded | queued |
  playing` with queued winning over playing. Click launches (220 ms debounce),
  clicking a playing pad queues `'stop'`, double-click cancels the pending
  launch and opens the editor, right-click opens the clip menu **only on a pad
  that holds a clip** — and the tooltip uses the same `hasClip` predicate, so it
  can never promise a menu that will not open. A teal `.auto-dot` marks a clip
  carrying automation.
- **Scene launch ▶** and the **scene-repeat flair** are `position:absolute` at
  `right:100%` / `left:100%` — deliberately OUTSIDE the row's flex, so pad
  geometry stays pixel-deterministic (`:2653-2695`). The flair cycles
  `[∞, 2, 3, 4, 8]` and shows live `p/N` progress while counting.
- **Channel footer** — a per-lane RATE `<select>` (`clipplayer-rate-{lane}`)
  over the **per-lane automation ARM ◉** row (`clipplayer-auto-arm-{lane}`).
- **Param row** — STEP (cycles `stepDiv`), OCT and GATE knobs, QNT, a sticky
  NOW, and RST wrapped in a `MidiAssignButton`.
- **The clip menu** — portaled and viewport-clamped: 40 clip-probability items
  plus **Delete clip**, which carries `data-clip-idx` and deliberately NOT
  `data-clip` (`:2033-2040`), because a second `[data-clip="n"]` match while the
  menu is open would make every existing pad locator ambiguous. Delete has no
  confirm (it is undoable through the strip's ↶), stops the lane immediately if
  the clip is playing or queued, and removes `d.clips[k]` **and** `d.auto[k]` in
  one transaction.

### 1c. The clip editor (`cardView === 'clip'`)

The card **overrides its rack tier** in this view with an inline
`width: ${editCardWidthPx}px; height:auto` (`:1475-1477`,
`editCardWidthPx` at `:1119-1127`). The piano roll renders **the entire editable
pitch range at once** — e2e pins **57 rows** — and **every step up to 128**, with
zero scroll in either axis. Rows carry `crow`/`frow` C and F guides; the
`clipplayer-noterow-legend` swatches are the exact grid colours
(`#2e343c` / `#262626` / `#161616`). The per-note menu has three sections
(Probability ×40, Play Every ×8, Pitch Probability ×41) and pitch probability is
marked by a **dashed border only** — a shape, not a third colour, because the
cell already blends probability and play-every.

**The clip-view range controls** (`clipplayer-clipview-ctl-{id}`, `:2144-2194`)
are the `restrictRange` / `rangeFloor` pair plus the CUSTOM SCALE picker. The
picker's open state is view-local and never synced — "a personal authoring
lens" — and while it is open the row list is deliberately UNFILTERED so rows can
be ADDED. The floor stepper's value label is the floor octave's C as a
lowercase note name (`c3` at the default).

### 1d. Launch quantize — the Deluge reference bar

`nextLaunchBoundary(playing, now)` (`clip-launch-quantize.ts:60-84`) picks the
playing lane with the **strictly greatest LOOP DURATION** (`lenSteps ×
laneStepDur`), ties to the FIRST (lowest) lane, and returns its next wrap rolled
forward to stay strictly after `now`. `referenceClocks` decides membership
**purely from the synced `playing[]`**, never a local audio probe, so peers
cannot pick different bars. Returns `null` when nothing is playing → the caller
launches immediately. The three immediacy escapes (QNT off, per-lane NOW,
nothing playing) all live in the caller (`clipplayer.ts:1840-1844`).

⚠ **THE ONE OPEN ITEM IN THE MEMORY IS FIXED IN CODE — do not re-chase it.**
`clip-launch-quantize-deluge` records a flagged over-quantization: *"per-lane
STOPs now ALSO quantize to the reference bar (was own-wrap)"*.
`clipplayer.ts:2166` now reads
`const wrapFloor = isStopQueued ? advanceFloorUntil : (advanceFloorUntil ?? launchBoundary)`,
with the comment *"a STOP → the LANE'S OWN next wrap (NOT launchBoundary): a
clip stops at the end of ITS OWN loop."* The major was paid.

### 1e. Lane monophony and the `1` / `∑` badge

**Monophony is an EDIT-TIME constraint and the engine never reads it.**
`laneMono(data, lane)` (`clip-types.ts:826-828`) is consumed by exactly the card
(`ClipplayerCard.svelte:1194`, `:1346`) and the monome control
(`monome-control.svelte.ts:417`). `grep laneMono clipplayer.ts` finds nothing —
playback plays whatever notes the column holds.

What it changes is `toggleNoteAt` (`clip-types.ts:1753-1778`): on ADD, mono
clears **every note whose span covers this column** and places one
("replace-on-add"); poly caps the column at `POLY_CHANNEL_PAIRS` and steals the
oldest. On REMOVE it is irrelevant. `setNoteSpan` honours the same rule.

The **badge** is `clipplayer-mono-{lane}` in the channel header
(`ClipplayerCard.svelte:1872-1883`): **`1` = mono**, **`∑` = poly`**,
`aria-pressed` = mono, `aria-label` = `channel {n} mono|poly`. The tooltip's poly
cap interpolates `POLY_CHANNEL_PAIRS` from `$lib/audio/poly` (= 16) precisely so
the card cannot restate a stale number — the glyph replaced an older literal
"5". Pinned by `clipplayer-controls.spec.ts:20`.

### 1f. Record, overdub and song mode

Two independent recorders, deliberately distinct on the card:

- the **red ● arranger record** (`clipplayer-record-{id}`) records clip
  **launches** onto a timeline, with SES/ARR and OVR/RPL beside it, and is
  labelled EXPERIMENTAL in its own tooltip;
- the **teal ◉ per-lane automation arm** (`clipplayer-auto-arm-{lane}`) records
  **knob moves** into the playing clip by continuous overdub, punching in at
  THAT clip's own next loop start, stopping only on a second click, with a
  🟡🟡🔴🔴 four-beat countdown on the pad and the arm;
- and a third, **SONG v2** (`clipplayer-song2-*`), which prints note events to a
  song timeline under its own arm and single-writer `recorderId`.

`clipplayer.ts` keeps the two record commits OUT of the undo scope on purpose
(`AUTOMATION_COMMIT_ORIGIN`, `SONG_COMMIT_ORIGIN`) and commits the song print
buffer once per BAR, never per step (`SONG_COMMIT_BEATS = 4`) — the
`cv-modulation-live-store-write-storm` discipline.

### 1g. Contract

**7 params** (`stepDiv` 0..3 discrete/2 · `octave` −2..2 discrete/0 ·
`gateLength` 0.1..1 linear/0.9 · `quantize` 0..1 discrete/**1** · `snh` 0..1
discrete/**1** · `restrictRange` 0..1 discrete/0 · `rangeFloor` 0..8 discrete/3),
**2 inputs** (`stop_all`, `reset`, both `edge:'trigger'`), **24 outputs**
(`pitch{1..8}` polyPitchGate, `gate{1..8}` gate with `edge:'gate'` — explicitly
not trigger, because the low edge is the note/tie span — `vel{1..8}` cv), and
**10 control families**.

Only `restrictRange` is `looksLikeSwitch` (`quantize` and `snh` default to 1, so
they are not), which would be **one** `ACKNOWLEDGED_LATCHING` entry.

**7 params + 10 families = 17 cells.**

⚠ **`clipplayer.ts:40` imports `createEdgeCounter`** — it is the only one of the
three modules in this batch that uses the shared windowed edge seam rather than
hand-rolling it. Nothing to do; noted because the sibling specs call it out.

---

## 2. WHY PROMOTION IS NOT AVAILABLE — the split-brain, in three steps

1. **The LANE would not change.** `laneRenderKind` (`legacy-fallback.ts:107-111`)
   consults `hasCard`, and `isShellSwappable` returns **false** for any type on
   `NON_SHELL_LANE_TYPES`. So with `clipplayer` in `STRICT_FACES` the canvas
   still renders the verbatim `ClipplayerCard`.
2. **The DOCK would.** `DockFullView` switches on `migrated(type)` — bare
   `STRICT_FACES` membership — so the dock full-view would stop rendering the
   card and start rendering the faceplate. `DockFullView.svelte:36-39` says the
   pinned clip player *"takes the un-migrated branch below (verbatim
   ClipplayerCard)"*; promotion silently invalidates that comment and the pinned
   `c` surface with it.
3. **Nothing would go red.** `module-face-lint` checks the face against the DEF,
   `faces-parity` drives the DOCK. Neither reads `NON_SHELL_LANE_TYPES`. A face
   that made the canvas and the dock show two different instruments would pass
   every gate in the repo — which is precisely the *"a gate that reads one side
   of a two-sided contract proves nothing about the other"* class this codebase
   keeps re-learning.

**And the arithmetic is against it even before the split-brain.** All ten
control families must be ranked in `face.order`
(`module-face-lint.test.ts:243-248`) and each must resolve to a registered
`shell-cells.ts` spec, or it renders `data-cell-inert="true"` and fails **two**
gates (`shell-cells.test.ts:55`; `faces-parity.spec.ts:460`). Two of the ten —
`clipplayer-pad` and `clipplayer-cell` — are the card's two primary surfaces; the
other eight are per-lane rows and badges. There is no arrangement of shell cells
that is a clip launcher.

Nor is authoring a `face` block WITHOUT promoting a route: `migrated()` keys off
`STRICT_FACES` alone, and `strict-faces.ts:452` calls an authored-but-unpromoted
face *"a draft-in-progress, not a shipped face"*. It would change nothing and
would then rot.

---

## 3. MEASURED — the launch boundary, driven through the real model

**Method.** clipplayer has no DSP. Its scheduler is plain JS and its
quantization law is a pure exported helper, so the real shipping engine here is
`clip-launch-quantize.ts` + `clip-clock.ts`, driven directly through `tsx` — no
mirror. A determinism control on a pure function is vacuous and is not claimed;
the discipline that applies is the **two-sided negative control** below.

Base step at the shipped defaults (`stepDiv` = 2 = 1/16, TIMELORDE 120 bpm):
**125.0 ms**. Lane rates `1/8 … 4x` = `0.125 … 4×`, default `1`.

### The reference bar

Two lanes, both 16 steps, both half way through their loop, `now = 1.5 s`:

| playing | loop length | boundary | wait |
|---|---|---|---|
| short alone (rate `1`) | 2.000 s | 2.0000 s | 0.5000 s |
| long alone (rate `1/2`) | 4.000 s | 3.0000 s | 1.5000 s |
| **both** | — | **3.0000 s** | **1.5000 s** |

The long clip owns the bar and the launch waits **1.0000 s longer** than the
short clip's own wrap. That is the feature, and it is exactly one second of
apparent unresponsiveness that no surface explains.

**NEGATIVE CONTROL, both directions** — the boundary must move with the one
thing it claims to read and stay put otherwise:

| perturbation | boundary | required |
|---|---|---|
| reference lane alone | 2.0000 s | — |
| **+ a SHORTER lane** | 2.0000 s | must NOT move ✓ |
| **+ a LONGER lane** | 8.0000 s | MUST move ✓ |
| nothing playing | `null` | caller launches immediately ✓ |
| a lane with `laneStepDur` 0 | `null` | lane skipped ✓ |

⚠ **THE FIRST PASS OF THIS MEASUREMENT WAS WRONG AND PRINTED A CLEAN ZERO.** It
built every reference lane at `stepIndex 0`, which the helper reads as *"the wrap
IS `nextStepTime`"* (the modulo at `:76` is load-bearing and documented as such),
so every lane returned the same boundary and the short-vs-long difference came
out as **0.0000 s** — a probe blind to the dimension under test, reporting that
the module's whole quantization feature does nothing. Rebuilt mid-loop, it is
1.0000 s. The phase rule, for the record: `stepIndex` 0 / 1 / 4 / 8 / 15 with the
next step at 0.500 s wraps at **0.5000 / 2.3750 / 2.0000 / 1.5000 / 0.6250 s**.

### The wait a player can be handed

A QNT launch is queued to the next wrap of the reference bar, so the worst wait
is one full loop of the longest playing clip. Across the control space the card
offers (clip length up to 128 steps, lane rate `1/8`, STEP `1/4`, TIMELORDE bpm
clamped 10..300 by the card's own tempo nudge):

| bpm | STEP | rate | 128-step loop |
|---|---|---|---|
| 10 | 1/4 | 1/8 | **6144.00 s (102.4 min)** |
| 10 | 1/4 | 1 | 768.00 s (12.8 min) |
| 120 | 1/4 | 1/8 | **512.00 s (8.5 min)** |
| 300 | 1/4 | 1/8 | 204.80 s (3.4 min) |
| 120 | 1/32 | 1 | 8.00 s |
| **120 · 1/16 · rate 1 · 16 steps (the defaults)** | | | **2.000 s** |

At the defaults it is two seconds and invisible. The point of the table is that
the ceiling is minutes, it is reachable from card controls alone, and a queued
pad blinks the whole time with nothing saying how long.

---

## 4. DEFECTS FOUND — ordered by cost to a user

### A · THE DEF SAYS "4-OCTAVE"; THE SHIPPED WINDOW IS **3** — in a `STRICT_DOCS` module

`ClipplayerCard.svelte:238` — `const RESTRICT_OCTAVES = 3; // window height when
restricted (matches restrictedRowWindow default)` — and `restrictedRowWindow`'s
own default is 3 (`clip-types.ts:1613`). The button label and both tooltips
INTERPOLATE the constant (`:2096`, `:2151-2152`) and are therefore correct: the
card paints `3OCT`.

Seven authored surfaces say four. **Two of them are the def's own docs**, i.e.
the pinned living-docs prose for a `STRICT_DOCS` module:

| where | what it says |
|---|---|
| `clipplayer.ts:193` | *"ON = a 4-octave window whose LOWEST octave is rangeFloor's C"* |
| `clipplayer.ts:240` | `docs.controls.restrictRange` — *"a compact 4-octave window"* |
| `clipplayer.ts:241` | `docs.controls.rangeFloor` — *"the 4-octave editor window"* |
| `ClipplayerCard.svelte:232` | comment |
| `ClipplayerCard.svelte:1068` | comment |
| `ClipplayerCard.svelte:2092` | comment |
| `ClipplayerCard.svelte:2142` | comment |

This is the `noise` pattern exactly — *"seven surfaces disagreed with the three
readouts"* — and it is the same reason nothing caught it: every one of them is
PROSE, and the only place the number is checked is the tooltip that interpolates
it. **One PR, prose only, no audio, no baseline movement.** It should ship.

### B · THE `4-OCTAVE` PROSE IS ALSO IN THE DOC PAGE'S PINNED GOLDEN

Because `clipplayer` is in `STRICT_DOCS`, fixing §4-A means re-running
`flox activate -- task docs:accept` and reviewing the `contract-lock.txt` diff.
The contract itself does not move (docs prose is not in the signature), but the
accept loop must still run — do not hand-edit.

### C · THE CARD IS 540 px TALL IN A ~352 px DOCK SCROLLPORT

Pre-existing and already mitigated, recorded so the mitigation is not lost.
`ClipplayerCard.svelte:626-640` documents it: the card is taller than
`.faceplate-scroll` (~352 px), so a bare `focus()` scrolled the pane by the
card's offset — **measured 62 px, exactly two grid rows** (28 px pad + 3 px gap)
— and the grid slid between the two clicks of a double-click, so click 2 landed
two rows below click 1. Fixed with `focus({ preventScroll: true })`, guarded by
`clipplayer-grid-stability.spec.ts`.

⚠ **That 352 px is the same box the two sibling specs in this batch budget their
heroes against**, and it is the number `wavesculpt` did not check (a 445 px hero
against it, so band content rendered entirely below the fold and all eight tabs
of its rail looked identical). Any future clipplayer surface — faceplate or
not — is designing against 352 px, not against the card's natural 540.

### D · `ClipplayerCard.svelte` IS NOT RANGE-BOUND, BUT MOSTLY BEHAVES

Unlike `WriteseqCard` and `ScoreCard`, this card reads its knob ranges from the
def through a `pdef()` helper (`:2058-2067`), so the ranges do not diverge. It
is still in neither `RANGE_BOUND_CARDS` nor `MAPPING_BOUND_CARDS`, so nothing
holds that. Two label overrides are already declared as accepted debt
(`card-def-debt.ts:68` — `gateLength.label`, `octave.label`). Enrol it when the
card is next opened for another reason; **do not open it for this alone.**

### E · FOUR `queue*_cv` PORTS, EIGHT QUICKSAVE SLOTS

Shared with every module using `TRANSPORT_CV_PORT_DEFS`; not a clipplayer
defect. Named once here so the three specs in this batch agree.

---

## 5. THE BESPOKE SPIKE, PRICED — for whoever picks up `plan §6`

Recorded so this is not re-derived. **It is a spike, not a face batch item.**

**The shape it has to be.** Not `face.order` + `face.pages`. A clip launcher's
dock surface is the LAUNCH GRID and the piano roll, at their real sizes, with
the transport and the eight per-lane rows around them — i.e. the card. The only
version of this that is not a regression renders the SAME components in both
mounts (the `cube` → `CubeVizSurface.svelte` precedent, #1452), which means:

| item | cost |
|---|---|
| **the extraction** | pull the grid, the piano roll, the control strip and the song timeline out of a **3356-line** card into surfaces both mounts use. `cube`'s equivalent needed an owner ruling and a real-GPU re-attest; this one has no WebGL, so it is cheaper — but it is the largest single-card refactor in the repo. |
| **ten shell cells** | one per declared family, each with a probe. Two are the primary surfaces; eight are per-lane rows. ⚠ **A panel must never emit `data-testid="control-<paramId>"`** — faces-parity asserts exact multiset equality against the seven param ids. |
| **panels are dock-only** | a panel may only be SELECTED at tier `dock` (`module-face-lint`'s `panelTierProblems`) — **by RULE, not by rank arithmetic** (PF-22/#1480 made a hero picture rank-free, so "the ten panels rank 8–17" is no longer the reason). The consequence is unchanged: the LANE tile can only ever be seven knobs. **That is the argument for leaving `clipplayer` on `NON_SHELL_LANE_TYPES` permanently even after a dock faceplate exists**: a seven-knob lane tile is not a clip launcher, and the list already says so. |
| **`ACKNOWLEDGED_LATCHING`** | +1 (`clipplayer:restrictRange`). |
| **height** | the grid alone is 8 rows × 31 px ≈ 248 px before the header, footer and arm rows, against a **~352 px** scrollport (§4-C). The clip editor is taller still — it renders 57 rows at once by design. A dock faceplate must either scroll (fine, `.faceplate-scroll` is `overflow:auto`) or re-cut those surfaces, and re-cutting them is a change to the owner's instrument. |
| **bands** | with ten families plus seven params, any sane grouping lands at or above **`DOCK_TAB_MIN_BANDS = 7`**, so the dock becomes a **TAB RAIL** and exactly one band renders at a time. On a launcher that is fatal for the one thing it must do — see eight lanes against each other — which is the same argument `mixmstrs` made for staying at five bands, on a module with 91 params instead of 7. |
| **e2e** | +1 `faces-parity` row at **17 cells** = 30 000 + 600×17 = **40.2 s** (45 000 + 1 800×17 = **75.6 s** under `SLOW_RENDER`). Small next to the extraction's risk to the **18 existing clipplayer spec files**, which are the real cost: every one of them locates by the card's testids. |
| **VRT** | +2 face baselines; the informational `vrt.spec.ts/clipplayer.png` moves if the card is touched at all. clipplayer is NOT in `STRICT_VRT_MODULES` (its chrome animates — blinking pads, rec blink, countdown pulses), so that one is informational, not required. |

**And the precondition, before any of it:** resolve the split-brain in §2. Either
`clipplayer` comes OFF `NON_SHELL_LANE_TYPES` (and its lane becomes a
seven-knob tile, which the list exists to prevent), or the dock's `migrated()`
switch grows a second condition — a real platform change with its own PR, its
own negative control, and an owner decision about what a snowflake's lane
should be.

---

## 6. THE STANDING INSTRUCTION

**Do not change the card.** Specifically, and each for a reason already written
into the source:

- pad geometry is **pixel-frozen** — fixed 28×28 with a 3 px gap, and both
  scene-column controls are `position:absolute` outside the flex so they cannot
  perturb it (`:2653-2695`);
- the Delete-clip item uses **`data-clip-idx`**, never `data-clip`, or every pad
  locator in 18 spec files goes ambiguous (`:2033-2040`);
- `focus({ preventScroll: true })` is **load-bearing**, not a micro-optimisation
  (§4-C);
- the keyboard claim gates on **focus-within**, not selection, or a
  merely-selected card starves every other digit consumer in the rack;
- the CUSTOM SCALE picker's open state and `cardView` are **view-local and never
  synced** — they are personal authoring lenses, and syncing them would move a
  collaborator's screen.

The only change this document asks for is **§4-A: three prose lines in the def
and four comments in the card, plus `task docs:accept`.**
