# Driving SONG mode (REC + SES⇄ARR) from the monome grid — FINAL recommendation

**Status:** design + docs only (NO source changes). Implementation-ready spec for owner accept/reject.
**Date:** 2026-06-19. Supersedes PROPOSAL-v1.md after a 3-lens adversarial review (gesture-conflict,
first-class-docs, launchpad-coherence). Every blocker raised is resolved below with file:line, and
two design changes were made as a result (the read-out scope shrank; the ARR LED level changed).

Goal: give a device-first performer an on-grid home for the two card-only SONG controls — **REC**
(arm arrangement recording) and **SES ⇄ ARR** (flip the playback transport between live SESSION and
the recorded ARRANGEMENT) — plus a standing read-out of record/song state, on the monome 16×8,
without colliding with any shipped gesture; and keep it coherent with the 2× Launchpad command deck.

All file:line + constants below were re-verified against the working tree (= `origin/main`) on
2026-06-19.

---

## 0. What changed from v1 (the adversarial pass moved the design)

| v1 said | Review found (file:line) | FINAL decision |
|---|---|---|
| Read-out = 4-pad fuel-gauge **+ 2-pad playhead tick** on `(9,2..7)` | The tick needs `songBeat`, which the card reads via `engineCtx.get()`→`e.read(node,'songBeat')` (ClipplayerCard.svelte:230,240); `engineCtx = useEngine()` is a Svelte **component context** (`:23,74`). The binding is a plain `.svelte.ts` with **no engine-context import** (imports end at `clip-playhead`'s `getLanePlayhead`, grid-clip-binding.svelte.ts:82) and reads only `node.data` in `renderLeds` (`:491`). The tick has **no data source today** — net-new plumbing, not a "small wiring add". | **DROP the playhead tick from v1.** Read-out = the **4-pad fuel-gauge only**, driven by `arrangement.events.length` which **is** on `node.data`. The tick becomes an explicit OPEN QUESTION / phase-2 (§OQ-1). |
| "Tapping `(9,y)` for y∈{0,1} only acts when songHeld; `(9,2..7)` are render-only no-ops." | `sceneSlotForPad` returns a valid slot for **any** `(9,y)` y∈[0,8) (grid-clip-map.ts:139-141), and that branch runs **after** the `if (e.s !== 1) return` guard (grid-clip-binding.svelte.ts:405) and fires a full scene. So `(9,2..7)` are **NOT** no-ops — brushing a gauge pad while holding SONG would fire scenes 2..7. | **Gate the ENTIRE col-9 (rows 0-7) under `songHeld`, BEFORE the `sceneSlotForPad` branch** (insert at grid-clip-binding.svelte.ts ~`:466`). Rows 0/1 = toggles; rows 2-7 = explicit no-op (early `return`) so they cannot fall through to scene-launch. Spelled out as a hard impl note (§5.2). |
| ARR (both on `(9,1)` and the resting `(15,1)`) lights at `LED_TRANSPORT_ON`(15). | `LED_TRANSPORT_ON=15` is **the same constant TRANSPORT-running uses** (grid-clip-map.ts:54,328-330). `(15,1)`-ARR-steady-15 sits two pads above TRANSPORT `(15,7)`-steady-15 → ARR and transport become brightness-indistinguishable in col 15, and the cross-controller legend breaks (launchpad ARR = white/distinct from transport-green). | **ARR gets its OWN level: `LED_QUEUED_HI`(12)** (a distinct mid-bright, not 15, not the transport family). New shared-legend row "arrangement-active" distinct from "transport-running". (§4.4, §7.1) |
| "Reuses the established hold-modifier idiom." | True for the **edge handling** (act on both edges like COPY/PASTE, grid-clip-binding.svelte.ts:398-403), but the existing modifiers reveal their action **on the matrix the hand is already on** (cols 0-7); SONG reveals on **col 9**, spatially disjoint from `(15,1)`. The reveal is real but does **not** inherit the matrix muscle-memory. | **Kept primary, with honest framing** (it is "hold-to-reveal", not "hold-then-tap-the-same-region") **and an elevated one-handed fallback** the owner can pick instead (§OQ-2). The decisive mitigation: the standing `(15,1)` indicator (§4.3) means you read record/ARR state with **zero gesture** — the part that most needs to be one-glance is. |

Net: the design is **leaner and safer** — one read-out band instead of two, a collision-proof
col-9 gate, and an ARR LED that's distinct from transport. Nothing was added.

---

## 1. Ground truth (file:line)

### 1.1 The SONG model (shared engine, controller-agnostic) — `clip-arrange.ts`
- `ClipPlayMode = 'session' | 'arrangement'` (`:48`).
- `ArrangeData { events: ArrangeEvent[]; lengthBeats; loop }` (`:37-45`); each `ArrangeEvent {
  beat, lane, slot, immediate? }` is a launch timestamped at the song-beat it **applied** (`:23-35`).
- `hasArrangement(data)` = "≥1 recorded launch" (`:140-142`); `arrangeLengthBeats(data,4)` = loop
  length, rounded up to a bar when not explicit (`:121-126`).
- Synced state on `node.data`: **`clipMode`**, **`recording`**, **`arrangement`**.

### 1.2 The card-only controls we're relocating — `ClipplayerCard.svelte`
- `recording = dataObj().recording === true` (`:257`); `arrangeMode = dataObj().clipMode ===
  'arrangement'` (`:258`); `arrangeEvents = arrangement?.events?.length` (`:259-261`).
- `toggleRecord()` → `writeData(d => d.recording = !d.recording)` (`:264-266`); arming **clears the
  old arrangement and records fresh** (v1 = replace, not overdub) per the doc copy.
- `toggleArrangeMode()` → flips `d.clipMode` between `'arrangement'`/`'session'` (`:267-269`).
- `songBeatLive` is fed by `engineCtx.get()` → `e.read(node, 'songBeat')` (`:230,240-241`) where
  `engineCtx = useEngine()` (`:23,74`) — **a component context the binding can't call** (see §0).

**Key fact:** the grid **already records into the arrangement today** — every `queueLane()` write
the grid makes is captured by the engine when `recording` is on. The grid is only missing the
*ability to arm/flip/observe* that mode. This is a pure **control-surface** addition: two writes
(`d.recording`, `d.clipMode`) the grid can't reach yet, plus a node.data-only read-out. **No engine
change.**

### 1.3 The shipped monome SESSION pad census — `grid-clip-map.ts`
`GRID_WIDTH=16`, `GRID_HEIGHT=8` (`mext.ts`). `CTRL_STOP_COL=8`, `CTRL_SCENE_COL=9` (`:104-105`).

| Region | Coords | Role | Source |
|---|---|---|---|
| Clip matrix | cols 0-7 × rows 0-7 | launch/queue/stop (`y*8+x`) | `padToClipIndex` `:125-128` |
| STOP column | col **8**, rows 0-7 | per-lane stop | `CTRL_STOP_COL` |
| SCENE column | col **9**, rows 0-7 | scene launch (slot y all lanes) | `CTRL_SCENE_COL`, `sceneSlotForPad` `:139-142` |
| EDIT | **(15,0)** | hold + tap clip → editor | `EDIT_PAD` `:107` |
| **`(15,1)`** | **(15,1)** | **— UNUSED (the `_(1)` gap) —** | comment `:101-102` |
| COPY | **(15,2)** | hold + tap → copy | `COPY_PAD` `:108` |
| COPY-IND | **(15,3)** | render-only buffer indicator (pulses) | `COPY_IND_PAD` `:109` |
| PASTE | **(15,4)** | hold + tap → paste | `PASTE_PAD` `:110` |
| PASTE-REV | **(15,5)** | hold + tap → paste reversed | `PASTE_REV_PAD` `:111` |
| STOP-ALL | **(15,6)** | stop every lane | `STOPALL_PAD` `:112` |
| TRANSPORT | **(15,7)** | toggle `timelorde.running` | `TRANSPORT_PAD` `:113` |

**`(15,1)` is the ONE free pad in the occupied right cluster** — VERIFIED by the review: a session
tap on `(15,1)` falls through every classifier (`padToClipIndex`→null since x=15≥8; `stopLaneForPad`
x≠8; `sceneSlotForPad` x≠9; not stop-all/transport/edit) to a true no-op, and no `is*Pad` returns
true for it. Cols 10-14 (40 pads) are dark on purpose (clean margin). The clip matrix, STOP/SCENE
cols, and the EDIT-mode function row are all fully consumed.

### 1.4 The two sub-pages that exclude any other home
- **EDIT mode** (grid-clip-binding.svelte.ts:301-396): the whole 16×8 is the note grid; row 7 is the
  function row packed with `EDIT·VEL·_·ROW−·OCT−·_·ROW+·OCT+·_·SCALE·_·FOLLOW·◀·▶·DOUBLE·LEN`
  (grid-clip-map.ts:84-100). In EDIT, **`(15,1)` is a NOTE CELL** (a pitch row, step 15) and col 9
  rows 0-6 are note cells. So a SONG control cannot live in EDIT, **and** the standing `(15,1)`
  indicator (§4.3) physically cannot render while editing (documented limitation, §6.4).
- **LENGTH-EDIT page** (`:239-260`): clip-scoped 2-row length editor — not a song home.

⟹ SONG lives in **SESSION mode only** (the only mode where the launching you're recording happens),
using the lone free pad `(15,1)` + a temporary borrow of the scene column behind the hold.

---

## 2. Design goals
1. **No collision** with launch / STOP / SCENE / EDIT / COPY / PASTE / PASTE-REV / STOP-ALL /
   TRANSPORT / the EDIT function row / LENGTH-EDIT. (Pad-by-pad verified, §1.3.)
2. **Reuse the existing edge idiom** (act on both edges, like COPY/PASTE) — but be honest it is
   *hold-to-REVEAL* (col 9), not *hold-then-tap-the-same-region* (§0 row 4).
3. **Cheap on pads** — spend the one free pad; no new always-on column; cols 10-14 stay a clean margin.
4. **One-glance standing state** within brightness-only limits (record / SES / ARR readable with
   zero gesture).
5. **Composes, never surprises** — SESSION-only; coexists with COPY/PASTE held modifiers via a
   distinct flag + a distinct region (col 9 vs matrix).

---

## 3. Why the held layer over the alternatives (decision)

The single free pad is the whole constraint. The two realistic designs:

- **A — held SONG layer (PRIMARY).** Hold `(15,1)` → col 9's top two pads become REC `(9,0)` +
  SES⇄ARR `(9,1)`, and `(9,2..5)` show a 4-pad recorded-length gauge; release → col 9 snaps back to
  scene launch. Surfaces **both** controls **plus** a read-out for the same one-pad budget; the
  resting `(15,1)` shows record/ARR state with zero gesture (§4.3).
- **B — one-handed fallback.** `(15,1)` = dedicated SES⇄ARR tap-toggle; **long-press `(15,1)`** =
  toggle REC. One-handed, the action lives **at** the pad you press (the directness a label-less grid
  wants most), but REC hides on a timing gesture and there's no room for the gauge.

Rejected: held-TRANSPORT (TRANSPORT is a tap-toggle today, `isTransportPad` acts on press
grid-clip-map.ts:120-122 → overloading it is surprising); double-tap/long-press TRANSPORT (hidden
chord — repo standard forbids it); a dedicated SONG sub-page (collapses to A's entry + adds a 4th
top-level mode); a permanent dark-col SONG column (turns the clean margin into label-less "buttons",
8 pads for 2 controls); hold-COPY+scene (overloads a frequent real gesture).

**Recommendation: A, primary; B held in reserve as a clean one-tap escape hatch.** The review
correctly noted A trades directness for capability; the mitigation is the §4.3 standing indicator,
which makes the most-glanceable need (am I armed? am I in ARR?) zero-gesture regardless. **The
held-vs-one-handed choice is OQ-2 — if the owner wants SES⇄ARR one-tap mid-set, pick B.**

---

## 4. PRIMARY DESIGN — the held SONG layer (implementation-ready)

### 4.1 The entry pad `(15,1)`
- New `SONG_PAD = { x: GRID_WIDTH - 1, y: 1 }` → `(15,1)`.
- **Press-and-HOLD modifier, acting on BOTH edges** exactly like COPY/PASTE/PASTE-REV
  (grid-clip-binding.svelte.ts:398-403): `if (isSongPad(e.x,e.y)) { songHeld = e.s === 1; return; }`
  placed in the **same both-edges block, BEFORE the `if (e.s !== 1) return` guard at `:405`**.
  ⚠️ Placing it after `:405` would swallow the release and wedge `songHeld=true` forever — the exact
  trap COPY/PASTE avoid by sitting at `:398-403`.

### 4.2 The SONG layer (col 9 WHILE `(15,1)` is held)
| Pad | Held action | Source write |
|---|---|---|
| `(9,0)` = REC | tap → toggle `d.recording` (arming clears + records fresh) | same as card `toggleRecord` (ClipplayerCard.svelte:264-266) |
| `(9,1)` = SES⇄ARR | tap → flip `d.clipMode` | same as card `toggleArrangeMode` (`:267-269`) |
| `(9,2..5)` = GAUGE | **no-op (render-only)** — recorded-length fuel-gauge | reads `arrangement.events.length` |
| `(9,6..7)` = reserved | **no-op (render-only), dark** — reserved for the phase-2 playhead tick (OQ-1) | — |

On **release** of `(15,1)`, col 9 reverts to SCENE LAUNCH (`LED_SCENE_IDLE`). `songHeld` is just
another bool beside `copyHeld`/`pasteHeld` (grid-clip-binding.svelte.ts:109-110) — **no new
top-level mode** in the `session|edit|lengthEdit` machine.

### 4.3 Standing read-out on `(15,1)` when the layer is CLOSED (the zero-gesture state)
`computeSessionLeds` (grid-clip-map.ts:290-332) currently leaves `frame[index(15,1)]` at the default
0. Make `(15,1)` a **tri-state status light** driven by new `SessionLedOpts` fields `recording` /
`arrangeMode` (threaded through `renderLeds` from `node.data`, the proven path it already uses at
grid-clip-binding.svelte.ts:491,507-517):

| Standing state | `(15,1)` LED |
|---|---|
| recording (loudest state, wins) | `LED_COPY_IND_PULSE` ramp `[8,13,8,3]` (the copy-buffer "armed" pulse, already used at grid-clip-map.ts:324-326) |
| ARR, not recording | **`LED_QUEUED_HI`(12)** static (the distinct arrangement-active level — NOT `LED_TRANSPORT_ON`(15)) |
| plain SES idle | `LED_MOD_IDLE`(4) static (reads as "a modifier pad") |
| held | `LED_MOD_ON`(15) static |

This is the part the launchpad-coherence lens called the central trade: the launchpad uses **two
always-on dedicated buttons** for arm + SES/ARR; the monome encodes the same standing state into
**one tri-state pad**. That is the honest divergence (§7.1), and the standing pad is what lets the
monome stay first-class — you can never be silently record-armed, and a second performer's grid
shows it too (state is synced on `node.data`).

### 4.4 The gauge `(9,2..5)` (brightness-only, 4 segments, render-only)
Map `arrangement.events.length` to a filled bar over 4 pads with thresholds
`SONG_EVENT_THRESHOLDS = [1, 4, 12, 32]`: segments at/above their threshold light at
`LED_LEN_BLOCK`(6), the highest filled segment at `LED_LEN_END`(15) (reusing the LENGTH-EDIT ruler
language, grid-clip-map.ts:77-79). **Empty arrangement → all 4 dark** = at-a-glance "nothing
recorded yet". Honest limit: 4 brightness pads answer "is there a take, and roughly how big" — for
the block-by-block arrangement you look at the card's song view. The grid arms/flips/confirms; the
card visualizes. `(9,6..7)` stay dark (reserved for OQ-1).

### 4.5 Composition with COPY/PASTE (precedence) — collision-proof
The binding has an explicit precedence comment (grid-clip-binding.svelte.ts:413-414 "editArmed >
copy > paste"). SONG slots in **last** and acts on **col 9** (not the matrix), so it cannot collide
with EDIT/COPY/PASTE (which act on **matrix** taps). Rule to enforce + document:
**if `(15,1)` is held, the entire col 9 is SONG (rows 0/1 = toggles, rows 2-7 = no-op `return`);
matrix taps still obey editArmed/copy/paste.** Holding SONG + COPY is harmless (SONG owns col 9,
COPY owns the matrix). Extend the `:413-414` comment to name SONG.

---

## 5. Exact constants + LED states + the two HARD impl notes

### 5.1 New constants (add to `grid-clip-map.ts`, all derived so the docs spec can't drift)
```ts
// SONG-mode held layer (SESSION only). (15,1) is the lone free right-column pad.
export const SONG_PAD          = { x: GRID_WIDTH - 1, y: 1 } as const;   // (15,1) hold to open
export const SONG_REC_PAD      = { x: CTRL_SCENE_COL, y: 0 } as const;   // (9,0) while SONG held
export const SONG_MODE_PAD     = { x: CTRL_SCENE_COL, y: 1 } as const;   // (9,1) while SONG held
export const SONG_GAUGE_ROWS   = [2, 3, 4, 5] as const;                  // (9,2..5) event fuel-gauge
export const SONG_EVENT_THRESHOLDS = [1, 4, 12, 32] as const;           // gauge fill thresholds
// (9,6..7) intentionally left to LED_EMPTY in the SONG layer — reserved for OQ-1 (playhead tick).
export const LED_ARR_ACTIVE    = LED_QUEUED_HI; // = 12 — arrangement-active, DISTINCT from transport(15)
```
Classifiers: `isSongPad`, `isSongRecPad`, `isSongModePad`, `isSongGaugePad(x,y)` (col 9, y∈[2,8) —
covers the reserved 6/7 too, so the gate is whole-column).

### 5.2 HARD impl note #1 — gate the WHOLE col-9 under `songHeld`, BEFORE `sceneSlotForPad`
In `handleSessionKey`, **insert before the `sceneSlotForPad` branch (grid-clip-binding.svelte.ts
~`:466`)**:
```ts
if (songHeld && e.x === CTRL_SCENE_COL) {
  if (e.y === SONG_REC_PAD.y)  editData(nodeId, d => { d.recording = !d.recording; }); // (9,0)
  else if (e.y === SONG_MODE_PAD.y)                                                     // (9,1)
       editData(nodeId, d => { d.clipMode = d.clipMode === 'arrangement' ? 'session' : 'arrangement'; });
  // rows 2..7 fall here as an explicit no-op — they MUST NOT reach sceneSlotForPad.
  return;
}
```
Without this, `sceneSlotForPad` (grid-clip-map.ts:139-142) fires a scene for **any** `(9,y)` y∈[0,8)
— so brushing a gauge pad while holding SONG would launch scenes 2..7. The gate is the fix; it must
come **before** the scene branch, or scene-launch wins.

### 5.3 HARD impl note #2 — reset `songHeld` in BOTH lifecycle hooks
Add `songHeld = false;` to **`start()` (grid-clip-binding.svelte.ts:124-136)** and
**`__test_resetBinding()` (`:521-537)`**, and add `songHeld` to `__test_mode()` (`:540`). Both
already reset every modifier flag (copyHeld/pasteHeld/editArmed). A stale `songHeld=true` surviving a
rebind would silently re-skin col 9 on the next grid.

### 5.4 Full LED table (all from the existing palette — no new brightness values invented)
| State | Pad(s) | Level / anim | Reuses |
|---|---|---|---|
| SONG pad idle (plain SES) | `(15,1)` | `LED_MOD_IDLE`(4) static | modifier-idle |
| SONG pad — ARR, not recording | `(15,1)` | **`LED_ARR_ACTIVE`(12)** static | arrangement-active (NEW distinct slot) |
| SONG pad — recording | `(15,1)` | `LED_COPY_IND_PULSE` ramp `[8,13,8,3]` | copy-buffer "armed" pulse |
| SONG pad held | `(15,1)` | `LED_MOD_ON`(15) static | COPY/PASTE held |
| REC `(9,0)` held — disarmed | `(9,0)` | `LED_MOD_IDLE`(4) | — |
| REC `(9,0)` held — armed | `(9,0)` | `LED_COPY_IND_PULSE` ramp | armed pulse |
| SES⇄ARR `(9,1)` — SES | `(9,1)` | `LED_STOP_IDLE`(3) static | "inactive transport" |
| SES⇄ARR `(9,1)` — ARR | `(9,1)` | **`LED_ARR_ACTIVE`(12)** static | arrangement-active |
| Gauge filled segment | `(9,2..5)` | `LED_LEN_BLOCK`(6); top = `LED_LEN_END`(15) | LENGTH-EDIT ruler |
| Gauge empty | `(9,2..5)` | `LED_EMPTY`(0) | — |
| Reserved (OQ-1) | `(9,6..7)` | `LED_EMPTY`(0) | — |

Animation grammar (consistent with the grid's existing language): **pulse = armed**, **`LED_ARR_ACTIVE`(12) =
arrangement is the live transport**, **dim-static(3-4) = idle/inactive**. ARR no longer shares the
transport's brightness, fixing the launchpad-coherence collision.

---

## 6. Docs / GridDiagram churn (if accepted) + tests

### 6.1 Files that change
1. **`grid-clip-map.ts`** — §5.1 constants + `LED_ARR_ACTIVE`; `isSongPad`/`isSongRecPad`/
   `isSongModePad`/`isSongGaugePad`; in `computeSessionLeds` the `(15,1)` tri-state (§4.3) and, when
   `opts.songHeld`, the col-9 re-skin (REC/SES⇄ARR/gauge); add `SessionLedOpts` fields
   `songHeld`, `recording`, `arrangeMode`, `eventCount`. **(LED frame + classifiers — source of truth.)**
2. **`grid-clip-binding.svelte.ts`** — `songHeld` state; the `(15,1)` both-edges handler before
   `:405`; the whole-col-9 SONG branch before `:466` (§5.2); thread `recording`/`clipMode` (from
   `node.data`) + `eventCount` + `songHeld` into the `computeSessionLeds` opts at `:507-517`; reset
   in `start()` + `__test_resetBinding` + `__test_mode` (§5.3). **(Mode machine.)**
3. **`clip-grid-spec.ts`** — it imports EVERY coord from grid-clip-map (`:14-38`) and pushes cells
   from them, so it's a pure fn today. Extend it the SAME way: **import
   `SONG_PAD`/`SONG_REC_PAD`/`SONG_MODE_PAD`/`SONG_GAUGE_ROWS`** (never hardcode `(15,1)`/`(9,0)`),
   add a `SONG` palette colour near `:42-55`, colour `(15,1)` as a SONG modifier with side label
   "SONG (hold)", and add a **new `clipSongLayerGrid()`** spec depicting col 9 while held
   (REC · SES⇄ARR · gauge). **Add a drift-guard test**: `expect(songCell).toEqual(SONG_PAD)` (the
   spec lacks one today). **(GridDiagram data.)**
4. **`grid-clip-launcher/+page.svelte`** — rewrite the **Song mode** section (`#song-mode`, today
   "Two small buttons on the card header") to "drive it from the card header **or** the grid: hold
   the **SONG pad (15,1)** and tap **REC** / **SES⇄ARR** on the top of the scene column; the gauge
   shows how much you've recorded; when armed/ARR the `(15,1)` pad pulses/lights even when not held."
   Add the new `<GridDiagram>` for the SONG layer; add a SONG + an "arrangement-active" row to the
   LED legend.
5. **`module-manifest.ts`** — append SONG to the `clipplayer` DESCRIPTIONS (the unit gate requires
   the entry stay in sync): "…COPY/PASTE/PASTE-REVERSE + STOP-ALL + TRANSPORT **+ SONG (hold (15,1) →
   REC + SES⇄ARR on the scene column, with a recorded-length read-out)**".
6. **(optional)** `ClipplayerCard.svelte` — REC/SES⇄ARR button `title`s mention "also on the grid:
   hold SONG (15,1)". No functional card change.

### 6.2 Tests the implementation owes (repo standards)
- **Unit (pure, mirror `grid-clip-map.test.ts`):** `isSong*` truth tables; `computeSessionLeds`
  re-skins col 9 when `songHeld` and restores `LED_SCENE_IDLE` on release; the `(15,1)` tri-state
  (idle / `LED_ARR_ACTIVE`(12) / recording-pulse / held); the gauge thresholds; **assert ARR uses
  `LED_ARR_ACTIVE`(12), NOT `LED_TRANSPORT_ON`(15)** (locks the §0 fix).
- **Binding (mode machine, via `installSimulatedGrid` + `__test_mode`):** hold `(15,1)` + tap
  `(9,0)`/`(9,1)` writes `d.recording`/`d.clipMode`; **a plain `(9,y)` tap (no hold) still fires a
  scene**; **holding SONG and brushing `(9,2..7)` fires NOTHING** (the §5.2 collision regression);
  hold SONG + hold COPY, tap `(9,0)` → only record toggles, no copy; `songHeld` resets across rebind.
- **Real-source-chain e2e (the poly/MIDI-style bar):** TIMELORDE running → grid: hold `(15,1)`, tap
  `(9,0)` to arm, perform a couple of clip launches, tap `(9,1)` to ARR → assert the arrangement
  captured events AND plays back (audible RMS at a lane output). Proves the grid can record AND drive
  playback end-to-end, not just toggle a bool.
- **VRT:** doc page / GridDiagram render → `task vrt` for the doc card; flake-check 3× per standard.

### 6.3 Migration / relearn — near-zero
`(15,1)` was dark/unused (verified: no classifier, no test, no LED write touches it); card buttons
untouched; `node.data` shape reused (`recording`/`clipMode`/`arrangement` all exist). **No
saved-patch / localStorage migration.** Existing grids light one previously-dark pad at idle (or
pulse if a loaded patch was already record-armed). Only additive relearn: "you can now also do this
from the grid."

### 6.4 Documented limitation
The standing `(15,1)` indicator (§4.3) exists **only in SESSION** — in EDIT/lengthEdit `(15,1)` is a
note cell, so you lose the armed-status light while editing a clip's notes. Document this; it's an
acceptable blind spot (you rarely arrange-record while note-editing, and you can be recording the
arrangement during an edit — the take still captures).

---

## 7. Cross-controller — Launchpad mapping + the justified divergences

The launchpad command deck (launchpad-mk3-proposal.md §5) already assigns **dedicated, always-on,
labelled** buttons: **`● = CC92`** → `data.recording` (red pulse when armed) and **`SONG = CC93`** →
`data.clipMode` (white, lit in arrangement) — the exact two `node.data` writes the card + monome use.

### 7.1 What stays IDENTICAL (the coherence guarantee — lead with this)
- **The byte-identical write seam.** Both controllers call the same `d.recording` /
  `d.clipMode` mutations the card uses (ClipplayerCard.svelte:264-269; launchpad §5 CC92/CC93). State
  is synced → arm on the monome, the launchpad's `●` lights; flip on the launchpad, the monome's
  `(15,1)` goes to `LED_ARR_ACTIVE`(12). **One model, many surfaces.** This is the coherence that
  matters most.
- **REC clears + records fresh (v1 replace)** on both — same engine behavior, documented once.
- **Same semantic LED grammar, mapped per device:** *armed = pulsing* · *ARR = its OWN active colour,
  distinct from transport* · *SES = dim/inactive*. The launchpad uses RGB (red/white); the monome
  uses brightness (pulse / `LED_ARR_ACTIVE`(12) / dim). With the §0 fix, **neither controller renders
  ARR as the transport colour** — the shared legend has a dedicated "arrangement-active" row.

### 7.2 Where they SHOULD diverge (and why it's correct — the owner pre-accepted)
| Aspect | monome (this proposal) | 2× Launchpad | Why divergence is correct |
|---|---|---|---|
| REC + SES⇄ARR access | **behind a held `(15,1)` layer**, but **standing state on `(15,1)` is zero-gesture** | **two always-on labelled buttons** (`●`/`SONG`) | monome has ONE free pad + no labels + brightness-only; launchpad has a de-overloaded command deck with text-capable RGB. Forcing the monome to ape always-on layout would steal a matrix/scene pad. |
| Standing indicator | **one tri-state pad** (idle / ARR-12 / record-pulse) | **two dedicated lit buttons** | the genuine divergence (not buried): the monome packs the launchpad's two-light job onto one tri-state pad — the owner should confirm this is acceptable (OQ-3) |
| Read-out | coarse 4-pad recorded-length gauge **while held**; no playhead tick in v1 | no always-on song-playhead in §5 either; both rely on the card's song view | the monome can't render a timeline; the launchpad command deck has no playhead pad — symmetric honesty |
| Scene column | **time-multiplexed**: col 9 is scene-launch, becomes SONG only while `(15,1)` held | **keeps scene + SONG on different physical pads** simultaneously | the monome is pad-starved; the hold-gate makes the multiplex safe (§5.2). State this asymmetry honestly — the monome does NOT have spare scene pads. |

### 7.3 Two cross-doc notes (launchpad-side, not this proposal's bug)
- **Shared legend** (`legend-colors.svg` in the launchpad folder) must gain an explicit
  **"arrangement-active"** row, distinct from "transport-running", so BOTH controllers map ARR to the
  same legend family (monome `LED_ARR_ACTIVE`(12) ↔ launchpad SONG-white). This is the visible proof
  the two state→colour maps are one family.
- **Launchpad-internal CC double-book to flag upstream:** the nav row maps `▼=CC92 / ◀=CC93`
  (launchpad-mk3-proposal.md:530) while the command deck §5 reuses `●=CC92 / SONG=CC93`. That double-
  books CC92/CC93 across the left/right units — a one-line cross-ref in the launchpad doc so the two
  docs don't ship contradictory CC tables. (Not this proposal's deliverable; surfaced by the review.)

### 7.4 The unified "held-reveals-more" framing (optional, recommended)
The launchpad already has a **global held SHIFT** (CC95, launchpad §7) that opens alternate meanings.
The monome's `(15,1)` is **the same idiom** — a held pad that reveals more. Present them as **one
family** in the docs ("hold the function key to reach the extra controls") even though the launchpad
ALSO keeps `●`/`SONG` always-on. This makes the divergence read as "same concept, device-appropriate
surface", which is exactly what the owner asked for. (Framing only — no code coupling.)

---

## 8. Risk / churn summary
- **Pure unit + one simulated-grid e2e** (no WebGL, no hardware) → well under the 2-min CI wall-time
  threshold; no new capability/renderer dependency.
- **Two-handed gesture** for the action (hold + tap) — mitigated by the zero-gesture standing
  indicator; the one-handed §3-B fallback is the escape hatch if the owner wants SES⇄ARR one-tap
  mid-set (OQ-2).
- **Read-out is coarse** (4 gauge pads, no timeline) — docs are honest: grid arms/flips/confirms,
  card visualizes.
- **No engine change** — pure control-surface + LED + docs.

---

## OPEN QUESTIONS (owner's call)

- **OQ-1 — Playhead tick: phase-2 or drop?** v1's `(9,6..7)` tick needs `songBeat`, which lives on a
  per-node engine **emit** the binding can't reach today (it has no `useEngine`/engine-context import;
  ClipplayerCard.svelte:230,240 vs grid-clip-binding.svelte.ts:82,491). Building it = a net-new
  engine-emit→binding bridge. **v1 ships the gauge only and leaves `(9,6..7)` dark/reserved.** Want
  the tick later as its own slice, or drop it entirely (the card's song view already shows the
  playhead)?
- **OQ-2 — Held layer (A) or one-handed fallback (B)?** A = both controls + gauge behind a hold
  (two-handed for the action, zero-gesture for the standing state). B = SES⇄ARR one-tap at `(15,1)`,
  REC on a long-press, no gauge. If you flip SES⇄ARR mid-set and want it one-handed, pick B.
  **Recommendation: A.**
- **OQ-3 — Standing indicator: one tri-state pad OK?** The monome encodes record/SES/ARR onto the
  single `(15,1)` pad (the launchpad uses two dedicated lit buttons). Acceptable, or do you want a
  second standing light somewhere (it would have to displace a dark margin pad)?
- **OQ-4 — ARR LED level.** I changed ARR from `LED_TRANSPORT_ON`(15) to `LED_ARR_ACTIVE`(12) so ARR
  ≠ transport-running on the same column. Happy with 12, or prefer a blink to make ARR even more
  distinct from the static transport-15?
