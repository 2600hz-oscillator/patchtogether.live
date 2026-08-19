# FACEPLATE BUILD SPEC — `mandelbulb` (video)

Written 2026-08-19 for the agent who will BUILD this face. Everything here was
read out of the tree at `02f77e20` (branch `feat/face-moog904a` worktree
`agent-a5c5eeb647927735a`). Nothing needs re-deriving; everything that is a
number carries its provenance.

**Provenance labels used throughout:**

- `DERIVED-BY-READING` — read straight off the source named beside it.
- `MEASURED` — produced by the probe script in §14 (a faithful JS transcription
  of the shader march + the slice lib, run under node). It measures the
  **algebra**, not the GPU: float64, not GLSL `highp` float32, and not
  SwiftShader.
- `GIVEN-BY-BRIEF` — handed to me as settled; where I could check it, I say so.

> ⚠ **This spec does not authorise a merge.** Read §12 (costs) and §13 (open
> owner questions) before writing code — one deliverable forces a **GPU
> re-attest**, and one asks the owner a question this spec deliberately does not
> answer.

---

## 0. Status of the three things the brief called settled

| claim | status |
|---|---|
| `glyph: 'none'` is mandatory, for a reason unique to mandelbulb | **CONFIRMED by reading three seams** (§4). ⚠ The cited proof file `packages/web/src/lib/ui/workflow/mandelbulb-glyph-tap.test.ts` **DOES NOT EXIST** in this worktree *or* in the main checkout. It is a deliverable, not a citation. |
| the card's pointer drag is the SLICE gesture, not a camera orbit | **CONFIRMED** — `MandelbulbCard.svelte:129-146`: `pointerToParams` writes `slice_y` (from `fy`) and `slice_ry` (from `fx`); `onBoxPointerDown:141` returns unless `sliceOn`. `rotate_x`/`rotate_y` appear only in `CONTROLS` (`:243-244`) as knobs. |
| #1920 / #1921 / #1922 are filed; reference, do not re-file | Taken as given. §10 and §14 add **measurements** that sharpen #1920 — report them on the existing issue, do not open a new one. |

---

## 1. What it is FOR, and the verb

A single full-screen-quad fragment shader ray-marches the power-8 Mandelbulb
distance estimate, shades it (finite-difference normals, diffuse, Phong,
soft shadow), tints it by HUE, and emits `video_out`. Turn `slice` ON and a
**fixed-size, camera-independent plane** is marched through the *same* distance
field to read a 256-sample wavetable, played as an oscillator on `audio_out`.

**The one thing its siblings do not do.** `mandleblot` and `acidwarp` are
pictures. `cube` is a sound with a picture. mandelbulb is the only module in the
registry that is **one geometry read by two engines at once** — a camera and a
cutting plane — and the two are deliberately decoupled: `SLICE_PARAMS`
(`mandelbulb.ts:675-677`) is `{slice_y, slice_rx, slice_ry, slice_rz, power,
detail}`, so orbiting or zooming **cannot** change the sound
(`mandelbulb-slice.ts:10-17` states this as the lib's whole design).

**The verb: FRAME A SOLID, THEN CUT IT.** Every rank in §8 descends from that
sentence, and the fact that exactly **two** params (`power`, `detail`) cross
from one engine to the other is the axis the ranking uses.

---

## 2. STOP 1 — does it MERIT a face? **YES.**

The refusal bar (`module-faceplates.md:38-53`) is *all* of: ≤2 params, no
control families, no `node.data`-backed affordances, no derived quantity worth a
readout. mandelbulb fails every clause:

- **13 params** (`mandelbulb.ts:374-391`), in ~6 distinct control shapes:
  `log 0.3..3` · `linear ±π` (×5) · `linear 1..12` · `discrete 4..30` ·
  `linear 0..1` · `discrete 0..1` (×3) · `linear ±1.2`. DERIVED-BY-READING.
- **10 CV inputs + 2 outputs across two domains** (`:345-373`) — the only video
  def in the registry with a `type: 'audio'` output.
- **Three derived quantities no dial states** (§10), two of which make live,
  filed defects visible on the faceplate.
- A genuine two-page structure (picture engine / sound engine) that a tier
  ladder can rank.

---

## 3. STOP 2 — does every way of getting DATA IN survive promotion? **YES.**

The skill's grep (`module-faceplates.md:68-71`), run verbatim on
`packages/web/src/lib/ui/modules/MandelbulbCard.svelte`:

```
313:    <button      →  SPIN  → param `autospin`   (discrete 0..1)
320:    <button      →  SCRN  → param `screen_on`  (discrete 0..1)
327:    <button      →  SLICE → param `slice`      (discrete 0..1)
```

Three hits, **all three param-backed**. `grep -nE 'node\.data|setNodeData|readData'`
on the same file returns **nothing** — this card owns no `node.data` state at
all, so the `samsloop` class (an input path that cannot survive promotion) does
not apply. Full affordance map:

| card affordance | line | survives as |
|---|---|---|
| 6 camera/shape knobs | `:337-345` | `param` cells (`face.order`) |
| 4 slice knobs (SLICE ON only) | `:350-358` | `param` cells |
| SPIN / SCRN / SLICE buttons | `:313-333` | `toggle` cells — **automatic**, see §7 |
| yellow select-box drag (`slice_y` + `slice_ry`) | `:129-146` | `face.xyPads` — §9 |
| display #1, live fractal preview | `:282-288` | `hasVideoSurface(def)` → `VideoTileThumb` (§4) |
| display #2, `mandelbulb-slice-readout` | `:301-310` | **THE OPEN QUESTION — resolved in §5** |
| patch panel (10 CV in, 2 out) | `:260-264` | the rear card (derived from `face.pages`) |

No file input, no `oncontextmenu`, no selector, no audition seam. **Promotion
loses nothing** provided §5 lands.

---

## 4. `glyph: 'none'` — MANDATORY, and for a reason no other video def has

Every video face must declare `glyph: 'none'` because `primaryAudioOutPortId`
returns null for them and any other literal resolves `{kind:'static'}`, which
reddens module-face-lint's dead-glyph clause (backdraft `:3297-3306`,
spirographs `:432-445`).

**mandelbulb is the one video def where that argument does not apply — and the
conclusion is the same, via a worse failure.** Verified by reading, in order:

1. `shell-glyph-live.ts:96` — `primaryAudioOutPortId` = *the first output with
   `type === 'audio'`*. mandelbulb declares `{ id: 'audio_out', type: 'audio' }`
   (`mandelbulb.ts:372`), so it returns **`'audio_out'`, not null**.
2. `shell-glyph-live.ts:156` — `if (audioOut) return { kind: 'live-audio', portId: audioOut }`.
   So **any** non-`'none'` glyph resolves to a LIVE-AUDIO binding here and
   passes every def-reading gate.
3. `shell-glyph-live.ts` `createShellGlyphTap` → `engine.getDomain('audio')` →
   `AudioEngine.getOutputNode` (`packages/web/src/lib/audio/engine.ts:849-854`),
   which is `this.nodes.get(nodeId)` — **the AUDIO engine's own node map**.
4. `PatchEngine.addNode` (`engine.ts:1096-1099`) routes by `node.domain`:
   `this.getDomain(node.domain).addNode(node)`. A `domain: 'video'` node is
   added to the VIDEO engine and **never enters `AudioEngine.nodes`**.

⇒ `getOutputNode` returns `null` forever ⇒ the tap never attaches ⇒
`getLevel()` is `0` and `getSamples()` is `undefined` for the life of the node.
A `meter` glyph would paint an unlit meter and a `scope` glyph a flat line,
**for ever, on a module that is audibly droning**.

**Deliverable:** write `packages/web/src/lib/ui/workflow/mandelbulb-glyph-tap.test.ts`
in this PR (it does not exist). It must assert BOTH directions:

- `glyphBinding({...mandelbulbDef, face:{glyph:'meter'}}).kind === 'live-audio'`
  — i.e. the def-reading gate **cannot** see the defect (that is the finding);
- a `createShellGlyphTap` against a PatchEngine-shaped mock whose `video` domain
  holds the node and whose `audio` domain does not → `attached() === false`,
  `getLevel() === 0`;
- **the positive leg**: the same tap against a mock where `getOutputNode` DOES
  resolve → `attached() === true`. Without it, leg 2 passes on a broken mock
  (memory: *a passing negative control is not enough*).

The picture arrives from a different seam: `hasVideoSurface(def)` is literally
`def.domain === 'video'` (`module-shell-model.ts:177-179`), and
`laneGlyphFor` returns `'picture'` for it (`:237-240`). So **`'none' + blank`
and `'none' + live thumbnail` are indistinguishable from the declaration** —
`mandelbulb-face-model.test.ts` must assert `hasVideoSurface(mandelbulbDef)`
directly, exactly as backdraft and spirographs do.

---

## 5. THE OPEN QUESTION — where does `mandelbulb-slice-readout` go?

### 5.1 Verdict: **(b) a `custom` sidebar block**, fed by a NEW engine read key

Register `'mandelbulb-slice'` in
`packages/web/src/lib/ui/workflow/sidebar-panels.ts` and declare

```ts
sidebar: [{ kind: 'custom', label: 'slice', panelId: 'mandelbulb-slice' }]
```

The panel **READS the waveform the oscillator is already playing** through a new
`read('sliceWave')` key on the module handle. It **never calls `mbSampleSlice`**.

### 5.2 Why not (a), a PF-14 `panel` cell

Two independent reasons, both from the tree:

**(i) As `hero.cell` it would DELETE the module's own picture.**
`module-shell-model.ts:876`:

```ts
heroGlyph: args.hasGlyph && !(dock && (args.heroCell || args.hasExtensionBody)),
```

For mandelbulb `hasGlyph` is true *because of the video surface*
(`ModuleShell.svelte:319` + `laneGlyphFor` → `'picture'`), and `glyphCell()`
renders `VideoTileThumb` when `videoThumb` (`ModuleShell.svelte:1170-1174`).
So declaring **any** `hero.cell` suppresses the **live fractal preview at the
dock**. The card shows *both* displays; a hero panel would trade one for the
other. That is a functional-parity regression, and functional parity is a hard
requirement (memory: *never surface "we would lose X" as an owner choice*).

> This corrects the brief's premise in the useful direction: the rank-7 wall is
> real for a *plain* panel, but `foldedOrder`/PF-22 **exempts a `hero.cell`
> panel from lane selection entirely**, so a panel *may* rank first
> (`module-face-lint.test.ts:1461-1473`, negative-controlled). The thing that
> rules `hero.cell` out here is the glyph suppression, not the rank.

**(ii) As a non-hero panel at rank ≥7 it is legal but needs a PROBE it cannot
honestly have.** `ShellPanelCell.probe` is **required**
(`shell-cells.ts:222-271`) and its `action` is `'click' | 'drag'` with an effect
in `{data, data-rev, text}`. The slice readout is a **pure display** — the only
interaction on the card is the yellow box, which writes *params*, and there is
no `param` effect kind (nor could there be: a panel must never emit
`control-<paramId>`, `shell-cells.ts:206-212`). Inventing a click for the sake
of the probe invents an affordance the module does not have.

For completeness: the rank arithmetic the brief cited is correct —
`FACE_TIER_CAPS` (`curated-face.ts:70-75`) is mini 1 / compact
`LANE_ROW_MAX_CELLS` / full `LANE_PLATE_MAX_CELLS` / dock `Infinity`, with
`LANE_ROW_MAX_CELLS_WITH_GLYPH = 2`, `LANE_ROW_MAX_CELLS = 3`,
`PLATE_COLS = 3`, `PLATE_MAX_ROWS = 2` ⇒ full = 6
(`module-shell-model.ts:366-369,469`). mandelbulb has 13 ranked keys, so rank 7
*is* reachable. It is simply the wrong shape.

### 5.3 Why not (c), an exemption

`module-faceplates.md:55-87` (STOP 2) plus the functional-parity ruling: the
readout is the ONLY surface anywhere that shows what the plane is cutting, and
promotion deletes the card from both the lane and the dock
(`DockFullView.svelte:319` renders `<ModuleShell>` *instead of* the card).
Dropping it is not an owner choice to surface.

### 5.4 Why the sidebar is the RIGHT shape, not just the remaining one

`sidebar-panels.ts:24-25` states the contract: *"A panel READS; it does not own
state. It takes a nodeId and derives everything from the live node + def."*
That is exactly this picture. The precedent paragraph at `:76-91` (meowbox
`formant-bank`) exists to say that a `custom` block **carries no `face.order`
key and therefore no rank**, which is why it can hold a picture a rank could
not. `noise-taps` (`:96-114`), `illogic-routing` (`:158-182`) and
`alm-transfer` (`:183-201`) are the same move.

**One thing is genuinely NEW here and must be stated in the registry comment:**
every existing sidebar panel is DRAWN from params and never traced. This one
reads a value off the live engine. Justify it in-comment on the ground that
makes it *stronger* than a re-derivation:

> Re-deriving the wave in the panel would be a THIRD independent derivation of
> one waveform, and the second and third already disagree — the card reads
> CV-inclusive live params (`MandelbulbCard.svelte:164-169`, via `liveParam` →
> `engine.readParam`) while the engine reads committed params
> (`mandelbulb.ts:523-530`), which is half of #1922. Reading the engine's own
> cache makes the picture and the sound **unable** to disagree.

Determinism is preserved: the engine recomputes **only on a signature change**
(`mandelbulb.ts:531-535`), so the value is stable at rest — which is what a VRT
baseline needs (§11).

### 5.5 The engine seam the panel needs (a `mandelbulb.ts` change)

The handle already answers four keys (`mandelbulb.ts:703-709`): `'eyeDist'`,
`'screenOn'`, `'autospin'`, `'slice'`. Add a fifth:

```ts
if (key === 'sliceWave') return lastWave;   // Float32Array | undefined
```

- `recomputeSlice` (`:521-543`) must cache **before** posting: the current call
  is `oscNode.port.postMessage({...}, [wave.buffer])`, and a transfer
  **neuters** `wave`. Cache `wave.slice()` (256 floats = 1 KiB) *before* the
  transfer, or post a copy.
- ⚠ **A latent 2× in the same function, found while reading — not filed
  anywhere I could see.** The `catch` fallback at `:541` calls
  `mbSampleSlice(sp)` a **second time** to recover from a failed transfer,
  instead of posting the cached copy. At the measured 11.96 ms (§6) that is an
  11.96 ms penalty for a shim quirk. Fold the fix into this PR's def commit and
  say so in the body; if the owner wants it tracked, file it then.
- The panel reads it via `PatchEngine.read(node, key)`
  (`engine.ts:2234-2236` → `getDomain('video').read(nodeId, key)` → the
  handle's `read`). Reach the engine from the panel with `useEngine()`
  (`$lib/audio/engine-context.ts:22-28`, which **safely returns
  `{ get: () => null }` out of context**). If it turns out the sidebar is
  outside Canvas's provider, `getActiveEngine()` (`$lib/audio/engine-ref.ts:23`)
  is already exported and already consumed from plain `.ts`
  (`module-faceplates.md:230-233` — *two independent agents invented the same
  false blocker here; do not be the third*). **Verify which one resolves before
  writing the drawing code.**
- With `slice` OFF (the default) there is no wave — `ensureAudio` is never
  called, so `oscNode` is null and `recomputeSlice` returns at `:522`. The panel
  must render an explicit inert state (`slice off — audio_out silent`), which is
  exactly what the module does and what the card does (`:301`, the canvas is not
  even mounted).

### 5.6 CI cost of choosing (b)

| item | cost | provenance |
|---|---|---|
| `contract-lock.txt` gains one line, `<type> face sidebar 0 kind=custom label=slice panelId=mandelbulb-slice` | one `flox activate -- task docs:accept`, reviewed as a diff | `contract-signature.ts` `serializeFaceSidebar`; CLAUDE.md "face is MOSTLY contract-transparent — sidebar is NOT" |
| `faceplate-platform.spec.ts` sidebar sweep gains one adopter | `sweepBudgetMs(n) = 30_000 + n*20_000` (`:164-166`) ⇒ the **cap** rises 20 s; the **wall time** rises by one shell boot. The sweep measured 11.9 s under `E2E_SWIFTSHADER=1` across the then-5 adopters ⇒ **≈2.4 s/adopter** | DERIVED-BY-READING (`faceplate-platform.spec.ts:139-165`) |
| `sidebar-panels.ts` | shared registry file — post-merge conflict surface (CLAUDE.md) | — |
| the panel component itself | not in the WebGL attest basis: the basis walks `packages/web/src/lib/video/**` and only those `lib/ui/modules/*.svelte` that create a GL context (`scripts/webgl-attest-lib.ts:260-275`). `lib/ui/workflow/panels/` is outside both | DERIVED-BY-READING |

The `mandelbulb.ts` edit in §5.5 **is** in the attest basis — see §12.

---

## 6. ⚠ THE COST RULE — read, never recompute

**MEASURED (§14, node, algebra only): one `mbSampleSlice` call is 11.96 ms at
`iters = 20` and 9.85 ms at `iters = 16`** — 256 × 64 = 16 384
`jsDistanceEstimate` calls, each looping up to `iters` times over
`sqrt/acos/atan2/pow×2/sin×2/cos×2`. For scale, `CubeHeroPanel.svelte:29-35`
records the analogous cube scan as **1.421 ms measured** — the bulb is ~8.4×
that, because the cube reads a field and the bulb iterates an escape-time
formula.

Where it runs today:

- **Engine**, main thread, synchronously inside `setParam` for any
  `SLICE_PARAMS` member (`mandelbulb.ts:697`), guarded by a `round(v*1000)`
  signature (`:531-535`), and **only once `oscNode` exists** — i.e. only with
  SLICE ON.
- **Card**, main thread, inside the rAF loop's `drawSliceReadout`
  (`MandelbulbCard.svelte:159-190`), with its own independent signature cache,
  again only with SLICE ON (`:230`).

⇒ With SLICE ON and a slice CV moving, the CV bridge writes once per frame, so a
frame that moves the plane pays **≈24 ms of DE scanning before the raymarch
runs at all** (2 × 11.96 ms MEASURED) — a ~41 fps ceiling from the readout
alone. **A third scan would make it ~36 ms / ~27 fps.**

**Therefore, binding rules for this face:**

1. Nothing on the faceplate may call `mbSampleSlice`, `mbRayDepth`,
   `mbSliceRay` or `jsDistanceEstimate`. The panel reads `read('sliceWave')`;
   the toggles/readouts read params.
2. **No `FaceReadoutValue` may derive anything from the waveform.** It
   structurally cannot anyway — `FaceReadoutValue` is
   `(read: (paramId) => number | undefined) => string`
   (`face-readout-values.ts:397`), so `node.data` and engine state are both out
   of reach — and it *runs on every render*, so a 12 ms body would take the
   faceplate down mid-drag.
3. Read the four keys the module already publishes (`'eyeDist'`, `'screenOn'`,
   `'autospin'`, `'slice'`, `mandelbulb.ts:703-709`) rather than recomputing
   any of them.
4. **Bonus, state it in the PR body:** at the DOCK the promoted face *removes*
   the card's duplicate scan (the card is not rendered — `DockFullView.svelte:319`),
   so the faceplate path is **1× where the card path is 2×**. The card keeps its
   own copy in the legacy rack; this PR does not touch it.

---

## 7. SCREEN ON/OFF — already satisfied, and say so explicitly

Owner ruling (`module-faceplates.md:126-135`): *"'screen on / off' on the card
like that is a thing all video modules should have moving forward"*, with
backdraft's `BackdraftOutputBody.svelte` (~`:314`) as the reference: the button
collapses the preview and **reclaims its vertical space while the module KEEPS
RENDERING** (ON again shows the LIVE picture, never a stale frame — the
#1720/#1721 bug class), and the state **persists through tab switches**.

> ⚠ **The brief refers to an "OVERLAY paragraph" in that section. It is not in
> this worktree's copy of the skill** — I grepped `-i overlay` across
> `.claude/skills/module-faceplates.md` (614 lines) and got zero hits. Either it
> is an uncommitted edit in a sibling worktree or it has not landed. **Re-read
> that section before you build, and if an OVERLAY requirement exists, treat it
> as authoritative over this paragraph.**

**mandelbulb already satisfies the ruling with no new mechanism, and the toggle
is automatic.** `screen_on` is `{ min: 0, max: 1, curve: 'discrete' }`
(`mandelbulb.ts:382`); `looksLikeToggle(p)` is exactly
`p.curve === 'discrete' && p.min === 0 && p.max === 1`
(`graph/group-controls.ts:54-56`), and `shellControlKind` returns `'toggle'` for
it (`shell-control-kind.ts:270`). The same is true of `autospin` and `slice`.
`detail` is `discrete 4..30`, so it stays a **knob** — correct.

The behaviour behind the toggle is already the ruling's: `screen_on` OFF skips
the raymarch **only when `video_out` is also unpatched**
(`mandelbulb.ts:613-623`) and the FBO keeps its last frame, so a downstream
consumer never goes dark and nothing is torn down.

**What the face must assert** (in `mandelbulb-face-model.test.ts`): `screen_on`
resolves to cell kind `'toggle'` at the dock, and it is ranked in `face.order`
(so `module-face-lint`'s completeness sees exactly one interactive cell for it).
Do **not** hand-build a screen button.

---

## 8. THE RANK — 13 params, 4 pages, NO TAB RAIL

### 8.1 The argument, from the DSP/shader

- `slice` (`:386`) is the module's `count`: it ships **0**, and with it off
  **four params and one of the two outputs are inert** — `ensureAudio` is never
  called (`:594`), so no audio node exists at all. Same shape as spirographs'
  `count` (20 of 31 params bit-exactly inert at spawn,
  `spirographs.ts:~418-423`), which is why that face ranks it first.
- `power` (`:378`) is the only *continuous* control that reaches **both**
  engines (`SLICE_PARAMS`, `:675-677`); it changes what the object IS.
- `zoom` (`:375`) is the framing gesture, and it carries a **measured cliff**
  (§10.2): the module's declared minimum renders 100 % sky.
- `rotate_y` (`:377`) is what `autospin` drives (`:632`), so it is the axis the
  module moves on its own; `rotate_x` (`:376`) is its partner.
- `hue` (`:380`) applies unconditionally (it tints both the lit surface and the
  sky, `FRAG_SRC:232-241`) but changes no geometry and no sound.
- `detail` (`:379`) is **demoted on measurement, not taste** — see §10.1: the
  shader caps the loop at `MAX_ITER = 16` (`FRAG_SRC:132`) and, at the def's own
  defaults, the delivered picture is unchanged from `detail = 8` upward
  (MEASURED §14 B). It is the least effective dial on the module per unit
  travel, so ranking it high would be ranking a dead band.
- `autospin` / `screen_on` are set-and-forget view state.
- The four slice-plane params only mean anything with `slice` ON.

### 8.2 `face.order` (13 keys — every param, as completeness requires)

```
'slice',                                   // 1 — nothing on the audio half exists until this is on
'power',                                   // 2 — the only continuous control in BOTH engines
'zoom',                                    // 3 — framing, and the one dial with a measured cliff
'rotate_y', 'rotate_x',                    // 4,5 — the orbit; rot Y is what SPIN drives
'hue',                                     // 6 — unconditional, colour-only  (end of the LANE budget)
// ── dock-only from here ───────────────────────────────────────────────
'slice_ry', 'slice_y',                     // the XY pad (y folds into x's cell; both must be listed)
'slice_rx', 'slice_rz',
'detail',                                  // demoted on the measurement in §10.1
'autospin', 'screen_on',
```

**The tier ladder as a sentence:** mini shows SLICE; compact shows SLICE +
POWER beside the live thumbnail (`LANE_ROW_MAX_CELLS_WITH_GLYPH = 2`, because
`laneGlyphFor` → `'picture'`); the in-lane plate shows the top six — SLICE,
POWER, ZOOM, ROT Y, ROT X, HUE; the dock shows all thirteen in four bands with
the live picture above them.

⚠ The XY pad's `x` key costs **no** lane rank — `laneOrder` excludes pad keys
(`graph/types.ts:831-838`) — so seating `slice_ry` at rank 7 does not shift the
lane budget.

### 8.3 `face.pages` — 4 pages, by FUNCTION

```
{ id: 'bulb',    label: 'bulb',    controls: ['power', 'detail'] }
{ id: 'camera',  label: 'camera',  controls: ['zoom', 'rotate_y', 'rotate_x', 'autospin'] }
{ id: 'picture', label: 'picture', controls: ['hue', 'screen_on'] }
{ id: 'slice',   label: 'slice',   controls: ['slice', 'slice_ry', 'slice_y', 'slice_rx', 'slice_rz'] }
```

Why these four and not others:

- **bulb** is the object itself — and it is the *only* page whose controls reach
  the sound as well as the picture. That is the module's central fact.
- **camera** is explicitly decoupled from the sound (`mandelbulb-slice.ts:10-17`,
  `mandelbulb.ts:671-674`). `autospin` belongs here because it *is* rot Y
  (`:632`).
- **picture** is how the frame is painted and whether it is painted at all —
  `hue` tints surface + sky, `screen_on` gates the render. Neither touches
  geometry or audio. It exists because `hue` alone would be a one-control page,
  which the skill forbids unless the control is the module's identity
  (`module-faceplates.md:150-153`); paired with `screen_on` it is a real idea.
- **slice** is the second engine.

### 8.4 NO TAB RAIL — and do not pad to get one

`DOCK_TAB_MIN_BANDS = 7` (`dock-tabs-model.ts`). **The honest page count is 4.**
The 2026-08-18 control-heavy ruling (`module-faceplates.md:106-124`) is met by
spirographs (31 params / 10 distinct shapes / 10 pages) and backdraft (7 pages);
mandelbulb at 13 params and ~6 shapes is **under** that bar, and the ruling is
explicit: *"If a heavy module's honest semantic grouping lands at 5–6 pages —
under the rail threshold — do not pad pages to force the rail; raise it to the
owner instead."* Four pages is under even that. **Ship it unrailed** and say so
in the face comment.

**Row-plan prediction (verify with `task test:one -- dock-row-plan`):** an
unrailed face packs (`dock-row-plan.ts`). `xy: 'wide'`
(`PARAM_CELL_WIDTH_CLASS`, `:113-139`), so the **slice band is SOLO**
(`bandIsPackable`). Cells per band: bulb 2, camera 4, picture 2, slice 4 (the
`slice_y` axis folds into `slice_ry`'s cell, so 5 keys → 4 cells). The packable
run 2+4+2 = 8 ≤ `DOCK_ROW_MAX_CONTROLS` (10) ⇒ **two rows: [bulb camera picture]
(8 cells), [slice] (4, solo)**. Twelve painted cells in total.

---

## 9. `face.xyPads` — one pad, and it is the SLICE pad

```ts
xyPads: [{ x: 'slice_ry', y: 'slice_y', label: 'slice' }]
```

- It reproduces the card's actual gesture: `fx → slice_ry`, `fy → slice_y`
  (`MandelbulbCard.svelte:132-138`).
- Axis convention checks out: `sliceYToFrac` maps `+MB_SLICE_Y_RANGE` to the TOP
  (`:116-120`), so **drag up = larger `slice_y`** — the `XyPad.svelte` joystick
  convention (`graph/types.ts:697-700`).
- Both axes are CONTINUOUS (`linear ±π` and `linear ±1.2`), which
  module-face-lint requires (`graph/types.ts:826-831`), and **both must appear
  in `face.order`** even though `y` never renders its own cell (backdraft
  `:3292-3294` learned this the hard way — both authorings were red).
- **Ranges come from the def**, never re-typed in a component — the backdraft
  class (CLAUDE.md). `MB_SLICE_Y_RANGE` is already exported
  (`mandelbulb.ts:288`); the pad cell reads the `ParamDef`, so the divergence is
  unrepresentable. If you touch the card at all, add
  `MandelbulbCard.svelte` to `RANGE_BOUND_CARDS` (boy-scout;
  `card-range-source.test.ts`).

**No camera pad.** `rotate_x`/`rotate_y` are knob-only on the card, so a camera
pad would be a NEW affordance, not parity — see §13 Q2.

---

## 10. READOUTS — three, each with a PERMANENT negative control

All three are `hero.readouts` with `valueId`s registered in
`face-readout-values.ts`, computed by pure functions living in a new
`packages/web/src/lib/ui/modules/mandelbulb-face-model.ts`. All three are pure
functions of params (the registry can see nothing else, §6 rule 2) and none of
them costs a DE call.

**`hero` declares readouts ONLY** — no `cell` (§5.2 i), no `control` (backdraft's
owner review removed its hero control for being present in every view), no
`action` (mandelbulb has no audition seam; a hero button would be the dead
`toBeEnabled()` control `ShellActionCell.probe` exists to prevent). A
readouts-only hero keeps `heroGlyph` true, so **the live fractal thumbnail
paints above the readout row** (`ModuleShell.svelte:1344-1351`).

### 10.1 `mandelbulb-iters-delivered` — label `iters`

Prints the iteration count the SHADER actually runs: `min(16, round(detail))`,
against a dial declared 4..30 (`FRAG_SRC:132,143`; `mandelbulb.ts:379`). This is
#1920 made visible on the faceplate.

**MEASURED (§14 B, 96×72 rays through the transcribed march, def defaults
`zoom 1 / rot 0.5,0.6 / power 8`):**

| declared `detail` | delivered | hit pixels | pixels differing vs delivered-16 | max &#124;Δt&#124; |
|---|---|---|---|---|
| 4 | 4 | 6579 | 3 | 3.14e-1 |
| 8 | 8 | 6576 | **0** | **0.00e+0** |
| 12 · 15 · 16 | 12 · 15 · 16 | 6576 | **0** | **0.00e+0** |
| 17 · 20 · 24 · 30 | **16** | 6576 | **0** | **0.00e+0** |

So the dead band is **worse than #1920 records**: the hard cap starts at 16
(55.6 % of travel), but at the def's own defaults the delivered picture is
already identical from `detail = 8` — **~85 % of the dial's declared travel
changes nothing in the picture**. Post this on #1920; do not open a new issue.
⚠ Caveat, state it wherever you quote it: float64 transcription, one camera, one
power, a coarse grid, and hit-mask + `t` equality (shading follows, since
`calcNormal` calls the same DE). It is an ALGEBRA result, not a pixel claim.

The audio path is genuinely uncapped but the divergence is **small**: max &#124;Δ&#124;
on the 256-sample wave vs `iters = 16` is **9.7e-4 (17) / 3.4e-4 (20) /
6.0e-4 (30)** at `rx 0.6, ry 0.4, rz 0, sliceY 0` (MEASURED §14 B). Report that
honestly — "one dial, two laws" is true in kind, ~1e-3 in magnitude at that
slice position. **Widen the slice-position sample before asserting anything
stronger.**

**Permanent negative controls** (`mandelbulb-face-model.test.ts`):
sweeping `detail` 17→30 must move the readout by **exactly 0** while a
`paramId: 'detail'` readback moves 13; sweeping 4→16 must move it 1:1. Both
directions, both legs, every run.

### 10.2 `mandelbulb-framing` — label `frame`

Prints the eye distance and, below the cliff, the fact that the frame is
**empty**. `jsEyeDistanceFromZoom(z) = 2.2 / clamp(z, 0.3, 3)`
(`mandelbulb.ts:87-90`); the march terminates at `MAX_DIST = 6.0`
(`FRAG_SRC:134`), so past a certain eye distance **no ray can reach the bulb**
and the shader takes the sky branch for every pixel.

**MEASURED (§14 C):** bisecting the centre ray gives the threshold at
**zoom = 0.3415 (eyeDist = 6.4419)**. Frame sweep at 64×48 rays:

| zoom | eyeDist | hits/3072 | sky |
|---|---|---|---|
| 0.30 *(the declared minimum)* | 7.333 | 0 | **100 %** |
| 0.31 / 0.32 / 0.33 / 0.34 | 7.097 … 6.471 | 0 | **100 %** |
| 0.35 | 6.286 | 311 | 89.9 % |
| 0.40 | 5.500 | 523 | 83.0 % |
| 0.50 | 4.400 | 835 | 72.8 % |

This **confirms the brief's 0.3416 to four figures** (I got 0.3415; the 1e-4
gap is the bisection's own tolerance). **The declared minimum 0.30 is inside the
blank-sky band**: 12.4 % of the ZOOM dial's low end renders a picture with no
bulb in it. A `paramId: 'zoom'` readout prints `0.30` and looks perfectly
healthy.

**Permanent negative controls:** at `zoom = 0.30` the readout must report the
blank state while the `zoom` dial reports its value normally; at `zoom = 0.35`
it must not. Plus an invariance leg: `power`, `detail`, `hue`, every slice
param and `autospin` must move it by **exactly 0** (it is a camera fact).
Assert the threshold constant is **imported from the def/model, never re-typed**
— and derive it in the model from `MAX_DIST` and the eye-distance map, so a
shader budget change reddens the test instead of the faceplate lying.

### 10.3 `mandelbulb-audio` — label `audio`

Prints what `audio_out` is actually doing: `silent` when `slice < 0.5` (no audio
node is ever constructed — `mandelbulb.ts:594`, `:683-698`), otherwise the
**fixed pitch**: `C4_HZ = 261.626` (`packages/dsp/src/mandelbulb-osc.ts:47`),
because the worklet's only pitch source is `inputs[0]` (`:168-173`) and the
factory wires a `ConstantSourceNode` with `offset = 0` into it
(`mandelbulb.ts:571-574`) — the def declares **no pitch input port at all**. So
the module's audio is an **unpitchable C4 drone**, which nothing on the card,
the docs page or any dial says.

⚠ **Never print an RMS or a level here** (#1922: the drone carries a large DC
bias). The readout is a state + a frequency, both pure param functions.

**Permanent negative controls:** every camera param and both fractal params must
move it by exactly 0; only `slice` may change it. Plus a totality leg (fresh
node / NaN / ±Infinity) on all three readouts — `face-readout-values.ts:80`
runs on every render, and a throw takes the faceplate down mid-drag.

### 10.4 Considered and NOT recommended: the spin period

`AUTOSPIN_RATE = 0.25 rad/s` ⇒ **one revolution per 25.13 s**
(MEASURED §14 D; it is arithmetic). It is a genuine fact nothing states — but it
is a **constant with two states** (`off` / `25.13 s`), so it cannot be
negative-controlled on anything except `autospin` itself, which is what the
toggle already says. Offer it to the owner (§13 Q3); do not ship it unasked.

---

## 11. VRT

### 11.1 Corrections to the brief

`HEAVY_RENDER` is **not** in `modules.spec.ts` (that file no longer exists). It
lives at `e2e/tests/io-spec-consistency.spec.ts:181` —
`{b3ntb0x, mandleblot, mandelbulb, twotracks, colourofmagic, sourcery,
warrensvisions}` — with `HEAVY_MOUNT_TIMEOUT = 30_000`,
`HEAVY_TEST_TIMEOUT = 90_000`, and those seven scheduled **one at a time** in
their own describe (`:601-640`, the #1539 measurement). mandelbulb is there
because *"a per-pixel GPU 3D fractal raymarcher whose first-paint shader compile
overruns the default budget"* (`:176-178`). **This face changes none of it** —
that sweep spawns the CARD at `/rack?shell=legacy`.

### 11.2 The existing live-surface entry, and what it means for you

`e2e/vrt/vrt-live-surfaces.ts:346-386` masks
`[data-testid="mandelbulb-canvas"]` on the `mandelbulb` **card** scene. The `why`
is worth reading in full before you touch anything pixel-shaped: unmasked,
`--update-snapshots` **could not write a baseline at all** — 8 settle attempts
differing 3 970 / 4 060 / 3 919 / 5 952 / 11 304 / 20 117 / 24 952 / 27 636 px,
*growing monotonically* because the auto-spin accelerates away from every
candidate settle. The mask covers 22.6 % of the card and carries a measured
companion (ink 0.056 / stdDev 12 / buckets 6 / chroma 6).

⚠ **The entry ends: *"the SECOND canvas on this card (mandelbulb-slice-readout)
is deliberately NOT masked; it is stable and stays in the diff."*** That is an
independent confirmation of §5's premise — the slice readout is
pixel-deterministic because it recomputes only on a signature change.

### 11.3 The two NEW face scenes

Add to the `FACES` roster in `e2e/vrt/_shell-faces.ts` (hand-maintained; nothing
ties it to `STRICT_FACES`, and the spec asserts set-equality both directions at
`workflow-shell-faces.spec.ts:540-563`):

```ts
{
  type: 'mandelbulb',
  pages: 4,                       // ⚠ RENDERED bands, not declared — see the 4plexer note (:251-258)
  videoFaceWhy:
    'both scenes carry a live picture: hasVideoSurface mounts VideoTileThumb at the compact '
    + 'tile AND above the dock hero, and this module SPINS BY DEFAULT (autospin ships at 1, '
    + 'advancing rot Y at 0.25 rad/s off the engine clock), so the surface is a different '
    + 'picture on every rendered frame. An AudioContext suspend says nothing about a '
    + 'rAF-driven picture. The card scene could not even settle a baseline unmasked '
    + '(vrt-live-surfaces.ts:346).',
}
```

`FACE_WIDTH_EXEMPTIONS` (`workflow-shell-faces.spec.ts:254`) is currently
**empty** — backdraft, spirographs and videoOut all pass the compact-by-default
width measurement without one. **Aim for zero.** If the face lands with slack,
fix the layout; only name an exemption if a live picture / XY pad genuinely
consumes it, and then the `why` must be ≥40 chars and name the consumer
(`:464-471`).

### 11.4 ⚠ THE FREEZE PROBLEM — the one hard blocker

`freezeFaceVideo` (`e2e/vrt/_shell-faces.ts:1408-1452`) is **hard-wired to one
param name**: it writes `n.params.freeze = 1` into the Y.Doc, waits
`VIDEO_FREEZE_SETTLE_FRAMES`, then samples every canvas' `toDataURL()` across
real frames **in the page** and asserts the picture is unchanged, failing with
*"the video surface was still MOVING after writing freeze=1"*.

**mandelbulb has no `freeze` param.** Declaring `videoFaceWhy` without one
produces a loud, correct failure — not a silent bad baseline. Two routes:

**Route A (RECOMMENDED) — give the def a `freeze` param, exactly as the two
landed video faces did.**

- `spirographs.ts:366-386` and backdraft both declare `noUserControl: [{ param:
  'freeze', writer: 'internal', why: … }]`, keep it **out of `face.order`**, and
  early-return from `draw()`. `module-face-lint` refuses a `noUserControl` param
  that IS ranked and requires it to render **exactly zero** cells
  (`module-face-lint.test.ts:330-337, 415-427`), so the two declarations cannot
  drift.
- In `mandelbulb.ts`, guard at the **top** of `surface.draw` (before the
  auto-spin accumulation at `:602-607`), so `spinPhase` does not keep advancing
  under freeze.
- Costs: a `docs.controls.freeze` entry (mandelbulb is already in `STRICT_DOCS`,
  `strict-docs.ts:354`), a `task docs:accept`, and **a WebGL re-attest** (§12).
- **Upside worth stating in the PR body:** a real `freeze` is the prerequisite
  for eventually retiring the 22.6 % card mask in §11.2. Do **not** attempt that
  in this PR (it needs its own measured companion work) — file it as a
  follow-up.

**Route B (fallback, only if the attest cannot be re-pinned) — generalise the
helper.** mandelbulb's picture is frozen just as effectively by `autospin = 0`:
`draw()` skips the render whenever `sceneSig` is unchanged
(`mandelbulb.ts:641-645`), and with spin off and no param moving, `sceneSig` is
constant. Add an optional per-scene `videoFreezeParams: Readonly<Record<string,
number>>` to the roster entry, deny-by-default, with a reason string, and make
`freezeFaceVideo` write those instead of the hard-coded `freeze` — **keeping the
existing "did the picture actually stop" assertion**, which is what makes either
route safe. This is e2e-only: no contract change, no attest.

Take **A** if `flox activate -- task webgl:attest` can re-pin on this branch
(§12); take **B** if it cannot, and say which in the PR body.

### 11.5 Capture

New face scenes need nothing declared beyond the roster entry (#1458). Push,
then `flox activate -- task vrt:commit` — the dispatch scopes to the branch diff
(#1795) and prints its token, files and test count before dispatching.
**Predict the file count and count what the bot commits** (expect exactly 2:
`face-mandelbulb-compact.png`, `face-mandelbulb-dock.png`). A green dispatch
that commits nothing is a RED FLAG. Never commit a baseline by hand; a local
macOS run is not a verification.

---

## 12. COSTS, ACCEPT LOOPS, AND THE SHARED-FILE SURFACE

### 12.1 ⚠ THE ATTEST — this PR is NOT attest-free

`scripts/webgl-attest-lib.ts:260-263` walks **every non-`.test.ts` file under
`packages/web/src/lib/video`** into the basis. So `mandelbulb.ts` is in-basis,
and:

- the `face:` block, the `docs:` block and `controlFamilies` are **stripped
  before hashing** (`scripts/attest-code-basis.ts`; `module-faceplates.md:491-496`)
  ⇒ **authoring the face costs NOTHING**;
- a new `ParamDef` (`freeze`), a new `read()` key (`sliceWave`), the cache-copy
  in `recomputeSlice` and the `draw()` guard are all **code** ⇒ **one GPU
  re-attest**.

Bundle all four into ONE def commit so you pay it once. Before spending the GPU:
**attest the MERGED tree, not the branch tip** (memory: main moving a basis file
changes your hash), **kill any dev server on 5173/4173** (a stale server makes
the attest a FALSE refusal, and it can silently test a sibling worktree — use a
per-agent `E2E_PORT`), and check whether the standing camera-input failures are
still blocking re-attest. **If the attest cannot land, switch to Route B in
§11.4 and drop `freeze` from the def — but you still need `sliceWave`, so the
attest is required for the sidebar picture either way.** Raise it rather than
shipping the face without its second display.

### 12.2 Accept loops

| command | why |
|---|---|
| `flox activate -- task docs:accept` | `face.sidebar` is projected into `contract-lock.txt` (one line per block), and Route A adds a `freeze` ParamDef + its `docs.controls` entry. **Review the diff line by line.** |
| `flox activate -- task test:ledger:accept` | only if you edit an exemption list |
| `flox activate -- task art:update` | **NOT NEEDED** — no DSP changes |

### 12.3 The Push 2 card WILL move

`push-card-config.ts:20-33` is OVERRIDE → FACE → GENERIC. mandelbulb has no face
today, so it is on the GENERIC tier (declaration order). **Authoring a face
moves the whole card to the FACE tier** (the first 8 *turnable* params of
`face.order`). Read that file's `turnable` predicate, then accept the
`push-card-schema.test.ts` golden diff **deliberately, with the reason written
into the test**. If the owner wants the card pinned, add an explicit
`PUSH_CARD_CONTROLS` entry (an override REPLACES, so it cannot drift).

### 12.4 Shared files this PR touches (run `task pr:conflict-sweep` after any merge)

`strict-faces.ts` · `face-readout-values.ts` · `sidebar-panels.ts` ·
`e2e/vrt/_shell-faces.ts` (roster) · `push-card-config.ts` /
`push-card-schema.test.ts` (golden) · `contract-lock.txt` (**generated — take
main + re-run `docs:accept`, never hand-merge**). **Never** `gh pr update-branch`
on this PR.

### 12.5 CI wall-time estimate

| sweep | delta | provenance |
|---|---|---|
| `faces-parity` | 12 painted cells (§8.4) × 0.8 s + 10 s ≈ **19.6 s** | the spec's own CI model, `faces-parity.spec.ts:78-83` |
| `workflow-shell-faces` | 2 new scenes, each a boot; the 21-face roster measured ~74 s/run ⇒ **~7 s** | DERIVED-BY-READING |
| `faceplate-platform` sidebar sweep | **~2.4 s** wall, **+20 s** cap | §5.6 |
| VRT capture dispatch | scoped to the branch diff ⇒ ~3 min, not 41-56 | #1795 |

**≈30 s of required-lane wall time — comfortably under the ~2 min owner sign-off
bar.** Re-estimate if the page/cell count changes.

### 12.6 Gates to run locally (unit lane, ~0 CI cost)

```sh
flox activate -- task test:one -- module-face-lint
flox activate -- task test:one -- dock-row-plan            # verify the §8.4 prediction
flox activate -- task test:one -- dock-faceplate-model
flox activate -- task test:one -- shell-cells
flox activate -- task test:one -- curated-face
flox activate -- task test:one -- rear-card-model
flox activate -- task test:one -- mandelbulb-face-model    # YOUR negative controls
flox activate -- task test:one -- mandelbulb-glyph-tap     # §4, new
flox activate -- task test:one -- no-user-control          # Route A only
flox activate -- task test:one -- push-card-schema
flox activate -- task test:one -- module-docs-lint
flox activate -- task docs:check
flox activate -- task typecheck
```

Then, with a warm server, `REPEAT=3` on: `faces-parity --grep mandelbulb`,
`tests/faceplate-platform.spec.ts`, `e2e/vrt/workflow-shell-faces.spec.ts`.
⚠ Never run a bare `npx vitest` (it globs into sibling worktrees).

### 12.7 Merge posture

Owner ruling (memory, `faces-merge-on-green-except-cube-wavesculpt`): face MRs
self-merge on **final-commit** green, except `cube` and `wavesculpt`. The older
line in `module-faceplates.md:562-564` ("do not auto-merge a faceplate") is
superseded, **but this is the first face on this module and it is
look-affecting** — put the two VRT PNGs in the PR body and give the owner a
chance to look. Never merge on red; a red push run on main is a P0.

### 12.8 Rear card

`face.rear` is derivable — one section per `pages` page holding that page's CV
holes, plus the outputs rail. Re-derive it on paper for the four pages
(`slice_y_cv`, `slice_rx_cv`, `slice_ry_cv`, `slice_rz_cv` → `slice`;
`zoom_cv`/`rotate_*_cv` → `camera`; `power_cv`/`detail_cv` → `bulb`;
`hue_cv` → `picture`) and check `rear-card-model.test.ts`. **Two outputs in two
domains** (`video_out` mono-video, `audio_out` audio) — the derived default
splits by cable domain only once the rail out-runs a column, so authoring an
output group is probably unnecessary. Verify, do not assume.

---

## 13. WHAT IS **NOT** DECIDED — take these to the owner

1. **Does the sidebar picture earn its place at all, given that it is blank at
   defaults?** `slice` ships OFF, so on a freshly spawned module the block
   prints `slice off — audio_out silent` and nothing else. That matches the card
   exactly (the canvas is not even mounted with SLICE off) and it is the honest
   state — but it means the dock VRT baseline shows an empty block. An
   alternative is a two-layer panel: always draw a cheap, pure **plane-geometry
   schematic** (where the cutting plane sits, from `slice_y/rx/ry/rz` against the
   bulb's bounding radius — no DE calls), and overlay the cached waveform when
   SLICE is on. I did not choose this because it invents a picture the module has
   never had. **Owner's call.**
2. **A camera XY pad (`rotate_x` / `rotate_y`)?** backdraft's argument is that a
   camera is ONE gesture and splitting it into two sequential drags is a lost
   capability (`graph/types.ts:820-824`). mandelbulb's card never offered it, so
   adding one is an ENHANCEMENT beyond parity — attractive, and out of scope for
   a spec whose job is not to lose anything.
3. **The spin-period readout** (§10.4) — one honest fact, two states, no real
   negative control. Ship, or leave the hero at three readouts?
4. **Retiring the 22.6 % card mask** once `freeze` exists (§11.4 Route A). Real
   coverage recovered; needs its own measured companion work. File as a
   follow-up, do not bundle.
5. **`page.title` / `page.hint` / band hints are ANNOTATION-ONLY** and this spec
   declares none. If the owner wants prose it goes to right-click annotate, per
   the standing ruling. Confirm rather than adding text to the plate.

Also worth reporting (not a decision): `graph/types.ts:686` still says
*"(P1 authoring note; no video def carries a `face` yet.)"* — **stale**;
backdraft, spirographs and videoOut all do. One-line boy-scout fix.

---

## 14. APPENDIX — the probe, and its raw output

Script: `<scratchpad>/mbulb-face-spec-probe-a5c5eeb.mjs` (session scratchpad; the
scratchpad is shared between agents, hence the unique name). It is a **faithful
transcription** of `mandelbulb-de.ts`, `mandelbulb-slice.ts`, `cube-dsp.rotate`
and the `FRAG_SRC` raymarch (`MAX_ITER 16 / MAX_STEP 96 / MAX_DIST 6.0 /
SURF_EPS 0.0016 / RENDER 320×240 / rd = normalize(uv.x·right + uv.y·up +
1.4·fwd)`), run under `flox activate -- node`. **Not the GPU.**

```
A slice recompute @iters=20: 11.962 ms   @iters=16: 9.852 ms   (256x64=16384 DE calls)
B PICTURE vs declared DETAIL (96x72 rays):
  detail= 4 delivered=4 hits=6579/6912 pxDiffVs16=3 max|dt|=3.14e-1
  detail= 8 delivered=8 hits=6576/6912 pxDiffVs16=0 max|dt|=0.00e+0
  detail=12 delivered=12 hits=6576/6912 pxDiffVs16=0 max|dt|=0.00e+0
  detail=15 delivered=15 hits=6576/6912 pxDiffVs16=0 max|dt|=0.00e+0
  detail=16 delivered=16 hits=6576/6912 pxDiffVs16=0 max|dt|=0.00e+0
  detail=17 delivered=16 hits=6576/6912 pxDiffVs16=0 max|dt|=0.00e+0
  detail=20 delivered=16 hits=6576/6912 pxDiffVs16=0 max|dt|=0.00e+0
  detail=24 delivered=16 hits=6576/6912 pxDiffVs16=0 max|dt|=0.00e+0
  detail=30 delivered=16 hits=6576/6912 pxDiffVs16=0 max|dt|=0.00e+0
B AUDIO slice max|delta| vs iters=16:  iters=17 9.741e-4  iters=20 3.401e-4  iters=30 6.048e-4
C centre ray: zoom=0.30 hit=false  zoom=3.0 hit=true  threshold zoom=0.3415 (eyeDist=6.4419)
  zoom=0.30 eyeDist=7.333 hits=0/3072 sky=100.0%
  zoom=0.31 eyeDist=7.097 hits=0/3072 sky=100.0%
  zoom=0.32 eyeDist=6.875 hits=0/3072 sky=100.0%
  zoom=0.33 eyeDist=6.667 hits=0/3072 sky=100.0%
  zoom=0.34 eyeDist=6.471 hits=0/3072 sky=100.0%
  zoom=0.35 eyeDist=6.286 hits=311/3072 sky=89.9%
  zoom=0.36 eyeDist=6.111 hits=391/3072 sky=87.3%
  zoom=0.40 eyeDist=5.500 hits=523/3072 sky=83.0%
  zoom=0.50 eyeDist=4.400 hits=835/3072 sky=72.8%
D autospin: AUTOSPIN_RATE=0.25 rad/s -> one revolution = 25.13 s
```

**Instrument validation, stated because a wrong metric reads exactly like a
finding:**

- The DETAIL rows are **negative-controlled by their own first line**:
  `detail = 4` DOES differ (3 px, max &#124;Δt&#124; 0.314), so the instrument can move.
  If it could not, the zeros below would prove nothing.
- The ZOOM bisection and the frame sweep are **two independent instruments**
  agreeing (0.3415 vs the 0.34→0.35 step where hits go 0 → 311).
- Both are float64; GLSL runs `highp` float32. Treat bit-equality as an algebra
  result and re-measure on the GPU before quoting it as a pixel claim.
- The slice-cost figure is single-threaded node on a developer Mac. **Re-measure
  in the browser before quoting it in a PR body**, and expect CI's software
  renderer to be worse, not better.
