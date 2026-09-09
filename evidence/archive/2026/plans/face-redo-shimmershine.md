# face re-do — shimmershine

> ⚠ **PLATFORM CORRECTIONS SINCE THIS WAS WRITTEN — 2026-08-12 janitorial sweep.**
> - **The `signal-flow` sidebar kind was DELETED** (#1468, removed with its twelve
>   adopters). `packages/web/src/lib/graph/types.ts:798` now reads "THERE IS NO
>   `signal-flow` KIND, and re-adding one is the mistake this note prevents."
>   **Any `signal-flow` sidebar block proposed below is VOID** — the surviving
>   kinds are the three in `FaceSidebar.svelte`.
> - **PF-22 freed the hero rank** (#1480): `face.hero.cell` no longer consumes a
>   LANE rank, so a `panel` may now rank FIRST. Any argument below that a module
>   cannot be faced because a panel's first legal rank is 7 is OBSOLETE.
> - **A card↔face PRIMITIVE-PARITY gate now exists** (#1480,
>   `card-primitive-parity.test.ts`): ranking a param whose card binds it to a
>   primitive the platform has no cell kind for now FAILS, naming the
>   `(module, param, primitive)` triple. `XyPad` and `NoteEntry` are the two
>   declared gaps.
> - **The faceplate pipeline is PAUSED by owner directive.** This spec is BANKED,
>   not cancelled and not blocked.


> ⚠ **STATUS CORRECTED 2026-08-04 — read `face-redo-INDEX.md` §0 before building.**
> PF-20 (**PR #1301**) **HAS MERGED** (`c6ff9253`); every "unmerged branch" citation below
> now resolves on `main`. **`face.title` and `face.hint` do NOT paint by default** —
> `facePageHeader()` returns `null` before reading anything unless annotate mode is on
> (`packages/web/src/lib/ui/workflow/dock-faceplate-model.ts:90`), and the owner ruled on
> 2026-08-03 that `face.title` stays annotation-only. **§5's read-through ("with zero
> annotation the dock paints … `face.hint` (which still paints)") is FALSE.** PF-21 dock
> ROW PACKING (`9bf12df7`) also landed after this was written. **This re-do is NOT built**
> — the shipped `face` still declares no `hero` and no `sidebar`. Live backlog.
> ⚠ **§9 IS OUT OF DATE AND ITS NUMBERS HAVE MOVED.** The P0 it reports — the "crystalline
> drone" being a pure DC rail past `shimmer ≈ 0.388` — **was FIXED in #1313** (`290dcdb5`):
> a 20 Hz one-pole DC blocker on the tank output and in the loop. DC is now ≤ 0.7 % of RMS
> and the self-sustain threshold MOVED (default tank ~0.75, was ~0.39). **Do not re-derive
> this face's argument from §9's measurements** — re-measure. shimmershine was also one of
> the five modules in the stereo-silence class fixed in #1343.

**Verdict: REAL REWORK** — collapse three declaration-order bands to ONE honest `tank` band, promote
the two taps off `wet` (SHIMMER, MIX) into the PF-20 hero rail, and print the strip this module
actually has: two fixed DSP constants no knob reveals plus one exactly-derived two-knob coefficient.

> ⚠ **Read §9 before building.** While reading the DSP I measured that the module's headline
> feature — "a continuous, level-bounded crystalline drone" (`shimmershine.ts:287`) — is a **pure DC
> offset**: 100 % DC, AC ≈ 0, 0 Hz at −0.2 dB and every other bin at −311 dB. At the **shipped
> defaults** the module is already on the runaway side of the boundary. That is a P0 audio defect and
> its own owner-audition PR. It is **not** folded into this face wave, but it constrains two things
> here (which derived readout is safe, and which preset values may ship), and I say where.

---

## 1. WHAT THE MODULE ACTUALLY DOES

**Signal path, in the DSP's real order** (`packages/dsp/src/shimmershine.ts:252-275`, mirrored for
node at `packages/web/src/lib/audio/modules/shimmershine.ts:196-206`):

```
in ─┬──────────────────────────────────────────────────► × (1 − mix) ─┬─► out
    └─(+ fb)─► 4 damped combs ─► 2 allpass ─► tanh ─► wet ─► × mix ───┘
                    ▲                                 │
                    └── tanh( shifted × shimmer×0.55 ) ◄─ +12 st granular shifter
```

- **The tank** is Freeverb's first four comb tunings and first two allpasses (`1116/1188/1277/1356`,
  `556/441` at 44.1 kHz, rescaled — `dsp:50-52,95-98`). Comb feedback is `fb = 0.70 + 0.18 × size`
  (`dsp:105`) over `effSize = size × (0.5 + 0.5 × decay)` (`dsp:248`). **The delay lines never
  move** — SIZE is a coefficient, not a geometry.
- **The shimmer** is a **+12-semitone (rate 2.0)** dual-head granular shifter on a **25 ms**
  cosine-crossfade window, hard-coded at `dsp:225-226` (mirror `shimmershine.ts:190`). It reads the
  **tank output**, is scaled by `fbGain = shimmer × FB_CAP`, `FB_CAP = 0.55` (`dsp:217,250`),
  tanh-limited (`dsp:270`), and summed back at the **tank input** (`dsp:257`). **The interval is
  exposed by no param** — `2.0` is the only rate literal in the module.
- **`wet` is computed once (`dsp:262`) and tapped exactly twice** — into the loop (`dsp:266`) and out
  through the crossfade (`dsp:273`). That is the architecture the face should teach. *(Round-2's
  observation; correct, kept.)*

**What each control genuinely does** — measured by rendering the verbatim DSP math standalone
(zero-mean noise burst, 48 kHz; RT60 = peak → peak−60 dB on a 10 ms RMS envelope):

| control | what it changes | measured |
|---|---|---|
| `shimmer` | the loop gain `× 0.55` into the +12 shifter. At 0 the module **is** REVERB. | crosses into runaway at 0.39 (defaults) — see §9 |
| `size` | comb feedback 0.700 → 0.844 (at DECAY 0.6) | RT60 0.53 s → ~1.2 s at DAMP 0.4 |
| `decay` | **scales SIZE**: fb 0.754 → 0.808 at the default SIZE 0.6 | RT60 **0.64 s → 0.80 s** |
| `damp` | one-pole LP inside each comb's feedback (`dsp:66`) | RT60 0.77 s (damp .4) → **0.25 s** (damp 1) |
| `mix` | output crossfade only; the tank and loop run regardless (`shimmershine.ts:316`) | — |

**`decay` is NOT inert at spawn**, and the design program's shorthand ("a multiplier on a `size` that
can be 0", program:1381) has been read that way. At the default SIZE 0.6 a full DECAY sweep moves
measured RT60 **0.64 s → 0.80 s (+25 %)**. It is inert **only at SIZE = 0**, where fb pins at 0.700
and the sweep moves RT60 by 0.04 s — inside measurement noise. The true statement is an *authority*
one: SIZE's full sweep moves fb by 0.144, DECAY's by 0.054, so **SIZE has ~2.7× DECAY's authority**.
That is a rank argument, not an inertness argument, and the two must not be conflated.

**The one genuinely inert-at-spawn thing here is `in_r`.** The worklet writes a mono fallback
(`inputs[1]?.[0] ?? inputs[0]?.[0]`, `dsp:235`) and the **factory defeats it** — a 0-valued
`ConstantSource` into *both* worklet inputs (`shimmershine.ts:332-339`), so input 1 always exists and
the `??` never fires. A mono source into IN L comes back **hard-left**. Documented on the def
(`:12-16`); still a live bug (§9 D4).

**Facts worth printing on the faceplate:** the interval (+12 st) and grain (25 ms) — fixed, reachable
from no knob — and the comb coefficient, the one number the whole tank reduces to and which **two**
knobs multiply into.

---

## 2. WHAT THE CURRENT SHIPPED FACE GETS WRONG

The face (`shimmershine.ts:266-283`) predates PF-20 and predates PF-7.

1. **Three bands, two of which hold one control each** — `shimmer:['shimmer']` and
   `output:['mix']` (`:270-271`). That is declaration order wearing a justification: the comment
   claims "Dock bands follow SIGNAL FLOW" (`:254`) but MIX is not a stage, it is the crossfade
   applied after everything (`dsp:273`).
2. **`decay` is listed before the `size` it scales** — `pages[0].controls: ['decay','size','damp']`
   (`:269`) reads the composition backwards.
3. **The face comment's arithmetic is stale.** `:252` says `full (8)`; PF-7 made
   `faceTierCap('full')` = `PLATE_COLS × PLATE_MAX_ROWS` = **6** (`curated-face.ts:46,65`). And
   `:249-252` never mentions that with 5 cells + a glyph the meter **is dropped at the full-in-lane
   tier** (`laneBodyPlan` → `rows = ceil(5/3) = 2`, glyph survives one row only).
4. **No `title`, no `hint`, no `hero`, no `sidebar`** — every PF-20 surface is unused, so the dock
   renders a bare glyph band over three knob rows with no statement of what the module is.
5. **`damp` is ranked LAST** (`:267`) — the only param with no CV jack, hence the only one reachable
   *solely* by hand, sits where the compact tile can never show it.
6. **`glyph: 'meter'` is right and stays.** It is the only glyph that reads the module's actual
   signature (is the tail fading, blooming, or refusing to stop) at 84 px; a waveform trace of a
   diffuse wash is mush. Keep it — and see §5 for why nothing should be allowed to suppress it.

What is already right: `rear.groups` naming the input band by function rather than the derived
`signal` (`:281`); the deliberate absence of `audioRate` (every `parameterDescriptor` is `k-rate`,
`dsp:195-199`, so a `~` tick would be a lie); and the co-located `docs`, which are unusually good.

---

## 3. THE ~8 CONTROLS THAT MATTER — there are only 5

| rank | key | why it earns the rank (an argument that is WRONG for another module) | what it costs below |
|---|---|---|---|
| 1 | `shimmer` | `fbGain = shimmer × FB_CAP` (`dsp:250`) **is** the module. At 0 this is literally REVERB — the one thing that makes it a different node type. It must survive to the 1-cell mini tile. | nothing; uncontested |
| 2 | `damp` | It is the **only control that can stop a self-sustaining loop**. MIX cannot: the def's own docs say the tank and loop run regardless of MIX (`:316`) and I measured it — pulling MIX to 0 mutes the output while the loop keeps building. And it is the **only param with no CV jack** (`:218-226` declares four, not five), so the panel knob is its sole access. Both halves are wrong for REVERB (nothing self-sustains) and wrong for DELAY (feedback is the kill switch). | costs `mix` the compact tile |
| 3 | `mix` | The insert ride control; also the only stage downstream of everything. | — |
| 4 | `size` | Sets the coefficient with **2.7× DECAY's authority** (measured Δfb 0.144 vs 0.054). | — |
| 5 | `decay` | A dependent scaler cannot outrank the parameter it scales (`dsp:248`), and it is the one control with a state in which it does nothing (SIZE 0). | — |

**THE LOSERS, NAMED.** There are none — the module has exactly 5 params and the plate cap is 6, so
every control renders at every tier from `full` up. `order` therefore decides exactly **two** things:
the mini hero (cap 1) and the compact companion (`LANE_ROW_MAX_CELLS_WITH_GLYPH` = 2). Ranks 3-5 only
choose plate position. I will not dress three non-decisions up as decisions.

⚠ **Rank 2 is a taste call with a one-line revert.** The counter — "you ride MIX on an insert" — is
real. Swapping `damp`↔`mix` in `order` moves nothing else: `pages`, `hero` and the rear all derive
independently. Only `face-shimmershine-compact.png` re-pins.

⚠ **`damp` at rank 2 routes players into the §9 defect** (turning DAMP to 1 to kill a drone is
exactly the path that freezes `fbStore` at a non-zero value). The rank is still right; the DSP is
what needs fixing.

---

## 4. BAND STRUCTURE + THE ANNOTATION PROSE

**ONE band.** With SHIMMER and MIX promoted into the hero (§5), the remaining three controls are
exactly the tank — and they are one idea, not three: `size` and `decay` multiply into the comb
coefficient and `damp` is the loss inside that same comb loop. A second band would have to be
`out: ['mix']`, a one-control header the program convicts everywhere else (delay's `output blend`,
dx7's `cartridge`), and MIX is better served in the hero beside the other tap off `wet`.

```ts
pages: [
  {
    id: 'tank',
    label: 'tank',
    hint:
      'Four comb filters in parallel, each with a one-pole lowpass inside its own feedback path, ' +
      'then two allpasses for diffusion. SIZE and DECAY do not act separately — they multiply into ' +
      'ONE comb-feedback coefficient, 0.70 + 0.18 × size × (0.5 + 0.5 × decay), which runs 0.700 at ' +
      'SIZE 0 to 0.880 wide open; DECAY only scales what SIZE sets, so at SIZE 0 it does nothing at ' +
      'all. DAMP is the only loss inside that loop: every recirculation comes back darker, which is ' +
      'what keeps the stacked octaves from turning brittle. It is also the only control here with ' +
      'no CV jack.',
    // The two promoted keys stay listed: `face.hero` MOVES a key, it cannot move
    // one no band claims — leaving them off drops them into the `__unpaged` band.
    controls: ['shimmer', 'size', 'decay', 'damp', 'mix'],
  },
],
```

**Does it read with every hint hidden?** Yes, and better than the current three-band face does. With
zero annotation the dock paints: the module title + `face.hint` (which still paints), then the hero
rail — meter · SHIMMER (xl) · MIX · three labelled readouts — then one band headed **TANK** holding
SIZE, DECAY, DAMP. Nothing in that layout needs a sentence to be parsed: the header names the group,
the group is three knobs that are visibly the same idea, and the two knobs that are *not* the tank
are physically somewhere else. The hint adds the coefficient arithmetic, which is teaching, not
navigation.

---

## 5. THE HERO + THE READOUT STRIP

**`hero.cell`: NONE — deliberately.** A bespoke picture here would *cost* the module its identity:
`heroGlyph = hasGlyph && !(view === 'dock-full' && hero?.cell)` (platform `ModuleShell.svelte:353`),
so declaring a `cell` **suppresses the meter at the dock**. The meter is the only thing on the whole
faceplate that tells you whether the tail is fading, blooming or stuck — the exact question this
module exists to make you ask. The generic glyph it would otherwise use IS the right hero picture.
(An "octave ladder" diagram is drawable and module-specific, but it would be decorative unless
driven by real loop state, and it would buy that decoration by deleting the live meter.)

**`hero.control`: `shimmer`.** Rank 1, the identity knob, the one you ride.

**`hero.action`: `mix`** — a second control, not an audition. The type sanctions it explicitly
("A second `face.order` key beside it — *typically* the audition button", platform `types.ts`), the
render path is the generic `controlCell(hero.action)` (`ModuleShell.svelte:913-915`), and the lint's
panel constraint applies to `cell` only. The argument is DSP-true: **`wet` is computed once and
tapped exactly twice** — SHIMMER is the tap back in, MIX is the tap out. They are one idea rendered
as two controls, and they are the two knobs a player *rides* while the tank's three are set and left.
*Reviewer's objection, answered:* it consumes the audition slot. There is no audition today (see
below); if one lands, MIX moves back to a band in that PR.

**No audition, and this is NOT a platform blocker.** `getActiveEngine()` (`engine-ref.ts:23`) is
exported for exactly this and is already called from plain `.ts` modules, so a burst-injector button
is buildable today. Deferred because it costs a Svelte component + a `SHELL_CELLS` entry + a face key
at rank ≥ 7 + one faces-parity cell (≈ +0.8 s), and because "silent on a silent rack" argues for an
audition on *every* FX module — a follow-up across the archetype (reverb/delay/cloudseed/
shimmershine), priced once, not a shimmershine special case.

### THE READOUT STRIP — 3 entries

```ts
readouts: [
  { label: 'shifter',  text: '+12 st · 25 ms grain' },
  { label: 'tank fb',  valueId: 'shimmershine-tank-fb' },
  { label: 'channels', text: '2 tanks · no cross-feed' },
],
```

**Why two `text` entries.** Because this module's most consequential numbers genuinely *are*
constants, and a strip that padded them out with knob readbacks would be noise by correction 1's own
rule. Every one of the five params is either the hero dial or a knob in the single band directly
beneath it, so **there is no honest `paramId` readout available on this face** — that is a finding,
not a shortfall.

- `+12 st · 25 ms grain` — `new GranularPitchShifter(sampleRate, 2.0, 25)` (`dsp:225-226`; mirror
  `shimmershine.ts:190`). Rate 2.0 = one octave. Fixed at construction, exposed by no param, and it
  is the single fact that distinguishes this module from REVERB. The brief is right that this is the
  legitimate use of `text`.
- `2 tanks · no cross-feed` — `tankL`/`tankR`/`shifterL`/`shifterR` are wholly separate state
  (`dsp:205-212`) and nothing sums them. This is the module's #1 patch-time hazard stated where the
  patcher is looking (the rear card repeats it at the jack).

**The derived one: `shimmershine-tank-fb`.**

- **FORMULA** — `0.70 + 0.18 × size × (0.5 + 0.5 × decay)`, printed to 3 dp (`0.786` at defaults).
  It mirrors two DSP lines and nothing else: `const effSize = size * (0.5 + 0.5 * decay)`
  (`dsp:248`) and `const fb = 0.70 + 0.18 * size` (`dsp:105`).
- **WHY IT IS NOT A KNOB READBACK.** It is a function of **two** params that multiply. A `size`
  readback prints 0.600 and is invariant to DECAY, which genuinely moves the answer (fb 0.754 →
  0.808 across DECAY's travel, measured RT60 0.64 s → 0.80 s). A `decay` readback is invariant to
  SIZE. Neither can express that at SIZE 0 the coefficient **pins at 0.700 and DECAY stops doing
  anything** — which is the single most misunderstood thing about this module.
- **NEGATIVE CONTROL (permanent, in `shimmershine.test.ts`).** Perturb `decay` 0 → 1 at SIZE 0.6: the
  printed value MUST move (0.754 → 0.808) — a `size` readback would not. Second leg: perturb `size`
  0.2 → 0.9 at DECAY 0.6 — MUST move — a `decay` readback would not. **Third leg, must NOT move:**
  perturb `shimmer`, `mix` and `damp` across their full ranges — the coefficient is genuinely
  independent of all three, so this leg proves the function is not silently reading the whole param
  bag. Fourth: at `size = 0`, sweeping `decay` must leave it at exactly `0.700`.
- **WHERE THE MATH LIVES.** A new `packages/web/src/lib/ui/modules/shimmershine-face-model.ts`
  (kickdrum's precedent) exporting `TANK_FB_MIN = 0.70`, `TANK_FB_SPAN = 0.18` and
  `combFeedback(size, decay)`, with **`shimmershineMath` in the def importing those constants** so
  the web side keeps ONE copy. Do **not** import the def into `face-readout-values.ts` — it pulls
  `@patchtogether.live/dsp/dist/shimmershine.js?url`, and dragging a worklet URL into the shell's
  import graph for a caption is a real cost.
- **PLUS A SOURCE GREP** (kickdrum's `splitHz` precedent in `kickdrum-face.test.ts`): assert
  `packages/dsp/src/shimmershine.ts` still contains `0.70 + 0.18 * size` and
  `size * (0.5 + 0.5 * decay)`. The worklet cannot be imported from node, so this is the only thing
  between the readout and a silent worklet-side edit — and it would have caught §9 D3.

### Three readouts I considered and REJECTED

- **An RT60 "tail". REJECTED, and I measured why.** The closed-form DC decay time
  (`60 / (−20 log₁₀ fb) × L_max/sr`) tracks measurement to 2-5 % **at DAMP 0** (predict
  0.884 / 0.752 / 0.996 / 1.662 s vs measured 0.870 / 0.770 / 0.960 / 1.630 s) — and then **at DAMP 1
  it prints 0.884 s while the module rings for 0.25 s.** A 3.5× lie that moves correctly with the two
  knobs a reviewer would check: the kickdrum `sub_decay` trap wearing a new hat. A *correct*
  broadband RT60 needs an impulse render, not a per-frame pure function, and it would contradict the
  broadband numbers the def's own docs quote (`shimmershine.ts:308`).
- **`shimmer × 0.55` as a "loop gain". REJECTED** — no perturbation distinguishes it from a `shimmer`
  readback, so by the brief's own rule it *is* a param readout; and a readback of the dial two inches
  to its left is noise.
- **A "drone threshold". REJECTED reluctantly — it is the readout this module deserves.** Derived and
  validated: loop DC gain is `shimmer × 0.55 / (1 − fb)`, so the tail stops decaying at
  `shimmer = (1 − fb)/0.55`. Predicted vs measured at six (size, decay) points with DAMP ≥ 0.4:
  0.388/0.39, 0.218/0.22, 0.545/0.55, 0.447/0.45, 0.382/0.39, 0.388/0.39 — **max error 0.008** — and
  it reproduces all three numbers the def's docs report as measured (`:310`: ~0.4 / ~0.2 / ~0.55).
  **Not shipping it, because the boundary it names is the §9 defect**: past it the module charges a
  DC rail rather than droning. Printing it would enshrine a bug as a feature, and the formula changes
  the moment a DC blocker lands. **Ship it in the fix PR** — it is the best readout in the batch.

---

## 6. THE SIDEBAR

Two blocks. An empty column would be worse than a full-width editor; three would be padding.

**(a) `signal-flow` — "signal flow".** The DSP's real order, with the loop marked as a branch:

```ts
stages: [
  { label: 'IN L · R',    role: 'generator', note: 'two tanks' },
  { label: '4 COMBS',     role: 'bus',       note: 'damped' },
  { label: '2 ALLPASS',   role: 'bus',       note: 'diffuse' },
  { label: 'WET',         role: 'bus',       note: 'tanh' },
  { label: '+12 SHIFTER', role: 'bus', parallel: true, note: '× 0.55 → tank in' },
  { label: 'DRY / WET',   role: 'bus',       note: 'mix' },
],
```

⚠ **`parallel: true` on the shifter is an approximation and I am naming it.** The platform's
`FaceFlowStage` has `generator` / `bus` / `parallel`, and `parallel` means "taps earlier and rejoins
further *down*". The shifter rejoins *upstream* — it is a feedback return, not a parallel branch.
`parallel` is the only non-inline mark available and drawing it inline would teach that the shimmer
reaches the output directly, which is flatly false (only the tank output is blended, `dsp:273`), so
the approximation is strictly better than the alternative. **A `role: 'feedback'` is a real platform
gap** worth one line in `FaceFlowStage` + one branch in `FaceSidebar.svelte` — a follow-up, not a
blocker, and the `note` carries the direction meanwhile.

**(b) `presets` — "presets".** Five params, so an entry is a **complete** recall by construction — no
partial-stamp hazard, no undocumented omissions. Every value in range, applied through the ordinary
param write path.

| id | label | note | shimmer | size | decay | damp | mix | fb | runaway at |
|---|---|---|---|---|---|---|---|---|---|
| `plain-room` | PLAIN ROOM | shimmer off | 0 | 0.5 | 0.5 | 0.45 | 0.30 | 0.768 | 0.423 |
| `halo` | HALO | the house sound | 0.30 | 0.6 | 0.6 | 0.40 | 0.40 | 0.786 | 0.388 |
| `cathedral` | CATHEDRAL | long, dark | 0.12 | 1.0 | 1.0 | 0.25 | 0.50 | 0.880 | 0.218 |
| `glass` | GLASS | short, bright | 0.35 | 0.2 | 0.3 | 0.10 | 0.35 | 0.723 | 0.503 |

⚠ **THE §9 DEFECT CONSTRAINS THIS TABLE.** Every entry's `shimmer` sits at least **0.08 below** its
own `(1 − fb)/0.55` boundary, because a preset that parks the module past it ships a DC rail. That
margin is not decorative: at DAMP 0 the measured boundary runs up to 0.075 *below* the closed form,
so 0.08 is the smallest honest cushion. **Add a unit assertion in the same commit** — for every
preset, `shimmer ≤ (1 − combFeedback(size, decay))/0.55 − 0.08` — and delete both the constraint and
the assertion when the loop is fixed. Note also that **HALO is not the def defaults**: the shipped
`shimmer` default of 0.4 is already 0.012 *over* the boundary (§9), so the preset uses 0.30.

No `readouts` block (the hero strip covers it) and no `custom` panel (nothing bespoke to draw that
the flow diagram does not already say).

---

## 7. RANGE / CURVE / VOCABULARY CHANGES

**None proposed.** All five params are `0..1 linear` (`shimmershine.ts:232-236`) and are byte-for-byte
1:1 with the worklet's `parameterDescriptors` (`dsp:195-199`) — same ids, ranges and defaults. **Zero
un-exposed DSP capability at the param level**; that is a finding, not a shortfall.

Explicitly **not** adding `ParamDef.format` to `shimmer`: its boundary is a function of four params,
so a formatter reading only `shimmer` would be a control lying about itself. (Round-2 reached the
same conclusion; my measurement confirms the boundary moves 0.218 → 0.545 across the SIZE/DECAY
plane with SHIMMER untouched.)

**Card grep — re-typed numbers, both hazards, neither a live divergence today:**

- `ShimmershineCard.svelte:31-35` re-types `min={0} max={1} defaultValue={0.6|0.4} curve="linear"` as
  markup literals on all five `<Fader>`s while importing `shimmershineDef` three lines above
  (`:5`). **AGREES with the def today → hazard.** Fix: read them off the def.
- `ShimmershineCard.svelte:14-18` resolves defaults **POSITIONALLY** —
  `shimmershineDef.params[0]!.defaultValue` … `params[4]`. `contract-signature.ts` sorts params **by
  id** before projecting, so re-ordering the `params` array is **contract-transparent**: it would
  rebind all five faders to the wrong defaults with contract-lock, module-docs-lint and every ART
  row green. Fix: `params.find(p => p.id === 'decay')`. *(Credit: round-2 found this; I re-verified
  it against the current file and it is unchanged.)*

Neither fix is required by this face (the dock does not render the card), but both are one-line
boy-scout edits in the same file family and should ride along.

---

## 8. COST

- **contract-lock: ZERO lines.** `face` has no branch in `contract-signature.ts` — no param, no port,
  no `ControlFamily`, no `options`. `title`/`hint`/`hero`/`sidebar`/`readouts` are all UI metadata.
  `task docs:check` stays green with no `docs:accept` run. The page `hint` is `ModuleFacePage.hint`,
  not `docs`, so the living-docs golden is untouched too.
- **ART: NIL, verified.** `art/scenarios/shimmershine/octave-up-tail.test.ts` is a pure-math Goertzel
  assertion over `shimmershineMath` with **no `.f32`, no `art/baselines/shimmershine`, and no
  `docsStrippedRepoSourceSha`** — so no face edit can move a `.sha`. ⚠ It *does* pin the shifter to
  rate 2.0 (440 → 880 Hz), which is why the deferred `interval` param must default to 2.0.
- **Attest: NIL.** Audio def, not in the WebGL basis (no `docs-hash-ignore` markers needed), and
  absent from the collab-attest basis.
- **VRT — which move:**
  - `workflow-shell-faces.spec.ts/darwin/face-shimmershine-dock.png` — **certain, enormous** (3 bands
    → 1, a new title/hint/hero rail/sidebar). Far over `DOCK_MAX_DIFF = 1500` (`spec:79`).
  - `workflow-shell-faces.spec.ts/darwin/face-shimmershine-compact.png` (88×82) — **⚠ the
    sub-tolerance trap.** Promoting DAMP to rank 2 changes the second column's *label only*: `mix`
    and `damp` share the identical default 0.4 (`shimmershine.ts:235-236`), so the pointer angle is
    pixel-identical. ~50-70 ink px against `COMPACT_MAX_DIFF = 150` (`spec:78`). The gate PASSES and
    `--update-snapshots` writes **nothing**. **`git rm` both darwin baselines before regenerating**
    (A2/#1213 verbatim); treat a green regen that commits zero files as a red flag.
  - **Structural gate, same commit:** `e2e/vrt/workflow-shell-faces.spec.ts:56`
    `{ type: 'shimmershine', pages: 3 }` → `pages: 1`. The assert at `:227`
    (`[data-testid="face-page"]` `toHaveCount(pages)`) runs **before** the pixel pin.
  - **Which must NOT move:** `vrt.spec.ts/{darwin,linux}/shimmershine.png` — the LEGACY card, and
    shimmershine is in `STRICT_VRT_MODULES` (`vrt-exemptions.ts:894`), i.e. the **REQUIRED
    `vrt-strict` lane**. This spec edits no card, so a diff there is a **finding, not a re-pin**.
  - **Linux:** `linux/face-shimmershine-{compact,dock}` are in `EXEMPT_BASELINE_PAIRS` at
    **`vrt-exemptions.ts:1059-1060`** (both round-2 and the program cite drifted numbers — grep, do
    not copy). Recommended: **drain both and lower `SHARED_LINUX_PAIR_CEILING` 91 → 89
    (`vrt-meta.test.ts:333`) and `LINUX_DEFICIT_CEILING` 148 → 146 (`:562`) in the SAME commit**,
    then dispatch `vrt-update.yml -f platform=linux`, **unscoped**, and approve the
    `action_required` follow-on. ⚠ Round-2's claim that forgetting the ratchet is "invisible to CI"
    is now **stale** — both ceilings are asserted in *both* directions (`:526`, `:619`), so a drain
    without the re-pin goes red on "THE CEILING HAS GONE SLACK". Draining is optional; if you skip
    it, change nothing and stay darwin-only.
- **e2e:** faces-parity cell count unchanged at **5** (no param added; the hero *moves* keys, and
  `heroFacePlanIsTotal` is asserted on every faced module), so its per-cell budget does not move.
- **CI wall-time:** `vrt-strict` +0 s (`VRT_STRICT=1` narrows to `vrt.spec.ts`, which this does not
  touch). Unit lane ~0 (a handful of pure assertions; no new file boots a browser). Informational
  `vrt` lane **+~18 s** *only if* the two linux pairs are drained — `workflow-shell-faces.spec.ts` is
  FULL_MATCH-only at `workers: 1`, ≈ 8-10 s per newly-unskipped scene. **0 s if not drained.**
  Nowhere near the ~2 min sign-off threshold either way.

---

## 9. DEFECTS FOUND IN SHIPPED CODE

**All four are follow-up bugs with their own PRs. None is spec content.** The first is P0.

### D1 — [P0] The "crystalline drone" is a DC RAIL, and the shipped defaults are already past it

**What.** Past a sharp boundary in SHIMMER the module does not sustain a shimmer tail — it charges a
**pure DC offset** and parks there until you turn SHIMMER down.

**Measured** (verbatim DSP math, standalone, 48 kHz, zero-mean noise burst then silence, wet output,
tank at its defaults, t = 25 s):

| shimmer | rms | DC | AC | DC / rms |
|---|---|---|---|---|
| 0.40 (the **default**) | 0.0119 | 0.0119 | 0.0002 | **100.0 %** |
| 0.55 | 0.8085 | 0.8085 | 0.0000 | **100.0 %** |
| 1.00 | 0.9803 | 0.9803 | 0.0000 | **100.0 %** |

Spectrum of the sustained state at SHIMMER 1: **0 Hz at −0.2 dB**; 10/20/40/80/160/320/640/1280/
2560/5120/10240 Hz all between **−311 and −323 dB**. There is no audio in it at all.

**Why** (`dsp:63-70, 80-88, 105, 217, 248-274`). The comb's steady-state DC gain is `1/(1−fb)`
(≈ **4.67** at defaults); the damping one-pole has **unity DC gain** for any `damp < 1`
(`(1−damp)/(1−damp)`), so DAMP cannot attenuate DC at all; the Schroeder allpass passes DC at unity;
and the shifter's two Hann head-gains sum to exactly 1, so it passes DC at unity too. **There is no
highpass or DC blocker anywhere in the loop.** Round-trip DC gain is `shimmer × 0.55 / (1 − fb)`,
crossing 1 at `shimmer = (1 − fb)/0.55` — long before any octave-stacking could matter. Max error vs
measurement **0.008** at DAMP ≥ 0.4; at DAMP 0 the measured boundary runs 0.03-0.08 *lower* (with the
LP wide open the neighbouring low modes reach unity slightly sooner).

**What it costs a user.** The **shipped default is `shimmer = 0.4`** (`shimmershine.ts:233`) against a
boundary of **0.388** — so a freshly spawned shimmershine with anything patched into it slowly
charges DC on both outs, scaled by MIX. At SHIMMER 1 / MIX 1 that is a **+0.98 DC rail**: no
headroom, asymmetric clipping on anything summed with it, speaker offset downstream. The docs
describe it as the feature — *"parked on the edge: the tail keeps a faint halo that very slowly
blooms"* (`:310`) — and that faint slow bloom **is** the DC ramp. `:287` promises "a continuous,
level-bounded crystalline drone"; the level bound is real (tanh), the crystalline part is not.

**Could a test catch it?** Yes, cheaply, and none does — `shimmershine.test.ts` exercises only the
Hann window and the shifter's 440 → 880 Hz spectrum, and the ART scenario is the same Goertzel. The
missing assertion is one line: render `shimmershineMath.renderShimmer` at the defaults for ~20 s and
assert `|mean(tail)| < ε`. A DC gate belongs on every recirculating module in the rack.

**Likely fix (owner audition, not this PR):** a one-pole DC blocker in the feedback path. It changes
the sound *and* the boundary formula — which is why the threshold readout waits for it (§5).

### D2 — [MED] `damp = 1` freezes the LP state at its LIVE value, not at zero — and seeds D1

**What.** `this.fbStore = this.fbStore * damp + y * (1 - damp)` (`dsp:66`, mirror
`shimmershine.ts:63`). At `damp === 1` this is `fbStore = fbStore` — it freezes at **whatever it
was**, injecting a constant `fbStore × fb` into every comb write forever.

**Measured.** Ramping DAMP 0.4 → 1 mid-ring leaves a persistent DC of **3.1e−3** (mean == rms to four
digits — pure DC), still there 3 s later. The control — spawning *at* `damp = 1`, where `fbStore`
never leaves 0 — gives **exactly 0.000e+0**. Across eight flip instants 11 ms apart the residue
ranged **+2.2e−3 to −2.3e−2**: sign and magnitude are arbitrary, set by whatever the LP happened to
hold. It does **not** clear when DAMP comes back down (−9.0e−3 → −1.4e−2), because D1's loop then
amplifies it. Two shipped comments assert the opposite — `shimmershine.ts:36` and `docs.controls.damp`
at `:314` both say the state "freezes at zero", which is true only from a cold spawn.

**What it costs.** "Turn DAMP up to kill the drone" is the documented panic move, and §3's rank-2
argument sends players straight down it. Fix: `damp >= 1 ⇒ fbStore = 0`, or clamp `damp` to ~0.999.
**Test:** the same DC assertion as D1, with a mid-render param change.

### D3 — [LOW] Two DSP comments contradict the code beneath them: 0.92 vs 0.88

`packages/dsp/src/shimmershine.ts:33` ("Internal tank comb feedback also self-caps at 0.92") and
`:247` ("size=1, decay=1 → comb fb ≈ 0.92") both contradict `:105`, where `fb = 0.70 + 0.18 * size`
maxes at **0.880**. The web mirror (`shimmershine.ts:94-97`, "pulled back from 0.92") and the
authored docs (`:312`) have it right. Costs a reader a wrong stability model. The §5 source-grep
guard would have caught it. *(Round-2 found this; I re-verified both lines.)*

### D4 — [LOW, already documented] `in_r` is not normalled, because the factory kills the fallback

The worklet writes `inputs[1]?.[0] ?? inputs[0]?.[0]` (`dsp:235`) — an explicit mono fallback — and
the factory defeats it by connecting a 0-valued `ConstantSource` into **both** worklet inputs
(`shimmershine.ts:332-339`), so input 1 always exists as a silent channel. A mono source into IN L
comes back **hard-left**. Documented on the def (`:12-16`) but still live; the dead `??` is code
expressing an intent the factory cancels. Fix is a judgement call (drop the right-hand
`ConstantSource` and let the fallback fire, vs. keep the stable channel count), so it needs an owner
call, not a drive-by. The rear label `stereo in · patch BOTH` mitigates it meanwhile.

---

## 10. VERIFICATION GATE

Run in this order. Nothing here needs a full suite.

```sh
# 1. the face declaration itself — hero promotion totality, readout resolution,
#    sidebar preset ranges, the registered valueId, rear derivation totality.
flox activate -- task test:one -- module-face-lint

# 2. THE DERIVED READOUT'S NEGATIVE CONTROL (§5) — the whole point of the entry.
#    Must contain all four legs: decay moves it, size moves it,
#    shimmer/mix/damp must NOT, and size=0 pins it at exactly 0.700.
REPEAT=3 flox activate -- task test:one -- shimmershine

# 3. the model the hero split runs through
flox activate -- task test:one -- dock-faceplate-model
flox activate -- task test:one -- rear-card-model

# 4. contract must be BYTE-IDENTICAL — a diff here means something non-face moved
flox activate -- task test:one -- contract-lock
flox activate -- task docs:check

# 5. the ratchets, IF the two linux pairs are drained (both directions assert now)
flox activate -- task test:one -- vrt-meta

# 6. faces-parity: 5 control-* testids, multiset-equal to the def, hero included
flox activate -- task e2e:serve
REPEAT=3 flox activate -- task e2e:one -- "faces-parity"

# 7. VRT — git rm FIRST or the compact pin silently stays stale (§8)
git rm e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/darwin/face-shimmershine-{compact,dock}.png
REPEAT=3 flox activate -- task vrt:one -- shimmershine
flox activate -- task e2e:stop

# 8. svelte-check is stricter than vitest
flox activate -- task typecheck
```

**Deferred, each its own PR, none folded in here:** D1's DC blocker (owner audition — and it unlocks
the drone-threshold readout of §5); D2's `damp = 1` clamp; the `interval` param (default **must** stay
2.0 — the ART scenario asserts 880 Hz from 440 Hz); the `damp_cv` jack (⚠ it would let CV drive DAMP
to exactly 1, i.e. straight into D2, and it removes the rank-2 argument in §3 — re-rank in that PR);
a `role: 'feedback'` stage mark on `FaceFlowStage` (§6); and the archetype-wide audition cell (§5).
