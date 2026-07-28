# BACKDRAFT faceplate rebuild — buildable spec (PR #1231)

**Base:** `origin/feat/backdraft-card-declutter` @ `d944e1fa`. All line numbers are on that branch unless marked `[1223]` (= `origin/feat/backdraft-virtual-camera`) or `[main]`.

**One-line summary of the change:** the card goes **5hp → 7hp** (900 → 1260 px wide), stays **3u (540 px)**, gets a **320×240 display centred in a new top band** flanked by the switch rows, and keeps all 19 faders + 6 switches in a **single 6-bank row** underneath — with the 6th bank (VIRTUAL CAMERA) pre-budgeted so #1223 merges with **zero further restructure**.

---

## 0. Conflicts between the three assessments — resolved

| # | Disagreement | Ruling | How determined |
|---|---|---|---|
| C1 | Display budget at 5hp with #1223's row: **148** (inv. A) vs **143** (inv. B) vs **≈140** (inv. C) | **143.** Use inventory B's model. | B's cumulative model reproduces *both* published measurements exactly (236 at the bank bottom, 362 with the camera row). A and C used a looser chrome estimate. Verified the component constants myself: `.vcard` padding 18/14 (`_module-card.css:110-111`), `.bd-body` padding `6px 14px 10px` + gap 10 (`BackdraftCard.svelte:690-695`), `.banks` border-top 1 + padding-top 10 (`:775-781`), Fader track 80+2 border (`Fader.svelte:518-521`), XyPad wrap = 10+3+74+3+10+3+13 = 116 (`XyPad.svelte:334-341,384,400-403`). Moot anyway — we are not shipping 5hp. |
| C2 | Width for a 6-bank row: **"6hp minimum, 7hp comfortable"** (inv. A) vs **"7hp; 6hp wraps"** (inv. B) | **7hp. A is wrong.** | A double-counted: it took the author's measured **830 px** (which *already includes* the 4×30 column gaps — `BackdraftCard.svelte:782-784`) and then added "~200" to reach ~1030. The correct sum is `830 + 30 (6th gap) + 198 (camera bank) = 1058`, against a **6hp inner width of 1050**. That is **8 px over** → `flex-wrap` fires → a second bank line costs +14 (row gap) +130 = **+144 px** of height, silently, and the overflow gate goes red. 6hp is a trap; 7hp gives 172 px slack. |
| C3 | Is the "236 CSS px" figure trustworthy? | **Yes**, and `card-control-overflow` on this branch does report CSS px. | `card-control-overflow.spec.ts:201-203` computes `scale = cardRect.width / card.offsetWidth` and divides every rect-derived figure; `:242` correctly leaves `scrollWidth - clientWidth` undivided. `[main]` has no `scale` field. **Keep this fix exactly as-is.** |
| C4 | Camera bank width: **~200** (inv. A) vs **~281** (inv. B) | **198 — but only after fixing a real #1223 bug (see §6.1).** B's 281 is correct *for #1223 as written*; A's ~200 is achievable and is what we build. | `XyPad` wrap width = `max(pad 74, readout, caption)`. With #1223's `xLabel="Tilt X"` the readout is `2 × ~57 + 6 ≈ 120`. With `xLabel="X"` it is `2 × ~34 + 6 = 74` = the pad width exactly. Both fit at 7hp (172 vs 86 px slack); we take the narrow one. |
| C5 | Is `opacity: 0.45` dimming compatible with "ALL controls usable"? | **Yes for `opacity`; NO for `disabled` and NO for `{#if}`.** See §4. | `.tv-bank.dim` sets opacity only — no `pointer-events`, no `disabled` — so drag, dbl-click reset, wheel and right-click MIDI-Learn all work. `disabled={tvOn}` on PURE GEO (`:502`) is a genuine lockout; `{#if tvOn}` on the camera row (`[1223]:621`) is an unmount. |

---

## 1. Card geometry

```
CARD                 1260 × 540 CSS px      (7hp × 3u)
inner content width  1260 − 2 (borders) − 28 (.bd-body padding-x) = 1230
```

Two files must change **in the same commit** or `card-control-ranges.test.ts:105-124` goes red:

- `packages/web/src/lib/ui/rack-sizes.ts:164` → `backdraft: { size: '3u', hp: 7 },`
- `packages/web/src/lib/ui/modules/BackdraftCard.svelte:685-689` → `.card { width: 1260px; min-height: 540px; overflow: hidden; }`

Do **not** re-add `backdraft` to `DYNAMIC_SIZED` (`rack-sizing.test.ts:57-81`) and do **not** re-add `startCornerResize`/`data?.width` — `card-control-ranges.test.ts:126-131` pins their absence, and a resize handle would fight the hard `max-height` pin at `_module-card.css:154-156`. 540 stays non-negotiable *because* the tier pins it.

7hp precedent: `pentemelodica: { size: '3u', hp: 7 }` (`rack-sizes.ts:113`) is the current widest. Nothing caps hp. RACKLINE lane tiles are hp-invariant (`SHELL_TILE_W = 192`), so the lane is unaffected. The dock full-view pane (`_dock-faceplate.css:124` `min-width: 900px`, `DockFullView.svelte:237` `max-height: min(60vh, 680px)`) will **scroll horizontally** at 1260 in a 50/50 split — same as pentemelodica today. 540 + chrome clears the 680 height ceiling; **4u would not**, which is the independent reason 3u is right.

---

## 2. Vertical arithmetic — sums to 540 exactly

Cumulative from the card's top border. Component constants verified against source (§0/C1).

### As shipped on #1231 (5 banks)

```
   1   card top border                                    →   1
  18   .vcard padding-top                                 →  19
  16   ModuleTitle text (0.85rem)                         →  35
   8   ModuleTitle margin-bottom                          →  43
   6   .bd-body padding-top                               →  49
 240   TOP BAND   = max(display 240, L-flank 50, R 74)    → 289
  10   .bd-body gap                                       → 299
   1   .banks border-top                                  → 300
  10   .banks padding-top                                 → 310
 112   tallest bank (title 10 + gap 4 + fader 98)         → 422
  10   .bd-body padding-bottom                            → 432
  14   .vcard padding-bottom                              → 446
   1   card bottom border                                 → 447
  ───
  447 of 540   →   93 px SLACK
```

### After #1223 merges (6 banks — camera bank is 18 px taller)

```
   same through the top band                              → 299
   1 + 10 + 130  (bank title 10 + gap 4 + XyPad wrap 116) → 440
  10 + 14 + 1                                             → 465
  ───
  465 of 540   →   75 px SLACK
```

**#1223's cost is +18 px, not +126 px** — because the camera cluster becomes a *bank on the existing row*, not a row of its own. That is the whole point of going 7hp.

Ceiling check: max legal display height is `240 + 75 = 315`. We ship **240**, deliberately 75 px inside the ceiling so the next control addition does not force a third restructure.

---

## 3. Layout — concrete

### 3.1 DOM skeleton (inside the existing `<PatchPanel>` slot)

```
.bd-body                              flex column, padding 6px 14px 10px, gap 10
├── .top-band                         flex row, align-items: flex-start, gap 24
│   ├── .switch-col.left              flex: 1 1 0;  align-items: flex-start
│   ├── .canvas-wrap  (the DISPLAY)   flex: 0 0 auto; 320 × 240
│   └── .switch-col.right             flex: 1 1 0;  align-items: flex-end
└── .banks  [data-testid=backdraft-controls]
    └── .bank-row                     flex, flex-wrap: wrap, gap 14px 30px
```

`flex: 1 1 0` on **both** flanks is what makes the display *genuinely centred* — the flanks are equal by construction regardless of their content. Flank width = `(1230 − 320 − 2×24) / 2 = 431 px` each.

**`.canvas-wrap` moves INTO `.bd-body`.** On #1231 it is a direct child of `.card` (`:644-659`) so full-frame could cover the card. That still works from inside `.bd-body`: `.patch-panel-host` is `display: contents` (generates no box → cannot be a containing block) and `.bd-body` / `.top-band` are `position: static`, so `.canvas-wrap.full-frame { position: absolute; inset: 0 }` still resolves against `.vcard` (`position: relative`, `_module-card.css:112`). **Verify this in the browser before moving on** — it is the one structural assumption in this spec.

Consequently the chrome-hiding rule at `:915-920` must change:

```css
/* WAS: .card.full-frame .bd-body { display: none } — would hide the display too */
.card.full-frame :global(.title),
.card.full-frame .stripe,
.card.full-frame .banks,
.card.full-frame .switch-col { display: none; }
.card.full-frame .bd-body { padding: 0; gap: 0; }
```

`backdraft-full-output.spec.ts:186-188` asserts `[data-testid="backdraft-controls"]` (= `.banks`) is hidden while full-frame — still satisfied.

### 3.2 The DISPLAY

| property | value |
|---|---|
| CSS box | **320 × 240** (4:3, matching `VIDEO_RES = 1024×768`) |
| position | centred in the top band → horizontally centred on the card, directly under the title |
| backing store, in rack | `fullscreenCanvasDims(expanded, engine, { width: 320, height: 240 })` — change `{ width: 2, height: 2 }` at `BackdraftCard.svelte:279` to `{ width: DISPLAY_W, height: DISPLAY_H }` |
| backing store, expanded | live engine dims — **unchanged** |
| aspect handling | `fitRect` already letterboxes: a 16:9 OUTPUT renders 320×180 with bars top/bottom inside the 320×240 box. No new code. |
| CSS | drop `visibility: hidden; opacity: 0; pointer-events: none; position: absolute; width:1px; height:1px` from `.canvas-wrap` (`:856-871`); it becomes `position: relative; width: 320px; height: 240px; background: #050608`. `.full-frame` / `.fullscreen` variants unchanged. |

"SMALLER" is satisfied: the pre-#1231 preview was ~380×285 on a 720-wide card (>half the card). 320×240 is smaller in both axes and is **¼ of the new card's width**.

### 3.3 Left flank (`.switch-col.left`, 431 px, 50 px tall)

flex column, `gap: 6`, rows of `.mirror-btn` (22 px each).

| row | contents | width |
|---|---|---|
| 1 | `MIRROR X` · `MIRROR Y` (`backdraft-mirror-x` / `-y`) | ~178 |
| 2 | `SHAPE: <NAME>` (`.wide`, min-width 122) · `PURE GEO` | ~212 |

### 3.4 Right flank (`.switch-col.right`, 431 px, 74 px tall)

flex column, `gap: 6`, `align-items: flex-end` so the band reads symmetric.

| row | contents | width |
|---|---|---|
| 1 | `TV: <MODE>` (`.wide`) · `.tv-readout` span (9 px, `{#if tvOn}`) | ~278 |
| 2 | `FLICKER` label + 6 × 42 px `.seg` buttons | ~336 |
| 3 | `⛶ OUTPUT` (`backdraft-output-menu`) | ~75 |

Delete the dead `.btn-group.grow` rule (`:711`) — unused since an earlier FLICKER layout.

### 3.5 Bank row — position, column count, width

One line, left-aligned, `gap: 14px 30px`, `align-items: flex-start` (fader banks top-align against the 18 px-taller camera bank).

| # | bank | `.bank-title` | columns (controls) | approx width |
|---|---|---|---|---|
| 1 | LOOP | `LOOP` | 3 — Mix, FB, Delay (+ CLK badge cell) | ~130 |
| 2 | COLOUR | `COLOUR` | 5 — Luma, Chr, R, G, B | ~190 |
| 3 | KEY | `KEY` | 2 — Lgt, Drk | ~70 |
| 4 | GEOMETRY | `GEOMETRY` | 5 — Zoom, Rot, OffX, OffY, Pix | ~190 |
| 5 | TV SCREEN | `TV SCREEN` + hint | 4 — Room, Bez, Phos, Drive | ~150 |
| 6 | **VIRTUAL CAMERA** *(#1223)* | `VIRTUAL CAMERA` + hint | 3 — TILT pad (74), POSITION pad (74), Dist fader (~30) | **198** |

```
#1231  banks 1-5 + 4 gaps                     =  830  of 1230  →  400 px slack
#1223  830 + 30 (gap) + 198 (camera bank)     = 1058  of 1230  →  172 px slack
```

**Keep `flex-wrap: wrap`** on `.bank-row`. Wrapping is the graceful-degradation path (never a horizontal spill), and the resulting height blow-up is loudly caught by `card-control-overflow`. That is the correct failure mode; do not switch to a fixed grid.

---

## 4. Dimmed vs. usable — the decision

**Ruling: `opacity` dimming COUNTS as usable. `disabled` and `{#if}` DO NOT.**

Rationale: a dimmed control is still draggable, dbl-click-resettable, wheel-scrollable and right-click MIDI-Learnable, and it keeps its box — which is *why* the card's height is identical in all three TV modes (the property the overflow gate depends on). The dim is honest signalling that the param is inert **in the model**, paired with an explanatory `title`. A `disabled` attribute is a lockout, and a `{#if}` is an unmount — both make a control unreachable, and both create a UI/CV disagreement because the **gate CV path keeps writing the param** while the user cannot touch it.

Required changes:

| control | now | required |
|---|---|---|
| `PURE GEO` (`:500-508`) | `class:inert={tvOn}` **+ `disabled={tvOn}`** | **Remove `disabled`.** Keep `.inert` opacity + the explanatory `title`. Zero model risk — `uPureGeo` is genuinely a no-op inside the `if (uTvOn > 0.5)` branch (that branch reads `srcRaw`, not the masked `source`, and overwrites `outc`), so the button already cannot break anything. This restores UI/CV parity (`pure_geo_gate` flips the param today under a button that refuses) and lets a user pre-set PURE GEO before cycling TV back OFF. |
| TV SCREEN bank (`:618`) | `class:dim={!tvOn}` | **Unchanged.** This is the precedent. |
| VIRTUAL CAMERA row `[1223]:621` | `{#if tvOn}` | **`class:dim={!tvOn}`, always mounted.** Same rule. This is also what makes the height mode-invariant (§2). |

**Add the remedy affordance** (recommended, zero height cost): the `.bank-hint` span inside the TV SCREEN and VIRTUAL CAMERA bank titles becomes a bare `<button>` reading `TV MODE OFF ▸ turn on` that calls `cycleTvMode()`. Style it `background:none;border:none;padding:0;font:inherit;cursor:pointer` so it stays on the title's 10 px baseline. A dimmed control then carries its own cure.

**Also add:** the OUTPUT button, `PURE GEO`, `SHAPE`, `MIRROR X/Y`, `FLICKER` and `TV MODE` remain plain `<button>`s with **no MIDI-Learn** — as today. Do not silently change that here; see §9.

---

## 5. OUTPUT / Full Frame / Full Screen / Present — what happens

**Nothing is lost. One thing is added back.**

- **The `⛶ OUTPUT` button STAYS** (`backdraft-output-menu`, `:552-559`), in the right flank, bottom row. It is the *discoverable* affordance — the pre-#1231 right-click on the preview was undiscoverable, and three e2e cases now drive the button. `backdraft-full-output.spec.ts:196-200` depends on it being hidden while full-frame (`.card.full-frame .switch-col { display: none }` in the new rule set keeps that true).
- **Right-click on the display is RESTORED** as an *additional* entry point, now that there is a display to right-click. On `.canvas-wrap`, wire `oncontextmenu` → `openOutputMenu` at the pointer position, with `e.preventDefault(); e.stopPropagation()` so the SvelteFlow node menu does **not** also open. Re-add the assertion at `backdraft-full-output.spec.ts:158` in its strong form (right-click the canvas, assert `[role="menu"][aria-label="Module actions"]` has count 0) — #1231 weakened it to a button-click check because there was nothing to right-click.
- **Full Frame** — unchanged semantics: `node.data.fullFrame` persists, chrome hides, `.canvas-wrap.full-frame { inset: 0 }` covers the card, dbl-click exits. Only the chrome-hiding selector list changes (§3.1).
- **Full Screen** — unchanged. `.canvas-wrap` is still a legal `requestFullscreen()` target (it is now a *real* element instead of a 1 px ghost, which is strictly better).
- **Present on another display** — unchanged. `createPresent({ getCanvas: () => canvasEl })` blits the card canvas; `present.isPresenting` is part of `expanded`, so `bufferDims` still promotes to engine dims while presenting.
- **Corner-resize stays RETIRED.** 3u = 540 is non-negotiable; a resize handle fights `max-height` at `_module-card.css:156` and would resurrect `node.data.width/height` as a competing truth. `card-control-ranges.test.ts:126-131` pins its absence — leave that test alone.

---

## 6. #1223 (VIRTUAL CAMERA) — pre-budgeted fit + the defects it must fix on the way in

Merge order: **#1231 lands first**, then #1223 rebases onto it. #1223 branches from `main` and rewrites the same 894-line card — take **#1231's card wholesale** and re-add only the camera cluster. Never `gh pr update-branch` (CLAUDE.md).

Budget already reserved: **+18 px height, +228 px width.** No restructure.

### 6.1 `XyPad`'s `title` prop is a **visible caption**, not a tooltip — #1223 passes a 300-character paragraph

`XyPad.svelte:246` renders `{#if title}<div class="xy-title">{title}</div>{/if}`, and `.xy-title` (`:340-348`) has `align-self: stretch; text-align: center` with **no `white-space: nowrap`**. `[1223]:632` and `:644` pass full explanatory paragraphs. That paragraph renders as wrapped body text above a 72 px pad. VIDEOCUBE — the only other `XyPad` consumer — passes short captions (`VideocubeCard.svelte:393` `title="ROT X / Y"`). **This is a layout bug in #1223 and must be fixed as part of folding the cluster in.**

Required form:

```svelte
<div class="cam-cell" title="TILT — swing the camera off the screen's normal. …(the long prose)…">
  <XyPad
    title="TILT" xLabel="X" yLabel="Y"
    xMin={-BACKDRAFT_CAM_TILT_RANGE} xMax={BACKDRAFT_CAM_TILT_RANGE}
    yMin={-BACKDRAFT_CAM_TILT_RANGE} yMax={BACKDRAFT_CAM_TILT_RANGE}
    … size={72} testid="backdraft-cam-tilt"
    moduleId={id} xParamId="camTiltX" yParamId="camTiltY" />
</div>
```

Short `xLabel`/`yLabel` are what pin the XyPad wrap to the 74 px pad width (§0/C4). The long prose moves to a native `title=` on the wrapper — the same idiom the TV SCREEN bank already uses on `.bank-faders` (`:625-627`).

### 6.2 `camDist` restates its range — turns a unit test RED

`[1223]:648` — `<Fader value={p('camDist')} min={0} max={1} …>`. The regex `\bmin=\{\s*-?\d` in `card-control-ranges.test.ts:73` matches `min={0}`, and `BackdraftCard.svelte` is on `STRICT_DEF_DERIVED_RANGES`. Fix: `min={pmin('camDist')} max={pmax('camDist')}`. (The XyPads are already correct — `xMin={-BACKDRAFT_CAM_TILT_RANGE}` does not match.)

### 6.3 The ±1 lie survived in the docs

`[1223]:3199-3202` — `docs.controls.camTiltX/Y` say `-1..+1` against a def of **±0.2**; `camPosX/Y` say `-1..+1` against **±0.5** (`BACKDRAFT_CAM_TILT_RANGE = 0.2` / `BACKDRAFT_CAM_POS_RANGE = 0.5` at `[1223]:502-503`). `module-docs-lint` checks completeness/orphans/vocabulary, **never numeric agreement**, so nothing goes red — and `backdraft` is in `STRICT_DOCS` (`strict-docs.ts:315`), so the doc page renders the lie to users. Fix all four strings.

**These edits are hash-transparent**: `[1223]`'s docs block spans lines **3126-3207**, inside `// docs-hash-ignore:start … :end`, and `computeWebglHash` strips those regions (`webgl-attest-lib.ts:288-305`).

The matching `BackdraftParams` interface comments at `[1223]:1478-1481` (`// -1..1 yaw` etc.) are **OUTSIDE** any hash-ignore region. The hash is over raw bytes minus ignored regions — comments are **not** stripped generally. So: **fix those four comments in #1223, which re-attests anyway (it changes the shader and carries its own `ci-webgl-attest/*.json`). Do NOT fix them on #1231** — that would force a gratuitous 10-minute GPU re-attest for a comment.

### 6.4 Ports

`[1223]:495-499` adds five hand-maintained `PortDescriptor` rows (`cam_tilt_x/y`, `cam_pos_x/y`, `cam_dist`, all `cable: 'cv'`). Keep them; the `inputs` array is hand-maintained while `outputs` uses `portsFromDef`, so labels/colours can drift silently — the per-module-per-port sweep only checks handle presence.

### 6.5 `bezel` default

#1223 moves it 0.4 → 0.5. That is a def change, part of #1223's legitimate re-attest. Leave it.

---

## 7. Every gate/test that must change

### 7.1 REWRITE

| file:line | what | why |
|---|---|---|
| `packages/web/src/lib/ui/rack-sizes.ts:164` | `hp: 5` → `hp: 7` | the width change |
| `packages/web/src/lib/ui/modules/BackdraftCard.svelte:685-689` | `.card { width: 900px }` → `1260px`; `min-height: 540px` unchanged | pinned to the tier by `card-control-ranges.test.ts:105-124`; both move in one commit |
| `BackdraftCard.svelte:915-920` | chrome-hiding selector list (§3.1) | `.bd-body { display:none }` would hide the display |
| `e2e/tests/backdraft-full-output.spec.ts:142` | `toBeHidden()` → `toBeVisible()` **+ a bounded size assertion** (`boundingBox()` w ≈ 320 ± 4, h ≈ 240 ± 4) | this single line encodes "no preview". Visibility alone is not enough — the requirement is a *smaller* display, so assert the box. |
| `backdraft-full-output.spec.ts:184` | `toBeVisible()` is now **vacuous** — replace with a growth assertion: capture `boundingBox()` before entering full-frame, assert the post-transition width > 900 (or that `.canvas-wrap` gained class `full-frame`, which is already asserted at `:182`) | otherwise the case passes while full-frame is broken |
| `backdraft-full-output.spec.ts:155-158` | restore the strong form: right-click the canvas → menu opens **and** `[role="menu"][aria-label="Module actions"]` count 0 | the gesture exists again (§5) |
| `backdraft-full-output.spec.ts:8-31, 122-131` | header prose + the 60 s cap comment: the card is no longer "a control surface with no in-rack thumbnail" | comments that lie are how the next person gets it wrong |
| `e2e/tests/card-control-overflow.spec.ts:358` | `['VIRTUAL CAMERA', 1]` → `['PURE TV', 1]` | **mislabel** — `BACKDRAFT_TV_MODE_LABELS = ['OFF','PURE TV','CRITICAL']` (`backdraft.ts:453`). Failure messages currently name a mode that does not exist. |
| `card-control-overflow.spec.ts:385-389` | guard asserts `backdraft-tv-readout` **and** (once #1223 lands) `backdraft-cam-row` | with the camera bank always mounted, `tv-readout` is the only remaining mode-conditional chrome; asserting both is strictly stronger |
| `e2e/vrt/vrt-exemptions.ts:820-830` | the `EXEMPT_FROM_VRT` reason claims the card is "fixed-size deterministic chrome **with no canvas**" | **false the moment the display returns.** Rewrite, or the next person promotes a card with a live feedback canvas and gets a flaky baseline. |
| `packages/web/src/lib/video/modules/backdraft.ts:2926` | `docs.explanation`: "The card is a **CONTROL SURFACE with no built-in preview screen**" → describe the centred on-card display + the OUTPUT menu + the bank layout incl. VIRTUAL CAMERA | `backdraft` is in `STRICT_DOCS`. **Stay inside the `docs-hash-ignore` markers at `:2924`/`:2995`** — hash-transparent, no re-attest. |
| `docs/testing/test-ledger.generated.md:65` | **already RED on #1231** — it still carries the pre-#1231 reason string ("given full output capabilities (corner-resize + …") while `EXEMPT_FROM_VRT` was changed. `scripts/test-ledger.test.ts:34-55` asserts byte-equality with a fresh regen. | run `flox activate -- task test:ledger:accept` — **and again** after the reason rewrite above. Never hand-merge. |

### 7.2 RESTORE (deleted by #1231, must come back with the display)

| file:line | what |
|---|---|
| `e2e/vrt/vrt-exemptions.ts:253-259` | `VRT_MODULE_MASKS.backdraft = [{ selector: 'canvas' }]`. #1231 deleted it with a comment explaining there is no canvas. There is again. Note the interaction at `vrt.spec.ts:171` (`mod.type in VRT_SCENES ? [] : masks`) — a module with a scene ignores its mask and relies on the scene's `freeze`; the mask matters only if the scene is ever removed. Restore it anyway so the file does not describe a card that no longer exists. |

### 7.3 ADD

| file | what | cost |
|---|---|---|
| `packages/web/src/lib/ui/card-control-ranges.test.ts` (or a sibling in the same unit lane) | `expect(cardSource('BackdraftCard.svelte')).not.toMatch(/\bdisabled=\{/)` — **no control on this card is ever locked out.** This is the cheapest possible encoding of owner requirement 1, and it is deterministic and free. | 0 s |
| `e2e/tests/card-control-overflow.spec.ts:358` | extend the loop to **three** cases — `[['OFF',0],['PURE TV',1],['CRITICAL',2]]` — with the OFF case asserting `[data-testid="backdraft-cam-row"]` **visible** (i.e. not `{#if}`-gated). This is the assertion that proves the camera controls are reachable in the default mode. Land it **with #1223**. | ~+10 s |

### 7.4 RE-MEASURE (no code change, but confirm the printed figures)

| file:line | what to confirm |
|---|---|
| `card-control-overflow.spec.ts` backdraft cases | `card 1260×540 CSS px`, `worst BOTTOM ≤ 6`, `worst RIGHT ≤ 6`, `horizontal content overflow ≤ 6` in **all three** TV modes. Note `.card { overflow: hidden }` (`:688`) hides a spill from the eye but **not** from `getBoundingClientRect` — this gate is the only reliable check. Never add `overflow-y: auto` to `.bd-body` (it makes clipped children report in-bounds rects and silently defeats the gate). |
| `card-control-overflow.spec.ts:195-243` | **do not touch** the `scale`/`toCss()` normalisation. `:242` must stay undivided. |
| `card-control-overflow.spec.ts:71-105` + `:297-310` | backdraft is **not** in `EXEMPT_CONTROL_OVERFLOW` and must not be added; the ratchet cap only shrinks. |
| `e2e/tests/backdraft.spec.ts:49` | `[data-testid="backdraft-canvas"]` `toHaveCount(1)` — passes either way, so it will **not** catch a broken display. Leave it; the size assertion in `backdraft-full-output.spec.ts:142` is the real gate. |

### 7.5 DELETE

Nothing. (`BackdraftCard.svelte:711` `.btn-group.grow` is dead CSS — remove it as hygiene.)

### 7.6 OWNER'S CALL — leave or revert

`e2e/tests/workflow-shell-video.spec.ts:355-405` — #1231 swapped the dock full-view EXPAND probe from `backdraft` to `feedback` *because backdraft lost its preview canvas*. With the display back, backdraft is a valid subject again. **Recommendation: keep `feedback`** (equivalent probe, zero churn) but **rewrite the comment at `:21`**, which currently implies backdraft has no preview. Do not leave a comment asserting something false.

---

## 8. WebGL re-attest — explicit answer

**NO re-attest is required for this rebuild**, provided two rules hold:

1. **`BackdraftCard.svelte` must keep using `getContext('2d', { alpha: false })`** (`:345`). The basis rule at `webgl-attest-lib.ts:236-242` includes a card **only if** its source creates a `webgl`/`webgl2` context after comment-stripping. Implementing the small display as a direct GL surface would put the card in the basis **permanently** — every future card edit would then cost a ~10-minute real-GPU re-attest. **Use the 2D `drawImage` blit.**
2. **Every edit to `backdraft.ts` on #1231 must stay inside the `docs-hash-ignore` markers** at `:2924` / `:2995`. `backdraft.ts` *is* in the basis (the whole `lib/video/**` dir sweeps in), but stripped regions are hash-free. The only tempting out-of-marker edit is the `BackdraftParams` `// -1..1` comments — defer those to #1223 (§6.3).

E2E specs are excluded from the hash by owner directive (`webgl-attest-lib.ts:246-266`), so all the spec rewrites are free. **`e2e/webgl-heavy-globs.ts` IS in the basis** — see §9.3.

---

## 9. CI cost — main is RED right now, do not make it worse

Main is red on `e2e (shard 1/10)`: 6 failures, all BACKDRAFT, all **timeouts** (`backdraft-full-output.spec.ts:172`, `backdraft-pure-tv.spec.ts:282`/`:322`, `backdraft.spec.ts:25`/`:132`/`:207`). **PR #1234 is the fix in flight** — it cuts PURE TV frame budgets (`NEST_FRAMES 100 → 45`, `220 → 130`, etc.). Restoring a live blit re-arms exactly the contention #1234 is unstarving. Three hard rules:

### 9.1 The in-rack blit MUST be harness-gated

`backdraft-pure-tv.spec.ts` sets `__videoEnginePause = true` and drives `vid.step()` itself; the card's own rAF would still fire `blitOutputToDrawingBuffer` + `drawImage` at 60 Hz on top of that. Gate it:

```ts
const harnessFrozen = (): boolean => {
  const g = globalThis as { __videoEngineFreezeRender?: boolean; __videoEnginePause?: boolean };
  return g.__videoEngineFreezeRender === true || g.__videoEnginePause === true;
};
// in tick():
if (expanded || (!harnessFrozen() && !document.hidden)) drawOutput(videoEngine);
```

This is honest, not a test hack: a paused/frozen engine has no new frames to present. With it, **every backdraft spec pays exactly what it pays on #1231** — `card-control-overflow` and `per-module-per-port` already set `__videoEngineFreezeRender`; `backdraft.spec.ts` and `backdraft-pure-tv.spec.ts` set `__videoEnginePause`; `backdraft-full-output.spec.ts:50-55` sets freeze-render.

### 9.2 Keep the display's backing store small, and throttle in-rack

- Backing store **320×240**, not engine dims. The `drawImage` readback cost scales with it — 320×240 is ~10× cheaper than 1024×768. Expanded promotes to engine dims as today.
- Throttle the **in-rack** blit to every 3rd rAF (~20 fps). A 320×240 preview does not need 60 Hz; expanded runs every frame.
- Off-screen cards are already handled centrally: `Canvas.svelte:7032` feeds `video-card-visibility.ts`'s IntersectionObserver into `engine.setCardVisibility`, and `isPullRoot` (`engine.ts:986-993`) demotes a known-offscreen card. No per-card work needed.

### 9.3 `backdraft-full-output.spec.ts` keeps its 8.5 s

The 13.5 s → 8.5 s saving came from (a) dropping the SHAPES source, (b) deleting four `waitForTimeout(300)`, (c) `freezeVideoRender`. All three survive **if the new assertions stay state-machine/geometry only**. The size assertion in §7.1 is a `boundingBox()` — layout, not pixels. **Do not add a "the display shows live content" pixel assertion here**; that would require restoring the SHAPES chain and the sleeps, and puts you back at ~13.5 s on the shard that is already over budget. Keep the 60 s cap at `:132` as a bounded-failure ceiling, not a budget.

**Estimated CI wall-time delta for this rebuild: ≈ +10 s** (one added `card-control-overflow` case, landing with #1223). Well under the 2-minute sign-off threshold. Recommend landing **after #1234 merges**, so the rebuild is measured against a green shard 1.

**Orthogonal but worth flagging to the owner:** `backdraft.spec.ts` (`getImageData` at `:64,117,179,254,348`) and `backdraft-pure-tv.spec.ts` (`stepRead` `readPixels`) match **no** heavy glob in `e2e/webgl-heavy-globs.ts:43-140`, so three pixel-reading specs sit in the sharded SwiftShader matrix — against that file's own stated rule. Moving them into the serialized heavy lane is the structural fix for the red-shard-1 class. **That file is in the WebGL attest basis**, so it costs one re-attest — batch it with #1223's, or make it its own PR. Do not fold it into this rebuild.

---

## 10. Persistence

- `node.data.width` / `node.data.height` — stale on already-saved racks (`[main] BackdraftCard.svelte:206-229`, `DEFAULT_WIDTH/HEIGHT = 720`). #1231 stops reading them; they become inert Y.Doc weight. No migration, no cleanup. **Say this in the PR body** — a user who resized their BACKDRAFT to 1440×1080 now silently gets 1260×540 with no explanation.
- `node.data.fullFrame` — survives untouched. **Verify** that a rack saved with `fullFrame: true` restores as a full-frame panel *and* that toggling back out lands on the 320×240 in-band display (not a double-applied sizing), given `.canvas-wrap` now moves between in-flow and `position: absolute`.
- The def declares **no** `size`/`hp` — `RACK_SIZE_DEFAULTS` is the single source (resolution order at `Canvas.svelte:566-572`).

---

## 11. Genuine design judgements — surface these to the owner, do not decide silently

1. **7hp = 1260 px is the widest card in the rack** (ties `pentemelodica`). It will scroll horizontally in the dock full-view's 50/50 split pane. 6hp does *not* work (§0/C2). Owner should confirm 7hp before build.
2. **Display size 320×240 (4:3).** The vertical ceiling is 315 px (≈420×315). 240 leaves 75 px of buffer for the next control addition. Owner may want it bigger — every 10 px of display height comes straight out of that buffer.
3. **Display backing store is DPR-1 (320×240).** On a 2× display the preview will look soft. Doubling to 640×480 quadruples the per-frame `drawImage` cost. Owner call: sharpness vs. per-rack CPU.
4. **The bank-title hint becomes a "turn TV on" button** (§4). Small behavioural addition to a dimmed bank. Owner sign-off on the interaction.
5. **Six discrete switches still carry no MIDI-Learn** (`mirrorX/Y`, `shape`, `pureGeo`, `flicker`, `tvMode` are plain `<button>`s — no `makeMidiAssignable`, no `ControlContextMenu`). They *are* CV-addressable via their gate ports, toggle/cycle only. Adding MIDI-Learn to them is a real feature request, out of scope here. **If any of the 19 faders or 4 camera axes is re-rendered as a bespoke primitive during this rebuild, it MUST carry `moduleId` + `paramId` (or `xParamId`/`yParamId`) or MIDI-Learn and automation-touch silently disappear.**
6. **`bezel` is the only continuous param with no CV input.** Given it is the load-bearing boundary between nesting levels, a slow LFO on it is an obvious gesture. Def gap, not a card gap — a separate PR (it is a contract change → re-attest).
7. **DELAY is operable-but-inert while `delay_clock` is patched** (`:577-580`). Deliberate; the CLK badge makes it legible. Flagging it because it is a third category — neither hidden nor disabled, yet dragging it does nothing.

---

## 12. Local green set before pushing (3× each, per the flake standard)

```sh
flox activate -- task test:one -- card-control-ranges
flox activate -- task test:one -- rack-sizing
flox activate -- task test:one PKG=scripts -- test-ledger
flox activate -- task test:ledger:accept        # after the vrt-exemptions reason rewrite
flox activate -- task docs:accept               # after the docs.explanation rewrite; REVIEW the diff
flox activate -- task typecheck

flox activate -- task e2e:serve
REPEAT=3 flox activate -- task e2e:one -- tests/backdraft-full-output.spec.ts
REPEAT=3 flox activate -- task e2e:one -- "tests/card-control-overflow.spec.ts --grep backdraft"
REPEAT=3 flox activate -- task e2e:one -- tests/backdraft.spec.ts
flox activate -- task e2e:stop
```

VRT needs nothing (backdraft is in `EXEMPT_FROM_VRT`; `git ls-files | grep backdraft` returns zero PNGs and there is no `EXEMPT_BASELINE_PAIRS` entry — a card relayout moves nothing). The WebGL attest needs nothing (§8).