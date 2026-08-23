# FACEPLATE BUILD SPEC — `quadralogical` (video, 4-input XY crossfader)

> **SPEC + MOCK.** Authored to the bar of `.myrobots/plans/dx7-and-faces-design-program-2026-07-27.md`
> §7 ("THE RECIPE") and the format of `.myrobots/plans/face-redo-dx7.md`. Two of that
> spec's sections — §5 *THE READOUT STRIP* and §6 *THE SIDEBAR* — are **historically
> shaped and are not reproduced**: both mechanisms were deleted fleet-wide on 2026-08-19
> (`face.sidebar`, `face.hero.readouts`, #1957). What replaces them here is §8 (the
> ARIA CONTRACT), because on this module the value that used to be painted is the pad's
> own position, and that is the one number the owner named by hand.
>
> **Mocks:** `screen-off.html` · `screen-on.html` (open in a browser; self-contained).
>
> **Figure labels used throughout** — `DERIVED-BY-READING` (I read the file and the
> claim follows from it) · `MEASURED` (a number taken from a committed artifact or a
> run) · `MUST-VERIFY` (a claim the build has to prove before merge; listed again in §11).

**Verdict: PROMOTE, and the promotion FIXES TWO LIVE DEFECTS.** `invert` is a documented
control with **no UI on the legacy card at all**, and every `edge{N}_fx` selector is a
`0..7 discrete` param with **no `options` roster**, so the def's eight named effects reach
the player only through a hand-rolled `<select>` the card builds from `TRANSITIONS`. The
face is what makes both reachable through the contract.

---

## 0. THE OWNER'S DESIGN, AS RECEIVED — and what each line costs

The five requirements, verbatim, each mapped to the mechanism that implements it. These
**override any conflicting convention** and nothing below re-litigates them.

| # | requirement | mechanism | cost |
|---|---|---|---|
| 1 | the face has a SCREEN with an ON/OFF toggle | `fullViewBody` shell extension, `node.data.previewCollapsed` | the fleet-standard route (`4plexvid`, `backdraft`, +24) |
| 2 | SCREEN OFF shows the card's XY pad — diamond, IN1–IN4 corner labels, red puck, no video | the same body, canvas unmounted, joystick overlay retained | **a DIFFERENCE from the fleet standard — see §3.3** |
| 3 | SCREEN ON shows the same joystick with each quadrant a live 4:3 preview of its input; the frame RE-ASPECTS | `blitOutputPortForPreview(nodeId, 'preview')` — the module's EXISTING `preview` port already renders exactly this 2×2 tile | zero new GLSL |
| 4 | the standalone preview screen is REMOVED | delete the card's `CANVAS_W×CANVAS_H` MIX canvas from the face | ⚠ **a parity loss unless designed around — see §4** |
| 5 | the four EDGE boxes move BELOW the screen, not beside it | `fullViewBody` renders **above** `.dock-pages` (`ModuleShell.svelte:1439-1457`), so every band is already below it | free — it is the platform's own ordering |

⚠ **Requirement 5 is free and requirement 3 is nearly free, and that is worth stating
up front, because it inverts the obvious cost estimate.** The expensive line is **2**,
not 3: the quadrant previews are a port that already exists and a blit helper that
already exists, whereas "SCREEN OFF still shows a control" has no precedent in the
twenty-six `fullViewBody` adopters, all of which unmount everything.

---

## 1. WHAT THE MODULE ACTUALLY DOES

**In one paragraph, and every rank below descends from it.** QUADRALOGICAL is the only
module in the fleet where **the mix and the transition are the same gesture**. A video
mixer gives you faders; a switcher gives you buttons. This gives you a stick over a
square, and *where the stick is* decides both **which inputs you see** and **which of
four independently-configured blend effects is doing the combining**. The verb is not
"set a level", it is **STEER**: you push toward a corner to cut to one source, sit on an
edge to crossfade two through that edge's own effect, or drop into the centre diamond for
a balanced four-way composite. Everything else on the module is setup for that one drag.

**The signal path, in the order the shader runs it** (`video/modules/quadralogical.ts`):

1. **Normalling** — `normalizeInputs(present)` (`:336`) forward-fills an unpatched input
   to the nearest lower PATCHED one (in4→in3→in2→in1); nothing patched ⇒ all four bind a
   standalone 1×1 black `emptyTex` (`:838`), never the module's own FBO (that is a GL
   feedback loop). DERIVED-BY-READING.
2. **Corner weights** — `quadWeights(x, y, margin, K)` (`:111`): bilinear base over the
   unit square, then a diamond-aware power-sharpening `p = 1 + K·smoothstep(margin, 1, |x|+|y|)`,
   renormalised with a `+1e-6` guard so an exact corner (three zero weights) does not
   divide by zero.
3. **Edge terms** — `edgeWeights` (`:186`) turns those four weights into four
   `(mass, ratio)` pairs over the INDEX CYCLE `(1,2) (2,3) (3,4) (4,1)` (`EDGE_PAIRS`,
   `:156`). ⚠ **This is an index cycle, NOT geometric adjacency** — edge 2 is `in2↔in3`,
   which is TR↔BL, a *diagonal* of the pad. The def says so at `:152-154`; the face must
   not quietly "fix" the labels to look adjacent.
4. **Per-edge blend + layer** — each edge runs its own effect on its two inputs at its
   ratio (`blend2`, `:264` / GLSL `blend`, `:491`), and the four results are composited
   weighted by mass: `out = Σ mass·blend / Σ mass` (`:557-567`).
5. **A SECOND FBO** — `previewFbo` renders a 2×2 tile of the four RAW inputs, in1 TL /
   in2 TR / in3 BL / in4 BR, with a `0.004`-wide separator cross (`PREVIEW_FRAG_SRC`,
   `:575-611`), exposed as `read('outputTexture:preview')`.

**What is INERT AT SPAWN, and it is most of the module.** All four edges default to
`fx = 0` = DISSOLVE, and `EFFECTS[0]` is `{ amount: null, param: null }` (`:371`) — so at
a fresh spawn **all eight `edge{N}_amount` / `edge{N}_param` controls do literally
nothing**, and `keyR/keyG/keyB` do nothing either (no edge is CHROMA). That is 11 of 21
params dead on arrival, and it is the single strongest ranking fact on this module.
DERIVED-BY-READING.

**What is ALWAYS live**: `pos_x`, `pos_y`, `diamond_margin`, `blend_sharp`, and the four
`edge{N}_fx` selectors (at centre every mass is 0.5 and every ratio is 0.5, so changing an
fx changes the picture immediately, even without moving the stick).

**Measured facts worth knowing.** At the exact centre `edgeWeights` returns `mass = 0.5,
ratio = 0.5` for all four edges (`:182`) — the composite is a balanced blend of four
blends, not of four inputs. At an exact corner the two edges touching it collapse to that
pure input and the other two carry mass 0, so a corner is a clean cut. `VIDEO_RES` is
**1024×768 = 4:3** (`video/video-res.ts`), which is why requirement 3's arithmetic works
(see §3.2).

---

## 2. STOP 1 — is promoting this module a PARITY LOSS?

**No, and the one candidate loss is designed around rather than accepted.** Reading
`QuadralogicalCard.svelte` line by line:

| # | affordance on the card | site | survives promotion? |
|---|---|---|---|
| 1 | 380 px XY pad, drag writes `pos_x`/`pos_y` | `:418-455` | **YES** — the body's joystick field (§3) |
| 2 | IN1/IN2/IN3/IN4 corner labels | `:433-436` | **YES** — retained verbatim |
| 3 | crosshairs + yellow diamond scaled to `diamond_margin` | `:438-446` | **YES** — and CORRECTED (§3.4: the rotated-square trick is wrong at 4:3) |
| 4 | dot tinted by the DOMINANT input (`INPUT_COLORS`) | `:115-117` | **YES** — the puck ring keeps it |
| 5 | `x: 0.00  y: 0.00` readout | `:457-462` | **DELETED, by ruling** — the value moves to the pad's accessible name (§8) |
| 6 | `X·MIDI` / `Y·MIDI` badges | `:460-461` | **YES** — per-axis assign handles carry a bound state + badge |
| 7 | bespoke 2-axis right-click menu: Assign/Forget X and Y | `:571-578` | **YES** — per-axis `ControlContextMenu` |
| 8 | Send/Remove X and Y to **Control Surface** | `:582-602` | **YES** — same menu |
| 9 | Send/Remove X and Y to **Electra ▸ Row ▸ knob** (3-level cascade) | `:607-675` | **YES** — same menu |
| 10 | MIX preview canvas 270×152 | `:468-476` | ⚠ **REMOVED by requirement 4 — recovered by §4** |
| 11 | four EDGE `<select>`s over `TRANSITIONS` | `:488-498` | **YES** — and upgraded to a contract `options` roster (§6) |
| 12 | per-edge AMT/PRM faders, **relabelled per effect**, hidden when the effect has none | `:500-535` | **YES for the controls; the CONDITIONALITY is lost** — see below |
| 13 | `pure dissolve (joystick ratio)` hint text | `:534` | **DELETED, by ruling** — resting derived text |
| 14 | CHROMA key R/G/B row, shown only when an edge is CHROMA | `:543-550` | **YES for the controls; the CONDITIONALITY is lost** |
| 15 | `invert` | **nowhere** | **GAINED** — see §5.1 |

⚠ **Rows 12 and 14 are the honest debits, and they are debits of DYNAMICS, not of
controls.** The card re-labels `edge1_amount` as `Amt` / `Angle` / `Thr` / `Radius`
depending on the selected effect, and *hides* it entirely for DISSOLVE. A faceplate cell's
caption comes from the `ParamDef.label`, which is static, and there is no conditional-cell
mechanism on `ModuleFace`. So the face paints all eight edge controls all the time, with
their static def labels.

That is a **worse caption and a better contract**, and the trade is defensible in exactly
one direction: hiding a control because it is currently inert is the same shape as the
tier-ranking rule (`module-faceplates.md`: *"a lane cell that does nothing on a fresh
spawn is worse than absent"*), which the platform expresses through RANK, not through
visibility. §6 therefore spends the ranking on it: the eight conditional controls rank
10–17, below everything unconditional, which is the platform's way of saying the same
thing. **Recorded as a taste call with its revert in §10.**

## 3. STOP 2 — does every way of getting DATA IN survive? THE SCREEN.

```sh
grep -nE '<button|<select|<input|oncontextmenu|manualTrigger|Toggle|Selector|accept=' \
  packages/web/src/lib/ui/modules/QuadralogicalCard.svelte
```

Hits: the four `<select class="fx-select">` (rows 11), `oncontextmenu={openMenu}` (rows
7–9), and the `.ctx-item` buttons inside the portaled menu. **Zero `<input>`, zero
`accept=`, zero `node.data`-backed state** — this card stores nothing outside
`node.params`, which is why it has no `previewCollapsed` today and why the SCREEN switch
is genuinely new here rather than migrated.

### 3.1 The body, and why it is the only route

`face.extension: 'quadralogical'` → `$lib/ui/modules/quadralogical/shell-extension.ts` →
`fullViewBody: QuadralogicalScreenBody.svelte`. Promotion sets `migrated(type)` true and
`DockFullView` mounts `<ModuleShell>` instead of the card, so a switch that lives only on
the card is **deleted by the promotion that was supposed to keep it** — the #1928 class
that shipped `spirographs` without its toggle. There is no generic shell affordance
(`previewCollapsed` appears in zero shell files).

`ModuleShell.svelte:1439-1457` renders the body **at the head of the faceplate, above the
bands**. Requirement 5 therefore needs no mechanism at all: every band is below the screen
because the platform puts it there.

### 3.2 THE GEOMETRY — the frame re-aspects on the WIDTH, and the height never moves

The arithmetic behind requirement 3, and it comes out clean:

```
one quadrant = one input at VIDEO_RES = 1024x768 = 4:3
2 x 2 grid of 4:3 tiles  =  (2 x 4) : (2 x 3)  =  8 : 6  =  4 : 3
```

So the ON frame is 4:3 and the OFF frame is the card's square pad. **Pin the HEIGHT and
let the WIDTH change**, which makes the toggle cost ZERO vertical reflow:

| state | frame | ratio | note |
|---|---|---|---|
| SCREEN **OFF** | `360 x 360` | 1 : 1 | the card's pad at 380 px, trimmed to a round 360 |
| SCREEN **ON** | `480 x 360` | 4 : 3 | `+120 px` of WIDTH; the height is byte-identical |

⚠ **Nothing below the frame moves on toggle**, which matters precisely because the owner
put the edge boxes there. A height-changing toggle would jump the four EDGE boxes up and
down under the player's cursor mid-performance. MEASURED against the fleet: every other
`fullViewBody` toggle *does* change height, because on every other module the thing being
collapsed is the whole surface.

### 3.3 ⚠ SCREEN OFF MEANS SOMETHING DIFFERENT HERE, AND THE DIFFERENCE MUST BE DECLARED

The 2026-08-18 ruling says OFF "collapses the preview and **reclaims its vertical
space**" while the module keeps rendering. On all twenty-six adopters the collapsed thing
is a canvas and nothing else, so OFF reclaims the entire box.

**Here the frame is also the CONTROL.** Collapsing it would delete the joystick from the
dock outright — and since a declared pad never reaches a lane tier either (§6), that would
leave the module's primary gesture with **no surface anywhere**. So on this module:

* **OFF unmounts the `<canvas>` and keeps the joystick overlay**, re-aspecting the field
  to 1:1. What it reclaims is **120 px of WIDTH**, not the box.
* **OFF must still call `markWatched(nodeId)` every frame** (#1937 / #2015). The blit IS
  the watch mark, so an OFF state that merely stops blitting drops the node out of the
  pull set and the SCREEN switch becomes a **producer kill switch** for everything
  downstream of `out`. This module is a MIXER — it exists to feed something — so a lapsed
  mark mutes the patch, not a preview.
* ⚠ **It is sharper here than on a generator, for a second reason.** This module has TWO
  output ports. A player can be watching `preview` on a downstream monitor while the
  faceplate's SCREEN is OFF; the retained mark is what keeps *that* alive too.

### 3.4 ⚠ THE DIAMOND CANNOT BE A ROTATED SQUARE ANY MORE — and the card's version is a latent bug

`QuadralogicalCard.svelte:130` computes `diamondSide = margin * PAD_PX / √2` and draws it
as a CSS square with `transform: rotate(45deg)` (`:747-755`). That is exactly right **at
1:1 and only at 1:1**: a rotated square has equal semi-axes, and the boundary it must draw
is `|x| + |y| = margin` in NORMALISED coordinates, which is a rhombus with horizontal
semi-axis `margin·W/2` and vertical semi-axis `margin·H/2`. At the ON state's 4:3 those
differ by 4/3 and the rotated square would be **wrong by 33 % on one axis** — it would
claim the all-four zone reaches further up than it does.

**One implementation, correct in both states**, aspect-free because it is expressed in
percentages of the frame:

```css
clip-path: polygon(
  50% calc(50% - var(--m) * 50%),   /* +y vertex */
  calc(50% + var(--m) * 50%) 50%,   /* +x vertex */
  50% calc(50% + var(--m) * 50%),   /* -y vertex */
  calc(50% - var(--m) * 50%) 50%    /* -x vertex */
);
```

⚠ **Do NOT "fix" the card in this PR.** The card is 1:1, so its rotated square is correct
where it lives; changing it would move `vrt.spec.ts/quadralogical.png` for no behaviour.

---

## 4. ⚠ THE MIX PICTURE — the one thing requirement 4 would delete, and how it is kept

Requirement 4 removes the standalone preview. That canvas showed the **MIX** — the
canonical `out` surface, the thing the module produces. The quadrant previews show the
four **RAW INPUTS**. They are not the same picture, and swapping one for the other would
leave the faceplate of a MIXER unable to show its own mix.

Per the standing rule (*never surface "we would lose X" as an owner choice; preserve the
affordance, then promote*), it is designed in rather than raised:

> **THE PUCK IS A WINDOW ONTO THE MIX.** The draggable dot — which already exists, already
> has a position, and already costs the layout nothing — becomes a **34 px circular canvas
> blitting `blitOutputForPreview(nodeId)`**, ringed in the dominant-input colour it
> already carries. Drag toward IN2 and the puck fills with IN2's picture; sit in the
> diamond and it fills with the four-way composite.

Why this is the right shape and not a trick:

* **It costs ZERO layout.** The overlay-not-a-row argument that settled the SCREEN button
  applies unchanged: a second monitor beside the frame is the ~18.8 px stacked-row
  anti-pattern in a wider form, and the owner has removed a standalone preview *by name*.
* **It is the module's own semantics.** `quadWeights` is shared by the dot's tint, the
  drawn diamond and the GLSL composite (`:36-37`) — the puck is already the one element
  that is 1:1 with the mix. Making it show the mix is the honest completion of that.
* **Two blits per frame do not fight.** `blitOutputPortForPreview` keys its cadence on
  `(node, port)` (`engine.ts:1689-1692`) precisely so a card can show a primary preview
  and a second port at full rate — VIDEOCUBE's SLICE is the precedent.
* **It is ON-only.** With SCREEN OFF the puck is the flat tinted dot the card draws today,
  so "SCREEN OFF = no video anywhere on this plate" stays literally true.

**Taste call, with its revert (§10.1).** If the owner would rather the puck stay flat, the
revert is one line — drop the puck canvas — and the consequence must be stated plainly:
**the MIX then has no surface on the faceplate at all**, and the module's own output is
visible only by patching it somewhere else.

---

## 5. THE TWO DEFECTS THE PROMOTION FIXES

### 5.1 `invert` is a documented control with NO UI. `quadralogical.ts:723` / card: absent.

The def declares `{ id: 'invert', label: 'Inv', 0..1 }` and documents it — *"global key
inversion — flips which side of the CHROMA/LUMA key threshold is kept versus revealed"*
(`:775`). The shader reads it in both keyed branches (`:513`, `:520`). **`QuadralogicalCard.svelte`
renders no control for it** — grep the file: `invert` appears zero times. So today the
only way to reach it is a CV cable, and there is no `invert` CV input either. It is
**unreachable**.

No gate can see this: `module-face-lint`'s completeness only runs over `STRICT_FACES`, and
this module is not in it; `contract-lock` pins the param's existence, not its reachability;
`module-docs-lint` requires the docs entry that *describes the control that does not
exist*. Promotion is what arms the gate.

⚠ **And its `curve` is wrong.** It is `'linear'` over `0..1`, so a faceplate would paint a
continuous rotary over a param the shader thresholds at `>= 0.5` (`:513`). It must become
`curve: 'discrete'` so `looksLikeToggle` derives a `<Toggle>` — **a contract change, and
one that costs a WebGL attest** (§9.1).

### 5.2 Four discrete params with eight named states and no `options` roster.

`edge1_fx` … `edge4_fx` are `min: 0, max: 7, curve: 'discrete'` with **no `options`**
(`:707-717`). The eight names exist — `TRANSITIONS` (`:354`), exported — but only the
card's hand-rolled `<select>` reads them. A faceplate would paint an anonymous
eight-position dial printing `5`.

This is the `sampleHold` / `moog904b` shape exactly, and the fix is the same: **promote
the names the module already has onto the def as an `options` roster, exported, and import
it in the card** so there is ONE place. Eight entries over `0..7` is TOTAL by construction.
Eight exceeds `SEGMENTED_MAX_OPTIONS = 6`, so `paramCellKind` derives `'selector'` — a
portaled, viewport-clamped list showing the same eight names the card shows.
**This satisfies the owner's "NAMES not numbers" requirement through the contract rather
than through a component.**

---

## 6. THE RANK — `face.order`, and the argument for each

`order` is PRIORITY (what a shrinking tier keeps). `pages` is FUNCTION order (§7). They
**disagree deliberately** and the face comment must say so.

| # | key | why it earns this rank — an argument that would be WRONG for a different module | what it costs below |
|---|---|---|---|
| 1 | `pos_x` | On a mixer, rank 1 is a level. Here there are no levels: the stick IS the mix *and* the transition, and it is the only control whose gesture the module was built to receive. Nothing else can be rank 1. | anchors the `xy` cell |
| 2 | `pos_y` | Not a rank in its own right — the `xyPads` lint REQUIRES both axes in `order` while the y axis folds into the x cell and never paints one. Listed, not argued. | — |
| 3 | `diamond_margin` | The only param besides the pad that the **pad itself draws**: the yellow diamond IS `margin`, 1:1 (`:126-130`). Move it and the picture under your cursor changes. Wrong for any module whose pad carries no geometry. | — |
| 4 | `blend_sharp` | Partner to 3 and the other half of the weight model: 3 says how big the four-way zone is, 4 says how hard the edge of it bites. Always live, at every stick position. | ends the always-live set |
| 5–8 | `edge1_fx` `edge2_fx` `edge3_fx` `edge4_fx` | **They rank as a BLOCK and that is the finding, not a dodge.** Nothing distinguishes edge 1–2 from edge 3–4 — they are bit-identically symmetric slots over the same eight effects — so any ordering among them would be fabricated semantics. They rank above their own amount/param controls because a selector is the ONLY control on this module that makes another control live at all (§1: DISSOLVE leaves both dead). | pushes every conditional control to 10+ |
| 9 | `invert` | Global, shared by all four edges — it is the only key control that is not per-edge. Ranks above the key colour because inverting is the gesture ("keep the other side"), while R/G/B is setup. | — |
| 10–13 | `edge{1..4}_amount` | Inert at spawn (DISSOLVE reads neither). Rank as a block, for the same symmetry reason as 5–8. | — |
| 14–17 | `edge{1..4}_param` | Inert at spawn **and** unused by four of the eight effects (`EFFECTS`: DISSOLVE/ADD/MULTIPLY/DIFF declare `param: null`). Strictly deader than 10–13, so strictly lower. | — |
| 18–20 | `keyR` `keyG` `keyB` | Live only when some edge is CHROMA — 1 of 8 effects. The deadest controls on the module at spawn. | — |
| — | `freeze` | `noUserControl`, `writer: 'internal'` — a determinism toggle for VRT capture (`:868`); no port targets it and no card control sets it. | — |

**THE TIER LADDER — ⚠ AND IT IS NOT THE ONE THE RANKING SUGGESTS. CORRECTED
2026-08-22 BY THE CODE.** This section first read *"at mini you get the STICK; at compact,
the stick and the DIAMOND"*, and `quadralogical-face-model.test.ts` disproved it before a
line of the component ran. **`laneOrder` (`curated-face.ts:131-143`) ALREADY makes every
declared pad's anchor dock-only**, for a MEASURED reason that predates this face: a pad is
square and a lane knob column is 46 px, so squeezing it there would keep the gesture and
lose the precision.

So **no lane tier has ever painted a pad**, and the real ladder is: at mini the **DIAMOND**
— the size of the all-four zone, which is the one thing besides the stick that decides what
is on screen — and at compact **DIAMOND + SHARP**. Everything from the four selectors down
is dock-only too. MEASURED through `curatedFace` (`mini === ['diamond_margin']`,
`compact === ['diamond_margin', 'blend_sharp']`), never inferred from `LANE_PLATE_MAX_CELLS`
— the correction `ruttetra`, `monoglitch` and `reshaper` each had to make independently.

⚠ **Two consequences, stated rather than absorbed.** (1) `surface: 'body'` (§9.2) is
therefore a **DOCK-only distinction**: it changes *which dock surface* paints the pad, never
whether a lane has one. (2) The **#1974 `joystick` refusal is a different question and this
design does not answer it** — that module is refused because a pad is its ONLY control, so
its lane resolves to ZERO. Quadralogical has eighteen other ranked params, which is the
whole reason it can be promoted at all.

**THE LOSERS, NAMED.** `blend_sharp` lost the mini tier to `diamond_margin` because at
the shipped defaults (`margin 0.5`, `K 3`) the diamond is already drawn on the pad and the
sharpening is not: a player can *see* one of them. The four selectors lost the lane budget
to the weight model because a selector at a 46 px lane column is a chip you cannot read.
`keyG` lost despite being the only key channel with a non-zero default (1, green-screen)
— a good default is not a reason to rank, it is a reason not to need to.

---

## 7. BAND STRUCTURE — three bands, no tab rail, and the edge boxes in ONE row

```ts
pages: [
  // 1 — THE FIELD. The two params the PAD DRAWS, directly under the pad that
  // draws them. `pos_x`/`pos_y` are listed and NEVER render here: the screen
  // body paints the pad (face.xyPads[0].surface === 'body'), and a key with no
  // home falls into the defensive '__unpaged' band, which is a different and
  // wrong faceplate. If the body declaration is ever dropped they degrade
  // gracefully back into this band as a generic pad. (The dx7 hero precedent.)
  { id: 'field', label: 'field',
    controls: ['pos_x', 'pos_y', 'diamond_margin', 'blend_sharp'] },

  // 2 — THE FOUR EDGES. ONE band, four CLUSTERS, STACKED.
  //
  // ⚠ AUTHORED AS `clusterFlow: 'row'` AND CORRECTED AGAINST A MEASUREMENT —
  // see the §7 note below. Four boxes side by side is ~1260 CSS px against a
  // 1220 px pane; the width ruling won. Four separate BANDS cannot produce the
  // row either: an fx selector is a 'wide' cell, so `bandIsPackable` makes
  // every one of them SOLO.
  //
  // ⚠ THE CLUSTER LABELS ARE THE INDEX CYCLE, NOT GEOMETRIC ADJACENCY. Edge 2
  // is in2<->in3 = TR<->BL, a DIAGONAL of the pad (EDGE_PAIRS, :156). Do not
  // relabel them to look adjacent.
  { id: 'edges', label: 'edges',
    controls: [],
    clusters: [
      { label: '1–2', controls: ['edge1_fx', 'edge1_amount', 'edge1_param'] },
      { label: '2–3', controls: ['edge2_fx', 'edge2_amount', 'edge2_param'] },
      { label: '3–4', controls: ['edge3_fx', 'edge3_amount', 'edge3_param'] },
      { label: '4–1', controls: ['edge4_fx', 'edge4_amount', 'edge4_param'] },
    ] },

  // 3 — THE SHARED KEY. Everything here is global across the four edges, which
  // is exactly why it is not four more cells inside band 2.
  { id: 'key', label: 'key', controls: ['invert', 'keyR', 'keyG', 'keyB'] },
],
```

**THREE bands, so NO TAB RAIL** — `DOCK_TAB_MIN_BANDS = 7`. That is not a shortfall, it is
required: a rail shows **one band at a time**, so a tabbed face would put at most one edge
box on screen and directly contradict requirement 5. `face.tabbed` is owner-instruction
only and is **not** reached for here.

⚠ **The `edges` band carries 12 cells against `DOCK_ROW_MAX_CONTROLS = 10`.** That is
fine and is the documented behaviour: `packRun` never splits a section, so an over-cap band
takes a row by itself (`dock-row-plan.ts:packRun`) — which is what it wants anyway.

### ⚠ THE ROW FLOW WAS BUILT, MEASURED TOO WIDE, AND REVERSED — resolving MUST-VERIFY §11.3

This section first specified `clusterFlow: 'row'`, the literal reading of the owner's "a row
under the frame" and the only mechanism that puts clusters beside each other. It shipped, and
**linux CI measured it**:

```
face-quadralogical-dock: 40 CSS px of faceplate right of the capture box
                         (content 1260, shown 1220)
```

against a gate whose budget is `hiddenX === 0`, exactly. Four boxes of
`[selector 168 + two knob columns]` is ~1260 px; the dock pane is 1220. **The width ruling
won** — *"we do not want useless gray horizontal space on cards, ever"*, and the burden of
proof is on the wide face: the live 2×2 preview earns 480 px, nothing on this module earns
1260.

**Two owner instructions collided and this is the narrower reading of the layout note rather
than a contradiction of it.** "A row under the frame, **not beside it**" is a statement about
where the edges live *relative to the screen* — the legacy card put them in a right-hand
COLUMN — and four stacked clusters directly under the frame still satisfy that. Flagged in
the PR for an explicit ruling; **the revert is one word**.

⚠ **AND STACKING TURNS THE CONSOLE GRID ON — a gain, not a consolation.** Four clusters of
equal size is `consoleGridCols`'s own definition of a table, so column *j* has **ONE x across
all four strips**: every FX selector, every AMT and every PRM lands on a shared ruler. On four
bit-identically symmetric edge slots that alignment is exactly the point — it is the property
owner review of #1738 asked for on mixmstrs. The row flow would have turned it **off by
construction** (`console-grid.ts:88` refuses a row-flow band in its first clause, because a
shared ruler and a side-by-side flow are contradictory requests). Both halves are pinned in
`quadralogical-face-model.test.ts`, the second as the negative control.

⚠ **The lesson generalises past this face.** `faceplate-platform.spec.ts`'s PF-21 row sweeps
passed locally at both pane widths, because they ask a different question (do packed rows fit
their column). The *plate-vs-pane* measurement lives in `workflow-shell-faces.spec.ts`, which
**cannot run locally without a baseline** — so the width of a new face is not knowable before
the first capture. Treat the first `vrt:commit` on a wide face as a MEASUREMENT, not a
formality.

**REAR CARD.** `face.rear` is a projection of `pages`, so re-derive it: the CV holes land
`pos_x`/`pos_y`/`diamond_margin`/`blend_sharp` → `field`; `edge{N}_amount`/`edge{N}_param`
→ `edges`; `keyR`/`keyG`/`keyB` → `key`. **`invert` has no CV input**, so the `key` rear
section holds three jacks, not four — an asymmetry between the front band and the rear
section that is CORRECT and must not be "fixed". No page id collides with a curated group
id (there is no `face.rear.groups` on this def today). MUST-VERIFY against
`rear-card-model.test.ts`.

---

## 8. THE ARIA CONTRACT — where the deleted numbers went

The card's `x: 0.00  y: 0.00` row (`:457-462`) is deleted, under the ruling the owner has
now stated four times. **The value is not hidden, it is relocated**, and the mechanism is
NOT the one the brief names, for a reason that is a property of the role:

> ⚠ **It is `aria-label`, not `aria-valuetext`, and that is settled platform, not a
> shortcut.** The pad is `role="application"` — the correct role for a 2-D manipulation
> surface that owns its own key handling — and **`aria-valuetext` is only meaningful on a
> range role**. `XyPad.svelte:317-330` records the same conclusion when #2038 deleted the
> generic pad's readout row: *"a pad is `role="application"`, NOT a slider, so its
> accessible value lives in `aria-label`; there is no `aria-valuetext` on this role to
> move it to."* Every spec that proves a pad tracks the graph already reads `aria-label`.

**The contract, verbatim, on the joystick field:**

| attribute | value |
|---|---|
| `role` | `application` |
| `tabindex` | `0` |
| `data-testid` | `control-pos_x` |
| `data-control-params` | `pos_x,pos_y` |
| `aria-label` | `joystick: X <x>, Y <y> — <dominant>` |

`<x>` / `<y>` use `XyPad`'s own `fmt` ladder (2 dp under 10). `<dominant>` names the input
the composite currently favours (`IN1`…`IN4`), which is the ONE derived fact the card
carried in a colour and nothing else — a colour is not speakable, and it is the only
statement on the plate about *which source you are looking at*. It is a NAME, not a
measurement, so it is permitted resting text — **except that it does not rest anywhere: it
is in the accessible name only.**

⚠ **`data-control-params` is load-bearing, not decoration.** `faces-parity` asserts EXACT
MULTISET EQUALITY between the dock's `control-*` testids and the def's param ids
(`faces-parity.spec.ts:1350-1368`), reading `data-control-params` when present. It scans
the whole `dockShell`, which **includes the extension body** — so a pad in the body that
carries both attributes satisfies the param-parity gate with no special case. That is the
property that makes §9.2's platform change small.

**The SCREEN button's contract** (copied from `FourPlexVidOutputBody.svelte`, deliberately
— a second spelling of this control is how `previewCollapsed` forks):
`aria-pressed={!previewCollapsed}`, caption `SCREEN ON` / `SCREEN OFF`, and a `title` that
says the module keeps rendering either way.

---

## 9. COST

### 9.1 ⚠ THE WEBGL ATTEST MOVES. This PR is NOT attest-free.

`quadralogical.ts` is a VIDEO def and therefore inside the WebGL attest basis. `face`,
`docs` and `controlFamilies` are stripped by `scripts/attest-code-basis.ts`
(`HASH_TRANSPARENT_PROPS`) — **but `options` and `curve` are not**. This PR changes both:

* four `options` rosters on `edge{N}_fx` (§5.2),
* `invert.curve` `'linear'` → `'discrete'` (§5.1).

So the basis hash moves. This is the same cost the concurrent batch-22 G2b PR carries
("*the option rosters that cost an attest*"), and it is **expected, not a surprise**.

**Protocol:** run `flox activate -- task webgl:attest:check` on a CLEAN COMMITTED tree
whose merge base is current `main`, capture the refusal hash, and **hand it to the
orchestrator**. This lane does not run attests.

### 9.2 The platform change — `face.xyPads[].surface`

The pad lives in the extension body, so the DOCK must not also paint it in a band. The
narrowest honest mechanism, and it reuses a field that already exists:

```ts
// graph/types.ts — ModuleFace
xyPads?: readonly { x: string; y: string; label?: string;
                    /** Which surface paints this pad's ONE cell at the DOCK.
                     *  'band' (default) = the shell's generic XyPad in a band.
                     *  'body' = the module's own `fullViewBody` paints it, and
                     *  the dock band renders NO cell for either axis. LANE
                     *  tiers are UNAFFECTED — `extBody` is dock-only
                     *  (dockFullViewHeadPlan), so a lane tile still gets the
                     *  generic pad and this module keeps a working lane. */
                    surface?: 'band' | 'body' }[];
```

Why `surface` and not a general `face.bodyControls`: an XY pad is the only control the
shell paints that a module could plausibly want to own, the field already exists, and a
narrower declaration cannot be reached for by a module that just wants a bigger knob.

**AS BUILT**, the touched files are: `graph/types.ts` (the field) · `curated-face.ts` (the
drop, in `curatedFace`'s dock branch and in `resolvePage`) · `shell-control-kind.ts`
(`bodyPaintedParamIds`) · `module-face-lint.test.ts` (expect 0 dock cells for a `'body'`
pad's axes — the same INVERTED assertion `noUserControl` uses, so the claim is falsifiable
in both directions — plus a clause refusing `'body'` with no `face.extension`) · a new
deny-by-default source gate, `face-xy-body-source.test.ts`, asserting in BOTH directions
that a `'body'` pad's `fullViewBody` really emits `data-control-params` + the
`control-<x>` anchor, and that a body emitting a pad was actually handed one.

⚠ **Two gates the spec predicted and that turned out NOT to need editing.**
`face-resting-text-source.test.ts` reads the `ModuleFace` / `ModuleFaceHero` interfaces
only, and `contract-lock.test.ts` walks TOP-LEVEL face keys — `surface` is nested inside
`xyPads`, which already has an entry in both. The `xyPads` entry's `why` in the resting-text
roster WAS updated, because it read *"param ids only"* and that is no longer true; a `why`
that has quietly stopped describing its field is the drift that file warns about.

⚠ **AND THE ARGUMENT FOR `surface` OVER A DELETE IS NOT THE ONE THIS SECTION FIRST GAVE.**
It read: *"the lane is the reason — a mechanism that dropped the pad everywhere would
resolve the lane to ZERO controls."* That is false (see §6): `laneOrder` already drops every
pad anchor at every lane tier, so there is no lane pad to protect. The real argument is
narrower and still holds: a per-pad enum names exactly the one control the shell paints that
a module could plausibly need to own, whereas a general "these params live in the body" list
would be reached for by the next module that merely wants a bigger knob.

### 9.3 The rest

* **contract-lock:** four `options` rosters + one `curve` — a real diff. `task docs:accept`,
  then read it: the ONLY lines that may move are `edge{1..4}_fx` and `invert`. Anything
  else is a finding.
* **docs:** `quadralogical` is in `STRICT_DOCS`. No new param ⇒ no new `docs.controls` key.
  The `invert` prose already exists and is now true.
* **ART:** NIL — no `art/scenarios/quadralogical`, no `.f32` baseline. Confirmed, not assumed.
* **Push 2:** the module has no `PUSH_CARD_CONTROLS` override, so authoring a face moves it
  from the GENERIC tier to the FACE tier — **the whole card changes**. Accept the golden
  diff deliberately, with the reason in the test. ⚠ And note the live limitation the #1972
  filing records: at the FACE tier a declared pad resolves to ONE encoder, not two.
* **VRT:** two NEW scenes (`face-quadralogical-compact`, `face-quadralogical-dock`) — add
  the row to the `FACES` roster in `e2e/vrt/_shell-faces.ts` / `workflow-shell-faces.spec.ts`
  and dispatch `task vrt:commit`. ⚠ **`vrt.spec.ts/quadralogical.png` and the eight
  `vrt-quadralogical` composite scenes MUST NOT MOVE** — they render the LEGACY card, which
  this PR does not touch. A diff there means something leaked out of `face`.
  ⚠ **A live 2×2 video preview is NOT pixel-deterministic** — `freeze` is the module's own
  hook and `freezeFaceVideo` is the harness; MUST-VERIFY that the dock scene is stable
  across three consecutive captures before trusting a baseline (the `analogVco` lesson).
* **CI wall-time:** faces-parity budgets ≈ `10 s + 0.8 s/cell` on CI. 19 rendered dock cells
  (21 params − 2 body-owned) ⇒ ≈ 25 s. Under the ~2 min threshold; no sign-off needed.

---

## 10. TASTE CALLS, EACH WITH ITS ONE-LINE REVERT

1. **The puck is a MIX window (§4).** Revert: delete the puck canvas. Consequence, stated
   plainly: the MIX has no surface on the faceplate at all.
2. **The edge boxes STACK rather than sitting in a row (§7).** ⚠ **This call was DECIDED BY
   A MEASUREMENT, not by taste** — the row flow was built and CI measured it 40 px over the
   pane (content 1260, shown 1220). It is listed here because the owner may still prefer the
   row and pay for it some other way (a narrower selector, a 2×2 split, a wider pane). Revert:
   restore `clusterFlow: 'row'` on that one page — and `workflow-shell-faces` goes red again
   with the same number until something else gives.
3. **Eight edge controls always visible (§2, rows 12/14).** Revert: none available today —
   there is no conditional-cell mechanism. The alternative is a platform PR for one, which
   is not this PR.
4. **`invert` ranks 9, above the key colours.** Revert: swap it to 20 and nothing else moves.
5. **The frame pins HEIGHT and grows WIDTH (§3.2).** Revert: pin width, grow height — and
   the four edge boxes jump 120 px on every toggle.

---

## 11. MUST-VERIFY — claims this spec makes that the build must prove

**Status after the build. Two of the seven were WRONG, and both were caught by the thing this
list exists to force.**

1. ✅ **The quadrant→corner mapping survives the blit.** `PREVIEW_FRAG_SRC` works in
   bottom-left-origin `vUv`; the canvas is top-left. A flip would put IN1 bottom-left and
   silently contradict the label above it. **VERIFIED** by a four-pixel positive control in
   `quadralogical-face-screen.spec.ts` — each quadrant carries its own input's colour. The
   mapping is right.
2. ⚠ **`curatedFace` resolves plate = compact = 2** — **TRUE but the CONTENT was wrong.** The
   spec said the two cells were the stick and the diamond; the stick never reaches a lane at
   all (`laneOrder`). It is DIAMOND, then DIAMOND + SHARP. Corrected in §6.
3. ❌ **The measured plate width.** **FAILED, and this is the finding of the build.** The row
   flow measured **1260 CSS px against a 1220 px pane** on linux CI. Reversed to stacked; see
   the §7 note. ⚠ It could not have been caught locally — that measurement lives in a spec
   that needs a committed baseline to run.
4. ⏳ **Three consecutive dock captures pixel-identical** with `freeze` engaged — pending the
   capture that #3 blocked.
5. ✅ **`markWatched` fires with SCREEN OFF** — verified at the SOURCE level (the collapsed
   branch marks before returning), with a negative control proving the pattern can fail. ⚠ The
   runtime probe this list originally asked for **does not exist**: `isPullRoot` is private
   with no public reader, so an e2e leg could only report "could not look", which is
   decoration. Recorded rather than faked.
6. ✅ **`faces-parity` multiset equality** with the pad in the body — and it caught a real gap
   on the way: the body needed the shell's own `data-cell-*` wrapper, without which the pad
   rendered, worked, satisfied the multiset, and was still never dragged.
7. ✅ **`rear-card-model`**: the `key` rear section has THREE jacks, not four (`invert` has no
   CV input) — green.

## 12. VERIFICATION GATE

```sh
# 1. the pure model + this face's PERMANENT negative controls
REPEAT=3 flox activate -- task test:one -- quadralogical-face-model
# 2. face lint: completeness, the 'body' pad renders ZERO dock cells, both axes ranked
flox activate -- task test:one -- module-face-lint
# 3. row/hero/cell plans
flox activate -- task test:one -- dock-row-plan
flox activate -- task test:one -- dock-faceplate-model
flox activate -- task test:one -- console-grid          # the stacked band IS a console grid
flox activate -- task test:one -- shell-cells
flox activate -- task test:one -- shell-extensions
flox activate -- task test:one -- module-shell-import-guard
# 4. the rulings' source gates
flox activate -- task test:one -- face-resting-text-source
flox activate -- task test:one -- face-readout-source    # + XyPad, see #1972
flox activate -- task test:one -- face-width-source
flox activate -- task test:one -- video-face-screen-source
flox activate -- task test:one -- face-rack-status-source # EXTENSION_BODY_ROLES
# 5. vocabulary + rear + push
flox activate -- task test:one -- param-vocabulary
flox activate -- task test:one -- rear-card-model
flox activate -- task test:one -- push-card-schema
flox activate -- task test:one -- module-docs-lint
# 6. the contract diff must contain ONLY edge{1..4}_fx options + invert curve
flox activate -- task docs:accept && flox activate -- git diff
# 7. e2e
flox activate -- task e2e:serve
REPEAT=3 flox activate -- task e2e:one -- tests/faces-parity.spec.ts
REPEAT=3 flox activate -- task e2e:one -- tests/quadralogical.spec.ts
REPEAT=3 flox activate -- task e2e:one -- tests/quadralogical-assign.spec.ts
flox activate -- task e2e:stop
# 8. typecheck LAST — svelte-check is stricter than vitest
flox activate -- task typecheck
# 9. VRT: dispatch only. NEVER commit a PNG.
flox activate -- task vrt:commit
# 10. the attest: report the refusal hash, DO NOT run it
flox activate -- task webgl:attest:check
```
