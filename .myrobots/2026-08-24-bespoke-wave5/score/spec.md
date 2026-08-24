# FACEPLATE BUILD SPEC — `score` (audio, the SHEET-MUSIC sequencer)

**SPEC ONLY. Nothing here is implemented.** Mockups: [`dock.html`](dock.html) ·
[`editor.html`](editor.html) · [`lane-tile.html`](lane-tile.html).

Requested by the OWNER, by name. Written against the **post-#2183 tree**, and §0.1
explains why that matters more for this module than for anything else in the program.

Method, per the standing directive: analyse what the module is FOR, then author the
spec, then build from the spec. **Six claims in here were checked and came back
different from what the rule predicted**, and all six are recorded in place rather than
quietly applied — they are collected in §16 (⚠ THE CORRECTIONS) and cross-referenced
where they bite.

---

# ⚠ READ FIRST — THIS FACE CHANGES HOW `score` IS PLAYED

**This is not the card with a new skin.** Everything else in this spec is layout, cost and
gates; this one section is a change to the INTERACTION, and it is the thing to weigh before
any of it. Full argument in **§5.1**; this is the summary that must not be missed.

**Today `score` is MODAL.** `activeTool` (`ScoreCard.svelte:227-235`) is one of
`duration(d) | sharp | flat | tie | dynamic(level) | stopBar | select`, and fifteen toolbar
buttons arm fifteen modes that change what a click on the staff means.

**The face is SELECTION-BASED instead.** Click a note to select it; the mark cells
(accidental, tie, dynamic, stop bar) act on the selection; click the selected note again to
delete it. Nothing is armed and there is no mode to be in.

### Why it is not merely different — the current interaction is ALREADY BROKEN

The selection model fixes **four live defects as a consequence**, not as four patches. Each is
measured, and together they are the case that the modal design is not working today:

| # | defect | evidence |
|---|---|---|
| 1 | **A note can barely be deleted.** `deleteNote` has **exactly one call site** — a keystroke on a focused note. But `Tab` is consumed by the rack flip (`RACK_FLIP_KEY = 'Tab'`, bare) and the staff's `pointerdown` calls `preventDefault`, so focusing a note is close to unreachable. **And no e2e anywhere tests note deletion** | §2.1(a) |
| 2 | **A tie can NEVER be removed.** `addTie` is the only writer of `d.ties`. There is no remover, on any surface | §2.1(c) |
| 3 | **`docs.controls` promises an affordance that does not exist** — *"click a note to select/remove it"* — on a module that is in `STRICT_DOCS`. ⚠ `module-docs-lint` reads the DEF, so it is structurally blind to a card that does not implement what the def promises | §2.1 |
| 4 | **Every music edit is outside Cmd-Z.** `writeData` calls `ydoc.transact(fn)` with no `LOCAL_ORIGIN`, and `mutate.guard`'s patterns anchor on the literal token `.params`, so the guard cannot see it | §0.3 |

Under the face, (1) and (2) become one gesture each, and (3) becomes true.

### ⚠ THE COST, STATED PLAINLY: THE SELECTION SYNCS TO COLLABORATORS

`node.data` rides the Y.Doc, so **two people editing one score share a selection cursor.**
That is a real downside and it is not hidden here.

It is also **unavoidable rather than chosen**: a cell's `value(node)` receives the node and
nothing else (`shell-cells.ts:167-183`), so a selection the mark cells must read has literally
nowhere else to live. A component-local selection would make every mark cell inert. `kria`
ships the identical construct with the identical property and the identical argument
(`kria/spec.md` §6.3).

**The one-line revert is in §13.** If the shared cursor is unacceptable, the face reverts to
five modal cells — and §5.1 explains why four of those five would then be painting a state
they do not hold.

---

## 0. THE CONSTRAINT MAP, READ FIRST

| constraint | `score`'s answer | measured at |
|---|---|---|
| disposition on the live roster | `bespoke-surface` — *"a NOTATION EDITOR … the staff is the interaction"* | `face-migration-inventory.ts:1016-1021` |
| `NON_SHELL_LANE_TYPES` | **NOT a member** — so promotion swaps BOTH surfaces | `legacy-fallback.ts:96-112` |
| `needs-note-entry-cell` blocker | ⚠ **DOES NOT APPLY** — and the reason is measured, not assumed | §0.4 |
| lane picture | **refused**, and mechanically protected | §4 |
| `glyph` | **`'none'` is the ONLY literal that compiles green** | §4 |
| tab rail | ⚠ **honest grouping lands at FIVE.** `DOCK_TAB_MIN_BANDS = 7`. **OWNER CALL — §5.4** | `dock-tabs-model.ts:101` |
| width | **EARNED, and it is the widest earn in the fleet** — 720 px, derived | §5.5 |
| `node.data` writes / Cmd-Z | ❌ **UNTAGGED** — every note, tie, dynamic, page and slot is outside undo | §0.3 |
| WebGL attest | **ZERO — not in the basis.** Measured both ways | §11.1 |
| ART | **ZERO** — no `.f32` pin exists; `score` is in `ART_BACKLOG` | §11.2 |
| VRT today | ⚠ **ONE committed card baseline, in the BLOCKING strict lane** | §10 |
| contract-lock | ⚠ **MOVES** — six new `family` lines | §11.4 |
| Push 2 card | ⚠ **moves GENERIC → FACE** | §11.5 |
| `midi-learn-note.spec.ts` | ⚠ **the #2166 class, in its purest form** — §3.3 | §3.3, §9 |

### 0.1 ⚠ #2183 IS THE CONTEXT FOR THIS ENTIRE SPEC, AND IT IS OPEN AND HELD

`gh pr view 2183` — *"chore: delete the five sequencers deprecated by CLIP PLAYER
(held for owner testing)"* — **deletes `sequencer`, `drumseqz`, `macseq`, `polyseqz`
and `writeseq`**, and its own body says:

> *"`score`, `numpadPlus` (kept; comprehensive authored specs to follow) are
> untouched."*

**This spec is that follow-up.** Three consequences that change the analysis, all
verified against the PR's own file list rather than inferred:

1. **`score` becomes the LAST module in the repo using `transport-cv.ts` and
   `QuicksaveControls.svelte`.** The `TRANSPORT_CV_PORT_DEFS` adopters today are
   `score, polyseqz, macseq, drumseqz, sequencer, writeseq`; five of those six are
   deleted. `QuicksaveControls.svelte` is imported by `PolyseqzCard`, `MacseqCard`,
   `ScoreCard`, `DrumseqzCard`, `WriteseqCard`, `SequencerCard` — same five deleted.
   ⚠ **So the six shared transport files become SCORE-ONLY shared files**, and a face
   PR that moves score off them leaves them with no consumer at all. That is a fact to
   carry, not to act on inside a face PR.
2. **Three of the four e2e specs that reach for score are DELETED by #2183** —
   `sequencer-transport.spec.ts` (935 lines), `sequencer-playhead-alignment.spec.ts`
   (310), `sequencer-clock-without-play.spec.ts` (214). The score legs in all three go
   with them. **So the e2e migration surface in §9 is materially smaller than a
   pre-#2183 read would show**, and a build agent working from the current tree would
   plan work for specs that will not exist.
3. **#2183 RE-POINTS `midi-learn-note.spec.ts` at SCORE** (9 additions / 9 deletions,
   `bootDrumseqz` → `bootScore`, `drumseqz-play-ds-1` → `score-play-ds-1`). That makes
   score the fleet's canonical card-BUTTON MIDI-assign subject — and it is the single
   most dangerous interaction with promotion in this spec. §3.3.

**Build against the post-#2183 world.** If #2183 has not merged when the face PR
starts, the face PR must still not depend on the deleted specs; if it has, three
migration rows in §9 disappear.

### 0.2 THE PARAM SET IS SIX KNOBS OVER AN INSTRUMENT THAT IS NOT MADE OF KNOBS

`score.ts:131-138`:

```ts
params: [
  { id: 'bpm',      label: 'BPM', defaultValue: 120,   min: 30,    max: 300, curve: 'linear' },
  { id: 'attack',   label: 'A',   defaultValue: 0.005, min: 0.001, max: 10,  curve: 'log', units: 's' },
  { id: 'decay',    label: 'D',   defaultValue: 0.1,   min: 0.001, max: 10,  curve: 'log', units: 's' },
  { id: 'sustain',  label: 'S',   defaultValue: 0.7,   min: 0,     max: 1,   curve: 'linear' },
  { id: 'release',  label: 'R',   defaultValue: 0.3,   min: 0.001, max: 10,  curve: 'log', units: 's' },
  { id: 'isPlaying',label: 'Play',defaultValue: 0,     min: 0,     max: 1,   curve: 'discrete' },
],
```

Five of the six are a **built-in ADSR**, which is a *voice* concern bolted to a
*sequencer*; the sixth is a transport switch. **Not one param is the music.** The music
— every note, every tie, every dynamic, the key signature, the page count, the loop
flag, the stop bar and the four quicksave snapshots — is `node.data`
(`score.ts:83-102`, the `readScoreData` reader).

That is the same inversion `kria` has (`kria/spec.md` §0.1: *"both params are
FALLBACKS"*), and it is why both modules sit in the `bespoke-surface` bucket. The
difference is that kria's two params do nothing in a default rack while score's five
ADSR knobs genuinely shape the ENV output — so score's rank problem is not "rank
nothing" but **"rank a picture first and five real knobs after it"**.

### 0.3 ⚠ EVERY EDIT TO THE MUSIC IS OUTSIDE Cmd-Z

`ScoreCard.svelte:262-289`:

```ts
function writeData(mut: (d: ScoreData) => void) {
  const t = patch.nodes[id];
  if (!t) return;
  ydoc.transact(() => {                       // ← no origin argument
    …
  });
}
```

and again at `:708` (`applySnapshot`, the quicksave LOAD path) and at
`transport-card.ts:63-70` (`setData`, which score reaches through
`transportDeps.transact: (fn) => ydoc.transact(fn)`, `ScoreCard.svelte:669`).

`mutate.ts:12-15` states the consequence: the local UndoManager is configured
`trackedOrigins: new Set([LOCAL_ORIGIN])`, so an edit is captured for Cmd-Z **only**
when its transaction was tagged. An untagged `ydoc.transact(fn)` has origin `null`.

**Everything that routes through `writeData` is therefore un-undoable**: `addNote`,
`placeDynamic`, `setStopBar`, `clearStopBar`, `toggleLoop`, `addPage`,
`toggleAccidentalOnNote`, `cycleKey`, `resetKey`, `addTie`, `deleteNote`, and the note
DRAG (`onSvgPointerMove` calls `writeData` on every pointermove).

Three things make this a section rather than a ledger row:

1. **It is not carelessness.** Three lines away, `set()` (`:119-121`) is
   `setNodeParam(id, k, v)` — origin-tagged, undoable, synced. The BPM fader and the
   four ADSR faders are correct. The module used the seam **everywhere the seam
   covers**, and `node.data` is not covered.
2. **No gate can see it.** `mutate.guard.test.ts:94`'s `RAW_PARAM_WRITE` regex anchors
   on the literal token `.params`; a `.data` write matches nothing, and there is no
   sibling ledger. The wave-3/4 tally is now **four broken** (`kria`, `audioOut`,
   `midiclock`, **`score`**) against **three correct** (`picturebox`, `matrixMix`,
   `twotracks`), with `mutate.guard` green over all seven.
3. **The fix is one argument.** `ydoc.transact(fn, LOCAL_ORIGIN)`, in three places.
   Fold it into the face PR (D1 in §12).

⚠ **Verify the coalescing, do not assume it.** `store.ts` configures
`captureTimeout: 500`, so a run of quick clicks becomes ONE undo step. On a note DRAG
that is essential — `onSvgPointerMove` writes on *every pointermove*, so an untagged
drag would otherwise become fifty undo steps. **M4 in §14 makes it a measurement.**

### 0.4 THE NOTE-ENTRY BLOCKER DOES NOT APPLY — measured, not assumed

`score` is the module whose name most strongly suggests `needs-note-entry-cell`, so it
was checked first. `MIGRATION_BLOCKERS['needs-note-entry-cell']`
(`face-migration-inventory.ts:173-191`) defines the capability as:

> *"a note/short-text entry face cell — card-primitive-parity declares NoteEntry
> `via: none`, and a raw `<input type="text">` shares the gap, so a **typed** pitch
> field ("c#3"), a MIDI note number or a name field has no face representation at
> all"*

**score types nothing.** Its note entry is a POINTER gesture:
`onSvgPointerDown` → `pointerToCell(svgEl, clientX, clientY)` → `addNote(bar, tick,
step, duration)` (`ScoreCard.svelte:402-489`, `:291-312`). The card mounts no
`<input>`, no `<textarea>`, no `contenteditable` — the STOP-2 grep in §3 returns zero
`<input` and zero `<select` hits across all 1272 lines.

score's roster entry declares no `blockers` array, which agrees. **The blocker is not
in the way, and it never was.** (#2183's body reports the blocker population dropping
17 → 12 as the five typed-step sequencers are deleted; score was never one of them.)

### 0.5 ⚠ FOUR DECLARED INPUT PORTS DEPEND ON A CARD-ONLY AFFORDANCE

`score.ts:123` pulls in `TRANSPORT_CV_PORT_DEFS`, which gives score
`queue1_cv … queue4_cv` — **four of its eleven inputs.** Their documented behaviour
(`score.ts:160-163`) is *"queues saved pattern slot N … does nothing if slot N is
empty"*, and the engine path is
`pollTransportCv` → `pickQueuedSlotFromEvents` → `node.data.queuedSlot` →
`maybeApplyQueuedSlot` → `data.slots[queued]` (`score.ts:472-549`).

`data.slots` is written by exactly one thing: `handleSlotClick` in
`transport-card.ts`, driven by `QuicksaveControls.svelte`, mounted at
`ScoreCard.svelte:1032-1043`.

**So promoting score without a quicksave surface leaves four declared input ports
permanently inert** — they would fire, resolve a slot, find it empty, and clear
`queuedSlot`. That is a functional-parity loss of the kind that is never surfaced as an
owner choice; it is a thing to solve. §5.3 solves it with a second `panel` cell, and
§14's M2 is the measurement that proves the solve.

---

## 1. WHAT THE MODULE IS FOR

**Writing music down, and hearing what you wrote.**

Every other sequencer in this repo asks you to think in STEPS: a grid of on/off cells
(`kria`, the deleted `drumseqz`), a piano roll (`clipplayer`), an X/Y field
(`cartesian`). score asks you to think in NOTATION — a treble staff in 4/4, with note
VALUES (whole down to sixteenth, plus eighth-note triplets), accidentals, a key
signature, ties, dynamics from *pp* to *ff*, and a stop-music double bar. The verb is
**write**, not **program**; the unit is a NOTE with a duration, not a step with a gate.

Two properties follow, and they drive the whole face:

1. **The instrument is a DOCUMENT.** `node.data` holds `notes[]`, `dynamics[]`,
   `ties[]`, `keySignature`, `pages`, `loop`, `stopBar` (`score-data.ts:81-92`) — an
   editable score, not a control state. The five ADSR knobs are a small voice attached
   to the side of it.
2. **Its grid is FINER than its transport, on purpose, and that has already cost three
   months of silence.** `TICKS_PER_BAR = 48` for PLACEMENT; the scheduler advances in
   16th-note SLOTS of `GRID_TICKS_PER_SLOT = 3`. `score-data.ts:123-151` records what
   happened when the two were conflated: a `triplet8th` is 4 ticks wide, so the
   toolbar offers `{0,4,8,…,44}` while the scheduler used to emit only at
   `tickIndex * 3` — and `4k ≡ 0 (mod 3)` for `k ∈ {0,3,6,9}` alone. **Four of twelve
   triplet positions sounded, from the module's first commit, in both clock modes, and
   nothing looked wrong** because the card draws x linearly in ticks and the playhead
   highlight is written INSIDE the emit.

That second property is the reason this module deserves a comprehensive spec: **its
picture and its playback are two derivations of one grid, and every time they are
re-derived separately they drift.** A face is a THIRD renderer of that grid. §6.2 says
how it avoids becoming the fourth divergence.

---

## 2. STOP 1 — is promoting this module a PARITY LOSS?

Not if the face carries what §3 maps. But it is the **largest** parity surface in the
program so far, and the honest way to say that is to count it rather than assert it.

`ScoreCard.svelte` is **1272 lines** — the largest card in the bespoke cohort — of
which roughly 570 lines are the SVG renderer + pointer/keyboard handlers and 200 are
the quicksave/transport wiring.

The refusal test is not size, it is **whether a control disappears**. Two of score's
affordances came within one measurement of failing it:

* **the QUICKSAVE row** — §0.5, four input ports depend on it. Solved (§5.3).
* **the MIDI-assignable PLAY button** — §3.3. Solved, with one migration (§12 D2).

Everything else maps. **Verdict on STOP 1: PROMOTE**, and §3 is the receipt.

### 2.1 ⚠ THREE AFFORDANCES THE CARD ADVERTISES AND DOES NOT HAVE

Found while doing the STOP-2 mapping, all live on `main`, all static-checkable:

**(a) There is no way to DELETE a note that a player can reach.**
`deleteNote` (`ScoreCard.svelte:389-394`) has **exactly one call site** —
`onSvgKeyDown`'s `Backspace`/`Delete` branch at `:538-541`, which acts on
`event.target.closest('[data-note-id]')`, i.e. the FOCUSED note.

Two things make that focus unreachable in ordinary use, and they compound:

* **Tab is consumed by the flip.** `workflow-pins.ts:322` is
  `RACK_FLIP_KEY = 'Tab'`, bare, and `:306-312` states the ruling: *"Tab is CONSUMED
  by the flip everywhere outside a typing target."* `isTypingTarget`
  (`workflow-pins.ts:298-304`) accepts `INPUT` / `TEXTAREA` / `SELECT` /
  `contentEditable`. An SVG `<g tabindex="0">` is none of those. So Tab does not walk
  the notes — it flips the rack (canvas) or the dock pane.
* **Pointerdown pre-empts the click that would focus.** `onSvgPointerDown`'s
  note branch (`:454-461`) calls `ev.preventDefault()` before capturing the pointer,
  which suppresses the compatibility mouse events that set focus in Chromium.

⚠ **Both halves are static reads; the COMBINED claim is a MUST-VERIFY (M1), not an
assertion** — "focus is unreachable" is a runtime property and this spec measures the
tree, not the browser. What IS asserted from the tree: **no e2e test anywhere
exercises note deletion.** `grep -n 'Backspace\|Delete\|deleteNote\|ArrowUp'
e2e/tests/score.spec.ts` returns nothing across its 750 lines and 17 tests.

**(b) The docs promise a click-to-remove that does not exist.**
`score.ts:178-179`, `docs.controls['score-note-{n}']`:

> *"Click an empty staff position with a note-value tool selected to add one, **click
> a note to select/remove it**; sharp/flat tools toggle its accidental."*

Clicking a note with a duration tool active starts a DRAG (`:454-461`). There is no
select. There is no remove. **`STRICT_DOCS` includes `score` (`strict-docs.ts:249`),
so this prose is on the strictest documentation tier in the repo and it describes a
control the module does not have.**

**(c) A TIE, once made, can never be removed.** `addTie` (`:382-387`) is the only
mutation of `d.ties`; the only deletion is the collateral filter inside `deleteNote`
(`:392`). So the only way to undo a tie is to delete one of its notes — and per (a),
that is itself unreachable.

⚠ **Note the shape.** These are not three bugs; they are one: **score has no SELECTION
MODEL**, so every destructive or per-note operation had to be hung off browser focus,
and browser focus was taken away by an owner ruling in a different file. §5.1 is the
design that fixes it, and it fixes it as a *consequence* of the face rather than as a
bolt-on.

### 2.2 THE AFFORDANCE INVENTORY, AND WHERE EACH ONE LANDS

| affordance | `ScoreCard.svelte` | on the face | lost? |
|---|---|---|---|
| PLAY / STOP | `:772-776` (MidiAssignButton + `<button>`) | `isPlaying` → `<Toggle>` | no — §3.3 has the migration |
| six NOTE-VALUE tools | `:782-791` | `score-value-{n}` selector | no |
| ♯ tool (per-note accidental) | `:792-800` | `score-accidental-{n}` selector | no |
| ♭ tool (per-note accidental) | `:801-809` | same cell | no |
| ♯/♭ on EMPTY staff → key sig ±1 | `:440-450` | `score-key-{n}` selector | no — and it stops being a hidden modal gesture |
| right-click ♯/♭ tool → reset key | `:621-626`, `:799`, `:808` | `score-key-{n}` → `C major` | no |
| TIE tool (two-click pick) | `:810-817`, `:419-429` | `score-tie-{n}` toggle on the SELECTION | no — and §2.1(c) is fixed |
| five DYNAMICS tools | `:818-827` | `score-dyn-{n}` selector on the SELECTION | no |
| STOP-BAR tool + drag | `:828-835`, `:409-416`, `:473-479`, `:493-497` | `score-stop-{n}` selector | no |
| LOOP toggle | `:836-843` | `score-loop-{n}` toggle | no |
| the STAFF (place / drag / select) | `:852-1021` | `score-note-{n}` **PANEL**, hero | no |
| bar-overflow SHAKE feedback | `:251-255`, `:905-914` | inside the panel, verbatim | no |
| playing-note HIGHLIGHT | `:933-947` | inside the panel, verbatim | no |
| page ‹ › nav | `:1046-1065` | inside the panel (viewport chrome) | no |
| page **+** (add) | `:1066-1073` | `score-pages-{n}` selector **1..4** | no — and §2.3 is fixed |
| BPM + A/D/S/R faders | `:1025-1029` | five param cells | no |
| QUICKSAVE (4 slots, 3 modes, reset) | `:1032-1043` | `score-slots-{n}` **PANEL** | no — §0.5 |
| PatchPanel (11 in, 4 out) | `:779` | the shell's own rail | no |
| Delete / Arrow / ♯ / ♭ **keyboard** | `:527-569` | see §2.4 | ⚠ see §2.4 |

### 2.3 ⚠ THE PAGE COUNT IS A ONE-WAY RATCHET

`addPage` (`:339-345`) is `d.pages = Math.min(MAX_PAGES, d.pages + 1)`. **There is no
decrement anywhere in the card, the def or `score-data.ts`.** `pages` is only ever
read back clamped to `1..MAX_PAGES` (`score.ts:91-94`, `ScoreCard.svelte:98-101`).

That is not cosmetic. `liveTotalGridTicks()` and `liveStopGridTick()`
(`score.ts:443-461`) both derive the sequence length from `pages`, so **adding a page
you did not want makes the piece 16 bars longer, with no way back** — the playhead
walks 768 extra grid ticks of silence on every pass unless a stop bar is placed.

The face fixes it by declaring the page count as a `selector` over `1..4` rather than a
`+` button (§5.2 rank 11). **That is a control the card should have had; making it a
ranked cell is the cheapest possible fix.** D3 in §12.

### 2.4 THE KEYBOARD HANDLERS — a NON-GOAL, stated so it is not silently dropped

`onSvgKeyDown` (`:527-569`) implements `Escape` (cancel tie pick / drag),
`Backspace`/`Delete` (remove the focused note), `ArrowUp`/`ArrowDown` (transpose it a
staff step) and `#` / `b` (toggle its accidental).

**The standing owner ruling is that this app is not keyboard-navigable and that
keyboard-a11y is never to be designed or filed** (`workflow-pins.ts:306-312`, #1629).
So this spec does **not** propose keyboard navigation, and does not propose removing
what is there.

What it does propose is that **every operation those keys perform gains a POINTER
route**, because §2.1(a) shows they are the *only* route today:

* delete a note → the panel's own gesture (§5.1: click the selected note again)
* transpose a note → drag it, which already works (`:498-517`)
* toggle its accidental → `score-accidental-{n}` (§5.2 rank 5)

The handler block moves into the panel component verbatim. It keeps working for anyone
who *can* focus a note. **Nothing is removed and nothing new is designed for the
keyboard** — the pointer routes exist for their own reasons.

---

## 3. STOP 2 — does every way of getting DATA IN survive promotion?

### 3.1 THE GREP

```
$ grep -nE '<button|<select|<input|oncontextmenu|manualTrigger|Toggle|Selector|accept=' \
    packages/web/src/lib/ui/modules/ScoreCard.svelte
744:  function onPlayToggle() { togglePlay(); }
772:    <MidiAssignButton moduleId={id} paramId="play" … onToggle={togglePlay}>
773:      <button class="play-btn" … data-testid={`score-play-${id}`}>
783:      <button                       ← the six duration tools (each in {#each})
792:      <button                       ← ♯
799:      oncontextmenu={onContextMenu} ← ♯ right-click → resetKey
801:    <button                         ← ♭
808:      oncontextmenu={onContextMenu} ← ♭ right-click → resetKey
810:    <button                         ← tie
819:      <button                       ← the five dynamics (each in {#each})
828:    <button                         ← stop-bar
836:    <button                         ← loop
865:    oncontextmenu={onContextMenu}   ← on the <svg> itself
1041:    {onPlayToggle}                 ← into QuicksaveControls
1047:    <button                         ← page ‹
1058:    <button                         ← page ›
1066:    <button                         ← page +
```

**Zero `<input`. Zero `<select`. Zero `accept=`.** (§0.4 depends on that.)

Plus, in the child component `QuicksaveControls.svelte` (208 lines):

```
64:    <button   ← the four slot buttons  (quicksave-slot-<node>-<k>)
80:    <button   ← mode SAVE              (quicksave-mode-save-<node>)
88:    <button   ← mode LOAD              (quicksave-mode-load-<node>)
96:    <button   ← mode QUEUE             (quicksave-mode-queue-<node>)
107:   <button   ← play                   (quicksave-play-<node>)
115:   <button   ← reset                  (quicksave-reset-<node>)
```

### 3.2 THE MAP — every hit to a face construct

| hit | construct after promotion |
|---|---|
| `:773` play `<button>` | `isPlaying` param cell → `<Toggle>` (`paramCellKind` → `'toggle'`, §3.3) |
| `:772` `MidiAssignButton paramId="play"` | ⚠ **`<Toggle>`'s own `makeMidiAssignable`, keyed `isPlaying` — §3.3 + a READER-side migration** |
| `:783` six duration tools | `score-value-{n}` — `ShellSelectorCell`, 6 options |
| `:792` / `:801` ♯ / ♭ | `score-accidental-{n}` — `ShellSelectorCell`, 4 options (♯ / ♮ / ♭ / none) |
| `:799` / `:808` right-click reset key | `score-key-{n}` — `ShellSelectorCell`, 15 options; `C major` is the reset |
| `:810` tie | `score-tie-{n}` — `ShellToggleCell` on the selection |
| `:819` five dynamics | `score-dyn-{n}` — `ShellSelectorCell`, 6 options (`—`, pp, p, mf, f, ff) |
| `:828` stop-bar | `score-stop-{n}` — `ShellSelectorCell` (`here` / `clear`) |
| `:836` loop | `score-loop-{n}` — `ShellToggleCell` |
| `:865` `<svg oncontextmenu>` | inside the `score-note-{n}` PANEL, verbatim |
| `:1047` / `:1058` page ‹ › | inside the PANEL (viewport chrome — §5.1) |
| `:1066` page + | `score-pages-{n}` — `ShellSelectorCell`, `1..4` (§2.3) |
| `QuicksaveControls` × 9 buttons | `score-slots-{n}` — `ShellPanelCell` wrapping the SAME component |
| `PatchPanel` | the shell's rear rail — unchanged |

**Nothing is exempted and nothing is lost.** Six of these need a new `controlFamily`
declaration; §5.2 lists them and §11.4 prices them.

### 3.3 ⚠ THE MIDI-ASSIGNABLE PLAY BUTTON — three separate findings

This is the highest-risk item in the spec and it decomposes into three independent
facts, all measured.

**(a) THE ACTION SURVIVES. The BINDING KEY DOES NOT.**

The card wraps its play button in `MidiAssignButton` with `paramId="play"`
(`ScoreCard.svelte:772`) — a **synthetic action id**, which is what that component's
own doc calls it (`MidiAssignButton.svelte:24-26`: *"Synthetic action id for this
button (e.g. 'play', 'clear'). Forms the binding key `moduleId:paramId`"*).

On the face, `isPlaying` is `curve: 'discrete', min: 0, max: 1`, so
`looksLikeToggle` (`group-controls.ts:54-56`) is true and `paramCellKind`
(`shell-control-kind.ts:316`) resolves `'toggle'` → `<Toggle>`. And `Toggle.svelte:55-62`:

```ts
const midi = makeMidiAssignable({
  kind: 'note', controlType: 'button',
  get moduleId() { return moduleId; },
  get paramId()  { return paramId;  },
  onGate: (high) => { if (high) onchange(toggledValue(value)); },
});
```

**Same factory, same `kind: 'note'`, same `controlType: 'button'`, same toggle-on-press
semantics.** So a promoted score's play toggle is MIDI-note-assignable by right-click
exactly as the card's button is — **the affordance is not lost, and this is NOT a
STOP-2 failure.**

⚠ **What IS lost is the SAVED BINDING.** `bindingKey(moduleId, paramId)` is
`` `${moduleId}:${paramId}` `` (`midi-learn.svelte.ts:102-104`), and bindings persist to
`localStorage` under `pt.midi-bindings.v1`. So:

```
card:  "<nodeId>:play"          ← what every existing user has stored
face:  "<nodeId>:isPlaying"     ← what the toggle will look up
```

**A player who bound a pad to score's PLAY before the promotion finds it dead
afterwards, with the binding still sitting in localStorage under a key nothing reads.**
Node ids are stable across reloads, so this is not theoretical.

**The fix is READER-side and needs no user action** — the `samsloop`/`momentary-params`
precedent (repair existing data on read, no migration step). One alias in the binding
lookup: when `<nodeId>:isPlaying` misses and `<nodeId>:play` hits on a node whose type
is `score`, adopt it. ⚠ **Write it as a general alias table keyed
`(type, legacyParamId) → paramId`, not a score `if`** — `MidiAssignButton`'s doc names
`'clear'` as a second synthetic id, so this class has more members than score.
D2 in §12.

**(b) ⚠ `midi-learn-note.spec.ts` IS THE #2166 CLASS, IN ITS PUREST FORM.**

Post-#2183, `bootScore` is:

```ts
await page.goto('/rack?shell=legacy&seed=none');
```

`Canvas.svelte:507` is `shellFaces = page.url?.searchParams?.get('shell') !== 'legacy'`,
and `laneRenderKind` (`legacy-fallback.ts`) returns `'legacy'` whenever
`!shellFaces` — **so under `?shell=legacy` the lane renders the verbatim
`ScoreCard.svelte`, promoted or not.**

The consequence is exact, and it is the thing CLAUDE.md's *"A gate whose PRECONDITION
is the defect cannot fail on the defect"* section is about:

> **After score is promoted, `midi-learn-note.spec.ts` STILL PASSES.** It finds
> `[data-testid="score-play-ds-1"]`, right-clicks it, binds NOTE 60, and watches
> `isPlaying` toggle — all on a surface that no default user reaches any more. It does
> not go red. It goes **green and blind**, and it would certify (a)'s orphaned-binding
> bug as fine.

**It does not "break outright" and it must not be left as-is.** The instruction is
CLAUDE.md's: **fix the SUBJECT.** Two legs, and the PR body says which:

1. **Keep** the `?shell=legacy` leg, re-titled to say what it now proves — *"the LEGACY
   card's button still binds"* — because the legacy escape hatch is a real surface and
   a real regression class.
2. **Add** the leg that matters: the same test on the DEFAULT shell, right-clicking the
   FACE's `isPlaying` toggle, asserting the binding materialises under
   `<nodeId>:isPlaying` **and** that a pre-seeded `<nodeId>:play` record still drives it
   (the (a) migration's own negative control, in both directions).

⚠ **Leg 2 is the one that can fail on the bug.** Without it, promoting score converts
the fleet's canonical button-MIDI proof into a test of a compatibility surface.

**(c) THE RE-POINT AT SCORE IS ITSELF A #2166 SELECTION.** #2183 chose score for this
fixture because score is a convenient un-faced card carrying a real MIDI-assignable
button. That property is exactly what this spec removes. ⚠ **The build agent must
check whether #2183 has merged and whether any OTHER spec re-pointed at score for the
same reason** — `grep -rn "'score'" e2e/tests` on the merged tree, and read each hit's
reason, not just its selector.

### 3.4 THE REST OF THE ENTRY-POINT MATRIX

| entry point | today | after |
|---|---|---|
| pointer on the staff | `pointerToCell` → `addNote` / `placeDynamic` / `setStopBar` / drag | unchanged, inside the panel |
| toolbar mode | component `$state` (`activeTool`) | ⚠ **moves to `node.data`** — §6.3 |
| CV: `attack/decay/sustain/release` | `paramTarget` → the ADSR worklet's AudioParams | unchanged (engine-side) |
| CV: `play_cv` / `reset_cv` | `transportCv.drain` → `isPlaying` / `tickIndex` | unchanged (engine-side) |
| CV: `queue1..4_cv` | → `data.queuedSlot` → `data.slots[k]` | ⚠ **requires §5.3** |
| external `clock` | `AnalyserNode` edge scan | unchanged |
| MIDI learn (knobs) | `NeonFader` → `makeMidiAssignable({kind:'cc'})` | the shell's own fader/knob does the same |
| MIDI learn (play button) | `MidiAssignButton`, key `:play` | ⚠ **§3.3(a)** |
| group exposure | `exposableControls: [{ id:'playStop', paramId:'isPlaying' }]` | unchanged — reads the def, not the card |
| `exposesSequence` | `GroupExposedControls.svelte:72-79` | **unchanged, and it renders a PLACEHOLDER box, not the card** (`:60-63`) — so promotion cannot break it |
| a peer's edit | `nodeVersion(id)` re-derive | unchanged |
| Cmd-Z | ❌ **never worked for the music** | ✅ fixed by D1 |

⚠ **`exposesSequence` is worth one extra line.** Post-#2183 exactly TWO modules declare
it (`contract-lock.txt:455` `clipplayer`, `:2795` `score`). It is checked here because a
reader would reasonably expect the group surface to mount the child's card; it does not.

---

## 4. THE LANE PICTURE — refused, and the mechanism is the SAME as kria's

The wave-2/3 refusals turned on `ShellExtensionGlyphProps` (`shell-extensions.ts:39-52`)
carrying `num`, `numbers`, `testid` and **no `nodeId`**, so a glyph would be
byte-identical across instances. score never reaches that seam:

**Mechanically protected, twice over.**

* `laneGlyphFor` (`module-shell-model.ts:237-240`) returns `'picture'` only for
  `hasVideoSurface(def)`, which is `def?.domain === 'video'` (`:177-179`). score is
  `domain: 'audio'` (`score.ts:107`).
* A `'trace'` glyph needs a live binding, and `glyphBinding` resolves through
  `primaryAudioOutPortId` (`shell-glyph-live.ts:111-113`):
  `def?.outputs?.find((o) => o.type === 'audio')?.id ?? null`.
  **score has NO `audio` output.** Its four are `pitch` (pitch), `gate` (gate),
  `env` (cv), `clock` (gate) — `contract-lock.txt:2807-2810`. So every glyph literal
  falls to `{kind:'static'}`, and `module-face-lint.test.ts:248-308`'s `deadGlyphProblems` reddens a dead
  glyph **unconditionally**.

**`glyph: 'none'` is therefore the only literal that compiles into a green run**, and
an author who never thinks about it ships the right thing.

**And the picture score WOULD want is strictly more than a `nodeId` prop buys.** The
useful glance is *"where is the playhead in the piece?"* — which needs `node.data.notes`
+ `data.pages` + the LIVE engine read `read('currentNoteId')` / `read('tickIndex')`
(`score.ts:706-723`). That is node data plus a per-frame engine handle, not a discrete
param value.

⚠ **This is the SAME mechanism kria refused on, and saying so is the point rather than
a weakness.** kria's own face comment (`kria.ts:199-207`) reads: *"a `nodeId` prop alone
would still not be enough here — the picture a player wants is the playhead over the
SELECTED track's SELECTED lane, which is two more pieces of node.data."* score is that
sentence with "page" substituted for "lane". **Two independent instruments landing on
the same refusal for the same structural reason is evidence the glyph seam's limit is a
SHAPE, not an oversight** — and it is the strongest form of that argument the program
has produced, because kria and score are the two modules whose lane picture would be
most valuable.

**The lane gets ranked CELLS instead**, and §5.6 argues they are the right glance
anyway.

---

## 5. THE FACE

### 5.1 ⚠ THE DESIGN DECISION THAT MAKES THIS FACE POSSIBLE: A SELECTION MODEL

The card is **MODAL**: `activeTool` (`ScoreCard.svelte:227-235`) is one of
`duration(d) | sharp | flat | tie | dynamic(level) | stopBar | select`, and every
gesture means something different depending on it. Fifteen toolbar buttons arm fifteen
modes; the staff then interprets a click.

**A modal toolbar cannot be expressed as face cells, and trying is the trap.** Fifteen
mutually-exclusive arming controls drawn as three separate selectors and two toggles
would be **five controls claiming to hold one single-valued state** — precisely the
argument `declaredParamCells` makes about its own shape (`shell-control-kind.ts:229-233`:
*"a param cannot be declared two primitives at once, because the record cannot hold two
values for one key"*). Whatever the cells showed, four of the five would be lying.

**So the face is NOT modal. It is SELECTION-BASED**, and this is the single design call
the whole spec rests on:

```
node.data.selectedNoteId : string | null     ← NEW
node.data.noteValue      : NoteDuration      ← NEW (was `activeTool.duration`)
```

* **The panel places** — click an empty staff position, and a note of
  `data.noteValue` appears there. That is the card's dominant gesture, unchanged.
* **The panel selects** — click an existing note, and it becomes
  `data.selectedNoteId`. (The card starts a drag here; the face selects AND drags, which
  is one gesture, not two: `pointerdown` selects, `pointermove` drags.)
* **Click the selected note again → delete it.** That is §2.1(a)'s missing pointer
  route, and it costs one comparison.
* **Every mark cell operates on the SELECTION**, so none of them is a mode:
  * `score-accidental-{n}` — ♯ / ♮ / ♭ / none on the selected note
  * `score-tie-{n}` — a TOGGLE: is the selected note tied to the next one in score
    order? Turning it OFF removes the tie. §2.1(c) fixed, and the card's two-click
    pick disappears.
  * `score-dyn-{n}` — the dynamic marker at the selected note's `(bar, tick)`;
    the first option is `—` (remove).
  * `score-stop-{n}` — place the stop bar at the selected note / clear it.

**Why this is better rather than merely different**, stated so it can be argued with:

1. It **eliminates a mode** the player has to remember they are in. The card's most
   confusing behaviour is that ♯ on a note means one thing and ♯ on empty staff means
   another (`:432-450`); with a selection, `score-key-{n}` is just a control.
2. It gives **every destructive operation a probe-able observable**, which a mode
   cannot have: `score-tie-{n}`'s toggle probe is a `data` write on `ties`, not "did a
   button light up".
3. It fixes §2.1(a), (b) and (c) as a **consequence**, not as three patches.
4. `kria` already ships the same construct and the same argument
   (`kria/spec.md` §6.3: *"THE SELECTION MUST LIVE IN `node.data`, AND THIS IS NOT A
   STYLE CHOICE"*) — a cell's `value(node)` receives the node and nothing else
   (`shell-cells.ts:167-183`), so a selection the cells must read has literally nowhere
   else to live.

⚠ **The cost, stated honestly: the selection SYNCS.** `node.data` rides the Y.Doc, so
two collaborators editing one score share a selection cursor. kria has the identical
property for its track/lane selection and shipped with it. **It is a real downside and
the alternative is worse** — a component-local selection is invisible to
`value(node)`, which would make every mark cell inert. Recorded as a taste call in §13
with its one-line revert.

⚠ **`data.noteValue` and `data.selectedNoteId` must be seeded lazily, never eagerly.**
An absent `noteValue` reads as `'quarter'` (the card's default, `:235`); an absent
`selectedNoteId` reads as `null` and every mark cell renders DISABLED. **A face that
writes defaults into `node.data` on mount would dirty every saved patch on open** and
push a Y.Doc update to every collaborator for doing nothing. M6 in §14.

### 5.2 RANK — `face.order`

```ts
face: {
  glyph: 'none',                       // MANDATORY — §4
  hero:  { cell: 'score-note-{n}' },   // PF-22: the staff ranks FIRST at no lane cost
  order: [
    'score-note-{n}',      //  1  THE STAFF — the module
    'isPlaying',           //  2  transport
    'bpm',                 //  3  tempo (only when CLOCK IN is unpatched)
    'score-value-{n}',     //  4  the note value the next click places
    'score-accidental-{n}',//  5  ♯ / ♮ / ♭ on the selection
    'score-dyn-{n}',       //  6  the dynamic at the selection
    'score-tie-{n}',       //  7  tie the selection to the next note
    'score-stop-{n}',      //  8  the stop-music bar
    'score-loop-{n}',      //  9  loop at the stop bar
    'score-key-{n}',       // 10  key signature
    'score-pages-{n}',     // 11  how many pages the piece is
    'attack', 'decay',     // 12-15  the built-in ADSR
    'sustain', 'release',
    'score-slots-{n}',     // 16  quicksave — §5.3
  ],
  pages: [ … ],                        // §5.4
}
```

**The rank is argued against the DSP and the docs, not against declaration order.**
Each of these would be wrong for a different module, which is the test:

* **The staff first** because it is the only thing that makes a note sound. PF-22
  (`curated-face.ts:131-143`) drops a declared `hero.cell` from `laneOrder`, so ranking
  it first costs **zero** lane ranks — the mechanism `kria` is named in as the first
  adopter of.
* **`isPlaying` second, `bpm` third**, and the order between them is not arbitrary:
  `bpm` is a FALLBACK. `tick()` (`score.ts:597`) reads `isClockInConnected()` first and
  runs the external-clock branch when a cable is present, ignoring BPM entirely.
  `isPlaying` has no such conditional (and `shouldSequencerRun` makes clock-only mode
  work regardless), so the transport is unconditionally applicable and the tempo is not.
* **`score-value-{n}` fourth** because it is the only cell that affects the NEXT
  gesture rather than the current selection — you set it before you click, every time.
* **Ranks 5-8 are the marks**, in the order a piece acquires them: pitch spelling →
  loudness → phrasing → where it ends.
* **`score-loop-{n}` ninth, immediately after `score-stop-{n}`**, because
  `liveStopGridTick` (`score.ts:451-461`) makes them one decision: the stop bar says
  WHERE the piece ends and `loop` says WHAT HAPPENS THERE. They are a cluster, not two
  ideas (§5.4).
* **`score-key-{n}` tenth, not higher**, and this is the demotion most worth defending.
  A key signature *feels* like a headline setting. It is not: `staffStepToMidi`
  (`score-data.ts:334-353`) applies it only to notes whose `accidental === null`, and
  `cycleKey` (`:364-372`) rewrites those notes' MIDI in place. So it is a bulk
  respelling operation you perform ONCE, at the start, and it never applies to a note
  you have explicitly marked. It is the definition of "set and forget".
* **`score-pages-{n}` eleventh** — a structural setting, changed rarely, but ranked
  (not buried in the panel) because §2.3 makes shrinking it a *repair* the player needs
  a control for.
* **The ADSR 12-15**, together, at the bottom of the ranked list. They are a VOICE
  bolted to a SEQUENCER: the ENV output is optional in every patch that drives a real
  envelope from `gate`. `sustain` before `release` mirrors the classic order the def's
  own labels use (`A`, `D`, `S`, `R`).
* **`score-slots-{n}` last** and it is deliberately last: quicksave is a *performance*
  affordance you reach for after the piece exists, and it is the largest cell after the
  staff (§5.3), so trailing it keeps the band packing sane.

**Read back as a sentence:** *write the notes; start it; set the tempo; choose what the
next click writes; then spell, shade, phrase and end what you selected; then the key,
the length, the envelope, and finally the snapshots.*

### 5.3 THE TWO PANELS — and why quicksave is one of them

`score-note-{n}` → `ShellPanelCell`:

```ts
'score-note-{n}': {
  kind: 'panel',
  label: 'staff',                     // NOT 'the score' — see below
  component: ScoreStaffPanel,
  minWidth: 720,                      // derived in §5.5, not chosen
  probe: {
    testid: 'score-staff',            // the panel's own staff surface
    action: 'click',
    effect: { kind: 'data', key: 'notes', expect: 'changed' },
  },
},
```

⚠ **`label: 'staff'`, not `'the score'`.** The mixmstrs ruling: a per-control caption
earns its place when it disambiguates otherwise-identical controls. This face carries
**two** panels, so the caption's job is to say WHICH picture — and `'the score'` would
also restate the module name the dock title bar already paints. (kria's `'the grid'`
passes the same test for the same reason.)

⚠ **The probe is `data`, not `data-rev`, and it is aimed at the SHIPPED default state.**
`shell-cells.ts` warns: *"A revision-only probe passes on a DEAD button that bumps the
counter without editing anything."* A fresh score has `notes: []` and
`data.noteValue` absent ⇒ `'quarter'`, so ONE click on an empty staff position writes a
quarter note and `notes` changes. **No setup, no seeding, no mode to arm.** That is
what makes it a real probe rather than a ceremony.

`score-slots-{n}` → `ShellPanelCell`:

```ts
'score-slots-{n}': {
  kind: 'panel',
  label: 'quicksave',
  component: ScoreSlotsPanel,         // wraps the EXISTING QuicksaveControls.svelte
  minWidth: 300,                      // MEASURE IT (M3) — do not guess
  probe: {
    testid: 'quicksave-mode-save',
    action: 'click',
    effect: { kind: 'data', key: 'pendingMode', expect: 'changed' },
  },
},
```

⚠ **The probe clicks the MODE button, not a slot, and the reason is measured.**
`coercePendingMode` (`transport-helpers.ts:69-72`) returns `null` for anything that is
not `'save' | 'load' | 'queue'`, so a fresh node has NO pending mode, and
`resolveSlotClick(null, slot)` (`:215-220`) returns `{ kind: 'noop' }` **by design**.
A single-click probe on a slot would therefore be red on a perfectly live widget. The
mode button writes `data.pendingMode` on the first click, which is the strongest
one-click observable this widget has.

⚠ **STATE THE PROBE'S SCOPE INSIDE THE PROBE.** It proves the widget reaches
`node.data`; it does **not** prove that SAVE saves. That half is
`transport-card.test.ts` + `transport-helpers.test.ts` in the pure lane, and the
comment must say so, because a probe that looks complete and is not is the exact class
this program keeps finding.

⚠ **Why quicksave is a PANEL and not three cells.** It is nine buttons implementing a
mode-then-target interaction over `node.data.slots`. Decomposing it into a mode
`selector` + four `action`s would be four cells for one widget, would need four new
families, and would still need somewhere to show WHICH slots are populated. It is
"one picture-you-edit inside the generic face" — the literal words of the `panel`
kind's own doc — and the component already exists and is already tested. **Reuse it;
do not re-implement it.**

⚠ **TWO panels on one face has no precedent in the tree.** Nothing forbids it —
`panelCellKeys()` (`shell-cells.ts:2045-2058`) filters on `kind === 'panel'` for the
dock-only rule and never counts — but "no precedent" is a thing to verify rather than
assume. **M5 in §14.**

⚠ **AND THE SECOND PANEL IS PROTECTED BY ITS RANK, NOT BY A RULE — which is exactly the
fragility `panelCellKeys`'s own comment names.** `score-note-{n}` is the `hero.cell`, so
`laneOrder` drops it and it can never be selected at a lane tier. `score-slots-{n}` is
**not** the hero, so it stays in `laneOrder` — at position 15, against a `full` cap of
6. It is safe today because 15 > 6, and the comment beside `panelCellKeys` says of
precisely this arithmetic: *"relying on `PLATE_COLS * PLATE_MAX_ROWS` to truncate it is
not a guard — it is a coincidence that a future cap bump silently removes."* The lint
does catch a panel that IS selected, so this cannot ship broken — **but any re-rank that
moves `score-slots-{n}` above rank 6 turns a taste change into a red run**, and the
reason will not be obvious from the diff. Say so in the `face` block's comment.

### 5.4 BANDS — FIVE, honestly, and the tab rail is an OWNER CALL

```ts
pages: [
  { id: 'score', label: 'score',
    controls: ['score-note-{n}', 'score-value-{n}', 'score-accidental-{n}', 'score-key-{n}'],
    hint: '…' },
  { id: 'marks', label: 'marks',
    controls: ['score-dyn-{n}', 'score-tie-{n}', 'score-stop-{n}', 'score-loop-{n}'],
    clusters: [{ label: 'ending', controls: ['score-stop-{n}', 'score-loop-{n}'] }],
    hint: '…' },
  { id: 'transport', label: 'transport',
    controls: ['isPlaying', 'bpm', 'score-pages-{n}'], hint: '…' },
  { id: 'envelope', label: 'envelope',
    controls: ['attack', 'decay', 'sustain', 'release'], hint: '…' },
  { id: 'slots', label: 'slots',
    controls: ['score-slots-{n}'], hint: '…' },
],
```

**Five bands. `DOCK_TAB_MIN_BANDS = 7` (`dock-tabs-model.ts:101`). No rail.**

⚠ **AND THAT IS THE OWNER QUESTION THIS SPEC EXISTS TO ASK.** The owner's
control-heavy ruling (2026-08-18) is *"lots of controls of DIFFERENT types → a
backdraft-style tab rail"*, and score is the clearest instance of "different types" in
the fleet: **a picture-you-edit, a second picture-you-edit, five selectors, two
toggles, five faders and a discrete transport switch — six distinct primitives.**

The skill is equally clear about what an author may NOT do:

> *"If a heavy module's honest semantic grouping lands at 5-6 pages — under the rail
> threshold — **do not pad pages to force the rail**; raise it to the owner instead."*

So this spec does not pad. It records what padding would look like, so the owner can
see the shape of the thing being refused: splitting `score` into `notes` + `key`,
`marks` into `dynamics` + `phrasing`, and `transport` into `transport` + `length`
would reach seven — and every one of those splits is one control in a band of its own.

**Three routes, and the choice is the owner's:**

| route | cost | consequence |
|---|---|---|
| **A — ship five bands, one column** (this spec's default) | zero | correct by the current rule; `ruttetra` shipped untabbed under the same reasoning |
| **B — `face.tabbed: true`** | one line + a verbatim `FACE_TAB_OPT_IN` entry | ⚠ **OWNER-INSTRUCTION ONLY** (`dock-tabs-model.ts:54-69`). The spec may not reach for it. Today's only adopter is `spirographs` |
| **C — lower `DOCK_TAB_MIN_BANDS`** | ⚠ **re-pins every dock baseline it newly captures** and changes how every 3-6 page face reads | a baseline-moving platform decision for one module's structure — refused by `dock-tabs-model.ts:70-74`'s own note |

**ROUTE A IS RULED, AND IT IS THIS SPEC'S SHIPPING ANSWER.** Route B is one line if the
owner later says so, in their own words, in `FACE_TAB_OPT_IN`.

### 5.4.1 ⚠ THE THRESHOLD IS THE REAL QUESTION, AND IT IS BIGGER THAN `score`

Route A is right *under the current rule*. Whether the current rule is right is a separate
question, and this wave produced the first evidence that can actually answer it — because
**three modules have now hit the same gap independently, from three different directions:**

| module | honest semantic grouping | threshold | outcome |
|---|---|---|---|
| `ruttetra` | 12 params | 7 bands | shipped **untabbed** — the owner ruled it so in the same breath as ruling `spirographs` tabbed at three |
| **`score`** (this spec) | **5 bands**, six distinct primitives | 7 | untabbed, and **all five bands fall below the fold** (measured above) |
| **`numpadPlus`** (`../numpadPlus/spec.md`) | **4 bands**, five distinct cell kinds | 7 | untabbed |

**None of the three is a heavy module that failed to earn a rail. All three are modules the
control-heavy ruling describes and the threshold refuses.** `score` and `numpadPlus` are the
two most control-heavy modules left on the roster and they land at 5 and 4; `ruttetra` is the
ruling's own first named application and it landed at 12 params in 3 pages.

⚠ **That is the shape of a rule and a threshold disagreeing in a region, not three
coincidences** — and it is worth stating precisely because each module on its own reads as a
near-miss that the author should simply accept. Three near-misses in the same direction is a
measurement.

**It is not this spec's call and it is not the orchestrator's.** `dock-tabs-model.ts:70-74`
says so itself: moving `DOCK_TAB_MIN_BANDS` re-pins every dock baseline it newly captures and
changes how every 3–6 page face reads. **A baseline-moving decision belongs to the owner**,
which is exactly why route C is refused here rather than argued for. Recorded so the owner
reads the accumulated evidence where the decision lives, rather than meeting it one module at
a time and correctly declining each one.

⚠ **AND ROUTE A HAS A MEASURED CONSEQUENCE ON THE DOCK.** `DockFullView.svelte:384` is
`max-height: min(60vh, 680px)` with its own scroll region. The staff panel is
**374 px** tall (`TOTAL_HEIGHT = ROW_TOP_PAD 18 + ROWS_PER_PAGE 4 × ROW_HEIGHT 80 + 36`,
`ScoreCard.svelte:164`) before its toolbar and page nav — call it ~420 px in the hero
band. **So on a 720p dock the staff fills the fold and all five bands sit below it.**
Route B would put one band at a time beside a rail instead. That is a design argument
for the rail, and it is the owner's to weigh; it is also §10's VRT warning.

### 5.5 WIDTH — EARNED, and the number is DERIVED

The owner ruling is *"we do not want useless gray horizontal space on cards, ever.
prefer compact."* A genuine earner is *a live picture, a scope trace, a video preview,
an XY pad, or a control that appears in one mode only.* **The staff is a
picture-you-edit and is the first item on that list.**

But "it is a picture" is not a number, so here is the number.

`ScoreCard.svelte:149-156`:

```
CARD_WIDTH    = 720
ROW_LEFT_PAD  =  60     (clef + key signature gutter)
ROW_RIGHT_PAD =  12
ROW_INNER_W   = 720 - 60 - 12 = 648
BAR_W         = 648 / BARS_PER_ROW(4) = 162
TICK_PX       = 162 / TICKS_PER_BAR(48) = 3.375
```

**The floor comes from glyph collision, not from taste:**

| spacing | ticks | px at `TICK_PX = 3.375` | vs the 18 px notehead (`.notehead { font-size: 18px }`, `:1176`) |
|---|---|---|---|
| sixteenth | 3 | **10.13** | 56 % of a glyph — already overlapping |
| triplet 8th | 4 | **13.50** | 75 % |
| eighth | 6 | 20.25 | 113 % |
| quarter | 12 | 40.5 | 225 % |

At 720 px a bar of sixteenths **already** draws noteheads closer together than a
notehead is wide. Take 20 % off the plate and a sixteenth run is 8.1 px apart, which is
not tight — it is unreadable. **720 px is at the collision floor for the resolution the
toolbar can place, and that is what earns it.**

The alternative that would be narrower is fewer bars per row: 2 bars/row × 8 rows is
~360 px wide and `18 + 8×80 + 36 = 694 px` tall. **That is worse**, and measurably so —
694 px exceeds the dock's own `min(60vh, 680px)` fold, so a portrait staff would not fit
the pane it lives in.

**No width exemption is needed, and this is a real check rather than an assumption.**
`workflow-shell-faces.spec.ts:441` measures `slack = bodyW - contentW` against
`FACE_WIDTH_SLACK_MAX_PX = 40` (`:224`) — a SLACK ceiling, not a width ceiling. score's
panel **defines** the body, so its slack is the ordinary 15 px / 33 px mode the
threshold note documents as normal. `FACE_WIDTH_EXEMPTIONS` gets **no new entry**, and
`PLATE_FLOOR_EXEMPTIONS` (`face-width-source.test.ts:88`) stays empty.

⚠ **Do NOT put a `max-width` on `.faceplate-body`.** `face-width-source.test.ts:146-176`
denies it outright and the gate is right — a clamp CLIPS a wide face where a scroll
REVEALS it. If the staff must be capped, the cap belongs INSIDE `ScoreStaffPanel`, on
its own scroll box, which is the matrixMix resolution and is a component's internal
layout rather than a platform hatch.

### 5.6 THE LANE TIERS — what a score looks like at 192 px

`laneOrder(face)` (`curated-face.ts:131-143`) drops the declared `hero.cell`, so the
lane roster is `face.order` minus `score-note-{n}`:

```
isPlaying · bpm · score-value · score-accidental · score-dyn · score-tie · …
```

Tier caps are GEOMETRY, not an authored ladder. `FACE_TIER_CAPS`
(`curated-face.ts:75-80`) is `mini: 1`, `compact: LANE_ROW_MAX_CELLS`,
`full: LANE_PLATE_MAX_CELLS`, `dock: Infinity`, and the numbers resolve in
`module-shell-model.ts:366-368` + `:473`: **`LANE_ROW_MAX_CELLS = 3`,
`LANE_ROW_MAX_CELLS_WITH_GLYPH = 2`, `PLATE_COLS × PLATE_MAX_ROWS = 6`.** score declares
`glyph: 'none'`, so `compact` gets **three**, not two:

| tier | shows |
|---|---|
| `mini` | `isPlaying` |
| `compact` | `isPlaying` · `bpm` · `score-value` |
| `full` | + `score-accidental` · `score-dyn` · `score-tie` |
| `dock` | everything, staff first |

⚠ **The tier is named `'full'`, not `'plate'`** (`FaceTier`, `curated-face.ts:49`) — the
lane's own biggest tier, not the dock. Use `faceTierCap(tier, laneGlyphFor(def))`
(`:279`) and never a raw `FACE_TIER_CAPS` lookup: the file's own note (`:68-73`) records
that a hand-rolled glyph predicate is how *"faces documented a 3-control compact tile the
shell truncated to 2"*.

**That is the right glance for a sequencer in a rack**: is it running, how fast, and
what am I about to write. It is strictly more than today, where an un-promoted score
renders a `module-shell-placeholder` tile (`laneRenderKind`) that says nothing at all.

⚠ **ASSERT THE CELLS ARE PRESENT, NOT MERELY THAT THE FACE RESOLVES.** The `joystick`
shape (#1974, `module-face-lint.test.ts:2984-3014`) is a face that ranks controls and
renders ZERO of them at every lane tier, and it happened because `laneOrder` dropped
the anchor and `foldedOrder` dropped its partner. score declares no `xyPads`, so
`foldedOrder` is a no-op here — but that is the kind of claim that must be measured
per module, not inherited. **M7 in §14.**

---

## 6. THE COMPONENTS

### 6.1 WHY `panel` CELLS AND NOT A `fullViewBody` EXTENSION

`fullViewBody` was the first candidate — it is wired
(`WIRED_SHELL_EXTENSION_SLOTS = ['glyph', 'fullViewBody']`, `shell-extensions.ts:124`),
it takes `nodeId`, it paints full-width at the head of the dock, and it is what
`backdraft` / `videoOut` / `cameraInput` use. It loses on three measurements:

1. **It requires no probe, so no gate proves it is alive.** A `ShellPanelCell` requires
   one (`shell-cells.ts:385-392`, `probe` is non-optional) and
   `shell-cells.test.ts:57-79` sweeps every promoted face for inert cells. **A staff
   nobody can prove is clickable is exactly the sixstrum failure** (a face over an
   instrument that could not be sounded, which passed because the action branch asserted
   `toBeEnabled()` and nothing else).
2. **It is DOCK-ONLY** (`dockFullViewHeadPlan`, `module-shell-model.ts:864-882`:
   `extBody = dock && hasExtensionBody`). A panel is also dock-only, but a panel is a
   RANKED KEY, so the three families the def already declares are satisfied by it. A
   body satisfies no key, and score's three declared `controlFamilies` each still need
   a cell or `module-face-lint`'s completeness gate (`:312-355`) is red.
3. **`kria` is the shipped precedent for exactly this shape** and chose the panel for
   reason 1.

⚠ **They are NOT mutually exclusive** — `ModuleShell.svelte:1496-1501` paints `extBody`
and `:1535` then paints the hero rail, so a face may have both. score does not need
both, and adding an extension would put the quicksave row ABOVE the staff, which is
upside down.

⚠ **Never `editorSurface`.** `shell-extensions.ts:75-79` describes it as *"a bespoke
EDITOR SURFACE for controls that are not cell-shaped at all (a clip arranger, a pad
matrix)"* — a notation editor is squarely in that description. **It is still the wrong
slot**: it is DECLARED and **UNWIRED**, and its own note requires the first adopter to
wire the ModuleShell render site in the same diff. A face PR is not the place to load a
third platform slot.

### 6.2 `ScoreStaffPanel.svelte` — the third renderer of one grid

`packages/web/src/lib/ui/modules/score/ScoreStaffPanel.svelte`, `{ nodeId }`.

It is `ScoreCard.svelte:768-1076` minus the title, the PatchPanel, the fader row and
the QuicksaveControls — i.e. the toolbar's note-value strip, the staff `<svg>`, and the
page nav. **Lifted, not rewritten.**

⚠ **KEEP EVERY `data-testid` VERBATIM.** `score.spec.ts` drives
`score-staff-<node>`, `score-note-<node>-<noteId>`, `score-tie-<node>-<tieId>`,
`score-dyn-<node>-<dynId>`, `score-stop-bar-<node>`, `score-highlight-<node>`,
`score-shake-<node>-<bar>`, `score-page-counter-<node>`, `score-page-{prev,next,add}-<node>`,
`score-tool-<name>-<node>`. There is no reason for a rename, and every rename is a spec
edit that hides a real behaviour change inside a diff of selector churn.

⚠ **THE GRID MUST BE IMPORTED, NEVER RE-DERIVED.** `score-data.ts:148-151` says why, in
its own words:

> *"This is exported from the pure module so the gate calls THE SAME function the
> engine calls. A re-typed copy of 'which ticks does the scheduler visit' in a test is
> precisely how a placement grid and a playback grid drift apart without anything going
> red — which is the bug above, stated as a process."*

The panel is the THIRD consumer of that grid (engine, card, panel). It imports
`TICKS_PER_BAR`, `BARS_PER_ROW`, `ROWS_PER_PAGE`, `BARS_PER_PAGE`, `MAX_PAGES`,
`tickWidth`, `quantizeTick`, `canPlace`, `staffStepToMidi`, `keySignatureLetters`,
`totalBars` and `SMUFL` from `score-data.ts`. **Zero re-typed constants.** The layout
constants (`CARD_WIDTH`, `ROW_HEIGHT`, `STAFF_LINE_GAP`…) move OUT of the card into
`score-layout.ts` and both surfaces import them, so the card and the panel cannot
disagree about where a note is drawn while both still exist.

### 6.3 `activeTool` → `node.data.noteValue`: what moves and what does NOT

The card's `activeTool` carries fifteen states. Under §5.1 only ONE of them survives as
persistent state — **which note value the next click places** — because every other
"tool" became a cell operating on the selection.

```
data.noteValue      : 'whole'|'half'|'quarter'|'eighth'|'16th'|'triplet8th'   (absent ⇒ 'quarter')
data.selectedNoteId : string | null                                          (absent ⇒ null)
```

⚠ **Do NOT move the drag state, the tie-pick state or `shakeBar` into `node.data`.**
`dragNoteId`, `dragOffset`, `dragStopBar` and `shakeBar` are per-frame interaction
state; putting them in the Y.Doc would push an update per pointermove to every
collaborator. They stay component `$state`, exactly as they are.

⚠ **`currentPage` is the interesting middle case, and the answer is: it STAYS
component-local.** It is a VIEWPORT position, not a document property — one player
looking at page 3 must not scroll everyone else's screen, which is the exact
distinction `ShellPanelProbe`'s `text` kind was invented for
(`shell-cells.ts:369-378`: *"one player zooming their own plot must not re-zoom
everyone else's screen and dirty the patch"*). It also means the panel's page nav needs
no ranked key — it is the picture's own scrollbar. **`data.pages` (how long the piece
is) and `currentPage` (which part I am looking at) are different things and the card
already treats them so.**

### 6.4 `ScoreSlotsPanel.svelte`

`packages/web/src/lib/ui/modules/score/ScoreSlotsPanel.svelte`, `{ nodeId }`. It builds
the same `TransportCardDeps` object the card builds (`ScoreCard.svelte:661-735`) and
renders `QuicksaveControls` with it.

⚠ **EXTRACT `transportDeps`, do not copy it.** That object is 75 lines of live-read
discipline including a getter for `nodeId` whose comment
(`ScoreCard.svelte:662-666`) records a real bug — *"XYFlow may reuse a card instance for
a different node, and a stale nodeId would write this sequencer's quicksave slots into
ANOTHER node."* A second copy is that bug waiting to be reintroduced in a file nobody
associates with it. Move it to `score-transport-deps.ts`; the card imports it too.

⚠ **The `onPlayToggle` / `onReset` wiring must keep using `setNodeParam`**, not a raw
write. `onReset` (`:745-750`) does a 1 → 0 → rAF → 1 dance on `isPlaying`; that is
origin-tagged today and must stay so.

### 6.5 SCREEN ON/OFF and MONITOR MODE — both refused, for different reasons

**SCREEN ON/OFF: not applicable.** The fleet-standard preview toggle is a VIDEO ruling.
`video-face-screen-source.test.ts` sweeps `listVideoModuleDefs() ∩ STRICT_FACES`; score
is `domain: 'audio'` and is invisible to it in both directions. On the merits: the staff
IS the module, and collapsing it leaves a plate with a play switch and a tempo knob —
which is not a compact view of score, it is a different and useless module. `kria`,
`dockscope`, `spectrograph` and `samsloop` all refuse on that argument and score is
squarely with them.

**MONITOR MODE (#2009): refused, and mechanically blocked anyway.**
`faceMonitorPlan` (`module-shell-model.ts:895-925`) makes `bandsHidden` conditional on
`extBody`, and `face-monitor-source.test.ts` denies a `monitor` declaration on a face
whose extension does not own a `fullViewBody` that reads and writes `hideControls`.
score declares no extension (§6.1), so it cannot declare `monitor` even if it wanted to.
⚠ **And it is worth checking rather than assuming the reverse direction too:** the gate
also reddens a FACED module whose legacy card still mounts `hideControls`.
`ScoreCard.svelte` contains no `hideControls` — grep returns nothing — so no exemption
is owed. **M8 in §14.**

---

## 7. ⚠ THE RESTING-TEXT RULING — the highest-risk section in this wave

**score is a module whose name is about a number.** It draws notation, it counts pages,
it walks a playhead, it has a tempo and it scales an envelope by a dynamic. Every one of
those is a candidate for exactly the shape the owner has now refused four times. So this
section draws the line explicitly, in three lists.

### 7.1 THE RULE, as the gate states it

`face-resting-text-source.test.ts:110-120` enumerates the PERMITTED TEXT ROLES and
denies everything else — on the TYPE, before a module adopts it:

```ts
type TextRole = 'none' | 'section-label' | 'control-caption' | 'option-name' | 'annotation';
```

> *"the module NAME (dock title bar), TAB/SECTION labels, CONTROL CAPTIONS, and
> OPTION/LANDMARK NAMES that disambiguate a control's own position. A value, a
> measurement, a state word or a sentence has no place — its home is `aria-valuetext`
> on the control it describes."*

⚠ And the gate states its own blind spot: **text drawn INTO a canvas or an SVG is
invisible to it.** *"Only the dock VRT baselines and a human reviewing them can see
that."* score is the module where that blind spot matters most, which is why the next
two lists exist.

### 7.2 WHAT PAINTS, AND UNDER WHICH ROLE

| painted string | role | why it is permitted |
|---|---|---|
| `SCORE` in the dock title bar | module NAME | the shell paints it; not a face field |
| `score` · `marks` · `transport` · `envelope` · `slots` | `section-label` | band labels |
| `BPM` `A` `D` `S` `R` `PLAY` | `control-caption` | `ParamDef.label`, verbatim |
| `staff` · `quicksave` | `control-caption` | the two panels' `label` — and they disambiguate each other (§5.3) |
| `VALUE` `ACC` `DYN` `TIE` `END` `LOOP` `KEY` `PAGES` | `control-caption` | each cell's `tag` (`ShellSelectorCell.tag`) |
| `quarter` in the VALUE selector | `option-name` | the selected option's own name |
| `mf` in the DYN selector | `option-name` | a musical NAME, not a number |
| `G major` in the KEY selector | `option-name` | the name of the state the control is in |
| `3` in the PAGES selector | `option-name` | ⚠ see §7.4 |
| `here` / `clear` in the END selector | `option-name` | states, named |

⚠ **A selector paints its selected option, and that is settled, shipped behaviour**, not
a licence this spec is inventing: `kria` ships `FROM`/`LEN`/`DIV`/`DIR`/`SCALE`/`ROOT`
selector cells whose values paint (`shell-cells.ts:1829-1884`), and
`face-resting-text-source` is green over them. **The role is `option-name`: it
disambiguates the control's own position, which is precisely the sentence the ruling
permits.**

### 7.3 ⚠ WHAT IS FORBIDDEN — the list a builder must be able to recite

None of these may appear on the resting faceplate, in any shape, and each is a thing
somebody would plausibly add to a *score* face:

* ❌ **a playhead position readout** — `bar 3 · beat 2`, `12 / 64`, `0:14`. It is
  derived state. It lives in `aria-valuetext` on the staff panel.
* ❌ **a note count** — `47 notes`, `page 2: 12 notes`.
* ❌ **the tempo as a number under the BPM knob** — the mechanism deleted 2026-08-17.
* ❌ **a transport word** — `PLAYING` / `STOPPED` beside the toggle. It is a state
  word; the toggle's own position says it.
* ❌ **a dynamic percentage** — the card's `title` attribute renders
  `Math.round(DYNAMIC_SCALE[level] * 100)` (`ScoreCard.svelte:824`). A `title` is
  unpainted and may stay; a painted `55 %` may not.
* ❌ **a bare page counter as chrome** — the card's `.page-counter` (`:1055-1057`) paints
  `{currentPage + 1} / {totalPages}` as a standalone `<span>`. On the FACE that string
  may only exist as the PAGES selector's option name (§7.4), or inside the panel's own
  nav where it labels the ‹ › buttons.
* ❌ **a "score is empty" hint on the plate.** Instructional copy belongs in the empty
  PICTURE, not in chrome.
* ❌ **any hover-reveal of the above.** *"i want the data gone, not there but hidden or
  something"* — refused by name, and `persistentReadout` is deleted so it cannot come
  back.

### 7.4 ⚠ THE ONE GENUINELY HARD CASE: the page indicator

The card paints `1 / 4` in a `.page-counter` span. On the face that string can exist in
**two different places with two different verdicts**, and confusing them is how this
face would ship a violation:

* **In the `score-pages-{n}` SELECTOR — PERMITTED.** The roster is `1, 2, 3, 4`, the
  selected option is the piece's length, and the painted glyph is that option's name.
  Role: `option-name`. Exactly kria's `LEN 16`.
* **In the PANEL's page nav — it is the PICTURE, and a human judges it.** The nav is
  three buttons plus a viewport label. `‹ 2/4 ›` inside the picture is the staff's own
  scrollbar position and is invisible to the source gate. **This spec's ruling: keep the
  ‹ › buttons and DROP the numeral**, and let the staff itself say which page you are on
  — the way a book does. If a page indicator survives, it must be the SELECTOR's, not
  two of them.

⚠ **Two page indicators would be a violation whichever one is "allowed"**, because the
second one is a derived restatement of the first. One control, one place.

### 7.5 WHAT IS DRAWN INTO THE PICTURE, AND WHY IT IS NOT "RESTING TEXT"

The staff panel draws a great deal of text. **None of it is resting derived-state
chrome, and the distinction is that it is the DOCUMENT, not a readout of the module:**

| drawn | what it is |
|---|---|
| the G clef, the `4`/`4` time signature | notation the score is written IN |
| key-signature ♯/♭ glyphs on the staff lines | the key signature, drawn where notation draws it |
| noteheads, stems, flags, per-note ♯/♮/♭ | **the music the player wrote** |
| tie arcs | the same |
| `pp` `p` `mf` `f` `ff` italic marks on the staff | ⚠ **the same — these are MARKS THE PLAYER PLACED**, at positions the player chose. They are content, exactly like the text of a sticky note. They are not a readout of `DYNAMIC_SCALE` |
| the stop-music double bar | the same |
| the playing-note highlight rect | a highlight, not text |
| the bar-overflow shake | feedback, not text |

⚠ **What may NOT be added to the picture**, because it would be derived chrome wearing
notation's clothes: **bar numbers, a tick ruler, beat subdivision marks, a
"page 2 of 4" watermark, or a tempo marking the module derives from `bpm`.** A real
engraver would draw bar numbers; this module does not, and adding them under cover of
"it is notation" is how a fifth mechanism gets in. **The card draws none of them today
— keep it that way, and say so in the PR body so the VRT reviewer knows what to look
for.**

### 7.6 THE ARIA CONTRACT — where every deleted number goes

| control | `aria-valuetext` |
|---|---|
| `score-note-{n}` panel | `"<N> notes over <M> bars; playing bar <B>, beat <T>"` — the whole playhead readout, unpainted |
| `isPlaying` | `"playing"` / `"stopped"` |
| `bpm` | `"120 BPM"` — and *"external clock"* while `clock` is patched, because the knob is inert then (§5.2) |
| `score-value-{n}` | `"quarter note"` |
| `score-accidental-{n}` | `"sharp"` / `"natural"` / `"flat"` / `"none"` — or `"no note selected"` |
| `score-dyn-{n}` | `"mezzo-forte"` |
| `score-tie-{n}` | `"tied to the next note"` / `"not tied"` / `"no note selected"` |
| `score-key-{n}` | `"G major, one sharp"` |
| `score-pages-{n}` | `"3 pages, 48 bars"` |
| `score-stop-{n}` | `"ends at bar 12"` / `"plays to the end"` |
| `score-loop-{n}` | `"loops at the end"` / `"stops at the end"` |
| `attack/decay/sustain/release` | `"5 ms"` / `"0.70"` etc. |
| `score-slots-{n}` panel | `"slots 1 and 3 saved; slot 1 last loaded"` |

⚠ **Every spec proving the face tracks the graph reads the ARIA, never the pixels.**
That is what makes §10's VRT position safe and what let the readout removals ship
without weakening a single assertion.

⚠ **And one finding really does lose its painted surface**, which the ruling requires be
said out loud rather than allowed to lapse quietly: **the card's dynamics tooltips are
the only place `DYNAMIC_SCALE` is legible to a player** (`ScoreCard.svelte:824`), and
`ff = 1.045` is a value **above unity** (`score-data.ts:102`) — the one dynamic that can
push the ENV output past full scale. That arithmetic survives in
`score-data.test.ts` and must gain a `score-face-model.test.ts` leg; it gets no
renderer, by ruling.

---

## 8. THE STATE MATRIX

| # | state | what the face shows | negative control |
|---|---|---|---|
| 1 | fresh spawn | empty 4-row staff, 1 page, VALUE `quarter`, every mark cell DISABLED (no selection) | ⚠ `node.data` must be UNWRITTEN — M6 |
| 2 | a note selected | mark cells ENABLE and read that note's state | deselect ⇒ they disable again |
| 3 | selected note is tied | `score-tie-{n}` reads ON | untie ⇒ `ties` shrinks, arc disappears |
| 4 | `clock` patched | `bpm` cell reads `"external clock"` in aria | unpatch ⇒ it reads the number again |
| 5 | playing | the panel highlights the sounding note, from `read('currentNoteId')` | stop ⇒ the highlight clears within a frame |
| 6 | stop bar set, loop OFF | playhead stops there; `isPlaying` returns to 0 (`score.ts:651-654`) | loop ON ⇒ it wraps to 0 instead |
| 7 | pages 4 → 1 with notes on page 3 | ⚠ **the notes SURVIVE in `node.data` and stop sounding** — `noteStartingAt` never reaches them | grow back to 4 ⇒ they sound again. **This is the fix in §2.3 and it must be non-destructive** |
| 8 | slot 1 saved, `queue1_cv` fires | the pattern swaps at the end of the pass (`maybeApplyQueuedSlot`) | slot 1 empty ⇒ nothing happens, `queuedSlot` clears |
| 9 | two collaborators | ⚠ the SELECTION is shared (§5.1) | the DRAG is not — it is component state |
| 10 | a triplet placed at tick 4 | it sounds, at `offset = 1/3` of its slot | ⚠ **the parked test (§9) is the only e2e gate on this** |

⚠ **Row 7 is a design requirement, not an observation.** Shrinking the page count must
NOT delete notes — `d.pages = n` and nothing else. A player who shrinks by accident and
grows back must get their music back. If the build agent finds themselves writing a
filter over `d.notes` in the pages setter, they have built the wrong control.

---

## 9. THE E2E SURFACE

**Post-#2183.** Three specs that reach for score are deleted by that PR and are struck
through here; they are listed because a build agent reading the current tree would plan
work for them.

| spec | role | after promotion |
|---|---|---|
| `score.spec.ts` (750 lines, 17 tests) | **SUBJECT** | ⚠ **a real rewrite** — §9.1 |
| `midi-learn-note.spec.ts` | ⚠ **FIXTURE, and #2166** | §3.3(b) — keep the legacy leg, ADD the face leg |
| `coverage-groups-3-4-5.spec.ts:455` | engine-level (`tickIndex` + `currentNoteId` via `seedScoreThenPlay`) | **unchanged** — it never touches the card |
| `_score-helpers.ts` (138 lines) | the seed-then-play ordering guarantee | **unchanged**, and it must stay: its `advancesBeforePlay === 0` leg is a permanent negative control |
| `_per-port-drivers.ts:324` | drives score's own ports | **unchanged** — writes `node.data.notes` directly |
| `_per-module-per-port-shared.ts:191` | `score: 'requires play_cv high + steps; covered by score.spec.ts'` | ⚠ **anchored to `score.spec.ts` by name** — if that file is renamed the exemption's reason goes stale |
| ~~`sequencer-transport.spec.ts` (935)~~ | quicksave round-trip, score leg | **DELETED by #2183** |
| ~~`sequencer-playhead-alignment.spec.ts` (310)~~ | playhead off-by-one, score leg | **DELETED by #2183** |
| ~~`sequencer-clock-without-play.spec.ts` (214)~~ | clock-without-play, score leg | **DELETED by #2183** |

**Not in** `_face-fixtures.ts`'s `DENIED` map. **Not in** `LEGACY_DOCK_CANDIDATES`
(`workflow-rear-card.spec.ts:738` = `['moog956','moog960','cartesian']`).

⚠ **score IS in the derived AUDIO fixture POOL, and promotion changes the pool without
changing the pick.** `deriveFixture` (`_face-fixtures.ts:420-472`) sorts the pool by
`params` ascending, then port count, then name. score has **6 params and 15 ports**, so
it sorts late; the current pick is `modtris`. Promotion removes score from `unpromoted`
and therefore from `pool`, which changes the `why` STRING the fixture prints and nothing
else. **Verify rather than assume** — M9 in §14 — because "it only changes a message"
is exactly the claim that turns out to be wrong.

### 9.1 `score.spec.ts` — what moves and what must NOT

Sixteen active tests plus one parked. The selectors are card-DOM, so most go **RED**
(not blind) on promotion — which is the good failure. The rewrite is mechanical:

* `score-tool-{quarter,whole,sharp,flat,tie,stop,loop,dyn-*}-<node>` — these ARE the
  toolbar buttons that become cells. Each becomes a cell interaction. ⚠ **This is
  where a rewrite can silently weaken a test**: `score: loop toggle persists in score
  data` (`:505`) asserts `node.data.loop`; keep the assertion on the DATA, and only
  change how the click is delivered.
* `score-staff-<node>`, `score-note-*`, `score-tie-*`, `score-dyn-*`,
  `score-stop-bar-*`, `score-highlight-*` — unchanged, they live in the panel.
* `score-page-{prev,next,add,counter}-<node>` — ⚠ `add` becomes the PAGES selector and
  `counter` may disappear (§7.4). `score: page count is capped at 4 — add button
  disabled at max` (`:480`) must become *"the PAGES selector offers exactly 1..4"*,
  which is a stronger assertion, plus a NEW leg for the shrink direction (§2.3) that
  fails on today's code.
* `score-play-<node>` — §3.3.

⚠ **THE PARKED TEST MUST SURVIVE BY NAME.** `score.spec.ts:250` is
`test.fixme('score: every triplet position SOUNDS — all three notes of a triplet
group', …)`, parked under `FLAKE-PARK #1847` and recorded in the ONE park authority,
`SKIP_BUDGET` (`scripts/e2e-skip-budget.mjs:555-578`), whose entry lists
`'score.spec.ts'` and matches `reason: /FLAKE-PARK #1847/`. That entry's `why` says
plainly: *"while these are parked a silent or mistuned chain has no CI gate at all."*

**It is the only e2e gate on the three-month triplet-silence fix.** If the rewrite
renames the file, deletes the fixme, or changes its `annotation.description`, the
budget entry goes stale and the PR reddens for paperwork reasons on top of losing the
record. **Rewrite it in place, keep the title, keep the annotation.**

### 9.2 THE NEW SPEC — `score-face.spec.ts`

Registry-driven sweeps enrol score automatically the moment it enters `STRICT_FACES`
(`faces-parity.spec.ts:857`, `module-face-lint` completeness, dock render-plan parity,
`shell-cells.test.ts:58`, the `faceplate-platform` annotation sweep). What they do NOT
cover is score-specific behaviour:

1. the two panels PAINT at the dock and neither is inert (M5);
2. selecting a note ENABLES the four mark cells and deselecting DISABLES them (state 2);
3. `score-tie-{n}` OFF actually removes a tie (§2.1(c) — fails on today's code);
4. `score-pages-{n}` SHRINKS and the notes survive (state 7 — fails on today's code);
5. clicking the selected note deletes it (§2.1(a) — fails on today's code);
6. the face's `isPlaying` toggle binds a NOTE, and a legacy `:play` record still drives
   it (§3.3(a), both directions).

⚠ **Legs 3, 4 and 5 must be written so they FAIL on `main`.** That is the difference
between a face spec and a screenshot.

---

## 10. VRT — ONE existing baseline, in the BLOCKING lane

**Today.** `e2e/vrt/__screenshots__/vrt.spec.ts/score.png` — **566 × 565 px, 21 234 B**,
one committed baseline, and `score` is a member of `STRICT_VRT_MODULES`
(`vrt-exemptions.ts:1306`, *"score/note display card"*). **`vrt-strict` is a required
context**, so this baseline is a blocking gate. score is **not** in `EXEMPT_FROM_VRT`
and needs no exemption.

**After promotion.** Two scenes are ADDED (`face-score-compact.png`,
`face-score-dock.png`) by adding one row to the `FACES` roster in
`e2e/vrt/_shell-faces.ts` — `{ type: 'score', pages: 5 }` (the POST-hero-split band
count; §5.4's five, since the hero promotion empties no band). **Nothing ties `FACES` to
`STRICT_FACES`, so a missing row means no scene, silently.**

**The card baseline: does it MOVE?** Only if the card's DOM changes. §6.2 moves the
staff into a shared component and §6.4 extracts `transportDeps` — both are refactors the
card renders identically through. **Predict: 2 files added, 0 moved.** ⚠ **Count what
the bot commits against that prediction** — a green dispatch that commits nothing is a
red flag, and a THIRD file means the card moved and nobody noticed.

**Three score-specific hazards:**

1. ⚠ **The dock scene will be almost entirely the staff.** `DockFullView.svelte:384` is
   `max-height: min(60vh, 680px)` and the capture sees the top ~425 px; the staff panel
   is ~420 px in the hero band (§5.4). **So `face-score-dock.png` is blind to all five
   section bands.** That is the same blindness that left sixstrum's, dx7's and
   kickdrum's dock baselines pixel-identical through a complete band re-grouping. **A
   green dock scene is NOT evidence that a band change is a no-op on this face** — the
   band gate is `faceplate-platform.spec.ts` plus the pure `dock-row-plan` /
   `module-face-lint` units, and the PR body must say so.
2. ✅ **The Bravura font is already handled.** `e2e/vrt/_fonts.ts:31` states it
   explicitly: `document.fonts.ready` *"only tracks @font-face faces the document
   declares (**just Bravura, for SCORE**)"*. The SMuFL face is the one self-hosted font
   the app ships, so the staff's glyphs are deterministic where the UI stack's were not.
   ⚠ **Verify it loads inside the PANEL** — the font is declared globally, but the
   scene now mounts the staff through a different component tree.
3. ✅ **A solo-spawned score is deterministic.** `notes: []`, `isPlaying: 0`, so no
   playhead, no rAF-driven highlight, no free-running surface. It belongs in
   `VRT_LIVE_SURFACES` **only** if a scene ever spawns it playing — which none should.
   ⚠ **`ScoreCard.svelte:132-143` runs an unconditional rAF poll of
   `read('currentNoteId')` whether or not the transport is running.** The panel must
   keep that behaviour (the highlight has to be frame-accurate) and it is harmless for
   VRT because the value is `null` — but it is a per-frame engine read on every mounted
   score, at every tier. **M10 in §14.**

**Dispatch scoped: `GREP=score flox activate -- task vrt:commit`.** ⚠ **`GREP=score`
also matches `scoreboard`** (`e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/face-scoreboard-{compact,dock}.png`
exist). Either accept the extra scope or use a tighter token, and **predict the file
count before dispatching either way.**

---

## 11. COST

### 11.1 WEBGL ATTEST — ZERO. MEASURED.

```
$ flox activate -- bash scripts/webgl-attest-hash.sh --list | wc -l
218
$ flox activate -- bash scripts/webgl-attest-hash.sh --list | grep -i score
packages/web/src/lib/video/modules/scoreboard-draw.ts
packages/web/src/lib/video/modules/scoreboard.ts
```

**Both hits are `scoreboard`, a different (video) module.** Neither
`audio/modules/score.ts`, nor `score-data.ts`, nor `ScoreCard.svelte`, nor anything
under `ui/workflow/` is in the basis. The only `audio/modules` members are `cube.ts`
and `wavesculpt.ts` (`webgl-attest-lib.ts:68-69`).

⚠ **Note the direction of the risk.** Basis membership is derived from CONTENT and
path, not from a list somebody maintains — a panel component that acquired a WebGL
context would enter the basis automatically. **The staff is an `<svg>`. Keep it one.**

### 11.2 ART — ZERO, and for a stronger reason than "no pin"

* `art/scenarios/score/score-pitch-and-envelope.test.ts` exists (13 566 B) — pitch
  correctness via Goertzel, envelope × dynamic peaks, and the tied-note single-envelope
  proof.
* `ls art/baselines/ | grep -i score` → **nothing.** There is no `.f32`, no `.sha`.
  Every assertion is computed against a reference, not against a committed buffer.
* `score` is in `ART_BACKLOG` (`art/setup/profile-coverage.ts:113`), so the
  audio-profile gate is satisfied and a face PR neither adds nor removes an entry.

**`art/` should be absent from the diff.** ⚠ If it is not, something changed the DSP,
and a face PR must not.

### 11.3 CI wall-time

* two new VRT scenes — dispatched, not in the PR lane;
* `faces-parity` budgets CI at roughly `10 s + 0.8 s/cell`
  (`faces-parity.spec.ts:78-83`). score's dock cell count is **16 ranked keys**, two of
  which are panels ⇒ ≈ `10 + 12.8 ≈ 23 s`;
* one new unit file (`score-face-model.test.ts`);
* `score-face.spec.ts` — six legs (§9.2);
* `score.spec.ts` rewritten in place, same test count.

**Estimated delta ≈ 60-80 s.** Under the ~2 min threshold, but not by much — **re-price
it against the real run and flag it if the panel probes are slow.**

⚠ **RE-PIN BOTH COST ARTIFACTS.** A face adds rows to the e2e sweeps *and* two
`vrt-strict` scenes, and an unmeasured scene rides the MEDIAN. That is what reddened
`vrt-strict shard 1/8` at 87 % and then `main` at 92 % on shard 2/8, twice in one day.
`task e2e:timings:accept` **and** `task vrt:strict:timings:accept`, both, against the
newest green run, both diffs reviewed.

### 11.4 CONTRACT-LOCK — it MOVES, by six lines

`score`'s current block is `contract-lock.txt:2795-2820` — 26 lines: 1 meta, 11 in,
4 out, 6 param, 1 expose, **3 family**.

`face` is fully contract-transparent (`FACE_FIELDS_IN_LOCK` is empty), so `order`,
`pages`, `hero`, `glyph` and the tab decision are all free. **`controlFamilies` is
NOT.** The six new families each add one line:

```
score family score-accidental kind=cell prefix=score-acc
score family score-key        kind=cell prefix=score-key
score family score-loop       kind=cell prefix=score-tool-loop
score family score-pages      kind=cell prefix=score-page
score family score-slots      kind=cell prefix=quicksave
score family score-stop       kind=cell prefix=score-stop
score family score-value      kind=cell prefix=score-tool
```

(seven lines listed, six new — `score-value` replaces nothing but the existing three
stay.) So: `flox activate -- task docs:accept`, **review the diff**, and expect exactly
those additions and nothing else.

⚠ **Each new family also owes a `docs.controls` entry** — `STRICT_DOCS` completeness
requires one per family, and `score` is on that list (`strict-docs.ts:249`). Six new
prose entries. **Write them as real prose**, not as label restatements; this is the
documentation the right-click annotate reads.

⚠ **And each `testidPrefix` must be a LITERAL the surface emits**, because
`module-docs-lint`'s card grep looks for it. Three of the six above deliberately reuse
prefixes the card already emits (`score-tool`, `score-page`, `quicksave`) so the grep
keeps finding them on both surfaces.

### 11.5 THE PUSH 2 CARD MOVES, GENERIC → FACE

Three tiers, first match wins (`push-card-config.ts:20-33`): OVERRIDE → FACE (the first
8 turnable params of `face.order`) → GENERIC (declaration order). score has no
`PUSH_CARD_CONTROLS` entry, so it is GENERIC today and becomes FACE on promotion.

score's turnable params are the five continuous ones (`isPlaying` is a toggle, and the
resolver *"refuses a MOMENTARY press-pad — an encoder cannot turn a trigger"*;
verify whether a toggle is likewise skipped — **M11**).

```
GENERIC (declaration order): bpm, attack, decay, sustain, release
FACE    (face.order order):  bpm, attack, decay, sustain, release   ← families SKIPPED
```

**The SET is identical and the ORDER is identical**, because `bpm` ranks 3rd in
`face.order` and 1st in declaration order but the four ADSR params follow it in the same
sequence either way, and the resolver *"SKIPS control families and keeps walking"*
(`push-card-schema.test.ts:259`). **Predict: no golden movement.** ⚠ **Verify it rather
than assert it** — this is exactly the drift CLAUDE.md warns about, and "I predicted no
change" is worth nothing next to a run.

### 11.6 EVERY SHARED FILE THIS PR TOUCHES

| file | edit |
|---|---|
| `$lib/ui/workflow/strict-faces.ts` | append `'score'` + the argument comment |
| `$lib/ui/workflow/shell-cells.ts` | one `score:` block, nine cell records |
| `e2e/vrt/_shell-faces.ts` | `{ type: 'score', pages: 5 }` |
| `$lib/docs/contract-lock.txt` | GENERATED — `task docs:accept` |
| `$lib/docs/module-manifest.ts` | ⚠ **D4/D5 in §12** |
| `$lib/ui/modules/card-range-source.test.ts` | ⚠ boy-scout — D6 |
| `e2e/e2e-timings.generated.json` · `e2e/vrt-strict-timings.generated.json` | GENERATED — §11.3 |
| `docs/testing/test-ledger.generated.md` | GENERATED — `task test:ledger:accept` |

**Not touched:** `modules-card-map.test.ts` (`score` is already in `EXPECTED_NODE_TYPES`
at `:53` and the card file survives), `vrt-exemptions.ts` (no exemption to add or
discharge), `push-card-config.ts` (no override), `art/*`.

---

## 12. DEFECT LEDGER — live on `main`, fix INSIDE the face PR

Per the standing ruling, nobody opens issues; a bug found in the course of planned work
is fixed as part of that work, with the story in the PR body.

| # | defect | evidence | routing |
|---|---|---|---|
| **D1** | ⚠ **Every edit to the MUSIC is outside Cmd-Z.** `writeData` calls `ydoc.transact(fn)` with no origin, so notes, ties, dynamics, key, pages, loop, stop bar and quicksave are all untracked by the UndoManager. No gate can see it — `mutate.guard`'s regex anchors on `.params`. | `ScoreCard.svelte:265`, `:708`; `transport-card.ts:66`; `mutate.ts:12-15`; `mutate.guard.test.ts:94` | **face PR** — add `LOCAL_ORIGIN` in three places; M4 verifies the coalescing |
| **D2** | ⚠ **Promotion orphans every saved MIDI binding on the PLAY button.** `bindingKey` is `` `${moduleId}:${paramId}` ``; the card binds `:play` (a synthetic id) and the face's Toggle looks up `:isPlaying`. | `MidiAssignButton.svelte:24-26`; `ScoreCard.svelte:772`; `Toggle.svelte:55-62`; `midi-learn.svelte.ts:102-104` | **face PR** — a general `(type, legacyParamId) → paramId` alias on READ; §3.3(a) |
| **D3** | **The page count is a one-way ratchet.** `addPage` only increments; nothing decrements. An accidental page permanently lengthens the piece by 16 bars of silence. | `ScoreCard.svelte:339-345`; `score.ts:443-461` | **face PR** — `score-pages-{n}` is a 1..4 selector; state 7 is the guard |
| **D4** | ⚠ **The docs promise a control that does not exist.** `docs.controls['score-note-{n}']` says *"click a note to select/remove it"*; the card starts a DRAG and there is no select and no remove. `score` is in `STRICT_DOCS`. | `score.ts:178-179` vs `ScoreCard.svelte:454-461`, `:389-394` | **face PR** — §5.1 makes the prose TRUE rather than editing it to match a gap |
| **D5** | ⚠ **A note can only be deleted by a keystroke on a focus that may be unreachable**, and no test covers it. `deleteNote` has exactly one call site. Tab is consumed by the rack flip; `pointerdown` `preventDefault`s. | `ScoreCard.svelte:389-394`, `:538-541`, `:454-461`; `workflow-pins.ts:298-312` | **face PR** — the pointer route in §5.1; M1 measures the focus claim |
| **D6** | **A tie can never be removed.** `addTie` is the only writer of `d.ties`; the only deletion is collateral inside `deleteNote`. Compounds with D5. | `ScoreCard.svelte:382-394` | **face PR** — `score-tie-{n}` is a toggle |
| **D7** | ⚠ **The doc page's one-liner is STALE and SHADOWS the good prose.** `describeModule` is `DESCRIPTIONS[type] \|\| MODULE_DOCS[type]?.explanation`, so score's rich co-located `docs.explanation` never renders — the reader gets *"8-bar treble-clef staff"* instead. **The module is 16 bars per page, up to 4 pages** (`BARS_PER_PAGE = 16`, `MAX_PAGES = 4`). | `module-manifest.ts:1088-1098`, `:291`; `score-data.ts:21-22` | **face PR** — delete the DESCRIPTIONS entry so the authored prose surfaces, or correct it |
| **D8** | **A port note is stale by a version.** `PORT_NOTES['score.env']` says *"ADSR x dynamic (mf=0.55, **ff=0.95**, etc)"*; `DYNAMIC_SCALE.ff` is **1.045**, and `score-data.ts:95-96` records the change (*"ff 0.95 -> 1.045"*). `describePort` returns `PORT_NOTES[key]` before anything else, so the def's own correct `docs.outputs.env` never renders. | `module-manifest.ts:625`, `:1071-1073`; `score-data.ts:97-103` | **face PR** — one-line correction, or delete the note and let the def's prose through |
| **D9** | **`ScoreCard.svelte` re-types five ranges the def declares** (`min={30} max={300}`, `min={0.001} max={10}` ×3, `min={0} max={1}`) and is **not** in `RANGE_BOUND_CARDS`. They AGREE today, so `card-def-agreement` is green — but the card is still a live surface (`?shell=legacy`, and `midi-learn-note.spec.ts` runs there). | `ScoreCard.svelte:1025-1029`; `card-range-source.test.ts` | **face PR** — boy-scout: export the ranges from one place, import in both, add `ScoreCard.svelte` to `RANGE_BOUND_CARDS` |

⚠ **What is NOT in this ledger, said plainly because an empty-looking search reads as a
search that was not performed.** score's ENGINE is in unusually good shape: it uses the
shared worker scheduler-clock, it has the #229 past-due drop guard (which #2183 reports
`kria` was *missing* and had ported *from score*), it exposes `lateStepsDropped` /
`pastDueEmits` as canaries, its tie semantics are documented and tested, its
grid/transport split is a shared exported function precisely so a gate calls the same
code the engine calls, and its ART scenario covers pitch, dynamic scaling and the tied
envelope. **Nine of the nine defects above are in the CARD, the DOCS or the PLATFORM's
relationship to the module. None is in the DSP.**

---

## 13. TASTE CALLS, EACH WITH ITS ONE-LINE REVERT

| call | revert |
|---|---|
| the face is SELECTION-based, not MODAL (§5.1) | keep `activeTool` in `node.data` and make the mark cells arm modes — accepting that four of five would then lie about a single-valued state |
| the selection lives in `node.data` and therefore SYNCS | move it to component `$state` — and every mark cell goes inert, because `value(node)` sees only the node |
| `score-key-{n}` ranks 10th | move it to rank 4, beside `score-value-{n}` |
| quicksave is one PANEL | decompose into a mode selector + four actions (four more families) |
| the panel caption is `staff` | `the score` (kria's `the grid` idiom) |
| the panel's page nav drops its numeral (§7.4) | keep `2/4` inside the picture and drop the PAGES selector's option name instead |
| `bpm` outranks the ADSR | move `attack…release` above `bpm` — defensible only if you argue the ENV output matters more than the tempo |
| five bands, no rail | **needs an owner instruction** — §5.4 |

---

## 14. MUST-VERIFY (before the face is written)

* **M1 — is a note's FOCUS actually unreachable?** (§2.1(a), D5.) Drive the real page:
  open a score in the dock, press Tab, and read `document.activeElement`; then click a
  note and read it again. ⚠ **Do it in the page, not from a Playwright poll loop.**
  Report which of the two mechanisms (flip-consumes-Tab, preventDefault-suppresses-focus)
  is operative — the fix is the same either way, but a wrong diagnosis in the PR body is
  a wrong diagnosis in the record.
* **M2 — the quicksave→queue_cv chain survives end to end.** SAVE slot 1 through the
  FACE's panel, then fire `queue1_cv`, and assert the pattern swaps. ⚠ This is §0.5's
  whole argument and it must be proven on the FACE, not on the card.
* **M3 — measure `ScoreSlotsPanel`'s real width** before writing `minWidth`. A number
  written from taste in a required field is a fiction, which is the reason matrixMix
  refused the panel kind outright.
* **M4 — Cmd-Z coalescing after D1.** `captureTimeout: 500` means a note DRAG (which
  writes on every pointermove) must collapse to ONE undo step, and two deliberate edits
  four seconds apart must be TWO. Measure both; neither has ever worked.
* **M5 — TWO panels on one face is unprecedented.** Confirm both PAINT at the dock,
  that `bandIsPackable` puts each in a solo row as expected, and that
  `dock-row-plan`'s totality assertion still flattens to exactly the input bands.
  ⚠ **And confirm `score-slots-{n}` is NOT selected at any lane tier** — it is protected
  by rank 15 against a cap of 6, not by a rule (§5.3). Assert it against
  `laneOrder` + `faceTierCap`, so a future re-rank fails here with a reason rather than
  in `module-face-lint` with a panel-in-a-knob-column message.
* **M6 — a freshly spawned score writes NOTHING to `node.data`.** (§5.1, state 1.)
  Spawn, open the dock, close it, and assert `node.data` is still absent/empty. A face
  that seeds its own defaults dirties every saved patch on open and pushes a Y.Doc
  update for doing nothing.
* **M7 — every lane tier PAINTS the cells it selects.** Assert PRESENCE, not that the
  face resolves — the `joystick` shape is a face that ranks controls and renders zero
  of them (§5.6).
* **M8 — `face-monitor-source.test.ts` is satisfied in both directions** (§6.5): score
  declares no `monitor`, and its legacy card mounts no `hideControls`.
* **M9 — the AUDIO fixture PICK does not move** when score leaves the pool (§9). Print
  `AUDIO_FIXTURE.type` and `.pool` before and after.
* **M10 — the panel's rAF `currentNoteId` poll costs what the card's did**, per mounted
  score, at every tier (§10 hazard 3). Count reads IN THE PAGE and report
  `samples / elapsedMs`. Negative-control it: stop the transport (reads continue, value
  is null) and unmount the panel (reads stop).
* **M11 — is a `toggle` param TURNABLE for the Push card?** (§11.5.) The resolver
  refuses a momentary pad; whether it also skips a toggle decides whether `isPlaying`
  takes a Push encoder slot.
* **M12 — has #2183 merged?** (§0.1.) If not, do not plan work on the three deleted
  specs. If it has, re-run the `grep -rn "'score'" e2e/tests` sweep on the merged tree —
  the re-subjecting moved several fixtures and score may have acquired more of them than
  §9 lists.

---

## 15. VERIFICATION GATE

```bash
# ── 1. the face model + THIS face's permanent negative controls (§8 rows 2, 7, 9)
flox activate -- npx vitest run \
  packages/web/src/lib/ui/workflow/score-face-model.test.ts

# ── 2. the module's own pure core — it is the grid BOTH renderers share (§6.2)
flox activate -- npx vitest run \
  packages/web/src/lib/audio/modules/score-data.test.ts

# ── 3. face lint + plans (order / pages / hero / paramCells / momentary / rear)
flox activate -- npx vitest run \
  packages/web/src/lib/ui/workflow/module-face-lint.test.ts \
  packages/web/src/lib/ui/workflow/dock-row-plan.test.ts \
  packages/web/src/lib/ui/workflow/dock-faceplate-model.test.ts \
  packages/web/src/lib/ui/workflow/curated-face.test.ts \
  packages/web/src/lib/ui/workflow/dock-tabs-model.test.ts \
  packages/web/src/lib/ui/workflow/rear-card-model.test.ts

# ── 4. the rulings' SOURCE gates — §7 lives or dies here
flox activate -- npx vitest run \
  packages/web/src/lib/ui/workflow/face-resting-text-source.test.ts \
  packages/web/src/lib/ui/controls/face-readout-source.test.ts \
  packages/web/src/lib/ui/dock/face-width-source.test.ts \
  packages/web/src/lib/ui/workflow/face-monitor-source.test.ts

# ── 5. the registries: no inert cell, no module leak into the shared shell
flox activate -- npx vitest run \
  packages/web/src/lib/ui/workflow/shell-cells.test.ts \
  packages/web/src/lib/ui/workflow/shell-extensions.test.ts \
  packages/web/src/lib/ui/workflow/module-shell-import-guard.test.ts \
  packages/web/src/lib/ui/workflow/face-migration-inventory.test.ts \
  packages/web/src/lib/ui/modules-card-map.test.ts \
  packages/web/src/lib/ui/modules/card-range-source.test.ts       # D9 boy-scout

# ── 6. D1's seam + the raw-write guard's own negative control
flox activate -- npx vitest run \
  packages/web/src/lib/graph/mutate.guard.test.ts \
  packages/web/src/lib/audio/modules/transport-helpers.test.ts \
  packages/web/src/lib/audio/modules/transport-card.test.ts

# ── 7. docs: the family entries + the two stale manifest strings (D7, D8)
flox activate -- npx vitest run \
  packages/web/src/lib/docs/module-docs-lint.test.ts \
  packages/web/src/lib/docs/module-manifest.test.ts
flox activate -- task docs:accept      # then REVIEW: 6 new family lines, nothing else
flox activate -- task docs:check

# ── 8. Push 2 — predicted NO movement (§11.5). A diff here is a finding.
flox activate -- npx vitest run \
  packages/web/src/lib/control/push2/push-card-schema.test.ts

# ── 9. e2e — the SUBJECT, the #2166 fixture, and the engine-level leg that must NOT move
flox activate -- task e2e:serve
REPEAT=3 flox activate -- task e2e:one -- tests/score.spec.ts          # ⚠ keep the parked test BY NAME
REPEAT=3 flox activate -- task e2e:one -- tests/score-face.spec.ts     # the six new legs (§9.2)
REPEAT=3 flox activate -- task e2e:one -- tests/midi-learn-note.spec.ts # ⚠ BOTH legs — §3.3(b)
flox activate -- task e2e:one -- tests/coverage-groups-3-4-5.spec.ts   # must be UNCHANGED
REPEAT=3 flox activate -- npx --workspace e2e playwright test faces-parity --grep score
REPEAT=3 flox activate -- task e2e:one -- tests/faceplate-platform.spec.ts
flox activate -- task e2e:stop

# ── 10. the park authority — a rename breaks it silently
flox activate -- node scripts/e2e-skip-budget.mjs

# ── 11. lint (the waits ledger only ever shrinks) then typecheck LAST
flox activate -- task lint
flox activate -- task typecheck

# ── 12. cost artifacts — BOTH, every time (§11.3)
flox activate -- task e2e:timings:accept -- <run>
flox activate -- task vrt:strict:timings:accept -- <run>

# ── 13. VRT: DISPATCH ONLY, scoped. Predict 2 files added, 0 moved. COUNT them.
#     ⚠ GREP=score also matches `scoreboard` — check the printed scope before it runs.
GREP=score flox activate -- task vrt:commit

# ── 14. attest: NIL (§11.1). Nothing to run.
```

---

## 16. ⚠ THE CORRECTIONS — six claims that came back different

Recorded in place rather than quietly applied, because the way each was wrong is the
useful part.

**1. "The note-entry blocker obviously applies to a notation editor."** It does not, and
the reason is that the blocker is about **TYPED** entry (`face-migration-inventory.ts:176-178`).
score types nothing — its note entry is a pointer gesture and its card mounts zero
`<input>` elements. ⚠ **The name of the blocker is what makes this trap**: a module
called `score`, whose whole subject is notes, reads as the canonical
`needs-note-entry-cell` case. Reading the capability text instead of the id is what
resolves it.

**2. "Promoting score would lose the MIDI-assignable PLAY button."** It does not.
`isPlaying` is `discrete 0..1`, `looksLikeToggle` is true, and `Toggle.svelte` calls the
**same** `makeMidiAssignable({ kind: 'note', controlType: 'button' })` factory with the
same press-edge toggle semantics. ⚠ **The first reading was a STOP-2 failure that would
have changed the verdict**, and it was wrong. What is genuinely lost is narrower and
more interesting: the **binding KEY** changes from `:play` to `:isPlaying`, so saved
bindings orphan (D2). *"We would lose the button"* and *"we would orphan the saved
binding"* need completely different responses.

**3. "`midi-learn-note.spec.ts` will go red and force the migration."** It will not. It
navigates to `/rack?shell=legacy&seed=none`, and `shellFaces = false` routes
`laneRenderKind` to `'legacy'` — **the verbatim card, promoted or not.** So it goes
**green and blind**, which is strictly worse than red, and it would certify D2 as fine.
⚠ **This is the sharpest #2166 instance the program has found**, because the
precondition is not incidental — it is written into the URL.

**4. "score has a VRT exemption to discharge, like matrixMix and midiclock."** It does
not. `grep score e2e/vrt/vrt-exemptions.ts` returns only `scoreboard` entries plus
`STRICT_VRT_MODULES`'s membership line at `:1306`. score has **one committed card
baseline in the BLOCKING strict lane** — the opposite position from waves 3 and 4's
subjects, and it means this face PR can MOVE a required gate rather than merely add two
scenes.

**5. "The three `controlFamilies` are three controls to rank."** Reading them that way
makes the face impossible — three families over one surface is either three copies of
the same picture or three mutually-exclusive selectors claiming to hold one
single-valued state. ⚠ **They are a DOCS-KEYING device**, declared for the
`STRICT_DOCS` gate before any face existed (the kria comment names the convention:
*"a card control with no backing param has no other way to be RANKED on a face or keyed
by the docs gate"*). Recognising that is what produced §5.1's selection model, which is
the design rather than a workaround: the families become the note surface, the tie
toggle and the dynamic selector, and none of them is a mode.

**6. "The DESCRIPTIONS one-liner is a fallback for modules without co-located docs."**
It is the opposite: `describeModule` is `DESCRIPTIONS[type] || MODULE_DOCS[type]?.explanation`
(`module-manifest.ts:1088-1098`), so a hand-typed one-liner **shadows** the authored,
drift-gated prose. score has the richest `docs.explanation` of any sequencer in the
tree and **none of it reaches the doc page** (D7). The comment beside the `||` says
*"AUDIO is byte-unchanged: every audio module already has a DESCRIPTIONS entry, so the
`||` short-circuits before this branch"* — which is an accurate description of a
mechanism whose effect nobody restated.

---

## 17. VERDICT, RISK, ESTIMATE

### **PROMOTE.** One PR, no platform precursor, no new seam, no unwired slot.

Nothing blocks it. The note-entry blocker does not apply (§0.4, correction 1); there is
no missing platform capability (both panels, all six selectors and both toggles are
shipped cell kinds); the glyph question answers itself (§4); the width is earned and
derived (§5.5); the attest is nil and the ART is nil (§11.1, §11.2). **The only open
question is a design one and it is the owner's: five honest bands against a
seven-band rail threshold on the most control-heavy module in the fleet (§5.4).**

The face is also the cheapest available fix for **six live defects** (D1, D3, D4, D5,
D6, D9) whose common cause is that score has no selection model — and it fixes them as a
consequence of the design rather than as six patches.

### Risk: **MEDIUM-HIGH**, and concentrated in three named places.

1. **§3.3 — the MIDI binding.** The affordance survives; the saved binding does not, and
   the spec that would have caught it goes green-and-blind. This is the item most likely
   to ship as a silent regression, and D2 + §9.2 leg 6 are the guard.
2. **§5.1 — the selection model.** It is the largest behaviour change in the wave: the
   face is not the card with a new skin, it is a different interaction over the same
   document. It is better and it is defensible, and it is still a change the owner should
   see before merge. ⚠ **Look-affecting, so it goes to owner preview — do not
   auto-merge.**
3. **§0.5 / M2 — the quicksave chain.** Four declared input ports depend on a widget
   that lives only on the card today. The fix is a panel and the fix is small; the risk
   is forgetting the port half of it.

Everything else is mechanical: two lifted components, nine cell records, one roster row,
six family declarations and six docs entries.

### Estimate: **≈ 16 h, ONE PR.**

| | |
|---|---|
| audit + D7/D8/D9 boy-scout + D1's three `LOCAL_ORIGIN` args | 2 h |
| `score-layout.ts` + `score-transport-deps.ts` extraction (both surfaces) | 2 h |
| `ScoreStaffPanel.svelte` (lift + the selection model + the delete gesture) | 4 h |
| `ScoreSlotsPanel.svelte` | 1 h |
| `score-cell-actions.ts` — six selectors, two toggles, the aria strings | 3 h |
| the `face` block + `strict-faces` + `shell-cells` + the docs entries | 1.5 h |
| `score-face-model.test.ts` + `score-face.spec.ts` (six legs) | 2 h |
| `score.spec.ts` rewrite in place + `midi-learn-note.spec.ts`'s second leg | 2.5 h |

⚠ **It is ONE PR and not two**, and that is a deliberate call against the wave-4 habit of
splitting. There is no attest window to protect (§11.1), no platform precursor to look
at alone (§0.2), and the six defects are all *caused by the missing selection model* —
splitting them out would mean shipping a fix whose whole justification lives in the
other PR.

### Build order: **AFTER #2183 merges.**

Not because the face depends on it, but because three of the four specs this PR would
otherwise migrate are deleted by it, and because #2183 is the PR that re-points the
fleet's canonical button-MIDI fixture at score. **Landing the face first would mean
rewriting `midi-learn-note.spec.ts` twice and migrating three specs that are about to
disappear.**
