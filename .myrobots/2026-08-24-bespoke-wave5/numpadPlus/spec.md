# FACEPLATE BUILD SPEC — `numpadPlus` (audio, the KEYPAD PERFORMANCE SEQUENCER)

**SPEC ONLY. Nothing here is implemented.** Mockups: [`dock.html`](dock.html) ·
[`dock-remap.html`](dock-remap.html) · [`lane-tile.html`](lane-tile.html).

Method, per the owner's directive: analyse what the module is FOR, then author the
spec, then build from the spec. The owner asked for this module by name and for a
comprehensive spec, so this is a full §0–§17 treatment rather than a batch entry.

**The one-line summary a reviewer should carry into §13:** the two defects
`kria-writes.ts` was written to close are **both live, verbatim, on `numpadPlus`
today** — and one of them means *arming REC and pressing PLAY erases a layer that
Cmd-Z cannot bring back*.

---

## 0. THE CONSTRAINT MAP, READ FIRST

| constraint | numpadPlus's answer | measured at |
|---|---|---|
| `NON_SHELL_LANE_TYPES` | **NOT a member** | `legacy-fallback.ts:105-112` |
| `HEADLESS_MOUNT_LANE_TYPES` (the #1511 tax) | **NOT a member** — the keyboard listener is in the FACTORY | `dom-source-modules.ts:89-97`, `:204-211`, `:219-222`; §0.2 |
| a PINNED instance? | **NO** — nothing in `graph/workflow-pins.ts` | §0.3 |
| lane picture | **refused, mechanically protected** — `glyph: 'none'` is the only literal that compiles green | §5 |
| WebGL attest | **ZERO — not in the basis.** Measured. | §12.1 |
| ART | ZERO for a face PR — `ART_BACKLOG`, not `ART_EXCLUDED` | §12.2 |
| VRT | ⚠ exempt — **and the exemption's stated reason is FALSE on a fresh spawn** | §11 |
| tab rail | **NO** — four honest bands against `DOCK_TAB_MIN_BANDS = 7` | `dock-tabs-model.ts:101`; §6.5 |
| `node.data` writes / Cmd-Z | ⚠ **BROKEN, in a NEW SHAPE** — a `transact` with no origin | §0.4 |
| contract | ⚠ **moves by ONE LINE** — one new `controlFamilies` entry, nothing else | §12.4 |
| Push 2 card | ⚠ **moves** GENERIC → FACE, same seven params, different order | §12.5 |
| the owner's keyboard-a11y ruling | **does not apply** — see §0.5, and getting this wrong in either direction wastes a review round | §0.5 |

### 0.1 THE STATE LIVES IN BOTH PLACES, AND THE SPLIT IS THE WHOLE DESIGN PROBLEM

`numpad-plus.ts:299-309` declares **seven params**:

```ts
{ id: 'bpm',         label: 'BPM',  defaultValue: 120, min: 30, max: 300, curve: 'linear'   },
{ id: 'isPlaying',   label: 'Play', defaultValue: 0,   min: 0,  max: 1,   curve: 'discrete' },
{ id: 'activeLayer', label: 'Lyr',  defaultValue: 0,   min: 0,  max: 3,   curve: 'discrete' },
{ id: 'recArm',      label: 'Rec',  defaultValue: 0,   min: 0,  max: 1,   curve: 'discrete' },
{ id: 'overdub',     label: 'Ovd',  defaultValue: 0,   min: 0,  max: 1,   curve: 'discrete' },
{ id: 'octave',      label: 'Oct',  defaultValue: 4,   min: 0,  max: 8,   curve: 'discrete' },
{ id: 'poly',        label: 'Poly', defaultValue: 0,   min: 0,  max: 1,   curve: 'discrete' },
```

and **two `node.data` structures** that are the actual instrument:

* `data.layers` — `4 × 16` `NoteStep`s (`numpad-plus.ts:233-241`), the recorded music;
* `data.keymap` — `physical event.code → semitone | octave-action` (`:85-100`,
  `:129-132` on the card), the player's own keyboard layout.

**So the param set is not the module.** Every param is a MODE or a TEMPO; the two
things a player *makes* are both in `data`. That is the DX7 defect verbatim and the
gap the shell-cell registry exists to close — which is exactly what `kria`'s
promotion established (`shell-cells.ts:1785-1806`: *"its two params … are both
FALLBACKS … everything a player actually plays lives in `node.data` — which is
exactly the gap this registry exists to close"*).

One family is ALREADY declared (`numpad-plus.ts:346-348`):

```ts
controlFamilies: [
  { id: 'numpad-cell', label: 'Per-step note cell', kind: 'cell', testidPrefix: 'numpad-cell' },
],
```

and it is already in the contract golden (`contract-lock.txt:2394`). **The keymap
has no family and no declaration of any kind** — it exists only as card markup
(`NumpadPlusCard.svelte:293-324`), which is the STOP-2 gap §3 closes.

### 0.2 THE ENGINE DOES NOT NEED THE CARD — MEASURED, NOT ASSUMED

Every promotion in this program has to answer whether a face orphans engine state.
For a module whose headline feature is *stealing the keyboard*, the obvious worry is
that promotion silently unplugs the keys. **It does not, and the reason is
structural rather than lucky.**

The `keydown` / `keyup` capture listener is installed **inside the factory**
(`numpad-plus.ts:604-683`), on `document`, at `{ capture: true }`, and torn down in
`dispose()` (`:719`). It is not on the card. Confirmed against the derived sets:
numpadPlus is absent from `DOM_SOURCE_LANE_TYPES` (`dom-source-modules.ts:89-97`),
absent from `CARD_PRODUCER_LANE_TYPES` (`:204-211` — `cube`, `rasterize`, `scope`,
`synesthesia`, `timelorde`, `wavesculpt`), and therefore absent from their union
`HEADLESS_MOUNT_LANE_TYPES` (`:219-222`). Those sets are grep-derived from the
cards, so the absence is gate-anchored rather than a reading of mine.

The card is a **pure view plus four editors**: a 33 ms `setInterval` polling
`engine.read` (`NumpadPlusCard.svelte:52-68`), the step grid, the layer/transport
buttons, and the keymap remapper. Nothing the engine needs.

⚠ **The card DOES install a second, conditional document listener** — the remap
capture at `NumpadPlusCard.svelte:186-198` — but only while `remapSemitone !== null`,
i.e. only between "Remap…" and the next keystroke. It is `return`-torn-down by the
effect. This matters in §13/D8, where a shipped comment claims the opposite.

### 0.3 NO PINNED INSTANCE, NO SNOWFLAKE CARVE-OUT — CHECKED

Unlike wave 4's `midiclock` and wave 3's `audioOut`, `numpadPlus` has **no
canvas-hidden pinned instance** (`grep numpadPlus packages/web/src/lib/graph/workflow-pins.ts`
→ nothing) and is **not** in `NON_SHELL_LANE_TYPES` (`legacy-fallback.ts:105-112` —
`group`, `sticky`, `cadillac`, `clipplayer`, `controlSurface`, `electraControl`,
`launchpadControlLeft`). So `laneRenderKind` (`:140-144`) reaches
`migrated ? 'shell' : 'placeholder'` for it today, and promotion flips exactly one
branch. There is no topbar surface to unify, no `DockCardHost` to thread a `face`
prop through, and no second host to keep in step.

**This is the wave's simplest constraint map, and that is the point of picking it:**
every complication in `numpadPlus` is in the *design*, not in the platform.

### 0.4 ⚠ EVERY SEQUENCE EDIT IS OUTSIDE Cmd-Z — AND IT IS A **NEW SHAPE**

Waves 3 and 4 established that the fleet's raw-write discipline is a
`params`-shaped gate — `mutate.guard.test.ts:88-98`'s regex anchors on the literal
token `.params` and its stated scope (`:42-48`) is *"ASSIGNMENTS to `.params[…]` /
`.params.<id>`"* — while the bespoke cohort keeps its instrument in `data`. Wave 3
found `kria` and `audioOut` writing `.data` untagged; wave 4 found `midiclock`
doing it with a bare SyncedStore proxy write.

**numpadPlus is a third shape, and it is the worst of the three, because it LOOKS
CORRECT.** `NumpadPlusCard.svelte:76-87`:

```ts
function setStep(layerIdx: number, stepIdx: number, on: boolean, midi: number | null) {
  const t = patch.nodes[id];
  if (!t) return;
  ydoc.transact(() => {              // ← :79  NO ORIGIN ARGUMENT
    if (!t.data) t.data = {};
    const d = t.data as Record<string, unknown>;
    const cur = coerceLayers(d.layers);
    const layer = cur[layerIdx]!;
    layer[stepIdx] = { on, midi };
    d.layers = cur.map((l) => l.map((s) => ({ ...s })));
  });
}
```

and the identical shape at `:140-147` (`writeKeymap`, `ydoc.transact` at `:143`).

`mutate.ts:13-18` names this exact failure, in the file that exists to close it:

> *"Any write that does NOT pass LOCAL_ORIGIN — a bare `patch.nodes[id].params[p] = v`
> (SyncedStore's proxy transacts with NO origin), **or a transact tagged with some
> other origin** — is silently NOT undoable."*

and `store.ts:70` is the mechanism: `trackedOrigins: new Set<unknown>([LOCAL_ORIGIN])`.
A `ydoc.transact(fn)` with the origin argument omitted transacts with origin `null`,
which is not in that set.

**A bare proxy write reads as sloppy. A `ydoc.transact` reads as careful.** They are
equally un-undoable, and only one of them survives a code review. That is why this
instance is worth writing out rather than adding a row to wave 4's table.

⚠ **And it is not only the CARD.** The FACTORY writes the same structure with no
transaction at all — `numpad-plus.ts:438-461` (`writeStepIntoLayer`) and `:462-471`
(`clearLayer`) mutate `live.data` through the bare proxy. Those are engine writes and
a case can be made that a recorded keypress should not enter the user's undo stack
(the `raw-write-ledger.ts` `sanctioned` category exists for exactly that argument) —
**but nowhere is that case made, because there is no `.data`-side ledger to make it
in.**

**The denominator, extended.** Across waves 3, 4 and this one, seven bespoke modules
have now been read for this:

| module | what lives in `node.data` | origin-tagged? |
|---|---|---|
| `kria` | the whole sequencer | ✗ → **FIXED** (`kria-writes.ts`, wave 3's build) |
| `audioOut` | `outputDeviceId` | ✗ bare proxy write (wave 3) |
| `midiclock` | `divisor`, `lastDeviceId` | ✗ bare proxy write (wave 4) |
| `picturebox` | image bytes, 7 slots | ✓ `LOCAL_ORIGIN` (wave 4) |
| `matrixMix` | two axis ids | ✓ `LOCAL_ORIGIN` (wave 4) |
| **`numpadPlus` (card)** | `layers`, `keymap` | ✗ **`transact` with NO ORIGIN** |
| **`numpadPlus` (engine)** | `layers` | ✗ bare proxy write |

**`mutate.guard` is green over all seven.** It is not that the cohort is careless —
two of seven are exemplary — it is that **the gate cannot tell the exemplary ones
from the broken ones**, and now cannot tell a broken one from a careful-looking one
either.

⚠ **THE USER-VISIBLE CONSEQUENCE, and it is not "undo feels incomplete".**
`numpad-plus.ts:558-563`: arming REC and pressing PLAY calls
`clearLayer(activeLayerIndex())` — it **erases sixteen steps** — through the untagged
`:462-471` path. So **arm + play destroys a layer and Cmd-Z cannot bring it back.**
That is a data-loss bug on the module's headline workflow, and it is D1 in §13.

**THE FIX IN THIS PR** follows `kria`'s shipped template exactly, and the template's
own header (`kria-writes.ts:14-36`) is the argument for it — it names *"(1) EVERY
SEQUENCER EDIT WAS OUTSIDE Cmd-Z … `ydoc.transact(fn)` with NO origin argument"* and
*"(2) ONE CELL CLICK REWROTE THE WHOLE PATTERN"* as the two defects it exists to
close, and **numpadPlus has both** (§13/D1, §13/D2). See §9.

### 0.5 ⚠ THE KEYBOARD-A11Y RULING DOES **NOT** APPLY HERE — AND WHY THAT MUST BE SAID

Standing owner ruling (memory `owner-ruling-no-keyboard-a11y`): *no keyboard-nav
a11y work; Tab IS the flip gesture; never file or fix keyboard-navigation
accessibility.*

That ruling is about **navigating the UI with the keyboard** — focus rings, tab
order, arrow-key traversal of a grid, "operable without a mouse". This spec proposes
**none of that**, and the build agent must propose none of it either.

`numpadPlus` is a module whose **INSTRUMENT** is a key device: the computer keypad is
its oscillator's keyboard, the way a MIDI keyboard is `midiCvBuddy`'s. Keeping the
keys working is **functional parity on the module's primary affordance**, not
accessibility work. The two are separable by a mechanical test:

* **the instrument** — `document.addEventListener('keydown', …, { capture: true })`
  in the FACTORY (`numpad-plus.ts:677-678`), producing MIDI notes on the graph. IN
  SCOPE, and untouched by promotion (§0.2).
* **navigation** — Tab order, focus management, roving tabindex, arrow keys inside
  the 4×4 grid, `aria-activedescendant`. **OUT OF SCOPE. Do not add any of it.**

⚠ There is one place the line is genuinely thin and the spec rules on it explicitly:
the panel's cells get an **accessible NAME** (`aria-label`) carrying the step's note,
because §7 removes that text from the paint and the ruling's own remedy is *"its home
is `aria-valuetext` on the control it describes, which is speakable, assertable, and
unpainted"* (`face-resting-text-source.test.ts:55-58`). **An accessible name is the
resting-text ruling's prescribed destination, not keyboard-navigation work.** kria's
panel already does exactly this and says so (`KriaGridPanel.svelte:22-30`). Adding a
name is required; adding a focus model is forbidden.

⚠ There is also one thing this module has that no other faced module has, and the
build agent must NOT "fix" it: the factory's listener calls `ev.preventDefault()` and
`ev.stopPropagation()` on every mapped key (`:625-626`). That is the module's
declared *exclusive numpad ownership* (`numpad-plus.ts:44-49`). It is deliberate, it
is documented, and it is the reason `clipplayer-card-parity.spec.ts:180` exists.

### 0.6 ⚠ THE CORRECTIONS — five claims that were checked and came back DIFFERENT

Wave 3's pattern was *"the rule was applied correctly and the subject was never
checked."* It happened five times here. Each is recorded in place rather than quietly
fixed, because **the way each was wrong is more useful than the corrected value**.

**1. I expected the keymap to need a `fullViewBody` extension. It does not.**
`cameraInput`'s device picker is the shipped precedent for *"a control no `ParamDef`
can express"* going into the extension body (`legacy-fallback.ts:83-87`), and a
`code → semitone` bijection with a right-click menu looks like that shape. **It is
not**: the ladder's rung 2 fits (`module-faceplates.md` — *"ONE picture-you-edit
inside the generic face"*), and `KriaGridPanel.svelte:4-10` already made and recorded
this exact call for a grid instrument. cameraInput needed the extension because its
roster lives behind a browser API and its card is kept alive off-screen with
`pointer-events: none`; **numpadPlus has neither problem.** So: no
`face.extension`, no lazy chunk, no new render site, no platform PR. *The lesson:
"module X needed the escape hatch" is not evidence that module Y does — check which
of X's constraints Y actually has.*

**2. The VRT exemption's stated reason is false, and it has been for as long as it
has existed.** I expected to confirm it and argue for keeping it. `vrt-exemptions.ts:831-834`
says the card *"animates whether the sequence is running or not"*; **both** named
animations are gated on params that default to `0` (§11). The entry describes a state
the capture never reaches. *The lesson is the one wave 4 drew on midiclock and it
recurs here: a stale exemption goes quietly green forever, produces no failure — only
absent work — and reads as a considered decision.*

**3. The claim that "NUMPAD+'s card installs a document-level capturing keydown
listener" is attributed to the wrong file.** It appears in three places
(`interactive-doc-modules.ts:154-156`, `strict-docs.ts:193-195`,
`docs-virtual-module.spec.ts:411`) and is the stated reason numpadPlus is excluded
from the live doc-card allowlist. **The listener is in the FACTORY**
(`numpad-plus.ts:604-683`), which the engine-less doc sandbox never runs. By the
allowlist's own criteria the module qualifies. ⚠ **The correction does NOT license
adding it** (D8) — a wrong reason for a decision is not the same as a wrong decision,
and promoting it needs a verified live run.

**4. A documented affordance does not exist.** I went looking for the drag-to-change-
note handler the def's `docs.controls` and the card's own header both describe, in
order to map it to a cell. **There is no handler** — the cell has `onclick` and
nothing else (D4). *The lesson: `module-docs-lint` reads the DEF, so a def that
promises what its card does not implement is invisible to it in exactly the direction
that matters.*

**5. `activeLayer`'s CV mapping is not what I assumed from `resolveActiveLayer`'s
name.** `round(cv * 4)` clamped to `0..3` looked like four equal quarters. Worked
through: L1 gets cv `[0, 0.125)` and L4 gets `[0.625, 1.0]` — **a 3× asymmetry**
(D6). *The lesson is the cheapest one here: a clamp on the outside of a rounding
function silently merges two buckets, and the merged one is always an endpoint.*

---

## 1. WHAT THE MODULE IS FOR

**Turning the thing already under your hands into a four-track sequencer.**

Every other sequencer in the rack is a thing you *program*: `sequencer`, `kria`,
`drumseqz`, `writeseq`, `cartesian` all give you a grid and ask you to place events
in it. `numpadPlus` gives you a **keyboard** — the 12 keys of a numeric keypad,
mapped `1=C … *=B` (`numpad-plus.ts:85-100`) — and records what you PLAY. Press a
key and the active layer's pitch + gate fire *immediately* (`:628-632`); with REC ARM
or OVERDUB on, the same press also lands on the nearest step
(`quantizeToNearestStep`, `:193-203`). Four layers share one playhead and one tempo,
each with its own `pitch`/`gate` pair, so four passes over the same sixteen steps
build four parallel lines into four downstream voices. A ninth output carries the
active layer as a **poly** cable (`:296-297`).

The verb is **PERFORM**, and the module's own comment says so: *"doubles as a live
performance keyboard"* (`:3-4`). The distinctive thing it does that its siblings do
not is that **the recording surface and the performance surface are the same
gesture**. `writeseq` records step-by-step; `polyseqz` sequences chords you enter;
`numpadPlus` is the only module in the fleet where *playing it* and *writing it* are
the same action, distinguished only by whether ARM or OVD is lit.

**What that means for the face.** The face has to make three things glanceable at
once — WHAT is recorded (the sixteen steps), WHERE you are writing (the layer, and
whether you are writing at all), and WHAT the keys will play (the octave, and the
map). Everything else — BPM, the transport — is the ordinary sequencer furniture
every sibling has. The two bespoke surfaces are the **step grid** and the **keymap**,
and they are bespoke for opposite reasons: the grid because sixteen cells of
`node.data` have no `ParamDef`, the keymap because a `code → semitone` bijection has
no primitive anywhere in the shell.

---

## 2. STOP 1 — IS PROMOTING THIS MODULE A PARITY LOSS?

Thinness is not the question (owner, 2026-08-20). The question is whether the
promoted face **drops something the player can do or see today**, since promotion
removes the legacy card from the lane and from the dock full view.

| affordance | `NumpadPlusCard.svelte` | where it goes on the face | lost? |
|---|---|---|---|
| 16 step cells (click to toggle) | `:277-289` | **`numpad-cell-{n}` PANEL**, `face.hero.cell` — §6.2 | no |
| the step's NOTE, painted in the cell | `:117-122` (`cellLabel`) | **stays painted** — §7 rules on it explicitly | no |
| playhead highlight | `:123-125`, `:473-476` | panel, same derivation | no |
| L1–L4 layer buttons | `:227-235` | **`activeLayer` gets an `options` roster** → a segmented cell — §6.3 | no, **gained** (selectable, nameable, MIDI-learnable) |
| PLAY / STOP | `:240-246` | `isPlaying` toggle cell | no |
| BPM knob | `:247` | `bpm` knob cell | no |
| ARM | `:248-256` | `recArm` toggle cell | no |
| OVD | `:265-273`… `:257-264` | `overdub` toggle cell | no |
| POLY | `:265-273` | `poly` toggle cell | no |
| octave ▼ / ▲ nudge | `:217-219` | `octave` gets an `options` roster → a selector cell — §6.3 | no |
| octave VALUE, painted as a number | `:218` | ⚠ **removed as a number, restored as an option NAME** (`c0…c8`) — §7 | no |
| 12 note key caps + their bound keys | `:295-308` | **`numpad-key-{n}` PANEL** — §6.2 | no, **gained** (declared, documented, contract-visible) |
| 2 octave-action key caps | `:311-323` | same panel, same family — §6.2 | no |
| right-click → Remap… / Reset to default | `:300`, `:316`, `:341-358` | same panel, verbatim, incl. the `<body>` portal | no |
| the "press any key" hint | `:326-330` | same panel, and it becomes the panel's PROBE — §6.2 | no |
| the prose hint block | `:332-336` | ⚠ **removed** — annotation/`docs`, per the ruling — §7 | no (moves to right-click Annotate) |
| the 11 jacks | `:100-114` (`PatchPanel`) | the shell's own patch surface + rear card | no |

**Nothing is lost. Four things are gained**, and they are gained because the face
forces declarations the card never needed: two discrete params get rosters (so they
become *selectable*, *nameable*, automatable and MIDI-learnable), and fourteen
card-only key caps become a declared, documented, contract-visible control family.

**STOP 1 verdict: PROMOTE.** No refusal grounds. The two named refusal precedents do
not apply — `joystick` (#1974) fails because `laneOrder`/`foldedOrder` drop its only
control to zero, and numpadPlus's `laneOrder` (§8) surfaces six; `spectrograph`
(#2065) fails because an audio-domain def with video ports has no engine surface, and
numpadPlus asks for no picture at all (§5).

---

## 3. STOP 2 — DOES EVERY WAY OF GETTING DATA IN SURVIVE?

The skill's grep, run verbatim:

```sh
grep -nE '<button|<select|<input|oncontextmenu|manualTrigger|Toggle|Selector|accept=' \
  packages/web/src/lib/ui/modules/NumpadPlusCard.svelte
```

**17 hits. Every one mapped, none exempted:**

| line | what it is | destination |
|---|---|---|
| `:217` | octave ▼ | `octave` param cell (roster, §6.3) |
| `:219` | octave ▲ | same cell |
| `:228` | L1–L4 (`{#each}` × 4) | `activeLayer` param cell (roster, §6.3) |
| `:240` | PLAY/STOP | `isPlaying` param cell |
| `:248` | ARM | `recArm` param cell |
| `:257` | OVD | `overdub` param cell |
| `:265` | POLY | `poly` param cell |
| `:279` | step cell (`{#each}` × 16) | `numpad-cell-{n}` panel (`face.hero.cell`) |
| `:296` | note key cap (`{#each}` × 12) | `numpad-key-{n}` panel |
| `:300` | `oncontextmenu` → remap menu | `numpad-key-{n}` panel, verbatim |
| `:312` | octave-action key cap (`{#each}` × 2) | `numpad-key-{n}` panel — SAME family, see below |
| `:316` | `oncontextmenu` → remap menu | same |
| `:349` | `oncontextmenu` on the menu backdrop | same (menu machinery) |
| `:352` | "Remap…" menu item | same |
| `:354` | "Reset to default" menu item | same |

**No `<select>`, no `<input>`, no `accept=` anywhere.** numpadPlus has no file
import, no device roster and no browser-permission gesture — so it needs none of the
things that blocked `midiclock` (`ShellSelectorCell.options` takes `node`, not an
`env`) or `cameraInput` (a status registry for an off-screen host). **The whole
surface is expressible with declarations plus two panels.**

⚠ **ONE FAMILY, NOT TWO — and the card's own markup is what makes it a decision
rather than an observation.** The card emits **two** testid prefixes for what is one
control kind: `numpad-key-${st}` for semitones 0–11 (`:301`) and
`numpad-octkey-${act}` for the two octave actions (`:317`). The DEF does not agree
with that split: `DEFAULT_KEYMAP` (`:85-100`) is ONE fourteen-entry map, and
`OCTAVE_UP_ACTION = 12` / `OCTAVE_DOWN_ACTION = 13` (`:106-107`) are described in the
def's own comment as *"remappable KEYS too (not held modifiers) … keyed by sentinel
'semitone' values OUTSIDE the 0..11 note range"* (`:101-105`). The card's own
`physLabelFor` / `targetLabel` / `openKeyMenu` / `beginRemap` handle all fourteen
identically (`:148-175`).

**So the split is a card artefact.** The face declares ONE family,
`testidPrefix: 'numpad-key'`, whose members are `numpad-key-0 … numpad-key-13`, and
the boy-scout half of this PR unifies the card's prefix to match. That costs one
contract line instead of two, and it removes the standing hazard that a second
prefix drifts away from the first.

⚠ **The card change breaks two committed e2e assertions and they are fixed in the
same PR**: `numpad-plus.spec.ts:134-135` (`numpad-octkey-12` / `numpad-octkey-13`)
and `:151`. See §10.

---

## 4. THE PRIMARY INTERACTION — WHY THIS IS BESPOKE AND NOT A RANKED LIST OF KNOBS

**Because both of this module's editable surfaces are grids of N identical
instances backed by `node.data`, and the shell has exactly one primitive for that.**

Rank the seven params honestly and you get a perfectly ordinary face: a tempo knob,
four switches, and two pickers. That face would be *complete* by
`module-face-lint`'s definition and it would be **useless**, because the player
could not see a single note they had recorded and could not tell which key plays
which pitch. The two things that make `numpadPlus` an instrument —
`data.layers` and `data.keymap` — have no `ParamDef` and therefore no rank, no cell,
no docs key and no place on a generic face at all.

That is the DX7 defect and the `kria` argument, and `kria`'s promotion is the proof
that the answer is a **PF-14 panel** rather than a shell extension. `KriaGridPanel.svelte:4-10`
states the ladder decision in one sentence:

> *"A 7×16 step grid is 'ONE picture-you-edit inside the generic face', which is
> rung 2's description almost word for word. Both of kria's views fit here, so this
> module ships NO `face.extension` at all — no lazy chunk, no new render site, and
> the clicked-grid half of the sequencer cohort turns out to need no platform seam
> whatsoever."*

**numpadPlus is the same cohort and needs the same nothing.** No
`face.extension`, no `fullViewBody`, no new wired slot, no platform PR. Two panels
inside the generic face, and every one of its seven params in an ordinary cell.

⚠ **THE ONE THING THAT IS GENUINELY DIFFERENT FROM `kria`, and it drives §7.**
kria's note is POSITIONAL: its NOTE lane is a column of rows and *which row is lit*
IS the pitch, so kria's grid can paint zero text and lose nothing
(`KriaGridPanel.svelte:22-27`). numpadPlus stores an **absolute MIDI int per step**
(`NoteStep.midi`, `numpad-plus.ts:233`) recorded at whatever octave was current, and
its grid is one row per step. There is no position that encodes the pitch. So the
question "does a step cell paint its note?" is a real question for this module and a
non-question for kria — and copying kria's answer without noticing that would delete
the only surface that says what was recorded. §7 rules on it.

---

## 5. THE LANE PICTURE — REFUSED, AND MECHANICALLY PROTECTED

Waves 2 and 3 refused a lane picture for every module they examined, always for the
same platform fact: `ShellExtensionGlyphProps` (`shell-extensions.ts:44-52`) carries
`num`, `numbers` and `testid` and **no `nodeId`**, so a glyph is a pure function of
one discrete param value and every instance of a module would draw a byte-identical
picture. Wave 4 accepted one for `picturebox`, but only because
`hasVideoSurface(def) → def?.domain === 'video'` (`module-shell-model.ts:177-179`)
routes video modules onto a different seam entirely.

**numpadPlus reaches neither.** It is refused by a third mechanism, and the refusal
is total:

```
numpad-plus.ts:286-298   outputs: pitch ×4, gate ×4, polyPitchGate ×1
shell-glyph-live.ts:111-113  primaryAudioOutPortId = outputs.find(o => o.type === 'audio')?.id ?? null
module-shell-model.ts:177-179 hasVideoSurface = domain === 'video'    (numpadPlus is 'audio')
module-face-lint.test.ts:121  VALID_GLYPHS = scope | meter | envelope | waveform | algorithm | none
```

**Not one of the nine outputs is `type: 'audio'`.** So `primaryAudioOutPortId`
returns `null`, `glyphBinding` can reach no `live-audio` binding, every non-`none`
literal falls through to `{ kind: 'static' }`, and `module-face-lint` reddens a dead
static glyph unconditionally — no exemption list, no count. And `laneGlyphFor`
(`module-shell-model.ts:237-240`) returns `'none'` for an audio-domain def without a
declared trace.

**`glyph: 'none'` is the only literal that compiles into a green run.** An author who
never thinks about it ships the right thing.

⚠ **What picture this module WOULD want, recorded so nobody re-derives it as a fresh
idea, and refused here.** The useful glance on a 192 px tile is *"what is on the
active layer, and where is the playhead"* — sixteen lit/unlit dots with one moving
highlight. That is not a picture of a SIGNAL, it is a picture of `node.data`, and it
needs strictly more than the `nodeId` prop waves 2 and 3 asked for: it needs the
node's `layers`, its `activeLayer` **and** an engine read of `stepIndex` per frame.
kria's own face makes the identical observation and declines for the identical reason
(`kria.ts:199-208`: *"a `nodeId` prop alone would still not be enough here — the
picture a player wants is the playhead over the SELECTED track's SELECTED lane, which
is two more pieces of node.data"*). **Two independent sequencer faces reaching the
same refusal by the same arithmetic is the strongest form of that argument, and it is
still not a reason to build the seam on a module PR.**

---

## 6. THE FACE

### 6.1 N IDENTICAL INSTANCES — A FAMILY KEY IS **ONE CELL**, AND THE NAIVE DESIGN BREAKS HERE

This is the central mechanical fact of the spec, and it is the one a designer
reading the card would get wrong. `numpadPlus` renders **16 step cells** and
**14 key caps** — thirty near-identical controls. The instinct is thirty
`face.order` keys, or a family that "expands" into thirty cells.

**Neither happens. A family template resolves to exactly ONE cell.** Measured:

* `module-face-lint.test.ts:119` — `const FAMILY_KEY = /^(.+)-\{n\}$/`, and
  `keyResolves` (`:150-155`) matches the template against `controlFamilies[].id`.
  ONE key, ONE family.
* `shell-cells.ts:2011-2020` — `shellCellFor(moduleType, ctl)` is
  `SHELL_CELLS[moduleType]?.[ctl.key]`. The face key indexes ONE spec.
* `ModuleShell.svelte:1224` — `{@const cell = shellCellFor(node.type, ctl)}` inside
  the per-control loop; `:1292-1309` renders the `panel` branch once, as one
  `.kcol.ms-cell-panel` with `--panel-min-w`.

**So the sixteen steps are ONE cell whose component draws sixteen buttons
internally, and the fourteen caps are ONE cell whose component draws fourteen.**
That is exactly how `kria` ships (`shell-cells.ts:1795-1806`: one
`'kria-cell-{n}'` panel covering `7 lanes × 16 steps` PLUS sixteen pattern slots),
and it is what makes the arithmetic in §6.4 come out at nine ranked keys instead of
thirty-eight.

⚠ **The corollary that matters for band packing:** a panel's width class is `'wide'`
(`dock-row-plan.ts:193`), so a band carrying one is SOLO (`bandIsPackable`,
`:220-222`) — regardless of how many buttons are inside it. Thirty controls cost the
row budget of one.

### 6.2 THE TWO PANELS

Both are PF-14 `panel` cells (`ShellPanelCell`, `shell-cells.ts:385-398`),
registered under a `numpadPlus:` block in `SHELL_CELLS` keyed by the exact
`face.order` key.

#### `numpad-cell-{n}` — THE STEP GRID (the hero)

* **Family: already declared** (`numpad-plus.ts:347`), already in the contract
  (`contract-lock.txt:2394`). **Zero contract movement for this one.**
* **Component**: `packages/web/src/lib/ui/modules/numpadPlus/NumpadStepGrid.svelte`.
  DOM, not canvas — `KriaGridPanel.svelte:35-38` states the reason and it applies
  verbatim: *"a WebGL surface would enrol this module in the attest basis … making
  every future edit here cost a real-GPU re-attest window"*, and numpadPlus costs
  ZERO attest today (§12.1).
* **Layout**: `4 × 4`, the card's own layout (`NumpadPlusCard.svelte:452-456`). §6.6
  argues why 4×4 and not 16×1.
* **`minWidth`**: **176** — derived in §6.6 from the committed CSS, and a
  MUST-VERIFY against the live pane (M6).
* **`face.hero.cell: 'numpad-cell-{n}'`.** Required, not decorative: `panelTierProblems`
  (`module-face-lint.test.ts:1857-1874`) refuses a panel SELECTED at any lane tier,
  and PF-22's `laneOrder` (`curated-face.ts:131-143`) drops exactly `face.hero.cell`
  from the LANE roster — so a hero picture costs no lane rank and MAY rank first.
  Without the hero promotion the grid would need rank ≥ 7 to clear
  `LANE_PLATE_MAX_CELLS = 6` (`curated-face.ts:58`, `PLATE_COLS = 3` ×
  `PLATE_MAX_ROWS = 2`), which would bury the module's only picture below every
  switch.
* **Probe** — `data`, not `data-rev`, per `shell-cells.ts:365-372`:

  ```ts
  probe: {
    testid: 'numpad-cell-0',
    action: 'click',
    effect: { kind: 'data', key: 'layers.0.0', expect: 'changed' },
  }
  ```

  **It is live in the SHIPPED DEFAULT STATE, which is the property kria's comment
  says to check** (`shell-cells.ts:1782-1789`). A fresh spawn has `activeLayer = 0`
  and `layers[0][0] = { on: false, midi: null }` (`numpad-plus.ts:236`); the click
  runs `toggleStep(0)` which writes `{ on: true, midi: 12 + octave*12 }`
  (`NumpadPlusCard.svelte:88-92`, and the panel keeps that arithmetic). No seeding,
  no transport, no audio gate.

  ⚠ **Narrower than kria's, deliberately.** kria watches a whole lane array; this
  watches the exact step the probe clicks, which is strictly stronger *because the
  probe names the cell*. A write that landed on a different step would leave
  `layers.0.0` untouched and redden — which is the failure mode kria's broader path
  cannot distinguish.

#### `numpad-key-{n}` — THE KEYMAP

* **Family: NEW.** `{ id: 'numpad-key', label: 'Keypad note binding', kind: 'other',
  testidPrefix: 'numpad-key' }`. `kind: 'other'` matches kria's non-grid families
  (`kria.ts:153-159`); `'step-grid'` would be a lie about what it is.
  **This is the ONE contract line the PR adds** (§12.4).
* `module-docs-lint.test.ts:360-375` greps ALL of `ui/**/*.svelte` for the literal
  `testidPrefix`. The card already emits `` `numpad-key-${st}` `` at `:301`, so the
  grep passes the moment the family is declared — and it keeps passing after the
  panel exists.
* **Component**: `.../numpadPlus/NumpadKeymapPanel.svelte`. Fourteen caps in a
  `7 × 2` grid; each cap paints its NOTE (or `OCT↑`/`OCT↓`) and the physical key
  currently bound to it. §7 rules on both texts.
* **`minWidth`**: **208** (§6.6).
* **RANKED LAST**, so it is dock-only by ARITHMETIC rather than by a rule: at lane
  roster index 8 it is past `LANE_PLATE_MAX_CELLS = 6` and `panelTierProblems` is
  satisfied (§6.4).
* **Probe** — and this is the one place the design must CHANGE the card's
  interaction, so it is argued rather than asserted:

  ```ts
  probe: {
    testid: 'numpad-key-0',
    action: 'click',
    effect: { kind: 'text', testid: 'numpad-key-hint', expect: 'changed' },
  }
  ```

  ⚠ **A LEFT-CLICK ON A CAP MUST DO SOMETHING, AND TODAY IT DOES NOTHING.** The
  card's cap carries `oncontextmenu` and no `onclick` (`NumpadPlusCard.svelte:296-307`),
  so a plain click is inert. `ShellPanelProbe.action` is `'click' | 'drag'`
  (`shell-cells.ts:352`) — there is no right-click action — so an inert cap cannot be
  probed at all, and `ShellPanelCell.probe` is a REQUIRED field
  (`shell-cells.ts:395`, non-optional; `ShellActionCell.probe` is required the same
  way at `:293`), which `shell-cells.test.ts` enforces over every promoted face.

  **The resolution is a UX improvement, not a workaround: left-click BEGINS the
  remap** (what the right-click menu's first item already does,
  `NumpadPlusCard.svelte:352-353`), right-click still offers the Remap…/Reset menu,
  and Esc still cancels (`:192`). One click instead of two for the common action.

  ⚠ **`text` and not `data`, for a stated reason.** Beginning a remap writes nothing
  to the graph — `remapSemitone` is component state (`:135`) — so a `data` probe
  would be RED on a perfectly live cap. `shell-cells.ts:373-381` is explicit that
  `text` exists for exactly this: *"a panel keeps the setting in component state, and
  its probe names a DIFFERENT element whose text the interaction must move"*. The
  named element is the panel's hint line, which is **not** the cap the probe clicks —
  `shell-cells.test.ts` fails a probe whose two testids are equal.

  ⚠ **The hint element must EXIST AT REST** (empty), not appear on click. The card
  renders it conditionally (`:326-330`), and `expect: 'changed'` over an
  absent→present element is not a comparison the sweep can make. In the panel it is
  always in the DOM with empty text.

  ⚠ **AND THE PANEL MUST NOT BE LEFT ARMED.** faces-parity clicks and moves on. A
  panel left listening would capture the sweep's NEXT keystroke and silently rebind a
  key — a test that mutates the fixture it is measuring. The panel cancels listening
  on pointerdown outside itself, on blur, and on Esc. **M4 in §15 is a permanent
  check that a faces-parity pass leaves `node.data.keymap` untouched.**

### 6.3 ROSTERS MAKE STATES SELECTABLE — TWO PARAMS NEED ONE

The skill's "rosters make states SELECTABLE" section names the trap and the shipped
failure: *"A `2..3 discrete` param drawn as a KNOB has exactly two reachable
positions across the dial's whole travel, so an ordinary drag quantises back to where
it started. ⚠ `moog962` shipped that way and `faces-parity` failed it on both
attempts."*

`paramCellKind` (`shell-control-kind.ts:303-318`) is the resolver:

```ts
if (p.options?.length) {
  if (tier !== 'dock') return 'knob';
  return p.options.length <= SEGMENTED_MAX_OPTIONS ? 'segmented' : 'selector';
}
if (looksLikeToggle(p)) return 'toggle';
return 'knob';
```

Applied to numpadPlus's seven params **as declared today**:

| param | shape | today's derived cell | verdict |
|---|---|---|---|
| `bpm` | `30..300 linear` | knob | ✓ correct |
| `isPlaying` | `0..1 discrete` | toggle | ✓ correct |
| `recArm` | `0..1 discrete` | toggle | ✓ |
| `overdub` | `0..1 discrete` | toggle | ✓ |
| `poly` | `0..1 discrete` | toggle | ✓ |
| **`activeLayer`** | `0..3 discrete`, no options | **knob — FOUR positions across the whole dial** | ⚠ the moog962 shape |
| **`octave`** | `0..8 discrete`, no options | **knob — NINE positions, and ANONYMOUS** | ⚠ parity loss |

**Both get a roster, and each for a different one of the two questions the skill
says look like one question.**

**`activeLayer` — the SELECTABILITY question.** Four detents over ~270° is 67° per
step; a short drag quantises back. More importantly the names already exist and live
only in the card: `NumpadPlusCard.svelte:234` renders the literal `` L{l + 1} ``.
That is the `moog904b` / `sampleHold` shape exactly — *"Promote names that already
exist and the shell cannot otherwise reach"*. So:

```ts
export const NUMPAD_LAYER_OPTIONS = Array.from(
  { length: NUMPAD_PLUS_LAYERS },
  (_, i) => ({ value: i, label: `l${i + 1}` }),
);
```

exported from the def and **imported by the card**, per the backdraft one-place rule
(`kria-cell-actions.ts:12-18` is the worked precedent). Four options ≤
`SEGMENTED_MAX_OPTIONS = 6` (`shell-control-kind.ts:128`) ⇒ a **segmented** cell at
the dock: all four visible at once, which is right for a control whose whole job is
"which of these four". No `paramCells` override, and none is possible — `'segmented'`
is not an `AuthoredParamCell` (`shell-control-kind.ts:118-122`).

⚠ Lowercase `l1…l4`, per the repo's lowercase-label standard. `looksNumeric('l1')`
is **false** (`face-readout-source.test.ts:572-574` requires a leading `[0-9]+`), so
no `NUMERIC_LABEL_EXEMPTIONS` entry is needed — checked, not assumed.

**`octave` — the PARITY question, and the answer avoids nine exemption entries.**
The card paints the octave as a NUMBER (`:218`, `data-testid="numpad-octave-value"`).
§7 removes that. Without a roster the dock would show an anonymous nine-position dial
and the player could no longer tell what octave they are in — a real parity loss. So
`octave` gets a roster; the only question is what the nine states are CALLED.

⚠ **Labelling them `'0' … '8'` would be a bare number under a control**, which is the
offence `face-readout-source.test.ts` owns. It would need **nine**
`NUMERIC_LABEL_EXEMPTIONS` entries — and that list's own header warns *"POPULATE IT
FROM A SWEEP, NOT FROM THE RED LINE"* (`:328-338`). Nine entries added to satisfy one
red line is precisely what it forbids.

**They have a real name, and the module already computes it.** `octave` N means the
keypad's `1` key plays C of octave N: `midiForKey` returns `(effectiveOctave + 1) * 12
+ semitone` (`numpad-plus.ts:186`), so octave N's C is MIDI `(N+1)*12`, and
`noteNameForMidi` (`note-entry.ts:109-116`) names it `c0 … c8`. Both endpoints are
in range — `MIN_MIDI = 12` is `c0`, `MAX_MIDI = 108` is `c8` (`note-entry.ts:23-24`).
So:

```ts
export const NUMPAD_OCTAVE_OPTIONS = Array.from(
  { length: 9 },
  (_, o) => ({ value: o, label: noteNameForMidi((o + 1) * 12) }),   // 'c0' … 'c8'
);
```

**DERIVED from the module's own arithmetic, not typed.** `looksNumeric('c4')` is
false. **Zero exemption entries.** Nine options > `SEGMENTED_MAX_OPTIONS` ⇒ a
**selector** at the dock (a portaled, viewport-clamped list) and a nine-position knob
in the lane, which is reachable.

⚠ **`optionsExhaustive` is NOT declared on either, and declaring it would be RED.**
`param-vocabulary.test.ts:168-174` fails a roster that covers every step
(*"roster covers every step … so optionsExhaustive is redundant — delete it"*).
`activeLayer` names 4 of 4 and `octave` names 9 of 9. Both are exhaustive by
coverage. **This is the inverse of wave 4's midiclock finding** — there the roster
was sparse and the clause was required; here it is total and the clause is refused.
Checked rather than copied.

⚠ **THE FOUR SWITCHES EACH NEED AN EXPLICIT LATCHING CLASSIFICATION.**
`looksLikeSwitch` (`shell-control-kind.ts:141-143`) marks every `0..1 discrete
default 0` param as requiring a momentary/latching decision, and
`module-face-lint.test.ts:499`'s `ACKNOWLEDGED_LATCHING` is where a promoted module
records it. `isPlaying`, `recArm`, `overdub`, `poly` all match the shape. All
four are **LATCHING**, and each classification is made **at the read site** (the
discipline every existing entry follows):

* `numpadPlus:isPlaying` — `tick()` reads it as a level every scheduler tick
  (`numpad-plus.ts:547`) and compares it against `prevIsPlaying` for the
  play-from-start edge (`:550`). A momentary render would stop the transport on
  release.
* `numpadPlus:recArm` — read as a level at play-from-start (`:558`); the module
  **writes it back to 0 itself** after sixteen steps (`:530-535`). A press-pad would
  make arming impossible, since arming means "be on when PLAY is next pressed".
* `numpadPlus:overdub` — read as a level inside the keydown handler on every press
  (`:634`). It is the mode you leave on while you play.
* `numpadPlus:poly` — read as a level per press (`:651`). Same shape as the already
  acknowledged `samsloop:poly`, and for the same reason.

**None gets `face.momentary`.** There is no press-pad on this module.

### 6.4 RANK — `face.order`

```ts
face: {
  glyph: 'none',                     // mandatory — §5
  hero: { cell: 'numpad-cell-{n}' }, // PF-22 — the picture costs no lane rank
  order: [
    'numpad-cell-{n}',   // 1  the sixteen steps — the module's only picture
    'activeLayer',       // 2  which of four lines everything else acts on
    'recArm',            // 3
    'isPlaying',         // 4
    'overdub',           // 5
    'octave',            // 6
    'bpm',               // 7
    'poly',              // 8
    'numpad-key-{n}',    // 9  the keymap — dock-only by arithmetic
  ],
  pages: [ /* §6.5 */ ],
}
```

**The tier ladder, read back as a sentence** (`faceTierCap(tier, laneGlyphFor(def))`,
`curated-face.ts:58,75-80`, with `laneGlyphFor → 'none'` so `hasGlyph` is false and
compact takes `LANE_ROW_MAX_CELLS = 3` rather than `…_WITH_GLYPH = 2`,
`module-shell-model.ts:366-368`):

> At **mini** you see which LAYER this instance is driving. At **compact** you also
> see whether it is ARMED and whether it is RUNNING. At **full** you get the whole
> transport and the octave. At the **dock** the sixteen steps sit above all of it,
> and the keymap below.

**Every rank defended against a counter-argument that would be right for a different
module:**

* **`activeLayer` first (rank 2, lane rank 1).** The obvious alternative is
  `isPlaying`, and it is wrong here in a way it would be right on `sequencer`.
  numpadPlus **sounds while stopped** — `tick()` returns early on `!isPlaying` but
  still calls `applyOutputs` so live keys play (`numpad-plus.ts:567-571`), and the
  def's own docs say so (`:333`: *"When stopped the playhead holds at step 1 but live
  keys still sound"*). So the transport is not the gate on making a sound, and
  `activeLayer` is: it decides which pitch/gate pair the keys drive, which layer
  records, which layer the grid edits, and which layer feeds `poly`
  (`applyPolyOutput`, `:508-519`). It is also the module's ONE CV-addressable control
  (`resolveActiveLayer`, `:264-273`) — the only param a cable can reach — and the
  disambiguator when a rack holds several instances, which the def explicitly
  supports (*"multiple NUMPAD+ on the same rack all act on the same keypress
  (chord-stack style)"*, `:47-49`).
* **`recArm` above `isPlaying`.** They are one gesture in a fixed order: ARM, then
  PLAY. `:557-563` only latches recording when `recArm` is already high at the
  play-from-start edge, so arming *after* pressing play does nothing until the next
  stop/start. The rank teaches the order.
* **`octave` above `bpm`.** `octave` transposes every key you press and is touched
  constantly during a performance; `bpm` is set once and is **ignored entirely while
  an external clock is patched** (`:573-577` returns before the internal scheduler).
  A tempo control that a cable disables is not a top-six control.
* **`poly` last of the params.** It gates RECORDING only, never the output — the
  def's own comment is emphatic (`:366-368`: *"Always live (the `poly` PARAM gates
  RECORDING, not the output)"*), so the POLY jack works at 0 or 1 and a player who
  never finds this switch loses nothing audible.
* **`numpad-key-{n}` last.** It is SETUP, not performance: the default map is a
  chromatic octave under the fingers and most players will never remap. Ranking it
  above `poly` would put a fourteen-cap grid in front of a control you use every
  take.

**Completeness** (`module-face-lint.test.ts:158-176` + the completeness clause):
seven params + two declared families = nine ranked keys, and `face.order` has nine.
No `noUserControl` (every param is one a player should control). No numbered legend —
only three exist in the whole repo and numpadPlus is not one of them.

### 6.5 PAGES, BANDS AND PACKING — FOUR HONEST BANDS, NO RAIL

```ts
pages: [
  { id: 'pattern',   label: 'pattern',   controls: ['numpad-cell-{n}', 'activeLayer'] },
  { id: 'record',    label: 'record',    controls: ['recArm', 'overdub', 'poly'] },
  { id: 'transport', label: 'transport', controls: ['isPlaying', 'bpm'] },
  { id: 'keypad',    label: 'keypad',    controls: ['octave', 'numpad-key-{n}'] },
],
```

`order` and `pages` DISAGREE, deliberately, and the comment on the def says why:
`order` is PRIORITY (what survives truncation at a lane tier), `pages` is SIGNAL
ORDER (what the dock reads top to bottom — you record into a pattern, then you run
it, and the keypad is the instrument underneath all of it).

**Four bands is the honest grouping and it does NOT reach the rail.**
`DOCK_TAB_MIN_BANDS = 7` (`dock-tabs-model.ts:101`, applied at `:142`).

⚠ **AND THE TEMPTATION IS WORTH NAMING, BECAUSE THIS MODULE LOOKS LIKE A TAB-RAIL
CANDIDATE AND ISN'T.** The owner's control-heavy ruling says *"lots of controls of
DIFFERENT types"*, and numpadPlus has **five** distinct cell kinds (panel, segmented,
selector, toggle, knob) across nine ranked keys — more kinds than most faced modules.
It would be easy to split this into seven pages (`steps / layer / arm / overdub /
poly / tempo / keys`) and engage the rail. **That would be padding.** `recArm`,
`overdub` and `poly` are one idea (how a keypress is written); `isPlaying` and `bpm`
are one idea (how the playhead walks). Backdraft's eight pages are eight
*subsystems*; numpadPlus has four. `face.tabbed` is **OWNER-INSTRUCTION ONLY**
(`graph/types.ts:1049-1069`, one adopter: `spirographs`) and this spec does not reach
for it.

**→ OWNER DESIGN DECISION, and it is the only one in this spec:** four bands renders
as one column. If the owner wants the rail on a five-cell-kind module, that is a
`FACE_TAB_OPT_IN` instruction, quoted verbatim. The spec ships untabbed, which is what
`ruttetra` was ruled to do at four pages.

**Band packing** (PF-21, `dock-row-plan.ts`), derived from the width classes:

| band | cells | width classes | packable? |
|---|---|---|---|
| `pattern` | `activeLayer` (the grid is MOVED to the hero by `heroFacePlan`) | segmented → **wide** (`:135`) | **SOLO** |
| `record` | `recArm`, `overdub`, `poly` | toggle ×3 → column (`:116`) | packable |
| `transport` | `isPlaying`, `bpm` | toggle, knob → column (`:115-116`) | packable |
| `keypad` | `octave`, `numpad-key-{n}` | selector → wide (`:136`); panel → wide (`:193`) | **SOLO** |

`record` + `transport` pack into one row (5 cells ≤ `DOCK_ROW_MAX_CONTROLS = 10`).
**Three rows** under the hero. No band is emptied by the hero promotion — `pattern`
keeps `activeLayer` — so the post-hero band count stays **4**, which is the number the
VRT roster entry declares (§11).

### 6.6 WIDTH — COMPACT, AND THE PLATE IS DEFINED BY THE KEYMAP AT ~208 px

Owner: *"we do not want useless gray horizontal space on cards, ever. prefer
compact. screen real estate is expensive!"* The gate is
`FACE_WIDTH_SLACK_MAX_PX = 40` measured as `bodyW - contentW`
(`workflow-shell-faces.spec.ts:224`, and the corrected subject documented at
`:250-263`), deny-by-default with `FACE_WIDTH_EXEMPTIONS` (`:264`).

⚠ **THERE IS NO COMMITTED BASELINE PNG TO MEASURE, because numpadPlus is
VRT-EXEMPT** (§11). So the numbers below are derived from **committed CSS and
committed constants**, and are labelled as such; the live pane measurement is
**M6 in §15**, and the build agent must not ship a `minWidth` it has not measured.
(The anti-pattern this avoids is the first one on the adversarial-audit list —
*"justifying a decision with computed pixel arithmetic instead of the committed
baseline PNG"*. There is no PNG; there is CSS, and it is named.)

**Committed measurements, from the card's own stylesheet:**

| source | value |
|---|---|
| `rack-sizes.ts:110` | `numpadPlus: { size: '4u', hp: 4 }, // 714×722px` — the rendered CARD, incl. an 11-jack PatchPanel |
| `NumpadPlusCard.svelte:368` | `.card { min-width: 360px }` |
| `:366` | `padding: 14px 12px 12px` ⇒ content box ≥ **336 px** |
| `:452-456` | `.grid { grid-template-columns: repeat(4, 1fr); gap: 3px }` |
| `:457-467` | `.cell { aspect-ratio: 1.4/1; font-size: 0.7rem }` (mono) |
| `:479-494` | `.keymap { display:flex; flex-wrap:wrap; gap:3px }`, `.kmap-key { width: 26px }` |

**The step grid.** The widest string a cell paints is a three-character sharp-plus-
octave name (`c#4`) at `0.7rem` mono ≈ 8.4 px/char ≈ 25 px, plus 2×4 px padding and
a 1 px border ⇒ a **~36 px** cell. Four columns + three 3 px gaps + a 2×8 px panel
padding ⇒ **`minWidth: 176`**.

**The keymap.** Fourteen `26 px` caps. The card lets them WRAP at the card's content
width (336 px ⇒ 12 per row, 2 rows, ragged). The panel fixes the grid at **7 × 2**,
which is exactly fourteen with no ragged row: `7×26 + 6×3 = 200`, plus 2×4 px panel
padding ⇒ **`minWidth: 208`**.

**So the widest thing on the plate is 208 px** — against `kria`'s 320
(`shell-cells.ts:1808-1811`), and roughly a fifth of the card's 714 px.

**Is any of it EARNED?** Yes, and only the part that is a picture-you-edit:

* the step grid is a **picture-you-edit** — the owner's named earner. It is also the
  *narrowest honest layout* of sixteen steps (see the taste call below).
* the keymap is a **grid of controls**, not empty reserve. Every one of the 200 px is
  a cap you can click.
* nothing else asks for width: four toggles and a knob are 40–68.8 px columns
  (`dock-row-plan.ts:109-111`), the segmented `l1|l2|l3|l4` is ~4×34 ≈ 136 px, the
  `octave` selector is a 168 px chip.

**So `FACE_WIDTH_EXEMPTIONS` gains NO entry, and `PLATE_FLOOR_EXEMPTIONS`
(`face-width-source.test.ts:88`, currently empty) gains none either.** The plate is
content-sized at ~208–230 px and the slack should land in the documented 15 px /
32–33 px modes.

⚠ **Why 4×4 and not 16×1, since 16×1 is what a sequencer usually looks like.**
Sixteen 36 px cells + fifteen gaps = **621 px** — three times the plate, and it would
be the widest face in the fleet on a module whose controls are otherwise tiny. 8×2 is
**333 px** and still the widest thing here by 60%. **4×4 is 176 px and it is what the
card already ships**, so it is also the zero-surprise choice for an existing user.
The cost is that the playhead wraps every four steps rather than sweeping — recorded
as a taste call in §14 with its one-line revert.

---

## 7. RESTING TEXT — THE KEY-CAP RULING, WHICH IS THE HARD CASE

`face-resting-text-source.test.ts:44-52` enumerates the permitted roles, and the
gate denies the SHAPE rather than any mechanism:

> * the module NAME — painted once, by the dock title bar.
> * TAB / SECTION labels — the rail and the band headers.
> * **CONTROL CAPTIONS — the name of the control, not its value.**
> * **OPTION / LANDMARK NAMES — a word that disambiguates a control's own position**
>   (`TRI`, `WET`), compact, under the control. A NUMBER there is a different
>   offence, owned by `face-readout-source`.
>
> Anything else — a value, a derived quantity, a state word, a measurement, a
> sentence — is denied at rest.

⚠ **AND THE GATE IS STRUCTURALLY BLIND TO BOTH OF THIS FACE'S PANELS.** It states its
own blind spot: text drawn inside a bespoke component is invisible to it. So every
ruling below is a ruling *I* am making against the owner's stated words, and only the
dock VRT baseline and a human reviewing it can catch a mistake. `KriaGridPanel.svelte:22-30`
took the same position and said so; this section is longer because numpadPlus's case
is genuinely harder than kria's (§4).

**The test I apply, taken from the ruling's own justification** (`knob-vocabulary-model.ts:152-158`
— *"a name disambiguates otherwise-identical states, a number restates the dial"*),
in three questions:

1. Is the text a **quantity** — a measurement, a count, a reading? → DENIED.
2. Does it **restate a position** the control already shows? → DENIED.
3. Is it the **NAME** of a state, drawn from a roster whose members have canonical
   names, and is it the only thing distinguishing otherwise-identical controls? →
   PERMITTED, as an option name.

### The verdicts

| card text | face | which question decided it |
|---|---|---|
| `NUMPAD+` title | kept (dock title bar) | module NAME |
| band labels `pattern`/`record`/`transport`/`keypad` | kept | SECTION labels |
| `Oct` / `BPM` / `Lyr` captions | kept | CONTROL CAPTIONS |
| **`{pget('octave', 4)}` — the octave NUMBER** (`:218`) | ⚠ **REMOVED as a number, RESTORED as `c0…c8`** | Q1: it is a quantity. Restored via §6.3's roster because `c4` is the octave's NAME, not a reading of it |
| **the step cell's note name** (`:117-122`) | ⚠ **KEPT — see below** | Q3 |
| **a key cap's NOTE** (`:306`) | **KEPT** | Q3 — CONTROL CAPTION |
| **a key cap's BOUND KEY** (`:305`) | **KEPT — see below** | Q3 — OPTION NAME |
| `▶ PLAY` / `■ STOP` text on the toggle (`:246`) | **REMOVED as text** — the toggle's own on/off state carries it | Q2: it restates the control's position |
| `◉ REC` vs `ARM` (`:256`) | **REMOVED as text** — same | Q2 |
| the `title=` tooltips (`:255`, `:263`, `:272`) | **REMOVED** — they are prose | denied sentence; the prose is already in `docs.controls` (`:337-340`) where right-click Annotate reads it |
| **the `.hint` block** (`:332-336`) — *"Mapped keys captured globally … Layers used: 4 · steps/layer: 16"* | ⚠ **REMOVED** | a sentence AND two counts. It restates `NUMPAD_PLUS_LAYERS`/`NUMPAD_PLUS_STEPS`, which the grid already shows by being 4×4 |
| the remap hint *"Press any key to map it to C · Esc to cancel"* (`:326-330`) | **KEPT** | ⚠ see the transient carve-out below |

### ⚠ THE STEP CELL PAINTS ITS NOTE. Ruling, with the argument.

kria's grid paints no text and loses nothing, because kria's note is POSITIONAL
(§4). numpadPlus's is not: `NoteStep.midi` is an absolute MIDI int and the grid has
one row per step, so **there is no position that encodes the pitch**. Remove the text
and a recorded pattern becomes sixteen indistinguishable lit squares.

Against the three questions: `c#4` is not a quantity (Q1 — it is a pitch NAME, the
same category as `TRI` or `WET`); it restates no dial position, because there is no
dial (Q2); and it is the ONLY thing distinguishing sixteen otherwise-identical cells
(Q3). That is the tidyVco `A/D/S/R` argument and the `sampleHold` ten-scale-names
argument, applied to a roster of pitches.

⚠ **It also survives `looksNumeric`** (`face-readout-source.test.ts:572-574`): the
regex demands a leading `[0-9]+`, and `c#4` starts with `c`. Checked, though that
gate does not reach a panel anyway.

**What is REFUSED inside the same panel**, so the ruling has a boundary rather than
an escape hatch: **no step NUMBER** (1…16 — a count, and the grid's shape already
says where you are), **no playhead index** (the moving highlight is the picture),
**no "REC"/"PLAY" word**, **no bar/beat readout**, **no tick count**. The panel paints
sixteen cells, each lit-or-not, each carrying its pitch name when lit and a `·`
when not — which is what the card already does (`:120`).

⚠ **AND THE ACCESSIBLE NAME MUST GAIN WHAT THE CARD NEVER PUT THERE.** The card's
cell is `aria-label={`Step ${s + 1}`}` (`:286`) — the note is in the painted text and
NOWHERE else. Every spec proving a face tracks its module reads the accessible name,
so the panel's cell name is `step 3 — c#4` / `step 3 — off`, following
`laneCellAriaLabel`'s shape (`kria-types.ts`). **That is an addition, not a
weakening: the note becomes assertable for the first time.**

### ⚠ THE KEY CAP PAINTS BOTH ITS NOTE AND ITS BOUND KEY. Ruling, with the argument.

This is the case the brief flagged as genuinely hard, and it decomposes cleanly once
you notice a cap is ONE CONTROL with a caption and a value:

* **the NOTE (`c#`, or `OCT↑`/`OCT↓`)** is the cap's **CAPTION** — *the name of the
  control, not its value*. It says what this cap IS. Twelve caps are otherwise
  identical; this is the only thing separating them. Permitted, and required.
* **the BOUND KEY (`1`, `Q`, `↑`, `␣`, `F5`)** is the cap's **OPTION NAME** — the
  member of the physical-key roster currently selected.

The second one is where a careless reading goes wrong in either direction, so here
is the test applied explicitly:

* **Is it a quantity?** No. `physLabelFor` (`NumpadPlusCard.svelte:164-168`) returns
  `keyCodeLabel(code)` (`numpad-plus.ts:119-136`), which maps `NumpadDivide → /`,
  `KeyQ → Q`, `Space → ␣`, `ArrowUp → ↑`. **These are ENGRAVINGS.** `1` is what is
  printed on the physical key in front of the player. It is not a count of anything
  and it cannot be more or less.
* **Does it restate a position?** No. There is no dial, no continuum, no travel. The
  roster is ~100 discrete named members with no order.
* **Is it a NAME that disambiguates?** Yes, and it is the ONLY feedback the remapping
  feature has. Remove it and remapping becomes write-only — you could bind a key and
  never learn which one you bound. That is a functional-parity break, and *"we would
  lose X"* is never an owner choice.

**Verdict: it paints.** It is the `paintsReadout` carve-out exactly — a declared
option NAME, no `format` — reached by a panel rather than by a knob.

⚠ **The uncomfortable half, stated rather than glossed:** for the ten default numpad
bindings the engraving IS a digit (`1`…`9`, `0`), so a cap paints the character `7`.
A reader scanning the plate could mistake that for a value. I am ruling it permitted
because **the identity of the text is what matters, not its glyph shape**: `7` here
is the proper noun of a key, exactly as `24` is the proper noun of a clock division
in `cvBuddy.ppqn`'s exemption (*"there is no name for the state that is not the
integer"*, `face-readout-source.test.ts` cvBuddy entry). The mock draws it small,
monospaced and inside a key-shaped box, so it reads as a legend rather than a
readout. **If the owner disagrees, the fix is not to delete it — it is to draw the
cap as a keycap glyph, and §14 carries that revert.**

### The transient carve-out

The remap hint (*"press any key to map it to c# · esc to cancel"*) is **instructional
copy in a transient MODE**, not resting text — the same class as `midiclock`'s
pre-connect hint and its access-failure message, both of which wave 4 kept. It is
empty at rest (§6.2 requires that for the probe), and it only has content while the
panel is actively listening. **The RESTING faceplate paints nothing from it.**

### ⚠ DELETING A READOUT DELETES A FINDING — here is the one

The card's `.hint` block prints `Layers used: {NUMPAD_PLUS_LAYERS} · steps/layer:
{NUMPAD_PLUS_STEPS}` (`:335`). That is the only surface anywhere that states the
module's dimensions, and it is being removed.

**It loses nothing, and saying why is the point.** Those two numbers are structural
constants (`numpad-plus.ts:75-76`), not derived state — the 4×4 grid IS the
statement, and the `l1…l4` roster IS the layer count. The prose that *is* worth
keeping (*"Mapped keys captured globally while this card exists"*) is already in
`docs.explanation` (`:313`, last sentence) where right-click Annotate reads it. **No
`<mod>-face-model.test.ts` arithmetic loses its surface here** — unlike kick drum's
TAIL or resofilter's mode collapse, there was never a derivation behind these.

---

## 8. WHAT THE LANE TILE SHOWS AT 1/8th THE SIZE

The lane tile is a fixed **192 × 180** box. `laneRenderKind`
(`legacy-fallback.ts:140-144`) returns `'shell'` for a migrated type under the
default shell and `'legacy'` under `?shell=legacy`.

**The picture question is settled by §5: there is none.** `laneGlyphFor` returns
`'none'`, so `hasGlyph` is false, so `faceTierCap` gives compact `LANE_ROW_MAX_CELLS
= 3` rather than the with-glyph `2` (`module-shell-model.ts:366-368`). **The tile IS
its controls.**

`laneOrder(face)` (`curated-face.ts:131-143`) drops exactly `face.hero.cell` and each
`xyPads[].x`. numpadPlus declares a hero cell and no pads, so the lane roster is the
eight remaining keys:

```
activeLayer · recArm · isPlaying · overdub · octave · bpm · poly · numpad-key-{n}
```

| tier | cap | what paints |
|---|---|---|
| **mini** | 1 | `activeLayer` — a 4-position knob (`paramCellKind` returns `'knob'` at any non-dock tier, `shell-control-kind.ts:313`) with `l1…l4` in its name readout |
| **compact** | 3 | `activeLayer`, `recArm`, `isPlaying` |
| **full** (3×2 plate) | 6 | + `overdub`, `octave`, `bpm` |
| **dock** | ∞ | everything, hero first |

**`poly` (index 7) and `numpad-key-{n}` (index 8) never reach a lane tier**, which
is what satisfies `panelTierProblems` (`module-face-lint.test.ts:1857-1874`) for the
keymap panel without a hero promotion. **`numpad-cell-{n}` never reaches one either,
by PF-22.**

⚠ **Two things a reviewer should check rather than take on trust**, both in §15:

* **M2** — `activeLayer` as a 4-position lane knob. `faces-parity` drags every knob
  and asserts the drag commits a param change; `moog962` failed exactly that with a
  2-position dial. Four detents over the full travel should clear it, but *should* is
  not a measurement.
* **M7** — the tile at mini shows ONE knob and nothing else. On a module named
  "numpad+" that is a thin tile, and the honest alternative (a lane picture) is
  refused in §5 for platform reasons rather than design ones. **Worth the owner
  seeing the mock** (`lane-tile.html`) rather than discovering it after merge.

---

## 9. WHERE THE STATE LIVES — `params` vs `node.data`, AND THE SEAM THIS PR BUILDS

**Both, and the split is the defect surface** (§0.1, §0.4).

| write | site | shape | seen by `mutate.guard`? |
|---|---|---|---|
| `setNodeParam(id, k, v)` | `NumpadPlusCard.svelte:49` | ✓ tagged, undoable | n/a (the sanctioned seam) |
| `live.params.octave = …` | `numpad-plus.ts:427-432` | raw `.params` write | **YES** — and **LEDGERED**: `raw-write-ledger.ts:109-113`, `kind: 'sanctioned'`, *"hardware-surface → store reflect"* |
| `live.params.recArm = 0` | `numpad-plus.ts:530-535` | raw `.params` write | **YES** — same ledger entry |
| `d.layers = …` | `NumpadPlusCard.svelte:79-86` | `transact`, **NO ORIGIN** | **NO** |
| `t.data.keymap = …` | `NumpadPlusCard.svelte:143-146` | `transact`, **NO ORIGIN** | **NO** |
| `data.layers = …` | `numpad-plus.ts:438-461` | bare proxy write | **NO** |
| `layers[i] = defaultLayer()` | `numpad-plus.ts:462-471` | bare proxy write, **destructive** | **NO** |

**The `.params` half is exemplary.** Someone read the rule, decided those two engine
writes should not enter the user's undo stack, and wrote the ledger entry with the
reason. **The `.data` half — which is the entire instrument — is invisible to every
gate in the repo**, and that asymmetry inside ONE MODULE is the sharpest version of
wave 3/4's finding this program has produced.

### THE FIX IN THIS PR — one new file, following the shipped kria template

`packages/web/src/lib/audio/modules/numpad-plus-writes.ts` — **the one write seam**,
built exactly like `kria-writes.ts` and for the two reasons its header states
(`:14-36`):

```ts
import { mutateNode } from '$lib/graph/mutate';   // defaults to LOCAL_ORIGIN

export function setNumpadStep(nodeId, layer, step, next: NoteStep): void
export function clearNumpadLayer(nodeId, layer): void
export function setNumpadKeymap(nodeId, next: Record<string, number>): void
```

Three surfaces call it — the legacy card, the two face panels, and the factory —
which makes *"the recorded write and the clicked write take the same path"* a
property of the code rather than a thing to re-verify.

⚠ **(2) IS AS IMPORTANT AS (1), AND IT IS EASY TO SKIP.** kria's second named defect
is *"ONE CELL CLICK REWROTE THE WHOLE PATTERN … in a multiplayer product that is not
merely wasteful: two collaborators editing DIFFERENT TRACKS of the same pattern
overwrote each other, because last-writer-wins applied to the whole object."*

**numpadPlus does exactly this, three times over:**

* `NumpadPlusCard.svelte:85` — `d.layers = cur.map((l) => l.map((s) => ({ ...s })))`
  rewrites **all 4 layers × 16 steps** on every single cell click;
* `numpad-plus.ts:460` — the identical line, **on every recorded keypress**, i.e. at
  performance rate while OVERDUB is on;
* `numpad-plus.ts:470` — the identical line in `clearLayer`.

So two collaborators recording into DIFFERENT layers of the same node overwrite each
other, and the loser's take vanishes. **The write must become granular**, which
kria's header proves is possible against a real SyncedStore (`:39-56`: a nested step
lane is a live Y.Array, so `arr[i] = v` throws but `arr.splice(i, 1, v)` works and
persists, and a per-track scalar assigns fine). **M5 in §15 re-measures that against
numpadPlus's own `layers` shape rather than assuming kria's transfers** — the shapes
differ (kria stores parallel lane arrays; numpadPlus stores an array of objects).

⚠ **DO NOT tag the FACTORY's recording write `LOCAL_ORIGIN` without deciding it.**
A recorded keypress arriving 8 times a second would storm the UndoManager — the #719
class `raw-write-ledger.ts:116-120` names for livecode. **The recommendation:**
`setNumpadStep` takes an explicit origin; the card and the panels pass the default
(`LOCAL_ORIGIN`, undoable), and the factory's live-recording write passes a
non-tracked origin **with a `.data`-side reason written on the call site**. That is
the `origin`-as-an-axis design `mutate.ts:60-67` describes, used as designed.

⚠ **`clearLayer` IS DIFFERENT AND MUST BE UNDOABLE.** It is not a stream of
performance events — it is one destructive act, triggered by one user gesture
(pressing PLAY with ARM lit), that erases sixteen steps. It gets `LOCAL_ORIGIN`.

**The platform question — whether `.data` gets an origin-tagged seam and a ledger of
its own — is an owner-facing decision and this spec does not assume it lands.** The
module-level fix above is complete without it.

---

## 10. THE #2166 CLASS — THREE SPECS GO **GREEN AND BLIND**, NONE GOES RED

CLAUDE.md: *"when a fix removes a condition, the gates that depended on it do not
merely go red — some go green and blind, and a green-and-blind gate will certify the
next bug in that area."*

**numpadPlus is not in `_face-fixtures.ts`'s `DENIED` map** (`:67-113`) and is not in
`LEGACY_DOCK_CANDIDATES` (`workflow-rear-card.spec.ts:738` =
`['moog956','moog960','cartesian']`), so it inherits neither repaired hazard. It is
also not the derived audio fixture pick: `_face-fixtures.ts`'s audio predicate
requires the card to mount a **Fader**, and `NumpadPlusCard.svelte:20` imports `Knob`
and no fader.

**But three shipped specs use numpadPlus's LEGACY CARD as a fixture, and every one of
them boots `?shell=legacy`.**

`legacy-fallback.ts:140-144` returns `'legacy'` whenever `!shellFaces`, **before it
ever looks at `migrated`**. So on `?shell=legacy` a promoted numpadPlus still renders
`NumpadPlusCard`, and:

| spec | what it does | after promotion |
|---|---|---|
| `numpad-plus.spec.ts` (13 tests) | `page.goto('/rack?shell=legacy&seed=none')` at `:24`, then card testids throughout | **STAYS GREEN. And stops testing the product.** |
| `menu-viewport-clamp.spec.ts:196-206` | *"numpad key remap menu opens fully in view at the bottom-right corner"* — `gotoClassic` = `?shell=legacy` (`:67-68`), then `.svelte-flow__node[data-id="n1"] [data-testid="numpad-key-11"]` | **STAYS GREEN.** Its subject — a portaled menu escaping SvelteFlow's transform — moves to the panel, and the panel is never exercised. |
| `clipplayer-card-parity.spec.ts:180-203` | *"an unfocused clip-player does NOT starve a co-present NUMPAD+ of computer keys"* — asserts `getByTestId('numpad-plus-card')` visible, then drives real keys | **STAYS GREEN**, and here that is CORRECT (see below). |

⚠ **THE DOCK FULL VIEW IS NOT PROTECTED BY `?shell=legacy`, AND THAT IS THE ASYMMETRY
TO CARRY.** `Canvas.svelte:9282` passes `migrated={migrated(fv.node.type)}` to
`DockFullView` with **no `shellFaces` term**, while the lane derivation at `:2455-2459`
takes both. So after promotion, `?shell=legacy` gives you the legacy CARD in the lane
and the FACEPLATE in the dock — which is exactly the surface these specs never open.

**The instruction, per CLAUDE.md: fix the SUBJECT, and say which in the PR body.**

1. **`numpad-plus.spec.ts` — SPLIT, do not re-point wholesale.** Its 13 tests fall
   into two kinds and they deserve opposite treatment:
   * **engine-truth tests** (`:180` pitch reaches SCOPE, `:250` OVERDUB writes step 0,
     `:298` layer CV wins, `:353`/`:369`/`:411` poly capture) drive `document`
     KeyboardEvents and read `__patch`/`__engine`. **They are surface-independent and
     should MOVE OFF `?shell=legacy` entirely** — they never needed the card. That is
     a strict improvement: they would then cover the shipping default.
   * **card-UI tests** (`:75` octave arrows, `:84` layer button, `:94` remap flow,
     `:131`/`:149` octave keys, `:169` the portal) are testing controls that move to
     the face. **Re-point them at the faceplate**, and keep `?shell=legacy` only where
     the spec is deliberately about the legacy card.
2. **`menu-viewport-clamp.spec.ts:196` — RE-POINT at the panel's menu**, opened from
   the dock faceplate, panned to the corner. The `use:portal` + `use:clampMenu`
   machinery (`NumpadPlusCard.svelte:341-357`) moves into the panel verbatim, so the
   subject survives; only the host changes. ⚠ **Leaving it on `?shell=legacy` would
   pin the OLD host as correct** — the exact "gate pinning the wasted space" shape.
3. **`clipplayer-card-parity.spec.ts:180` — LEAVE IT, and say why in the PR body.**
   Its subject is that an unfocused clip-player does not steal keys from a co-present
   numpadPlus, and numpadPlus's key capture is in the FACTORY (§0.2), so the test is
   about the ENGINE and the card is only how it locates the node. It would be
   strictly better on the default shell, but it is not blind: it drives real keys and
   asserts `node.data.layers`. **Re-pointing it is a nice-to-have, not a correction.**
   ⚠ It DOES break on one line — `:186` asserts `numpad-plus-card` is visible — only
   if the spec is moved off `?shell=legacy`. On `?shell=legacy` it is untouched.
4. **`io-spec-consistency.spec.ts:537`** mentions `NUMPAD+` only in a comment about
   punctuation in `mod.label`; it sweeps every card generically. **Untouched.**

**Per-module sweeps keep their entries, and each stays true:**

* `_per-module-per-port-shared.ts:261` — `EXEMPT_OUTPUT_EMIT_MODULES: numpadPlus:
  'driver page.evaluate hangs under CI load (8 outputs × 20s exceeds budget)'`. ⚠ The
  reason says **8 outputs**; the def declares **NINE** (`poly` was added later). The
  entry is still correct in substance and now understates its own cost — **fix the
  number in this PR**, it is a one-word edit next to work already being done.
* `_per-module-per-port-shared.ts:542` — `PINNED_MODULE_EXEMPT_KEYS`. Unchanged.
* `per-module-per-port-behavioral.spec.ts:127` — *"requires keypress on numpad;
  covered by numpad-related specs"*. Unchanged and still true.
* `_per-port-drivers.ts:684-698` — a REAL driver (seeds all four layers at midi 72
  and starts the sequencer). Unchanged; it drives `node.data` and params, not the
  card.

---

## 11. VRT — THE EXEMPTION'S STATED REASON IS **FALSE ON A FRESH SPAWN**

`vrt-exemptions.ts:831-834`:

```
// NUMPAD+ — card has a current-step highlight box + REC ARM pulse
// animation that animates whether the sequence is running or not.
// Functional coverage via the e2e spec; pinning baselines pending.
numpadPlus: 'live step-highlight box + REC ARM animation defeat deterministic capture; unit + E2E provide coverage',
```

with `ALLOWED_PERMANENT_EXEMPT` membership at `:1179`.

**Both named animations are gated on params that DEFAULT TO 0.** Measured against the
card source:

| animation | gate | value on a fresh spawn |
|---|---|---|
| the step-highlight box (`.cell.active`, `:473-476`) | `isActiveStep(s)` = `stepIdx === stepIndexLive && pget('isPlaying', 0) >= 0.5` (`:123-125`) | `isPlaying` defaults to **0** (`numpad-plus.ts:301`) ⇒ **never true** |
| the REC ARM pulse (`.rec-btn.armed`, `:443`) | `class:armed={armedLive}` ← `engine.read(node,'armedRecording')` (`:64-65`) | `armedRecording` is set only at the play-from-start edge with `recArm` high (`numpad-plus.ts:557-560`); both default to **0** ⇒ **false** |
| the REC ARM colour (`.rec-btn.on`, `:442`) | `recArm >= 0.5` | defaults to **0** |

⚠ **So the sentence "animates whether the sequence is running or not" is simply
wrong**, and it has been wrong for as long as the entry has existed. A fresh
numpadPlus is static. This is the same class as wave 4's midiclock finding — an
exemption whose exit condition was already satisfied and nobody re-measured — and it
is the exact shape kria relied on to ship its scenes with no freeze seam at all
(`_shell-faces.ts:3125-3131`: *"`running` defaults to 0 … so a fresh spawn is
STOPPED. The playhead — the one live thing on this face … never starts, so no freeze
seam is needed and none is declared"*).

**Disposition — THE FACE PR DISCHARGES THE EXEMPTION.**

* Delete `numpadPlus` from `EXEMPT_FROM_VRT` **and** from `ALLOWED_PERMANENT_EXEMPT`.
  `vrt-meta.test.ts` asserts the two sets equal in both directions, so a one-sided
  delete is RED, and `ALLOWED_PERMANENT_EXEMPT`'s own header says *"the set only ever
  SHRINKS BY NAME"* (`:1137`) with `cvBuddy`'s 2026-08-20 removal as the shipped
  precedent (`:1163-1165`).
* Add `{ type: 'numpadPlus', pages: 4 }` to the `FACES` roster
  (`e2e/vrt/_shell-faces.ts:34+`) — **hand-maintained, nothing ties it to
  `STRICT_FACES`, and a promoted module missing from it silently has no VRT scene.**
  `pages: 4` is the POST-hero-split band count (§6.5; no band is emptied).

**Predicted baselines: THREE added, ZERO moved.**

| file | why |
|---|---|
| `e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/face-numpadPlus-compact.png` | the lane tile |
| `e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/face-numpadPlus-dock.png` | the dock faceplate |
| `e2e/vrt/__screenshots__/vrt.spec.ts/numpadPlus.png` | the LEGACY CARD — `vrt.spec.ts:53` filters on `EXEMPT_FROM_VRT` and `:86` boots `?shell=legacy`, so the card scene appears the moment the exemption is deleted, and it survives promotion |

`find e2e -iname '*numpad*'` returns only `e2e/tests/numpad-plus.spec.ts` today — **no
PNG exists**, so nothing can be stale and nothing needs `git rm`. **Dispatch scoped
(`GREP=numpadPlus flox activate -- task vrt:commit`), predict THREE, and count what
the bot commits.** A green dispatch that commits nothing is a RED FLAG.

⚠ **If a scene proves non-deterministic in the capture, THERE IS A NAMED PLACE TO SAY
SO, AND IT IS NOT THE OLD SENTENCE.** Two different mechanisms, for two different
surfaces, and they must not be confused:

* the **CARD** scene → `EXEMPT_FROM_VRT` + `ALLOWED_PERMANENT_EXEMPT`. If it must
  stay, **rewrite the reason with what actually moved** — do not restore a sentence
  this section has just refuted.
* a **FACE** scene → `FACES_WITHOUT_SCENES` (`e2e/vrt/_shell-faces.ts:3372`), a
  typed, deny-by-default record requiring a `why` that is *"an ARGUMENT WITH THE
  MEASUREMENT IN IT, not a label"* (`:3329-3335` — *"'It's animated' is not
  sufficient"*) plus a `coveredBy` list of paths asserted to EXIST. `acidwarp` is its
  worked example. **A promoted face with no roster entry and no record here is RED**,
  so the debt cannot go quiet.

Either way, **the sentence must name what MOVED and by how much.** A stale exemption
reason is what produced this section.

⚠ **`vrt-strict` cost.** Promoting adds two `vrt-strict` scenes plus one card scene,
and an unmeasured scene rides the MEDIAN — which reddened `main` twice in one day
(2026-08-23). **Re-pin BOTH cost artifacts** on the absorb-main:
`task e2e:timings:accept` and `task vrt:strict:timings:accept`.

---

## 12. COST

### 12.1 WEBGL ATTEST — **ZERO. MEASURED.**

```
$ flox activate -- bash scripts/webgl-attest-hash.sh --list | grep -i numpad
  (no output)

$ flox activate -- bash scripts/webgl-attest-hash.sh --list | grep 'audio/modules'
  packages/web/src/lib/audio/modules/cube.ts
  packages/web/src/lib/audio/modules/wavesculpt.ts
```

The basis contains exactly two files under `audio/modules/` and neither is
`numpad-plus.ts`. No `NumpadPlusCard` either. **So even the real code changes in
this PR — a new write module, a new `ParamDef` roster, two new panel components —
cost NOTHING.** Contrast wave 4's `picturebox`, where the identical class of edit
costs a GPU window; the difference is the DIRECTORY, not the change.

⚠ **And keep it that way: both panels are DOM, not canvas** (§6.2). A WebGL surface
would enrol the module in the basis and make every future edit here cost a real-GPU
re-attest — `KriaGridPanel.svelte:35-38` names that trade and declines it.

### 12.2 ART — ZERO FOR THIS PR

`numpadPlus` is in **`ART_BACKLOG`** (`art/setup/profile-coverage.ts:107`), not
`ART_EXCLUDED`. That means it has no committed profile and owes one — but a face PR
touches no DSP, changes no output arithmetic and moves no baseline, so **`art/` should
be absent from this diff**. The backlog entry stays exactly where it is.

⚠ **One thing to confirm rather than assume**: §6.3 adds `options` rosters to two
params. `options` is COSMETIC vocabulary — `paramCellKind` reads it and nothing in
the factory does — so no rendered sample can move. **If `task art` is run at all,
confirm no `numpadPlus` entry appears rather than assuming the exclusion covers it.**

### 12.3 CI WALL-TIME

New: three VRT captures (dispatched, not in the PR's own run), one unit file
(`numpadPlus-face-model.test.ts`), one write-seam unit file
(`numpad-plus-writes.test.ts`), `numpad-plus.spec.ts` split/re-pointed in place, and
`faces-parity` auto-enrolling **nine cells**. `faces-parity.spec.ts:78-83` budgets CI
at roughly `10 s + 0.8 s/cell` ⇒ **~17 s** for this module. **Estimated total delta
comfortably under 2 minutes.**

### 12.4 CONTRACT — **ONE LINE**

`contract-lock.txt:2375-2394` currently carries 20 numpadPlus lines: 1 meta, 2 in,
9 out, 7 param, 1 family.

**After this PR: 21.** The only addition is

```
numpadPlus family numpad-key kind=other prefix=numpad-key
```

Everything else is contract-transparent, **verified rather than assumed**:

* `face` in all its forms (order, hero, pages, glyph, paramCells) — `FACE_FIELDS_IN_LOCK`
  is empty;
* **`options` rosters are NOT projected.** Checked against two live counter-examples:
  `scope param mode 0..1 discrete default=0` (`contract-lock.txt:2793` — scope's
  `mode` carries a roster, per its `ACKNOWLEDGED_LATCHING` entry) and
  `cvBuddy param ppqn 1..48 discrete default=24` (`:783` — seven options plus
  `optionsExhaustive`). Neither line shows a roster.

So `task docs:accept` produces a **one-line diff**. Anything else, stop.

⚠ **Plus one `docs.controls` entry** for the new family — `numpad-key-{n}` — required
by STRICT_DOCS completeness (numpadPlus is already in `STRICT_DOCS`,
`strict-docs.ts:206`).

### 12.5 ⚠ THE PUSH 2 CARD MOVES — GENERIC → FACE

`push-card-config.ts:20-33`: three tiers, first match wins. numpadPlus has **no**
`PUSH_CARD_CONTROLS` entry, so it resolves GENERIC today and FACE after.

**Predicted before** (GENERIC = declaration order with plain on/off switches demoted
to the end):

```
bpm · activeLayer · octave · isPlaying · recArm · overdub · poly
```

**Predicted after** (FACE = `curatedFace(def, 'dock')` — *"the tier that resolves
EVERY ranked key"*, `push-card-schema.ts:179-181` — walked in order, non-params
SKIPPED into `spec.skipped`, `:28-32`):

```
activeLayer · recArm · isPlaying · overdub · octave · bpm · poly
skipped: ['numpad-cell-{n}', 'numpad-key-{n}']
```

⚠ **BOTH families land in `skipped`, not just the hero.** The walk breaks only at
`picked.length >= PUSH_CARD_SLOTS = 8` (`:186`) and this face yields seven, so it
reaches the ninth key and skips it too. **Expect two entries in the golden, not one**
— a one-entry expectation would read as a missing key rather than as a full walk.

**Same seven params, different order.** `isTurnable` (`push-card-schema.ts:106-108`)
is only `max > min`, so a toggle IS turnable and the FACE tier does **not** demote
switches the way GENERIC does (`genericControls`, `:232-234`, partitions
`continuous` before `switches`; `faceControls` has no such partition).

⚠ **THE RESULT IS WORSE ON HARDWARE, AND THAT IS A REAL FINDING ABOUT THE TIER
RATHER THAN ABOUT THIS MODULE.** The FACE tier reproduces on eight encoders a ranking
designed for a screen. numpadPlus ranks four on/off switches high (correctly — they
are what a player reaches for), so the face card puts **three two-position encoders
in strips 2–4** and buries BPM — the one genuinely continuous control — at strip 6.
The GENERIC tier demotes switches for exactly this reason (`push-card-config.ts:29-31`:
*"a two-state switch is a poor use of a bar graph"*) and the FACE tier does not.

**Recommendation: pin it with an explicit override**, which is sanctioned, cannot
drift, and needs no platform change:

```ts
numpadPlus: ['bpm', 'activeLayer', 'octave', 'recArm', 'overdub', 'poly', 'isPlaying'],
```

`push-card-schema.test.ts` is a MUST-RUN either way, and the golden diff must be
accepted deliberately with the reason written down.

**Also newly reachable, from the two rosters alone** — say so, a reviewer should not
have to derive it: `activeLayer` and `octave` become MIDI-learnable, group-exposable
(`group-controls.ts`) and clip-automatable as NAMED states rather than as bare
integers.

---

## 13. DEFECT LEDGER — LIVE ON `main`, INDEPENDENT OF ANY FACE

Per CLAUDE.md, nobody opens issues: a bug found while doing planned work is fixed
inside that work's PR. The `routing` column is the instruction to the build agent.

| # | defect | evidence | routing |
|---|---|---|---|
| **D1** | ⚠ **ARM + PLAY ERASES A LAYER AND Cmd-Z CANNOT UNDO IT.** `tick()`'s play-from-start branch calls `clearLayer(activeLayerIndex())`, which overwrites sixteen steps through a bare SyncedStore proxy write — no `transact`, no `LOCAL_ORIGIN`. `mutate.guard` cannot see it (its regex anchors on `.params`). Data loss on the module's headline workflow. | `numpad-plus.ts:557-563`, `:462-471`; `mutate.ts:13-18`; `store.ts:70`; `mutate.guard.test.ts:42-48,88-98` | **fix in this PR** — §9 |
| **D2** | ⚠ **EVERY STEP EDIT AND EVERY REMAP IS OUTSIDE Cmd-Z — via a `transact` WITH NO ORIGIN.** `setStep` and `writeKeymap` both open a transaction and both omit the origin argument, so the UndoManager never captures them. Three lines away, `setNodeParam` is correctly tagged — so the BPM knob is undoable and the sequence is not. **This is the `kria` defect verbatim**, on a module `kria-writes.ts` does not cover. | `NumpadPlusCard.svelte:76-87` (`:79`), `:140-147` (`:143`), vs `:49`; `kria-writes.ts:16-27` | **fix in this PR** — §9 |
| **D3** | ⚠ **ONE CELL CLICK REWRITES ALL FOUR LAYERS — AND SO DOES EVERY RECORDED KEYPRESS.** Three sites deep-clone and reassign the whole `4 × 16` structure. In a multiplayer rack, two collaborators recording into DIFFERENT layers of the same node overwrite each other by last-writer-wins. During OVERDUB this fires at performance rate. **kria's second named defect, verbatim.** | `NumpadPlusCard.svelte:85`; `numpad-plus.ts:460`, `:470`; `kria-writes.ts:28-36` | **fix in this PR** — §9, M5 |
| **D4** | ⚠ **A DOCUMENTED AFFORDANCE THAT DOES NOT EXIST.** The def's own `docs.controls['numpad-cell-{n}']` says *"click-and-dragging up/down on the cell changes its note by hand"*, and the card's header comment says *"click toggles step on/off; click+drag changes the note"*. **The cell has `onclick` and nothing else** — no pointer, drag or wheel handler anywhere. So the ONLY way to set a step's pitch is to record it from the keypad, and `toggleStep` gives a freshly-lit step the octave's C regardless. `module-docs-lint` reads the DEF, so it is structurally blind to a card that does not implement what the def promises. | `numpad-plus.ts:341-342`; `NumpadPlusCard.svelte:13-14`, `:277-289` (`:284` is the only handler), `:88-92` | **fix in this PR** — the panel implements drag-to-change-note, which is what makes the grid a *picture-you-edit* rather than a picture-you-toggle. ⚠ The PR body must say the affordance was **added, not restored** |
| **D5** | ⚠ **AT OCTAVE 8, ELEVEN OF THE TWELVE KEYS RECORD A STEP THE UI CANNOT NAME.** `midiForKey` returns `(octave+1)*12 + semitone`, so octave 8 spans MIDI 108–119; `noteNameForMidi` returns `''` above `MAX_MIDI = 108`, and `cellLabel`'s `|| '?'` fallback paints **`?`**. The pitch output is correct — only the name fails. | `numpad-plus.ts:186`; `note-entry.ts:23-24`, `:109-116`; `NumpadPlusCard.svelte:121` | **fix in this PR** — export ONE `numpadNoteName(midi)` from the def (the backdraft one-place rule), used by the card AND both panels AND the accessible names; unit-test at 12 / 60 / 108 / 119. **Do not change the octave range** — that is a behaviour change to saved patches |
| **D6** | **THE CV LAYER SELECTOR'S BUCKETS ARE UNEQUAL BY 3×.** `resolveActiveLayer` is `round(cv * 4)` clamped to `0..3`, so L1 occupies cv `[0, 0.125)` (width 0.125) while L4 occupies `[0.625, 1.0]` (width 0.375). A player sweeping an LFO through the layer input spends three times as long on L4 as on L1. | `numpad-plus.ts:264-273`; e2e at `numpad-plus.spec.ts:299` pins `round(0.75×4)=3` | ⚠ **NOT this PR.** Fixing it changes which layer every saved patch's CV selects — an owner-preview behaviour change. Recorded so it is not lost |
| **D7** | **A BIPOLAR PORT WHOSE NEGATIVE HALF IS DEAD, AND THE FILE CONTRADICTS ITSELF ABOUT IT.** `numpad-plus.ts:53` says *"layer (cv): **bipolar** CV selecting the active layer"*; `:22-23` and `docs.inputs.layer` (`:316-317`) both say `0..1`; `cv-scale-registry.test.ts:165-166` says `0..1`. The implementation is `0..1` — any negative value rounds ≤ 0 and clamps to L1. | `numpad-plus.ts:53` vs `:22-23`, `:316-317`; `cv-scale-registry.test.ts:165-166` | **fix in this PR** — correct the one wrong comment. Free: comments are stripped from every attest basis by `attest-code-basis.ts` |
| **D8** | **A SHIPPED COMMENT BLAMES THE CARD FOR SOMETHING THE FACTORY DOES.** `interactive-doc-modules.ts:154-156` excludes numpadPlus from the live doc-card allowlist because *"NUMPAD+'s card installs a document-level capturing keydown listener"*, echoed at `strict-docs.ts:193-195` and `docs-virtual-module.spec.ts:411`. **The card does not.** The listener is in the FACTORY (`numpad-plus.ts:604-683`), which the *engine-less* doc sandbox never runs; the card's only document listener is the conditional remap capture. By the allowlist's own stated criteria (*"a playhead-polling requestAnimationFrame is fine — the engine-less doc sandbox just no-ops the read"*), numpadPlus's 33 ms engine poll qualifies. | `interactive-doc-modules.ts:151-156`; `strict-docs.ts:193-195`; `NumpadPlusCard.svelte:57-68`, `:186-198`; `numpad-plus.ts:677-678` | **CORRECT THE COMMENTS in this PR** (prose, next to a claim about this module, and hash-transparent). ⚠ **Do NOT add numpadPlus to `INTERACTIVE_DOC_MODULES`** — that needs a `PROBES` row in `docs-virtual-module.spec.ts` and a verified live run, which is its own work |
| **D9** | **A STALE PORT COUNT IN AN EXEMPTION REASON.** `EXEMPT_OUTPUT_EMIT_MODULES` says *"8 outputs × 20s exceeds budget"*; the def declares **nine** (`poly` landed later), so the entry understates its own cost. | `_per-module-per-port-shared.ts:261`; `numpad-plus.ts:286-298` | **fix in this PR** — one word, in a file the PR already touches |
| **D10** | **THREE STALE PASSAGES IN THE DEF'S OWN HEADER**, each describing a behaviour the code no longer has: `:29-30` *"(+12 with Numpad+ held, -12 with Numpad-)"* (the held modifier is gone — `midiForKey`'s `modifierOctave` is **hardcoded `0`** at the only call site, `:623`, and octave up/down are remappable KEYS now, `:101-109`); `:50-53` *"captures Numpad\* event.codes"* (it captures ANY physical key, `:609-623`); `:55-64` the Outputs and Params lists both **omit `poly`**. `module-manifest.ts:378-379` repeats the first two verbatim to the user. | `numpad-plus.ts:29-30`, `:50-64`, `:623`; `module-manifest.ts:379` | **fix in this PR** — the manifest sentence is user-facing and wrong. ⚠ Note the dead `modifierOctave` parameter is still exercised by `numpad-plus.test.ts:118-126`, so the unit lane keeps a path production cannot reach — **decide: delete the parameter, or keep it and say why** |
| **D11** | **THE `poly` OUTPUT IS NEVER PROVEN TO SOUND.** `numpad-plus.spec.ts:353-367` asserts the poly HANDLE is attached and `:369` asserts the recorded `midis` array — neither patches `poly` into a poly-aware voice. CLAUDE.md's poly rule (*"a per-port 'edge materializes' assertion does NOT count"*) is written about consumers, and numpadPlus is a PRODUCER, so the letter does not bind — **but the failure mode is identical**, and `strict-docs.ts:196-197` explicitly flags this module as POLY whose *"poly output must feed a real poly-aware voice"*. | `numpad-plus.spec.ts:353-409`; `strict-docs.ts:196-198`; `numpad-plus.ts:508-519` | ⚠ **NOT this PR unless it is cheap.** One added test (numpadPlus `poly` → a poly-aware voice → audible RMS) would close it, and the spec is being edited anyway. **Flag the wall-time delta before adding it** |

⚠ **WHAT IS *NOT* A DEFECT, checked and recorded**, because it looks like one:

* **`setParam()` is an empty no-op** (`numpad-plus.ts:701`). That reads like the
  midiclock bug. It is not: the comment says *"tick re-reads from node.params each
  iteration"*, and `tick()` genuinely does (`:547`, `:558`, `:579`, `:634`, `:640`,
  `:651`), so every param IS live. The handle's `readParam` (`:702-706`) reads the
  graph directly. Nothing to fix.
* **`live.params.octave` and `live.params.recArm` raw writes** (`:427-432`, `:534`).
  These ARE ledgered — `raw-write-ledger.ts:109-113`, `kind: 'sanctioned'`, with the
  reason *"hardware-surface → store reflect (the numpad drives the value, the store
  mirrors it)"*. Someone made this decision deliberately and wrote it down. **Leave
  it alone.**
* **The `document` keydown capture with `preventDefault`.** Deliberate, documented
  (`:44-49`), and the subject of a dedicated cross-module e2e
  (`clipplayer-card-parity.spec.ts:180`). Not a bug (§0.5).

---

## 14. TASTE CALLS, EACH WITH ITS ONE-LINE REVERT

| call | revert |
|---|---|
| the step grid is `4 × 4`, not `8 × 2` or `16 × 1` | change the panel's `grid-template-columns` and `minWidth` (176 → 333 → 621). ⚠ 16×1 makes numpadPlus the widest face in the fleet — §6.6 |
| `activeLayer` ranks first in the lane (mini shows it alone) | swap it with `recArm` in `face.order` |
| `octave` options are `c0…c8`, not `0…8` | label them `String(o)` **and add nine `NUMERIC_LABEL_EXEMPTIONS` entries** — which that list's own header forbids doing from a red line |
| the keymap is a SECOND panel, ranked last, rather than folded into the hero grid | move `numpad-key-{n}`'s caps inside `NumpadStepGrid` and drop the family + its `face.order` key. ⚠ Costs the dock ~60 px of permanent vertical space and puts a setup surface on the hero |
| **LEFT-CLICK on a key cap begins the remap** (right-click still offers the menu) | drop the `onclick`; the panel then has no probe-able affordance and cannot be a cell — §6.2 |
| a key cap paints its bound key as text (`1`, `Q`, `↑`) | draw the cap as a keycap GLYPH with the legend inside it — the information survives, the "looks like a readout" objection goes away. ⚠ Deleting it outright is a parity break, not a revert |
| the step cell paints its note name | delete the text and rely on the accessible name — ⚠ that is kria's design on a module where the note is not positional, and it makes a recorded pattern sixteen identical squares (§4) |
| four bands, no tab rail | an owner `FACE_TAB_OPT_IN` instruction, quoted verbatim — §6.5 |
| an explicit `PUSH_CARD_CONTROLS` override | delete the entry; the module falls back to the face ranking, with three toggles under encoders 2–4 — §12.5 |
| the family is `numpad-key` and the card's `numpad-octkey` prefix is unified into it | keep two prefixes and declare two families — two contract lines, and a standing drift hazard |

---

## 15. MUST-VERIFY (before the face is written, or as the first thing written)

* **M1 — D1/D2/D3 are real, and reproduce BEFORE the fix.** Click a step, press
  Cmd-Z, assert `node.data.layers` is unchanged (the defect). Arm + play, assert the
  layer is cleared and Cmd-Z does not restore it. Then fix, and assert both undo.
  **Both numbers go in the commit message.**
* **M2 — the lane knob for `activeLayer` is REACHABLE.** Four detents across the full
  travel. Run `faces-parity --grep numpadPlus` and confirm the drag commits a param
  change; `moog962` failed exactly this clause twice with two detents. ⚠ Do not infer
  it from the option count — drive the control.
* **M3 — the dock cells are what actually render.** Confirm `paramCellKind` returns
  `'segmented'` for `activeLayer` (4 ≤ 6) and `'selector'` for `octave` (9 > 6) at
  the DOCK tier, and `'knob'` for both at a lane tier. ⚠ **Read the resolver
  (`shell-control-kind.ts:303-318`), do not reason from `SEGMENTED_MAX_OPTIONS`.**
* **M4 — a faces-parity pass leaves the KEYMAP UNTOUCHED.** The keymap panel's probe
  arms a listening mode (§6.2). Run the sweep twice in one page and assert
  `node.data.keymap` is byte-identical to the default afterwards. **A test that
  rebinds the fixture it is measuring is the instrument bug this program keeps
  finding.** Make it a permanent leg of `numpadPlus-face-model.test.ts`.
* **M5 — the GRANULAR `.data` write actually persists.** kria measured against a real
  SyncedStore that a nested lane is a live Y.Array (`arr[i] = v` throws;
  `arr.splice(i,1,v)` works) — **but numpadPlus's shape is different** (an array of
  `{on, midi, midis}` objects, not parallel scalar lanes). Re-measure: can a single
  step object be replaced in place? Can `step.on` be set? **Do not assume kria's
  result transfers.**
* **M6 — the plate WIDTH, measured on the live pane.** §6.6's 176 / 208 are derived
  from committed CSS, not from a baseline. Walk every descendant of
  `.faceplate-body` in the dock full view, record `contentW` and `bodyW`, and confirm
  `bodyW - contentW ≤ FACE_WIDTH_SLACK_MAX_PX = 40`. **Ship the measured `minWidth`,
  not the derived one.**
* **M7 — look at the MINI and COMPACT tiles.** One knob at mini, three at compact, no
  picture (§8). That is what the geometry gives; whether it is acceptable on this
  module is a LOOK question and goes to owner preview with `lane-tile.html`.
* **M8 — the VRT card scene is deterministic.** Before predicting three baselines,
  confirm a fresh numpadPlus really is static (§11): spawn, settle, and assert no
  element carries `.cell.active` or `.rec-btn.armed`. ⚠ **Assert it on the ARTIFACT,
  not from the source** — this section's whole finding is that somebody read the
  source once and wrote a sentence. If it moves, route it to the right mechanism
  (`EXEMPT_FROM_VRT` for the card, `FACES_WITHOUT_SCENES` for a face scene) with the
  measurement in the reason.
* **M9 — the migration question does not exist here, and confirm that.** Unlike wave
  4's midiclock, **no value moves between `params` and `data`** in this PR. Adding
  `options` to two existing params changes no stored value. Load a pre-PR fixture
  rack with `data.layers` and `data.keymap` populated and assert both round-trip
  unchanged. **If anything moves, stop — the spec is wrong.**

---

## 16. VERIFICATION GATE — the exact commands, in order

```bash
# 1. the module's own units + the NEW write seam + this face's permanent negative controls
flox activate -- npx vitest run \
  packages/web/src/lib/audio/modules/numpad-plus.test.ts \
  packages/web/src/lib/audio/modules/numpad-plus-writes.test.ts \
  packages/web/src/lib/ui/workflow/numpadPlus-face-model.test.ts

# 2. face lint + the promotion anchor (asserted equal in BOTH directions)
flox activate -- npx vitest run packages/web/src/lib/ui/workflow/module-face-lint.test.ts

# 3. the rulings' source gates. ⚠ #1 matters here — the two NEW rosters (§6.3)
flox activate -- npx vitest run \
  packages/web/src/lib/ui/controls/face-readout-source.test.ts \
  packages/web/src/lib/ui/workflow/face-resting-text-source.test.ts \
  packages/web/src/lib/ui/dock/face-width-source.test.ts

# 4. param vocabulary — ⚠ optionsExhaustive must NOT appear (redundant ⇒ RED, §6.3)
flox activate -- npx vitest run packages/web/src/lib/ui/workflow/param-vocabulary.test.ts

# 5. the cell registries, the packing plan, and the shared-file neighbours
flox activate -- npx vitest run \
  packages/web/src/lib/ui/workflow/shell-cells.test.ts \
  packages/web/src/lib/ui/workflow/dock-row-plan.test.ts \
  packages/web/src/lib/ui/workflow/dock-faceplate-model.test.ts \
  packages/web/src/lib/ui/workflow/curated-face.test.ts \
  packages/web/src/lib/ui/workflow/rear-card-model.test.ts \
  packages/web/src/lib/ui/workflow/face-migration-inventory.test.ts \
  packages/web/src/lib/ui/modules-card-map.test.ts

# 6. the undo seam + its guard — ⚠ the guard is BLIND to .data, so this proves
#    only that nothing REGRESSED on the .params side (§9)
flox activate -- npx vitest run \
  packages/web/src/lib/graph/mutate.guard.test.ts \
  packages/web/src/lib/graph/mutate.test.ts

# 7. docs: the new family needs a docs.controls entry, and D7/D8/D10 edit prose
flox activate -- npx vitest run packages/web/src/lib/docs/module-docs-lint.test.ts
flox activate -- npx vitest run packages/web/src/lib/audio/edge-detect-guard.test.ts

# 8. ⚠ THE NEW PUSH CARD — it moves GENERIC → FACE (§12.5). Read the golden diff.
flox activate -- npx vitest run packages/web/src/lib/control/push2/push-card-schema.test.ts

# 9. the CV/param surface — adding rosters touches more than it looks like
flox activate -- npx vitest run packages/web/src/lib/audio/

# 10. VRT exemption set-equality — a one-sided delete is RED (§11)
flox activate -- npx vitest run packages/web/src/lib/audio/modules/vrt-meta.test.ts

# 11. docs contract — ⚠ EXPECT EXACTLY ONE NEW LINE (§12.4). Read it, then accept.
flox activate -- task docs:accept
flox activate -- git diff packages/web/src/lib/docs/contract-lock.txt
#     Expected: + numpadPlus family numpad-key kind=other prefix=numpad-key
#     Anything else — a param line, an options roster — STOP.

# 12. e2e: the SUBJECT (split, §10), the two fixtures, and the sweeps
flox activate -- task e2e:serve
flox activate -- npx --workspace e2e playwright test faces-parity --grep numpadPlus
flox activate -- task e2e:one -- tests/faceplate-platform.spec.ts
flox activate -- task e2e:one -- numpad-plus
flox activate -- task e2e:one -- menu-viewport-clamp
flox activate -- task e2e:one -- clipplayer-card-parity
flox activate -- task e2e:one -- per-module-per-port
flox activate -- task e2e:one -- e2e/vrt/workflow-shell-faces.spec.ts
flox activate -- task e2e:stop

# 13. typecheck LAST — svelte-check is stricter than vitest
flox activate -- task typecheck

# 14. flake-check everything NEW or seriously CHANGED, 3× (scoped)
REPEAT=3 flox activate -- task e2e:one -- numpad-plus
REPEAT=3 flox activate -- npx --workspace e2e playwright test faces-parity --grep numpadPlus
REPEAT=3 flox activate -- task e2e:one -- menu-viewport-clamp

# 15. VRT: dispatch only, SCOPED. Predict THREE files. COUNT what the bot commits.
#     NEVER commit a PNG by hand.
GREP=numpadPlus flox activate -- task vrt:commit

# 16. ⚠ RE-PIN BOTH COST ARTIFACTS off the newest green run (§11)
flox activate -- task e2e:timings:accept -- <run>
flox activate -- task vrt:strict:timings:accept -- <run>

# 17. attest: NIL (§12.1). Measured, not assumed.
```

---

## 17. VERDICT, RISK, ESTIMATE

**PROMOTE. ONE PR.** No precursor, no platform change, no new seam, no new wired
slot, zero attest, zero ART, one contract line, three VRT baselines added and none
moved, and a permanent VRT exemption discharged on a refuted reason.

**Why this is the wave's best value pick.** It is the only module examined in this
program whose promotion is blocked by *nothing at all* — no missing field on a type
(`matrixMix`), no pinned topbar surface (`midiclock`), no attest window
(`picturebox`), no engine-side roster the cell interface cannot reach. Every rung of
the bespoke-surface ladder it needs is already shipped and already proven by `kria`.
And it arrives carrying **eleven ledger items, five of them fixed inside the PR**,
including a **data-loss bug on the module's headline workflow** (D1) and a
**multiplayer overwrite that fires at performance rate** (D3) — both of which are
verbatim repeats of the two defects the neighbouring module's write seam was built to
close, on a module that seam does not cover.

**RISK: MEDIUM**, and it is concentrated in exactly two places, neither of them the
face:

1. **The `.data` write-seam rewrite (§9).** It touches the recording hot path, the
   collaborative merge behaviour and the undo stack at once. The mitigation is that
   `kria-writes.ts` is a shipped, tested template for precisely this — but **M5 says
   do not assume its measurements transfer**, because the two modules' `layers`
   shapes differ.
2. **The keymap panel's probe (§6.2).** It requires a genuinely new interaction
   (left-click begins a remap) and it arms a listening mode that a sweep could leave
   hot. **M4 is the permanent guard**, and it must be written before the panel is.

Everything else is additive and invisible: two rosters that move no stored value, a
family that was already half-declared in card markup, and a hero promotion that costs
no lane rank.

⚠ **NOT A RISK, and worth stating so nobody spends a round on it:** the keyboard
capture survives promotion untouched, because it lives in the factory and numpadPlus
is in none of the headless-mount sets (§0.2). The obvious worry about this module is
the one that turns out to be free.

**ESTIMATE: ≈ 16 h.**

| | |
|---|---|
| the `.data` write seam + its unit suite (D1/D2/D3) | ≈ 4 h |
| `NumpadStepGrid.svelte` incl. drag-to-change-note (D4) | ≈ 3 h |
| `NumpadKeymapPanel.svelte` incl. the portal + the probe's hint element | ≈ 3 h |
| the def: two rosters, one family, the `face`, `numpadNoteName` (D5), the comment fixes (D7/D10) | ≈ 2 h |
| `numpad-plus.spec.ts` split + `menu-viewport-clamp` re-point (§10) | ≈ 2 h |
| `numpadPlus-face-model.test.ts` + the four `ACKNOWLEDGED_LATCHING` entries | ≈ 1 h |
| the VRT exemption discharge + the roster entry + both cost re-pins | ≈ 1 h |

**Look-affecting, so it goes to OWNER PREVIEW and does NOT auto-merge.** Three
things want a human eye before it lands: the key caps painting their bound keys
(§7 — the one ruling I am least certain of), the mini/compact lane tile (§8/M7), and
the four-band no-rail decision (§6.5), which is the only genuine owner design
question in this spec.
