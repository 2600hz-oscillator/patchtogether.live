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
| `controlSurface` | ✅ | `'legacy'` — the verbatim card | **no shell lane tile exists**, so promotion must **DELETE the entry** (a dock-only face is possible and is refused — below) |
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

⚠ **"A DOCK-ONLY FACE" IS MECHANICALLY REAL AND BOTH SPECS REFUSE IT.** The wave's
first framing was that a carved-out module could keep its `'legacy'` lane render and
gain a dock face — and `DockFullView.svelte:136`, `:334` gate on `migrated` **alone**,
so it really would render. **It is refused on two measurements**, not on taste:

* `Canvas.svelte:635`/`:650` keep the LEGACY GEOMETRY for a carve-out member, so the
  lane would hold a **330 px card in a rack of 192 px tiles, forever**;
* the resting-text ruling would then apply to **half a module** — status deleted in
  the dock and still painted in the lane, same node, same moment.

**So promotion DELETES the `NON_SHELL_LANE_TYPES` entry**, and the carved-out modules
get a lane tile like everyone else. `cameraInput`'s removal from that set on
promotion (`legacy-fallback.ts:63-65`) is the shipped precedent.

⚠ **AND THE DELETION IS POSITIVELY ASSERTED, so it is a RED, not a silent change.**
`legacy-fallback.test.ts:229` is
`expect(NON_SHELL_LANE_TYPES.has(LAUNCHPAD_CONTROL_TYPE)).toBe(true)`. A drain reddens
it; the face PR flips it to `toBe(false)` with a lineage note
(`dom-source-modules.test.ts:1249` is the cameraInput precedent). ⚠ **Keep `:230`** —
`expect(NON_SHELL_LANE_TYPES.has('launchpadControl')).toBe(false)` with the message
*"the unregistered id must be GONE"* is the half that actually guards #1579, and it
is unaffected.

⚠ **The compact-by-default reasoning still differs on the two sides — but only
BEFORE the deletion.** A module with no lane tile has no
section-heading-versus-caption tradeoff to make, which is precisely why
`face.bareCells` is dock-only. **After the entry goes, the tradeoff is live for the
carved-out modules too**, so each spec argues it rather than inheriting "dock-only,
so it does not apply".

⚠ **And `push2Control` is on the wrong side of that line by omission, not by
design.** Its own header says *"Modeled on ElectraControl / LaunchpadControl — a
meta-domain control-surface node with no audio cable I/O"* (`push2-control.ts:41-43`),
and both models are in the set while it is not. The consequence is user-visible
today: at plain `/rack` it is a name, a badge and an empty jack rail, and the one
gesture without which it does nothing is dock-only. ⚠ **The fix is the FACE, not
adding it to the set** — `cameraInput`'s removal from that set on promotion
(`legacy-fallback.ts:63-65`) is the shipped direction of travel. Recorded because
*"never added"* and *"deliberately left out"* are indistinguishable from the tree.

### 0.4.1 ⚠ AND 14 OF THE COHORT'S 16 e2e SPECS RUN IN THE SHELL WHERE A FACE CANNOT EXIST

Measured over every spec covering these seven modules
(`adsr-poly-midilane`, `control-surface`, `es9-card-shows-state`, `es9-hardware`,
`es9-per-leg-patching`, `es9-shell-lifetime`, `gamepad`, `launchpad-arp`,
`launchpad-clip-launch`, `launchpad-keys-record`,
`launchpad-monitor-survives-card-collapse`, `launchpad-perf-controls`,
`launchpad-scene-repeats`, `midi-lane`, `push2-clip-launch`,
`toybox-control-surface`):

**14 reach the canvas only through the `rack` fixture**, which is
`page.goto('/rack?shell=legacy&seed=none')` (`e2e/tests/_fixtures.ts:91-93`). The
fixture's own comment says why that matters (`:76-83`): *"the bare default `/rack`
renders each module as a FACEPLATE tile… so a module's own card testids do not
exist in the lane."* **So promotion is invisible to almost the entire e2e surface
of this cohort** — those specs stay green because the legacy shell still exists, and
not one of them observes a face.

**Two exceptions, and both are load-bearing:**

* `es9-shell-lifetime.spec.ts:56` — `page.goto('/rack' + (shell ? '' : '?shell=legacy'))`.
  It **parameterises over BOTH shells**, which makes it the only spec in the cohort
  that already exercises the default renderer for its module by construction.
* `launchpad-monitor-survives-card-collapse.spec.ts:140` — `page.goto('/rack?seed=none')`,
  the DEFAULT shell only, with the comment *"the configuration the bug needs. Under
  `?shell=legacy` the card sits in the lane forever and never unmounts"* (`:138-139`).

⚠ **The second one ASSERTS THE PLACEHOLDER, so it is `main`'s own proof of §0.4.**
`:154-159` spawns `shapes → outToLaunch` and asserts
`expect(page.locator('[data-testid="out-to-launch-card"]')).toHaveCount(0)` with the
message *"the shell renders a placeholder tile, not the real card"*, under the
comment *"Un-migrated (`bespoke-surface`) module under the shell: no real card in
the lane at all. **Its card exists ONLY inside the dock full-view.**"* A derivation
from `laneRenderKind` and a shipped CI assertion agreeing is much stronger evidence
than either alone.

**And it breaks two ways on promotion, with the RED one being the good half:**

* `:173` — after `openFullView(page)`, `toHaveCount(1)` on `out-to-launch-card`.
  ⛔ **RED**: `DockFullView` is gated on the `migrated` prop, so a promoted module
  renders its FACE there, not the legacy card. Loud, in the right place, and the face
  PR owns re-pointing it at the face's body. ⚠ Do NOT simply delete it — the
  surrounding test proves an owner-facing P0 (the monitor survives card collapse) and
  that claim must keep a subject.
* `:155-159` — ⚠ **stays GREEN and becomes a DIFFERENT claim.** Today it means "the
  shell renders a placeholder"; afterwards it means "the shell renders a faceplate",
  and `toHaveCount(0)` on the legacy card is true in both worlds. That is the
  green-and-blind class: an assertion whose precondition changed underneath it.

⚠ **The asymmetry inside the launchpad family is worth stating**: `outToLaunch` has
the best default-shell coverage in the cohort and `launchpadControlLeft` has **none**
— all five of its specs are `rack`-fixture specs.

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
`FACES_WITHOUT_SCENES` entry** (`e2e/vrt/_shell-faces.ts:3472`) carrying the
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

### 1.4 ⚠ WAVE 5's "DISCHARGE IT AT THE ROOT" IS OVERTURNED — BY THE DRAIN ITSELF

Wave 5 `BINDERS.md §6` said the inherited rationale should be settled once at its
root: *"discharging it at the root discharges it for the cohort."* **The `midiclock`
drain says the opposite, in the same file, two lines below the entry it removed**
(`vrt-exemptions.ts:761-767`):

> ⚠ THE OTHER THREE ENTRIES IN THIS BLOCK ARE UNCHANGED, DELIBERATELY. `midiCvBuddy`,
> `midiOutBuddy` and `midiLane` say "same rationale as midiCvBuddy", so ONE argument
> is written once and referenced four times. **Discharging it here does NOT discharge
> it there:** each of those cards paints its post-Connect surface differently and none
> of them is promoted, so the decision has to be made at each on its own evidence.
> **Falsifying the rationale for one module is not falsifying it for the module it was
> written about.**

**And the tree is right.** The correct generalisation is narrower than wave 5's and
wider than that comment's, and it is worth stating precisely because it is the rule
for the next five drains:

> **THE MECHANISM TRANSFERS; THE CAPTURE DOES NOT.**
> The mechanical claim — *`requestMIDIAccess` is never called without a click, so a
> freshly spawned node's roster does not merely happen to be empty, it does not
> exist* — is a fact about shared code and holds for every module that reaches its
> device the same way. **What each module still owes on its own evidence is what its
> own plate actually PAINTS in that state.**

⚠ **The ROOT is still undrained and still carries the falsified clause.**
`midiCvBuddy` (`:745`) is the entry all the others reference, it has no
cross-reference to the argument that just falsified half of it, and two entries still
read *"same rationale as midiCvBuddy"* (`:751` `midiOutBuddy`, `:769` `midiLane`)
while one reads *"like controlSurface/electraControl"* (`:686`
`launchpadControlLeft`).

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
names the cards it must find (`:530-537` — `cartesian`, `sticky`,
`textmarquee`) and the grep found only `textmarquee`.

The corrected instrument replicates `cardTemplate()` + `mountsTypedEntry()`
verbatim over whole files. Results — **all four positive controls fire**, which is
what makes the negatives believable:

| card | typed entry? | via |
|---|---|---|
| `CartesianCard` | **TYPED** | `<NoteEntry` | *(positive control ✓)* |
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
   Linux CI authors them and nobody commits a PNG.
   ⚠ **DISPATCH WITH `GREP=<module> task vrt:commit`, NOT A BARE `task vrt:commit`.**
   CLAUDE.md (VRT section, current text): the derivation *"reads PATHS ONLY"* — the
   diff-content tokenizer was **deleted 2026-08-23** because it inferred module names
   from prose and from ordinary identifiers and forced full sweeps on single-module
   PRs three times in one week. **Every face PR touches a shared roster file whose
   path names no module, so a bare dispatch on a face PR DERIVES FULL** — measured
   41-56 min unscoped against ~3 min scoped (#1795). Passing `GREP=` is the single
   biggest lever on this wave's loop, and it is safe because scoping cannot silently
   under-capture where it gates: `vrt-strict` reddens on the next CI run and names
   the file.
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
   for every declared `controlFamilies[].testidPrefix`, `cards.includes(prefix)`,
   **PRESENCE-ONLY** by its own comment (*"proves the family exists, not that its
   member COUNT is right"*).
   ⚠ **`allCardSource()` IS WIDER THAN ITS NAME** (`:78-94`): it walks the **whole
   `lib/ui/` tree** and joins **every `.svelte` file** into one string — deliberately,
   *"because a card's dynamic controls may live in a shared sub-component"*. So the
   check is a GLOBAL substring test: **a prefix present in any `.svelte` anywhere
   under `lib/ui/` satisfies the leg for any def.**
   ⚠ **Two consequences, and the second is the useful one.** (i) It cannot tell that
   a family's testid moved from a card to somewhere else, so it is *not* an obstacle
   to a face PR — **a face BODY carrying the testid satisfies it**, which is the
   honest direction anyway. (ii) It therefore proves much less than "the family is on
   the card"; it proves only "this string exists in the UI tree". Stated because a
   spec that treats this leg as a real constraint on where a family lives is
   over-reading it.
   ⚠ **Where it does bite, the honest fix is ADDING the testid, never dropping the
   family.**
5. **the `optionsExhaustive` SNAP contract** — `param-vocabulary.test.ts:130-203`.
   A param that **DECLARES** `optionsExhaustive` must **SNAP at point of use**, not
   validate-and-reject, because `paramCellKind` returns `'knob'` OFF-DOCK so a lane
   drag genuinely can land between options. ONE implementation — `snapToOptions`
   from `$lib/ui/controls/knob-vocabulary-model`. ⚠ *"one that declares it and does
   NOT snap is worse than one that never declared it"* (`:153`).

   ⚠⚠ **THIS WAVE'S BRIEF GOT THIS WRONG AND THE CORRECTION MATTERS MORE THAN THE
   RULE.** Three specs were briefed that a discrete param with an option roster IS a
   SNAP case. **It is not — the contract keys on the DECLARATION, not on the shape**,
   and for a **DENSE** roster *declaring it is itself RED*. `param-vocabulary.test.ts:168-172`:

   ```ts
   if (opts.length === steps) {
     offenders.push(
       `${type}.${p.id}: roster covers every step (${opts.length}/${steps}), ` +
       `so optionsExhaustive is redundant — delete it`);
   }
   ```

   So a `0..3 discrete` param with a four-member roster — `es9`'s per-jack class
   selector, and most rosters this cohort would add — **must NOT declare
   `optionsExhaustive`**: every reachable integer is already a member, so there is
   nothing for a snap to repair and the declaration is refused as redundant.
   **`optionsExhaustive` is for a SPARSE roster** — one that names fewer values than
   the param's range can reach, which is the only case where a drag can land between
   options. ⚠ Two of this wave's seven modules were briefed as SNAP cases and
   **neither is one.**

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
| `controlSurface` | `node.data`, **all seven mutators through ONE `ydoc.transact(…, LOCAL_ORIGIN)` chokepoint** | ✅ **the CLEANEST in the fleet** — `electra-control.ts` copied it deliberately |
| `gamepad` | `node.data` via **`mutateNode`** at 7 call sites (`GamepadCard.svelte:135,143,159,180,288,300,349`) | ✅ clean on `.data` — ⚠ **and NOT on `params`**, below |
| `push2Control` | ⚠ **`localStorage` + module-level runes. `mutateNode` appears ZERO times** | see below |
| `es9` | none — no `node.data` at all | n/a |
| `midiLane` | ⚠ **TEN bare `node.data` writes**, two of them reactive `$effect`s (`:154-159`) that mirror engine state into the Y.Doc **from every peer with the card open** | ⛔ third verbatim copy of the helper wave 5 found twice |
| `launchpadControlLeft` | `localStorage` — including **a graph NODE ID** with no lifetime | ⛔ see the ledger |
| `outToLaunch` | `node.data`, 0 → 1 writer on promotion | per-spec |

⚠ **A SIXTH STATE, AND IT IS ON `params` — WHICH THE CENSUS HAS NEVER LOOKED AT.**
`GamepadCard.svelte:393-395` is `t.params.padIndex = …` — **a bare proxy write to
`params`, no `transact`, no `LOCAL_ORIGIN`** — on a file whose seven `node.data`
writers all correctly use `mutateNode`. **Cmd-Z cannot undo a controller-slot
change.** Every prior wave's census enumerated `.data` writes, so **this class was
outside its subject entirely**, and the per-module binary column would have scored
this file ✓ twice over. ⚠ It also means the running total's shape was wrong in a
way none of waves 3–6 could have detected: **discipline is per CALL SITE *and* per
BAG.** The face fixes it as a side effect, which is exactly why the fix must be
named explicitly in the PR or it vanishes into a refactor.

⚠ **`push2Control` would score ✓ on the census for a reason that is a tautology
about the probe: it never writes at all.** That is wave 6's `recorderbox` finding
arriving from the opposite direction — an absence from a derived set that is a
property of the instrument, not of the subject.

⚠ **AND WAVE 5's RUNNING TOTAL IS STALE — `midiclock` IS PAID.** Its face PR
origin-tagged **both** surfaces (`MidiclockDeviceBody.svelte:113-121` and
`MidiclockCard.svelte:88-97`, whose comment quotes the old bare write verbatim).
Corrected total across waves 3–7:

* **untagged `.data`** — `kria`, `audioOut`, `midiCvBuddy`, `midiOutBuddy`, **`midiLane`**
* **tagged `.data`** — `picturebox`, `matrixMix`, `chromaconsole`, **`midiclock`**, **`controlSurface`**, **`gamepad`**
* **n/a** — `twotracks`, **`es9`**, **`push2Control`** (no `.data` at all)
* ⚠ **untagged `params`** — **`gamepad`**, the first and so far only instance, and a
  category the census did not have

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

| module | verdict | side of the lane carve-out | body role | est. |
|---|---|---|---|---|
| `launchpadControlLeft` | **PROMOTE** — no precursor. *Build FIRST* | **inside** — the entry goes | `status-primitive` | ≈ 8 h |
| `gamepad` | **PROMOTE** — one contract change in the same PR | outside | `control-grid` | ≈ 10-13 h |
| `push2Control` | **PROMOTE** — no precursor | outside | `picture` | ≈ 8 h |
| `outToLaunch` | **PROMOTE-WITH-PRECURSOR** (a one-clause `hasVideoSurface` fix) | outside | `picture` | ≈ 4 h + ≈ 10 h |
| `es9` | **PROMOTE-WITH-PRECURSOR**, and ⚠ **it is a `kria`-style GENERIC face, not a bespoke one** | outside | `status-primitive` | — |
| `midiLane` | **PROMOTE-WITH-PRECURSOR** — ⚠ blocked on §9.1, a gate question, not a face question | outside | `status-primitive` | — |
| `controlSurface` | ⛔ **REFUSE** — a measured parity loss, plus §9.1 | **inside** | (`control-grid`, if ever) | — |

### 8.1 ⚠ THE ONE REFUSAL, AND IT IS A PARITY MEASUREMENT RATHER THAN A PREFERENCE

`controlSurface` is refused on an arithmetic that no seam can bridge: a faced lane
tile is `SHELL_TILE_W = 192` px (`module-shell-model.ts:39,55`, uniform at every
zoom) against `BOX_W = 174` px **per binding group**
(`control-surface-layout.ts:76-79`). A module whose entire purpose is *reaching for a
knob* would trade four columns of live knobs on the canvas for a tile plus a dock
open. `fullViewBody` is dock-only by `dockFullViewHeadPlan` and
`ShellExtensionGlyphProps` carries no `nodeId`, so **there is no slot that fixes it.**

⚠ **The verdict was PRODUCED rather than escalated**, per the skill: this is #1974
(`joystick`) verbatim, and *"we would lose X"* is never an owner choice to surface.

⚠ **It is the only cohort member with a THIRD, independent blocker** (§9.1 hits it
too) — but the parity refusal stands on its own and would stand even if §9.1 were
decided tomorrow.

### 8.2 ⚠ `es9` IS NOT BESPOKE — the commissioned question, answered against the inventory

Four of the five clauses in `es9`'s inventory `why` (`face-migration-inventory.ts:802-808`)
name **readouts the resting-text ruling deletes**; the fifth is 22 ordinary
`ParamDef`s already pinned in `contract-lock.txt:1060-1082`. The only thing a generic
face cannot do here is mount a `StatusLed` — and that is a `fullViewBody` of role
`status-primitive`, **a shipped pattern whose two adopters are the entire `StatusLed`
caller set in `packages/web/src`** (`MidiclockDeviceBody.svelte`,
`CvBuddyStatusBody.svelte`).

**`kria` at least needed a bespoke PF-14 panel. `es9` needs two lamps and two
buttons.** It reads as bespoke to anyone who has only seen the bottom-left quadrant
of wave 5's axis — which is §8.3.

### 8.3 ⚠ WAVE 5's SINGLE AXIS IS TWO AXES, AND `es9` IS WHAT SEPARATES THEM

`BINDERS.md §0` ranked its cohort on one axis: *"how much of the module is the
binding, and how much is an instrument on top of it."* `es9` breaks it. It has
**more instrument on top** than `chromaconsole` (22 params, 46 ports) **and less
binding underneath** than `midiCvBuddy` (one device, no picker, no permission
prompt). Those are independent quantities, and a one-dimensional ranking that never
met a module in the top-left quadrant reads it as "bespoke" by default.

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

### 9.1.1 ⚠ IF ROUTE (b), *WHICH* SUBJECT? — two concrete forms, and the conditional-body case decides between them

Route (b) is not one option, and the difference is the whole cost. Written out so
the owner chooses between **concrete options rather than a direction.**

⚠ **First, a correction to how (b) is naturally phrased.** "Read what the face
renders instead of the card" makes the gate *still* red — a face body containing an
`<input>` mounts typed entry under any subject. **The gate's actual premise is
`face == cells`, and `cells have no text`, therefore `a module needing text cannot
be a face`.** The `fullViewBody` slot falsified the FIRST clause, not the second.
So the honest repair is not "look somewhere else" — it is **"the module may be a
face if its face CARRIED the affordance"**, which is functional parity expressed as
a gate. That makes (b1) below **strictly stronger than today's leg**, not weaker: it
adds a requirement where today there is a flat prohibition.

**(b1) THE PARITY FORM** — the recommended one.

> A `generic-face` module whose CARD mounts typed entry is an offender **unless**
> its def declares `face.extension: '<id>'` **and** that extension's `fullViewBody`
> source also mounts typed entry — same `mountsTypedEntry` predicate, applied to
> the body.

* **Deny-by-default with no list.** There is no exemption roster to maintain and no
  named carve-out; the escape is *carrying the affordance*, which is the outcome
  wanted anyway.
* **Anchored to the artifact in both directions.** If the body later drops its
  `<input>`, the gate reddens again — which is exactly the regression a face PR
  could otherwise introduce silently.
* **Same tier, same file, same predicate, ~10 lines.** `mountsTypedEntry` and
  `cardTemplate` are **already `export function`s** in that file (`:127`, `:144`),
  `RegisteredDef` already carries `face?: ModuleFace` (`:99-104`), and `CARD_DIR`
  (`:95`) is already the directory the extensions live under. The body resolver is the ten-line
  `fullViewBodySource(extId)` that **already exists** in
  `face-rack-status-source.test.ts:118-131` — a `shell-extension.ts` read plus two
  regexes. Nothing new is invented.
* ⚠ **It does NOT weaken the blocker.** `needs-note-entry-cell` stays live and its
  probe is untouched: `ModuleShell` still has no text CELL, so a LANE still cannot
  type, which is the capability the blocker actually names.

**(b2) THE RENDER FORM** — *"whatever the face actually renders"*, i.e. a DOM oracle
over the promoted face. **Refused, on three grounds:**

* ⚠ **Wrong tier, and this is where the no-CI-changes ruling genuinely bites.** The
  leg is a vitest source scan in the unit lane. A DOM oracle is an e2e — new CI
  wall-time and a new mechanism, which is squarely the thing the ruling names, in a
  way (b1) is not.
* ⚠⚠ **It is BLIND on exactly the case this cohort is made of.** A device-picker
  body renders its `<input>` only after a grant, and **CI has no device** — so the
  scan reads "no typed entry" and the gate passes *for the wrong reason*. That is
  CLAUDE.md's *"a gate whose PRECONDITION is the defect cannot fail on the defect"*,
  arriving in its purest form: the condition the check measures would be made true
  by the absence of hardware rather than by the code being right.
* It cannot distinguish *"the body has no input"* from *"the body failed to mount"*.

**So the conditional-body case the question turns on decides FOR (b1):** a SOURCE
scan sees a conditional `<input>` regardless of its branch, and a RUNTIME scan does
not — and for a cohort whose bodies are conditional on hardware that CI does not
have, the runtime scan is blind precisely where the modules live.

⚠ **One honest limitation of (b1), stated rather than discovered later.** A source
scan cannot tell that the body's `<input>` is *the same affordance* the card had —
only that the body has one of the same kind. A module could satisfy it by carrying
an unrelated text field. That is a real gap, it is the same gap
`module-docs-lint`'s family↔card leg names about itself (*"PRESENCE-ONLY … proves
the family exists, not that its member COUNT is right"*), and it is the correct
trade at this tier: presence is checkable in the unit lane, identity is not.

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
3. ⚠ **Wave 5 `BINDERS.md §6`'s "discharging it at the root discharges it for the
   cohort" is OVERTURNED — by the drain itself.** `vrt-exemptions.ts:761-767`:
   *"Discharging it here does NOT discharge it there… Falsifying the rationale for
   one module is not falsifying it for the module it was written about."* The
   correct rule is narrower: **the MECHANISM transfers, the CAPTURE does not.** ⚠ And
   the ROOT (`midiCvBuddy`, `:745`) is still undrained and still carries the
   now-falsified clause with no cross-reference. §1.4.
   ⚠ **This wave asserted the opposite in its own first draft** and it was corrected
   by a spec agent reading the file rather than the prior wave — which is the same
   failure mode as correction 1, one wave later.
4. ⚠ **The `env`-for-selectors ask now has THREE independent refutations, on three
   different axes.** §3.1. Not re-proposed; recorded so a fourth instance has
   something cell-shape-neutral and transport-neutral to hit.
4b. ⚠⚠ **WAVE 1's `electraControl` SPEC CARRIES A FALSE BLOCKER THAT IS NOW FIXED,
   AND IT IS THE FOURTH INSTANCE OF THE CLASS.** That spec (`spec.md:35`) records
   `STRICT_FACES` membership as *"structurally impossible today — `MetaModuleDef`
   has no `face` field"*. **`packages/web/src/lib/meta/module-registry.ts:85` is now
   `face?: ModuleFace;` and `:106` is `controlFamilies?: readonly ControlFamily[];`**,
   and `:64` states the precursor is *"READ, not merely declarable"* with a named
   negative-control block. **Anyone reading that spec today inherits a blocker that
   does not exist** — and it is what unblocks three of this wave's meta members.
   The skill's *"assume a third would too"* warning has now been vindicated four
   times, and this instance is a NEW shape: not a mis-read capability, but a **spec
   that was true when written and was never re-checked.**
4c. ⚠ **`.claude/skills/module-faceplates.md:485-489` is stale on the extension
   slots** — it describes `fullViewBody` as unwired. `WIRED_SHELL_EXTENSION_SLOTS`
   is `['glyph', 'fullViewBody']` with ~30 adopters; only `editorSurface` is unwired.
4d. ⚠⚠ **THE `optionsExhaustive` SNAP CONTRACT WAS MIS-BRIEFED BY THIS WAVE**, and
   the correction is in §5, gate 5: the contract keys on the **DECLARATION**, not on
   "a discrete param with an option roster", and for a **DENSE** roster
   (`opts.length === steps`) *declaring it is itself RED*
   (`param-vocabulary.test.ts:168-172`). Two of seven modules were briefed as SNAP
   cases and neither is one.
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
   // ALWAYS pass the gate's OWN positive controls first — it names them at :530-537,
   // and ⚠ READ THAT LIST RATHER THAN COPYING THIS ONE (§10.8): as of cef7c16c0 it is
   //   CartesianCard StickyCard TextmarqueeCard
   ```

6. ⚠⚠ **THIS WAVE'S OWN BRIEF ASSERTED AN 8×8 PAD GRID THAT DOES NOT EXIST**, and
   three shipped artifacts assert it too. `LaunchpadControlCard.svelte:135-235`
   paints **four buttons, a status line and a docs hint** — no canvas, no matrix, no
   colour legend. The three that say otherwise:
   * the inventory `why` (`face-migration-inventory.ts:840-846`) — *"an 8×8 pad
     matrix … the pad map is the interaction"*;
   * the VRT exemption (`vrt-exemptions.ts:667-679`) — *"a colour legend"*;
     `grep legend` over that card returns nothing (it moved to `LaunchpadDocs.svelte`
     at consolidation);
   * the `NON_SHELL_LANE_TYPES` carve-out's own stated reason
     (`legacy-fallback.ts:40-44`).

   **The orchestrator read the inventory `why` and propagated it into a spec brief**,
   which is how a stale description becomes a design constraint one wave later.
   ⚠ The consequence is not that `#2181` stops mattering for that module — it matters
   **more**, for the opposite reason: `params: []` means every `face.order` key must
   be a family template (matrixMix's route, `matrixmix.ts:46-52`).

   ⚠ **The general form, and it is the wave's most transferable lesson:** an
   inventory `why` is PROSE, no gate compares it to the card, and **three of them in
   this cohort are provably wrong** (this one, `gamepad`'s — §11.4 — and
   `recorderbox`'s, which wave 6 found). **Read the card, never the `why`.**

8. ⚠⚠ **THIS DOCUMENT WENT STALE WHILE IT WAS BEING WRITTEN, AND THE PROCESS THAT
   CAUGHT IT IS THE POINT.** `#2183` (`cef7c16c0`) merged mid-wave and **deleted five
   sequencer modules outright** — including `SequencerCard.svelte` and
   `DrumseqzCard.svelte`, **two of the four positive controls this section was
   relying on** to prove the typed-entry instrument works. The gate's own list moved
   with it: `:534` is now `['cartesian', 'sticky', 'textmarquee']`, three names, and
   `cartesian` is the replacement `NoteEntry` carrier.

   **Re-measured against the new `main` before this PR merged**, with the surviving
   controls plus `cartesian` (which fires, `<NoteEntry`):

   > **THE FINDING IS UNCHANGED.** The same five modules are TYPED —
   > `controlSurface`, `midiLane`, `archivist`, `peertube`, `recorderbox` — and the
   > same nine are clean, `midiclock` / `kria` / `matrixmix` among them.

   ⚠ **Only the CONTROLS moved, not the result — and there is no version of this
   document that would have told you that without re-running the scan.** A wave that
   cites `file:line` throughout has bought reproducibility, not permanence: **a
   citation is a coordinate into a tree that keeps moving**, and the mitigation is
   the one already in §10.5 — the instrument is inlined so the scan can be re-run,
   rather than the numbers being asserted and trusted.

   ⚠ **So the recipe above names the controls as of `cef7c16c0` and tells you to read
   the gate's list rather than copy them.** Hard-coding a positive-control list into
   a document is the same construct as hard-coding a population count, one level up:
   correct for the tree it was written in, and silently wrong for the next one.

9. **Two of this wave's own citations were wrong and a spec agent caught both** —
   `ModuleShellPlaceholder.svelte` is under `ui/modules/`, not `ui/workflow/`, and
   `FACES_WITHOUT_SCENES` is `_shell-faces.ts:3472`, not `:3391`. Corrected
   throughout. Recorded because a wave that spends this much effort on other
   documents' staleness owes the same accounting of its own.

---

## 11. DEFECT LEDGER — live on `main`, independent of any face

Consolidated from the seven specs. Each is measured; each names its file and line.

1. ⚠⚠ **`outToLaunch`'s LANE TILE PAINTS ANOTHER MODULE'S PICTURE, TODAY.**
   `hasVideoSurface` is `domain === 'video'` (`module-shell-model.ts:177-179`), so
   the placeholder tile mounts `VideoTileThumb`; `blitOutputToDrawingBuffer` returns
   early because `surface.texture` is `null` (`out-to-launch.ts:165-167`,
   `engine.ts:1765-1766`); and the thumb's `drawImage` copies the **shared engine
   drawing buffer anyway** (`VideoTileThumb.svelte:74-90`). It is the **only video def
   in the fleet with `outputs: []`**, and `hasVideoSurface`'s own doc comment names
   this exact failure while guarding the wrong direction. ⚠ **Promotion makes it
   worse**: `laneGlyphFor` returns `'picture'`, which OUTRANKS ranked cells (#1785).
   The fix is one clause in a file in no attest basis — `outToLaunch`'s precursor.
2. ⚠⚠ **`es9`'s `updateEs9Config` has exactly ONE caller** (`Es9Card.svelte:89`), on
   a card the default shell never mounts. So the bridge's per-jack **UNDERRUN POLICY
   does not follow the class param**, and **the CV-Buddy janitor's class writes never
   reach it at all**. Safety-relevant by the def's own words (`es9.ts:113-139`: *"a
   held gate … EMITS A WRONG SUSTAINED SIGNAL"*), invisible to every gate, and
   **already broken today**. `es9`'s precursor.
3. ⚠⚠ **`es9-card-shows-state.spec.ts`'s headline assertion is VACUOUS** —
   `.not.toContain('idle')` against a label vocabulary in which `'idle'` renders as
   **`off`**. The exact regression it was written for passes on the first poll, and
   its negative control (`text.length > 0`) does not rescue it. A second leg is both
   unreachable on CI and wrong if reached (`.toContain('stopped')` vs the label
   `off`).
4. ⚠ **`gamepad`'s inventory `why` is wrong on two counts**
   (`face-migration-inventory.ts:814-821`): there is **no "live device roster"** (one
   device NAME for the selected slot, plus four blind numbered buttons), and
   **`padIndex` IS a param**, against *"none of it is a param"*.
5. ⚠ **`GamepadCard.svelte:393-395` — a BARE PROXY WRITE to `t.params.padIndex`**, on
   a file whose seven `.data` writers all use `mutateNode`. Cmd-Z cannot undo a slot
   change. §6 — the first `params`-bag instance the census has ever seen.
6. ⚠ **`midiLane`: TEN bare `node.data` writes, two of them reactive `$effect`s**
   (`:154-159`) mirroring engine state into the Y.Doc **from every peer with the card
   open**. Third verbatim copy of the helper wave 5 found twice.
7. ⚠ **`launchpadControlLeft` persists a GRAPH NODE ID in `localStorage` with no
   lifetime** (`launchpad-control.svelte.ts:814`, `:855` — the bound clip-player's
   node id). Nothing clears it on delete, peer-delete or patch load.
8. ⚠ **`OutToLaunchCard.svelte:216`, `:224` RE-TYPE both param ranges the def
   declares** (`out-to-launch.ts:105-106`) — the backdraft class exactly. The card is
   not in `RANGE_BOUND_CARDS`, so **no gate compares them**. ⚠ Fix with
   `paramSpec(def,'x')`, **never** a new `export const` — that def IS in the attest
   basis (#2186).
9. ⚠ **`module-manifest.ts:773` is wrong about `midiLane.poly` on BOTH claims** —
   *"10-channel = 5 pairs"* (`POLY_CHANNEL_PAIRS = 16`) and *"only in POLY mode"* (the
   def says the opposite at `:277-281`, #674). **A third copy is inside the DEF**
   (`docs.outputs.poly`, `:303`), plus `:38` and `:329` — **five stale statements,
   one true number**, and no gate compares doc prose to code.
10. ⚠ **The best-documented module in the pair is invisible to every docs gate.**
    `launchpadControlLeft` has a hand-authored route page (one of nine in the tree),
    yet `MetaModuleDef` has no `docs` field, so `MODULE_DOCS` has no entry,
    `ctxMenuHasDocs` is false and **Annotate never appears** — while **Docs** works.
    Mechanically documented at `strict-docs.ts:303-323`. ⚠ Whoever adds `docs?` must
    re-point `module-annotate.spec.ts` in the same diff.
11. ⚠ **All 18 `gamepad.spec.ts` tests boot `?shell=legacy`** — correct today,
    **green-and-blind after promotion**: the face's remap / calibrate / invert /
    mapping paths would have zero coverage while 18 green tests say otherwise.
12. **`e2e/tests/control-surface.spec.ts:310` is a parked `test.fixme`** (#1847, 10
    recovered-on-retry in 96 h) — and the parked assertion is *exactly* the layout the
    face cannot reproduce (§8.1). **The park and the refusal are one finding seen from
    two sides.**
13. **Stale prose describing a card the promoted module will not have** —
    `out-to-launch.ts:114` `docs.explanation` and `module-manifest.ts:165` both say
    *"from the card"* / *"the on-card 9x9 preview"*; `es9.ts:25-28` and
    `bridge-client.ts:5-8` carry **three sentences saying the CARD owns the connection
    lifetime**, contradicted 340 lines later by the factory. Wave 6's `recorderbox`
    stale-`why` class, now in a def.
14. Minor: `module-manifest.ts:376-377` documents only the LEFT stick calibration
    while the right stick, its calibrate button and its `set center` all ship (the
    def's own `docs.explanation` is left-only too); `midi-lane.spec.ts:26` checks six
    of seven output handles and **omits `poly`**, the one output with a defect
    history; `es9`'s `stateDetail` is derived and never painted (`:51`); and
    `Es9OwnerSnapshot.supported` has no consumer, so a no-`Worker` environment reports
    `off` — indistinguishable from a user DISCONNECT.

### 11.1 ⚠ ONE THING NO AGENT COULD RUN, AND IT DECIDES A FILE COUNT

**Pre-flight before any `es9` VRT dispatch: `GREP=es9 task vrt:one -- es9`.**
`es9.ts:378` spawns the bridge Worker **unconditionally**, `SharedArrayBuffer` **is**
present on `/rack` (COOP/COEP are set for Faust), so the worker really does retry
`ws://127.0.0.1:9209` forever on CI — and `vrt.spec.ts` fails a card row on **console**
errors, not only page errors. **Whether Playwright surfaces the worker's failed-
WebSocket console error decides whether `es9`'s drain is 3 files or 2.** Nothing on
`main` answers it: neither `es9` e2e spec requests `errorWatch`. Recorded as a
measurement to take, not a guess to carry.

#### ✅ TAKEN, 2026-08-24 — **the answer is NO: the `es9` card row PASSES, console-error assertion included.**

Recorded here with its METHOD so the next reader can re-run it rather than believe it.

1. `task vrt:one -- es9` with the exemption in place → **"No tests found"**. An exempt
   module generates no row at all, so the naive run answers nothing. That is the first
   trap and it looks like a result.
2. Temporarily removed the `es9:` key from `EXEMPT_FROM_VRT` → the row generates.
3. First run FAILED on *"A snapshot doesn't exist … writing actual"* — the expected
   first-capture behaviour.
4. ⚠ **THAT FIRST RESULT WAS INCONCLUSIVE AND WAS VERY NEARLY REPORTED AS THE ANSWER.**
   The console-error assertion is `vrt.spec.ts:188`
   (`expect(errors, '<mod>: no console / page errors').toEqual([])`), which sits **after**
   the screenshot call — so a run that dies AT the screenshot never reaches it.
   *"No console-error failure appeared"* and *"no console errors occurred"* are different
   facts, and only the second one is the question. This is CLAUDE.md's
   validate-the-instrument shape: the gate was never executed, and its silence read
   exactly like a pass.
5. Second run, with the snapshot now present: **1 passed.** It got past the screenshot,
   reached `:188`, and `errors` was empty.

The exemption was then restored byte-for-byte, the macOS `es9.png` that run wrote was
deleted, and `test-results` cleared — tree verified clean.

**Two honest limits, recorded with the verdict rather than after it:**

* This is a **local macOS run**. The WebSocket retry is not renderer-dependent, so it
  should hold on linux, but the definitive answer is a CI run. Say that rather than
  promising it.
* The passing run took **1.6 s**. A connection-refused on localhost errors immediately,
  so the window is adequate — it is not unlimited, and a slower failure mode (a DNS
  timeout, a proxy) would not be covered by this measurement.

**What it means for the drain:** `es9`'s exemption text already reads *"VRT baseline
pending … card is static chrome. Promote + capture baselines in a follow-up PR"* — a
DEFERRAL, not a structural refusal — and this removes the one live objection to acting
on it. **`es9`'s drain is the SMALLER number, not the larger one.** It is not done here:
that is `es9`'s own promotion work.
