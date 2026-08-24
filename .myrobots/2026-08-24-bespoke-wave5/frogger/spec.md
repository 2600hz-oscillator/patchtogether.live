# FACEPLATE BUILD SPEC — `frogger` (audio, a gate-steered arcade game)

> **SPEC + MOCKS. Nothing here is implemented.** Group analysis: [`../GAMES.md`](../GAMES.md).
> Direct precedent: `.myrobots/2026-08-23-bespoke-wave1/pong/spec.md` — where its argument
> transfers it is CITED, not re-derived, and where it does not the divergence is named.
>
> **Mocks:** `dock.html` · `lane-tiers.html` (self-contained, open in a browser).
>
> ⚠ **DOOM is excluded from this spec by name**, per the standing owner ruling. It is a game
> module and would fall inside every sweep here; nothing in this document applies to it and no
> file of its was opened. Reason: its game clock IS its frame clock, so any re-timing
> re-specifies the game.

**Verdict: PROMOTE. This is the cheapest face in the wave and it DISCHARGES A NAMED RATCHET.**
One param, one band, one body. Frogger's `EXEMPT_FROM_VRT` entry states its own exit condition
verbatim — *"Promote to a real VRT baseline once a deterministic-time test hook is added so the
scene can freeze the game at a known tick"* (`vrt-exemptions.ts:766-768`) — and this PR builds
exactly that hook. It is unusually cheap to build here for a reason no sibling shares: **frogger
has no RNG at all**, so the board is already a pure function of tick count and the seam is a
tick pin with nothing to seed.

The audit found **the module's only control does nothing until the next START pulse** (§13.1),
and a class-level lie about `vizPassthrough` shared with three siblings (GAMES.md §8.1).

---

## 0. THE CONSTRAINT MAP, READ FIRST

| registry | member? | what it means here |
|---|---|---|
| `NON_SHELL_LANE_TYPES` (`legacy-fallback.ts:96-107`) | **NO** | the lane swaps. `laneRenderKind` returns **`'placeholder'`** today (`legacy-fallback.ts:143-147`). |
| `CARD_PRODUCER_LANE_TYPES` (`dom-source-modules.ts:204-211`) | **NO — and CORRECTLY so** | the set is DERIVED by a grep over card subtrees for two producer seams. `FroggerCard.svelte` matches neither: it *reads* `eng.read(node,'snapshot')` and paints. **Nothing engine-visible depends on the card.** ⚠ Contrast `skifree`, where the same answer is WRONG — GAMES.md §5. |
| `HEADLESS_MOUNT_LANE_TYPES` | **NO** | so the card is simply NOT MOUNTED under the shell. |
| `EXEMPT_FROM_VRT` (`vrt-exemptions.ts:769`) | **YES** | *"animated sprite motion (cars/logs/turtles) + auto-start defeat deterministic single-frame capture"* — with a stated exit condition. |
| `ALLOWED_PERMANENT_EXEMPT` (`:1176`) | **YES** | ⚠ anchored in both directions; the two lists move in ONE commit or not at all. |
| `STRICT_FACES` | **NO** | un-migrated. |
| `STRICT_DOCS` (`strict-docs.ts:303`) | **YES** | so any new param needs a `docs.controls.<id>` entry or completeness reddens. |
| `PUSH_CARD_CONTROLS` | **NO** | GENERIC tier. One turnable param, so the card is one encoder before and after — the least disruptive Push move in the wave. |
| `RANGE_BOUND_CARDS` | **NO** | so the card's three re-typed range literals are unchecked (§13.3). |
| `ART_EXCLUDED` (`profile-coverage.ts:41`) | **YES** — *"free-running game audio driven by RNG + gameplay state"* | ⚠ the reason is half wrong (there is no RNG) but the exclusion is right: frogger has no audio-family OUTPUT at all. Cost: **ZERO**. |
| `_face-fixtures.ts` pools | `AUDIO_PLACEHOLDER` pool, index 9 of 26 | ⚠ **not the PICK** (`clockedRunner` is), and the pool has 25 members of slack. Promotion is invisible to it. Contrast `modtris` — GAMES.md §6. |
| `face-migration-inventory.ts:810-813` | **`bespoke-surface`, NO BLOCKERS** | *"a GAME viewport driven by the keyboard — one knob beside it does not make it a face."* ⚠ **The `why` is FACTUALLY WRONG**: `FroggerCard.svelte` has no keyboard handler of any kind. GAMES.md §8.6. |
| WebGL attest basis | **NO — VERIFIED** | `scripts/webgl-attest-hash.sh --list` contains no frogger file. `FroggerCard.svelte` is `getContext('2d')`, so the mechanical card sweep misses it too. **Editing frogger is attest-transparent.** |

### ⚠ THE FACT THAT DEFINES THIS FACE: THE BOARD IS ON THE CARD, AND THE CARD IS GONE

`drawFrogger` (`frogger.ts:324-442`) is a pure exported function; the CARD calls it every rAF
(`FroggerCard.svelte:62`) reading `eng.read(node, 'snapshot')`. The game runs engine-side on the
shared scheduler at **40 Hz** (`frogger.ts:234`, `SCHEDULER_TICK_MS = 25`), so it keeps playing,
keeps timing out, and keeps pulsing `dead_gate` whether or not anything is mounted.

**So under the shipping shell, today, on `main`:** the lane tile is a `ModuleShellPlaceholder` —
no board, no HUD, no knob — while the game runs and fires. **Every frogger e2e navigates
`/rack?shell=legacy`** (`frogger.spec.ts:68`, and the shared `rack` fixture is `?shell=legacy`
by construction, `_fixtures.ts:93`), so nothing in the suite has ever observed it.

That is §13.5, and **it is the reason to promote rather than a cost of promoting** — pong's §0
conclusion, reached independently on a module with the same topology.

### ⚠ AND THE LANE STILL WILL NOT HAVE A BOARD

GAMES.md §2.2 and §3 in full: `hasVideoSurface(def)` is `domain === 'video'`; frogger is
`domain: 'audio'`, so no `VideoTileThumb`. All three outputs are `type: 'gate'`, so
`primaryAudioOutPortId` is null and **every glyph literal except `'none'` resolves
`{kind:'static'}`** and reddens the dead-glyph clause. The face declares `glyph: 'none'` and the
lane tile is **one knob and no picture.**

---

## 1. WHAT THE MODULE IS FOR

**In one paragraph.** FROGGER is not a game you play — it is **a five-input event
transformer whose transfer function is a road and a river.** You do not touch it; you patch
gates into UP / DOWN / LEFT / RIGHT and the game emits gates back on the events your steering
produces: a home pad reached, a death, a level cleared. The verb a player performs is **AIM THE
HOPS**: you choose what drives the four directions (a sequencer, a clock through a divider, an
LFO through a comparator) and then listen to what the *geometry* does to that pattern. Its
sibling `pong` derives a rhythm from a bouncing ball; frogger derives one from a **grid of
moving obstacles with a countdown on top**, which is a genuinely different generator — the
output rate depends on traffic phase and on how long the frog survives, not on a rally length.
The board is a readout of that system, which is why it is the module's identity and not
decoration.

**The chain, in execution order** (`frogger.ts:129-234` + `frogger-state.ts`):

1. **The clock.** `getSchedulerClock().subscribe(tick)` (`:234`). `SCHEDULER_TICK_MS = 25`
   ⇒ **40 Hz**. ⚠ `dtSeconds = SCHEDULER_TICK_MS / 1000` is computed **once** (`:195`) and never
   measures real elapsed time. **The board is a pure function of TICK COUNT**, which §11 is built
   on and which is already true today.
   ⚠⚠ **That clock is a Web Worker `setInterval` and is NOT gated on the AudioContext** —
   `scheduler-clock.ts:78`, `:101-118`, `dispatch()` has no state check. GAMES.md §4.1. **An
   audio suspend cannot freeze this game.**
2. **Gate in.** Five `AnalyserNode` taps at `fftSize = 32`, `smoothingTimeConstant = 0`
   (`:132-144`); each read takes the **tail sample only**. `detectRisingEdge` turns each into a
   boolean. ⚠ These are analyser taps, not AudioParams, so there is no cv-scale fast path — the
   same shape `cv-scale-registry.test.ts` records for pong's paddles.
3. **The synthetic boot start.** `pendingAutoStart` (`:192`) ORs a rising edge into
   `inputs.start` on the FIRST tick, so a freshly-spawned module is already playing. The BOOT
   NOTE (`:177-191`) argues the design: one code path for boot and for a CV restart, so one test
   covers both. ⚠ "Boot" is **module spawn**, not page load — a reload does not re-fire it.
4. **The step.** `stepFroggerState`: movement → sprite tick (`SPRITE_TICK_MS = 10`, so ~100 Hz
   of game time inside a 40 Hz real tick, `frogger-state.ts:603-607`) → collisions → homes →
   the 1 Hz timer countdown (`:620-624`).
5. **Gate out.** Three `ConstantSourceNode`s. `pulseGateNTimes` schedules `GATE_PULSE_S = 0.005`
   pulses separated by `GATE_SPACER_S = 0.005` after a `SCHEDULE_CUSHION_S = 0.005` cushion —
   **so a single move that fills the last home emits that many DISTINCT staggered edges**, which
   is the module's most musically interesting property and nothing on any surface shows it.
6. **The picture.** The card's rAF reads the snapshot and calls `drawFrogger`.

**What the one control genuinely changes.**

| param | read at | effect | hazard |
|---|---|---|---|
| `initialTime` (10..120 linear, default 60) | `frogger-state.ts:313` (`initFroggerState`) and `:336` (`startGame`) — **constructors ONLY** | seeds `state.time` AND `state.defaultTime` | ⚠ **§13.1 — moving it mid-game changes NOTHING until the next START pulse**, and `handleLevelComplete` then decays `defaultTime` by 5 s per level (floor `LOWEST_TIME = 10`, `:378`, `:482`), so after a few levels the knob's value is not even the current ceiling |

**Hidden constants no surface shows:** `INITIAL_PLAYER_LIVES = 5`, `COLS = 14` / `ROWS = 13`,
`INITIAL_PLAYER_X = 7` / `Y = 13`, `LOWEST_TIME = 10`, the −5 s per-level decay,
`SPRITE_TICK_MS = 10`, `GATE_PULSE_S` / `GATE_SPACER_S` / `SCHEDULE_CUSHION_S = 0.005` each.

---

## 2. STOP 1 — is promoting this module a PARITY LOSS?

**No — and the comparison to #2065 (`spectrograph`) has to be made explicitly, because frogger
is the same SHAPE.** An audio-domain module whose headline feature is a card-drawn canvas, with
no engine surface for the shell to paint.

Three things make it a PROMOTE, and any one missing would flip the verdict. They are pong's
three, re-checked against frogger rather than inherited:

1. **The alternative is not the card — it is a BLANK TILE.** spectrograph's refusal compared a
   face against a working card in the lane. Frogger has no card in the lane today (§0), so
   promotion is measured against grey.
2. **`fullViewBody` gives the board a real home at the dock**, and it is WIRED —
   `WIRED_SHELL_EXTENSION_SLOTS` is `['glyph','fullViewBody']`, with `backdraft`, `videoOut`,
   `spirographs`, `cameraInput` and `rasterize` as adopters. ⚠ **`rasterize` is the precedent
   that matters here**, because it is an AUDIO-domain module with a JS-painted picture in a
   `fullViewBody` and a `simPin` — frogger's exact shape.
3. **One ranked param, so no tier resolves to zero controls.** The #1974 `joystick` bar is
   cleared, but ⚠ **only just** — and the honest statement is that frogger clears it with one
   control, not with room. If `initialTime` were removed the module would be a refusal.

⚠ **What is honestly WORSE than the card, and must be said rather than absorbed:** the dock
board is reachable only by EXPANDING. The card put a board in the lane; the face puts one in the
dock. Until the `ShellExtensionGlyphProps` `nodeId` widening lands (GAMES.md §2.2), **a rack full
of froggers is a rack of blank tiles** — which is what ships today, so it is not a regression,
but it is not the fix either.

---

## 3. STOP 2 — does every way of getting DATA IN survive?

```sh
grep -nE '<button|<select|<input|oncontextmenu|manualTrigger|Toggle|Selector|accept=' \
  packages/web/src/lib/ui/modules/FroggerCard.svelte
```
**Zero hits.** The smallest STOP-2 surface in the group.

| # | affordance | site | after promotion |
|---|---|---|---|
| 1 | `<header class="title">FROGGER</header>` | `:82` | ⚠ **CHANGES, and it is an IMPROVEMENT.** This card uses a bare `<header>`, **not `<ModuleTitle>`** — unlike its three siblings — so frogger's card has **no rename and no control-colour dot today.** The shell's title bar supplies both. Note it as a gain, and note that nothing gated the divergence. |
| 2 | `<PatchPanel>` — all eight jacks, drill-down, unpatch menu, card flip | `:84-105` | **YES** — the shell paints its own |
| 3 | TIME `<Knob>` | `:96-103` | **YES** — rank 1, the face's only cell |
| 4 | knob right-click → MIDI learn / Send to Control Surface / Send to Electra ▸ Row ▸ knob / clear automation | `Knob.svelte` context menu | **YES** — the shell renders the same `<Knob>` |
| 5 | knob drag / dbl-click-to-default / wheel / `role="slider"` keys | same | **YES** |
| 6 | the 200×226 board canvas | `:86-93` | **YES via `fullViewBody`** (§7). ⚠ dock-only. |
| 7 | `data-viz-passthrough` on the canvas (`:91`) | — | ⚠ **NOTHING IS LOST, because it does nothing today.** GAMES.md §8.1 (#1755) |
| 8 | `data-testid="frogger-canvas"` | `:92` | **carry it onto the body's canvas verbatim** — `frogger.spec.ts` reads it, and re-naming it would break a spec for no reason |

**No `node.data` state, no button, no dropdown, no file input, no keyboard handling.** The
card's only write is `setNodeParam` for row 3. STOP 2 is satisfied by **one knob cell and one
body.**

### 3.1 Where state lives — `params` vs `node.data`

**100 % `params`, ZERO `node.data`.** `grep -c "mutateNode\|node.data" FroggerCard.svelte` → 0.
So frogger does not touch the generic face path at all, and it contributes a **clean** row to
the wave-3/wave-4 `.data`-discipline census: `mutate.guard.test.ts`'s regex anchors on the
literal token `.params`, so it is structurally blind to `.data` writes — and frogger has none to
be blind to. Not a finding; recorded so the census has a denominator.

---

## 4. THE RANK — `face.order`

| # | key | why it earns this rank | what it costs below |
|---|---|---|---|
| 1 | `initialTime` | **It is the only param, so the rank is not a judgement — but the ARGUMENT still has to be made, because the alternative is not ranking it at all.** On a module whose outputs are gates, `initialTime` is the one control that changes the OUTPUT RATE: it is the ceiling on how long a life lasts, so it bounds the period of `dead_gate` in the degenerate case (no steering patched, frog sits still, DEAD fires every `initialTime` seconds like a very slow LFO). That is a real, reachable, musically useful behaviour and it is the strongest thing the control does. | nothing |

**THE TIER LADDER, read back as a sentence.** With `glyph: 'none'` the caps are the glyph-less
column (`curated-face.ts:62-79`, `laneBodyPlan`'s `LANE_ROW_MAX_CELLS`): **at mini you get TIME;
at compact, TIME; at plate, TIME; at the dock, TIME plus the board.** ⚠ It is the same sentence
at every tier and that is the correct outcome of a one-param module, not a defect —
`module-faceplates.md`'s STOP-1 override says so in the owner's words (*"they still need to be
done, <4 params or not"*). **MUST-VERIFY §15.1** — derive it through `curatedFace`, never from
the cap constants; four sibling faces got that wrong.

**THE LOSER, NAMED.** There is none, and saying so is the point: a reviewer should be able to
confirm the absence rather than infer it.

---

## 5. VOCABULARY — one new param, and no roster

**5.1 `freeze` — a new `0..1 discrete` param, `noUserControl`, `writer: 'internal'`.**
Required by §11 and nothing else. Spelled exactly as every video def spells it, so
`freezeFaceVideo` and the roster's own machinery reach it with no special case.

```ts
{ id: 'freeze', label: 'Freeze', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
// …
noUserControl: [
  { param: 'freeze', writer: 'internal',
    why: 'a VRT determinism hook — at >= 0.5 the scheduler tick returns before stepping the '
       + 'game, so the frog, the traffic, the timer and the HUD hold and the body repaints one '
       + 'frame. Required because the game clock is a Web Worker setInterval independent of the '
       + 'AudioContext, so suspending audio cannot stop it.' },
],
```

⚠ **The `noUserControl` declaration is not optional and not decoration.** Without it, `freeze`
is a SECOND turnable param and — on a module that currently has ONE — the Push card would go
from one encoder to two, the second one labelled *"stop the game"*. With it, three consumers
change at once: the group instrument bar never auto-exposes it, the Push card never ranks it,
and `module-face-lint`'s render-plan parity asserts it renders **exactly zero cells** — an
INVERTED assertion, which is what makes the claim falsifiable in both directions.

**5.2 NO rosters, NO landmarks, NO `units`.** Considered and refused:
- `landmarks` on `initialTime` at 60 (the upstream default): refused, because `defaultValue`
  already restores it on double-click — a gesture that costs nothing — and a landmark is a NAME
  for a position the dial already has.
- `units: 's'`: ⚠ refused for a sharper reason. A `format` on the param would make the readout
  PAINT (`paintsReadout` only survives when the text is an option/landmark NAME **and** the
  param declares no `format`). Declaring units here would re-introduce a resting decimal under
  the dial by the back door — mechanism five. The seconds go in `aria-valuetext` (§10).

⚠ **Attest cost of 5.1: ZERO** — frogger is not in the WebGL basis (§0). Contract-lock cost is
one `param` row.

---

## 6. BAND STRUCTURE — one band, one control, and that is the honest answer

```ts
pages: [
  // ONE band, ONE control. There is no second idea to page, and a page costs a
  // ~81px band header on a dock that folds at 720p. `order` and `pages` AGREE,
  // which is unusual for this house style and is stated so a reader does not go
  // hunting for the disagreement.
  { id: 'run', label: 'run', controls: ['initialTime'] },
],
```

**ONE band, so obviously no tab rail** (`DOCK_TAB_MIN_BANDS = 7`). ⚠ And `face.tabbed` is
**owner-instruction-only** and is not reached for here.

⚠ **Does a one-control band earn a header at all?** The rule is *"a page earns a header at ≥2
controls, or 1 that is the module's identity."* `initialTime` is not frogger's identity — the
BOARD is. So the honest reading is that the band label `run` is decoration, and the strongest
alternative is **one unlabelled band** (the `4plexvid` / `rasterize` shape: declare no
`face.pages` at all and let the dock render one unlabelled band). **This spec declares the
label anyway**, for one reason and it is worth stating: a single knob floating under a game
board with no section header reads as a stray control rather than a setting. §14.3 carries the
one-line revert.

**REAR CARD.** Re-derive it: all five inputs are `gate` with **no `paramTarget`** — they are the
module's real signal inputs, not CV holes for a ranked param — so the input rail gets no
page-derived section and would be uncurated. ⚠ **Author a `face.rear.groups` entry**:

```ts
rear: { groups: [
  { id: 'steer', ports: ['up_gate', 'down_gate', 'left_gate', 'right_gate'] },
  { id: 'start', ports: ['start_gate'] },
] },
```

so the rail says what the module is: four steering triggers and a restart, not five anonymous
gates. The output rail takes the derived default (all three are `gate`, one section).
MUST-VERIFY §15.3 against `rear-card-model.test.ts`.

---

## 7. THE BODY — `face.extension: 'frogger'`

### 7.1 Why a body and not a panel

A PF-14 `panel` cell would be the right seam for *one picture you edit inside the generic face*
— but **its first legal rank is 7 and frogger has one param**, so a panel can never be reached.
`fullViewBody` is the only route, and it is the right one anyway: the board is not a control, it
is the module's identity, and the body paints above the bands where an identity belongs.

```ts
// $lib/ui/modules/frogger/shell-extension.ts
import FroggerBoardBody from './FroggerBoardBody.svelte';
export default { fullViewBody: FroggerBoardBody } satisfies ShellExtension;
```

⚠ **Import `drawFrogger` from the def — do NOT re-implement it.** It is already a pure exported
function (`frogger.ts:324`) and the card already calls it; a second painter would be two
renderers for one picture and nothing would catch a divergence.

⚠ **AND DO NOT COPY THE CARD'S CALL SIGNATURE BLIND.** `FroggerCard.svelte:62` passes
`canvasEl.width/height` — the BACKING STORE at `DPR = 2`, i.e. 400×452 — into a function that
lays out in those same units and then draws its HUD at `'700 9px ui-monospace'`. Unlike pong
(whose `drawPong` documents its opts in CSS px and is therefore demonstrably called at the wrong
scale — that spec's §13.5), `drawFrogger` derives **every** dimension from the `w`/`h` it is
given (`cellPx = Math.floor(Math.min(w/14, gridH/13))`, `:337`), so the board itself scales
correctly. **Only the two font sizes and `HUD_H = 22` are absolute**, so at DPR 2 the HUD text
renders at ~4.5 CSS px and the HUD strip takes 11 CSS px instead of 22. ⚠ **That is a real,
smaller version of pong's bug and it is worth measuring rather than assuming** — MUST-VERIFY
§15.6. The body should pass CSS px and `ctx2d.scale(DPR, DPR)`, and if that changes the card's
appearance, fix the card in the same PR rather than shipping two boards at two HUD scales.

### 7.2 The zone map

```
┌─ dock full view ───────────────────────────────────────────┐
│ FROGGER                                            [ ✕ ]   │
├────────────────────────────────────────────────────────────┤
│   ┌───────── fullViewBody ─────────┐                        │
│   │ LIVES 5  LV 1  T 47   SCORE 60 │  ← HUD, INSIDE the     │
│   │ ▓▓░░▓▓░░▓▓░░▓▓  homes          │    canvas (§10.1)      │
│   │ ~~~ logs / turtles ~~~         │    200×226 CSS,        │
│   │ ▁▁▁ bank ▁▁▁                   │    DPR-correct         │
│   │ ══ cars ══  ══ lorry ══        │                        │
│   │ ▁▁▁ bank ▁▁▁      🐸  [SCREEN] │                        │
│   └────────────────────────────────┘                        │
├─ run ──────────────────────────────────────────────────────┤
│      ◉ TIME                                                 │
└────────────────────────────────────────────────────────────┘
```

**WIDTH.** A 200 px board and one knob column (40–68.8 px measured across the live dock).
**Nothing here earns a wide plate**, and the board must not be inflated to fill one — *"we do
not want useless gray horizontal space on cards, ever. prefer compact. screen real estate is
expensive!"* Expected plate: **~230–260 px**, among the narrowest in the fleet, which is the
correct outcome of the compact default rather than a defect. ⚠ MUST-VERIFY §15.4 against
`workflow-shell-faces.spec.ts`'s content-vs-plate leg, which cannot run locally without a
baseline.

### 7.3 The SCREEN switch — required by SPIRIT, invisible to the gate, and RIGHT here

`video-face-screen-source.test.ts` sweeps `listVideoModuleDefs()` only, so an audio-domain
module is structurally invisible to it. ⚠ **The 2026-08-18 owner ruling is about VIDEO
modules, and frogger is audio — so the ruling does not cover it and inventing a fleet rule is
not this spec's to make.** Ship it anyway, for a reason specific to this module: a rack can hold
several froggers, each repainting a 400×452 canvas every rAF, and a player who wants the gates
without the picture has no way to say so today. **Flagged as an owner question in the report,
not asserted as policy.**

Placement is a MEASUREMENT, not a taste: **OVERLAY the board's bottom-right corner on a
translucent backplate (`rgba(5,6,8,0.72)`), NEVER a row of its own** — the stacked row cost
spirographs ~18.8 px against ~11 px of slack and `io-spec-consistency` caught the overhang.
State on **`node.data.previewCollapsed`**, never component `$state` (the component unmounts on
dock collapse / LRU eviction — the #1531/#1574/#1583 class).

⚠ **SCREEN OFF here is UNUSUALLY SAFE, and saying why is the point.** The game runs on the
SCHEDULER, engine-side, subscribed in the factory — not in the card, not on rAF, not gated on
anything watching. So SCREEN OFF stops a `drawFrogger` call and **nothing else**: the timer
counts, the traffic moves, the frog dies, the gates fire. **Make that a permanent leg of the
face model test rather than a comment, because `skifree` — one module away in the same group —
does NOT have this property** (GAMES.md §5), and somebody will copy this one.

---

## 8. CONTROL INVENTORY — every primitive decision, argued

| face key | primitive | derivation | why not the alternative |
|---|---|---|---|
| `initialTime` | **`'knob'` — the GENERIC default, DECLARED NOTHING** | `paramCellKind` on a continuous linear param with no `options` → `'knob'` | ⚠ **This is the one place frogger and its siblings diverge, and it is PARITY that decides it.** `FroggerCard.svelte:96` renders a `<Knob>`; `ModtrisCard.svelte:88-89` renders `<NeonFader>`s. So modtris DECLARES `paramCells: 'fader'` and frogger declares nothing — each face matches its own card's primitive. **Declaring `'fader'` here to match the sibling would be a parity loss nothing gates**, and a player's muscle memory for a rotary would land on a vertical throw. |
| `initialTime` | landmarks: **NONE** | §5.2 | `defaultValue`'s double-click already restores 60. |
| `freeze` | **`noUserControl`** | §5.1 | Renders zero cells, asserted invertedly. |

**No `ShellActionCell`, no `ShellFileCell`, no `face.momentary`, no `hero`, no PF-14 panel, no
roster.** Frogger has no button on any surface and no discrete param. Recorded so a reviewer can
confirm the absence rather than infer it.

⚠ **One thing this module conspicuously does NOT get: a START button.** It is the obvious
missing affordance — `start_gate` is the only way to restart, and the auto-fire happens once per
module spawn, so **a player whose frog runs out of lives has no way to restart without patching
a cable.** That is a genuine usability hole, and it is refused here because it does not exist on
the card either: adding it is a **feature**, not a promotion. Recorded as a future PR with the
shape it wants: an `ShellActionCell` in the `run` band with
`probe: { effect: { kind: 'audition', seam: 'manual-strike' } }` and an AUDITION-LEDGER
observable — **not** a revision counter, because *"a revision-only probe passes on a dead button
that bumps the counter"*. ⚠ `getActiveEngine()` is already exported and already consumed from
plain `.ts`; **two independent agents have invented the false blocker that a shell-cells action
needs a platform PR to reach the engine. Assume a third will.**

---

## 9. THE STATE MATRIX

| # | steering gates | SCREEN | body paints | what a reviewer checks |
|---|---|---|---|---|
| 1 | nothing patched | ON | ⚠ **a LIVE, SELF-RUNNING game**: the boot auto-start fired, the frog sits at `(7,13)`, traffic moves, the timer counts down, and `dead_gate` fires every `initialTime` seconds | **the fresh-spawn state**, and it is a self-playing demo. Unusual and good — and it means the dock scene has a moving subject the instant it opens |
| 2 | a clock → `up_gate` | ON | the frog hops up one row per pulse, dies on the road or the river, `dead_gate` fires | the mock that shows the module's actual use |
| 3 | four gates, a lucky pattern | ON | homes fill; the 5th fires `home_gate` AND `level_gate` in the same tick — **`pulseGateNTimes` emits distinct staggered edges** | the module's most interesting output behaviour, and no surface shows it. ⚠ Not an argument for a readout (§10) |
| 4 | any | ON, `initialTime` moved mid-life | **the HUD's `T` does not change** | ⚠ **§13.1.** Reachable in five seconds by a user and by nothing in CI |
| 5 | any | **OFF** | nothing | ⚠ **the gates keep firing** (§7.3). The strongest single assertion in this spec |
| 6 | any | ON, `freeze = 1` | the last frame, held | the VRT state (§11) |
| 7 | lives exhausted | ON | `GAME OVER — START GATE TO RESTART`, centred, inside the canvas | ⚠ the state with **no way out from any surface** (§8's START-button note) |

---

## 10. THE ARIA CONTRACT — and the resting-text ruling

### 10.1 ⛔ THE SCORE ROW IS REFUSED BY NAME, AND FROGGER'S HUD IS ALLOWED

**The ruling** (GAMES.md §1): a game's score and lives painted INSIDE the playfield canvas are
ALLOWED; a score or lives row rendered as CHROME BESIDE the playfield is FORBIDDEN.

**Frogger is already on the allowed side, and this is stated rather than skipped because "the
HUD is fine" and "nobody looked at the HUD" are indistinguishable from the outcome.**
`drawFrogger`'s `hud` block (`frogger.ts:427-441`) paints `LIVES n  LV n  T n` at 4,6, `SCORE n`
right-aligned, and a centred `PRESS START` / `GAME OVER — START GATE TO RESTART` banner —
**all of it into the canvas, by the module's own pure function.** The face is not painting it;
the game is. It is the module's artwork, and it is part of the picture that earns the width.

⚠ **AND THE FACE ADDS NO CHROME ROW OF ITS OWN. REFUSED BY NAME.** No `LIVES 5` beside the
board, no `T 47` under the knob, no state word, no banner in the plate. That shape is the hero
readout strip (#1957) with a different label, and it is refused for the same reason: a labelled
derived value sitting at rest next to the thing it describes. Frogger's DOM chrome today is
exactly `<header class="title">FROGGER</header>` and nothing else, so **there is nothing to
delete** — which is worth recording, because `skifree` and `nibbles` in this same group each
have a row that does not survive.

⚠ **AND THE GATE CANNOT SEE EITHER SHAPE.** `face-resting-text-source.test.ts` names its own
blind spot: text drawn INTO a canvas is invisible to it, and a chrome row inside a
module-owned `fullViewBody` is not a `ModuleFace` field either. **This ruling is enforced by
the dock VRT baseline and a human reviewing it, and by nothing else.** Do not write "the gate
keeps this honest" in the PR body. The two honest mitigations are (a) the dock baseline contains
the body, so a chrome row shows in a diff, and (b) `frogger-face-model.test.ts` asserts the
body's DOM contains no text node outside the canvas — negative-controlled by temporarily adding
one.

### 10.2 The contract

| element | contract |
|---|---|
| the board canvas | `role="img"`, `aria-label="FROGGER — lives 5, level 1, 47 seconds, score 60"`. ⚠ Not `aria-valuetext`: a picture is not a range role (the `XyPad.svelte:317-330` conclusion). **This is where the painted HUD becomes speakable**, which is the accessibility half a canvas cannot supply — and it is what every spec proving the face tracks the game now reads. |
| the SCREEN button | `aria-pressed={!previewCollapsed}`, `SCREEN ON` / `SCREEN OFF`, and a `title` saying **the game keeps playing and the gates keep firing** (§7.3). |
| `control-initialTime` | `aria-valuetext`: `"60 s per life"`. ⚠ **AND, if §13.1 is fixed as specified, nothing more.** If §13.1 is NOT fixed, the honest string is `"60 s per life — applies at the next START"`, and shipping that is an admission that the module's only control lies. **Prefer the fix.** |
| every param cell | `data-testid="control-<paramId>"`; `faces-parity` asserts exact multiset equality against the def's param ids and scans the whole `dockShell` **including the body**. `freeze` must render **zero**. |

⚠ **Keyboard.** Owner ruling: no keyboard-a11y work, and none is proposed. Note the distinction
this group needs: frogger takes **no keyboard input at all** — its instrument is the gate cable.
`Knob`'s existing `role="slider"` keys are untouched. (`nibbles` is the one module here where
keys ARE the instrument, and that is a different thing from a11y — see its §10.)

---

## 11. DETERMINISM AND VRT — and it CLOSES A DEBT THE EXEMPTION NAMED

**Two new scenes** — `face-frogger-compact`, `face-frogger-dock` — added by hand to the `FACES`
roster in `workflow-shell-faces.spec.ts`. ⚠ Nothing ties that roster to `STRICT_FACES`; a
promoted module missing from it silently has no VRT scene.

⚠ **The compact scene has no picture** (§0), so it is a static one-knob tile and is
deterministic for free. **The dock scene carries the live board** and is not.

**`FACES_WITHOUT_SCENES` IS NOT AVAILABLE.** Its bar is *evidence that `simPin` AND `freeze`
cannot reach this renderer*. Here both can — they simply do not exist yet.

**`videoFaceWhy` MUST NOT BE DECLARED.** It is the video-zone boot selector first and the freeze
opt-in second; a `domain: 'audio'` module that declares it hangs in `bootWithFace`'s
channel-column wait. `rasterize` is the shipped precedent for exactly this combination — an
audio module with a JS-painted picture, a `fullViewBody`, a `simPin`, and no `videoFaceWhy`.

**The seam, and it is SMALLER HERE THAN ANYWHERE ELSE IN THE WAVE:**

1. **`freeze` (§5.1) stops the game.** The scheduler `tick` returns before stepping when
   `params.freeze >= 0.5`, so `state` stops changing and the body's rAF repaints an identical
   frame. ⚠ It must be in the **`tick`**, not in the body — a body-side freeze stops the picture
   while the game runs on, which is the difference between "frozen" and "not looking".
2. **`simPin` chooses WHICH frame — and frogger needs NO SEED.**
   `grep -n "Math.random\|rng\|seed" frogger-state.ts` → **zero hits.** There is no RNG anywhere
   in the stepper: the sprite table is a fixed clone (`cloneSprites`), the traffic is
   deterministic, and `dtSeconds` is a constant. **So the board is a pure function of TICK COUNT
   and the only nondeterminism is how many ticks elapsed before the capture.**

   ```ts
   // frogger.ts factory — read a page global at CONSTRUCTION (the simPin contract)
   const pin = (globalThis as { __froggerVrtTicks?: number }).__froggerVrtTicks;
   // when set: run exactly `pin` ticks synchronously at materialize, then latch
   // freeze so the scheduler subscription is a no-op. The captured frame becomes
   // a pure function of (pin, params) rather than of boot speed.
   ```

   ⚠ **`simPin` installs globals with `addInitScript`, so it reaches a factory that reads them
   AT CONSTRUCTION.** Frogger's factory is main-thread (no `renderLocus`), so the global is
   visible — unlike `acidwarp`, whose factory runs in a Worker with its own global scope.
   MUST-VERIFY §15.5.

⚠ **AND THIS PAYS A DEBT THE EXEMPTION ITSELF NAMED.** `vrt-exemptions.ts:766-768`:
*"Promote to a real VRT baseline once a deterministic-time test hook is added so the scene can
freeze the game at a known tick."* This PR builds it. **So the card-level `EXEMPT_FROM_VRT`
entry should be re-examined in the same PR** — and if it is dropped, `ALLOWED_PERMANENT_EXEMPT`
must lose frogger in the SAME commit (both lists are anchored in both directions). ⚠ **That is a
real ratchet payment and it is the best reason to do this module.** It also means the capture
bot commits **THREE** PNGs, not two — predict it and count them.

⚠ ⚠ **`--update-snapshots` CANNOT CREATE A BASELINE THAT ALREADY PASSES.** Dropping frogger from
`EXEMPT_FROM_VRT` makes `vrt.spec.ts` enrol it and the comparison fails as *"snapshot doesn't
exist"*, which is the state that writes. That is the correct route. Nothing needs `git rm`-ing —
and **`git status` for untracked PNGs after every local VRT run** in this window.

**Scope the dispatch.** `GREP=frogger flox activate -- task vrt:commit` — measured 41-56 min
unscoped against ~3 min scoped. ⚠ A bare dispatch on a face PR derives FULL, because every face
PR touches a shared roster file whose path names no module.

**CI wall-time.** `faces-parity` budgets ≈ `10 s + 0.8 s/cell`. **1 cell ⇒ ≈ 10.8 s**, plus two
face scenes and (if the exemption drops) one card scene. Well under the ~2 min threshold. ⚠ The
bespoke `frogger.spec.ts` already costs **24.6 s** and is untouched. **Re-pin BOTH cost
artifacts** (`e2e:timings:accept` AND `vrt:strict:timings:accept`) — an unmeasured `vrt-strict`
scene rides the median and has reddened `main` at 92 % of a shard budget with every test
passing.

---

## 12. COST

| item | cost |
|---|---|
| **WebGL attest** | **ZERO — VERIFIED.** No frogger file in the attest basis; `FroggerCard.svelte` is 2D-only. ⚠ **`FroggerBoardBody.svelte` must stay 2D** — a WebGL board would pull the module into the basis and put a GPU attest on every future edit. |
| **contract-lock** | **ONE new `param` row** (`frogger param freeze …`). `face` and `noUserControl` are not projected. Run `task docs:accept` and read the diff: **the only line that may move is that one.** Anything else is a finding. |
| **docs** | frogger is in `STRICT_DOCS` (`strict-docs.ts:303`), so `freeze` **needs a `docs.controls.freeze` entry** or completeness reddens. ⚠ Boy-scout while here: §13.1's latency caveat belongs in `docs.controls.initialTime`, which currently promises the timer ceiling with no caveat at all. |
| **ART** | **ZERO.** `ART_EXCLUDED` (`profile-coverage.ts:41`) and there is no `art/scenarios/frogger/` at all — ⚠ unlike `modtris`, which has one. Nothing to re-pin. |
| **Push 2** | No override ⇒ GENERIC today. A face moves it to the FACE tier, and with one turnable param the card is one encoder either way — **the least disruptive Push move in the wave.** ⚠ `freeze` must NOT appear; that is what `noUserControl` buys, and `push-card-schema`'s golden diff is where you confirm it. |
| **New code** | one `shell-extension.ts`, one `FroggerBoardBody.svelte` (importing `drawFrogger`, 2D only, DPR-correct), the `freeze` early-return + tick pin in the factory, one `STRICT_FACES` line, one `FACES` roster row with `simPin`, one `frogger-face-model.test.ts`. |
| **Conflict surface** | `strict-faces.ts` · `_shell-faces.ts` · `push-card-config.ts` golden · `vrt-exemptions.ts` (**two lists, one commit**) · `contract-lock.txt` (GENERATED — take main and re-run the accept task, never hand-merge). |

---

## 13. DEFECT LEDGER

Per CLAUDE.md nobody opens issues: each of these is fixed **inside this PR**, scoped honestly,
with the story in the PR body.

**13.1 — ⚠ THE MODULE'S ONLY CONTROL DOES NOTHING UNTIL THE NEXT START.** `params.initialTime`
is read at exactly two sites, both constructors: `initFroggerState` (`frogger-state.ts:313`) and
`startGame` (`:336`). `handleDie` (`:472`) restores `state.time = state.defaultTime` and
`handleLevelComplete` (`:481-483`) sets `state.defaultTime = Math.max(LOWEST_TIME,
state.defaultTime - 5)` — both from a SNAPSHOT taken at start. So moving TIME mid-game changes
nothing until a `start_gate` rising edge, and after a few levels the knob's value is not even
the current ceiling. `docs.controls.initialTime` (`frogger.ts:124-126`) promises the countdown
ceiling with no caveat, and `readLive` reports the new value immediately while the game keeps
the old one. **Severity: fold into this PR.** This face has ONE control; shipping a face whose
only control appears dead is worse than not shipping the face. Fix: apply `params.initialTime`
to `state.defaultTime` on change (preserving the per-level decay as a DELTA from the new
ceiling, not from the old one), and pin it with a stepper leg that fails on the old code.

**13.2 — the HUD renders at ~4.5 CSS px because the card passes backing-store dimensions.**
`FroggerCard.svelte:62` calls `drawFrogger(ctx2d, snap, canvasEl.width, canvasEl.height)` =
400×452 at `DPR = 2`, and never applies `ctx2d.scale(DPR, DPR)`. `drawFrogger` derives the board
geometry from `w`/`h` so the grid scales correctly — **but `HUD_H = 22`, `'700 9px
ui-monospace'` and `'700 11px ui-monospace'` are absolute** (`:332`, `:429`, `:438`). At DPR 2
the HUD strip is 11 CSS px tall and its text ~4.5 CSS px. There is **no pixel test at all**,
because frogger is `EXEMPT_FROM_VRT`. ⚠ **The body must NOT copy the card's call**, and after
§11 there IS a pixel test — the first thing that could ever have caught this. **Severity: fold
in**; fix the card in the same PR so there are not two boards at two HUD scales.

**13.3 — the card re-types three range literals and NOTHING checks them.**
`FroggerCard.svelte:98`: `min={10} max={120} defaultValue={60}` — **while importing `froggerDef`
and using `froggerDef.params[0]!.defaultValue` three lines earlier** (`:33`). `card-kit.ts`
exports `paramSpec` for exactly this; `grep -c paramSpec FroggerCard.svelte` → 0. Frogger is not
in `RANGE_BOUND_CARDS`, whose own stated scope is *"every card NOT in this set is unchecked"*.
They agree today; nothing holds them there. **Severity: fold in** (use `paramSpec`, enrol the
card). Cheap, boy-scout, and the backdraft class verbatim.

**13.4 — `FroggerCard` uses a bare `<header>` instead of `<ModuleTitle>`, so it has no rename
and no control-colour dot.** `:82` against `ModtrisCard.svelte:74`, `SkifreeCard.svelte:178` and
`NibblesCard.svelte:132`, all of which use `<ModuleTitle {id} {data} defaultLabel=…>`. Frogger is
the only one of the four without a renameable label. Nothing gates the divergence. ⚠ **The
promotion FIXES it incidentally** (the shell paints its own title bar), so the honest move is to
record it as a gain rather than fix the card that is about to stop rendering. **Severity: note.**

**13.5 — the lane tile is a dead placeholder and no test has ever looked.** §0 in full. Not in
`NON_SHELL_LANE_TYPES`, not in `STRICT_FACES`, not a `CARD_PRODUCER` ⇒ `'placeholder'`, no card,
no board. **Every frogger e2e drives `?shell=legacy`** (`frogger.spec.ts:68`; the `rack` fixture
is `?shell=legacy` by construction). This spec closes it at the dock and leaves it open at the
lane until the glyph widening lands. **Severity: report as the group-level platform finding**
(GAMES.md §2.2) — it is now the sixth module on the same seam.

**13.6 — `vizPassthrough: true` is a lie, and two surfaces advertise it.** GAMES.md §8.1 in
full: `frogger.ts:82` declares it and `docs.explanation` (`:105`) tells the user the canvas *"can
be portaled into a containing GROUP card for cross-domain video"*, but `GROUP_VIZ_HOST_TYPES` is
`new Set(['scope'])`. MEASURED in the tree: `group-viz-hosts.test.ts:104` — *"canvasInSlot 0 for
frogger/modtris/pong against SCOPE's 1"*, tracked as #1755, with the reverse assertion
deliberately withheld. **Severity: report — it is a CLASS across four modules, not a frogger
bug.**

**13.7 (minor) — `face-migration-inventory.ts:812` describes a module that does not exist.**
*"a GAME viewport driven by the keyboard"* — `FroggerCard.svelte` has **no keyboard handler of
any kind**; the module is driven entirely by gate CV, which is the whole point of its design and
is spelled out at length in its own header. Fix the string in this PR. GAMES.md §8.6.

---

## 14. TASTE CALLS, EACH WITH ITS ONE-LINE REVERT

1. **`freeze` + a tick pin rather than `FACES_WITHOUT_SCENES` (§11).** Revert: none defensible —
   the exemption's own bar refuses it. Recorded so the shortcut is not attempted.
2. **`'knob'`, not `'fader'` (§8).** Revert: declare `paramCells: { initialTime: 'fader' }` and
   match modtris. Consequence: the face silently stops matching frogger's own card primitive,
   which is a parity loss nothing gates.
3. **A LABELLED one-control band (§6).** Revert: drop `face.pages` entirely and let the dock
   render one unlabelled band (`4plexvid` / `rasterize` shape). Consequence: a single knob
   floating under a game board reads as a stray control. ⚠ Note the roster count changes with
   it: `pages: 1` either way, but for different reasons.
4. **A SCREEN switch on an AUDIO module (§7.3).** Revert: drop it — the owner ruling covers video
   modules and frogger is audio, so nothing requires it. Consequence: no way to stop N canvases
   repainting. **Raised as an owner question rather than decided here.**
5. **No START button (§8).** Revert: it is a feature PR, not a revert. ⚠ But note the state
   matrix row 7: GAME OVER currently has no exit from any surface without a patch cable.
6. **Dropping the card's `EXEMPT_FROM_VRT` entry in the same PR (§11).** Revert: keep both lists
   and capture only the two face scenes. Consequence: the module keeps a permanent exemption
   whose own stated promotion condition this PR has just satisfied — which is how a temporary
   exemption becomes permanent.

---

## 15. MUST-VERIFY

1. **The tier ladder**, derived through `curatedFace`, not the cap constants.
2. **One `'knob'` cell and the plate's width** — `cellWidthClass` is deny-by-default `'wide'`,
   so measure rather than assume.
3. **`rear-card-model`** — the `steer` / `start` input groups resolve, and the five gate inputs
   (which have no `paramTarget`) do not orphan.
4. **Plate width ≤ pane width** — needs a baseline; the first `vrt:commit` IS the measurement.
5. **`simPin` reaches the factory** — the global must be readable at CONSTRUCTION. Prove it:
   **three consecutive dock captures pixel-identical, AND a fourth with a DIFFERENT tick pin that
   is visibly different.** A pin that changes nothing is indistinguishable from a pin that never
   ran.
6. **The DPR question (§13.2)** — measure the rendered HUD font in CSS px before and after,
   both on the card and in the body, and state the units in the assertion message.
7. **SCREEN OFF leaves the gates firing** — a downstream counter on `dead_gate` before and after
   a collapse window. ⚠ The single most valuable assertion in this spec, because it is the
   property `skifree` does NOT have.
8. **`freeze` renders exactly ZERO cells** in both `module-face-lint` and `faces-parity`, and
   does not appear on the Push golden.
9. **§13.1's fix is negative-controlled BOTH ways** — moving TIME mid-life must change the
   HUD's `T` ceiling on the next life, AND the per-level −5 s decay must still apply from the
   NEW ceiling rather than the old one.
10. **If the card's `EXEMPT_FROM_VRT` entry is dropped**, `ALLOWED_PERMANENT_EXEMPT` loses
    frogger in the SAME commit, and the capture commits THREE PNGs, not two.
11. **The body contains NO text node outside the canvas** (§10.1) — the only mechanical check
    available for the resting-text ruling on this surface, and it must be negative-controlled by
    temporarily adding one.

---

## 16. VERIFICATION GATE

```sh
# 1. the pure model + this face's PERMANENT negative controls (§9 rows 5/6, §10.1's no-chrome leg)
REPEAT=3 flox activate -- task test:one -- frogger-face-model
# 2. the stepper, because §13.1 changes it
REPEAT=3 flox activate -- task test:one -- frogger-state
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
flox activate -- task test:one -- push-card-schema         # freeze must NOT appear
flox activate -- task test:one -- card-range-source        # after §13.3
flox activate -- task test:one -- module-docs-lint         # docs.controls.freeze is REQUIRED
flox activate -- task test:one -- vrt-meta                 # the two exemption lists stay anchored
flox activate -- task test:one -- group-viz-hosts          # §13.6 touches its comment only
# 6. the contract diff must contain ONLY `frogger param freeze`
flox activate -- task docs:accept && flox activate -- git diff
# 7. ART — NIL. frogger is ART_EXCLUDED and has no scenario directory.
# 8. e2e
flox activate -- task e2e:serve
REPEAT=3 flox activate -- task e2e:one -- tests/faces-parity.spec.ts
REPEAT=3 flox activate -- task e2e:one -- tests/frogger.spec.ts
REPEAT=3 flox activate -- task e2e:one -- tests/faceplate-platform.spec.ts
flox activate -- task e2e:stop
# 9. typecheck LAST — svelte-check is stricter than vitest
flox activate -- task typecheck
# 10. VRT: SCOPED dispatch only. Predict the file count (2 face scenes, +1 card scene if the
#     exemption drops) and COUNT what the bot commits against the prediction.
GREP=frogger flox activate -- task vrt:commit
# 11. re-pin BOTH cost artifacts against the newest run, and review both diffs
flox activate -- task e2e:timings:accept -- <run>
flox activate -- task vrt:strict:timings:accept -- <run>
# 12. attest: NIL for this module — nothing to run.
```

**The negative controls, spelled out so a builder cannot ship a green stub:** a DIFFERENT
`__froggerVrtTicks` must produce a visibly different dock capture; SCREEN OFF for N frames must
leave a downstream `dead_gate` counter STILL INCREMENTING; `initialTime` 60 → 20 must change
`control-initialTime`'s `aria-valuetext` AND (after §13.1) the HUD's `T` ceiling on the next
life; adding a `<span>LIVES 5</span>` to the body must turn §10.1's leg RED.

## 17. BUILD-COST ESTIMATE

| phase | estimate |
|---|---|
| `freeze` param + `noUserControl` + the `tick` early-return + `docs.controls.freeze` | ~1 h |
| the tick pin in the factory (§11) — **no seed needed, which is the saving** | ~1 h |
| `shell-extension.ts` + `FroggerBoardBody.svelte` (importing `drawFrogger`, DPR-correct) | ~2 h |
| §13.1 (initialTime applies live) — **stepper change, own commit** | ~1.5 h |
| §13.2 card-side DPR, §13.3 `paramSpec` + `RANGE_BOUND_CARDS`, §13.7 inventory string | ~1.5 h |
| `frogger-face-model.test.ts` + the stepper leg for §13.1 | ~2 h |
| roster/registry edits, exemption-list decision, push golden, `rear.groups` | ~1 h |
| gate loop, 3× flake checks, typecheck | ~2 h |
| VRT dispatch + the tick-pin negative control | ~1.5 h wall |
| **total** | **≈ 13.5 h** |

**Risk rank: LOW-MEDIUM — the lowest in the wave.** One knob, one band, one body, no RNG to
seed, no attest, no ART, no shared-fixture precursor. The only real work is the determinism seam
and one stepper fix, and both are small and both are worth paying. ⚠ **If the wave needs a fast
module, this is it — and it closes a named ratchet on the way.**
