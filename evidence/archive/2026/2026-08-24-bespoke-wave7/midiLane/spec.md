# `midiLane` — FACEPLATE SPEC (wave 7, cohort B, agent C)

**Nothing here is implemented. This is a spec.**

Measured against `origin/main` at `99a961b08`. Every claim carries its `file:line`.

**This module is the DIRECT HEIR to wave 5's `BINDERS.md`, and its sibling `midiclock`
shipped as #2187 hours ago.** Wave 5's shared binder analysis is CITED here, never
re-derived. What this spec adds is the three things `midiclock` did not have to answer:
**the typed note-number field, the settings that are `node.data` where `midiclock`'s are
params, and a card that is FOUR TIMES the size of the one that shipped.**

---

## 0. THE HEADLINE

`midiLane` is `midiclock` plus one numeric field, and **that one field is the entire
difference between "already shipped" and "blocked on an owner decision."**

Everything else about the two modules is the same problem with the same shipped answer:
a permission gesture as a ranked ACTION cell, a runtime device roster in a
`status-primitive` `fullViewBody`, `glyph: 'none'` mechanically forced, a VRT exemption
whose pre-connect state is deterministic, and a `node.data` bare-write to pay off. The
face design below is a near-transcription of `MidiclockDeviceBody.svelte` and
`midiclock-cell-actions.ts`, which is the point: **the binder body is now a shipped
pattern with two adopters and this is the third.**

### 0.1 ⚠ WHAT WOULD MAKE `midiLane` DRAINABLE FROM `ALLOWED_PERMANENT_EXEMPT` — one line

> **NOTHING. IT IS ALREADY DRAINABLE, AND ITS OWN EXEMPTION TEXT SAYS SO.**
> `vrt-exemptions.ts:769-774` reads: *"the rich card UI (device picker, channel/mode/CC/note
> controls, live readout) only appears **AFTER Connect**, which depends on hardware absent
> in CI; **the pre-Connect state is just the "Connect MIDI…" button + hint**."* The second
> clause is the exit condition and the harness only ever sees the second clause: the VRT
> scene presses nothing, `connect()` is the only path to `requestMIDIAccess`
> (`midi-lane.ts:67-69`: *"we DON'T request Web MIDI on mount"*), so
> `MidiLaneCard.svelte:190` takes its `{#if !cardState.connected}` branch and paints one
> button and one static sentence. **That is the identical argument `_shell-faces.ts:3350-3372`
> used to drain `midiclock` — from the very same four-entry block — and it applies here
> verbatim.** No `FACES_WITHOUT_SCENES` entry (`_shell-faces.ts:3472`) is warranted.

### 0.2 ⚠ WHICH SIDE OF THE `NON_SHELL_LANE_TYPES` SPLIT — one sentence

> `midiLane` is **NOT** in `NON_SHELL_LANE_TYPES` (`legacy-fallback.ts:109-124`), so
> `hasCard` is true and `migrated` is false and `laneRenderKind` (`:156-160`) returns
> **`'placeholder'`** today — a RACKLINE tile with **no ranked controls at all**
> (`ModuleShellPlaceholder.svelte:1-10`: *"differing only in the body (no ranked knobs
> until the module gets a `face`)"*) whose real card opens only through the dock full
> view — so promotion's whole user-visible lane effect is **"which ranked cells appear on
> a tile that currently has none,"** and on a module that is completely inert until
> CONNECT is pressed, the cell that matters is CONNECT. That is #2187's headline verbatim
> (*"the CONNECT gesture was DOCK-ONLY on a module that is inert until it is pressed"*),
> and it is a **smaller** tail here than on `es9`, which brings 22 routing params with it.

### 0.3 ⚠⚠ THE BLOCKING FINDING — the typed field makes a `face` RED on a gate no wave has listed, and it is **NOT** fixed by dropping the blocker

*(Measured by the orchestrator; independently re-verified here against
`origin/main:packages/web/src/lib/ui/workflow/face-migration-inventory.test.ts` — the
control flow, the predicate and the template source are quoted from the file below.)*

`MidiLaneCard.svelte:261-272` mounts

```svelte
<input class="note-num" type="number" min="0" max="127"
       value={noteGateNote} onchange={onChangeNoteGate} />
```

Three legs of ONE gate file interlock:

1. **`:229`** — `it('every def that DECLARES a `face` is dispositioned generic-face')`.
   Reads the DEF and refuses `d.face && disposition !== 'generic-face'`. **Authoring a
   `face` FORCES the entry to `generic-face`.**
2. **`:268`** — `it('every `blocked` entry names at least one blocker, and no generic-face
   entry names any')`: `'generic-face' cannot be waiting on a capability`. **So
   `midiLane`'s `blockers: ['needs-note-entry-cell']` (`face-migration-inventory.ts:893-895`)
   must be emptied in the same commit.**
3. **`:509-528`** — the TYPED-ENTRY leg, quoted in full because the CONTROL FLOW is the
   finding:

```ts
for (const [type, tmpl] of templates) {
  if (!mountsTypedEntry(tmpl)) continue;
  const entry = inventoryEntry(type);
  if (!entry) continue;
  if (entry.disposition === 'generic-face') {
    offenders.push(`${type}: dispositioned generic-face, but its card mounts typed entry
                    — the face system has no text cell (card-primitive-parity: NoteEntry via:none)`);
    continue;                                      // ⚠ RETURNS BEFORE READING THE BLOCKERS
  }
  if (entry.disposition === 'organizational-native') continue;
  if (!migrationBlockers(entry).includes('needs-note-entry-cell')) { … }
}
```

**The `generic-face` branch fires and `continue`s before `migrationBlockers` is ever
read.** Emptying the blockers array is *necessary* (leg 2) and *does not help* with leg 3.

⚠ **`templates` is the LEGACY CARD's markup, and the legacy card SURVIVES promotion** —
it is what `?shell=legacy` renders. `cardTemplates()` (`:154-172`) walks every registered
def, resolves `<Type>Card.svelte` through `readCardSourceWithDelegates`, and strips
script/style/comments via `cardTemplate()` (`:127-133`). `mountsTypedEntry` (`:144-150`)
matches `<NoteEntry>`, `<textarea>`, `contenteditable`, and
`<input type="text|number|url|search|email|tel">` — deliberately **not** `range`, `file`,
`color`, `checkbox`, `radio`, *"which are all expressible today, and matching them would
turn this leg into a blanket ban on `<input>`."* `type="number"` is in the matched set.

> ### ⚠ THIS OVERTURNS WAVE 6 §5.2's PRESCRIPTION — the reasoning was right, the remedy was incomplete
>
> Wave 6 §5.2 concluded: *"The blocker's capability text is scoped to CELLS. A
> `fullViewBody` is a SLOT: it satisfies no cell contract and needs no probe … **The
> blocker is real — it is simply not in these modules' way** … Recommendation: drop
> `needs-note-entry-cell` from `archivist` and `peertube`'s `blockers` arrays when their
> faces land."*
>
> **The reasoning is correct and this spec relies on it** (§6). **The remedy is necessary
> and not sufficient**, because the gate that actually reddens does not read the blockers
> at all — it reads the legacy card and the disposition.
>
> ⚠ **Wave 6 could not have seen it, and the reason is instructive rather than
> exculpatory.** All three modules promoted since the extension slot shipped —
> `midiclock`, `kria`, `matrixmix` — have CLEAN cards, so **the leg has never fired.** A
> gate that has never fired and a gate that cannot fire are indistinguishable from a green
> run; this one can fire, and the first module to reach it is this one.
>
> ⚠ And the same file **contains both subjects, disagreeing.** `:346` makes the *blocker's
> own liveness probe* `faceShellMountsTypedEntry: mountsTypedEntry(moduleShellTemplate())`,
> reading `ModuleShell.svelte` — *"the ONE renderer every face cell is painted by"*
> (`:335-337`). So the **blocker's** subject is the shared face RENDERER while the
> **disposition leg's** subject is the LEGACY CARD, **and a `fullViewBody` is neither.**
> That gap is exactly the hole wave 6's argument walks through, and exactly why the gate
> does not notice it walking.

**THE THREE ROUTES, AND THIS SPEC PICKS NONE OF THEM.** Each costs something a standing
ruling protects, so it is escalated (see the cohort doc's owner-decision section):

| route | what it costs |
|---|---|
| **(a)** strip the `<input>` from `MidiLaneCard.svelte`, replacing it with the same `<select>` roster the face uses (§5.4) | a change to the `?shell=legacy` surface. ⚠ Under *functional parity is a HARD requirement* this is **not** a loss — a 128-row named roster reaches every value the field reaches — but it is a look change to a legacy card, which is an owner call |
| **(b)** narrow the gate's subject to what the FACE renders | forbidden by the standing **no-fundamental-CI-changes** ruling |
| **(c)** do not promote `midiLane` | leaves the cohort's second-cheapest face unbuilt for one field |

⚠ **A FOURTH ROUTE IS NAMED IN ORDER TO REFUSE IT.** The leg skips
`organizational-native` (`:522`, *"the text IS the object"*). Re-dispositioning `midiLane`
into that bucket would turn the gate green **and change nothing about the module** — a
green gate certifying exactly what it was built to catch. Do not.

**⚠ THE FACE DESIGN BELOW IS IDENTICAL WHICHEVER WAY IT GOES.** Only the PR's file list
changes: route (a) adds one edit to `MidiLaneCard.svelte`; route (c) shelves the PR. No
cell, no band, no `order` entry and no gate answer in §§3-9 depends on the outcome.

⚠ **And the asymmetry inside this agent's pair is worth stating rather than assuming:
`es9` is CLEAN** — `Es9Card.svelte` mounts no `<input>` of any kind, only 22 `<select>`s
and two `<button>`s. This is a `midiLane`-only problem.

---

## 1. WHAT THE MODULE IS

`midi-lane.ts:262-306`. `domain: 'audio'`, `label: 'midi lane'`, `category: 'sources'`,
palette `MIDI / MIDI`. **No `maxInstances`** — the design is explicitly *"a LIGHT,
instantiable per-lane bus: drop one per instrument, multi-timbral = drop several"*
(`:19-22`), which is the opposite of `es9`'s singleton.

* **0 inputs.** *"the MIDI source is the external device"* (`:55`).
* **7 outputs** — `pitch_cv` (cv), `gate` (gate, `edge:'gate'`), `velocity_cv` (cv),
  `cc_a`/`cc_b` (cv), `note_gate` (gate, `edge:'trigger'`), `poly` (polyPitchGate).
  `:270-282`.
* **0 params** (`:283`). Everything the user sets lives in `node.data`
  (`MidiLaneData`, `:214-226`): `channels`, `priority`, `retrig`, `mode`, `ccA`, `ccB`,
  `noteGateNote`, `lastDeviceId`.
* Already in `STRICT_DOCS` (`strict-docs.ts:226`) and `DESCRIPTIONS`
  (`module-manifest.ts:370`), with per-port prose and `docs.controls: {}` (`:305`) —
  empty, correctly, because there are no controls to document yet.

### 1.1 ⚠ THE TRANSPORT AXIS — a browser PERMISSION, and that is the whole availability story

`midiLane` reaches its hardware through `navigator.requestMIDIAccess`, mocked in the
per-port driver at `_per-port-drivers.ts:882-905`. One user gesture, **cached per origin**
by Chrome (`midi-lane.ts:67-69`), and thereafter the roster is whatever is plugged in.

**Contrast the sibling in this pair, and it is the cohort's sharpest transport split
(`../es9/spec.md §1.3`):** `es9` touches **no browser device API at all** — a WebSocket to
a native helper on a local origin, plus a Worker and a SharedArrayBuffer ring. A
permission is granted once and cached; a helper process is either running or it is not,
on this machine, right now. **Those are different availability stories, and they produce
different empty states, different VRT arguments and different lane-tile priorities** —
which is the substance of §12's answer to the wave's commissioning question.

---

## 2. THE PRIMARY INTERACTION, AND WHY IT IS NOT BESPOKE

The inventory says (`face-migration-inventory.ts:891-901`):

> a MIDI DEVICE BINDER with a typed note-number field for the gate tap: permission
> gesture, live device roster, channel/mode selection. No params, and the one numeric
> field is typed entry.

Every clause is accurate. **None of them is bespoke any more**, and three of the four were
answered by a merged PR:

| clause | shipped answer |
|---|---|
| permission gesture | a ranked `ShellActionCell` — `midiclock-cell-actions.ts`, whose header is the whole argument |
| live device roster | a `status-primitive` `fullViewBody` — `MidiclockDeviceBody.svelte`, `shell-extension.ts` |
| channel/mode selection | **fixed rosters known when the def is authored** ⇒ ordinary params with `options` (§5) |
| the typed note field | a **128-entry named roster** ⇒ an ordinary param, no typed cell anywhere on the face (§5.4). ⚠ The gate in §0.3 is about the LEGACY CARD, not about this |

**So the honest disposition after promotion is `generic-face`** — which leg 1 of §0.3
forces anyway.

---

## 3. THE FACE

```ts
export const MIDI_LANE_FACE: ModuleFace = {
  glyph: 'none',                        // §3.2 — mechanically forced
  extension: 'midiLane',
  order: [
    'midilane-connect-{n}',
    'channel', 'mode', 'priority', 'retrig',
    'cc_a_num', 'midilane-learn-a-{n}',
    'cc_b_num', 'midilane-learn-b-{n}',
    'note_gate_note',
  ],
  bandFocus: { … },                     // §4 — mono-only bands, and it needs `mode` to be a PARAM
  pages: [
    { id: 'bind',  label: 'bind',  hint: '…', controls: ['midilane-connect-{n}'] },
    { id: 'voice', label: 'voice', hint: '…', controls: ['channel','mode','priority','retrig'] },
    { id: 'cc',    label: 'cc taps', hint: '…', controls: ['cc_a_num','midilane-learn-a-{n}','cc_b_num','midilane-learn-b-{n}'] },
    { id: 'note',  label: 'note gate', hint: '…', controls: ['note_gate_note'] },
  ],
};
```

**FOUR bands. NO tab rail** — `DOCK_TAB_MIN_BANDS` is 7 and `face.tabbed` is
owner-instruction-only (`graph/types.ts`, `tabbed`'s doc-comment: *"A face with 3-6 honest
pages renders as a column, and that is correct"*). Nothing is padded to reach it.

**The ranking, argued from the module rather than from the card's layout:**
CONNECT first (nothing works before it — `midiclock`'s exact argument, and the reason its
gesture reaches the lane); then CHANNEL, because *"one MIDI channel = one instrument"* is
what the module is FOR (`midi-lane.ts:6-11`) and a lane pointed at the wrong channel is
silent; then MODE, which decides whether the mono jacks are live at all; then the CC taps
and the drum note, which are per-patch refinements.

### 3.1 ⚠ THE PRECURSOR — SEVEN SETTINGS MIGRATE FROM `node.data` TO PARAMS, and `midiclock` already shipped the pattern

**A face must RANK every control, and `midiLane` has `params: []`.** Everything is
`node.data`. There are two routes and the tree has already chosen one.

**Route A — `SHELL_CELLS` static keys over `node.data`.** Legal: `ShellSelectorCell`
(`shell-cells.ts:176-184`) and `ShellToggleCell` (`:341-346`) both read and write via
`(node) => …` / `(nodeId, value) => …` closures and are used exactly this way today.

**Route B — make them PARAMS.** ⚠ **This is what `midiclock`'s face PR actually did**, and
it says why at the line. `MidiclockCard.svelte:100-107`:

> *"⚠ **A PARAM NOW, NOT A `node.data` KEY.** `setNodeParam` is the ordinary origin-tagged
> seam every knob writes through, so the division is undoable and reaches automation /
> MIDI learn / a group like any other value."*

and the def's `explanation` generalises it into a rule (`midiclock.ts:332`):

> *"Two settings, and they are deliberately different kinds of thing: **the DIVISION is a
> param, so it can be automated, MIDI-learned, exposed on a group and undone like any
> other value; the DEVICE is not, because its roster lives behind the browser's own MIDI
> permission and differs on every machine.**"*

**That rule partitions `midiLane`'s eight `node.data` keys perfectly**, and the partition
is not a judgement call — it is "is the roster fixed when the def is authored?":

| key | roster | → |
|---|---|---|
| `channels` | ALL + 1..16 | **param `channel`** (§5.1) |
| `priority` | last / low / high | **param `priority`** |
| `retrig` | on / off | **param `retrig`** |
| `mode` | mono / poly | **param `mode`** |
| `ccA`, `ccB` | none + CC 0..127 | **params `cc_a_num`, `cc_b_num`** |
| `noteGateNote` | MIDI 0..127 | **param `note_gate_note`** (§5.4) |
| `lastDeviceId` | **the machine's MIDI inputs** | **stays in `node.data`**, written through `mutateNode` |

**The back-compat shape is `midiclock`'s, copied exactly** — params FIRST, then the legacy
`data` key, and **the legacy key is never written back** (`midi-lane.ts`'s factory reads
`savedData` at `:335`; the new read order is `MidiclockCard.svelte:42-56` and
`midiclock.ts:356-370` verbatim, including the reason: *"Reading params first means a NEW
value always wins over a stale legacy one, and falling through to `data` means an OLD rack
keeps"* its author's setting).

⚠ **ONE THING GENUINELY NARROWS, and it narrows a capability NO UI HAS EVER OFFERED.**
`MidiLaneData.channels` is `number[] | null` — a multi-channel Set the engine really
supports (`expandLaneChannels`, `:127-134`). A `ParamDef` is a scalar, so a `channel` param
is ALL-or-one. **The card already only offers ALL-or-one**: `onChangeChannel`
(`MidiLaneCard.svelte:112-117`) writes `null` or `[n]`, and `channelLabel` (`:179-181`)
collapses any multi-channel array back to `'all'` — with a comment saying so
(*"v1 of the card surfaces the single-channel + ALL choices"*). So the param makes the
DECLARATION honest rather than removing an affordance. **The engine keeps its Set**, and a
saved rack holding `data.channels: [2,3]` keeps demuxing both, because the factory falls
through to the legacy key. Named, not hidden.

**Alternative if the owner refuses the contract change:** Route A is a complete fallback —
six `SHELL_CELLS` entries over `node.data`, no contract-lock diff, no push card, and
`bandFocus` unavailable (§4). Everything else in this spec is unchanged.

### 3.2 `glyph: 'none'` — mechanically forced, exactly as wave 5 established for the cohort

`primaryAudioOutPortId` is `outputs.find(o => o.type === 'audio')?.id`, **`type === 'audio'`
exactly** (`shell-glyph-live.ts:111-113`). `midiLane`'s seven outputs are
cv / gate / cv / cv / cv / gate / polyPitchGate (`midi-lane.ts:270-282`) — **no `audio`
port** — so `glyphBinding` cannot reach `live-audio`, every other literal falls through to
`{ kind: 'static' }`, and `module-face-lint`'s dead-glyph clause reddens it
unconditionally. Wave 5 `BINDERS.md §5` established this for four modules; `midiLane` is
the fifth and it is the same mechanism, cited rather than re-derived.

⚠ **The glance a player wants is `midiclock`'s and `midiCvBuddy`'s glance** — *is a device
bound, and are notes arriving?* — a BINDING STATE plus an EVENT RATE, which none of the
five `VALID_GLYPHS` members expresses. **No sixth glyph is invented on a module PR**
(wave 4 refused; wave 5 §5 refused for four more). ⚠ **But the population for that ask is
now MEASURABLY NARROWER than wave 5 left it:** the fifth binder, `es9`, gets a perfectly
good live glyph for free because it moves AUDIO rather than events
(`../es9/spec.md §3.2`). The honest population is **"binders whose payload is EVENTS,"**
not "binders."

### 3.3 Three control families, and the card must GROW their testids

```ts
controlFamilies: [
  { id: 'midilane-connect', label: 'Connect MIDI', kind: 'other', testidPrefix: 'midilane-connect' },
  { id: 'midilane-learn-a', label: 'Learn CC A',   kind: 'other', testidPrefix: 'midilane-learn-a' },
  { id: 'midilane-learn-b', label: 'Learn CC B',   kind: 'other', testidPrefix: 'midilane-learn-b' },
],
```

`module-docs-lint.test.ts:359-375` scans **every card's source** for each declared
`testidPrefix`. `MidiLaneCard.svelte:191`, `:247` and `:255` carry **no testid at all**, so
all three families would redden on arrival. **The honest fix is ADDING the testids to the
card** — precedent `cs-clear-tail` and the four `twotracks-*` — which the card genuinely
has the gestures for. Three `docs.controls` entries are then required too (`midiLane` is in
`STRICT_DOCS`); `midiclock.ts:346` is the prose shape.

⚠ Note the free repair: `midi-lane.spec.ts:35` and `:44` currently find the button by
`getByRole('button', { name: /Connect MIDI/ })` — a text match on a caption. A testid
survives a caption edit.

### 3.4 The `fullViewBody` — role `status-primitive`, and it is `MidiclockDeviceBody` with one lamp changed

`$lib/ui/modules/midiLane/shell-extension.ts` → `MidiLaneDeviceBody.svelte`.

It carries **only** what cannot be a cell:

* **the DEVICE `<select>`** — the roster lives behind `requestMIDIAccess()` and differs per
  machine, so it is neither a `ParamDef` nor an `options` roster
  (`midiclock/shell-extension.ts`, *"a roster is a fixed set known when the def is
  authored"*). Its painted text is a DEVICE NAME, which is a NAME — the `cameraInput`
  precedent;
* **the PRE-CONNECT HINT** and **the PERMISSION-FAILURE line** (§4 rows 5-6);
* **two `StatusLed` lamps** (§4.1).

It carries **no CONNECT button** — the cell owns that, and `MidiclockDeviceBody.svelte`
states why in place: *"A second button on the same plate would be one gesture with two
affordances, which is clutter under 'compact is the default' and, worse, a second thing to
keep in sync."*

⚠ **AND NO `node.data` PICKER STATE IS INVENTED.** `midiclock`'s body writes
`lastDeviceId` through `mutateNode`; this one does the same, which is also §7's `.data`
payment.

⚠ **THE BODY MUST OWN AND RELEASE ITS SUBSCRIPTION** — `$effect` teardown **plus**
`onDestroy`, which is the shipped body's pattern and which its header calls out by name:
*"a body that subscribed without unsubscribing is the node-resource-leak class from the
other side."* `MidiLaneCard.svelte:73-85` already has exactly this shape; port it.

**`EXTENSION_BODY_ROLES` entry, as it would be committed**
(`face-rack-status-source.test.ts:150`; union `:142`; predicates `:557-575`; set identity
`:806-821`):

```ts
midiLane: { role: 'status-primitive', why: 'the MIDI DEVICE BINDING surface — the input-port `<select>` whose roster lives behind requestMIDIAccess() and therefore cannot be a ParamDef `options` set (a roster is a fixed set known when the def is authored, and this one differs on every machine), plus two StatusLed lamps: MIDI (access granted and a device selected) and NOTE (a key is currently held on this lane). ⚠ ITS PAINTED TEXT IS EXHAUSTIVELY: the DEVICE control caption, the device NAMES inside the picker that selects them, the pre-connect instructional hint in a state that has no other content, and the access-failure message — an ERROR, absent whenever nothing is wrong, and it STAYS LOUD for the reason the legacy card records ("the suppressed-prompt case produced NO message at all"). ⚠ THE LEGACY CARD\'S TWO READOUT ROWS ARE GONE: `NOTE C5` and `VEL 100` (MidiLaneCard.svelte:274-283) were labelled derived values at rest — the deleted hero-readout strip\'s exact shape — and both now reach aria-label through the NOTE lamp\'s `detail`. ⚠ NO CONNECT BUTTON HERE: the gesture is a ranked ACTION cell, which is what puts it on the lane tile, and a second affordance for one gesture is clutter plus a second thing to keep in sync. ⚠ NO CANVAS. ⚠ NO SCREEN SWITCH and NO WATCH MARK: the video-screen ruling runs over STRICT_FACES INTERSECT video defs and this is domain audio, and markWatched is a VideoEngine pull-set concept this module has no part in.' },
```

Predicate: imports `StatusLed` ✓, mounts no `<canvas>` ✓ ⇒
`ROLE_PREDICATE['status-primitive'].holds` is satisfied. `why` far exceeds the 40-char
floor (`:799-804`). Role is one of the three the union already defines, so the
set-identity leg is untouched.

⚠ **`face.rackStatus` is NOT declared.** It is for a face showing a property of the PATCH
with `primaryOnlyBands` suppression on non-primary peers (`graph/types.ts`). `midiLane` is
deliberately multi-instance and every instance is independent — there is no shared
resource and no primary.

---

## 4. `bandFocus` — the MODE-GATED BANDS, and it is the second reason `mode` must be a param

`MidiLaneCard.svelte:228-242` wraps PRIO and RETRIG in `{#if mode === 'mono'}`, and the
card is right to: in POLY mode neither does anything. Measured —
`buildPolyLanes(heldKeysInPressOrder, bendVOct)` (`midi-lane.ts:170-176`) takes **press
order** and never consults `priority`, and `retrig` only dips the **mono** gate.

**A face that renders two live-looking dials wired to nothing is worse than the card it
replaces.** That is `cvBuddy`'s exact argument for `rackStatus.primaryOnlyBands`
(`graph/types.ts`: *"without it, promotion turns two hidden controls into two live-looking
ones that change nothing"*).

`face.bandFocus` is the mechanism — *"a param's VALUE decides which control bands render …
⚠ IT IS STRUCTURE, NOT TEXT, which is why it is free under the resting-text rulings"* —
and it reads a **PARAM**. With `mode` in `node.data` it is unavailable. So:

```ts
bandFocus: { param: 'mode', /* … showAllOn per FaceBandFocus */ },
```
splitting `voice` into `voice` (channel, mode) and `mono` (priority, retrig, focused on
`mode === 0`).

⚠ **This grows the band count from 4 to 5** and adds a `faces-parity` obligation: that
sweep drives a face into a declared `showAllOn` value first, *"so a freshly opened
faceplate renders ONE band, and `faces-parity`'s 'every param renders exactly one cell'
would go RED on a correctly-working module"* — and `mono` is the DEFAULT
(`DEFAULT_DATA.mode = 'mono'`, `:232`), so at rest both bands render and nothing is
hidden on the fresh-spawn dock baseline. Gate: `band-focus-model.test.ts` plus the parity
sweep's focused-absence leg.

**If the owner refuses the param migration (Route A), drop `bandFocus` and render PRIO
and RETRIG unconditionally** — a small, named regression against the card, and the only
thing in this spec that depends on the choice.

---

## 5. THE PARAMS — rosters, primitives, and the two gates they touch

### 5.1 `channel` — and it needs sixteen `NUMERIC_LABEL_EXEMPTIONS` entries

```ts
export const MIDI_LANE_CHANNEL_CHOICES = [0, 1, 2, /* … */ 16] as const;   // 0 = ALL
{ id: 'channel', label: 'Ch', defaultValue: 0, min: 0, max: 16, curve: 'discrete',
  options: [{ value: 0, label: 'ALL' }, …Array.from({length:16},(_,i)=>({ value: i+1, label: String(i+1) }))] }
```

17 options for 17 discrete steps ⇒ **DENSE**, so plain `options` and **no
`optionsExhaustive`** (the gate refuses a redundant declaration by name — see §5.3).
`paramCellKind` → `'selector'` at the dock (17 > `SEGMENTED_MAX_OPTIONS` = 6,
`shell-control-kind.ts:128`, `:312-315`) and `'knob'` in the lane.

⚠ **`face-readout-source.test.ts`'s LEG 2 FIRES ON THIS PARAM.** `looksNumeric` is
`/^[+\-−]?[0-9]+(\.[0-9]+)?\s*[a-zA-Z%°¢×x]{0,3}$/` (`:572`), and the labels `1`…`16`
match it. **The right answer is the shipped one: keep the numbers and take the exemption**,
because the number IS the name — the `cvBuddy/ppqn` and `timelorde/swingSource`
precedents, both of which chose the number over an invented word. Derive it from the
roster constant, never type sixteen lines:

```ts
...MIDI_LANE_CHANNEL_CHOICES.filter((n) => n > 0).map((n) => ({
  type: 'midiLane', param: 'channel', label: String(n),
  why: `A MIDI CHANNEL NUMBER — ${n} is not a reading of the dial, it is what the channel is `
     + 'CALLED. The whole module exists for the DAW-style workflow "one MIDI channel = one '
     + 'instrument", so a player says "the bass is on channel 3" out loud and sets the same '
     + 'number on the hardware sequencer\'s track; the two surfaces must print the same word or '
     + 'the setting stops naming anything. There is no name for channel 3 that is not "3", and '
     + 'inventing one would be the vocabulary invention the moog904c review declined. ALL is the '
     + 'one member that HAS a name, and it carries it.',
})),
```

The exemption list is **ANCHORED to a live `(type, param, label)` triple**, and the file's
own instruction applies: *"POPULATE IT FROM A SWEEP, NOT FROM THE RED LINE."* Deriving from
the exported constant satisfies both directions at once.

⚠ **`ALL` needs no entry** — `looksNumeric('ALL')` is false.

### 5.2 `mode`, `priority`, `retrig`, `cc_a_num`, `cc_b_num` — all clean

| param | shape | dock cell | Leg-2 exposure |
|---|---|---|---|
| `mode` | `0..1 discrete`, options `MONO` / `POLY` | `segmented` | none |
| `priority` | `0..2 discrete`, options `LAST` / `LOW` / `HIGH` | `segmented` | none |
| `retrig` | `0..1 discrete`, default **1** | ⚠ `looksLikeToggle` requires `defaultValue === 0` for the *switch* shape, but `paramCellKind` returns `'toggle'` from `looksLikeToggle(p)` alone (`shell-control-kind.ts:316`) — so declare `options` `OFF`/`ON` and it renders `segmented`, or omit them and let it be a toggle. **Prefer the toggle**: it is what the card draws (`:239`) | none |
| `cc_a_num`, `cc_b_num` | `0..128 discrete`, `0 = NONE`, `n = CC n-1`, labels `NONE`, `CC 0`…`CC 127` | `selector` | none — `looksNumeric('CC 1')` is **false** (the pattern requires a leading digit) |

⚠ **The `✕` CLEAR buttons (`MidiLaneCard.svelte:250`, `:258`) DO NOT BECOME CELLS.**
Clearing a tap is `NONE` in the same selector that sets it, so two affordances collapse
into one — "compact is the default" applied honestly rather than by dropping something.
Parity is preserved: every value the ✕ reaches is reachable.

⚠ **`LEARN` DOES stay a cell**, one per tap, because it is a *gesture* (bind the next CC
seen) and not a value. Its `ShellActionCell.probe` is `{ kind: 'audition' }` — an action
writes nothing to the graph, so `readParam`/`readData` are blind and `delivered: false` is
recorded rather than dropped (`midiclock-cell-actions.ts`'s argument, and
`shell-cells.ts:247-259` makes `probe` REQUIRED for exactly this reason).

⚠ **`learningCcA/B` — the `WIGGLE…` caption flip (`:248`, `:256`) is REFUSED.** A caption
that changes with state is the shape `StatusLed`'s contract denies at the call site. The
learn-armed state becomes the **`class:learning` highlight the card already has** (`:367-371`),
i.e. a non-text mark carrying the same signal — wave 5 §2.1's activity-dot reasoning and
`midiOutBuddy`'s `data-ch-override` outline, applied. ⚠ **What narrows:** the word
`WIGGLE…` told a first-timer what to DO. That sentence moves to the family's
`docs.controls` prose and to the cell's `title`/`aria-label`, and it is a real reduction
at rest — named, not lapsed.

### 5.3 ⚠ THE `optionsExhaustive` SNAP CONTRACT DOES **NOT** BIND ANY OF THESE — and declaring it would be RED

Every roster above is **DENSE**: one option per reachable discrete step. The gate refuses
a redundant declaration in words (`param-vocabulary.test.ts`, the *"an exhaustive roster is
SPARSE, in-range, unique and fully labeled"* leg):

```ts
if (opts.length === steps) {
  bad.push(`${type}.${p.id}: roster covers every step (${opts.length}/${steps}),
            so optionsExhaustive is redundant — delete it`);
}
```

And the SNAP obligation has nothing to repair: `snapToOptions` exists because a lane knob
over a **sparse** roster can land between members (`midiclock`'s divisor — five legal
values in a 1..24 span, nineteen illegal integers, `midiclock.ts:143-154`). Over a dense
roster every reachable integer is already a member.

**This is the same correction the sibling spec makes** (`../es9/spec.md §3.1`): the SNAP
contract keys on the DECLARATION, not on "discrete param with options." Two of this
agent's two modules were briefed as SNAP cases and neither is one.

### 5.4 ⚠ `note_gate_note` — the typed field becomes a NAMED ROSTER, and it reaches the LANE

```ts
{ id: 'note_gate_note', label: 'Note', defaultValue: 36, min: 0, max: 127, curve: 'discrete',
  options: Array.from({ length: 128 }, (_, m) => ({
    value: m, label: noteNameForMidi(m),          // $lib/audio/note-entry:109-116 → 'C1', 'F#3', …
    title: `MIDI note ${m}${m === 36 ? ' — GM kick' : ''}`,
  })) }
```

**128 options for 128 discrete steps — dense, `selector` at the dock, `knob` in the lane.**
Precedent for a large runtime-scale roster in a cell: `milkdrop-preset-select-{n}`
(`shell-cells.ts:713-720`), which is *larger* and reads the live engine.

**This is the direct answer to the brief's §6 question — "check whether the field needs to
be reachable in a LANE, because that is the case the blocker genuinely covers."** It does,
and **it is**: a `selector` cell is not dock-restricted (only `panel` is —
`curated-face.ts`'s `panelCellKeys` filters on `kind === 'panel'`; `midiclock.ts:278-284`
spells out the mechanism). So `midiLane` clears `needs-note-entry-cell` by a **third,
stronger route** than either wave 5's `score` (which types nothing) or wave 6's slot
argument (which puts an `<input>` in a body): **it needs no typed entry anywhere on the
face, in any tier.** The blocker keeps meaning what it says, for modules that genuinely
need free typed text in a lane — `sequencer`, `drumseqz`, `sticky`, `textmarquee`, the
four the gate's own positive control names (`face-migration-inventory.test.ts:529-536`).

⚠ **AND THIS IS WHY §0.3 IS A GATE PROBLEM AND NOT A DESIGN PROBLEM.** The face needs no
typed entry. The gate reads the **legacy card**. Route (a) — replacing the card's
`<input type="number">` with the *same* `<select>` roster the face uses — is therefore not
a compromise; it is making both surfaces use the control the module should have had, and
`midiclock` did exactly this to `divisor` in its own face PR.

⚠ **ONE THING NARROWS, and it is named rather than lapsed.** The card shows the NUMBER
(`36`) beside the name (`:263-271`); the face shows the NAME only, because a MIDI note
number under a control is the value of the control — the readout the ruling deletes — and
the note NAME is the permitted form. **Drum programmers think in numbers** (the def
defaults to *"GM kick = 36"*, `:235`). The number survives in each option's `title` and in
`aria-valuetext`, and the family's `docs.controls` prose names the GM mapping. Real
reduction, stated.

⚠ And `looksNumeric('C1')` is **false** (leading letter), so **no Leg-2 exemption** —
which is a second, independent reason to label by name rather than by number.

---

## 6. EVERY READOUT THE CARD PAINTS TODAY

| # | what it is | where | verdict | replacement | the finding |
|---|---|---|---|---|---|
| 1 | `NOTE  {activeNoteLabel}` — the last note as a name, `—` when none | `MidiLaneCard.svelte:274-278`, derived `:176-178` | ⛔ **REMOVED.** A labelled derived value at rest — the deleted hero-readout strip's exact shape, and wave 5 `BINDERS.md §2` row 1 verbatim | **NOTE lamp** `lit={lastNote !== null}`, note+velocity in `detail` → `aria-label` | §6.1 |
| 2 | `VEL  {cardState.lastVelocity}` | `:279-282` | ⛔ **REMOVED.** A raw count | same lamp's `detail` | §6.1 |
| 3 | `{ccA === null ? '—' : ccA}` / same for B — the assigned CC number | `:246`, `:254` | ⛔ **REMOVED as a separate readout**, and it removes itself: it becomes the SELECTOR's own displayed option (`NONE` / `CC 1`), which is an option NAME inside the control that selects it | the `cc_a_num` / `cc_b_num` cell | — |
| 4 | `WIGGLE…` / `LEARN` button caption flip | `:248`, `:256` | ⛔ **caption FIXED to `LEARN`**; the armed state becomes the existing `class:learning` highlight (`:367-371`) | a non-text mark | §5.2 |
| 5 | `Permission denied or browser unsupported.` | `:195` | ✅ **KEPT** — an ERROR, absent whenever nothing is wrong, and `MidiclockDeviceBody.svelte` permits it by name (*"⚠ AND IT STAYS LOUD"*). ⚠ **And it is FIXED here** — see §6.2 | — | — |
| 6 | `Class-compliant USB-MIDI (Reliq / Programm / ZOIA) appears here. One-time grant per origin.` | `:197` | ✅ **KEPT** — instructional copy in an EMPTY state, the shipped body's own permitted role | — | — |
| 7 | `DEVICE / CH / MODE / PRIO / NOTE#` captions, `CC A` / `CC B` | `:201`, `:211`, `:221`, `:230`, `:262`, `:245`, `:253` | ✅ **KEPT** as CONTROL CAPTIONS | — | — |
| 8 | option text inside the selects — device names, `ALL`, `1`…`16`, `MONO`/`POLY`, `LAST`/`LOW`/`HIGH` | `:205`, `:213-216`, `:223-224`, `:232-234` | ✅ **KEPT** — option NAMES inside the control that selects them, the settled discriminator | — | — |
| 9 | `{noteNameForMidi(noteGateNote)}` beside the number field | `:271` | ✅ **KEPT**, and it becomes the option label itself (§5.4) | — | — |
| 10 | the number `{noteGateNote}` in the `<input>` | `:263-270` | ⛔ **REMOVED as a painted number** (§5.4); the field itself is §0.3's subject | option `title` + `aria-valuetext` | §5.4 |
| 11 | `RETRIG` text beside the checkbox | `:240` | ✅ **KEPT** — the toggle's caption | — | — |

**Eleven rows, five removals.** ⚠ **`face.bareCells` is NOT declared.** The mixmstrs rule
is *"a caption is clutter when a section heading already conveys it"*; `CC A` and `CC B`
under a `CC TAPS` heading are the tidyVco `A`/`D`/`S`/`R` case — the only thing separating
two identical controls — so they stay.

### 6.1 The NOTE lamp, and what a lit dot buys that two rows do not

```svelte
<StatusLed caption="NOTE" lit={cardState.lastNote !== null}
           detail={midiLaneNoteDetail(cardState)} testid="midilane-led-note-{nodeId}" />
<StatusLed caption="MIDI" lit={cardState.connected}
           detail={midiLaneDeviceDetail(cardState)} testid="midilane-led-midi-{nodeId}" />
```

Both `detail` strings come from a **pure model file beside the body**, for the reason
`MidiclockDeviceBody.svelte` gives: *"An unpainted string that is wrong is invisible to a
VRT baseline and to a human reading one, so they are decided where a unit test can read
them."* `midiLaneNoteDetail` composes rows 1-2:
`"C5 held, velocity 100"` / `"no key held on this lane"`.

⚠ **THE NARROWING IS WAVE 5's, AND IT IS THE SAME ONE.** `BINDERS.md`'s midiCvBuddy mock
states it exactly: *"It answers 'is anything arriving?' and not 'what?'. A wrong-channel
keyboard is still diagnosable (dot dark); a wrong-OCTAVE keyboard is not."* That holds
here and is the ruling's intended trade — with one mitigation `midiCvBuddy` did not have:
`midiLane`'s failure mode is usually the CHANNEL, and the CHANNEL is a ranked cell whose
option name is right there.

⚠ **`lastNote` is NOT LATCHED to `null` — verified before relying on it.**
`MidiLaneCardState.lastNote` is documented as *"Last note received on the lane (MIDI int)
for the readout"* (`midi-lane.ts:198-199`) — i.e. it may be a **latched last value**
rather than a held-key indicator, in which case `lit={lastNote !== null}` would latch ON
after the first note and never go dark, which is a lamp that says nothing.
**The build agent must read `snapshotState()` (`:362`) and bind the lamp to the HELD-KEY
STACK, not to `lastNote`** — `midiOutBuddy`'s dot is `activeNote !== null` for exactly this
reason (wave 5 §2.1). If the held stack is not on `MidiLaneCardState`, adding it is a
one-line change to `snapshotState()` and is part of the face PR. **This is a real
instrument hazard in the design, flagged rather than assumed away.**

### 6.2 ⚠ ROW 5 IS WRONG ON `main`, and the shipped sibling already fixed the same bug

`MidiLaneCard.svelte:194-198` renders `Permission denied or browser unsupported.` whenever
`cardState.permissionDenied` — **one sentence for two different conditions**, and it says
nothing at all about the third: the case where Chromium silently declines to show its own
prompt. `MidiclockDeviceBody.svelte` records the fix and the reason:

> *"The old copy was a one-line hint swap that a user reading a dead button did not
> register — and the suppressed-prompt case produced NO message at all." It comes from the
> shared `midiOutcomeMessage` seam, which always yields a nameable outcome including the
> case where the browser silently declined to show a prompt.*

**The face PR routes `midiLane`'s failure line through the same shared seam.** That is not
scope creep — it is the third module joining a seam that exists, and it is the difference
between a face that says "denied" and one that says which of four things happened.

---

## 7. THE `.data` CENSUS — per CALL SITE, and `midiLane` is the worst instance found so far

Wave 6 established that the per-module binary column cannot express the truth. `midiLane`
proves it in the other direction: **every one of its call sites is bare, and there are
ten.**

`MidiLaneCard.svelte:91-99`:

```ts
function writeData(patch_: Partial<MidiLaneData>): void {
  const target = patch.nodes[id];
  if (!target) return;
  if (!target.data) target.data = {};
  for (const [k, v] of Object.entries(patch_)) {
    if (v === undefined) delete target.data[k];
    else (target.data as Record<string, unknown>)[k] = v as unknown;
  }
}
```

No `ydoc.transact`. No `LOCAL_ORIGIN`. `grep -c LOCAL_ORIGIN MidiLaneCard.svelte` → **0**.
This is **byte-for-byte the third copy** of the helper wave 5 §4 found pasted between
`MidiCvBuddyCard.svelte:89-97` and `MidiOutBuddyCard.svelte:135-143` — which is the more
useful form of the finding: *the raw-write pattern propagates by copy through a cohort
whose members are deliberate siblings.*

**Ten call sites, all bare:**

| # | call site | key(s) | severity |
|---|---|---|---|
| 1 | `onChangeDevice` `:104` | `lastDeviceId` | the exact key `midiclock` fixed |
| 2 | `onChangeChannel` `:116` | `channels` | changes which track plays |
| 3 | `onChangePriority` `:122` | `priority` | |
| 4 | `onToggleRetrig` `:128` | `retrig` | |
| 5 | `onChangeMode` `:134` | `mode` | changes which JACKS are live |
| 6 | `onChangeNoteGate` `:141` | `noteGateNote` | |
| 7 | `onClearCcA` `:146` | `ccA` | |
| 8 | `onClearCcB` `:147` | `ccB` | |
| 9 | ⚠ **`$effect` `:154-156`** | `ccA` | **a reactive-effect write mirroring ENGINE state into the Y.Doc** |
| 10 | ⚠ **`$effect` `:157-159`** | `ccB` | same |

**Cmd-Z undoes none of them**, because `store.ts` tracks `trackedOrigins=[LOCAL_ORIGIN]`,
and `mutate.guard.test.ts` cannot see any of them, because all three of its patterns anchor
on the literal token `.params` (wave 4's finding, wave 5 §4's citation).

⚠ **Sites 9-10 are a shape the census has not recorded before.** They are not user
gestures — they are `$effect`s that mirror the engine's authoritative CC assignment back
into `node.data` whenever it diverges. The guard against churn is
`if (engineStateLoaded && cardState.ccANum !== ccA)`, which is real. But **an effect-driven
Y.Doc write fires on every peer whose card is open**, and being untagged it is *also*
outside undo — so a LEARN performed by one collaborator writes the document from N
machines. That is the automation-assign hazard the janitor origins exist for
(`CVBUDDY_JANITOR_ORIGIN`'s comment: *"undo-tracking it would plant phantom undo items on
every OTHER client"*), arriving from the other direction: this one is neither tagged nor
deliberately untagged, it is just untagged.

**The precursor in §3.1 dissolves sites 2-10 entirely** — they become `setNodeParam`, the
ordinary origin-tagged seam. Site 1 becomes `mutateNode`, copying
`MidiclockDeviceBody.svelte:113-121` and `MidiclockCard.svelte:88-97`. ⚠ **BOTH surfaces**
— the legacy card too, or the two disagree about whether picking a device is undoable.

### 7.1 ⚠ CORRECTION TO WAVE 5's RUNNING TOTAL: `midiclock` IS PAID

Wave 5 `BINDERS.md §4` lists *"five modules writing `.data` untagged (`kria`, `audioOut`,
`midiclock`, `midiCvBuddy`, `midiOutBuddy`)"*. **`midiclock` is off that list**, and the
face PR is what paid it — on **both** surfaces (`MidiclockDeviceBody.svelte:113-121` and
`MidiclockCard.svelte:88-97`, whose comment quotes the old bare write verbatim).

**The running total, corrected and extended:**

| state | modules |
|---|---|
| ✗ untagged | `kria`, `audioOut`, `midiCvBuddy`, `midiOutBuddy`, **`midiLane` (10 sites, 2 of them reactive effects)** |
| ✓ tagged | `picturebox`, `matrixMix`, `chromaconsole`¹, **`midiclock`** |
| n/a | `twotracks`, **`es9`** |

¹ transacts without `LOCAL_ORIGIN` — atomic but outside undo (wave 5 §4).

**And the generalisable finding is the one `midiclock` demonstrated: a face PR is the
natural place to pay a module's `.data` debt**, because the body has to write the same keys
anyway. This is what "boy-scout when you touch it" looks like when the mechanism is
`mutateNode`.

---

## 8. WIDTH — NOT EARNED, and no exemption is requested

The gate is `bodyW - contentW ≤ FACE_WIDTH_SLACK_MAX_PX` (40 px), modes at 15 px and
32-33 px (`workflow-shell-faces.spec.ts`, the `FACE_WIDTH_SLACK_MAX_PX` block); the source
half is `face-width-source.test.ts`, whose `PLATE_FLOOR_EXEMPTIONS` is **empty**.

**The measurement:** `MidiLaneCard.svelte:290` is `width: 230px`, with a 42 px caption
column (`:321-327`) and a 56 px `.note-num` (`:338`). The face's widest band is `cc taps`
— two selectors plus two action buttons — and its selectors are the same primitive
`midiclock`'s `divisor` band renders, whose dock baseline (`face-midiclock-dock.png`) is
the thing to measure against.

**No live picture, no scope trace, no video preview, no XY pad** — the four things the
ruling names as genuine earners. `face.hero` is not declared. **Nothing earns width, so
`face-width-source.test.ts` gets no entry — which is the point.**

⚠ One measured caution for the build agent: the DEVICE `<select>` in the body must carry a
`max-width` the way the shipped one does (`MidiclockDeviceBody.svelte`'s
`.row select { max-width: 190px }`), because a Windows WinMM roster **duplicates its device
names** and can produce a very long option string (the `launchpad-windows-dual-port`
finding). A body that lets one option set the plate width is a face whose width is decided
by someone else's driver.

---

## 9. THE FOUR GATES + THE SNAP CONTRACT + THE FIFTH

| # | gate | file:line | what `midiLane` must do |
|---|---|---|---|
| 1 | face lint / `STRICT_FACES` | `module-face-lint.test.ts`; `strict-faces.ts:10-21` | Author a COMPLETE `face` (every param + all three family templates in `order`) and add `'midiLane'` to `STRICT_FACES` in the same PR. Asserted EQUAL to the set of defs declaring a `face`, both directions |
| 2 | VRT baselines | `e2e/vrt/_shell-faces.ts` (`FACES` at `:34`); `task vrt:commit` | Add `{ type: 'midiLane', pages: 4 }` (5 with `bandFocus`). **3 files** (§10). Delete `midiLane` from `EXEMPT_FROM_VRT` (`vrt-exemptions.ts:774`) **and** from `ALLOWED_PERMANENT_EXEMPT` (`:1223`) — `vrt-meta.test.ts:365` asserts the two are SET-EQUAL, so leaving either behind is RED |
| 3 | `EXTENSION_BODY_ROLES` | `face-rack-status-source.test.ts:142`, `:150`, `:557-575`, `:806-821` | Role **`status-primitive`**, `why` as written in §3.4. Predicate: imports `StatusLed`, no `<canvas>` ✓ |
| 4 | `module-docs-lint` FAMILY↔CARD | `module-docs-lint.test.ts:359-375` | ADD `data-testid="midilane-connect-{id}"`, `midilane-learn-a-{id}`, `midilane-learn-b-{id}` to `MidiLaneCard.svelte:191`, `:247`, `:255`. **Never drop the family.** Plus three `docs.controls` entries |
| **5** | ⚠ **`face-migration-inventory.test.ts`'s THREE INTERLOCKING LEGS** | `:229`, `:268`, `:509-528` | §0.3. This is the one no previous wave listed, and it is the only gate in this table that a face cannot satisfy by design work |

**Plus the `optionsExhaustive` SNAP contract**: **DOES NOT APPLY, and declaring it would
be RED.** §5.3.

**Plus `face-readout-source.test.ts` LEG 2**: 16 derived `NUMERIC_LABEL_EXEMPTIONS` entries
for `channel`'s numeric labels, and **only** those. §5.1.

---

## 10. VRT — 3 FILES, and the drain argument is `midiclock`'s, verbatim

### 10.1 ⚠ WHAT ACTUALLY HAPPENED TO THE "SAME RATIONALE AS `midiCvBuddy`" BLOCK — and it CORRECTS wave 5 §6

Wave 5 `BINDERS.md §6` concluded:

> *"It is one rationale, written once, referenced four times. **Discharging it at the root
> discharges it for the cohort.** Whichever way it goes, the decision should be made once
> at `midiCvBuddy` rather than four times."*

**That is not what happened, and the tree now says the opposite in writing.** `midiclock`
was drained — a LEAF, not the root — and the drain commit left a comment in the block
(`vrt-exemptions.ts:751-767`) that rules against wave 5 by name:

> *"⚠ **THE OTHER THREE ENTRIES IN THIS BLOCK ARE UNCHANGED, DELIBERATELY.**
> `midiCvBuddy`, `midiOutBuddy` and `midiLane` say "same rationale as midiCvBuddy", so ONE
> argument is written once and referenced four times. **Discharging it here does NOT
> discharge it there**: each of those cards paints its post-Connect surface differently and
> none of them is promoted, so the decision has to be made at each on its own evidence.
> **Falsifying the rationale for one module is not falsifying it for the module it was
> written about.**"*

**Report it as a correction, and note that the tree's version is the better one.** The
shared *sentence* is not shared *evidence*: `midiCvBuddy`'s post-connect card and
`midiLane`'s post-connect card really are different pictures, and a drain is a claim about
a specific capture. What IS shared — and what wave 5 got right — is the **pre-connect
argument**, which is a claim about a *mechanism* (`requestMIDIAccess` is never called
without a click) and which does transfer intact. So the right generalisation is narrower
than wave 5's and wider than the comment's: **the mechanism transfers, the capture does
not.**

**Status of the block after `midiclock`:** `midiCvBuddy` (`:745`, the root — still
exempt), `midiOutBuddy` (`:746-750`), `midiLane` (`:769-774`). Three left, and this spec
drains one of them. ⚠ **The ROOT is still undrained**, so a reader arriving at `:745` still
finds the original rationale with no note that a sibling falsified its second clause. A
one-line cross-reference at `midiCvBuddy` would be a cheap, honest improvement and rides
this PR.

### 10.2 The file count

`vrt.spec.ts:52` builds `COVERED_MODULES` as
`REGISTRY.filter(m => !(m.type in EXEMPT_FROM_VRT))`, so the drain enrols the **legacy
card** too. Measured against what `midiclock`'s drain actually produced (all three present
on `main`):

| file | sweep |
|---|---|
| `e2e/vrt/__screenshots__/vrt.spec.ts/midiLane.png` | the legacy-card sweep |
| `…/workflow-shell-faces.spec.ts/face-midiLane-compact.png` | the face sweep |
| `…/workflow-shell-faces.spec.ts/face-midiLane-dock.png` | the face sweep |

**Predicted: 3.** Count what the bot commits against this number.

**Other sweeps the drain joins:**

* **`vrt-cable-stripe.test.ts`** — `MidiLaneCard.svelte:185` is
  `<div class="stripe" style="background: var(--cable-cv);">`, so the new legacy baseline is
  pinned to `--cable-cv` and joins the palette gate. It runs in `unit` **and** in the
  REQUIRED `vrt-strict` job under `VRT_STRIPE_PALETTE_REQUIRED=1`. *(This is the sweep wave 6
  saw `midiclock`'s drain surface on #2184 — and `midiclock`'s stripe is the same token
  family, so the precedent is exact.)*
* `vrt-legacy-mask-audit.spec.ts` / `vrt-live-surfaces.test.ts` — `midiLane` declares **no**
  mask and needs none, so both are satisfied by absence.
* `STRICT_VRT_MODULES` — **do not add it in this PR.** `vrt-meta.test.ts:202`/`:212`
  would accept it, but strict membership is a separate deliberate decision.

### 10.3 Why the capture is deterministic — the mechanism, not a bet

`_shell-faces.ts:3352-3372` states `midiclock`'s and every word transfers:

> *"A freshly spawned midiclock has NO MIDI ACCESS: `requestMIDIAccess` is never called
> until someone presses CONNECT, and this scene presses nothing. So the device roster is
> not merely empty, **it does not exist** … ⚠ AND THE UNREACHABILITY IS STRUCTURAL, NOT
> INCIDENTAL … reaching that state requires a gesture this suite does not perform."*

For `midiLane`: `midi-lane.ts:67-69` — *"like MIDI-CV-BUDDY, we DON'T request Web MIDI on
mount. The card calls `connect()` once"* — and the only caller of `api.connect()` in the
product is the CONNECT gesture (`MidiLaneCard.svelte:87-89`; the only other callers in the
tree are `_per-port-drivers.ts:862` and `:927`, which are test drivers). So the scene
captures: the CONNECT cell, the pre-connect hint, two dark lamps, and the four bands'
cells at their defaults. **Every pixel a function of the code.**

⚠ **NO `simPin`, NO `videoFaceWhy`.** `domain: 'audio'` with seven cv/gate/poly outputs and
no canvas anywhere; there is no clock to pin and nothing advances between frames. The lamps
change only when a MIDI message arrives, and none does.

⚠ **What this baseline does NOT cover, stated rather than implied:** the POST-CONNECT
device picker, the CC-learn armed highlight, and the note-held lamp. A mocked roster is
reachable — `_per-port-drivers.ts:882-905` already mocks `requestMIDIAccess` and pumps
notes — but installing that mock in the VRT harness is a change to the HARNESS, not to this
module. Not this PR. Those behaviours are asserted in `midi-lane.spec.ts` and (post-fix) in
the pure model file beside the body.

### 10.4 `FACES_WITHOUT_SCENES` — not needed

`_shell-faces.ts:3472` is the named refusal for a genuinely non-deterministic *renderer*.
`midiLane` has none. Do not take an entry.

---

## 11. THE COST TABLE

| axis | cost | evidence |
|---|---|---|
| **WebGL attest** | **ZERO** | The audio-domain basis is exactly `cube.ts` + `wavesculpt.ts` (`scripts/webgl-attest-lib.ts`, `AUDIO_WEBGL_MODULE_DEFS`). #2186's `paramSpec(def,'x')` rule does not apply |
| **ART** | ⚠ **CHECK THE POLY SUITE.** No ART scenario names `midiLane` today, but the module has a `polyPitchGate` output and the standing rule is *"Poly/chord → FULL `task art`"* because ART pins exact voicing. The face PR changes **no** audio path — but §3.1's `mode`/`priority` migration changes where the factory READS them from, so **run the full ART suite once on the precursor** and expect a byte-identical result | CLAUDE.md; `midi-lane.ts:335-339` |
| **contract-lock** | ⚠ **+10 lines**, and this is the largest cost in the spec | 7 new `midiLane param …` lines (§3.1) + 3 `midiLane family …` lines. `options` and `face` are BOTH unprojected — `ContractParamLike` (`contract-signature.ts`) is `{id, defaultValue, min, max, curve, units}`, `grep -c options contract-lock.txt` → 0, and `contract-lock.txt:1729` renders `midiclock`'s option-bearing `divisor` as a bare line. Run `task docs:accept` and **review the diff** |
| **Push 2 card** | ⚠ **APPEARS WHERE THERE WAS NONE** | `params: []` today ⇒ tier 3 (GENERIC) over an empty list ⇒ **zero strips**. After §3.1, seven turnable params ⇒ **seven encoder strips** ranked by `face.order`. **Do NOT pin a `PUSH_CARD_CONTROLS` override**: seven params against eight encoders is no competition for slots, so the FACE tier already derives the right answer, and an override REPLACES — `midiclock.ts:267-276` makes exactly this argument for exactly this reason |
| **docs / `STRICT_DOCS`** | already strict (`strict-docs.ts:226`); **+10 `docs.controls` entries** (7 params + 3 families) — `docs.controls` is `{}` today (`midi-lane.ts:305`) | `midiclock.ts:344-347` is the shape |
| **`DESCRIPTIONS`** | unchanged, **but see D3** — the existing text is wrong | `module-manifest.ts:370` |
| **VRT** | 3 files, 2 exemption deletions | §10.2 |
| **e2e** | **0 broken.** All four specs that touch `midiLane` run on `?shell=legacy` (§13) | |
| **CI wall-time** | 2 new face scenes ≈ the `midiclock` pair; 1 new legacy row. Under the ~2 min threshold; **still estimate it on the PR** | CLAUDE.md |

---

## 12. THE COHORT ANSWER — do `es9` and `midiLane` share ONE device-binding shape?

**NO. They share a BODY SHAPE and they do not share a BINDING SHAPE, and the discriminator
is the TRANSPORT.**

| | `midiLane` | `es9` |
|---|---|---|
| transport | `navigator.requestMIDIAccess` — a browser permission | **WebSocket to a native helper on a local origin** + Worker + SharedArrayBuffer ring (`bridge-client.ts:50`, `:87`) |
| when the attempt happens | only on a user gesture (`midi-lane.ts:67-69`) | **at node construction, unconditionally** (`es9.ts:378`) |
| what "available" means | granted-once-per-origin, then cached | **a process is running on this machine, right now** — and it must be re-asked forever (`bridge.worker.ts`'s backoff) |
| the roster | **N devices**, per machine ⇒ a picker | **ONE device.** `maxInstances: 1`, *"the native app accepts a single client"* (`es9.ts:212-214`) ⇒ **no picker at all** |
| params | **0** today, 7 after the precursor | **22 today** — the cohort's only module with real params |
| `node.data` | 8 keys, 10 bare call sites | **none** |
| glyph | `'none'`, mechanically forced | **`'meter'`, reachable** — the cohort's only one |
| what the empty state says | *"press CONNECT to grant access"* | *"run the es9-bridge app, then connect"* |
| the VRT problem | the bad state is **unreachable** | the bad state is **the default**, and the ruling deletes it |
| typed-entry gate | ⛔ **RED** (§0.3) | ✅ clean |

**What they DO share, and it is worth being precise about because it is the reusable
part:** both need a `status-primitive` `fullViewBody`, both rank their connect gesture as
an ACTION cell that reaches the lane, both are `'placeholder'` today, both are drainable,
both cost zero attest and zero ART, and both pay their debt in the same PR that adds the
face. **That is the BINDER BODY, and it is now a shipped pattern with two adopters
(`midiclock`, `cvBuddy`) — not a cohort property.**

> ### ⚠ THE DISCRIMINATOR, stated so the next wave can apply it in a minute
>
> **"How does the module learn that its hardware is there?"**
>
> * **A PERMISSION** (`requestMIDIAccess`, `getUserMedia`, `navigator.hid`) → the roster is
>   N-ary and per-machine, the attempt is gesture-gated, the empty state is *ask*, and the
>   VRT capture is free because the bad state is unreachable without a click.
> * **A PROCESS** (a localhost socket to a helper) → the roster is unary, the attempt is
>   unconditional and eternal, the empty state is *install and run*, and the VRT capture
>   has to be EARNED by deleting the retry's own text.
> * **NEITHER** (`controlSurface`, per the orchestrator's measurement) → there is no
>   binding at all and the module is in this cohort by resemblance, not by mechanism.
>
> This is a strictly better cut than "binders", because it predicts the **empty state**,
> the **roster arity**, the **VRT argument** and the **glyph availability** — four
> independent things — from one question anyone can answer by reading the transport.

### 12.1 ⚠ AND IT EXTENDS WAVE 5's §0 AXIS RATHER THAN RE-DERIVING IT

Wave 5 §0 put its three on one axis: *"how much of the module is the binding, and how much
is an instrument on top of it."* `midiCvBuddy` ≈ pure binding; `chromaconsole` = binding +
an eight-slot control surface.

**This pair extends that axis to both ends at once.** `midiLane` sits where
`midiCvBuddy` does — almost pure binding, plus six settings. **`es9` breaks the axis**: it
has more instrument on top (22 routing params, 46 ports) than `chromaconsole`, *and* less
binding under it (one device, no picker, no permission). **So "how much of the module is
the binding" is not one axis — it is two independent ones**, and `es9` is the module that
separates them:

```
              LOTS of instrument on top
                        │
       chromaconsole    │    es9          ← many controls, trivial binding
                        │
  ────────────────────────────────────────  how much BINDING
                        │
       midiCvBuddy      │    (empty)
       midiOutBuddy     │
       midiclock        │
       midiLane         │
                        │
              LITTLE instrument on top
```

The bottom-right quadrant is empty and the top-right has one occupant, which is exactly
why `es9` reads as "bespoke" to a reader who has only seen the bottom-left: it is
unfamiliar along the axis nobody was measuring.

---

## 13. THE e2e SPECS PROMOTION TOUCHES — **none break**

| spec | shell | effect |
|---|---|---|
| `midi-lane.spec.ts` (3 tests) | `rack` ⇒ `?shell=legacy&seed=none` (`_fixtures.ts:91`) | ✅ **unaffected.** All three assert on `.svelte-flow__node-midiLane`, the legacy card. ⚠ Two notes: `:26` checks six handles and **omits `poly`** (a real coverage gap on `main`, D5), and `:47` is a `page.waitForTimeout(300)` that sits in `e2e/waitfortimeout-ledger.generated.txt` — **do not "fix" it in this PR** unless the ledger line is regenerated in the same commit |
| `adsr-poly-midilane.spec.ts` (6 tests) | `rack` | ✅ unaffected — engine-level poly chain assertions, no card DOM |
| `_per-port-drivers.ts` `midiLane` entry (`:882-935`) | engine-driven | ✅ **promotion-proof by construction.** It mocks `requestMIDIAccess` in an init script and drives `read(node,'card-api')` — it never touches the card. ⚠ It calls `api.setCcB(7)` with the comment *"the factory captured ccB at construction, so a post-spawn `node.data` write wouldn't reach it"* — **after §3.1 that stops being true** (a param write reaches `setParam`), so the driver can be simplified, and if it is, verify it still passes |
| `midi-lane.test.ts` (unit) | — | ⚠ **The precursor's real test surface.** It mocks `requestMIDIAccess` and covers the demux; §3.1's param read-order needs its own legs there (params first, legacy `data` fallback, legacy key never written back — `midiclock`'s three) |

**Zero e2e re-points.** That is a strictly cheaper promotion than `es9`'s, which breaks two
(`../es9/spec.md §14`).

---

## 14. DEFECT LEDGER — live on `main`, independent of any face

**D1. ⚠⚠ Ten bare `node.data` writes, two of them from reactive `$effect`s.** §7. Cmd-Z
undoes none of them; `mutate.guard` cannot see any of them; sites 9-10 write the Y.Doc
from every peer with the card open. Third verbatim copy of a helper wave 5 found twice.

**D2. ⚠ The permission-failure line conflates two conditions and misses a third.**
`MidiLaneCard.svelte:194-198`. The shared `midiOutcomeMessage` seam exists and
`MidiclockDeviceBody.svelte` records why it was adopted. §6.2.

**D3. ⚠ `module-manifest.ts:773` is WRONG about `midiLane.poly`, on both of its claims —
and `module-docs-lint` is structurally blind to it.** It says *"Polyphonic chord output
(10-channel polyPitchGate = 5 pitch/gate pairs). Carries signal **only in POLY mode** …
Neutral in MONO mode."* Measured:

* **`POLY_CHANNEL_PAIRS = 16`**, `POLY_CHANNELS = 32` (`poly.ts:36-37`), and
  `MAX_POLY_VOICES = 16` (`midi-lane.ts:163`, whose comment says *"MIDI LANE packs up to 16
  held keys so it can fully drive a 16-voice consumer"*). Not 10, not 5 pairs.
* **The mode claim is the exact opposite of the shipped behaviour**, and the def says so at
  the port: *"Always declared AND always live: it carries the held chord in BOTH modes …
  (#674: poly used to be silent in the default mono mode.)"* (`:277-281`).

⚠ **This is wave 6 §3c's class** — prose describing behaviour the code reversed, in a file
`module-docs-lint` does not read (it reads the DEF). ⚠ **And a THIRD copy is inside the
def**: `docs.outputs.poly` (`:303`) says *"up to 10 voices"*, which IS in the def and is
still wrong, because no gate compares doc prose to code. Two further stale spots:
`midi-lane.ts:38` (*"a 10-channel polyPitchGate"*) and `:329` (*"10-channel polyPitchGate
merger"*). **Five stale statements, one true number.** The face PR fixes all five while
it is in the file.

**D4. `MidiLaneCardState.lastNote` is documented as the LAST note "for the readout", not as
a held-key indicator.** `midi-lane.ts:198-199`. Deleting the readout removes its only
consumer, and binding a lamp to it may latch. §6.1. Not a bug today; it becomes one the
moment the value is reused for a boolean.

**D5. `midi-lane.spec.ts:26` checks six of seven output handles and omits `poly`.** The
one output with a defect history (#674) is the one the handle sweep does not name. One
array entry.

**D6. The engine supports a multi-channel Set that no UI has ever offered.**
`expandLaneChannels` (`:127-134`), `MidiLaneData.channels: number[] | null`, and the card's
`channelLabel` (`:179-181`) collapses any multi-channel array to `'all'` — so a rack that
somehow acquired `[2,3]` displays `ALL` and demuxes two channels. A declaration with no
producer and a display that lies about it. §3.1 makes the declaration honest.

**D7. ⚠ The "same rationale as `midiCvBuddy`" ROOT is still undrained and now carries a
falsified second clause with no note.** `vrt-exemptions.ts:745`. §10.1. A one-line
cross-reference costs nothing and rides this PR.

---

## 15. VERDICT

> ## **PROMOTE-WITH-PRECURSOR — and the promotion is BLOCKED ON ONE OWNER DECISION that is about a GATE, not about this face.**

**The one-line reason:** it is `midiclock` with six more settings and one numeric field;
the body, the connect cell, the glyph, the VRT argument and the `.data` payment are all
transcriptions of a merged PR, and the only thing standing in the way is
`face-migration-inventory.test.ts:509-528` reading the LEGACY card.

| | |
|---|---|
| **PR A (precursor)** | Migrate 7 settings from `node.data` to params with `midiclock`'s params-first read order; `mutateNode` for `lastDeviceId` on **both** surfaces; route the failure line through `midiOutcomeMessage`; fix D3's five stale statements and D5. **~8 h. LOW-MEDIUM risk** — the read-order back-compat is the whole risk and it has a shipped template |
| **PR B (the face)** | `MIDI_LANE_FACE` + `bandFocus` + 3 `controlFamilies` + `midilane-cell-actions.ts` + `MidiLaneDeviceBody.svelte` + `EXTENSION_BODY_ROLES` + `STRICT_FACES` + 3 testids on the card + 10 `docs.controls` + 16 `NUMERIC_LABEL_EXEMPTIONS` + drain both VRT lists + empty `blockers`. **~9 h. LOW risk** |
| **BLOCKER** | §0.3. The face design does not change whichever way the owner rules; only PR B's file list does |
| **Blocks** | Nothing blocks PR A — **and PR A is worth landing on its own merits** even if the promotion is refused, because D1, D2, D3 and D6 are all live |

**Build `midiLane` BEFORE `es9`.** It is the closer heir to the shipped pattern, its
promotion breaks zero e2e specs, and its precursor is a mechanical migration with a
template. `es9`'s precursor touches the hardware safety path (`../es9/spec.md §11`) and
deserves the attention a second slot gives it.

---

## 16. MOCKS

* [`dock.html`](dock.html) — the dock faceplate at rest, PRE-CONNECT: the state every CI
  runner captures and every first-run user sees. Carries the drain argument and the width
  measurement.
* [`dock-bound.html`](dock-bound.html) — the distinguishing state: granted, a device
  picked, a note held, CC A learned and CC B arming.
