# face re-do — snaredrum

> ⚠ **Read `face-redo-INDEX.md` §0 first.** Two owner rulings (2026-08-11) void
> the prose half of this spec: a face declares **no `title`, no `hint`, no page
> `hint`** (explanation goes to `docs`, read by right-click → annotate), and the
> **`signal-flow` sidebar kind is DELETED**. Both are struck below. The faceplate
> pipeline is PAUSED; this is not a queue item.
>
> ✅ Ledger defect #25 (the wire bed panning to the WRONG side during a roll) is
> **FIXED** — one shared `panSideGain` helper, #1328 (`snaredrum-dsp.ts:596`).
>
> ✅ **PF-22 (#1480) removed the rank floor this spec was written under.**
> `laneOrder(face)` now drops `face.hero.cell` from the ranking a LANE tier sees,
> so a hero picture no longer has to be ranked 7th-or-later to escape the 6-cell
> lane budget. §3's "first legal panel rank" arithmetic is obsolete — rank the
> picture wherever it honestly belongs.

**Verdict: REAL REWORK** — but a *structural* one, not a re-ranking: the six-cell
lane and the five bands are right and stay unchanged; what the platform adds is a
hero rail whose ACTION slot holds only ONE key while this module has TWO
auditions, and resolving that honestly is what moves the face — HIT to the hero,
ROLL down into the `roll` band where its own docs already say it belongs.

---

## 1. WHAT THE MODULE ACTUALLY DOES

Read: `packages/web/src/lib/audio/modules/snaredrum.ts` (def+face+docs),
`packages/dsp/src/snaredrum.ts` (worklet),
`packages/dsp/src/lib/snaredrum-dsp.ts` (voice+bed+bus),
`packages/dsp/src/lib/snare-roll-dsp.ts` (the roll engine),
`packages/web/src/lib/ui/modules/SnaredrumCard.svelte` (legacy card).

**The signal path, in the DSP's real order** (`snaredrumStepStereo`):

1. **TRIGGER edge** — one pool voice, `vel` latched, bed re-excited,
   `bedPanTarget = 0` (a single hit is *always* centred).
2. **ROLL engine** (→ `rollStep`, `snare-roll-dsp.ts`) — two hand phases 180°
   apart at `rollHandHz = clamp(4·6^roll_speed · 2^cv, 1, 40)` (`:97`); each
   hand-beat schedules a bounce train from `bounceSchedule` (`:122`), velocities
   `r^k` with `r = 0.5 + 0.25·bounce`, spacing `τ = 0.18/handHz` shrinking by
   `GSPACE = 0.7` and floored at 4 ms.
3. **Per-voice generators** (`snareVoiceStep`) — HEAD (4 self-ringing Chamberlin
   modes at Bessel ratios `1 : 1.03 : 1.593 : 2.135`), BODY (band-passed noise at
   the same drifting centre), CRACK (a **fixed 6 ms** tick, `CRACK_LEN_MS`, summed
   *outside* `VOICE_NORM` with `CRACK_GAIN = 5.0`). `tone` crossfades HEAD↔BODY
   inside the voice.
4. **Pool sum** — constant-power pan, `1/√nact` normalisation, then the `tone`
   tilt as a *voice-vs-bed* opposition: `voiceG = 1 + 0.8(t−0.5)`,
   `bedG = 1 − 0.8(t−0.5)`.
5. **WIRE BED** — a **top-level, shared, re-excitable** generator, not per-voice.
   `bedEnv += wire·vel` on every strike (`exciteBed`), decaying at
   `wire_decay · (1 − 0.6·damp)`; a `contact` term rides the rectified head
   displacement on top.
6. **Bus** — `DRIVE → DC block → LEVEL → per-channel tanh CEILING`, **on the MID
   ONLY**. The SIDE signal (`sidePool + wireSide`) **bypasses the shaper and the DC
   blocker** and rejoins at `out[0] = tanh(g(m+sd))`, `out[1] = tanh(g(m−sd))`.
7. **CHOKE** (worklet) — multiplies both channels *post*-ceiling.

**What each control genuinely changes about the sound, where the label
under-states it:**

- `wire` is TWO controls in one — the bed's *level* AND how hard every strike tops
  the bed up (`exciteBed(s, wireAmt, vel)`), so it is simultaneously "is this a
  snare or a tom" and "does the roll sustain". Nothing else on the module has that
  dual role.
- `damp` (label `G Damp`) scales **three** decays together, `×(1 − 0.6·damp)` —
  head, body, bed — and tightens the modal ring through `ringMs`. One cell, three
  tails.
- `damping` (label `Damp`) is the head bank's **Q**, applied *on top of* the
  damping `head_decay` already sets (`qBase = (0.05 + damping·0.45)(1 −
  ringReduce)`), so it keeps its full relative range at any decay length.
- `bounce` sets the roll TYPE, but **jointly with `roll_speed`**:
  `rateFactor = (24 − handHz)/20`, so slower hands grow more rebounds. Verified
  against the docs' own claims: at handHz 24 even `bounce = 1` yields N = 2 (a
  plain double); at handHz 4, `bounce = 0.6` yields N = 4. The authored prose
  checks out exactly.
- `spread` is a **ROLL-ONLY** control (a trigger hit sets `bedPanTarget = 0` and
  `tuneMul = 1`), and it also scales the humanize *detune* share.

**INERT AT SPAWN / conditional:** `spread` does nothing until the roll gate runs.
`hard` does nothing until `drive > 0` (the shaper is bypassed outright at
`driveAmt ≤ 0.001`). `humanize`'s detune half is scaled by `spread`, so at
Spread 0 it only jitters timing and velocity.

**Measurable facts worth printing on the faceplate** (all re-derived here, not
copied):
- per-hand rate at the default `roll_speed = 0.5` → `4·√6 = 9.80 Hz`; sub-strokes
  per hand-beat at `bounce = 0.35` → `maxB = 3`, `rateFactor = 0.7101`, **N = 3**;
  composite **58.8 sub-strokes/s**.
- the new-voice budget is **70/s** (`ALLOC_RATE_CAP`, `snare-roll-dsp.ts:49`) over
  a **10**-voice pool (`MAX_VOICES`) — so at defaults every stroke gets a voice,
  and at `roll_speed = 1` (96/s) about 27 % are bed-only.
- the bed's −60 dB decay at defaults is `260 × 0.88 = 228.8 ms` against a **17 ms**
  inter-stroke interval. That ratio *is* why the roll is continuous, and it is
  currently only reachable by ear.

---

## 2. WHAT THE CURRENT SHIPPED FACE GETS WRONG

The face (`snaredrum.ts:228-283`, pinned by a 336-line `snaredrum-face.test.ts`)
is **largely right**. The lane ranking (`tune, wire, roll_speed, bounce, damp,
tone`) is well-argued and I change **none** of it. Four genuine gaps, all still
true on `main` (verified 2026-08-12):

1. **No `hero`, no `sidebar`** — the PF-20 surface is unused. (The `title` /
   `hint` half of this gap is void per §0: it is not to be filled.)
2. **The ROLL pad is in the wrong band, and the def's own docs say so.**
   `docs.controls['snaredrum-roll-{n}']` reads: *"Press it with ROLL SPEED and
   BOUNCE under your other hand — that is the whole reason those two rank into the
   lane."* The face then puts that pad in band `drum` (`:262`), **four bands away**
   from `roll_speed` and `bounce` (`:271`). The prose and the layout contradict
   each other. This is not a platform consequence — it was wrong on the day it
   shipped, and it is still wrong.
3. **`damping` ('Damp') and `damp` ('G Damp') are two knobs one character apart,
   in DIFFERENT bands** (`drum` and `whole`), doing unrelated things (mode Q vs. a
   three-tail scaler). Separating them removed the only disambiguation the card had
   (its `HEAD` group header). Still `label: 'Damp'` at `:99` and
   `label: 'G Damp'` at `:110`.
4. **No `format` on any of the 22 params** (`:96-120`), while kickdrum attaches
   `fmtHz`/`fmtMs`/`fmtDb`/`fmtAmount` to all of its. The dock prints `4500` where
   its sibling prints `4.5 kHz`. ⚠ Under the no-prose ruling this is now the
   *primary* mechanism a faceplate has for saying anything, so it is promoted from
   polish to core.

Explicitly NOT wrong, and not touched: the six-cell lane; the `whole drum` band's
existence; the glyph accounting (a ≥4-cell `full` face drops the glyph); the rear
field; the `strike · hit or hold` cluster caption.

---

## 3. THE RANKING

**Ranks 1–6 are UNCHANGED.** Re-cutting a ranking that was itself rebuilt on a
good argument would be churn, and the program's own anti-pattern list names
"proposing a ranking identical to the existing one and presenting it as a
redesign" — the honest inverse is to say plainly that this one is already right.

| # | key | why THIS module ranks it here (wrong for any other module) | cost below |
|---|---|---|---|
| 1 | `tune` | the modal bank *and* the body noise centre both track it — a 1-cell mini tile can say nothing else useful | — |
| 2 | `wire` | the only control whose extreme turns this into a **different instrument** (a tom), *and* the master of the roll's sustain (`bed += wire·vel`) | pushes `tone` out of the compact pair |
| 3 | `roll_speed` | the DEF ITSELF says this knob is expected to move: it is the **only** param with a dedicated audio-rate node input (`roll_speed_cv`, read raw per sample) while 21 others get an 80 Hz-smoothed AudioParam | — |
| 4 | `bounce` | ranking a mechanism's rate without its type is exactly what the pre-`f5cb7550` face did | — |
| 5 | `damp` | one cell moving three tails; the natural counterpart to a buzz roll, whose overlapping tails are what turn a press roll into mud | demotes `head_decay` |
| 6 | `tone` | the whole-drum bright↔fat tilt, and the only knob that moves voice and bed in *opposition* | demotes `crack` |

**THE LOSERS, NAMED.** `head_decay` — `damp` moves that tail and two others from
one cell. `crack` — the level of a *fixed* 6 ms tick; an attack you set, not one
you ride. `damping` — a relative Q on top of a decay already ranked.
`spread`/`humanize` — inert or near-inert until a roll runs.
`wire_tone`/`wire_decay`/`crack_tone`/`body_decay`/`pitch_amt`/`pitch_time` —
sound-design, set once. `drive`/`hard`/`ceiling`/`width` — bus. `level` — stays
out on the drum-family rule: it is applied to mid *and* side **before** the
ceiling, so it is a saturation lever, not a fader, and promoting it invites the
misuse the ranking exists to prevent.

**Ranks 7+ (dock-only)** gain `'snaredrum-hero-{n}'`, THE PICTURE. ⚠ **This spec
originally placed it at rank 8 because a panel's first legal rank was 7** —
`module-face-lint` refuses a panel SELECTED at a lane tier and the lane budget is
6. **PF-22 removed that floor** (`curated-face.ts:73-85`): `laneOrder` drops
`face.hero.cell` before the lane slice, so the picture may rank wherever it
honestly belongs and still cannot reach a 46 px knob column.

⚠ **PUSH CARD: does not move.** No snaredrum override in `push-card-config.ts`, so
the card is the first 8 **turnable params** of `face.order`; families are skipped.
That set is `tune, wire, roll_speed, bounce, damp, tone, damping, head_decay`
before and after.

---

## 4. BAND STRUCTURE

Five bands, ids **unchanged** (`drum/snap/roll/whole/bus` — the rear-derivation
totality assert at `snaredrum-face.test.ts:285` and the structural gate
`{ type: 'snaredrum', pages: 5 }` both stay green). ~~Page `hint`s~~ are struck
per §0. Labels gain the kickdrum-style **stage numbers** on the three generator
bands; the two bus bands stay unnumbered because they are one chain.

```
1 · drum — head + body   snaredrum-hero-{n}, snaredrum-hit-{n}, tune, damping,
                         head_decay, body_decay, pitch_amt, pitch_time
                         cluster: pitch drop = [pitch_amt, pitch_time]
2 · snap — wires + stick wire, wire_tone, wire_decay, crack, crack_tone
3 · roll — two hands     snaredrum-roll-{n}, roll_speed, bounce, humanize, spread
whole drum               tone, damp
bus · out                drive, hard, ceiling, width, level
```

Notes that are load-bearing rather than decorative:

- `snaredrum-hero-{n}` and `snaredrum-hit-{n}` are **listed in band 1 and must
  be** — `face.hero` PROMOTES a key it can only move if some band already claims
  it; leaving them off drops them into the defensive `__unpaged` band. (Since
  #1480 the promotion also *removes the band* if it empties one — not a risk here,
  band 1 has six other keys.)
- `snaredrum-roll-{n}` leads band 3 and is **un-clustered**, because clusters
  render *after* the band's flat row — a clustered pad can never lead a band. This
  move is the fix for §2 defect 2.
- No page id is `voice` and no page label contains the word `strike` (the rear owns
  it) — the two assertions at `snaredrum-face.test.ts:288-309`. `'stick'` is not
  `'strike'`; verify the substring test still passes on the new label.
- Rear band labels after the rename: `strike · performance`, `1 · drum — head +
  body`, `2 · snap — wires + stick`, `3 · roll — two hands`, `whole drum`,
  `bus · out`. **No label prefixes another** (the lint rule that exists for
  kickdrum's two adjacent `STRIKE` bands).

**Does this face read correctly with no prose at all?** That is now the only test
that matters, and it is the one this band cut was designed to. Each label carries a
stage number and a two-noun name (`snap — wires + stick`); the hero rail says what
the module is; the readout strip prints the roll's density and the drum's ring;
and every value gets a `format` (§7.3) so no dial prints a bare coefficient.

---

## 5. THE HERO + THE READOUT STRIP

**`hero.cell` — YES, a bespoke picture, and it is NOT kickdrum's.** The generic
alternative is the `scope` glyph, which is a live trace of the output and
therefore **flatlines on a silent rack** — and this voice makes no sound at all
until something strikes it, so the glyph is blank exactly when a player is
deciding what to do. (Declaring a `cell` suppresses the dock glyph; it is untouched
at mini and compact.) The picture:

- **Top — the ROLL GRID.** Two lanes (L / R) over the selected window; each
  hand-beat drawn at `1/rollHandHz(roll_speed, 0)` with its bounce train at
  exactly the offsets and velocities `bounceSchedule(bounce, handHz, sr)` returns;
  sub-strokes past the 70/s budget drawn hollow (bed-only). Both functions are
  already **exported** from `snare-roll-dsp.ts`, so the panel imports the DSP's own
  law by relative path (the `kickdrum-face-model.ts` precedent) and re-types
  nothing.
- **Bottom — the WIRE-BED envelope.** The bed's sawtooth: `+= wire·vel` per
  stroke, clamped at 1, decaying at `wire_decay·(1 − 0.6·damp)`. If it never
  reaches the floor the roll is continuous; if it does, you *see* the gaps. This is
  the module's central relation and there is no other way to read it.
- **Probe** (required by PF-14): a WINDOW button (250 ms / 1 s / 4 s) held in
  **component state, not `node.data`** — a private view setting must not re-zoom
  every collaborator's screen. So `{ testid: 'snaredrum-grid-window', action:
  'click', effect: { kind: 'text', testid: 'snaredrum-grid-axis', expect:
  'changed' } }` — drive the button, assert the AXIS LABELS moved, never the
  button's own text. Exactly kickdrum's shape and for the same reason.

The picture answers *"what will a roll look like"*; the `tail` readout answers
*"how long does one hit ring"*. Neither is derivable from the other, which is why
both exist.

**`hero.control` = `wire`.** *(Taste call — see the revert.)* `tune` stays rank 1
because that is the answer to a different question (what can a ONE-CELL mini tile
say). The hero dial sits beside a picture whose whole subject is the wire bed, and
`wire` is the only control on this module that changes what instrument it is *and*
the only one that couples the two halves of the faceplate. It also demonstrates
the strip's own derivation: turning it visibly moves `tail` and pointedly does
**not** move `strokes`.
**Revert:** set `hero.control: 'tune'` and change readout 3 to
`{ label: 'wires', paramId: 'wire' }`. Nothing else moves.

**`hero.action` = `snaredrum-hit-{n}`.** The slot takes exactly ONE key
(`ModuleFaceHero.action`), and this module has two auditions. HIT is the universal
drum audition — the same cell kickdrum, tomtom and karplus all put here — so it
goes in the rail; ROLL is this module's *mechanism* and belongs beside the
mechanism's knobs. **This is the one place snaredrum genuinely cannot mirror
kickdrum, and the resolution improves the face rather than compromising it** (it
is what fixes §2 defect 2).

**THE READOUT STRIP — three entries, full-width beneath the picture:**

| label | source | prints at defaults |
|---|---|---|
| `strokes` | `valueId: 'snaredrum-roll-rate'` | `59 /s` |
| `tail` | `valueId: 'snaredrum-tail'` | `179 ms` |
| `head` | `paramId: 'tune'` | `180 Hz` |

Three, not five: the strip is the most-read line on the faceplate and I could not
defend a fourth. `tune` earns its slot only because it is **not** the hero dial
under this proposal — under the revert it must be swapped out, or it becomes
exactly the "repeats the knob above it" noise.

**`snaredrum-roll-rate` — formula + negative control.**
`2 × rollHandHz(roll_speed, 0) × bounceSchedule(bounce, handHz, sr)` — the
exported laws at `snare-roll-dsp.ts:97` and `:122`, evaluated at `MODEL_SR`. At
defaults `2 × 9.798 × 3 = 58.8 → 59 /s`.
- **NEGATIVE CONTROL (must move):** perturb `bounce` 0.35 → 0. N drops 3 → 1 and
  the readout goes 59 → 20 /s, while a `roll_speed` knob readback stays `0.50`.
  This is the perturbation that distinguishes the two models.
- **SECOND LEG (must NOT move):** perturb `wire` 0.7 → 0. `RollParams` carries only
  `rollSpeed/rollSpeedCv/bounce/humanize/spread` — `wire` never enters the
  schedule, so the number is unchanged. This is what stops the function drifting
  into "sum whatever params are nearby".
- **THIRD LEG (must NOT move):** perturb `humanize`. It jitters offsets
  (`±0.08·period`) but not the *count*, so the mean density is invariant.
- Lives permanently in `snaredrum-face-model.test.ts`.

**`snaredrum-tail` — formula + negative control.**
The −60 dB point of the summed amplitude envelope, each layer at its own live mix,
solved by bisection (the `kickdrumTailMs` shape):
`head = tone·VOICE_NORM @ head_decay·(1−0.6·damp)`,
`body = (1−tone)·VOICE_NORM @ body_decay·(…)`,
`crack = crack·CRACK_GAIN @ 6 ms`, `bed = wire·bedG @ wire_decay·(1−0.6·damp)`.
At defaults: weights `0.31 / 0.31 / 2.00 / 0.70`, peak 3.32, → **179 ms**.
- **NEGATIVE CONTROL (must move):** perturb `wire` 0.7 → 0. The 229 ms bed leaves
  the sum entirely and the tail collapses to **109 ms** — while a `wire_decay`
  readback still says `260 ms`. That is the kickdrum `sub_decay` trap in this
  module's clothing.
- **SECOND, non-obvious leg (must move):** perturb `crack` 0.4 → 0. Crack's weight
  is `0.4 × CRACK_GAIN 5.0 = 2.0` — it *dominates the peak*, so removing it LOWERS
  the −60 dB floor and the tail grows **179 → 209 ms**. No decay knob on the module
  shows this, and nobody would guess a 6 ms tick lengthens the tail by 30 ms.
- **THIRD LEG (must NOT move):** perturb `roll_speed`. The tail is a single-hit
  quantity.

⚠ These are the only two derived readouts I could defend. A `roll_speed`-only
"hands/s" figure is a monotone bijection of one knob — I cannot name a
perturbation that distinguishes it from a knob readback, so it is **not** a derived
readout and it is not declared. Saying so is the honest answer.

---

## 6. THE SIDEBAR

Two blocks. ~~A `signal-flow` block was drafted and is STRUCK~~ — the kind was
deleted from the platform (INDEX §0). Two findings from drafting it survive
independently of the ruling, because both are facts about the DSP:

- **`SIDE` is genuinely parallel and it is a correctness fact, not decoration:**
  `side` is formed at the pool sum and rejoins only at the output matrix, never
  entering the shaper or the DC blocker. Any picture that draws it inline teaches
  a producer that DRIVE colours the stereo image. It does not.
- **The `stereo-crossover` custom panel kickdrum uses must NOT be copied here.**
  snaredrum has **no crossover**: `width` decorrelates the wire band with no
  frequency split anywhere in `snaredrumStepStereo`, so that panel would paint a
  split that does not exist.

**1. `presets`** — snaredrum has none anywhere today. Five entries, **each a
complete 22-param voice** (a partial recall whose omissions are undocumented is
worse than either honest option), every value re-checked against the declared
ranges at `snaredrum.ts:96-120`:

| id | label | note | the argument |
|---|---|---|---|
| `rock` | ROCK | 160 Hz | big and ringy — long head, wires up, light damp |
| `tight-funk` | TIGHT FUNK | 250 Hz | high, short, heavily damped; bright wires |
| `press-roll` | PRESS ROLL | buzz | **the showcase**: slow hands + `bounce 0.9` + `wire_decay 520` |
| `piccolo` | PICCOLO | 340 Hz | very high, papery, crack-forward |
| `gated-80s` | GATED 80s | hard | `drive 0.8`, `hard 1`, `ceiling 0.85`, wide |

```ts
rock:       { tune:160, tone:0.55, damping:0.30, head_decay:260, body_decay:150, pitch_amt:4,  pitch_time:22,
              wire:0.75, wire_tone:4200, wire_decay:320, crack:0.50, crack_tone:3000, damp:0.10,
              roll_speed:0.45, bounce:0.30, humanize:0.25, spread:0.50,
              drive:0.30, hard:0, ceiling:0.55, width:0.45, level:0 }
tight-funk: { tune:250, tone:0.40, damping:0.65, head_decay:90,  body_decay:60,  pitch_amt:2,  pitch_time:10,
              wire:0.85, wire_tone:5600, wire_decay:130, crack:0.60, crack_tone:4200, damp:0.45,
              roll_speed:0.60, bounce:0.20, humanize:0.30, spread:0.45,
              drive:0.20, hard:0, ceiling:0.50, width:0.35, level:0 }
press-roll: { tune:175, tone:0.45, damping:0.35, head_decay:150, body_decay:100, pitch_amt:3,  pitch_time:16,
              wire:0.95, wire_tone:4800, wire_decay:520, crack:0.25, crack_tone:3400, damp:0.05,
              roll_speed:0.25, bounce:0.90, humanize:0.35, spread:0.60,
              drive:0.15, hard:0, ceiling:0.45, width:0.55, level:-1 }
piccolo:    { tune:340, tone:0.30, damping:0.55, head_decay:70,  body_decay:45,  pitch_amt:2,  pitch_time:8,
              wire:0.80, wire_tone:7200, wire_decay:180, crack:0.70, crack_tone:5200, damp:0.35,
              roll_speed:0.70, bounce:0.25, humanize:0.20, spread:0.40,
              drive:0.15, hard:0, ceiling:0.50, width:0.50, level:1 }
gated-80s:  { tune:140, tone:0.60, damping:0.25, head_decay:380, body_decay:220, pitch_amt:6,  pitch_time:30,
              wire:0.60, wire_tone:3400, wire_decay:420, crack:0.45, crack_tone:2400, damp:0.00,
              roll_speed:0.50, bounce:0.35, humanize:0.15, spread:0.35,
              drive:0.80, hard:1, ceiling:0.85, width:0.60, level:-2 }
```

PRESS ROLL is worth checking by hand because it is the entry that proves the
readouts: `handHz = 4·6^0.25 = 6.26`; `bounce 0.9 → maxB 6`, `rateFactor 0.887`,
**N = 6**; density `2 × 6.26 × 6 = 75 /s` — deliberately just **past** the 70/s
budget, so ~7 % of sub-strokes drive the bed alone, which is precisely what a dense
buzz is. The bed decays at `520 × 0.97 = 504 ms` against a 13 ms interval. The
strip will read `strokes 75 /s · tail ~450 ms`.

**2. `readouts` — `stereo`.** Three entries, no registry cost:
`{ label:'spread', paramId:'spread' }`, `{ label:'width', paramId:'width' }`,
`{ label:'centred', text:'head · body · crack' }`. The mono-safety property
(`width=0 && spread=0` → `L == R` **exactly**, by the `pan=0 ⇒ sideGain=0`
construction) is this module's most-documented and least-visible fact, and it is
what a producer needs before folding to mono.

---

## 7. RANGE / CURVE / VOCABULARY CHANGES

**Grep result for re-typed ranges in the card: ZERO, and that is already fixed.**
`SnaredrumCard.svelte:45-67` builds every control from `paramSpec(snaredrumDef,
…)` and is enrolled in `card-range-source.test.ts`. No hazard, no bug.

Proposed changes, all **contract-free** (`contract-signature.ts` emits only
`id/min/max/curve/default/unit`; `format`, `options`, `landmarks` and `label` are
never read):

1. **`hard` gains `options: [{value:0,label:'clean'},{value:1,label:'hard'}]`.**
   Recommended by the round-2 spec and it did **not** ship — `snaredrum.ts:118` is
   still `{ id: 'hard', label: 'Hard', … curve: 'discrete' }` with no `options`.
   `hard` is not a boolean, it is a character choice between a 2× tanh and a 4×
   wavefolder. With `options` it renders `<Segmented>` `clean | hard` at the dock.
   `ACKNOWLEDGED_LATCHING['snaredrum:hard']` **stays** — the render kind is
   independent of the switch classification.
2. **`damping` label `'Damp'` → `'Head Q'`; `damp` label `'G Damp'` → `'Damp'`.**
   *(Taste call.)* Two knobs one character apart in two different bands is §2
   defect 3; `Head Q` names the layer and the quantity, leaving `Damp`
   unambiguous. ⚠ I rejected `'Ring'` for `damping`: the param runs 0 = open →
   1 = muted, so `Ring` reads backwards. **Revert:** leave both labels as shipped;
   nothing else in this spec depends on them.
3. **`format` on all 22 params.** Promote `kickdrum-format.ts` to a shared
   `.../voice-format.ts` in the same PR and attach `fmtHz` (tune, wire_tone,
   crack_tone), `fmtMs` (head_decay, body_decay, pitch_time, wire_decay), `fmtDb`
   (level), `fmtSemitones` (pitch_amt), `fmtAmount` (the eight 0..1 params). Doing
   it now stops the second copy of that file before it exists. ⚠ Under the
   no-prose ruling this is the load-bearing item in this section, not the cosmetic
   one.
4. **NO `landmarks` on `bounce` — and this is a finding, not an omission.** A
   landmark roster (`single` / `double` / `buzz`) is the obvious move and it would
   **lie**: the regime is a joint function of `bounce` AND `handHz`, and at
   `roll_speed = 1` even `bounce = 1.0` yields N = 2, a plain double.
   `knobValueReadout` would print `buzz` over a double. The roll's real type is
   carried by the derived `strokes` readout instead.
5. **NO `format`/`units` on `roll_speed`.** A formatter would have to evaluate
   `4·6^v`; attaching it means the def imports the DSP, and the number a player
   wants (composite strokes/s) needs `bounce` too — which a per-param formatter
   cannot see. The hero readout is the right home for it.

---

## 8. DEFECTS FOUND IN SHIPPED CODE

*(Follow-up bugs with their own owner-audition PRs — none is spec content.
Re-verified against the tree 2026-08-12.)*

**✅ D1 — the wire bed panning to the WRONG side during a roll — FIXED** in #1328.
`snaredrum-dsp.ts:596` now routes the bed through the same `panSideGain` helper as
the voice path, so a positive pan produces a negative side on both.

**D2 [MODERATE, STILL LIVE] — `accent_in`'s velocity term is inert on every
PRIMARY stroke.** `snaredrum-dsp.ts:512` computes a trigger hit's velocity as
`clamp(1 · (1 + ACCENT_VEL·acc), 0, 1)` with `ACCENT_VEL = 0.5`, which is
identically **1** for every accent value; `:527` does the same for roll strokes,
whose primary sub-stroke also has `firedVel = 1`. So `ACCENT_VEL` only ever moves
the *rebound* strokes of a double or buzz roll. Cost to a user: the canonical drum
patch — a sequencer velocity lane into `accent_in`, gates into `trigger_in` —
produces **no velocity dynamics at all**, only the continuous ±30 % drive / +4 dB
macro applied pre-core in the worklet. The def's own docs acknowledge the clamp
(`snaredrum.ts:321`), so this is documented-as-designed rather than a silent bug —
but it is the wrong design for a drum, and the two-line shape of the fix is to make
accent 0 the *quiet* end (base velocity `1/(1 + ACCENT_VEL)` → accent sweeps
0.67 → 1.00). DSP change, ART re-pin, owner audition; **never fold it into a face
wave.**

**D3 [MINOR, latent, STILL LIVE] — `bounceSchedule` relies on `clamp`'s
lo-wins-first behaviour.** `snare-roll-dsp.ts:139` is
`clamp(round(2 + (maxB−2)·rateFactor), 2, maxB)`, and for `bounce ∈ [0.05, 0.10)`
`maxB = min(MAX_SUBSTROKES, round(1 + b·5))` evaluates to **1** (`:135`) — an
inverted range. `dsp-utils.ts` `clamp` is `x < lo ? lo : x > hi ? hi : x` so it
returns `lo`, N = 2, and the behaviour is *correct* (a double, which is what the
docs promise). But the loop then writes `outOff[k]` for `k < N` where N **exceeds**
the `maxB` the line above computed, and any future "fix" that makes `clamp`
order-independent would silently turn `bounce ∈ [0.05, 0.10)` back into a
single-stroke roll. No user impact today. A one-line `Math.max(2, maxB)` and a unit
case at `bounce = 0.06` would make the intent explicit.

*(Also observed, not a defect: `const ROLL_P` at `snaredrum-dsp.ts:446` is
module-level state shared by every snaredrum node in one
`AudioWorkletGlobalScope`. Safe today because all five fields are written
immediately before the synchronous `rollStep` read, but it is the one piece of
cross-instance state in a file whose stated discipline is per-instance state
objects.)*
