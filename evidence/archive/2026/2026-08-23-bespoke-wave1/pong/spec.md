# FACEPLATE BUILD SPEC — `pong` (audio, a CV-steered arcade game)

> **SPEC + MOCKS. Nothing here is implemented.** Authored to the bar of
> `.myrobots/plans/face-redo-dx7.md` and `.myrobots/2026-08-22-quadralogical-face-mocks/spec.md`.
> The HERO READOUT STRIP and the SIDEBAR are **not reproduced** — both mechanisms were
> deleted fleet-wide on 2026-08-19 (#1957). §10 (the ARIA CONTRACT) replaces them.
>
> **Mocks:** `dock.html` · `lane-tiers.html` (open in a browser; self-contained).
>
> **Figure labels** — `DERIVED-BY-READING` · `MEASURED` · `MUST-VERIFY` (re-listed in §15).

**Verdict: PROMOTE — but this face is a DETERMINISM PR wearing a faceplate, and that is the
finding.** The controls are three faders and the mapping is trivial. What is not trivial is
that **the court only exists on the card**, and under the shipping shell the card is not
mounted anywhere — so a player in workflow mode is already looking at a blank grey tile for a
GAME. The face fixes that at the dock. Making it fix it *and* be capturable requires a
determinism seam this module does not have — and building that seam **closes the promotion
condition its own VRT exemption already names** (`vrt-exemptions.ts:696-700`: *"until either
(a) a deterministic-time test harness is added so VRT can freeze the ball at a known
position…"*).

Along the way the audit found **a control that does nothing until the ball goes out**, **an
unbounded velocity accumulator with no clamp**, and **a whole advertised feature that is
inert in the shipping product**. §13.

---

## 0. THE CONSTRAINT MAP, READ FIRST

| registry | member? | what it means here |
|---|---|---|
| `NON_SHELL_LANE_TYPES` (`legacy-fallback.ts:80-98`) | **NO** | the lane swaps. `laneRenderKind` returns **`'placeholder'`** today. |
| `CARD_PRODUCER_LANE_TYPES` (`dom-source-modules.ts:187-194`) | **NO — and CORRECTLY so** | the set is DERIVED by a grep gate over card sources for `attachExternalSource` / `write(node,…)`. `PongCard.svelte` has neither: it *reads* `eng.read(node,'snapshot')` and paints. **Nothing engine-visible depends on the card being mounted.** |
| `HEADLESS_MOUNT_LANE_TYPES` | **NO** | `needsHeadlessSourceMount` returns `false` at its first line. **So the card is simply NOT MOUNTED under the shell.** |
| `EXEMPT_FROM_VRT` (`vrt-exemptions.ts:701`) | **YES** | *"animated game state defeats deterministic capture; unit + ART + E2E provide coverage"* |
| `ALLOWED_PERMANENT_EXEMPT` (`:1116`) | **YES** | ⚠ anchored in both directions — removing one without the other is RED. |
| `STRICT_FACES` | **NO** | un-migrated. |
| `PUSH_CARD_CONTROLS` | **NO** | GENERIC tier; three params, so all three get encoders and a face moves it to the FACE tier. |
| `RANGE_BOUND_CARDS` | **NO** | so the card's six re-typed range literals are **unchecked** (§13.4). |
| `face-migration-inventory.ts:818-822` | **`bespoke-surface`, NO BLOCKERS** | *"a GAME: a paddle viewport with CV taps; the faders beside it are not the module."* |
| WebGL attest basis | **NO — VERIFIED** | `webgl-attest-hash.sh --list` (218 files) contains no `pong` file. `PongCard.svelte` calls only `getContext('2d')`, so the mechanical card sweep misses it. **Editing pong is attest-transparent.** |

### ⚠ THE ONE FACT THAT DEFINES THIS FACE: THE COURT IS ON THE CARD, AND THE CARD IS GONE

`drawPong` (`pong.ts:245-289`) is a pure function; the CARD calls it every rAF
(`PongCard.svelte:56`) reading `eng.read(node, 'snapshot')`. The game itself runs engine-side
on the shared scheduler clock at **40 Hz** (`pong.ts:184`, `SCHEDULER_TICK_MS = 25`), so it
keeps playing and the gates keep firing whether or not anything is mounted.

**So under the shipping shell, today, on `main`:** the lane tile is a `ModuleShellPlaceholder`
— no court, no score, no faders — while the game runs, scores, and pulses `score_left` /
`score_right` into whatever is patched. **Every pong e2e drives `?shell=legacy`**
(`pong.spec.ts:58`), so nothing in the suite has ever observed this. That is §13.8, and it is
the reason to promote rather than a cost of promoting.

### ⚠ AND THE LANE STILL WILL NOT HAVE A COURT — the same platform gap `timelorde` hits

`hasVideoSurface(def)` is `domain === 'video'` (`module-shell-model.ts:177-179`); pong is
`domain: 'audio'`, so **no `VideoTileThumb`**. And both outputs are `type: 'gate'`, so
`primaryAudioOutPortId` returns null (`shell-glyph-live.ts:95-97`) and **every glyph literal
except `'none'` resolves `{kind:'static'}`** and reddens the dead-glyph clause.

So the face declares `glyph: 'none'` and **the lane tile is three faders and no picture.**
`ShellExtension.glyph` exists but renders only under `binding.kind === 'algorithm'`
(`ModuleShell.svelte:1372-1391`), and `glyphBinding`'s `'algorithm'` branch requires an
`algorithm` param. The widening is already prescribed in the file's own comment
(`shell-glyph-live.ts:83-88`: *"do NOT add a third glyph literal: widen THIS branch to carry a
layout-source id"*).

⚠ **THIS IS THE SECOND MODULE IN THIS WAVE TO HIT IT** (`timelorde` §13.2 is the first), and
they are two of five affected modules — `scope`, `rasterize` and `wavesculpt` are the others.
**Report it as a wave-level platform finding, not a per-module footnote.**

---

## 1. WHAT THE MODULE IS FOR

**In one paragraph.** PONG is not a game with CV bolted on; it is **a two-input, two-output
signal processor whose transfer function happens to be a game of pong**. Patch a slow LFO into
each paddle and you have a rhythm generator whose period is a function of geometry rather than
of a clock — the gates fire when the ball gets past a paddle, which is a *derived* event, not a
divided one. The verb a player performs is **RIG THE MATCH**: you do not play it, you set the
conditions (how fast the ball is, how big the paddles are, how wildly it serves) and then patch
things to steer and to listen. The court is a *readout of a physical system*, which is why it
is the module's identity and not decoration.

**The chain, in execution order** (`pong.ts:118-224` + `pong-state.ts`):

1. **The clock.** `getSchedulerClock().subscribe(tick)` — `pong.ts:184`. `TICK_MS = 25` ⇒ **40 Hz**.
   ⚠ `dtSeconds = SCHEDULER_TICK_MS / 1000` is computed **once** (`:172`) and never measures
   real elapsed time. **The game is a pure function of TICK COUNT**, not of wall clock — which
   is the property §11 is built on, and it is already true today.
2. **CV in.** Two `AnalyserNode`s at `fftSize = 32`, `smoothingTimeConstant = 0`
   (`:123-125`, `:132-134`); each read takes the **tail sample only**
   (`buf[buf.length - 1] ?? 0`). Mapped `paddleCvToY(cv) = clamp01(0.5 + cv·0.5)`
   (`pong-state.ts:105-110`) — so **−1 = top, 0 = centre, +1 = bottom.**
   ⚠ These are analyser taps, **not AudioParams** — so there is no cv-scale fast path, recorded
   deliberately at `cv-scale-registry.test.ts:130-134` (*"the CV doesn't modulate any knob, it
   IS the paddle position"*).
3. **The step** (`stepPongState`): integrate → wall bounce → paddle collision + english → score
   detect → serve-and-stamp.
4. **Gate out.** Two `ConstantSourceNode`s; on a score, `pulseGate` schedules
   `setValueAtTime(1, t)` / `setValueAtTime(0, t + GATE_PULSE_S)` with
   `GATE_PULSE_S = 0.005` and `SCHEDULE_CUSHION_S = 0.005` (`:149-157`, `:57`, `:62`).
5. **The picture.** The card's rAF reads the snapshot and calls `drawPong`.

**What each control genuinely changes.**

| param | read at | effect | hazard |
|---|---|---|---|
| `speed` (0.25..4 log) | `pong-state.ts:89` — **inside `resetState` ONLY** | `speed = BASE_SPEED · params.speed` where `BASE_SPEED = 0.55` field-widths/s | ⚠ **§13.2 — moving it mid-rally changes NOTHING until the next serve**, and with tracking paddles the rally never ends |
| `paddleH` (0.05..0.5) | the collision test, **every step** | paddle height as a fraction of the court | none — the one control that acts on the frame you turn it |
| `serveAngle` (0..1) | `resetState:87-88` | `maxAngleRad = (π/4)·serveAngle`; `angle = (rng()−0.5)·2·maxAngleRad` | ⚠ at 0 the serve is exactly horizontal (`‖ballVY‖ < 1e-9`, pinned at `pong-state.test.ts:64-67`) — a **degenerate, perfectly repeatable** rally |

**Hidden constants no surface shows:** `BASE_SPEED = 0.55` (`pong-state.ts:49`),
`BALL_RADIUS = 0.012` (`:123`), `INITIAL_SERVE_DIR = 1` (`:53`), the english kick
`vy += offset · BASE_SPEED · 0.4` (`:164`, `:171` — **and §13.3 is about that expression**),
`GATE_PULSE_S = 0.005`, `SCHEDULE_CUSHION_S = 0.005`.

---

## 2. STOP 1 — is promoting this module a PARITY LOSS?

**No, and the comparison to #2065 is the whole argument, so it is made explicitly.**

`spectrograph` was REFUSED because *"its headline feature is a live scrolling sonogram the card
draws on its own canvas … an audio-domain module with `mono-video` ports has no engine surface
for the shell to paint; the face would be one GAIN knob and a static glyph."* Pong is the same
shape — **an audio-domain module whose headline feature is a card-drawn canvas.**

**Three things make it a PROMOTE rather than a refusal, and any one of them missing would flip
the verdict:**

1. **The alternative is not the card — it is a BLANK TILE.** spectrograph's refusal compared a
   face against a working card in the lane. Pong has no card in the lane today (§0), so
   promotion is measured against grey, not against a sonogram.
2. **`fullViewBody` gives the court a real home at the dock**, and it is WIRED
   (`shell-extensions.ts:124`, `ModuleShell.svelte:1453`). spectrograph's refusal predates
   nobody using it for an audio module; it is available and this is a legitimate use.
3. **Three ranked params, so no tier resolves to zero** — the #1974 `joystick` bar is cleared
   with room.

⚠ **What is honestly WORSE than the card, and must be said rather than absorbed:** the dock
court is reachable only by EXPANDING. The card put a court in the lane; the face puts one in
the dock. Until the §0 glyph widening lands, **a rack full of pongs is a rack of blank tiles**
— which is what ships today, so it is not a regression, but it is not the fix either. Recorded
as the wave-level platform finding.

---

## 3. STOP 2 — does every way of getting DATA IN survive?

```sh
grep -nE '<button|<select|<input|oncontextmenu|manualTrigger|Toggle|Selector|accept=' \
  packages/web/src/lib/ui/modules/PongCard.svelte
```
**Zero hits.** Every interactive element comes from three shared components.

| # | affordance | site | after promotion |
|---|---|---|---|
| 1 | `<ModuleTitle defaultLabel="PONG">` — rename + control-colour dot | `:76` | **YES** — the shell's own title bar |
| 2 | `<PatchPanel>` — all four jacks, drill-down, unpatch menu, card flip | `:78-94` | **YES** — the shell paints its own |
| 3 | SPEED `NeonFader` | `:90` | **YES** — rank 1, `paramCells: { speed: 'fader' }` (§8) |
| 4 | PADDLE `NeonFader` | `:91` | **YES** — rank 2, fader |
| 5 | SERVE `NeonFader` | `:92` | **YES** — rank 3, fader |
| 6 | per-fader right-click → MIDI learn / Send to Control Surface / Send to Electra ▸ Row ▸ knob / clear automation | `NeonFader.svelte:420` | **YES** — the shell renders the same `<NeonFader>` |
| 7 | per-fader drag / dbl-click-to-default / wheel / `role="slider"` keys | `:415`, `:421-423` | **YES** |
| 8 | the 200×140 court canvas | `:80-87` | **YES via `fullViewBody`** (§7). ⚠ dock-only. |
| 9 | `data-viz-passthrough` on the canvas (`:85`) | — | ⚠ **NOTHING IS LOST, because it does nothing today.** §13.1 |

**No `node.data` state, no button, no dropdown, no file input, no keyboard handling on the card
itself, no `mutateNode`.** The card's only write is `setNodeParam` for rows 3–5. STOP 2 is
satisfied by three fader cells and one body.

---

## 4. THE RANK — `face.order`

| # | key | why it earns this rank — an argument that would be WRONG for a different module | what it costs below |
|---|---|---|---|
| 1 | `speed` | **It is the module's TEMPO, and on a module whose outputs are gates that is rank 1 by definition.** Everything downstream of `score_left`/`score_right` is being clocked by how long a rally takes, and `speed` is the only control that scales that directly. ⚠ **And it is ranked 1 DESPITE §13.2** — the argument for ranking is what the module IS, not what a bug currently makes it feel like. Ranking around a defect you are fixing in the same PR bakes the defect into the UI permanently. | evicts `paddleH` from mini |
| 2 | `paddleH` | **The strongest runner-up in this wave, and it nearly won on a measurement.** It is the ONLY param read every step rather than only at `resetState`, so it is the only one whose effect is visible on the very next frame and applies to the rally in progress. On a module you *watch*, "acts now" is a real claim. It loses because it changes the game's DIFFICULTY, not its RATE, and a rack cares about rate. | — |
| 3 | `serveAngle` | Genuinely third: it does nothing to a rally already in flight and its effect is statistical rather than immediate — you have to watch several serves to see it. ⚠ Its 0 endpoint is a degenerate horizontal serve (`pong-state.test.ts:64-67`), which is a *feature* for a repeatable rhythm and a trap for anyone who wanted variety. | — |
| — | `freeze` | **NOT RANKED — `noUserControl`, `writer: 'internal'`.** New in this PR; §11. |

**THE TIER LADDER, read back as a sentence.** With `glyph: 'none'` the caps are the glyph-less
column (`curated-face.ts:62-79`): **at mini you get SPEED; at compact, SPEED and PADDLE; at
plate and above, all three; at the dock, all three plus the court.** ⚠ **MUST-VERIFY §15.1** —
derive it through `curatedFace`, never from `LANE_PLATE_MAX_CELLS`; four sibling faces got that
wrong.

**THE LOSER, NAMED.** `paddleH` lost mini to `speed` for the rate-vs-difficulty reason above,
and the revert is one swap (§14.2). `serveAngle` lost to both because a control you must watch
three serves to evaluate is not a control a 46 px lane column can serve.

---

## 5. VOCABULARY CHANGES — one new param, and no roster

**5.1 `freeze` — a new `0..1 discrete` param, `noUserControl`, `writer: 'internal'`.**
Required by §11 and nothing else. It is the fleet-standard determinism hook, spelled exactly
as every video def spells it, so `freezeFaceVideo` reaches it with no special case
(`_shell-faces.ts:3573-3583` writes `params.freeze = 1` and then **verifies every canvas in the
page holds still** — it is domain-agnostic, opt-in per roster entry via `videoFaceWhy`).

```ts
{ id: 'freeze', label: 'Freeze', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
// …
noUserControl: [
  { param: 'freeze', writer: 'internal',
    why: 'a VRT determinism hook — at >= 0.5 the scheduler tick returns before stepping the '
       + 'game, so the ball, the paddles and the score hold and the card repaints one frame.' },
],
```

⚠ **The `noUserControl` declaration is not optional and not decoration.** Without it, `freeze`
is a fourth turnable param and the GENERIC → FACE Push tier would offer *"stop the game"* under
an encoder — the exact defect `lushgarden` has today (that spec's §13.1). With it, three
consumers change behaviour at once: the group instrument bar never auto-exposes it, the Push
card never ranks it, and `module-face-lint`'s render-plan parity asserts it renders **exactly
zero cells** — an INVERTED assertion, which is what makes the claim falsifiable in both
directions.

**5.2 NO rosters, NO landmarks, NO `units`.** Considered:
`landmarks` on `speed` at 1.0 (the unity multiplier) is the most defensible candidate in the
wave — `BASE_SPEED · 1` is the tuned baseline and a player genuinely navigates back to it.
**Refused** because `defaultValue` already restores it on double-click, which is a *gesture*
that costs nothing, and a landmark is a *name* for a position the dial already has. No param
here is discrete, so `options` does not apply.

⚠ **Attest cost of 5.1: ZERO — pong is not in the WebGL basis (§0).** Contract-lock cost is one
`param` row. That asymmetry is worth noticing: **this is exactly the def edit that would be
expensive on `lushgarden` and is free here**, and it is why the determinism seam is affordable
on this module.

---

## 6. BAND STRUCTURE — one band, and that is the honest answer

```ts
pages: [
  // ONE band. All three params are the same idea — THE RULES OF THE MATCH, set
  // before you patch anything — and splitting them would be inventing a
  // distinction the module does not have. A page is a different IDEA; three
  // faders that all answer "how hard is this game" are one.
  //
  // ⚠ `order` and `pages` AGREE here, which is unusual and is stated so a reader
  // does not go looking for the disagreement the house style usually carries. On
  // a three-param module priority order and function order are the same list.
  { id: 'match', label: 'match', controls: ['speed', 'paddleH', 'serveAngle'] },
],
```

**ONE band, so obviously no tab rail.** Do not add a second page to get a second header —
*"do not add a page just to get a header"*, and a page costs a ~81 px band on a dock that folds
at 720p.

⚠ **Three `'fader'` cells in one band: is the band packable?** `cellWidthClass`
(`dock-row-plan.ts:115`) is **deny-by-default ⇒ `'wide'` for anything it cannot resolve**, and a
fader is not a knob column. With one band the question is moot for packing, but it decides the
plate's WIDTH. **MUST-VERIFY §15.2.**

**REAR CARD.** Re-derive it: `paddle_left` and `paddle_right` are `cv` inputs with **no
`paramTarget`** (`pong.ts:76-77`) — they are not CV holes for a ranked param, they are the
module's real signal inputs. So the input rail gets no page-derived section and the whole rail
is uncurated. ⚠ **Author a `face.rear.groups` entry `{ id: 'paddles', ports: ['paddle_left',
'paddle_right'] }`** so the rail says what the module is: two steering inputs, not two
modulation destinations. The output rail takes the derived default (both are `gate`, one
section). MUST-VERIFY §15.3 against `rear-card-model.test.ts`.

---

## 7. THE BODY — `face.extension: 'pong'`

### 7.1 Why a body and not a panel

A PF-14 `panel` cell would be the right seam for *one picture you edit inside the generic
face* — but **its first legal rank is 7 and pong has three params**, so a panel can never be
reached. The `fullViewBody` is the only route, and it is the right one anyway: the court is not
a control, it is the module's identity, and the body paints above the bands where an identity
belongs.

```ts
// $lib/ui/modules/pong/shell-extension.ts
import PongCourtBody from './PongCourtBody.svelte';
export default { fullViewBody: PongCourtBody } satisfies ShellExtension;
```

⚠ **Import `drawPong` from the def — do NOT re-implement it.** It is already a pure function
(`pong.ts:245-289`) and the card already calls it; a second painter would be two renderers for
one picture, and nothing would catch a divergence.

### 7.2 The zone map

```
┌─ dock full view ──────────────────────────────────────────────────────┐
│ PONG                                                          [ ✕ ]   │
├───────────────────────────────────────────────────────────────────────┤
│   ┌───────────────── fullViewBody ─────────────────┐                   │
│   │  ┌──────────────────────────────────────────┐  │                   │
│   │  │ 3                              2         │  │  the court        │
│   │  │ ▌            ·                       ▐   │  │  200x140 CSS,     │
│   │  │              ·                           │  │  DPR-correct      │
│   │  │                             [SCREEN ON]  │  │  (see 13.5)       │
│   │  └──────────────────────────────────────────┘  │                   │
│   └────────────────────────────────────────────────┘                   │
├─ match ───────────────────────────────────────────────────────────────┤
│      ▮ SPEED          ▮ PADDLE          ▮ SERVE                        │
│      ▮                ▮                 ▮                              │
└───────────────────────────────────────────────────────────────────────┘
```

**WIDTH.** A 200 px court and three fader columns. **Nothing here earns a wide plate**, and the
court should not be inflated to fill one — *"we do not want useless gray horizontal space on
cards, ever. prefer compact."* ⚠ MUST-VERIFY §15.4 against
`workflow-shell-faces.spec.ts`'s content-vs-plate leg, which cannot run locally without a
baseline.

### 7.3 The SCREEN switch — required by SPIRIT, invisible to the gate, and RIGHT here

`video-face-screen-source.test.ts` sweeps `listVideoModuleDefs()` only, so an audio-domain
module is structurally invisible to it (the same blind spot `timelorde`'s spec records).
**Ship it anyway**, for a reason specific to this module: a rack can hold several pongs, each
repainting a canvas every rAF, and a player who wants the gates without the picture has no way
to say so today.

Placement is a MEASUREMENT: **OVERLAY the court's bottom-right corner on a translucent
backplate (`rgba(5,6,8,0.72)`), NEVER a row of its own** — the stacked row cost spirographs
~18.8 px against ~11 px of slack. State on `node.data.previewCollapsed`, never component
`$state`.

⚠ **SCREEN OFF here is UNUSUALLY SAFE, and saying why is the point.** On every video adopter,
collapsing risks tearing down a producer (#1720/#1721) and the mark that keeps the pull chain
alive (#1937/#2015). **Neither applies to pong**: the game runs on the SCHEDULER, engine-side,
subscribed in the factory — not in the card, not on rAF, and not gated on anything watching.
So SCREEN OFF stops a `drawPong` call and **nothing else**. The gates keep firing.
Make that a permanent leg of the face model test rather than a comment, because the *next*
audio module with a body will not have this property and someone will copy this one.

---

## 8. CONTROL INVENTORY — every primitive decision, argued

| face key | primitive | derivation | why not the alternative |
|---|---|---|---|
| `speed` · `paddleH` · `serveAngle` | **`paramCells: 'fader'` — all three, DECLARED** | `shell-control-kind.ts:63` — *"the param is a LEVEL the player expects to see as a THROW, not a dial"* | ⚠ **This is the one declaration that must not be skipped, and the reason is PARITY rather than taste.** The card renders all three as `<NeonFader>` (`PongCard.svelte:90-92`). Without `paramCells` the face paints three KNOBS, and a player's muscle memory for a vertical throw lands on a rotary. The generic default is a knob; the card is the ground truth; the declaration is what joins them. |
| all three | ⚠ **NOT `warped-fader`** | — | Checked deliberately. `ShellWarpedFaderCell` (`shell-cells.ts`, landed 2026-08-23 on `face/samsloop-2026-08-23`) exists for *any param whose CARD converts at the boundary* — samsloop renders knob space 0..1 and maps piecewise. **PongCard does not convert**: it passes `min`/`max`/`defaultValue`/`curve` straight through (`:90-92`). ⚠ It passes them as **literals rather than as the def's symbols**, which is §13.4 — a *one-source* defect, not a *warp*. Do not confuse the two: the warped-fader cell would be the wrong fix and would encode a map that does not exist. |
| all three | landmarks: **NONE** | §5.2 | `speed = 1.0` was the strongest candidate in the wave and still loses to `defaultValue`'s double-click. |
| `freeze` | **`noUserControl`** | §5.1 | Renders zero cells, asserted invertedly. |

**No `ShellActionCell`, no `ShellFileCell`, no `face.momentary`, no `hero`, no PF-14 panel.**
Pong has no button on any surface and no discrete param. Recorded so a reviewer can confirm
the absence rather than infer it.

⚠ **One thing this module conspicuously does NOT get: a SERVE button.** It is the obvious
missing affordance — a manual serve would make the module playable rather than merely riggable.
It is refused here because it does not exist on the card either, so adding it is a **feature**,
not a promotion, and an ACTION cell requires a probe that a feature-less module cannot supply.
Recorded as a future PR, with the note that if it is ever built it wants
`probe: { effect: { kind: 'param', paramId: 'freeze' } }`-shaped thinking, not a revision
counter (`shell-cells.ts:225-240`: *"a revision-only probe passes on a dead button that bumps
the counter"*).

---

## 9. THE STATE MATRIX

| # | `paddle_left` | `paddle_right` | SCREEN | body paints | what a reviewer checks |
|---|---|---|---|---|---|
| 1 | unpatched | unpatched | ON | both paddles pinned at **centre** (`paddleCvToY(0) = 0.5`); the ball scores often; both counters climb | the baseline mock. ⚠ **This is the fresh-spawn state**, and it is a self-playing demo — unusual and good |
| 2 | an LFO | unpatched | ON | one paddle tracks, the other is a wall at centre | the mock that shows the CV mapping (−1 top / +1 bottom) |
| 3 | a perfect tracker | a perfect tracker | ON | ⚠ **an INFINITE rally** — MEASURED: `art/scenarios/pong/gate-pulses.test.ts:93-110` asserts **zero scores over 5 s** | **the state where SPEED is permanently inert (§13.2) and velocity grows without bound (§13.3)**. Both defects are only reachable here, which is why the ART fixture that proves it is the most valuable test on the module |
| 4 | any | any | ON, `serveAngle = 0` | every serve dead horizontal (`‖ballVY‖ < 1e-9`) | a perfectly repeatable rhythm — a feature, and a trap |
| 5 | any | any | **OFF** | nothing | ⚠ **the gates keep firing** (§7.3). The strongest single assertion in this spec |
| 6 | any | any | ON, `freeze = 1` | the last frame, held | the VRT state (§11) |

⚠ **Row 3 is the module's real failure mode and no shipping surface can distinguish it from
row 1** — a long rally and a stuck game look identical for the first several seconds. That is
worth knowing and it is **not** an argument for a readout (§10).

---

## 10. THE ARIA CONTRACT

⚠ **Nothing is deleted by the resting-text ruling on this module, and that is worth stating
plainly rather than skipping**: `PongCard.svelte` paints **no derived-state text at all**. The
score is drawn INSIDE the canvas by `drawPong` (`pong.ts:284`), and text drawn into a canvas is
the resting-text gate's own **named blind spot** (`face-resting-text-source.test.ts`: *"text
drawn INTO a canvas … is invisible to it, and only the dock VRT baselines and a human reviewing
them can see that"*).

⚠ **So the honest question is whether the SCORE is permitted.** It is — and the argument is
that it is not *derived state about a control*, it is **the picture itself**. A scoreboard on a
pong court is the same kind of object as the ball. It has always been there, no ruling names
it, and removing it would make the court unreadable. **Recorded explicitly, because "a number
painted on a faceplate" is exactly the shape four rulings have now refused, and a reviewer is
entitled to see the distinction argued rather than assumed.**

| element | contract |
|---|---|
| the court canvas | `role="img"`, `aria-label="PONG court — left 3, right 2"`. ⚠ Not `aria-valuetext`: not a range role (the `XyPad.svelte:317-330` conclusion). **This is where the score becomes speakable**, which is the accessibility half the canvas cannot supply. |
| the SCREEN button | `aria-pressed={!previewCollapsed}`, `SCREEN ON` / `SCREEN OFF`, and a `title` saying **the game keeps playing and the gates keep firing** (§7.3). |
| `control-speed` | `aria-valuetext`: `"1.00x"`. ⚠ **AND, if §13.2 is fixed as specified, nothing more.** If §13.2 is NOT fixed, the honest text is `"1.00x — applies at the next serve"`, and shipping that string is an admission that a rank-1 control lies. **Prefer the fix.** |
| `control-paddleH` | `aria-valuetext`: `"20% of the court"`. A percentage, not the raw 0.2 — the def's own docs say *"as a fraction of the court"* and the fraction is what the player sees. |
| `control-serveAngle` | `aria-valuetext`: `"0.30 — up to 13.5 degrees off horizontal"` (`(π/4)·0.3` in degrees). ⚠ A DERIVED quantity with a live negative control (`speed` must not move it), so it belongs in the face model test as a permanent leg. |
| every param cell | `data-testid="control-<paramId>"`; `faces-parity` asserts exact multiset equality against the def's param ids and scans the whole `dockShell` **including the body**. `freeze` must render **zero**. |

⚠ **Keyboard.** Owner ruling: no keyboard-a11y work. `NeonFader`'s `role="slider"` keys already
exist and are untouched.

---

## 11. DETERMINISM AND VRT — the real work, and it CLOSES AN EXISTING DEBT

**Two new scenes** — `face-pong-compact`, `face-pong-dock` — added by hand to the `FACES`
roster. ⚠ **The compact scene has no picture** (§0), so it is a static three-fader tile and is
deterministic for free. **The dock scene carries the live court** and is not.

**`FACES_WITHOUT_SCENES` IS NOT AVAILABLE, and that is the whole reason this section exists.**
Its bar is *evidence that `simPin` AND `freeze` cannot reach this renderer*
(`workflow-shell-faces.spec.ts:817`). Here **both can reach it** — they simply do not exist
yet. Claiming the exemption would be the acidwarp argument made by a module that does not
qualify.

**The seam, in two halves, both small:**

1. **`freeze` (§5.1) stops the picture.** The scheduler `tick` returns before stepping when
   `params.freeze >= 0.5`, so `state` stops changing and the card's `drawPong` repaints an
   identical frame. `freezeFaceVideo` then **verifies** it held, in the page, across real rAF
   frames — it is not a hope, it is an assertion (`_shell-faces.ts:3590-3613`).
2. **`simPin` chooses WHICH frame.** *"`freezeFaceVideo` stops the picture; it does not choose
   WHICH picture"* — `_shell-faces.ts:980`, where `outlines` measured **6724 px against a
   1500 px tolerance** across two ubuntu CI boots with freeze alone. Pong needs the same fix
   and it is unusually cheap here, because **the game is already a pure function of tick
   count** (§1.1: `dtSeconds` is a constant, never a measurement). The only nondeterminism is
   `Math.random` and the tick count at capture.

   Both `initPongState` and `stepPongState` **already accept an injectable `rng`**
   (`pong-state.ts:58`, `:120`, defaulting to `Math.random` at `:62`, `:130`). The factory calls
   `initPongState(params)` with none (`pong.ts:165`). So the pin is:

   ```ts
   // pong.ts factory — read a page global at CONSTRUCTION (the simPin contract)
   const seed = (globalThis as { __pongVrtSeed?: number }).__pongVrtSeed;
   const rng = typeof seed === 'number' ? createSeededRng(seed) : Math.random;
   let state = initPongState(params, { rng });
   ```
   plus a fixed tick budget so the captured frame is a function of `(seed, params)` rather than
   of boot speed — the same shape `outlines`' phase pin takes.

⚠ **`simPin` installs globals with `addInitScript`, so it reaches a factory that reads them AT
CONSTRUCTION.** Pong's factory is main-thread (no `renderLocus`), so the global is visible —
unlike `acidwarp`, which is unreachable because its factory runs in a Worker with its own
global scope. **MUST-VERIFY §15.5.**

**⚠ AND THIS PAYS A DEBT THE EXEMPTION ITSELF NAMED.** `vrt-exemptions.ts:696-700` states the
promotion condition verbatim: *"until either (a) a deterministic-time test harness is added so
VRT can freeze the ball at a known position, or (b) the prototype is promoted out of
research/."* This PR builds (a). **So the card-level `EXEMPT_FROM_VRT` entry should be
re-examined in the same PR** — and if it is dropped, `ALLOWED_PERMANENT_EXEMPT` must lose pong
in the SAME commit (the two lists are anchored in both directions, `:1100-1102`; an entry
naming a non-exempt module is RED). ⚠ **That is a real ratchet payment and it is the best
reason to do this module.** It also means the card gains a first baseline, so the capture bot
commits **three** PNGs, not two — predict it and count them.

⚠ ⚠ **AND `--update-snapshots` CANNOT CREATE A BASELINE THAT ALREADY PASSES.** Dropping pong
from `EXEMPT_FROM_VRT` makes `vrt.spec.ts` enrol it and the comparison **fails as
"snapshot doesn't exist"**, which is the state that writes. That is the correct route. Do not
`git rm` anything (there is nothing to remove), and **`git status` for untracked PNGs after
every local VRT run** in this window.

**CI wall-time.** `faces-parity` budgets ≈ `10 s + 0.8 s/cell`. **3 cells ⇒ ≈ 12.4 s**, plus
two face scenes and (if the exemption is dropped) one card scene. Well under the ~2 min
threshold. ⚠ The bespoke `pong.spec.ts` already costs 14.3 s
(`e2e-timings.generated.json:234`) and is untouched.

---

## 12. COST

| item | cost |
|---|---|
| **WebGL attest** | **ZERO — VERIFIED.** No pong file in the 218-file basis; `PongCard.svelte` is 2D-only so the mechanical card sweep misses it. ⚠ **`PongCourtBody.svelte` must stay 2D** — a WebGL court would pull the module into the basis and put a GPU attest on every future edit. |
| **contract-lock** | **ONE new `param` row** (`freeze`). `face` and `noUserControl` are not projected. Run `task docs:accept` and read the diff: **the only line that may move is `pong param freeze`**. Anything else is a finding. |
| **docs** | `pong` is in `STRICT_DOCS` (`strict-docs.ts:304`) — so the new param **needs a `docs.controls.freeze` entry** or completeness reddens. ⚠ Boy-scout while here: §13.2's latency caveat belongs in `docs.controls.speed`, which currently says *"scales how fast the ball travels"* with no caveat at all. |
| **ART** | ⚠ **NOT NIL — READ THIS.** `art/scenarios/pong/gate-pulses.test.ts` exists and its Part 1 drives the **pure stepper** (`:39-111`). If §13.3 is fixed (the english clamp), **the trajectories change and the determinism leg at `:65-89` re-measures.** It asserts *equality between two identical runs*, not a pinned value, so it should stay green — but **verify, do not assume**, and no `.f32` baseline exists so there is nothing to re-pin. Part 2 (`:115-181`) is blind to the factory (§13.7) and is unaffected either way. |
| **Push 2** | No override ⇒ GENERIC today. A face moves it to the FACE tier: three turnable params in `face.order` order. ⚠ **`freeze` must NOT appear** — that is what `noUserControl` buys, and `push-card-schema`'s golden diff is where you confirm it. Accept deliberately, with the reason in the test. |
| **New code** | one `shell-extension.ts`, one `PongCourtBody.svelte` (importing `drawPong`, 2D only), a seeded-RNG helper + the factory's two-line pin, the `freeze` early-return in `tick`, one `STRICT_FACES` line, one `FACES` roster row with `videoFaceWhy` + `simPin`, one `pong-face-model.test.ts`. |
| **Conflict surface** | `strict-faces.ts` · `_shell-faces.ts` · `push-card-config.ts` golden · `vrt-exemptions.ts` (**two lists, one commit**) · `contract-lock.txt` (GENERATED — take main and re-run the accept task). |

---

## 13. DEFECT LEDGER

Recorded here and **reported to the orchestrator for routing**. None is fixed in the spec PR.

**13.1 — `vizPassthrough: true` IS A LIE FOR PONG, and two surfaces advertise it.**
`pong.ts:70` declares it; `docs.explanation` (`:100`) tells the user *"since the module is
vizPassthrough, that canvas can be portaled into a containing GROUP card for cross-domain
video"*. But `GROUP_VIZ_HOST_TYPES = new Set(['scope'])` (`group-viz-hosts.ts:62`), so
`GroupCard` never mounts `PongCard` while collapsed and its
`querySelector('canvas[data-viz-passthrough]')` finds nothing. **MEASURED and recorded in the
tree**: `group-viz-hosts.test.ts:100-107` — *"canvasInSlot 0 for frogger/modtris/pong against
SCOPE's 1"*, tracked as **#1755**. The `data-viz-passthrough` attribute at
`PongCard.svelte:85` is inert in the shipping product. ⚠ The reverse assertion was
**deliberately withheld** in that test to avoid stating a falsehood, which means the defect is
known, documented, and uncovered. **Severity: report — it affects frogger and modtris too, so
it is a class, not a module.**

**13.2 — ⚠ A RANK-1 CONTROL THAT DOES NOTHING UNTIL THE BALL GOES OUT.**
`params.speed` is read at **exactly one site**: `pong-state.ts:89`, inside `resetState`.
`stepPongState` integrates `prev.ballVX · dt` (`:136`) and only ever *reflects* velocity
(`:144`, `:147`, `:157`, `:169`) — it never re-derives magnitude from `params.speed`. So moving
SPEED mid-rally changes nothing until the next serve. `docs.controls.speed` (`pong.ts:112`)
says *"scales how fast the ball travels"* with no caveat, and `readLive` reports the new value
immediately while the ball keeps its old velocity. ⚠ **With tracking paddles the rally is
infinite** (measured: `gate-pulses.test.ts:93-110`, zero scores over 5 s), so **SPEED can be
permanently inert.** Fix: renormalise the velocity vector to `BASE_SPEED · params.speed` when
the param changes, preserving direction. **Severity: fold into the face PR** — this face ranks
it 1, and shipping a rank-1 control that appears dead is worse than not shipping the face.

**13.3 — UNBOUNDED VELOCITY, and a hidden scalar that makes the SPEED range feel 16:1
inconsistent.** `pong-state.ts:164` (left) and `:171` (right): `vy += offset * BASE_SPEED * 0.4;`
Two independent problems in one expression:
(a) it uses the module constant `BASE_SPEED = 0.55`, **not** `BASE_SPEED * params.speed` — so at
`speed = 4` the ball is 4× faster while the paddle english is unchanged, and the control's felt
effect varies 16:1 across its declared range;
(b) it is a **pure addition with no renormalisation and no clamp** — `|v|` grows monotonically
with every paddle hit, and there is no speed cap anywhere in the file. A long rally accelerates
until the ball tunnels through a paddle or the paddles cannot track.
No test covers either: the perfect-tracker ART asserts `scores === 0` and never looks at
velocity magnitude. **Severity: real, and (b) is a correctness bug.** ⚠ Fixing it changes
trajectories, so re-run the ART scenario (§12).

**13.4 — the card re-types six range literals and NOTHING checks them.**
`PongCard.svelte:90-92` hard-codes `min={0.25} max={4} defaultValue={1.0}`, `min={0.05}
max={0.5} defaultValue={0.2}`, `min={0} max={1} defaultValue={0.3}` — **while importing
`pongDef` three lines earlier and using `pongDef.params[N]!.defaultValue` for the reactive
read** (`:28-30`). `card-kit.ts:67-82` documents `paramSpec` for exactly this; `grep -c
paramSpec PongCard.svelte` → **0**. Pong is not in `RANGE_BOUND_CARDS`, whose own stated scope
is *"every card NOT in this set is unchecked"*. They agree today; nothing holds them there.
**Severity: fold in** (use `paramSpec`, enrol the card). Cheap, boy-scout, and the backdraft
class verbatim.

**13.5 — ⚠ THE COURT RENDERS AT HALF THE INTENDED SIZE, and the spec must not inherit it.**
`PongDrawOpts` documents `paddleW` as *"Paddle visual width in **CSS pixels**"* (`pong.ts:236`)
and `ballPx` likewise (`:238`), defaulting to 4 and 6 (`:253-254`). The card passes
**backing-store** dimensions — `drawPong(ctx2d, snap, params, canvasEl.width, canvasEl.height)`
= 400×280 at `DPR = 2` (`PongCard.svelte:56`, `:41-42`) — and **never applies
`ctx2d.scale(DPR, DPR)`**. So the ball renders at **3 CSS px**, the paddles at **2 CSS px**,
the centre dash (`dashH = 6`, `dashGap = 6`, `pong.ts:264-265`) at 3, and the score font
`'700 14px ui-monospace'` (`:284`) at **7 CSS px**. Every def-reading gate is blind to it, and
there is **no pixel test at all** because pong is `EXEMPT_FROM_VRT`. ⚠ **The face's body must
NOT copy the card's call**; and after §11 there IS a pixel test, which is the first thing that
could ever have caught this. **Severity: fold into the face PR** — the body is being written
anyway, and getting it right there while the card stays wrong would be two courts at two sizes.

**13.6 — the design doc and the shipped def disagree on param ids.**
`docs/design/game-modules.md:145-147` proposes `paddle_h` / `serve_angle`; the def ships
`paddleH` (`pong.ts:89`) / `serveAngle` (`:93`), and `pong.ts:2` and `:6` both cite that doc as
the *architectural reference*. The doc also omits `edge: 'trigger'` on the gate outputs, which
the def carries and `contract-lock.txt:2553-2554` pins. **Severity: doc drift; fold in.**

**13.7 — the ART gate-pulse test cannot fail on a factory regression.**
`art/scenarios/pong/gate-pulses.test.ts:129-131` and `:157-162` **re-type**
`setValueAtTime(1, 0.005)` / `(0, 0.010)` into a fresh `OfflineAudioContext`. It never imports
`pongDef`, never calls `factory`, and never reads `GATE_PULSE_S` (`pong.ts:57`) or
`SCHEDULE_CUSHION_S` (`:62`). **Change either constant and this test stays green while the
shipped gate width changes.** Its own header is honest — *"hand-orchestrate the exact
ConstantSourceNode schedule the factory's pulseGate() emits"* — and "hand-orchestrate" IS the
blindness: it is a fixture the test built, asserting a property of itself. **Severity: a blind
gate on a shipped contract.** Fix: import the two constants at minimum; drive the real factory
ideally. Report.

**13.8 — the lane tile is a dead placeholder and no test has ever looked.**
§0 in full. Not in `NON_SHELL_LANE_TYPES`, not in `STRICT_FACES`, not a `CARD_PRODUCER` ⇒
`'placeholder'`, no card, no court. **Every pong e2e drives `?shell=legacy`**
(`pong.spec.ts:58`). **This spec closes it at the dock and leaves it open at the lane** until
the §0 glyph widening lands. Report as the wave-level platform finding.

**13.9 (minor) — `label: 'pong'` is lowercase, every other surface says `PONG`.**
`pong.ts:68` vs `PongCard.svelte:76` (`defaultLabel="PONG"`) and `game-modules.md:134`. The
def's label is what `moduleLabel()` returns for the Electra flash
(`electra/host.ts:105-109`) and what a faceplate title bar would use. ⚠ **Do NOT "fix" it
upward** — the house rule is LOWERCASE module labels, enforced by a guard test. The card's
`defaultLabel` is the outlier. Note only.

---

## 14. TASTE CALLS, EACH WITH ITS ONE-LINE REVERT

1. **`freeze` + `simPin` rather than `FACES_WITHOUT_SCENES` (§11).** Revert: none defensible —
   the exemption's own bar refuses it. Recorded so the shortcut is not attempted.
2. **`speed` ranks 1 over `paddleH`.** Revert: swap them. ⚠ The measured argument for
   `paddleH` (the only param read every step) is genuinely strong and is written out in §4 so
   an owner can overrule with the facts in hand.
3. **All three declared `'fader'`.** Revert: drop `paramCells` and they are knobs — and the
   face silently stops matching the card's own primitive, which is a parity loss nothing gates.
4. **ONE band.** Revert: split `match` into `ball` (speed, serveAngle) and `paddles` (paddleH).
   Consequence: a second ~81 px band header for a distinction the module does not make.
5. **No SERVE button (§8).** Revert: it is a feature PR, not a revert.
6. **Dropping the card's `EXEMPT_FROM_VRT` entry in the same PR (§11).** Revert: keep both
   lists as they are and capture only the two face scenes. Consequence: the module keeps a
   permanent exemption whose own stated promotion condition this PR has just satisfied — which
   is how a temporary exemption becomes permanent.

---

## 15. MUST-VERIFY

1. **The tier ladder**, derived through `curatedFace`, not the cap constants.
2. **Three `'fader'` cells and the plate's width** — `cellWidthClass` is deny-by-default
   `'wide'`, so measure rather than assume.
3. **`rear-card-model`** — the `paddles` input group resolves, and the CV inputs (which have no
   `paramTarget`) do not orphan.
4. **Plate width ≤ pane width** — needs a baseline; the first `vrt:commit` IS the measurement.
5. **`simPin` reaches the factory** — the global must be readable at CONSTRUCTION. Prove it:
   **three consecutive dock captures pixel-identical, AND a fourth with a DIFFERENT seed that
   is visibly different.** A pin that changes nothing is indistinguishable from a pin that
   never ran.
6. **`freezeFaceVideo` genuinely holds this canvas.** It asserts it itself
   (`_shell-faces.ts:3610-3613`), so this is really a check that the `freeze` early-return is in
   the `tick`, not in the card.
7. **SCREEN OFF leaves the gates firing** — a downstream counter on `score_left` before and
   after a collapse window. ⚠ The single most valuable assertion in this spec, because it is
   the property the NEXT audio module with a body will not have.
8. **`freeze` renders exactly ZERO cells** in both `module-face-lint` and `faces-parity`, and
   does not appear on the Push golden.
9. **The ART determinism leg is still green after §13.3** — it asserts run-to-run equality, not
   a pinned trajectory, so it should be; verify rather than assume.
10. **If the card's `EXEMPT_FROM_VRT` entry is dropped**, `ALLOWED_PERMANENT_EXEMPT` loses pong
    in the SAME commit, and the capture commits THREE PNGs, not two.

---

## 16. VERIFICATION GATE

```sh
# 1. the pure model + this face's PERMANENT negative controls (§9 rows 3/5, §10's serveAngle leg)
REPEAT=3 flox activate -- task test:one -- pong-face-model
# 2. the stepper, because §13.2 and §13.3 both change it
REPEAT=3 flox activate -- task test:one -- pong-state
# 3. face lint + plans
flox activate -- task test:one -- module-face-lint
flox activate -- task test:one -- dock-row-plan
flox activate -- task test:one -- dock-faceplate-model
flox activate -- task test:one -- curated-face
flox activate -- task test:one -- shell-extensions
flox activate -- task test:one -- module-shell-import-guard
# 4. the rulings' source gates
flox activate -- task test:one -- face-resting-text-source
flox activate -- task test:one -- face-readout-source        # packages/web/src/lib/ui/controls/
flox activate -- task test:one -- face-width-source          # packages/web/src/lib/ui/dock/
flox activate -- task test:one -- face-rack-status-source    # the fullViewBody ROSTER entry
# 5. #1726 + rear + push + docs
flox activate -- task test:one -- no-user-control            # freeze: zero cells, both directions
flox activate -- task test:one -- rear-card-model
flox activate -- task test:one -- push-card-schema           # freeze must NOT appear
flox activate -- task test:one -- card-range-source          # after §13.4
flox activate -- task test:one -- module-docs-lint           # docs.controls.freeze is REQUIRED
flox activate -- task test:one -- vrt-meta                   # the two exemption lists stay anchored
# 6. the contract diff must contain ONLY `pong param freeze`
flox activate -- task docs:accept && flox activate -- git diff
# 7. ART — trajectories move if §13.3 lands
flox activate -- task art:one -- pong
# 8. e2e
flox activate -- task e2e:serve
REPEAT=3 flox activate -- task e2e:one -- tests/faces-parity.spec.ts
REPEAT=3 flox activate -- task e2e:one -- tests/pong.spec.ts
flox activate -- task e2e:stop
# 9. typecheck LAST
flox activate -- task typecheck
# 10. VRT: dispatch only. Predict the file count (2 face scenes, +1 card scene if the exemption drops).
flox activate -- task vrt:commit
# 11. attest: NIL for this module — nothing to run.
```

**The negative controls, spelled out so a builder cannot ship a green stub:** a DIFFERENT
`__pongVrtSeed` must produce a visibly different dock capture; SCREEN OFF for N frames must
leave a downstream `score_left` counter STILL INCREMENTING; `speed` 1 → 4 must change
`control-speed`'s `aria-valuetext` AND (after §13.2) the ball's measured velocity within the
same rally; `serveAngle` 0.3 → 1.0 must move its `aria-valuetext` from `13.5 degrees` to
`45 degrees` while `speed` moves neither.

## 17. BUILD-COST ESTIMATE

| phase | estimate |
|---|---|
| `freeze` param + `noUserControl` + the `tick` early-return + `docs.controls.freeze` | ~1 h |
| the seeded-RNG pin in the factory (§11) | ~1.5 h |
| `shell-extension.ts` + `PongCourtBody.svelte` (importing `drawPong`, **with the DPR fix**) | ~2.5 h |
| §13.2 (speed renormalisation) + §13.3 (english scaling + clamp) — **DSP-adjacent, own commit** | ~3 h |
| §13.4 `paramSpec` + `RANGE_BOUND_CARDS`, §13.5 card-side DPR, §13.6 doc drift | ~1.5 h |
| `pong-face-model.test.ts` + the stepper legs for §13.2/§13.3 | ~2.5 h |
| roster/registry edits, exemption-list decision, push golden | ~1 h |
| gate loop, 3× flake checks, ART re-run, typecheck | ~2.5 h |
| VRT dispatch + the seed negative control | ~1.5 h wall |
| **total** | **≈ 17 h** |

**Risk rank: MEDIUM-HIGH — the highest in this wave, and not because of the face.** The face
itself is three faders and a body: perhaps four hours. The other thirteen are a determinism
seam, two genuine physics defects and a rendering-scale bug, all of which are worth paying and
none of which is faceplate work. ⚠ **If the wave needs a fast module, this is not it — but if
the wave wants to close a named ratchet, this is the one that does.**
