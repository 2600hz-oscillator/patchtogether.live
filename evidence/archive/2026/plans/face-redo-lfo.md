# face re-do — lfo

> ⚠ **Read `face-redo-INDEX.md` §0 first.** Two owner rulings (2026-08-11) void
> the prose half of this spec: a face declares **no `title`, no `hint`, no page
> `hint`** (explanation goes to `docs`, read by right-click → annotate), and the
> **`signal-flow` sidebar kind is DELETED**. This spec leaned on "`face.hint`,
> which still paints by default" three times; that premise was already false
> (`facePageHeader()` returns `null` outside annotate mode) and the surface is
> now gone. The faceplate pipeline is PAUSED; this is not a queue item.

**Verdict: MECHANICAL ONLY.** The shipped face already *is* the design program's
§4 BATCH B lfo entry, implemented in full and better-argued than the entry
itself; what it needs is a `hero.control` — and **no readout strip, no sidebar,
no bespoke hero picture**, each an argued decision rather than a gap.

---

## 1. WHAT THE MODULE ACTUALLY DOES

**Signal path, in the worklet's real order** (`packages/dsp/src/lfo.ts`,
`process()`):

1. `rateHeld = rateArr[0]`, hoisted **out** of the sample loop (`:141`) —
   sample-and-held once per ~128-sample block *on purpose*, so multiplayer clients
   cannot skew on sub-block CV latency (`:138-140`).
2. Per sample, `shape = shapeArr[i]` and `depthRaw = depthArr[i]` (`:162,:167`) —
   genuinely a-rate, read **inside** the loop.
3. `gain = Math.max(0, depthRaw) * 2` (`:168`). Negative depth clamps to silence;
   the product is **not** capped, so depth 1 really emits ±2.
4. Clock rising edge → `lastClockSample < 0.5 && c >= 0.5 → this.phase = 0`
   (`:175-179`): it re-zeros phase and cancels the in-flight smoothing ramp. It
   never measures the period and never touches rate.
5. `this.phase += Math.max(0, rate) / sr` (`:184`), the shared-clock correction
   slice (`:187-194`), then wrap (`:196-197`).
6. Four taps off the *same* accumulator — `(phase+0.25)/(+0.5)/(+0.75) % 1`
   (`:201-203`) — each through `morph(p, shape) * gain` (`:205-208`).

**The shape morph is a CONTINUOUS BLEND, not a set of discrete waveforms.**
`morph()` (`:232-243`) is a two-segment linear crossfade: `s<1 → sine·(1−s) +
saw·s`, `s≥1 → saw·(2−s) + square·(s−1)`. Every value between the anchors is an
audible intermediate wave. This decides `landmarks` over `options` and the two
are never interchangeable — the def already says so (`lfo.ts:124-126`,
`lfo-face-model.ts:86-89`), and `param-vocabulary.test.ts` enforces the split off
`curve`.

**The rate is Hz, never sync divisions.** `rate` is `log 0.01..100 Hz`
(`lfo.ts:121-122`) and the worklet declares the identical
`minValue: 0.01, maxValue: 100` (`dsp/src/lfo.ts:61`). There is no divisor param,
no tempo input, no BPM anywhere. "Clockable" is a half-truth — the `clock` hole is
a phase reset only (§6 D2).

**What each control changes about the sound:** `rate` is the one speed, shared by
all four taps, block-held (so a rate CV is a stepped sweep at ~2.7 ms granularity
at 48 kHz, not a glide); `shape` is the morph position, per-sample, so an
audio-rate CV here is real timbral modulation of the wave; `depth` is output gain
×2, orthogonal to shape (every shape centres on 0, so depth scales swing and
never shifts centre), per-sample, so audio-rate CV here is amplitude modulation.

**Load-bearing vs incidental:** all three are load-bearing; there are only three.
`depth = 0` is a genuine **mode** — every tap flat, module silent — which is why
the readout prints `still` rather than `±0.00` (`lfo-face-model.ts:134-139`).

**Inert at spawn:** the `clock` input, and in an unusual way — **in a solo rack it
works fully and permanently; in a shared rackspace it is momentary.** The
shared-clock anchor schedules a ~200 ms glide back to the epoch-derived phase on
the next block whose divergence exceeds 1e-7 (`dsp/src/lfo.ts:146-158`), and a
clock reset creates exactly that divergence. The authored `docs.inputs.clock`
(`lfo.ts:239`) already states this correctly.

**Measurable facts worth printing** — the depth→gain multiplier (2), the unity
point (0.5), the Hz↔period crossover (1 Hz), the three morph anchors. **All four
are already printed**, by `lfoDepthReadout`, by `depth`'s derived default
`LFO_DEPTH_UNITY = 1/LFO_DEPTH_GAIN`, by `lfoRateReadout` and by
`LFO_SHAPE_LANDMARKS`. That is why §3 finds nothing left for a strip.

---

## 2. WHAT THE CURRENT SHIPPED FACE GETS WRONG — AND THE RANKING

**Almost nothing, and that is the finding.** `lfo.ts:193+` is a fully-argued face:
`order` is `['rate','depth','shape']` with a written justification per rank, one
`engine` page in signal order, `glyph: 'waveform'` with a per-module
`glyphDepthGain`, and a `rear` block that pins the `sync` band and the two genuine
`~` audio-rate holes — *correcting* an earlier wrong claim in the same comment.
Every batch-B contract item is already landed: `edge: 'trigger'` on `clock`
(`:90`), PF-4 labels on the four taps (`:112-115`), PF-10 landmarks (`:126`),
PF-3 `format` on rate and depth (`:122`, `:133`). Nothing here is declaration
order wearing a justification.

The genuine gaps:

1. **No `face.hero`** — the dock paints the bare capped glyph band then three
   equal knobs; the rank-1 control gets no promotion.
2. **The band LABEL is carrying a sentence.** `label: 'one oscillator · four phase
   taps'` is a *fact*, not a name. Under the no-prose ruling the fact does **not**
   move up into `face.hint` — that surface is gone. It belongs in `docs`, and the
   label becomes a name.
3. Consequence of (2): the rear CV band inherits the page label verbatim
   (`rear-card-model.ts:291` — `{ id: page.id, label: page.label }`), so the rear
   currently reads `one oscillator · four phase taps` over three CV holes. Fixing
   the front fixes the rear. ⚠ The page id stays `'engine'`:
   `rear-card-model.test.ts:259-260` pins `bandIds === ['voice','engine']` and
   `bandPorts(def,'engine') === ['rate','shape','depth_cv']`.

**Not a gap: the glyph.** `glyphBinding` resolves this def to `wave-morph`
(`shell-glyph-live.ts:162`) and draws a real cycle of the module's own morph law
at the live shape, scaled by `waveMorphGlyphAmp(depth, 2)`. It is param-derived,
not analyser-derived, so it does **not** flatline on a silent rack. That is the
correct kind of glyph and it is already here.

**THE RANKING — unchanged, three params.** The 6-cell lane budget is never the
constraint; `order` decides only the mini tile (1 cell) and the compact tile
(2 cells + glyph).

| rank | key | why it earns that rank (an argument wrong for another module) |
|---|---|---|
| 1 | `rate` | **The glyph is speed-INVARIANT by construction** — `triMorphWaveSample` draws one *normalized* cycle, so 0.01 Hz and 100 Hz paint the identical picture. A module with a live *scope* glyph would not need this rank; here the picture structurally cannot answer "how fast". It is also the only control ridden mid-patch, and PF-3 makes its readout actionable (`0.01` → `100 s`). |
| 2 | `depth` | The on/off *and* the amount: `gain = max(0,depth)*2` is exactly 0 at 0, so the module goes silent. And **the glyph stops reporting it halfway up** — `lfoGlyphAmp` saturates at unity (`lfo-face-model.ts:77-79`, pinned at `lfo-face-model.test.ts:123-129`), so unity→±2 draws identically. A control the picture stops reporting needs its own cell. |
| 3 | `shape` | **Demoted because the glyph draws it, and draws it exactly** — `triMorphWaveSample` reproduces the worklet's `morph()` live off the transient param stream. That is a glyph *buying a rank*, which is the whole point of having one. |

**THE LOSERS, NAMED: there are none.** Three params, three ranks; no control
family and no static control exists on this def. The only thing that lost is the
legacy card's static `SHAPE_GLYPHS` track marks, and that loss is already accepted
and argued (`lfo.ts:164-172`) — the live morph glyph plus PF-10 landmark ticks is
strictly more information at both tiers.

---

## 3. THE HERO + WHY THERE IS NO READOUT STRIP

### `hero.cell` — **NO bespoke picture. The most important call in this spec.**

The generic `waveform` glyph already **is** this module's own picture, and a
better one:

- `glyphBinding(lfoDef)` resolves `kind: 'wave-morph'` (`shell-glyph-live.ts:162`),
  drawing one cycle at the live `shape` through `triMorphWaveSample` — the
  worklet's `morph()` law — amplitude-scaled by
  `waveMorphGlyphAmp(depth, LFO_DEPTH_GAIN)`.
- It is **param-derived, not analyser-derived**, so the usual argument for a
  bespoke picture ("the generic scope shows nothing on a silent rack") does not
  apply.
- **A `hero.cell` would SUPPRESS it.** `ModuleShell.svelte:403` computes
  `heroGlyph = hasGlyph && !(view === 'dock-full' && hero?.cell)`. Declaring a
  panel would replace a correct picture of the wave with a second hand-drawn one
  — and a fourth independent copy of `morph()` (§6 D3).
- It also breaks the zero-contract claim: a panel key must be a family template
  resolving through `shell-cells.ts`, i.e. a declared `ControlFamily` — and
  families **are** in the contract.

The one thing a bespoke panel *could* add is the four taps drawn simultaneously,
including the def's `180° (anti)` nuance (a polarity flip for sine and square, a
half-cycle-early ramp restart for saw — `lfo.ts:106-110`). Genuine, and genuinely
this module's identity — **rejected for this wave**; revisit only on an owner
eyeball.

### `hero.control` — `rate`

Rank 1, and the hero argument is the *same* argument as the rank argument, which
is what makes it right: the picture answers "what wave", the big dial answers "how
fast", and those are exactly the two questions and exactly the two surfaces.
`knobReadout` returns non-null for `rate` (it declares `format`), so the hero dial
prints `1.00 Hz` / `100 s` at hero size.

⚠ `rate` stays listed in the band's `controls` — `heroFacePlan` can only *move* a
key some band already claims; leaving it off drops it into the defensive
`__unpaged` band.

### `hero.action` — **none, with a specific rejection**

Nothing to audition: an LFO runs the instant it spawns, unlike a struck voice. The
obvious candidate — a manual RESET firing a phase reset the way kickdrum's strike
fires a `ConstantSource` — is rejected on three grounds: a new `ControlFamily`
(+1 contract line), a factory change in the audio path, and **in a shared
rackspace it would visibly not work** — the anchor glides the phase back within
~200 ms (`dsp/src/lfo.ts:146-158`). A button undone before you release it is a
control that lies. *(For the record, against the recurring "platform blocker"
defect: an action cell CAN reach the engine — `engine-ref.ts` `getActiveEngine()`.
This rejection is on merit, not capability.)*

### THE READOUT STRIP — **omitted, deliberately**

**No `valueId` is proposed, because this module has no derived quantity that
survives the bar.**

| candidate | formula | traced to | negative control | verdict |
|---|---|---|---|---|
| `period` / `cycle` | `1 / rate` | `dsp/src/lfo.ts:184` | *none exists* — `rate` is the sole input, so every perturbation that moves the period moves the rate readback | **alias, not derived** |
| `tap spacing` (0°→90° in time) | `0.25 / rate` | `dsp/src/lfo.ts:201` + `:184` | *none exists* — same single input | **alias** |
| `output range` / `swing` | `±(max(0,depth) × 2)` | `dsp/src/lfo.ts:168` | *none exists* — `depth` is the sole input, and `lfoDepthReadout` **already is** this formatting, on the param | **alias** |

A quantity with no distinguishing perturbation is a param readout. All three are
single-input aliases. Registering any as a `valueId` would be the kickdrum-`tail`
trap inverted: a registry entry whose permanent negative control **cannot fail**,
i.e. decoration.

The honest `paramId` fallback does not earn the strip either, because of what
makes this module unusual: **every one of its three controls already prints its
own meaning** — `rate` switches Hz↔period at the crossover, `depth` prints the
swing not the position, `shape` names the nearest morph anchor via PF-10 landmarks
through `knobReadout`'s precedence ladder (`knob-vocabulary-model.ts:84-87`). A
strip of `rate · shape · depth` is those three strings reprinted ~40 px from the
dials that already say them. So `hero.readouts` is **omitted**; `heroFacePlan`
still returns a hero because `control` resolves.

⚠ **The one live fact worth a readout is structurally unreachable, and that is
worth stating rather than working around.** The genuinely useful thing to print is
*"is the clock hole authoritative right now, or is the rack anchor overriding
it?"* — which decides whether the clock input does anything lasting. But
`FaceReadoutValue` is typed `(read: (paramId: string) => number | undefined) =>
string`, so a readout can only be a function of params; shared-clock attachment is
neither a param nor per-node state. An observation, not a request.

**What would earn a strip later:** the design program's deferred `offset` DSP
param. With it, `output range` becomes genuinely two-input — `[offset − 2·depth,
offset + 2·depth]` — and the negative control writes itself: perturb `offset`, the
printed range moves while the DEPTH readback stays `±1.00`. That arrives with its
own DSP PR and ART re-pin, never folded into a face wave.

---

## 4. THE SIDEBAR — NONE

`face.sidebar` is omitted; `sidebarPlan` returns `null` and `DockFullView` keeps
the full-width editor. This was argued before the signal-flow kind was deleted and
the argument survives it:

- ~~`signal-flow`~~ — the kind no longer exists. It would have been a poor block
  anyway: the chain is `phase@RATE → morph(SHAPE) → ×gain(DEPTH) → four taps`,
  three stages in the same left-to-right order as the three knobs in the band
  beside it, and the fan-out was not expressible — `parallel` meant "taps the bus
  earlier and rejoins downstream", which the four taps do not do (they terminate),
  so marking them parallel would have taught the wrong chain.
- `presets` — three params. Any preset is two seconds of knob turning, and the
  roster's real value (provenance for a 25-param voice) does not exist at n=3.
- `readouts` — the same emptiness §3 establishes for the strip.
- `custom` — a component plus a `sidebar-panels.ts` registry line for a picture
  the glyph draws.

The facts a sidebar might have carried are already allocated: the clock hole's
semantics → the rear card's pinned `sync` band label plus the ▲ trigger glyph off
`edge: 'trigger'`; everything else → the authored `docs` (lfo is in `STRICT_DOCS`
and its prose is already complete and accurate).

---

## 5. RANGE / CURVE / VOCABULARY CHANGES

**None proposed.** All three params are already correct and single-sourced: `rate`
`log 0.01..100 Hz` matches `dsp/src/lfo.ts:61` exactly, with PF-3 `format`;
`shape` `linear 0..2` matches `:64`, with PF-10 `landmarks` (`options` would be a
lie — §1); `depth` `linear 0..1` with its default **derived** as
`LFO_DEPTH_UNITY = 1/LFO_DEPTH_GAIN` (`lfo.ts:132`), so "the default is unity" is
arithmetic rather than two literals agreeing.

**Card grep for re-typed range literals: ZERO found.** `LfoCard.svelte:81-83`
binds every range/curve/units prop to `rateP`/`shapeP`/`depthP` pulled off
`lfoDef.params`, and its shape track marks derive from `LFO_SHAPE_LANDMARKS`
through `knobValueToFrac` with the def's own curve. ⚠ **But one binding IS
missing, and it currently DISAGREES** — `formatValue` is never passed. That is a
live bug, not a design change → D1 below.

---

## 6. DEFECTS FOUND IN SHIPPED CODE

*(Follow-up bugs — not spec content. All five re-verified against the tree
2026-08-12 and all five are STILL LIVE.)*

**D1 — `LfoCard.svelte` ignores the def's declared `format`, and one value already
disagrees at the DEFAULT.** `LfoCard.svelte:81,83` bind
`min/max/defaultValue/curve/units` to the def but never `formatValue={p.format}`.
`Fader.svelte` and `Knob.svelte` both fall back to the shared ladder when it is
absent, so on `/rack` the DEPTH knob's drag tag reads **`0.50`** while the dock
face reads **`±1.00`** — at the shipped default, with nothing moved. RATE diverges
at the low end too (`0.01 Hz` vs `100 s`). *Cost:* the one number
`lfo-face-model.ts:126-133` exists to stop people misreading is still printed the
misleading way on the card most players use. *Why nothing caught it:* the shared
gate `card-range-source.test.ts` has a format clause but `LfoCard.svelte` is not in
`RANGE_BOUND_CARDS`; the private copy of that guard inside
`lfo-face-model.test.ts:268-368` predates the clause and has only range +
curve/units. **Two agreeing implementations of one guard, and the older is missing
the clause that matters.** *Fix:* pass `formatValue={p.format}` on rate and depth;
enrol `LfoCard.svelte` in `RANGE_BOUND_CARDS` **and** `MAPPING_BOUND_CARDS`;
delete the duplicated regex block, keeping only its landmark-glyph clause. Free at
VRT — the value tag renders only `{#if dragging || hovering}`, so no baseline
moves.

**D2 — `module-manifest.ts:563` states a falsehood on the public docs site.**
`'lfo.clock': 'External clock - locks LFO rate to incoming pulses.'` The clock
input does **not** lock the rate; it re-zeroes phase and nothing else.
Contradicted by the worklet (`dsp/src/lfo.ts:175-179` — no period measurement
anywhere), by the def header (`lfo.ts:14-15`, "the period is NOT measured and rate
is unchanged") and by the module's own authored `docs.inputs.clock`
(`lfo.ts:239`). Rendered in the port table at `/docs/modules`. *Cost:* a patcher
wires a clock expecting tempo sync and gets a phase reset at the old rate.
*Catchable?* Cheaply — assert a `PORT_NOTES` entry does not contradict the same
port's authored `docs.inputs` vocabulary, or delete the entry so `describePort`'s
fallback runs. While there, `'lfo.depth_cv'` has **no** entry and falls back to
`CV -> depth param.`; and `DESCRIPTIONS[lfo]` (`:247`, "Clockable LFO…") inherits
the half-truth.

**D3 — the MORPH law has THREE independent implementations and no cross-check,
beside a DEPTH law that has one and is cross-gated.** `morph()`
(`dsp/src/lfo.ts:232-243`), `morphLfo()` (`modules/lfo-state.ts:46-57`) and
`triMorphWaveSample()` (`ui/controls/scope-screen-model.ts`) are three separate
expressions of one crossfade. They are numerically equal today (checked by hand at
s = 0, 1, 2), but nothing asserts it: `lfo-face-model.test.ts:84-114` rigorously
cross-gates the depth multiplier and default across the package boundary *and* the
authored prose, and stops there; `scope-screen-model.test.ts:202-233` tests
`triMorphWaveSample` against its own expectations, never against `morphLfo`.
*Cost:* the glyph could silently draw a different wave than the module emits.
Note `lfo.ts:160` claims `triMorphWaveSample` is the worklet's `morph()`
"verbatim"; it is *equal*, not verbatim. *Catchable?* Trivially — sweep shape ×
phase asserting `morphLfo ≡ triMorphWaveSample`, plus the `repoFile` regex idiom
that file already uses against the worklet's expression.

**D4 — `lfo-face-model.test.ts` cross-gates the worklet's depth default and gain
but not the three RANGES.** If `dsp/src/lfo.ts:61-70`'s `minValue`/`maxValue` ever
narrowed, the def's dial would keep writing values the `AudioParam` silently
clamps — the backdraft "the control lied about its own range" shape, across a
package boundary, invisible to every def-reading gate. Three more lines with the
`repoFile` helper already present.

**D5 (cosmetic) — `dsp/src/lfo.ts:141`:**
`const rateHeld = rateArr.length > 1 ? (rateArr[0] ?? 0) : (rateArr[0] ?? 0);` —
both ternary branches identical. Harmless (the block-hold is correct either way)
but it reads as a half-finished a-rate/k-rate branch and invites someone to "fix"
it into a per-sample read, which would break the multiplayer phase alignment the
comment above it exists to protect.
