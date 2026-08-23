# FACEPLATE BUILD SPEC — `lushgarden` (video, a generative botanical garden)

> **SPEC + MOCKS. Nothing here is implemented.** Authored to the bar of
> `.myrobots/plans/face-redo-dx7.md` and `.myrobots/2026-08-22-quadralogical-face-mocks/spec.md`.
> The HERO READOUT STRIP and the SIDEBAR those exemplars carry are **not reproduced** —
> both mechanisms were deleted fleet-wide on 2026-08-19 (#1957). §10 (the ARIA CONTRACT)
> is what replaces them.
>
> **Mocks:** `dock-screen-on.html` · `dock-screen-off.html` (open in a browser; self-contained).
>
> **Figure labels** — `DERIVED-BY-READING` · `MEASURED` · `MUST-VERIFY` (re-listed in §15).

**Verdict: PROMOTE — and the promotion is a FIX-PLUS-FACE in one PR, because this module
ships THREE PARAMS A PLAYER CAN ALREADY REACH AND MUST NOT.** `cv_grow`, `cv_reset` and
`freeze` are synthetic jack/harness params with no card control and **no `noUserControl`
declaration**. That is not a face blocker: it is a **live product defect on two surfaces the
face has nothing to do with** — the Push 2 generic card and the group instrument bar — and
turning one of them silently and permanently kills the RATE knob (§13.1). The face is what
forces the declaration, and the declaration is what fixes the bug.

The face is otherwise cheap, and **the WebGL attest stays at ZERO if it is authored
correctly** (§12) — a property worth protecting deliberately, because this def is one of the
218 files in the basis.

---

## 0. THE CONSTRAINT MAP, READ FIRST

| registry | member? | what it means here |
|---|---|---|
| `NON_SHELL_LANE_TYPES` (`legacy-fallback.ts:80-98`) | **NO** | the lane swaps. `'placeholder'` today, `'shell'` after promotion. |
| `DOM_SOURCE_LANE_TYPES` (`dom-source-modules.ts:70-80`) | **NO** | it owns no `<video>`/`<img>` and calls no `attachExternalSource`. |
| `CARD_PRODUCER_LANE_TYPES` (`:187-194`) | **NO** | **and this is the fact that makes this module cheap.** The picture is produced by the VIDEO ENGINE from the graph (`VideoEngine.addNode` → the def's own `surface.draw`), not by the card. The card only READS it (`blitOutputForPreview`, `LushGardenCard.svelte:73-78`). |
| `EXEMPT_FROM_VRT` / `ALLOWED_PERMANENT_EXEMPT` | **NO** | it is fully baselined today: `e2e/vrt/__screenshots__/vrt.spec.ts/lushgarden.png`, **566×565 RGB, 83 499 B**, no mask. |
| `STRICT_FACES` | **NO** | un-migrated; authoring the `face` IS the promotion. |
| `PUSH_CARD_CONTROLS` | **NO** | falls to the GENERIC tier — see §13.1, which is where the defect lives. |
| `RANGE_BOUND_CARDS` (`card-range-source.test.ts`) | **NO** | so the card's four re-typed numeric ranges are **unchecked by anything** (§13.2). |
| `VOCABULARY_DEBT` (`card-def-debt.ts:141`) | **YES** | `['fov.label','horizon.label','rate.label','view.label']` — case-only divergence (def `Rate`, card `RATE`). |

**Nothing carves this module out and nothing depends on its card being mounted.** That is
the whole difference between this spec and `timelorde`'s: there is no producer seam to
protect, no headless host to reason about, and swapping the card away costs the graph
nothing.

### The lane tile GAINS a live picture

`hasVideoSurface(def)` is `def.domain === 'video'` (`module-shell-model.ts:177-179`) and
lushgarden is `domain: 'video'` (`lushgarden.ts:312`), so `laneGlyphFor` returns
**`'picture'`** — and a picture **OUTRANKS ranked controls** in `laneBodyPlan` (owner ruling,
#1785: *"for a video module the picture IS the module's identity in a rack"*). Today the lane
tile is a `ModuleShellPlaceholder` with no picture at all. **A face is a strict gain at every
lane tier.**

⚠ **`glyph: 'none'` IS REQUIRED AND COUNTER-INTUITIVE.** All four outputs are `type: 'video'`,
so `primaryAudioOutPortId` returns null (`shell-glyph-live.ts:95-97`) and every other glyph
literal resolves `{kind:'static'}` and reddens the dead-glyph clause. `'none' + blank tile`
and `'none' + live picture` are indistinguishable from the declaration — **assert
`hasVideoSurface` in the face model test**, which is the only thing that tells them apart.

⚠ **MUST-VERIFY §15.1 — WHICH of the four outputs does the tile show?** `VideoTileThumb`
calls `blitOutputToDrawingBuffer(nodeId)`, which blits *the node's surface*, while the card
calls `blitOutputForPreview(id)`. This module renders **four separate FBOs**
(`lushgarden.ts:403-408`) and exposes them by the `read('outputTexture:<port>')` escape hatch
(`:850-856`). If the tile resolves a different port than the card's preview, the lane and the
dock body would show two different styles of the same garden with nothing saying so.

---

## 1. WHAT THE MODULE IS FOR

**In one paragraph, and every rank below descends from it.** LUSH GARDEN is the only source
in the fleet whose output is **an accumulating scene rather than a signal**. It is not a
pattern generator with a rate control; it is a **garden that fills up**. Seventy-six scanned
botanical cutouts (52 flower / 17 bush / 7 tree, `packages/web/static/lushgarden/manifest.json`)
are spawned at a random depth and a random world position, sorted far-to-near, and drawn with
a perspective law — so the picture at second 30 contains the picture at second 10. The verb a
player performs is **GARDEN**: set how fast it grows, then move the camera through what grew.
Everything else on the module is that camera.

**And the second half of the identity, which is easy to miss and is the reason this face is
not just four knobs: ONE SIMULATION, FOUR SIMULTANEOUS RENDERS.** `mono`, `watercolor`,
`psychedelic` and `clean` are not modes — they are four output ports rendering the SAME plant
set through four different pipelines, every frame, all patchable at once (`renderOutput`,
`lushgarden.ts:756-798`). A player can send `clean` to a key and `psychedelic` to a feedback
loop from one garden.

**The chain, in execution order** (`lushgarden.ts:669-801`):

1. **`freeze >= 0.5` → the whole draw returns** (`:677`). Every surface holds its last frame.
2. **The VRT seed hook** (`:680-698`): a numeric change on `globalThis.__lushgardenVrtSeed`
   resets the scene, spawns `LUSHGARDEN_VRT_PLANTS = 24` fully-grown from a seeded RNG, and
   sets `vrtMode` — **which suppresses all further spawning** (`:701`, `:712-715`). This is
   the single most important fact in §11.
3. **Spawning** (`:701-711`): `stepSpawner(spawner, dt, params.rate, growPatched)`.
   ⚠ **`growPatched` short-circuits it to zero unconditionally** (`lushgarden-scene.ts:323-326`).
4. **Bake throttle** — at most `BAKES_PER_FRAME = 2` cutouts are keyed + outlined + blurred +
   watercoloured per frame, a 5-pass GL sequence per entry (`:540-635`).
5. **Layout** (`:730-747`): `farScale = fovToFarScale(fov)`, then far→near sort, then per plant
   `layoutPlant` → a viewport rect. The placement law, verbatim
   (`lushgarden-scene.ts:384-406`):
   ```
   g       = growFactor(now - grownAt)                     // 1-(1-t)^3 over GROW_IN_S=0.35 s
   persp   = 1 - clamp01(depth) * (1 - farScale)
   hPx     = KIND_CANONICAL_HEIGHT[kind] * (resH/768) * persp * g
   pan     = clamp01(view) * (WORLD_WIDTH-1) * parallaxFactor(depth)
   anchorY = clamp01(depth) * clamp01(horizon) * resH
   ```
6. **Four renders** (`:795-798`), in the fixed order `clean → mono → watercolor → psychedelic`.
   ⚠ **`clean` ALWAYS renders; the other three render only when downstream-connected**
   (`:762`). That single line is what §7.3's style monitor collides with.

**What each control genuinely changes, measured from the code.**

| param | read at | effect | inert? |
|---|---|---|---|
| `rate` | `:710` → `stepSpawner` | spawns/sec, clamped 0.5..10, log curve | ⚠ **DEAD whenever `growPatched`** — and `growPatched` is a **permanent latch** (§13.4) |
| `horizon` | `:732` → `anchorY = depth·horizon·resH` | vertical compression of the far rank. **At 0 every plant anchors at y = 0** — the whole garden flattens to one bottom row | no |
| `view` | `:733` → `pan` | horizontal parallax translation; `parallaxFactor` runs 1 → 0.2 over depth (`:234-237`), so near plants shift 5× further than far ones | no |
| `fov` | `:736` → `fovToFarScale(v) = 0.5 − 0.4·v` | the far-plane scale. At the shipped 0.7 this is **exactly `FAR_SCALE = 0.22`** | ⚠ **default-NEUTRAL, not inert** — moving it does change the picture |
| `cv_grow` | `:829-836` | first write **latches `growPatched = true` permanently**; a rising edge (0.6/0.4 hysteresis) queues one spawn | — |
| `cv_reset` | `:837-844` | a rising edge clears every plant | — |
| `freeze` | `:677` | the render stops | ⚠ **written by nothing in the product today** (§13.3) |

**Hidden constants a surface never shows** (none player-reachable, all worth knowing):
`PLANT_CAP = 350` and **the cap REPLACES THE OLDEST plant** (`lushgarden-scene.ts:132`,
`spawnPlant`) — so a garden left running does not stop, it churns; `WORLD_WIDTH = 2.5`;
`SPAWN_MIX` 70 / 20 / 10 flower / bush / tree; `LUSHGARDEN_HUE_SPEED = 0.12` (the
psychedelic rotation, on a wall clock, not on `rate`); the watercolour edge darkening
`1.0 − 0.3·edge`; the RNG seed `0x10c4a11`.

---

## 2. STOP 1 — is promoting this module a PARITY LOSS?

**No — it is a gain at the lane and a wash at the dock, PROVIDED §7 is built.** Against the
two refusal precedents:

- **#1974 (`joystick`) — does every lane tier resolve to zero controls?** No. Four turnable
  params and a picture that outranks them.
- **#2065 (`spectrograph`) — is the headline feature a picture the shell cannot paint?** No,
  and this is the exact inverse case: the shell paints it *for free* because the module is
  video-domain. `spectrograph` was refused because an audio def with mono-video ports has no
  engine surface; lushgarden IS the engine surface.

**But there is a THIRD refusal test this module fails until §13.1 is paid, and it is not on
the list because it has never come up before: a face RANKS EVERY PARAM.** `module-face-lint`
completeness loops every `ParamDef` with no filter and no skip list; a param in neither
`face.order` nor `noUserControl` is RED. lushgarden has seven params and four controls. **So
the face cannot be authored at all without the `noUserControl` declaration** — which is why
the inventory (`face-migration-inventory.ts:353`) and the next-cut derivation
(`.myrobots/2026-08-23-next-cut-derivation.md:269-277`) both marked this module **AUDIT
FIRST** rather than queueing it as a plain face. That audit is §13.1, and its outcome is a
def correction.

---

## 3. STOP 2 — does every way of getting DATA IN survive?

```sh
grep -nE '<button|<select|<input|oncontextmenu|manualTrigger|Toggle|Selector|accept=' \
  packages/web/src/lib/ui/modules/LushGardenCard.svelte
```

**Zero hits in the card's own markup.** Every interactive element it has comes from three
shared components. That is unusual and it is the reason this STOP is short.

| # | affordance | site | after promotion |
|---|---|---|---|
| 1 | `<ModuleTitle>` — editable label + colour dot | `:133` | **YES** — the shell paints its own title bar |
| 2 | `<PatchPanel>` — jacks, drill-down, the right-click unpatch menu, the card flip | `:135` | **YES** — the shell paints its own patch panel and rear card |
| 3 | RATE knob (log 0.5..10) | `:146-151` | **YES** — rank 1 |
| 4 | HORIZON knob (0..1) | `:152-157` | **YES** — rank 3 |
| 5 | VIEW knob (0..1) | `:158-163` | **YES** — rank 2 |
| 6 | FOV knob (0..1) | `:164-169` | **YES** — rank 4 |
| 7 | per-knob right-click MIDI-learn, drag, double-click-to-default, scroll-wheel | `Knob.svelte:298-304` | **YES** — the shell renders the same `<Knob>` |
| 8 | 240×180 preview canvas of the CLEAN output | `:141`, draw `:65-92` | **YES via `fullViewBody`** (§7). ⚠ dock-only; the LANE gets the shell's own `VideoTileThumb` instead |
| 9 | `[GATED]` badge | `:139`, derived `:108-112` | **DELETED BY RULING — and it was WRONG.** §10.1 |
| 10 | plant-count readout | `:142`, polled `:84-89` | **DELETED BY RULING.** §10.2 |

**No `node.data` state, no file input, no dropdown, no keyboard handler, no `mutateNode`.**
The card's only write path is `setNodeParam(id, k, v)` (`:46-48`), used by rows 3–6 alone. So
STOP 2 is satisfied by four param cells and one body — which is why the *interesting* work in
this spec is §7 and §13, not the control mapping.

---

## 4. THE RANK — `face.order`

| # | key | why it earns this rank — an argument that would be WRONG for a different module | what it costs below |
|---|---|---|---|
| 1 | `rate` | **It is the only control over the module's GENERATOR; the other three are a camera over a scene that already exists.** Turn `rate` to 10 and the frame fills in seconds; turn it to 0.5 and the same garden takes twenty times as long to become the same picture. Wrong for a filter or a mixer, where rank 1 is a level; right here because this module's output is *accumulated*, and `rate` is the only thing that changes what accumulates. | anchors every tier |
| 2 | `view` | The camera control with a **performance verb**. `parallaxFactor` makes near plants shift 5× further than far ones (`lushgarden-scene.ts:234-237`), so a `view` sweep is a dolly, not a crop — the one gesture on this module that reads as a move through the garden rather than a change to it. Wrong for a still-image source. | evicts `horizon` from compact |
| 3 | `horizon` | The most VIOLENT control and still rank 3, deliberately. At 0 the depth sort collapses and every plant anchors at `y = 0` — a single flat row. That is a composition decision made once, not a thing anyone rides; a control whose extreme is dramatic is not the same as a control that earns the lane. | — |
| 4 | `fov` | **Last, and the argument is structural rather than aesthetic: it is the ONLY visible param with no CV input.** `rate`, `horizon` and `view` each have a `paramTarget` port (`lushgarden.ts:320-322`); `fov` has none. A param nothing can automate is set-once by construction, and set-once is what rank 4 means. ⚠ Its shipped 0.7 also reproduces `FAR_SCALE` exactly — the default is the module's own baked-in gradient — so a fresh spawn shows nothing about it. | — |
| — | `cv_grow` · `cv_reset` · `freeze` | **NOT RANKED. `noUserControl`.** §13.1. |

**THE TIER LADDER, read back as a sentence.** With `laneGlyphFor === 'picture'` the caps are
the glyph-bearing column (`curated-face.ts:62-79`): **at mini, the PICTURE and RATE; at
compact, the picture, RATE and VIEW; at plate, the picture and all four; at the dock,
everything plus the body.** ⚠ **MUST-VERIFY §15.2 — derive this through `curatedFace`, never
from the cap constants.** `ruttetra`, `monoglitch`, `reshaper` and `quadralogical` each got a
tier ladder wrong by reading it off `LANE_PLATE_MAX_CELLS`; on THIS module there is a second
trap, because a picture outranks ranked cells (#1785) and the arithmetic is therefore not the
glyph-less one.

**THE LOSERS, NAMED.** `horizon` lost the compact tier to `view` because at the shipped
defaults `view = 0.5` already sits mid-pan and moving it visibly moves the garden, whereas
`horizon = 0.65` is a composition a player accepts and forgets. `fov` lost to everything
because it is unautomatable and default-neutral — a lane cell that, on a fresh spawn, is
sitting exactly on the constant the module was tuned around.

---

## 5. VOCABULARY CHANGES — **NONE, AND THAT IS A DELIBERATE, LOAD-BEARING DECISION**

⚠ **This is the section where the attest is won or lost, so read §12 first.**
`HASH_TRANSPARENT_PROPS` is exactly `['docs', 'controlFamilies', 'face', 'noUserControl']`
(`scripts/attest-code-basis.ts:96-108`). **`options`, `landmarks`, `units`, `format`, `curve`
and every range are NOT in it**, and `lushgarden.ts` is one of the 218 files in the WebGL
attest basis. So each of the following is a real, GPU-requiring re-attest, and each was
considered and **refused**:

| candidate | why it was refused |
|---|---|
| `units: '/s'` on `rate` | genuinely useful, and the docs already say "0.5–10 spawns/sec". A units string on the knob would print `2 /s`. **Not worth a GPU re-attest**, and the same fact is already in `aria-valuetext` and in `docs.controls.rate`. |
| `landmarks` on `fov` | tempting, because `fov = 0.7` is the exact point where `fovToFarScale` reproduces `FAR_SCALE = 0.22` — a genuine continuous waypoint, which is what a landmark is for. **Refused for the same reason**, and because the def's `defaultValue` already restores it on double-click, which is a *gesture* rather than a *name*. |
| `landmarks` on `horizon` | `horizon = 0` is the flat-row degenerate state and arguably deserves a name. Same refusal. ⚠ Recorded as the strongest of the three, and as the one to revisit **if this def ever needs an attest for another reason** — take the free ride then. |
| `options` on anything | no param here is discrete. Nothing applies. |

**So the def diff in this PR is: one `face` block, one `noUserControl` block, one
`controlFamilies` entry if §7 needs one, and `docs.controls` prose. All four are stripped
before hashing. The attest expectation is ZERO, and it is a property to protect rather than
a coincidence to notice.**

---

## 6. BAND STRUCTURE — two bands, no tab rail

```ts
pages: [
  // 1 — GROWTH. One control, and it earns a header because it is the module's
  //     IDENTITY: `rate` is the only thing here that touches the generator. Every
  //     other param is a camera over a scene that already exists. (A page earns a
  //     header at >=2 controls, OR at 1 that is the module's identity.)
  { id: 'growth', label: 'growth', controls: ['rate'] },

  // 2 — CAMERA. Three params that change WHERE YOU STAND, not what is there.
  //     Ordered by the axis they move: `view` pans, `horizon` sets how far the
  //     ground recedes, `fov` how much smaller the far rank gets.
  //     ⚠ `order` and `pages` DISAGREE here and that is deliberate: `order` puts
  //     `view` above `horizon` because a shrinking tier should keep the pan;
  //     `pages` lists them in geometric order because at the dock, where all
  //     three are visible, the picture is easier to reason about that way.
  { id: 'camera', label: 'camera', controls: ['view', 'horizon', 'fov'] },
],
```

**TWO bands, so NO TAB RAIL** (`DOCK_TAB_MIN_BANDS = 7`). Correct, and do not pad.
⚠ Both bands are all knob-column cells, so `bandIsPackable` should let them share ONE row
(`dock-row-plan.ts:156`) — which is the compact outcome the width ruling wants. MUST-VERIFY
§15.3; do not eyeball it.

**REAR CARD.** `face.rear` is a projection of `pages`, so re-derive it:

- `rate`, `horizon`, `view` each have a CV input with `paramTarget` set, so those three jacks
  land in the sections their params' pages produce — `rate` → `growth`, `horizon`/`view` →
  `camera`.
- ⚠ **`fov` has NO CV input, so the `camera` rear section holds TWO jacks against the front
  band's THREE.** That asymmetry is CORRECT and must not be "fixed" — it is the same shape as
  quadralogical's `invert`, and it is exactly the fact §4 uses to rank `fov` last. A reviewer
  who sees two jacks under a three-knob band is looking at the argument.
- `grow` and `reset` are `gate` inputs whose `paramTarget`s are the two `noUserControl`
  params. ⚠ **MUST-VERIFY §15.4: does `rearFieldPlan` place a CV hole whose target param is
  declared `noUserControl` and therefore ranked nowhere?** If it orphans them, author a
  `face.rear.groups` entry `{ id: 'trigger', ports: ['grow','reset'] }` — those two jacks are
  the module's only performance input and they must not fall off the rail.
- `background` is a `video` input; the four outputs are all `video` and take the derived
  default (one `out` section, split by cable domain only if the rail out-runs a column). Leave
  the output rail alone.

---

## 7. THE BODY — `face.extension: 'lushgarden'`, the SCREEN switch, and one refused idea

### 7.1 Why a body

The owner ruling of 2026-08-18 makes this non-optional: **every video module's face gets a
SCREEN ON/OFF toggle**, and `video-face-screen-source.test.ts` enforces it over
`listVideoModuleDefs()` — which includes this module — so a promotion without one is RED, by
name, at the source level. There is no generic shell affordance (`previewCollapsed` appears
in zero shell files), so the route is the `fullViewBody` slot. `spirographs`, `backdraft`,
`videoOut` and `4plexvid` are the adopters to copy.

```ts
// $lib/ui/modules/lushgarden/shell-extension.ts
import LushGardenScreenBody from './LushGardenScreenBody.svelte';
export default { fullViewBody: LushGardenScreenBody } satisfies ShellExtension;
```

### 7.2 The zone map

```
┌─ dock full view ──────────────────────────────────────────────────────┐
│ LUSH GARDEN                                                   [ ✕ ]   │
├───────────────────────────────────────────────────────────────────────┤
│   ┌───────────────── fullViewBody ─────────────────┐                   │
│   │  ┌──────────────────────────────────────────┐  │                   │
│   │  │                                          │  │  the CLEAN output │
│   │  │        the garden, 4:3, live             │  │  at 4:3           │
│   │  │                                          │  │  (VIDEO_RES is    │
│   │  │                             [SCREEN ON]  │  │   1024x768)       │
│   │  └──────────────────────────────────────────┘  │                   │
│   └────────────────────────────────────────────────┘                   │
├─ growth ───────────────────┬─ camera ───────────────────────────────────┤
│        (RATE)              │   (VIEW)   (HORIZON)   (FOV)              │
└────────────────────────────┴────────────────────────────────────────────┘
```

**WIDTH.** One 4:3 picture and four knob columns. `.faceplate-body`'s old 900 px floor is
gone; **nothing here earns more than the picture's own width**, and the picture should be
sized to what a garden needs to read (the card's 240×180 is the shipped proof that it reads
small). ⚠ MUST-VERIFY §15.5 against `workflow-shell-faces.spec.ts`'s content-vs-plate leg,
which **cannot be run locally without a baseline** — the first `vrt:commit` on this face is a
MEASUREMENT, not a formality.

### 7.3 ⚠ THE STYLE MONITOR — a genuinely good idea, REFUSED, with the reason

The obvious win: this module has **four** live outputs and every surface shows only `clean`.
A body with a four-way port picker — `blitOutputPortForPreview(nodeId, port)`, exactly what
quadralogical uses for its `preview` port, with the choice on `node.data.previewPort` — would
let a player *see* watercolour and psychedelic without patching them somewhere.

**It does not work, and the reason is one line of the module's own render loop.**

```ts
// lushgarden.ts:762
if (connected && port !== 'clean' && !connected.has(port)) return;
```

`clean` always renders; **the other three render ONLY when something downstream is
connected.** So a style monitor pointed at `watercolor` with nothing patched to it shows a
never-written FBO — black on the first boot, and a stale frame from whenever it was last
patched thereafter. That is worse than not offering it: a picker that silently shows a lie is
the `[GATED]` badge defect (§13.4) rebuilt on purpose.

**Two honest routes, neither of which is this PR:**

1. **A product change** — teach the module that a previewed port counts as connected. The
   seam exists (`frame.connectedOutputPorts?.(node.id)`, `:752`), and `markWatched` /
   `blitOutputPortForPreview` is already the fleet's "someone is looking at this" signal. This
   is the RIGHT fix and it is a video-engine change, so it costs a **real GPU re-attest** and
   belongs in its own PR with its own measurement.
2. **Ship `clean` only** — the card's behaviour, verbatim. This spec takes route 2 and
   **records route 1 as the follow-up**, because a face PR that changes what the GPU renders
   is not a face PR.

⚠ **Recorded rather than quietly dropped, because it is the single best idea this module
suggests** and the next agent to look at this face will have it again within five minutes.

### 7.4 SCREEN OFF — and the one obligation that is NOT optional here

OFF collapses the preview and reclaims its vertical space; the module KEEPS RENDERING; ON
shows the LIVE picture, never a stale frame; the state lives on `node.data.previewCollapsed`
(never component `$state` — the component unmounts on dock collapse / LRU eviction, the
#1531 / #1574 / #1583 class) and survives a tab switch, a remount, a reload and a sync.

**Placement is a MEASUREMENT, not a taste: OVERLAY the picture's bottom-right corner on a
translucent backplate (`rgba(5,6,8,0.72)`), NEVER a row of its own.** The stacked row cost
spirographs ~18.8 px against ~11 px of slack and overhung the card by 7.8 CSS px against a
tolerance of 6.

⚠ **`markWatched` MUST STILL FIRE WITH SCREEN OFF.** The blit IS the watch mark (#1937 /
#2015), so an OFF state that merely stops blitting drops the node out of the pull set. On a
FILTER that would stall a preview; **on this module it would stop the GENERATOR every
downstream node is sampling** — lushgarden is a pure SOURCE with no input requirement, so it
is the origin of the signal, and a lapsed mark mutes the patch rather than the preview. This
is the acidwarp argument verbatim (`face-rack-status-source.test.ts:241`) and it applies here
for the same reason.

⚠ **AND ONE MORE, SPECIFIC TO THIS MODULE AND EASY TO GET WRONG.** Collapsing must not stop
`surface.draw`. If it did, the garden would **stop accumulating** — and because the picture is
a running integration rather than a function of the current params, re-opening SCREEN would
show a garden that is *younger than the rack*. Every other adopter's picture is stateless
enough that "keeps rendering" is a performance nicety; here it is a correctness requirement.
Make it a permanent leg of the face model test.

---

## 8. CONTROL INVENTORY — every primitive decision, argued

| face key | primitive | derivation | why not the alternative |
|---|---|---|---|
| `rate` | **knob** | `paramCellKind` default | Not `'fader'`. A fader is *a LEVEL the player expects to see as a THROW* (`shell-control-kind.ts:63`); a log-curve spawn rate over 0.5..10 has no throw semantics and no unity point. |
| `rate` | ⚠ **NOT a `warped-fader`** | — | Checked deliberately, because the shape invites it. `ShellWarpedFaderCell` (landed 2026-08-23 on `face/samsloop-2026-08-23`) exists for *any param whose CARD converts at the boundary* — samsloop renders knob space 0..1 and maps piecewise, so unity sits at the fader's midpoint. **LushGardenCard does not convert**: `:148` passes `min={0.5} max={10} curve="log"`, the def's own numbers in the def's own space. There is no warp to declare, and declaring one would be a second implementation of a map that does not exist. |
| `view` · `horizon` · `fov` | **knob** | default | Same reasoning; all three are 0..1 linear positions, not levels. |
| all four | **`paramCells`: NOTHING DECLARED** | — | `'grid'` needs picture-states, `'color'` a packed RGB, `'hue'` a wrapping angle, `'fader'` a level. None applies. ⚠ `'hue'` was considered for nothing here and is named only so a reader does not reach for it on account of `psychedelic` — that hue is a wall-clock rotation the module owns, not a param. |
| all four | **landmarks: NONE** | §5 | Refused on attest cost, with `horizon = 0` recorded as the one to revisit on a free ride. |
| `cv_grow` · `cv_reset` | **`noUserControl`, `writer: 'cv-port'`** | `cvWritersOf` finds `grow` / `reset` | Anchored in both directions: rename the port and the entry reddens. |
| `freeze` | **`noUserControl`, `writer: 'internal'`** | asserted NO port targets it | ⚠ And the day someone adds a `freeze` CV input, the entry reddens and gets re-read. That is the mechanism, not a nicety. |

**No `ShellActionCell`, no `ShellFileCell`, no `face.momentary`, no PF-14 panel.** This module
has no button anywhere, on any surface. Recorded explicitly, because "there is no action cell"
is the kind of absence a reviewer should be able to confirm rather than infer.

---

## 9. THE STATE MATRIX

| # | `grow` patched | SCREEN | `freeze` | body paints | bands paint | what a reviewer checks |
|---|---|---|---|---|---|---|
| 1 | no | ON | 0 | the garden, filling at `rate` | RATE live, camera live | the baseline mock |
| 2 | no | ON | 0, `rate = 0.5` | fills 20× slower | identical | **the bands look the same and the picture does not** — which is why `rate` is rank 1 and why no readout is needed to see it |
| 3 | **yes** | ON | 0 | the garden grows **one plant per gate edge** | ⚠ **RATE is visibly present and completely dead** | §10.1 — the one state the face must be able to explain |
| 4 | no | ON | 0, `horizon = 0` | every plant on one flat bottom row | HORIZON at its floor | the degenerate composition |
| 5 | no | **OFF** | 0 | nothing | unchanged | ⚠ the garden **keeps accumulating** (§7.4); re-opening shows a garden as old as the rack, not a fresh one |
| 6 | no | ON | **1** | the last frame, held | unchanged | the VRT state, and the only way any surface reaches `freeze` after §13.1 |
| 7 | — | ON | 0, manifest failed | ⚠ **an empty frame that looks exactly like a garden that has not grown yet** | unchanged | §10.2 — the finding the plant-count readout carried |

⚠ **Rows 3 and 7 are the two states where the picture cannot tell you what is wrong, and both
of them lose their surface to the resting-text ruling.** They are the reason §10 is the
longest section in this spec.

---

## 10. THE ARIA CONTRACT — where the deleted text went, and what a FINDING lost

Two resting readouts are deleted. Per the standing rule, **say which finding lost its
surface.**

### 10.1 The `[GATED]` badge — deleting a readout that was ALSO WRONG

**What it was.** A `[GATED]` chip, shown when `patch.edges` contains any edge targeting the
`grow` port (`LushGardenCard.svelte:108-112`).

**What it was FOR.** State 3 of §9: with GROW patched, `stepSpawner` returns zero
unconditionally (`lushgarden-scene.ts:323-326`) and **the RATE knob does nothing at all.** The
badge is the only thing on any surface that says so.

⚠ **AND IT IS NOT ACTUALLY TRUE — it disagrees with the engine.** The engine's gate is
`growPatched`, which is set on the FIRST bridge write and **never cleared**
(`lushgarden.ts:831`, and the def says so in prose at `:355`: *"Unpatching holds gated mode
until the module is respawned"*). So: patch GROW, send one edge, unpatch. The badge
disappears; the module stays gated forever; RATE is present, turns, and is dead. The engine
already publishes the correct signal — `read('growPatched')` (`:860`) — and the card does not
read it; it polls only `plantCount` (`:85`). **The module's own e2e knows better:**
`e2e/tests/lushgarden.spec.ts:175` asserts on `growPatched`, not on the badge.

**So the ruling deletes a lie, and the truth has to be relocated:**

| control | `aria-valuetext` |
|---|---|
| `control-rate` | `2.0 spawns per second` — normally |
| `control-rate` | `2.0 spawns per second — INERT, the GROW input is driving the garden` — when `growPatched` |

⚠ **MUST-VERIFY §15.6: can a param cell's `aria-valuetext` read an ENGINE PROBE?** The
`FaceReadoutValue` registry that could read params is deleted (#1957), and `aria-valuetext` is
rendered by the shell's own param cell. If there is no module-supplied accessible-value seam,
the honest outcome is: **the inertness has NO surface on the faceplate, and that must be
written down rather than faked.** ⚠ In that case the fix is not a readout — it is
`docs.controls.rate` (which already says *"no effect while GROW is patched"*) plus §13.4's
product fix, which is to clear the latch on unpatch so the state stops being permanent.

### 10.2 The plant-count readout — the module's only liveness signal

**What it was.** `videoEngine.read(id, 'plantCount')` polled each rAF and printed
(`:142`, `:84-89`).

**What is lost, and it is real.** State 7 of §9. If `manifest.json` fails to fetch, or every
bake is still pending, the module renders a **perfectly valid empty frame** — which is
pixel-identical to a garden that simply has not grown yet at `rate = 0.5`. `plantCount` is the
only thing that separates "nothing has grown" from "nothing CAN grow", and the engine exposes
the whole diagnostic set for it (`manifestCount`, `manifestFailed`, `readyCount`,
`pendingLoads`, `:850-880`) of which the card used exactly one.

**Where it goes.** The display canvas's accessible name:
`role="img"`, `aria-label="LUSH GARDEN — 47 plants growing"` / `"— no plants yet"` /
`"— the plant atlas failed to load"`. That is speakable, assertable and unpainted. ⚠ It is
**not** a range role, so it is `aria-label`, not `aria-valuetext` — the same conclusion
`XyPad.svelte:317-330` records for pads.

⚠ **And the coverage that lapses, named.** `e2e/tests/lushgarden.spec.ts:123-129` asserts
`manifestCount > 0`, `plantCount >= 6` and `readyCount > 0` — but it reads them **off the
engine probe**, not off the card, so it survives promotion untouched. Good; and that is
exactly why it is not a substitute: **nothing will assert that the FACEPLATE says anything
about liveness.** Add that leg or record the gap.

### 10.3 The rest of the contract

| element | contract |
|---|---|
| the display canvas | `role="img"` + the `aria-label` above. ⚠ Not `aria-valuetext`. |
| the SCREEN button | `aria-pressed={!previewCollapsed}`, caption `SCREEN ON` / `SCREEN OFF`, a `title` saying the module keeps rendering — **and, on this module, keeps GROWING** (§7.4). |
| every param cell | `data-testid="control-<paramId>"`; `faces-parity` asserts EXACT MULTISET EQUALITY against the def's param ids and scans the whole `dockShell` **including the extension body**. ⚠ The three `noUserControl` params must render **exactly ZERO** cells — an inverted assertion, which is what makes the declaration falsifiable in both directions (`no-user-control.ts` consumer 4). |
| the body | must carry the shell's own `data-cell-*` wrapper if it ever paints a control. It paints none today, so this is a note for §7.3's follow-up. |

⚠ **Keyboard.** Owner ruling: no keyboard-a11y work. Do not add key handling and do not file
keyboard-nav issues.

---

## 11. DETERMINISM AND VRT — this face IS baselinable, and the mechanism already ships

**Two new scenes** — `face-lushgarden-compact`, `face-lushgarden-dock` — added by hand to the
`FACES` roster in `e2e/vrt/_shell-faces.ts` with the post-hero-split band count (**2**; no
hero, so nothing empties). Nothing ties that roster to `STRICT_FACES`.

**The problem.** Both scenes carry a LIVE picture: the compact tile through
`hasVideoSurface`, the dock through the body. The garden spawns from a wall clock, integrates
a grow-in curve per plant, and bakes cutouts two per frame. **It is a different picture on
every frame and on every boot.**

**The solution, and both halves already exist.**

1. **`freezeFaceVideo` writes `params.freeze = 1`**, and on this module that genuinely stops
   the picture: `lushgarden.ts:677` returns from `surface.draw` before anything else. ⚠ But it
   *"stops the picture; it does not choose WHICH picture"* — the exact wording `_shell-faces.ts:980`
   uses about `outlines`, whose frozen frame measured **6724 px against a 1500 px
   tolerance** across two ubuntu CI boots.
2. **`simPin` chooses which.** `globalThis.__lushgardenVrtSeed` (`lushgarden.ts:680-698`)
   resets the scene, spawns a fixed **24** fully-grown plants from a seeded RNG, and
   **suppresses all further spawning**. That is strictly stronger than `outlines`' pin: the
   picture becomes time-invariant, not merely phase-pinned.

```ts
{ type: 'lushgarden', pages: 2,
  videoFaceWhy: '…the tile and the body both carry a live surface, and the garden is a '
    + 'wall-clock accumulation: plants spawn on a rate, each integrates a 0.35 s grow-in, '
    + 'and bakes drain two per frame, so the picture differs on every frame and every boot.',
  simPin: [{ global: '__lushgardenVrtSeed', value: 0x5eed,
    why: '…pins a fixed 24-plant set from a seeded RNG AND sets vrtMode, which suppresses '
      + 'all further spawning — so the surface is time-invariant rather than merely '
      + 'phase-pinned. Reuses the value the CARD scene already pins (vrt-scenes.ts:604), '
      + 'so the layout is one a human has already reviewed in the legacy baseline.' }] }
```

⚠ **`simPin` REACHES THIS MODULE, and that is not automatic.** It installs boot-time globals
with `addInitScript`, so it works only for a factory running in the PAGE's global scope.
`acidwarp` is unreachable precisely because its `renderLocus` is `'worker'`
(`FACES_WITHOUT_SCENES`, #2111). **`lushgarden.ts` declares no `renderLocus`** — grep returns
zero hits — so it runs main-thread and the global is visible. ⚠ **MUST-VERIFY §15.7**: the
read site is inside `surface.draw` (`:680`), evaluated every frame rather than at
construction, so even a late write works; confirm that against the harness's write ordering.

⚠ **`FACES_WITHOUT_SCENES` IS NOT THE ROUTE, and neither is `freezeIsNotASeam`.** The
exemption's bar is *evidence that `simPin` and `freeze` cannot reach this renderer*; here both
reach it. And `freezeIsNotASeam` is a field on `UnbaselinableFace` — it is only ever read for
entries **inside** `FACES_WITHOUT_SCENES` (`workflow-shell-faces.spec.ts:777-779`), so it is
not applicable to a module in `FACES`. ⚠ Note for the record: `freeze` on this module IS a
determinism seam in the ordinary sense, unlike `acidwarp`'s, so even if the module ever did
need the exemption the declaration would be refused — correctly.

**MUST NOT MOVE — a diff here is a finding, not a re-pin:**
`e2e/vrt/__screenshots__/vrt.spec.ts/lushgarden.png` (566×565) renders the LEGACY card, which
this PR does not touch. ⚠ Its scene sets the same seed and uses `freezeAudio: false` with an
argued `freezeAudioWhy` (`vrt-scenes.ts:625-628`) — **do not "tidy" that to match the new face
scenes**; it is a different capture with a different justification.

**MOVES, and predict it:** `rear-lushgarden` gains two sections derived from `face.pages`
(§6). Count the files the capture bot commits against the prediction; a green dispatch that
committed nothing is a RED FLAG.

**CI wall-time.** `faces-parity` budgets ≈ `10 s + 0.8 s/cell` on CI. **4 cells ⇒ ≈ 13.2 s**,
plus two VRT scenes. Well under the ~2 min sign-off threshold. ⚠ Separately: this module is
already the fleet's slow case in the behavioral lane — it is the named subject of the 96 000 ms
CI timeout that drove the `behavioralTimeoutMs` rework
(`e2e/tests/behavioral-observation-window.spec.ts:14`) and its bespoke spec costs 21.3 s
(`e2e-timings.generated.json:170`). **The face adds nothing to that lane, but do not also
add a bespoke face spec here without re-costing the shard.**

---

## 12. COST

| item | cost |
|---|---|
| **WebGL attest** | **ZERO — VERIFIED, and CONDITIONAL ON §5.** `flox activate -- bash scripts/webgl-attest-hash.sh --list` returns 218 files including `packages/web/src/lib/video/modules/lushgarden.ts` and `lushgarden-scene.ts` (they enter through rule (1), the fail-closed whole-directory sweep of `lib/video`, `webgl-attest-lib.ts:256-266`). But `face`, `noUserControl`, `docs` and `controlFamilies` are stripped by `attest-code-basis.ts:96-108`, and this PR touches **only** those. ⚠ **`LushGardenCard.svelte` is correctly ABSENT from the basis** (it uses a 2D context, `:69`) — and the new `LushGardenScreenBody.svelte` must stay 2D for the same reason, or it pulls itself in through rule (2) and every future edit costs a GPU. |
| **contract-lock** | Only if §7 needs a `controlFamilies` entry (it does not, as specified — there is no family control). `face` is fully contract-transparent (`FACE_FIELDS_IN_LOCK` is empty) and `noUserControl` is not projected. ⚠ **So `task docs:accept` should produce an EMPTY diff. A non-empty one is a finding**, and the most likely cause is an accidental param edit — which is also the attest tripwire. |
| **docs** | `lushgarden` is in `STRICT_DOCS` (`strict-docs.ts:386`) and **all seven params already have `docs.controls` prose** (`:364-372`), including the three hidden ones. Nothing to add. ⚠ Fold §13.8's two stale comments in while here (boy-scout). |
| **Push 2** | ⚠ **THE HEADLINE COST, AND IT IS A FIX.** No `PUSH_CARD_CONTROLS` override, so authoring a face moves the module GENERIC → FACE and the whole card changes. **Today the generic tier gives all seven params an encoder** because `noUserControl` is empty (§13.1). After this PR the face tier gives four. Accept the golden diff deliberately, with the reason in the test — *the three that disappear are the defect being fixed, not controls being lost.* |
| **ART** | **NIL — confirmed.** No `art/` fixture names lushgarden; it has no audio path. |
| **New code** | one `shell-extension.ts`, one `LushGardenScreenBody.svelte` (2D only), one `STRICT_FACES` line, one `FACES` roster row with `videoFaceWhy` + `simPin`, one `lushgarden-face-model.test.ts`. |
| **Conflict surface** | `strict-faces.ts` · `_shell-faces.ts` · `push-card-config.ts` + its golden · `strict-docs.ts` (no change) · `contract-lock.txt` (GENERATED — take main and re-run the accept task, never hand-merge). |

---

## 13. DEFECT LEDGER

Recorded here and **reported to the orchestrator for routing**. None is fixed in the spec PR.

**13.1 — ⚠ P1, LIVE, AND NOT A FACE PROBLEM: three unturnable params are on the Push 2 and
the group bar, and turning one silently bricks the module.** `lushgarden.ts` declares no
`noUserControl`. Consequences, all mechanical and all present on `main` today:

- **Push 2.** No override + no face ⇒ the GENERIC tier. `genericControls` skips only
  `momentary || noControl || !isTurnable`; `noControl` is `new Set(def.noUserControl ?? [])` =
  **empty**. Seven turnable params, `PUSH_CARD_SLOTS = 8` ⇒ **all seven get an encoder**,
  including `cv_grow`, `cv_reset` and `freeze`.
- **What turning them does.** A graph param write reaches the handle
  (`video/engine.ts:870-872`). `cv_grow` past 0.6 hits `lushgarden.ts:829-835`: **`growPatched`
  latches TRUE PERMANENTLY**, `stepSpawner` returns 0 forever, and **the RATE knob is dead with
  no badge** (the badge reads edges, and there is no edge). `freeze` past 0.5 hits `:677` and
  **the module stops rendering entirely.** Neither is recoverable without respawning the node.
- **Group bar.** `listExposableControls` auto-synthesises a knob for every param not covered by
  `exposableControls` minus `noUserControl` (`group-controls.ts:85-86`). lushgarden declares
  neither, so **collapsing a group containing it offers all three as knobs** — the exact bug
  #1726 was written to fix, on the exact module class it was written for.

**Fix, and it is three lines and HASH-TRANSPARENT** (`noUserControl` is in
`HASH_TRANSPARENT_PROPS` *precisely so a video def can declare one without a GPU re-attest* —
the property's own doc comment says so):

```ts
noUserControl: [
  { param: 'cv_grow',  writer: 'cv-port',
    why: 'the GROW jack writes it; a rising edge spawns one plant and the first write latches gated mode.' },
  { param: 'cv_reset', writer: 'cv-port',
    why: 'the RESET jack writes it; a rising edge clears every plant.' },
  { param: 'freeze',   writer: 'internal',
    why: 'a VRT determinism hook — at >= 0.5 surface.draw returns and every output holds its last frame.' },
],
```
**Severity: fold into the face PR.** It is the audit the queue predicted, and its outcome is
the def correction the queue said it might be.

**13.2 — the card re-types four ranges and NOTHING checks them.** `LushGardenCard.svelte:148`
is `min={0.5} max={10}` where `lushgarden-scene.ts:157-158` exports `RATE_MIN`/`RATE_MAX` —
**and the card already imports from that module** (`:24-28`). Same at `:154`, `:160`, `:166`.
They agree today, so this is latent. But `LushGardenCard.svelte` is not in
`RANGE_BOUND_CARDS`, whose own stated scope is *"every card NOT in this set is unchecked"* —
so a divergence would be invisible to every gate, which is the backdraft class verbatim.
**Severity: fold in (import the symbols, enrol the card).** Cheap, and boy-scout.

**13.3 — `freeze` is written by NOTHING in the product.** Read at `:677`, documented at
`:371`, and never written: the card writes four params, and the card VRT scene uses
`__lushgardenVrtSeed` + `settleMs`, not `freeze` (`vrt-scenes.ts:597-628`). `freezeFaceVideo`
only runs for FACED modules. So today `freeze` is reachable **only** through 13.1's Push
encoder, where it is a footgun. **This spec makes it live** (the face scene writes it, §11) —
so 13.3 closes as a side effect, and 13.1's declaration is what stops it being reachable any
other way. Recorded because the same shape will recur.

**13.4 — the `[GATED]` badge disagrees with the engine after an unpatch.** §10.1 in full.
Card badge = "an edge targets GROW"; engine gate = `growPatched`, a permanent latch. Unpatch
and the badge lies. The engine already publishes `read('growPatched')` and the card ignores
it. ⚠ **The deeper question is whether the LATCH is right at all** — "unpatching holds gated
mode until respawn" is a defensible design and an indefensible surprise, and clearing it on
unpatch would make the badge true and the RATE knob recover. **Severity: owner question**
(latch semantics), with a cheap partial fix (bind the badge to the engine signal) available
today. Report.

**13.5 — the white-matte chroma-key path is DEAD CODE against the shipped atlas.** Every one
of the 76 manifest entries carries `"matte": "none"`, because `scripts/lushgarden-dekey.cjs:194`
force-writes it after keying offline. So `entry.matte === 'white'` (`lushgarden.ts:528`, `:581`)
is never true: `estimateKeyBackdrop` (~40 lines with an `OffscreenCanvas` readback, `:451-491`)
never runs, `uMatteWhite` is always 0, and the `if (uMatteWhite > 0.5)` branch of PREP_FRAG
(`:171-179`) is unreachable. The module header (`:39-43`) describes it as live.
**Severity: cleanup, low priority** — but it is ~60 lines of GPU code and prose that a future
reader will trust. Report; **do NOT delete it in a face PR** (it is basis code and would cost
a GPU re-attest for a no-op).

**13.6 — three of six input ports are unasserted, and the sweep is known-vacuous for a
fourth.** `per-module-per-port-behavioral.spec.ts:1060-1062` skips `lushgarden.rate`,
`.horizon` and `.view` with measured `why` strings (Δμvar 0.7–132 against a ±300 stochastic
variance floor). Independently, `_module-coverage-helpers.ts:280-287` records the negative
control: **making RESET a no-op and re-running the sweep still PASSES 7/10** — root-caused to
the video arm's absolute floor (`varMeanΔ > 5` against an output whose whole variance is ~50).
**So of six inputs, the sweep meaningfully covers at most `grow` and `background`.**
**Severity: the sweep's floor is the defect, not this module.** Report; out of scope here.

**13.7 — the background-passthrough contract has NO live gate.**
`e2e/tests/lushgarden.spec.ts:244` is `test.fixme` (FLAKE-PARK #1847), and
`.myrobots/2026-08-18-flake-park-coverage-lost.md:68` names exactly what lapsed: *"that LUSH
GARDEN's clean output passes the background through OUTSIDE the plant silhouettes — the
compositing contract that makes the module usable as a layer rather than an opaque source."*
Nothing else asserts it. **Severity: real coverage hole on a shipped contract.** Report.

**13.8 — two stale in-repo control counts.** `LushGardenCard.svelte:7-8` says *"Knobs: RATE /
HORIZON / VIEW"* (there are four; FOV is at `:164`), and `rack-sizes.ts:206` says *"preview +
3 knobs"*. **Severity: fold in.** Boy-scout while the file is open.

**13.9 — content-budget fact, not a bug.** `SPAWN_MIX` declares 10 % trees but the atlas has
**7 tree cutouts of 76**, and trees are the largest sprite (`KIND_CANONICAL_HEIGHT.tree = 560`)
and the most identifiable. So ~1 in 10 spawns draws from a 7-image pool and the near rank
visibly repeats. Contributing cause: 3 of the 13 hand-DENY-listed ids in
`scripts/lushgarden-dekey.cjs:169` are trees. Recorded so a spec reader does not mistake the
repetition for a layout bug.

---

## 14. TASTE CALLS, EACH WITH ITS ONE-LINE REVERT

1. **No landmarks and no `units`, to keep the attest at zero (§5).** Revert: add
   `landmarks: [{ value: 0, label: 'flat' }]` to `horizon` — and the PR gains a real-GPU
   re-attest it does not otherwise need. ⚠ Recorded as the one to take **on a free ride**, if
   this def is ever in a PR that already pays.
2. **The style monitor is REFUSED (§7.3).** Revert: none available without a video-engine
   change. Consequence, stated plainly: **three of the module's four outputs remain invisible
   until they are patched somewhere.**
3. **`rate` is rank 1 over `view`.** Revert: swap them. Consequence: at mini the tile shows
   the camera pan for a garden that may not have grown yet.
4. **Two bands rather than one.** Revert: merge into a single `garden` band. Consequence: the
   face stops saying that `rate` is a different kind of thing from the camera — which is the
   §1 paragraph the whole ranking descends from.
5. **`fov` ranks last on the "no CV input" argument.** Revert: rank it 3 on its visual weight.
   Consequence: the rear card's two-jacks-under-three-knobs asymmetry stops having a stated
   reason.

---

## 15. MUST-VERIFY

1. **WHICH output the lane tile shows.** `blitOutputToDrawingBuffer(nodeId)` vs the card's
   `blitOutputForPreview(id)` over four FBOs. If they differ, say so on the face and pick one.
2. **The tier ladder**, derived through `curatedFace` — and note the caps are the
   PICTURE-bearing column (#1785), not the glyph-less one.
3. **Both bands pack into ONE row** — a `dock-row-plan` assertion, not an eyeball.
4. **`rearFieldPlan` does not orphan the `grow`/`reset` CV holes** whose target params are
   `noUserControl` and therefore ranked nowhere.
5. **Plate width ≤ pane width** — `workflow-shell-faces.spec.ts`'s content-vs-plate leg, which
   needs a baseline to run. The first `vrt:commit` IS the measurement.
6. **Can a param cell's `aria-valuetext` read an engine probe** (`growPatched`)? If not,
   record that the RATE-inert state has no faceplate surface. **Do not fake it.**
7. **`simPin` reaches this module.** `renderLocus` is undeclared (main-thread) and the seed is
   read inside `surface.draw` every frame — confirm against the harness's write ordering, then
   prove it: **three consecutive dock captures pixel-identical**, and a fourth with a DIFFERENT
   seed that is visibly different (the negative control — a pin that changes nothing is
   indistinguishable from a pin that never ran).
8. **SCREEN OFF does not stop `surface.draw`** — assert the garden keeps accumulating, via
   `read('spawnCount')` before and after a collapse window. ⚠ This is the leg that would catch
   the tempting-and-wrong optimisation.
9. **`markWatched` still fires with SCREEN OFF** — at the source level, with a negative
   control proving the pattern can fail (the quadralogical precedent: a runtime probe is not
   available because `isPullRoot` is private).
10. **The three `noUserControl` params render EXACTLY ZERO cells** in both the pure lint and
    `faces-parity` — the inverted assertion, which is what makes the declaration falsifiable.

---

## 16. VERIFICATION GATE

```sh
# 1. the pure model + this face's PERMANENT negative controls (§9 rows 3/5/7)
REPEAT=3 flox activate -- task test:one -- lushgarden-face-model
# 2. the scene math is untouched — run it because §13.2 edits the card's ranges
flox activate -- task test:one -- lushgarden-scene
# 3. face lint: completeness, the ZERO-cell inversion for the three declared params, rear
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
flox activate -- task test:one -- video-face-screen-source   # THE SCREEN SWITCH — this one sees us
flox activate -- task test:one -- face-rack-status-source    # the fullViewBody ROSTER entry
# 5. the #1726 machinery, in both directions
flox activate -- task test:one -- no-user-control
flox activate -- task test:one -- push-card-schema           # the three encoders DISAPPEAR — accept deliberately
flox activate -- task test:one -- rear-card-model
flox activate -- task test:one -- card-range-source          # after enrolling the card (§13.2)
flox activate -- task test:one -- module-docs-lint
# 6. the contract diff must be EMPTY. A non-empty one is a finding — and the attest tripwire.
flox activate -- task docs:accept && flox activate -- git diff
# 7. e2e
flox activate -- task e2e:serve
REPEAT=3 flox activate -- task e2e:one -- tests/faces-parity.spec.ts
REPEAT=3 flox activate -- task e2e:one -- tests/lushgarden.spec.ts
flox activate -- task e2e:stop
# 8. typecheck LAST — svelte-check is stricter than vitest
flox activate -- task typecheck
# 9. VRT: dispatch only. NEVER commit a PNG. Predict the file count first.
flox activate -- task vrt:commit
# 10. attest: EXPECTED ZERO. Run the CHECK to prove it, and report the hash either way.
flox activate -- task webgl:attest:check
```

**The negative controls, spelled out so a builder cannot ship a green stub:** a DIFFERENT
`__lushgardenVrtSeed` must produce a visibly different dock capture (a pin that changes
nothing is indistinguishable from a pin that never ran); SCREEN OFF for N frames must leave
`read('spawnCount')` STRICTLY HIGHER than before, not equal; writing `cv_grow` must leave
`control-rate` present and its `aria-valuetext` changed; and `task webgl:attest:check` must
print the SAME hash as `main` — a moved hash means a param was edited and §5 was violated.

## 17. BUILD-COST ESTIMATE

| phase | estimate |
|---|---|
| the `noUserControl` audit + declaration (§13.1) — the AUDIT is the work, not the typing | ~2 h |
| `face` block + `docs.controls` boy-scout + the two stale comments (§13.8) | ~1 h |
| `shell-extension.ts` + `LushGardenScreenBody.svelte` (2D preview + SCREEN overlay) | ~2.5 h |
| §13.2 range import + `RANGE_BOUND_CARDS` enrolment | ~0.5 h |
| `lushgarden-face-model.test.ts` with §16's negative controls | ~2 h |
| roster/registry edits + push golden (three encoders disappear — write the reason) | ~1 h |
| gate loop, 3× flake checks, typecheck | ~2 h |
| VRT dispatch + the seed negative control + rear re-capture | ~1.5 h wall |
| **total** | **≈ 12.5 h** |

**Risk rank: LOW-MEDIUM.** Every mechanism it needs already ships; the determinism story is
the strongest in this wave (the seed hook is better than `outlines`'); and the one genuinely
novel idea (§7.3) was refused with a reason rather than attempted. **The risk that remains is
entirely in §13.1** — it is a real product fix on two surfaces nobody is looking at, and it
must be verified on the Push card and the group bar, not merely typed into the def.
