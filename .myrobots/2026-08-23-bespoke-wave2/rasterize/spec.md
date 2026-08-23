# FACE SPEC — `rasterize` (audio → picture): THE LANE-GLYPH DECISION, AND THE AUDIT

> **SPEC + MOCKS. Nothing here is implemented.** Same bar and same figure labels as the
> rest of this wave — `DERIVED-BY-READING` · `MEASURED` · `MUST-VERIFY`.
>
> **Mocks:** `lane-decision.html` · `dock-audit.html` (open in a browser; self-contained).

---

## ⚠ 0. THE BRIEF'S PREMISE IS STALE, AND THIS IS THE FIRST FINDING

This lane was commissioned to produce "a dx7-grade spec package" for three
card-drawn-picture modules, on the understanding that all three were unfaced.

**`rasterize` HAS BEEN FACED SINCE #2001 (merged as #2018, `7eeccfb30`).** MEASURED:

```
$ flox activate -- git log --oneline -1 -- packages/web/src/lib/audio/modules/rasterize.ts
7eeccfb30 feat(faces): rasterize — the shell has NO route to an audio module's PICTURE …
```

* `rasterizeDef.face` is declared at `rasterize.ts:208-223`.
* `'rasterize'` is in `STRICT_FACES` (`strict-faces.ts:2310`) with a long argued entry
  at `:2233`-ish.
* `rasterize/shell-extension.ts` and `rasterize/RasterizeOutputBody.svelte` ship.
* `rasterize-face-model.test.ts` pins it across ten `describe` blocks.
* Two dock baselines exist: **`face-rasterize-dock.png` 546 × 681** and
  **`face-rasterize-compact.png` 88 × 82** (MEASURED off the committed PNG headers).
* `face-migration-inventory.ts:418-434` records `DONE (#2001)`.

So a promote/blocked verdict for this module would be answering a question that was
settled three weeks ago. **This package therefore delivers the question that is still
open, and it is exactly the one the brief asked for:**

> **#2160 landed on `main` yesterday and made a lane-tile picture EXPRESSIBLE for the
> first time. `rasterize` declares `glyph: 'none'` with an argument written BEFORE that
> widening existed. Does the new information change the answer?**

That re-decision is §2. The rest is an audit of the shipped face against the four
faceplate rulings and against gates that have arrived since it merged (§3-§4), plus its
live defect ledger (§5).

**Verdict, up front: the lane-tile picture is REFUSED AGAIN, on a NEW and STRONGER
argument than the one in the def today — and the def's comment is now factually wrong
about why, so it must be rewritten rather than left alone.** Total remaining work
≈ 4 h in one PR, plus one platform PR that is not this module's to carry (§4.2).

---

## 1. WHAT THE MODULE IS FOR (re-derived, not transcribed)

RASTERIZE is the **audio→picture bridge**, and the emphasis belongs on *bridge*: it is
the only module in the rack that treats an audio buffer as a framebuffer with no
intervening analysis. Each video frame it takes a fixed run of samples and writes them
as **voltage-per-pixel in raster scan order** into the 1024 × 768 engine frame; a scan
cursor advances and wraps across frames. A steady tone therefore paints horizontal bands
whose spacing and drift track the audio frequency against the line rate — the faithful
analog scan-converter mapping, **not** an oscilloscope trace. `docs.explanation`
(`rasterize.ts:227`) says all of this and is accurate.

**The signal path** (`rasterize.ts:251-399`):

1. `in → inGain → thru`, with `inGain → analyser` (fftSize 2048) as a sink (`:254-261`).
   `thru` is `inGain` itself (`:416`) and nothing ever writes `inGain.gain` — **THRU is
   bit-exactly the input.** Load-bearing in §2.
2. Four CV shadows, one per param (`:278-283`), replacing a state in which all four ports
   published `inGain.gain` — the live passthrough — so a cable into SCAN multiplied the
   audio instead of moving the cursor (MEASURED there: `3.146e+5` peak against a `5.0e-1`
   baseline).
3. `advanceOncePerFrame()` (`:369-392`) coalesces the bridge's `drawFrame` and the
   card/body's `read('imageData')` onto one 8 ms guard, freezes while the AudioContext is
   suspended, and short-circuits under `__rasterizeVrtSeed`.
4. `RasterPainter.paint()` (`rasterize-draw.ts:94-126`) does the mapping into a persistent
   RGBA framebuffer that both surfaces share.

**THE MEASUREMENT THIS MODULE IS BUILT AROUND**, and it is already pinned: at the frame
boundary, CLAMP discards 700 of an 800-sample run where WRAP paints all 800 and continues
toroidally (`rasterize.ts:108-110`). The two `wrap` states are the module's two looks.

---

## 2. THE LANE-GLYPH RE-DECISION

### 2.1 What #2160 actually changed

`shell-glyph-live.ts:105` is now
`{ kind: 'algorithm'; layoutSource: string; paramId: string | null }`, and the resolver
gained an EXTENSION arm at `:156-159`:

```ts
const ext = def?.face?.extension;
if (typeof ext === 'string' && ext.length > 0) {
  return { kind: 'algorithm', layoutSource: ext, paramId: null };
}
```

`rasterize` already declares `extension: 'rasterize'`. **So flipping `glyph: 'none'` to
`glyph: 'algorithm'` today resolves a LIVE-kind binding, passes the dead-glyph clause,
and puts a picture in the lane tile.** It is one word. That is why the question has to be
answered rather than inherited.

### 2.2 REFUSED. Four measured reasons, and none of them is the one in the def today

**(a) A layout-source glyph has NO INPUT. It is a constant.**
`ModuleShell.svelte:456-465` ends `if (b.paramId === null) return 0;` — `topologyValue`
is hardcoded `0` for every node in every rack, forever. `:473` returns `''` for the
caption. And `ShellExtensionGlyphProps` (`shell-extensions.ts:44-51`) is
`{ num, numbers?, testid? }` — **no `nodeId`, no engine, no store**, in deliberate
contrast to `ShellExtensionFullViewBodyProps`, which is `{ nodeId }` (`:57-59`).

DERIVED-BY-READING: **a `rasterize` lane glyph could not show the raster.** It could not
show the cursor, the bands, the gain, the wrap mode, or anything that distinguishes one
`rasterize` node from another. It could only be a fixed diagram of the idea "audio goes in,
a frame comes out" — which the module's NAME already says, in the same tile, one row above.

**(b) It would not hold its ground even as decoration.**
`laneGlyphFor` (`module-shell-model.ts:237-240`) returns `'trace'` for any non-`'none'`
glyph on a non-video def, and `'trace'` **yields to ranked cells** in `laneBodyPlan`. Only
`'picture'` outranks cells, and `'picture'` is gated on `hasVideoSurface(def)` ≡
`domain === 'video'` — which this module is not and cannot become without a domain change.
So the constant diagram would be dropped by the lane precisely when the tile is busy.
MEASURED context: the compact tile is **88 × 82** and carries three cells; there is no
room being wasted for a glyph to fill.

**(c) It costs a component, a slot and a gate row, for that.**
`shell-extensions.test.ts:102-117` requires that any def declaring `glyph: 'algorithm'`
resolve an extension exporting a `glyph` slot. `rasterize/shell-extension.ts:34-36`
exports `{ fullViewBody }` only, so the flip alone reddens with
`rasterize: extension 'rasterize' loads without a glyph slot`. ⚠ **And the dead-glyph
clause would NOT catch it** — the binding resolves `algorithm`, which is live, not
`static`. Two different gates; only the second sees this.

**(d) The owner's compact ruling points the same way.** *"We do not want useless gray
horizontal space on cards, ever. Prefer compact. Screen real estate is expensive."* A
per-instance-identical SVG in a 88 × 82 tile is the definition of unearned space.

### 2.3 ⚠ SO THE DEF'S OWN COMMENT IS NOW WRONG, AND MUST BE REWRITTEN

`rasterize.ts:188-191` reads:

> *"The picture that IS this module is the raster frame; it is `mono-video` and **matches
> no glyph kind**, so it arrives at the dock through `fullViewBody`."*

**That sentence was true when it was written and is false today.** After #2160 there IS a
kind it matches — `algorithm` with `layoutSource: 'rasterize'` — and the reason to refuse
it changed from *"no kind fits"* to *"the kind that fits carries no data"*. Leaving the
old wording is the failure mode CLAUDE.md names about stale scoping claims: it produces
no failure, only absent work, and the next reader will re-derive the widening from
scratch and possibly reach the opposite conclusion because the recorded reason no longer
matches the tree.

**The rewrite** (the substance; wording is the build's):

```
// ⚠ `glyph: 'none'` IS A CHOICE, AND SINCE #2160 IT IS A CHOICE BETWEEN TWO LEGAL
// OPTIONS RATHER THAN A REFUSAL. Both were evaluated:
//
//   * 'scope'/'meter'/'waveform' → {kind:'live-audio', portId:'thru'}. LIVE, green on
//     every gate, and BLIND: `thru` is `inGain`, bit-exactly this module's input, so the
//     trace is invariant to all four controls. (The original argument; still correct.)
//   * 'algorithm' + extension  → {kind:'algorithm', layoutSource:'rasterize',
//     paramId:null}. Also live-kind, also green — and CONSTANT: ModuleShell.svelte:462
//     hardcodes topologyValue to 0 when paramId is null, and ShellExtensionGlyphProps
//     carries no nodeId, so the picture cannot vary per node or over time. It would also
//     rank 'trace' (module-shell-model.ts:237-240) and yield to the three ranked cells
//     the compact tile already shows.
//
// Neither is a picture OF THIS MODULE. The raster reaches the dock through
// `fullViewBody`; the lane tile shows controls, which is strictly more than the
// placeholder an un-promoted module shows.
```

### 2.4 The general form, stated once for the wave

> **After #2160, a layout-source glyph is a CONSTANT PICTURE.** The widening removed a
> refusal; it did not add a data path — its own doc-comment says so
> (`shell-glyph-live.ts:101-103`). Until `ShellExtensionGlyphProps` carries a `nodeId`,
> no module in the five-module cohort gains an informative lane picture from it, and
> `rasterize` is the cohort member where that is easiest to check because it is the only
> one already faced.

**The escalation this raises is `scope`'s, not this module's** — see
`../scope/spec.md` §12.3. Recorded here because rasterize is where the widening's first
plausible adopter sat.

---

## 3. AUDIT — the shipped face against the four rulings

| ruling | verdict | evidence |
|---|---|---|
| **no resting derived-state text** | **PASS, and it is a correctness win** | the face paints no readout; `rasterize.ts:160-166` argues that a SCAN readout would have shipped a number wrong by construction (§5.3) |
| **a caption earns its place** | **PASS** | four params, four distinct captions under one unlabelled band; `bareCells` correctly undeclared (mixmstrs is still the only declarer) |
| **compact is the default; width must be EARNED** | **PASS, MEASURED** | `face-rasterize-dock.png` is **546 × 681** against the old 900 px floor. The earner is the 480 × 360 live raster — one of the ruling's own named examples. `FACE_WIDTH_EXEMPTIONS` has one entry and it is not this module |
| **every video card gets SCREEN ON/OFF** | **PASS in substance, UNGATED in fact** | `RasterizeOutputBody.svelte:129-137` — see §4 |

### 3.1 The face is more thoroughly gated than most

`rasterize-face-model.test.ts` already carries the legs this wave would otherwise have to
propose: a NEGATIVE CONTROL asserting that a `scope` glyph **binds LIVE rather than
falling to static** (`:69`), a POSITIVE CONTROL that `hasVideoSurface` is true for a
real video def (`:100`), the SCAN-ranks-last inversion (`:117-130`), the WRAP roster
anchored to reachable values with a *names-not-numbers* negative control (`:220-243`),
and — unusually — an explicit acknowledgement that the **Push 2 card moved GENERIC →
FACE** and that this was accepted deliberately (`:140-158`).

That last one is worth calling out as fleet practice: `push-card-config.ts:23-27` makes
the FACE tier tier 2, so authoring a face silently re-ranks a module's Push encoders.
`rasterize` is the module that wrote the observation down instead of discovering it.

### 3.2 What the shipped body gets right that the rest of this wave must copy

* **State on the NODE, never `$state`** (`:47-55`) — this component unmounts on dock
  collapse and LRU eviction (#1531/#1574/#1583), so `previewCollapsed` lives on
  `node.data`. Absent ⇒ false ⇒ ON, so existing racks open unchanged.
* **The switch OVERLAYS the picture** (`:147-151`) — stacking it below cost ~18.8 px
  against ~11 px of slack and reddened `io-spec-consistency`'s card sweep. The body is
  exactly the height the picture is.
* **PUSH THEN READ** (`:64-86`) — `readParam` → `write('cvCombined')` → `read('imageData')`,
  because the painter runs inside the read.
* **The collapse skips the BLIT and never the ADVANCE** (`:79-83`) — this module's
  producer is PULL-DRIVEN, so stopping the loop would freeze the module itself.

⚠ **That last one is an EXEMPTION WITH A REASON, not a pattern.** It is why this body uses
a raw `requestAnimationFrame` where `dockscope`'s uses `onMeterFrame`. A sibling copying
the rAF without the pull-driven inversion ships an ungated full-canvas redraw. Stated
here because two more bodies in this wave will be written from this file (`scope` §3.2,
`wavesculpt` §6).

---

## 4. THE ONE GATE HOLE, MEASURED

### 4.1 The SCREEN switch is compliant and nothing certifies it

`video-face-screen-source.test.ts:71-76`:

```ts
function facedVideoTypes(): string[] {
  return listVideoModuleDefs()
    .filter((d) => STRICT_FACES.has(d.type))
    .map((d) => d.type).sort();
}
```

**`rasterize` is `domain: 'audio'`. It is not in `listVideoModuleDefs()`. It is out of the
gate's subject BY CONSTRUCTION.** DERIVED-BY-READING, and verified against the gate's
other legs: `NO_SCREEN_SWITCH` holds exactly one entry (`videoOut`), anchored in both
directions with a `why.length >= 40` check — a careful, deny-by-default gate that simply
cannot see this module.

So `rasterize` ships the fleet-standard switch, correctly built, and **a future edit
deleting `rasterize-face-screen-toggle` goes green.** This is the blind-gate shape
CLAUDE.md asks to be hunted: *would its green run look any different if the answer were
"everything"?* — for the audio-domain half of the population, no.

### 4.2 The fix exists, is mechanical, and is NOT this module's PR

`face-rack-status-source.test.ts:106-115` already carries the domain-blind population:

```ts
function extensionsWithBody(): string[] {
  return readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name)
    .filter((id) => { const f = resolve(MODULES_DIR, id, 'shell-extension.ts');
                      return existsSync(f) && /fullViewBody:/.test(read(f)); })
    .sort();
}
```

Read off the DIRECTORY — *"there is no list to go stale"*. Re-pointing
`video-face-screen-source`'s subject at that predicate would cover every body regardless
of domain.

⚠ **It cannot ride a face PR, and the reason is the same one that makes it worth doing.**
`extensionsWithBody()` includes audio-domain bodies that legitimately have no switch —
`dockscope`'s body argues its absence explicitly (it inherits `videoOut`'s "the preview
IS the module" reasoning), and `samsloop`'s roster entry at
`face-rack-status-source.test.ts:198` records the identical derivation. Widening the
sweep therefore reddens correct modules until each gets a named `(type, why)` exemption.
**That is its own PR**, and it must add exemptions with real reasons rather than a
domain filter — a filter would re-create the hole one layer down.

MUST-VERIFY for whoever takes it: run the widened predicate and enumerate exactly which
bodies redden before writing a single exemption, so the list is measured rather than
guessed.

---

## 5. DEFECT LEDGER

Five, each with evidence and a routing call. **None is fixed in this docs PR.**

### 5.1 THE LEDGERED `wrap` DEBT IS STILL OUTSTANDING, AND THE FACE DID NOT PAY IT — P2

`RasterizeCard.svelte:53-56`:

```ts
function toggleWrap() {
  const target = patch.nodes[id];
  if (target) target.params.wrap = wrap ? 0 : 1;
}
```

`setNodeParam` (`mutate.ts:106-119`) wraps its write in
`ydoc.transact(fn, LOCAL_ORIGIN)` and its doc-comment calls itself *"equivalent to the
bare proxy assignment but tagged so it lands on the undo stack"*. `store.ts:70` configures
`trackedOrigins: new Set([LOCAL_ORIGIN])`. A bare assignment runs with origin `null`, so
the flip is neither undoable nor origin-tagged for collaborators, while the three faders
beside it are both.

⚠ **NOT A NEW FINDING — it is a named entry**, `raw-write-ledger.ts:279-283`:

```ts
'ui/modules/RasterizeCard.svelte': {
  keys: ['wrap'], kind: 'debt',
  why: 'card button write — user gesture, should be undoable + synced',
},
```

**The finding is that it SURVIVED THE PROMOTION, and that this was predictable.**
`raw-write-ledger.ts:202-210` records the general form, filed against a different module
but true of this one:

> *"#2025 argued the debt was 'paid by construction' by FACING the module … That is not
> what this ledger measures. It is keyed by CARD PATH and anchored to the source, and
> promotion does not delete the card — the per-card VRT sweep still renders it under
> `?shell=legacy`. … **A face does not pay a card's debt; editing the card does.**"*

So today the FACED `wrap` cell is correct and the LEGACY card's button is not, on the same
param, in the same module. **Route: the one-line payment plus the ledger deletion, in the
next PR that opens this card — which is §6's.** ⚠ Both halves or neither: deleting the
entry without editing the card is RED (stale exemption), and editing the card without
deleting the entry is RED too (the write no longer exists).

`GatemaidenCard` (queue Q53, `raw-write-ledger.ts:195-210`) and `JoystickCard` (Q43,
`:211-217`) are the two worked payments to copy.

### 5.2 The card's redraw is not visibility-gated — P3 (perf)

`RasterizeCard.svelte:61-87` drives its repaint with a bare `requestAnimationFrame`
chain. `ScopeCard.svelte:135` — the module rasterize's own header says its architecture
mirrors — uses `onMeterFrame`, which is IntersectionObserver-gated *"so it stops entirely
while the card is scrolled out of view"*.

So an off-screen `rasterize` card pays, every frame: four `readParam` calls, a
`write('cvCombined')`, `advanceOncePerFrame()`, a 786 432-pixel `ImageData` allocation
(`rasterize-draw.ts:128-130` constructs a fresh `ImageData` per call) and a
1024 × 768 → 480 × 360 `drawImage`. DERIVED-BY-READING.

⚠ **The BODY's exemption does not transfer to the CARD.** The body's raw rAF is justified
because it is the only thing advancing a pull-driven painter when nothing downstream is
patched (`RasterizeOutputBody.svelte:18-28`). The CARD is never the only advancer while
the body exists, and under `?shell=legacy` the same argument would apply — so the honest
fix is `onMeterFrame` on the card **with the same read-unconditionally / blit-conditionally
split the body uses**, not a straight swap. Route: fold into whichever PR next touches
the card.

### 5.3 SCAN is a change detector that cannot address its own unit — P2, OPEN (#2000)

Confirmed at the source. `rasterize-draw.ts:98-105`:

```ts
const startOffset = Math.floor(params.cursor);
if (startOffset !== this.lastStartOffset) {
  this.cursor = normalizeCursor(startOffset, total);
  this.lastStartOffset = startOffset;
}
```

Two consequences, both DERIVED-BY-READING:

* **Re-selecting a value the knob already displays is a NO-OP.** The running cursor keeps
  drifting, so the number the control shows and the position it names diverge permanently.
* **No gesture can move it by its declared unit.** `units: 'px'` over a
  `0 .. VIDEO_RES.width * VIDEO_RES.height` range; the finest (ctrl-drag) moves ~39 px of
  it. A control declared in pixels that cannot address a pixel.

The face already encodes this — SCAN ranks LAST, inverting declaration order, with a
pointer left deliberately (`rasterize.ts:209-218`) so the rank is re-decided rather than
fossilised. **The rank is a workaround for an open defect, and the def says so.** Route:
unchanged — #2000 is the owner's to decide; if it is fixed, the rank moves above `wrap`
and `rasterize-face-model.test.ts:117-130` is the test that must be re-pointed.

### 5.4 `read('cursor')` is a DEAD ENGINE SEAM — P3

`rasterize.ts:445-447` exposes `read('cursor')` → `painter.currentCursor`, and
`rasterize-draw.ts:84-87` documents the getter as *"Exposed for the card readout"*.

**MEASURED — that readout no longer exists and nothing consumes the seam:**

```
$ grep -rn "currentCursor" packages/web/src e2e
packages/web/src/lib/audio/modules/rasterize-draw.ts:85:  get currentCursor(): number {
packages/web/src/lib/audio/modules/rasterize.ts:446:          return painter.currentCursor;
```

Two hits: the definition and the one call site inside the definition's own module. No
card, no body, no test, no e2e. The consumer was the resting decimal deleted by the
2026-08-17 ruling.

⚠ **Do not delete it reflexively.** It is the only external read of the *running* cursor,
and it is exactly the observable a fix for #2000 would need to assert against ("the knob
says 1000, the cursor says 49 800"). Route: **keep, and re-point the comment** — replace
*"Exposed for the card readout"* with *"the only external read of the running cursor;
the observable a #2000 fix asserts against."* A dead seam with a stale reason is how a
future sweep deletes the thing a fix needs.

### 5.5 STALE RECORDS — P3, three of them

| record | what it says | what is true |
|---|---|---|
| `rasterize.ts:188-191` | the picture *"matches no glyph kind"* | §2.3 — it matches `algorithm` since #2160; the refusal is now about DATA, not kinds |
| `face-migration-inventory.ts:881-885` (pong's note) | *"That is the five-module platform gap (with timelorde, scope, rasterize, wavesculpt)"* | the gap was closed MECHANICALLY by #2160 and remains open SUBSTANTIVELY (§2.4). The sentence now over-claims in one direction and under-claims in the other |
| `face-migration-inventory.ts:444` (scope's note) | *"the dual-trace + Lissajous screen is ONE `scope` glyph binding"* | it binds LIVE on a passthrough output — see `../scope/spec.md` §0.2 |

Route: all three in one boy-scout edit, ideally the same PR as §2.3 since it is the same
paragraph's subject.

---

## 6. THE WORK, AND WHAT IT COSTS

| item | h |
|---|---|
| rewrite the glyph comment on `rasterizeDef` (§2.3) | 0.5 |
| add the layout-source refusal as a PERMANENT NEGATIVE LEG of `rasterize-face-model.test.ts`: assert that `glyphBinding({...def, face:{...face, glyph:'algorithm'}})` resolves `{kind:'algorithm', layoutSource:'rasterize', paramId:null}`, and that `paramId === null` ⇒ the shell's `topologyValue` is 0 | 1.0 |
| re-point `currentCursor`'s comment (§5.4) | 0.25 |
| the three stale-record corrections (§5.5) | 0.5 |
| `onMeterFrame` on the legacy card, read-unconditional / blit-conditional (§5.2) + a regression leg | 1.0 |
| pay the `raw-write-ledger` `wrap` DEBT: edit the card AND delete the entry (§5.1) | 0.5 |
| docs accept + review | 0.5 |
| **total** | **≈ 4.25 h, ONE PR** |

**WebGL attest: ZERO.** MEASURED —

```
$ flox activate -- bash scripts/webgl-attest-hash.sh --list | grep -i rasteriz
(no output)
```

No `rasterize` file is in the basis. The derivation (`webgl-attest-lib.ts:256-276`) is
(1) all of `lib/video/**`, (2) any `.svelte` under `ui/modules` **that creates a WebGL
context**, (3) the hand-listed `AUDIO_WEBGL_MODULE_DEFS` (`cube.ts`, `wavesculpt.ts`).
Both rasterize surfaces are 2D canvases and the def is not one of the two named files.

**VRT: none expected.** Nothing in §6 moves a pixel — the glyph decision is to keep
`'none'`, the comment edits are comments, and the card's `onMeterFrame` change alters
*when* it paints, not *what*. ⚠ **MUST-VERIFY that claim rather than assert it**: an
IntersectionObserver gate on a card whose VRT scene captures it off-screen would move
`vrt.spec.ts/rasterize.png` (**MEASURED 377 × 377**). Check `vrt-scenes.ts:256-282` — the
rasterize scene sets `__rasterizeVrtSeed`, which short-circuits the advance entirely, so
the seeded frame should be identical either way. If it is not, the gate belongs behind
the seed check.

---

## 7. VERIFICATION GATE

```bash
# 1. the face model, incl. the NEW layout-source negative leg (§6)
flox activate -- task test:one -- rasterize-face-model
flox activate -- task test:one -- rasterize-draw
flox activate -- task test:one -- rasterize-map

# 2. the glyph resolver + the extension seam — both, because they see different halves
flox activate -- task test:one -- shell-glyph-live
flox activate -- task test:one -- shell-extensions
flox activate -- task test:one -- module-face-lint

# 3. the rulings' source gates (unchanged, but the comment edit touches the def)
flox activate -- task test:one -- face-rack-status-source
flox activate -- task test:one -- face-resting-text-source

# 4. docs — a comment edit must produce an EMPTY contract diff
flox activate -- task docs:accept && flox activate -- git diff --stat

# 5. e2e, if the card's rAF changes
flox activate -- REPEAT=3 task e2e:one -- faces-parity

# 6. typecheck LAST
flox activate -- task typecheck

# 7. VRT: expected NO-OP. Verify, then dispatch only if a diff appears.
flox activate -- GREP=rasterize task vrt:commit

# 8. attest: NIL (§6). Nothing to run, nothing to report.
```

---

## 8. TASTE CALLS, EACH WITH ITS ONE-LINE REVERT

| call | revert |
|---|---|
| refuse the layout-source glyph (§2.2) | `glyph: 'algorithm'` + a `glyph` slot on the extension — and accept a per-instance-identical SVG that yields to the cells |
| keep `read('cursor')` rather than delete it (§5.4) | delete the getter and the read arm; #2000's future fix loses its observable |
| fix the card's rAF gating rather than leave it (§5.2) | leave it; an off-screen card keeps paying a full-frame `ImageData` per rAF |
| record the stale-record corrections here rather than open issues | per the owner ruling, nobody opens issues; the PR narrative is the searchable record |

---

## 9. WHAT THIS PACKAGE ANSWERS FOR THE WAVE

1. **The #2160 widening has no useful adopter yet, and this is where it is provable.**
   `rasterize` is the only member of the five-module cohort already faced, so it is the
   only one where the flip is a one-word experiment rather than a whole promotion. The
   answer is no, and §2.2 (a) is why — a fact about `ModuleShell.svelte:462`, not a
   preference.
2. **The SCREEN ruling has an audio-shaped hole**, it is measured (§4.1), it has a
   mechanical fix (§4.2), and the fix needs its own PR because it reddens correct modules.
3. **"The face pays the card's debt" is a claim the tree has already refuted, and this
   wave nearly repeated it** (§5.1). The first draft of this package and of
   `../scope/spec.md` both wrote *"promotion fixes it for free"* — the exact reasoning
   `raw-write-ledger.ts:202-210` records #2025 getting wrong, on the exact ledger those
   two modules are listed in. The corrected rule is one sentence: **a face gives faced
   users the fixed control and leaves `?shell=legacy` users the broken one; only editing
   the card pays the debt.** Worth carrying into every remaining face brief.

4. **The DEBT bucket is an inventory of payable work, which the owner ruling says not to
   keep** (*"fix it in one sweep, never inventory it"*). MEASURED: the bucket still holds
   entries across many cards, and two of them (`GatemaidenCard`, `JoystickCard`) have been
   drained one at a time over the past week, each by the PR that happened to open that
   card. That drain-on-contact policy is working and is visible in the file. Recorded, not
   crusaded: the `sanctioned` and `not-a-node` halves of the same ledger are a legitimate
   deny-by-default classification, so the answer is to keep draining rather than to delete
   the mechanism. **This wave's three modules account for three of those entries; two of
   them (`scope`, `rasterize`) are one-line button payments and are budgeted in their
   own specs.**
