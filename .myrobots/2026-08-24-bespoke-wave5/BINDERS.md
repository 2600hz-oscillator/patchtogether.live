# THE BINDER COHORT — shared analysis for `midiCvBuddy`, `midiOutBuddy`, `chromaconsole`

Wave 4 named this cohort and did not spec it. `midiclock/spec.md` called it *"the
archetype of the **binder cohort** — the largest unblocked group left on the roster shares
its shape (connect gesture + live device roster + no params)"*, and wave 4's README closed
with a platform ask addressed specifically at unblocking it.

**This document is the cohort's shared reasoning.** The three per-module specs
(`midiCvBuddy/spec.md`, `midiOutBuddy/spec.md`, `chromaconsole/spec.md`) reference it
rather than repeating it three times.

Nothing here is implemented. This is a spec.

---

## 0. WHY THESE THREE, AND WHY TOGETHER

They are one group because they share ONE design problem, not because they share a palette
entry. All three are **BINDERS**: their job is to attach the rack to a piece of hardware
that is not in the rack.

| | `midiCvBuddy` | `midiOutBuddy` | `chromaconsole` |
|---|---|---|---|
| direction | hardware **→** rack | rack **→** hardware | rack **→** hardware |
| ports | 3 out (`pitch_cv`, `gate`, `velocity_cv`) | 4 in (`poly`, `gate`, `pitch`, `velocity`), **0 out** | **none at all** |
| `params` | `[]` (`midi-cv-buddy.ts:327`) | `[]` (`midi-out-buddy.ts:326`) | **8**, all identical (`deviceSlotParams`) |
| the gesture | **Connect MIDI…** → pick an input port | **Connect MIDI…** → pick an output port | **Connect MIDI…** → pick an output port |
| the roster | `MIDIAccess.inputs`, reached via `read('card-api')` | `MIDIAccess.outputs`, same | `api().listOutputs()`, same |
| what it binds to | a keyboard / controller | a hardware synth | ONE named pedal (Hologram Chroma Console) |

The three sit at deliberately different points on one axis — **how much of the module is
the binding, and how much is an instrument on top of it.** `midiCvBuddy` is almost purely
a binding with four settings. `midiOutBuddy` is a binding with one genuinely subtle idea
in it (the lane-channel override). `chromaconsole` is a binding carrying a **full eight-slot
assignable control surface**, which is why it is the only one of the three with any params
at all and the only one whose face has anything to rank.

**That spread is the reason the group is worth reading as a group.** The device-picker
problem is identical across all three and resolves once; everything ABOVE the picker
resolves three different ways, and a spec that only looked at `midiCvBuddy` would have
concluded the cohort is trivial.

---

## 1. ⚠ THE CORRECTION — WAVE 4's PLATFORM ASK IS BOTH TOO NARROW AND UNNECESSARY

This is the cohort's headline, and it overturns the routing call wave 4 closed on.

### 1.1 What wave 4 asked for

`.myrobots/2026-08-24-bespoke-wave4/README.md`, "THE ROUTING CALL":

> **The ask: give `ShellSelectorCell.options`/`value` the same `env` that
> `ShellActionCell` already gets.** One parameter, matching a shape the same file already
> has, and it would unblock the device picker for **midiclock, midiCvBuddy, midiOutBuddy,
> chromaconsole, outToLaunch, audioIn and cameraInput** at once — most of the binder cohort.

Three of those seven named adopters are this wave's subjects, so the cohort is the natural
place to test the ask. It does not survive the test.

### 1.2 The ask as stated would NOT unblock a single device picker

`shell-cells.ts:185-190` — the whole of `ShellCellEnv`:

```ts
export interface ShellCellEnv {
  engine: { write(node: ModuleNode, key: string, value: unknown): void } | null;
  /** The LIVE node (Y.Doc entry), or undefined before it resolves. */
  node: ModuleNode | undefined;
}
```

**`engine` is typed structurally, and the only member is `write`.** There is no `read`.

A device picker needs to LIST devices. Every one of the three reaches its roster through a
READ:

* `MidiCvBuddyCard.svelte:63` — `e.read(node, 'card-api')`, then `api.subscribe(…)` whose
  payload carries `devices` (`midi-cv-buddy.ts:250`).
* `MidiOutBuddyCard.svelte` — the same shape against `MidiOutBuddyCardState`.
* `ChromaconsoleCard.svelte:68` — `engine.read(node, 'card-api')`, then `api().listOutputs()`
  (`:83`).

So a `ShellSelectorCell.options` closure handed today's `ShellCellEnv` **still could not
enumerate one device.** The ask is well-aimed at the right seam and asks for the wrong
thing: the missing capability is not "selectors do not get `env`", it is "**`env` cannot
read**".

⚠ **The reason the mistake is easy is written into the type.** `ShellCellEnv`'s own doc
comment explains that `engine` is typed structurally *"so shell-cells never pulls the whole
PatchEngine import chain"*. That is a good reason for a narrow type and it is completely
silent about which methods are missing — the interface reads as "the engine, narrowed",
not as "the write half of the engine". Anyone reasoning from the sentence rather than the
signature concludes the engine is reachable.

### 1.3 And no platform change is needed at all

`PatchEngine.read(node, key)` exists (`engine.ts:2234`, delegating to `:828`), and it is
reachable from plain TypeScript today:

```ts
// $lib/audio/engine-ref.ts:23
export function getActiveEngine(): PatchEngine | null { return activeEngine; }
```

`getActiveEngine()` is not a proposal. It is consumed from plain `.ts`, right now, by at
least four module-owned action files, all of which are exactly the kind of file a
selector's `options` closure would live in:

```
$lib/ui/modules/manual-strike-actions.ts:71,156,187,250,319
$lib/ui/modules/twotracks-face-actions.ts:51,79,167
$lib/ui/modules/frametable-file-actions.ts:36,66
$lib/ui/modules/milkdrop-preset-actions.ts:28
```

And `shell-cells.ts` states the pattern in its own comments, twice, as the reason an
action does NOT take `env`:

> `shell-cells.ts:1405-1408` — *"It takes the nodeId and not the `env` handle:
> `fireManualStrike` resolves the live engine itself through `getActiveEngine()`, which is
> what lets a Svelte card with no ShellCellEnv share it."*

So the shipped codebase's own preferred idiom for reaching the engine from a cell is
**not `env` at all**. `env` is the narrow, write-only convenience; `getActiveEngine()` is
the general route, and it is the one the existing adopters took.

`ShellSelectorCell.options` is already `(node: ModuleNode | undefined) => SelectorOption<string>[]`
— **a plain function in a module-owned file.** It can call `getActiveEngine()?.read(node, 'card-api')`
on the line after it checks `node`. Nothing in the shell needs to change.

### 1.4 ⚠ THIS IS THE THIRD INSTANCE OF A FALSE BLOCKER THE SKILL ALREADY WARNS ABOUT

`.claude/skills/module-faceplates.md`, "ACTION cells REQUIRE a probe":

> ⚠ `getActiveEngine()` (`$lib/audio/engine-ref.ts:23`) is already exported and already
> consumed from plain `.ts` (`clipplayer.ts:28`, `push2-control.svelte.ts:61`). **Two
> independent agents invented the same false blocker** that a shell-cells action needs a
> platform PR to reach the engine. It does not. **Assume a third would too.**

Wave 4 is the third. The warning was written, it was in the file, and the shape mutated
just enough to walk around it — the previous two were about **actions**, wave 4's is about
**selectors**, and the skill's paragraph is filed under an actions heading. An agent
reading for the selector question does not find it.

**The instructive part is not that wave 4 was wrong.** Its reasoning was careful and its
supporting measurement was correct: `legacy-fallback.ts:70-73` really does say *"It is NOT
a ParamDef, so no shell face can render it"*, wave 4 really did identify that as a false
general claim, and it really did locate the correct constraint ("where the roster LIVES").
It then reached one step further than the evidence and proposed a platform change for a
capability that already exists. **A correct diagnosis followed by an unnecessary
prescription is harder to catch than a wrong diagnosis**, because everything up to the last
paragraph checks out.

### 1.5 THE STANDING RECOMMENDATION

**Do not schedule the `env`-for-selectors change.** It is not on any of these three
modules' critical paths, and shipped as specified it would not have unblocked them.

Three narrower things ARE worth doing, and each is small:

1. **Correct the two comments that manufacture the belief.** `legacy-fallback.ts:70-73`'s
   *"no shell face can render it"* is false as a general claim (wave 4 established this);
   `ShellCellEnv`'s doc should say **which** engine methods it carries and that
   `getActiveEngine()` is the route for anything else. Both are prose, both ride any face
   PR, and between them they are the whole reason three agents in a row reached for a
   platform change.
2. **Move the skill's `getActiveEngine()` warning out from under the ACTION heading** into
   a cell-shape-neutral position. It is written as a warning about actions and the third
   instance was about selectors.
3. If the write-only `env` is a deliberate boundary rather than an oversight, **say so in
   the type** — a narrow `env` whose narrowness is intentional and a narrow `env` that
   nobody has widened yet are indistinguishable today, and that ambiguity is what
   generated the ask.

⚠ **What this does NOT settle.** Whether a selector's roster SHOULD reach the engine at
all is a design question, not a capability question, and it is genuinely open. A roster
that is a pure function of `node` is trivially testable; one that reads a live engine
handle is not, and `shell-cells.test.ts`'s inert-cell sweep would have to grow a shape for
it. **The three specs here do not depend on the answer** — all three route their picker
through `fullViewBody` instead (§3), which is the shipped cameraInput answer and needs no
new cell shape. The capability correction is reported because wave 4's ask was about to be
scheduled, not because anything in this wave is waiting on it.

---

## 2. ⚠ WHAT EVERY ONE OF THESE THREE CARDS PAINTS THAT A FACE MAY NOT

All three cards were built before the resting-text ruling and all three violate it. **This
is the single largest visible change promotion makes to this cohort**, and it is worth
tabulating once because two of the four offenders are NOT the obvious ones.

The permitted resting text is exhaustively: the module NAME (dock title bar), TAB/SECTION
labels, CONTROL CAPTIONS, and option/landmark NAMES that disambiguate a control's own
position (CLAUDE.md, "Faceplate chrome"; gate: `face-resting-text-source.test.ts`).

| # | what it is | where | verdict | what replaces it |
|---|---|---|---|---|
| 1 | `NOTE` / `VEL` readout rows | `MidiCvBuddyCard.svelte:187-196` | ⛔ **REMOVED.** A labelled derived value at rest beside the control it describes — the deleted hero readout strip's exact shape (#1957) | the ACTIVITY DOT survives (§2.1); the note value goes to `aria-valuetext` |
| 2 | `NOTE` readout row + lit dot | `MidiOutBuddyCard.svelte:240-246` | ⛔ **text REMOVED, dot KEPT** | same |
| 3 | `↯ CH {channel} ≠ LANE {laneChannel}` badge | `MidiOutBuddyCard.svelte:230-238` | ⛔ **text REMOVED** — and it carries a real finding, so see §2.2 | the `[data-ch-override='true']` OUTLINE, which is already the non-text half of the same signal |
| 4 | `Send-only — the pedal cannot report back…` | `ChromaconsoleCard.svelte:228-230` | ⛔ **REMOVED**, and this one is contested — see §2.3 | the authored `docs` prose, reachable by right-click Annotate |
| 5 | per-slot value readout | `ChromaconsoleCard.svelte:284` | ⛔ **REMOVED**, and it removes itself — see §2.4 | `aria-valuetext` |
| 6 | `pedal-snapped` marker | `ChromaconsoleCard.svelte:291` | ⛔ **REMOVED** — see §2.4 | ⚠ nothing yet. This is the cohort's one genuine loss |
| 7 | `N slot(s) point at controls this device no longer has` | `ChromaconsoleCard.svelte:221-223` | ⛔ **REMOVED as text** | a per-slot visual state on the offending cells; §2.5 |

### 2.1 The ACTIVITY DOT is not a readout, and the distinction is load-bearing

`MidiOutBuddyCard.svelte:244` is `<span class="dot" class:lit={cardState.activeNote !== null}>`.
It carries no text. It is a lit/unlit mark whose entire content is a colour.

**The ruling is about TEXT.** Its own wording — *"A value, a measurement, a state word or a
sentence has no place"* — enumerates textual shapes, and the permitted list is a list of
text roles. A non-text indicator is not addressed by it and is not removed by it. The same
reasoning is why `[data-ch-override='true']`'s outline survives while the badge does not,
and why the four NON-COLOUR direction channels in `rear-direction.ts` are an accepted way
to carry meaning without printing it.

⚠ **Do not over-apply this.** A dot that carries the SAME information as a forbidden
readout is fine; a "compact" or "abbreviated" version of the readout is not — *"there but
hidden"* was refused by name. The test is whether a reader has to read anything.

### 2.2 THE CHANNEL-OVERRIDE BADGE — the finding that must not lapse

CLAUDE.md: *"**Deleting a readout deletes a FINDING** … When you remove one, **say which
finding lost its surface** rather than letting the coverage quietly lapse."*

The badge's finding is real and non-obvious: **this module lives in lane N but sends MIDI
on channel M.** `midi-out-buddy.ts:15-22` documents that `midiOutChannel` absent means
"follow the lane" and present means an explicit override *"that leaves lane membership +
the clip assignment completely untouched"* — i.e. the two can disagree indefinitely, and
nothing else on screen says so. `MidiOutBuddyCard.svelte:154-156` even carries a comment
about why writing the wrong key would be read as a LANE REASSIGNMENT (#1168). This is a
foot-gun the card was deliberately built to surface.

**It does not lapse, and no design work is needed to save it**, because the card already
carries the same signal on a second, non-text channel:

```svelte
<!-- MidiOutBuddyCard.svelte:189-191 -->
<!-- data-ch-override is BOTH the styling hook and the state the e2e reads: one
     source of truth for "this module routes MIDI off its lane". -->
<div class="mod-card midi-out-buddy-card" data-ch-override={channelOverridden ? 'true' : 'false'}>
```

`:258-259` gives that attribute a violet outline, chosen (per the CSS comment) so that
*"a divergent route is unmistakable"*, and explicitly *"Outline + shadow only, so the
card's geometry never shifts."*

**So the face keeps the outline and drops the badge**, and the exact channel numbers move
into `aria-valuetext` on the CH cell. The e2e reads `data-ch-override`, not the badge text,
so no assertion is weakened by the removal — which is the same property that let the
original readout deletion land without weakening a single spec.

⚠ **One thing genuinely narrows and the spec should not pretend otherwise.** The badge
names the two numbers; the outline says only *that* they differ. `title=` on the badge
(`:234`) already carried the full sentence and a hover string is *"there but hidden"*, so
it goes too. The replacement is `aria-valuetext` on the channel cell — speakable and
assertable, unpainted. That is a real reduction in at-rest information and it is the
ruling's intended trade, not an oversight.

### 2.3 ⚠ THE OPEN-LOOP SENTENCE — the one place this cohort needs an OWNER DECISION

`ChromaconsoleCard.svelte:226-230`:

```svelte
<!-- The open-loop statement. Permanent, not a transient toast: it is true at
     every moment, not just after an error. -->
<p class="openloop">
  Send-only — the pedal cannot report back. These show what was sent, not what the pedal holds.
</p>
```

Under the ruling this is a SENTENCE on a faceplate and it goes. Under the card author's
argument — set out at length in that file's header, `:4-18` — it is the one thing standing
between the user and a specific false belief:

> *"'connected' means A PORT IS SELECTED. It does NOT mean the pedal is there, powered, on
> the right MIDI channel, or showing these values. … There is deliberately no 'synced'
> light, no checkmark, and no green state. A reassuring indicator would be a lie, and the
> one thing worse than an unsynced device is an unsynced device that claims otherwise."*

**These are not reconcilable by a spec, and pretending otherwise is how the wrong thing
ships.** The ruling is exhaustive and admits no "unless it is important" clause — that is
precisely the property that made it survive four mechanisms. But the sentence is also not
decoration: it is a correctness warning about a receive-only device, authored deliberately
as permanent rather than transient.

**Three routes, and the choice is the owner's:**

| route | what it costs |
|---|---|
| **(a) DELETE it.** The explanation is already in `chromaconsole.ts:61-76`'s `docs.explanation`, verbatim and at greater length, reachable by right-click Annotate | the warning is one gesture away instead of zero, on the only module in the fleet where the screen can silently disagree with the hardware |
| **(b) DELETE the text, keep a NON-TEXT signal** — the §2.1 principle applied to a whole-module state rather than a control | a mark that means "open loop" and is not a word has to be legible without one. There is no such vocabulary today, and inventing an icon language on a module PR is out of scope |
| **(c) An OWNER EXCEPTION** naming this one sentence on this one face | a fifth mechanism, and the ruling's whole strength is that it has never granted one |

**The spec's own recommendation is (a)**, on the narrow ground that the text is already
authored in `docs` and therefore genuinely survives rather than being lost — which is not
true of any of the other six rows in §2's table. But it is recorded as an owner question
rather than decided, because the card's header is an argument by a person for permanence
and this document is not the place to overrule it.

⚠ **`face-resting-text-source.test.ts` would not catch this either way.** It denies
`ModuleFace` FIELDS with no permitted text role — it reads the type, not a
`fullViewBody`'s markup. A sentence rendered inside a shell extension is invisible to it,
exactly as text drawn into a canvas is. **Whichever route is chosen, the enforcement is a
dock VRT baseline and a human reading it.** Naming that gap is required; implying the gate
covers it is the failure this repo cares most about.

### 2.4 THE SLOT READOUT DELETES ITSELF — and takes a real signal with it

Two rows, one mechanism.

`ChromaconsoleCard.svelte:284` renders `readoutFor(slot?.controlId, paramVal(slotId))`,
which calls `formatControlValue(control, value)` — a **DEVICE-DESCRIPTOR** function
(`device-descriptor.ts`), keyed on the descriptor's per-control `format` field (`:129`).

**That format lives on the DeviceControl, not on the ParamDef.** `deviceSlotParams`
(`device-module.ts:86-100`) emits `{ id, label, defaultValue, min, max, curve }` and
nothing else — no `format`, no `options`.

Consequences, both of which are convenient and neither of which is designed:

* A face's knob asks `paintsReadout(vocab)` (`knob-vocabulary-model.ts:144`), which
  requires a named roster and no declared `format`. A bare `0..127 linear` param with
  neither has no readout to paint. **The value readout vanishes with zero work** — no
  removal commit, no gate to satisfy.
* ⚠ **And so does `pedal-snapped`.** `:287-292` renders that marker from
  `control.quantize`, whose entire purpose is stated in place: *"The pedal snaps this and
  cannot be told not to. Saying so on the control is the only way the user can reconcile a
  smooth-looking number with a stepped-sounding result."* `device-module.ts:79-84` is a
  second, independent argument for the same thing — it explains that `curve` deliberately
  stays `'linear'` on a quantized control because declaring `discrete` over 0..127 would
  claim 128 detents, and that *"the honest signal for that is the READOUT"*.

**So the module's own source names the readout as the honest signal for a property the
param declaration is deliberately unable to carry, and the face removes the readout.**
That is the cohort's one genuine information loss, and it is worth stating sharply because
it is easy to miss: two controls (RATE and TIME, per `chromaconsole.ts:74-76`) become
smooth-looking dials over a stepped response with nothing anywhere saying so.

Two things it is NOT:
* It is **not** an argument for keeping the readout. A number under a dial is the deleted
  mechanism by name.
* It is **not** a parity blocker. `quantize.note` is descriptor data and reaches
  `aria-valuetext` on that cell without any new capability.

⚠ **But `aria-valuetext` is unpainted by construction**, so a sighted player operating the
dial gets nothing. If a non-text marker for "this control is quantized by the hardware" is
wanted, that is a **platform-level control-vocabulary question** — it would apply to every
device module, not just this pedal — and it is out of scope for a module PR. **Recorded as
the second owner-facing item in this cohort.**

### 2.5 THE STALE-SLOT WARNING — text out, per-cell state in

`:217-224` prints a count of unresolvable saved assignments, and its comment is right about
why it exists: *"a slot that quietly behaved like an empty one would leave automation
writing into a dead lane with nothing anywhere saying so."*

The text goes (it is a derived sentence containing a derived count). The signal does not
have to: staleness is a property of an individual slot, `status.staleSlots` already
identifies WHICH, and the face renders eight slot cells. **Mark the offending cells, not
the module** — which is strictly better than the card's version, because the card tells you
how many and not which.

⚠ And note what the card's phrasing is: *"{status.staleSlots.length} slot(s) point at
controls this device no longer has"* — **a hand-typed population count rendered into the
UI**. It is derived at runtime rather than typed as a literal, so it is not the construct
CLAUDE.md's ratchet section forbids, and it is **not** a bug to go fix. It is noted only
because "a count of a population" is the shape that section trains you to look at twice,
and the correct reading here is that the count is the least useful part of the message.

---

## 3. WHERE THE PICKER GOES — `fullViewBody`, for all three, and it is already shipped

None of the three needs the §1 capability, because none of them routes its picker through a
cell at all.

`face.extension: '<id>'` → `$lib/ui/modules/<id>/shell-extension.ts` → the `fullViewBody`
slot. `WIRED_SHELL_EXTENSION_SLOTS` is `['glyph', 'fullViewBody']` (`shell-extensions.ts:124`),
so the slot is wired, and `CameraInputOutputBody.svelte` is the shipped precedent for
exactly this problem — a device picker whose roster lives behind a browser API.

A `fullViewBody` is a Svelte component. It has `useEngine()`, it has `getActiveEngine()`,
and it has no cell contract to satisfy — which is why it needs no probe and no new
`SHELL_CELLS` shape. It is **dock-only** by `dockFullViewHeadPlan`; the lane keeps the
generic tile, which for these three is correct (§5).

**All three bodies are the same component twice over**, which is worth saying because it is
the cohort's practical payoff: CONNECT button + port `<select>` + a channel `<select>`,
over an `MIDIAccess.inputs`-or-`.outputs` roster, with a permission-denied path. Whether
that becomes one shared `MidiBinderBody.svelte` or three near-copies is a build-time call,
not a spec-time one — ⚠ but note that `module-shell-import-guard.test.ts` denies the shared
shell layer from referencing module-owned directories, so a shared body must live somewhere
that is not the shell, or be a declared BOUNDARY entry. **Flagged so the build agent
resolves it before writing three copies.**

---

## 4. THE `.data` RAW-WRITE CENSUS — wave 3 gave 2, wave 4 gave 6, this makes 9

Wave 4's README established the finding that matters: `mutate.guard.test.ts`'s patterns
anchor on the literal token `.params` (`RAW_PARAM_WRITE`, `RAW_PARAM_WRITE_KEY`,
`WHOLE_BAG` — all three, verified at `:94-110`), so the guard is **structurally blind to
`.data` writes**, and it therefore cannot distinguish the careful modules from the careless
ones.

Three more data points:

| module | what lives in `node.data` | transacted / `LOCAL_ORIGIN`? |
|---|---|---|
| `midiCvBuddy` | `channel`, `priority`, `retrig`, `lastDeviceId` | ✗ — `MidiCvBuddyCard.svelte:89-97`, a bare proxy write, no `ydoc.transact`, no origin |
| `midiOutBuddy` | `midiOutChannel`, `lastDeviceId` | ✗ — `MidiOutBuddyCard.svelte:135-143`, **byte-for-byte the same helper** |
| `chromaconsole` | `assign` (the 8 slot→CC map) | ✓ — `chromaconsole.ts:105-111`, inside `ydoc.transact` |

⚠ **The two `writeData` helpers are the same function pasted twice**, which is the more
useful form of the finding than "two more modules are wrong": it says the raw-write pattern
**propagates by copy** through a cohort whose members are deliberate siblings, and a guard
that cannot see it cannot see it spreading either.

Running total across waves 3–5: **five modules writing `.data` untagged
(`kria`, `audioOut`, `midiclock`, `midiCvBuddy`, `midiOutBuddy`), three tagged
(`picturebox`, `matrixMix`, `chromaconsole`), one n/a (`twotracks`) — and `mutate.guard` is
green over all nine.**

⚠ **`chromaconsole` transacts but does NOT pass `LOCAL_ORIGIN`** — `ydoc.transact(fn)` with
one argument (`:105`). `store.ts:32-39,70` shows the UndoManager tracks
`trackedOrigins=[LOCAL_ORIGIN]`, so an untagged transaction is atomic but **outside the
undo stack**: Cmd-Z will not undo a slot reassignment. That is a third state the wave-4
table's binary ✓/✗ column cannot express, and it is a live defect rather than a spec
question — folded into chromaconsole's defect ledger.

**Routing is unchanged from waves 3 and 4.** The module-level fixes are small and ride
their own face PRs. Whether `.data` gets an origin-tagged seam and a ledger is a separate
owner-facing decision; this wave reports, does not build, and no spec here assumes it lands.

---

## 5. THE LANE PICTURE — refused for all three, by the mechanism wave 2 established

None of the three is in `NON_SHELL_LANE_TYPES` (`legacy-fallback.ts:96-112` —
`group`, `sticky`, `cadillac`, `clipplayer`, `controlSurface`, `electraControl`,
`launchpadControlLeft`), so all three get a `ModuleShell` lane tile on promotion.

All three are `domain: 'audio'`, so `hasVideoSurface` is false and the wave-4
`picturebox` escape does not apply. They are on the glyph seam, where
`ShellExtensionGlyphProps` (`shell-extensions.ts:44-52`) carries `num`, `numbers` and
`testid` and **no `nodeId`** — so a glyph is a pure function of a discrete param value and
every instance would draw an identical picture.

| module | outputs | resolves | verdict |
|---|---|---|---|
| `midiCvBuddy` | `pitch_cv` (cv), `gate`, `velocity_cv` (cv) — **no `audio`** | `primaryAudioOutPortId` matches `type === 'audio'`; none exists ⇒ any literal → `{kind:'static'}` ⇒ dead-glyph clause | `glyph: 'none'`. Mechanically forced |
| `midiOutBuddy` | **none at all** — a terminal MIDI sink (`:324`) | same, more strongly | `glyph: 'none'`. Mechanically forced |
| `chromaconsole` | **none at all** (`:52-53`, zero ports both ways) | same | `glyph: 'none'`. Mechanically forced |

**The useful glance for all three is identical and none of the five `VALID_GLYPHS` members
expresses it:** *is this thing bound to a device, and is traffic flowing?* That is a
BINDING STATE plus an EVENT RATE, and every valid glyph describes a continuous audio
quantity. It is the same gap wave 4 identified for `midiclock` and named as the argument
for a sixth glyph — **and this cohort strengthens the argument from one module to four**,
which is exactly the kind of evidence a platform change should wait for.

**No spec here invents one.** A new glyph kind on a module PR is the wrong shape; wave 4
refused for the same reason and the refusal is more defensible now, not less.

---

## 6. VRT — TWO DISCHARGEABLE EXEMPTIONS AND ONE COMMITTED BASELINE

| module | today | after a face |
|---|---|---|
| `midiCvBuddy` | `EXEMPT_FROM_VRT:720` — *"card content depends on connected MIDI device; unit + E2E provide coverage"* — **and permanent** (`:1174`) | 2 face scenes added; **discharge the exemption** |
| `midiOutBuddy` | `EXEMPT_FROM_VRT:725`, *"same rationale as midiCvBuddy"*, **permanent** (`:1175`) | 2 added; **discharge** |
| `chromaconsole` | ⚠ **no exemption — one committed baseline**, `e2e/vrt/__screenshots__/vrt.spec.ts/chromaconsole.png` | 1 moved, 2 added |

⚠ **`midiCvBuddy` is the ROOT of the exemption's stated reason, and three other modules
inherit it by reference.** `:721`, `:726` and `:731` each say *"same rationale as
midiCvBuddy"* — for `midiOutBuddy`, `midiclock` and `midiLane`. Wave 4 already showed the
rationale is falsifiable for `midiclock` two ways: the pre-Connect view is deterministic by
the exemption's own concession, and `e2e/tests/_per-port-drivers.ts:726` already mocks
`requestMIDIAccess` and pumps a deterministic clock stream, built for the per-port sweep
and never carried back.

**This wave adds the sharper point: it is one rationale, written once, referenced four
times.** Discharging it at the root discharges it for the cohort. Whichever way it goes,
the decision should be made once at `midiCvBuddy` rather than four times.

⚠ **`chromaconsole`'s baseline is the opposite hazard, and the card knows it.** Its header
(`:20-28`) states that the resting render must be byte-stable and lists what was excluded
to keep it so: *"no message counters, no activity blink, no elapsed times, no 'last CC
sent' readout."* It then observes that the two constraints agree — the determinism argument
and the honesty argument both delete the same element.

**They agree a third time.** Every one of those excluded elements is exactly what the
resting-text ruling forbids. A card built for VRT determinism in 2026-07 independently
arrived at most of a ruling made in 2026-08. **That is the strongest available evidence
that the ruling is a design principle and not a preference** — and it makes chromaconsole
the cheapest face in this cohort to get right, because its author already did the removal
pass for a different reason.

---

## 7. COST, PER MODULE

| | `midiCvBuddy` | `midiOutBuddy` | `chromaconsole` |
|---|---|---|---|
| **WebGL attest** | ZERO | ZERO | ZERO — the basis names two audio defs, `cube.ts` and `wavesculpt.ts` (`webgl-attest-lib.ts:68-69`); none of these three is in it |
| **ART** | ZERO — no audio path | ZERO — terminal MIDI sink, no audio out | ZERO — zero ports |
| **contract-lock** | unchanged if no param is added | unchanged if no param is added | unchanged — `face` is fully contract-transparent |
| **Push 2 card** | unchanged — `params: []`, nothing to rank | unchanged — `params: []` | ⚠ **unchanged, and for a good reason**: `push-card-config.ts:64` already pins all eight slots as an explicit `PUSH_CARD_CONTROLS` override, and an override REPLACES, so a face cannot re-rank it |
| **docs** | already in `STRICT_DOCS:225` | already in `:227` | already in `:253` |
| **VRT** | 2 added, discharge | 2 added, discharge | 1 moved, 2 added |

**All three are already documented and already strict**, so the living-docs ratchet is
satisfied on arrival — unusual for this roster and worth noting as a reason the cohort is
cheap.

---

## 8. VERDICTS

| module | verdict | the one-line reason | risk | est. |
|---|---|---|---|---|
| `midiCvBuddy` | **PROMOTE** | zero params, four `node.data` settings, one connect gesture — the cohort's minimal case, and the root of an exemption three siblings inherit | LOW | ≈ 6 h / 1 PR |
| `midiOutBuddy` | **PROMOTE** | the same body plus ONE real idea (the lane-channel override), whose finding survives promotion on the outline it already has | LOW/MED | ≈ 7 h / 1 PR |
| `chromaconsole` | **PROMOTE** | eight identical slots is the family-key problem in its purest form, and the card's VRT-determinism pass already did most of the resting-text removal | MEDIUM | ≈ 10 h / 1 PR |

**Build `midiCvBuddy` first.** It is the smallest, it settles the shared
`fullViewBody` binder body that the other two reuse, and it is where the VRT exemption
decision has to be made anyway.

## 9. THE TWO OWNER-FACING ITEMS

1. **chromaconsole's open-loop sentence** (§2.3) — delete it, replace it with a non-text
   signal that does not exist yet, or grant the ruling's first exception. Recommendation:
   delete; the text is already in `docs.explanation` verbatim.
2. **A control-vocabulary marker for "the hardware quantizes this"** (§2.4) — applies to
   every device module, not just this pedal, and the face removes the only surface that
   carried it. Out of scope for a module PR either way.

And one correction that is NOT a decision, only a report: **§1 — wave 4's `env`-for-selectors
platform ask should not be scheduled.** It would not have unblocked the cohort it named, and
the capability it asks for already exists under a different name.
