# face re-do — snaredrum

> ⚠ **STATUS CORRECTED 2026-08-04 — read `face-redo-INDEX.md` §0 before building.**
> PF-20 (**PR #1301**) **HAS MERGED** (`c6ff9253`); every "unmerged branch" citation below
> now resolves on `main`. **`face.title` and `face.hint` do NOT paint by default** —
> `facePageHeader()` returns `null` before reading anything unless annotate mode is on
> (`packages/web/src/lib/ui/workflow/dock-faceplate-model.ts:90`), and the owner ruled on
> 2026-08-03 that `face.title` stays annotation-only. **Any argument below that parks a
> load-bearing fact in `face.hint` because it "still paints" is VOID.** PF-21 dock ROW
> PACKING (`9bf12df7`) also landed after this was written. **This re-do is NOT built** —
> the module's shipped `face` still declares no `hero` and no `sidebar`. Live backlog.
> ✅ The re-do ledger's snaredrum defect #25 (the wire bed panning to the WRONG side during
> a roll) **is FIXED** — one shared pan helper, **#1328** (`1446f1c5`).

**Verdict: REAL REWORK** — but a *structural* one, not a re-ranking: the six-cell lane and the five
bands that merged two days ago (`f5cb7550`) are right and I keep them unchanged; what the platform
adds is a hero rail whose ACTION slot holds only ONE key while this module has TWO auditions, and
resolving that honestly is what moves the face — HIT to the hero, ROLL down into the `roll` band
where its own docs already say it belongs.

---

## 1. WHAT THE MODULE ACTUALLY DOES

Read: `packages/web/src/lib/audio/modules/snaredrum.ts` (def+face+docs, 549 lines),
`packages/dsp/src/snaredrum.ts` (worklet), `packages/dsp/src/lib/snaredrum-dsp.ts` (voice+bed+bus),
`packages/dsp/src/lib/snare-roll-dsp.ts` (the roll engine),
`packages/web/src/lib/ui/modules/SnaredrumCard.svelte` (legacy card).

**The signal path, in the DSP's real order** (`snaredrumStepStereo`, `snaredrum-dsp.ts:461`):

1. **TRIGGER edge** (`:474-483`) — one pool voice, `vel` latched, bed re-excited, `bedPanTarget = 0`
   (a single hit is *always* centred).
2. **ROLL engine** (`:486-500` → `rollStep`, `snare-roll-dsp.ts:303`) — two hand phases 180° apart at
   `rollHandHz = clamp(4·6^roll_speed · 2^cv, 1, 40)` (`:97`); each hand-beat schedules a bounce
   train from `bounceSchedule` (`:122`), velocities `r^k` with `r = 0.5 + 0.25·bounce`, spacing
   `τ = 0.18/handHz` shrinking by `GSPACE = 0.7` and floored at 4 ms.
3. **Per-voice generators** (`snareVoiceStep`, `:296`) — HEAD (4 self-ringing Chamberlin modes at
   Bessel ratios `1 : 1.03 : 1.593 : 2.135`), BODY (band-passed noise at the same drifting centre),
   CRACK (a **fixed 6 ms** tick, `CRACK_LEN_MS :66`, summed *outside* `VOICE_NORM` with
   `CRACK_GAIN = 5.0` `:70`). `tone` crossfades HEAD↔BODY inside the voice (`:378`).
4. **Pool sum** — constant-power pan, `1/√nact` normalisation, then the `tone` tilt as a *voice-vs-bed*
   opposition: `voiceG = 1 + 0.8(t−0.5)`, `bedG = 1 − 0.8(t−0.5)` (`:530-531`).
5. **WIRE BED** (`:538-549`) — a **top-level, shared, re-excitable** generator, not per-voice.
   `bedEnv += wire·vel` on every strike (`exciteBed :449`), decaying at
   `wire_decay · (1 − 0.6·damp)`; a `contact` term rides the rectified head displacement on top.
6. **Bus** (`:565-580`) — `DRIVE → DC block → LEVEL → per-channel tanh CEILING`, **on the MID ONLY**.
   The SIDE signal (`sidePool + wireSide`, `:563`) **bypasses the shaper and the DC blocker** and
   rejoins at `out[0] = tanh(g(m+sd))`, `out[1] = tanh(g(m−sd))`.
7. **CHOKE** (worklet, `packages/dsp/src/snaredrum.ts:201-209`) — multiplies both channels
   *post*-ceiling.

**What each control genuinely changes about the sound, where the label under-states it:**

- `wire` is TWO controls in one — the bed's *level* AND how hard every strike tops the bed up
  (`exciteBed(s, wireAmt, vel)`), so it is simultaneously "is this a snare or a tom" and "does the
  roll sustain". Nothing else on the module has that dual role.
- `damp` (label `G Damp`) scales **three** decays together, `×(1 − 0.6·damp)` — head (`:362`), body
  (`:363`), bed (`:548`) — and tightens the modal ring through `ringMs` (`:309`). One cell, three tails.
- `damping` (label `Damp`) is the head bank's **Q**, applied *on top of* the damping `head_decay`
  already sets (`qBase = (0.05 + damping·0.45)(1 − ringReduce)`, `:311`), so it keeps its full
  relative range at any decay length.
- `bounce` sets the roll TYPE, but **jointly with `roll_speed`**: `rateFactor = (24 − handHz)/20`, so
  slower hands grow more rebounds. Verified against the docs' own claims: at handHz 24 even
  `bounce = 1` yields N = 2 (a plain double); at handHz 4, `bounce = 0.6` yields N = 4. The authored
  prose at `snaredrum.ts:393` checks out exactly.
- `spread` is a **ROLL-ONLY** control (a trigger hit sets `bedPanTarget = 0` and `tuneMul = 1`), and
  it also scales the humanize *detune* share (`snare-roll-dsp.ts:274`).

**INERT AT SPAWN / conditional:** `spread` does nothing until the roll gate runs. `hard` does nothing
until `drive > 0` (the shaper is bypassed outright at `driveAmt ≤ 0.001`, `:569`). `humanize`'s detune
half is scaled by `spread`, so at Spread 0 it only jitters timing and velocity.

**Measurable facts worth printing on the faceplate** (all re-derived here, not copied):
- per-hand rate at the default `roll_speed = 0.5` → `4·√6 = 9.80 Hz`; sub-strokes per hand-beat at
  `bounce = 0.35` → `maxB = 3`, `rateFactor = 0.7101`, **N = 3**; composite **58.8 sub-strokes/s**.
- the new-voice budget is **70/s** (`ALLOC_RATE_CAP`, `snare-roll-dsp.ts:49`) over a **10**-voice pool
  (`MAX_VOICES :43`) — so at defaults every stroke gets a voice, and at `roll_speed = 1` (96/s) about
  27 % are bed-only.
- the bed's −60 dB decay at defaults is `260 × 0.88 = 228.8 ms` against a **17 ms** inter-stroke
  interval. That ratio *is* why the roll is continuous, and it is currently only reachable by ear.

---

## 2. WHAT THE CURRENT SHIPPED FACE GETS WRONG

The face is **recent and largely right** — `snaredrum.ts:227-307` plus its 336-line pin
`snaredrum-face.test.ts`. The lane ranking (`tune, wire, roll_speed, bounce, damp, tone`) is
well-argued and I change **none** of it. Five genuine gaps, three of which are simply "the platform
did not exist yet":

1. **No `title`, no `hint`, no `hero`, no `sidebar`** — the whole PF-20 surface is unused.
2. **No page `hint`s.** Under correction 2 these are annotation-only, but they are living-docs content
   and must be authored; today there are zero.
3. **The ROLL pad is in the wrong band, and the def's own docs say so.**
   `docs.controls['snaredrum-roll-{n}']` (`snaredrum.ts:378`) reads: *"Press it with ROLL SPEED and
   BOUNCE under your other hand — that is the whole reason those two rank into the lane."* The face
   then puts that pad in band `drum` (`:260`), four bands away from `roll_speed` and `bounce`
   (`:271`). The prose and the layout contradict each other. This is not a platform consequence — it
   was wrong on the day it shipped.
4. **`damping` ('Damp') and `damp` ('G Damp') are two knobs one character apart, in DIFFERENT bands**
   (`drum` and `whole`), doing unrelated things (mode Q vs. a three-tail scaler). Separating them
   removed the only disambiguation the card had (its `HEAD` group header).
5. **No `format` on any of the 22 params** (`:96-120`), while kickdrum attaches `fmtHz`/`fmtMs`/
   `fmtDb`/`fmtAmount` to all of its. The dock prints `4500` where its sibling prints `4.5 kHz`.

Explicitly NOT wrong, and I am not touching them: the six-cell lane; the `whole drum` band's
existence; the glyph accounting (a ≥4-cell `full` face drops the glyph — already true before the
re-cut); the rear field; the `strike · hit or hold` cluster caption.

---

## 3. THE ~8 CONTROLS THAT MATTER

**Ranks 1–6 are UNCHANGED.** Re-cutting a two-day-old ranking that was itself rebuilt on a good
argument would be churn, and the program's own anti-pattern list names "proposing a ranking identical
to the existing one and presenting it as a redesign" — the honest inverse is to say plainly that this
one is already right.

| # | key | why THIS module ranks it here (wrong for any other module) | cost below |
|---|---|---|---|
| 1 | `tune` | the modal bank *and* the body noise centre both track it (`:313`, `:336`) — a 1-cell mini tile can say nothing else useful | — |
| 2 | `wire` | the only control whose extreme turns this into a **different instrument** (a tom), *and* the master of the roll's sustain (`bed += wire·vel`) | pushes `tone` out of the compact pair |
| 3 | `roll_speed` | the DEF ITSELF says this knob is expected to move: it is the **only** param with a dedicated audio-rate node input (`roll_speed_cv`, input 2, read raw per sample) while 21 others get an 80 Hz-smoothed AudioParam | — |
| 4 | `bounce` | ranking a mechanism's rate without its type is exactly what the pre-`f5cb7550` face did | — |
| 5 | `damp` | one cell moving three tails; the natural counterpart to a buzz roll, whose overlapping tails are what turn a press roll into mud | demotes `head_decay` |
| 6 | `tone` | the whole-drum bright↔fat tilt, and the only knob that moves voice and bed in *opposition* | demotes `crack` |

**THE LOSERS, NAMED.** `head_decay` — `damp` moves that tail and two others from one cell.
`crack` — the level of a *fixed* 6 ms tick; an attack you set, not one you ride. `damping` — a
relative Q on top of a decay already ranked. `spread`/`humanize` — inert or near-inert until a roll
runs. `wire_tone`/`wire_decay`/`crack_tone`/`body_decay`/`pitch_amt`/`pitch_time` — sound-design, set
once. `drive`/`hard`/`ceiling`/`width` — bus. `level` — stays out on the drum-family rule: it is
applied to mid *and* side **before** the ceiling (`:575-578`), so it is a saturation lever, not a
fader, and promoting it invites the misuse the ranking exists to prevent.

**Ranks 7+ (dock-only) change**, and only here:

```
7  'snaredrum-hit-{n}'    the audition — the one control that makes a silent voice audible at all
8  'snaredrum-hero-{n}'   THE PICTURE — first legal panel rank (module-face-lint refuses a panel
                          SELECTED at a lane tier; the lane budget is 6)
9+ the tail, in FACEPLATE reading order:
   damping, head_decay, body_decay, pitch_amt, pitch_time,        (band 1)
   wire_tone, wire_decay, crack, crack_tone,                      (band 2)
   'snaredrum-roll-{n}', humanize, spread,                        (band 3)
   drive, hard, ceiling, width, level                             (band 5)
```

⚠ **PUSH CARD: does not move.** `push-card-config.ts:22-27` — no snaredrum override, so the card is
the first 8 **turnable params** of `face.order`; families are skipped. That set is
`tune, wire, roll_speed, bounce, damp, tone, damping, head_decay` before and after.

---

## 4. BAND STRUCTURE + THE ANNOTATION PROSE

Five bands, ids **unchanged** (`drum/snap/roll/whole/bus` — the rear-derivation totality assert at
`snaredrum-face.test.ts:285` and the structural gate `{ type: 'snaredrum', pages: 5 }` at
`e2e/vrt/workflow-shell-faces.spec.ts:54` both stay green). Labels gain the kickdrum-style **stage
numbers** on the three generator bands; the two bus bands stay unnumbered because they are one chain.

```ts
pages: [
  { id: 'drum',  label: '1 · drum — head + body',
    hint: 'a four-mode membrane at Bessel ratios plus noise at the same pitch — struck, then falling',
    controls: ['snaredrum-hero-{n}', 'snaredrum-hit-{n}', 'tune', 'damping', 'head_decay',
               'body_decay', 'pitch_amt', 'pitch_time'],
    clusters: [{ label: 'pitch drop', controls: ['pitch_amt', 'pitch_time'] }] },

  { id: 'snap',  label: '2 · snap — wires + stick',
    hint: 'the shared wire bed rings BETWEEN strokes; the crack is a fixed 6 ms tick above the onset',
    controls: ['wire', 'wire_tone', 'wire_decay', 'crack', 'crack_tone'] },

  { id: 'roll',  label: '3 · roll — two hands',
    hint: 'two hands 180° apart, each beat a bounce train; SPREAD moves the hands, never a single hit',
    controls: ['snaredrum-roll-{n}', 'roll_speed', 'bounce', 'humanize', 'spread'] },

  { id: 'whole', label: 'whole drum',
    hint: 'the only two controls that touch every layer — a tilt and a towel',
    controls: ['tone', 'damp'] },

  { id: 'bus',   label: 'bus · out',
    hint: 'drive and the DC blocker run on the MID only; the side path rejoins at the ceiling',
    controls: ['drive', 'hard', 'ceiling', 'width', 'level'] },
]
```

Notes that are load-bearing rather than decorative:

- `snaredrum-hero-{n}` and `snaredrum-hit-{n}` are **listed in band 1 and must be** — `face.hero`
  PROMOTES a key it can only move if some band already claims it (`heroFacePlan`,
  `dock-faceplate-model.ts`); leaving them off drops them into the defensive `__unpaged` band.
- `snaredrum-roll-{n}` leads band 3 and is **un-clustered**, because clusters render *after* the
  band's flat row — a clustered pad can never lead a band.
- No page id is `voice` and no page label contains the word `strike` (the rear owns it) — the two
  assertions at `snaredrum-face.test.ts:288-309`. `'stick'` is not `'strike'`; verify the substring
  test still passes on the new label.
- Rear band labels after the rename: `strike · performance`, `1 · drum — head + body`,
  `2 · snap — wires + stick`, `3 · roll — two hands`, `whole drum`, `bus · out`. **No label prefixes
  another** (the lint rule that exists for kickdrum's two adjacent `STRIKE` bands).

**Does this face read correctly with every hint hidden?** Yes, and that is the test I designed to.
Each label carries a stage number and a two-noun name (`snap — wires + stick`); the hero rail already
says what the module is; the readout strip already prints the roll's density and the drum's ring; and
the sidebar's signal-flow diagram carries the one fact the hints add value on (the side path bypassing
the drive) in a form that paints by default. Nothing in the hints is load-bearing — they are the
*why*, not the *what*.

---

## 5. THE HERO + THE READOUT STRIP

**`hero.cell` — YES, a bespoke picture, and it is NOT kickdrum's.** The generic alternative is the
`scope` glyph, which is a live trace of the output and therefore **flatlines on a silent rack** — and
this voice makes no sound at all until something strikes it, so the glyph is blank exactly when a
player is deciding what to do. (Declaring a `cell` suppresses the dock glyph; it is untouched at mini
and compact.) The picture:

- **Top — the ROLL GRID.** Two lanes (L / R) over the selected window; each hand-beat drawn at
  `1/rollHandHz(roll_speed, 0)` with its bounce train at exactly the offsets and velocities
  `bounceSchedule(bounce, handHz, sr)` returns; sub-strokes past the 70/s budget drawn hollow
  (bed-only). Both functions are already **exported** from `snare-roll-dsp.ts`, so the panel imports
  the DSP's own law by relative path (the `kickdrum-face-model.ts` precedent) and re-types nothing.
- **Bottom — the WIRE-BED envelope.** The bed's sawtooth: `+= wire·vel` per stroke, clamped at 1,
  decaying at `wire_decay·(1 − 0.6·damp)`. If it never reaches the floor the roll is continuous; if it
  does, you *see* the gaps. This is the module's central relation and there is no other way to read it.
- **Probe** (required by PF-14): a WINDOW button (250 ms / 1 s / 4 s) held in **component state, not
  `node.data`** — a private view setting must not re-zoom every collaborator's screen. So
  `{ testid: 'snaredrum-grid-window', action: 'click', effect: { kind: 'text', testid:
  'snaredrum-grid-axis', expect: 'changed' } }` — drive the button, assert the AXIS LABELS moved,
  never the button's own text. Exactly kickdrum's shape and for the same reason.

The picture answers *"what will a roll look like"*; the `tail` readout answers *"how long does one hit
ring"*. Neither is derivable from the other, which is why both exist.

**`hero.control` = `wire`.** *(Taste call — see the revert.)* `tune` stays rank 1 because that is the
answer to a different question (what can a ONE-CELL mini tile say). The hero dial sits beside a
picture whose whole subject is the wire bed, and `wire` is the only control on this module that
changes what instrument it is *and* the only one that couples the two halves of the faceplate. It also
demonstrates the strip's own derivation: turning it visibly moves `tail` and pointedly does **not**
move `strokes`.
**Revert:** set `hero.control: 'tune'` and change readout 3 to `{ label: 'wires', paramId: 'wire' }`.
Nothing else moves.

**`hero.action` = `snaredrum-hit-{n}`.** The slot takes exactly ONE key
(`ModuleFaceHero.action`, `graph/types.ts`), and this module has two auditions. HIT is the universal
drum audition — the same cell kickdrum, tomtom and karplus all put here — so it goes in the rail;
ROLL is this module's *mechanism* and belongs beside the mechanism's knobs. This is the one place
snaredrum genuinely cannot mirror kickdrum, and the resolution improves the face rather than
compromising it (§2 defect 3).

**THE READOUT STRIP — three entries, full-width beneath the picture** (correction 1):

| label | source | prints at defaults |
|---|---|---|
| `strokes` | `valueId: 'snaredrum-roll-rate'` | `59 /s` |
| `tail` | `valueId: 'snaredrum-tail'` | `179 ms` |
| `head` | `paramId: 'tune'` | `180 Hz` |

Three, not five: the strip is the most-read line on the faceplate and I could not defend a fourth.
`tune` earns its slot only because it is **not** the hero dial under this proposal — under the revert
it must be swapped out, or it becomes exactly the "repeats the knob above it" noise.

**`snaredrum-roll-rate` — formula + negative control.**
`2 × rollHandHz(roll_speed, 0) × bounceSchedule(bounce, handHz, sr)` — the exported laws at
`snare-roll-dsp.ts:97` and `:122`, evaluated at `MODEL_SR`. At defaults `2 × 9.798 × 3 = 58.8 → 59 /s`.
- **NEGATIVE CONTROL (must move):** perturb `bounce` 0.35 → 0. N drops 3 → 1 and the readout goes
  59 → 20 /s, while a `roll_speed` knob readback stays `0.50`. This is the perturbation that
  distinguishes the two models.
- **SECOND LEG (must NOT move):** perturb `wire` 0.7 → 0. `RollParams` carries only
  `rollSpeed/rollSpeedCv/bounce/humanize/spread` — `wire` never enters the schedule, so the number is
  unchanged. This is what stops the function drifting into "sum whatever params are nearby".
- **THIRD LEG (must NOT move):** perturb `humanize`. It jitters offsets (`±0.08·period`) but not the
  *count*, so the mean density is invariant.
- Lives permanently in `snaredrum-face-model.test.ts`.

**`snaredrum-tail` — formula + negative control.**
The −60 dB point of the summed amplitude envelope, each layer at its own live mix, solved by
bisection (the `kickdrumTailMs` shape):
`head = tone·VOICE_NORM @ head_decay·(1−0.6·damp)`, `body = (1−tone)·VOICE_NORM @ body_decay·(…)`,
`crack = crack·CRACK_GAIN @ 6 ms`, `bed = wire·bedG @ wire_decay·(1−0.6·damp)`.
At defaults: weights `0.31 / 0.31 / 2.00 / 0.70`, peak 3.32, → **179 ms**.
- **NEGATIVE CONTROL (must move):** perturb `wire` 0.7 → 0. The 229 ms bed leaves the sum entirely and
  the tail collapses to **109 ms** — while a `wire_decay` readback still says `260 ms`. That is the
  kickdrum `sub_decay` trap in this module's clothing.
- **SECOND, non-obvious leg (must move):** perturb `crack` 0.4 → 0. Crack's weight is
  `0.4 × CRACK_GAIN 5.0 = 2.0` — it *dominates the peak*, so removing it LOWERS the −60 dB floor and
  the tail grows **179 → 209 ms**. No decay knob on the module shows this, and nobody would guess a
  6 ms tick lengthens the tail by 30 ms.
- **THIRD LEG (must NOT move):** perturb `roll_speed`. The tail is a single-hit quantity.

⚠ These are the only two derived readouts I could defend. A `roll_speed`-only "hands/s" figure is a
monotone bijection of one knob — I cannot name a perturbation that distinguishes it from a knob
readback, so it is **not** a derived readout and it is not declared. Saying so is the honest answer.

---

## 6. THE SIDEBAR

Three blocks. Kickdrum has four; the one I deliberately do **not** copy is its `custom`
`stereo-crossover` panel — snaredrum has **no crossover**. `width` decorrelates the wire band with no
frequency split anywhere in `snaredrumStepStereo`, so that panel would paint a split that does not
exist. A diagram that teaches the wrong chain is worse than none.

**1. `signal-flow`** — the DSP's real order, with the branch mark carrying the fact the prose spends a
sentence on:

```
HEAD        generator   modal bank
BODY        generator   noise at TUNE
CRACK       generator   6 ms tick
WIRE BED    generator   shared · re-excited
POOL · TONE bus         10 voices · 1/√n · tilt
DRIVE · HARD bus        MID only
DC BLOCK    bus         20 Hz
SIDE        bus  ⟂      spread · width — bypasses drive
LEVEL       bus         pre-ceiling
CEILING → OUT L·R  bus  tanh(mid ± side)
```

`SIDE` is `parallel: true` and that is a **correctness** field, not decoration: `side` is formed at the
pool sum (`:563`) and rejoins only at the output matrix (`:579-580`), never entering the shaper or the
DC blocker. Drawn inline it would teach a producer that DRIVE colours the stereo image. It does not.
The four generators are marked `role: 'generator'` — including WIRE BED, which is the one a reader
will otherwise assume is a bus effect.

**2. `presets`** — snaredrum has none anywhere today. Five entries, **each a complete 22-param voice**
(a partial recall whose omissions are undocumented is worse than either honest option), every value
re-checked against the declared ranges at `snaredrum.ts:96-120`:

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

PRESS ROLL is worth checking by hand because it is the entry that proves the readouts:
`handHz = 4·6^0.25 = 6.26`; `bounce 0.9 → maxB 6`, `rateFactor 0.887`, **N = 6**; density
`2 × 6.26 × 6 = 75 /s` — deliberately just **past** the 70/s budget, so ~7 % of sub-strokes drive the
bed alone, which is precisely what a dense buzz is. The bed decays at `520 × 0.97 = 504 ms` against a
13 ms interval. The strip will read `strokes 75 /s · tail ~450 ms`.

**3. `readouts` — `stereo`.** Three entries, no registry cost:
`{ label:'spread', paramId:'spread' }`, `{ label:'width', paramId:'width' }`,
`{ label:'centred', text:'head · body · crack' }`. The mono-safety property (`width=0 && spread=0` →
`L == R` **exactly**, by the `pan=0 ⇒ sideGain=0` construction at `:511-516`) is this module's
most-documented and least-visible fact, and it is what a producer needs before folding to mono.

---

## 7. RANGE / CURVE / VOCABULARY CHANGES

**Grep result for re-typed ranges in the card: ZERO, and that is already fixed.**
`SnaredrumCard.svelte:45-67` builds every control from `paramSpec(snaredrumDef, …)` and
`SnaredrumCard.svelte` is enrolled in `card-range-source.test.ts:76`. No hazard, no bug.

Proposed changes, all **contract-free** (`contract-signature.ts:110` emits only
`id/min/max/curve/default/unit`; `format`, `options`, `landmarks` and `label` are never read):

1. **`hard` gains `options: [{value:0,label:'clean'},{value:1,label:'hard'}]`.** Recommended by the
   round-2 spec and it did **not** ship — `snaredrum.ts:117` still has none, and `contract-lock.txt:3031`
   confirms the line is `snaredrum param hard 0..1 discrete default=0`. `hard` is not a boolean, it is
   a character choice between a 2× tanh and a 4× wavefolder. With `options` it renders `<Segmented>`
   `clean | hard` at the dock. `ACKNOWLEDGED_LATCHING['snaredrum:hard']`
   (`module-face-lint.test.ts:341`) **stays** — the render kind is independent of the switch
   classification.
2. **`damping` label `'Damp'` → `'Head Q'`; `damp` label `'G Damp'` → `'Damp'`.** *(Taste call.)*
   Two knobs one character apart in two different bands is the §2 defect; `Head Q` names the layer and
   the quantity (and the band header already says HEAD), leaving `Damp` unambiguous.
   ⚠ I rejected `'Ring'` for `damping`: the param runs 0 = open → 1 = muted, so `Ring` reads backwards.
   **Revert:** leave both labels as shipped; nothing else in this spec depends on them.
3. **`format` on all 22 params.** Promote the platform branch's
   `packages/web/src/lib/audio/modules/kickdrum-format.ts` to a shared
   `.../voice-format.ts` in the same PR (2 import edits: `kickdrum.ts`, `face-readout-values.ts`) and
   attach `fmtHz` (tune, wire_tone, crack_tone), `fmtMs` (head_decay, body_decay, pitch_time,
   wire_decay), `fmtDb` (level), `fmtSemitones` (pitch_amt), `fmtAmount` (the eight 0..1 params).
   Doing it now stops the second copy of that file before it exists.
4. **NO `landmarks` on `bounce` — and this is a finding, not an omission.** A landmark roster
   (`single` / `double` / `buzz`) is the obvious move and it would **lie**: the regime is a joint
   function of `bounce` AND `handHz`, and at `roll_speed = 1` even `bounce = 1.0` yields N = 2, a plain
   double. `knobValueReadout` would print `buzz` over a double. The roll's real type is carried by the
   derived `strokes` readout instead.
5. **NO `format`/`units` on `roll_speed`.** A formatter would have to evaluate `4·6^v`; attaching it
   means the def imports the DSP, and the number a player wants (composite strokes/s) needs `bounce`
   too — which a per-param formatter cannot see. The hero readout is the right home for it.

---

## 8. COST

**contract-lock:** **+1 line, exactly one** — `snaredrum family snaredrum-hero kind=cell
prefix=snaredrum-hero`. `serializeModuleContract` sorts families by id (`contract-signature.ts:124`),
so it lands **before** `snaredrum-hit` at the current `contract-lock.txt:3046`, pushing hit/roll to
3047-3048. Everything else in this spec (title, hint, hero, sidebar, presets, page labels, page hints,
`format`, `options`, `label` renames) is **ZERO** contract lines. Accept with `task docs:accept` and
review the one-line diff.

**Docs:** `docs.controls['snaredrum-hero-{n}']` is REQUIRED — snaredrum is in `STRICT_DOCS`
(`strict-docs.ts:380`) and `module-docs-lint` fails an undocumented family. The `testidPrefix` grep
(`module-docs-lint.test.ts:232-247`) walks **all** of `$lib/ui/**.svelte`, so
`SnaredrumHeroPanel.svelte` emitting `data-testid="snaredrum-hero"` satisfies it — **no legacy-card
edit is required** (verified: `KickdrumCard.svelte` does not mention `kickdrum-hero`;
`KickdrumHeroPanel.svelte:186` does).

**VRT:**
- `darwin/face-snaredrum-dock` + `linux/face-snaredrum-dock` — **MOVE, massively** (title, hint, hero
  rail, readout strip, sidebar column, five relabelled bands, two moved cells, `hard` → Segmented,
  22 reformatted values). Far over `DOCK_MAX_DIFF` 1500 px, so `--update-snapshots` regenerates
  normally — no `git rm` needed. Both platforms' baselines are already **present** (the pairs were
  drained on 2026-08-02, `vrt-exemptions.ts:1051`), so this is a re-capture, not a drain, and the
  vrt-meta ratchet does **not** move.
- `face-snaredrum-compact` — **must NOT move.** Compact's cap is 2 and `order[0..1]` is `tune, wire`
  before and after. A compact diff is a **finding**, not churn to accept.
- `darwin/snaredrum` (the legacy card, `vrt.spec.ts`) — moves only if the `label` renames (change 2)
  ship; the card reads labels from the def. `linux/snaredrum` stays exempt (`:1631`) — do not drain it
  here, that needs its own capture and its own ratchet move.
- `snaredrum` is **not** in `STRICT_VRT_MODULES`, so none of this touches the REQUIRED `vrt-strict`
  gate.
- ⚠ **The dock capture covers LESS of this face afterwards.** `.dock-faceplate` caps at 425 px and
  snaredrum already overflows it by a **measured 282 px** (`vrt-exemptions.ts:1077`). Adding a header,
  a hero rail and a readout strip at the top — and narrowing the editor column for the sidebar, which
  makes bands taller — pushes the overflow to roughly 550–600 px. The `bus` band and most of `whole`
  render below the frame. State it; do not "fix" it by shrinking the face (the pane scrolls, and
  425 px is Chromium's default window, not a design constraint). The uncovered surface's real coverage
  is faces-parity's cell sweep.

**e2e:** faces-parity's cell count is registry-derived (`defIds.length + controlFamilies.length`), so
22 + 3 auto-updates — no manual edit. The new **panel probe** is a real drive (click the window
button, assert the axis text changed): ~+1 s. `snaredrum-face.test.ts` needs rewriting at :170-183
(the auditions no longer lead band 1) and :211-218 (the order/pages argument changes shape); its other
19 assertions survive unchanged. `snaredrum-face.spec.ts` and `snaredrum-roll.spec.ts` need **no**
change — both drive cells by testid, and neither testid moves.

**CI wall-time:** +1 faces-parity cell × ~0.8 s + the panel probe ~1 s + a `snaredrum-face-model.test.ts`
in the unit lane (~0.1 s, two pure bisections) ≈ **+2 s**. Well under the 2-minute sign-off threshold.

**ART / attest: NIL, confirmed not assumed.** `art/scenarios/snaredrum/profile.test.ts:128-135` pins
`dspSourceSha('snaredrum.ts','lib/snaredrum-dsp.ts','lib/snare-roll-dsp.ts','lib/dsp-utils.ts',
'lib/oversample.ts','lib/rbj-biquad.ts')`, and `dspSourceSha` reads `DSP_SRC_DIR = packages/dsp/src` —
the web def, the panel and the face model are **not** in that basis, and nothing here edits a DSP file.
snaredrum is an AUDIO def, so it is not in the WebGL basis and needs no `docs-hash-ignore` markers.
The collab basis contains no audio module defs, no `shell-cells.ts` and no `ModuleShell.svelte`.

---

## 9. DEFECTS FOUND IN SHIPPED CODE

**Three. All are FOLLOW-UP BUGS with their own owner-audition PRs — none is spec content.**

**D1 [MAJOR, already known, still live] — the wire bed pans to the WRONG SIDE during a roll.**
`snare-roll-dsp.ts:267-269` gives the right hand `pan = +spread`. The voice path then uses
`sideGain = −√2·sin(pan·π/4)` (`snaredrum-dsp.ts:516`), so a positive pan produces a *negative* side
and `out[1] = tanh(g(m−sd))` is louder → the right hand goes right. ✅ The **bed** path uses
`wireSide = (… + wireMono · s.bedPan) · bedG` (`:562`) with `bedPanTarget = firedPan` (`:495`) — no
negation — so a positive pan produces a *positive* side and `out[0]` is louder → **the right hand's
sizzle goes LEFT.** Cost to a user: with WIRE up and SPREAD up, a roll's stereo image alternates
against itself instead of reading as two hands; the def already documents this at
`snaredrum.ts:395` as *"a known DSP sign bug"*, so it has been shipped-and-known since the module
landed. Fix is one sign (`wireMono * -s.bedPan`, or negate `bedPanTarget` at the two assignment
sites). A test can catch it: a unit assertion on `snaredrumStepStereo` that a right-hand roll stroke
with `wire=1, width=0` puts more energy in `out[1]` than `out[0]`. Requires an ART re-pin of the
`roll_l`/`roll_r` baselines **plus** `task art:fingerprints:accept`, and an owner audition — it changes
the stereo image of every spread roll.

**D2 [MODERATE, new] — `accent_in`'s velocity term is inert on every PRIMARY stroke.**
`snaredrum-dsp.ts:478` computes a trigger hit's velocity as `clamp(1 · (1 + 0.5·acc), 0, 1)`, which is
identically **1** for every accent value; `:493` does the same for roll strokes, whose primary
sub-stroke also has `firedVel = 1`. So `ACCENT_VEL` only ever moves the *rebound* strokes of a double
or buzz roll. Cost to a user: the canonical drum patch — a sequencer velocity lane into `accent_in`,
gates into `trigger_in` — produces **no velocity dynamics at all**, only the continuous ±30 % drive /
+4 dB macro applied pre-core in the worklet (`packages/dsp/src/snaredrum.ts:191-193`). The def's own
docs acknowledge the clamp (`snaredrum.ts:320`), so this is documented-as-designed rather than a
silent bug — but it is the wrong design for a drum, and the two-line shape of the fix is to make
accent 0 the *quiet* end (base velocity `1/(1 + ACCENT_VEL)` → accent sweeps 0.67 → 1.00). DSP change,
ART re-pin, owner audition; **never fold it into a face wave.**

**D3 [MINOR, latent] — `bounceSchedule` relies on `clamp`'s lo-wins-first behaviour.**
`snare-roll-dsp.ts:139` is `clamp(round(2 + (maxB−2)·rateFactor), 2, maxB)`, and for
`bounce ∈ [0.05, 0.10)` `maxB` evaluates to **1** — an inverted range. `dsp-utils.ts:13`
(`x < lo ? lo : x > hi ? hi : x`) returns `lo`, so N = 2 and the behaviour is *correct* (a double, which
is what the docs promise). But the loop then writes `outOff[k]` for `k < N` where N **exceeds** the
`maxB` the line above computed, and any future "fix" that makes `clamp` order-independent would
silently turn `bounce ∈ [0.05, 0.10)` back into a single-stroke roll. No user impact today. A one-line
`Math.max(2, maxB)` and a unit case at `bounce = 0.06` would make the intent explicit.

*(Also observed, not a defect: `const ROLL_P` at `snaredrum-dsp.ts:446` is module-level state shared by
every snaredrum node in one `AudioWorkletGlobalScope`. Safe today because all five fields are written
immediately before the synchronous `rollStep` read, but it is the one piece of cross-instance state in
a file whose stated discipline is per-instance state objects.)*

---

## 10. VERIFICATION GATE

Run in this order. Every row is scoped — no full-suite runs.

```sh
# 1. the derived readouts, INCLUDING their negative controls (the permanent legs)
flox activate -- task test:one -- snaredrum-face-model
REPEAT=3 flox activate -- task test:one -- snaredrum-face-model
#    must contain: bounce 0.35→0 moves `strokes` 59→20;  wire 0.7→0 does NOT move it
#                  wire 0.7→0 moves `tail` 179→109;      crack 0.4→0 moves `tail` 179→209
#                  roll_speed perturbation does NOT move `tail`

# 2. the face pin (rewritten at :170-183 and :211-218) + the platform lints
flox activate -- task test:one -- snaredrum-face
flox activate -- task test:one -- module-face-lint     # hero ranked/promoted-once/readouts resolve,
                                                        # sidebar presets in range, panel not lane-selected
flox activate -- task test:one -- shell-cells
flox activate -- task test:one -- manual-strike-wiring  # a cell's `mode` still matches its handler
flox activate -- task test:one -- module-docs-lint      # snaredrum-hero-{n} documented + prefix greppable
flox activate -- task test:one -- card-range-source
flox activate -- task test:one -- push-card-schema      # the card must NOT have moved

# 3. the contract accept-loop — expect EXACTLY one added line
flox activate -- task docs:accept && flox activate -- git diff packages/web/src/lib/docs/contract-lock.txt

# 4. typecheck (svelte-check is stricter than vitest — the new panel is a .svelte file)
flox activate -- task typecheck

# 5. e2e: the panel probe + the two existing real-chain specs (unchanged, must stay green)
flox activate -- task e2e:serve
flox activate -- task e2e:one -- faces-parity --grep snaredrum
flox activate -- task e2e:one -- tests/snaredrum-face.spec.ts
flox activate -- task e2e:one -- tests/snaredrum-roll.spec.ts
REPEAT=3 flox activate -- task e2e:one -- tests/snaredrum-face.spec.ts

# 6. VRT — compact must NOT move; a diff there is a FINDING, not churn
flox activate -- task vrt:one -- face-snaredrum-compact
flox activate -- task vrt:one -- face-snaredrum-dock
flox activate -- task vrt:one -- snaredrum            # legacy card; moves only if the labels change
flox activate -- task e2e:stop
```

Then re-capture the dock baselines on darwin and dispatch
`gh workflow run vrt-update.yml -f ref=<branch> -f platform=linux` **unscoped** (never `-f grep=`).
Both linux pairs are already drained, so the dispatch writes over existing PNGs — confirm the
committed baseline dimensions still match the render, in the SAME PR.
