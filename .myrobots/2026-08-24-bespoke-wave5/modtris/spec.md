# FACEPLATE BUILD SPEC — `modtris` (audio, a gate-steered falling-block game)

> **SPEC + MOCKS. Nothing here is implemented.** Group analysis: [`../GAMES.md`](../GAMES.md).
> Direct precedent: `.myrobots/2026-08-23-bespoke-wave1/pong/spec.md` — cited where it
> transfers, and the divergences are named. Sibling: [`../frogger/spec.md`](../frogger/spec.md),
> the same topology with one control and no RNG.
>
> **Mock:** `dock.html` (self-contained, open in a browser).
>
> ⚠ **DOOM is excluded from this spec by name**, per the standing owner ruling. It is a game
> module and would fall inside every sweep here; nothing in this document applies to it and no
> file of its was opened.

**Verdict: PROMOTE — but this PR carries a PRECURSOR DECISION that is not optional, and half of
this module's control surface does nothing.**

Two faders and a well. The face is small. What is not small is that

1. **`modtris` is the LAST MEMBER of the derived `AUDIO_OPERABLE_FIXTURE` pool** — MEASURED,
   pool size **1** — so promoting it turns `workflow-shell.spec.ts`'s *"the verbatim legacy card
   is OPERABLE in the dock full view"* leg into a **named SKIP**. Not red. Green, with a loud
   message, and the coverage ends (§0.1, GAMES.md §6). **That must be answered before the
   promotion lands, in the PR body.**
2. **`levelStep` — one of the module's two controls — is read by nothing.** Its own type
   declaration says so: *"unused in v1 stepper but reserved for future scoring"* (§13.1). The
   def declares it, the card faders it, `contract-lock` pins it, the Push card will rank it, and
   the docs promise a difficulty ramp that does not exist.

---

## 0. THE CONSTRAINT MAP, READ FIRST

| registry | member? | what it means here |
|---|---|---|
| `NON_SHELL_LANE_TYPES` | **NO** | the lane swaps. `laneRenderKind` returns **`'placeholder'`** today. |
| `CARD_PRODUCER_LANE_TYPES` | **NO — and CORRECTLY so** | `ModtrisCard.svelte` matches neither producer seam: it *reads* `eng.read(node,'snapshot')` and paints. Nothing engine-visible depends on the card. ⚠ Contrast `skifree` (GAMES.md §5). |
| `HEADLESS_MOUNT_LANE_TYPES` | **NO** | so the card is simply NOT MOUNTED under the shell. |
| `EXEMPT_FROM_VRT` (`vrt-exemptions.ts:756`) | **YES** | *"animated game state defeats deterministic capture; unit + ART + E2E provide coverage"* — ⚠ **unlike frogger's and skifree's, this entry states NO exit condition**, so it is not dischargeable by its own terms even though the seam is buildable. |
| `ALLOWED_PERMANENT_EXEMPT` (`:1176`) | **YES** | anchored in both directions; the two lists move in ONE commit or not at all. |
| `STRICT_FACES` | **NO** | un-migrated. |
| `STRICT_DOCS` (`strict-docs.ts:304`) | **YES** | any param add/remove needs its `docs.controls` entry to match or completeness reddens. §13.1 makes this live. |
| `PUSH_CARD_CONTROLS` | **NO** | GENERIC tier; two params, so both get encoders. A face moves it to the FACE tier and re-ranks by `face.order`. ⚠ §13.1 may REMOVE one of them. |
| `RANGE_BOUND_CARDS` | **NO** | so the card's SIX re-typed range literals are unchecked (§13.3). |
| `ART_EXCLUDED` (`profile-coverage.ts:40`) | **YES** | ⚠ **but `art/scenarios/modtris/gate-pulses.test.ts` EXISTS** — an ART scenario with no audio profile. §12 and §13.4. |
| `_face-fixtures.ts` `AUDIO_OPERABLE_FIXTURE` | ⚠ **THE PICK, and the ONLY member. Pool size 1.** | §0.1 — the precursor |
| `_face-fixtures.ts` `AUDIO_PLACEHOLDER_FIXTURE` | pool member, index 12 of 26 | not the pick; 25 members of slack, promotion invisible to it |
| `workflow-shell.spec.ts:365-378` | ⚠ **a REPAIRED precondition-class instance, ON modtris** | §0.2 |
| `face-migration-inventory.ts:907-910` | **`bespoke-surface`, NO BLOCKERS** | *"a GAME: a falling-block viewport played on the keyboard, with two faders beside it."* ⚠ **the `why` is FACTUALLY WRONG** — `ModtrisCard.svelte` has no keyboard handler. GAMES.md §8.6. |
| WebGL attest basis | **NO — VERIFIED** | no modtris file in the attest basis; the card is `getContext('2d')`. **Editing modtris is attest-transparent.** |

### 0.1 ⚠ THE PRECURSOR: PROMOTING `modtris` SILENTLY RETIRES A TEST

**MEASURED** by evaluating the derivation rather than reading its comment:

```
AUDIO_OPERABLE — picked: modtris | pool size 1
```

`AUDIO_OPERABLE_FIXTURE` is a DERIVED pool: un-promoted `domain=audio` modules that render a
placeholder tile, have a determinate `uniformDomainClass`, and mount a `<NeonFader>`. Its
consumer is the one leg in `workflow-shell.spec.ts` that DRIVES a control rather than looking at
a tile — *"the verbatim legacy card, OPERABLE, in the dock full view"*.

When the pool empties, `deriveFixture` returns `kind: 'migration-complete'` with a long, honest
diagnosis. `fixtureProblems()` **deliberately does not count that as a problem** (*"it is the
designed end state, and the consuming spec skips on it by name"*), and the spec pairs it with
`test.skip(F.kind === 'migration-complete', F.why)`.

> **So the suite goes GREEN and the leg stops running.** Skips are not passes.

⚠ **This is the DERIVED version of a failure the same file already survived once.** Its header
records that `VIDEO_FIXTURE`'s predecessor was a hand-picked four-deep list, that *"the cohort in
flight spent all four"*, and that it was self-HEALING but never self-REFILLING. Deriving the pool
removed the obligation for video — and the audio OPERABLE pool has narrowed from **4 at the
#2137 split to 1 today** with nobody measuring it, because a shrinking derived pool emits no
signal until it empties.

**What this PR must do, per CLAUDE.md's rule (fix the SUBJECT, never the threshold), stated in
the PR body:**

1. **Widen the predicate to what the leg actually needs.** The leg drives `.fader-wrap .track`,
   so `mountsAFader` refuses every knob-drawing card by name — `moog902` is named in the file as
   the measured reason it exists. If a `<Knob>`-driving variant of the same leg is a small
   change, that is the honest repair and it re-fills the pool from the 26-strong placeholder
   population. ⚠ **Do NOT widen it merely to keep a pool non-empty** — that is a threshold fix
   wearing a subject fix's clothes.
2. Or **retire the leg together with the design it covered**, explicitly.
3. Or **provide a purpose-built fixture module that is deliberately never promoted**, which
   `deriveFixture`'s own `migration-complete` text names as the alternative.

**A modtris face PR that does not mention `AUDIO_OPERABLE_FIXTURE` has quietly ended a test.**

### 0.2 ⚠ AND `workflow-shell.spec.ts` ALREADY CARRIES A REPAIRED PRECONDITION BUG ON THIS MODULE

`workflow-shell.spec.ts:365-378` records it: the derivation offered `modtris`, *"whose card is a
game board with its two faders far below the fold"*, and the leg failed with an empty param map —
the card had mounted correctly and both sliders were in the accessibility tree, but the drag
landed outside the dock's clipped viewport. The fix was `scrollIntoViewIfNeeded` **in the LEG**,
with the reason written down: *"denying the module would have hidden a fragility that the next
tall card hits again."*

That is the right instinct applied correctly, and it is a reason to take §0.1 seriously rather
than to shrug: the leg has already been strengthened once because of this module, and promoting
it is what stops the strengthened leg from running.

### 0.3 THE FACT THAT DEFINES THIS FACE — the same one as frogger's

`drawModtris` (`modtris.ts:278-355`) is a pure exported function; the CARD calls it every rAF
(`ModtrisCard.svelte:54`) reading `eng.read(node,'snapshot')`. The game runs engine-side on the
scheduler at **40 Hz** (`modtris.ts:203`). So under the shipping shell the lane tile is a
`ModuleShellPlaceholder` — no well, no NEXT preview, no faders — while pieces drop, lines clear
and `line_cleared` fires. **Every modtris e2e drives `?shell=legacy`** (`modtris.spec.ts:57`, and
the `rack` fixture is `?shell=legacy` by construction). §13.5.

### 0.4 AND THE LANE STILL WILL NOT HAVE A WELL

GAMES.md §2.2 / §3: `hasVideoSurface` is `domain === 'video'`; modtris is audio. Both outputs are
`gate`, so `primaryAudioOutPortId` is null and every glyph literal but `'none'` is a dead static.
`ShellExtension.glyph` carries no `nodeId`, so every instance would draw the same picture. **The
face declares `glyph: 'none'` and the lane tile is two faders and no picture.** modtris is the
seventh module on that seam.

---

## 1. WHAT THE MODULE IS FOR

**In one paragraph.** MODTRIS is **a gate-driven ACCUMULATOR whose output rate is a function of
how well the patch is playing.** Its siblings derive rhythm from a bouncing ball (`pong`) or from
a grid of moving traffic (`frogger`); modtris derives it from a **stack that remembers**. Nothing
else in the rack has that property: the well accumulates every previous decision, so the same
input pattern produces a different output rate ten seconds later. The verb a player performs is
**FEED THE WELL** — you patch a sequencer into MOVE and ROTATE and a clock into DROP, and the
`line_cleared` output fires when the geometry you built happens to complete a row. And when four
complete at once, `pulseGateNTimes` emits **four distinct staggered edges**, which is the single
most musically interesting thing in the group and no surface shows it.

**The chain, in execution order** (`modtris.ts:119-203` + `modtris-state.ts`):

1. **The clock.** `getSchedulerClock().subscribe(tick)` (`:203`). `SCHEDULER_TICK_MS = 25` ⇒
   **40 Hz**; `dtSeconds` is computed once (`:178`) and never measures elapsed time.
   ⚠⚠ **That clock is a Web Worker `setInterval` with no AudioContext check**
   (`scheduler-clock.ts:78`, `:101-118`). GAMES.md §4.1. **An audio suspend cannot freeze this
   game**, which is why §11 needs a module-side seam.
2. **Gate in.** Five `AnalyserNode` taps (`fftSize = 32`, `smoothingTimeConstant = 0`), tail
   sample only, through `detectRisingEdge`. Analyser taps, not AudioParams — no cv-scale fast
   path, the same shape `cv-scale-registry.test.ts` records for pong's paddles.
3. **The step.** `stepModtrisState`: input edges → gravity → lock → `clearLines` → 7-bag refill.
4. **Gate out.** Two `ConstantSourceNode`s; `pulseGateNTimes` with `GATE_PULSE_S = 0.005`,
   `GATE_SPACER_S = 0.005`, `SCHEDULE_CUSHION_S = 0.005`.
5. **The picture.** The card's rAF reads the snapshot and calls `drawModtris`.

**What each control genuinely changes.**

| param | read at | effect | hazard |
|---|---|---|---|
| `gravityBpm` (30..240 **log**, default 60) | `modtris-state.ts:407`, **inside `stepModtrisState`, EVERY STEP** | `gravitySecondsPerDrop = 60 / max(1, bpm)` — seconds between automatic drops | ⚠ none, and this is the module's one genuinely live control: it acts on the very next step, which is the argument for rank 1 |
| `levelStep` (1..20 linear, default 10) | ⚠ **NOWHERE** | **none** | ⚠⚠ **§13.1. `grep -n "params\." modtris-state.ts` returns exactly one consumer, `gravitySecondsPerDrop(params.gravityBpm)`. `ModtrisState` has `lines` but NO `level` field, so there is not even a thing for it to threshold.** |

**Hidden constants no surface shows:** `COLS = 10` / `ROWS = 20`, the 7-bag Fisher-Yates refill,
`PIECE_COLOR_INDEX`, the three gate timing constants, and the `wellWidthPx = w * 0.7` split that
reserves 30 % of the canvas for the NEXT strip (`modtris.ts:295`).

---

## 2. STOP 1 — is promoting this module a PARITY LOSS?

**No.** The #2065 (`spectrograph`) comparison is the same one frogger's §2 makes, re-checked
against modtris:

1. **The alternative is not the card — it is a BLANK TILE** (§0.3).
2. **`fullViewBody` gives the well a real home at the dock**, and it is WIRED. `rasterize` is the
   precedent that matters: an AUDIO-domain module with a JS-painted picture in a `fullViewBody`
   plus a `simPin`.
3. **Two ranked params, so no tier resolves to zero controls** — the #1974 `joystick` bar is
   cleared. ⚠ **And §13.1 is the reason to check that claim rather than assert it**: if
   `levelStep` is DELETED rather than wired, modtris becomes a ONE-param module and the bar is
   cleared by one control, exactly like frogger. Still a promote, but the sentence changes and
   the spec must not pretend otherwise.

⚠ **What is honestly WORSE than the card:** the dock well is reachable only by EXPANDING (§0.4).
Same as today, so not a regression, but not the fix either.

---

## 3. STOP 2 — does every way of getting DATA IN survive?

```sh
grep -nE '<button|<select|<input|oncontextmenu|manualTrigger|Toggle|Selector|accept=' \
  packages/web/src/lib/ui/modules/ModtrisCard.svelte
```
**Zero hits.**

| # | affordance | site | after promotion |
|---|---|---|---|
| 1 | `<ModuleTitle {id} {data} defaultLabel="MODTRIS">` — rename + control-colour dot | `:74` | **YES** — the shell's own title bar |
| 2 | `<PatchPanel>` — all seven jacks, drill-down, unpatch menu, card flip | `:76-91` | **YES** |
| 3 | DROP `<NeonFader>` | `:88` | **YES** — rank 1, `paramCells: { gravityBpm: 'fader' }` |
| 4 | LVL `<NeonFader>` | `:89` | ⚠ **YES structurally, and §13.1 asks whether it should exist at all** |
| 5 | per-fader right-click → MIDI learn / Send to Control Surface / Send to Electra ▸ Row ▸ knob / clear automation | `NeonFader.svelte` | **YES** — the shell renders the same `<NeonFader>` |
| 6 | per-fader drag / dbl-click-to-default / wheel / `role="slider"` keys | same | **YES** |
| 7 | the 200×260 well canvas + the NEXT-piece preview + `LN` count | `:78-85` | **YES via `fullViewBody`** (§7). ⚠ dock-only |
| 8 | `data-viz-passthrough` (`:83`) | — | ⚠ **NOTHING IS LOST, because it does nothing today.** GAMES.md §8.1 (#1755) |
| 9 | `data-testid="modtris-canvas"` | `:84` | **carry it onto the body's canvas verbatim** — `modtris.spec.ts` reads it |

**No `node.data` state, no button, no dropdown, no file input, no keyboard handling.** STOP 2 is
satisfied by **two fader cells and one body.**

### 3.1 Where state lives — `params` vs `node.data`

**100 % `params`, ZERO `node.data`.** `grep -c "mutateNode\|node.data" ModtrisCard.svelte` → 0.
So modtris does not touch the generic face path, and it contributes a clean row to the
`.data`-discipline census (`mutate.guard.test.ts`'s regex anchors on the literal token `.params`
and is structurally blind to `.data` writes — modtris has none). Combined with frogger and
skifree, **three clean rows**; `nibbles` is the one module in this group with a `.data` question,
and only because this face gives it one (`nibbles/spec.md` §3.1).

---

## 4. THE RANK — `face.order`

| # | key | why it earns this rank — an argument that would be WRONG for a different module | what it costs below |
|---|---|---|---|
| 1 | `gravityBpm` | **It is the module's TEMPO, and on a module whose outputs are gates that is rank 1 by definition** — everything downstream of `line_cleared` is clocked by how fast the stack fills. ⚠ **AND it is the only param read EVERY STEP** (`modtris-state.ts:407`), so it is the only one whose effect is visible on the next frame. On pong, "tempo" and "acts now" were split between two params and the spec had to choose; here they are the SAME param, which makes this the least contestable rank in the wave. | evicts `levelStep` from mini |
| 2 | `levelStep` | ⚠ **Ranked 2 only because it is DECLARED, and the honest note is that it is ranked 2 out of 2.** It is not a runner-up on merit — it does nothing (§13.1). **If §13.1 is resolved by WIRING it**, this rank is right: a difficulty ramp changes the rate over time and rate is what a rack cares about. **If §13.1 is resolved by DELETING it**, this row disappears and modtris becomes a one-param face. **The rank is not defensible until that decision is made**, and stating that is more useful than defending a rank for a dead control. | — |
| — | `freeze` | **NOT RANKED — `noUserControl`, `writer: 'internal'`.** New in this PR; §11. |

**THE TIER LADDER, read back as a sentence.** With `glyph: 'none'` the caps are the glyph-less
column: **at mini you get DROP; at compact, DROP and LVL; at plate, both; at the dock, both plus
the well.** ⚠ If §13.1 deletes `levelStep`, it collapses to frogger's sentence. **MUST-VERIFY
§15.1** — derive it through `curatedFace`, never from the cap constants.

**THE LOSER, NAMED.** `levelStep` lost mini to `gravityBpm` because a threshold that changes
difficulty *over the next several minutes* is not a control a 46 px lane column can serve — and
because, today, it changes nothing at all.

---

## 5. VOCABULARY — one new param, no roster, and one param whose FATE is a decision

**5.1 `freeze` — a new `0..1 discrete` param, `noUserControl`, `writer: 'internal'`.**
Required by §11 and nothing else, spelled exactly as every video def spells it.

```ts
{ id: 'freeze', label: 'Freeze', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
// …
noUserControl: [
  { param: 'freeze', writer: 'internal',
    why: 'a VRT determinism hook — at >= 0.5 the scheduler tick returns before stepping the '
       + 'game, so the well, the falling piece and the NEXT queue hold and the body repaints '
       + 'one frame. Required because the game clock is a Web Worker setInterval independent '
       + 'of the AudioContext, so suspending audio cannot stop it.' },
],
```

⚠ Without the declaration `freeze` is a third turnable param, and the Push card would offer
*"stop the game"* under an encoder — the exact defect `lushgarden` has today. With it,
`module-face-lint`'s render-plan parity asserts it renders **exactly zero cells**, an INVERTED
assertion that is falsifiable in both directions.

**5.2 NO rosters, NO landmarks, NO `units`.** Considered:
- `options` on `levelStep`: it is `1..20 discrete`-ish in spirit but declared `linear`, and 20
  states exceeds `SEGMENTED_MAX_OPTIONS = 6` so it would derive a `'selector'` — a dropdown of
  twenty numbers for a threshold. Refused; and refused twice over while the param is dead.
- `units: 'bpm'` on `gravityBpm`: ⚠ refused for the sharp reason. A `format` makes the readout
  PAINT (`paintsReadout` survives only for an option/landmark NAME with no `format`), which
  re-introduces a resting decimal under the control by the back door — mechanism five. The BPM
  goes in `aria-valuetext` (§10).
- `landmarks` on `gravityBpm` at 60 (one drop per second, the tuned baseline): the strongest
  landmark candidate in this group. **Refused** because `defaultValue`'s double-click already
  restores it and a landmark is a NAME for a position the dial already has.

**5.3 ⚠ `levelStep`'s FATE IS A CONTRACT DECISION AND IT BELONGS IN THIS PR.** §13.1 argues both
resolutions. Whichever is chosen changes `contract-lock.txt`, `docs.controls`, the Push golden
and `face.order` — so it cannot be deferred past the face, and the face cannot rank it honestly
until it is made.

---

## 6. BAND STRUCTURE — one band, and that is the honest answer

```ts
pages: [
  // ONE band. Both params answer the same question — HOW HARD IS THIS GAME —
  // and splitting them would invent a distinction the module does not have.
  // A page is a different IDEA; two faders that both set difficulty are one.
  //
  // ⚠ `order` and `pages` AGREE, which is unusual for this house style and is
  // stated so a reader does not go hunting for the disagreement.
  { id: 'fall', label: 'fall', controls: ['gravityBpm', 'levelStep'] },
],
```

**ONE band, so no tab rail** (`DOCK_TAB_MIN_BANDS = 7`); `face.tabbed` is owner-instruction-only
and is not reached for.

⚠ **Two `'fader'` cells in one band: is the band packable?** `cellWidthClass`
(`dock-row-plan.ts:115`) is **deny-by-default ⇒ `'wide'` for anything it cannot resolve**, and a
fader is not a knob column. With one band the packing question is moot, but it decides the
plate's WIDTH. **MUST-VERIFY §15.2.**

**REAR CARD.** Re-derive it: all five inputs are `gate` with **no `paramTarget`** — the module's
real signal inputs, not CV holes — so the rail would be uncurated. ⚠ **Author a
`face.rear.groups` entry:**

```ts
rear: { groups: [
  { id: 'steer',  ports: ['move_l', 'move_r'] },
  { id: 'rotate', ports: ['rotate_l', 'rotate_r'] },
  { id: 'drop',   ports: ['drop_fast'] },
] },
```

so the rail says what the module is: two moves, two rotations and a drop. ⚠ A section's WIDTH is
derived from its row count (`rearSectionColumns`), so these are 2/2/1 columns — check the
layout rather than assuming, MUST-VERIFY §15.3. The output rail takes the derived default (both
`gate`, one section).

---

## 7. THE BODY — `face.extension: 'modtris'`

### 7.1 Why a body and not a panel

A PF-14 `panel` cell's first legal rank is 7 and modtris has two params, so a panel can never be
reached. `fullViewBody` is the only route, and it is the right one: the well is not a control, it
is the module's identity.

```ts
// $lib/ui/modules/modtris/shell-extension.ts
import ModtrisWellBody from './ModtrisWellBody.svelte';
export default { fullViewBody: ModtrisWellBody } satisfies ShellExtension;
```

⚠ **Import `drawModtris` from the def — do NOT re-implement it.** It is already pure
(`modtris.ts:278`) and the card already calls it; a second painter is two renderers for one
picture with nothing catching a divergence.

⚠ **`drawModtris` scales correctly and its TEXT does not.** `cellPx` derives from
`Math.min(w*0.7/COLS, h/ROWS)` (`:295-296`), so the well scales with whatever `w`/`h` it is
given — but the NEXT strip's labels are absolute (`'700 9px ui-monospace'` at `:331`,
`'700 11px'` at `:351`) and its layout offsets are absolute (`wellY + 14`, `+ 90`, `+ 102`). The
card passes backing-store px at DPR 2 (`ModtrisCard.svelte:54`, 400×520), so those render at
half their intended CSS size and the strip's vertical rhythm is wrong by 2×. **The body must pass
CSS px and `ctx2d.scale(DPR, DPR)`** — MUST-VERIFY §15.6, and fix the card in the same PR rather
than shipping two wells at two label scales. (Frogger has the same defect at a smaller
magnitude — `frogger/spec.md` §13.2 — so it is a CLASS across the two, and pong's §13.5 is the
worst instance.)

### 7.2 The zone map

```
┌─ dock full view ───────────────────────────────────────────┐
│ MODTRIS                                            [ ✕ ]   │
├────────────────────────────────────────────────────────────┤
│   ┌───────── fullViewBody ─────────┐                        │
│   │ ┌──────────────┐  NEXT         │  the well, 200×260     │
│   │ │ ▒▒▒▒▒▒▒▒▒▒▒▒ │  ▓▓           │  CSS, DPR-correct      │
│   │ │ ▒▒▒▒█▒▒▒▒▒▒▒ │  ▓▓           │  (see 7.1)             │
│   │ │ ▒▒▒███▒▒▒▒▒▒ │               │                        │
│   │ │ ██▒▒▒▒▒▒███▒ │  LN           │  ← the LN count is     │
│   │ │ ███▒▒█████▒▒ │  17           │    INSIDE the canvas   │
│   │ └──────────────┘     [SCREEN]  │    (§10.1: ALLOWED)    │
│   └────────────────────────────────┘                        │
├─ fall ─────────────────────────────────────────────────────┤
│      ▮ DROP           ▮ LVL                                 │
│      ▮                ▮                                     │
└────────────────────────────────────────────────────────────┘
```

**WIDTH.** A 200 px well and two fader columns. **Nothing here earns a wide plate** and the well
must not be inflated to fill one — *"we do not want useless gray horizontal space on cards,
ever."* Expected plate ~250–290 px. ⚠ MUST-VERIFY §15.4 against `workflow-shell-faces.spec.ts`'s
content-vs-plate leg, which cannot run locally without a baseline.

### 7.3 The SCREEN switch — required by SPIRIT, invisible to the gate

`video-face-screen-source.test.ts` sweeps `listVideoModuleDefs()` only, so an audio-domain module
is structurally invisible to it. ⚠ **The 2026-08-18 owner ruling covers VIDEO modules; modtris is
audio, so the ruling does not reach it and inventing a fleet rule is not this spec's to make.**
Ship it anyway (a rack can hold several modtrises, each repainting a 400×520 canvas every rAF),
and **flag it as an owner question in the report rather than asserting policy.**

Placement is a MEASUREMENT: **OVERLAY the well's bottom-right corner on a translucent backplate
(`rgba(5,6,8,0.72)`), NEVER a row of its own.** State on **`node.data.previewCollapsed`**, never
component `$state`.

⚠ **SCREEN OFF here is UNUSUALLY SAFE**, and for the same measured reason as frogger's: the game
runs on the scheduler, engine-side, and that scheduler is a Web Worker `setInterval` with no
AudioContext check. OFF stops a `drawModtris` call and **nothing else** — pieces keep dropping,
lines keep clearing, gates keep firing. **A permanent leg of the face model test, not a comment**,
because `skifree` one module away does not have the property.

---

## 8. CONTROL INVENTORY — every primitive decision, argued

| face key | primitive | derivation | why not the alternative |
|---|---|---|---|
| `gravityBpm` · `levelStep` | **`paramCells: 'fader'` — BOTH, DECLARED** | `shell-control-kind.ts` — *"the param is a LEVEL the player expects to see as a THROW, not a dial"* | ⚠ **This is the declaration that must not be skipped, and the reason is PARITY rather than taste.** The card renders both as `<NeonFader>` (`ModtrisCard.svelte:88-89`). Without `paramCells` the face paints two KNOBS and a player's muscle memory for a vertical throw lands on a rotary. ⚠ **And note the divergence from its own sibling**: `frogger` declares NOTHING because `FroggerCard` renders a `<Knob>`. Each face matches its OWN card; copying across the group would be a parity loss nothing gates. |
| both | ⚠ **NOT `warped-fader`** | — | Checked deliberately. `ShellWarpedFaderCell` exists for a param whose CARD converts at the boundary (samsloop renders knob space 0..1 and maps piecewise). `ModtrisCard` does not convert: it passes `min`/`max`/`defaultValue`/`curve` straight through. ⚠ It passes them as **literals rather than the def's symbols**, which is §13.3 — a *one-source* defect, not a *warp*. Do not confuse the two; the warped-fader cell would encode a map that does not exist. |
| `gravityBpm` | `curve: 'log'` — **inherited from the def, not restated** | `ModuleShell.svelte:657-700` passes `curve` straight off the `ParamDef` | ⚠ **Check the consumer reads it.** CLAUDE.md's warning: four cards pass `curve="linear"` where the def says `discrete` and `Knob.svelte` has no `discrete` branch — a green gate certifying a live bug. `'log'` on a fader IS consumed; verify rather than assume (MUST-VERIFY §15.7). |
| both | landmarks: **NONE** | §5.2 | |
| `freeze` | **`noUserControl`** | §5.1 | Renders zero cells, asserted invertedly. |

**No `ShellActionCell`, no `ShellFileCell`, no `face.momentary`, no `hero`, no PF-14 panel.**
modtris has no button on any surface. Recorded so a reviewer can confirm the absence.

⚠ **One thing this module conspicuously does NOT get: a RESET / NEW GAME button.** `modtris` has
**no restart input at all** — unlike frogger, which at least has `start_gate`. `stepModtrisState`
re-inits internally on overfill (`:353`), so the game recovers on its own, but a player cannot
choose to. Refused here because it does not exist on the card either: adding it is a **feature**,
and it would need an input port (a contract change) or an ACTION cell with an AUDITION-LEDGER
probe. Recorded as a future PR. ⚠ `getActiveEngine()` is already exported and consumed from plain
`.ts`; **two independent agents have invented the false blocker that a shell-cells action needs a
platform PR to reach the engine. Assume a third will.**

---

## 9. THE STATE MATRIX

| # | gates patched | SCREEN | body paints | what a reviewer checks |
|---|---|---|---|---|
| 1 | nothing | ON | ⚠ **a LIVE, SELF-RUNNING game**: pieces fall at `gravityBpm`, stack, and eventually overfill and re-init. `overfill` fires periodically | **the fresh-spawn state.** The dock scene has a moving subject the instant it opens |
| 2 | a clock → `drop_fast` | ON | pieces slam down; the stack builds much faster | the mock that shows the module's actual use — and `modtris.spec.ts:103` already drives exactly this |
| 3 | a full sequencer on all five | ON | lines clear; a TETRIS emits **FOUR distinct staggered `line_cleared` edges** | ⚠ the module's most interesting output behaviour, and no surface shows it. **Not an argument for a readout** (§10) |
| 4 | any, `levelStep` swept 1 → 20 | ON | ⚠ **NOTHING CHANGES. AT ALL.** | ⚠⚠ **§13.1.** Reachable in two seconds by a user and by nothing in CI |
| 5 | any | **OFF** | nothing | ⚠ **the gates keep firing** (§7.3). The strongest single assertion in this spec |
| 6 | any | ON, `freeze = 1` | the last frame, held | the VRT state (§11) |

---

## 10. THE ARIA CONTRACT — and the resting-text ruling

### 10.1 ⛔ THE SCORE ROW IS REFUSED BY NAME, AND MODTRIS' `LN` COUNT IS ALLOWED

**The ruling** (GAMES.md §1): a game's score and lives painted INSIDE the playfield canvas are
ALLOWED; a score or lives row rendered as CHROME BESIDE the playfield is FORBIDDEN.

**modtris is on the allowed side, and this is stated rather than skipped** because "the LN count
is fine" and "nobody looked at the LN count" are indistinguishable from the outcome.
`drawModtris`'s right strip (`modtris.ts:329-354`) paints `NEXT`, the next-piece preview, `LN` and
`String(state.lines)` — **all of it into the canvas, by the module's own pure function.** The
face is not painting it; the game is. It is artwork, and it is part of the picture that earns the
width. ⚠ Note that the NEXT preview is a *picture* rather than text, and that the strip consumes
30 % of the canvas by construction (`wellWidthPx = w * 0.7`) — so the well is deliberately
narrower than the canvas and the strip is not slack to be reclaimed.

⚠ **AND THE FACE ADDS NO CHROME ROW OF ITS OWN. REFUSED BY NAME.** No `LINES 17` beside the
well, no `LEVEL 2` under the faders, no state word, no `GAME OVER` banner in the plate. That
shape is the hero readout strip (#1957) with a different label, refused for the same reason: a
labelled derived value sitting at rest next to the thing it describes. modtris' DOM chrome today
is `<ModuleTitle>` and nothing else, so **there is nothing to delete** — worth recording, because
`skifree` and `nibbles` in this same group each have a row that does not survive.

⚠ **AND THE GATE CANNOT SEE EITHER SHAPE.** `face-resting-text-source.test.ts` names canvas text
as its own blind spot, and a chrome row inside a module-owned `fullViewBody` is not a `ModuleFace`
field. **This ruling is enforced by the dock VRT baseline and a human reviewing it, and by
nothing else.** Do not write "the gate keeps this honest" in the PR body. Mitigations: (a) the
dock baseline contains the body; (b) `modtris-face-model.test.ts` asserts the body's DOM contains
no text node outside the canvas, negative-controlled by temporarily adding one.

### 10.2 The contract

| element | contract |
|---|---|
| the well canvas | `role="img"`, `aria-label="MODTRIS — 17 lines, next piece L, well 40% full"`. ⚠ Not `aria-valuetext`: a picture is not a range role. **This is where the painted `LN` becomes speakable**, and it is what every spec proving the face tracks the game now reads. ⚠ *"well 40 % full"* is a DERIVED quantity with a live negative control (`gravityBpm` must not move it) — a permanent leg of the face model test. |
| the SCREEN button | `aria-pressed={!previewCollapsed}`, `SCREEN ON` / `SCREEN OFF`, and a `title` saying **the game keeps playing and the gates keep firing**. |
| `control-gravityBpm` | `aria-valuetext`: `"60 bpm — 1.00 s per drop"`. The seconds-per-drop is the quantity the player actually feels and it is `60 / bpm`, the def's own function — a derived value with a negative control (`levelStep` must not move it). |
| `control-levelStep` | ⚠ **If §13.1 WIRES it**: `"every 10 lines"`. **If §13.1 has NOT been resolved**, the honest string is `"10 — has no effect"`, and shipping that is an admission that half the face is dead. **Prefer the fix, or prefer the deletion.** |
| every param cell | `data-testid="control-<paramId>"`; `faces-parity` asserts exact multiset equality against the def's param ids and scans the whole `dockShell` **including the body**. `freeze` must render **zero**. |

⚠ **Keyboard.** Owner ruling: no keyboard-a11y work, and none is proposed. modtris takes **no
keyboard input at all** — its instrument is the gate cable, which is why
`face-migration-inventory.ts:909` describing it as *"played on the keyboard"* is wrong (§13.7).
`NeonFader`'s existing `role="slider"` keys are untouched.

---

## 11. DETERMINISM AND VRT

**Two new scenes** — `face-modtris-compact`, `face-modtris-dock` — added by hand to the `FACES`
roster. ⚠ Nothing ties that roster to `STRICT_FACES`; a promoted module missing from it silently
has no VRT scene.

⚠ **The compact scene has no picture** (§0.4), so it is a static two-fader tile and is
deterministic for free. **The dock scene carries the live well** and is not.

**`FACES_WITHOUT_SCENES` IS NOT AVAILABLE.** Its bar is *evidence that `simPin` AND `freeze`
cannot reach this renderer*. Here both can.

**`videoFaceWhy` MUST NOT BE DECLARED** — it is the video-zone boot selector first, and a
`domain: 'audio'` module that declares it hangs in `bootWithFace`'s channel-column wait for the
full 90 s test timeout. `rasterize` is the shipped audio-side precedent.

**The seam, in two halves — and modtris is EXACTLY pong's shape, unlike frogger:**

1. **`freeze` (§5.1) stops the game.** The scheduler `tick` returns before stepping when
   `params.freeze >= 0.5`. ⚠ It must be in the **`tick`**, not the body — a body-side freeze
   stops the picture while the game runs on, and "frozen" and "not looking" must be
   distinguishable.
2. **`simPin` chooses WHICH frame, and modtris needs a SEED as well as a tick pin.** Unlike
   frogger (no RNG at all), modtris has a 7-bag Fisher-Yates shuffle — but the hook is **already
   half-built**: `initModtrisState({ rng })` (`modtris-state.ts:177-178`) and
   `stepModtrisState(…, { rng })` (`:336-338`) both accept an injectable RNG defaulting to
   `Math.random`, and **the factory calls both with none** (`modtris.ts:173`, `:194`).

   ```ts
   // modtris.ts factory — read a page global at CONSTRUCTION (the simPin contract)
   const seed = (globalThis as { __modtrisVrtSeed?: number }).__modtrisVrtSeed;
   const rng = typeof seed === 'number' ? createSeededRng(seed) : Math.random;
   let state = initModtrisState({ rng });
   // …and pass { rng } through every stepModtrisState call.
   ```
   plus a fixed tick budget so the captured frame is a function of `(seed, params)` rather than of
   boot speed.

   ⚠ **The seeded-RNG helper already exists in the tree**, in `art/scenarios/modtris/gate-pulses.test.ts`
   (a mulberry32 `seededRng`). ⚠ **Do NOT import it from a test file** — lift it to a shared
   module both can import, or the ART scenario becomes part of the product's basis.

⚠ **`simPin` installs globals with `addInitScript`, so it reaches a factory that reads them AT
CONSTRUCTION.** modtris' factory is main-thread (no `renderLocus`), so the global is visible.
MUST-VERIFY §15.5.

⚠ **The exemption is NOT dischargeable by its own terms.** Unlike frogger's and skifree's,
`vrt-exemptions.ts:756` states no exit condition — just *"animated game state defeats
deterministic capture"*. **This PR builds a seam that would satisfy the condition frogger's entry
names**, so re-examining modtris' card exemption in the same PR is defensible and should be
raised — but it is a judgement rather than a discharge, and if it is dropped
`ALLOWED_PERMANENT_EXEMPT` must lose modtris in the SAME commit (both lists anchored in both
directions). **Predict the PNG count either way and check it.**

**Scope the dispatch.** `GREP=modtris flox activate -- task vrt:commit` — measured 41-56 min
unscoped against ~3 min scoped. ⚠ A bare dispatch on a face PR derives FULL.

**CI wall-time.** `faces-parity` budgets ≈ `10 s + 0.8 s/cell`. **2 cells ⇒ ≈ 11.6 s**, plus two
face scenes. Well under the ~2 min threshold. ⚠ `modtris.spec.ts` already costs **17.8 s** and is
untouched. **Re-pin BOTH cost artifacts** — an unmeasured `vrt-strict` scene rides the median and
has reddened `main` at 92 % of a shard budget with every test passing.

---

## 12. COST

| item | cost |
|---|---|
| **WebGL attest** | **ZERO — VERIFIED.** No modtris file in the attest basis; the card is 2D-only. ⚠ **`ModtrisWellBody.svelte` must stay 2D.** |
| **contract-lock** | **+1 row for `freeze`**, and ⚠ **−1 row if §13.1 deletes `levelStep`.** Run `task docs:accept` and read the diff: the only lines that may move are those. Anything else is a finding. |
| **docs** | modtris is in `STRICT_DOCS` (`:304`), so `freeze` needs `docs.controls.freeze` **and** §13.1 requires `docs.controls.levelStep` to be corrected or removed — it currently promises *"gravity speeds up each level"*, a behaviour that does not exist. |
| **ART** | ⚠ **NOT NIL — READ THIS.** `art/scenarios/modtris/gate-pulses.test.ts` exists and Part 1 drives the **pure stepper**. If §13.1 WIRES `levelStep`, the stepper's behaviour changes and Part 1 re-measures. It asserts scripted event positions rather than a pinned waveform, and there is **no `.f32` baseline**, so there is nothing to re-pin — but **verify, do not assume**. Part 2 is blind to the factory (§13.4) and is unaffected either way. |
| **Push 2** | GENERIC today. A face moves it to the FACE tier: two turnable params in `face.order` order. ⚠ **`freeze` must NOT appear** — that is what `noUserControl` buys, and `push-card-schema`'s golden diff is where you confirm it. ⚠ If §13.1 deletes `levelStep`, the golden loses a slot; **accept it deliberately with the reason written in the test.** |
| **New code** | one `shell-extension.ts`, one `ModtrisWellBody.svelte` (importing `drawModtris`, 2D, DPR-correct), the `freeze` early-return + seed pin + a shared `createSeededRng`, one `STRICT_FACES` line, one `FACES` roster row with `simPin`, one `modtris-face-model.test.ts`, and **whatever §0.1 decides**. |
| **Conflict surface** | `strict-faces.ts` · `_shell-faces.ts` · `push-card-config.ts` golden · `vrt-exemptions.ts` (two lists, one commit) · `contract-lock.txt` (GENERATED — take main and re-run the accept task) · ⚠ **`e2e/tests/_face-fixtures.ts` / `workflow-shell.spec.ts`**, which no other face PR in this wave touches. |

---

## 13. DEFECT LEDGER

Per CLAUDE.md nobody opens issues: each of these is fixed **inside this PR**, scoped honestly,
with the story in the PR body.

**13.1 — ⚠⚠ HALF THIS MODULE'S CONTROL SURFACE DOES NOTHING.** `modtris-state.ts:128-129`, in its
own words: *"Lines-per-level threshold (**unused in v1 stepper** but reserved for future
scoring)."* MEASURED: `grep -n "params\." modtris-state.ts` returns **one** consumer,
`gravitySecondsPerDrop(params.gravityBpm)` at `:407`; `ModtrisState` declares `lines` (`:141-142`)
and **no `level` field at all**, so there is no difficulty ramp for the threshold to threshold.
Meanwhile `modtris.ts:114-116` promises *"how many cleared lines it takes to advance a level and
ramp the difficulty (gravity speeds up each level). Lower = a steeper difficulty curve"* — false
in both clauses — `contract-lock.txt:2031` pins the param, the card draws a fader for it, and a
promoted face would rank it 2 of 2 on the Push card. **Severity: fold into this PR; it is a
contract change either way, so it cannot be deferred past the face.** The two honest resolutions:

- **WIRE IT** — add `level` to `ModtrisState`, derive it as `floor(lines / levelStep)`, and scale
  `gravitySecondsPerDrop` by it. Pros: the docs become true, the face keeps two ranked controls,
  and it is a small, testable stepper change with a leg that fails on the old code. Cons: it
  changes how the module SOUNDS (the gate rate ramps where it used to be flat), so it is an
  **owner-preview PR — do NOT auto-merge**, and the ART scenario's Part 1 re-measures.
- **DELETE IT** — remove the param, the fader, the docs entry and the contract row. Pros:
  smallest honest change, no behaviour change, no owner audition. Cons: modtris becomes a
  one-param module (which is fine — the STOP-1 override says so) and **a saved rack carrying
  `params.levelStep` must not break**; `setParam`'s guard already ignores unknown ids, so the
  reader side recovers with no migration.

⚠ **This spec does not choose.** It is a behaviour question with an audible consequence, which is
an owner call, and the PR must ask it explicitly. **What the spec does insist on is that
`face.order` cannot rank `levelStep` honestly until it is answered** (§4).

**13.2 — the NEXT strip's labels render at half size because the card passes backing-store
dimensions.** `ModtrisCard.svelte:54` calls `drawModtris(ctx2d, snap, canvasEl.width,
canvasEl.height)` = 400×520 at `DPR = 2`, with no `ctx2d.scale(DPR, DPR)`. The well scales
correctly (`cellPx` is derived) but `'700 9px'`/`'700 11px'` and the `+14`/`+90`/`+102` offsets
are absolute, so `NEXT`, `LN` and the count render at ~4.5–5.5 CSS px with a compressed vertical
rhythm. There is **no pixel test at all**, because modtris is `EXEMPT_FROM_VRT`. ⚠ The body must
NOT copy the card's call, and after §11 there IS a pixel test — the first thing that could have
caught it. **Severity: fold in**, and fix the card too so there are not two wells at two label
scales. (Same class as `frogger/spec.md` §13.2 and pong's §13.5 — three instances, so it is a
CLASS.)

**13.3 — the card re-types SIX range literals and NOTHING checks them.**
`ModtrisCard.svelte:88-89`: `min={30} max={240} defaultValue={60}` and `min={1} max={20}
defaultValue={10}` — **while importing `modtrisDef` and using `modtrisDef.params[N]!.defaultValue`
two lines earlier** (`:26-27`). `card-kit.ts` exports `paramSpec` for exactly this; `grep -c
paramSpec ModtrisCard.svelte` → 0. modtris is not in `RANGE_BOUND_CARDS`, whose own stated scope
is *"every card NOT in this set is unchecked"*. They agree today; nothing holds them there.
**Severity: fold in** (use `paramSpec`, enrol the card). The backdraft class verbatim.

**13.4 — the ART gate-pulse test cannot fail on a factory regression.**
`art/scenarios/modtris/gate-pulses.test.ts` Part 2 **hand-orchestrates** *"the exact
ConstantSourceNode schedule the factory emits"* into a fresh `OfflineAudioContext`. It never
imports `modtrisDef`, never calls `factory`, and never reads `GATE_PULSE_S` (`modtris.ts:55`),
`GATE_SPACER_S` (`:58`) or `SCHEDULE_CUSHION_S` (`:60`). **Change any of the three and this test
stays green while the shipped gate width changes.** Its own header is honest —
*"hand-orchestrate the exact ConstantSourceNode schedule the factory emits"* — and
"hand-orchestrate" IS the blindness: it is a fixture the test built, asserting a property of
itself. ⚠ **pong has the identical defect** (that spec's §13.7), so it is a CLASS across the game
cohort. **Severity: a blind gate on a shipped contract.** Minimum fix: import the three constants.
Ideal: drive the real factory.

**13.5 — the lane tile is a dead placeholder and no test has ever looked.** §0.3 in full. Not in
`NON_SHELL_LANE_TYPES`, not in `STRICT_FACES`, not a `CARD_PRODUCER` ⇒ `'placeholder'`. **Every
modtris e2e drives `?shell=legacy`.** This spec closes it at the dock and leaves it open at the
lane. **Severity: report as the group-level platform finding** (GAMES.md §2.2).

**13.6 — `vizPassthrough: true` is a lie, and two surfaces advertise it.** `modtris.ts:68`
declares it and `docs.explanation` (`:97`) tells the user the canvas *"can be portaled into a
containing GROUP card for cross-domain video"*, but `GROUP_VIZ_HOST_TYPES` is
`new Set(['scope'])`. MEASURED: `group-viz-hosts.test.ts:104` — *"canvasInSlot 0 for
frogger/modtris/pong against SCOPE's 1"* (#1755), with the reverse assertion deliberately
withheld. **Severity: report — a CLASS across four modules.** GAMES.md §8.1.

**13.7 (minor) — `face-migration-inventory.ts:909` describes a module that does not exist.**
*"a falling-block viewport played on the keyboard"* — `ModtrisCard.svelte` has **no keyboard
handler**; the module is driven entirely by five gate CVs, which is the point of its design.
Fix the string in this PR. GAMES.md §8.6.

---

## 14. TASTE CALLS, EACH WITH ITS ONE-LINE REVERT

1. **Answering §0.1 by widening the fixture PREDICATE rather than retiring the leg.** Revert:
   retire the leg with the design it covered, in the PR body. ⚠ **Neither is "do nothing"** —
   doing nothing is the silent skip.
2. **`freeze` + `__modtrisVrtSeed` rather than `FACES_WITHOUT_SCENES` (§11).** Revert: none
   defensible — the exemption's own bar refuses it. Recorded so the shortcut is not attempted.
3. **`gravityBpm` ranks 1 over `levelStep`.** Revert: swap. ⚠ There is no measured argument for
   the swap and there cannot be one until §13.1 is answered.
4. **Both declared `'fader'` (§8).** Revert: drop `paramCells` and they are knobs — and the face
   silently stops matching the card's own primitive, a parity loss nothing gates.
5. **ONE band (§6).** Revert: split `fall` into `speed` (gravityBpm) and `difficulty`
   (levelStep). Consequence: a second ~81 px band header for a distinction the module does not
   make — and, today, for a band containing one dead control.
6. **A SCREEN switch on an AUDIO module (§7.3).** Revert: drop it — the owner ruling covers video
   modules. **Raised as an owner question rather than decided here.**
7. **No RESET/NEW GAME affordance (§8).** Revert: it is a feature PR (and a contract change),
   not a revert.

---

## 15. MUST-VERIFY

1. **The tier ladder**, derived through `curatedFace`, not the cap constants.
2. **Two `'fader'` cells and the plate's width** — `cellWidthClass` is deny-by-default `'wide'`.
3. **`rear-card-model`** — the `steer`/`rotate`/`drop` groups resolve, their derived column
   widths (2/2/1) lay out, and the five gate inputs (no `paramTarget`) do not orphan.
4. **Plate width ≤ pane width** — needs a baseline; the first `vrt:commit` IS the measurement.
5. **`simPin` reaches the factory** — the global must be readable at CONSTRUCTION. Prove it:
   **three consecutive dock captures pixel-identical, AND a fourth with a DIFFERENT seed that is
   visibly different.** A pin that changes nothing is indistinguishable from a pin that never ran.
6. **The DPR question (§13.2)** — measure the rendered `LN` font in CSS px before and after, on
   the card and in the body, and state the units in the assertion message.
7. **`curve: 'log'` is actually CONSUMED by the fader** — CLAUDE.md's warning about a green gate
   certifying a live bug. Sweep the fader across its travel and confirm the value distribution is
   logarithmic, not linear.
8. **SCREEN OFF leaves the gates firing** — a downstream counter on `line_cleared` before and
   after a collapse window. ⚠ The property `skifree` does NOT have.
9. **`freeze` renders exactly ZERO cells** in both `module-face-lint` and `faces-parity`, and does
   not appear on the Push golden.
10. **§0.1 — after the promotion, `fixtureProblems(AUDIO_OPERABLE_FIXTURE)` and the leg that
    consumes it.** Run `workflow-shell.spec.ts` and **read the skip count**: a Playwright sweep's
    trailing list is tests that DIDN'T RUN.
11. **The ART scenario is still green after §13.1**, if §13.1 wires `levelStep` — it asserts
    scripted event positions, so it should be; verify rather than assume.
12. **The body contains NO text node outside the canvas** (§10.1) — negative-controlled by
    temporarily adding one.

---

## 16. VERIFICATION GATE

```sh
# 1. the pure model + this face's PERMANENT negative controls (§9 rows 5/6, §10.2's derived legs)
REPEAT=3 flox activate -- task test:one -- modtris-face-model
# 2. the stepper, because §13.1 may change it
REPEAT=3 flox activate -- task test:one -- modtris-state
# 3. face lint + plans
flox activate -- task test:one -- module-face-lint
flox activate -- task test:one -- dock-row-plan
flox activate -- task test:one -- dock-faceplate-model
flox activate -- task test:one -- curated-face
flox activate -- task test:one -- shell-extensions
flox activate -- task test:one -- module-shell-import-guard
# 4. the rulings' source gates
flox activate -- task test:one -- face-resting-text-source
flox activate -- task test:one -- face-readout-source
flox activate -- task test:one -- face-width-source
# 5. #1726 + rear + push + docs
flox activate -- task test:one -- no-user-control          # freeze: zero cells, both directions
flox activate -- task test:one -- rear-card-model
flox activate -- task test:one -- push-card-schema         # freeze absent; levelStep per §13.1
flox activate -- task test:one -- card-range-source        # after §13.3
flox activate -- task test:one -- module-docs-lint         # docs.controls must match §13.1
flox activate -- task test:one -- vrt-meta                 # the two exemption lists stay anchored
flox activate -- task test:one -- group-viz-hosts          # §13.6 touches its comment only
# 6. the contract diff must contain ONLY `modtris param freeze` (+ the levelStep row per §13.1)
flox activate -- task docs:accept && flox activate -- git diff
# 7. ART — Part 1 re-measures if §13.1 wires levelStep
flox activate -- task art:one -- modtris
# 8. e2e — ⚠ workflow-shell is NOT optional here (§0.1). READ THE SKIP COUNT.
flox activate -- task e2e:serve
REPEAT=3 flox activate -- task e2e:one -- tests/faces-parity.spec.ts
REPEAT=3 flox activate -- task e2e:one -- tests/modtris.spec.ts
REPEAT=3 flox activate -- task e2e:one -- tests/workflow-shell.spec.ts
REPEAT=3 flox activate -- task e2e:one -- tests/faceplate-platform.spec.ts
flox activate -- task e2e:stop
# 9. typecheck LAST — svelte-check is stricter than vitest
flox activate -- task typecheck
# 10. VRT: SCOPED dispatch only. Predict the file count and COUNT what the bot commits.
GREP=modtris flox activate -- task vrt:commit
# 11. re-pin BOTH cost artifacts against the newest run, and review both diffs
flox activate -- task e2e:timings:accept -- <run>
flox activate -- task vrt:strict:timings:accept -- <run>
# 12. attest: NIL for this module — nothing to run.
```

**The negative controls, spelled out so a builder cannot ship a green stub:** a DIFFERENT
`__modtrisVrtSeed` must produce a visibly different dock capture; SCREEN OFF for N frames must
leave a downstream `line_cleared` counter STILL INCREMENTING; `gravityBpm` 60 → 240 must change
`control-gravityBpm`'s `aria-valuetext` from `1.00 s per drop` to `0.25 s per drop` AND change
the measured drop interval; if §13.1 wires `levelStep`, sweeping it 1 → 20 must change the
measured drop interval after N cleared lines and must NOT change it at zero lines; adding a
`<span>LINES 17</span>` to the body must turn §10.1's leg RED.

## 17. BUILD-COST ESTIMATE

| phase | estimate |
|---|---|
| ⚠ **§0.1 — the `AUDIO_OPERABLE_FIXTURE` decision + its implementation** | ~2 h (widen the predicate) to ~1 h (retire the leg) — **and an owner round-trip if it is a coverage loss** |
| `freeze` param + `noUserControl` + the `tick` early-return + `docs.controls.freeze` | ~1 h |
| the seed pin + a shared `createSeededRng` lifted out of the ART fixture (§11) | ~1.5 h |
| `shell-extension.ts` + `ModtrisWellBody.svelte` (importing `drawModtris`, DPR-correct) | ~2.5 h |
| **§13.1 — `levelStep`: wire it or delete it. Own commit, and WIRING is an owner-preview PR** | ~2 h + an owner audition |
| §13.2 card-side DPR, §13.3 `paramSpec` + `RANGE_BOUND_CARDS`, §13.4 ART constants, §13.7 string | ~2 h |
| `modtris-face-model.test.ts` + the stepper legs for §13.1 | ~2.5 h |
| roster/registry edits, exemption-list decision, push golden, `rear.groups` | ~1 h |
| gate loop, 3× flake checks, ART re-run, typecheck | ~2.5 h |
| VRT dispatch + the seed negative control | ~1.5 h wall |
| **total** | **≈ 18.5 h** |

**Risk rank: MEDIUM — and the risk is NOT the face.** The face is two faders and a body: perhaps
four hours. The rest is a shared-fixture precursor that must be decided before the promotion
lands, a dead control whose resolution is an owner call with an audible consequence, and the same
determinism seam pong specified. ⚠ **If the wave needs a fast module, this is not it — but it is
the only module in the wave that forces a question the whole face programme will hit again**, and
answering it here is cheaper than answering it when the pool empties by accident.
