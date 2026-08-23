# Cut B — the "screen-panel" faces, re-derived

Written 2026-08-23 against `main` at `7cc78f0e5`. **Evidence, not instruction.**
Every claim is a read site you can open.

Assigned: `spectrograph`, `scope`, `vfpgaRunner`, `synesthesia` — the four modules
Cut B describes as needing "a registered panel" for their displays.

## The headline: the cut's own name is wrong

**Not one of these four wants a registered `panel`.** Three want a
`fullViewBody`, and the fourth wants something the cut does not describe at all.

The discriminator is mechanical, not aesthetic, and it is already written in the
tree (`shell-cells.ts:462-472`, on wavecel):

> a **PANEL** is right when the picture is **DERIVED** — from params and
> `node.data`, with no analyser. A **BODY** is right when the surface carries a
> **per-frame engine read** and has no natural probe.

| module | its display reads… | verdict |
|---|---|---|
| `spectrograph` | `getVideoSource(nodeId,port).drawFrame()` each rAF | **BODY** |
| `scope` | `read('snapshot')` each meter frame | **BODY** |
| `synesthesia` | `read('snapshot')` each rAF | **BODY** |
| `vfpgaRunner` | *(see §5 — the display is not the problem)* | **BODY + new cells** |

This is the same class of error as last batch's dockscope note ("the trace IS the
`scope` glyph"): a plausible mechanism named without checking which seam actually
reaches the data.

### ⚠ For `synesthesia` a panel is not merely wrong, it is impossible

`ShellPanelCell` **requires** an operability probe — `ShellPanelProbe`
(`shell-cells.ts:241-275`): a testid inside the panel, a `click`/`drag` action,
and an observable effect. `faces-parity` drives every one of them.

Synesthesia's two VU canvases have **no pointer handlers, no `role`, no
`tabindex`**, and write nothing. There is no interaction to probe, so the type
cannot be satisfied honestly. (Read-only panels do exist — `sidecar` — but
sidecar's probe is a pointer-driven cursor readout. A VU meter has nothing to
drive.)

---

## 1. What a PANEL actually costs, for the record

Because the cut assumed panels, here is what one would have required — four
artifacts, all mandatory:

1. a `controlFamilies` entry with `kind: 'cell'` on the def;
2. the family's template key ranked in `face.order` **and** placed on a page;
3. a spec in `SHELL_CELLS` keyed `moduleType → exact face.order key`, with a
   static component import;
4. an **operability probe**.

Plus two hard rules: a panel must **never** emit
`data-testid="control-<paramId>"`, and it is **dock-only by lint** —
`module-face-lint.test.ts:1633-1661` fails a panel *selected* at any lane tier,
so a non-hero panel must rank **7 or later** (past the `full` cap of 6), while a
`face.hero.cell` panel takes no lane rank at all and may rank first.

A `fullViewBody` by contrast has **no rank, no page, no cell and no probe**. It
is dock-only by `dockFullViewHeadPlan` and takes the place of the hero glyph.

⚠ **One gap found and not fixed here.** `EXTENSION_BODY_ROLES` covers every
`fullViewBody` deny-by-default, role-verified, with a required `why`. **Panels
have no text-role roster at all** — and the shipped ones *do* paint derived DOM
text at rest (`AnalogVcoHeroPanel`'s `… · 12.4 ms` axis; sidecar's cursor level).
No gate sees it. This batch adds no panels, so it is logged rather than fixed —
but it is a rule enforced on one surface and not its sibling, the same shape as
the joystick zero-lane finding.

---

## 2. `spectrograph` — the cheapest face left in the fleet

**1 param** (`gain`, log 0.25-4), 1 audio in, 2 mono-video out. One `Knob`, **no
`NeonFader`**. **Zero readouts to delete** — the only resting text is a static
axis legend and a state NAME. Not a card-producer. Not in the attest basis.

- **Display**: the waterfall accumulator lives in the module **factory closure**
  (`spectrograph.ts:148-239`) and is reachable only through
  `videoSources.get(port).drawFrame`. A body mounts a canvas and calls it —
  about five lines. ⚠ **Do not re-implement the scroll**: it is per-node closure
  state and a second copy would advance at a different rate. The 16 ms
  time-gate (`:151-154`) already makes a third caller idempotent within a frame.
- **Determinism is free**: `__spectrographVrtFreeze` lives **in the module**
  (`spectrograph.ts:60-64`), so any surface inherits it. Contrast scope below.
- ⚠ **The one real cost is parity.** The COLOR/B-W toggle is **local card state**
  (`SpectrographCard.svelte:32`), not a param. Functional parity is a hard
  requirement, so it must survive promotion — which means a **new `ParamDef`**,
  i.e. a contract change and a `docs:accept` diff. (Both video outputs always
  render both colormaps; the toggle only picks which port the preview pulls, so
  the param is display-only and costs the engine nothing.)
- Boy-scout: the card re-types `0.25`/`4`/`1` as numeric literals and is not in
  `RANGE_BOUND_CARDS`.

---

## 3. `scope` — two channels, a producer seam, and a feature that must not vanish

**9 params, 11 in, 3 out**, `vizPassthrough: true`. **Six `NeonFader`s** plus
three header buttons. Draw logic is already pure — `drawScope(ctx2d, snap,
params, w, h)` in `scope-draw.ts` — so a body reuses it exactly as
`DockscopeOutputBody` reuses `drawDockscope`.

- **The display genuinely needs TWO channels.** `drawSplit` paints ch1 and ch2;
  `drawXY` plots ch1 against ch2. ⚠ And there are **four** draw branches, not
  two: `isDefaultIntensity(0.5)` short-circuits to a legacy path
  (`scope-draw.ts:220-225`) that **every committed baseline depends on**.
- ⚠ **`glyph: 'scope'` would resolve LIVE here, unlike dockscope** — scope
  declares `ch1_out` as an audio output. It would still be wrong: it paints the
  **ch1 passthrough**, not the module's own dual-trace/XY render. Right answer,
  different reason. Do not reuse dockscope's ruling verbatim.
- ⚠ **THE PARITY PROBLEM OF THIS BATCH.** `ScopeCard.svelte:275-293` carries a
  **YIN pitch tuner** — Hz, note name, and a cents meter — fed by `read('pitch')`
  → `detectPitch`. It is the module's only surface for that feature and it has
  dedicated coverage (`e2e/tests/scope-tuner.spec.ts`, `art/scenarios/scope-tuner`).
  Dropping it orphans a real feature whose tests then assert arithmetic nothing
  displays.
  - The no-resting-text ruling does **not** cover it: that rule is about a
    decimal **restating a dial**. The tuner restates nothing — it is an
    independent measurement, structurally scoreboard's digits ("the OUTPUT
    PICTURE, not a readout of a control"), not a knob's value.
  - `status-primitive` is **unavailable**: its predicate is `StatusLed && NO
    <canvas>` and this body needs a canvas for the trace.
  - **Resolution: paint it INTO the canvas**, the shape the fleet has already
    settled on three times (graphicEq's meters, dockscope's `±1.0`/`±5V`,
    scoreboard's digits). `drawScope` is the pure function to extend. ⚠ Only the
    dock VRT baseline can see it — the acknowledged blind spot, stated rather
    than hidden.
- **Card-producer**, and the constraint is sharp: `ScopeCard.svelte:148-153`
  pushes `write(node,'cvCombined')`, and `CARD_PRODUCER_LANE_TYPES` membership is
  **DERIVED** by walking that card's `.svelte` imports. **Move the push and scope
  drops out of the set AND `needsHeadlessSourceMount` returns false**, un-mounting
  the only producer. The card stays; the face is additive.
  - What breaks without it is a **stuck value, not darkness**: `cv-shadow`'s
    `combined` is cleared only by a knob move, so a CV-driven param latches at
    its last modulated value.
- ⚠ `data-viz-passthrough="scope"` on the canvas is load-bearing — GroupCard
  `appendChild`-moves that exact element, and scope is the sole member of
  `GROUP_VIZ_HOST_TYPES`. A face must not mount a second element carrying it.
- **Determinism is NOT free**: `__scopeVrtSeed` lives in the **card**, so the
  body must read the same global (the `DockscopeOutputBody` lesson — a different
  global leaves the face unbaselinable while the card stays pinned).
- **Rosters**: `mode`, `ch1Range`, `ch2Range` are all `0..1 discrete` with **no
  `options`**; the names live only in card markup. `ch1Range`/`ch2Range` are the
  *same switch with the same threshold and the same two names* as
  `dockscope.range` — promote them identically so the two cannot drift. For
  `mode`, state 0 has no name in code (`⇆` is a glyph); the def comment and docs
  both say "split (two stacked traces)".
  ⚠ Note `drawSplit` does **not** actually split — both traces share the `h/2`
  mid-line and overlay unless offset. Do not let a name imply two lanes.
- **All three switches LATCHING**, verified at read sites; no edge detector
  anywhere in the module or its draw core.
- ⚠ **Live defect**: `toggleXY` (`ScopeCard.svelte:70-73`) writes the bare Yjs
  proxy instead of `setNodeParam`, so it carries no `LOCAL_ORIGIN` and **is not
  undoable**, while `toggleRange` on the same card is. One-line fix.
- Boy-scout: `scope.intensity` has no `PORT_DESCRIPTIONS` entry.

---

## 4. `synesthesia` — 22 params, two copies, and a dead half-knob ×8

**22 / 4 / 48**, all three counts confirmed against the def *and*
`contract-lock.txt`. **No `NeonFader`** — every rotary is a `Knob`, so
**`paramCells` declares nothing** (knob is the default).

- **Control census: 3 primitive types, 4 semantic roles.** 4 two-state toggles
  (`a_mode`/`b_mode`/`a_bipolar`/`b_bipolar`), 2 midpoint-unity masters
  (0.5-1.5), 8 floor-unity gains (1-2), 8 midpoint-unity depths (0-2). **Zero
  multi-state selectors, zero colour params.**
- **The honest page axis is COPY A / COPY B.** The card, the PatchPanel
  `sections` and the docs all already partition it that way, and the two copies
  are genuinely independent in the worklet. A role axis (levels / depth / mode)
  is also real. Neither is padded — which matters, because the tabbed-face
  direction forbids padding pages to force a rail.
- **Displays**: two `<canvas>` painting four 10-segment VU columns via
  `drawVuMeters` — already pure and extracted (`synesthesia-draw.ts`), fed by
  `read('snapshot')`. The history is a worklet-side `MeterBallistics` (10 ms
  attack / 300 ms release), so **a face inherits the ballistics and adds no
  state of its own**.
- ⚠ **Live defect, backdraft class.** The eight ENV-DEPTH knobs pass `max={4}`
  on the card while the def, `contract-lock.txt` **and** the worklet's
  `parameterDescriptors` all say `0..2`. The AudioParam clamps at 2, so **the top
  half of eight knobs is dead travel.** Not in `RANGE_BOUND_CARDS`, so no gate
  sees it. A stale `0..4` comment at `packages/dsp/src/synesthesia.ts:28`
  contradicts `:163-166` in the same file.
- ⚠ **Two more re-typed constants**: the band captions `20–200 / 200–1k / 1k–4k /
  4k+` are hand-typed in the card while `SYN_BAND_EDGES` is exported, and
  `R/G/B/L` is re-typed while `SYN_VIDEO_CHANNELS` is exported. And those
  captions **flip with mode** — they are the only thing on the surface saying
  what lane 3 currently means, so they are load-bearing disambiguation.
- **Card-producer**: the card samples the two video inputs and pushes
  `write(node,'video_levels_a'/'_b')` — **the only writer of what the AUDIO
  outputs carry in VIDEO mode**. Without it, 24 outputs per copy go dead.
  ⚠ And the producer rAF **early-returns unless a canvas is bound**
  (`SynesthesiaCard.svelte:179-181`) — display and data path are coupled by that
  one guard.
- **4 `ACKNOWLEDGED_LATCHING` entries required** at promotion; all four verified
  LATCHING at the worklet read site, none edge-detected, none CV-targeted.
- **Rosters**: `AUDIO`/`VIDEO` and `UNI`/`BI` exist only in card markup. Adding
  them is a ParamDef change (contract-lock moves) and turns those cells into dock
  Segmented pairs — the `cofefve` precedent.
- **48 outputs are a SOLVED problem**: synesthesia is already the registry's
  fixture for the mixed-rail split (`rear-card-model.test.ts:814-834`), and
  `expectTotal` passes for it **today**, outside `STRICT_FACES`. Rely on the
  automatic derivation; an explicit `face.rear` buys nothing and costs two more
  gate clauses. ⚠ Do **not** name a page `signal` — that is the leading input
  band's id, and a collision renders the band twice (the dx7 double-band scar).
- **Baselinable**: the face harness freezes the AudioContext by default, the same
  lever the card scene uses. No `FACES_WITHOUT_SCENES` entry needed.

---

## 5. `vfpgaRunner` — the one the cut mis-describes, and it is not about panels

**16 params, 12 in, 2 out** — counts confirmed. But **every param is generated by
`.map()`**: `p1..p8`, `cv1_val..cv4_val`, `g1_evt..g4_evt`, all identical
`0..1 linear default=0`.

### The real problem is the manifest, and it is a parity regression

"The manifest" is the loaded `VfpgaSpec`'s `params`/`cvRoles`/`gateRoles`. The
card is **manifest-driven** and says so in its own header. Measured across the 8
shipped specs:

- **`p1` carries EIGHT different labels** (`phase` / `xor-mask` / `feedback` /
  `mosh` / `deint` / `BRIGHT` / `h-jit` / `rate`) and ranges from `0..1` to
  `0.5..1.0` to `0..0.2` to **`0..65535`**.
- **8 of the 16 def params are permanently dead** in the shipped catalog —
  `p6`,`p7`,`p8`, `cv3`,`cv4`, `g2`,`g3`,`g4` are used by zero specs.

So the note's "rank the def-declared params, not the manifest" is **forced, not
stylistic** — a ParamDef is static and the label/range are per-preset. But it is
also **insufficient guidance**: a generic face ranking them paints **eight
identical `0..1` dials labelled `P1`…`P8`, five of which nothing uses**, against
a card showing 2-5 correctly named and ranged knobs. Under the hard parity rule
that is a regression, not a trade-off.

**The fix is manifest-aware cells in `shell-cells.ts` that resolve label and
range from the live spec at render time** — and that resolution happens outside
the attest basis, so it is free. This is the work the cut does not describe.

### Other findings

- ⚠ **The preset `<select>` is `node.data.vfpga`, not a param** — and its
  `onchange` does **two** things: `setVfpgaSpec(...)` **and** a synthetic
  `setParam(id,'__reloadVfpga',1)` pulse. **Without the pulse the Y.Doc write
  lands and the GL pipeline never rebuilds** — preset switching is silently
  dead. Any face selector must replicate the pair.
- The roster does **not** force an `options` array: `face.order` admits **static
  control keys**, resolved through `SHELL_CELLS` with their own live state and
  actions. **`milkdrop` is the exact precedent** (`milkdropPresetOptions` /
  `selectMilkdropPreset`). Zero attest.
- The **fabric floorplan** is pure, read-only, Canvas2D, and **provably
  deterministic** (no `Math.random`/`Date.now`/`performance.now`/rAF anywhere in
  its model or draw). Its toggle is component-local `$state` — **lost on every
  unmount**; per the SCREEN ruling it should move to `node.data`.
- Per-preset, **g1 is a level-held GATE on 3 specs and a rising-edge TRIGGER on
  4**, which is why the port declares `edge: 'gate'` as the never-lying superset.
  A face cannot statically label it either way.
- `noUserControl` is owed for the 8 synthetic cv/gate params — the def's own docs
  say "no knob" for all eight, and without the declaration a generic face ranks
  and paints them.
- **Not a card-producer** (verified: no `attachExternalSource`, no
  `write(node,…)` beyond the discrete reload pulse).
- **VRT**: fully exempt today — but ⚠ the exemption's own words are *"VRT
  baseline **pending**"* and *"in a follow-up PR"*, i.e. **un-captured, not
  unbaselinable**. A face need not inherit "permanently exempt". The default
  preset `smpte-bars` is a 0-input pure pattern generator at rest, so a face may
  well baseline — **that must be measured, not asserted**. The CV scopes are the
  residual risk (a 64-sample ring filling from boot).
  ⚠ The module has **no `freeze` param**, so `freezeIsNotASeam` is *forbidden* on
  any `UnbaselinableFace` entry, and `freezeFaceVideo`'s write is a no-op.
- Two stale docs claims to boy-scout: the def says it "declares the
  off-main-thread worker render locus" (it does not — `renderLocus` was removed),
  and `module-manifest.ts` says "ships ONE VFPGA" (8 ship).

---

## 6. ATTEST — zero for all four, verified against the basis list

`resolveWebglBasis()` admits exactly: the whole `lib/video/**` (minus tests), any
`lib/ui/modules/**.svelte` **whose source greps as creating a WebGL context**,
the two `rendersWebGL` audio defs (`cube.ts`, `wavesculpt.ts`), and the
toolchain pins. Measured: **218 files, of which 45 are vfpga.**

- `spectrograph`, `scope`, `synesthesia`: audio defs, outside all four sweeps.
  **Their `options` rosters and even a new ParamDef cost nothing.**
- `vfpgaRunner`: **in** the basis — but `HASH_TRANSPARENT_PROPS` is exactly
  `docs`, `controlFamilies`, `face`, `noUserControl`, stripped when direct
  members of a module-scope object literal. Its def is exactly that shape, and
  **`paramCells` rides free because it is nested inside `face`**. Every change
  the face needs is hash-transparent.

⚠ **THREE WAYS THIS TURNS INTO AN ATTEST — all avoidable, all easy to trip:**

1. **Putting any new file under `packages/web/src/lib/video/`.** The walk is
   whole-directory. Face code goes under `lib/ui/`.
2. **A real WebGL context in a `lib/ui/modules/**.svelte`.** The grep pulls that
   file into the basis *permanently*, and every later edit then needs a real-GPU
   re-attest CI cannot run. Copy the card's Canvas2D blit of `engine.canvas`.
3. ⚠ **Editing any `specs/*.ts` prose.** All 8 spec files are basis members and
   `VfpgaSpec.doc` is **not** hash-transparent — **a one-word edit to a spec's
   `doc` string costs a full GPU re-attest.** This is the trap for a PR that
   tidies preset descriptions along the way.

**So there is no attest line to split on.** Verify with
`webgl:attest:check` before and after regardless.

---

## 7. BATCHING — split 3 + 1, and NOT on the attest line

Since all four are zero-attest, the attest line is not a seam. The real seam is
**what platform surface each face needs**:

**Batch B1 — `spectrograph`, `scope`, `synesthesia`.** All three need exactly one
thing: a `fullViewBody`. That is a wired, established pattern with two fresh
precedents (dockscope last batch, graphicEq the batch before). They share one
shape, one roles-roster block, one review argument. Their differences (a new
ParamDef for spectrograph's B/W; rosters and the tuner for scope; rosters and
latching entries for synesthesia) are per-module authoring, not new platform
surface.

**Batch B2 — `vfpgaRunner` alone.** It needs **new manifest-aware cell specs in
`shell-cells.ts`** — a shared registry file, new live-state actions, and a
selector that must replicate the `__reloadVfpga` pulse. That is a different kind
of work, a different conflict surface, and it carries the only open VRT question
in the cut (measure whether the face baselines rather than inheriting the card's
"pending" exemption). Bundling it with three body-shaped faces would put the
riskiest change behind the same review as the cheapest one.

⚠ Two of B1's three are **card-producers with DERIVED membership**, so the
gating constraint on that batch is "the card survives and keeps its `eng.write`
seam" — worth stating once, at batch level, rather than three times.

## 8. Things checked so nobody re-checks them

- **No panel anywhere in this cut**, and for synesthesia a panel is structurally
  impossible (no probe is satisfiable).
- **Neither `scope` nor `spectrograph` is VRT-exempt or masked** — both are fully
  pixel-gated, and scope's scene comment says so deliberately: *"The canvas stays
  fully inside the pixel diff; this is a fix, not a mask."* Reach for a seam, not
  a mask.
- **`vfpgaRunner` creates no WebGL context in any card file** — every one is
  `getContext('2d')`. Load-bearing for the attest answer.
- **Three live defects found**, all folding into their face PRs: scope's
  non-undoable `toggleXY`; synesthesia's 8 knobs of dead travel; and the two
  stale vfpgaRunner docs claims. Plus boy-scouts: `scope.intensity`'s missing
  port description, and three sets of re-typed constants that have exported
  sources.
