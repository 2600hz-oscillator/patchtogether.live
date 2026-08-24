# THE CONTROL-SURFACE COHORT — shared analysis for wave 7

Seven modules: **`controlSurface`, `gamepad`, `launchpadControlLeft`,
`push2Control`, `outToLaunch`, `es9`, `midiLane`.**

**This document is the cohort's shared reasoning.** The seven per-module specs
reference it rather than repeating it seven times. It is the `BINDERS.md` /
`GAMES.md` slot for this wave.

Nothing here is implemented. This is a spec. Measured against `origin/main`
@ `99a961b08`; every claim carries the command or the `file:line` that produced it.

---

## 0. THE COMMISSIONING PREMISE IS FALSE AT THE ROOT

The wave was commissioned on a stated shared design problem: *"a PHYSICAL DEVICE
is the interaction. The roster of devices lives behind a browser API and is READ
from the engine; mapping/assignment is the primary surface, not a knob list."*

**That sentence is not true of this cohort.** It is true of some members, false of
others, and false in four independent ways — each of which is a one-command check,
none of which is an argument.

### 0.1 One member has no device at all

`controlSurface` (`packages/web/src/lib/meta/modules/control-surface.ts`, 34 lines)
is `domain: 'meta'` with `inputs: []`, `outputs: []`, `params: []` and no `docs`.
Its header describes the whole interaction:

> Right-click any MIDI-assignable knob/fader on any module and choose *"Send to
> \<surface\>"* — a POINTER to that control appears on the surface, grouped
> (dotted border + label) under its source module… **Meta domain: no engine
> binding, no ports, no params. All state lives on `node.data`.**

There is no `requestMIDIAccess`, no `getGamepads`, no `navigator.usb`, no
`getUserMedia` anywhere in the def, the card or `$lib/graph/control-surface.ts`.
**It is a TABLE OF BINDINGS between modules that are already in the rack** — its
face problem is a table problem, and its cohort membership is **by NAME ONLY**.
Stated explicitly here so that a later reader does not have to re-derive it.

### 0.2 The other six use FIVE distinct transports

Measured with `git grep -c -E "requestMIDIAccess|getGamepads|requestDevice\(|navigator\.usb|new WebSocket"` over each module's engine layer:

| module | transport | where | permission model |
|---|---|---|---|
| `controlSurface` | **none** | — | — |
| `gamepad` | **Gamepad API**, an rAF-rate POLL | `audio/modules/gamepad.ts` (8 hits) | ⚠ **no prompt at all** — the browser exposes a pad only after the user presses a button on it |
| `midiLane` | Web MIDI | `audio/modules/midi-lane.ts` (1) | one-time-per-origin prompt |
| `launchpadControlLeft` | Web MIDI | `control/launchpad/launchpad-device.svelte.ts` (2) | same |
| `outToLaunch` | Web MIDI (SysEx OUT, via the shared launchpad seam) | `ui/modules/OutToLaunchCard.svelte:36,61` | same |
| `push2Control` | Web MIDI **+ WebUSB** | `control/push2/push2-device.svelte.ts` (2) **and** `push2-display.svelte.ts` (5) | ⚠ **TWO independent grants**, the second optional |
| `es9` | ⚠ **a WebSocket to a NATIVE HELPER** | `audio/es9/bridge-client.ts:50` `es9BridgeUrl()`, `:87` `start(rate, config, url)`, plus a worker and a SharedArrayBuffer ring | ⚠ **no browser permission — an external process must be running, and HTTPS cannot reach `ws://localhost`** |

Five transports, two of which are not device-permission flows in any sense.
`es9`'s availability story — *is a helper process running on this machine?* — has
nothing structurally in common with `gamepad`'s — *has the user pressed a button
on the pad yet?*

### 0.3 Three domains, and the fleet rulings are scoped by domain

`meta` (`controlSurface`, `push2Control`, `launchpadControlLeft`), `audio`
(`es9`, `midiLane`, `gamepad`), `video` (`outToLaunch` — and it is a SINK,
`out-to-launch.ts:97-103`, `inputs: [{id:'in',type:'video'}]`, `outputs: []`).

This is not bookkeeping. The SCREEN ON/OFF ruling runs over
`STRICT_FACES ∩ video defs` (`video-face-screen-source.test.ts`), so exactly one of
the seven is in its scope. `hasVideoSurface` and the free `VideoTileThumb` lane
picture likewise.

### 0.4 The lane is ALREADY split by a shipped carve-out, and nobody has noticed

`legacy-fallback.ts:110-129`, `NON_SHELL_LANE_TYPES` — `group`, `sticky`,
`cadillac`, `clipplayer`, **`controlSurface`**, **`electraControl`**,
**`launchpadControlLeft`**.

| module | in the set? | `laneRenderKind` today | what a face MEANS |
|---|---|---|---|
| `controlSurface` | ✅ | `'legacy'` — the verbatim card | **no shell lane tile exists.** A face is DOCK-ONLY, and promotion means removing it from the set |
| `launchpadControlLeft` | ✅ | `'legacy'` | same |
| `push2Control` | ❌ | `'placeholder'` | a tile exists and is EMPTY; a face fills it |
| `gamepad` | ❌ | `'placeholder'` | same |
| `es9` | ❌ | `'placeholder'` | same |
| `midiLane` | ❌ | `'placeholder'` | same |
| `outToLaunch` | ❌ | `'placeholder'` | same |

Derived from `laneRenderKind` (`:156-160`) with `hasCard` computed by
`isShellSwappable` (`:181-183`) — and note that `LaneRenderInput.hasCard`'s own doc
(`:137-138`) defines it as *"resolves to a real card **AND is not a
`NON_SHELL_LANE_TYPE`**"*, which is why the carve-out routes to `'legacy'` rather
than to a tile.

⚠ **The compact-by-default reasoning is DIFFERENT on the two sides**, and each spec
says which side it is on before it argues width. A module with no lane tile has no
section-heading-versus-caption tradeoff to make — which is precisely why
`face.bareCells` is dock-only.

⚠ **And `push2Control` is on the wrong side of that line by omission, not by
design.** Its own header says *"Modeled on ElectraControl / LaunchpadControl — a
meta-domain control-surface node with no audio cable I/O"* (`push2-control.ts:41-43`),
and both models are in the set while it is not. The consequence is user-visible
today: at plain `/rack` it is a name, a badge and an empty jack rail, and the one
gesture without which it does nothing is dock-only. ⚠ **The fix is the FACE, not
adding it to the set** — `cameraInput`'s removal from that set on promotion
(`legacy-fallback.ts:63-65`) is the shipped direction of travel. Recorded because
*"never added"* and *"deliberately left out"* are indistinguishable from the tree.

### 0.5 So the useful output is not one controller shape

It is per-module and it is checkable: **what does each of these seven actually
bind to, where does its state live, and which side of the lane carve-out is it
on?** The seven specs answer that individually. §1 and §2 are the two things they
genuinely share.

---

## 1. ⚠ THE FIRST REAL CONVERGENCE — SEVEN "PERMANENT" VRT EXEMPTIONS, ONE RATIONALE, AND A DRAIN THAT LANDED TODAY

**All seven are in `EXEMPT_FROM_VRT` AND on `ALLOWED_PERMANENT_EXEMPT`**
(`e2e/vrt/vrt-exemptions.ts` — `:450` `outToLaunch`, `:457` `es9`, `:639`
`controlSurface`, `:686` `launchpadControlLeft`, `:687` `push2Control`, `:774`
`midiLane`, `:868` `gamepad`; the permanent set at `:1205-1226`). **7 of 7.** That
is the cohort's one genuine shared property.

And the stated reason is the same sentence written seven ways: *the card's content
depends on a device that is not present in CI.*

**It is falsifiable, and it was falsified hours ago.** `vrt-exemptions.ts:1216-1222`:

> ⚠ `midiclock` REMOVED 2026-08-24 — **the second drain, after `cvBuddy` above,
> and the first in the MIDI-binder block.** … This list is ANCHORED in both
> directions, so leaving the name here while the module is baselined would be RED
> — which is exactly the property that makes a drain a two-line edit rather than a
> policy discussion.

`midiclock` was on that list, carried the same rationale (its exemption was one of
the four reading *"same rationale as midiCvBuddy"*), shipped a face as #2187, and
now has three committed baselines. **So "permanent" is not an empirical claim about
these modules. It is a record of which ones nobody has drained yet.**

### 1.1 Each spec therefore answers ONE question: what would make ITS module drainable?

That converts a shared excuse into seven separate checkable claims, and it is the
wave's most useful output for whoever drains the third one. The general shape of
the answer, which every spec instantiates rather than inherits:

**A VRT scene controls the spawned patch, and a device is absent in CI by
definition — so the NO-DEVICE state is not a hazard, it is the most deterministic
state the module has.** Several of these exemptions concede it in their own words:
`controlSurface`'s (`:639`) says *"empty state is a blank square"*; `es9`'s
(`:457`) says *"card is static chrome"*, which is not a device-dependence claim at
all.

⚠ **Where a module genuinely cannot be baselined, the answer is a NAMED
`FACES_WITHOUT_SCENES` entry** (`e2e/vrt/_shell-faces.ts:3391`) carrying the
reason — never a silent absence, and never a re-exemption.

### 1.2 ⚠ The cost every spec PREDICTS rather than discovers: a drain is THREE files, not two

`vrt.spec.ts:52` builds `COVERED_MODULES` as
`REGISTRY.filter(m => !(m.type in EXEMPT_FROM_VRT))`, so draining an exemption
enrols the **legacy CARD** as well as the two face scenes.

Verified against the shipped drain —
`git ls-tree -r --name-only origin/main | grep -i midiclock` returns exactly three PNGs:

```
e2e/vrt/__screenshots__/vrt.spec.ts/midiclock.png                              ← the legacy CARD
e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/face-midiclock-compact.png
e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/face-midiclock-dock.png
```

`midiclock` predicted 3 where its own spec had said 2, and was right. Every spec
here predicts its count and checks it against what the bot commits — a green
dispatch that commits nothing is a red flag.

### 1.3 ⚠ And the drain is a TWO-LINE, DOUBLY-ANCHORED edit

`EXEMPT_FROM_VRT` and `ALLOWED_PERMANENT_EXEMPT` must move together:
*"an entry here naming a module that is NOT in `EXEMPT_FROM_VRT` is RED, so a
drained module cannot leave a stale licence to re-exempt itself lying around"*
(`:1197-1199`). Leaving the name behind is a red gate, not a stale comment.

⚠ **One inherited rationale still fans out and should be settled at its root, not
seven times.** Two exemptions still read *"same rationale as midiCvBuddy"*
(`:746` `midiOutBuddy`, `:769` `midiLane`) and one reads *"like
controlSurface/electraControl"* (`:686` `launchpadControlLeft`). Wave 5
`BINDERS.md §6` said the decision should be made once at the root; `midiclock`'s
drain has now made it once, in the direction of draining.

---

## 2. ⚠⚠ THE BLOCKING FINDING — A `face` ON A CARD THAT MOUNTS TYPED ENTRY REDDENS A GATE NO WAVE HAS LISTED, AND WAVE 6's PRESCRIPTION DOES NOT FIX IT

This is the wave's most consequential output. It affects **two modules in this
cohort and all three of wave 6's `needs-note-entry-cell` recommendation targets**,
and it is a live, mechanical, reproducible red — not a design opinion.

### 2.1 The chain, in three legs of ONE file

`packages/web/src/lib/ui/workflow/face-migration-inventory.test.ts`:

1. **`:229`** — *"every def that DECLARES a `face` is dispositioned generic-face"*,
   asserted `toEqual([])` on contradictions, with the reason stated in place:
   *"A module cannot be 'needs a bespoke surface' and ship a curated face at the
   same time."* **So authoring a `face` FORCES `disposition: 'generic-face'`.**
2. **`:268-281`** — *"no generic-face entry names any [blocker]"*:
   `'generic-face' cannot be waiting on a capability`. **So the entry's `blockers`
   array must be emptied at the same time.**
3. **`:509-528`** — the TYPED-ENTRY leg:

   ```ts
   for (const [type, tmpl] of templates) {
     if (!mountsTypedEntry(tmpl)) continue;
     const entry = inventoryEntry(type);
     if (!entry) continue;
     if (entry.disposition === 'generic-face') {
       offenders.push(`${type}: dispositioned generic-face, but its card mounts typed entry
                       — the face system has no text cell (card-primitive-parity: NoteEntry via:none)`);
       continue;
     }
     if (entry.disposition === 'organizational-native') continue; // the text IS the object
     if (!migrationBlockers(entry).includes('needs-note-entry-cell')) { … }
   }
   ```

**Read the control flow.** The `generic-face` branch fires and `continue`s
**before** the code ever looks at `migrationBlockers(entry)`. So **emptying the
blockers array does not help** — that is the branch below it, for modules that are
still bespoke.

⚠ **`templates` is the LEGACY CARD's rendered markup**, resolved once per
registered def (`cardTemplates()`, `:153-170`), with `cardTemplate()` (`:126-133`)
stripping `<script>`, `<style>` and comments. **The legacy card survives
promotion** — it is what `?shell=legacy` renders and what `DockCardHost` mounts for
a non-`face` rail occupant — so nothing about authoring a face removes it from the
scan.

### 2.2 WHO IT HITS — measured, with the instrument validated first

⚠ **The first instrument was wrong and returned a clean, plausible, empty answer**,
which is worth recording because it is exactly CLAUDE.md's named class. A `git
grep -E '<NoteEntry[\s/>]|<textarea|contenteditable|<input\b[^>]*type="(text|number)"'`
over the seven cohort cards returned **zero hits**. `git grep` is LINE-BASED and
every one of these tags is written across multiple lines
(`<NoteEntry⏎`, `<textarea⏎`, `type="text"` on its own line), while the real gate
reads the **whole file as one string**. The negative control caught it: the gate
names four cards it must find (`:533-537` — `sequencer`, `drumseqz`, `sticky`,
`textmarquee`) and the grep found only `textmarquee`.

The corrected instrument replicates `cardTemplate()` + `mountsTypedEntry()`
verbatim over whole files. Results — **all four positive controls fire**, which is
what makes the negatives believable:

| card | typed entry? | via |
|---|---|---|
| `SequencerCard` | **TYPED** | `<NoteEntry` | *(positive control ✓)* |
| `DrumseqzCard` | **TYPED** | `<NoteEntry` | *(positive control ✓)* |
| `StickyCard` | **TYPED** | `<textarea` | *(positive control ✓)* |
| `TextmarqueeCard` | **TYPED** | `contenteditable` | *(positive control ✓)* |
| **`ControlSurfaceCard`** | ⚠ **TYPED** | `<input type="text">` | the in-situ rename |
| **`MidiLaneCard`** | ⚠ **TYPED** | `<input type="number">` | the note-number tap |
| **`ArchivistCard`** | ⚠ **TYPED** | `<input type="text">` | wave 6's target |
| **`PeerTubeCard`** | ⚠ **TYPED** | `<input type="text">` | wave 6's target |
| **`RecorderboxCard`** | ⚠ **TYPED** | `<input type="text">` | wave 6's target |
| `GamepadCard` | clean | | |
| `Es9Card` | clean | | |
| `OutToLaunchCard` | clean | | |
| `LaunchpadControlCard` | clean | | |
| `Push2ControlCard` | clean | | |
| `MidiclockCard` | clean | | ← why the leg has never fired |
| `KriaCard` | clean | | ← same |
| `MatrixMixCard` | clean | | ← same |

**The three modules promoted since the extension slot shipped are all clean, which
is the entire reason this has never been hit.** It is not a latent theoretical
problem; it is the next thing five separate face PRs will walk into.

### 2.3 ⚠ THIS OVERTURNS WAVE 6 §5.2's PRESCRIPTION — the reasoning is right, the remedy is not

Wave 6 concluded, correctly, that `needs-note-entry-cell` is scoped to **CELLS**;
that a `fullViewBody` is a **SLOT** which satisfies no cell contract and can carry
an `<input>` today; and that the blocker is therefore over-declared on that cohort.
It then prescribed: *"drop `needs-note-entry-cell` from `archivist` and
`peertube`'s `blockers` arrays when their faces land. `recorderbox`'s filename
field is the same argument."*

**Dropping the blocker is necessary (§2.1 leg 2) and it is not sufficient**, because
the gate that actually reddens **does not read the blockers array** — it reads the
CARD's markup and branches on the DISPOSITION. Wave 6's analysis was of the
blocker; the obstacle is a different leg that happens to mention the same blocker
in its failure message.

**This is the same shape wave 6 itself named** — a correct diagnosis followed by a
prescription aimed one layer off — and it was invisible from wave 6's position
because none of the three modules it had already seen promoted mounts typed entry.

### 2.4 ⚠ AND THE FILE ALREADY CONTAINS BOTH SUBJECTS, DISAGREEING

The sharpest form of the finding: **one file uses two different subjects for one
concept, and both are individually defensible.**

* `:346` — the blocker's own liveness probe is
  `faceShellMountsTypedEntry: mountsTypedEntry(moduleShellTemplate())`, reading
  **`ModuleShell.svelte`**, described at `:332-334` as *"the ONE renderer every
  face cell is painted by"*. So the blocker's subject is **the shared face
  renderer**.
* `:512` — the disposition leg's subject is **the module's legacy card**.

The `fullViewBody` extension slot is **neither**. It is module-owned markup that
`ModuleShell` does not contain and the legacy card is not. So the probe correctly
reads FALSE (the shell still has no text cell — the blocker is genuinely live) while
a body carrying an `<input>` is perfectly legal and invisible to it, **and the
disposition leg reddens on a card the face no longer renders.**

That is CLAUDE.md's blind-gate shape in its exact stated form: *a filter applied
before the check that quietly redefined the check's subject.* The subject was
redefined when `#1512` shipped the extension slot, and neither leg was revisited.

### 2.5 THE OPTIONS — and this one genuinely goes to the owner

⚠ **No spec in this wave picks one**, and every affected spec is written so it can
go any of three ways without restructuring. It is escalated because all three
routes cost something the standing rulings care about, which is the definition of
not-decidable-by-an-agent.

| route | what it costs |
|---|---|
| **(a) Move the typed entry OFF the legacy card into the `fullViewBody`** | ⚠ **a FUNCTIONAL-PARITY cost on `?shell=legacy`.** The escape hatch renders the verbatim card; strip its `<input>` and the affordance is gone in that shell. "Functional parity is a hard requirement" and "we would lose X is never an owner choice to surface" both point away from this |
| **(b) Narrow the gate's subject** — have the typed-entry leg read what the module's FACE renders (cells + its declared `fullViewBody`) rather than its legacy card | ⚠ **the standing no-CI-changes ruling (2026-08-23).** This is not adding a gate, a workflow or a ratchet — it is correcting an existing gate whose subject went stale — but the ruling is broad and this is the owner's call, not an agent's |
| **(c) Do not promote the five affected modules** | ⚠ costs `controlSurface`, `midiLane`, `archivist`, `peertube` and `recorderbox` — two of which wave 6 already scheduled |

**A fourth route exists and should be named to be refused**: the gate skips
`organizational-native` (`:522`, *"the text IS the object"*). Re-dispositioning a
module into that bucket to dodge the leg would be a green gate certifying nothing —
CLAUDE.md's *"before 'fixing' a declaration to satisfy a gate, check the consumer
reads it"*, inverted.

⚠ **What is NOT in question:** the blocker itself is real and live. `ModuleShell`
mounts no typed entry, the probe reads FALSE on the real tree, and
`card-primitive-parity`'s `NoteEntry via: 'none'` still holds. Nothing here argues
for deleting `needs-note-entry-cell`.

---

## 3. WHERE THE PICKER GOES — `fullViewBody`, and it is shipped twice over

No module in this cohort needs a new cell shape, and none proposes a platform
capability.

`face.extension: '<id>'` → `$lib/ui/modules/<id>/shell-extension.ts` → the
`fullViewBody` slot. `WIRED_SHELL_EXTENSION_SLOTS` is `['glyph', 'fullViewBody']`
(`shell-extensions.ts:124`), so the slot is wired, and there are now **two** shipped
precedents rather than one:

* **`cameraInput`** — a device picker whose roster lives behind a browser API
  (`CameraInputOutputBody.svelte`);
* **`midiclock`** — the same problem over Web MIDI, and the closest template this
  cohort has (`ui/modules/midiclock/MidiclockDeviceBody.svelte` +
  `shell-extension.ts`).

`midiclock`'s extension header states the rule this cohort should copy verbatim:

> ⚠ **WHY A BODY AT ALL, WHEN THE CONNECT GESTURE IS A CELL.** Exactly one thing on
> this module cannot be a cell: the DEVICE ROSTER… ⚠ **AND IT IS *ONLY* THAT.** The
> DIVISION is a real param and renders as an ordinary segmented band cell; CONNECT
> is a real action cell and reaches the lane. Neither is duplicated here. A body
> that also carried them would be a second implementation of controls the face
> already owns.

**The generalisation, which every spec here applies:** *put in the body only what
cannot be a cell, and rank everything else.* A body that duplicates a cell is
drift with extra steps.

### 3.1 ⚠ THE `env`-FOR-SELECTORS ASK IS DISPROVEN, and this wave adds a THIRD independent reason

It is **not** re-proposed anywhere in this wave. The three refutations are on
different axes, which is what makes the refusal durable:

1. **CAPABILITY** (wave 5 `BINDERS.md §1`) — `ShellCellEnv.engine` is typed
   `{ write(...) }` with no `read`, so a selector handed today's `env` could not
   enumerate one device; and `getActiveEngine()` (`$lib/audio/engine-ref.ts:23`)
   already exists and is already consumed from plain `.ts` by four module-owned
   action files.
2. **REACH** (wave 6 §2.1) — `tvLibrarian`'s roster is two network fetches against
   `raw.githubusercontent.com`; an engine handle does not reach it.
3. ⚠ **OWNERSHIP** (this wave, `push2Control`) — its roster and selection live in
   **`localStorage`** (`push2-control.svelte.ts:154-157`, `:449`) plus module-level
   runes, deliberately, because two collaborators on one rack each drive their own
   hardware on their own lane. **No engine handle of any shape reaches
   `localStorage`**, and moving that state into the Y.Doc to make a cell possible
   would be a multiplayer regression, not a refactor.

Three modules, three reasons, one conclusion. `.claude/skills/module-faceplates.md`
warns about this false blocker by name and says *"assume a third would too"*; wave
4 was the third and wave 5 caught it. This is the standing note for the fourth.

---

## 4. RESTING TEXT — the shipped positive form, and the two shapes this cohort will reach for

Permitted resting text, exhaustively: module NAME, TAB/SECTION labels, CONTROL
CAPTIONS, and option/landmark NAMES that disambiguate a control's own position.
⚠ Every module here wants to paint *connected*, a device name, a port number, a
MIDI channel, an xrun count or a button index. **None of them gets an exemption**,
and none is needed, because the positive form shipped with `midiclock`:

**`StatusLed`** (`$lib/ui/controls/StatusLed.svelte`, gated by
`status-led-source.test.ts`) — a static literal caption, a boolean lamp that IS the
picture, the derived quantity in `detail` → `aria-label`/`title`, and
`tone: 'accent' | 'warn'` distinguishing a FAULT from a readiness **in colour, not
text**. Three properties make it hold where four previous mechanisms did not:

* **there is NO `value` prop** — `Readout.svelte` is *"the refused shape preserved
  next door"*, and adding one is an edit to a gated file, not a call-site choice;
* ⚠ **the caption is STATIC BY CONTRACT** — painted and announced identically
  whether `lit` is true or false, so a caller cannot smuggle a measurement through
  `lit ? 'LATE 3' : 'OK'`, and the source gate denies that AT THE CALL SITE;
* `persistentReadout=false` is refused BY NAME and the prop is deleted.

### 4.1 The two settled discriminators this cohort keeps needing

Applied, never re-litigated:

* **An option NAME inside the control that SELECTS it is permitted; the same text
  painted OUTSIDE every control, restating what is selected, is a readout.** A
  device picker showing device names is fine (`cameraInput`'s precedent, and
  `midiclock`'s roster entry says so in the roster itself). A "now bound: Launchpad
  Mini MK3" line is not.
* **In-canvas text is the MODULE'S ARTWORK, not the face's chrome** (wave 5
  `GAMES.md:59-65`). ⚠ **This cohort contains its strongest instance**:
  `push2Control`'s body is a byte-accurate replica of a physical 960×160 OLED,
  painted by the same op list already on its way to the hardware. Deleting those
  readouts would not remove a readout from the *product* — the panel still paints
  them — it would only break the one-seam guarantee. See that spec's §2.5.

### 4.2 ⚠ A THIRD DISCRIMINATOR THIS COHORT NEEDS AND NO PREVIOUS WAVE STATED

**A button caption that CHANGES is not automatically a readout — but it is one
when the label names the same action twice.**

The test: does the label name a **DIFFERENT ACTION**, or the **SAME ACTION plus a
state word**?

* `Bind to clip-player` / `Unbind clip-player` — two genuinely different actions on
  one control; the handler branches. ✅ **A caption.**
* `Connect Push 2` / `Re-connect Push 2` — ⚠ **one action.** `connect()`
  (`Push2ControlCard.svelte:113-120`) does not branch; the `Re-` prefix carries no
  information about the gesture and exactly one bit about the module's state.
  ⛔ **A state word wearing a caption's clothes.** Pin it to the literal.

⚠ **Nothing in the tree enforces this.** `status-led-source` reads ONE primitive
and says so (*"A module that hand-rolls its own `<span>3 skipped</span>` is
invisible here"*); `face-resting-text-source` reads FACE FIELDS and is blind to a
body's markup by its own admission. **A `<button>` caption inside a `fullViewBody`
is seen by the dock VRT baseline and a human reading it, and by nothing else.**

⚠ And `DOCK_MAX_DIFF = 1500` px *"cannot see a short caption change"*
(`_shell-faces.ts:3556`), while `--update-snapshots` cannot repair a
passing-but-stale baseline anyway. **Caption wording in this wave is verified by
eye on the committed PNG, never by a gate.** Stated because §4 is enforced largely
through what captions say.

---

## 5. THE FIVE GATES EVERY FACE PR IN THIS WAVE SATISFIES

Wave 4 listed two. Wave 6 listed five. **This wave lists five and finds a sixth**
(§2), which is the one that will actually stop a PR.

1. **the face lints / `STRICT_FACES` promotion anchor** — `module-face-lint.test.ts`;
   the set is asserted EQUAL to the set of defs declaring a `face`, in both
   directions, so **authoring the `face` IS the promotion** and there is no count
   to maintain.
2. **the VRT baselines (compact + dock)** — registered in `e2e/vrt/_shell-faces.ts`;
   Linux CI authors them, nobody commits a PNG, dispatch with `task vrt:commit`.
   ⚠ **Draining an exemption also enrols the LEGACY CARD** — predict 3 files, not 2
   (§1.2), and delete BOTH anchored entries (§1.3).
3. **`EXTENSION_BODY_ROLES`** — `face-rack-status-source.test.ts:150`.
   Deny-by-default over every `fullViewBody`, membership derived off the DIRECTORY,
   a mechanical predicate per role, and a `why` **required by the type** (`:146`:
   *"Required — `tsc` refuses the bare form"*).
   ⚠ **THE ROLE SET IS THREE, NOT TWO** — `:143` is
   `type BodyRole = 'picture' | 'status-primitive' | 'control-grid';`. `control-grid`
   arrived with matrixMix and **wave 6's README explicitly records it as
   non-existent**, because at that point it lived only on an open PR (#2184). It has
   since merged. ⚠ **AND THE ANCHOR CHANGED SHAPE TOO**: `:805-825` is now a SET
   IDENTITY between the roles `ROLE_PREDICATE` defines and the roles the roster
   uses, asserted in both directions — no longer the hand-typed pair wave 6
   describes, and its own comment says the pair *"went stale the moment a third
   surface kind arrived"*.
   The predicates, verbatim (`:560-604`): `picture` = `paintsCanvas(...)`;
   `status-primitive` = `/StatusLed/ && !paintsCanvas(...)`; `control-grid` =
   `/aria-label=/ && !paintsCanvas(...)`. **They are ordered by the canvas test**,
   so a body that keeps a canvas *and* uses `StatusLed` is legally `picture`.
   ⚠ `control-grid` carries an extra permanent leg (`:826-860`): an expression bound
   to `aria-label={…}` **must not also appear in a bare text mustache** — *"the
   resting-text violation wearing the ruling's own mechanism as a disguise"*.
4. **`module-docs-lint`'s FAMILY↔CARD leg** — `module-docs-lint.test.ts:359-375`:
   for every declared `controlFamilies[].testidPrefix`, `cards.includes(prefix)`
   over the concatenated source of ALL cards, **PRESENCE-ONLY** by its own comment.
   ⚠ **The honest fix is ADDING the testid to the card, never dropping the family.**
5. **the `optionsExhaustive` SNAP contract** — `param-vocabulary.test.ts:130-203`.
   An exhaustive-roster param must **SNAP at point of use**, not validate-and-reject,
   because `paramCellKind` returns `'knob'` OFF-DOCK so a lane drag genuinely can
   land between options. ONE implementation — `snapToOptions` from
   `$lib/ui/controls/knob-vocabulary-model`. ⚠ *"one that declares it and does NOT
   snap is worse than one that never declared it"* (`:153`).

**And the sixth, which is §2**: `face-migration-inventory.test.ts`'s three
interlocking legs — declaring a `face` forces `generic-face` (`:229`), which forces
an empty `blockers` array (`:268`), which trips the TYPED-ENTRY leg (`:509`) if the
module's **legacy card** mounts an `<input type="text">`, a `<textarea>`, a
`contenteditable` or a `<NoteEntry>`.

### 5.1 THE WIDTH GATE'S CURRENT STATE, verified rather than assumed

`packages/web/src/lib/ui/dock/face-width-source.test.ts` — `PLATE_FLOOR_EXEMPTIONS`
is **`[]`** (`:88`, empty), `PLATE_SCALE_PX = 100` (`:79`), `WIDTH_CHAIN =
['_dock-faceplate.css']` (`:70`), and the failure message is *"the DEFAULT is wrong
— fix the default. Per-module hatches are how `min-width: 900px` happened"*
(`:173`). **So no face in this wave adds a `min-width` to the width chain.** Body
width is a different mechanism — the body is content, audited by the per-face
content-vs-plate leg in `workflow-shell-faces.spec.ts`.

---

## 6. THE `.data` CENSUS — a FIFTH state the running column cannot express, and the census is now the thing that is wrong

Waves 3–5 tracked a per-module binary (`node.data` writes transacted +
`LOCAL_ORIGIN`-tagged, or not). Wave 6 found the column cannot express the truth
because **discipline is per CALL SITE** — one file had correctly tagged content
writers and a bare-proxy resize writer, and *"all 15 `startCornerResize` callers
have it."*

**This wave adds a fifth state and it breaks the column a second way:**

| module | state location | verdict |
|---|---|---|
| `gamepad` | `node.data` via **`mutateNode`** at 7 call sites (`GamepadCard.svelte:135,143,159,180,288,300,349`) | ✅ **clean** — and it is the cohort's model |
| `push2Control` | ⚠ **`localStorage` + module-level runes. `mutateNode` appears ZERO times** | see below |
| `controlSurface` | `node.data` (per its own def header) | per-spec |
| the rest | per-spec | |

⚠ **`push2Control` would score ✓ on the census for a reason that is a tautology
about the probe: it never writes at all.** That is wave 6's `recorderbox` finding
arriving from the opposite direction — an absence from a derived set that is a
property of the instrument, not of the subject.

⚠ **And the placement is CORRECT, not sloppy.** Two collaborators on one rack each
have their own Push on their own lane; syncing `selectedChannel` would make one
player's button move the other player's hardware screen. **Per-machine hardware
binding is a legitimate fifth home for state**, and a census that scores it as
"clean" and a module that genuinely tags every write as "clean" are recording two
different facts in one column.

**The recommendation is the one wave 6 reached and this wave strengthens: stop
reporting the census as a per-module binary.** The useful form is per call site
with the state's HOME named — params / `node.data` tagged / `node.data` bare /
per-machine local / none.

---

## 7. THE GLYPH GAP — five modules now, and still nobody invents one

`ShellExtensionGlyphProps` (`shell-extensions.ts:44-51`) carries `num`, `numbers`
and `testid` and **no `nodeId`**, so a glyph is a pure function of a discrete param
value and every instance of a module draws an identical picture. And
`glyphBinding` short-circuits on `primaryAudioOutPortId` =
`outputs.find(o => o.type === 'audio')?.id`, so a module with no `audio` output
falls through to `{ kind: 'static' }`, which `module-face-lint`'s dead-glyph clause
reddens unconditionally with no exemption list.

**The useful glance for this whole cohort is one thing and none of the five
`VALID_GLYPHS` members expresses it:** *is this thing bound to a device, and is
traffic flowing?* That is a BINDING STATE plus an EVENT RATE; every valid glyph
describes a continuous audio quantity.

Wave 4 argued it for `midiclock` (1 module). Wave 5 raised it to 4. **This cohort
raises it further**, and the evidence is now strong enough that a platform change
would be justified — which is exactly why **no spec here invents one.** A new glyph
kind on a module PR is the wrong shape; the refusal is more defensible with more
evidence, not less.

⚠ **One correction to carry forward.** Wave 6's defect-ledger item 8 records that
`strict-faces.ts:835-837` and `picturebox.ts:309` justify `glyph:'none'` with the
claim that *"a video def has no `audio` output"* — **false for `archivist`,
`peertube`, `videocube`, `milkdrop`, `nibbles` and others**, which reach the right
answer from a wrong premise. **It does not apply to the meta members of this
cohort**, whose `outputs` arrays are literally empty, so the premise is true by
inspection rather than by luck. Checked rather than assumed, because a correct
conclusion resting on a false premise breaks the next time somebody reasons from
the premise.

---

## 8. THE VERDICTS

Per-module reasoning lives in each `spec.md`; this table is the index.

| module | verdict | side of the lane carve-out | body role | width earned | est. |
|---|---|---|---|---|---|
| `push2Control` | **PROMOTE** — no precursor | outside (a tile exists, empty) | `picture` | **YES**, at 480 px | ≈ 8 h |
| `launchpadControlLeft` | see `launchpadControlLeft/spec.md` | **inside** — dock-only face | | | |
| `outToLaunch` | see `outToLaunch/spec.md` | outside | | | |
| `controlSurface` | see `controlSurface/spec.md` — ⚠ **§2 applies** | **inside** — dock-only face | | | |
| `gamepad` | see `gamepad/spec.md` | outside | | | |
| `es9` | see `es9/spec.md` | outside | | | |
| `midiLane` | see `midiLane/spec.md` — ⚠ **§2 applies** | outside | | | |

---

## 9. WHAT NEEDS AN OWNER DECISION

**One.** It is cohort-level, it reaches beyond this cohort, and every affected spec
is written so it can go any of three ways without restructuring.

### 9.1 ⚠⚠ How does a face land on a module whose LEGACY CARD mounts typed entry?

§2 in full. The short form:

* Authoring a `face` forces `disposition: 'generic-face'`
  (`face-migration-inventory.test.ts:229`), and the TYPED-ENTRY leg (`:509-518`)
  reddens on any `generic-face` module whose **legacy card** mounts
  `<input type="text"|"number"|…>`, `<textarea>`, `contenteditable` or `<NoteEntry>`.
* **Measured, with the instrument negative-controlled: it hits `controlSurface`
  and `midiLane` in this cohort, and `archivist`, `peertube` and `recorderbox` —
  all three of wave 6's `needs-note-entry-cell` recommendation targets.**
* **Wave 6's prescription (drop the blocker) is necessary and does not fix it**,
  because the offending branch fires on the DISPOSITION and `continue`s before it
  reads the blockers array.
* The three routes — strip the card (a `?shell=legacy` parity cost), narrow the
  gate's subject (the no-CI-changes ruling), or don't promote five modules — each
  cost something a standing ruling protects.

**The reason it is genuinely undecidable by an agent** is that route (b) is not
obviously a "CI change" and not obviously not one: the gate is not being added,
weakened or exempted — its subject went stale when `#1512` shipped the
`fullViewBody` slot, and the same file already reads the SHELL as the subject for
the very blocker this leg's message cites (`:346`). Whether correcting a stale
subject counts as "fundamental CI change" is the owner's call.

**Nothing is blocked on the answer.** The five specs are written so the face
design is identical either way; only the PR's file list changes.

---

## 10. STANDING CORRECTIONS TO THE PRIOR WAVES

Recorded because each was believed on entry and each was checked.

1. ⚠ **`EXTENSION_BODY_ROLES` has THREE roles, not two.** Wave 6's README §3
   states `control-grid` *"does not exist"* and calls it an open-PR error. It
   merged. The role anchor also changed shape — it is now a SET IDENTITY against
   `ROLE_PREDICATE`'s keys, not a hand-typed pair. **Wave 6's own lesson applied to
   wave 6:** an unmerged PR's contents read exactly like merged tree state, and
   nothing but going and looking distinguishes them. §5, gate 3.
2. ⚠ **Wave 6 §5.2's `needs-note-entry-cell` prescription is insufficient.** §2.3.
3. ⚠ **Wave 5 `BINDERS.md §6`'s "decide the inherited rationale once at the root"
   has HAPPENED**, in the direction of draining: `midiclock` left
   `ALLOWED_PERMANENT_EXEMPT` on 2026-08-24 (`vrt-exemptions.ts:1216-1222`), the
   second drain ever. Two `"same rationale as midiCvBuddy"` references remain
   (`:746`, `:769`). §1.
4. ⚠ **The `env`-for-selectors ask now has THREE independent refutations, on three
   different axes.** §3.1. Not re-proposed; recorded so a fourth instance has
   something cell-shape-neutral and transport-neutral to hit.
5. **A grep is not the gate.** §2.2 — a line-based `git grep` of a whole-file
   predicate returned a clean, plausible, empty answer over 14 cards, and only the
   gate's own named positive controls caught it.

   **The corrected instrument, reproducible from this file** — it replicates
   `cardTemplate()` + `mountsTypedEntry()` (`face-migration-inventory.test.ts:126-149`)
   verbatim over WHOLE files, and it prints the four positive controls first so a
   silent-failure run is visible rather than reassuring:

   ```js
   // node - <<'EOF'   (run from the repo root, under `flox activate --`)
   import { execFileSync } from 'node:child_process';
   const tmpl = s => s.replace(/<script[\s\S]*?<\/script>/gi,'')
                      .replace(/<style[\s\S]*?<\/style>/gi,'')
                      .replace(/<!--[\s\S]*?-->/g,'');
   const typed = t =>
       /<NoteEntry[\s/>]/.test(t) ? 'NoteEntry'
     : /<textarea[\s/>]/.test(t)  ? 'textarea'
     : /contenteditable/.test(t)  ? 'contenteditable'
     : (/<input\b[^>]*\btype="(text|number|url|search|email|tel)"/.exec(t)?.[1] ?? null);
   for (const c of process.argv.slice(2)) {
     const src = execFileSync('git',
       ['show', `origin/main:packages/web/src/lib/ui/modules/${c}.svelte`],
       { encoding:'utf8', maxBuffer: 32<<20 });
     console.log(c.padEnd(26), typed(tmpl(src)) ?? '.');
   }
   // ALWAYS pass the four positive controls first — the gate names them at :533-537:
   //   SequencerCard DrumseqzCard StickyCard TextmarqueeCard
   ```
