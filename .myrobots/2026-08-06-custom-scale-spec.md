# CUSTOM SCALE — per-lane note-row filter for the clip editor

**Owner request, 2026-08-06.** Status at hand-off: **NOT STARTED** — no code exists
(`git grep -i "custom scale"` over `packages/web/src` returns nothing). This
document is the complete build plan for a fresh session. Everything below the
"Anchors" heading was verified against the tree at `f0787337` (main) plus
`feat/midi-out-poly`.

---

## 1. What the owner asked for (verbatim intent)

> i need a "custom scale" option inside a clip, which, once used, impacts the
> whole lane. the way i want this to work is a "custom scale" button on the front
> of the card when we're in clip-edit mode. in this view we now need each row of
> notes has a check box off to the side. we can check one or more rows of notes
> and then click a "apply custom scale" which should sit next to the VEL button
> we have now. when we click this, all note rows not in the custom scale are
> hidden, and the "apply custom scale" button turns into a "remove custom scale"
> button. when we click that, the hidden rows unhide. the intention here is that
> i have a device receiving midi on channel 10 for 4 notes only, to be converted
> into drum triggers in a modular rack, and i want to only see those 4 rows in my
> sequencer. we do not need Push/Launchpad controls to edit the custom scale,
> but, the external controllers need to respect it, in terms of, they only show
> rows that are enabled if custom scale is selected on the card. so if i have a
> custom scale with a total of 4 rows in it, the clip view on the Push/Launchpad
> is limited to those 4 and shows then all together. if our custom scale has 10
> notes in it, then we see the first 8 on the push/launchpad grid, and we can move
> up/down as usual to see the additional rows.

### The use case that decides ambiguities
A hardware device listens on **MIDI ch 10 for four notes only** and converts them
to drum triggers in the modular rack. The sequencer should show **only those four
rows**. So: this is a **VIEW FILTER for authoring**, not a musical scale, not a
transform, and **not a playback change**. When in doubt, prefer the reading that
keeps the emitted notes untouched.

### Explicitly out of scope
- Editing the custom scale **from** Push/Launchpad (view-only there).
- Any change to what the clip **plays**. Hidden rows keep their notes and keep
  sounding — see §3 "Decision D1" and make it a test.

---

## 2. Anchors (verified file:line — re-verify before editing)

**Pure model** — `packages/web/src/lib/audio/modules/clip-types.ts`
- `rowToMidi(row, root, scale)` — the row↔pitch primitive everything uses.
- `editableRowRange(root, scale)` → `{lo, hi}` — the full row span.
- `restrictedRowWindow(root, scale, floorOctave, octaves)` **≈ line 1560** —
  **THE PRECEDENT TO COPY.** Pure, unit-tested, returns `{lo, hi, count}`, and
  the card feeds it into the SAME render path the unfiltered view uses, so the
  feature-off path stays byte-identical. Read its docstring before designing.
- Per-lane data readers: `laneMono(data, lane)` **line 808**, `laneMuted` **813**,
  `laneSwing(data, lane)` **902**. Shape is `data.<key>[lane]` (a lane-indexed
  array, normalized by `coerceLaneArray`). **Follow this exactly.**

**Card** — `packages/web/src/lib/ui/modules/ClipplayerCard.svelte` (~3075 lines)
- `midiForDisplayRow(clip, displayRow)` **≈ line 1075** — display row → MIDI.
  `displayRow 0 = TOP = highest pitch`; descends. **The one funnel to re-point.**
- `editRange` / `editRows` — the row stack the grid renders from.
- Row rendering **≈ line 1998** (`{@const midi = midiForDisplayRow(editClip, row)}`).
- `toggleNote(step, displayRow)` **≈ 1096**, velocity cycle **≈ 1115**, prob menu
  **≈ 1134** — all call `midiForDisplayRow`, so all follow the funnel for free.
- **CLIP OPS bar ≈ line 1944–1952**, testid `clipplayer-clip-ops-${id}`. The VEL
  hint is the last child: `<span class="op-vel" … data-testid="clipplayer-velmode-${id}">VEL</span>`.
  **The APPLY/REMOVE button goes immediately after it**, same flex row.
- `clipview-ctl` bar **≈ 1955+** — the RngLim/floor/KEY controls, i.e. the
  existing precedent for *view-local chrome that touches neither playback nor CV*.
- Writers: `writeData(mut)` **line 268** (transient) / `writeDataUndoable(mut)`
  **line 280** (persistent + undo). Custom-scale edits are **undoable** → use
  `writeDataUndoable`.

**Controllers (Push 2 + Launchpad)** — `packages/web/src/lib/control/clip-surface-map.ts` (202 lines)
- `editLogicalRowToMidi(clip, logicalRow)` **line 108** →
  `rowToMidi(logicalRow, clip.root, clip.scale)`.
- `noteForCell(clip, col, logicalRow, rowOffset, page)` **line 124** — calls
  `editLogicalRowToMidi(clip, rowOffset + logicalRow)`.
- `noteCellLevel(...)` **line 140**, `shownEditPageFor(...)` **line 157**.
- **This file is the SINGLE choke point both surfaces go through** (it says
  "Surface-independent: a placement adapter converts its own physical row to this
  logical row before calling"). Filter here and BOTH controllers inherit it — do
  not touch per-controller code.
- ⚠ These functions currently take `clip` but **not** `data`/`lane`, and the
  scale lives per-LANE on `data`. Threading the row list in is the main
  refactor — see §4 step 3.

---

## 3. Design decisions (made; change only with reason)

**D1 — Hidden rows still PLAY.** The filter is a view. A hidden row's notes stay
in the clip and keep sounding. Rationale: it is a drum-row filter, not an edit;
silently muting notes on a view toggle would be data loss by UI state. **Pin this
with a test** (apply a scale that hides a row holding a note → the emitted note
set is unchanged).

**D2 — Storage is PER LANE, on `node.data`, Y.Doc-synced.**
`data.customScale[lane] = number[]` (sorted, de-duplicated **MIDI note numbers**,
not row indices). Absent/empty ⇒ feature off for that lane.
- **MIDI numbers, not row indices**, because row indices shift with
  `clip.root`/`clip.scale`; a stored row index would silently re-point at a
  different pitch when the clip's key changes. MIDI is stable.
- Lane-indexed array to match `laneMono`/`laneSwing`/`laneMuted` exactly
  (`coerceLaneArray` normalization, back-compat on load).

**D3 — Two independent bits of state.**
1. `data.customScale[lane]` — the membership set (persistent, synced).
2. `data.customScaleOn[lane]: boolean` — whether the filter is APPLIED
   (persistent, synced — the owner wants it to survive and to drive hardware).
Plus one **view-local, non-persisted** `$state` in the card: `pickingScale`
(are the checkboxes visible). Not in the Y.Doc — it is a personal authoring
lens like `annotate-mode`, and a rack-mate toggling it must not change your view.

**D4 — Button behaviour.** `APPLY CUSTOM SCALE` is disabled when the checked set
is empty (never let the user hide every row). When applied it becomes
`REMOVE CUSTOM SCALE`, which clears `customScaleOn[lane]` but **keeps the
membership set**, so re-applying is one click. A separate "custom scale" toggle
button reveals/hides the checkbox column.

**D5 — Controller paging.** `rowOffset` indexes into the **filtered** list.
Max offset = `max(0, filteredCount - 8)`. 4 rows ⇒ all four shown, no scroll.
10 rows ⇒ first 8, up/down reaches rows 9–10. This falls out of D6 for free.

**D6 — ONE source of truth.** A single pure function returns the ordered row
list; card AND controllers both consume it. Never re-derive the filter in the
card or in a controller. (Repo rule: a card that disagrees with its model is
invisible to every model-reading gate.)

---

## 4. Build order

### Step 1 — Pure model (`clip-types.ts`), TDD
Add beside `restrictedRowWindow`:

```ts
/** Per-lane custom-scale membership (MIDI notes), normalized + sorted. */
export function laneCustomScale(data: ClipPlayerData | undefined, lane: number): number[]

/** Is the lane's custom scale currently APPLIED? (false when the set is empty) */
export function laneCustomScaleOn(data: ClipPlayerData | undefined, lane: number): boolean

/**
 * THE ONE ROW LIST both the card and the controllers render, top-down
 * (index 0 = highest pitch, matching the card's display-row convention).
 * Custom scale OFF  → every row in `range` (byte-identical to today).
 * Custom scale ON   → only rows whose MIDI is in the set, high→low.
 */
export function visibleNoteRows(
  clip: NoteClipRecord,
  data: ClipPlayerData | undefined,
  lane: number,
  range?: { lo: number; hi: number },   // defaults to editableRowRange
): number[]   // MIDI note numbers, high → low
```

Unit tests (`clip-types.test.ts`) — **including these specific legs**:
- OFF ⇒ identical to the current full-range list (the no-op proof).
- ON with 4 notes ⇒ exactly those 4, ordered high→low.
- A member note **outside** the clip's current editable range is dropped (no
  phantom row) — and that is asserted, not assumed.
- A member note not on the clip's scale/key still shows (drum rows are chromatic).
- Empty set ⇒ treated as OFF (never a zero-row grid).
- Interaction with `restrictedRowWindow`: pass a restricted `range` and confirm
  the filter intersects rather than overrides.

### Step 2 — Card UI (`ClipplayerCard.svelte`)
1. Re-point `midiForDisplayRow` at `visibleNoteRows(...)[displayRow]`, and derive
   `editRows` from `visibleNoteRows().length`. **This is the whole render change**
   — `toggleNote`, velocity cycling and the prob menu all route through that
   funnel already.
2. Checkbox column: rendered only while `pickingScale`, one per rendered row, to
   the side of the row (see the owner's wording). Give each a stable testid:
   `clipplayer-scalerow-${id}-${midi}`.
3. `custom scale` toggle button (reveals checkboxes) — put it in `clipview-ctl`
   next to `RngLim`, which is the established home for view-local chrome.
4. `APPLY / REMOVE CUSTOM SCALE` button appended to `.clip-ops`, **immediately
   after the `.op-vel` span** (testid `clipplayer-customscale-apply-${id}`).
   Disabled when the pending set is empty.
5. Writes go through `writeDataUndoable` (undo/redo + sync).
6. ⚠ While the checkbox column is visible the grid gains width — check the card
   does not overflow its rack tier (`card-control-overflow` measures VIEWPORT-
   SCALED px, so never size from its printed number).

### Step 3 — Controllers (`clip-surface-map.ts`)
Thread the filtered row list through the existing choke point. Preferred shape
(keeps the pure functions pure and surface-independent):

```ts
// rows = visibleNoteRows(...) computed by the caller once per render
export function editLogicalRowToMidi(clip, logicalRow, rows?: readonly number[]): number
export function noteForCell(clip, col, logicalRow, rowOffset = 0, page = 0, rows?: readonly number[])
```
With `rows` omitted, behaviour is **byte-identical to today** (that is the
back-compat proof and should be its own test). With `rows` supplied, index into
it — note the ORDER convention: `clip-surface-map` uses `logicalRow 0 = bottom`,
while the card uses `displayRow 0 = top`. **Pick one convention for
`visibleNoteRows` (spec says high→low) and have the controller adapter invert.
Write that inversion down in a test with a named example, or it will be wrong.**

Then update the two adapters to pass `rows` and to clamp `rowOffset` to
`max(0, rows.length - 8)`.

### Step 4 — Verification
- `REPEAT=3 flox activate -- task test:one -- clip-types`
- `REPEAT=3 flox activate -- task test:one -- clip-surface-map`
- `flox activate -- task test` (full unit lane — this touches shared clip model)
- `flox activate -- task typecheck`
- `flox activate -- task vrt:one -- clipplayer` then **inspect the diff**:
  clip-edit chrome moved, so a baseline shift is expected — confirm it is only
  the new button/checkbox column and re-pin deliberately.
- e2e: extend the clip-editor spec — apply a 4-row scale, assert exactly 4 rows
  render, assert a note on a hidden row **still plays** (D1), assert remove
  restores the rows.
- Controller coverage: assert BOTH surfaces (Push AND Launchpad) honour the
  filter; **state the gate's scope in the gate** — a test that only drives
  Launchpad must say so, or it reads as covering both.

---

## 5. Traps specific to this feature

- **Do NOT store row indices** (D2). A clip key change silently re-points them.
- **Do NOT let the filter reach playback** (D1). The scheduler must never read
  `customScale`. If a future need arises, that is a separate MUTE feature.
- **Empty set must not render a zero-row grid** — guard in the model, not the UI.
- **`data.customScale` is a NEW `node.data` key on clipplayer** → check whether
  clipplayer's def/docs or the contract gate needs `task docs:accept`, and
  whether the perf-zip envelope carries it automatically (it should — `node.data`
  rides the Yjs envelope, unlike out-of-band media).
- **In-place Y discipline**: never rebuild-and-reassign a map holding live Y
  types; mutate in place inside the `writeDataUndoable` callback
  (see `yjs-save-load-real-ydoc`).
- **`coerceLaneArray` back-compat**: an older save has no `customScale` key at
  all — every reader must treat missing as OFF without throwing.

---

## 6. Suggested PR split

1. **PR A — pure model + tests** (`clip-types.ts`). No UI, no behaviour change.
   Mergeable alone, zero risk.
2. **PR B — card UI** (checkbox column, two buttons, funnel re-point) + VRT re-pin
   + card e2e.
3. **PR C — controller respect** (`clip-surface-map.ts` + the two adapters) +
   Push/Launchpad tests.

Each PR is independently green and independently revertible. PR A is the one that
must be right; B and C are consumers of it.

---

## 7. Related work landed the same day (context)

- **#1385 `feat/midi-out-poly`** (open at hand-off, blocked on a GitHub Actions
  outage, not on code): MIDI-OUT-BUDDY gained a `poly` input so a 4-note column
  sends 4 notes. **Same drum-trigger use case as this feature** — the owner's rig
  is a poly clip lane → MIDI ch 10 → ES-9 → drum triggers. Custom scale is the
  authoring half of that story; poly-out was the transport half.
- Owner note for that PR: an existing SAVED patch keeps its stored edge types, so
  the clip→`pitch` cable stays mono until the lane re-taps (re-drop the module).
