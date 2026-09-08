# FACEPLATE BUILD SPEC — `wavesculpt` (audio, the 4-voice 3D video synth)

> **SPEC + MOCKS. Nothing here is implemented.** Same bar and figure labels as the rest
> of this wave — `DERIVED-BY-READING` · `MEASURED` · `MUST-VERIFY`.
>
> **Mocks:** `dock-tabs.html` · `dock-monitor.html` (open in a browser; self-contained).
>
> ⚠ **TWO STANDING CONSTRAINTS ON THIS MODULE, BOTH OWNER RULINGS.**
> **(1) `wavesculpt` is on the manual-review list** — face MRs self-merge on final-commit
> green EXCEPT `cube` and `wavesculpt`. Neither PR proposed here may self-merge.
> **(2) `readCamShadow` is owner-listed and MUST NOT BE TOUCHED.** It is referenced in
> the defect ledger (§9.4) for completeness and nowhere else; nothing in this plan reads,
> edits or reasons around it.

**Verdict: BLOCKED ON ONE PRECURSOR PR, then PROMOTE. HIGH risk, ≈ 26 h across TWO PRs,
and EXACTLY ONE WebGL re-attest if the two PRs are sequenced as specified (§8).**

The blocker is not a missing platform capability — unusually for a module this size,
**every mechanism the face needs already ships, and one of them was built FOR this
module** (§4). The blocker is that this module's picture is a WebGL2 renderer living
inside a 3 644-line card, and no faceplate body can mount it without extracting it first.
That extraction is a behaviour-neutral refactor of an attest-basis file, which is its own
PR by size and by review shape.

---

## 0. THE CONSTRAINT MAP, READ FIRST

Six registries, all read.

| registry | member? | what it means here |
|---|---|---|
| `STRICT_FACES` | **NO** | un-migrated. Authoring the `face` IS the promotion. |
| `AUDIO_WEBGL_MODULE_DEFS` → the **WebGL attest basis** | **YES, BY NAME** | §0.1 — the single largest cost driver on this page |
| `CARD_PRODUCER_LANE_TYPES` (`dom-source-modules.ts:204-211`) | **YES — and for the GOES-BLACK half** | §0.2. Opposite of `scope`/`rasterize`. |
| `DOM_SOURCE_LANE_TYPES` | **NO** | owns no `<video>`/`<img>` |
| `GROUP_VIZ_HOST_TYPES` (`group-viz-hosts.ts:62`) | **NO** | `scope` is the sole member; MEASURED there, wavesculpt went `170/3072 → 0/3072` on group collapse before #1721 hosted it instead |
| `SKIP_BUDGET` (`scripts/e2e-skip-budget.mjs:363-371`) | **YES** | §0.3 — and it is a CAPABILITY park, not a flake park |

### 0.1 ⚠ THE ATTEST BASIS — MEASURED, AND IT DECIDES THE PR SEQUENCE

```
$ flox activate -- bash scripts/webgl-attest-hash.sh --list | grep -i wavesculpt
packages/web/src/lib/audio/modules/wavesculpt.ts
packages/web/src/lib/ui/modules/WavesculptCard.svelte
```

**Both files are in the basis.** The derivation (`webgl-attest-lib.ts:256-276`) is
(1) all of `lib/video/**`, (2) any `.svelte` under `ui/modules` **that creates a WebGL
context** — which is how `WavesculptCard.svelte` is in — and (3) the hand-listed
`AUDIO_WEBGL_MODULE_DEFS`, which names `cube.ts` and `wavesculpt.ts`.

**What that costs, and what it does NOT:**

* `face`, `docs` and `controlFamilies` are **STRIPPED** by `attest-code-basis.ts`. So
  authoring the whole `face` block, its argued comment, and any `controlFamilies` entry
  is **hash-transparent — ZERO attest.** The def's own comment says so (`:963-968`).
* `params` is **NOT** stripped. **Any new `options` roster, landmark, `format`, range or
  default on `wavesculpt.ts` moves the hash and forces a GPU re-attest.** `strict-faces.ts`
  records this exact contrast in its `dockscope` entry — that module's roster was free
  *because* its def is not in the basis; `graphicEq` pays it because it is.
* ⚠ **Basis rule (2) is derived from CONTENT.** A new `.svelte` under `ui/modules` that
  creates a WebGL context enters the basis automatically. So the renderer extraction
  (§6) both ADDS a basis file and REMOVES one, in one move.

**Consequence, and it is the plan's spine:** every edit that touches
`wavesculpt.ts`'s `params` or moves the WebGL context must land in ONE PR, or each PR
pays its own ~10-minute GPU attest. §8 sequences them so exactly one is paid.

### 0.2 ⚠ THE PICTURE GOES BLACK WITHOUT A MOUNTED CARD — the opposite of this wave's siblings

`dom-source-modules.ts:133-140`:

> *"`wavesculpt` — the card installs a frame drawer (`installWavesculptFrameDrawer`) that
> blits its WebGL ribbon render into the canvas the audio→video texture bridge hands it.
> With no drawer installed the module's own `drawFrame` fills the canvas SOLID BLACK, so
> `WAVESCULPT.video_out → VIDEO OUT` is a black screen. **MEASURED with the card never
> mounted: nonBlack 0/3072 px, maxLuma 0, ONE distinct frame signature across 42 rAF
> frames.**"*

`needsHeadlessSourceMount` returns `true` for `kind === 'shell' || 'placeholder'`, so
`Canvas` keeps `WavesculptCard` alive in `<HeadlessSourceHost>` after promotion and
`video_out` survives. **But that is a LIFETIME fix, not a rendering one** — it keeps the
port alive and paints nothing a player can see.

⚠ **And it makes one route to the face body structurally fragile.** A body that merely
READS a frame the headless card produces is depending on that headless mount for its own
picture. `needsHeadlessSourceMount` returns FALSE for `kind === 'stub'` (the real card is
in the dock rail) — a state that does not arise for a faced module, but the dependency is
one indirection away from a black faceplate and cannot be checked by reading the body.
**§6 rejects that route for this reason and picks the one with no such dependency.**

### 0.3 THE SKIP-BUDGET ENTRY IS A CAPABILITY PARK, NOT A FLAKE PARK

`scripts/e2e-skip-budget.mjs:363-371`:

```js
{ specs: ['wavesculpt.spec.ts'], reason: /no usable GL pixel read/,
  lanes: ['e2e'], homeLane: 'e2e',
  why: 'Renderer capability probe: readPixels on some software-GL stacks returns nothing
        usable; asserting on it would test the renderer, not WAVESCULPT. Tolerated but
        surfaced.' }
```

CLAUDE.md's triage rule applies in the direction that matters: *a test whose git history
shows no flake fixes is more likely under-budgeted than flaky, and those need opposite
responses.* This is neither — it is a probe-and-skip whose subject genuinely does not
exist on some renderers. **The face PR must not "fix" it, and must not add a second
readPixels assertion that would inherit the same skip.** Anything the face needs to prove
about the picture proves it through the DOM and the engine seam, never a pixel read
(§10).

### 0.4 THE LANE-PICTURE DECISION

**`wavesculpt` gets NO lane-tile picture. `glyph: 'none'`.** Stated as a decision, with
its own mechanism — this wave's three refusals share a conclusion and not an argument.

⚠ **This module is the ONE case in the cohort where a live-audio glyph would be
HONEST.** `wavesculpt.ts:826` declares `L` as `type: 'audio'`, and unlike `scope`'s
`ch1_out` or `rasterize`'s `thru`, `L` is not a passthrough — it is the **summed stereo
mix**, downstream of every voice's envelope, the distance gain, the pan and
`master_gain`. `primaryAudioOutPortId` returns `'L'` and a `waveform` glyph would resolve
`{kind:'live-audio', portId:'L'}` and paint the module's real output, moving with tune,
morph, fold, the four ADSRs, the gates and the master level. That is a legitimate live
glyph by every standard this fleet applies.

**It is still refused, for three reasons that are about THIS module rather than about
glyphs:**

1. **It is the wrong picture, and confidently so.** This module's claim is that the sound
   and the image are two readings of one field. A lane tile showing only the WAVEFORM
   asserts the audio half and silently drops the half the module is named for. A player
   glancing at the rack would read "an oscillator" — which is the one thing wavesculpt is
   not.
2. **A live moving surface in the compact VRT baseline is the `analogVco` problem**, and
   here it is worse than usual: unlike `scope` (silent until patched) this module's four
   voices are gate-driven but its `blink`/`view` modes and its wall compositor are not,
   and `master_gain` defaults to unity. ⚠ **MUST-VERIFY (§10.2): does an unpatched
   wavesculpt produce a flat `L`?** If it does not, the compact baseline is unbaselinable
   without a seed and the glyph is refused on determinism alone.
3. **The layout-source alternative is a constant**, exactly as for the other two:
   `ModuleShell.svelte:462` hardcodes `topologyValue` to `0` when `paramId` is null, and
   `ShellExtensionGlyphProps` (`shell-extensions.ts:44-51`) carries no `nodeId`. And its
   precedence is tier-split (`module-shell-model.ts:702-720` vs `:767-786`): dropped from
   a busy `'full'` plate, painted unconditionally at `'compact'`. On a module with the
   largest param order in the fleet after `mixmstrs`, a 40 px static diagram of a room
   with four wall emitters would be taking the compact tile's space from cells it has far
   too few of already.

**So the lane tile is controls-only** and the picture is dock-only through `fullViewBody`.
⚠ `curatedFace`'s `laneOrder` would drop a hero panel from the lane anyway — the `cube`
precedent, recorded at `dom-source-modules.ts:125-132`: *"a migrated face is not evidence
that a producer is mounted."*

---

## 1. WHAT THE MODULE IS FOR

**In one paragraph.** WAVESCULPT is a **hybrid instrument: it makes a sound and a 3D
picture from ONE engine, and the coupling is the design.** A unit box holds four "wall
oscillators" (RED / GREEN / BLUE / ALPHA), each a full wavetable voice emitting a ribbon
along a vector into the room. One camera renders the scene from INSIDE the box, and you
fly it. **Closer is bigger AND louder — one distance number drives visual size and audio
gain** (`docs.controls.zoom`). Six video inputs texture the room's faces, and
LUMINOSITY→BANDPASS lets a wall's brightness shape the audio of the lines that cross it.
So the verb a player performs is **INHABIT A ROOM THAT SOUNDS LIKE IT LOOKS** — and every
rank below descends from the fact that the camera is not a view setting, it is a
performance control on both domains at once.

**The structure, and it is regular** (`wavesculpt.ts:842-961`):

* **Per oscillator, four times over**: `tune`, `fine`, `morph`, `spread`, `fold`, an ADSR
  quartet, `thickness`, `fxType` and `fxAmount` — the loop at `:847-865` pushes the same
  twelve for `i = 1..4`. Plus a DOM-only wavetable-source strip per osc, declared as the
  control family `wavesculpt-osc` (`:1046-1053`).
* **The camera**: `pos_x`, `pos_y`, `pos_z`, `zoom`, `rot` — the first two are an XY pad
  on the card, `zoom`/`rot` a second pad, `pos_z` a knob.
* **Voicing**: `unison`, `detune`, `chord_mode`, `chord_quality`.
* **Look**: `video_mode`, `blink_mode`, `scale`, `wiggle`, `alpha_brightness`,
  `lum_depth`, and three packed-RGB colour params.
* **Output**: `master_gain`, which drives BOTH the audio bus and the render's
  `uMasterGain` uniform, clamped through one shared `clampMasterGain` (`:625-645`) so the
  two domains cannot drift.
* **The room**: six faces × (`alpha`, `distort`), listed literally so the static manifest
  extractor sees them (`:938-960`).

**THE MEASUREMENT THIS MODULE IS BUILT AROUND**, and it is already named on the def:
`BLINK_MODE_OPTIONS` (`:696-708`) carries the note *"⚠ `SCALE` IS DEAD AT STATE 0 and the
label is the only place a player can learn that: `uScale[]` is read solely by the SCOPE
program, which runs only when `blink_mode > 0`."* **One control is inert unless another
control is off its default**, and the only surface that can say so is the state's NAME.
That is the shape of this whole module: several controls mean nothing until a mode
selects them, and the face's job is to make the mode legible.

**What is INERT AT SPAWN.** `blink_mode = 0` ⇒ `scale` is dead. `wiggle = 0` is OFF by
declaration. `lum_depth = 0` is OFF. `unison = 0` ⇒ `detune` does nothing. `chord_mode = 0`
⇒ `chord_quality` does nothing. And the six walls are transparent-by-nothing until a video
cable lands, so twelve wall params move nothing on a fresh spawn. **A face that ranks any
of these highly is ranking a control that is dead in the shipped state** — §5 is built
around that.

---

## 2. STOP 1 — is promoting this module a PARITY LOSS?

`migrated(type)` (`strict-faces.ts:3918-3924`) stops BOTH surfaces rendering
`WavesculptCard.svelte`. Everything the card owns needs a route. Nine things live only
there.

| # | affordance | line | route |
|---|---|---|---|
| 1 | the WebGL2 render surface | `:3120-3128` | **`fullViewBody`, via the extracted renderer** — §6. THE BLOCKER |
| 2 | camera XY pad (`pos_x`/`pos_y`) | `:3083-3099` | `face.xyPads` → the shared `xy` cell |
| 3 | zoom/rot pad | `:3101-3117` | `face.xyPads`, a second entry |
| 4 | three colour pickers | `:2962-2977` | `paramCells: 'color'` — **a kind built for this module** (§4.2) |
| 5 | per-osc PRESET `<select>` | `:2981-2991` | a `selector` `ShellCell` on the family key |
| 6 | per-osc FACTORY `<select>` | `:2994-3011` | a `selector` `ShellCell` |
| 7 | per-osc LOAD `.wav` | `:3012-3019` | a `file` `ShellCell` |
| 8 | VIEW / BLINK / UNISON / CHORD buttons + MAJ/MIN radiogroup | `:3141-3215` | rosters → `segmented` cells (§4.1) |
| 9 | the corner RESIZE handle | `:3271-3277` | `face.monitor` — §7.3, and it is NOT a copy |

### 2.1 ⚠ THE VIEW BUTTON'S CAPTION DISAGREES WITH ITS OWN TOOLTIP, TODAY

`WavesculptCard.svelte:3141-3148` paints the VIEW button's caption from a hand-written
ternary:

```svelte
>{Math.round(video_mode) === 0 ? '3D' : Math.round(video_mode) === 1 ? 'BIRDSEYE' : 'SPECTRO'}</button>
```

while `VIDEO_MODE_OPTIONS` (`wavesculpt.ts:681-685`) declares `PROXIMITY` / `BIRDSEYE` /
`SPECTROGRAPH`, and `VIEW_CYCLE_TITLE` (`:2436`) — **the `title` attribute on that very
button** — is built from the roster:

```ts
const VIEW_CYCLE_TITLE = `View mode: ${VIDEO_MODE_OPTIONS.map((o) => o.label).join(' / ')}`;
```

**DERIVED-BY-READING: the button reads `3D` and its own tooltip reads
`View mode: PROXIMITY / BIRDSEYE / SPECTROGRAPH`. One element, two vocabularies.** State 2
reads `SPECTRO` against `SPECTROGRAPH`; only state 1 agrees.

⚠ **This is a defect in the exact place the def declares it was fixed.**
`wavesculpt.ts:656-661` says the rosters were exported *"SO THE CARD READS THEM TOO … a
SECOND SOURCE OF TRUTH for a vocabulary, which is the exact divergence `card-range-source`
records against FilterCard's private `const MODES = ['LP','HP','BP']`. **One roster, read
by the def, the dock and the card.**"* Every other consumer complies —
`fxTypeLabel` (`:284`), `blinkModeName` (`:2420`), both `*_CYCLE_TITLE`s — and this one
caption does not. `wavesculpt-mode-options.test.ts` pins the rosters against the docs
prose, so it cannot see a card caption that ignores them.

**Promotion FIXES the faced surface** (a `segmented` cell paints the roster label) **and
leaves the legacy caption wrong.** Both halves are one edit; §9.1.

### 2.2 THE RIBBONS STATE HAS A NAME THAT NO SURFACE EVER SHOWS

`blinkModeName` (`:2420-2421`) returns `''` for `blink_mode === 0`, and the name div is
`{#if blink_mode !== 0}` (`:3164-3166`). The BLINK button's own caption is the constant
string `BLINK`. So at the shipped default the roster's declared label `RIBBONS`
(`wavesculpt.ts:697`) appears **nowhere**, and the only signal that BLINK is in state 0 is
the ABSENCE of a name div beside it.

A `segmented` cell paints all three names with the current one selected, which is a strict
improvement and costs nothing extra — the roster already exists.

### 2.3 THE WAVETABLE STRIP IS DOM-ONLY AND ALREADY DECLARED

`controlFamilies: [{ id: 'wavesculpt-osc', label: 'Per-oscillator wavetable source',
kind: 'cell', testidPrefix: 'wavesculpt-osc' }]` (`:1046-1053`). Selection rides
`node.data` (`WavesculptData.osc1..4`, `:718-725`), never a `ParamDef`, and
`docs.controls['wavesculpt-osc-{n}']` (`:1027-1028`) already documents it.

**Face completeness REQUIRES it in `face.order`** — `module-face-lint.test.ts:312-357`
sweeps every param, **every `controlFamilies` entry as `<id>-{n}`**, and every legend
static key. So `face.order` carries `wavesculpt-osc-{n}`, which expands to one key per
oscillator, each of which must resolve a registered `ShellCell` (`shell-cells.test.ts`).

⚠ **One family key resolves ONE cell, and this strip is three affordances.** Two ways out,
and the choice is argued in §7.2: split into three families (a `controlFamilies` edit,
which is **hash-transparent** — the field is stripped), or one `panel` cell per osc
(which requires a probe, and a picker's only probe is a different control). **Three
families is the answer**, and it is the cheaper one in both senses.

---

## 3. STOP 2 — does every way of getting DATA IN survive?

```
WavesculptCard.svelte
:393-394  t.params.pos_x / pos_y   ← raw store write (LEDGERED, §9.2)
:445-446  t.params.zoom  / rot     ← raw store write (LEDGERED, §9.2)
:2872-2873 target.data.width/height ← the resize; `.data`, not `.params`
onColorPick / onPresetChange / selectFactory / onWavFileChange
                                   ← node.data writes + a param write for colour
set('<id>')(v)                     ← every knob and button
```

No keyboard handler. One file input (`:3013-3017`, `accept=".wav,audio/wav"`) and two
`<select>`s, all routed in §2. **STOP 2 is clean once the strip has cells** — with the
resize as the one genuinely new design item (§7.3).

---

## 4. THE MECHANISMS ALREADY EXIST — including one built for this module

This is the section that changes the module's risk profile, so it leads with the evidence.

### 4.1 Rosters — three of the four the face wants already ship

`fxType{1..4}`, `video_mode` and `blink_mode` all carry `options` today (PF-1 paid that
bill). **The one that does not is `chord_quality`**, whose `MAJ` / `MIN` are painted by
card markup alone (`:3197-3214`) — the `fourplexer` control loss, the fourth instance this
wave has found of the same class.

The argument for it is `dockscope`'s, verbatim in shape: *without `options` a 2-state
toggle announces pressed/unpressed — enable-and-absence semantics — while what this switch
picks is one of two MODES.* "Off" is not a thing a chord quality has.

```ts
{ id: 'chord_quality', label: 'Quality', defaultValue: 0, min: 0, max: 1, curve: 'discrete',
  options: [
    { value: 0, label: 'MAJ', title: 'major triad + octave — 1 · 3 · 5 · 8' },
    { value: 1, label: 'MIN', title: 'minor triad + octave — 1 · ♭3 · 5 · 8' },
  ] },
```

Names PROMOTED from `:3205`/`:3214`; the titles are `CHORD_INTERVALS_SEMITONES`
(`:607-612`) read back as prose.

⚠ **`unison` and `chord_mode` need NO roster.** Both are genuine on/off enables — the
control's own caption ("Unison", "Chord") carries the meaning, and a roster would be
inventing two words the module does not have. That is the discriminator the `dockscope`
entry states, applied in the negative for once.

⚠ **THIS ROSTER COSTS THE ATTEST.** It is a `params` edit to a basis file (§0.1). It is
the reason §8 sequences the work the way it does.

### 4.2 `paramCells: 'color'` was written FOR this module

`shell-control-kind.ts:52-60`:

> *"`'color'` — the integer is a PACKED 0xRRGGBB, not a position on a scale
> (**wavesculpt's `red_color`/`grn_color`/`blu_color`**)."*

Named, by param id, in the platform's own type documentation. `param-cell-coverage.test.ts`
records the kind as exercised (the ratchet list `UNEXERCISED_BY_FACES_PARITY` is currently
empty), so adopting it deletes nothing and adds nothing.

⚠ **`'color'`, not `'hue'`.** `:66-71` distinguishes them and says why: `color` is DISCRETE
over packed RGB, `hue` is CONTINUOUS over 0..1 and circular; *"handing a packed RGB to the
wheel would make one turn sweep the whole 24-bit space"*, and `module-face-lint` refuses
each on the other's shape. Wavesculpt's params are `discrete 0..0xffffff`, so `color`.

⚠ **ALPHA has no colour param and that is correct** — it is the alpha/mask layer
(`wavesculpt.ts:918-921`). So the OSC ALPHA band has one fewer cell than its three
siblings, by design rather than omission, and the face must not invent a fourth.

### 4.3 Both hand-cloned pads become the shared `xy` cell

`face.xyPads` (`types.ts:933`, shape at `FaceXyPad`) binds two params into one cell.
Constraints, read: both axes must appear in `face.order`, both must be **CONTINUOUS**
(*"a pad over a discrete param is a stepper wearing a joystick"*), the `y` axis is folded
so it does not render twice (`foldedParamIds`), and a pad is **DOCK-ONLY** — `laneOrder`
excludes it because a pad is square and a lane knob column is 46 px.

Both wavesculpt pads qualify: `pos_x`/`pos_y` are linear ±1; `zoom` is log 0.3..3 and
`rot` linear ±1 — all four continuous. ⚠ **The zoom/rot pad is the interesting one**: its
axes have different curves and different ranges, which the mechanism permits (each axis
maps its own param) but which the MOCK must show honestly, because a square pad whose
horizontal is logarithmic is a real usability question and not a rendering detail.

⚠ **`surface: 'body'` vs `'band'` is a live decision, not a default.** Declaring `'body'`
means the pad is painted by the module's own `fullViewBody` and DROPPED from the dock
bands (`bodyPaintedParamIds`, `shell-control-kind.ts:187-212`), verified by
`face-xy-body-source.test.ts` reading the body's source. §7.1 argues for `'body'` on the
camera pad and `'band'` on zoom/rot.

### 4.4 The tab rail engages on its own

`DOCK_TAB_MIN_BANDS = 7` (`dock-tabs-model.ts:101`) and the rail engages at
`bands.length >= DOCK_TAB_MIN_BANDS` **or** `face.tabbed === true` (`:131-144`). §5's
band structure is nine bands, so **the rail engages with no declaration at all.**

⚠ **AND `face.tabbed` MUST NOT BE DECLARED HERE.** `dock-tabs-model.ts:50-80` fences it:
*"IT IS DECLARED ONLY ON EXPLICIT OWNER INSTRUCTION, PER MODULE"*, with a verbatim-quote
registry (`FACE_TAB_OPT_IN`) red in both directions. There is no owner instruction naming
`wavesculpt`, so the field stays absent — and it is not needed, which is the happy case.
This satisfies the owner's control-heavy-gets-a-tabbed-face ruling **by band count rather
than by declaration**, and the ruling's own guard rail (*"never pad pages to force the
rail"*) is respected because the bands are not padded: four of the nine are the four
oscillators, which are irreducibly four.

---

## 5. THE RANK — `face.order`

The full order is long and regular; the argued form is the BAND structure plus the
within-band rank, because the module's controls are a grid rather than a ladder.

| # | band | hint | contents |
|---|---|---|---|
| 1 | `CAMERA` | *fly the room — closer is bigger AND louder* | `pos_x`/`pos_y` pad (body), `pos_z`, `zoom`/`rot` pad (band) |
| 2 | `OSC RED` | *wavetable voice 1* | `wavesculpt-osc-1`, `red_color`, `tune1`, `fine1`, `morph1`, then clusters `SHAPE` (`spread1`,`fold1`,`thickness1`) and `ENV` (`A1`,`D1`,`S1`,`R1`) and `FX` (`fxType1`,`fxAmount1`) |
| 3 | `OSC GREEN` | *wavetable voice 2* | the mirror, with `grn_color` |
| 4 | `OSC BLUE` | *wavetable voice 3* | the mirror, with `blu_color` |
| 5 | `OSC ALPHA` | *the mask layer — no colour of its own* | the mirror, **minus the colour cell** |
| 6 | `VOICING` | *four independent voices, or one stacked instrument* | `unison`, `detune`, `chord_mode`, `chord_quality` |
| 7 | `LOOK` | *what the render shows, and how* | `video_mode`, `blink_mode`, `scale`, `wiggle`, `alpha_brightness`, `lum_depth` |
| 8 | `OUTPUT` | *one level, both domains* | `master_gain` |
| 9 | `WALLS` | *texture the room's six faces* | six clusters, `alphaN` + `distortN` each |

### 5.1 CAMERA RANKS FIRST, AND THIS IS THE RANK WORTH DEFENDING

Declaration order puts the four oscillators first and the camera at `:866-870`. The face
inverts it.

**The argument is the module's own coupling claim.** `docs.controls.zoom`: *"closer
(smaller) = bigger ribbons visually AND louder audibly (closer = louder, one shared
distance number)."* The camera is the only control set that moves **both domains at
once**, it is the only one a player operates continuously during a performance, and it is
the only one whose effect is audible with **no gate patched at all** — the four voices are
silent until their gates open, and the distance gain is applied regardless.

`xyPads`' own doc-comment sanctions the inversion: *"It costs no lane rank — `laneOrder`
excludes it — so it may rank FIRST, which for a module whose pad IS its main control is
the honest ranking."*

⚠ **The counter-argument, stated so the rank is a decision.** An oscillator with no
wavetable and no tuning makes no sound, so one could argue the voices come first because
nothing works without them. That is true of the SETUP order and false of the PERFORMANCE
order, and a faceplate ranks the second — the `sixstrum` re-do is the precedent (its
shipped face ranked three next-strike-only controls into the lane and had no strike key,
so the dock offered twenty controls over an instrument that could not be sounded).

### 5.2 THE FOUR OSCILLATORS ARE FOUR BANDS, NOT ONE BAND WITH FOUR CLUSTERS

`types.ts:639-644` prices it: a page costs ~81 px, a cluster ~14 px, and the rule is
*reach for a PAGE when the controls are a different IDEA; reach for a CLUSTER when they
are the same idea, twice.*

Four oscillators are the same idea four times, which reads as "cluster". **It is still
four bands, and the reason is arithmetic rather than taste:** each oscillator carries
twelve params plus a wavetable strip plus (for three of them) a colour cell. Four of those
in one band is a wall of knobs with four sub-headers, on a dock that folds at 720p. The
CLUSTERS then do their proper job INSIDE each band — `SHAPE`, `ENV`, `FX` are three
different ideas about one voice, which is exactly the filter-EG-next-to-amp-EG case the
type doc uses as its worked example.

⚠ **And this is what engages the rail honestly.** Without the four-way split the band
count is six and the rail does not engage; with it, nine. The split is justified on its
own merits and the rail is a consequence, not the goal — which is the test the owner's
"never pad pages to force the rail" ruling actually applies.

### 5.3 WALLS RANKS LAST, AND `LOOK` RANKS ABOVE IT

Twelve wall params move nothing until a video cable lands in one of six `wall{N}` inputs
(`:818-823`). `LOOK` is above them because `video_mode` and `blink_mode` change what the
render IS in every patch, cabled or not. `OUTPUT` sits between them because `master_gain`
is the one control that can silence the module, and burying a mute is a mistake.

⚠ **`scale` is DEAD at the shipped `blink_mode = 0`** (§1). It ranks inside `LOOK`
immediately after `blink_mode` — adjacency is the only affordance a faceplate has for
"this control belongs to that mode", and the mode's roster label is what makes the
dependency legible. **It must not rank into the lane tier**, where the section heading
that carries the relationship does not exist.

### 5.4 THE LANE TIER

`master_gain`, `zoom`, `blink_mode`. The level, the one camera axis that is both audible
and visual, and the mode that decides what the picture is. ⚠ Deliberately NOT `pos_x`/
`pos_y` — a pad has no lane rank by construction, and splitting it into two lane knobs
would be the 2-D-gesture-flattened-to-two-knobs loss `xyPads` exists to prevent.

---

## 6. THE BODY — and the reason this module is BLOCKED

### 6.1 What the body has to contain

The render surface, the camera pad, and the SCREEN switch. Three routes were evaluated.

### 6.2 ROUTE A — the body owns its own WebGL2 context. REJECTED

Straightforward, and wrong: it is a **second renderer** for one node. Two GL contexts,
two program sets, two texture uploads per frame — for a module that already uploads six
wall textures. It also enters the attest basis by content (§0.1), so it pays the attest
AND every future edit to it pays another. **No.**

### 6.3 ROUTE B — the body blits a frame the headless card produces. REJECTED

Superficially the `rasterize` shape and cheap. Rejected for the §0.2 reason: the body's
picture would depend on the headless mount, a condition no reader of the body can check
and no gate asserts, on the one module in this wave that **measurably goes black** without
it (`nonBlack 0/3072, maxLuma 0`). It also needs a new read key on `wavesculpt.ts` —
a code edit to a basis file — so it is not free either.

### 6.4 ROUTE C — extract the renderer into a mountable surface. **THE PLAN**

`cube` already did this and the tree calls it the right shape
(`dom-source-modules.ts:113-117`): *"the drawer is installed from
`modules/cube/CubeVizSurface.svelte` … **`CubeVizSurface` is THE cube renderer (the legacy
card and the faceplate hero are two mounts of it, not two renderers)**."*

**And wavesculpt's card is already structured for it.** MEASURED by reading:
`displayCanvas` is a **2D** canvas (`:2735`, `:2747`, `:2762` all take
`getContext('2d', { alpha: false })`); the GL work targets an offscreen `renderCanvas` and
is blitted in (`:2761-2778`); BIRDSEYE and SPECTROGRAPH draw straight into the 2D canvas.
So the renderer is already separated from its presentation surface **inside** the card —
the extraction is moving a boundary that exists, not drawing a new one.

```
packages/web/src/lib/ui/modules/wavesculpt/
  WavesculptVizSurface.svelte   ← the GL renderer + the 2D presentation canvas + the
                                   three view modes + installWavesculptFrameDrawer
  WavesculptOutputBody.svelte   ← mounts the surface, adds SCREEN + MONITOR + the pad
  shell-extension.ts            ← { fullViewBody: WavesculptOutputBody }
WavesculptCard.svelte           ← mounts WavesculptVizSurface where its canvas was
```

**What this buys, beyond unblocking the face:**

* **ONE renderer, one `installWavesculptFrameDrawer` registration, one `video_out`.**
  ⚠ The registry is already OWNER-CHECKED for exactly this hazard
  (`wavesculpt.ts:104-124`): *"Under the faceplate shell one node's card MOVES between
  mounts … an unconditional `delete` lets a STALE card's `onDestroy` erase the drawer the
  LIVE card just installed, and the node goes permanently black with both mounts believing
  they are fine."* The extraction moves the install/uninstall pair into the surface, where
  mount and unmount are the same component's lifecycle — **which is the condition that
  makes the owner-check unnecessary rather than merely correct.**
* `__wavesculptVrtFreeze` is honoured in one place instead of two (`:1348-1361`).
* The card shrinks by the renderer's share of 3 644 lines, which is the single biggest
  readability win available on this module.

**Why it is its own PR:** it is a large behaviour-neutral refactor of an attest-basis file
whose review question is *"is the picture identical?"*, answered by VRT and by the existing
`vrt-wavesculpt-blink` / `vrt-wavesculpt-walls` scenes. Landing a faceplate on top would
mix that question with *"is the face right?"*, and this module is on the owner's
manual-review list — mixing them makes the review harder, not the PR smaller.

### 6.5 THE SCREEN SWITCH

Built exactly as `RasterizeOutputBody.svelte:47-62`/`:129-137`: `previewCollapsed` derived
from `node.data`, written through `mutateNode`, absent ⇒ ON, the button OVERLAYING the
picture's corner so it costs zero layout height.

⚠ **The rAF must stay running while collapsed, and here the reason is stronger than
rasterize's.** This module's renderer feeds `video_out` through the installed drawer, so
stopping it does not merely freeze a preview — it blacks out an OUTPUT other modules are
consuming. **Skip the BLIT to the presentation canvas; never skip the render.**

⚠ **No gate will check the switch.** `video-face-screen-source.test.ts:71-76` sweeps
`listVideoModuleDefs()` and `wavesculpt` is `domain: 'audio'`. Same hole as `rasterize`
and `scope`; see `../rasterize/spec.md` §4.

---

## 7. CONTROL INVENTORY — the decisions that are not mechanical

### 7.1 The two pads, and why they get different surfaces

| pad | axes | surface | why |
|---|---|---|---|
| camera | `pos_x` / `pos_y` | **`'body'`** | it is a control **over the picture** — you fly the camera by looking at where it goes. Painting it in the body puts the gesture next to its feedback, which is the entire reason the card put it beside the canvas. Costs a `face-xy-body-source.test.ts` obligation: the body's source must really paint it |
| zoom / rot | `zoom` / `rot` | **`'band'`** | ⚠ **and it is a weaker pad than the camera one.** Its axes have different curves (log vs linear) and different ranges, so equal pixel travel is not equal parameter travel in the two directions — a real usability wart the card already ships. Keeping it in a band, beside the other camera controls, is the honest presentation; promoting it to the body would put two pads over one picture and imply they are peers |

⚠ **The alternative for zoom/rot is worth naming rather than hiding: split it into two
faders.** That loses no GESTURE (each axis drives one param independently; nothing on the
card couples them) and gains a correct curve per axis. **It is a parity question the build
must put to the owner** — a 2-D pad flattened to 1-D controls is exactly the loss
`face.xyPads` was created to prevent, and doing it deliberately for a pad whose two axes
are not commensurate is a different case from doing it by accident. §11.3.

### 7.2 The wavetable strip becomes THREE control families

Split `wavesculpt-osc` into `wavesculpt-preset`, `wavesculpt-table`, `wavesculpt-load`,
each `kind: 'cell'` with its own `testidPrefix`, and register three `ShellCell`s per
oscillator:

* `wavesculpt-preset-{n}` → `selector` — `options` from `WAVETABLE_PRESETS`
* `wavesculpt-table-{n}` → `selector` — `options` from `getFactoryTables()`, plus the
  `USER · <label>` entry when the osc holds a user table
* `wavesculpt-load-{n}` → `file` — `accept: '.wav,audio/wav'`, `onFile` returning
  `{status, error}`

**Why three families rather than one `panel`.** A PF-14 panel REQUIRES a probe
(`shell-cells.ts:317`), and a picker's only observable is the selection it makes — so the
probe would either watch the control it is certifying (circular) or a different one
(blind). The generic kinds cover exactly *"a roster"*, *"a roster"* and *"a file"*, which
is what this strip is. `milkdrop`'s preset picker is the precedent for a runtime-sourced
selector.

⚠ **`controlFamilies` is STRIPPED from the attest hash** (`wavesculpt.ts:963-968`), so
splitting one family into three is **free**. This is the cheapest decision on the page and
it should not be mistaken for a big one.

⚠ **`docs.controls['wavesculpt-osc-{n}']` must split with it**, or `module-docs-lint`
reddens on a family with no prose and a prose key with no family.

### 7.3 THE RESIZE — `face.monitor`, and it is NOT a copy of ruttetra

The card's corner grip writes `target.data.width` / `target.data.height` (`:2872-2873`)
and those size **the whole card element** (`:2940`). `face.monitor` (`FaceMonitor`,
`types.ts:1096-1112`) is the declared seam for *"hiding the controls turns it into a
resizable monitor"*, gated deny-by-default in both directions by
`face-monitor-source.test.ts`, and `RuttetraOutputBody` + `BentboxOutputBody` are the two
adopters to copy from.

⚠ **But ruttetra's keys are `resizedWidth`/`resizedHeight`, and it CLEARS them when
monitor mode turns off** — *"the card DEFINES `resizedWidth`/`resizedHeight` as 'the size
while the controls are hidden'"*. Wavesculpt's `data.width`/`data.height` mean something
different: **the card's size, at all times, controls visible.** Reusing them for a
monitor box would make the faceplate's monitor size and the legacy card's size the same
number for two different things, and turning monitor mode off would resize the card.

**So: adopt `face.monitor` with the ruttetra KEYS (`resizedWidth`/`resizedHeight`), leave
`data.width`/`data.height` alone as the legacy card's own state, and say so in the
declaration's required `why`.** `FaceMonitor` is *"a record with one REQUIRED field, so
`tsc` refuses the bare `monitor: true` form"* (`types.ts:1252-1257`) — the burden of proof
is in the type, and this is what that field is for.

⚠ **MUST-VERIFY (§10.4):** that the two key pairs really are independent — i.e. that
nothing in the card reads `resizedWidth`, and nothing in `RuttetraOutputBody`'s shared
helper assumes a single global meaning.

### 7.4 `paramCells` and `bareCells`

```ts
paramCells: { red_color: 'color', grn_color: 'color', blu_color: 'color' },
```

⚠ **NO `'fader'` declarations.** The card mounts `<Knob>` for every continuous control
(`:3028-3071`, `:3170-3241`, `:3257-3262`) — it is a knob module, not a throw module — so
the shell's default resolution is already correct and declaring `fader` would be the
regression rather than the fix. This is the opposite call from `scope`'s, made from the
same evidence (what the card actually mounts), which is the test of whether either is
reasoned.

⚠ **`face.bareCells` IS a real candidate here and is still refused.** The wall band's
twelve cells are captioned `W1 α`, `W1 Dst`, … under a `WALLS` heading with per-face
cluster labels — the mixmstrs shape. But unlike mixmstrs' `1LO…8LO`, these captions carry
**two different quantities** per face (transparency vs distort), so a bare cell would leave
two identical-looking knobs per cluster with nothing distinguishing them. **The caption
that is redundant is the WALL NUMBER, not the quantity** — and `bareCells` hides the whole
caption or none of it. Refused; noted as the case that would justify a partial-caption
mechanism if one is ever wanted, and NOT proposed here (a new `ModuleFace` field is RED on
the TYPE until `face-resting-text-source.test.ts` gets a `TextRole` entry, which is a
platform change this face does not need).

### 7.5 `face.momentary` — none

Every switch on this module is LATCHING, classified at the READ SITE: `unison`,
`chord_mode`, `chord_quality`, `video_mode` and `blink_mode` are all read per frame by the
renderer and by `tick()`, with no edge detector anywhere in the chain.
`ACKNOWLEDGED_LATCHING`, never `face.momentary`.

---

## 8. COST — and the attest sequencing that halves it

### 8.1 THE SEQUENCE, and it is the plan's most important decision

| | PR 1 — **THE EXTRACTION** | PR 2 — **THE FACE** |
|---|---|---|
| moves the WebGL context out of `WavesculptCard.svelte` into `wavesculpt/WavesculptVizSurface.svelte` | ✅ | |
| adds the `chord_quality` roster (a `params` edit) | ✅ | |
| splits `controlFamilies` into three (**stripped — free**) | ✅ | |
| authors `face` + `paramCells` + `xyPads` + `monitor` (**all stripped — free**) | | ✅ |
| `shell-extension.ts` + `WavesculptOutputBody.svelte` (2D only, no GL context) | | ✅ |
| the three `ShellCell` registrations | | ✅ |
| **WebGL attest** | **ONE** | **ZERO** |

**Why the roster rides PR 1.** It is a `params` edit to a basis file, so it moves the hash
whichever PR it lands in. PR 1 already moves the hash (the basis gains
`WavesculptVizSurface.svelte` and loses `WavesculptCard.svelte`). **Two hash-moving edits
in one PR pay one attest; in two PRs they pay two.** ⚠ Landing the roster in PR 2 would
turn a zero-attest face PR into a second ~10-minute GPU run for one `options` array.

⚠ **And PR 2's zero depends on the body never touching WebGL.** It mounts
`WavesculptVizSurface`; it does not call `getContext('webgl2')`. If it did, basis rule (2)
would enrol it and PR 2 pays too.

⚠ **Attest protocol reminders that have burned time before:** attest the MERGED tree, not
the branch tip — `main` moving a basis file changes your hash; verify the pin against
head + current `main` before merging; and never measure attest state in a dirty primary
checkout.

### 8.2 The rest

| item | PR | h |
|---|---|---|
| extract `WavesculptVizSurface.svelte`; re-point the card; move the drawer install/uninstall into the surface | 1 | 7.0 |
| `chord_quality` roster + `controlFamilies` split + the docs keys that follow | 1 | 1.5 |
| PR 1 verification: `wavesculpt.spec.ts`, both VRT wavesculpt scenes, the attest | 1 | 3.0 |
| `face` block with its argued comment (nine bands, the camera inversion, the dead-`scale` note) | 2 | 3.0 |
| `shell-extension.ts` + `WavesculptOutputBody.svelte` (surface mount, SCREEN, MONITOR, the camera pad) | 2 | 4.0 |
| three `ShellCell` registrations + their `shell-cells.test.ts` rows | 2 | 2.0 |
| `wavesculpt-face-model.test.ts` (§9's matrix) | 2 | 3.5 |
| shared-file entries (`strict-faces.ts`, `_shell-faces.ts` `FACES`, `EXTENSION_BODY_ROLES`), docs accept, VRT dispatch + review | 2 | 2.0 |
| **total** | | **≈ 26 h** |

⚠ **CI wall-time.** PR 2 adds one faces-parity partition row over a module with the largest
param order in the fleet after `mixmstrs`, plus two VRT scenes. **MUST-VERIFY the delta
against the ~2 min threshold before merge** (§10.5) — this is the PR in this wave most
likely to exceed it, and faces-parity drives every cell.

---

## 9. DEFECT LEDGER

**None is fixed in this docs PR.**

### 9.1 The VIEW button's caption is a second vocabulary — P2

`WavesculptCard.svelte:3148` paints `3D` / `BIRDSEYE` / `SPECTRO`; `VIDEO_MODE_OPTIONS`
declares `PROXIMITY` / `BIRDSEYE` / `SPECTROGRAPH`; and `VIEW_CYCLE_TITLE` (`:2436`) —
the `title` on the same element — prints the roster. Two of three states disagree, on one
button, with its own tooltip. The def's rosters exist expressly to prevent this
(`wavesculpt.ts:656-661`) and every other consumer complies.

**Route: fix the caption in PR 1** (the extraction PR already opens the card).
`{VIDEO_MODE_OPTIONS.find(o => o.value === Math.round(video_mode))?.label}` — and the
`.on` class keeps its current `!== 0` test. ⚠ **It changes rendered text on the legacy
card, so it moves `vrt.spec.ts/wavesculpt.png`** — expected, reviewable, and it must be
predicted in the PR body rather than discovered in the diff.

### 9.2 The two pads' raw store writes are LEDGERED DEBT, still outstanding — P2

`raw-write-ledger.ts:309-313`:

```ts
'ui/modules/WavesculptCard.svelte': {
  keys: ['pos_x', 'pos_y', 'zoom', 'rot'], kind: 'debt',
  why: 'viewport/joystick drags — need the transient-first treatment
        (cv-modulation-live-store-write-storm)',
},
```

`WavesculptCard.svelte:393-394` and `:445-446` write `t.params.*` directly, so the drags
are neither undoable nor `LOCAL_ORIGIN`-tagged — and, being drags, they are a **write
storm** as well as an undo gap.

⚠ **The face does NOT pay this.** `raw-write-ledger.ts:202-210` refutes that claim by name
(*"a face does not pay a card's debt; editing the card does"*, filed against #2025 for
making it). The `xy` cell gives faced users correct, coalesced writes; `?shell=legacy`
users keep the storm.

**The payment is `createDragCommit`** — the same rAF-coalescing pump Fader/Knob/XyPad use,
and `JoystickCard` (queue Q43, `:211-217`) is the worked precedent: *"the card now writes
through the tracked param path, so the raw write is gone from the ARTIFACT and this entry
had to go with it."*

**Route: PR 1** (it opens the card, and a drag payment is a behaviour change worth
reviewing next to the extraction rather than under a faceplate). ⚠ Both halves or neither.

### 9.3 `RIBBONS` is a declared name no surface shows — P3

§2.2. `blinkModeName` returns `''` at state 0 and the name div is conditional, so the
roster's state-0 label never paints and BLINK's state is signalled only by an absence.
**Route: fixed for free by the face's `segmented` cell** (PR 2); the legacy card can keep
its behaviour or drop the `{#if}` in PR 1 — a one-line call for the build.

### 9.4 `readCamShadow` — OWNER-LISTED, REFERENCED ONLY

`wavesculpt.ts:1664-1674` reads a camera shadow's analyser tail and returns the KNOB
fallback when `tail === 0 && gain.value !== 0`. It is a known owner-listed defect and
**this plan does not touch it, does not depend on it, and proposes no change to it.**
Recorded here so a future reader does not mistake its absence from the plan for an
oversight. `mixmstrs.ts:843` cites it as prior art for the same distinction, which is the
only other place in the tree that reasons about it.

⚠ **One consequence the face DOES have to respect:** the camera pad and the `zoom`/`rot`
cells read their values through the ordinary param path, not through `readCamShadow`. The
body must not "improve" on that by reading the shadow to make the pad follow CV — that
would be building on the listed defect. **The pad shows the KNOB. CV moves the picture.
Those are two different numbers and both are correct.**

### 9.5 STALE RECORD — the inventory note predicts a mistake that is now preventable — P3

`face-migration-inventory.ts:535`:

> *"two HAND-CLONED camera pads (#1509 §3) and the largest order after mixmstrs; **a face
> was authored for it once and shipped both pads as knobs — do not repeat that**"*

The warning is correct and the mechanism that prevents it now exists (`face.xyPads`, with
`module-face-lint` enforcing that both axes are ranked and continuous). **Route: update
the note in PR 2 to name the mechanism**, so the next reader gets the fix rather than only
the warning.

---

## 10. MUST-VERIFY

1. **The extracted surface renders identically.** Both wavesculpt VRT scenes plus
   `wavesculpt.spec.ts`, and ⚠ the extraction must NOT introduce a second readPixels
   assertion — see §0.3.
2. **Does an unpatched `wavesculpt` produce a flat `L`?** Decides whether §0.4's glyph
   refusal rests on two arguments or three, and decides whether the compact baseline needs
   a seed at all.
3. **`installWavesculptFrameDrawer` still has exactly ONE registration per node** across
   a dock open/close, a tab switch and an LRU eviction. The owner-check exists because
   this went wrong before; the extraction should make it structurally impossible, and the
   test must prove that rather than assume it.
4. **`resizedWidth`/`resizedHeight` and `data.width`/`data.height` are independent**
   (§7.3) — grep both key pairs across the card, the body and ruttetra's shared helper.
5. **CI wall-time delta < 2 min for PR 2** (§8.2).
6. **The attest is measured on the MERGED tree**, matching CI's refusal hash before the
   GPU is spent.
7. **Owner review on BOTH PRs** — `wavesculpt` is on the manual-review list; neither may
   self-merge.

---

## 11. TASTE CALLS, EACH WITH ITS ONE-LINE REVERT

| call | revert |
|---|---|
| CAMERA ranks first, inverting declaration order (§5.1) | move the four oscillator bands above it; the rail is unaffected |
| four oscillator bands rather than one band with four clusters (§5.2) | collapse to one band — and the rail stops engaging, which is the tell that the split was load-bearing |
| **`zoom`/`rot` stays a pad rather than becoming two faders (§7.1)** | delete the second `xyPads` entry — ⚠ **owner question, because the two axes are not commensurate** |
| the camera pad is `surface: 'body'`; zoom/rot is `'band'` | flip either `surface` value |
| three control families rather than one `panel` (§7.2) | one family + a `panel` cell — and invent a probe for a picker |
| `face.monitor` with ruttetra's KEYS, not the card's (§7.3) | reuse `data.width`/`data.height` — and accept that leaving monitor mode resizes the legacy card |
| no `'fader'` declarations (§7.4) | declare them — and change what every control on this module looks like, against what its card mounts |

---

## 12. VERIFICATION GATE

```bash
# ── PR 1 · THE EXTRACTION ────────────────────────────────────────────────────
flox activate -- task test:one -- wavesculpt            # the def's own unit suite
flox activate -- task test:one -- wavesculpt-mode-options
flox activate -- task test:one -- dom-source-modules    # ⚠ the producer-seam subtree walk
flox activate -- task test:one -- mutate.guard          # ⚠ the ledger, anchored BOTH ways (§9.2)
flox activate -- task test:one -- webgl-attest-coverage # the basis swap is legible to the guard
flox activate -- REPEAT=3 task e2e:one -- wavesculpt
flox activate -- task typecheck
flox activate -- GREP=wavesculpt task vrt:commit        # ⚠ PREDICT the file count first (§9.1)
# then, on the MERGED tree and only once green:
flox activate -- task webgl:attest:check                # match CI's refusal hash BEFORE the GPU
flox activate -- task webgl:attest

# ── PR 2 · THE FACE ─────────────────────────────────────────────────────────
flox activate -- task test:one -- wavesculpt-face-model
flox activate -- task test:one -- module-face-lint      # completeness over the FULL order + 3 families
flox activate -- task test:one -- shell-cells           # every family key resolves a cell
flox activate -- task test:one -- param-cell-coverage   # 'color' + 'xy' adoption
flox activate -- task test:one -- face-xy-body-source   # the body really paints the camera pad
flox activate -- task test:one -- face-monitor-source   # the `why` is an argument, not a boolean
flox activate -- task test:one -- face-rack-status-source
flox activate -- task test:one -- face-resting-text-source
flox activate -- task test:one -- face-width-source
flox activate -- task test:one -- shell-extensions
flox activate -- task test:one -- dock-tabs-model       # ⚠ the rail engages on COUNT; `tabbed` stays absent
flox activate -- task test:one -- push-card-schema      # ⚠ the face CHANGES wavesculpt's push card
flox activate -- task docs:accept && flox activate -- git diff --stat
flox activate -- REPEAT=3 task e2e:one -- faces-parity
flox activate -- task typecheck
flox activate -- GREP=wavesculpt task vrt:commit
# attest: ZERO, IF the body touches no WebGL and no `params` moved (§8.1). VERIFY:
flox activate -- task webgl:attest:check                # must report the hash UNCHANGED
```

⚠ **The last line is not ceremony.** A zero-attest claim that turns out false is a
~10-minute GPU run discovered at merge time, on a module the owner reviews by hand.
`dockscope`'s entry in `strict-faces.ts` models the right discipline: *"Measured, not
reasoned: `task webgl:attest:check` reports the hash unchanged with a matching attestation
already on disk."*
