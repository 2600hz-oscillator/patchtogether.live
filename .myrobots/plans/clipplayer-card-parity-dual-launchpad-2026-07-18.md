# Clip-player card parity + dual-Launchpad rework — DESIGN

**Date:** 2026-07-18
**Status:** DESIGN ONLY (no source changes; no PR). Read/research/spec.
**Scope:** three owner asks against the clip-player surface stack —
1. FULL CARD PARITY with the single-pad Launchpad control.
2. Computer-keyboard **1–8** → the card's 8 top control buttons (with **hold**).
3. DUAL-Launchpad rework: two INDEPENDENT single-pad controllers of the same
   card, plus a COMBINED 16-step view.

**Files in play (all under `packages/web/src/lib/`):**
- `control/launchpad/launchpad-control.svelte.ts` — the stateful control brain (single + pair).
- `control/launchpad/launchpad-map.ts` — Launchpad placement + colour + single-mode classifiers/frames + pair L/R frames.
- `control/launchpad/launchpad-device.svelte.ts` — Web-MIDI device singleton, per-unit (L/R) binding.
- `control/launchpad/launchpad-sysex.ts` — pure byte codec (CC 91–98 top row, SCENE_CCS, padNote).
- `control/clip-surface-map.ts` — controller-agnostic clip brain (index math, note math, length classifier).
- `ui/modules/ClipplayerCard.svelte` — the card UI.
- `ui/modules/LaunchpadControlCard.svelte` — the Launchpad connect/pair/single/view UI.

---

## 0. The single-pad control surface, enumerated (the parity target)

This is the concrete "every single-pad function" list. It is the union of the
**permanent top row** (owned first in every view) + the four **views** + the
**KEYS** sub-view + the **length-edit** takeover. Source: `handleSingleKey` and
the classifiers in `launchpad-map.ts`.

### 0.1 PERMANENT TOP ROW (CC 91–98, `topRowAction`) — live in EVERY view
| CC | col | action | edge | function |
|----|----|--------|------|----------|
| 91 | 1 | `transport` | press | toggle TIMELORDE `running` |
| 92 | 2 | `grid` | press | switch to Grid view (+ **hold**-arm the repeat-count gesture) |
| 93 | 3 | `clip` | press | switch to Clip view |
| 94 | 4 | `arranger` | press | switch to Arranger view (inert placeholder) |
| 95 | 5 | `control` | press | switch to Control view |
| 96 | 6 | `undo` | press | launchpad-scoped `lpDoUndo` |
| 97 | 7 | `redo` | press | launchpad-scoped `lpDoRedo` |
| 98 | 8 | `shift` | **hold** | momentary shift modifier (no latch) |

**SHIFT overlay (per-lane automation arm), reachable from every view:**
- HOLD shift + top CC 91–97 → toggle lane 0–6's automation arm (`armTopLane`); the button's normal function is **consumed**.
- HOLD shift + the pad directly below SHFT (`LANE8_ARM_PAD` = top-right 8×8 pad) → toggle lane 7's arm (`ARM_SHIFT_LANE`).

### 0.2 GRID view (`handleSingleGrid`)
- 8×8 matrix: x = channel/lane (0–7 left→right), rows = slots top→bottom, through a scroll window (`sceneScrollOffset`).
  - pad tap = **launch/stop** the clip (`queueLane`, content-gated create on empty).
  - **double-tap** the same clip = select it + open Clip view, reverting the lane's play/queue intent (owner rule).
- right scene column, **no shift** = **scene/row launch** (fire the slot across all lanes, `applySceneLaunchWrite`).
- right scene column, **+shift** = grid-shift palette (`gridShiftRight`): `copy`(arm) · `paste`(arm) · `clipDiv`(arm) · `swingUp`(nudge) · `swingDown`(nudge) · `len`(arm) · `scrollUp` · `scrollDown`.
- HOLD GRID (CC 92) + HOLD a scene button → **scene-repeat count view** (pad k sets k repeats; pad 64 = infinite; `setSceneRepeat`).
- arm consume: copy/paste/clipDiv/len on a clip pad; copy/paste on a scene button = **whole-scene** copy/paste (clip buffer vs scene buffer, typed).
- NOW is a modifier on launches (sticky in single-clip-view arm strip; on grid it rides `nowHeld`).

### 0.3 CLIP view (`handleSingleClip`, note editor on `selectedClipIndex`)
- 8×8 = note grid (8 pitch rows × 8-step window): tap toggle / drag-span a note; **+shift** = velocity-cycle.
- right column (`clipRight`): `double` · `lengthEdit` · `follow` · `keys`(enter KEYS) · `rowUp` · `rowDown` · `stepLeft` · `stepRight`; **+shift** on row/step = jump a page/block.

### 0.4 KEYS sub-view (`handleSingleKeys`, entered from Clip → `keys`)
- 8×8 = isomorphic keyboard (6 rows) + top playhead strip (8-cell whole-clip) + bottom controls: `EXIT` · `QUEUE-REC` · `OVERDUB` · `OCT−` · `OCT+` · `PANIC` · `LEN`.
- right column, **no shift** = scale-select (`keysScaleRight`): 6 named scales + `chromatic` + `arpToggle`.
- right column, **+shift** = arp controls (`keysArpShiftRight`): `arpDivUp/Down` · `arpUp/Down/UpDown` · `arpRange±` · `arpLatch`.

### 0.5 CONTROL view (`handleSingleControl`, performance deck)
- RESET pad (`doReset`), per-lane MONO / MUTE / RATE rows (`toggleMono`/`toggleMute`/`cycleRate`), per-lane STOP scene column (`controlRight`).
- re-homed pads (`controlRehomePad`): `tempoDown` · `tempoUp` · `stopAll` · `rec` (arranger record) · `song` (SES↔ARR).

### 0.6 LENGTH-EDIT (full-device takeover, `handleRLength`)
- block ruler (row 0) + step rulers (rows 1–2) + EXIT (top scene). Returns to the opener's view.

---

## PART A — Full card parity with the single-pad Launchpad

### A.1 Design principle
Treat the **card as another independent single-pad-style controller** of the
same clip node — exactly the same mental model the dual rework (Part C) applies
to two physical pads. The card gets:
1. a **permanent control strip** of 8 buttons mirroring CC 91–98 (drives keyboard 1–8, Part B);
2. a **4-view body** (Grid / Clip / Arranger / Control) mirroring the device views;
3. a **shift modifier** that reveals the alternate palettes, exactly like the device.

Every card action writes the **same synced `node.data` field** the device
writes (no new engine logic). The card's **view + shift are LOCAL** to the card
(each surface owns its own view/shift — the device and the card can be in
different views at once, just like the two pads in Part C). Persistent edits
(mono/mute/rate/arm/copy-paste/length/div/swing/scene-repeat/rec/song/notes)
land on `node.data`; transient view state is card-local `$state`.

> **Reuse note:** many action seams already exist as pure helpers
> (`clip-types`, `clip-scene-repeats`, `clip-surface-map`, `arp-engine`). The
> card should call those directly rather than re-deriving. Where a write seam
> lives only inside `launchpad-control` (module-private, e.g. `queueLane`,
> `toggleMono`, `setSceneRepeat` wrappers), factor a shared, node-id-parameterized
> action module (`clip-actions.ts`) that BOTH the card and the launchpad import,
> so parity can't drift. This is the single biggest reuse win and it de-risks
> Part C too (the two controllers call the same seam).

### A.2 What the card already has (no new work)
Transport ▶/■, STOP-ALL ■, RST, SES/ARR, REC ●, OVR/RPL, ARR⤢ (pop-out
arranger), S&H, STEP/OCT/GATE/QNT, launch pads (click/dbl-click→edit),
per-lane color, per-lane MONO (1/5), per-lane RATE select, per-lane AUTO-ARM ◉,
scene-repeat **read-only** flair, monome GRID connect, automation chips/override/MAX;
editor: back, scale, root, length-cycle, octave/row nav, clear, clear-auto,
NOW, QUEUE, note toggle, right-click velocity; arrangement: song timeline with
move/select/delete/slot-cycle/length-nudge.

### A.3 The parity GAP → new on-card affordances (grouped, mapped 1:1)

**Group 1 — Permanent control strip (NEW, 8 buttons; = keyboard 1–8):**
| # | button | maps to single-pad | notes |
|---|--------|--------------------|-------|
| 1 | ▶/■ Transport | CC 91 | already exists in header — move/alias into the strip |
| 2 | GRID | CC 92 | selects the Grid (session) body |
| 3 | CLIP | CC 93 | selects the Clip (editor) body on `selectedClip` |
| 4 | ARR | CC 94 | selects the Arranger (song-timeline) body — card's ARR is richer than the device placeholder |
| 5 | CTRL | CC 95 | selects the new Control (deck) body |
| 6 | ↶ Undo | CC 96 | launchpad-scoped undo (see A.6) |
| 7 | ↷ Redo | CC 97 | launchpad-scoped redo |
| 8 | ⇧ Shift | CC 98 | **press-and-hold** modifier (A.5); also driven by keyboard-8 |

This unifies the card's ad-hoc `view` ('session'|'edit') + `arrangeMode` into a
single 4-view enum matching the device: `grid` (=session grid), `clip`
(=editor), `arranger` (=arrangement song view), `control` (=new deck). `SES/ARR`
+ double-click-to-edit + `back ‹` become the view buttons (kept as aliases for
back-compat / discoverability).

**Group 2 — Grid view additions:**
- **Scene-launch column** (NEW): one button per visible slot-row, right of the grid → fire that slot across all lanes (`applySceneLaunchWrite`). (The card comment already flags "the card has no scene-launch button yet.")
- **Scene-repeat SET** (NEW): promote the read-only flair to an editable stepper (click flair → small number popover, or shift+click a scene-launch button → count field). Replaces the device's HOLD-GRID+HOLD-scene gesture with a mouse-native control.
- **Scene-window scroll** (NEW): up/down affordance to reach scenes ≥ 8 (`sceneScrollOffset`, `slotForScene`, `maxSceneScrollOffset`). Card currently shows only slots 0–7.
- **Copy / Paste / Paste-rev (clip)** + **Copy / Paste (scene)** (NEW): a small function bar shown under Shift (or always-visible in a "clip ops" tray). Uses the typed `CopyBuffer` (clip|scene) + `writeClipWithAuto` / `pasteSceneInto`.
- **Clip-Div (per-clip rate)** (NEW): a per-clip division control (distinct from per-lane RATE) — shift+click a pad cycles `clip.div`, or a context control on the selected clip.
- **Swing ±** (NEW): per-channel swing nudge (`laneSwing`/`clampSwing`) for the selected lane, with a small meter.
- **NOW** (already: shift-click = immediate) — surface an explicit sticky NOW toggle so it matches the device's `nowHeld`.

**Group 3 — Clip (editor) view additions:**
- **DOUBLE** (NEW): `doubleNoteClip` button in the editor head.
- **FOLLOW** toggle (NEW): `followOn` — freeze/track the playhead window (the card currently always shows all cols; add for parity + long clips).
- **KEYS** entry (NEW): opens the KEYS sub-view (Group 4).
- **Velocity-edit mode** (parity): a Shift-mode where a plain click cycles velocity (the device's shift-in-Clip), complementing the existing right-click.
- Step-scroll: card shows up to 16 cols; only needed if a clip is > 16 steps → add a step-window scroller for long clips (parity with `stepLeft/stepRight`).

**Group 4 — KEYS sub-view (NEW, the largest piece):**
- On-screen isomorphic **keyboard** (playable with mouse; drives `pushAudition`), **QUEUE-REC**, **OVERDUB**, **OCT ±**, **PANIC**, **LEN**, a **playhead strip**.
- **Scale-select** row (`keysScaleRight`) + **ARP** controls (`arpToggle`, div/dir/range/latch via `arp-engine`).
- Reuses `clip-record` (`recordNoteAt`/`extendRecordedNote`/`clearStep`) and `arp-engine` exactly as the device does.

**Group 5 — Control (deck) view additions:**
- **Per-lane MUTE** (NEW — the card has mono/rate/arm but **no mute**): `toggleMute`.
- **Per-lane STOP** (NEW dedicated buttons; card only stops by clicking a playing pad): `queueLane(lane,'stop')`.
- **Tempo ±** (NEW): `nudgeTempo` on TIMELORDE.
- RESET, REC, SONG already exist (surface them in the Control body too).

**Group 6 — Permanent modifiers/overlays:**
- **Shift** (Group 1 #8) — see A.5.
- **Per-lane automation arm** — already on the card as ◉ (direct); the device's "shift+column" gesture is a superset the card already covers. Keep ◉; no shift gesture needed on the card.
- **Undo / Redo** — see A.6.

### A.4 Proposed card layout
```
┌ CLIP PLAYER ─────────────── [S&H] ──────────────┐
│ CONTROL STRIP (keyboard 1–8):                    │
│  [1 ▶] [2 GRID] [3 CLIP] [4 ARR] [5 CTRL]        │
│  [6 ↶] [7 ↷] [8 ⇧]           (active view lit)   │
├──────────────────────────────────────────────────┤
│ VIEW BODY (one of):                              │
│                                                  │
│ GRID: [scene◄►scroll]                            │
│   8×8 launch matrix  │ scene-launch column       │
│   per-lane: color / mono / rate / arm ◉ (as now) │
│   Shift tray: COPY PASTE P-REV | DIV SWING± LEN  │
│               NOW  | SCENE-COPY SCENE-PASTE      │
│   STEP OCT GATE QNT RST                          │
│                                                  │
│ CLIP: [‹ back] scale root len DOUBLE FOLLOW KEYS │
│   piano-roll (shift = velocity)  oct/row/step nav│
│   NOW  QUEUE   CLR  CLR-AUTO                      │
│                                                  │
│ KEYS: playhead strip                             │
│   keyboard grid   │ scale-select / arp (shift)   │
│   QREC OVERDUB OCT± PANIC LEN                     │
│                                                  │
│ ARR: song timeline (existing) + tools            │
│                                                  │
│ CTRL: RESET | per-lane MONO MUTE RATE STOP       │
│   TEMPO − +   STOP-ALL   REC  SONG               │
└──────────────────────────────────────────────────┘
```
The control strip is the anchor for Part B. Everything else is a view body; the
active view button lights (mirrors `RGB_VIEW_ACTIVE` on the device).

### A.5 Shift on the card
- A card-local `let shiftHeld = $state(false)`.
- Set true on: on-card Shift button `pointerdown` (cleared on `pointerup`/`pointerleave`), OR keyboard-8 keydown (cleared on keyup) — see Part B.
- Mirrors the device: **momentary hold, no latch**.
- While held, view bodies reveal their alternate palette (Grid → ops tray/scene column shifts to functions; Clip → velocity-edit; KEYS → arp column) and pad clicks read `shiftHeld` (e.g. Grid shift-click = NOW).
- Back-compat: the physical keyboard `Shift` key remains a NOW alias for pad clicks (`ev.shiftKey`), independent of the card Shift modifier.

### A.6 Undo/redo on the card
The device's undo (`lpUndo`) is an origin-tagged `Y.UndoManager` created in
`start()` for single mode only. For the card to drive the SAME buttons, factor
the undo manager out of `launchpad-control` into the shared action module
(`clip-actions.ts`) so it is created per-bound-node regardless of surface, and
both the card ↶/↷ and the device CC 96/97 call it. (Alternatively the card uses
the existing global app undo; but the owner asked for parity with the launchpad-
scoped undo — **OWNER Q**.)

---

## PART B — Keyboard 1–8 → the card's 8 top control buttons

### B.1 Focus / highlight model (which card owns 1–8)
A card is **keyboard-active** when BOTH:
1. it is the **single selected** flow node (svelte-flow `.selected`; if 0 or >1
   nodes are selected, no card owns 1–8 — avoids ambiguity), AND
2. it is a clip-player card.

Clicking anywhere inside a node keeps it selected in svelte-flow, so "hold 8,
then click a pad" keeps the card keyboard-active through the click. A visible
**highlight ring** (reuse the `.selected` accent glow, or add a subtle "1–8
active" chip on the control strip) tells the user which card owns the keys.

Rationale for selection (not hover / not raw DOM focus): hover is lost the
instant the pointer moves to the strip; raw focus is stolen by every control
click. Selection is the durable "this is the card I'm working with" signal and
already has a visual. (Optionally also accept `:focus-within` as a second
trigger — **OWNER Q**: selection-only, or selection OR focus-within.)

### B.2 Listener + hold semantics
- Install a **window-level `keydown` + `keyup`** listener (capture phase) in a
  `$effect` that runs only while the card is keyboard-active (add on activate,
  remove on deactivate / unmount).
- On `keydown` where `e.key` ∈ `'1'..'8'`:
  - **Guard** (B.3) — bail if typing into an editable target or a non-shift
    modifier (Ctrl/Cmd/Alt) is down.
  - `e.preventDefault(); e.stopPropagation();` (own the digit so it doesn't
    reach flow / browser).
  - **Momentary buttons (1–7):** act on the FIRST keydown only. **Suppress
    key-repeat**: if `e.repeat` → ignore. (transport/views/undo/redo fire once
    per physical press.)
  - **Shift (8):** `keydown` → `shiftHeld = true`; `keyup` → `shiftHeld =
    false`. This is the HOLD. Ignore `e.repeat` on the down edge (don't re-fire).
- **Stuck-shift guards (critical):** when shift becomes held, also register
  one-shot `window` `blur` + `document` `visibilitychange` handlers that
  force-release shift, and keep the `keyup` listener at window/capture so a
  keyup that lands after focus moved into a form control still releases. On card
  deactivation while shift is held, force-release. (Missing keyup is the classic
  stuck-modifier bug — the launchpad's own `handleShift` only trusts the CC
  edge; the card must synthesize the release on focus loss.)

### B.3 Coexistence with text inputs (don't hijack typing)
Skip the mapping (let the key pass through) when the event target OR
`document.activeElement` is editable:
```
input:not([type=color]):not([type=range]), textarea, select, [contenteditable=""], [contenteditable="true"]
```
Specifically the module **title** (`ModuleTitle` inline rename), the per-lane
**color** inputs, and the per-lane **rate** selects. Color/range inputs don't
consume digit keys meaningfully, but skipping when focused is the safe,
predictable rule. Also skip when `e.metaKey || e.ctrlKey || e.altKey` (leave
OS/browser/app shortcuts — cmd-1, etc. — alone). Shift is NOT excluded (shift-8
is not a thing here; digit keys are unmodified).

### B.4 Exact mapping
`1`→Transport · `2`→GRID · `3`→CLIP · `4`→ARR(anger) · `5`→CTRL · `6`→Undo ·
`7`→Redo · `8`→Shift(hold). Identical order to CC 91–98.

### B.5 Pitfalls (called out)
- **Stuck shift** on blur / lost keyup → force-release (B.2).
- **Key-repeat** re-firing view switches / undo storms → `e.repeat` guard.
- **Multi-select ambiguity** → require exactly one selected card.
- **Typing hijack** → editable-target guard (B.3).
- **svelte-flow shortcut collision** → digits are unused by flow today (verified:
  no digit handling in `Canvas.svelte`), but capture-phase + `stopPropagation`
  insulates against future ones.
- **Two clip-player cards** both selected → neither owns 1–8 (by design).

---

## PART C — Dual-Launchpad rework (two independent single-pad controllers)

### C.1 New premise
Retire today's owner-locked **L=matrix / R=deck** split. In dual mode BOTH pads
are **independent single-pad controllers of the SAME clip node**, each running
the full single-pad surface (Part 0). One pad can be in Clip while the other is
in Grid; each has its own view, shift, arm, scroll, editor window, KEYS, arp.
Only the synced `node.data` is shared. The lone exception is the **combined
16-step view** (C.5).

### C.2 Per-controller state (the refactor's core)
Today the single-mode surface uses **module-level singletons** in
`launchpad-control.svelte.ts`. The rework promotes these into a per-controller
struct instantiated **twice** (one per unit). Fields to move into `CtrlState`
(currently module vars):

| module var (today) | role |
|---|---|
| `singleView` | active view |
| `mode` (`session`/`edit`/`lengthEdit`/`keys`) | sub-mode |
| `selectedClipIndex`, `editClipIndex` | edit target |
| `shiftHeldSingle` | momentary shift |
| `armedRightAction`, `armTick`, `divPreview` | grid-shift arm + div preview |
| `sceneScrollOffset` | scene window |
| `editRowOffset`, `editWindowStart`, `followOn` | editor window |
| `gridHeldSingle`, `repeatViewHeld` | repeat-count hold |
| `lastTapClipIndex/Tick/PrevQueued/WasPlaying` | double-tap tracker |
| `swingMeterActive`, `swingMeterDir` | swing meter |
| `lengthReturnMode`, `lengthReturnView` | length-edit return |
| `keys*` (`keysClipIndex`, `keysPressed`, `keysOnsets`, `keysPrevStep`, `keysStopAtWrap`, `keysOctaveShift`, `keysRecHeld`, `keysOverdubHeld`) | KEYS transient |
| `arp`, `arpOn`, `arpNextTime` | arp |

Every handler (`handleSingleKey`, `handleTopRow`, `handleSingleGrid/Clip/Keys/Control`,
`handleRLength`, `renderLeds`) becomes a **method that takes a `CtrlState` +
target `unit`**. The pure classifiers/frames in `launchpad-map.ts` are already
unit-agnostic (they build a `LaunchpadFrame`; the caller does `setFrame(unit,
frame)`) — they need **no change** except passing the target unit to
`computeSingleKeysFrame` (currently hardcodes `unit:'L'`; make it a param) and
the render loop calling `setFrame(unit, …)` per controller.

### C.3 Shared vs per-controller resources (decisions + OWNER Qs)
| resource | proposal |
|---|---|
| `node.data` (clips/queued/playing/mono/mute/rate/swing/color/rec/clipMode/arrangement/auto/sceneRepeats/resetNonce) | **SHARED** (both write; existing rebuild-and-assign seams are last-writer-wins per field) |
| copy buffer (`copyBuffer`/`bufferSourceIndex`) | **SHARED** (one machine clipboard) → copy on one pad, paste on the other. **OWNER Q** (shared vs per-pad) |
| undo (`lpUndo`) | **SHARED** (one launchpad-origin UndoManager; both pads' persistent edits are captured) |
| `noteRec` (KEYS record) | single per node → only ONE pad records at a time; second KEYS entry **retargets/steals** `noteRec`. **OWNER Q** (allow parallel KEYS? or block second entry?) |
| `arp` | per-controller (each pad's KEYS has its own arp) — but see noteRec constraint |
| tick / blink phase | shared render loop drives both controllers each tick |

### C.4 Routing + painting
- `handleKey(e)` in dual mode: pick the controller by `e.unit` → `handleSingleKey(ctrl[e.unit], e.unit, e)`. No more `handleL`/`handleR`.
- `renderLeds()` in dual mode: for each unit, paint that controller's active-view frame (`computeSingle{Grid,Clip,Keys,Control,Arranger}Frame` / `computeRLengthFrame` + `paintPermanentTopRow`) via `setFrame(unit, …)`. Combined view (C.5) is a special paint that spans both.
- Persistence: per-unit view keys (`pt.launchpad.activeView.L` / `.R`) instead of the single `STORAGE_KEY_VIEW`. Deployment stays `pair` (or rename → `dual`).

### C.5 COMBINED 16-step view (the exception)
**Purpose:** show 16 steps of ONE clip at once across the two pads.

**Trigger:** while in **CLIP** view on EITHER controller, **double-tap the CLIP
top-row button** (CC 93). Detection mirrors the grid double-tap: per-controller
`lastClipBtnTick`; two CC-93 presses within `DOUBLE_TAP_TICKS` → enter combined.
(First press switches to/stays Clip; second within the window → combined.)

**Target clip:** the triggering controller's `selectedClipIndex` becomes the
**combined target**; the other controller adopts it. (**OWNER Q**: adopt vs keep
each pad's own selection — combined implies one shared clip, so adopt.)

**Layout (two pads placed L | R):**
```
[ L 8×8: steps 0–7 ] [ L scene col = MIDDLE, STUB ] [ R 8×8: steps 8–15 ] [ R scene col = clipRight ]
```
- **L 8×8** = the note grid for window steps **0–7** (colOffset = block start).
- **R 8×8** = the note grid for window steps **8–15** (colOffset + 8). Same 8
  pitch rows on both (rowOffset shared from the combined target).
- **L (middle) scene column = STUBBED** — dark, no-op. *Future work:* a
  **sequence-timing display** (per-step timing / swing / ratchet lane readout).
  Mark clearly as a reserved stub.
- **R (far) scene column = `clipRight`** for the combined clip: `double` ·
  `lengthEdit` · `follow` · `keys` · `rowUp` · `rowDown` · `stepLeft` ·
  `stepRight` (step nav now moves the 16-step window by ±16 / ±1 block).
- **BOTH top rows live** (transport / views / undo / redo / shift on each pad).
- **Shift from either (or both)** applies to the combined editor:
  `combinedShift = ctrl.L.shift || ctrl.R.shift` (velocity-edit + page/block
  jump honor it). Per-lane arm overlay still works from each pad's shift+column.

**Note-edit mapping:** a pad press on L at (x,y) edits `{step = winStart + x,
midi = row(y)}`; on R edits `{step = winStart + 8 + x, midi = row(y)}`. Reuse
`editPadToNote` with the per-unit colOffset; span-drag across the L|R seam is a
**stretch goal** (anchor on L, release on R) — **OWNER Q** (support cross-pad
spans now, or keep spans within one pad?).

**Exit conditions (drop out of combined → back to independent):**
1. **Any view-button press** (Grid/Clip/Arr/Ctrl) on EITHER controller. The
   acting pad goes to the pressed view; the OTHER pad **restores the view it had
   before combined** (snapshot on enter). (**OWNER Q**: restore-previous vs
   leave the other pad in Clip.)
2. `keys` pressed in the R clip-right column → drops combined and enters KEYS on
   the triggering pad (other restores). (**OWNER Q**: or stub `keys` inside
   combined.)
3. Unbind / rebind / deployment change; or the combined clip vanished (paint
   returns false).

**Other controller's state on ENTER:** snapshot both controllers' `{view, mode,
selectedClipIndex, editor window}`. Force both into the combined clip editor. If
either pad was in KEYS/length-edit, force-exit it first (flush KEYS notes) —
combined requires the note editor. (**OWNER Q**: block combined-entry while the
other pad is mid-KEYS-record instead of stealing?)

**On EXIT:** restore the non-acting pad's snapshot; the acting pad goes where it
asked. Clear the combined flag.

### C.6 State machine

```mermaid
stateDiagram-v2
    [*] --> Independent

    state Independent {
        note right of L_view
          Each pad has its OWN view.
          L and R are fully independent.
        end note
        state "Pad L: Grid/Clip/Arranger/Control (+KEYS/Length sub-modes)" as L_view
        state "Pad R: Grid/Clip/Arranger/Control (+KEYS/Length sub-modes)" as R_view
        L_view --> L_view : any pad-L input (own CtrlState)
        R_view --> R_view : any pad-R input (own CtrlState)
    }

    Independent --> Combined : double-tap CLIP btn (CC93) on EITHER pad while THAT pad is in CLIP\n(snapshot both pads' view/mode; adopt triggering pad's selectedClip)

    state Combined {
        note right of comb
          ONE clip, 16 steps:
          L 8x8 = steps 0-7, R 8x8 = steps 8-15
          L(middle) scene col = STUB (future: seq-timing display)
          R(far) scene col = clipRight
          both top rows live; shift = L.shift OR R.shift
        end note
        state "16-step editor across L+R" as comb
    }

    Combined --> Independent : ANY view button on EITHER pad\n(acting pad -> pressed view; other pad -> restore snapshot)
    Combined --> KEYS_exit : R clip-right KEYS pressed\n(drop combined, enter KEYS on triggering pad)
    Combined --> Independent : unbind / rebind / clip vanished
    KEYS_exit --> Independent

    note left of Independent
      Shared across both pads:
      node.data, copy buffer, undo,
      noteRec (single-writer).
    end note
```

### C.7 Migration from today's pair-mode
**Retire / repurpose:**
- `handleL`, `handleR`, `handleRDeck`, `handleREdit` pair routing (replaced by two `handleSingleKey` controllers). `handleRLength` becomes per-controller.
- Pair frames: `computeLSessionFrame(... lTopMute)` (the L matrix + per-lane MUTE top row) and `computeRDeckFrame` (the command deck) — replaced by the single-mode per-view frames on each unit. Keep `computeLSessionFrame` core if reused, but the pair-only `lTopMute`/deck paths go dead.
- Pair KEYS 16-wide keyboard (`computeKeysFrame` with `KEYS_PH_CELLS`=16 spanning L|R): the NEW combined view is a 16-step **editor**, not the old 16-wide keyboard. Decide whether the old dual-KEYS keyboard survives as a per-pad 8-wide KEYS (yes — single-mode KEYS already is 8-wide) or is removed. **OWNER Q**: is a 16-wide dual KEYS keyboard still wanted, or is combined-editor the only 16-wide surface?
- `startPairing`'s L/R semantics: the press-a-pad handshake still resolves which physical unit is L vs R (needed for per-unit persistence + the combined L|R placement), but L/R no longer implies matrix/deck — just "left pad / right pad" placement.
- Sim + tests: `installSimulatedLaunchpad` driver (`pressL`/`pressR`/`ccL`/`ccR`) stays, but the **semantics change** — `pressL(x,y)` now hits pad L's *active view* (default Grid: x=lane, y from bottom). The poly **real-source-chain** e2e (MIDI-LANE/matrix → clip → RMS) that relies on `pressL` launching a clip must be updated to set pad L to Grid first (default) and use the single-grid transpose. VRT baselines for the pair (matrix vs deck) are replaced by per-view frames.

**Keep unchanged:** device layer (`launchpad-device.svelte.ts`) per-unit binding, the pairing handshake, `clip-surface-map`, all `node.data` seams, single-mode classifiers/frames (they become the dual per-pad renderers).

---

## Effort estimate (phased, design→ship)

| phase | scope | estimate |
|---|---|---|
| 0 | Factor shared `clip-actions.ts` (node-id-parameterized action seams + undo) | 0.5–1 d |
| A1 | Card control strip (8 buttons) + 4-view refactor of the card body | 1–1.5 d |
| A2 | Grid additions: scene-launch, scroll, scene-repeat set, copy/paste (clip+scene), clip-div, swing, NOW | 1.5–2 d |
| A3 | Clip additions: double/follow/velocity-mode/step-scroll | 0.5 d |
| A4 | KEYS sub-view on card (keyboard + record + scale + arp) — heaviest | 1.5–2 d |
| A5 | Control view on card (mute/stop/tempo + deck) | 0.5–1 d |
| B | Keyboard 1–8 focus model + hold + guards + tests | 1 d |
| C1 | Per-controller state refactor (module singletons → `CtrlState`×2, routing, painting, persistence) | 2–3 d |
| C2 | Combined 16-step view (frame + handler + state machine) | 1.5–2 d |
| C3 | Retire pair code + migrate sim/e2e/VRT + unit tests | 1.5–2 d |
| — | 3× flake-check new/changed tests, typecheck, docs gate, review | 1 d |
| **total** | | **~13–18 days** (≈3 weeks focused) |

Parts A and C can proceed in parallel (different files) once phase 0 lands. B
depends on A1 (the strip must exist).

---

## Risks
- **Independent-dual-state refactor (C1)** is the highest-risk change: the
  single-mode state is deeply woven as module-level vars across ~40 functions.
  Threading a `CtrlState` handle through every handler + render path is a large
  diff with real regression surface. Mitigation: encapsulate the transient state
  + methods in a `Controller` class, instantiate twice, keep pure classifiers/
  frames untouched; land behind the existing `deployment` switch so single mode
  is unaffected until dual is flipped.
- **Keyboard-capture pitfalls (B):** stuck shift on lost keyup/blur, typing
  hijack, key-repeat storms, multi-select ambiguity. All have explicit guards
  above; the stuck-modifier release-on-blur is the one most likely to be missed.
- **Shared-write races:** two pads editing the same clip's div/swing (per-pad
  local previews that commit independently) can clobber each other on the same
  clip; the array-rebuild seams are last-writer-wins. Document that the last
  commit wins; consider a per-clip guard if it bites.
- **Parallel KEYS / arp:** `noteRec` is single-per-node; two pads recording at
  once is undefined. Proposal blocks/steals; needs an owner decision.
- **Combined-view seam complexity:** double-tap detection on a *view button*
  (not a pad) + snapshot/restore of the OTHER pad + cross-pad span edits. Keep
  cross-pad spans a stretch goal to contain scope.
- **Test/VRT migration:** the pair L=matrix/R=deck baselines + the poly real-
  source-chain e2e (`pressL` launches a clip) break under the new routing.
  Per repo standard (poly-modules-test-real-source-chain) the MIDI-LANE→module→
  RMS chain MUST stay green — update the sim driver + spec to drive pad L in Grid
  view. Budget CI wall-time (>2 min needs sign-off).
- **Card size / VRT determinism:** the card grows a lot (control strip + view
  bodies + KEYS keyboard). The 3u tier has room, but VRT card baselines will
  churn; keep fixed-integer geometry (the card comment already notes this for
  the scene-flair). New card = full `task test` + `task vrt` + docs manifest
  (`DESCRIPTIONS`/`STRICT_DOCS`) per repo standards.

---

## OWNER QUESTIONS
1. **Undo scope on the card:** launchpad-scoped undo (factor `lpUndo` to shared) or the global app undo for the card's ↶/↷?
2. **Keyboard focus trigger:** single-selected node only, or also `:focus-within`?
3. **Card parity depth:** faithfully mirror **shift** (fewer buttons, shift reveals palettes) — as specced — or expose every function as an always-visible button (bigger card, no shift dependence)?
4. **Copy buffer in dual mode:** one shared machine clipboard (copy on L, paste on R) or per-pad buffers?
5. **Parallel KEYS:** allow both pads in KEYS at once (needs per-pad noteRec/arp — a bigger change), block the second entry, or let the second steal `noteRec`?
6. **Combined target clip:** adopt the triggering pad's `selectedClip` (as specced) or require both pads to already be on the same clip?
7. **Combined exit — other pad:** restore its pre-combined view (as specced) or leave it in Clip?
8. **`keys` inside combined:** drop combined + enter KEYS (as specced), or stub the keys button while combined?
9. **Cross-pad note spans in combined:** support anchor-on-L / release-on-R spans now, or keep spans within one pad for v1?
10. **Dual KEYS keyboard:** is a 16-wide dual-pad KEYS keyboard still wanted, or is the combined 16-step **editor** the only cross-pad surface (per-pad KEYS stays 8-wide)?
11. **Rename `deployment` `'pair'` → `'dual'`** to reflect the new independent-controllers premise (persistence-key migration), or keep `'pair'`?
```
