# 27. THE NEXT COHORT — spec lane, 2026-08-19 (the §2 QUEUE HEAD: Q2 / Q3 / Q4)

**Read against `main` @ `deb5453c`.** Nothing below was produced by running the DSP
or a browser. **Every figure is labelled `DERIVED-BY-READING`** (arithmetic on
constants read out of the shipping source) **or `MEASURED (<who>)`** with the
attribution, when the repo itself records the measurement. There is no number in
this document that I measured, and none is presented as if there were.

**Why this cohort.** `.myrobots/plans/faceplate-queue-2026-08-14.md` §2 has carried
`timelorde` (Q2), `treeohvox` (Q3) and `scope` (Q4) as PLAN-BLOCKED since
2026-08-14, and §11/§19 re-derived them three times without re-checking the blocks.
**All three blocks were re-checked against the tree. One has evaporated entirely,
two have changed shape, and a fourth block nobody wrote down was found.**

---

## 27.1 THE THREE BLOCKS, RE-CHECKED — the headline

| queue entry | the block as written | status | the evidence |
|---|---|---|---|
| **Q3 `treeohvox`** | *"blocked by #1658 — the module appears to be un-soundable from any surface"* | ⚠ **EVAPORATED. Fixed and gated.** | `treeohvox.ts:204-221` mounts a dedicated `gateCs` ConstantSource into worklet input 1; `:268-278` publishes the `manualGate` read key; `:137-139` declares the `treeohvox-gate` control family; `TreeohvoxCard.svelte:192-206` mounts the pad. `e2e/tests/treeohvox-strike.spec.ts` has a negative control (`:252`), a permanent positive control (`:325`) **and a DOCK leg (`:219`)**. |
| **Q4 `scope`** | *"THE OPEN QUESTION IS THE SCREEN… a dual-trace + Lissajous screen needs a registered PANEL or a `face.extension`. Settle that before ranking."* | ⚠ **SETTLED. The platform landed.** | `WIRED_SHELL_EXTENSION_SLOTS = ['glyph', 'fullViewBody']` (`shell-extensions.ts:124`). `fullViewBody` is a full-width surface at the head of the dock full view that **takes the place of the generic hero glyph and leaves every param band intact** (`:80-95`). Three adopters exist (`backdraft/`, `dx7/`, `videoOut/shell-extension.ts`). |
| **Q2 `timelorde`** | *"extension-class… the owl is a LOOK LOSS; painting it means a `face.extension` glyph — a genuinely different size of PR"* | ⚠ **REAL, but SMALLER than written, and the recommended SPLIT is refuted.** | Same `fullViewBody` finding. And the queue's *"land the face WITHOUT the owl first"* would ship `wizardOn` as a cell whose only visible effect is at a **downstream video jack** — see §27.4. |

⚠ **AND A BLOCK NOBODY WROTE DOWN, which applies to `timelorde` AND `scope`** — see
§27.3. It is not a reason to stop; it is a thing each PR must handle by name.

---

## 27.2 What all three share (read, so it is not restated per entry)

| property | `timelorde` | `treeohvox` | `scope` |
|---|---|---|---|
| params | 6 | 7 | 9 |
| inputs | 1 `gate` clock + 2 `gate` transport + 1 `gate` level + 1 `video` = **5** | 1 `pitch` + 2 `gate` + 7 `cv` = **10** | 2 `audio` probes + 9 `cv` = **11** |
| outputs | 13 `gate` + 1 `video` = **14** | 1 `audio` | 2 `audio` + 1 `mono-video` = **3** |
| `domain` | `audio` | `audio` | `audio` |
| `primaryAudioOutPortId` | **null** → `glyph:'none'` MANDATORY | `audio_out` — a glyph BINDS | `ch1_out` — a glyph BINDS (CH1 only) |
| `hasVideoSurface` | **false** (`domain === 'video'` only) | false | **false**, despite a `mono-video` out |
| declares `face` | no | no | no |
| in `STRICT_DOCS` | yes (`:243`) | yes (`:173`) | yes (`:155`) |
| in `DESCRIPTIONS` | yes (`:259`) | yes (`:356`) | yes (`:240`) |
| `INTERACTIVE_DOC_MODULES` | no (static — canvas rAF) | **yes** | no (static — canvas rAF) |
| `CARD_PRODUCER_LANE_TYPES` | ⚠ **yes** (`:192`) | no | ⚠ **yes** (`:190`) |
| `VRT_LIVE_SURFACES` | ⚠ **yes**, WRAP mask | no | ⚠ live, no mask (`__scopeVrtSeed` instead) |
| card mounts | `Knob` ×3 | `Knob` ×7 | ⚠ `NeonFader` ×6 |
| raw-write ledger | — | — | ⚠ `mode` (`raw-write-ledger.ts:270`, `kind:'debt'`) |

Four things checked rather than assumed, because each has burned a previous cohort:

- **The `mandelbulb` trap is STRUCTURALLY ABSENT from all three.** `mandelbulb`'s
  glyph resolves and then flatlines because a `domain:'video'` node is added to the
  VIDEO engine and never enters `AudioEngine.nodes`, so `getOutputNode` returns null
  forever (`mandelbulb-glyph-tap.test.ts:29-46` — the file IS present on this
  branch). **All three of these defs are `domain: 'audio'`**, so a resolving glyph
  here resolves to a node the audio engine really holds. ⚠ But *resolves* and
  *reads* are still two questions, and only the first is answered by reading.

- **None of the three can empty the `_face-fixtures.ts` legacy-fallback pool.**
  `derivePool()` requires `rendersAudioFaceplate` (**every** output maps to the
  `audio` domain class) **and** a `<NeonFader` in the card. `domainClassForCable`
  puts `gate` → `gate` and `mono-video` → `video` (`module-shell-model.ts:96-111`),
  so `timelorde` and `scope` are rejected on the domain leg; `treeohvox` passes the
  domain leg and is rejected on the fader leg (its card mounts `Knob`). §20.6's
  hazard does not reach this cohort. DERIVED-BY-READING.

- **`options[]` is not free on a 0..1 discrete param — it DEMOTES the cell outside
  the dock.** `paramCellKind` (`shell-control-kind.ts:266-271`) tests `p.options`
  FIRST: with options declared, `tier !== 'dock'` returns **`'knob'`**. Only
  *without* options does `looksLikeToggle(p) = curve==='discrete' && min===0 &&
  max===1` (`group-controls.ts:54-56`) return `'toggle'`. So Q4's *"all three become
  toggle cells"* is TRUE **exactly as long as no one declares an option roster to
  recover the names**. That trade is the single most consequential authoring
  decision in this cohort and it is spelled out per entry.

- **`face.sidebar` is the one contract-projected `face` field.** Declare none on any
  of the three and `contract-lock.txt` does not move and
  `faceplate-platform.spec.ts`'s `sweepBudgetMs(adopterCount)` does not move.
  A new `controlFamilies` entry IS in the contract — `treeohvox` already has its
  one, so its face costs no new lock line either.

### 27.2.1 ⚠ EVERY SHIPPED E2E FOR THIS COHORT IS BLIND TO ITS OWN FACE — EXCEPT ONE

This is the CLAUDE.md *"a gate whose PRECONDITION is the defect"* shape at cohort
scale, and it is why the queue's inherited STOP-2 notes were wrong twice.

| spec | surface it drives | can it see a face regression? |
|---|---|---|
| `e2e/tests/timelorde-transport-state.spec.ts` | `/rack?shell=legacy` (`:72`, `:153`) | **NO** |
| `e2e/tests/timelorde-tap-tempo.spec.ts` | `/rack?shell=legacy` (`:80`, `:119`, `:156`) | **NO** |
| `e2e/tests/scope-tuner.spec.ts` | the `rack` fixture | **NO** — `_fixtures.ts:93` is `/rack?shell=legacy&seed=none` |
| `e2e/tests/scope-xy-intensity.spec.ts` | the `rack` fixture (`:79`, `:115`) | **NO** |
| `e2e/tests/scope-video-out.spec.ts` | `/rack?shell=legacy` (`:143`, `:234`) | **NO** |
| `e2e/tests/treeohvox-strike.spec.ts` | ⚠ `:219` drives `/rack?seed=none` — the **DEFAULT** shell — and asserts the pad inside `dock-full-view` | **YES** |

So: promote `timelorde` or `scope` and **every one of their shipped e2e stays
green** while the surface a real user gets loses the affordance under test. The
`treeohvox` PR is the only one of the three that gets a red light for free — and it
gets it because `treeohvox.ts:125-136` deliberately wrote the trap down and pointed
a DEFAULT-shell spec at it. ⚠ *"Do not 'fix' that by re-pointing the test at the
card"* is on the def; obey it.

**What each PR therefore OWES:** at least one new spec on the **default** shell
asserting the promoted surface still does the thing. That is not polish; without it
the PR ships with no gate at all.

---

## 27.3 THE BLOCK NOBODY WROTE DOWN — a promoted CARD PRODUCER goes dark IN THE DOCK FULL VIEW

Both `timelorde` and `scope` are `CARD_PRODUCER_LANE_TYPES`
(`dom-source-modules.ts:187-194`): their *card's* rAF loop is the only writer of the
module's engine-visible state — `write(node,'displayFrame')` for timelorde
(`TimelordeCard.svelte:385`), `write(node,'cvCombined')` for scope
(`ScopeCard.svelte:153`).

Q2 asserts *"Promotion does NOT kill it — `needsHeadlessSourceMount` returns true
for the `'shell'` lane kind."* **That is true for the LANE and false for the DOCK
FULL VIEW**, and the second half is what a user reaches by clicking EXPAND.

Three lines, read in order:

1. `Canvas.svelte:2377` — `if (dockStore.isFullView(n.id)) continue;` The headless
   host **skips** any node whose full view is open.
2. `Canvas.svelte:2255-2257` states the reason: *"DockFullView already mounts its
   real card — a second mount would run two media elements for one node."*
3. `DockFullView.svelte:319-332` — `{#if migrated} <ModuleShell view="dock-full">
   {:else} <CardComponent … >`. **A migrated type mounts NO card there.**

So the precondition in (2) is exactly the thing promotion removes. For a promoted
producer with its full view open: no headless mount, no card in the full view, and
the lane tile is a `ModuleShell`. **Nothing is pushing.** Predicted consequence,
DERIVED-BY-READING against the recorded behaviour of the unmounted case:
timelorde's `video_out` falls to the `#07090d` idle field (MEASURED never-mounted:
`nonBlack 0, maxLuma 8, 1 distinct signature / 42 frames` —
`dom-source-modules.ts:124-130`), and scope's CV shadows **latch at their last
modulated value** rather than falling back to the knob (`:156-170`).

**This is not a reason to defer either face — it is the reason both faces must carry
the module's own surface.** `cube` is the shipped precedent: it is in
`CARD_PRODUCER_LANE_TYPES` **and** in `STRICT_FACES` (`strict-faces.ts:790`), and
`dom-source-modules.ts:110-115` records how — *"cube's hero cell IS `cube-view-{n}`
— the surface"*. The face is the producer. `fullViewBody` (wired,
`shell-extensions.ts:124`) is the same move with a bigger slot.

⚠ **Each PR must state, and prove with a spec on the DEFAULT shell, that its
extension body owns the pump while the full view is open.** Anything less ships a
module that goes dark on the one gesture that makes it big.

---

## 27.4 Q2 · `timelorde` — the rack's only module with a param the DSP never reads, and the queue's recommended split would ship it inert

**Merit: YES**, and it is still the highest raw user value in the queue:
`maxInstances: 1`, `undeletable: true`, auto-spawned into any rack that opens
without one (`timelorde.ts:96-101`), so it is the only module present in 100 % of
racks. 6 params, 5 inputs, 14 outputs, plus a TAP gesture and a transport the jacks
structurally cannot report.

**What it is FOR, musically.** It is the rack's only TIME AUTHORITY: one tempo, fanned
out to twelve simultaneous musical divisions plus a shuffled tap, so no patch ever
needs a separate divider. The verb a player performs is **setting the pulse the
whole rack agrees on** — by ear (TAP), by hand (BPM), or by slaving to hardware
(CLOCK IN / START / STOP). The one thing it does that its siblings do not: its
outputs are all *the same clock*, so changing one number re-times everything at
once.

**Control-heavy: NO.** 6 params over four ideas. **Honest page count: 4.** Nowhere
near `DOCK_TAB_MIN_BANDS = 7` (`dock-tabs-model.ts:57`). **No padding, no
escalation** — §25.5's escalation was a 6-against-7 argument and does not reach a 4.

### STOP 2 — the card, read line by line, and the queue's list was one short

`grep -nE '<button|<select|<input|oncontextmenu|manualTrigger|Toggle|Selector|accept='`
returns four `<button`s. Reading the file returns **six** affordances:

| # | affordance | `TimelordeCard.svelte` | survives as |
|---|---|---|---|
| 1 | RUN `■`/`▶` | `:546`, `toggleRun` → `set('running')` `:452-456` | a `toggle` cell on `running` |
| 2 | MUTE / ON | `:553`, `toggleMute` → `set('muteOutputs')` `:446-451` | a `toggle` cell on `muteOutputs` |
| 3 | TAP | `:559-567`, `tap()` `:469-475` writes `bpm` | an **ACTION** cell — and unlike an audition it writes a PARAM, so `readParam` is a valid probe |
| 4 | WIZARD toggle (the owl thumbnail IS the button face) | `:602-608`, `toggleWizard` → `wizardOn` | a `toggle` cell on `wizardOn` |
| 5 | ⚠ **SPACEBAR → tap** | `:488-502`, a `window` keydown scoped to `selected`, `!e.repeat`, `!isEditableTarget`, `!hasExternalClock` | ⚠ **NOTHING. There is no shell seam for a node-scoped key binding.** |
| 6 | ⚠ the footer readout | `:635` | ⚠ **only half of it is reachable** — see READOUTS |

- **(5) is a real affordance loss and it is NOT an a11y question.** The owner ruling
  *"no keyboard a11y — Tab IS the flip gesture"* is about navigation; this is a
  product gesture (tap tempo by ear, hands free) that `DESCRIPTIONS.timelorde:259`
  advertises by name. The PR must either state it as an accepted loss **in the PR
  body** or keep it alive from the extension body. ⚠ It is also a CORE-GESTURE
  change either way, so it needs owner sign-off before merge, not after.
- **(1) is conditional**: the RUN button is inside `{#if !transportSlaved}`
  (`:545`), i.e. it disappears the moment `start_in`/`stop_in` is patched. A face
  cell cannot vanish (completeness requires exactly one interactive cell per param),
  so **always show it and let the transport readout say who owns the transport** —
  which is the queue's recommendation and it survives the re-check.
- **(3) is conditional too**: `disabled={hasExternalClock}` (`:562`), and `tap()`
  is *additionally* a no-op on the same condition (`:470`) — belt and braces, so a
  shell cell that forgets the disabled state still cannot fight the follower.

### THE DISPLAY IS NOT OPTIONAL — this refutes the queue's recommended split

Q2 recommends *"land the face WITHOUT the owl first… then the extension glyph as its
own PR."* **Do not.** `wizardOn` is declared `card-only` and **is not consumed by
the DSP worklet at all** (`timelorde.ts:187-194`, verbatim: *"NOT consumed by the
DSP worklet (purely a card-visual flag)"*). `module-face-lint`'s completeness loops
every `ParamDef` with no filter and no skip-list, so the face MUST render a cell for
it. Land the face without the display and that cell:

- changes nothing the user can see **on the surface they are looking at**, and
- **does** change what `video_out` emits, because the headless-mounted card is still
  compositing (owl vs. the wizard-off overlay) — so its only observable effect is on
  a *downstream video module*.

A toggle whose effect is invisible here and visible three modules away is worse than
an inert one: it is a live control with a hidden subject. **`face.extension:
'timelorde'` + `fullViewBody` is part of v1, not a follow-up.** It also discharges
§27.3 (the body owns the `displayFrame` pump while the full view is open) and
§27.2's `VRT_LIVE_SURFACES` mask target moves with it.

### RANKING, FROM THE DSP

`timelorde-clock-core.ts`: every divisor (`DIVISOR_DEFS:86`) and multiplier
(`MULTIPLIER_DEFS:101`) is computed off one `periodSamples`, and `swingLagFor`
(`:403-415`) is `max(0, (swingAmount/360) × sourceInterval)` where `sourceInterval`
is the SELECTED train's own interval, not the master's.

| param | range | default | reach | authority |
|---|---|---|---|---|
| `bpm` | 10…300, log | 120 | **all 13 gate outputs** | the only param any downstream module can feel |
| `running` | 0/1 discrete | 1 | all 13 (freezes phase) | halts everything, position preserved |
| `muteOutputs` | 0/1 discrete | 0 | all 13 (zeroes writes) | silences the jacks, clock keeps turning |
| `swingAmount` | 0…90°, linear | **0** | **1 output** (`OUT_SWING`) | ⚠ at the default the swing tap is a sample-exact duplicate of its source |
| `swingSource` | 0…11 discrete | 0 (`1x`) | 1 output | re-points the swing tap |
| `wizardOn` | 0/1 discrete | 1 | **0 outputs in the audio domain**; `video_out` only | picture |

**Rank order: `bpm, running, muteOutputs, swingAmount, swingSource, wizardOn`.**

- **`bpm` is rank 1 on FANOUT.** It is the only param that reaches all thirteen gate
  outputs; `swingAmount` reaches exactly one. ⚠ **This argument would be WRONG for
  `scope`, which is the test.** `scope.timeMs` also reaches every channel, and ranks
  nothing by it — because scope's outputs are byte-identical passthroughs at every
  param setting (`scope.ts` `setParam` writes only `shadows[paramId]`; `gain1`/
  `gain2` are never touched), so its fanout is across two traces of one *picture*.
  Fanout across outputs ranks a control only when the outputs are the product.
- **`running` over `muteOutputs`** because STOP is strictly larger: it freezes the
  phase accumulator, so `LIVECODE`'s `clocked()` subscribers stop too, while MUTE
  leaves them firing (`timelorde-transport-state.ts:16-21`). Two states that are
  byte-identical at the jacks are not equal in the graph.
- **`swingAmount`/`swingSource` demote on CONDITIONAL APPLICABILITY**: with nothing
  patched to `swing`, both are observationally inert, and at the shipped
  `swingAmount = 0` the swing tap is an exact copy of `1x` even when it IS patched.
- **`wizardOn` last** — the only param with no DSP consumer.

**Tier ladder as a sentence.** `glyph: 'none'` is MANDATORY (`primaryAudioOutPortId`
returns null — 13 `gate` outs and one `video`, zero `audio`) and `hasVideoSurface`
is false (`module-shell-model.ts:177-179` is `domain === 'video'`, and timelorde is
`domain: 'audio'`), so `hasGlyph` is false and the compact cap is the glyph-less 3:
**at mini you get the TEMPO; at compact tempo plus the two transport switches; at
plate all six; the TAP action and the owl surface are dock-only.**

**Pages (4).** `tempo` = `bpm` + the TAP action · `transport` = `running`,
`muteOutputs` · `swing` = `swingAmount`, `swingSource` · `display` = `wizardOn`.
`order` and `pages` AGREE here and the comment should say so — unusually, priority
and signal order are the same list, because the module has one signal.
⚠ The `display` band is a 1-control band and earns its header on the skill's *"1
that is the module's identity"* clause only **because the `fullViewBody` sits above
it**; without the body it is a header over a control with no visible subject, which
is the §27.4 argument again.
⚠ `swingSource` with an option roster is a `selector` at the dock (12 options >
`SEGMENTED_MAX_OPTIONS = 6`), and `PARAM_CELL_WIDTH_CLASS` puts `selector` in
`'wide'` (`dock-row-plan.ts:113-140`), so the `swing` band is **SOLO** — it cannot
pack with `transport`. Say so in the comment rather than discovering it in a
baseline.

### THE `swingSource` ROSTER — and four of its twelve labels are REFUSED by name

`swingSource` is `discrete, min 0, max 11`. `looksLikeToggle` is false (max ≠ 1) and
there is no `options[]`, so `paramCellKind` falls through to **`'knob'`**: a
twelve-position dial that, with the resting decimal removed, prints **nothing at
all**. The names exist only on the card — `SRC_LABELS` at `TimelordeCard.svelte:511`
and `OUT_LABELS` at `:510`. That is a string that exists ONLY on the card, i.e. a
STOP-2 hit the queue did not list.

The fix is an `options[]` roster on the def (contract-transparent, no lock line —
`contract-signature.ts` projects `id/min/max/curve/defaultValue/units` only). ⚠ **Four
of the twelve labels are refused by `face-readout-source.test.ts`.**
`looksNumeric` is `/^[+\-−]?[0-9]+(\.[0-9]+)?\s*[a-zA-Z%°¢×x]{0,3}$/`
(`face-readout-source.test.ts:300`), and `'1x'`, `'8x'`, `'4x'`, `'2x'` all match
(digits + a ≤3-char alpha suffix). The eight slash forms `1/2 … 1/64` do not.
DERIVED-BY-READING against the regex.

**Do not rename them to dodge the regex.** The precedent is already in that file:
`cofefve/tempoSync` label `'1'` is exempt *"a musical DIVISION, and the roster it
sits in is written the way a delay pedal writes it… every sibling in the same roster
carries a slash and reads as a name for the same reason"* (`:174-178`). That
argument is this roster's verbatim. Add **four** `NUMERIC_LABEL_EXEMPTIONS` entries
with that reason. ⚠ Also note the file's own docstring claims *"a leading `x`/`×`
counts as part of the number"* while the regex only accepts a TRAILING one — so
`×1` would slip past a gate whose stated intent is to catch it. Do not exploit that;
fix or file it (§27.7).

### GLYPH

`primaryAudioOutPortId(timelordeDef)` = **null** (`shell-glyph-live.ts:94-97` matches
`type === 'audio'`; timelorde declares thirteen `gate` and one `video`). Every glyph
literal except `'none'` therefore falls through to `{kind:'static'}` — the dead-glyph
state the face lint refuses. **Declare `glyph: 'none'`.** And unlike a video def,
`hasVideoSurface` does NOT rescue the picture here: it is `domain === 'video'` and
timelorde is `domain: 'audio'` **despite having a `video_out`**. That is the exact
inverse of the `mandelbulb` shape — mandelbulb is a video def with an audio out whose
glyph resolves and cannot read; timelorde is an audio def with a video out whose
glyph cannot resolve at all and whose picture has no shell seam. **The `fullViewBody`
is the only route to the owl. This is not a preference.**

### READOUTS

| `valueId` | formula (params only) | at the defaults | the permanent NEGATIVE CONTROL a knob readback FAILS |
|---|---|---|---|
| `timelorde-transport` | `timelordeTransportState({running, muteOutputs}).short` | `RUNNING · gates live` | ⚠ **three-sided.** (a) sweep `bpm` 10 → 300: the string must NOT move — the model's own named control (`timelorde-transport-state.ts:107-110`); (b) a `running` readback is blind to MUTE; (c) a `muteOutputs` readback is blind to STOP. Only the JOIN separates all four states, and the four are byte-identical at all 13 jacks — MEASURED on the real clock core, 4 s @ 120 bpm, pinned in `timelorde-clock-core.test.ts` (*"STOP and MUTE are indistinguishable AT THE JACKS"*), quoted from `timelorde-transport-state.ts:9-14`, not re-measured here. |
| `timelorde-swing-lag-ms` | `1000 · (swingAmount/360) · (60/bpm) · r(swingSource)`, where `r` is the selected train's interval ratio (`DIVISOR_DEFS`/`MULTIPLIER_DEFS`) | **0.000 ms** (`swingAmount` default is 0) | ⚠ **two-sided, and the second side is the whole point.** (a) a `swingAmount` readback is blind to SRC: hold SWING at 90° and move SRC `1x → 8x` and the delivered lag goes **125.000 → 15.625 ms** at 120 bpm while the SWING dial never moves; (b) it is blind to TEMPO: at SRC `1x`, 90°, the lag is **1500.000 ms at 10 bpm and 50.000 ms at 300 bpm**. All four figures DERIVED-BY-READING from `swingLagFor` (`timelorde-clock-core.ts:403-415`); none was measured. |

⚠ **AND ONE THE FACE CANNOT HAVE, stated rather than quietly dropped.** The card's
footer (`TimelordeCard.svelte:635`) prints
`{measured-or-knob} BPM ({external|internal}) · src={name}`. `measuredBpm` comes from
`e.read(node,'measuredBpm')` — a worklet message (`:62-68`) — and `hasExternalClock`
is an **edge scan of `patch.edges`** (`:420-427`). Neither is a `ParamDef`, and a
`FaceReadoutValue` is `(read: (paramId) => number | undefined) => string`
(`face-readout-values.ts:409`), so **both are structurally unreachable**. This is the
`samsloop` shape: five of six specced readouts died on the same wall. The `src=`
third of the footer survives (it is `swingSource`, a param, and it becomes the
selector's own label). **The face is honestly worse than the card at answering "is
my tempo mine or the hardware's", and the PR must say so** — the platform fix is a
`node.data`-reading readout kind, which is a platform PR, not a face.

**`bareCells`: NO.** `RUN` / `MUTE` under a `transport` heading are the only thing
separating two identical switches — the tidyVco `A/D/S/R` case the owner kept, not
the mixmstrs `1LO…8LO` case he removed.

**Push 2:** no `PUSH_CARD_CONTROLS` entry today ⇒ GENERIC tier; promotion moves it to
FACE and the golden re-orders from declaration order to `bpm, running, muteOutputs,
swingAmount, swingSource, wizardOn`. Accept deliberately with the reason in the test.

**VRT:** ⚠ `timelorde` is already a live surface with a WRAP mask and a NOTE in
`vrt-exemptions.ts:1179-1189` explaining that it is *temporarily demoted from the
strict lane pending a linux baseline*. **That note names the OWL CARD**, which stops
rendering on the default shell after promotion — a ledger entry describing an
artifact that no longer exists is RED per CLAUDE.md. Re-word it in the face PR, and
add `{ type: 'timelorde', pages: 4 }` to `e2e/vrt/_shell-faces.ts`. The extension
body is a beat-pulsing canvas, so the face scenes need the same
`prefers-reduced-motion` freeze the card already relies on (`:585-591`).

**Rear card:** 5 input holes (`clock`, `start_in`, `stop_in`, `gate`, `video_in`) —
**none has a `paramTarget`**, so all five are orphans against `rearFieldPlan` and
`face.rear.groups` must be authored deliberately rather than derived. 14 outputs is
enough to out-run a column, so the derived default splits by CABLE DOMAIN (13 `gate`
+ 1 `video`); author a group only if the split should mean something else.

**RISK: MEDIUM.** No DSP change and no ART move, attest NIL, `docs:accept` needed
only for the `swingSource` roster (`options[]` is not projected — but re-read
`FACE_FIELDS_NOT_IN_LOCK` before assuming). The risk is the extension body and the
§27.3 pump, both of which are new ground for an AUDIO def.

---

## 27.5 Q3 · `treeohvox` — the block is GONE, and the queue's "STOP 2: CLEAN" is now false

**THE BLOCK: EVAPORATED.** Q3 says *"the factory declares no `manualTrigger` read key
and the card mounts no strike affordance, so the module appears to be un-soundable
from any surface… Do not author the face first."* Every clause of that is now
out of date:

- `treeohvox.ts:217-220` creates a dedicated `gateCs` ConstantSource summed into
  worklet input 1 — the same input a cable feeds, so it works ALONGSIDE a patched
  sequencer.
- `:268-278` publishes `read('manualGate')`. ⚠ The **omission** of `manualTrigger`
  is deliberate and documented (`:256-267`): `gate_in` declares `edge: 'gate'` and the
  processor acts on both edges, so the shared 5 ms `TRIGGER_PULSE_S` one-shot would
  end every auditioned note 5 ms after it began. **A face cell must be `mode: 'gate'`
  with `onGate`, never `mode: 'trigger'`** — `shell-cells.ts:161-165` fails the
  mismatch, and a caller asking for `manualTrigger` gets `undefined` with the ledger
  recording `delivered: false`.
- `:137-139` declares `controlFamilies: [{ id: 'treeohvox-gate', … testidPrefix:
  'treeohvox-gate' }]` — so the family line is **already in `contract-lock.txt`** and
  the face costs no new one.
- `TreeohvoxCard.svelte:192-206` mounts the pad with four release handlers
  (`up`/`cancel`/`leave`/`blur`) plus a `holding` idempotence guard.

The original defect is recorded as **MEASURED (#1658, quoted from `treeohvox.ts:118-123`;
not re-measured here): `audio_out` peaked at exactly `0.000e+0` over 145 frames with
all twenty-five card pressables clicked, against `3.390e-1` the moment a sequencer
gate reached `gate_in`.**

**A SECOND, UNSTATED BLOCKER ALSO LANDED.** The def once offered CUTOFF from 40 Hz
while `tb303Coeffs` clamped at 200 Hz, so **the bottom ~25 % of a log knob was
bit-exactly dead — MEASURED by bisection: every setting from 40 Hz to 139.5 Hz
rendered byte-identical output at ENVELOPE 0** (recorded at
`treeohvox-range-source.test.ts:6-9` and `treeohvox-dsp.ts:171-181`; not re-measured
here). It is fixed and joined three ways — def ↔ worklet `parameterDescriptors` ↔
the DSP constant — with a **both-directions** negative control
(`treeohvox-range-source.test.ts:69-88`: coefficients must MOVE just above the floor
and must COLLAPSE below it).

**Merit: YES.** 7 params, 10 inputs, 1 output, 1 control family. It is the rack's
acid bass.

**What it is FOR, musically.** It is the rack's only voice where the FILTER is the
instrument: a band-limited saw↔square into a 303 ladder whose corner is yanked
upward by a snappy decay envelope on every note, with a per-note ACCENT that pushes
both the amp and the filter drive. The verb is **squelching a line** — playing the
filter, not the notes. The one thing it does that `resofilter` + an `adsr` do not:
the envelope's *depth* is a nonlinear function of where the cutoff already sits, so
moving CUTOFF re-shapes the sweep rather than sliding it.

**Control-heavy: NO.** 7 params + 1 audition over four ideas. **Honest page count: 4.**
Below `DOCK_TAB_MIN_BANDS = 7`. No padding, no escalation.

### STOP 2 — the card, read line by line

Q3's *"STOP 2: CLEAN — `TreeohvoxCard.svelte` has zero buttons; every control is a
param fader"* is **now false in three ways**, and each matters:

| what | evidence | survives as |
|---|---|---|
| ⚠ **one `<button`** — the gate pad | `:193-205`, `data-testid={`treeohvox-gate-${id}-1`}` | a `SHELL_CELLS` entry `'treeohvox-gate-{n}'`, `kind:'action'`, **`mode:'gate'` + `onGate`**, `probe: { effect: { kind:'audition', seam:'manual-gate' } }` |
| the controls are **`Knob`s, not faders** | `:98-187` | knob cells; irrelevant to the pool (§27.2) but the queue's wording implied `<NeonFader>` |
| ⚠ seven knobs, not six | `:98-187` — `waveform` was added after the queue entry | a 7th cell |

**The testid survives promotion — and that is what makes the existing spec a real
gate.** The family key template is `'<familyId>-{n}'` (`shell-cells.ts:282`,
matching `'karplus-strike-{n}'`, `'cloudseed-clear-{n}'`), and the card already
emits `treeohvox-gate-${id}-1`. So `treeohvox-strike.spec.ts:238`'s locator
`dock.getByTestId(\`treeohvox-gate-${NID}-1\`)` resolves against the FACE if the cell
is declared, and fails if it is not. ⚠ DERIVED-BY-READING — **run that spec against
the branch before believing it**; it is the one place in this cohort where a green
run is worth something.

Nothing else on the card is unreachable: no `<select`, no `<input`, no
`oncontextmenu`, no `node.data`, no `accept=`, and no `<span>` readout.

### RANKING, FROM THE DSP

Read out of `packages/dsp/src/lib/treeohvox-dsp.ts`:

- `tb303Coeffs` (`:170`) floors cutoff at `TB303_CUTOFF_FLOOR_HZ = 40` — **exactly the
  def's own `min`** — so the CUTOFF dial is live end to end.
- `envModScalerOffset` (`:584`) maps `(cutoffHz, envMod%)` to a scaler/offset pair via
  `c = ln(cutoff/313.8153) / ln(2394.412/313.8153)`, **clamped to [0,1]**.
- `resonanceSkew` (`:150`) is `(1 − e^{−3r}) / (1 − e^{−3})` — an exponential skew, so
  the top of the RESONANCE dial does most of the work.

⚠ **The CUTOFF→ENVMOD coupling SATURATES, and the boundaries land inside the dial.**
`c` reaches 0 at **313.815 Hz** and 1 at **2394.412 Hz**. On the def's log CUTOFF
taper (40…6000), those sit at **41.11 %** and **81.67 %** of travel, so the env-mod
depth map is **bit-exactly constant over the bottom 41.1 % and the top 18.3 % of the
CUTOFF dial and varies only across the middle 40.6 %**. The shipped default
(1000 Hz) sits at **57.0 %** of travel — comfortably inside the live band.
All four figures DERIVED-BY-READING from the constants at `:569-574`; none measured.
⚠ **This is NOT a defect and must not be filed as one** — it is Open303's own
`calculateEnvModScalerAndOffset` verbatim, CUTOFF itself moves the ladder
monotonically across the whole range, and the clamp is upstream's. It is a RANKING
fact and a READOUT's negative control.

⚠ **ALL SEVEN PARAMS ARE OBSERVATIONALLY INERT AT SPAWN** — the module makes no
sound at all until a gate arrives (MEASURED, #1658, above). **So inertness cannot
discriminate the ranking here**, and #1758's "sample AT the declared value" habit
would otherwise read as finding seven dead knobs. Say so. The positive control is
the gate pad held: with `manualGate` high every one of the seven moves the output.

**Rank order: `cutoff, resonance, envelope, decay, accent, waveform, tune`.**

- **`cutoff` is rank 1 on UNCONDITIONAL APPLICABILITY.** It is the only control that
  changes the timbre of every note under every other setting — including
  `envelope = 0`, where it is the *whole* filter. ⚠ **This argument would be WRONG
  for `karplus`**, whose nearest analogue (BRIGHT) is an *in-loop* damping filter
  that tracks `f0`: at BRIGHT ≈ 0 the loop-gain safety cap shortens the note instead
  of darkening it, so the control changes DURATION, not just timbre, and cannot be
  ranked on timbral applicability. The 303's ladder is outside the amp path
  entirely; the coupling is a property of a recirculating string, not of filters.
- **`resonance` rank 2** — `resonanceSkew`'s exponential is the 303's identity (the
  squelch), and it is the only control that changes the filter's *character class*
  (round bass ↔ near-self-oscillation) rather than its position.
- **`envelope` then `decay`** — the sweep. `envelope` first because at `envelope = 0`
  the DECAY dial has nothing to time (a static filter has no sweep), so `decay`'s
  applicability is conditional on `envelope`'s and never the reverse.
- **`accent` rank 5** — conditional on `accent_in` being patched *and* high.
- **`waveform` rank 6, `tune` rank 7** — `tune` last deliberately: it is a ±12 st
  offset on a `pitch_in` a sequencer already owns, so on a real patch it is a setup
  control, not a play control.

**Tier ladder as a sentence.** `primaryAudioOutPortId` = `'audio_out'`, so a glyph
BINDS and `glyph: 'scope'` is right (a live output trace on a voice that flatlines
when ungated is honest — it flatlines *because* it is ungated). With a glyph the
compact cap is 2: **at mini you get CUTOFF; at compact cutoff and resonance; at plate
the six timbre controls; TUNE and the GATE pad are dock-only.**
⚠ **That puts the ONLY way to sound the module at the dock tier.** State it; the
alternative is a `face.hero` promotion of the gate cell, which suppresses the shell
glyph at the dock (`graph/types.ts:1003`) and costs the live trace. Recommend
the plain ranking and say why.

**Pages (4).** `filter` = `cutoff`, `resonance` · `sweep` = `envelope`, `decay` ·
`voice` = `tune`, `waveform` · `play` = `accent` + the `treeohvox-gate` action.
⚠ `order` and `pages` DISAGREE deliberately — `order` interleaves by priority,
`pages` separates by signal stage (what the ladder does / what times it / what
enters it / what a performance adds). Say so in the comment.

### GLYPH

`primaryAudioOutPortId(treeohvoxDef)` = **`'audio_out'`** — the def's single output is
`type: 'audio'` (`treeohvox.ts:77-79`). `glyphBinding` takes the *any glyph + a
primary AUDIO output* arm and returns `live-audio`. The tap resolves through
`AudioEngine.getOutputNode`, and treeohvox is `domain: 'audio'` (`:46`) so the node
really is in the audio engine's map — the `mandelbulb` failure mode
(`mandelbulb-glyph-tap.test.ts:29-46`) is structurally absent. **`glyph: 'scope'`.**

### READOUTS

| `valueId` | formula (params only) | the permanent NEGATIVE CONTROL a knob readback FAILS |
|---|---|---|
| `treeohvox-envmod-span-hz` | the cutoff range the filter envelope actually sweeps, from `envModScalerOffset(cutoff, envelope·100)` | ⚠ **two-sided AND bit-exact at both boundaries.** A `cutoff` readback reads 1000 Hz at every ENVMOD position; an `envelope` readback reads 0.5 at every CUTOFF position; the truth is a function of both. Legs: hold ENVMOD 0.5 and sweep CUTOFF **40 → 313.815 Hz — the value must NOT move** (the `c < 0` clamp); **313.815 → 2394.412 Hz — strictly monotonic**; **2394.412 → 6000 Hz — must NOT move again** (the `c > 1` clamp). ⚠ The three boundary POSITIONS are DERIVED-BY-READING (`:569-574`); **the Hz values the formula returns must be produced by the implementing PR from the real function — do not hand-type them here.** |
| `treeohvox-note-hz` *(the instrument's own control)* | `261.6255653005986 · 2^(tune/12)` (`pitchCvToFreq(0, tune)`, `:604-608`) | it is a monotone function of ONE knob and therefore **weak as a readout** — publish it precisely because it must be **invariant to all six of the others**, the `clap-q` / `moog911-attack-ms` pattern. At `tune = 0` it is **261.626 Hz**; at ±12 st, **523.251 / 130.813 Hz**. DERIVED-BY-READING. |

Totality legs are mandatory (fresh node, NaN, ±Infinity) — the function runs on every
render and a throw takes the faceplate down mid-drag.

**`bareCells`: NO.** Under a `filter` heading, `Cutoff` and `Reso` are two different
things, not two identical knobs — the mixmstrs case does not apply.

**⚠ ENROL `TreeohvoxCard.svelte` IN `RANGE_BOUND_CARDS`.** It hand-types
`min={-12} max={12}` (`:100-101`), `min={40} max={6000}` (`:113-114`),
`min={50} max={3000}` (`:153-154`) and four `min={0} max={1}` pairs. They AGREE with
the def today so `card-def-agreement` is green — which is exactly the
`AnalogLogicMathsCard` case already in the list. And this module has a live history
of a def/DSP range divergence (the 200 Hz clamp), so it is the last card in the
fleet that should keep restating its own numbers. **Better still: `cutoff` should
import `TB303_CUTOFF_FLOOR_HZ`/`TB303_CUTOFF_CEILING_HZ`**, which
`treeohvox-range-source.test.ts` already proves the def equals.

**Push 2:** GENERIC → FACE on promotion; the golden re-orders declaration order
(`tune,cutoff,resonance,envelope,decay,accent,waveform`) to face order
(`cutoff,resonance,envelope,decay,accent,waveform,tune`) — a rotation of `tune` from
slot 1 to slot 7. Accept deliberately.

**VRT:** `EXEMPT_FROM_VRT:872` with the reason *"deterministic card (6 knobs, no
canvas)"* and a header comment at `:1062-1066` saying *"6 knobs in 2 rows + 9 patch
inputs + 1 output"*. ⚠ **Both are STALE — there are 7 knobs, 10 patch inputs and a
gate pad** (`waveform` + `waveform_cv` landed after the entry was written). Per
CLAUDE.md a ledger entry naming an artifact that no longer exists is RED. Fix the
reason **and** capture in the face PR, and add `{ type: 'treeohvox', pages: 4 }` to
`e2e/vrt/_shell-faces.ts`.

**Rear card:** 10 input holes. Seven carry a `paramTarget` and land in their params'
page sections; **`pitch_in`, `gate_in` and `accent_in` are the orphans** and want an
authored `face.rear.groups` — they are the *playing* jacks (pitch / when / how hard)
and read as one group. One output, so the derived default is right.

**RISK: LOW.** No DSP change, no ART move (the ART baseline is
`art/scenarios/treeohvox/voice-character.test.ts` and nothing here touches audio),
attest NIL, `docs:accept` only if a range import changes a projected number (it must
not). **The face is a pure surface addition over a module that now works.**

---

## 27.6 Q4 · `scope` — nine controls that provably change nothing at the jacks, over a picture the generic face cannot draw

**THE BLOCK: SETTLED, and the answer is not a generic face.**

**Merit: FACE ON MERIT — as a `bespoke-surface`, NOT a generic one.** 9 params, 11
inputs, 3 outputs. It passes STOP 1 arithmetically with room to spare, and it fails
the *shape* test the skill's *"odd ducks whose controls are a viewport"* clause
exists for. The chain, each link read out of the source:

1. **All nine params are DISPLAY-ONLY.** `setParam` writes only `shadows[paramId]`
   (`scope.ts` factory); `gain1`/`gain2` are created at unity and never written. So
   `ch1_out` and `ch2_out` are byte-identical passthroughs at every setting of every
   param — the def says it in prose (*"Display-only — none of the controls touch the
   audio path"*) and the factory says it in code. DERIVED-BY-READING.
2. **Therefore the ONLY observable of all nine is the picture** — and the generic
   face has no cell that draws it. `hasVideoSurface(scopeDef)` is **false**
   (`module-shell-model.ts:177-179` is `domain === 'video'`; scope is `domain:
   'audio'` **with a `mono-video` output**), so the shell's video-thumbnail seam does
   not fire.
3. **The glyph BINDS but sees one channel.** `primaryAudioOutPortId(scopeDef)` =
   **`'ch1_out'`** (first `type:'audio'` output). `glyphBinding` returns `live-audio`
   on `ch1_out`, and scope is an audio-domain node so the tap resolves for real (the
   `mandelbulb` mode is absent). But the glyph draws **CH1 only, never CH2, and never
   XY** — so `ch2Scale`, `ch2Offset`, `ch2Range` and `mode` would be **four of nine
   controls with no observable at all** on a generic face.
4. **`fullViewBody` is WIRED** (`shell-extensions.ts:124`), takes the place of the
   hero glyph, and **leaves every param band intact** (`:80-88`), so completeness,
   the dock render-plan parity gate and `faces-parity` all still apply. Three
   adopters already ship.

**So: `face.extension: 'scope'` exporting `fullViewBody`, mounting the real
320×300 dual-trace/Lissajous canvas** — the same `drawScope` both existing render
paths already share. A PF-14 `panel` cell is the weaker alternative (also dock-only
by lint, but it competes with the bands for width instead of replacing a glyph that
would be showing half the truth).

⚠ **This ALSO discharges §27.3.** `ScopeCard.svelte:153` `write(node,'cvCombined')`
is the only thing that makes a SAME-DOMAIN cv cable reach a DISPLAY param at all
(`dom-source-modules.ts:138-143`), and an unmounted card leaves each shadow
**latched at its last modulated value**, not fallen back to the knob (`:156-170`).
The extension body must own that pump while the full view is open.

**What it is FOR, musically.** It is the rack's only inline PROBE: two signals go in,
the same two come out untouched, and you get to SEE them — in time or against each
other. The verb is **looking at a cable without changing it**. The one thing it does
that `dockscope` and `spectrograph` do not: two channels *related to each other*
(XY / Lissajous / stereo phase), which is a statement about a PAIR and cannot be made
by any number of single-trace modules side by side.

**Control-heavy: NO.** 9 params over three ideas, and six of them are the same idea
twice. **Honest page count: 3.** Nowhere near `DOCK_TAB_MIN_BANDS = 7`. ⚠ It would
be trivial to inflate this to 7 by splitting CH1 and CH2 and giving each range,
scale and offset its own band. **Do not.** CH1 and CH2 are *the same idea twice*,
which is the definition of a CLUSTER (`graph/types.ts:598`, ~14 px sub-header),
not of a page (~81 px band). Two clusters in one band is the honest shape and it is
what `face.pages` clusters are for.

### STOP 2 — the card, read line by line, and the queue missed the biggest item

| what | `ScopeCard.svelte` | survives as |
|---|---|---|
| CH1 mode button, label `AUDIO`/`CV` | `:225-236` → `toggleRange(1)` → `ch1Range` | a `toggle` cell |
| CH2 mode button, label `AUDIO`/`CV` | `:237-248` → `toggleRange(2)` → `ch2Range` | a `toggle` cell |
| XY button, label `XY`/`⇆` | `:249-258` → `toggleXY` → `mode` | a `toggle` cell |
| the 320×300 canvas | `:266-272` | ⚠ **the `fullViewBody` — nothing else** |
| ⚠ **THE TUNER** — `PITCH <hz> \| NOTE <name>` + a ±50-cent meter with an in-tune band | `:275-293`, fed by `eng.read(node,'pitch')` on a 100 ms interval (`:161-172`) | ⚠ **NOTHING GENERIC.** `detectPitch` runs over the analyser buffer in the factory (`scope.ts` `readPitch`); it is **not a param**, and `FaceReadoutValue` is params-only (`face-readout-values.ts:409`). It must live in the extension body or be lost. |
| the strings `AUDIO`, `CV`, `XY`, `⇆`, `PITCH`, `NOTE`, `—` | `:235`, `:247`, `:257`, `:277-281` | ⚠ **exist ONLY on the card** |

**The TUNER is the item Q4 does not mention and it is bigger than the buttons.** It
has its own e2e (`e2e/tests/scope-tuner.spec.ts`) and its own ART scenarios
(`art/scenarios/scope-tuner/{internal-references,real-world}.test.ts`) — four
artifacts pinning a feature that a generic face silently deletes, and the e2e is on
`?shell=legacy` so it cannot notice (§27.2.1). **Functional parity is a hard
requirement**: the tuner goes in the extension body, and the PR says so.

### THE OPTION-ROSTER TRAP — naming the three switches costs their cell kind

`ch1Range`, `ch2Range` and `mode` are all `discrete, min 0, max 1`, so `looksLikeToggle`
is true and `paramCellKind` returns `'toggle'` — **Q4's claim verified**. With the
resting decimal removed, a bare toggle does not paint `AUDIO`/`CV`.

The obvious repair — declare `options: [{0:'AUDIO'},{1:'CV'}]` — **is a downgrade**:
`paramCellKind` tests `p.options` before `looksLikeToggle`, and for `tier !== 'dock'`
it returns **`'knob'`** (`shell-control-kind.ts:266-271`). So naming the states turns
three switches into three twelve-o'clock dials everywhere except the dock.
**Recommendation: no `options[]`; keep the toggles; carry the names in the
`fullViewBody`** — where `drawScaleLabel` already paints `±1.0` / `±5V` per channel
onto the screen itself (`scope-draw.ts:318-319`, and `:489-490` on the phosphor
path), which is where a scope user reads
them anyway. State the trade in the face comment so the next author does not
"fix" it.

### RANKING, FROM THE DSP

`scope-draw.ts`, read:

| param | range | default | what it does | note |
|---|---|---|---|---|
| `timeMs` | 1…200 ms, log | 20 | `samplesInWindow = min(bufLen, max(2, round(timeMs/1000 · sr)))` (`:305`, `:361`, `:441`) | ⚠ **`bufLen` is 2048 — see DEFECTS** |
| `mode` | 0/1 | 0 | picks `drawSplit` vs `drawXY` — **a different picture, not a different setting** | |
| `ch1Range`/`ch2Range` | 0/1 | 0 | `RANGE_MAX_AUDIO = 1` vs `RANGE_MAX_CV = 5` (`:161-162`) — a 5× vertical rescale | |
| `ch1Scale`/`ch2Scale` | 0.1…10, log | 1 | multiplies on top of the range | |
| `ch1Offset`/`ch2Offset` | −1…1 | 0 | vertical position | |
| `intensity` | 0…1 | **0.5** | `persistScreens = max(0.02, 2·intensity)` (`:97-101`) | ⚠ **0.5 is a CODE-PATH SEAM — see DEFECTS** |

**Rank order: `timeMs, mode, ch1Range, ch2Range, ch1Scale, ch2Scale, ch1Offset,
ch2Offset, intensity`.**

- **`timeMs` is rank 1 on UNCONDITIONAL APPLICABILITY**: it is the only param that
  applies in BOTH display modes to BOTH channels — it sets the window `drawSplit`
  and `drawXY` both read (`:305` and `:361` are the identical expression). Every
  other control is per-channel, per-mode, or cosmetic.
- **`mode` is rank 2 because it is the only control that changes WHAT IS BEING
  ASKED**, not how the answer is drawn: NORMAL asks "what does each signal look
  like", XY asks "how do they relate". ⚠ **This argument would be WRONG for
  `qbrt`**, whose `mode` is a pure output picker over one shared SVF — switching it
  changes which tap you hear, not what question the module answers, and the def says
  so (*"the MODE knob is a pure output picker — so switching modes mid-render is
  pop-free"*). A mode ranks high only when the modes are different *questions*.
- **the two RANGES over the two SCALES**: RANGE is a 5× jump that makes an
  out-of-frame CV signal visible at all, while SCALE is a continuous trim within a
  frame you can already see. A signal you cannot see is not a smaller version of a
  signal you can.
- **`intensity` last** — the def's own word is *"Visual feel only"*, and at its
  default it takes the legacy render path outright (`:220`).

**Tier ladder as a sentence.** The glyph binds (`ch1_out`), so the compact cap is 2:
**at mini you get the TIMEBASE; at compact timebase and mode; at plate the six
window/channel controls; the offsets, the intensity and — critically — THE SCREEN
are dock-only.** ⚠ Say the last clause out loud in the PR: a lane scope tile shows a
46 px CH1 trace and no XY, which is *less* than today's lane card. That is the price
of `fullViewBody` being a dock-only slot, and it is a real regression for a user who
patches a scope to watch it in the lane.

**Pages (3).** `timebase` = `timeMs` · `channels` = two CLUSTERS —
`ch1` (`ch1Range`, `ch1Scale`, `ch1Offset`) and `ch2` (`ch2Range`, `ch2Scale`,
`ch2Offset`) · `display` = `mode`, `intensity`.
`order` and `pages` DISAGREE deliberately: `order` interleaves the channels by
priority so a 6-cell plate shows both channels' RANGE and SCALE rather than all of
CH1 and none of CH2; `pages` groups them so the dock reads as a channel strip. Say so.

### GLYPH

`primaryAudioOutPortId(scopeDef)` = **`'ch1_out'`**. `glyph: 'scope'` — it resolves,
it reads (audio-domain node, real `GainNode` output), and it is honest as far as it
goes. ⚠ **Declare it knowing it shows one of two channels and cannot show XY**, and
that at the dock the `fullViewBody` replaces it with the real screen
(`shell-extensions.ts:82-84`).

### READOUTS

| `valueId` | formula (params only) | at the defaults | the permanent NEGATIVE CONTROL a knob readback FAILS |
|---|---|---|---|
| `scope-display-state` | join of `mode`, `ch1Range`, `ch2Range` → e.g. `SPLIT · CH1 AUDIO · CH2 AUDIO` / `XY · X AUDIO · Y CV` | `SPLIT · CH1 AUDIO · CH2 AUDIO` | ⚠ **three-sided.** (a) a `mode` readback is blind to which RANGE each channel is in; (b) a `ch1Range` readback is blind to XY — **and in XY the two ranges stop meaning "upper/lower trace" and start meaning "X axis / Y axis"**, so the same two numbers name a different thing; (c) it must be INVARIANT to `timeMs`, `intensity`, both scales and both offsets. Only the join names the state, and the state is what three of the nine controls exist to set. |

⚠ **AND THE ONE READOUT THIS MODULE MOST NEEDS CANNOT BE BUILT.** The honest
timebase readout is *"the window the screen is actually drawing"*, i.e.
`min(2048/sampleRate, timeMs)` — the number that would make the dead travel in
DEFECT S-1 visible instead of silent. **`FaceReadoutValue` is
`(read: (paramId) => number | undefined) => string` (`face-readout-values.ts:409`):
it has no access to `ctx.sampleRate`.** Assuming 48 kHz would be an instrument that
reads wrong on a 44.1 kHz device — the exact CLAUDE.md failure mode.

⚠ **This is not a judgement call; the registry has already refused this exact
readout once.** `face-readout-values.ts:678-684` records why `noise-brown-corner-hz`
was deliberately NOT built: *"`FaceReadoutValue` is `(read) => string` and receives
no sample rate, while brown's corner MOVES with the interface (70.5 Hz at 44.1 k,
76.8 at 48 k, 153.6 at 96 k)… A live readout would print one of those three as if it
were all of them."* Same wall, same answer. **So the readout is not the fix; the def
is wrong and should be fixed** (DEFECT S-1). Do not paper over a range bug with a
derived string.

**`bareCells`: YES, candidate — and it is the second face in the fleet to want it.**
Under a `ch1` cluster header, captions `Ch1 Sc` / `Ch1 Y` / `Ch1 R` repeat the header
twice per cell — the mixmstrs `1LO…8LO` case verbatim, which is the one the owner
removed. Declare `face.bareCells` for the six channel params (dock-only by
construction; a lane tile has no cluster headers, so the thing that makes the caption
redundant is not on screen). ⚠ Hide the TEXT, never the accessible name — pass
`hideCaption`, never drop `label`.

**Push 2:** GENERIC → FACE; the golden re-orders from declaration order to the rank
above. Accept deliberately.

**VRT:** ⚠ scope is a LIVE surface handled by SEEDING, not masking —
`__scopeVrtSeed` builds a phase-locked synthetic snapshot
(`ScopeCard.svelte:100-128`). **The `fullViewBody` must honour the same global**, or
the two new face scenes are the `warrensspectrum` bug verbatim (*"a `__…VrtSeed`
frame pin the scene simply never called"* — `vrt-live-surfaces.ts:97-101`). Add
`{ type: 'scope', pages: 3 }` to `e2e/vrt/_shell-faces.ts` and dispatch;
`vrt-exemptions.ts` needs no edit (scope is not exempt — it passes 10/10 unmasked,
`:70`).

**Rear card:** 11 input holes — nine carry a `paramTarget` and land in their params'
sections; **`ch1` and `ch2` are the orphans**, and they are the module's whole
point, so author a `face.rear.groups` entry for them (the PROBES) rather than
letting them fall into a derived bucket. Three outputs across TWO cable domains
(`audio` ×2, `mono-video` ×1), which is exactly the derived default's split — author
nothing unless the split should mean something else.

**Also worth one line of boy-scout docs, not a defect:** `vizPassthrough: true`
(`scope.ts:69`) means `GroupCard` portal-hoists this canvas when scope is collapsed
inside a group, and `Canvas.svelte:2398` reads `groupCardHostsChildCard('scope')` so
the node is not double-mounted. A `fullViewBody` adds a THIRD potential mount of the
same picture. **Check it explicitly** — the comment at `Canvas.svelte:2256` says a
second mount is exactly what the exclusion exists to prevent.

**RISK: HIGH — the highest in the cohort.** A new `fullViewBody` adopter on an AUDIO
def (all three shipped adopters are video-adjacent), a producer pump that must move
into the extension, a VRT seed that must be re-honoured, a group-portal interaction,
and a tuner that must be rebuilt in a new home. ⚠ **This should not be attempted in
the same wave as `timelorde`** — both are `CARD_PRODUCER_LANE_TYPES` and both are
first-of-kind for §27.3. Land `treeohvox` first (LOW risk, blocker gone, and it
already has a default-shell gate), then `timelorde`, then `scope`.

---

## 27.7 DEFECTS — file these, do not fold them into a face PR

Every entry carries file:line. None was measured by me; each is read out of the
source and the derivation is shown.

| id | module | defect | evidence |
|---|---|---|---|
| **S-1** | `scope` | ⚠ **DEAD DIAL TRAVEL — the top ~29 % of the TIME fader is bit-exactly dead.** `samplesInWindow = min(snap.ch1.length, …)` in all three draw paths, and `snap.ch1.length` is the analyser's `fftSize`, hard-set to **2048**. So the window ceiling is `2048/sr` = **42.667 ms @ 48 kHz** / **46.440 ms @ 44.1 kHz**, while the def declares `max: 200`. On the log taper (`t = ln(v)/ln 200`) that is dead above **70.84 %** of travel at 48 kHz (**72.44 %** at 44.1 kHz) — the fader claims **4.6875×** more window than the buffer can supply. **This is the CUTOFF-clamp defect this module's sibling already fixed, in a different module, with its own gate.** DERIVED-BY-READING. | `scope-draw.ts:305-307`, `:361-363`, `:441`; `scope.ts:174` + `:182` (`analyser1.fftSize = 2048` → `new Float32Array(analyser1.fftSize)`); `scope.ts:116` (`max: 200`) |
| **S-2** | `scope` | **DOCS CONTRADICT CODE, same root.** `docs.controls.timeMs` says *"1 to 200 ms, log, default 20: smaller values zoom in on a few cycles, **larger values show a longer slice**"*, and the module header repeats *"scope time-window per screen width"*. False above ~42.7 ms. | `scope.ts:156` (`docs.controls.timeMs`) and `:36` (header) vs `scope-draw.ts:305` |
| **S-3** | `scope` | ⚠ **THE DEFAULT SITS EXACTLY ON A CODE-PATH SEAM.** `drawScope` branches on `isDefaultIntensity` (`\|intensity − 0.5\| < 1e-4`) into a legacy full-brightness render; **1e-4 off the default** it takes the phosphor path at `persistScreens ≈ 1.0`, where `phosphorAlpha(age ≥ persistScreens)` returns `EDGE_ALPHA = 0.12` — an **8.33× brightness step at the oldest end of the trace for a 0.01 % knob movement.** And the function's own docstring claims *"At the 12:00 one-screen length the whole screen sits near full brightness"*, which its own `if (ageScreens >= persistScreens) return EDGE_ALPHA` contradicts. DERIVED-BY-READING. | `scope-draw.ts:199-202` (the branch predicate), `:220-226` (the dispatch), `:112-116` (the claim), `:118-126` (`phosphorAlpha`) |
| **S-4** | `scope` | **RAW PARAM WRITE — already ledgered, still live.** `toggleXY` mutates `patch.nodes[id].params.mode` directly while its sibling `toggleRange` goes through `setNodeParam`. Two persistence laws for two buttons three lines apart. ⚠ Note promotion FIXES it on the default surface (the shell writes through `shell-param-writes`) but the ledger entry stays until the card is deleted. | `ScopeCard.svelte:70-77`; ledgered `raw-write-ledger.ts:270` as `kind: 'debt'` |
| **T-1** | `timelorde` | **DOCS CONTRADICT CODE — the def says a button does not exist that does.** `params.running`'s comment reads *"The card has no button for this — only the external gates can flip it."* The card has a RUN button that calls `toggleRun` → `set('running')`. (The prose `docs.controls.running` is correct — *"driven by the START/STOP gate inputs as well as the card's transport button"* — so the def contradicts **itself**.) | `timelorde.ts:183-185` vs `TimelordeCard.svelte:546` + `:452-456`; correct prose at `timelorde.ts:248-249` |
| **T-2** | `timelorde` | **A 12-STATE PARAM WITH NO `options[]`.** `swingSource` is `discrete 0…11`; `looksLikeToggle` is false and there is no roster, so `paramCellKind` returns `'knob'` — a twelve-position dial that paints nothing. The names live only on the card. §17.3's class, on an audio def. | `timelorde.ts:167`; `shell-control-kind.ts:266-271`; names at `TimelordeCard.svelte:511` |
| **T-3** | `timelorde` | **STALE VRT LEDGER REASON.** The `vrt-exemptions.ts` note explains the demotion in terms of *"the card big display… an owl toggle + a gate input row"* — the artifact promotion removes from the default shell. A ledger entry describing something that no longer exists is RED. | `vrt-exemptions.ts:1179-1189` |
| **V-1** | `treeohvox` | **STALE VRT LEDGER REASON — off by one on two counts.** *"deterministic card (6 knobs, no canvas)"* and *"6 knobs in 2 rows + 9 patch inputs + 1 output"*. Actual: **7 knobs** (`waveform` landed later), **10 patch inputs** (`waveform_cv`), plus a gate pad. | `vrt-exemptions.ts:872` and `:1062-1066` vs `treeohvox.ts:75`, `:115` and `TreeohvoxCard.svelte:176-206` |
| **V-2** | `treeohvox` | **THREE STALE COMMENTS, same root (the `waveform` addition).** The def's input-layout header stops at `accent_cv → input 8` and never lists `waveform_cv`; the factory comment says *"9 input slots: 3 audio-rate + **6** CV-into-param"* against seven CV ports; the card header describes *"2 rows of 3 knobs"* with `row 2: [ENV] [DECAY] [ACCENT]` against a four-knob row 2, and its patch-panel comment omits WAVE. | `treeohvox.ts:18-31`, `:177-178`; `TreeohvoxCard.svelte:4-13` |
| **V-3** | `treeohvox` | **A DSP DOC COMMENT RESTATES A RANGE THE DEF WIDENED.** `VoiceParams.decayMs` is documented *"DECAY knob — ms (200..2000)"*; the def declares `min: 50, max: 3000`. Harmless today (nothing reads the comment) and exactly the class that becomes a re-typed range tomorrow. | `treeohvox-dsp.ts:627` (in `VoiceParams`, `:618`) vs `treeohvox.ts:105` |
| **P-1** | platform | ⚠ **A PROMOTED `CARD_PRODUCER` HAS NO PRODUCER WHILE ITS DOCK FULL VIEW IS OPEN**, and the comment justifying the exclusion states a precondition that promotion removes. Live today for any `CARD_PRODUCER_LANE_TYPES` member in `STRICT_FACES` — `cube` is one. | `Canvas.svelte:2377` (`if (dockStore.isFullView(n.id)) continue;`), `:2255-2257` (the stale reason), `DockFullView.svelte:319-332` (`{#if migrated}`) |
| **P-2** | platform | **A GATE'S DOCSTRING DISAGREES WITH ITS REGEX.** `looksNumeric`'s comment says *"Signs and a leading `x`/`×` count as part of the number"*, but the pattern only accepts a TRAILING `[a-zA-Z%°¢×x]{0,3}`. So `×1` passes a gate whose stated intent is to catch it. | `face-readout-source.test.ts:295-301` |

---

## 27.8 THE COHORT AT A GLANCE

| | `treeohvox` | `timelorde` | `scope` |
|---|---|---|---|
| block status | ⚠ **EVAPORATED** | real, smaller than written (+ P-1) | ⚠ **SETTLED** (+ P-1) |
| merit verdict | **FACE ON MERIT** — generic | **FACE ON MERIT** — extension REQUIRED, not optional | **FACE ON MERIT — `bespoke-surface`** (`fullViewBody`) |
| honest pages | **4** (`filter`/`sweep`/`voice`/`play`) | **4** (`tempo`/`transport`/`swing`/`display`) | **3** (`timebase`/`channels`×2 clusters/`display`) |
| reaches the rail (7)? | no | no | no — **and inflating it to 7 would be padding, refused** |
| glyph | `'scope'` — binds `audio_out`, resolves, reads | ⚠ **`'none'` MANDATORY** — no audio out, `hasVideoSurface` false | `'scope'` — binds `ch1_out`, **CH1 only, no XY** |
| readouts | `treeohvox-envmod-span-hz` (+ `treeohvox-note-hz` as the instrument's own control) | `timelorde-transport`, `timelorde-swing-lag-ms` | `scope-display-state`; ⚠ the timebase one is **unbuildable** (no `sampleRate` in the reader) |
| default-shell e2e today | ⚠ **YES** (`treeohvox-strike.spec.ts:219`) | none | none |
| new cells | 7 knobs + 1 gate action | 6 (3 toggles, 1 knob, 1 selector, 1 knob) + 1 action | 9 (3 toggles, 6 knobs/faders) |
| CI wall-time at `10 s + 0.8 s/cell` | ≈ **16.4 s** | ≈ **15.6 s** | ≈ **17.2 s** |
| risk | **LOW** | **MEDIUM** | **HIGH** |
| recommended order | **1st** | 2nd | 3rd — **not in the same wave as timelorde** |

All three in one wave ≈ **49.2 s** plus 6 new face VRT scenes — under the ~2 min bar.
Declare no `face.sidebar` on any of the three and `sweepBudgetMs(adopterCount)` does
not move.

---

## 27.9 THE ADVERSARIAL PASS — what I attacked in my own spec

1. **"The queue said treeohvox's STOP 2 was CLEAN, so I can skip the card."** Wrong
   twice: there is one `<button>` now, and there are seven knobs where the queue and
   two ledger entries still say six. **The grep found the button; only reading found
   the seventh knob and the stale ledgers.** §25.8's ATTACK 2 again: the grep is
   necessary, not sufficient.
2. **"Q2 says the owl needs an extension GLYPH, so that is the shape."** Checked:
   `fullViewBody` is wired and is a strictly better fit (full width, at the head of
   the dock view, replaces the glyph rather than competing with it). The queue's
   sentence was written before the slot existed.
3. **"timelorde has a `video_out`, so `hasVideoSurface` gives it a free thumbnail."**
   False — `hasVideoSurface` is `domain === 'video'`, nothing to do with ports. I
   went looking for this specifically because §16 records the shell being ready for
   video faces, and it does not transfer to an audio def with a video port.
4. **"scope's glyph binds, so the picture is handled."** It binds to CH1 and cannot
   draw XY. Four of nine controls would have no observable. That is what moved the
   verdict from "generic face" to `bespoke-surface`.
5. **"Declare `options[]` to name the AUDIO/CV states."** Checked the resolver:
   options are tested BEFORE `looksLikeToggle`, and outside the dock the cell
   downgrades to a knob. The obvious repair is a regression.
6. **"Name timelorde's twelve divisions and move on."** Checked the readout gate's
   own regex: four of the twelve labels are refused as bare numbers. The exemption
   precedent (`cofefve/tempoSync`) exists and its stated reason is this roster's
   verbatim — so the answer is four exemptions, not a rename.
7. **"The e2e already covers all of this."** Every scope and timelorde spec drives
   `?shell=legacy`. They would stay green through the exact regressions this cohort
   risks. That inverted the "what does each PR owe" section.
8. **"Add a derived readout for the real time window."** The reader is params-only —
   no `sampleRate`. The readout would have to hard-code 48 kHz and lie on a 44.1 kHz
   device. Dropped it and filed the range bug instead (S-1).
9. **What I could NOT check by reading, and is therefore owed a measurement**: that
   `treeohvox-strike.spec.ts:238`'s testid really resolves against a shell action
   cell; that the extension body can actually own the `displayFrame`/`cvCombined`
   pump while the full view is open; and that `scope`'s glyph tap *reads* rather than
   merely *resolves*. All three need a browser.
