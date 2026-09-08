# FACEPLATE BUILD SPEC — `scope` (audio, the rack's two-channel probe)

> **SPEC + MOCKS. Nothing here is implemented.** Authored to the bar of
> `.myrobots/2026-08-23-bespoke-wave1/timelorde/spec.md` and its siblings.
>
> **Mocks:** `dock.html` · `dock-xy.html` (open in a browser; self-contained, no scripts).
>
> **Figure labels used throughout** — `DERIVED-BY-READING` (read the file; the claim
> follows from it) · `MEASURED` (a number off a committed artifact or a command run in
> this tree) · `MUST-VERIFY` (a claim the build must prove before merge; listed again
> in §14).

**Verdict: PROMOTE. LOW-MEDIUM risk, ≈ 11 h, ONE PR, ZERO WebGL attest (measured).**
`scope` is the closest thing this fleet has to a solved promotion: its sibling
`dockscope` shipped the identical shape three weeks ago — `glyph: 'none'` plus a
`fullViewBody` whose canvas calls the module's own pure draw function — and every
mechanism that shape needs is wired and adopted. What is NOT solved, and what most of
this page is about, is that `scope` has an audio OUTPUT where `dockscope` has none, and
that single difference turns the glyph question from "refused because nothing feeds it"
into **"available, legal, green on every gate, and a lie about the module"** (§0.2).

---

## 0. THE CONSTRAINT MAP, READ FIRST

Five registries decide what a `scope` face is allowed to be. All five were read.

| registry | member? | what it means here |
|---|---|---|
| `STRICT_FACES` (`strict-faces.ts`) | **NO** | un-migrated. Authoring the `face` IS the promotion (`module-face-lint.test.ts:3080-3092`, asserted both directions). |
| `CARD_PRODUCER_LANE_TYPES` (`dom-source-modules.ts:204-211`) | **YES** | listed with `rasterize`. ⚠ For the LIFETIME half only — see §0.1. |
| `DOM_SOURCE_LANE_TYPES` | **NO** | owns no `<video>`/`<img>`; nothing calls `attachExternalSource`. |
| `GROUP_VIZ_HOST_TYPES` (`group-viz-hosts.ts:62`) | **YES, AND IT IS THE SOLE MEMBER** | `GroupCard` hidden-mounts `ScopeCard` while a parent group is collapsed. Survives promotion — see §2.4. |
| `EXEMPT_FROM_VRT` (`e2e/vrt/vrt-exemptions.ts`) | **NO** | already baselined: `vrt.spec.ts/scope.png` **MEASURED 377 × 565**, plus three scenes in `vrt-scope-modes.spec.ts`. |

### 0.1 THE PRODUCER MEMBERSHIP IS ALREADY PAID, AND IT DEGRADES RATHER THAN GOES DARK

`dom-source-modules.ts:155-160` names `scope` and `rasterize` together: the card
"reads `readParam` … and pushes `write(node,'cvCombined')`, which is how a SAME-DOMAIN
cv cable reaches a DISPLAY param at all". `needsHeadlessSourceMount` returns `true` for
`kind === 'shell' || 'placeholder'` on any producer type, so `Canvas` keeps `ScopeCard`
mounted in `<HeadlessSourceHost>` whether the module is faced or not.

⚠ **What that does and does not buy.** `:162-171` is explicit that scope and rasterize
are members "for the LIFETIME half of this rule … and NOT for the 'renders black' half":
both render their picture inside the MODULE from its own analysers, so an unmounted
card still produces a full, moving, correct trace. **So the FACE BODY does not depend on
the headless mount for its picture** — it reads `read('snapshot')` off the engine handle
directly. That is the single biggest de-risking fact on this page, and it is the exact
opposite of `wavesculpt`'s situation (see that spec's §0).

⚠ The one thing the headless mount still owns is the `cvCombined` PUSH. `:173-187`
records the corrected behaviour: a param that was under CV when the pump stopped
**LATCHES AT ITS LAST MODULATED VALUE** — it does not fall back to the knob. The face
body must therefore run the same push-then-read pair the card runs, or a docked scope
with a patched TIME cable draws with a stale timebase. This is not new work; it is
`RasterizeOutputBody.svelte:68-86` verbatim, and §6.2 specifies it.

### 0.2 ⚠ THE GLYPH IS AVAILABLE, LEGAL, GREEN — AND A LIE. THIS IS THE PAGE'S HEADLINE

`dockscope` refused `glyph: 'scope'` because it declares `outputs: []`, so
`primaryAudioOutPortId` returns null and every literal falls to `{kind:'static'}` — the
dead-glyph clause (`module-face-lint.test.ts:248-309`, unconditional, no exemption list)
catches it and the refusal is mechanical.

**`scope` has no such protection.** `scope.ts:104-106` declares `ch1_out` and `ch2_out`
as `type: 'audio'`, so `primaryAudioOutPortId(scopeDef)` returns `'ch1_out'`
(`shell-glyph-live.ts:111-113`) and `glyphBinding` short-circuits at `:184` to
`{ kind: 'live-audio', portId: 'ch1_out' }`. That binding is **LIVE**. The dead-glyph
clause is green. `VALID_GLYPHS` is satisfied. Nothing anywhere reddens.

And the picture would be wrong in the one way that matters most on this module:

**`ch1_out` IS `gain1`.** `scope.ts:170-179` creates `gain1`, connects it to `analyser1`,
and `:274` publishes `['ch1_out', { node: gain1, output: 0 }]`. Nothing ever writes
`gain1.gain` — `setParam` writes the nine CV shadows instead (`:284-290`). So `ch1_out`
is **bit-exactly the module's CH1 INPUT**, and a `live-audio` glyph on it would paint a
raw 2048-sample analyser dump that is:

* **invariant to `timeMs`** — no timebase; the glyph draws the whole ~43 ms window,
* **invariant to `ch1Scale` / `ch1Offset` / `ch1Range`** — no scale, offset or ±5 V law,
* **invariant to `mode`** — never an XY plot,
* **invariant to `intensity`** — no phosphor,
* **invariant to `ch2*` entirely** — channel 2 is not in the picture at all.

**Every one of this module's controls.** DERIVED-BY-READING.

⚠ **And it is worse here than the two recorded cases, for a reason specific to what
this module IS.** `rasterize.ts:173-191` already named this class — *"this is the first
that resolves LIVE AND IS STILL BLIND, which no gate looks for"* — and
`mandelbulb-glyph-tap.test.ts` pins its sibling (a binding that resolves live and reads
zero forever). On rasterize a passthrough trace is merely uninformative: nobody expects
a raster module's lane tile to be a waveform. **On SCOPE a waveform trace is exactly
what a player will believe is the scope's trace.** The glyph would not fail to inform;
it would actively misinform, on the one module whose entire contract is "this picture is
your signal, drawn the way you dialled it".

**So the face declares `glyph: 'none'`.** Not because nothing fits — because the thing
that fits is false.

### 0.3 ⚠ AND THE #2160 WIDENING DOES NOT RESCUE IT

`shell-glyph-live.ts:105` now reads `{ kind: 'algorithm'; layoutSource: string; paramId:
string | null }`, and `:147-161` resolves the extension arm BEFORE the audio-out
short-circuit — so `scope` COULD legally declare `glyph: 'algorithm'` with
`extension: 'scope'` and get a live-kind binding despite having audio outputs. That
route was evaluated and refused, and the refusal is measured rather than aesthetic:

1. **A layout-source glyph has no input.** `ModuleShell.svelte:462` is
   `if (b.paramId === null) return 0;` — `topologyValue` is hardcoded `0` for every node,
   forever — and `:473` returns `''` for the caption. `ShellExtensionGlyphProps`
   (`shell-extensions.ts:44-51`) is `{ num, numbers?, testid? }`: **no `nodeId`, no
   engine, no store**. So every instance of `scope` in the rack would render a
   byte-identical SVG that cannot vary per node or over time. DERIVED-BY-READING.
2. **A constant SVG in a lane tile is the useless width the owner refused.** The tile
   already prints the module NAME; a fixed diagram of "two inputs into a screen" adds
   nothing the name has not said, and consumes tile height that ranked cells want.
3. **It would not even hold its ground at the tier that matters.** `laneGlyphFor`
   (`module-shell-model.ts:237-240`) returns `'trace'` for any non-`'none'` glyph on a
   non-video def, and the precedence is tier-dependent — read it exactly:
   * at `'full'` (`:767-786`), *"Ranked controls outrank the glyph: the strip renders
     only when a whole strip-row still fits UNDER the cell rows"* —
     `glyph: hasGlyph && plateGlyphFitsRows(usedTracks)`. **A nine-param face fills the
     plate, so the diagram is dropped.**
   * at `'compact'`/`'mini'` (`:702-720`) it is `glyph: hasGlyph` unconditionally, so the
     constant SVG WOULD paint — in the remainder of the design row, taking space from the
     three ranked cells that are the tile's whole value.
   * only `'picture'` gets the INVERTED precedence (reserved first, `:724-765`), and it
     is gated on `hasVideoSurface(def)` ≡ `domain === 'video'`, which this module is not.

   So the diagram is absent exactly where a player would look for detail and present
   exactly where the tile can least afford it. Neither outcome is worth a component.
4. **It costs a gate obligation.** `shell-extensions.test.ts:102-117` requires that any
   def declaring `glyph: 'algorithm'` resolve an extension exporting a `glyph` slot;
   without one the shell paints a 40 px empty framed plate (`ModuleShell.svelte:1429`
   has no `{:else}`). So the constant SVG is not free — it is a component, a slot and a
   gate row.

### 0.4 ⚠ THE LANE-PICTURE DECISION, STATED AS A DECISION

**`scope` gets NO lane-tile picture, and the lane tile is controls-only.** The trace is
DOCK-ONLY, through `fullViewBody`.

This is the same conclusion `timelorde` and `dockscope` reached, and it must not be read
as three copies of one argument — the three refusals have three different mechanisms
(timelorde: no audio output at all, so `{static}`; dockscope: no output at all, same;
scope: an output that resolves LIVE and is blind). What they share is the platform fact,
and it is worth stating plainly because it is now measured rather than suspected:

> **After #2160, a layout-source glyph is a CONSTANT PICTURE. The widening removed the
> refusal; it did not add a data path.** Its own doc-comment says so
> (`shell-glyph-live.ts:101-103`: *"THIS BRANCH REMOVES THE REFUSAL; IT DOES NOT DRAW
> ANYTHING"*), and `ModuleShell.svelte:462` is where that becomes concrete.

**The ONE platform change that would flip this module's answer is small and nameable:**
give `ShellExtensionGlyphProps` a `nodeId`, the way `ShellExtensionFullViewBodyProps`
already has one (`shell-extensions.ts:57-59`). Scope is the best adopter in the fleet
for that change — it already owns a pure, tested, resolution-independent draw function
and a live engine seam — and a 40 px `drawScope` at `timeMs`/`scale`/`mode` would be a
genuinely informative lane picture. **That is a platform PR, not this one.** Recorded in
§12.3 as the single escalation this package raises.

---

## 1. WHAT THE MODULE IS FOR

**In one paragraph, and every rank below descends from it.** SCOPE is not a sound
module and not a video module: it is **THE RACK'S PROBE**. You patch it INLINE — the
signal passes through untouched (`ch1_out`/`ch2_out` are the input gains verbatim) — and
it draws what is going past. Its two probe inputs are typed `audio` but `accepts:
['cv','pitch','gate']` (`scope.ts:86-87`), a per-port opt-in that lifts the global
`canConnect` block precisely because *a scope is a visualiser, not a master bus*. So the
verb a player performs here is **FRAME A SIGNAL SO IT CAN BE READ**: choose the window,
fit the amplitude, pick the volts-per-division convention, and decide whether you are
looking at two signals in time or one against the other.

**The signal path, in execution order** (`scope.ts:168-353`):

1. **Passthrough + tap.** `ch1 → gain1 → ch1_out`, with `gain1 → analyser1` as a pure
   sink (`:170-180`). `fftSize = 2048`, `smoothingTimeConstant = 0` — a ~43 ms window at
   48 kHz. Channel 2 is the mirror. **No control touches this path.** The module is
   display-only by construction, not by discipline.
2. **The nine display params are CV SHADOWS, not AudioParams** (`:205-215`). Every one is
   applied in JS by `drawScope`, so each gets its own `createCvShadow`. `:192-200` records
   what this replaced: six ports published `gain1.gain` — the live passthrough gain — so a
   cable into TIME amplitude-modulated the audio (MEASURED there: `7.010e+1` peak against
   a `5.0e-1` baseline) instead of moving the timebase.
3. **One draw, two surfaces.** `liveParams()` (`:219-231`) samples knob+CV once per frame;
   `drawScope` renders it. The on-card canvas and the cross-domain `videoSources`
   `drawFrame` (`:247-254`, `:281-283`) call the SAME function, so the card picture and
   the `out` mono-video texture cannot disagree.
4. **Two read keys nothing else in the rack provides.** `read('pitch')` runs YIN over
   ch1 (`:242-245`) — the tuner — and `read('ch1_last_sample')`/`read('ch2_last_sample')`
   (`:324-331`) return the newest sample at the probe. The latter pair is the canonical
   "a CV signal actually arrives" assertion for the whole e2e suite; `:314-323` records
   why (`readParam('cutoff')` returns the slider, not the modulated AudioParam, so an
   earlier attempt was "structurally wrong").

**THE MEASUREMENT THIS MODULE IS BUILT AROUND.** `RANGE_MAX_AUDIO = 1` and
`RANGE_MAX_CV = 5` (`scope-draw.ts:161-162`), and `pixelFromSample` (`:180-190`) divides
by the range: a ±1 audio sample fills the half-height, a ±5 V pitch CV sweep fills the
same half-height. **The range switch is the difference between a pitch-CV trace being a
readable curve and being a flat line at the top of the screen.** It is the least
glamorous control on the module and the one that decides whether the module works for
half its declared inputs.

**What is INERT AT SPAWN: nothing.** Every default is a working setting and the trace is
live the moment a cable lands. `intensity` defaults to `0.5`, which
`isDefaultIntensity` (`scope-draw.ts:196-200`) treats as a special case rendering
"PIXEL-IDENTICAL to the pre-PR scope" — so the shipped default is the legacy render and
both directions of the knob are real travel. This module has no dead-at-spawn control,
which makes it unusual in this wave.

---

## 2. STOP 1 — is promoting this module a PARITY LOSS?

`migrated(type)` is `STRICT_FACES.has(type)` (`strict-faces.ts:3918-3924`), and it stops
BOTH surfaces rendering `ScopeCard.svelte`. Everything the card owns must have a route
or it is deleted. Six things live only there.

| # | affordance on the card | route after promotion |
|---|---|---|
| 1 | the 320 × 300 trace canvas (`:266-272`) | **`fullViewBody`** — §6 |
| 2 | the pitch tuner: Hz + note text + tuning meter (`:275-293`) | **into the trace canvas as a graticule strip** — §5, and it is the one owner-visible call on this page |
| 3 | CH1 / CH2 `AUDIO`↔`CV` buttons (`:225-248`) | `ch1Range`/`ch2Range` gain an `options` roster → `segmented` cells — §4.1 |
| 4 | the `XY` / `⇆` button (`:249-258`) | `mode` gains an `options` roster → a named toggle — §4.1 |
| 5 | six `NeonFader` throws (`:296-304`) | `face.paramCells` declares `'fader'` for all six — §4.2 |
| 6 | `data-viz-passthrough="scope"` on the canvas (`:270`) | **survives untouched** — §2.4 |

### 2.1 ⚠ THE TWO BUTTON LABELS ARE THE ONLY PLACE FOUR WORDS EXIST

`AUDIO`, `CV`, `XY` and the dual-trace state are painted by card markup and nowhere
else: `ScopeCard.svelte:235`/`:247` (`{ch1Range >= 0.5 ? 'CV' : 'AUDIO'}`) and `:257`
(`{xyMode ? 'XY' : '⇆'}`). None of the three params declares `options`
(`scope.ts:122`, `:125`, `:127`).

`paintsReadout` is `!format && (options || landmarks)`, so an undeclared discrete param
paints an **anonymous** switch. Promotion without rosters therefore deletes every one of
those words — the `fourplexer` control loss exactly, and the same finding
`rasterize.ts:96-110` and `dockscope.ts:63-87` each wrote down for a single param. Scope
has **three** of them.

⚠ And the dockscope entry already argues the general form, on the identical control:
*"Without `options` a toggle reads as pressed/unpressed — enable-and-absence semantics,
'range is on' — while what this switch actually picks is one of two DISPLAY MODES with
different volts-per-division. 'Off' is not a thing this control has."* That argument was
written for `dockscope.range`, which is `scope.ch1Range` with one channel. **The names
are PROMOTED, not invented** (§4.1).

### 2.2 THE TUNER IS THE ONLY REAL QUESTION ON THIS PAGE

`read('pitch')` (`scope.ts:242-245`) is an engine seam **no other module has and nothing
else consumes**: `grep -rn "'pitch'" ` across the card layer finds `ScopeCard.svelte:165`
and nothing more. If the face does not carry it, the fleet loses its only pitch display
and `detectPitch` becomes dead code reachable from one un-rendered legacy card.

It cannot be carried as it stands. `ScopeCard.svelte:275-293` is a labelled row of
derived values sitting under a picture — **structurally the HERO READOUT STRIP**, deleted
from 50 of 68 faces on 2026-08-19 (#1957), and the fourth mechanism the owner has
refused. `face-resting-text-source.test.ts` would not catch it (a `fullViewBody` is that
gate's declared blind spot), and passing a blind gate is not compliance.

**§5 resolves it by moving the tuner INTO THE INSTRUMENT** rather than deleting it or
hiding it. That is a taste call with a revert, and it is listed as such.

### 2.3 THE FILE-HEADER COMMENT IS WRONG ABOUT THE RANGE SWITCH

MEASURED by reading three sites in two files:

* `scope.ts:39` (file header) — *"`ch1Range` / `ch2Range` … 0 = bipolar ±1, **1 =
  unipolar 0..1**"*.
* `scope.ts:119-121` (the param comment) — *"0 = audio (±1 fills the canvas), **1 = cv
  (±5** — Eurorack pitch CV convention…)"*.
* `scope-draw.ts:180-190` `pixelFromSample` — `if (isCv) return (sample / cvRange) *
  halfHeight;` with `RANGE_MAX_CV = 5`. **Bipolar in both modes; CV mode divides by 5.**

The header is wrong in both halves: state 1 is neither unipolar nor 0..1. `docs.controls
.ch1Range` (`:159`) gets the ±5 right but repeats "unipolar", which contradicts its own
parenthesis. `scope` is in `STRICT_DOCS` (`strict-docs.ts:160`), and the docs gate checks
presence and quality, not semantic truth — a gate reading one side of a two-sided claim.
**Boy-scout fix, folded into the face PR** (§12.1).

### 2.4 THE GROUP PORTAL SURVIVES, AND THIS IS WORTH PROVING RATHER THAN ASSUMING

`scope` is the sole member of `GROUP_VIZ_HOST_TYPES` (`group-viz-hosts.ts:62`): when a
parent group collapses, `GroupCard` hidden-mounts **`ScopeCard.svelte` directly** and
portals its `data-viz-passthrough` canvas into the group body. `:35-36` is explicit that
the component stays a direct `.svelte` import in `GroupCard` — it does not go through
`ModuleShell`, `migrated()`, or the extension registry.

**So promotion cannot touch it.** MEASURED and recorded at `:57-61`: collapsing a group
around SCOPE keeps `nonBlack 3072/3072, maxLuma 151` with `viz-hidden-mount` count 1 in
both shells. MUST-VERIFY (§14.4) that this still holds after promotion, because the
measurement predates it.

---

## 3. STOP 2 — does every way of getting DATA IN survive?

Grep of every write path on the card:

```
ScopeCard.svelte
:68   setNodeParam(id, paramId, v)     ← the six faders
:70-73 toggleXY()                       ← ⚠ SEE BELOW
:74-77 toggleRange(channel)             ← setNodeParam
:153  eng.write(node,'cvCombined',…)    ← the producer push (§0.1)
```

No keyboard handler, no file input, no drag target, no `node.data` write. Every user
input is a param write. **STOP 2 is clean** — with one defect found on the way through.

### 3.1 THE XY TOGGLE IS NOT UNDOABLE — AND IT IS ALREADY LEDGERED, WHICH CHANGES THE ROUTE

`ScopeCard.svelte:70-73`:

```ts
function toggleXY() {
  const target = patch.nodes[id];
  if (target) target.params.mode = xyMode ? 0 : 1;
}
```

against `:74-77`, three lines below it:

```ts
function toggleRange(channel: 1 | 2) {
  const key = channel === 1 ? 'ch1Range' : 'ch2Range';
  setNodeParam(id, key, (node?.params[key] ?? 0) >= 0.5 ? 0 : 1);
}
```

`setNodeParam` (`mutate.ts:106-119`) wraps the write in `ydoc.transact(fn, LOCAL_ORIGIN)`,
and its own doc-comment says it is *"equivalent to the bare proxy assignment but tagged
so it lands on the undo stack"*. The UndoManager is configured
`trackedOrigins: new Set([LOCAL_ORIGIN])` (`store.ts:70`). A bare proxy assignment runs
with origin `null`. **DERIVED-BY-READING: flipping XY is not undoable and does not carry
the LOCAL_ORIGIN tag a collaborator's client keys on; flipping either range switch beside
it is and does.**

⚠ **THIS IS NOT A NEW FINDING, AND SAYING SO WOULD HAVE BEEN THE ERROR.** It is a NAMED,
GUARDED, CLASSIFIED entry in `graph/raw-write-ledger.ts:289-293`:

```ts
'ui/modules/ScopeCard.svelte': {
  keys: ['mode'], kind: 'debt',
  why: 'XY-mode toggle — user gesture, should be undoable + synced',
},
```

The ledger is deny-by-default in both directions (a raw write in neither bucket and with
no inline marker is RED; an entry naming a write that no longer exists is RED), it is
keyed by PARAM KEY rather than line number so an already-listed file that grows a NEW raw
write still fails, and it exists because the guard's original pattern was bracket-only —
MEASURED there: **96 dotted writes the guard had never seen against 3 bracketed ones it
had**, i.e. it was covering ~3 % of its own subject.

### 3.1.1 ⚠ AND THE LEDGER ALREADY REFUTES THE OBVIOUS CLAIM ABOUT FACES

The tempting sentence here — *"promotion fixes it for free, because a `segmented` cell
writes through the shell's proper commit path"* — is **exactly the mistake #2025 made**,
and `raw-write-ledger.ts:202-210` records it verbatim:

> *"#2025 argued the debt was 'paid by construction' by FACING the module, on the
> reasoning that a faceplate routes the param through the normal path. That is not what
> this ledger measures. It is keyed by CARD PATH and anchored to the source, and
> promotion does not delete the card — the per-card VRT sweep still renders it under
> `?shell=legacy`. The raw write would have survived the promotion untouched and deleting
> this entry without touching the card would have gone RED as a stale exemption.
> **A face does not pay a card's debt; editing the card does.**"*

So: **the face gives faced users a correct XY toggle, and leaves `?shell=legacy` users
with the broken one.** The debt is paid only by editing `ScopeCard.svelte:70-73` to call
`setNodeParam(id, 'mode', …)` and deleting the ledger entry in the same diff.

**Route: pay it inside the face PR.** Three reasons, and none of them is "while we're
here": the PR already opens the file, `GatemaidenCard` (queue Q53, `:195-210`) is the
worked precedent for a one-line button payment, and the owner ruling on payable debt is
that it is fixed rather than inventoried. ⚠ **Deleting the entry without editing the card
is RED**, and editing the card without deleting the entry is RED too — the anchor runs
both ways.

⚠ `RasterizeCard.svelte` (`keys: ['wrap']`) and `WavesculptCard.svelte`
(`keys: ['pos_x','pos_y','zoom','rot']`) carry the sibling entries. The rasterize one is
the same one-line shape and should be paid in whichever PR next opens that card; the
wavesculpt one is a DRAG, not a button, and needs `createDragCommit` — see that package's
§5.

### 3.2 THE CARD'S REPAINT IS VISIBILITY-GATED AND THE BODY'S MUST BE TOO

`ScopeCard.svelte:135` drives the redraw through `onMeterFrame(canvasEl, …)`, which is
IntersectionObserver-gated, "so it stops entirely while the card is scrolled out of
view". This is the correct pattern and the face body must keep it — `dockscope`'s body
does (`DockscopeOutputBody.svelte`, `onMeterFrame`, not a raw rAF).

⚠ **Do NOT copy `RasterizeOutputBody`'s raw `requestAnimationFrame` here.** That body's
own header explains why it is exempt: rasterize's painter is advanced INSIDE
`read('imageData')`, so its loop is the only thing advancing the raster. **Scope has no
such inversion** — `readSnapshot()` (`scope.ts:233-237`) only reads two analysers and
mutates nothing, and the video bridge's `drawFrame` is independent of the card. Copying
the exemption without the reason would ship an ungated full-canvas redraw on a collapsed
dock. DERIVED-BY-READING.

---

## 4. THE RANK — `face.order`

```ts
order: [
  'timeMs',
  'ch1Scale', 'ch1Offset', 'ch1Range',
  'ch2Scale', 'ch2Offset', 'ch2Range',
  'mode',
  'intensity',
],
```

**The argument, against the DSP rather than declaration order.** Declaration order and
rank agree here, which is unusual enough to state explicitly rather than let it look
unexamined — the ordering was derived and then found to match.

1. **`timeMs`** — the only SHARED control, and the only one that changes what you are
   looking AT rather than how it sits on screen. Every other continuous control is
   per-channel cosmetics on top of the window this one chooses. Log 1..200 ms with the
   whole range useful.
2. **`ch1Scale` → `ch1Offset` → `ch1Range`**, then the channel-2 mirror. Grouped by
   CHANNEL, not by function, and this is the rank worth defending because the obvious
   alternative — `ch1Scale`,`ch2Scale`,`ch1Offset`,`ch2Offset`,… — reads better as a
   table and worse as an instrument. A player working on a trace works on ONE trace:
   they fit it, they move it out of the other one's way, and they set its convention.
   Interleaving makes every adjustment a two-column hunt. `mixmstrs`' console grid is
   the counter-example that proves the rule is about the GESTURE, not the layout.
3. **`mode`** — below both channels because XY is meaningless until both traces are
   readable on their own; you set the channels up, THEN cross them. It is also the one
   control that changes what the other eight mean (§7), which is a reason to keep it
   adjacent to the picture rather than at the top of the plate.
4. **`intensity`** — LAST, and it is a genuine taste call rather than a measured one.
   It is display feel, it is the only control that cannot make a trace wrong, and its
   shipped default is a special-cased legacy render (`scope-draw.ts:196-200`), so it is
   the control a player is least likely to reach for on a fresh spawn.

**The lane tier gets `timeMs`, `ch1Scale`, `ch2Scale`** — the smallest set that lets a
player make an unreadable trace readable without opening the dock. `ch1Range`/`ch2Range`
are deliberately NOT in the lane: they are set once for the kind of cable you patched and
then left alone (dockscope reached the identical conclusion for the identical control).

### 4.1 VOCABULARY CHANGES — three rosters, every name PROMOTED

**None of these is a contract change.** `contract-signature.ts` projects only
`id/min/max/curve/default/units`, so an `options` roster does not reach `contract-lock`
— the same class of edit as naming a param. And **`scope.ts` is not in the WebGL attest
basis** (§10.1), so unlike `wavesculpt` these cost nothing.

```ts
{ id: 'ch1Range', label: 'Ch1 R', defaultValue: 0, min: 0, max: 1, curve: 'discrete',
  options: [
    { value: 0, label: 'AUDIO', title: 'audio range — ±1.0 fills the trace' },
    { value: 1, label: 'CV',    title: 'CV range — ±5 V, the Eurorack convention' },
  ] },
```
…and the `ch2Range` mirror.

**Promoted, not invented**, and from two places that already agree: `ScopeCard.svelte:235`
paints exactly `CV`/`AUDIO`, and `dockscope.ts:83-86` already ships this precise roster,
word for word, for the same control. Copying it is not laziness — it is the whole point
of a fleet vocabulary, and a divergence here would be the defect.

```ts
{ id: 'mode', label: 'XY', defaultValue: 0, min: 0, max: 1, curve: 'discrete',
  options: [
    { value: 0, label: 'SPLIT', title: 'two stacked time-domain traces' },
    { value: 1, label: 'XY',    title: 'channel 1 against channel 2 — Lissajous / stereo phase' },
  ] },
```

⚠ **`SPLIT` is the one genuinely NEW word in this package, and it is a deliberate
correction rather than an invention.** The card paints `⇆` for state 0 — a glyph, not a
name, and one that says "swap" rather than "two traces". The def's own comment
(`scope.ts:126`) already calls it *"0 = split (two stacked traces)"*, and `scope-draw.ts`
names the function `drawSplit`. So `SPLIT` is the word the CODE uses; the card is the
outlier. Flagged in §13 with its revert.

⚠ **`label: 'XY'` on a param whose state 1 is also `XY` is a collision to fix in the same
edit.** Rename the param label to `Mode` — `label` is UI metadata, out of
`contract-signature`, and leaving it would paint a cell captioned `XY` whose two
positions read `SPLIT` and `XY`.

### 4.2 `paramCells` — all six continuous controls are FADERS, declared

```ts
paramCells: {
  timeMs: 'fader', ch1Scale: 'fader', ch1Offset: 'fader',
  ch2Scale: 'fader', ch2Offset: 'fader', intensity: 'fader',
},
```

`ScopeCard.svelte:296-304` mounts six `<NeonFader>`s. Nothing in a `ParamDef` separates
"a throw" from any other continuous scalar (`shell-control-kind.ts:92-99`), so an
undeclared face silently swaps every one for a dial — the `noise` regression `'fader'`
exists for. The two range switches and `mode` are NOT in the map: `min 0 / max 1 /
discrete` is the genuine two-state shape, `looksLikeToggle` resolves it, and with a
two-entry roster the dock renders a captioned `segmented` pair (2 ≤ `SEGMENTED_MAX_OPTIONS`,
`shell-control-kind.ts:128`).

⚠ **This declaration has a measured layout cost and it is accepted here on purpose.**
`LANE_CELL_H.fader` is 96 px against a 42 px plate row, so declaring `fader` halves a
module's lane plate. Scope's lane tier carries three cells (§4), so the tile stays one
row either way — the cost lands on a module that was never going to show six controls in
a lane. Twenty-three faced modules rank params their cards draw as faders and paint as
knobs and have not converted; scope converts because its lane set is small enough that
the conversion is free, not because the fleet has decided.

### 4.3 NOT CONTROL-HEAVY — no tab rail, and the rail could not engage anyway

`DOCK_TAB_MIN_BANDS = 7` (`dock-tabs-model.ts:101`) and the rail engages at
`bands.length >= 7` **or** `face.tabbed === true` (`:131-144`). Scope's band structure
(§7) is three bands. The rail cannot engage, and `face.tabbed` must not be declared:
`dock-tabs-model.ts:50-80` fences it as *"DECLARED ONLY ON EXPLICIT OWNER INSTRUCTION,
PER MODULE"*, with a verbatim-quote registry red in both directions. There is no owner
instruction for scope, so there is no `tabbed`.

This is the right answer on the merits too: nine params over one display is one honest
idea, and the owner's ruling is *never pad pages to force the rail*.

---

## 5. THE TUNER — the one owner-visible call, and where the FINDING goes

**The finding at risk.** SCOPE is the only module in the rack that reports the PITCH of
a signal. `detectPitch` (YIN, `pitch-detect.ts:44-…`) runs over the ch1 analyser window
at ~10 Hz and returns `{hz, note, cents, confidence}`. Two surfaces consume it, both on
the card: a text row (`PITCH 440.0 Hz | NOTE A4`) and a ±50-cent meter with a centre
tick and a marker that turns green inside ±5 cents (`ScopeCard.svelte:184-187`,
`:283-292`).

**The ruling.** The resting faceplate paints no derived-state text in any shape. The text
row is a labelled row of derived values under a picture — mechanism 3 in CLAUDE.md's list,
deleted fleet-wide. It goes.

**The design: the tuner becomes part of the INSTRUMENT, not a row beside it.**

* The **meter** — centre tick, marker, in-tune colour — is a PICTURE, not text, and it is
  drawn INTO the trace canvas as a graticule strip along the screen's bottom edge, the
  way a hardware scope prints its cursor readout on the CRT rather than on the bezel.
* The **note letter** is drawn in the same strip, as a graticule annotation.
* The **Hz value, the cents value and the confidence** are NOT painted anywhere. They
  land on `aria-label` of the strip's own element: `"tuning: A4, 440.1 Hz, +3 cents"` —
  speakable, assertable, unpainted, and it is what `scope-tuner.spec.ts` would read on a
  faced surface.

**Why this lands on the right side of the line, argued rather than asserted.**
`drawScope` ALREADY paints text into the canvas: `scope-draw.ts:160` exposes
`RANGE_MAX_AUDIO`/`RANGE_MAX_CV` *"for the corner scale-label in drawScope"*. Every
oscilloscope in the world prints its volts-per-division on the screen, and no reviewer has
ever called that a readout strip. `dockscope`'s shipped body does the same thing and
passed owner review. **The line the rulings draw is between DOM text areas that sit
BESIDE a module's controls and annotation that is part of the instrument's own picture** —
and the tuning strip is unambiguously the second.

⚠ **I am naming the risk rather than burying it: this is a judgement about where a line
falls, and the line has moved four times.** It is listed in §13 as a taste call with a
one-line revert (drop the strip from `drawScope`'s params; the meter disappears, the
`aria-label` survives, nothing else changes), and in §14 as the one item to put in front
of the owner with a screenshot before merge.

### 5.1 ⚠ AND THE TUNER'S PITCH BEHAVIOUR IS CURRENTLY UNTESTED IN CI

MEASURED by reading `e2e/tests/scope-tuner.spec.ts`:

* `:18` — *"ANALOG-VCO at A4 → pitch=440Hz / note=A4 / center hash visible"* is a
  **`test.fixme`**, annotated *"FLAKE-PARK #1847 — nondeterministic on CI: 1
  recovered-on-retry observation in the 96 h census to 2026-08-18; parked until
  root-caused."* **The only assertion that reads a pitch VALUE does not run.**
* `:80-100` — the one live test asserts the **em-dash placeholder** (`—` in `pitch-hz`
  and `pitch-note`) on `.svelte-flow__node-scope`, i.e. **on the LEGACY CARD**, after a
  `page.waitForTimeout(400)`.

Two consequences, and both make the §5 design better rather than riskier:

1. **The live test is unaffected by promotion.** It targets the card, and a face does not
   delete the card — `raw-write-ledger.ts:202-210` makes exactly that point about a
   different gate (*"promotion does not delete the card — the per-card VRT sweep still
   renders it under `?shell=legacy`"*). So the em-dash leg keeps passing, on the surface
   it has always tested.
2. **The face's `aria-label` route is STRICTLY better-tested than the DOM row it
   replaces**, because a `toHaveAttribute` on a stable accessible name is deterministic
   where a rendered Hz string chasing a live YIN estimate is what got parked. ⚠ **Write
   that leg**: the face PR should add a pitch assertion at the FACE reading
   `aria-label`, which is the assertion #1847 wanted and could not stabilise. It is not a
   replacement for un-parking `:18` — that is still #1847's to root-cause — but it means
   the fleet regains a pitch assertion that runs.

⚠ **Do NOT touch the parked test.** Un-parking it is a root-cause job with its own
evidence, and a face PR is the wrong place to relitigate a flake park.

⚠ **What is NOT proposed:** keeping the DOM row, hiding it behind a hover, or making it
an opt-in. Those are "there but hidden", refused by name.

---

## 6. THE BODY — `face.extension: 'scope'`

### 6.1 Why a body and not a panel cell

A PF-14 `panel` cell REQUIRES a probe (`shell-cells.ts:317`), and a read-only picture has
no operable affordance of its own — so the probe would have to watch a DIFFERENT control,
which is an aliveness check that cannot observe the thing it certifies. `rasterize` and
`foxy` both refused a panel for exactly this reason
(`face-migration-inventory.ts:326-334`, `:428-433`). `fullViewBody` needs no proxy, and
`dockscope` is the precedent this face matches exactly: a card whose BODY is the screen.

### 6.2 The component, specified

`packages/web/src/lib/ui/modules/scope/shell-extension.ts` → `{ fullViewBody:
ScopeScreenBody }`. **One slot. No `glyph`** (§0.3).

`ScopeScreenBody.svelte`, modelled on `DockscopeOutputBody.svelte` and differing from it
in three named ways:

1. **Draw through the module's OWN pure function.** `drawScope(ctx2d, snap, params, w, h)`
   from `$lib/audio/modules/scope-draw` — the same call `ScopeCard.svelte:195-212` and
   `scope.ts:247-254` make. *The whole point of routing through `drawScope` is that the
   three surfaces cannot draw different traces.*
2. **PUSH THEN READ, unconditionally.** For each `scopeDef.params`, `eng.readParam(node,
   id)` → `eng.write(node,'cvCombined', combined)` → `eng.read(node,'snapshot')` →
   `eng.read(node,'drawParams')`. This is `RasterizeOutputBody.svelte:68-86` with
   `imageData` swapped for `snapshot`, and §0.1 is why it is not optional.
3. **`onMeterFrame`, not a raw rAF** (§3.2).

**Size.** Bitmap 480 × 360 at `max-width: 100%; height: auto`, against the card's
320 × 300. The 4:3 ratio is kept because XY mode plots a circle for a 1:1 Lissajous and a
non-square aspect makes it an ellipse — a wrong picture, not merely a stretched one.
MEASURED reference point: `face-rasterize-dock.png` is **546 × 681** and
`face-dockscope-dock.png` is **306 × 404**, so a 480-wide screen sits inside the
established range and well under any plate ceiling.

**VRT determinism.** The body must read the SAME global the card reads —
`globalThis.__scopeVrtSeed` (`ScopeCard.svelte:108-128`), including its `{ch1Freq,
ch2Freq, ch2Phase}` shape and its `220/330/0` defaults. `dockscope` records why
(`DockscopeOutputBody`): reading a different global would leave the face unbaselinable.
Two live oscillators driving ch1/ch2 are not phase-locked, so the Lissajous orientation
drifts run-to-run; the seed is what makes the XY baseline stable.

### 6.3 ⚠ THE SCREEN ON/OFF SWITCH — required by the ruling, invisible to its gate

The owner ruling is fleet-wide: *all video cards get a preview-collapse toggle; it keeps
rendering while OFF; the state persists across tabs.*

`scope`'s body carries one, built exactly like `RasterizeOutputBody.svelte:47-62` and
`:129-137`:

* `previewCollapsed` DERIVED from `patch.nodes[nodeId]?.data?.previewCollapsed ?? false`
  — **state on the NODE, never `$state`**, because this component unmounts on dock
  collapse and LRU eviction (#1531/#1574/#1583). Absent ⇒ false ⇒ ON, so an existing rack
  opens unchanged.
* Written through `mutateNode`, one boolean per CLICK, never per frame.
* The button OVERLAYS the picture's bottom-right corner — `RasterizeOutputBody`'s CSS
  comment records that stacking it below cost ~18.8 px against ~11 px of slack and
  reddened `io-spec-consistency`'s card sweep.
* ⚠ **The `onMeterFrame` handler keeps running while collapsed; only the DRAW is
  skipped.** Scope's analysers are fed by the audio graph regardless, so this is cheap —
  but it must be written as "skip the paint", not "stop the loop", so the body behaves
  identically to every other adopter.

⚠ **And no gate will check any of that.** `video-face-screen-source.test.ts:71-76` builds
its subject as `listVideoModuleDefs().filter(d => STRICT_FACES.has(d.type))`. `scope` is
`domain: 'audio'`. **It is out of scope by construction**, exactly as `rasterize` is
today (see that package's §4, which measures the same hole and names the fix). So this
switch ships compliant and unguarded, and a future edit deleting it goes green. Stated
here so the absence is a known condition rather than a discovery.

---

## 7. BAND STRUCTURE — three bands, no rail

| band | label | hint (dock-only) | controls |
|---|---|---|---|
| 1 | `TIMEBASE` | *the window the screen shows* | `timeMs`, `mode` |
| 2 | `CHANNELS` | *fit each trace and pick its volts-per-division* | clusters `CH 1` (`ch1Scale`,`ch1Offset`,`ch1Range`) and `CH 2` (`ch2Scale`,`ch2Offset`,`ch2Range`), `flow: 'row'` |
| 3 | `BEAM` | *phosphor persistence — display feel only* | `intensity` |

**Clusters, not pages, for the two channels.** `types.ts:639-644` prices it: a page costs
a ~81 px band, a cluster costs a ~14 px sub-header. The two channels are *the same idea,
twice* — the file's own worked example ("a filter EG next to an amp EG") — so they are
clusters. `flow: 'row'` sets them side by side, which is the mixmstrs RETURN-strip case:
two peers wide enough to sit together and narrow enough to fit, saving a whole band's
vertical space.

⚠ **`mode` sits in TIMEBASE, not in CHANNELS**, and that placement is an argument. XY is
not a channel setting — it is a statement about what the horizontal axis IS. In SPLIT the
X axis is time and `timeMs` is its scale; in XY the X axis is channel 1 and `timeMs`
still selects the sample window but no longer scales anything visible. Putting `mode`
beside `timeMs` is the only arrangement in which the two controls that define the
horizontal axis are adjacent.

---

## 8. CONTROL INVENTORY — every primitive decision, argued

| control | primitive | why this one |
|---|---|---|
| `timeMs` | `fader` (declared) | a throw on the card; log 1..200 ms; the shared window |
| `ch1Scale` / `ch2Scale` | `fader` (declared) | throws on the card; log 0.1..10, unity at 1 |
| `ch1Offset` / `ch2Offset` | `fader` (declared) | throws on the card; linear ±1, centre-detented at 0 |
| `ch1Range` / `ch2Range` | `segmented` (resolved) | 0..1 discrete + a 2-entry roster ⇒ `looksLikeToggle` → `segmented`; the names are the whole point (§4.1) |
| `mode` | `segmented` (resolved) | same shape, same reason; `SPLIT` / `XY` |
| `intensity` | `fader` (declared) | a throw on the card; linear 0..1 with a special-cased centre |
| the trace + tuner | `fullViewBody` | §6 |

**No `face.momentary` anywhere.** All three switches are LATCHING, and the classification
is made at the READ SITE, not guessed: `drawScope` compares `params.mode` and
`params.ch{1,2}Range >= 0.5` on EVERY FRAME (`scope-draw.ts`, the `drawSplit`/`drawXY`
dispatch and `pixelFromSample`'s `isCv`). There is no edge detector anywhere in the
chain, so these are levels, not triggers — `ACKNOWLEDGED_LATCHING`
(`module-face-lint.test.ts:499`), never `face.momentary`. This is the identical call
`dockscope` made for `range`.

**No `face.bareCells`.** Every caption disambiguates: `1 Sc` / `2 Sc` under a `CH 1` /
`CH 2` cluster heading are the only thing separating two identical faders, which is the
tidyVco side of the ruling, not the mixmstrs side.

---

## 9. THE STATE MATRIX

The rows a `scope-face-model.test.ts` must pin, each a permanent leg.

| # | state | what the face must show | negative control |
|---|---|---|---|
| 1 | nothing patched | a flat centre line per channel; every cell live | perturb `timeMs` → the graticule spacing moves |
| 2 | ch1 patched, SPLIT | one moving trace, upper half | unpatch → row 1 |
| 3 | both patched, SPLIT | two traces, independently scaled | move `ch2Offset` → only the lower trace moves |
| 4 | both patched, XY | a Lissajous figure; NO stacked traces | flip `mode` back → row 3 |
| 5 | `ch1Range = 1` (CV) | ch1 amplitude divides by 5; the cell reads `CV` | `ch2Range` unchanged ⇒ ch2 amplitude unchanged |
| 6 | `intensity = 0` | a single moving dot | `intensity = 0.5` ⇒ pixel-identical to legacy (`isDefaultIntensity`) |
| 7 | `intensity = 1` | a ~2-screen persistence trail | — |
| 8 | a pitched signal on ch1 | the tuning marker leaves centre; `aria-label` names the note | silence ⇒ `rms < 0.001` ⇒ YIN's energy gate returns EMPTY ⇒ marker idles at centre |
| 9 | SCREEN OFF | no canvas; every control still live; `aria-pressed=false` | SCREEN ON ⇒ row 2 |
| 10 | a CV cable on `timeMs` | the trace window follows the cable, not the knob | ⚠ **and the knob must NOT move** — the shadow's `knob()` is what `readParam` returns |

Row 10 is the permanent negative control for the `cvCombined` push (§0.1). Row 6's
"pixel-identical" leg is what stops a body rewrite silently changing the shipped render.

---

## 10. COST

### 10.1 ⚠ WEBGL ATTEST: ZERO. MEASURED, NOT REASONED.

```
$ flox activate -- bash scripts/webgl-attest-hash.sh --list | grep -i scope
packages/web/src/lib/video/toybox-scope-draw.ts
```

**One hit, and it is a different module** — the toybox scope, not this one.
`scope.ts`, `scope-draw.ts` and `ScopeCard.svelte` are absent from the basis.

The derivation says why (`webgl-attest-lib.ts:256-276`): the basis is (1) all of
`lib/video/**`, (2) any `.svelte` under `ui/modules` **that creates a WebGL context**,
(3) the hand-listed `AUDIO_WEBGL_MODULE_DEFS`. `ScopeCard` is a 2D canvas; `scope.ts` is
not one of the two named audio defs (`cube.ts`, `wavesculpt.ts`). This is the identical
argument `strict-faces.ts` records for `dockscope`, and it means the three new `options`
rosters — which WOULD cost an attest on `wavesculpt` — are free here.

⚠ **One trap to avoid.** Basis rule (2) is derived from CONTENT, not from a list. If
`ScopeScreenBody.svelte` were ever written against a WebGL context it would enter the
basis automatically and every future edit to it would cost a GPU re-attest. **The body is
2D.** `drawScope` is a `CanvasRenderingContext2D` function; there is no reason to reach
for GL and a measured reason not to.

### 10.2 The rest

| item | cost |
|---|---|
| `face` block on `scopeDef` | ~60 lines incl. the argued comment |
| three `options` rosters + the `mode` label rename | ~20 lines |
| `scope/shell-extension.ts` | ~25 lines |
| `scope/ScopeScreenBody.svelte` | ~180 lines (dockscope's body + the push pair + the screen switch) |
| tuning strip in `scope-draw.ts` | ~50 lines + unit legs |
| `scope-face-model.test.ts` | ~200 lines (§9) |
| `strict-faces.ts` + `e2e/vrt/_shell-faces.ts` `FACES` entry | 2 shared-file edits — **conflict surface, see §12.4** |
| `face-rack-status-source.test.ts` `EXTENSION_BODY_ROLES` entry | `role: 'picture'` + a `why`; **mechanically verified** (`:37-42`) — a `picture` claim must really mount a `<canvas>` |
| docs re-accept | `task docs:accept`; the diff must contain ONLY the rosters + the corrected range prose |
| VRT | two new baselines (`face-scope-compact`, `face-scope-dock`) — **dispatch `GREP=scope task vrt:commit`, never commit a PNG** |
| CI wall-time delta | one faces-parity partition row + two VRT scenes; **estimated well under 2 min**, MUST-VERIFY |

**≈ 11 h.** The estimate is low relative to this wave because the precedent is exact and
nothing on this page needs a platform change.

---

## 11. DETERMINISM AND VRT

* **`face-scope-compact`** — three lane cells, no glyph, no picture. Static by
  construction.
* **`face-scope-dock`** — the trace under `__scopeVrtSeed`. The seed must be set BEFORE
  the body's first paint; the existing `vrt-scenes.ts:171` scope scene is the model.
* ⚠ **The width gate is the one that will bite.** `workflow-shell-faces.spec.ts:439-451`
  asserts `slack = bodyW - contentW <= FACE_WIDTH_SLACK_MAX_PX` (**40 CSS px**,
  `:224`), measured on `.faceplate-body` (`width: max-content`). A 480 px screen over a
  three-band plate whose widest row is the two side-by-side channel clusters should sit
  inside that, but it is a real constraint and the mocks are built to it.
  `FACE_WIDTH_EXEMPTIONS` has exactly one entry (`moog912`) and **scope must not become
  the second** — if the slack fails, narrow the screen, do not add a row.
* The trace IS the width-earner, and it is one of the ruling's own named examples
  ("a live picture, a scope trace").

---

## 12. DEFECT LEDGER

Four defects and one stale record, each with evidence and a routing call. **None is
fixed in this docs PR.**

| # | defect | evidence | severity / route |
|---|---|---|---|
| 12.1 | the file header states the CV range is *"unipolar 0..1"*; it is bipolar ±5 | `scope.ts:39` vs `:119-121` vs `scope-draw.ts:180-190` + `RANGE_MAX_CV = 5` | **P3 — fold into the face PR** (boy-scout; `docs.controls` says "unipolar/CV (±5)" and contradicts itself) |
| 12.2 | the XY toggle is not undoable and not origin-tagged; the two range toggles beside it are | `ScopeCard.svelte:70-73` vs `:74-77`; `mutate.ts:106-119`; `store.ts:70`; **already ledgered** at `raw-write-ledger.ts:289-293` | **P2 — PAY IT in the face PR.** ⚠ Not "fixed by promotion" — `raw-write-ledger.ts:202-210` refutes that claim by name (#2025). Edit the card AND delete the entry, in one diff (§3.1.1) |
| 12.3 | a layout-source glyph cannot vary per node or over time, so #2160 has no useful adopter | `ModuleShell.svelte:462`, `:473`; `shell-extensions.ts:44-51` | **PLATFORM — owner decision.** The fix is one prop (`nodeId` on `ShellExtensionGlyphProps`) and scope is the fleet's best adopter. **Not this PR** |
| 12.4 | `video-face-screen-source.test.ts` cannot see an audio-domain body's SCREEN switch | `:71-76` builds its subject from `listVideoModuleDefs()`; `face-rack-status-source.test.ts:106-115` `extensionsWithBody()` is the domain-blind population that would fix it | **PLATFORM — own PR.** Widening would redden any sibling body without a switch, so it cannot ride a face PR. Detailed in the `rasterize` package §4 |
| 12.5 | STALE RECORD: `face-migration-inventory.ts:444` still says *"the dual-trace + Lissajous screen is ONE `scope` glyph binding"* | §0.2 shows the binding is live-but-blind; `pong`'s note at `:881-885` still calls this "the five-module platform gap" after #2160 closed it mechanically | **P3 — correct in the face PR.** A stale scoping claim produces no failure, only absent work |

⚠ **12.4 and 12.3 are the same shape and must not be merged into one item.** 12.3 is a
missing capability; 12.4 is a gate that cannot see a capability that already ships.

---

## 13. TASTE CALLS, EACH WITH ITS ONE-LINE REVERT

| call | revert |
|---|---|
| the tuner becomes a graticule strip inside the canvas (§5) | drop the strip from `drawScope`'s params — the meter disappears, `aria-label` survives |
| `SPLIT` as `mode`'s state-0 name, against the card's `⇆` | `label: '⇆'` — but then the cell paints a glyph with no name |
| channels grouped by CHANNEL, not by function (§4) | reorder `face.order`; clusters follow |
| `intensity` ranked last | move it above `mode` |
| all six continuous controls declared `fader` (§4.2) | delete `paramCells` — every one becomes a dial, and the lane plate doubles in cell count |
| the lane tier is `timeMs`/`ch1Scale`/`ch2Scale` | widen `laneOrder`; the tile grows a row |

---

## 14. MUST-VERIFY — claims this spec makes that the build must prove

1. **`glyph: 'scope'` really does resolve `{kind:'live-audio', portId:'ch1_out'}` on the
   live def**, and the dead-glyph clause really is green on it. Assert it as a PERMANENT
   NEGATIVE LEG of `scope-face-model.test.ts` — the whole §0.2 argument is that no gate
   catches this, so the test must be the thing that records it.
2. **`ch1_out` is bit-exactly the `ch1` input** across a sweep of all nine params.
   Measured at the handle, not argued.
3. **The body's push-then-read makes a CV cable on `timeMs` move the trace** while
   `readParam` still returns the knob (§9 row 10).
4. **The group-viz portal still works after promotion** — collapse a group around a faced
   SCOPE and re-measure `nonBlack` / `viz-hidden-mount` against `group-viz-hosts.ts:57-61`.
5. **`face-scope-dock` slack ≤ 40 px** at the shipped screen width.
6. **CI wall-time delta < 2 min.**
7. **The tuning strip in front of the owner with a screenshot before merge** (§5).
8. **A pitch assertion that RUNS**, reading the strip's `aria-label` at the face (§5.1) —
   the fleet has none today, because `scope-tuner.spec.ts:18` is parked under #1847.
   ⚠ Adding it is not un-parking that test, and the face PR must not attempt to.

---

## 15. VERIFICATION GATE

```bash
# 1. the pure model + this face's PERMANENT negative controls (§9, §14.1)
flox activate -- task test:one -- scope-face-model
flox activate -- task test:one -- scope-draw

# 2. face lint: completeness, consistency, dead-glyph, dock render-plan parity
flox activate -- task test:one -- module-face-lint

# 3. the rulings' source gates
flox activate -- task test:one -- face-readout-source
flox activate -- task test:one -- face-resting-text-source
flox activate -- task test:one -- face-width-source
flox activate -- task test:one -- face-rack-status-source     # the EXTENSION_BODY_ROLES entry
flox activate -- task test:one -- shell-extensions            # extension resolves; no unwired slot

# 4. vocabulary, cards, push, docs
flox activate -- task test:one -- modules-card-map
flox activate -- task test:one -- mutate.guard                # ⚠ the ledger is anchored BOTH ways (§3.1.1)
flox activate -- task test:one -- push-card-schema            # ⚠ the face CHANGES scope's push card
flox activate -- task docs:accept && flox activate -- git diff --stat

# 5. e2e — the existing scope specs must survive, and faces-parity auto-enrols
#    ⚠ scope-tuner's pitch leg is PARKED (#1847); only the em-dash leg runs, and it
#      targets the LEGACY CARD, which promotion retains. Do not un-park it here.
flox activate -- task e2e:one -- scope-tuner
flox activate -- task e2e:one -- scope-xy-intensity
flox activate -- task e2e:one -- scope-video-out
flox activate -- task e2e:one -- nibbles-cv-scope
flox activate -- REPEAT=3 task e2e:one -- faces-parity

# 6. typecheck LAST — svelte-check is stricter than vitest
flox activate -- task typecheck

# 7. VRT: dispatch only. NEVER commit a PNG.
flox activate -- GREP=scope task vrt:commit

# 8. attest: NIL for this module — nothing to run, and nothing to report (§10.1).
```

⚠ **Step 4's push-card row is not ceremony.** `push-card-config.ts:23-27` makes the FACE
tier tier 2: absent an override, scope's Push 2 card becomes *the first eight turnable
params of `face.order`*. Scope is not in `PUSH_CARD_CONTROLS`, so **authoring this face
silently changes its Push card**. Decide deliberately: the rank in §4 gives a sensible
eight (`timeMs`, both scales, both offsets, both ranges, `mode`), so no override is
proposed — but the change must be observed rather than discovered.

---

## 16. BUILD-COST ESTIMATE

| phase | h |
|---|---|
| rosters + label rename + the two doc corrections (§4.1, §12.1, §12.5) | 1.0 |
| `face` block with its argued comment | 1.0 |
| `shell-extension.ts` + `ScopeScreenBody.svelte` (dockscope's body + push pair + screen switch) | 3.0 |
| the tuning strip in `scope-draw.ts` + unit legs | 1.5 |
| `scope-face-model.test.ts` (§9, ten rows, two permanent negative controls) | 2.5 |
| pay the `raw-write-ledger` DEBT entry: edit the card, delete the entry, keep `mutate.guard` green (§3.1.1) | 0.75 |
| shared-file entries, docs accept, VRT dispatch + review | 1.5 |
| **total** | **≈ 11 h** |

**ONE PR.** Nothing here needs a platform change to ship; the two platform items (§12.3,
§12.4) are recorded and routed, and the face is complete and honest without either.
