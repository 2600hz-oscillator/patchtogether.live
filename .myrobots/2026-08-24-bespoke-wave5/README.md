# BESPOKE FACE PROGRAM — WAVE 5 (the two the OWNER ASKED FOR, the GAMES, and the BINDERS)

Nine spec packages for `bespoke-surface` modules, chosen off the live roster
(`docs/design/face-migration.generated.md` on `main`). Each is a `spec.md` plus one to three
browsable, self-contained HTML mocks. Two shared analyses carry what a group has in common
rather than repeating it per module.

**Method, per the standing directive:** analyse what the module is FOR first, then author the
spec, then build from the spec. These are the analysis and the spec. **Nothing here is
implemented.**

| module | group | class | verdict | risk | est. |
|---|---|---|---|---|---|
| [`score`](score/spec.md) | ⭑ owner-requested | SHEET-MUSIC sequencer | **PROMOTE** — build after #2183 | MED-HIGH | ≈ 16 h / 1 PR |
| [`numpadPlus`](numpadPlus/spec.md) | ⭑ owner-requested | keymapped step sequencer | **PROMOTE** — the least-blocked module the program has examined | MEDIUM | ≈ 16 h / 1 PR |
| [`frogger`](frogger/spec.md) | [games](GAMES.md) | CV-steered arcade game | **PROMOTE** — cheapest in the wave, and it discharges a ratchet its own exemption names | LOW-MED | ≈ 13.5 h |
| [`modtris`](modtris/spec.md) | [games](GAMES.md) | falling-block game | **PROMOTE, after a named precursor** | MEDIUM | ≈ 18.5 h |
| [`nibbles`](nibbles/spec.md) | [games](GAMES.md) | snake, **video domain** | **PROMOTE** — the wave's only lane picture | MEDIUM | ≈ 17.5 h + a separate 2 h attest PR |
| [`skifree`](skifree/spec.md) | [games](GAMES.md) | vendored arcade game | ⛔ **REFUSE.** Three independent blockers — do the producer bug-fix instead | — | ≈ 8 h (the fix, not a face) |
| [`midiCvBuddy`](midiCvBuddy/spec.md) | [binders](BINDERS.md) | hardware → rack | **PROMOTE** — build first in its cohort | LOW | ≈ 6 h |
| [`midiOutBuddy`](midiOutBuddy/spec.md) | [binders](BINDERS.md) | rack → hardware | **PROMOTE** | LOW-MED | ≈ 7 h |
| [`chromaconsole`](chromaconsole/spec.md) | [binders](BINDERS.md) | device control surface | ⛔ **BLOCKED** on one precisely-located capability | MEDIUM | ≈ 10 h + 3 h precursor |

**Seven promote, one refuse, one blocked.** Both refusals are more valuable than most of the
promotions, and §3 and §4 are why.

---

## WHY THESE NINE, IN THESE THREE GROUPS

`score` and `numpadPlus` were **requested by the owner by name**, with comprehensive specs
asked for. They are also the two largest cards left on the roster (1272 and 546 lines), so
they would have starved any group they were placed in. Each got a dedicated agent.

The other seven are grouped because each group shares **one design problem**, not a folder:

* **The GAMES** — `frogger`, `modtris`, `skifree`, `nibbles` — all have a live playfield as
  the primary interaction, with `pong` (wave 1) already spec'd as a direct precedent, so the
  group is derivative work on a settled argument rather than four fresh derivations. What
  made it worth a whole agent is the **contrast inside it**: `nibbles` is video-domain and
  the other three are audio, and the same requirement resolves by two mechanisms that share
  no code (§5). Second shared problem: every one of them has a SCORE and a LIVES count, so
  the resting-text question had to be ruled once, for four modules (§2).
* **The BINDERS** — `midiCvBuddy`, `midiOutBuddy`, `chromaconsole` — all attach the rack to
  hardware that is not in the rack: connect gesture, live device roster, few or no params.
  Wave 4 named this cohort and aimed a platform ask at it, so specifying it is also the test
  of that ask (§3).

⚠ **`doom` and anything blood-related were never opened.** Standing owner ruling. The games
group is where that bites — a sweep for "game modules" walks straight into it — so it is
**excluded by name, with the mechanical reason, in `GAMES.md` and in all four game specs**.
A silent inclusion is the failure mode even when the change is otherwise correct.

Also excluded, deliberately: the five sequencers #2183 deletes; `clipplayer` (the owner chose
option (a), the card stays); the note-entry-blocked VST pair; and everything already spec'd
in waves 1–4.

---

## 1. ⚠ THE TWO PLATFORM ASKS — one REFUTED, one ESTABLISHED, and the difference is the METHOD

This is the wave's most transferable result, and it only exists because both happened in the
same wave.

### 1.1 Wave 4's ask does NOT survive the cohort it named — `BINDERS.md §1`

Wave 4 closed on: *"give `ShellSelectorCell.options`/`value` the same `env` that
`ShellActionCell` already gets"*, naming seven adopters, three of which are this wave's
binder cohort. **It fails in two independent ways.**

**TOO NARROW.** `ShellCellEnv.engine` is typed `{ write(node, key, value): void }`
(`shell-cells.ts:185-190`). **There is no `read`.** Every device picker in the cohort reaches
its roster through a read (`read('card-api')` → `devices` / `listOutputs()`). A selector
handed today's `env` still could not enumerate one device.

**UNNECESSARY.** `PatchEngine.read(node, key)` exists (`engine.ts:2234`) and
`getActiveEngine()` returns the full engine from plain `.ts` — already consumed by four
module-owned action files. `shell-cells.ts` says so **twice, in its own comments**, as the
reason an action does *not* take `env` (`:1405-1408`). `ShellSelectorCell.options` is already
a plain closure in a module-owned file; it can call `getActiveEngine()` on the next line.

⚠ **This is the THIRD instance of a false blocker `module-faceplates.md` warns about by
name**, with *"assume a third would too"* attached. **The warning is filed under an ACTION
heading and this instance was about SELECTORS**, so an agent reading for the selector question
never reaches it. **A warning scoped to one cell shape does not generalise to another** — that
sentence, not the finding, is what stops a fourth instance.

`BINDERS.md §1.5` carries three small corrective actions (fix the two comments that
manufacture the belief; move the skill's warning somewhere cell-shape-neutral; say in the type
whether the write-only `env` is a deliberate boundary). **Do not schedule the change.**

### 1.2 chromaconsole's blocker is verified in the OPPOSITE direction — `chromaconsole/spec.md §0.2`

**A face cell's caption is `ParamDef.label` and nothing else.** Ten call sites in
`ModuleShell.svelte`, all `label={pd.label}`; the one apparent exception is a def-derived
warped-fader plan; shell-cell captions are static strings on the `SHELL_CELLS` record.
**There is no node-derived caption anywhere in the shell.**

chromaconsole's eight params are `slot1`…`slot8`, labelled `"slot 1"`…`"slot 8"`, and **what
each one controls is per-node `node.data.assign`.** The card solves it (`knobLabel()` reads
the live assignment); a face cannot. And the params **must** be face cells — `module-face-lint`
walks `def.params` unconditionally and its render-side twin requires each to resolve to
exactly one interactive cell. **Four escapes, all closed, each for a different reason.**

That is a **functional-parity loss**, which is never surfaced as an owner choice — so the
verdict is **BLOCKED, not REFUSED**, with the ask sized: one optional
`labelFor?: (node) => string` on `ParamDef`, negative-controlled in both directions, smallest
version being the field plus one call site.

### 1.3 THE PAIR IS THE POINT

> **One ask was refuted by looking for the capability and finding it. One was established by
> looking for the capability and not finding it.** Both searches are recorded by file and
> line. The difference between a real platform blocker and an invented one is **whether
> anybody ran the search**, and both halves of that are in this wave.

Wave 4's reasoning was careful and its supporting measurement was correct — it identified a
false general claim in a shipped comment and located the right constraint. It then reached one
step past the evidence. **A correct diagnosis followed by an unnecessary prescription is
harder to catch than a wrong diagnosis, because everything up to the last paragraph checks
out.**

---

## 2. ⛔ THE GAME-SCORE RULING — and the gate cannot see EITHER answer

Every game in this wave has a score and a lives count, and "is a game score allowed on a
faceplate?" is exactly the shape that has gone wrong four times. **Ruled once, for four
modules** (`GAMES.md §1`):

* Score and lives painted **INSIDE the playfield canvas are ALLOWED** — they are the module's
  **artwork**, not the face's chrome. A playfield with its score in it is ONE PICTURE, and
  that picture is the width earner.
* A score or lives row rendered as **CHROME BESIDE the playfield is FORBIDDEN** — it is the
  deleted hero readout strip (#1957) with a different label: a labelled derived value sitting
  at rest next to the thing it describes, and none of the four permitted roles.

⚠ **`face-resting-text-source.test.ts` cannot see EITHER shape**, and states that blind spot
in its own words: text drawn into a canvas is invisible to it, and a chrome row inside a
`fullViewBody` is module-owned markup rather than a `ModuleFace` field. **So this ruling is
enforced by the dock VRT baselines and a human reviewing them, and by nothing else.**

That gap is written down rather than implied. A spec relying on a gate that structurally
cannot check its rule is the failure this repo cares most about, and "the resting-text gate
keeps this honest" would have been exactly that sentence.

⚠ **And the escape hatch is not free where it is most wanted.** The four do not agree today:
frogger and modtris already paint their HUD inside the canvas and need no change; `skifree`
and `nibbles` use DOM chrome. **`nibbles` paints no text in its canvas at all**, so putting
`LEN` there is a `paintFrame` edit — to a file **in the WebGL attest basis**. The one module
that most obviously wants the hatch is the one where using it costs an owner-machine GPU
re-attest CI cannot run. **Priced separately; not folded into the face PR.**

---

## 3. ⛔ THE LIVE DEFECT THAT IS BIGGER THAN ANY FACE — `skifree` — `GAMES.md §5`

**`SkifreeCard.svelte` owns the entire game.** It injects the bundle, calls
`window.SkiFree.create({ canvas, … })` against its own canvas, and publishes the controller on
a shared bridge. The factory only READS it.

**No card ⇒ no bundle ⇒ no controller ⇒ no game.** Not a missing picture — a missing module.
And `laneRenderKind` returns `'placeholder'` for an un-migrated module under the shipping
shell, so:

> **On `main` today, a rack containing SKIFREE has no game at all until the user expands its
> dock pane — and collapsing the pane disposes the run.**

**Two deny-by-default gates own this class and both are structurally blind to it.**
`CARD_PRODUCER_LANE_TYPES` derives from two `PRODUCER_SEAMS` regexes searched over each card's
**`.svelte` subtree**; skifree publishes through a **`.ts`** file. `card-media-lifetime`'s
`EXTRAS_OWNERS` never asks, because skifree is not on the extras channel at all. Both green.

That is the Pattern-5 shape verbatim — **a filter applied before the check quietly redefined
the check's subject.** And every skifree e2e boots `?shell=legacy`, so nothing in the suite
has ever looked.

**Routing: the producer fix is worth doing on its own merits, now, as an ordinary bug PR,
independent of any face.** The face is refused behind it plus two more blockers (a zero-param
lane tier at #1974's bar, and an un-pinnable third-party render loop).

---

## 4. ⚠ THE MIGRATION HAZARD THAT APPEARS IN EVERY GROUP: GREEN-AND-BLIND, NOT RED

CLAUDE.md's *"a gate whose PRECONDITION is the defect cannot fail on the defect"* is the
single most frequently-hit rule in this wave. It landed in all three groups, by three
different mechanisms, and **not one instance goes red.**

| where | the mechanism | consequence |
|---|---|---|
| `score` | `midi-learn-note.spec.ts` boots `/rack?shell=legacy&seed=none` ⇒ `shellFaces=false` ⇒ `laneRenderKind` returns `'legacy'`, so it keeps finding `score-play-ds-1` and keeps passing | it would **certify an orphaned MIDI binding as fine** — `bindingKey` is `${moduleId}:${paramId}`, the card binds the synthetic id `play` and the face looks up `isPlaying`, so every saved binding orphans in localStorage |
| `numpadPlus` | three e2e specs, same root: `?shell=legacy` keeps the CARD in the lane, while `Canvas.svelte:9282` passes `migrated` to the dock full view **with no `shellFaces` term** — so the dock swaps regardless | the specs go green while testing a surface the user no longer operates |
| `modtris` | the derived `AUDIO_OPERABLE_FIXTURE` pool has **exactly one member, and it is modtris**. Promoting it returns `migration-complete` → `test.skip` | **`workflow-shell.spec.ts`'s "the legacy card is OPERABLE in the dock full view" leg silently stops running.** Loud message, green run, coverage gone. **Skips are not passes** |
| `midiOutBuddy` | the lane-following `$effect` (card `:162-165`) dies with the card | a **defect that PROMOTION CREATES** — §6 |

⚠ **The `?shell=legacy` root is one fact and it explains three of the four:** a spec on the
legacy flag keeps the card in the LANE, and the DOCK swaps on `migrated()` alone. Any spec
that reaches for an un-faced module's card is a candidate, and the failure is silent by
construction.

⚠ **And `AUDIO_OPERABLE`'s pool narrowed from 4 at the #2137 split to 1 today with nobody
measuring it**, because a shrinking DERIVED pool emits no signal until it empties. It was
found by **evaluating the derivation, not by reading its comment** — the comment still says
"4 candidates". A derived fixture pool fixed the hand-maintained list's *staleness* and
inherited its *exhaustion*.

---

## 5. THE LANE-PICTURE DECISION — ONE ACCEPT, EIGHT REFUSALS, AND THE PORT LIST IS A DECOY

`hasVideoSurface(def)` is `def?.domain === 'video'` and **nothing else** — no opt-in, no face
field, no port check — and `VideoTileThumb` takes the `nodeId`, so a video module's lane
picture is per-node by construction. Everything else is on the glyph seam, where
`ShellExtensionGlyphProps` carries `num` / `numbers` / `testid` and **no `nodeId`**, so every
instance would draw a byte-identical picture.

⚠ **The intuitive rule — "the module with a video port gets the picture" — is FALSE IN BOTH
DIRECTIONS, and this wave contains both counter-examples:**

* **`skifree` declares a `video` OUTPUT port and gets no picture**, because it is
  `domain: 'audio'`. Its `out` is a cross-domain bridge source — a port a video cable
  consumes, not a surface the shell can blit.
* **`nibbles` declares two `audio` outputs and gets the picture anyway**, because it is
  `domain: 'video'`.

**The predicate is the DOMAIN and only the domain.**

`nibbles` is the wave's single accept, and it is free: `LANE_ROW_MAX_CELLS_WITH_GLYPH = 2` and
nibbles has exactly 2 params, so its compact tile is **picture + both cells with nothing
evicted** — the #1785 picture-outranks-controls rule never has to fire.

The eight refusals resolve by **four different mechanisms**, which is the test of whether they
are arguments rather than copies: no engine surface (frogger, modtris — #2065 verbatim); no
audio out so every glyph literal is a dead static (the binders, score); **no producer at all**
(skifree — even a `nodeId` prop would draw nothing); and a picture that would need more state
than a `nodeId` could carry (numpadPlus needs `layers` + `activeLayer` + a per-frame
`stepIndex`).

⚠ **frogger and modtris are the sixth and seventh modules to hit the missing `nodeId`** (after
`scope`, `rasterize`, `wavesculpt`, `timelorde`, `pong`). That is no longer a per-module
footnote; it is the standing argument for the escalation waves 2 and 3 nominated. **No spec
here asks for it or depends on it.**

---

## 6. ⚠ A DEFECT THAT PROMOTION *CREATES*, AND THE STOP-2 GREP IS BLIND TO ITS WHOLE CLASS

`MidiOutBuddyCard.svelte:162-165` is an `$effect` that keeps the engine's send-channel in step
with the derived effective channel — *"so a module that has NOT been overridden still follows
its lane when it is moved between columns."*

**Promotion deletes the card, and that effect with it.** A module dragged between channel
columns would silently stop following its lane, on the one behaviour its own def spends
thirteen lines explaining (#1168).

⚠ **The STOP-2 grep in `module-faceplates.md` is
`'<button|<select|<input|oncontextmenu|manualTrigger|Toggle|Selector|accept='`.** It finds
affordances a USER operates. **It is structurally blind to a component-lifecycle side effect
the card performs on the user's behalf** — an `$effect`, an `onMount`, a subscription. Those
die on promotion exactly as buttons do, and nothing in the checklist looks for them.

**Grep for `$effect(` and `onMount(` as well, on every module.** And note the category: a bug
found on `main` can be scheduled; **a bug that does not exist until the PR that must also fix
it** cannot, and it is only visible if someone asks what the card was doing besides rendering.

The fix is not to move the effect into the `fullViewBody` — a body is **dock-only**, so
correctness would then depend on a dock being open. It moves into the engine factory, which
already owns `setChannel` and already reads `node.data`.

---

## 7. THE `.data` CENSUS — wave 3 gave 2, wave 4 gave 6, wave 5 makes it TWELVE, and finds a THIRD STATE

`mutate.guard.test.ts`'s three patterns all anchor on the literal token `.params`
(`RAW_PARAM_WRITE`, `RAW_PARAM_WRITE_KEY`, `WHOLE_BAG`), so the guard is **structurally blind
to `.data` writes** — and therefore cannot distinguish the careful modules from the careless
ones.

Wave 5 read six more, and produced a shape the earlier waves' binary column cannot express:

| state | modules | Cmd-Z? |
|---|---|---|
| bare proxy write, no transaction | `kria`, `audioOut`, `midiclock`, `midiCvBuddy`, `midiOutBuddy`, part of `numpadPlus` | ✗ |
| ⚠ **`ydoc.transact(fn)` with NO `LOCAL_ORIGIN`** | `chromaconsole`, `score`, `numpadPlus` | ✗ — atomic, but **outside the undo stack** |
| `ydoc.transact(fn, LOCAL_ORIGIN)` | `picturebox`, `matrixMix` | ✓ |

> ⚠ **A `transact` reads as careful and a bare proxy write reads as sloppy. They are equally
> un-undoable, and only one of them survives review.**

That is the finding, and it is worth more than the count. Three of this wave's six are in the
middle row — code that looks like it did the right thing.

Two consequences are user-visible and severe enough to name: **`numpadPlus` can erase sixteen
steps that Cmd-Z cannot restore** (arming REC and pressing PLAY, through a bare proxy write),
and **`chromaconsole` cannot undo a slot reassignment** — the most destructive edit on that
module, and the one a player would reach for undo after. Both are fixed inside their face PRs.

⚠ **Two further copies of the same helper were found byte-for-byte identical**
(`MidiCvBuddyCard.svelte:89-97` and `MidiOutBuddyCard.svelte:135-143`). The pattern
**propagates by copy** through cohorts of deliberate siblings, and a guard that cannot see it
cannot see it spreading either.

**Routing is unchanged from waves 3 and 4.** Module fixes ride their face PRs. Whether `.data`
gets an origin-tagged seam is a separate owner-facing decision; this wave reports, does not
build, and no spec assumes it lands.

---

## 8. THE CORRECTIONS — claims checked that came back different

Wave 3's pattern was *"the rule was applied correctly and the subject was never checked."* It
repeated fifteen times across this wave; each is recorded in place. The four with the widest
reach:

1. **"An audio suspend freezes an audio game's picture." FALSE.** `scheduler-clock.ts` drives
   `dispatch()` from a **Web Worker `setInterval`** with **no AudioContext check anywhere in
   the file**. So `freezeAudio` and `freezeFaceVideo` cannot reach frogger or modtris, and a
   scene capturing "after the suspend" is capturing an arbitrary number of elapsed ticks.
   ⚠ This changes a design: **pong's `freeze`-param seam is the ONLY mechanism, not the
   convenient one.**
2. **"The module with a video port gets the lane picture." FALSE in both directions** — §5.
3. **"The derived fixture pools are self-refilling, so a promotion is free."** True for three
   of four, false for the one that matters — §4.
4. **"score's MIDI-assignable play button is a STOP-2 failure." FALSE, and the real problem is
   narrower and worse.** The affordance survives (`isPlaying` is `discrete 0..1` →
   `looksLikeToggle` → `<Toggle>`, calling the same `makeMidiAssignable`). What is lost is that
   `bindingKey` is `${moduleId}:${paramId}` and the ids differ, so **every saved binding
   orphans in localStorage** — and the spec that would catch it goes green-and-blind (§4).

---

## 9. COST — every promotion is cheap, and ONE file is the exception

| | attest | ART | contract | VRT after |
|---|---|---|---|---|
| `score` | ZERO | ZERO | ⚠ **moves** — 6 family lines + 6 docs entries | 2 added, 0 moved (1 existing card baseline is in the **blocking** strict lane) |
| `numpadPlus` | ZERO | ZERO | ⚠ +1 line | **3 added, 0 moved** — the exemption is discharged |
| `frogger` | ZERO | ZERO | unchanged unless `freeze` is a param | 2 added, **+1 if the exemption is discharged** |
| `modtris` | ZERO | ZERO | ⚠ moves either way (§10 item 1) | 2 added, 0 moved |
| `nibbles` | ⚠ **IN THE BASIS** — free for `face` ONLY | ZERO | unchanged, **and it must stay unchanged** | 2 added, 0 moved |
| `midiCvBuddy` / `midiOutBuddy` | ZERO | ZERO | unchanged | 2 each; **an exemption cited four times is discharged at its root** |
| `chromaconsole` | ZERO | ZERO | ⚠ depends on the precursor | 1 moved, 2 added |

⚠ **`nibbles.ts` hash-transparency was MEASURED IN BOTH DIRECTIONS**, per wave 4's correction
that the obvious reading of an attest measurement can be false: `face` and a def-level
`noUserControl` leave the digest unchanged; a **nested** `face:` moves it; a real code edit
moves it. Both controls fire, so the instrument is not blind either way.

> **A nibbles face PR that adds ONLY `face` costs ZERO GPU. Any other edit to that file costs
> a real-machine re-attest CI cannot run.**

That is why the nibbles spec refuses a `freeze` param, refuses to paint the score into the
framebuffer, and splits the range boy-scout into its own PR. **Merging them would convert a
free PR into one held hostage to an attest window** — wave 4 named that as the single most
avoidable cost in a face wave.

⚠ **Every face PR re-pins BOTH cost artifacts** — `e2e:timings:accept` AND
`vrt:strict:timings:accept`. An unmeasured `vrt-strict` scene rides the median and has
reddened `main` at 92 % of a shard budget with every test passing.

---

## 10. WHAT NEEDS AN OWNER DECISION

Rulings already given this round are recorded in the specs and are **not** repeated here (the
tab rail: ship untabbed on both; the keycap engraving: keep; chromaconsole's open-loop
sentence: delete, as a relocation). What remains open:

1. **`modtris.levelStep`: wire it or delete it?** `modtris-state.ts:129` says it is *"unused in
   v1 stepper"*, and `grep -n "params\." modtris-state.ts` returns exactly one consumer —
   `gravitySecondsPerDrop(params.gravityBpm)`. The def declares it, the card faders it,
   `contract-lock` pins it, and the Push card will rank it. **This is half of modtris' control
   surface.** Wiring it **changes how the module sounds** (the gate rate would ramp where it is
   flat today) and needs a preview; deleting it makes modtris a one-param module. Either way it
   is a contract change, and **the face cannot rank it honestly until this is answered.**

   ⚠ **AND THERE IS A LIVE DOCS DEFECT UNDERNEATH IT THAT IS TRUE WHICHEVER WAY THIS IS
   RULED.** `docs.controls.levelStep` promises *"gravity speeds up each level"* — on a module
   whose `ModtrisState` **has no `level` field at all.** So the documentation does not merely
   describe an unwired control; it describes a **concept the module does not have**. That is
   not contingent on the decision, it is wrong today, and it is on a module in `STRICT_DOCS`.
   ⚠ `module-docs-lint` reads the DEF, so it is structurally blind to a `docs` string that
   promises behaviour the implementation never had — the same blind spot `score` hit
   independently (`score/spec.md §2.1`), which makes it a class rather than a typo.
2. **Does "every video module gets a SCREEN ON/OFF toggle" extend to AUDIO-domain modules with
   a card-drawn canvas?** The specs propose the toggle for `frogger` and `modtris` but flag it
   as the owner's call — **a fleet rule is not an agent's to invent.**

   **The fact the decision turns on is a COST, and it is measured:** each of these boards
   repaints on **every rAF**, unconditionally, for as long as the surface is mounted — and a
   rack can hold several at once, plus `pong`. The video ruling's own justification is that OFF
   *reclaims the vertical space while the module KEEPS RENDERING*; for an audio game the
   equivalent question is whether a player who is not watching a board should still be paying
   for its repaint. **These three are the only audio-domain modules in the fleet where that
   question arises**, because they are the only ones whose primary surface is a continuously
   redrawn canvas.

   ⚠ **And the current gate is structurally blind to exactly these three.**
   `video-face-screen-source.test.ts` sweeps **video defs only**, so `frogger`, `modtris` and
   `pong` are outside its subject by construction — whichever way this is ruled, a rule that
   covers them needs a gate that can see them, and today none exists.
3. **Should `nibbles` paint the snake's length into its own framebuffer?** §2. Unlike frogger
   and modtris it has no in-canvas fallback, and adding one is a GPU-re-attest edit. Priced
   separately.
4. **`skifree`: fork the vendored bundle for a determinism hook?** The only route to a VRT
   baseline, and a maintain-a-fork decision. The producer bug-fix (§3) is independent and
   should proceed regardless.
5. **`chromaconsole`: a non-text marker for "the hardware quantizes this."** The face removes
   the only surface that carried it, and the module's own source names that surface as the
   honest signal for a property the param declaration is deliberately unable to carry. It is a
   control-vocabulary question for **every** device module. ⚠ Deliberately not solved in a
   module spec — a marker invented on a module PR becomes the fleet's vocabulary by accident of
   being first.
6. **The `DOCK_TAB_MIN_BANDS` threshold** — carried separately with the accumulated evidence
   (`score/spec.md §5.4.1`): score at 5 bands, numpadPlus at 4, ruttetra at 12 params, all
   three described by the control-heavy ruling and all three refused by the threshold. **Three
   near-misses in the same direction is a measurement, not three coincidences.** Moving it
   re-pins baselines, so it is a baseline decision and belongs to the owner.

---

## 11. BUILD ORDER

**`midiCvBuddy` first** — the cheapest face in the wave (≈ 6 h), it settles the shared
`fullViewBody` binder body that two siblings reuse, and it is where the VRT exemption decision
has to be taken **once for four modules** (three siblings cite its rationale verbatim by
reference). Nothing it touches can regress a saved patch, because no key moves.

**`frogger` second** — the cheapest game, and the only module in the wave that **discharges a
ratchet its own exemption names**: `EXEMPT_FROM_VRT` asks for *"a deterministic-time test hook
… so the scene can freeze the game at a known tick"*, and its PR builds exactly that. It also
has **zero RNG**, so the board is a pure function of tick count and there is nothing to seed —
the cheapest determinism seam in the program.

**`numpadPlus` third** — the least-blocked module the program has examined, and the one that
proves out the shared ladder end to end (a hero panel, a family template, a discharged
exemption) on an owner-requested module.

**`nibbles` fourth, as ONE PR that touches `nibbles.ts` with `face:` and NOTHING ELSE.**

**`midiOutBuddy` fifth** — it inherits the binder body and carries §6, the defect promotion
creates.

**`score` after #2183 merges.** That PR deletes three of the four e2e specs that reach score,
so its migration surface is materially smaller afterwards; doing it first would mean migrating
tests that are about to be deleted.

**`modtris` last of the promotions** — it is the one that needs decisions before it starts
(§10 item 1, and the `AUDIO_OPERABLE_FIXTURE` question in §4, which must be answered *before*
the promotion lands rather than after).

**`chromaconsole` when its precursor lands**, and land that precursor **alone** — it opens a
capability to the whole registry rather than to one module, which is the same argument that
put `matrixMix`'s one-field precursor in its own PR.

**`skifree` — do not attempt the face. Do the producer fix now, on its own merits.**
