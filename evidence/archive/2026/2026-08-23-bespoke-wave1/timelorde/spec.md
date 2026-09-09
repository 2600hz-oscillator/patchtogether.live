# FACEPLATE BUILD SPEC — `timelorde` (audio, the rack's singleton master clock)

> **SPEC + MOCKS. Nothing here is implemented.** Authored to the bar of
> `.myrobots/plans/face-redo-dx7.md` and `.myrobots/2026-08-22-quadralogical-face-mocks/spec.md`.
> Two sections those exemplars carry — the HERO READOUT STRIP and the SIDEBAR — are
> **historically shaped and are not reproduced**: both mechanisms were deleted fleet-wide
> on 2026-08-19 (#1957). What replaces them here is §10, the ARIA CONTRACT, because on
> this module the thing that used to be painted is *the one fact its thirteen jacks
> cannot report*.
>
> **Mocks:** `dock.html` · `dock-monitor.html` (open in a browser; self-contained).
>
> **Figure labels used throughout** — `DERIVED-BY-READING` (read the file; the claim
> follows from it) · `MEASURED` (a number from a committed artifact or a run recorded in
> the tree) · `MUST-VERIFY` (a claim the build has to prove before merge; listed again in §15).

**Verdict: PROMOTE — and the promotion is a NET GAIN at the lane and a REAL DEBT at the
dock that must be paid inside the same PR.** Today `timelorde` is un-migrated, so its lane
tile is a `ModuleShellPlaceholder`: the owl, the transport, the TAP button and the three
knobs are **all absent from the lane already**. A face is the first time any of it reaches
a lane tile. The debt is the other direction: promotion swaps `TimelordeCard.svelte` out of
the DOCK too, and five affordances live only there (§3). Every one has a route; one of them
(the transport readout) is deleted by ruling and its FINDING has to be relocated rather
than lost (§10).

---

## 0. THE CONSTRAINT MAP, READ FIRST

Four registries decide what a `timelorde` face is even allowed to be. All four were read,
not assumed.

| registry | member? | what it means here |
|---|---|---|
| `NON_SHELL_LANE_TYPES` (`legacy-fallback.ts:80-98`) | **NO** | the lane DOES swap. `laneRenderKind` returns `'placeholder'` today and `'shell'` after promotion. No carve-out protects the legacy card. |
| `CARD_PRODUCER_LANE_TYPES` (`dom-source-modules.ts:187-194`) | **YES** | *"the card composites its big display … and pushes it with `write(node,'displayFrame')`. Unpushed, `drawFrame` paints the #07090d idle field."* |
| `DOM_SOURCE_LANE_TYPES` (`:70-80`) | **NO** | it owns no `<video>`/`<img>`; nothing calls `attachExternalSource`. |
| `STRICT_FACES` (`strict-faces.ts`) | **NO** | un-migrated. Authoring the `face` IS the promotion. |

**The producer membership is the single most load-bearing fact on this page, and it is
already SOLVED — do not re-solve it.** `needsHeadlessSourceMount` (`dom-source-modules.ts:285-290`)
returns `true` for `kind === 'shell' || 'placeholder'` on any `CARD_PRODUCER` type, so
Canvas keeps `TimelordeCard` mounted in `<HeadlessSourceHost>` whether the module is faced
or not. `video_out` therefore keeps passing its picture downstream **after** promotion for
exactly the reason it does before it. MEASURED, recorded at `dom-source-modules.ts:126-130`:
never-mounted `nonBlack 0`, `maxLuma 8`, 1 distinct signature / 42 frames; card mounted,
`nonBlack 2944/3072`, `maxLuma 232`, 4 distinct signatures over 6 samples.

⚠ **What this does NOT mean.** The headless host is a LIFETIME fix, not a rendering one. It
keeps `video_out` alive; it paints nothing a player can see. The picture on the FACEPLATE is
a separate build (§7), and the two must not be confused — that confusion is what a green
`card-producer-lifetime.spec.ts` would certify.

### ⚠ THE LANE HAS NO PICTURE, AND THAT IS STRUCTURAL

`hasVideoSurface(def)` is `def.domain === 'video'` (`module-shell-model.ts:177-179`).
`timelorde` is `domain: 'audio'` with a `video` PORT, so it resolves `false` and the lane
tile paints **no `VideoTileThumb`**. And it cannot fall back to a trace glyph either:
`primaryAudioOutPortId` matches `o.type === 'audio'` (`shell-glyph-live.ts:95-97`) and
timelorde's fourteen outputs are thirteen `gate` and one `video` — **zero `audio`** — so
every glyph literal except `'none'` resolves `{kind:'static'}` and reddens the dead-glyph
clause. This is the `ninelives` shape (`strict-faces.ts:718-728`) without ninelives'
escape: ninelives could declare `'waveform'` because it has a `shape` 0..2 morph param;
timelorde has no param a glyph could be derived from.

**So the face declares `glyph: 'none'` and the lane tile is controls-only.** That is not a
regression — the placeholder has no picture either — but it must be stated, because a
reader who knows the owl will look for it in the lane and find nothing.

⚠ **The obvious fix is NOT available and must not be improvised.** `ShellExtension.glyph`
IS wired, but only inside `binding.kind === 'algorithm'` (`ModuleShell.svelte:1372-1391`
and the `algorithmCell` snippet at `:1773-1781`), and `glyphBinding`'s `'algorithm'` branch
requires an `algorithm` param (`shell-glyph-live.ts:131-133`). A bespoke lane glyph for
this module needs the widening that file's own comment already prescribes — *"do NOT add a
third glyph literal: widen THIS branch to carry a layout-source id"* (`:83-88`). **That is a
platform PR, not this one.** Recorded in §13.2.

---

## 1. WHAT THE MODULE IS FOR

**In one paragraph, and every rank below descends from it.** TIMELORDE is not a clock
module; it is **THE** clock — `maxInstances: 1`, `undeletable: true`, and a rack that opens
without one gets one dropped in (`timelorde.ts:96-101`, `timelorde-autospawn.ts`). Every
sequencer, every clip launch and every LIVECODE `clocked()` callback rides it. So the verb
a player performs here is not "set a tempo", it is **DECIDE WHETHER THE RACK IS MOVING** —
and, when it is not, **find out which of two indistinguishable reasons is why**. The
tempo-setting is the easy half; the module's whole design tension is that STOP and MUTE
are the same silence at every jack.

**The signal path, in execution order** (`packages/dsp/src/timelorde.ts`, driven from
`timelorde.ts:255-660`):

1. **Tempo resolution.** If a cable sits in `clock`, the worklet measures the period between
   rising edges and posts `{type:'measuredBpm', bpm}`; the factory writes that back into the
   `bpm` AudioParam **and** `livePatch.nodes[id].params.bpm`, clamped to `10..300`
   (`:349-356`). So an external lock **overwrites the knob** — the knob is not merely
   overridden, its stored value is replaced. `hasExternalClock` is reflected into a worklet
   AudioParam every 250 ms by an edge scan (`:306-318`); it is **not** a `ParamDef` and so
   never reaches face completeness.
2. **Transport.** `running` gates the phase accumulator. `start_in`/`stop_in` are Gain →
   Analyser taps at `fftSize = 16384` (~341 ms @ 48 kHz — widened from 2048 precisely so a
   80–150 ms canvas-drag stall cannot overwrite an edge, `:376-382`), drained on the
   scheduler clock through `transportEventsToRunState` (`:80-88`, stop wins a tie).
3. **Fanout.** Thirteen gate outputs, order pinned to the DSP's `OUT_*` indices
   (`:140-153`). `swing` shadows whichever train `swingSource` selects, holding its
   off-beats back by `swingAmount` as a fraction of **that train's own** interval — so the
   same degree value means the same feel at every division (`docs.controls.swingAmount`).
4. **Mute.** `muteOutputs` zeroes the gate WRITES only; the internal clock keeps turning so
   LIVECODE's subscribers stay alive (`:168-177`).
5. **The picture.** The CARD composites a 220×220 display — the owl painting with a
   colour-targeted beat boost, or the live `video_in` feed — and pushes it as an
   `ImageBitmap` via `handle.write('displayFrame', …)` each rAF (`TimelordeCard.svelte:367-389`).
   `drawFrame` blits the latest; with nothing pushed it paints `#07090d` (`timelorde.ts:449-471`).

**THE MEASUREMENT THIS MODULE IS BUILT AROUND.** `running = 0`, `muteOutputs = 1` and both
together are **byte-identical on all thirteen gate outputs** — zero rising edges, zero peak,
zero DC — while a running clock differs from all three. MEASURED on the real clock core, 4 s
at 120 bpm, pinned in `packages/dsp/src/lib/timelorde-clock-core.test.ts` ("STOP and MUTE are
indistinguishable AT THE JACKS") and quoted at `timelorde-transport-state.ts:7-14`. Four
param combinations, four genuinely distinct states, **one observable**.

**What is INERT AT SPAWN.** `swingAmount` at 0 makes `swing` an exact duplicate of its
source (documented as a feature — *"safe to patch permanently and dial the shuffle in
later"*). `swingSource` at 0 selects `1x`, which is what `swing` would shadow anyway. So on a
fresh spawn **two of six params do nothing**, and both are in the same idea. `running` is 1
and `muteOutputs` is 0, so the clock is live the instant it exists — unlike dx7, this module
makes its output with no source patched and no note played.

**What is ALWAYS live:** `bpm`, `running`, `muteOutputs`, `wizardOn`.

---

## 2. STOP 1 — is promoting this module a PARITY LOSS?

**No at the lane (strict gain), and no at the dock provided §7 is built.** The refusal bar
is #1974 / #2065 — *would the promoted face DROP something the player can do or see today*.
Run against this module:

- **#1974 (`joystick`) shape — does every lane tier resolve to zero controls?** No.
  Six ranked params, four of them plain knob/toggle cells. Even `mini` (cap 1 with a glyph,
  and this face has none, so cap 1) resolves `bpm`.
- **#2065 (`spectrograph`) shape — is the headline feature a picture the shell cannot
  paint?** ⚠ **Partly YES, and this is the one real hazard.** The owl display is exactly the
  spectrograph shape: an AUDIO-domain module whose picture the shell has no engine surface
  for. **The difference is the ESCAPE**: spectrograph's face would have been *one GAIN knob
  and a static glyph*, whereas timelorde has a `fullViewBody` route that already ships on
  three adopters and six ranked params underneath it. So the picture is **built**, not
  refused — §7.

---

## 3. STOP 2 — does every way of getting DATA IN survive?

```sh
grep -nE '<button|<select|<input|oncontextmenu|manualTrigger|Toggle|Selector|accept=|addEventListener' \
  packages/web/src/lib/ui/modules/TimelordeCard.svelte
# 500: window.addEventListener('keydown', onKey)   ← the SPACEBAR tap
# 546: RUN     602: WIZARD TOGGLE
# 553: MUTE    559: TAP
```

The complete inventory, read line by line. **Nothing in this table may be lost.**

| # | affordance | site | after promotion |
|---|---|---|---|
| 1 | `bpm` knob (log 10..300) | `:629` | **YES** — rank 1 param cell |
| 2 | `swingAmount` knob (0..90°) | `:630` | **YES** — rank 4 param cell |
| 3 | `swingSource` knob (0..11 discrete) | `:631` | **YES, AND UPGRADED** — §5.2 promotes the roster; the anonymous 12-position dial becomes a named selector |
| 4 | RUN button (`running`) | `:546` | **YES** — `looksLikeToggle` derives a `<Toggle>` (`shell-control-kind.ts:316`) |
| 5 | ⚠ RUN button **HIDES ITSELF** when `start_in`/`stop_in` are patched | `:545` | **LOST — deliberately, and it is a GAIN.** See below. |
| 6 | MUTE button (`muteOutputs`) | `:553` | **YES** — same toggle derivation |
| 7 | TAP TEMPO button | `:559-567` | **YES** — `ShellActionCell`, probe REQUIRED (§8) |
| 8 | TAP disabled while `hasExternalClock` | `:562` | ⚠ **CONDITIONALITY LOST** — see below |
| 9 | SPACEBAR → tap, scoped to the SELECTED node | `:488-502` | **YES, unchanged** — it is a `window` listener keyed on `selected`, not a card control. ⚠ It is registered by `TimelordeCard`, and the headless host keeps that card mounted (§0), so it keeps working — but for a reason that has nothing to do with the face. MUST-VERIFY §15.4. |
| 10 | WIZARD toggle (`wizardOn`) — an owl thumbnail button | `:602-608` | **YES** — toggle cell; the THUMBNAIL is decoration and moves into the body (§7) |
| 11 | 220×220 big display: owl **or** live `video_in` monitor | `:612-621` | **YES via `fullViewBody`** (§7). ⚠ dock-only. |
| 12 | TRANSPORT readout strip (four named states) | `:576-583` | **DELETED BY RULING — and it is the highest-value thing on the card.** §10. |
| 13 | footer `120 BPM (internal) · src=1x` | `:634-636` | **DELETED BY RULING.** Its three facts are relocated in §10. |
| 14 | `PatchPanel` jacks | `:627` | **YES** — the shell paints its own patch panel |

**Row 5, and why losing it is right.** The card hides RUN when the transport is slaved so
the button cannot fight the external MIDICLOCK. The card's own comment records the cost:
*"the RUN button HIDES itself whenever start_in/stop_in are patched … which is exactly the
MIDICLOCK case where a hardware stop is the likely cause and the card said nothing at all"*
(`:100-103`). A faceplate has no conditional-cell mechanism, so the control is always
present — **and that removes the trap rather than reproducing it.** A visible RUN toggle
under an external transport is honest: pressing it writes `running`, and the next
`start_in` edge writes it back. The behaviour was always idempotent (`:78-79`).

**Row 8 is a genuine debit.** `disabled={hasExternalClock}` is a live, edge-derived
condition; a `ShellActionCell` has no `disabled` predicate. The face therefore paints an
always-enabled TAP that is a **no-op** while an external clock is patched (`tap()`'s own
first line, `:470`). The behaviour is unchanged; the AFFORDANCE-SIGNAL is lost. ⚠ It is
recoverable in the accessible name and nowhere else — §10 puts `— disabled, external clock
owns the tempo` in the action cell's `aria-label`. Taste call §14.3.

---

## 4. THE RANK — `face.order`

`order` is PRIORITY (what a shrinking tier keeps). `pages` is FUNCTION order. They
**disagree deliberately** and the face comment must say so.

| # | key | why it earns this rank — an argument that would be WRONG for a different module | what it costs below |
|---|---|---|---|
| 1 | `bpm` | On most modules rank 1 is the thing you *ride*; here it is the thing the whole rack is *derived from*. Thirteen outputs and every sequencer in the patch are a function of this one number, and it is the only continuous control on the module. Nothing else can be rank 1. | anchors every tier |
| 2 | `running` | **The lane budget's most contested cell, and it wins on the module's own measurement.** A stopped rack is silent at every jack and blames nothing; this is the control that un-silences it. It ranks above MUTE because STOP is the strictly worse state — un-muting a stopped rack does not start it (`timelorde-transport-state.ts:86-90`). ⚠ Wrong for any non-singleton: on a per-voice module a transport toggle is setup, not performance. | evicts `swingAmount` from the compact tier |
| 3 | `muteOutputs` | The other half of the pair, and the two are only legible together. Ranking them adjacently is the entire point: a player who can see both can distinguish the states the JACKS cannot (§10). | — |
| 4 | `swingAmount` | The only other continuous control, and the only one that changes how the rack FEELS rather than whether it runs. Inert at its 0 default, which is why it is below the transport pair and not above them. | — |
| 5 | `swingSource` | Setup, not performance: chosen once when you decide which division to shuffle. After §5.2 it is a named selector, so it is legible at the dock and pointless at a 46 px lane column. | — |
| 6 | `wizardOn` | ⚠ **Ranked LAST on purpose, and its rank is the argument for the whole §7 body.** It governs a picture that only exists on the DOCK. A `wizardOn` cell at a lane tier is a switch for something the lane cannot show — the definition of a cell that does nothing where it is painted. | — |
| — | `timelorde-tap-{n}` | `ShellActionCell`. ⚠ **Ranked 7 — dock-only — and that is a REAL loss argued in §14.2.** A rank ≤6 would put a press-pad in the lane, which is right for a performance control; it is refused here only because the six params above it are each defensible and TAP has a working keyboard route (row 9) that the params do not. | — |

**THE TIER LADDER, read back as a sentence.** With `glyph: 'none'` the caps are mini 1 /
compact 3 / plate 6 (`curated-face.ts:62-79` — the glyph-less column). So: **at mini you get
BPM; at compact, BPM + RUN + MUTE; at plate, all six params; at the dock, everything plus the
display and the TAP pad.** ⚠ **MUST-VERIFY §15.1** — derive this through `curatedFace`,
never from the cap constants. Three sibling faces (`ruttetra`, `monoglitch`, `reshaper`) each
had to make that correction independently, and `quadralogical` shipped the wrong ladder in a
spec that read plausibly.

**THE LOSERS, NAMED.** `swingAmount` lost the compact tier to `muteOutputs` because at its
shipped default it does nothing at all, and a lane cell that is inert on a fresh spawn is
worse than absent. `swingSource` lost to `swingAmount` because a selector at a 46 px lane
column degrades to an anonymous knob (`paramCellKind` returns `'knob'` at every non-dock
tier, `shell-control-kind.ts:313`) — which is the exact control §5.2 exists to abolish.
`wizardOn` lost to everything because the thing it switches is not on the surface it would
be painted on.

---

## 5. VOCABULARY CHANGES — two, and one of them is a live defect

### 5.1 `running` and `muteOutputs` get `options` rosters

Both are `0..1 discrete`. `looksLikeToggle` already derives a `<Toggle>`, so this is **not**
about selectability — it is about the ONE kind of resting text the ruling still permits.

> *Permitted resting text, exhaustively: the module NAME, TAB/SECTION labels, CONTROL
> CAPTIONS, and **option/landmark NAMES that disambiguate a control's own position**.*

So a roster is the mechanism that lets the plate print `STOPPED` instead of nothing, without
being a derived readout — because the text is the control's **own** state name, not a
derivation over two params.

```ts
{ id: 'running', label: 'Run', min: 0, max: 1, curve: 'discrete',
  options: [ { value: 0, label: 'STOPPED' }, { value: 1, label: 'RUNNING' } ] },
{ id: 'muteOutputs', label: 'Mute', min: 0, max: 1, curve: 'discrete',
  options: [ { value: 0, label: 'GATES LIVE' }, { value: 1, label: 'MUTED' } ] },
```

⚠ **`options` outranks `looksLikeToggle` in `paramCellKind` (`:288-291`, `:312-316`)**, so
declaring a roster turns each into a two-cell `segmented` control at the dock instead of a
switch. That is the intent — *"a two-state param that DECLARED names for its states wants
those names painted on two captioned buttons, not an anonymous switch"* — and at every LANE
tier it stays a knob with a persistent state-name readout, which is exactly the affordance
the legacy button's `class:playing` colour carried. MUST-VERIFY §15.2.

⚠ **The words are chosen so the pair reads as a state and not as a command.** `STOPPED` and
`MUTED` are the states `timelorde-transport-state.ts` already names; a roster reading
`STOP`/`START` would be a verb on a latching control, which is the momentary/latching
confusion `module-face-lint` classifies separately.

### 5.2 `swingSource` is a 12-state discrete param with NO roster — and the names exist

`timelorde.ts:167` is `{ id: 'swingSource', min: 0, max: 11, curve: 'discrete' }` with **no
`options`**. The twelve names exist and are already rendered by the card — but from a
CARD-LOCAL literal:

```
TimelordeCard.svelte:511
const SRC_LABELS = ['1x','8x','4x','2x','1/2','1/3','1/4','1/8','1/12','1/16','1/32','1/64'];
```

This is the `sampleHold` / `moog904b` shape verbatim. A faceplate over today's def paints an
anonymous twelve-position dial printing `5`, on a module whose docs spell the mapping out
(`docs.controls.swingSource`). **Promote the roster onto the def, export it, and import it in
the card** — the one-source rule applied to a list.

⚠ **The list is not free-standing: it is the OUTPUT ORDER.** `SRC_LABELS` is `OUT_LABELS`
(`:510`) minus `swing`, and `OUT_LABELS` is the def's `outputs` array minus `video_out`
(`:141-153`), in the order the DSP's `OUT_*` indices pin (`:140`). **Derive the roster from
`timelordeDef.outputs`, do not re-type it** — a hand-typed twelfth entry is a
population count in disguise, and the def's own comment says the order MUST match the DSP.

```ts
// derived, not typed: the gate outputs in DSP index order, minus `swing` itself.
export const TIMELORDE_SWING_SOURCES = timelordeDef.outputs
  .filter((o) => o.type === 'gate' && o.id !== 'swing')
  .map((o, i) => ({ value: i, label: o.id }));
```

12 entries > `SEGMENTED_MAX_OPTIONS = 6`, so `paramCellKind` derives `'selector'` — a
portaled list showing the same twelve names the card shows. TOTAL by construction against
`min`/`max` (`param-vocabulary`'s own requirement).

**No other vocabulary change.** No range, curve, `format`, `units` or landmark edit. `bpm`'s
`curve: 'log'` is correct for 10..300 and its `units: 'bpm'` already prints.

---

## 6. BAND STRUCTURE — three bands, no tab rail

```ts
pages: [
  // 1 — TRANSPORT. The two params that decide whether the RACK MOVES, adjacent,
  //     because they are only legible as a pair: STOP and MUTE are byte-identical
  //     at all thirteen jacks (timelorde-clock-core.test.ts) and the ONLY thing
  //     that separates them is seeing both switches at once. This band is the
  //     module's answer to "why is my whole rack silent".
  //     ⚠ `timelorde-tap-{n}` is homed here and NOT promoted out: TAP sets the
  //     tempo, so it reads as a TEMPO control — but it is a PRESS, and the one
  //     thing a press belongs beside is the other things you press.
  { id: 'transport', label: 'transport', controls: ['running', 'muteOutputs', 'timelorde-tap-{n}'] },

  // 2 — TEMPO. One continuous control and the thing it is measured in.
  { id: 'tempo', label: 'tempo', controls: ['bpm'] },

  // 3 — SWING. Depth and which train it shadows: one idea, two halves, and the
  //     second is meaningless without the first.
  { id: 'swing', label: 'swing', controls: ['swingAmount', 'swingSource'] },
],
```

**THREE bands, so NO TAB RAIL** (`DOCK_TAB_MIN_BANDS = 7`, `dock-tabs-model.ts:56`). That is
correct and not a shortfall: this module has six params in three genuinely different ideas,
and `face.tabbed` is owner-instruction only. **Do not pad pages to reach seven.**

⚠ **`wizardOn` is NOT in any page — it lives in the BODY.** See §7; it is declared through
the body's own switch, and its param cell is suppressed the way a `'body'`-surfaced control
is. **MUST-VERIFY §15.3**, because `module-face-lint`'s completeness loops every `ParamDef`
with no filter and no skip list: a param with no cell is RED. If the body-suppression
mechanism the quadralogical spec proposes (`face.xyPads[].surface`) has not generalised to
plain params by build time, **`wizardOn` goes in band 1 as an ordinary toggle and the body's
switch writes the same param** — two surfaces, one param, which is what the card already
does with the gate input and the button (`timelorde.ts:187-193`).

**PACKING.** Bands 2 and 3 are all knob-column cells, so `bandIsPackable` lets them share a
row; band 1 carries a `selector`-shaped segmented pair plus an action, so it is likely SOLO
(`cellWidthClass` is deny-by-default ⇒ `'wide'`, `dock-row-plan.ts:115`, `:156`). Expect
**two rows**. MUST-VERIFY §15.5 — this is a `dock-row-plan` unit assertion, not a guess.

**REAR CARD.** `face.rear` is a projection of `pages`, so re-derive it. The five inputs are
`clock`, `start_in`, `stop_in`, `gate`, `video_in`; **none of them is a `_cv` stem of a
ranked param**, so no rear section is derived from a page — the whole input rail is
uncurated. ⚠ **That is an asymmetry worth declaring rather than fixing**: `start_in`/`stop_in`
target the same state as `running`, and `gate` targets `wizardOn`, but the port ids do not
follow the `<param>_cv` convention so nothing joins them. Author a `face.rear.groups` entry
naming `transport` (`start_in`, `stop_in`) and `clock` (`clock`) so the rail says what the
front says. The OUTPUT rail has a derived default and **must be left alone**: thirteen `gate`
jacks and one `video` jack split by cable domain is already the right answer, and
`rearSectionColumns` widens the gate section on its own.

---

## 7. THE BODY — `face.extension: 'timelorde'`, and the SCREEN switch

### 7.1 Why a body and not a panel cell

The ladder in `module-faceplates.md` says reach for the earlier rung first. A PF-14 `panel`
cell would work mechanically — the display is *a picture you edit* only in the loosest sense
— but it fails on two counts the body does not: a panel's first legal rank is 7, and the
display is the module's **identity**, so it belongs above the bands rather than inside one;
and the SCREEN switch has to live somewhere, and the switch is a property of the surface,
not of a cell.

```ts
// $lib/ui/modules/timelorde/shell-extension.ts
import TimelordeDisplayBody from './TimelordeDisplayBody.svelte';
export default { fullViewBody: TimelordeDisplayBody } satisfies ShellExtension;
```

`ModuleShell.svelte:1439-1457` renders the body at the head of the faceplate, above the
bands. It is **dock-only** by `dockFullViewHeadPlan` (`:585`), which is the constraint that
makes §0's "the lane has no picture" true and §4's `wizardOn` rank correct.

### 7.2 The zone map

```
┌─ dock full view ──────────────────────────────────────────────────────┐
│ TIMELORDE                                                     [ ✕ ]   │  dock title bar
├───────────────────────────────────────────────────────────────────────┤
│                                                                       │
│   ┌───────────────── fullViewBody ─────────────────┐                  │
│   │                                                 │                  │
│   │        ┌───────────────────────┐                │                  │
│   │        │                       │                │  220 x 220       │
│   │        │   OWL   /   MONITOR   │                │  canvas          │
│   │        │                       │  [owl chip]    │                  │
│   │        │                       │  [SCREEN ON]   │  ← OVERLAY, in   │
│   │        └───────────────────────┘                │    the picture's │
│   │                                                 │    own box       │
│   └─────────────────────────────────────────────────┘                  │
│                                                                       │
├─ transport ───────────────────────────────────────────────────────────┤
│  [ STOPPED | RUNNING ]   [ GATES LIVE | MUTED ]   ( TAP )             │
├─ tempo ──────────────────┬─ swing ─────────────────────────────────────┤
│      (BPM)               │   (Swing)      [ src: 1x  ▾ ]              │
└──────────────────────────┴─────────────────────────────────────────────┘
```

**WIDTH.** The body is 220 px of canvas; the widest band is `transport` at two segmented
pairs plus an action pad. **Nothing here earns 900 px** and nothing should be padded to it.
The owner's standing ruling — *"we do not want useless gray horizontal space on cards, ever.
prefer compact"* — makes this plate one of the narrower ones in the fleet, which is the
correct outcome. The live picture IS a declared width earner; it just does not want much.
MUST-VERIFY §15.6 against `workflow-shell-faces.spec.ts`'s content-vs-plate measurement,
which **cannot be run locally without a baseline** — treat the first `vrt:commit` as a
MEASUREMENT, not a formality (the quadralogical lesson: a row flow that passed every local
gate measured 1260 CSS px against a 1220 px pane).

### 7.3 THE SCREEN SWITCH — required by spirit, invisible to the gate

Owner ruling 2026-08-18: every video module's card gets a SCREEN ON/OFF toggle; the state
lives on `node.data` (never component `$state`) and persists across tab switches; the module
KEEPS RENDERING while OFF.

⚠ **`video-face-screen-source.test.ts` CANNOT SEE THIS MODULE.** Its sweep is
`listVideoModuleDefs()` (`:105`, `:123`) and timelorde is in the AUDIO registry. So the
switch is required by the ruling's reason and **not** by any gate. Build it anyway, and
record the blind spot: a faced audio-domain module that paints a live picture in a
`fullViewBody` is a population of one today, and the honest close is to widen that gate's
sweep to *"every faced def whose `fullViewBody` mounts a canvas"* — which the
`face-rack-status-source` roster already enumerates mechanically (`extensionsWithBody()`,
`:104-116`). Recorded in §13.3; **not built here**, because widening a gate that would then
red four existing modules is not a face PR.

**Placement is settled and is a MEASUREMENT, not a taste:** OVERLAY the picture's
bottom-right corner on a translucent backplate (`rgba(5,6,8,0.72)`), NEVER a row of its own.
The stacked row cost spirographs ~18.8 px against ~11 px of slack and overhung the card by
7.8 CSS px. Keep a small `min-height` on the wrap so an absolutely-positioned button does not
escape the plate with the canvas gone.

⚠ **AND ON THIS MODULE SCREEN-OFF HAS A SHARPER OBLIGATION THAN ON A GENERATOR.** The card's
rAF is the **sole writer** of `displayFrame`. If SCREEN OFF stops the rAF, `drawFrame` falls
back to the `#07090d` idle field (`timelorde.ts:467-470`) and **`video_out` goes dark for
everything downstream** — a preview switch acting as a producer kill switch, the #1720/#1721
class. So: **OFF unmounts the VISIBLE canvas and the rAF keeps compositing into the push
scratch.** The card is already structured for this — `renderDisplay` paints the owl into the
canvas *even in the wizard-off case* precisely so `video_out` stays coherent (`:357-362`) —
so the correct implementation is the one already there, not a new one.

⚠ **The wizard toggle and the SCREEN toggle are DIFFERENT CONTROLS and must not be merged.**
`wizardOn` is a graph param that syncs to rack-mates and is drivable by the `gate` input;
`previewCollapsed` is local view furniture on `node.data`. Merging them would make a
collaborator's preview collapse when you hid your owl.

---

## 8. CONTROL INVENTORY — every primitive decision, argued

| face key | primitive | derivation | why not the alternative |
|---|---|---|---|
| `bpm` | **knob** | `paramCellKind` default (`:317`) | Not a `'fader'`: a fader is *a LEVEL the player expects to see as a THROW* (`shell-control-kind.ts:63`). Tempo is not a level, and `curve: 'log'` over 10..300 has no meaningful throw. |
| `bpm` | ⚠ **NOT a `warped-fader`** | — | The `warped-fader` cell (`shell-cells.ts`, `ShellWarpedFaderCell`, landed 2026-08-23 on `face/samsloop-2026-08-23`) is for *any param whose CARD converts at the boundary*. **Timelorde's card does not convert**: `TimelordeCard.svelte:629` passes `min={10} max={300} curve="log"` — the def's own numbers, in the def's own space. The knob and the ParamDef agree, so there is no warp to declare. Checked because the shape (`log` curve, a landmark-worthy 120) invites the mistake. |
| `bpm` | landmarks: **NO** | — | ⚠ Considered and REFUSED. `ParamLandmark` is for *continuous waypoints* the player navigates to. 120 is a default, not a waypoint, and the def already restores it on double-click via `defaultValue`. Declaring `{120, 'default'}` would paint a name for a position the knob already has a gesture for. |
| `running` · `muteOutputs` | **segmented** (dock) / **knob + state readout** (lane) | `options` roster, §5.1 | Not a bare `toggle`: a toggle paints no state NAME, and the state name is the one text this ruling permits and this module most needs. |
| `swingAmount` | **knob** | default | Not a fader for the same reason as `bpm`; `units: 'deg'` already prints in `aria-valuetext`. |
| `swingSource` | **selector** (dock) | `options.length 12 > SEGMENTED_MAX_OPTIONS 6` (`:314`) | Not `segmented` — twelve captioned buttons is a wall. Not a bare knob — that is the defect §5.2 fixes. |
| `wizardOn` | **toggle**, painted by the BODY | `looksLikeToggle` | ⚠ See §6's fallback: if the body cannot claim the param, it is a plain band toggle and the body's switch writes the same key. |
| `timelorde-tap-{n}` | **`ShellActionCell`, `mode: 'trigger'`** | `shell-cells.ts` | `mode: 'trigger'` requires `onFire` (`:161-165`); `shell-cells.test.ts` fails the mismatch. Not `face.momentary`: momentary is for a 0/1 press-PARAM that returns to rest, and TAP is not a param at all — it is a call into `TapTempo`. |

### The TAP probe — and why the obvious one is vacuous

`ShellActionCell.probe` is **required** (`shell-cells.ts:157`). Until 2026-08-02 the parity
sweep clicked an action and asserted nothing, and **sixstrum shipped a face over an
instrument that could not be sounded**.

⚠ **`{ kind: 'audition' }` IS THE WRONG PROBE HERE, and it would pass on a dead button.**
An audition probe asks the ledger whether a callable resolved off the engine handle. TAP
does not call the engine: it calls `tapController.tap(now)` and, **only from the second tap
onward**, writes `bpm` through `setNodeParam` (`TimelordeCard.svelte:468-475`). A single
click therefore delivers nothing, by design.

**The probe must be a `param` probe on `bpm`, and it must press TWICE.**

```ts
'timelorde-tap-{n}': {
  kind: 'action', label: 'tap', mode: 'trigger',
  onFire: /* the module's own TapTempo instance */,
  // TWO presses. `TapTempo` locks on the SECOND tap (2-tap lock, median of
  // recent intervals, ~2 s timeout reset — $lib/electra/tap-tempo.ts). A
  // one-press probe reads `bpm` unchanged and cannot distinguish "the
  // controller is warming up" from "this button is dead".
  probe: { presses: 2, effect: { kind: 'param', paramId: 'bpm', expect: 'changed' } },
}
```

⚠ **MUST-VERIFY §15.7: does `ShellActionCell.probe` support a multi-press form?** If it does
not, this is a **platform gap that must be reported to the orchestrator, not worked around**
— a single-press probe on this control is the sixstrum defect with a green tick, and the
alternative (probing a revision counter) is explicitly refused by `shell-cells.ts:225-240`
(*"a revision-only probe passes on a dead button that bumps the counter"*).

⚠ **And the probe has a real hazard the spec must name: TIMING.** Two presses `n` ms apart
lock a BPM of `60000/n`, clamped to `10..300`. A parity sweep that presses as fast as the
harness allows produces a value the clamp pins at 300, and a sweep that stalls between
presses produces 10 — **both of which are "changed", so the probe is honest either way**, but
the SECOND is the one to watch: if the harness's inter-press gap ever exceeds `TapTempo`'s
~2 s timeout the series RESETS and the probe reads unchanged. That is a wall-clock dependency
in a gate, on CI, which is the shape this repo has been burned by. **Bound it: the probe's
two presses must be issued without an intervening `await` on anything renderer-dependent.**

---

## 9. THE STATE MATRIX

Every combination a reviewer has to be able to check a mock against. **Four transport states
× two picture sources × two screen states**, collapsed to what is actually distinguishable.

| # | `running` | `muteOutputs` | `video_in` | SCREEN | body paints | bands paint | `video_out` emits |
|---|---|---|---|---|---|---|---|
| 1 | 1 | 0 | — | ON | owl, **eyes+border pulsing at `bpm`** | `RUNNING` · `GATES LIVE` | the pulsing owl |
| 2 | 0 | 0 | — | ON | owl, **steady** (`beatPulse` returns 0 when not running) | `STOPPED` · `GATES LIVE` | the steady owl |
| 3 | 1 | 1 | — | ON | owl, **pulsing** ⚠ the picture is identical to #1 | `RUNNING` · `MUTED` | the pulsing owl |
| 4 | 0 | 1 | — | ON | owl, steady ⚠ identical to #2 | `STOPPED` · `MUTED` | the steady owl |
| 5 | 1 | 0 | patched | ON | **the live feed**; the owl steps aside | unchanged | the feed, passed through |
| 6 | any | any | any | **OFF** | nothing — the canvas is unmounted | unchanged | ⚠ **still the same picture** — the rAF keeps compositing (§7.3) |
| 7 | any | any | — | ON, `wizardOn = 0` | the `wizard off` placeholder | unchanged | ⚠ still the owl — the card paints it into the push canvas regardless (`:357-362`) |

⚠ **Rows 1/3 and 2/4 are the whole point of this module and the picture cannot tell them
apart.** The beat pulse is a function of `bpm` and `running` only (`beatPulse`,
`timelorde-wizard.ts`), so MUTE is invisible on the display. **The only surface that
separates all four is the two option rosters of §5.1, side by side in band 1.** That is the
argument for their adjacency in §6 and for their ranks 2 and 3 in §4, stated as a table so a
reviewer can falsify it.

⚠ **Rows 6 and 7 are the two places a naive implementation goes dark.** Both are already
correct in the card; both are easy to "simplify" away during a body rewrite. They are
permanent legs of the face model test (§16).

---

## 10. THE ARIA CONTRACT — where the deleted text went, and what a FINDING lost

Two resting readouts are deleted by the 2026-08-19 ruling. Per the standing rule, **say which
finding lost its surface** rather than letting the coverage quietly lapse.

### 10.1 The TRANSPORT STRIP (`:576-583`) — the highest-value deletion in this wave

**What it was.** A one-line, fixed-height, `white-space: nowrap` strip printing one of four
derived states (`RUNNING · gates live` / `STOPPED · phase frozen` / `MUTED · clock turning` /
`STOPPED + MUTED · frozen`), colour-coded, ALWAYS rendered — including while the transport
is slaved and the RUN button has hidden itself.

**What is lost.** The *combined* state. `running` and `muteOutputs` each publish their own
state name after §5.1, but the strip published something neither can: **which of the two is
the reason your rack is silent, in one glance, plus the half a jack cannot report at all
("phase frozen" vs "clock turning underneath")**. That is a genuine two-input derivation with
a live negative control (`bpm` must not move it — pinned in
`timelorde-transport-state.test.ts` and again in
`e2e/tests/timelorde-transport-state.spec.ts:118-137`).

**Where it goes.** `aria-valuetext` on **both** rosters, carrying the COMBINED state:

| control | `aria-valuetext` (running=0, muted=1) |
|---|---|
| `control-running` | `STOPPED — the phase accumulator is frozen; un-muting will not restart the rack` |
| `control-muteOutputs` | `MUTED — and the transport is also STOPPED, so un-muting alone will not start it` |

Both strings come from `timelordeTransportState(node.params).detail` — the **same pure
function** the card renders and the engine handle publishes as `read('transportState')`, so
the two surfaces still cannot drift. ⚠ **Do not re-derive the words in the face model.**

⚠ **AND THE COVERAGE THAT ACTUALLY LAPSES, NAMED.** `timelorde-transport-state.spec.ts`
spawns at `/rack?shell=legacy` (`:75`), so it renders the LEGACY CARD and is **unaffected by
promotion** — the strip it asserts on still exists where it looks. That is convenient and it
is also the trap: **the spec will stay green while the faceplate has no equivalent
assertion at all.** A green legacy spec is not evidence about the face. The face needs its
own leg — a `timelorde-face-model.test.ts` asserting the four `aria-valuetext` strings and
carrying the same `bpm` negative control, plus one browser leg reading `aria-valuetext` off
`control-running` on the dock faceplate.

### 10.2 The FOOTER (`:634-636`) — three facts, three different answers

`{measured or knob} BPM ({external|internal}) · src={SRC_LABELS[swingSource]}`

| fact | verdict |
|---|---|
| the BPM number | **relocated** to `aria-valuetext` on `control-bpm`. It is a plain param readback and the knob's own `units: 'bpm'` already carries it. |
| `(external)` / `(internal)` | **relocated, and it is the only genuinely derived half.** It is a function of `patch.edges` — whether a cable sits in `clock` — which no param can see. It joins the same `aria-valuetext`: `128 bpm — locked to the external clock` vs `120 bpm — internal`. ⚠ **This is also the signal that TAP is a no-op (§3 row 8)**, so the two deletions are relocated to the same string on purpose. |
| `src=1x` | **not relocated — it becomes the CONTROL's own text.** After §5.2 the selector prints `1x` as its option NAME, which is permitted resting text. The footer was restating a control that could not name itself. |

⚠ **`aria-valuetext` cannot read `patch.edges` from a param resolver.** The external-lock half
must be produced by the cell that renders `bpm`, from the same edge scan the card runs
(`TimelordeCard.svelte:420-427`). **MUST-VERIFY §15.8** — if the shell's param cell has no
seam for a module-supplied accessible-value function, the honest fallback is to leave
`aria-valuetext` as the plain readback and record that the external-lock signal has **no
surface on the faceplate**, rather than to fake it.

### 10.3 The rest of the contract

| element | contract |
|---|---|
| the display canvas | `role="img"`, `aria-label="TIMELORDE display — the owl painting, pulsing at 120 bpm"` / `"— live video monitor"`. ⚠ NOT `aria-valuetext`: it is not a range role. |
| the SCREEN button | `aria-pressed={!previewCollapsed}`, caption `SCREEN ON` / `SCREEN OFF`, `title` saying the module keeps rendering either way (copied verbatim from `FourPlexVidOutputBody.svelte` — a second spelling of `previewCollapsed` is how the key forks). |
| the WIZARD toggle | `aria-pressed={wizardOn}`, accessible name `wizard`. ⚠ Keep the accessible name when the caption is hidden — the primitives take `hideCaption` precisely so a caller cannot do it by dropping `label`. |
| TAP | `aria-label="tap tempo"`, extended to `"tap tempo — inactive, the external clock owns the tempo"` while `hasExternalClock` (§3 row 8). |
| every param cell | `data-testid="control-<paramId>"`. ⚠ `faces-parity` asserts **exact multiset equality** between the dock's `control-*` testids and the def's param ids, and it scans the whole `dockShell` **including the extension body** — so a `wizardOn` switch in the body must carry `data-control-params="wizardOn"` **and** the shell's own `data-cell-*` wrapper. The quadralogical build found that gap the hard way: without the wrapper the control rendered, worked, satisfied the multiset, and **was never draggable**. |

⚠ **Keyboard.** Owner ruling: **no keyboard-a11y work**. Tab IS the flip gesture; do not file
or fix keyboard-navigation issues. The Spacebar tap (§3 row 9) is a *product* binding that
predates the face and is untouched.

---

## 11. DETERMINISM AND VRT

**Two new scenes** — `face-timelorde-compact`, `face-timelorde-dock` — added by hand to the
`FACES` roster in `e2e/vrt/_shell-faces.ts` with the **post-hero-split** band count (3; there
is no hero, so no band empties). Nothing ties that roster to `STRICT_FACES`, so a promoted
module missing from it silently has no scene.

**Is the dock scene baselinable? YES — and the mechanism already ships, on the CARD.**

`TimelordeCard.svelte:148-165` and `:391-401`: under `prefers-reduced-motion: reduce` — which
the VRT runner sets, alongside `animations: 'disabled'` — the card **does not run either rAF
loop**, pins `pulse = 0`, and paints exactly ONE deterministic frame (the steady owl, no
colour boost; `drawOwl` returns before `applyBeatBoost` when `pulseNow <= 0`, `:332`). The
CSS transform is belt-and-braces-disabled in the same media query (`:818-820`).

**So the body must reuse that exact mechanism, not re-implement it.** If the body's rAF is
written fresh and forgets the reduced-motion branch, the dock scene becomes non-deterministic
and the face lands in `FACES_WITHOUT_SCENES` for a reason that was avoidable.

⚠ **`freezeIsNotASeam` DOES NOT APPLY — timelorde declares NO `freeze` param.** The field is
REQUIRED when a def declares `freeze` and **forbidden when it does not** (`_shell-faces.ts`
`UnbaselinableFace`). Declaring one here would red the gate in the second direction. And
`freezeFaceVideo` — which freezes a video face by writing `params.freeze = 1` — is
structurally inapplicable: there is no such param and the picture is not produced by the
video engine.

⚠ **`FACES_WITHOUT_SCENES` is likewise NOT the route.** Its bar is *evidence that `simPin`
and `freeze` cannot reach this renderer*. Here a third mechanism reaches it and already
ships. Reaching for the exemption would be the acidwarp argument made by a module that does
not qualify for it.

**The one honest hazard: the OWL IS AN ASSET.** `OWL_SRC = '/img/timelorde-owl.png'` is
loaded through an `Image()` whose `onload` sets `owlReady`, and the deterministic single
frame is repainted when it resolves (`:394-395` tracks `owlReady` for exactly this). A capture
taken before the decode lands paints the bare `#07090d` ground and the baseline is a black
square that passes forever. **MUST-VERIFY §15.9: the dock capture must wait on a
frame-counted settle after `owlReady`, never a wall-clock budget** — `waitFrames`, never
`waitForTimeout` (`e2e/_helpers/frames.ts` is the ONE export site, and `page.waitForTimeout`
under `e2e/` is denied by default).

**MUST NOT MOVE — treat a diff as a finding, not a re-pin:**

- `vrt.spec.ts/timelorde.png` — the LEGACY card scene. It renders `TimelordeCard.svelte`,
  which this PR does not touch. ⚠ timelorde is **not** in `STRICT_VRT_MODULES` today: it was
  demoted pending a linux baseline (`vrt-exemptions.ts:1234-1243`) and rides the
  informational lane. **That is a pre-existing debt this PR should NOT silently inherit** —
  if the linux baseline has landed by build time, re-promote it in the same PR and say so;
  if it has not, say that too. A face PR that leaves a "temporarily demoted" note untouched
  for a third wave is how a temporary state becomes permanent.
- `rear-timelorde` — `face.rear` gains two INPUT groups (§6), so this one **does** move.
  Predict it and count the files the capture bot commits against the prediction.

**CI wall-time.** `faces-parity` budgets roughly `10 s + 0.8 s/cell` on CI. Six params + one
action cell = **7 cells ⇒ ≈ 15.6 s**, plus two VRT scenes. Comfortably under the ~2 min
sign-off threshold.

---

## 12. COST

| item | cost |
|---|---|
| **WebGL attest** | **NIL — VERIFIED, not assumed.** `flox activate -- bash scripts/webgl-attest-hash.sh --list` returns 218 files; **`timelorde.ts`, `TimelordeCard.svelte` and every `timelorde-*.ts` are absent**. The basis is `packages/web/src/lib/video/**`, WebGL-context-creating cards under `lib/ui/modules`, plus `AUDIO_WEBGL_MODULE_DEFS = [cube, wavesculpt]` (`webgl-attest-lib.ts:67-70`, `resolveWebglBasis` `:256-300`). `TimelordeCard.svelte` uses a 2D context only, so the mechanical card sweep does not pick it up. **The `fullViewBody` must stay 2D** — a WebGL display would pull this module into the basis and put a GPU attest on every future face edit. |
| **contract-lock** | **A REAL DIFF, and it is the one to read.** Two `options` rosters (§5.1) + one derived roster (§5.2) + one `ShellActionCell` family entry. `face` itself is fully contract-transparent (`FACE_FIELDS_IN_LOCK` is empty) — but **`controlFamilies` is NOT**, so the TAP family adds a lock line. Run `task docs:accept` and read the diff: **the only lines that may move are `running`/`muteOutputs`/`swingSource` options and the `timelorde` family**. Anything else is a finding. |
| **docs** | `timelorde` is in `STRICT_DOCS` (`strict-docs.ts:248`). The new `controlFamilies` entry needs a `docs.controls` blurb for `timelorde-tap-{n}` or completeness reddens. The three existing option-bearing params already have prose and it is already true. |
| **ART** | **NIL — confirmed.** No `art/scenarios/timelorde`, no `art/baselines/timelorde`. The clock core is unit-tested in `packages/dsp/src/lib/timelorde-clock-core.test.ts`. ⚠ Nothing in this PR touches DSP. |
| **Push 2** | timelorde has **no `PUSH_CARD_CONTROLS` override**, so authoring a face moves it GENERIC → FACE tier and **the whole card changes**. The face tier takes the first 8 *turnable* params of `face.order`; there are six, so all six land, in the §4 order. Accept the golden diff deliberately with the reason in the test. ⚠ And pin it: this is the rack's singleton clock, so its Push card genuinely matters — give it an explicit `PUSH_CARD_CONTROLS` entry so a later re-rank cannot drift it. |
| **New code** | one `shell-extension.ts`, one `TimelordeDisplayBody.svelte` (reusing the card's own render functions — **import them, do not re-implement**), one `SHELL_CELLS` entry, one `STRICT_FACES` line, one `FACES` roster row, one `timelorde-face-model.test.ts`. |
| **Conflict surface** | `strict-faces.ts` · `shell-cells.ts` · `_shell-faces.ts` · `push-card-config.ts` + its golden · `contract-lock.txt` (GENERATED — on conflict take main and re-run the accept task, never hand-merge). |

---

## 13. DEFECT LEDGER

Recorded here and **reported to the orchestrator for routing**. None is fixed in the spec PR.

**13.1 — `swingSource` is UNNAMEABLE on any faceplate.** `timelorde.ts:167` declares a
12-state discrete param with no `options`; the twelve names exist only as a card-local array
(`TimelordeCard.svelte:511`) that duplicates the def's own output order. Today the defect is
invisible because no faceplate renders the param; the moment one does, the control prints a
bare integer for a state that has a name the module already knows. **Severity: fold into the
face PR (§5.2).** Class: the `sampleHold` / `moog904b` shape.

**13.2 — an AUDIO module with a picture has no LANE surface, and the widening is prescribed
but unbuilt.** `hasVideoSurface` is `domain === 'video'`; `ShellExtension.glyph` renders only
under `binding.kind === 'algorithm'`. So `timelorde`, `scope`, `rasterize`, `wavesculpt` and
`synesthesia` — every `CARD_PRODUCER` that is not a video def — can have a picture in the
dock and none in the lane. `shell-glyph-live.ts:83-88` already names the fix (*"widen THIS
branch to carry a layout-source id"*). **Severity: platform PR, not a face PR.** Report.

**13.3 — the SCREEN-switch gate cannot see an audio-domain body.**
`video-face-screen-source.test.ts` sweeps `listVideoModuleDefs()` only, so the 2026-08-18
ruling is unenforced for exactly the modules §13.2 describes. The mechanically-derived
population already exists (`face-rack-status-source.test.ts`'s `extensionsWithBody()`).
**Severity: gate widening; would red existing modules, so it needs its own PR.** Report.

**13.4 — the transport-state e2e is legacy-pinned and will go GREEN-AND-BLIND.**
`timelorde-transport-state.spec.ts` spawns `?shell=legacy`, so after promotion it asserts a
strip on a surface the player no longer reaches by default while the faceplate has no
equivalent assertion. This is the *precondition-is-the-defect* class from CLAUDE.md, in its
milder form: not a gate that certifies the bug, but a gate whose green is evidence about the
wrong surface. **Severity: fold into the face PR** — add the face-side leg (§10.1); do not
delete the legacy one, which still covers a reachable surface.

**13.5 — an external clock lock OVERWRITES the stored `bpm`.** `timelorde.ts:349-356` writes
the measured tempo into `livePatch.nodes[id].params.bpm`. Patch a MIDICLOCK at 137, unpatch
it, and the knob is at 137 — the user's hand-set tempo is gone with no undo marker. The
factory's own comment argues this is intentional (*"the last followed tempo is the most
sensible value to hold"*) and it is defensible; it is recorded because **it is invisible on
every surface**, and after §10.2 the `(external)` marker that was the only hint lives in an
`aria-valuetext` the sighted player never reads. **Severity: owner question, not an
agent decision.** Report.

No DSP defects found. The transport helper, the four-state derivation, the edge-detector
sizing and the v1→v2 `isPlaying` migration all read as internally consistent.

---

## 14. TASTE CALLS, EACH WITH ITS ONE-LINE REVERT

1. **`running` and `muteOutputs` get option rosters (§5.1)**, which turns two switches into
   two segmented pairs. Revert: drop the `options` and they are bare toggles — and the
   consequence must be stated plainly: **the plate then prints no transport state anywhere**,
   and the module's central distinction survives only in `aria-valuetext`.
2. **TAP ranks 7 (dock-only).** Revert: rank it 5 and demote `swingSource`. Consequence: a
   press-pad in the lane, and the swing division becomes an anonymous lane knob again. ⚠
   Recorded as a genuine argument, not a formality — TAP is a performance gesture and the
   Spacebar route only works when the node is SELECTED.
3. **TAP is always enabled and silently inert under an external clock (§3 row 8).** Revert:
   none available today — `ShellActionCell` has no `disabled` predicate. The alternative is a
   platform field, which is not this PR.
4. **`wizardOn` ranks last and is painted by the body (§4, §6).** Revert: rank it 4 and put it
   in a band; the body's switch then writes a param that also has its own cell, which is two
   surfaces for one param — the card's existing button/gate convergence, so it is not novel.
5. **Three bands rather than two (`tempo` and `swing` kept separate).** Revert: merge them
   into one `tempo · swing` band. Consequence: the module loses the statement that swing is a
   different idea from tempo, which the docs make at length.

---

## 15. MUST-VERIFY — claims this spec makes that the build must prove

1. **The tier ladder** — derive `mini` / `compact` / `plate` through `curatedFace`, never
   from `LANE_PLATE_MAX_CELLS`. Three sibling faces got this wrong from the constants.
2. **`options` → `segmented` at dock, `knob` + state readout at lane** for a 2-entry roster,
   and that the lane readout paints the option NAME (`paintsReadout`) rather than a number.
3. **`wizardOn` in the body satisfies `module-face-lint` completeness** — every `ParamDef`
   must render exactly one interactive cell, and the loop has no filter and no skip list. If
   the body cannot claim it, take §6's fallback.
4. **The Spacebar tap still works with the card headless-hosted.** The listener is registered
   by `TimelordeCard` and keyed on the `selected` NodeProp — which is a *lane* selection.
   ⚠ A headless-hosted card is not in the lane, so `selected` may be permanently false and
   the binding may already be dead TODAY, before any face exists. **Measure it on `main`
   first**; if it is dead, that is a pre-existing defect for the ledger, not a promotion cost.
5. **Row packing** — assert the band count and row plan in `dock-row-plan`, do not eyeball it.
6. **Plate width ≤ pane width** — `workflow-shell-faces.spec.ts`'s content-vs-plate leg. It
   cannot run locally without a baseline; the first `vrt:commit` IS the measurement.
7. **`ShellActionCell.probe` supports two presses.** If not → report the platform gap; do not
   ship a one-press probe or a revision probe.
8. **`aria-valuetext` on `control-bpm` can carry a patch-derived fact.** If the shell has no
   module-supplied accessible-value seam → record that the external-lock signal has no
   faceplate surface. Do not fake it.
9. **The dock capture waits on `owlReady` via a frame count**, not a wall-clock budget, and
   three consecutive captures are pixel-identical.
10. **`video_out` is alive with SCREEN OFF** — a downstream probe reading `nonBlack > 0` on
    `TIMELORDE.video_out → VIDEO OUT`, with the negative control being the pre-fix shape
    (`nonBlack 0/3072, maxLuma 8`) recorded in `dom-source-modules.ts:126-130`.

---

## 16. VERIFICATION GATE

```sh
# 1. the pure model + this face's PERMANENT negative controls (§9 rows 6/7, §10.1's bpm leg)
REPEAT=3 flox activate -- task test:one -- timelorde-face-model
# 2. the transport derivation is untouched — it now has TWO consumers
flox activate -- task test:one -- timelorde-transport-state
# 3. face lint: completeness (incl. wizardOn), hero-less plan, paramCells, rear
flox activate -- task test:one -- module-face-lint
flox activate -- task test:one -- dock-row-plan
flox activate -- task test:one -- dock-faceplate-model
flox activate -- task test:one -- curated-face
flox activate -- task test:one -- shell-cells            # the TAP probe's shape
flox activate -- task test:one -- shell-extensions       # declared id <-> discovered module
flox activate -- task test:one -- module-shell-import-guard
# 4. the rulings' source gates
flox activate -- task test:one -- face-resting-text-source
flox activate -- task test:one -- face-readout-source
flox activate -- task test:one -- face-width-source
flox activate -- task test:one -- face-rack-status-source   # the fullViewBody ROSTER entry
# 5. vocabulary, rear, push, docs
flox activate -- task test:one -- param-vocabulary        # both rosters TOTAL over min..max
flox activate -- task test:one -- rear-card-model
flox activate -- task test:one -- push-card-schema
flox activate -- task test:one -- module-docs-lint
# 6. the contract diff must contain ONLY the three rosters + the tap family
flox activate -- task docs:accept && flox activate -- git diff
# 7. e2e
flox activate -- task e2e:serve
REPEAT=3 flox activate -- task e2e:one -- tests/faces-parity.spec.ts
REPEAT=3 flox activate -- task e2e:one -- tests/timelorde-video.spec.ts
REPEAT=3 flox activate -- task e2e:one -- tests/timelorde-tap-tempo.spec.ts
REPEAT=3 flox activate -- task e2e:one -- tests/timelorde-transport-state.spec.ts  # legacy, must stay green
REPEAT=3 flox activate -- task e2e:one -- tests/card-producer-lifetime.spec.ts     # video_out survives the swap
flox activate -- task e2e:stop
# 8. typecheck LAST — svelte-check is stricter than vitest
flox activate -- task typecheck
# 9. VRT: dispatch only. NEVER commit a PNG.
flox activate -- task vrt:commit
# 10. attest: NIL for this module — nothing to run, and nothing to report.
```

**The negative controls, spelled out so a builder cannot ship a green stub:** `bpm`
10 → 300 must leave both `aria-valuetext` transport strings unchanged; `muteOutputs` 0 → 1 at
`running = 0` must move `control-running`'s `aria-valuetext` from the STOPPED string to the
STOPPED+MUTED string (a readout that were secretly `paramId: 'running'` would not move);
SCREEN OFF must leave a downstream `video_out` probe's `nonBlack` count unchanged; and
`wizardOn` 1 → 0 must leave it unchanged too.

## 17. BUILD-COST ESTIMATE

| phase | estimate |
|---|---|
| def edits (rosters, `face`, `controlFamilies`, `docs.controls`) | ~1.5 h |
| `shell-extension.ts` + `TimelordeDisplayBody.svelte` (importing the card's own render fns) | ~3 h — the SCREEN switch and the reduced-motion branch are the whole risk |
| `SHELL_CELLS` TAP entry + probe (blocked on MUST-VERIFY §15.7) | ~1 h, or **escalate** |
| `timelorde-face-model.test.ts` with §16's negative controls | ~2 h |
| roster/registry edits + `docs:accept` + push golden | ~1 h |
| gate loop, 3× flake checks, typecheck | ~2 h |
| VRT dispatch + baseline review + rear re-capture | ~1 h wall, mostly waiting |
| **total** | **≈ 11 h, plus one platform escalation** |

**Risk rank: MEDIUM.** The body is real work and the TAP probe may be blocked, but every
mechanism it needs already ships on another module, and the producer seam — the thing that
would have been hardest — was solved before this spec existed.
