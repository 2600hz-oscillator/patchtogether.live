# FACEPLATE BUILD SPEC — `midiCvBuddy` (audio, the hardware-keyboard BINDER)

**Mocks:** [`dock.html`](dock.html) · [`dock-connect.html`](dock-connect.html)
**Cohort analysis:** [`../BINDERS.md`](../BINDERS.md) — read §1, §2, §4, §5, §6 first; this
spec does not repeat them.

Nothing here is implemented. This is a spec.

---

## 0. THE CONSTRAINT MAP, READ FIRST

```
def          packages/web/src/lib/audio/modules/midi-cv-buddy.ts     655 lines
card         packages/web/src/lib/ui/modules/MidiCvBuddyCard.svelte  271 lines
e2e          e2e/tests/midi-cv-buddy.spec.ts                          3 tests
             e2e/tests/midi-autobind-perfzip.spec.ts                  (see §8.2)
docs         STRICT_DOCS:225 — ALREADY STRICT
VRT          EXEMPT_FROM_VRT:720 + ALLOWED_PERMANENT_EXEMPT:1174
push2        no entry — params: [], nothing to rank
attest       NOT in webgl-attest-lib.ts's basis. ZERO.
ART          no audio output path. ZERO.
```

| the fact | where | what it forces |
|---|---|---|
| `params: []` | `:327` | **nothing to rank.** `face.order` is empty; every control on this face is a `fullViewBody` element or a shell cell |
| four settings live in `node.data` | `MidiCvBuddyData`, `:261-272` | `channel`, `priority`, `retrig`, `lastDeviceId` — none is a `ParamDef`, so none is on the generic face path |
| the device roster is on the ENGINE HANDLE | `:632-635` `read('card-api')` | not derivable from `node`; the picker cannot be a `ShellSelectorCell` today (BINDERS §1) |
| outputs are `cv`/`gate`/`cv` — no `audio` | `:319-323` | `glyph: 'none'` is mechanically forced (BINDERS §5) |
| MIDI permission is deferred to a click | `:31-36`, `:526-560` | the face has **two resting states**, and only one of them is the interesting one |

### 0.1 THE ONE FACT THAT DEFINES THIS FACE

**There is nothing to rank, and that is not a problem to solve — it is the module.**

`params: []` with a comment saying why (`:324-327`): *"No knob params — all settings are
dropdown/toggle on the card and live in node.data. (Channel selector + voice priority +
retrig are discrete, not continuous, so they don't fit the AudioParam shape.)"*

Wave 4 met the zero-param case twice and resolved it two opposite ways: `matrixMix` had
nothing to rank and no jacks either, so its face had to be argued into existence;
`midiclock` had nothing to rank *because one of its two settings was never declared as a
param*, and declaring it made the module nearly generic.

⚠ **midiCvBuddy is a THIRD outcome, and the difference is the reason it is worth specifying
rather than batching.** Its four settings are genuinely not param-shaped, and the def says
so with an argument that is correct:

* `channel` is `0..15 | null` — the `null` is a real value ("all channels"), and a
  `ParamDef` has no null.
* `priority` is `'last' | 'low' | 'high'` — three named strings.
* `retrig` is a boolean.
* `lastDeviceId` is an opaque browser-assigned string.

**Two of the four could be forced into params and one genuinely cannot.** `priority` would
be a `0..2 discrete` with an `options` roster (the gatemaiden shape — names that already
exist and the shell cannot otherwise reach). `retrig` would be a `0..1` toggle. `channel`
would need a 17th value to encode ALL, and `lastDeviceId` is not a quantity at all.

**This spec declines all four**, and the reason is not effort:

> ⚠ **Do not "fix" a declaration to satisfy a face.** CLAUDE.md: *"Before 'fixing' a
> declaration to satisfy a gate, check the consumer reads it."* Converting `priority` and
> `retrig` to params so the face has something to rank would put **two of the module's four
> settings on the faceplate and two in a `fullViewBody`**, split by nothing a player can
> perceive. A binder's four settings are one idea. They belong on one surface.

The consequence is stated plainly rather than hidden: **this face's `face.order` is empty
and its entire operable surface is its extension body.** That is an unusual shape and it is
the honest one.

### 0.2 ⚠ THE `.data` WRITES ARE UNTAGGED — and the helper is copy-propagated

`MidiCvBuddyCard.svelte:89-97`:

```ts
function writeData(patch_: Partial<MidiCvBuddyData>): void {
  const target = patch.nodes[id];
  if (!target) return;
  if (!target.data) target.data = {};
  for (const [k, v] of Object.entries(patch_)) {
    if (v === undefined) delete target.data[k];
    else (target.data as Record<string, unknown>)[k] = v as unknown;
  }
}
```

No `ydoc.transact`, no `LOCAL_ORIGIN`. Four call sites (`:102`, `:109`, `:115`, `:121`).

⚠ **The same function, byte-for-byte, is `MidiOutBuddyCard.svelte:135-143.`** See
BINDERS §4 — the finding is not "two modules are careless", it is that the pattern
propagates by copy through a cohort of deliberate siblings while `mutate.guard` is green
over all of them, because its three patterns all anchor on the literal token `.params`
(`mutate.guard.test.ts:94-110`).

Consequences that are user-visible and are therefore fixed in this PR:

* **Cmd-Z does not undo a settings change.** `store.ts:70` configures the UndoManager with
  `trackedOrigins: new Set([LOCAL_ORIGIN])`; an untagged write is outside it.
* **Four separate writes are four separate transactions**, so a collaborator can observe
  an intermediate state. Not currently reachable (the card writes one key per gesture), but
  the helper takes a `Partial<>` and invites a multi-key call.

**Fix, in this PR:** wrap the loop in `ydoc.transact(fn, LOCAL_ORIGIN)`. Two lines. The
face must write `node.data` anyway, so the fix and the face touch the same seam and belong
in the same diff (CLAUDE.md: a bug found mid-task is fixed in the same PR, with the story in
the PR body).

---

## 1. WHAT THE MODULE IS FOR

**One sentence:** it makes a hardware keyboard into a monophonic voice the rack can patch.

The verb the player performs is *plug in a keyboard and play*. Everything else on the
module exists to make that gesture correct: WHICH keyboard (device), WHICH channel it is
transmitting on, WHICH note wins when you hold a chord (priority), and whether a new key
under a held gate re-fires the envelope (retrig).

The one thing it does that its siblings do not: **it is the monophonic workhorse, and the
mono-ness is a feature.** `docs.explanation` (`:331`) says so directly — *"For polyphony,
use MIDI LANE's poly output instead; this module is the simple mono workhorse."* `pickWinner`
(`:111-128`) is the entire idea: three named strategies for collapsing a chord to one note,
which is a decision `midiLane` never has to make.

**Every rank in this spec descends from that** — except there are no ranks, because there
is nothing to rank (§0.1). The ordering question instead becomes: *in what order does the
BODY present four settings?* §5.

---

## 2. STOP 1 — is promoting this module a PARITY LOSS?

**No.** Verdict: **PROMOTE.**

Thinness does not refuse (owner, 2026-08-20). The refusal test is whether the promoted
face **drops something the player can do or see today**, and the two filed precedents show
what a real loss looks like: #1974 (`joystick` — every lane tier resolves to zero controls
on a module whose whole purpose is one pad) and #2065 (`spectrograph` — an audio-domain
module with a live canvas has no engine surface for the shell to paint).

Neither applies:

* midiCvBuddy's controls are not param-shaped, so the `laneOrder`/`foldedOrder` collapse
  that killed joystick's pad has nothing to collapse. The lane tile shows a title and a
  patch panel **today as well as after** — `MidiCvBuddyCard.svelte:141-199` puts every
  control inside `PatchPanel`'s default slot, and the lane tier ladder never showed them.
* There is no canvas. Nothing to paint.

⚠ **The parity question that DOES need an answer is the DOCK one, and it is where the
work is.** Promotion sets `migrated(type)` true, and `DockFullView.svelte:319` then renders
`<ModuleShell view="dock-full">` **instead of** `MidiCvBuddyCard.svelte`. Everything in
§3's grep must exist in the face or the module loses it.

---

## 3. STOP 2 — does every way of getting DATA IN survive?

```sh
grep -nE '<button|<select|<input|oncontextmenu|manualTrigger|Toggle|Selector|accept=' \
  packages/web/src/lib/ui/modules/MidiCvBuddyCard.svelte
```

Five hits. Every one maps:

| # | line | affordance | survives as |
|---|---|---|---|
| 1 | `:144` | `Connect MIDI…` button | `fullViewBody` button. ⚠ **must be called straight from the click handler** — see §3.1 |
| 2 | `:155` | DEVICE `<select>` over `cardState.devices` | `fullViewBody` `<select>`. Roster from `read('card-api')`; BINDERS §1 |
| 3 | `:165` | CH `<select>` — ALL + 1..16 | `fullViewBody` `<select>`. ⚠ 17 options; not a `Segmented` |
| 4 | `:175` | PRIO `<select>` — LAST/LOW/HIGH | `fullViewBody` `<select>`, OR a `Segmented` (3 options) — §5.2 |
| 5 | `:183` | RETRIG `<input type=checkbox>` | `fullViewBody` toggle |

**Plus two non-interactive elements the grep does not catch and the ruling does:**

| | line | what | verdict |
|---|---|---|---|
| 6 | `:150` / `:148` | the connect hints (`"Click to grant MIDI access (one-time per origin)."` / `"Permission denied or browser unsupported."`) | §3.2 — **split verdict**, they are not the same kind of text |
| 7 | `:187-196` | the `NOTE` / `VEL` readout block | ⛔ **REMOVED.** BINDERS §2 row 1 |

**Nothing is unrepresentable. No exemption is needed. STOP 2 passes.**

### 3.1 ⚠ THE CONNECT BUTTON HAS A USER-ACTIVATION CONSTRAINT AND THE CARD DOES NOT SAY SO

`ChromaconsoleCard.svelte:108-110` carries the rule explicitly:

> *"Straight from the click handler — an await before requestMIDIAccess spends the user
> activation and Chromium refuses to prompt."*

`MidiCvBuddyCard.svelte:83-87` is `async function onClickConnect() { const api = getApi();
if (!api) return; await api.connect(); }` — no `await` before `connect()`, so it is
**correct today**, and it is correct **by accident of ordering** with nothing recording
why.

**Carry the constraint into the extension body as a comment on the handler.** A
`fullViewBody` is new code written by a different agent months later; the failure mode is
silent (no prompt, no error, a button that looks broken) and the fix is invisible in
review. This is the cheapest possible defence and it costs one comment.

### 3.2 ⚠ THE TWO HINTS ARE NOT THE SAME KIND OF TEXT — split the verdict

Both are sentences, so the reflex is to delete both. That reflex is wrong on one of them,
and getting it wrong in either direction is a real cost.

**`:150` — `"Click to grant MIDI access (one-time per origin)."` ⛔ DELETE.** It describes
what a labelled button does. The button says `Connect MIDI…`; the sentence adds only the
parenthetical, which is exactly the kind of explanation the fleet moved into right-click
Annotate. `docs.explanation` (`:331`) already carries it: *"Web MIDI permission is requested
only when you click Connect, not on patch load."*

**`:148` — `"Permission denied or browser unsupported."` ✅ KEEP.** It is not resting text.

The distinction is the ruling's own: it governs the **RESTING** faceplate — *"the resting
faceplate paints no derived-state text"*. A message that appears only after a failed
action, on a plate that otherwise never shows it, is not at rest; it is the outcome of a
gesture. Deleting it leaves a button that does nothing with no way to find out why, on the
one code path where the browser has actively refused. The deleted mechanisms were all
*permanently painted* — the decimal under every dial, the sidebar on every face, the hero
strip on 50 of 68 faces, a caption a heading already conveyed. None of them was conditional
on a failure.

⚠ **`midiOutBuddy` already got this right and midiCvBuddy did not**, which is worth
carrying into the build: `MidiOutBuddyCardState.accessMessage` (`midi-out-buddy.ts:186-189`)
is a *human-readable reason* with a comment saying *"a SUPPRESSED prompt used to look
identical to a broken button"*, sourced from `$lib/audio/midi-access`. midiCvBuddy has only
a boolean `permissionDenied` (`:379`, `:529`) and one flat string that **conflates
"permission denied" with "this browser has no Web MIDI"** — two conditions with different
user actions (grant it / use a different browser).

**Fold into this PR:** move midiCvBuddy onto the shared `midiOutcomeMessage` helper its
sibling already uses. It is a ~6-line change on a module whose card is being rewritten
anyway, and it converts a KEPT piece of text from misleading to correct — which is a better
use of this PR than deleting it would be.

---

## 4. THE LANE PICTURE — refused, mechanically

BINDERS §5. `glyph: 'none'` is forced: the outputs are `cv`/`gate`/`cv` with no `audio`
port, `primaryAudioOutPortId` matches `type === 'audio'`, so any other literal resolves to
`{kind:'static'}` and the dead-glyph clause reddens unconditionally.

**The lane tile after promotion:** module name + `PatchPanel` jacks (PITCH / GATE / VEL),
same as today. `laneRenderKind` → `'shell'` (the module is not in `NON_SHELL_LANE_TYPES`),
tier caps give it 1–3 controls, and it has zero rankable params, so it resolves to **title
+ jacks and nothing else.**

⚠ **That is IDENTICAL to today's lane tile and must be verified, not assumed.**
`MidiCvBuddyCard.svelte:141` puts the whole body inside `PatchPanel`'s slot; at lane tiers
the card is the same title + jacks. **Verify with a before/after screenshot at the lane
tier in the build PR** — this is the one place a "no visible change" claim could be wrong,
and it is cheap to check.

The glance a player actually wants — *is a keyboard bound, and is it sending?* — is a
BINDING STATE plus an EVENT RATE. No member of `VALID_GLYPHS` expresses either. It is the
same gap wave 4 named for `midiclock`, and this cohort takes the waiting-adopter count from
one to four. **This spec does not invent a sixth glyph on a module PR.**

---

## 5. THE FACE

### 5.1 SHAPE

```ts
face: {
  glyph: 'none',          // mechanically forced (§4)
  order: [],              // params: [] — there is nothing to rank (§0.1)
  extension: 'midi-cv-buddy',
}
```

**One band, no pages, no tab rail.** `DOCK_TAB_MIN_BANDS = 7`; this face has one. Padding
pages to reach a rail is named as an anti-pattern and there is nothing here to pad with.

⚠ **`face.hero` is NOT declared.** A hero MOVES a key that a band already claims
(`dock-faceplate-model.ts:276`, pinned by `heroFacePlanIsTotal`), and there are no keys.

### 5.2 THE BODY — `face.extension: 'midi-cv-buddy'`, slot `fullViewBody`

Four settings and one gesture, in the order a player meets them:

```
┌──────────────────────────────────────────┐
│  [ Connect MIDI… ]                       │   ← state A: pre-permission
└──────────────────────────────────────────┘

┌──────────────────────────────────────────┐
│  DEVICE   [ Arturia KeyStep 37      ▾ ]  │   ← state B: bound
│  CH       [ ALL                     ▾ ]  │
│  PRIO      ( LAST )( LOW )( HIGH )       │
│  RETRIG   [x]                            │
└──────────────────────────────────────────┘
```

**The order is causal, not alphabetical, and it is the card's order** (`:153-185`): you
cannot filter a channel before choosing a device, and priority and retrig only mean
anything once notes are arriving. Keeping the card's order also means no player has to
relearn a layout they already know — a real consideration on a promotion that removes the
card from both surfaces.

**PRIO becomes a SEGMENTED, not a `<select>`.** Three named states, always all three
visible, one click to change instead of two. This is the `options`-roster reasoning applied
at the body level: a roster makes states SELECTABLE, and three is comfortably under
`SEGMENTED_MAX_OPTIONS`. ⚠ It is NOT a param, so `paramCellKind` is not involved — the body
renders `Segmented` directly, as `ChromaconsoleCard.svelte:259-267` already does for its
enum controls.

**CH stays a `<select>`.** Seventeen options (ALL + 1..16). A segmented control at
seventeen is a wall of digits.

**RETRIG stays a toggle.** One boolean.

### 5.3 WIDTH — COMPACT, and it is among the narrowest plates in the fleet

Measured off the card: `.midi-cv-buddy-card { width: 220px; }` (`:203`) with
`padding: 10px 14px 8px` (`:205`), so the control column is **192 px** and every row is a
42 px label plus a flexed select (`:234-241`).

**The face's body is the same four rows.** Nothing here is a live picture, a scope trace, a
video preview or an XY pad. **Nothing earns width.** The plate is the width of a device
name plus a caption column — call it ~300 px to let a long port name breathe
(`"Arturia KeyStep 37 Arturia KeyStep 37"` is a real shape on Windows, per the
Launchpad dual-port note), and no more.

⚠ **This is the correct outcome, not a defect.** Owner: *"we do not want useless gray
horizontal space on cards, ever. prefer compact. screen real estate is expensive!"* A
four-setting binder is a narrow plate. `face-width-source.test.ts` is deny-by-default with
a NAMED exemption carrying the thing that consumes the width — **midiCvBuddy asks for no
exemption**, which is the whole point.

---

## 6. RESTING TEXT

BINDERS §2. On this module:

| what | verdict |
|---|---|
| `NOTE` / `VEL` readout rows (`:187-196`) | ⛔ **REMOVED — the data is GONE, not hidden.** A hover reveal was refused by name |
| `"Click to grant MIDI access…"` (`:150`) | ⛔ **REMOVED.** §3.2 |
| `"Permission denied or browser unsupported."` (`:148`) | ✅ **KEPT** — not resting text; §3.2. And fixed while we are here |
| `DEVICE` / `CH` / `PRIO` / `RETRIG` captions | ✅ **KEPT** — CONTROL CAPTIONS, explicitly permitted, and each disambiguates an otherwise-identical `<select>` |
| `LAST` / `LOW` / `HIGH`, `ALL`, `1`..`16`, the device names | ✅ **KEPT** — OPTION NAMES that disambiguate a control's own position, explicitly permitted |

### 6.1 WHICH FINDING LOSES ITS SURFACE

CLAUDE.md requires this to be stated rather than left to lapse.

**The NOTE/VEL readout was the module's only proof of life.** With it gone, a player whose
keyboard is on the wrong MIDI channel sees a face that looks exactly like a working one:
correct device selected, no error, and silence. The readout was the fastest way to
distinguish *"the keyboard is not sending"* from *"the channel filter is wrong"* from
*"the patch downstream is broken"* — three different problems with three different fixes.

**Two replacements, and together they are close to parity:**

1. **`aria-valuetext` on the device cell** carries the last note and velocity —
   speakable and assertable. This is what every spec proving a face tracks the graph now
   reads, so **no assertion is weakened by the removal**.
2. **An ACTIVITY DOT.** BINDERS §2.1 establishes that a non-text lit/unlit mark is not
   addressed by the ruling — it is what `midiOutBuddy` already has (`:244`) and what
   `[data-ch-override]`'s outline is. midiCvBuddy has **no dot today**, so this is the one
   thing the face ADDS.

⚠ **The dot is a strictly weaker instrument than the readout and the spec says so.** It
answers *"is anything arriving?"* and not *"what?"*. The wrong-channel case above is still
distinguishable (dot dark = nothing arriving on this filter) but the wrong-octave case is
not. That narrowing is the ruling's intended trade.

⚠ **And the dot is a LIVE SURFACE.** A blinking element in a VRT scene is
non-deterministic — `analogVco` was dropped from batch 3 for exactly this
(**254 / 154 / 315 px across three captures of the same tile**). The dot is dark at rest
with no device connected, which is the state a VRT scene captures, so it should be stable
— **but that is a prediction, and predictions about VRT stability have been wrong before.**
Measure it (§11) before assuming; if it flaps, it belongs in `VRT_LIVE_SURFACES`
(`e2e/vrt/vrt-live-surfaces.ts`) with a mask and a measured companion, not in a face PR's
error budget.

---

## 7. WHERE STATE LIVES, AND THE MIGRATION QUESTION

| key | lives | who writes it | face path |
|---|---|---|---|
| `channel` | `node.data` | card (`:109`) → `api.setChannel` | `fullViewBody` |
| `priority` | `node.data` | card (`:115`) → `api.setPriority` | `fullViewBody` |
| `retrig` | `node.data` | card (`:121`) → `api.setRetrig` | `fullViewBody` |
| `lastDeviceId` | `node.data` | card (`:102`) → `api.selectDevice` | `fullViewBody` |
| held keys, bend, access | **engine closure** (`:372-380`) | the MIDI handler | not persisted, not the face's business |

⚠ **Every write is DOUBLE: the card calls the engine API *and* writes `node.data`
separately** (`:99-122`, four identical pairs). The engine reads `node.data` once at
factory time (`:365-369`) and never again, so the two must be kept in step by hand.

**This is a latent divergence and the face must not make it worse.** The correct shape for
the body is the same double write — engine API for the live effect, `node.data` for
persistence — because there is no seam that does both. It is worth a comment in the
extension so the next reader does not "simplify" it to one call and silently break either
persistence or the live update.

**No migration is needed.** No key changes name, no key changes type, and nothing moves
between `params` and `data`. A patch saved before the face loads identically after it —
which is the property `midiclock` does NOT have (its `divisor` moves from `data` to
`params`), and it is the reason this module is the cheaper first build.

---

## 8. THE e2e SURFACE

### 8.1 The module's own spec — three tests, all of which survive

`e2e/tests/midi-cv-buddy.spec.ts`:

| line | test | after promotion |
|---|---|---|
| `:23` | drop module → card mounts with no console errors | ✅ survives — re-point at the shell tile |
| `:34` | `Connect MIDI…` is visible + interactive | ⚠ **moves to the DOCK.** The button is in a `fullViewBody`, which is dock-only by `dockFullViewHeadPlan`. The test must open the dock full view first |
| `:45` | clicking Connect does not crash the card | ⚠ same |

**All three are re-points, none is a rewrite.** But note that two of them silently change
SURFACE — a lane assertion becomes a dock assertion — and a re-point that changes surface
without saying so in the diff is how a spec ends up asserting something it no longer means.
**Say it in the PR body.**

### 8.2 ⚠ `midi-autobind-perfzip.spec.ts:124` — the latent positional selector

Wave 4 found this while reading `midiclock` and it is worth restating because it is now
this cohort's problem in two places:

```
.locator('select').first()
```

Positional. It works only because the card in question happens to have exactly two
`<select>`s in a known order. **midiCvBuddy has THREE** (`:155`, `:165`, `:175`), so any
positional selector aimed at this cohort is one design change away from silently selecting
the wrong control — and a `<select>` that resolves to the wrong element does not throw, it
just changes something else.

**Re-point it at a testid.** ⚠ And note that **`MidiCvBuddyCard.svelte` has no `data-testid`
on any of its three selects** — `midiOutBuddy` and `chromaconsole` both do
(`midioutbuddy-access-error-{id}`, `chromaconsole-port-{id}`, …). The face's body must add
them; without testids the re-point has nothing to point at.

### 8.3 The #2166 class — nothing inherits it here

`_face-fixtures.ts`'s `DENIED` map and `LEGACY_DOCK_CANDIDATES`
(`workflow-rear-card.spec.ts:738` = `['moog956','moog960','cartesian']`) contain no member
of this cohort, so none inherits the repaired `scope` hazard.

⚠ **But check `per-module.spec.ts` and `per-module-per-port-behavioral.spec.ts` before
building.** Both reach for this cohort (grep hits) and both are registry-driven, so they
**auto-enrol** the face rather than needing a re-point — which means they will exercise it
on the first CI run whether or not anyone looked. That is the good case; verify it is the
actual case.

---

## 9. VRT — THE EXEMPTION IS THE ROOT OF FOUR

BINDERS §6. `EXEMPT_FROM_VRT:720`:

> `midiCvBuddy: 'card content depends on connected MIDI device; unit + E2E provide coverage'`

plus `ALLOWED_PERMANENT_EXEMPT:1174`.

⚠ **Three siblings inherit this sentence by reference** — `:721` (midiOutBuddy), `:726`
(midiclock), `:731` (midiLane) each say *"same rationale as midiCvBuddy"*. **It is one
rationale, written once, cited four times**, so the decision should be taken once, here.

**The face FALSIFIES it, and the falsification is cheap.** The exemption's premise is that
card content depends on a connected device. The face's **state A** — pre-Connect — is a
title, a patch panel and one button. It depends on no device, contains no device-derived
text, and is what a VRT scene captures (a scene never clicks Connect).

**Recommendation: capture state A, discharge the exemption.** ⚠ And `EXEMPT_FROM_VRT` /
`ALLOWED_PERMANENT_EXEMPT` are asserted for SET EQUALITY, so **a one-sided delete is RED** —
remove the module from both, in the same commit, and re-run `task test:ledger:accept`.

⚠ **The stronger discharge already exists and is not needed for this PR.**
`e2e/tests/_per-port-drivers.ts:726` mocks `requestMIDIAccess` and pumps a deterministic
stream, built for the per-port sweep and never carried back. That would let state B be
captured too. **Do not fold it into the face PR** — it is a second, independently valuable
change and it would make one PR responsible for both.

---

## 10. COST

| | |
|---|---|
| **WebGL attest** | **ZERO.** `webgl-attest-lib.ts:68-69` names exactly two audio defs in the basis — `cube.ts` and `wavesculpt.ts`. `midi-cv-buddy.ts` is not one |
| **ART** | **ZERO.** No audio output path — three `ConstantSourceNode`s carrying CV |
| **contract-lock** | **UNCHANGED.** No param added (§0.1), and `face` is fully contract-transparent (`FACE_FIELDS_IN_LOCK` is empty). Expect an EMPTY `docs:accept` diff — ⚠ and if it is not empty, something in this spec is wrong; stop and read it |
| **Push 2 card** | **UNCHANGED.** `params: []`, so there is no FACE tier to move to and no generic tier to re-rank |
| **docs** | already `STRICT_DOCS:225` with `docs.explanation` + all three outputs documented. Ratchet satisfied on arrival |
| **VRT** | 2 scenes added; 1 exemption pair discharged |
| **CI wall-time** | faces-parity budgets ~`10 s + 0.8 s/cell` on CI. **Zero param cells** — the body is a `fullViewBody`, not cells — so ≈ 10 s, plus 2 VRT scenes. Well under the ~2 min sign-off threshold |
| **⚠ BOTH cost artifacts** | a face adds rows to the e2e sweeps AND two `vrt-strict` scenes. **Re-pin `e2e-timings.generated.json` AND `vrt-strict-timings.generated.json`** — an unmeasured scene rides the median and reddened `main` once already |

---

## 11. DEFECT LEDGER — live on `main`, folded into this PR

| # | defect | where | fix |
|---|---|---|---|
| D1 | `node.data` writes are untagged — Cmd-Z does not undo a settings change | `MidiCvBuddyCard.svelte:89-97` | wrap in `ydoc.transact(fn, LOCAL_ORIGIN)`. §0.2 |
| D2 | `permissionDenied` conflates "denied" with "no Web MIDI in this browser" — two conditions, different user actions, one string | `:379`, `:529`, surfaced at `:148` | adopt `midiOutcomeMessage` from `$lib/audio/midi-access`, as `midiOutBuddy` already does. §3.2 |
| D3 | no `data-testid` on any of three `<select>`s, and a positional `.first()` selector already aims at this cohort | card `:155/:165/:175`; `midi-autobind-perfzip.spec.ts:124` | testids in the body; re-point the selector. §8.2 |
| D4 | the engine reads `node.data` once at factory time and never again; card and engine are kept in step by four hand-paired double writes | def `:365-369` vs card `:99-122` | **NOT fixed here** — it is a seam design question, not a bug, and the face reproduces the existing shape with a comment. §7 |

Per CLAUDE.md nobody opens issues: D1–D3 are fixed inside this PR with the story in the PR
body. D4 is recorded, not filed.

---

## 12. TASTE CALLS, EACH WITH ITS ONE-LINE REVERT

| call | revert |
|---|---|
| PRIO becomes a `Segmented` instead of staying a `<select>` | render a `<select>` — three options either way |
| body row order follows the card's causal order | reorder the rows in the extension component |
| the activity DOT is added (it does not exist today) | delete the element; `aria-valuetext` still carries the note |
| `"Permission denied…"` is KEPT | delete the branch; the button then fails silently |
| the four settings all stay in `node.data` rather than two becoming params | declare `priority` + `retrig` as params — but read §0.1 first, because it splits one idea across two surfaces |

---

## 13. MUST-VERIFY, BEFORE THE FACE IS WRITTEN

1. **The lane tile is genuinely unchanged.** §4 predicts title + jacks before and after.
   Screenshot both. This is the only "no visible change" claim in the spec.
2. **The dot is VRT-stable at rest.** §6.1. If it flaps, it is a `VRT_LIVE_SURFACES` entry
   and NOT a face-PR problem.
3. **`docs:accept` produces an EMPTY diff.** §10. A non-empty diff falsifies §0.1.
4. **`per-module.spec.ts` auto-enrols rather than needing a re-point.** §8.3.
5. **The Connect handler still calls `requestMIDIAccess` with no prior `await`.** §3.1.
6. ⚠ **`getActiveEngine()` is reachable from the extension.** BINDERS §1.3 says it is —
   verify in this tree rather than trusting the cohort doc, because the whole picker design
   rests on it.

---

## 14. VERIFICATION GATE

```sh
# 1. the rulings' source gates — FIRST, they are the cheapest and the most likely to fail
flox activate -- task test:one -- face-resting-text-source
flox activate -- task test:one -- face-readout-source
flox activate -- task test:one -- face-width-source

# 2. face lint + the promotion anchor (asserted BOTH directions)
flox activate -- task test:one -- module-face-lint
flox activate -- task test:one -- curated-face
flox activate -- task test:one -- dock-row-plan
flox activate -- task test:one -- dock-faceplate-model

# 3. the extension registry + the shared shell's module-freedom
flox activate -- task test:one -- shell-extensions
flox activate -- task test:one -- module-shell-import-guard
flox activate -- task test:one -- shell-cells

# 4. the module's own pure core — the exemption's stated cover
flox activate -- task test:one -- midi-cv-buddy
flox activate -- task test:one -- mutate.guard          # D1 must not regress it

# 5. registries + shared-file neighbours
flox activate -- task test:one -- rear-card-model
flox activate -- task test:one -- push-card-schema      # expect NO diff (§10)
flox activate -- task test:one -- module-docs-lint
flox activate -- task docs:check                        # expect NO diff (§10)

# 6. VRT exemption SET EQUALITY — a one-sided delete is RED (§9)
flox activate -- task test:one -- vrt-exemptions
flox activate -- task test:ledger:accept

# 7. e2e — the module's own spec (re-pointed) and the positional-selector fix
flox activate -- task e2e:serve
REPEAT=3 flox activate -- task e2e:one -- tests/midi-cv-buddy.spec.ts
REPEAT=3 flox activate -- task e2e:one -- tests/midi-autobind-perfzip.spec.ts
REPEAT=3 flox activate -- npx --workspace e2e playwright test faces-parity --grep midiCvBuddy
flox activate -- task e2e:stop

# 8. typecheck LAST — svelte-check is stricter than vitest
flox activate -- task typecheck

# 9. VRT: dispatch only, SCOPED. Predict TWO files. COUNT them. NEVER commit a PNG.
GREP=midiCvBuddy flox activate -- task vrt:commit

# 10. BOTH cost artifacts, from the newest run with blobs (§10)
flox activate -- task e2e:timings:accept -- <run>
flox activate -- task vrt:strict:timings:accept -- <run>

# 11. attest: NIL. Nothing to run (§10).
```

---

## 15. VERDICT

**PROMOTE.** ONE PR. Risk **LOW**. Estimate **≈ 6 h**.

It is the cheapest face in the binder cohort and it should be built first: it settles the
shared `fullViewBody` binder body that `midiOutBuddy` and `chromaconsole` both reuse, it is
where the VRT exemption decision has to be taken for four modules at once, and it is the
only one of the three whose saved patches cannot regress, because no key moves.
