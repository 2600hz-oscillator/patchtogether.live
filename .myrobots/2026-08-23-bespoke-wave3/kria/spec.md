# FACEPLATE BUILD SPEC — `kria` (audio, the 4-track grid step-sequencer)

**SPEC ONLY. Nothing here is implemented.** Mocks: [`dock.html`](dock.html) ·
[`dock-patterns.html`](dock-patterns.html).

**Verdict: PROMOTE — a fix-plus-face PR, zero attest.** Risk MEDIUM.
Estimate ≈ 15 h.

This is the wave's unblocking pick. `kria` is the one member of the sequencer class the
`needs-note-entry-cell` blocker does not gate, so it is the cheapest possible answer to
the question the roster is actually stuck on: **can a step grid live on a faceplate?**

---

## 0. THE CONSTRAINT MAP, READ FIRST

| fact | where | consequence |
|---|---|---|
| TWO params only — `bpm`, `running` | `kria.ts:78-85` | and **both are fallbacks** (§0.1). The instrument is not in the param system |
| the whole sequencer lives in `node.data` | `kria-types.ts:141-152`, `KriaPatternBank` | §0.2 — undo, and what the gates cannot see |
| outputs are `pitch*` / `gate*`, no `audio` | `kria.ts:68-77` | `primaryAudioOutPortId` is null ⇒ every glyph literal → dead static. **Mechanically protected** (§4) |
| the def already declares a `kind: 'cell'` control family | `kria.ts:118-120` | the note-entry blocker does not apply — §0.3 |
| every unreachable control already has a typed roster or range | `kria-types.ts:76-125` | the face invents no vocabulary — §5 |
| the card reaches `trig`/`note`/`octave`/`duration` and nothing else | `KriaCard.svelte`, exhaustively | §2.1, the defect that dominates the page |
| `running` defaults to 0 | `kria.ts:84` | a fresh spawn is STOPPED ⇒ deterministic by default (§11) |
| zero WebGL attest | measured, §10.1 | free |

### 0.1 ⚠ BOTH PARAMS ARE FALLBACKS — the rank question is inverted here

`bpm` is *"Internal fallback tempo: used only when there's no TIMELORDE node AND no
external clock patched"* (`kria.ts:79-81`). `running` is *"Local transport. When a
TIMELORDE node exists its `running` param drives playback"* (`:82-84`).

The rack auto-spawns a TIMELORDE (`workflow-pins.ts:124`). **So in the default product
configuration, neither of this module's two params does anything.** They are the
correct fallbacks and they must stay — a rack without a TIMELORDE needs them — but it
means something unusual for a face:

> **`face.order` ranks the two least important controls on the module, because they are
> the only two the param system knows about.**

That is not a reason to refuse the face. It is the reason the face needs a body, and it
is the sharpest available statement of why the bespoke-surface cohort exists at all.

### 0.2 ⚠ EVERY EDIT TO THIS MODULE IS OUTSIDE Cmd-Z

`KriaCard.svelte:115-122`:

```ts
function writeData(mut: (d: KriaData) => void) {
  const target = patch.nodes[id];
  if (!target) return;
  ydoc.transact(() => {                      // ← no origin argument
    if (!target.data) target.data = { ...defaultKriaData() } as Record<string, unknown>;
    mut(target.data as KriaData);
  });
}
```

`store.ts:70` configures the UndoManager `trackedOrigins: new Set([LOCAL_ORIGIN])`, and
`mutate.ts:12-15` states the consequence: an edit is captured for Cmd-Z **only** when
its transaction was tagged `LOCAL_ORIGIN`. An untagged `ydoc.transact(fn)` has origin
`null`.

**So every step you click, every pattern you cue, every empty slot you seed is
un-undoable.** `commitTrack`, `selectPattern` and every grid gesture route through
`writeData`.

Three things make this worth a section rather than a ledger row:

1. **It is not carelessness.** Three lines away, `setParam` (`:108`) is
   `setNodeParam(id, pid, v)` — origin-tagged, undoable, synced. The BPM knob and the
   RUN button are correct. The module used the seam **everywhere the seam covers**.
2. **No gate can see it.** `mutate.guard.test.ts:94`'s regex anchors on the literal
   token `.params`; a `.data` write matches nothing, and there is no sibling ledger.
   See the wave README — this is the wave-level finding, and `kria` is its clearest
   instance because the un-undoable surface here is the entire instrument.
3. **The fix is one argument.** `ydoc.transact(fn, LOCAL_ORIGIN)`. It is folded into
   this PR (§11 D1) and it does not depend on the platform question.

⚠ **Verify the fix, do not assume it.** Coalescing matters: `captureTimeout: 500`
(`store.ts:69`) means a run of quick cell clicks becomes ONE undo step. That is
probably right for a drag across a row and probably wrong for two deliberate edits
four seconds apart, and it is a behaviour nobody has looked at because the feature has
never worked. §13 makes it a MUST-VERIFY rather than a hope.

### 0.3 THE NOTE-ENTRY BLOCKER DOES NOT APPLY, AND THE REGISTRY'S OWN TEXT SAYS WHY

`face-migration-inventory.ts:175-181` defines `needs-note-entry-cell` as:

> *"a note/short-text entry face cell — card-primitive-parity declares NoteEntry
> `via: none`, and a raw `<input type="text">` shares the gap, so **a typed pitch field
> ("c#3")**, a MIDI note number or a name field has no face representation at all"* …
> unblocking *"the sequencer-class surfaces (**their step rosters are typed, not
> turned**)"*.

**kria's step roster is neither typed nor turned. It is CLICKED.** `onCell(step, row)`
(`KriaCard.svelte:150-172`) is a pointer handler on a `<button>`; the def's own docs say
*"Click a cell to set/clear it for the active page"* (`kria.ts:114`); and the def
declares the family explicitly (`:118-120`):

```ts
controlFamilies: [
  { id: 'kria-cell', label: 'Per-step editor cell (note on the NTE page)', kind: 'cell', testidPrefix: 'kria-cell' },
],
```

That is why the roster gives `kria` no blocker while giving one to `sequencer`,
`drumseqz`, `polyseqz`, `macseq`, `writeseq`, `midiLane` and `cartesian`. **kria is the
counterexample living inside the cohort the blocker's prose generalises about**, and
promoting it settles the clicked-grid half of the sequencer class by demonstration.

⚠ **This does not weaken the blocker.** The typed half is still real: a face has no
route to a typed pitch field, and every module above whose step editor accepts typing
still needs one. The scope of the claim is exactly "the clicked half is buildable
today", and §5 is the demonstration.

---

## 1. WHAT THE MODULE IS FOR

`kria` is a clean-room reimagining of monome's Kria: four **independent** tracks, each
of which is not one pattern but several layered ones.

Per step, per track, there are seven lanes: `trig` (does it fire), `ratchet` (1–4
sub-hits inside the step), `note` (a scale DEGREE, not a chromatic pitch), `octave`
(0..5), `duration` (gate width as a fraction of the step), `probability` (0..1, a
four-level fader), `glide` (pitch slew in seconds). Per track there are five more:
`loopStart`, `loopLength` (a wrapping loop window), `timeDivision` (advance once every
N base ticks), `direction` (forward / reverse / ping-pong / drunk / random) and
`muted`. Per pattern there are two: `scale` and `root`.

All four tracks share one 16th-note base clock — from TIMELORDE, an external CLOCK IN,
or the local BPM fallback — but each walks it at its own division over its own loop
length, **so the tracks drift in and out of phase.** That drift is the instrument. It
is why Kria is a sequencer people keep rather than a step editor people outgrow.

Sixteen pattern slots each hold a full snapshot of all four tracks, and switching is
QUANTIZED: tap a slot to CUE it, and the engine swaps on the next track-0 loop
boundary.

**The mental model the face must serve:** you are looking at ONE track's ONE lane at a
time, and everything else about that track — how long its loop is, how fast it walks,
which way it walks — is context you need visible while you edit. The monome hardware
solves this with pages. The card solves a quarter of it. §5 is the face's answer.

---

## 2. STOP 1 — is promoting this module a PARITY LOSS?

**No — and the honest finding is the reverse. Promotion is the first time most of this
module becomes reachable at all.**

### 2.1 ⚠ THE CARD CAN EDIT `TRIG`, `NOTE`, `OCTAVE` AND `DURATION`. THAT IS ALL OF IT.

Enumerated exhaustively from `KriaCard.svelte`'s markup (`:235-342`), not from memory.
The card's entire body is: four track buttons, four page buttons plus `PAT`, either the
16 pattern slots **or** the 7×16 step grid, a BPM knob, a read-only `scale:` text tag,
and RUN + GRID in the title bar.

| control | documented in `docs.explanation`? | implemented in the engine? | reachable from the card? |
|---|---|---|---|
| `trig` | yes | yes | **yes** — TRG page |
| `note` | yes | yes | **yes** — NTE page |
| `octave` | yes | yes | **yes** — OCT page |
| `duration` | yes | yes | **yes** — DUR page |
| `ratchet` | yes | yes, `kria.ts:277-285` | **NO** |
| `probability` | yes | yes, `kria.ts:267-268` | **NO** |
| `glide` | yes | yes, `kria.ts:253-260` | **NO** |
| `loopStart` / `loopLength` | yes | yes | **NO** |
| `timeDivision` | yes | yes | **NO** |
| `direction` | yes | yes | **NO** |
| `muted` | yes | yes, `kria.ts:268` | **NO** |
| `scale` | yes | yes | **DISPLAYED, read-only** (`:338`) |
| `root` | yes | yes | **NO** |

Every "NO" above is reachable from **one** place: an attached monome grid over
WebSerial (`lib/control/monome/kria-grid`), which the card's own GRID button disables
when unsupported with the title *"monome grid needs WebSerial (Chromium only)"*
(`:252-253`).

And `module-manifest.ts:290` — the text a user reads on the docs page — says the module
is *"**FULLY usable from the card with a mouse**."*

**That is measurably false**, and it is the defect that dominates this page. The module
documents an instrument, implements an instrument, and exposes a quarter of it to
anyone who does not own a monome grid.

⚠ **The face is the fix, and this is the rare case where "promotion fixes it" is
true — but not for free.** The rule stands: a face does not pay a card's debt, because
the legacy card still renders under `?shell=legacy` and in the per-card VRT sweep. So
§11 routes each item explicitly, and the SCALE tag (§11 D4) is fixed on the card too.

### 2.2 THE GESTURES THAT DO EXIST, AND ALL OF THEM SURVIVE

| affordance | element | survives? |
|---|---|---|
| grid cell click | `<button data-testid="kria-cell-{step}-{row}">` (`:317-327`) | **YES** — the body, §6 |
| track select | four `<button data-testid="kria-track-{t}">` (`:268-274`) | **YES** — body chrome, §6.3 |
| page select | `TRG/NTE/OCT/DUR` + `PAT` (`:279-291`) | **YES**, and extended (§5.1) |
| pattern slot click / cue | `<button role="gridcell">` (`:299-308`) | **YES** — the body's second view |
| RUN | title-bar button (`:240-246`) | **YES** — a `running` param cell |
| GRID connect | title-bar button (`:247-258`) | **§2.3** |
| rename | `ModuleTitle` (`:238`) | **YES** — dock title bar |
| jacks | `PatchPanel` (`:262`) | **YES** — the shell's rail |

No drag, no right-click, no keyboard handler, no wheel handler, no file drop.

### 2.3 THE GRID BUTTON IS AN ACTION CELL, AND IT NEEDS A PROBE

`toggleGrid` (`:72-79`) is a hardware-attach gesture: `gridConnect()` opens a WebSerial
port, then `bindGridToKria(id)`. It is `disabled` when `serialAvailable()` is false.

This is **the hardware-egress probe shape wave 1 named as finding #3** — the gap that
`ShellActionCell.probe` cannot express, because `audition` / `param` / `data` / `text`
cannot observe *a byte reached a device*.

⚠ **But `kria`'s case is genuinely narrower, and the narrowness is the point.** Wave 1's
gap is about *egress* — proving a SysEx preset arrived. `kria`'s button proves only
**binding**, and binding is already observable in the graph: `boundKriaNode()` returns
the bound node id, and `gridBoundHere` (`:71`) is derived from it. So:

* the cell is `kind: 'action'`, `mode: 'trigger'`, with a **`data` probe** on a
  `node.data` key mirroring the bound state — the probe kind the registry says to
  prefer (`shell-cells.ts:324`, *"Prefer `data` where you can. A revision-only probe
  passes on a DEAD…"*);
* ⚠ **and it must record `delivered: false` rather than dropping it** when
  `serialAvailable()` is false or the user cancels the port prompt. "Pressed and
  reached nothing" and "not pressed" must stay distinguishable — the registry makes
  this argument at `:581` for another cell and it applies verbatim.

**So this face does NOT need wave-1 finding #3**, and saying so is more useful than
claiming it as a blocker: the egress gap is real, and `kria` is evidence that part of
what looked blocked behind it is not.

---

## 3. STOP 2 — does every way of getting DATA IN survive?

Yes, and the `data`-shaped ones get a better seam than they have.

* **Params** (`bpm`, `running`) already route `setNodeParam`. Clean. No
  `raw-write-ledger` entry exists and none is owed.
* **The sequencer** routes `writeData` → §0.2 → gets `LOCAL_ORIGIN`.
* **The monome grid** writes through `lib/control/monome/kria-grid.svelte.ts`, which
  is **outside the card entirely** and unaffected by promotion. ⚠ MUST-VERIFY (§13.6):
  the grid path and the face must write the same keys through the same helper, or a
  face edit and a grid edit will disagree about the pattern bank. They share
  `kria-types.ts`'s pure mutators (`toggleTrig`, `setNote`, `setOctave`, `setDuration`)
  today; the new lanes must extend that file, not the card.

### 3.1 ⚠ EVERY CELL CLICK REWRITES THE WHOLE PATTERN, AND TWO EDITORS CLOBBER EACH OTHER

`commitTrack` (`:126-136`) does:

```ts
d.patterns[String(slot)] = { scale: base.scale, root: base.root, tracks };
```

where `tracks` is all four tracks deep-cloned. **One cell click replaces the entire
pattern object** — four tracks × seven lanes × sixteen steps.

The deep clone itself is correct and deliberate: the comment at `:124-125` says *"so we
never reassign a live Y type at two paths"*, which is the Y.Doc discipline this repo
learned the hard way. **Do not undo it.**

The problem is the granularity of the WRITE, not the clone. Because the whole pattern
is one assignment:

* **two collaborators editing different tracks of the same pattern overwrite each
  other** — last writer wins on the whole object, so peer A's track-3 edit silently
  discards peer B's track-1 edit made a moment earlier. This is a multiplayer product;
  `clipplayer` treats per-lane single-writer as a design requirement for exactly this
  reason.
* every click sends the whole pattern over the wire.

**Fold into this PR** (§11 D2). The fix is to write at the LANE-STEP path
(`d.patterns[slot].tracks[t].trig[step] = …`) rather than replacing the pattern —
`KriaPatternBank` is already a string-keyed record precisely so Yjs supports keyed
assignment (`kria-types.ts:135-140`), so the mechanism is present; only the write site
is coarse. ⚠ `tracks` is a JS array inside the pattern, and Yjs forbids `arr[i] = x` on
a live Y.Array — the same note that made the bank a record. **Verify which of the two
`tracks` really is at runtime before writing the fix**; if it is a live Y.Array, the
tracks list needs the same record treatment the bank got, and that is a persistence
migration rather than a one-liner. **Measure it first.**

---

## 4. THE LANE PICTURE — refused, and the mechanism is a third distinct one

**`glyph: 'none'`.**

`primaryAudioOutPortId` (`shell-glyph-live.ts:111-113`) is
`def.outputs.find(o => o.type === 'audio')`. `kria`'s outputs are four `pitch` and four
`gate` ports (`kria.ts:68-77`) — **no `audio` output at all.** So every literal falls to
`{kind:'static'}` and the dead-glyph clause catches it. Mechanically protected, like
`dockscope` and like `audioOut`.

**And the #2160 widening does not rescue it — for a reason specific to this module.**
A layout-source `glyph: 'algorithm'` would be legal after #2160 and would resolve
live-kind. But `ShellExtensionGlyphProps` (`shell-extensions.ts:72-74`) carries no
`nodeId`, so the picture is a CONSTANT: every kria in the rack draws the same sixteen
steps.

For `scope` that made the glyph uninformative. **For `kria` it would be worse than
uninformative, because the sequence IS the module** — a tile showing someone else's
pattern is actively wrong. And `kria` needs strictly MORE than the missing `nodeId`:
the picture a player wants is the playhead over the selected track's selected lane,
which depends on `node.data.selTrack` and `node.data.selLane` as well as the node
identity. **A `nodeId` prop alone would not be sufficient here** — which is worth
recording for whoever picks that platform PR up, because `scope` and `audioOut` would
both be satisfied by `nodeId` and this module would not.

So: no lane picture. The grid is dock-only, through `fullViewBody`, which is dock-only
by construction.

---

## 5. THE FACE — the demonstration

The ladder in the faceplates skill says to reach for the earlier rungs first: a
registry cell, then a PF-14 panel, and only then a shell extension. **kria's design is
mostly rung 1**, and that is the finding: the module looks bespoke, and most of it
isn't.

### 5.1 EVERY UNREACHABLE CONTROL ALREADY HAS A DECLARED ROSTER OR A TYPED RANGE

The face invents no vocabulary. `kria-types.ts` already declares:

| control | declared as | in |
|---|---|---|
| `direction` | `KRIA_DIRECTIONS` (forward / reverse / pingpong / drunk / random) | `:76` |
| `timeDivision` | `KRIA_TIME_DIVISIONS = [1,2,3,4,6,8,12,16]` | `:88` |
| `scale` | `KRIA_SCALE_PRESETS` | `:50` |
| `root` | MIDI, clamped `MIN_MIDI..MAX_MIDI`, default `KRIA_DEFAULT_ROOT` (C3 = 48) | `:40`, `:266` |
| `loopStart` | `0..KRIA_STEPS-1` | `:114-115` |
| `loopLength` | `1..KRIA_STEPS`, wrapping | `:116-118` |
| `muted` | `boolean` | `:123-124` |
| `probability` | *"0..1; Kria's 4-level fader: 1, 0.5, 0.25, 0"* | `:109-111` |
| `ratchet` | *"1 = single hit, 2..4 = ratchets"* | `:99-100` |
| `glide` | *"per-step pitch slew time, seconds (0 = no glide)"* | `:112-113` |

⚠ **Import these, never re-type them.** This is the card-disagrees-with-its-def rule
and `kria` is a textbook candidate for it: the face would otherwise re-type four
rosters and two ranges. The cells import the exported symbols, and `kria` is brought
into `RANGE_BOUND_CARDS` when this PR touches it (boy-scout — the gates are opt-in per
card, and that blind spot is where the class lives now).

### 5.2 RANK — `face.order`, and ⚠ THE GRID IS A RANKED KEY, NOT JUST BODY CHROME

```ts
order: ['kria-cell-{n}', 'running', 'bpm']
```

⚠ **The first entry is REQUIRED and the first draft of this spec omitted it.** It was
found by reading the gate rather than by assuming, and it is recorded here rather than
quietly corrected because it changes §6's design question.

`module-face-lint.test.ts:341-344` sweeps every promoted def's `controlFamilies` and
demands the template key:

```ts
for (const f of def.controlFamilies ?? []) {
  if (!orderSet.has(`${f.id}-{n}`)) {
    missing.push(`${def.type}: control family '${f.id}' not in face.order (need '${f.id}-{n}')`);
  }
}
```

`kria` declares `controlFamilies: [{ id: 'kria-cell', … }]` (`kria.ts:118-120`), so a
promoted `kria` **must** rank `'kria-cell-{n}'` or completeness is RED. And
`curated-face.ts:19` resolves a `<f>-{n}` template to `kind: 'family'` — *"(whole
grid/cluster)"* — so it is a first-class ranked control occupying a lane-budget slot,
not a decoration.

**It ranks FIRST, and that is not a close call.** The grid is the module; §0.1's two
params are fallbacks that do nothing in the default rack. (⚠ §0.1's line *"`face.order`
ranks the two least important controls on the module"* was written before this was
measured. The corrected statement is narrower and still worth making: **the two entries
the PARAM system knows about are the two least important controls**, and the only reason
the grid is rankable at all is a `controlFamilies` declaration that exists for docs.)

All three fit inside the lane budget (ranks 1–6 are the entire lane budget; rank 7+ is
dock-only), so nothing falls off a tile.

### 5.3 BANDS — three, untabbed, and the tab question raised rather than manufactured

```
1 · TRANSPORT   running · bpm
2 · TRACK       [LOOP: loopStart · loopLength]  [TIME: timeDivision · direction]  mute
3 · SCALE       scale · root
```

**Three bands. No tab rail, and this spec does not want one.**

⚠ **This is the section where an agent is most likely to go wrong, so the reasoning is
written out.** Kria's *hardware* is organised as pages, and it is genuinely tempting to
mirror that: TRIG / NOTE / OCTAVE / DURATION / PROBABILITY / GLIDE / RATCHET / LOOP /
TIME / DIRECTION / SCALE / PATTERN would clear `DOCK_TAB_MIN_BANDS = 7` comfortably and
produce a rail.

**That would be padding, and it would be wrong twice over.** The per-step lanes are not
bands at all — they are *which lane the grid is editing*, one selection, and giving
each its own band would put twelve headers on a plate to express one choice. The skill's
rule is explicit: a page is a different IDEA, a cluster is the same idea twice, and
*"do not add a page just to get a header."* LOOP and TIME are the same idea twice
(how this track walks the grid), so they are CLUSTERS at ~14 px, not pages at ~81 px.

The honest grouping lands at three. `face.tabbed` is owner-instruction-only and this
spec does not reach for it. **If the owner wants a rail here, that is a threshold
conversation, not a padding exercise** — which is precisely what the skill says to do
when an honest grouping lands under the threshold.

### 5.4 CONTROL INVENTORY — every primitive decision, argued

| key | primitive | why |
|---|---|---|
| `running` | **`toggle`** (derived) | a 0/1 param with `curve: 'discrete'` — `looksLikeToggle` infers it; no declaration needed |
| `bpm` | **knob** (default) | a continuous 30–300 range. Not a fader: it is a value you dial to, not a level you throw |
| `loopStart` | **`selector`** over `0..KRIA_STEPS-1` | a step INDEX. A knob over sixteen integers has no landmark at any position; a roster names the step |
| `loopLength` | **`selector`** over `1..KRIA_STEPS` | same argument |
| `timeDivision` | **`selector`** over `KRIA_TIME_DIVISIONS` | a declared roster of eight irregular values (`1,2,3,4,6,8,12,16`) — **not** a continuous range. A knob would let a user land between two legal divisions |
| `direction` | **`selector`** over `KRIA_DIRECTIONS` | five named modes. The names disambiguate; the positions do not |
| `mute` | **`toggle`** cell | boolean |
| `scale` | **`selector`** over `KRIA_SCALE_PRESETS` | ⚠ and this REPLACES the card's read-only text tag (§11 D4) |
| `root` | **`selector`** over note names | ⚠ **not a raw MIDI number.** The stored value is MIDI (48 = C3), but a face that made a user pick `48` would be a worse instrument than the hardware. The roster is note names; the cell writes the MIDI int |
| GRID connect | **`action`**, `mode: 'trigger'`, `data` probe | §2.3 |

**Every one of these except `running` and `bpm` reads and writes `node.data` for the
CURRENTLY SELECTED TRACK.** That coupling is real and §6.3 specifies where the
selection lives and why.

**Two things NOT done:**

* **No `hero`.** A hero MOVES a key out of its band and suppresses the shell glyph at
  the dock. There is no param here worth promoting above the others, and the body
  already takes the hero glyph's place.
* **No `paramCells` fader declaration.** Neither param is a throw.

---

## 6. THE BODY — `face.extension: 'kria'`

### 6.0 ⚠ §5.2 RE-OPENS THIS SECTION: THE GRID IS A RANKED KEY, SO SOMETHING MUST RENDER IT

The first draft of §6 put the grid in `fullViewBody` and treated the ranked key question
as settled. It is not, and the ladder says to reach for the earliest rung that fits:

1. a family/static **cell**; 2. a PF-14 **`panel`** cell — *"ONE picture-you-edit
   **inside** the generic face (an operator map, an envelope editor). Registered in
   `shell-cells.ts`, probe required, dock-only by lint"*; 3. a **shell extension**.

**A 7×16 step grid is one picture-you-edit.** That is rung 2's description almost word
for word, and rung 2 is where `warrensspectrum` landed for the same reason — its card
was the filterbank's only editor, so it got a bank PANEL *inside* the face rather than
a body that ate it (`shell-extensions.ts:89-94` records that as the failure this seam
exists to prevent).

**Measured:** `shell-cells.ts` contains **no `kria-cell-{n}` entry** — grep returns
nothing for `kria` in that file. So today the ranked key would resolve to no registered
cell, and `shell-cells.test.ts` ("no inert cell on a promoted face") is the gate that
catches it. **The key must be registered, whichever rung wins.**

**The recommendation, and it is a change from the first draft:** register
`'kria-cell-{n}'` as a **PF-14 `panel` cell** — dock-only by lint, with a **`data`
probe** on the pattern bank (the registry's preferred probe kind, and here the observable
is real: a cell click changes `node.data.patterns`). The face then needs **no shell
extension at all** for the step grid.

⚠ **This does NOT settle where the PATTERN view goes**, and the honest answer is that it
is a second picture, not a second view of the first. Two routes, and the build should
pick by measuring the panel primitive's actual affordances rather than by preference:
either a second registered panel cell, or the `fullViewBody` retained solely for the
pattern strip. §6.1 below is written for the `fullViewBody` route and stays valid for
whichever part of the surface takes it.

⚠ **And if BOTH views fit in panel cells, drop `face.extension` entirely** — a module
that needs no bespoke code is a better outcome than one that ships a lazy chunk, and it
would make `kria` a considerably stronger demonstration for the sequencer cohort than
this spec originally claimed: **the clicked-grid class may need no platform seam at
all.**

### 6.1 IF a shell extension is used at all, it is `fullViewBody` — never `editorSurface`

⚠ Read this section as conditional on §6.0: if both views fit in panel cells there is no
extension, and this section is moot. It exists because `editorSurface` is the slot a
reader will reach for, and reaching for it would be wrong either way.

`editorSurface` is the slot whose own documentation names this exact thing — *"a
bespoke EDITOR SURFACE for controls that are not cell-shaped at all (a clip arranger,
**a pad matrix**)"* (`shell-extensions.ts:75-79`). A 7×16 step grid is a pad matrix.

**It is UNWIRED.** `WIRED_SHELL_EXTENSION_SLOTS` is `['glyph', 'fullViewBody']`
(`:124`), and `shell-extensions.test.ts` refuses an extension exporting an unwired
slot, so it cannot silently no-op.

**Use `fullViewBody`.** It is wired, dock-only, paints above the control bands, replaces
the hero glyph, and — the load-bearing half — **leaves every param cell intact**
(`:85-87`), so face completeness, the dock render-plan parity gate and `faces-parity`
all still apply. That is the `rasterize` / `pong` / `timelorde` precedent and it needs
no platform change.

⚠ **Do not wire `editorSurface` for this.** Wiring a slot is a platform change that
must land in the same diff as its first adopter, and picking the harder route when the
easy one is correct would put a face PR in the business of moving the shell's render
sites. Recorded so the next reader knows the slot was considered and why it was not
taken.

### 6.2 The component

`$lib/ui/modules/kria/shell-extension.ts` → `{ fullViewBody: KriaGridBody }`.

**Two views, one surface**, matching the card's `showPatterns` flip:

* **STEP view** — the 7×16 grid, plus the playhead column highlight.
* **PATTERN view** — the sixteen slots with occupied / active / cued state.

The view flip is body chrome (§6.3), not a face cell — it is navigation, not a setting.

⚠ **DOM, not canvas.** The card's grid is `<button>` elements and it should stay that
way. A canvas grid would lose every accessible name (§7), lose hit-testing for free,
and — because attest basis rule (2) is derived from CONTENT — a WebGL canvas would
enrol this module in the attest basis and make every future edit cost a GPU re-attest
(§10.1). There is no reason to draw 112 rectangles by hand.

### 6.3 ⚠ THE SELECTION MUST LIVE IN `node.data`, AND THIS IS NOT A STYLE CHOICE

`KriaCard.svelte` keeps `selTrack`, `selPage` and `showPatterns` as component `$state`
(`:65-67`). On a face they must move to `node.data`, for three independent reasons —
any one of which is sufficient:

1. **The band cells depend on it.** Every cell in §5.4 except `running`/`bpm` is
   "…of the selected track". A cell's `value(node)` receives only the node
   (`shell-cells.ts:135`), so the selection must be readable from it. Component state
   in a sibling component is not.
2. **The component unmounts.** Dock collapse and LRU eviction destroy it — the
   #1531 / #1574 / #1583 class. `node.data` is what survives a remount, a tab switch
   and a reload. The faceplates skill states this as a hard rule for
   `previewCollapsed` and the same argument applies verbatim.
3. **It makes the cells and the body agree by construction** rather than by a prop
   contract nobody gates.

⚠ **And it must be a LOCAL-ORIGIN write like everything else** (§0.2) — but consider
whether a selection change *should* be an undo step at all. Navigating is not editing.
The registry's own precedent (`shell-cells.ts:333`) discusses a panel keeping a
setting in component state and probing it; **the honest answer here is probably a
`node.data` key written with a NON-tracked origin** — synced and durable, but not on
the Cmd-Z stack, so undo walks back through your edits rather than through your
clicks. `mutateNode` takes `{ origin }` for exactly this (`mutate.ts:60-62`).
**This is a judgement; §12 gives it a revert.**

### 6.4 THE PAGE SELECTOR EXTENDS TO EVERY LANE

The card offers `TRG / NTE / OCT / DUR`. The body offers those plus `PRB`, `GLD`,
`RAT` — the three per-step lanes §2.1 found unreachable. Each reuses the same 7×16
grid with its own `cellOn` / `onCell` interpretation, exactly as the four existing
pages already do.

* `probability` — four levels (`1, 0.5, 0.25, 0`), so four of the seven rows are
  meaningful. ⚠ **Do not alias the other three** — that is D3's bug (§11). Either use
  four rows and leave three inert-and-visibly-inert, or map the seven rows onto the
  four levels with an explicit, tested rounding. Pick one and assert it.
* `ratchet` — 1..4, same shape, same warning.
* `glide` — seconds, continuous. A 7-row quantisation is a real design decision;
  the range and its landmarks must come from `kria-types.ts`, not from the body.

### 6.5 SCREEN ON/OFF — no, and the reason is the same as `audioOut`'s

`kria` is `domain: 'audio'`, so `video-face-screen-source.test.ts` cannot see it either
way (it sweeps `listVideoModuleDefs() ∩ STRICT_FACES`). On the merits: the grid IS the
module. Collapsing it leaves a plate with a run button and a tempo knob, which is not a
compact view of kria — it is a different, useless module. `dockscope` / `spectrograph`
/ `samsloop` refuse a toggle on this argument and `kria` is squarely on their side.

---

## 7. THE ARIA CONTRACT — the part the card gets wrong

`KriaCard.svelte:325` is:

```svelte
aria-label={`step ${step} row ${row}`}
```

**A bare grid coordinate.** It is page-invariant: on the NOTE page the cell is a scale
degree, on OCT an octave offset, on DUR a gate width — and the accessible name says
`step 5 row 2` for all of them. It also never says the cell's VALUE or whether it is
lit.

This matters more here than on any other module in the wave, because of the resting-text
ruling: **the face paints no derived state, so `aria-valuetext` is the ONLY place the
sequencer's state exists in a readable form** — and it is what every spec proving the
face tracks the graph will read.

The contract:

* **`aria-label`** names what the cell IS on the current page and where it is —
  `step 5, degree 3` on NTE, `step 5, octave 2` on OCT, `step 5, gate 4 of 7` on DUR.
  It changes when the page changes.
* **`aria-valuetext`** carries the value and the lit state.
* **`role`** stays `gridcell` inside `role="grid"` / `role="row"` — the card already
  has this right (`:313-321`).
* **The playhead** is announced on the ROW or the grid, not by mutating 16 cells' names
  every step. A live region that fires sixteen times a bar is unusable.
* ⚠ **Per the owner ruling, this is NOT a keyboard-navigation project.** No roving
  tabindex, no arrow-key grid navigation, nothing that changes the Tab gesture. The
  accessible NAME is the deliverable; the interaction model is untouched.

---

## 8. THE STATE MATRIX

| # | state | grid | cells | observable |
|---|---|---|---|---|
| 1 | fresh spawn, empty bank | all cells dark, no playhead | defaults from `defaultPattern()` | `running` = 0 |
| 2 | TRG page, some steps lit | bottom row lit on those steps | — | `aria-valuetext` per cell |
| 3 | NTE page, same track | ONE cell lit per step at its degree row | — | names the degree |
| 4 | OCT page | filled bar from the bottom | — | ⚠ **row 0 must be reachable AND lightable** — D3 |
| 5 | running, TIMELORDE present | playhead column tracks `currentStep:{selTrack}` | `bpm` inert | engine `read` |
| 6 | track 2 selected | grid shows track 2's lanes | **every §5.4 cell re-reads for track 2** | the permanent negative control |
| 7 | pattern 3 cued | PATTERN view: slot 3 cued, slot 0 active | — | `read('cued')` = 3 |
| 8 | track muted | grid unchanged (mute is not a lane) | mute toggle on | no gate output |

⚠ **State 6 is the permanent negative control for the whole design.** The entire §5.4
inventory is "…of the selected track", and a body/cell disagreement about which track
is selected is the failure mode that design invites. The test switches tracks and
asserts every cell's value moved with it — and, in the other direction, that editing a
cell changed **only** the selected track.

⚠ **State 4 is D3's regression test** and it must be written so it fails on today's
code.

---

## 9. DETERMINISM AND VRT

Two live things and one random thing, all of which the scene must handle by
construction rather than by timing.

* **The playhead is live** (an engine `read` per rAF). ⚠ But `running` **defaults to
  0** (`kria.ts:84`), so a fresh spawn is STOPPED and the default scene is
  deterministic for free. Capture stopped.
* ⚠ **A blank grid is a nearly vacuous baseline.** An empty bank means every cell is
  dark, and a baseline of 112 dark squares would pass whether the body rendered the
  right lane, the wrong lane, or a lane of the wrong track. **The scene must seed a
  deterministic pattern through the patch fixture** — a fixture the test itself builds
  is not a population count and not a hand-typed constant; it is the subject.
* ⚠ **`Math.random()` is in the emit path.** `kria.ts:268` rolls
  `Math.random() < prob` per firing step. This is not a determinism problem for a
  STOPPED capture, and it is not a defect — a probability lane must be random. It IS a
  constraint: **no VRT scene and no assertion may run this module while a
  sub-1 probability step exists**, and any behavioural test of the probability lane
  must assert a distribution or pin the generator, never a specific step.
  Recorded because the failure would present as a flake and the diagnosis would start
  in the wrong place.
* **Two scenes predicted**: `face-kria-compact.png`, `face-kria-dock.png`.
  Dispatch `GREP=kria task vrt:commit` — a bare dispatch on a face PR derives FULL,
  because the derivation reads PATHS ONLY. **Count what the bot commits against that
  prediction.**
* `e2e/vrt/workflow-shell-faces.spec.ts`'s `FACES` roster is **NOT registry-driven** —
  add `kria` by hand or it silently has no scene.

---

## 10. COST

### 10.1 ⚠ WEBGL ATTEST: ZERO. MEASURED, NOT REASONED.

```sh
flox activate -- bash scripts/webgl-attest-hash.sh --list | grep -i kria
```

returns **nothing**. `audio/modules/kria.ts`, `audio/modules/kria-types.ts` and
`ui/modules/KriaCard.svelte` are all absent from the basis.

⚠ **Keep the body DOM** (§6.2). Basis rule (2) is derived from CONTENT, so a WebGL
grid would enrol this module automatically.

### 10.2 ART: ZERO, and measured rather than assumed

⚠ ART pins to the **RAW FILE SHA** and is **NOT** comment-stripped — the opposite of the
attest, and that asymmetry cost wave 2 a red run on a comment-only edit. So "no audio
output" is not sufficient reason to skip the check.

**Measured:** `kria` appears in `art/` exactly once, in
`art/setup/profile-coverage.ts:88`, as a member of **`ART_BACKLOG`** — the reasoned list
of audio-domain registry modules that do not yet ship a profile. There is no
`art/scenarios/kria/`, no baseline, and therefore **no source pin for this PR to move.**

⚠ **And do not remove it from that list.** `audio-profile-gate.test.ts` enforces
*"a module that gains a baseline MUST be removed from this list"* — the converse of what
this PR does. A face adds no baseline, so `kria` stays exactly where it is, and touching
`profile-coverage.ts` here would be a change with no cause.

### 10.3 CI wall-time

Registry-driven auto-enrolment (`faces-parity` partition row, `module-face-lint`
completeness, dock render-plan parity, `shell-cells`, the `faceplate-platform`
annotation sweep), two dock VRT scenes, one `kria-face-model` unit file, and the
existing `kria.spec.ts` unchanged. **Under the 2 min threshold**, but the estimate is
stated so it is checkable.

### 10.4 The Push 2 card moves

`push-card-config.ts` resolves tier 2 from `face.order` absent an override, so
authoring a face **silently re-ranks this module's Push card**. `kria` has no
`PUSH_CARD_CONTROLS` entry. With two params the result is two encoders and is almost
certainly right — pinned as a permanent leg in `push-card-schema` rather than assumed.

⚠ Note the shape: the Push card sees `params`, so it sees the two fallbacks and none of
the instrument. That is the same blindness §0.1 describes, appearing in a third place.

---

## 11. DEFECT LEDGER

| # | defect | evidence | routing |
|---|---|---|---|
| **D1** | **Every sequencer edit is un-undoable.** `writeData` transacts with no origin | `KriaCard.svelte:118`; `store.ts:70`; `mutate.ts:12-15` | **Fold into this PR.** One argument: `ydoc.transact(fn, LOCAL_ORIGIN)`. ⚠ Fix the CARD too — a face does not pay a card's debt. ⚠ Verify the `captureTimeout: 500` coalescing behaviour (§0.2) |
| **D2** | **A cell click rewrites the whole pattern**, so two collaborators editing different tracks clobber each other | `KriaCard.svelte:126-136` | **Fold in** — §3.1. ⚠ Measure whether `tracks` is a live Y.Array first; if it is, this is a persistence migration, not a one-liner, and it goes to the owner |
| **D3** | **OCT page row 0 is click-responsive and can never light.** `onCell` computes `Math.min(5, 6 - row)`, so rows 0 and 1 both write octave 5; `cellOn` lights `6 - row <= oct`, which for `oct = 5` is rows 1..6. **Row 0 responds and never shows its own state** | `KriaCard.svelte:161-163` vs `:183-186` | **Fold in.** The face's OCT page must not reproduce it (§6.4), and the card is fixed in the same diff. State 4 (§8) is the regression test and must fail on today's code |
| **D4** | **`scale` is displayed and not editable.** The card prints `scale: {pattern.scale}` as a read-only tag; there is no control anywhere but the grid | `KriaCard.svelte:338` | **Fold in.** ⚠ Two separate things: the face gets a `selector` cell (§5.4), AND the tag is **resting derived-state text** that must not appear on the face in any form. Its FINDING — which scale is active — moves to the cell's own `aria-valuetext`, so no coverage lapses |
| **D5** | **`ratchet`, `probability`, `glide`, `loopStart`, `loopLength`, `timeDivision`, `direction`, `muted` and `root` are documented, implemented and unreachable without a monome grid**, while the manifest says the module is *"FULLY usable from the card with a mouse"* | §2.1 table; `module-manifest.ts:290` | **Fold in** — this IS the face (§5, §6.4). ⚠ **And correct the manifest sentence in the same diff**, whatever the face does: a description that oversells is a defect independent of the fix |
| **D6** | **`onMeterFrame` is imported and never used**, beside a hand-rolled uncapped rAF that is the thing it exists to replace. The rAF also runs while the PATTERN view is showing, where there is no playhead to draw | `KriaCard.svelte:17` (only occurrence); `:214-226` | **Fold in.** Use the shared frame pump, and gate it on the STEP view being visible. The irony is worth recording: the card imported the right mechanism and then did not use it |
| **D7** | **Every grid cell's accessible name is a bare coordinate**, page-invariant and value-free | `KriaCard.svelte:325` | **Fold in** — §7. ⚠ Not a keyboard-nav project |
| **O1** | `Math.random()` in the emit path means two peers roll differently for the same probability step | `kria.ts:268` | **OBSERVATION, not a defect.** Each peer runs its own engine, so any randomness diverges by construction; whether kria's probability lane *should* be per-peer is a musical question for the owner, not a face PR's call. Recorded because it constrains testing (§9) |

⚠ **D1, D2, D3, D4, D6 and D7 are CARD defects.** The legacy card still renders under
`?shell=legacy` and in the per-card VRT sweep. Each fix edits `KriaCard.svelte` (or
`kria-types.ts`) directly. **A face does not pay a card's debt** — the mistake #2025
made by name.

---

## 12. TASTE CALLS, EACH WITH ITS ONE-LINE REVERT

| call | revert |
|---|---|
| Three bands, untabbed (§5.3) | the owner may want a rail; that is a threshold conversation, and `face.tabbed` needs an instruction recorded verbatim |
| Selection written with a NON-tracked origin (§6.3) | pass `LOCAL_ORIGIN` and navigation joins the undo stack |
| `root` as a note-name roster, not a MIDI int (§5.4) | swap the roster; the stored value is unchanged either way |
| `loopStart` / `loopLength` as selectors, not knobs | swap the primitive; the range import is unchanged |
| The body carries track + lane selection as chrome (§6.3) | promote them to cells; they would then owe band placement |
| Three new grid pages (PRB / GLD / RAT) rather than dedicated cells | drop the pages; the lanes revert to grid-only reachability |

---

## 13. MUST-VERIFY

0. **`'kria-cell-{n}'` is ranked and RENDERED** (§5.2, §6.0). Completeness demands the
   key; `shell-cells.test.ts` demands it not be inert. **Decide the rung by building the
   panel cell first** and only reaching for an extension if the panel primitive cannot
   carry a 7×16 grid — and if it can carry BOTH views, ship with no `face.extension` at
   all and say so, because that is a materially stronger result for the cohort.
1. **Undo actually works**, and the `captureTimeout: 500` coalescing is looked at
   rather than inherited (§0.2).
2. **`tracks` at runtime — live Y.Array or plain array?** D2's fix depends on the
   answer and the answer is measurable (§3.1).
3. **State 6** — switching tracks moves every §5.4 cell, and editing a cell touches
   ONLY the selected track (§8).
4. **State 4** — the OCT row-0 regression test fails on today's code before it passes
   on the fix.
5. **Rosters are IMPORTED, not re-typed**, and `kria` enters `RANGE_BOUND_CARDS`
   (§5.1).
6. **The monome grid path and the face write the same keys through the same pure
   mutators** in `kria-types.ts` (§3).
7. **The VRT scene is seeded**, not blank (§9).
8. **ART stays at zero** — `kria` remains in `ART_BACKLOG` and no `art/scenarios/kria/`
   appears (§10.2). A face adds no baseline, so nothing in `art/` should be in the diff.
9. **`FACE_WIDTH_EXEMPTIONS` is untouched.** The card is 420 px; the face must not be
   the wave's width exception.
10. **The GRID action cell records `delivered: false`** when WebSerial is unavailable
    (§2.3).

---

## 14. VERIFICATION GATE

```sh
# 1. the pure model + this face's PERMANENT negative controls (§8 states 4 and 6)
flox activate -- task test:one -- kria-face-model
flox activate -- task test:one -- kria-types          # D3's arithmetic lives here
flox activate -- task test:one -- kria                # the existing engine unit file

# 2. face lint
flox activate -- task test:one -- module-face-lint
flox activate -- task test:one -- dock-row-plan
flox activate -- task test:one -- dock-faceplate-model
flox activate -- task test:one -- dock-tabs-model      # §5.3 — asserts NO rail at 3 bands
flox activate -- task test:one -- curated-face

# 3. the rulings' source gates
flox activate -- task test:one -- face-resting-text-source   # §11 D4 — the scale tag
flox activate -- task test:one -- face-readout-source
flox activate -- task test:one -- face-width-source

# 4. the registries
flox activate -- task test:one -- shell-cells                # selector + action probe shapes
flox activate -- task test:one -- shell-extensions
flox activate -- task test:one -- module-shell-import-guard
flox activate -- task test:one -- card-range-source          # §5.1 — kria joins RANGE_BOUND_CARDS
flox activate -- task test:one -- card-control-ranges
flox activate -- task test:one -- push-card-schema
flox activate -- task test:one -- mutate.guard               # must stay green
flox activate -- task test:one -- module-docs-lint
flox activate -- task docs:check

# 5. e2e — the REAL source chain assertion already exists; it must survive
flox activate -- task e2e:serve
REPEAT=3 flox activate -- task e2e:one -- tests/kria.spec.ts
REPEAT=3 flox activate -- npx --workspace e2e playwright test faces-parity --grep kria
REPEAT=3 flox activate -- task e2e:one -- tests/faceplate-platform.spec.ts
flox activate -- task e2e:stop

# 6. typecheck LAST
flox activate -- task typecheck

# 7. VRT: dispatch only. NEVER commit a PNG.
GREP=kria flox activate -- task vrt:commit

# 8. attest: NIL (§10.1).
```

⚠ `kria.spec.ts` is the module's **real-source-chain** assertion (TIMELORDE → kria →
VCO + VCA → audible gated RMS). It is the thing that catches a green-but-silent
sequencer. **It must pass unchanged**; if the face PR needs to edit it, that is a
signal about the change, not about the test.

---

## 15. BUILD-COST ESTIMATE

| | |
|---|---|
| the face declaration, three bands, the registry cells, each importing its roster | ≈ 4 h |
| `KriaGridBody` — two views, seven pages, the selection in `node.data` | ≈ 5 h |
| the card defect fixes (D1, D2, D3, D4, D6, D7) + the manifest correction (D5) | ≈ 3 h |
| `kria-face-model` with states 4 and 6 as permanent negative controls | ≈ 2 h |
| VRT dispatch, reconcile, docs accept | ≈ 1 h |
| **Total** | **≈ 15 h** |

Risk MEDIUM: no precursor and no platform dependency, but D2 has a measurement gate in
front of it that could turn a one-liner into a persistence migration, and the
selected-track coupling (§6.3) is the kind of design that is easy to get subtly wrong
and hard to notice.
