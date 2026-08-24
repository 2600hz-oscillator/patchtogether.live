# FACEPLATE BUILD SPEC — `twotracks` (audio, the 2-reel tape-loop emulator)

**SPEC ONLY. Nothing here is implemented.** Mocks:
[`dock-tabs.html`](dock-tabs.html) · [`dock-reel-b.html`](dock-reel-b.html).

**Verdict: PROMOTE — but ONE contract change must land first, in the same PR.**
Risk MED-HIGH. Estimate ≈ 18 h.

This is the wave's control-heavy module, its only genuine tab-rail candidate, and the
only one whose face has a **measured** problem to solve rather than an aesthetic one.

---

## 0. THE CONSTRAINT MAP, READ FIRST

| fact | where | consequence |
|---|---|---|
| **`playhead_a` / `playhead_b` are DECLARED PARAMS THAT NOTHING WRITES AND NOTHING READS** | `twotracks.ts:255, 272`; `:732-733`; the only other occurrence in the tree is `contract-lock.txt` | **§0.1 — the blocker.** Face completeness would put two inert cells on the plate |
| `out_l` / `out_r` are `type: 'audio'` | `twotracks.ts:225-226` | `primaryAudioOutPortId` resolves ⇒ a glyph literal is **LIVE and legal**. Unprotected — §4 |
| the transport is an engine MESSAGE, not a param | `TwotracksCard.svelte:232-237`; `twotracks.ts:613` | maps onto `ShellActionCell` — and the probe key already exists (§3.1) |
| the engine already mirrors `transportState_a/b` into `node.data` | `twotracks.ts:444-454` | the `data` probe is free |
| a large param set: two symmetric reels plus a global mix | `twotracks.ts:249-288` | the wave's only control-heavy module — §5.2 |
| **measured mount cost**: exceeds a 5 s budget; needs `HEAVY_MOUNT_TIMEOUT = 30_000`; a 30 s `boundingBox` timeout in the fixture bridge | `io-spec-consistency.spec.ts:173-182`; `_face-fixtures.ts:74-77` | §5.3 — the face has a number attached |
| every param write already routes `setNodeParam` | `TwotracksCard.svelte:6`, and every call site | exemplary. No ledger entry owed |
| no committed VRT baseline | `vrt-exemptions.ts:1062` | §9 |
| zero WebGL attest | measured, §8.1 | free |

### 0.1 ⚠ THE BLOCKER: TWO PARAMS IN THE PUBLIC CONTRACT THAT NOTHING IMPLEMENTS

`twotracks.ts` declares:

```ts
{ id: 'playhead_a', label: 'Playhead A', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
{ id: 'playhead_b', label: 'Playhead B', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
```

and then excludes them from the AudioParam map with a comment (`:729-733`):

```
    // Display-only / toggle-handled params — no direct AudioParam
    // playhead_a: display-only
    // playhead_b: display-only
```

**Measured, exhaustively:** across `packages/web/src` and `e2e`, `playhead_a` occurs in
exactly two files — `audio/modules/twotracks.ts` (the declaration and that comment) and
`packages/web/src/lib/docs/contract-lock.txt:3467`. **No card control writes it. No
engine path reads it. No test touches it.**

⚠ The name is also *taken twice*, which is how this hid. `TwoTracksData` (`node.data`)
has its own `playhead_a` field (`:59`) which the engine DOES write and the card DOES
read (`syncedPlayheadA`). So a reader grepping the name finds live code and moves on.
**The `node.data` key is real; the `params` entry is not.**

**Why this blocks the face specifically.** `module-face-lint.test.ts:329-339` requires
every param to be ranked in `face.order`, and `shell-cells.test.ts` refuses an inert
cell on a promoted face. So promotion would either put two dead faders on the plate or
fail the gate. Today the inertness is invisible because the card simply never mounts a
control for them — **the face is the first surface that is obliged to.**

⚠ **There IS a second legal resolution, and it must be named and refused rather than
left for a reviewer to suggest.** `:323-338` carries a `#1726` escape hatch: a param the
def declares `noUserControl` satisfies completeness without a rank (and a param in BOTH
is red, so the hatch is anchored in both directions).

**Do not use it here.** `noUserControl` means *"this param is real, the engine drives
it, a user does not."* These two are not that — **nothing drives them at all.** Declaring
the hatch would green the gate, keep two params in the public contract that nothing
implements, and make the situation look deliberate to the next reader. That is the
CLAUDE.md pattern of a green gate certifying a live defect, chosen on purpose. It is also
strictly more work to reverse later than a deletion is now.

This is the CLAUDE.md declaration-vs-consumer rule running in the less familiar
direction. The usual warning is *"before fixing a declaration to satisfy a gate, check
the consumer reads it."* Here there is no consumer at all, and the honest fix is not to
build one.

**The fix: DELETE both params.** It is a **contract change** — `contract-lock.txt`
moves, so `task docs:accept` runs and the diff is reviewed rather than accepted
blindly. It rides this PR (fix-plus-face is one PR) but it is called out here because:

* ⚠ **it is the first thing to do**, before any face work, so the rest of the spec is
  written against the real param set;
* ⚠ **check saved racks.** A persisted patch may carry `params.playhead_a`. Since
  nothing reads it, dropping it is inert — but *verify* that rather than assume it, and
  confirm the loader does not reject unknown keys. §12.
* ⚠ **and there is NO ART capture to corroborate the deletion against** (§8.2). The
  strongest evidence a param is inert is that removing it does not move a captured
  waveform — this module has no baseline, so that evidence is unavailable and the search
  has to carry the whole weight.

**Alternative, and it should be rejected explicitly rather than left open:** wire the
params to the scrub. Do not. The scrub is a live engine seek (`port.postMessage({type:
'seek'})`, `:217`) whose value the worklet owns and streams back; making it a param
would put the playhead on the undo stack and in the Y.Doc at frame rate, which is the
CV-modulation write-storm class this repo already has a rule against.

---

## 1. WHAT THE MODULE IS FOR

Two independent tape decks in one box, mixed to a stereo output.

Each reel records the stereo audio at its inputs onto a fixed-length blank tape, then
plays the take back. You set a **loop window** (START / END markers dragged on the
waveform), a **tape RATE** that slows, speeds or reverses playback and pitch like a
varispeed reel (−3..+3, where 0 is frozen and negative is backwards), an **ECHOES**
feedback amount for tape-echo repeats, and a per-reel **3-band EQ plus a multimode
filter** to colour the playback. Recording is hands-free from the per-reel `rec_start`
/ `rec_arm` / `overdub` gate inputs, or from the on-card transport. **OVERDUB layers
new input onto the existing loop sound-on-sound.**

The two reels blend through a global **A/B** crossfader, **cross-feed into each other**
(`a2b`, `b2a`) for runaway tape-loop textures, a global **LOFI** degrades the sound,
and **MONITOR** passes the live input through. Each reel's take exports to WAV.

**The mental model the face must serve:** you are working on ONE reel at a time, and
while you work you need to see that reel's tape — where the audio is, where the loop
window sits, where the playhead is. Everything else is a setting. That is a tab rail
with a persistent picture, which is precisely backdraft's shape.

---

## 2. STOP 1 — is promoting this module a PARITY LOSS?

**No, provided §0.1 lands and the two canvases keep their drag gestures.** The card is
the most affordance-dense in the wave, so this is enumerated rather than summarised.

| affordance | element | survives? |
|---|---|---|
| every param knob / fader | `Knob`/`NeonFader`, all via `setNodeParam` | **YES** — cells |
| REC / PLAY / STOP × 2 reels | `sendTransport` → worklet port (`:232-237`, `:474-481`, `:631-638`) | **YES** — `action` cells, §3.1 |
| MODE toggle (TAPE / LOOP TAPE) × 2 | `toggleModeA/B` (`:253`, `:298`) | **YES** — a 0/1 discrete param, inferred toggle |
| OVERDUB toggle × 2 | `toggleOverdubA/B` (`:254`, `:299`) | **YES** — same |
| FILTER MODE cycle × 2 | `(mode + 1) % 4` (`:257`, `:302`) | ⚠ **§2.1 — becomes a selector, and that is an upgrade** |
| LOFI 4-way | four buttons (`:589`) | **YES** — segmented, from the discrete 0..3 param |
| MONITOR | `:575` | **YES** — toggle |
| RATE reset to 1 | `.rate-reset` button (`:522`) | ⚠ **§2.2** |
| **START / END marker drag** on the canvas | `onCanvasPointerDown/Move` → `setStartA`/`setEndA` (`:207-210`, `:262-291`) | **YES** — the body, §6 |
| **PLAYHEAD scrub** on the canvas | → `port.postMessage({type:'seek'})` (`:217`) | **YES** — the body |
| SAVE TAPE × 2 | `:527-532`, `:684` | **YES** — `action` cell, exact precedent §3.2 |
| four LEDs × 2 reels (ARM/REC/PLAY/OVERDUB) | `:448-460`, `:605-617` | ⚠ **§2.3 — these are the interesting ones** |
| jacks | `PatchPanel` | **YES** |

### 2.1 THE FILTER-MODE CYCLE BUTTON IS A DOWNGRADE THE FACE FIXES

`filterMode_a` is `min: 0, max: 3, curve: 'discrete'` and the card exposes it as a
button that increments modulo 4 (`:257`). **To reach mode 1 from mode 3 you press it
twice and watch what happens.** There is no roster on screen; the four modes have no
names anywhere the user can see.

**The names exist — in prose only.** `twotracks.ts:317` builds the doc string
*"FILTER MODE — off / low-pass / high-pass / band-pass selector"*, so the roster is
`off · low-pass · high-pass · band-pass` in that order, with `defaultValue: 0` meaning
**the filter ships OFF**.

⚠ **Take the names from `:317` and nowhere else.** The file header at `:18-19` calls it
an *"HP/LP/BP filter"* — three modes, wrong order, and no `off`. Two records of the
same roster already disagree, which is the reason the next step is not optional.

On the face it is a **segmented control over a declared roster** — one press, direct
addressing, and the mode NAMES visible. ⚠ **The def declares no `options` anywhere
today** (measured: zero occurrences of `options:` in `twotracks.ts`), so adding them is
part of this PR — and the cell **imports the exported symbol** rather than re-typing the
four strings, which is the card-disagrees-with-its-def rule and the reason the header
and the doc string were free to drift apart in the first place.

⚠ **And note what that changes:** an `options` roster on a param makes the shell render
it as `segmented`/`selector` automatically — no `paramCells` declaration needed — and
it makes the option NAMES paintable resting text, which is the one derived-text shape
the ruling permits (a name disambiguates otherwise-identical positions; a number
restates the dial).

### 2.2 THE RATE RESET IS A LANDMARK, NOT A BUTTON

`.rate-reset` sets `rate_a` to 1 — unity, forward, normal speed. On a −3..+3 knob,
unity is not the centre (the centre is 0, which is FROZEN tape), so it is genuinely
hard to hit by hand and the button earns its place on the card.

The face does not need a button: **every face knob already supports double-click-to-
default**, and `defaultValue: 1` is already declared (`:249`). ⚠ **VERIFY that**
(§14) rather than assuming it — if the shell's reset gesture does not exist or does not
reach this control, the button must be carried as an `action` cell, because losing it
is a real parity loss on a control whose useful position is off-centre.

⚠ Additionally: `rate` at 0 means FROZEN and negative means REVERSE. Those are
landmarks a player needs. They belong in `aria-valuetext` (`reverse, 2× speed` /
`frozen` / `unity`), not painted — and that is strictly more information than the
card's bare knob gives today.

### 2.3 ⚠ THE EIGHT LEDs ARE THE REAL PARITY QUESTION, AND THE ANSWER IS NOT "KEEP THEM"

Each reel paints four LEDs — ARM, REC, PLAY, OVERDUB — driven from
`transportState_a/b`. They are the only indication of what the tape is doing.

They are **derived state**, and the resting-text ruling denies derived state *in any
shape*. But the ruling's subject is TEXT: *"the module NAME, TAB/SECTION labels,
CONTROL CAPTIONS, and option/landmark NAMES"* are permitted, and *"a value, a
measurement, a state word, a sentence"* are not. `face-resting-text-source.test.ts`
denies `ModuleFace` fields without a permitted role; it explicitly **cannot see text
drawn into a canvas or a shell extension's `fullViewBody`**, and it says so.

So the honest reading, and this spec commits to it:

* **An LED is not text. It is a live picture**, in the same family as a meter or a
  scope trace, and the ruling's four deletions were all of *labelled values*.
* **But the LED's MEANING must not be painted as a word.** `REC` as a caption beside a
  lamp is a control caption (permitted — it labels the button). `RECORDING` as a status
  word is not.
* **The state belongs in `aria-valuetext` on the transport cell**, where every spec
  proving the face tracks the engine will read it — and where `armed` vs `rec` vs
  `overdub` are distinguishable, which four lamps of similar colour arguably are not.

⚠ **This is a judgement about where a line falls, and the line has moved four times.**
§13 gives it a one-line revert, and it is the item to look at in the dock baseline
before merge. **Do not treat "the previous face did X" as settling it.**

---

## 3. STOP 2 — does every way of getting DATA IN survive?

Yes, and `samsloop` is an exact shipped precedent for every non-param one — which is
the reason this module's verdict is PROMOTE rather than BLOCKED.

### 3.1 THE TRANSPORT — an `action` cell whose probe already exists

`sendTransport` (`TwotracksCard.svelte:232-237`) reads the worklet port off the engine
and posts `{ type: 'transport', reel, action }`. Nothing is written to the graph.

That is the shape `ShellActionCell` exists for, and the probe question has a shipped
answer. `samsloop`'s record button (`shell-cells.ts:783-784`):

```ts
probe: { effect: { kind: 'audition', seam: 'engine-message' } },
onFire: (nodeId) => { toggleSamsloopRecord(nodeId); },
```

**And twotracks can do better than `samsloop`**, because the engine already mirrors the
result into the graph: `twotracks.ts:444-454` writes `transportState_a` /
`transportState_b` into `node.data` on every transition, with the comment *"ONLY
transport state + bufLen go to the Y.Doc — both change rarely."*

So the transport cells take a **`data` probe** on `transportState_{reel}` — the kind the
registry says to prefer (`:324`, *"Prefer `data` where you can. A revision-only probe
passes on a DEAD…"*) — which is strictly stronger than an audition ledger because it
observes the ENGINE'S RESULT rather than the message's departure.

⚠ **`mode: 'trigger'`, not `'gate'`.** REC/PLAY/STOP are one-shots. The registry
asserts each cell declares exactly the handler its mode needs, and a `gate` consumer
driven by a click would open and never close.

### 3.2 SAVE TAPE — and the precedent carries a warning aimed exactly at this module

`samsloop`'s export cell (`shell-cells.ts:787-798`):

```
// ⚠ The seam is `file-export` rather than `engine-message`: an export reaches no
// engine, and a probe watching `engine-message` here would be satisfied by a REC
// press on the same node.
'samsloop-download-{n}': {
  kind: 'action', label: 'export', mode: 'trigger',
  probe: { effect: { kind: 'audition', seam: 'file-export' } },
  …
}
```

**Read that warning against this module's layout.** twotracks' SAVE TAPE sits in the
same reel block as REC, on the same node — the exact adjacency the comment describes.
Use `seam: 'file-export'`. Getting this wrong produces a probe that is green because
the user pressed a *different* button.

⚠ **And it records `delivered: false` rather than dropping it** when the reel is empty
(`bufLen === 0`). "Pressed and exported nothing" and "not pressed" must stay
distinguishable — an export of an empty tape is a real state a user can reach and the
card today produces a silent no-op.

### 3.3 THE CANVAS DRAGS — the body, and they are already correctly split

Two different gestures on one canvas, and the card gets the seam right:

* **START / END markers** → `setNodeParam(id, 'start_a', clampLoopStart(…))` (`:207`).
  A durable setting: undoable, synced, origin-tagged. ✅
* **PLAYHEAD scrub** → `port.postMessage({ type: 'seek', reel, pos })` (`:217`).
  Transient engine state: NOT in the Y.Doc, NOT on the undo stack. ✅

**That split is correct and the face must preserve it exactly.** It is the same
distinction the CV-modulation rule is about: performance gesture vs stored setting.
`clampLoopStart` / `clampLoopEnd` are pure and live outside the card — the body imports
them, and no clamping arithmetic is re-typed.

### 3.4 EVERY PARAM WRITE IS ALREADY CLEAN

`TwotracksCard.svelte:6` — *"All param writes go through setNodeParam() — never direct
node.params mutation"* — and every call site honours it. **There is no `TwotracksCard`
entry in `raw-write-ledger.ts` and none is owed.**

⚠ Worth stating plainly because this is the wave's counter-example: the wave README's
finding is that the raw-write gate is blind to `data`, and `twotracks` is the module
that would have been fine either way. It keeps essentially nothing user-editable in
`data` — the engine owns `transportState` and `bufLen`, and the user's edits are all
params. **That is the shape the other two should look like**, and it is why this
module's ledger (§12) contains no undo defect.

---

## 4. THE LANE PICTURE — refused, and this one is UNPROTECTED

**`glyph: 'none'`.** And unlike `audioOut` and `kria`, nothing stops an author from
choosing otherwise.

`primaryAudioOutPortId` (`shell-glyph-live.ts:111-113`) is
`def.outputs.find(o => o.type === 'audio')`. `twotracks` declares `out_l` and `out_r`,
both `type: 'audio'` (`:225-226`). **So `glyphBinding` short-circuits to
`{ kind: 'live-audio', portId: 'out_l' }`. The binding is LIVE. The dead-glyph clause
is green. `VALID_GLYPHS` is satisfied. Nothing anywhere reddens.**

This is `scope`'s trap class — and the refusal here is for a **different** reason,
which is what makes it an argument rather than a copy.

`scope`'s live glyph was refused because it would be a **lie**: `ch1_out` IS `gain1`,
so the trace is invariant to all nine controls. **twotracks' would not be a lie.**
`out_l` is genuinely downstream of the tape, the rate, the EQ, the filter, the lofi and
the crossfader; it moves with the controls.

It is refused because **it answers a question nobody is asking, and it makes three
different states look identical.** What a player wants from a tape machine at a glance
is: *is there tape on this reel, and where is the playhead?* A live output trace shows:

| state | what the trace shows |
|---|---|
| stopped with a full tape | **flat** |
| running with an empty tape | **flat** |
| running, monitoring silence | **flat** |
| running with audio | a waveform — but the same waveform any module would show |

**Three distinct states, one picture.** And the module's own picture — the recorded
buffer with its loop window and playhead, which the card already draws — is not
available as a glyph: `ShellExtensionGlyphProps` (`shell-extensions.ts:72-74`) carries
no `nodeId`, so a layout-source glyph after #2160 would draw the same tape for every
instance, and a tape is per-instance by definition.

So: no lane picture. **The waveform is dock-only, through `fullViewBody`.**

⚠ Because nothing reddens here, `twotracks-face-model.test.ts` asserts the mechanism as
a **permanent negative leg**: the binding really does resolve `live-audio` on `out_l`
(the thing that makes the trap possible), and a stopped reel with a recorded tape
really does read flat at `out_l` (the thing that makes it uninformative). A future
author who adds a literal must fail a test, not merely disagree with a document.

---

## 5. THE FACE

### 5.1 RANK — `face.order`

Ranks 1–6 are the entire lane budget; rank 7+ is dock-only. With this many params the
ranking decides what a lane tile shows, so it is a real decision:

```ts
order: [
  'ab',            // 1 — the blend. The one control that is always relevant
  'rate_a',        // 2 — reel A's varispeed: the module's signature gesture
  'rate_b',        // 3
  'echoes_a',      // 4
  'echoes_b',      // 5
  'monitor',       // 6 — hear the input at all
  // 7+ dock-only: start/end, mode, overdub, the two EQ sets, the two filter
  //    sets, a2b, b2a, lofi
]
```

**The argument.** Rank is grouped by *what a player reaches for during a take*, not by
the def's declaration order and not by reel. `ab` is rank 1 because it is the only
control that is meaningful regardless of which reel you are working on. The two RATEs
follow because varispeed is what makes this a tape machine rather than a looper.

⚠ **The rejected alternative, named:** ranking reel A's whole block ahead of reel B's
(`rate_a, echoes_a, start_a, end_a, mode_a, overdub_flag_a`) would fill the entire lane
budget with ONE reel and put reel B's existence below the fold. On a two-reel module
that is the wrong first impression — the lane tile would read as a one-reel looper.

### 5.2 ⚠ THE TAB RAIL — the decision, its sensitivity, and the escalation path

**Seven bands, and the rail engages through the ORDINARY threshold
(`DOCK_TAB_MIN_BANDS = 7`, `dock-tabs-model.ts:56,72`). `face.tabbed` is NOT declared
and must not be.**

```
1 · A · TRANSPORT   mode_a · overdub_flag_a · [REC] [PLAY] [STOP] · [SAVE TAPE]
2 · A · TAPE        rate_a · echoes_a · start_a · end_a
3 · A · TONE        [EQ: eqLow_a · eqMid_a · eqHigh_a]  [FILTER: filterMode_a · cutoff_a · reso_a]
4 · B · TRANSPORT   mode_b · overdub_flag_b · [REC] [PLAY] [STOP] · [SAVE TAPE]
5 · B · TAPE        rate_b · echoes_b · start_b · end_b
6 · B · TONE        [EQ: eqLow_b · eqMid_b · eqHigh_b]  [FILTER: filterMode_b · cutoff_b · reso_b]
7 · MIX             ab · a2b · b2a · lofi · monitor
```

The owner's ruling is that *"lots of controls of DIFFERENT types"* gets a tabbed face,
with backdraft's eight semantic pages as the reference. twotracks has knobs, faders,
toggles, segmented selectors, action buttons and two canvases. **It is the
control-heavy module the ruling describes**, and an untabbed plate of this many
controls would be a very tall face — which collides directly with *"screen real estate
is expensive."*

⚠ **AND THIS SPEC WILL NOT PRETEND THE GROUPING IS UNAMBIGUOUS.** A reviewer could
reasonably say TAPE and TONE are one idea per reel (*"reel A"*), which collapses the
structure to three bands, drops it under the threshold, and turns the rail off. The
counter-argument is that a tape machine's transport, its tape motion and its tone
section are three different things on the hardware this emulates, and backdraft's own
pages are comparably granular.

**The rule that decides how to behave, not which is right:** *"do not pad pages to force
the rail"*, and *"if a heavy module's honest semantic grouping lands at 5–6 pages, raise
it to the owner instead."* So:

* **Author the seven** and state the argument for each page on the def.
* ⚠ **If the reviewer collapses it to three or five, DO NOT re-split to get the rail
  back.** That is the padding the rule forbids. Ship untabbed (ruttetra's precedent —
  the owner ruled it untabbed at six pages) or raise the threshold question to the
  owner. **`face.tabbed` is owner-instruction-only, recorded verbatim in
  `FACE_TAB_OPT_IN`, and the risk it exists to prevent is an agent writing a plausible
  sentence about what the owner wanted. Do not be that agent.**
* ⚠ **A hero that empties its band changes the tab count** (`heroFacePlan` drops a band
  whose every control was promoted), so the rail must be computed from the POST-hero
  bands. This face declares **no hero** (§5.4), partly for that reason.

### 5.3 ⚠ THE FACE HAS A NUMBER ATTACHED, AND IT MUST BE MEASURED RATHER THAN CLAIMED

twotracks is the only module in the wave with a measured cost problem:

* `io-spec-consistency.spec.ts:173-175` — *"xyflow keeps the node wrapper
  visibility:hidden until ResizeObserver fires; on CI's production preview bundle
  TwotracksCard — **580 px wide, complex layout** — can take longer than the default
  5 s"*, hence `HEAVY_MOUNT_TIMEOUT = 30_000` (`:182`).
* `_face-fixtures.ts:74-77` — DENIED as a face fixture because *"the bridge test **timed
  out at 30 s in `boundingBox`** waiting for it."*

A tabbed face mounts one band at a time, so **the rail is plausibly the remedy as well
as the requirement.**

⚠ **"Plausibly" is doing real work in that sentence and the build must not skip it.**
Two things are unverified and both are measurable:

1. **Does `dockTabPlan` UNMOUNT inactive bands, or merely hide them?** If it hides
   them, every control still mounts and the rail buys nothing on this axis. **Read the
   render site; do not infer it from the word "tab".**
2. **Is the mount cost in the CONTROLS or in the two 220×60 canvases?** Those are
   different problems with opposite fixes, and *"slower"* and *"differently
   structured"* look identical from a timeout.

**Measure `main` before and the branch after, on the same machine, and report both
numbers.** A face PR claiming a performance win without a before/after is exactly the
instrument-validation failure CLAUDE.md is about. If the rail does not move the number,
say so — the rail is still right on the owner's ruling, and an honest null result is
worth more than an unmeasured claim.

### 5.4 NO HERO, AND COMPACT BY DEFAULT

**No `hero`.** A hero MOVES a key out of its band and can empty it, which changes the
tab count (§5.2). There is also no single control that deserves to dominate: `ab` is
rank 1 but it is a crossfader, not the instrument.

**Width must be EARNED.** The persistent waveform (§6) is a genuine earner — it is a
live picture and it is the module's own. Nothing else is. ⚠ `FACE_WIDTH_EXEMPTIONS`
must remain untouched: the card is 580 px and the temptation to carry that width onto
the plate is exactly what the ruling forbids. **The face should be NARROWER than the
card**, because the rail shows one reel's band at a time where the card shows both
reels side by side.

---

## 6. THE BODY — `face.extension: 'twotracks'`

### 6.1 The persistent waveform

`$lib/ui/modules/twotracks/shell-extension.ts` → `{ fullViewBody: TwotracksReelBody }`.

`fullViewBody` is WIRED (`shell-extensions.ts:124`), dock-only, paints above the control
bands, replaces the hero glyph, and **leaves every param cell intact** (`:85-87`).

**It shows the SELECTED reel's tape**, and it is present on every tab — backdraft's
ruling applied (*"the preview screen can stay present in all views"*). Which reel is
selected follows the active tab: bands 1–3 show reel A, bands 4–6 show reel B, and the
MIX tab shows… §13 gives this a revert, because the honest options are *keep the last
reel* and *show both, half height*, and only a baseline will settle it.

Contents, all of which the card already draws (`drawWaveform`, `:343-421`):

* the peak envelope of the recorded buffer, from `read('peaksA'/'peaksB')`;
* the loop window, START and END as **draggable markers** (§3.3 — `setNodeParam`);
* the playhead, **draggable to scrub** (§3.3 — `port.postMessage seek`);
* the empty-tape state **drawn**, not blank — "no tape yet" and "the body failed to
  mount" must be different pictures.

⚠ **2D canvas, and it must stay 2D.** Attest basis rule (2) is derived from CONTENT, so
a WebGL waveform would enrol this module in the basis and make every future edit cost a
GPU re-attest (§8.1). The existing draw is 2D; reuse it.

⚠ **Visibility-gate the draw.** The card runs a rAF peak poll (`:103-105`) and a
reactive redraw with no visibility gate. On a dock face that loop must stop when the
body is off screen — §12 D5.

### 6.2 SCREEN ON/OFF — yes, and this is the wave's only one

`twotracks` is `domain: 'audio'`, so `video-face-screen-source.test.ts` — which sweeps
`listVideoModuleDefs() ∩ STRICT_FACES` — **cannot see it either way.** That gate hole is
recorded fleet-wide; nothing new here, and this module owes no exemption entry because
it is out of that population by construction.

On the merits, and unlike `audioOut` and `kria`, **twotracks is on the "yes" side.**
`dockscope` / `spectrograph` / `samsloop` refuse a toggle because the picture IS the
module. Here the picture is a **preview beside a large control set**: with the waveform
collapsed you still have transport, rate, echoes, EQ, filter and the mix — a complete,
usable tape machine. That is exactly the shape the ruling is about, and on the wave's
tallest face reclaiming that vertical space is worth real screen.

Per the ruling: the state lives on **`node.data`**, reusing the **`previewCollapsed`**
key verbatim (never component `$state` — the #1531/#1574/#1583 unmount class, and racks
saved before the promotion must not silently re-open); the module **keeps rendering
while OFF** (never tear the producer down — the #1720/#1721 class); and the state
**persists across tab switches**, which on a seven-tab face is the whole point.

⚠ **The switch ships compliant and UNGUARDED**, and that is stated rather than left to
be discovered: no gate sees it, so a future edit deleting it goes green. Covered from
two directions this PR can supply — a `face-screen-render.spec.ts` SUBJECTS row (the
only runtime leg it has anywhere) and a source-level assertion in
`twotracks-face-model.test.ts` including an ORDER assertion that the collapse bail
skips the PAINT and never the peak read.

---

## 7. THE STATE MATRIX

| # | state | body | cells | observable |
|---|---|---|---|---|
| 1 | fresh spawn, both reels empty | empty tape DRAWN, not blank | defaults | `bufLenA` = 0 |
| 2 | reel A armed | tape unchanged | A transport `aria-valuetext` = `armed` | `data.transportState_a` |
| 3 | reel A recording | tape grows | `rec` | same |
| 4 | reel A overdubbing | tape unchanged, playhead moving | `overdub` | same |
| 5 | reel A stopped WITH a tape | full envelope, playhead parked | `idle` | ⚠ **`out_l` reads FLAT** — §4's permanent negative leg |
| 6 | loop window sub-range | markers inside the envelope | `start_a` / `end_a` moved | params |
| 7 | rate negative | — | `aria-valuetext` says `reverse` | §2.2 |
| 8 | rate 0 | playhead parked | `aria-valuetext` says `frozen` | §2.2 |
| 9 | SCREEN off | body collapsed, **peaks still read** | all cells present | §6.2 order assertion |
| 10 | tab → reel B | body shows reel B's tape | reel B's cells | the tab/body coupling |
| 11 | SAVE with empty tape | — | `delivered: false` recorded | §3.2 |

⚠ **State 5 is §4's permanent negative control** — it is the state that proves a live
glyph would be uninformative, and it must fail if someone later adds a glyph literal.
**State 9's ORDER assertion** is the one that catches a collapse implemented by
skipping the read instead of the paint. **State 11** is the one a naive implementation
silently drops.

---

## 8. COST

### 8.1 ⚠ WEBGL ATTEST: ZERO. MEASURED, NOT REASONED.

```sh
flox activate -- bash scripts/webgl-attest-hash.sh --list | grep -i twotracks
```

returns **nothing**. `audio/modules/twotracks.ts`, `audio/modules/twotracks-transport.ts`
and `ui/modules/TwotracksCard.svelte` are absent from the basis. ⚠ Keep the body 2D
(§6.1).

### 8.2 ART — no pin to move, and the reasoning that said otherwise was wrong

⚠ **ART pins baselines to the RAW FILE SHA and is NOT comment-stripped** — the opposite
of the attest, and that asymmetry cost wave 2 a red run on a comment-only edit. This PR
edits `twotracks.ts` **three times over** (deleting the two inert params, adding the
`face` block, adding the `filterMode` roster), so the rule says the pin moves.

**Measured, and there is no pin.** ART's source pins are `.sha` files beside their
`.f32` baselines in `art/baselines/<module>/`. There is **no `art/baselines/twotracks/`**,
and `twotracks` sits in **`ART_BACKLOG`** (`art/setup/profile-coverage.ts:118`) — the
reasoned list of audio-domain modules that do not yet ship a profile. The four tests
under `art/scenarios/twotracks/` are lofi property tests, not SHA-pinned captures.

**So: zero ART cost, and `art/` should be absent from the diff.**

⚠ **Do NOT take that as licence to skip the check.** The point of §0.1 is that two
params are believed to be inert, and **the strongest available evidence that a param is
inert is that removing it does not move a captured waveform.** This module cannot offer
that evidence, because it has no capture. So the deletion's verification falls entirely
on §12.1's tree-wide search and on the existing suites — `twotracks-worklet-params`,
`twotracks-transport` and `twotracks-perfzip` — passing unchanged. **Weigh that when
deciding how hard to look.**

⚠ And do not remove `twotracks` from `ART_BACKLOG`: `audio-profile-gate.test.ts`
enforces *"a module that gains a baseline MUST be removed from this list"*, which is the
converse of what this PR does. A face adds no baseline.

### 8.3 CI wall-time

Registry-driven auto-enrolment plus two dock VRT scenes, one `face-screen-render`
SUBJECTS row (rides an existing batch, amortised page boot), and one
`twotracks-face-model` unit file. ⚠ **This is the wave's most likely 2 min offender**,
because the module is already in `HEAVY_RENDER` and a tabbed face adds
`workflow-shell-faces` scenes with a per-scene `pages` count. **Estimate the delta and
flag it before merge** rather than discovering it in the queue.

### 8.4 The Push 2 card moves, and here it moves a LOT

`push-card-config.ts` resolves tier 2 from `face.order` when there is no override.
`twotracks` has no `PUSH_CARD_CONTROLS` entry, so **authoring `face.order` re-ranks its
Push card from whatever the fallback tiers produce to the first eight of §5.1.**

⚠ On a module this param-dense, the fallback ranking and the face ranking are very
unlikely to agree, so **this is a real change to a real surface**, not the trivial
no-op it was for `audioOut` and `kria`. Pin the resulting eight in `push-card-schema`
as a permanent leg, look at them, and **consider an explicit `PUSH_CARD_CONTROLS`
entry** — an override REPLACES, so it cannot drift when a param is added later. That
matters here because §0.1 REMOVES two params in the same PR, which re-ranks the
fallback tiers by itself.

---

## 9. DETERMINISM AND VRT

* **No committed baseline exists.** `twotracks` is in `EXEMPT_FROM_VRT`
  (`vrt-exemptions.ts:1062`) and its masks entry masks both canvases (`:84-86`).
* ⚠ **The exemption's exit condition cannot be met as written.** It says *"Promote once
  **darwin + linux** baselines captured via vrt-update.yml"* — a two-platform capture
  model that no longer exists. `snapshotPathTemplate` has no `{platform}` segment and
  **linux CI authors one set** (`workflow-audio-io-composite.spec.ts:19-21` states it).
  So the exemption will sit "pending" forever. **This PR is the natural moment to
  discharge it**, and the exit condition should be rewritten in the current vocabulary
  whether or not the module is promoted in the same breath.
  ⚠ This vocabulary staleness is fleet-wide rather than specific to twotracks; the
  claim here is scoped to *this* entry and its exit condition, not to a campaign.
* **Determinism is available for free**: a fresh spawn has an EMPTY tape on both reels,
  the transport is idle, and the playhead is parked. **Capture that.**
* ⚠ **But do NOT mask the body canvas in the FACE scenes.** The existing card mask
  exists because both canvases are empty on a fresh spawn — masking an empty canvas
  hides nothing, and carrying the mask onto the face would make the baseline blind to
  the one thing the body adds. If the empty-tape state is drawn (§6.1), it is
  deterministic and belongs in the diff.
* **Scenes predicted**: `face-twotracks-compact.png`, `face-twotracks-dock.png`, plus
  one per tab if `workflow-shell-faces` captures pages — **the `FACES` roster carries a
  per-scene `pages` count, so predict the number from that roster, not from a guess.**
  ⚠ Dispatch `GREP=twotracks task vrt:commit`; a bare dispatch derives FULL because the
  derivation reads PATHS ONLY. **Count what the bot commits against the prediction.**
* `e2e/vrt/workflow-shell-faces.spec.ts`'s `FACES` roster is **NOT registry-driven** —
  add `twotracks` by hand or it silently has no scene.

---

## 10. DEFECT LEDGER

| # | defect | evidence | routing |
|---|---|---|---|
| **D1** | **`playhead_a` / `playhead_b` are declared params nothing writes and nothing reads** | §0.1; occurrences are `twotracks.ts:255,272,732-733` and `contract-lock.txt:3467` only | **Fold in — FIRST.** Delete both; contract change, `docs:accept`, review the diff, verify saved racks (§14) |
| **D2** | **`DESCRIPTIONS.twotracks` is three phases stale.** It says *"Phase 1 ships reel A … Phase 2 adds reel B, EQ, and filter; Phase 3 adds Lofi saturation; Phase 4 adds CV ins"* while the def ships reel B, all three EQ bands, the filter, `lofi`, and the `rate_cv_a`/`rate_cv_b` CV inputs. **The card's own header says *"Phase 4"*** | `module-manifest.ts:429`; `twotracks.ts:216-221, 266-288`; `TwotracksCard.svelte:2` | **Fold in.** This is the text a user reads on the docs page. The docs gate checks presence and quality, not truth — the same class as wave 2's `scope` header |
| **D3** | **The same description documents a control that does not exist**: *"a DECAY knob that fades previous passes by 0.50–0.90× per loop"*. There is no `decay` param; the real control is `echoes_a`, `1..5` discrete | `module-manifest.ts:429` vs `twotracks.ts:251` | **Fold in**, with D2 |
| **D4** | **The file header names a param that does not exist**, and mis-states a roster. `twotracks.ts:8` lists `decay_a` among the params — it occurs **nowhere else in the tree**; and `:18-19` calls the filter *"HP/LP/BP"*, three modes in the wrong order with no `off`, against `:317`'s authoritative *"off / low-pass / high-pass / band-pass"* | `twotracks.ts:8`, `:18-19` vs `:317` | **Fold in** — §2.1. ⚠ Comments are free for the attest and **NOT free for ART** (§8.2). ⚠ And the real repair is the exported roster: two prose records of one roster were free to drift because neither was the source |
| **D5** | **The peak-poll rAF and the reactive redraw are not visibility-gated**, so a mounted-but-offscreen card polls and redraws forever | `TwotracksCard.svelte:103-105`, `:422-431` | **Fold in.** The body must be gated (§6.1); the card should be too |
| **D6** | **The FILTER MODE control is a modulo-4 cycle button** with no roster and no visible mode names | `TwotracksCard.svelte:257`, `:302` | **Fold in** — §2.1. Declare `options` on the def and import them |
| **D7** | **Reel A's testids are unsuffixed while reel B's carry `-b`** (`twotracks-rec` vs `twotracks-rec-b`, `led-arm` vs `led-arm-b`), so nothing in a locator says the unsuffixed one is reel A | `TwotracksCard.svelte:448-486` vs `:605-643` | **REPORT, do not fix here.** Renaming testids touches every twotracks spec and the perfzip spec; it is a mechanical rename that would bury the face diff. Worth doing, worth doing alone |
| **D8** | **The VRT exemption's exit condition names a capture model that no longer exists** | `vrt-exemptions.ts:1062` | **Fold in** — §9. Scoped to this entry |

⚠ **D5, D6 and D7 are CARD defects**, and the legacy card still renders under
`?shell=legacy` and in the per-card VRT sweep. **A face does not pay a card's debt** —
D5 and D6 are fixed on `TwotracksCard.svelte` directly, in this diff.

---

## 11. TASTE CALLS, EACH WITH ITS ONE-LINE REVERT

| call | revert |
|---|---|
| The eight LEDs survive as lamps, state goes to `aria-valuetext` (§2.3) | drop the lamps; the `aria-valuetext` is unaffected. **The item to look at in the baseline** |
| Seven bands, rail on (§5.2) | collapse TAPE + TONE per reel → three bands, rail off. ⚠ **Do not re-split to get the rail back** |
| `ab` at rank 1 rather than `rate_a` | swap two strings in `face.order` |
| The MIX tab keeps the last reel's tape visible (§6.1) | show both reels at half height, or blank the body on MIX |
| No RATE-reset action cell (§2.2) | add one, if double-click-to-default does not reach the control |
| SCREEN ON/OFF present (§6.2) | delete the key; ⚠ nothing would go red, which is why it is asserted at source |

---

## 12. MUST-VERIFY

1. **Nothing reads `playhead_a` / `playhead_b`** — re-run the tree-wide search on the
   branch. ⚠ **There is no ART capture to corroborate it with** (§8.2), so this rests on
   the search plus `twotracks-worklet-params`, `twotracks-transport` and
   `twotracks-perfzip` passing unchanged. Look harder than you would if a waveform were
   watching.
2. **A saved rack carrying `params.playhead_a` still loads** after the deletion.
3. **Does `dockTabPlan` unmount or hide inactive bands?** (§5.3.1) Read the render site.
4. **Mount cost, `main` vs branch, same machine, both numbers reported** (§5.3).
   An honest null result is acceptable; an unmeasured claim is not.
5. **Double-click-to-default reaches `rate_a`** (§2.2), or the reset button is carried.
6. **State 5** — a stopped reel with a recorded tape reads flat at `out_l` (§4's
   permanent negative leg, and the reason the glyph is refused).
7. **State 9's ORDER assertion** — SCREEN off skips the PAINT, never the peak read.
8. **State 11** — an export with an empty tape records `delivered: false`.
9. **The export probe's seam is `file-export`, not `engine-message`** (§3.2).
10. **The START/END vs PLAYHEAD seam split is preserved exactly** (§3.3) — markers are
    params, the scrub is an engine message. A face that made the scrub a param would
    be the CV write-storm class.
11. **`FACE_WIDTH_EXEMPTIONS` untouched**, and the face is narrower than the 580 px card.
12. **The Push card's new eight are looked at**, not just pinned (§8.4).

---

## 13. VERIFICATION GATE

```sh
# 1. the pure model + this face's PERMANENT negative controls (§7 states 5, 9, 11)
flox activate -- task test:one -- twotracks-face-model
flox activate -- task test:one -- twotracks-transport      # the existing state machine
flox activate -- task test:one -- twotracks-worklet-params # ⚠ §0.1 — must stay green after the deletion

# 2. face lint
flox activate -- task test:one -- module-face-lint
flox activate -- task test:one -- dock-row-plan            # ⚠ a TABBED face never packs
flox activate -- task test:one -- dock-tabs-model          # §5.2 — the rail at 7 bands
flox activate -- task test:one -- dock-faceplate-model
flox activate -- task test:one -- curated-face

# 3. the rulings' source gates
flox activate -- task test:one -- face-resting-text-source  # §2.3 — the LED judgement
flox activate -- task test:one -- face-readout-source
flox activate -- task test:one -- face-width-source         # §5.4 — no new exemption

# 4. the registries
flox activate -- task test:one -- shell-cells               # action probes + seams (§3.1, §3.2)
flox activate -- task test:one -- shell-extensions
flox activate -- task test:one -- module-shell-import-guard
flox activate -- task test:one -- card-range-source         # twotracks joins RANGE_BOUND_CARDS
flox activate -- task test:one -- card-control-ranges
flox activate -- task test:one -- push-card-schema          # §8.4 — this one really moves
flox activate -- task test:one -- mutate.guard
flox activate -- task test:one -- module-docs-lint

# 5. THE CONTRACT — §0.1 moves contract-lock.txt. Review the diff; do not accept blindly.
flox activate -- task docs:accept
git diff packages/web/src/lib/docs/contract-lock.txt

# 6. e2e
flox activate -- task e2e:serve
REPEAT=3 flox activate -- task e2e:one -- tests/twotracks.spec.ts
REPEAT=3 flox activate -- task e2e:one -- tests/twotracks-stereo.spec.ts
REPEAT=3 flox activate -- task e2e:one -- tests/twotracks-perfzip.spec.ts   # ⚠ §12.2 — the save/load path
REPEAT=3 flox activate -- npx --workspace e2e playwright test faces-parity --grep twotracks
REPEAT=3 flox activate -- task e2e:one -- tests/io-spec-consistency.spec.ts # §5.3 — the mount budget
flox activate -- task e2e:stop

# 7. typecheck LAST
flox activate -- task typecheck

# 8. ART — no baseline, no pin (§8.2). Run the property tests; expect `art/` to be
#    absent from the diff. Do NOT run art:update.
flox activate -- task art:one -- scenarios/twotracks

# 9. VRT: dispatch only. NEVER commit a PNG.
GREP=twotracks flox activate -- task vrt:commit

# 10. attest: NIL (§8.1).
```

⚠ `twotracks-perfzip.spec.ts` is the **portable-performance round trip** — it exports a
recorded tape out of band and reloads it, asserting `bufLenA`, `start_a`, `end_a` and
`a2b` all restore and the tape is audible. It is the spec most likely to notice a
param deletion done carelessly, and it must pass unchanged.

---

## 14. BUILD-COST ESTIMATE

| | |
|---|---|
| §0.1 — delete the two inert params, `docs:accept`, review, verify saved racks + ART | ≈ 2 h |
| the face declaration: seven bands, the rank argument, the `filterMode` roster | ≈ 4 h |
| `TwotracksReelBody` — the persistent waveform, both drag seams, SCREEN ON/OFF | ≈ 5 h |
| the transport + export action cells with the right probes and seams | ≈ 2 h |
| the card defect fixes (D5, D6) + the manifest and header corrections (D2, D3, D4, D8) | ≈ 2 h |
| `twotracks-face-model` with states 5, 9 and 11 as permanent negative controls | ≈ 2 h |
| the mount-cost before/after measurement (§5.3), VRT dispatch, reconcile | ≈ 1 h |
| **Total** | **≈ 18 h** |

Risk MED-HIGH, for three separate reasons rather than one: it carries a **contract
change** (§0.1), it is the wave's most likely **CI wall-time** offender (§8.3), and its
tab-rail structure is a **judgement a reviewer may overturn** (§5.2) — in which case
the correct response is to ship untabbed and ask, not to re-split.
