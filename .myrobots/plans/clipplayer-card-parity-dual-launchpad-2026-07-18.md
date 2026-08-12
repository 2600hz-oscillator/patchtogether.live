# Clip-player card parity + dual-Launchpad rework — DESIGN

**Date:** 2026-07-18
**Status: PARTS A + B SHIPPED (#1100). PART C IS NOT BUILT — it is the whole live remainder.**

> **TRIAGE.** **#1100** ("card parity control strip + keyboard 1-8 (Parts A+B)",
> merged 2026-07-18) built PART A (full card parity with the single-pad Launchpad)
> and PART B (computer-keyboard 1–8 → the 8 top control buttons, with hold). Both
> sections have been removed from this file; read the shipped code.
>
> **PART C — the dual-Launchpad rework (two independent single-pad controllers +
> the combined 16-step view) — was NOT built.** Confirmed in the tree:
> `launchpad-control.svelte.ts` still imports the `// L matrix (pair)` frame
> helpers, and `let deployment: 'pair' | 'single' = 'pair'` with module-level
> `singleView` / `selectedClipIndex` singletons is unchanged. Part C is gated on
> ~10 unanswered owner questions, collected at the end.
>
> ⚠ **§0 is a SNAPSHOT of the single-pad surface at 2026-07-18. RE-VERIFY EVERY
> EXACT CC / PAD NUMBER AGAINST `launchpad-map.ts` BEFORE BUILDING.** At least four
> changes post-date it: scene repeats (**#1091**), the SHIFT hold-only fix
> (**#1094**), the KEYS stuck-gate fix (**#1423**) and right-click Delete clip
> (**#1427**). §0 is kept because it is the only written enumeration of the surface
> Part C has to instantiate twice — not because its numbers are current.

**Files in play (all under `packages/web/src/lib/`):**
- `control/launchpad/launchpad-control.svelte.ts` — the stateful control brain (single + pair).
- `control/launchpad/launchpad-map.ts` — Launchpad placement + colour + single-mode classifiers/frames + pair L/R frames.
- `control/launchpad/launchpad-device.svelte.ts` — Web-MIDI device singleton, per-unit (L/R) binding.
- `control/launchpad/launchpad-sysex.ts` — pure byte codec (CC 91–98 top row, SCENE_CCS, padNote).
- `control/clip-surface-map.ts` — controller-agnostic clip brain (index math, note math, length classifier).
- `ui/modules/ClipplayerCard.svelte` — the card UI.
- `ui/modules/LaunchpadControlCard.svelte` — the Launchpad connect/pair/single/view UI.

---

## 0. The single-pad control surface, enumerated (SNAPSHOT — re-verify)

The union of the **permanent top row** (owned first in every view) + the four
**views** + the **KEYS** sub-view + the **length-edit** takeover. Source:
`handleSingleKey` and the classifiers in `launchpad-map.ts`.

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
  - **double-tap** the same clip = select it + open Clip view, **reverting the lane's play/queue intent** (owner rule).
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

## PART C — Dual-Launchpad rework (two independent single-pad controllers)

### C.1 New premise
Retire today's owner-locked **L=matrix / R=deck** split. In dual mode BOTH pads
are **independent single-pad controllers of the SAME clip node**, each running
the full single-pad surface (§0). One pad can be in Clip while the other is
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
- Pair KEYS 16-wide keyboard (`computeKeysFrame` with `KEYS_PH_CELLS`=16 spanning L|R): the NEW combined view is a 16-step **editor**, not the old 16-wide keyboard. **OWNER Q**: is a 16-wide dual KEYS keyboard still wanted, or is combined-editor the only 16-wide surface (per-pad KEYS stays 8-wide)?
- `startPairing`'s L/R semantics: the press-a-pad handshake still resolves which physical unit is L vs R (needed for per-unit persistence + the combined L|R placement), but L/R no longer implies matrix/deck — just "left pad / right pad" placement.
- Sim + tests: `installSimulatedLaunchpad` driver (`pressL`/`pressR`/`ccL`/`ccR`) stays, but the **semantics change** — `pressL(x,y)` now hits pad L's *active view* (default Grid: x=lane, y from bottom). The poly **real-source-chain** e2e (MIDI-LANE/matrix → clip → RMS) that relies on `pressL` launching a clip must be updated to set pad L to Grid first (default) and use the single-grid transpose. VRT baselines for the pair (matrix vs deck) are replaced by per-view frames.

**Keep unchanged:** device layer (`launchpad-device.svelte.ts`) per-unit binding, the pairing handshake, `clip-surface-map`, all `node.data` seams, single-mode classifiers/frames (they become the dual per-pad renderers).

---

## Effort estimate (Part C only)

| phase | scope | estimate |
|---|---|---|
| C1 | Per-controller state refactor (module singletons → `CtrlState`×2, routing, painting, persistence) | 2–3 d |
| C2 | Combined 16-step view (frame + handler + state machine) | 1.5–2 d |
| C3 | Retire pair code + migrate sim/e2e/VRT + unit tests | 1.5–2 d |
| — | 3× flake-check new/changed tests, typecheck, docs gate, review | 1 d |

---

## Risks

- **Independent-dual-state refactor (C1)** is the highest-risk change: the
  single-mode state is deeply woven as module-level vars across ~40 functions.
  Threading a `CtrlState` handle through every handler + render path is a large
  diff with real regression surface. Mitigation: encapsulate the transient state
  + methods in a `Controller` class, instantiate twice, keep pure classifiers/
  frames untouched; land behind the existing `deployment` switch so single mode
  is unaffected until dual is flipped.
- **Shared-write races:** two pads editing the same clip's div/swing (per-pad
  local previews that commit independently) can clobber each other on the same
  clip; the array-rebuild seams are last-writer-wins. Document that the last
  commit wins; consider a per-clip guard if it bites.
- **Parallel KEYS / arp:** `noteRec` is single-per-node; **two pads recording at
  once is undefined.** The proposal blocks or steals; it needs an owner decision.
- **Combined-view seam complexity:** double-tap detection on a *view button*
  (not a pad) + snapshot/restore of the OTHER pad + cross-pad span edits. Keep
  cross-pad spans a stretch goal to contain scope.
- **Test/VRT migration:** the pair L=matrix/R=deck baselines + the poly real-
  source-chain e2e (`pressL` launches a clip) break under the new routing.
  Per repo standard (poly-modules-test-real-source-chain) the MIDI-LANE→module→
  RMS chain MUST stay green — update the sim driver + spec to drive pad L in Grid
  view. Budget CI wall-time (>2 min needs sign-off).

---

## OWNER QUESTIONS — Part C is blocked on these

1. **Copy buffer in dual mode:** one shared machine clipboard (copy on L, paste on R) or per-pad buffers?
2. **Parallel KEYS:** allow both pads in KEYS at once (needs per-pad noteRec/arp — a bigger change), block the second entry, or let the second steal `noteRec`?
3. **Combined target clip:** adopt the triggering pad's `selectedClip` (as specced) or require both pads to already be on the same clip?
4. **Combined exit — other pad:** restore its pre-combined view (as specced) or leave it in Clip?
5. **`keys` inside combined:** drop combined + enter KEYS (as specced), or stub the keys button while combined?
6. **Cross-pad note spans in combined:** support anchor-on-L / release-on-R spans now, or keep spans within one pad for v1?
7. **Dual KEYS keyboard:** is a 16-wide dual-pad KEYS keyboard still wanted, or is the combined 16-step **editor** the only cross-pad surface (per-pad KEYS stays 8-wide)?
8. **Block combined-entry while a length-edit or KEYS-record is active** on the other pad, instead of force-exiting it?
9. **Rename `deployment` `'pair'` → `'dual'`** to reflect the new independent-controllers premise (persistence-key migration), or keep `'pair'`?
10. **Undo scope:** the card's ↶/↷ currently needs a decision that also governs dual — launchpad-scoped undo (factor `lpUndo` into a shared, per-bound-node action module both surfaces import) or the global app undo?
11. **Keyboard focus trigger** (Part B, shipped as selection-only): single-selected node only, or also `:focus-within`?
