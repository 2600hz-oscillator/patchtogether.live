# face re-do — adsr

> ⚠ **STATUS CORRECTED 2026-08-04 — read `face-redo-INDEX.md` §0 before building.**
> PF-20 (**PR #1301**) **HAS MERGED** (`c6ff9253`); every "unmerged branch" citation below
> now resolves on `main`. **`face.title` and `face.hint` do NOT paint by default** —
> `facePageHeader()` returns `null` before reading anything unless annotate mode is on
> (`packages/web/src/lib/ui/workflow/dock-faceplate-model.ts:90`), and the owner ruled on
> 2026-08-03 that `face.title` stays annotation-only. **Any argument below that parks a
> load-bearing fact in `face.hint` because it "still paints" is VOID.** PF-21 dock ROW
> PACKING (`9bf12df7`) also landed after this was written. **This re-do is NOT built** —
> the module's shipped `face` still declares no `hero` and no `sidebar`. Live backlog.

**Verdict: REAL REWORK (declaration-only).** The shipped `face` is a well-argued RANKING sitting on
an ~85 %-empty faceplate that teaches nothing about the one thing that decides whether this module
works — the difference between a gate and a trigger. Proposal: a title + hint, a THREE-entry derived
READOUT STRIP that prints the two dimensions the envelope graph is invariant to by construction,
a five-shape `presets` sidebar, spelled-out param labels, and **no hero picture** (structurally
illegal today, and the `envelope` glyph already IS the module-specific graph).

---

## 1. WHAT THE MODULE ACTUALLY DOES

A gate-driven 0..1 contour generator. It makes no sound; it shapes something else.

**The DSP is four lines.** `adsr.dsp:6-9` declares four `hslider`s; `:13` is
`process(gate) = en.adsr(a,d,s,r,gate)` — Faust stdlib, `envelopes.lib:213`:

```faust
adsr(at,dt,sl,rt,gate) = ADS : *(1-R) : max(0)
  an=max(1,at*SR); dn=max(1,dt*SR); rn=max(1,rt*SR);  adelta=1/an;  ddelta=(1-sl)/dn;
  atime = +(gate) ~ *(gate' >= gate);   // ⇒ atime = atime'·[gate' >= gate] + gate
  A = atime*adelta;  D = (1 + an*ddelta) - atime*ddelta;  ADS = min(A, max(D, sl));
  rtime = (+(1) : *(gate == 0)) ~ _;    R = rtime/rn;
```

- **attack** — `A` reaches 1 at exactly `at` s of held gate. Linear.
- **decay** — reaches `sl` at exactly `dt` s after the attack, **independent of how far it travels**.
  ⚠ **At `sl == 1`, `ddelta == 0`, `D` is the constant 1, and decay has ZERO duration** — the def's
  own `docs.controls.decay` says so (`adsr.ts:198`).
- **sustain** — a LEVEL, the only linear param. ⚠ **At `sl == 0` the envelope reaches 0 at `a+d` and
  the release moves nothing** (release multiplies a frozen value) — `adsr.ts:199` says this too.
- **release** — `ADS` freezes on the falling edge and the output is `frozen · (1 − rtime/rn)`,
  hitting 0 at exactly `rt` s **from any level**. NOT level-scaled; the def's doc is accurate.

**env_inv** is host-side, not Faust: `ConstantSource(+1)` summed with `env·−1` (`adsr.ts:227-236`) —
the same contour flipped, which is the whole "one cable gives you sidechain" pitch.

**INERT AT SPAWN — the whole module.** Unpatched, `env` is a flat 0 and `env_inv` a flat 1 forever.
There is no audition (contrast kickdrum's STRIKE): a player can turn all four knobs and observe
nothing but the param-derived glyph.

**⚠ THE GATE SHAPE MATTERS AND NOTHING SAYS SO.** `atime` integrates the RAW SIGNAL and **resets on
every rising sample** (`gate' >= gate` is false while a signal rises), while `fireTrigger`'s default
shape is a TRIANGLE (`gate-trigger.ts:53-70`). **INFERRED** (Faust source + arithmetic, unmeasured):
at 48 kHz `an` = 240 while the falling ramp contributes ≈ 60, so a canonical trigger pulse yields an
envelope peaking near **0.25**, not 1.0. See §9.2.

**Numbers worth printing, none of which is a knob:** the note's SPAN (405 ms at defaults), the
minimum gate-HIGH time to reach sustain (105 ms), and how long the canonical trigger is actually
high (2.5 ms = `TRIGGER_PULSE_S/2`, `gate-trigger.ts:35` + the triangle).

---

## 2. WHAT THE CURRENT SHIPPED FACE GETS WRONG

I read the committed baseline, not arithmetic:
`e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/darwin/face-adsr-dock.png` (1220×370).

1. **The dock faceplate is ~85 % empty.** The glyph is capped at `DOCK_HERO_GLYPH_W` (214 px,
   `module-shell-model.ts:310`) and the four knob columns take ~200 px inside a ~1170 px pane;
   everything right of x≈250 is background.
2. **No `title`, `hint`, `hero` or `sidebar`** — the face predates PF-20. Expected, and it is the work.
3. **The band LABEL is a sentence** — `'gate → attack · decay · sustain · release'` (`adsr.ts:147`),
   and the def comment says why: *"the LABEL carries what the mock put in a sub-tag the shell has no
   slot for"* (`adsr.ts:141-144`). Correction 2 supplies that slot; the sentence moves to `hint` and
   is then hidden by default, so the face must stand without it (§4).
4. **Nothing on the FRONT teaches gate-vs-trigger.** `edge: 'gate'` (`adsr.ts:60`) reaches only the
   REAR ▬ glyph and edge legend; the front's "gate →" lives in a label about to become
   annotation-only. On a module whose defining property is level-sensitivity, that is the gap.
5. **The face's only picture is INVARIANT TO TIME by construction.** `envelopeCurvePoints`
   (`scope-screen-model.ts:49-80`) normalises x by `total = a+d+hold+r`, so scaling all four times
   by 10× draws a pixel-identical curve; it also draws a fictitious plateau (`ENV_HOLD_FRAC = 0.28`,
   `:37`) that is the GATE, not a parameter. It teaches shape and cannot teach duration — which is
   exactly what the strip is for (§5).
6. **Param labels are single letters** (`adsr.ts:95-98`) leaning on the page label to expand them.
   Correction 2 removes that crutch (§7).
7. **The rank-1 argument's arithmetic is wrong** (`adsr.ts:118-122`) — conclusion survives, reasoning
   does not. §9.2.

What is already RIGHT and stays: the `order`, the single page, the page **id** `stages` (pinned by
`rear-card-model.test.ts:189` and claimed by the curated rear group), `glyph: 'envelope'`, and the
rear's split by CV LAW. This is not a re-ranking spec.

---

## 3. THE ~8 CONTROLS THAT MATTER

**adsr has FOUR params.** There is no top-8 and no loser list — every control is ranked, `dockFacePlan`
renders all four, and `curatedFace(def,'full')` (cap 6) selects all four. Saying "8 controls" here
would be template. `order` is UNCHANGED; what changes is the argument behind rank 1.

| rank | key | why THIS module ranks it here | what it costs below |
|---|---|---|---|
| 1 | `release` | The only stage that applies **unconditionally**. Decay is dead at sustain 1.0, sustain is dead at 0, attack is skipped whenever the gate is shorter than it — release runs on every gate fall from any level, including mid-attack. And under trigger drive it is the *entire* audible event (§9.2 makes this stronger, not weaker). Wrong for a swell-oriented amp EG; right for a rack whose default sources are short. | pushes `attack` off the mini tile |
| 2 | `attack` | The one stage a player *hears as an articulation* — the click↔pluck↔swell axis, and the only stage whose log range is mostly spent below 10 ms. | — |
| 3 | `sustain` | The stage that decides whether the other three even run (see the two degeneracies in §1). Ranked below attack because it is a *level*, not a gesture: it is set once per patch and then left. | — |
| 4 | `decay` | The most conditional of the four: at the default sustain 0.7 it travels 0.3 of the range, and at 1.0 it does nothing at all. | dock-visible only at the plate tier and above |

⚠ **TASTE CALL, unchanged from what shipped** (design program §8 OPEN #4). The revert is one line —
swap `'release'` and `'attack'` in `order`; nothing else in the file moves. I recommend KEEPING it,
because §9.2 strengthens the trigger half of the case rather than weakening it.

Tier ladder read back as a sentence: **mini** = RELEASE + the contour; **compact** = RELEASE +
ATTACK + the contour; **full-in-lane** = all four stages, no glyph (4 cells ⇒ 2 plate rows ⇒
`laneBodyPlan` drops the glyph — priced in); **dock** = everything plus the strip and the sidebar.

---

## 4. BAND STRUCTURE + THE ANNOTATION PROSE

One page. The id does NOT move (`rear-card-model.test.ts:189` pins it, and `face.rear.groups` has a
curated `stages` group claiming that page's rear slot — `adsr.ts:174`).

```ts
pages: [
  {
    id: 'stages',
    label: 'stages',
    hint:
      'A gate drives all four, in the order they run: attack then decay while it is high, ' +
      'sustain held for as long as it stays high, release from wherever the level is when it falls.',
    controls: ['attack', 'decay', 'sustain', 'release'],
  },
],
```

Controls stay in canonical A/D/S/R order, **deliberately not `face.order`** — `order` is priority for
tiers showing a subset; a page shows all four, where the only sane order is the order they run in.
(Keep that sentence in the face comment; it is the thing a later author will otherwise "fix".)

**Does this read with EVERY hint hidden?** Yes — and only because of two other changes in this spec.
With hints off the band is: the envelope graph, the readout strip (`note 405 ms · gate to sustain
105 ms · from a trigger 2.5 ms high`), the header `stages`, and four cells reading
**Attack 5 MS · Decay 100 MS · Sustain 0.70 · Release 300 MS** (§7 spells the labels out). Nothing on
that face needs a sentence: the graph shows the shape, the labels name the stages, and the strip
prints the two facts the graph cannot. If the labels stayed `A/D/S/R` the answer would be NO — the
hidden label would have been the only thing expanding them, which is the exact "smuggled into the
label" failure the brief names.

---

## 5. THE HERO + THE READOUT STRIP

### No `hero.cell`. Two independent reasons, either sufficient.

**(a) It is structurally illegal today.** `module-face-lint`'s `panelTierProblems`
(`module-face-lint.test.ts:576`, platform branch) fails a panel key SELECTED at `mini`/`compact`/
`full`, and `faceTierCap('full', …) = LANE_PLATE_MAX_CELLS = 6` (`curated-face.ts:46,76`). adsr's
order would be five keys, so a panel ranked fifth is inside the top six and IS selected at `full`.
**A module with ≤ 6 controls can never declare a hero picture** — a platform gap, not an adsr gap (§9.4).

**(b) It would be a bigger copy of something generic.** `glyphBinding` already returns
`{kind:'env-params', …}` for this def (`shell-glyph-live.ts:119-124`), drawn reactively from the live
params by `envelopeCurvePoints`. That IS the module-specific graph; it is just small. A `cell` would
additionally **suppress** it (`ModuleShell.svelte:353`), so a bespoke panel costs: lose the live
glyph, gain a hand-maintained second implementation of the same curve. The honest fix for "too small"
is platform sizing (`DOCK_HERO_GLYPH_W` / `.dock-hero`), not a per-module panel — flagged, not folded in.

### No `hero.control`.

Promoting one stage to an XL dial REMOVES it from the band and leaves three in a row. The band's
entire content is that it reads A → D → S → R in the order they run; `1 big + 3 small` destroys it.
Other faced modules have a headline CONTROL — adsr's headline is the *sequence*.

### No `hero.action` here — but the audition is cheap, and the design program mis-priced it.

adsr is inert at spawn (§1), so an audition is high value. `manual-strike-actions.ts`'s header says
*"adsr's `manualGate` is already queued"*, and the seam is a **factory handle key, not a param** —
`snaredrum.ts:515-529` implements `read('manualGate')` as `openGate`/`closeGate` on a host-side
`ConstantSource` summed into the same worklet input a cable feeds. **adsr already has that
ConstantSource**: `silence` (`adsr.ts:205-208`) is a `ConstantSource(0)` wired into worklet input 0 —
the gate input. So the program's costing ("adsr `manualGate` … +1 param … ART re-pin ×2", §2 of the
design program) is wrong by a wide margin: **zero DSP, zero params, zero ART.** Real cost: ~12 LOC in
the factory, one `ShellActionCell` (`mode:'gate'`), and one `controlFamily` — which IS +1
contract-lock line, +1 `docs.controls` entry, and a matching `data-testid` in the legacy card
(`module-docs-lint.test.ts:231-246` greps card source for every declared `testidPrefix`).
**Its own small PR**, so this wave stays declaration-only.

### THE READOUT STRIP — three entries, two derived.

```ts
hero: {
  readouts: [
    { label: 'note',            valueId: 'adsr-span' },
    { label: 'gate to sustain', valueId: 'adsr-gate-min' },
    { label: 'from a trigger',  text: `${(TRIGGER_PULSE_S * 1000) / 2} ms high` },
  ],
},
```

Under correction 1 this is a full-width strip directly beneath the graph, above the `stages` band.
adsr is the module that makes correction 1 obviously right: with no `cell`, `control` or `action`,
the shipped `.hero-side` layout (`ModuleShell.svelte:907-919`) renders it as a dangling list floating
to the right of a 214 px graph.

**Why NO `paramId` entry.** All four params are cells in the ONE band directly beneath the strip, and
each dial already prints its value persistently via `ParamDef.format` (visible in the baseline:
`5 MS / 100 MS / 0.70 / 300 MS`). On this face a param readout is *structurally* redundant.

#### `adsr-span` — the note's full length. `span(a,d,s,r) = a + (s<1 ? d : 0) + (s>0 ? r : 0)`

Traced to the DSP: the `d` term drops because `ddelta = (1−sl)/dn` is 0 at `sl == 1`, so `D` is the
constant 1 and `ADS = min(A,1)` — decay has no duration. The `r` term drops because release is
`ADS : *(1−R)` over a value already at 0. Both degeneracies are asserted by the def's own docs
(`adsr.ts:198-199`). Formatted through `formatStageTime` so the strip and the dials share ONE ladder.
Defaults ⇒ `405 ms`.

**NEGATIVE CONTROL — permanent, three legs, in a new `adsr-face-model.test.ts`:**

| leg | perturbation | required | why a knob readback / naive `a+d+r` fails |
|---|---|---|---|
| MUST MOVE | sustain 0.70 → **1.00** | 405 → **305 ms** (drops by exactly `decay`) | invariant to sustain |
| **MUST NOT MOVE** | sustain 0.70 → 0.30 | stays **405 ms** | fails any "release scales with sustain" law |
| MUST MOVE | sustain 0.30 → **0.00** | 405 → **105 ms** (drops by exactly `release`) | invariant to sustain |

Leg 2 has real teeth rather than being ceremony: **this repo contains a second ADSR core with a
different law** — `packages/dsp/src/lib/adsr-env.ts` `tick()` (`:74-90`) is a single-pole EXPONENTIAL
with time-constant semantics. A plausible author mirrors it and is wrong; leg 2 says which core the
readout speaks for.

#### `adsr-gate-min` — the minimum gate-HIGH time. `gateMin(a,d,s) = a + (s<1 ? d : 0)`

How long the gate must stay high for the contour to reach sustain. `105 ms` at defaults. Not
redundant with `span`: `span` answers *how long is a note*, `gateMin` answers *how long must my gate
be* — and beside `from a trigger · 2.5 ms high` it is the module's most important lesson printed as
two numbers, permanently, with every hint hidden.
**NEGATIVE CONTROL:** MUST MOVE on sustain 0.7 → 1.0 (105 → **5 ms**); **MUST NOT MOVE** on `release`
0.3 → 3.0 (release is not in the formula — a copy-paste of `span` would move here).

⚠ **Caveat, stated in the face comment:** both are step functions at `s == 0` and `s == 1`. That is
the DSP, not the readout — and it is what the face should teach (turn SUSTAIN to max, watch DECAY
stop mattering, live, on the number).

---

## 6. THE SIDEBAR — `presets`, and only `presets`

Four params means a preset is COMPLETE by construction — the partial-recall hazard the platform
warns about cannot occur here. Every value below is in range (`a/d/r ∈ 0.001..10`, `s ∈ 0..1`).

```ts
sidebar: [
  { kind: 'presets', label: 'shapes', entries: [
    { id:'pluck', label:'PLUCK', note:'no sustain',  values:{ attack:0.002, decay:0.22,  sustain:0,    release:0.22  } },
    { id:'perc',  label:'PERC',  note:'46 ms',       values:{ attack:0.001, decay:0.045, sustain:0,    release:0.045 } },
    { id:'organ', label:'ORGAN', note:'gate-shaped', values:{ attack:0.002, decay:0.001, sustain:1,    release:0.006 } },
    { id:'bass',  label:'BASS',  note:'snap + body', values:{ attack:0.001, decay:0.35,  sustain:0.35, release:0.12  } },
    { id:'pad',   label:'PAD',   note:'slow swell',  values:{ attack:1.2,   decay:0.9,   sustain:0.75, release:2.5   } },
  ]},
],
```

The roster **hand-negative-controls the strip**: PLUCK/PERC are the `s == 0` case (span = `a+d` =
222 / 46 ms, release dead) and ORGAN the `s == 1` case (span = `a+r` = **8 ms**, decay dead). Clicking
through five shapes moves the two derived numbers in ways no knob readback could produce — the
negative control is visible to a human on the shipped surface, not only in a unit test.

**Why not the other three kinds** (an empty column is worse than full-width; a decorative one too):

- **`signal-flow`** — an envelope is a state machine over TIME, not a signal chain, and the block's
  `role: 'generator' | 'bus'` legend has no honest mapping (nothing generates — the module makes no
  sound — and nothing processes an incoming bus). Drawing A → D → S → R as bus stages would teach
  that a signal passes through four processors; "a diagram that teaches the wrong chain is worse
  than none" (the field's own doc). The band already reads in that order.
- **`readouts`** — everything worth printing is in the strip; a second list of the same numbers is
  the duplication the strip exists to prevent.
- **`custom`** — `stereo-crossover` is the only registered panel and does not apply; a new one costs
  a component + a registry line for a picture the glyph already draws.

---

## 7. RANGE / CURVE / VOCABULARY CHANGES

**One vocabulary change, forced by correction 2.** `ParamDef.label`: `'A'→'Attack'`, `'D'→'Decay'`,
`'S'→'Sustain'`, `'R'→'Release'` (`adsr.ts:95-98`). `label` is UI vocabulary, **not** contract —
`contract-lock.txt:45-48` reads `adsr param attack 0.001..10 log default=0.005 unit=s` with no label
field, and `types.ts:345` says so explicitly. Length precedent: kickdrum ships `'Translate'` (9) and
`'Sub Dec'` (`kickdrum.ts:110,121`), so 6–7 chars is well inside what a knob column prints.

**Grep of `AdsrCard.svelte` for re-typed def NUMBERS: ZERO.** `min`/`max`/`defaultValue`/`units`/
`curve`/`formatValue` all bind through `paramSpec` (`:30-33`, `:67-70`); the card is on both
`RANGE_BOUND_CARDS` and `MAPPING_BOUND_CARDS` (`card-range-source.test.ts:72,83`). The only literals
are `width={204} height={56}` on the ScopeScreen (display geometry) — **and the four `label="Attack"`
strings, which DISAGREE with the def** (`'A'`). A live divergence, not a hazard → §9.3. Fix
`label={pAttack.label}` … in the same commit as the rename, after which the legacy card renders
**identical text** (it already printed those words).

**PF-4 port label**, one line, contract-transparent (`types.ts:258-259`, `portLine` has no label
branch): `{ id:'env_inv', type:'cv', label:'ENVELOPE ⁻¹ · duck' }`. Today it derives to `ENV INV`
(`AdsrCard.svelte:41-43`) and no surface says it is the same contour flipped — the "one cable gives
you sidechain" pitch (design program BATCH D). `env` keeps its derivation; an explicit label there
would be a second copy that can drift.

**No range, curve, `options`, `landmarks`, `format` or `units` change.** The four ranges are the DSP's
`hslider` ranges verbatim (`adsr.dsp:6-9`) — **1:1, zero un-exposed DSP capability. That is a
finding, not a shortfall.**

---

## 8. COST

- **contract-lock: ZERO lines.** Checked field by field against `contract-lock.txt:37-48`: `face.*`
  has no contract branch, `ParamDef.label` and `PortDef.label` have none, and no param/port/family/
  `edge` is added or changed. No `docs:accept` run is needed (the `docs.*` prose keys are param ids,
  which do not move).
- **New source:** `packages/web/src/lib/ui/modules/adsr-face-model.ts` (two pure functions) +
  `adsr-face-model.test.ts` (the negative controls) + **2 lines** in
  `face-readout-values.ts` (`'adsr-span'`, `'adsr-gate-min'`).
- **VRT — MOVES:** `face-adsr-dock` (title + hint + strip + sidebar column + spelled labels) and
  `face-adsr-compact` (labels only). Both platforms are committed and **neither is in
  `EXEMPT_BASELINE_PAIRS`**, so this is a re-capture, not a drain: darwin locally, linux via one
  `vrt-update.yml -f platform=linux` dispatch, **in the same PR** (a drain/re-capture split ships a
  red lane). ⚠ The dock delta is far above `DOCK_MAX_DIFF` (1500 px) — a whole new column — so the
  gate will see it; the compact delta (four labels in ~86×81 px) must be checked against
  `COMPACT_MAX_DIFF` (150 px) and is expected to exceed it.
- **VRT — MUST NOT MOVE** (a diff here is a finding, never a re-pin): `vrt.spec.ts/{darwin,linux}/
  adsr.png` — **adsr is in `STRICT_VRT_MODULES` (`vrt-exemptions.ts:865`), the REQUIRED lane** — plus
  the two darwin-only composites `adsr-sustain-low` / `adsr-sustain-high`
  (`vrt-composite-scenes.ts:562-588`, which capture `.svelte-flow__node-adsr` itself) and
  `cube-adsr-midilane`. All four render the LEGACY card, whose printed text is unchanged by design.
- **VRT annotated:** `e2e/vrt/__annotated__/adsr.legend.json` enumerates four fader **testids**, not
  labels — unchanged.
- **e2e:** `e2e/tests/workflow-shell-faces.spec.ts:122` asserts the `.page-label` text and MOVES
  (`'gate → attack · decay · sustain · release'` → `'stages'`); the comment at `:107-109` needs the
  same edit. `e2e/vrt/workflow-shell-faces.spec.ts:47` (`{ type:'adsr', pages: 1 }`) is unchanged.
  **faces-parity cell count: UNCHANGED** — nothing is promoted, no cell is added; hero readouts and
  sidebar blocks are not `control-*` cells (the sidebar renders outside the shell subtree).
- **Unit pins that move:** none. `rear-card-model.test.ts:189` reads the page **id** (unchanged).
  `push-card-config.ts:73` is `['attack','decay','sustain','release']` — unchanged.
- **ART / attest: NIL, confirmed not assumed.** `art/baselines/adsr/env.sha` pins
  `dspSourceSha('adsr.dsp', 'lib/adsr-env.ts')` (`art/scenarios/adsr/profile.test.ts:74`) — neither
  file is touched, and `adsr.ts` is not in the pin. No attest basis contains an audio def.
- **CI wall-time: +0.** Two new unit files ≈ +0.2 s in the unit lane; no new e2e or VRT scene. The
  darwin/linux re-capture is a one-off dispatch, not recurring wall-time. ⚠ adsr is alphabetically
  first in faces-parity and pays SvelteKit's cold `/rack` compile — **do not shrink its budget.**

---

## 9. DEFECTS FOUND IN SHIPPED CODE (follow-ups, NOT spec content)

**9.1 — The ART audio profile for adsr pins a DIFFERENT envelope law than the module produces.**
`art/scenarios/adsr/profile.test.ts:24,48` renders `packages/dsp/src/lib/adsr-env.ts` `Envelope`,
whose decay/release are single-pole EXPONENTIALS with time-CONSTANT semantics
(`coef = Math.exp(-1/(sr*d))`, "99 % in approximately 5d" — `adsr-env.ts:79,89-90`). The shipped
module is Faust `en.adsr` (`adsr.dsp:13`): LINEAR ramps completing in exactly `d` / `r` seconds. The
assertions encode the wrong law — `:64-67` comments "exponential fall" and asserts `buf[last] > 0` at
0.6 s after gate-off with release 0.3 s, whereas **under the real module the envelope is exactly 0
from 0.9 s onward, so that assertion would FAIL against the module it claims to profile.** Cost: the
module's only ART lane is green about a synth that is not this one. The header (`:15-21`) is honest
about the substitution, so the SEMANTIC gap was known-adjacent and never noticed — worse in a way,
since it reads as covered. Catchable by a behavioral leg that reads the real worklet's `env` and
asserts it hits 0 at `gate-off + release` and is linear in between.

**9.2 — The `face.order` rank-1 argument is arithmetically wrong** (`adsr.ts:118-122`): it claims
`TRIGGER_PULSE_S` (0.005) equals the attack default so "a trigger-driven note peaks at the instant
the gate falls". Both halves fail, for the reasons derived in §1 — the canonical pulse is a triangle
above `GATE_HI` for only 2.5 ms, and `en.adsr` never thresholds at all. INFERRED peak ≈ **0.25**, not
1.0. The CONCLUSION survives and is strengthened (under trigger drive the whole audible event is a
quarter-height release) but the reasoning is not what the DSP does, and it is a comment other faces
will copy. **Also user-facing:** CLOCK → ADSR gives a quarter-height envelope; GATEMAIDEN is the fix
and nothing says so. Catchable by a behavioral test driving the real worklet with `fireTrigger` and
asserting the peak.

**9.3 — `AdsrCard.svelte:67-70` re-types the param labels** (`label="Attack"` …) while the def
declares `'A'…'R'` (`adsr.ts:95-98`) — one control, two names, three surfaces (card "Attack", dock
"A", doc page). The same two-sided-contract class `card-range-source.test.ts`'s header documents for
RingbackCard's `FB` and SnaredrumCard's `Tone` (`:55-69`) — but that file has **no label clause**,
only range/mapping/format, so nothing sees it. §7 fixes the instance; the follow-up is the gate:
**add a LABEL clause to `card-range-source.test.ts`**, and re-derive `RANGE_BOUND_FLOOR` rather than
inheriting the literal (that file's own merge warning, `:93-102`).

**9.4 — PF-20 makes a hero PICTURE unreachable for any module with ≤ 6 controls.**
`panelTierProblems` (`module-face-lint.test.ts:576`) fails a panel key SELECTED at a lane tier, and
`faceTierCap('full', …)` is 6 — so a 4-param module's 5th key is always selected and no panel is ever
legal. Its own comment warns against relying on that rank arithmetic in the *other* direction ("a
COINCIDENCE OF THE CURRENT NUMBERS, not a guarantee"); the objection is symmetric. Fix: make lane
SELECTION kind-aware — exclude panel-kind keys inside `curatedFace` for `mini`/`compact`/`full` — so
the rule holds at any cap and small faces regain the slot. Not a blocker for adsr (§5), but it
silently constrains every small module that follows.

---

## 10. VERIFICATION GATE

```sh
# 1. the derived readouts + their PERMANENT negative controls (write these FIRST)
REPEAT=3 flox activate -- task test:one -- adsr-face-model
# 2. the face gates: hero/sidebar/preset ranges, hero-split totality, page-hint legality
flox activate -- task test:one -- module-face-lint
flox activate -- task test:one -- dock-faceplate-model
# 3. the pins that must NOT move (page id, rear bands, card range/mapping/format binding)
flox activate -- task test:one -- rear-card-model
flox activate -- task test:one -- card-range-source
# 4. contract must be BYTE-unchanged — a diff here means something in §7 was not UI metadata
flox activate -- task docs:check
flox activate -- task typecheck
# 5. the structural e2e (page count + the updated .page-label text)
flox activate -- task e2e:serve
REPEAT=3 flox activate -- task e2e:one -- "adsr renders its SHELL face in-lane"
flox activate -- npx --workspace e2e playwright test per-module-per-port --grep adsr
# 6. VRT — the two that MOVE, then the ones that MUST NOT
flox activate -- task vrt:one -- face-adsr        # expect a diff on both scenes → re-pin darwin
flox activate -- task vrt:one -- adsr             # legacy card: expect NO diff (STRICT lane)
flox activate -- task e2e:stop
# 7. linux baselines, AFTER the darwin re-pin is committed on the branch
flox activate -- gh workflow run vrt-update.yml -f ref=<branch> -f platform=linux
```

⚠ The `adsr-face-model` negative controls are step 1, not step 5: if leg 2 ("sustain 0.7 → 0.3 must
NOT move the span") is not red against a deliberately wrong `r * s` implementation before you wire
the readout, the registry entry is a knob readback with extra steps.
