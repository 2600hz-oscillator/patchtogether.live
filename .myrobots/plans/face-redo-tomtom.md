# face re-do — tomtom

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
> 2026-08-03 that `face.title` stays annotation-only. **Any argument below that parks a
> load-bearing fact in `face.hint` because it "still paints" is VOID.** PF-21 dock ROW
> PACKING (`9bf12df7`) also landed after this was written. **This re-do is NOT built** —
> the module's shipped `face` still declares no `hero` and no `sidebar`. Live backlog.
> ✅ The re-do ledger's tomtom defect #4 (`strike` persisting stuck at 1 in the Y.Doc and
> permanently masking `trigger_in`) **is FIXED** — **#1316** (`bbba5b5d`).

**Verdict: REAL REWORK — but the SMALL version of the drum-family grammar, deliberately.**
tomtom keeps its ranking, gains a title/hint, a hero of `tune` + the **already-shipped STRIKE pad**
+ a 4-entry readout strip, merges 4 bands → 2, and takes a two-block sidebar (presets + signal
flow). It does **NOT** get kickdrum's bespoke hero PICTURE, and §5 argues that on the merits.

Designed against PF-20 (`origin/feat/faceplate-platform-v2`, PR #1301 — **MERGED**, `c6ff9253`) **plus the two
owner corrections** (readouts = a strip BELOW the graphic; band hints = annotation-only). Claims
carry `file:line`; inferences are labelled. **[measured]** = run of the real DSP core
(`packages/dsp/src/lib/tomtom-dsp.ts`) at 48 kHz in a scratch harness.

In `STRICT_FACES` (`strict-faces.ts:56`) + `STRICT_DOCS` (`strict-docs.ts:384`). 9 params, 11 in,
1 out. contract-lock block = **22 lines** (`contract-lock.txt:3341-3362`).

---

## 1. WHAT THE MODULE ACTUALLY DOES

One mono struck-membrane voice. `tomtomStep` (`tomtom-dsp.ts:349-427`), in the DSP's real order:

1. **STRIKE** — per-sample rising edge at 0.5 (`:357-360`). `strikeTom` (`:316-330`) resets both
   phases, sets `ampEnv = bendEnv = 1`, latches accent, reseeds the RNG. Bit-identical per hit.
2. **Effective params** (`:363-370`) — every CV law is an identity at cv = 0, so an unpatched input
   is a true no-op (the factory fans one 0-offset `ConstantSource` into all 11, `tomtom.ts:230-233`).
3. **MEMBRANE** (`:372-380`) — a sine at `f1` plus a partial at `f1 × 1.593` (`OVERTONE_RATIO :66`,
   the Bessel pair snaredrum's modal bank also uses). Both ride ONE bend law:
   `f = tune × 2^((depth/12)·bendEnv)` (`tomFreqHz :212-222`).
4. **BREATH** (`:382-394`) — xorshift noise through a Chamberlin SVF centred at
   `clamp(settled × 2.5, 300, 6000)` (`:386`; constants `:75`, `:77-78`), × `NOISE_GAIN = 8` (`:89`).
5. **Envelopes** (`:399-405`) — fundamental at `decay`; overtone `× 0.6` (`:69`); bend at `bendTime`;
   breath `clamp(decay × 0.5, 25, 500)` (`:82-84`). `decayCoeff` (`:188-191`) is sr-calibrated, so
   DECAY is **frequency-compensated**: 60 Hz and 400 Hz ring the same length at the same knob.
6. **Balance + sum + DRIVE** (`:414-421`) — TONE ducks the fundamental to 40 % as the second mode
   comes up (`:95`); NOISE ducks the whole membrane to 30 % as the breath comes up (`:96`). DRIVE is
   a 2×-oversampled `tanh((1+3·drive)·x)` **gated off entirely below 0.001** (`:418`).
7. **BUS** (`:424-426`) — 20 Hz DC block → `10^(level/20)` → final `tanh`, so `|out| < 1`.

| control | what it changes about the SOUND | load-bearing? |
|---|---|---|
| `tune` | the settled fundamental; the overtone AND the breath centre track it | always |
| `bend_amt` | how many semitones sharp the strike starts. 0 = a plain resonator | always (default 7 st) |
| `bend_time` | how fast the sweep settles. **The one knob with a genuine INERT REGION** — at `bend_amt = 0` it does nothing | conditional |
| `decay` | the −60 dB ring in ms at every tune; also SETS the overtone (×0.6) and breath (×0.5, clamped) envelopes | always |
| `tone` | fundamental ↔ 1.593× tilt, the mode decaying faster — woody → struck | always |
| `noise` | membrane ↔ breath, the SDS-V mix law | always |
| `drive` | warmth — **and this voice's loudness lever**. A true bypass at 0 (`:418`) | always (default 0.25) |
| `level` | dB *before* the true-peak bound, so hot settings saturate rather than clip | always |
| `strike` | the manual pad. A real `ParamDef` (`tomtom.ts:81`), OR-ed with `trigger_in` in the worklet (`packages/dsp/src/tomtom.ts:182`) | audition only |

**Three measurable facts worth printing on a faceplate:**

- **[measured]** At defaults the strike starts at **164.8 Hz** and settles to **110 Hz**
  (`tune × 2^(7/12)`). At `bend_amt = 24` it starts at **440 Hz** — exactly 4×.
- **[measured]** At the default `tune = 110` the breath centre is **300 Hz — its FLOOR**, not
  2.5 × 110 = 275, and it does not start tracking the drum until `tune > 120`. `docs.controls.noise`
  says this in prose; nothing on either surface prints it.
- **[measured] The kickdrum TAIL trap does NOT reproduce here.** Composite −60 dB tail vs the DECAY
  knob: defaults **354** vs 350 (+1.1 %); `decay = 40` → 47; `decay = 1500` → 1495. Widest deviation
  in the whole timbre space: `noise = 1` → 299 (−15 %), `drive = 1` → 390 (+11 %) — both are the
  −60 dB *reference* moving with the peak, not a different ring. See §5c.

---

## 2. WHAT THE CURRENT SHIPPED FACE GETS WRONG

The **ranking is right and I am not re-cutting it** (§3). The gaps are structural — the ones you
expect of a face authored before PF-20 existed.

1. **No `title`, `hint`, `hero`, `sidebar` or page hints** (`tomtom.ts:114-163`).
2. **The glyph flatlines, and I looked.**
   `e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/darwin/face-tomtom-dock.png` (1220×425):
   the hero band is two dark rectangles with a **flat horizontal line** — the `'scope'` glyph
   (`:137`) bound to `audio_out` on a rack nothing has struck. §5a fixes it *without* replacing it.
3. **The audition is below the fold.** `strike` is rank 9 (`:122`) → dock-only, and the baseline
   shows bands 3 (`breath · heat`) and 4 (`output · play`) entirely off the captured pane.
4. **`membrane · sweep` and `membrane · ring` are ONE idea split in two.** Both describe the struck
   head; the split separates `bend_amt` (rank 2) from `bend_time` — the two halves of one gesture —
   and both from `decay`, which sets the envelopes of all three layers.
5. **Two def comments are factually wrong** (§9-b, §9-c). The second matters most: `:141-144` claims
   an un-pinned `bend_cv` *"would fall out of the sweep band into the orphan 'cv' tail"*. It would
   not. `rear-card-model.ts:229` is
   `isPerParamCv = target !== undefined && (port.paramTarget !== undefined || paramIds.has(target))`;
   `bend_cv`'s stem is `bend`, not a param, so this is **false** and `:231` pushes it into the
   leading **voice** band beside TRIGGER/ACCENT/PITCH. The pin stays mandatory — the failure is
   *worse* than the comment says, and invisible to every gate (rear-totality stays green either way).

**Right, and untouched:** rank 1–6, `glyph: 'scope'`, `momentary: ['strike']`, and `rear.audioRate` —
verified against `packages/dsp/src/tomtom.ts:172-180`, where all nine continuous CVs are read `[s]`
per sample unsmoothed while `strike` is read once per block (`:156`, `'k-rate'` at `:124`).

---

## 3. THE ~8 CONTROLS THAT MATTER

`order` is **UNCHANGED**. Presenting an existing ranking as a redesign is the program's
anti-pattern (3); churning a correct one is worse.

| # | key | why it earns the rank (wrong for another module) | cost below |
|---|---|---|---|
| 1 | `tune` | answers *which drum* — 60–90 floor, ~110 mid, 200+ rack into timbale. A **category** control, not a pitch trim: the overtone and the breath band both track it | only key at `mini` |
| 2 | `bend_amt` | the synth-tom identity. 0 = an ordinary resonator, 24 = the Simmons dive. This is what makes it a synth tom rather than a filtered click | shares `compact` with the glyph |
| 3 | `decay` | the ring — and it *sets* the overtone and breath envelopes (`:400`, `:402`). One knob, three layers | — |
| 4 | `tone` | the 1.593× tilt: what separates 808 woody from 909 struck | — |
| 5 | `noise` | membrane ↔ breath — the whole tone→noise-hit axis of an SDS-V kit | — |
| 6 | `drive` | analog heat, **and this voice's loudness lever**, which is what lets `level` be demoted | closes the lane at 6 |
| 7 | `bend_time` | *(reason REWRITTEN — §9-b)* the only continuous knob with a genuine **inert region** (`bend_amt = 0` ⇒ silent), and the sculptor's half of a pair whose depth half is rank 2 | dock-only |
| 8 | `level` | the drum-family rule: loudness is DRIVE, and `level` sits *before* the true-peak bound (`:425-426`), so it is a saturation lever, not a fader. The mixer owns the fader | dock-only |
| 9 | `strike` | a momentary PAD. `laneBodyPlan`'s no-clip guarantee is derived from knob-column geometry, so a button has no place in the plate; the lane tile already carries the TRIG jack | dock-only — **now the hero action** |

**THE LOSERS, NAMED.** `bend_time`, `level`, `strike` render in **no** lane tier —
`LANE_PLATE_MAX_CELLS = PLATE_COLS × PLATE_MAX_ROWS = 6` (`module-shell-model.ts:291-292`).
Unchanged by this spec; stated so it is not re-found as a bug. At `full`, 6 cells → 2 rows →
`laneBodyPlan` drops the glyph; the scope survives at `mini`, `compact` and the dock hero only.

**Re-rank considered and REJECTED — `bend_time` 7 ↔ `drive` 6.** *For:* three of the four named
recipes specify a bend TIME (808 = 40 ms, 909 = 60, Simmons = 200+) and only one specifies drive, so
the lane ships half a two-knob gesture. *Against, decisively:* `level` is demoted to 8 **because**
drive is the loudness control. Demote drive and the lane has no loudness control at all,
retroactively invalidating the argument that put `level` at 8. Two demotions cannot lean on each
other. **If you disagree: swap `drive` and `bend_time` in `order`, change nothing else.**

---

## 4. BAND STRUCTURE + THE ANNOTATION PROSE

**4 pages → 2, by GROUPING SEMANTICS.** I explicitly decline the round-2 spec's fold arithmetic: its
"per-band constant of 88 px cross-checked six ways" was falsified by its own fact-checker off the
same committed line (`vrt-exemptions.ts:1077` — shimmershine 3 pages = 58 px vs karplus 3 pages =
106; dx7 4 pages = 166 vs tomtom 4 pages = 194). Overflow is a function of band CONTENT, and
`workflow-shell-faces.spec.ts` shoots the `dock-full-view` ELEMENT in Chromium's default window, so
425 px is that pane, not a design constraint.

```ts
pages: [
  {
    id: 'membrane',
    label: '1 · membrane — the struck head',
    hint: 'one head: it starts sharp, falls to TUNE, rings, and tilts between the fundamental and its 1.593× second mode, which damps faster',
    controls: ['tune', 'bend_amt', 'bend_time', 'decay', 'tone'],
  },
  {
    id: 'air',
    label: '2 · breath — the stick, then the bus',
    hint: 'band-passed skin noise summed BESIDE the membrane (centre 2.5× TUNE, floored at 300 Hz; its decay is half the ring, held between 25 and 500 ms), then warm-tanh drive, DC block, level, true-peak bound',
    controls: ['strike', 'noise', 'drive', 'level'],
  },
],
```

Band 1 renders **4** cells, band 2 **3**: `tune` and `strike` are listed here because `hero`
PROMOTES a key rather than copying it, so the key must still be claimed by a page — `heroFacePlan`
(`dock-faceplate-model.ts:127-159`) lifts them out. Neither band empties.

**Does this read with EVERY hint hidden?** Yes — that is the test I designed against.
`1 · membrane — the struck head` over BEND / B TIME / DECAY / TONE is a complete instruction: the
number says which stage of the voice, the noun says what it is, and all four knobs are properties of
a drum head. `2 · breath — the stick, then the bus` over NOISE / DRIVE / LEVEL reads in signal order
without a sentence. The hints carry *mechanism* (the Bessel ratio, the 300 Hz floor, the breath
clamp) — exactly what annotation mode is for. I have deliberately **not** smuggled the 300 Hz floor
into a label: it is a NUMBER, so it goes in the readout strip (§5c), live rather than prose.

Two bands, so `dockTabPlan` never fires (`DOCK_TAB_MIN_BANDS = 7`, `dock-tabs-model.ts:46`) and the
hints can render at all — the platform fails a hint declared on a tabbed face.

**Rear — the ONE load-bearing coupling.** The curated group that pins `bend_cv` must be re-pointed
`sweep` → **`membrane`** in the SAME edit, because `rearFieldPlan` claims a curated group by
matching a **page id**. Get it wrong and the group appends as an "extra curated" band while
`decay_cv`/`tone_cv` form a second `membrane` band — and the rear-totality gate **stays green**,
because every port still renders exactly once.

```ts
rear: {
  groups: [
    { id: 'voice',    label: 'strike · voice',   ports: ['trigger_in', 'accent_in', 'pitch_cv'] },
    { id: 'membrane', label: 'membrane · the head', ports: ['tune_cv', 'bend_cv', 'bend_time_cv'] },
  ],
  audioRate: [ /* unchanged — all nine continuous CVs */ ],
},
```

Page ids `membrane`/`air` collide with neither `voice`, `signal` nor `cv`, so the dx7 double-band
scar cannot fire; and no rear band label prefixes another (`strike · voice`,
`membrane · the head`, `2 · breath — the stick, then the bus`).

---

## 5. THE HERO + THE READOUT STRIP

### 5a. NO bespoke `hero.cell` picture — the spec's main judgement call

1. **Declaring a `cell` SUPPRESSES the live glyph at the dock.** `ModuleShell.svelte:353` —
   `heroGlyph = hasGlyph && !(view === 'dock-full' && hero?.cell)` — and `types.ts:697-700` states
   why (the glyph traces the OUTPUT, a picture describes the PATCH). A tomtom hero picture would
   **replace a surface that is real when you play it with a drawing that is never real.** On a voice
   whose whole identity is one transient, that is the wrong trade.
2. **Everything the picture would draw is two numbers the strip already prints live.** kickdrum's
   graph exists because its envelope is a *sum of three layers at three mix levels* — a shape no
   number captures (TAIL 398 ms against a 450 ms knob). tomtom's is one falling sine under one
   exponential: *starts at X, settles to Y, rings Z*, and §1's measurement shows there is no hidden
   shape to reveal.
3. **Cost.** A picture is `+1 controlFamily` (**a real contract-lock line**), a ~300-line component
   (`KickdrumHeroPanel.svelte` is 401), a pure model + its negative-control test, a rank-7 panel and
   `+1` faces-parity cell — more platform than instrument on a 9-param module.

**The flatline objection is answered, not ignored.** `hero.action = 'strike'` puts the audition
beside the glyph: one click and the trace is real. tomtom is the **one** struck voice in the rack
that needs no platform work to get there — its audition is already a declared `ParamDef` (`:81`) on
`face.momentary` (`:130`), rendered as a press-and-release `<Button>` by
`ModuleShell.firePressParam`, where kickdrum, karplus, sixstrum and snaredrum each needed a
`controlFamily` + a `shell-cells` `action` + the `manual-strike-actions` engine seam. **No PF-6f, no
family, no contract line.** (If the glyph vocabulary later gains a `transient`/one-shot-hold kind,
tomtom is its first correct consumer — that is a glyph-wave PR, not this one.)

**Does tomtom mirror kickdrum? Partly, and the boundary is principled.** It takes the parts of the
grammar that are DATA — title, hint, numbered bands, a readout strip, a signal-flow diagram, a
preset roster — because those are the same shape on every instrument and cost nothing. It declines
the part that is CODE, because tomtom's picture carries no information the strip does not print.
That is the platform's own rule about sidebars, applied one field over.

### 5b. The hero rail

```ts
hero: { control: 'tune', action: 'strike', readouts: [ /* §5c */ ] },
```

`tune` because it is rank 1 for the same reason it is the hero: *which drum*. `strike` beside it
because the voice makes no sound until something hits it — and because it is the one control this
re-do rescues from below the fold.

### 5c. THE READOUT STRIP — 4 entries (correction 1: a full-width row BELOW the graphic)

Reads as a sentence: **starts at 165 Hz · settles to 110 Hz · ring 350 ms · breath 300 Hz.**

| label | source | at defaults |
|---|---|---|
| `starts at` | `valueId: 'tomtom-strike-hz'` | **164.8 Hz** |
| `settles to` | `paramId: 'tune'` | 110 Hz |
| `ring` | `paramId: 'decay'` | 350 ms |
| `breath` | `valueId: 'tomtom-breath-hz'` | **300 Hz** |

Four, not six. `bend_amt` is deliberately **absent**: printing "+7 st" beside a `bend_amt` dial one
band down is exactly the noise the correction warns about, and `starts at 165 Hz` is the same fact
in the unit a player can hear.

**DERIVED 1 — `tomtom-strike-hz`.**
*Formula:* `tomFreqHz(tomTuneHz(tune, 0), 0, /* bendEnv */ 1, bend_amt, /* accent */ 0)` =
`clamp(tune,60,400) × 2^(clamp(bend_amt,0,24)/12)`. Traced to `tomtom-dsp.ts:212-222`, evaluated at
`bendEnv = 1` because that is what `strikeTom` sets at the strike instant (`:320`). It runs the
**worklet's own function** by relative import (the `kickdrum-face-model` precedent).
*Genuinely two-input:* `tune` reads 110, `bend_amt` reads 7 st, neither is 164.8 Hz.
*NEGATIVE CONTROL (must MOVE):* hold `tune = 110`, move `bend_amt` 7 → 24 ⇒ **164.8 → 440.0 Hz**,
while a `paramId:'tune'` readback does not move at all. **[measured]**
*SECOND LEG (must NOT move):* `bend_time` 60 → 300 and `decay` 350 → 1500 leave it unchanged —
`bend_time` sets how fast it settles, never how high it starts. An implementation that reached for
`bendTimeEff` fails this leg.
*Home:* a permanent leg of `tomtom-face-model.test.ts` (unit lane).
*Stated limitation:* a readout reads PARAMS, so this is the knob-state strike pitch — an attached
`pitch_cv`/`tune_cv`/`bend_cv`, or a latched accent (up to +50 % sweep, `ACCENT_BEND` `:106`), is
invisible to it. Put that in the def comment so nobody reads it as a meter.

**DERIVED 2 — `tomtom-breath-hz`.**
*Formula:* `clamp(clamp(tune,60,400) × 2.5, 300, 6000)` — `tomtom-dsp.ts:386`, constants `:75`,
`:77-78`.
*The strongest readout here, because its negative control runs the OTHER way.* At the default
`tune = 110` the answer is **300 Hz — the FLOOR**, not 275.
*NEGATIVE CONTROL (must NOT move):* sweep `tune` 60 → 80 → 100 → 110 → 120 and the readout stays
pinned at **300 Hz** at every step, while a `paramId:'tune'` readback moves on every one.
**[measured]** A derived value that is *invariant where the knob is not* cannot be faked by a
relabelled knob.
*SECOND LEG (must MOVE):* `tune` 200 → 400 ⇒ **500 → 1000 Hz**. *THIRD LEG (must NOT move):*
`noise` 0 → 1 ⇒ unchanged (NOISE is the mix; the centre is not a function of it).
*Home:* the same permanent test file.

**`ring` is `paramId: 'decay'`, and that is the honest answer, not the lazy one.** I looked for the
kickdrum trap and it is not here (§1's measurements). A derived function buys ≤15 % accuracy at one
corner and costs a registry entry plus a permanent negative control, for a number whose knob is one
band below. **Revert is one line** (`valueId: 'tomtom-tail'`) plus the registry entry and a
`noise`-perturbation leg.

**Also considered, rejected:** `breath decay = clamp(decay × 0.5, 25, 500)` — a real derived value
with a real negative control (`decay` 1000 → 1500 leaves it pinned at 500 ms while the knob moves,
**[measured]**). Dropped: five readouts crowd the strip and this is the least useful. It is in the
band-2 annotation prose instead.

---

## 6. THE SIDEBAR — `presets` + `signal-flow`, both pure data, zero contract cost

**No `custom` panel:** `stereo-crossover` is the only registered id (`sidebar-panels.ts`) and tomtom
is mono; a new one costs a component + a registry line for a picture the strip states in numbers.
**No `readouts` block:** the hero strip carries the four numbers, and a second copy is the "two
surfaces disagreeing about one number" hazard `readoutText`'s own doc warns about.

### 6a. `presets` — this module's strongest sidebar case in the rack

`docs.explanation` names **four corner recipes with numbers** ("808 woody = Tune low-mid, Bend ~3 st
/ 40 ms, Tone low, Noise ~0.3 …") and the DSP header names the same lineages (`tomtom-dsp.ts:6-23`).
Today a player must read the doc page and hand-dial seven knobs. A preset is a full stamp through
the ordinary write path — undoable, synced, immediately editable — so the def's own claim ("corners
of one continuous space, **not** presets") survives intact. Two entries are byte-for-byte the
committed VRT scenes (`vrt-karplus-tomtom-states.spec.ts:80`, `:89`), so roster and baselines agree
by construction rather than by luck.

```ts
{ kind: 'presets', label: 'toms', entries: [
  { id: '808-woody',     label: '808 WOODY',   note: '80 Hz',
    values: { tune: 80,  bend_amt: 3,  bend_time: 40,  decay: 420,  tone: 0.15, noise: 0.30, drive: 0.15, level: 0 } },
  { id: '909-punchy',    label: '909 PUNCHY',  note: 'drive',
    values: { tune: 130, bend_amt: 7,  bend_time: 60,  decay: 260,  tone: 0.50, noise: 0.25, drive: 0.55, level: 0 } },
  { id: 'simmons-zap',   label: 'SIMMONS ZAP', note: '24 st',
    values: { tune: 60,  bend_amt: 24, bend_time: 300, decay: 1200, tone: 0.70, noise: 0.60, drive: 0.80, level: 0 } },
  { id: 'floor-deep',    label: 'FLOOR TOM',   note: '1.2 s',
    values: { tune: 60,  bend_amt: 4,  bend_time: 90,  decay: 1200, tone: 0.10, noise: 0.20, drive: 0.20, level: 0 } },
  { id: 'timbale-tight', label: 'TIMBALE',     note: '400 Hz',
    values: { tune: 400, bend_amt: 2,  bend_time: 15,  decay: 40,   tone: 0.10, noise: 0.90, drive: 1.00, level: 0 } },
]}
```

Every value checked against its declared range (`contract-lock.txt:3354-3362`): `bend_time: 15` ≥ 10
✓, `decay: 40` = the floor ✓, `drive: 1.00` = the ceiling ✓. The roster spans the full 60 → 400 Hz.

**⚠ EACH ENTRY IS 8 OF 9 PARAMS, AND THE OMISSION IS DECLARED.** `strike` is excluded because it is
a momentary PAD, not a setting: `strike: 0` would be a meaningless write and `strike: 1` would fire
a hit on recall. This IS a complete recall of every VALUE the voice has, and the def comment must
say that sentence — kickdrum's own note records that a 24-of-25 preset with undocumented omissions
is worse than either honest option.

### 6b. `signal-flow` — 6 stages, and **no `parallel` mark**, deliberately

```ts
{ kind: 'signal-flow', label: 'signal flow', stages: [
  { label: 'MEMBRANE', role: 'generator', note: 'fund + 1.593×' },
  { label: 'BREATH',   role: 'generator', note: 'band-passed noise' },
  { label: 'DRIVE',    role: 'bus',       note: '2× tanh · bypassed at 0' },
  { label: 'DC BLOCK', role: 'bus',       note: '20 Hz' },
  { label: 'LEVEL',    role: 'bus',       note: 'dB, pre-bound' },
  { label: 'OUT',      role: 'bus',       note: 'true-peak tanh' },
]}
```

**Why nothing is `parallel`, when it is tempting.** `parallel` means *taps the bus earlier and
rejoins it further down* (`types.ts:737-748`). BREATH taps nothing — it is a second GENERATOR summed
with the membrane before the bus starts (`tomtom-dsp.ts:415`), exactly like kickdrum's
SUB/BODY/CLICK, none of which are marked parallel. Marking it would teach that turning NOISE up
excites the driven signal; it does not. The drum family's one genuinely parallel stage is kickdrum's
TRANSLATE, and tomtom has no equivalent. **DRIVE's note earns its place:** the stage is gated off
outright below 0.001 (`:418`), so at `drive = 0` the chain really is five stages — not derivable
from the diagram.

---

## 7. RANGE / CURVE / VOCABULARY CHANGES — none; one hazard reported

**Zero.** No range, `curve`, `options`, `landmarks`, `format` or `units` change. Rejected: a PF-3
`format` on tune/decay/bend_time (the units ladder already prints `110 Hz` / `350 ms` through
`knobValueReadout`, and an ungated persistent readout moves ~17 dock baselines for nothing);
`options` on any knob (every one is a real continuum); `landmarks`.

**THE HAZARD — the card re-types all eight ranges, and every one AGREES.** `TomtomCard.svelte:110-113`
(60..400 / 0..24 / 10..300 / 40..1500), `:119-121` (0..1 ×3), `:127` (−24..12) vs `tomtom.ts:71-78`.
Checked all eight by hand: **no divergence, so no live bug of the backdraft class.** It is still a
one-source-of-truth violation — the card single-sources `defaultValue` through `cardParams` (`:28`)
and hand-types the ranges beside it — and the legacy card is still live at `/rack`, backing five
committed VRT baselines. Boy-scout fix if this PR touches the module: give `cardParams` a
`rangeFor(id)` beside `defaultFor(id)` and use it on all eight faders. Importing the same numbers
changes no pixels, so no baseline moves.

---

## 8. COST

- **contract-lock: ZERO lines.** `contract-signature.ts` has no `face` branch (no `face` field on
  `ContractDefLike`, no `face` case in `serializeModuleContract`). No new param, port, family, edge
  or range. `task docs:accept` **must produce an empty diff** — any line means something touched the
  contract and is a bug, not an accept.
- **New non-contract files:** `packages/web/src/lib/ui/modules/tomtom-face-model.ts` (~60 lines,
  pure, importing `tomFreqHz`/`tomTuneHz` from the DSP core by relative path) + its test, and **+2
  entries** in `face-readout-values.ts`. Neither is a contract surface.
- **VRT — MOVES:** `darwin/face-tomtom-dock`, hard (page header + hero rail + readout strip +
  sidebar column, 4 bands → 2). **MUST NOT MOVE — assert, do not assume:**
  `darwin/face-tomtom-compact` (ranks 1–2 and the glyph untouched; PF-20 is dock-only);
  `vrt.spec.ts/{darwin,linux}/tomtom.png`; and
  `vrt-karplus-tomtom-states.spec.ts/{darwin,linux}/tomtom-{simmons-zap,timbale-tight,strike-held}.png`
  — the last three shoot the **legacy card** (`:137` locates `.svelte-flow__node-tomtom`) and are the
  three scenes the round-2 spec omitted while asserting "2 tomtom scenes". There are **five**
  face-independent tomtom baselines per platform. A diff on any of these four rows is a FINDING.
- **Lane:** none of it is in the required gate. tomtom is absent from `STRICT_VRT_MODULES`
  (`vrt-exemptions.ts:863+`), and `workflow-shell-faces.spec.ts` is in `FULL_MATCH` but **not**
  `STRICT_MATCH` (`vrt.config.ts:37`) — all informational (`task vrt`).
- **VRT drain, in this order** (a drain without its re-capture ships a red lane): (1) delete
  `'linux/face-tomtom-compact'`/`'linux/face-tomtom-dock'` (`vrt-exemptions.ts:1057-1058`) **and**
  lower `SHARED_LINUX_PAIR_CEILING` 91 → 89 (`vrt-meta.test.ts:333`) in the SAME commit — it is
  asserted both ways (`:524`, `:526`), so slack is red, not silent; (2) dispatch
  `vrt-update.yml -f platform=linux`, **unscoped**; (3) once the PNGs land, lower
  `LINUX_DEFICIT_CEILING` 148 → 146 (`:562`, both ways at `:611`/`:619`) — that ratchet is anchored
  to the ARTIFACT, so it only moves when the files exist; (4) approve the `action_required` runs.
  Also refresh the overflow note at `vrt-exemptions.ts:1077` — **re-measure**, never predict from a
  per-band constant.
- **e2e:** `workflow-shell-faces.spec.ts:55` `{ type:'tomtom', pages: 4 }` → `2`. **faces-parity
  cells UNCHANGED at 9** (9 params + 0 families). No new bespoke spec.
- **CI wall-time ≈ 0 s** (bounded ±1 s): faces-parity's budget is
  `FACE_FIXED_MS + FACE_PER_CELL_MS × cells.length` and `Δcells = 0`; scene count unchanged; the
  dock renders 2 bands instead of 4. The two new unit tests are pure functions (single-digit ms).
  Nothing needs the >2 min sign-off.
- **ART: NIL — confirmed.** `art/scenarios/tomtom/profile.test.ts:86` and `:161` pin `dspSourceSha`,
  which hashes `packages/dsp/src` only. Importing those files into a web model reads them; it does
  not change them. **Attest: NIL** — `packages/web/src/lib/audio/modules/**` is in neither basis.
- **Push 2:** tomtom has no `PUSH_CARD_CONTROLS` override, so its card resolves from the live def.
  This spec adds no param, so the card cannot move — `push-card-schema.test.ts` is the gate.

---

## 9. DEFECTS FOUND IN SHIPPED CODE  *(follow-ups, NOT spec content)*

**a. `strike` can persist stuck at 1 in the Y.Doc, permanently masking `trigger_in`.**
`TomtomCard.svelte:44-60` (and `ModuleShell.firePressParam`, `ModuleShell.svelte:439-445` on the
platform branch) write the pad through `setNodeParam`, i.e. into the **shared document**. The
release write happens only if the release EVENT reaches the button — and pointer capture protects a
*moving* pointer, not a *deleted element*: close the dock, delete the module or hide the tab
mid-press and the button unmounts holding 1. The sibling audition seam knows this exactly —
`manual-strike-actions.ts` installs `ensurePanicListeners()` (`pointerup`/`pointercancel`/`blur`/
`visibilitychange`) for precisely this, and writes nothing to the graph. The press-param path has
neither protection. On tomtom the consequence is worse than a stuck button, because the worklet ORs
**levels**, not edges (`packages/dsp/src/tomtom.ts:182`): with `strike = 1` latched, `trig` is high
forever, `high && !prevHigh` never fires, and **an external sequencer cable stops striking the
drum** — and the state survives save/reload, firing one hit at spawn. `ModuleShell.svelte:437`
asserts the opposite. *Catchable:* a unit test that unmounts the pad mid-press, or route the
press-param through the same panic latch. **Platform fix, not this face PR.**

**b. `tomtom.ts:102-105` — the `bend_time` rank-7 justification is wrong.** It says bend_time is
*"inaudible while BEND sits at 0"*; `bend_amt` defaults to **7 st** (`:72`), so it is audible on a
fresh spawn. The rank is right, the reason is not. Doc-accuracy fix; safe to fold in (wording in §3).

**c. `tomtom.ts:141-144` — the rear-pin comment names a failure mode that cannot occur.** See §2.5.
It costs the next author, who will "fix" a phantom and miss the real one. Fold the correction in.

**d. `tomtom-dsp.ts:224` — stale JSDoc contradicts its own constant.** The doc says *"±12 st per
volt"*; `BEND_CV_ST = 24` (`:112`), the code is `BEND_CV_ST * clamp(bendCv,-2,2)` (`:226`), and
`docs.inputs.bend_cv` says ±24. Three of four sources agree; this one is 2× out. Comment-only — but
`packages/dsp/src` is inside the ART source-SHA basis, so land it in a PR that expects an
`art:update`. **Do NOT fold into the face PR.**

**e. Coverage hole: worklet inputs 7–10 are never driven at any tier.** `tomtom.test.ts:135-138`
builds only **seven** input arrays, so `tune_cv`, `bend_time_cv`, `drive_cv`, `level_cv` never reach
the *wrapper*; their laws are covered (`tomtom-dsp.test.ts:154-195`) but through the core params
directly. A mis-wire between `inputsMap` (`tomtom.ts:251-254`) and `inputs[7..10]`
(`packages/dsp/src/tomtom.ts:146-149`) would ship silently. I verified by hand that they currently
**agree** — a missing gate, not a live bug. Fix: extend `runProc`'s `ins` array to 11 + four
routing assertions.

**f. Platform review note (PR #1301):** `heroProblems` validates that `hero.cell` is a panel but
never validates that `hero.action` is action-shaped, so a plain knob promoted to `action` renders a
dial in the audition slot with nothing red. tomtom is correct by construction; the next author will
not be. One lint clause.

---

## 10. VERIFICATION GATE

```sh
# 1. the two DERIVED readouts + their negative controls (the whole point).
#    Permanent legs: strike-hz bend_amt 7→24 @ fixed tune ⇒ 164.8→440.0 (MOVES);
#    strike-hz bend_time 60→300 + decay 350→1500 (does NOT move);
#    breath-hz tune 60/80/100/110/120 ⇒ pinned 300 Hz (does NOT move);
#    breath-hz tune 200→400 ⇒ 500→1000 (MOVES); breath-hz noise 0→1 (does NOT move).
REPEAT=3 flox activate -- task test:one -- tomtom-face-model

# 2. hero ranked + promoted once, readout ids registered, presets in range,
#    panel ids registered, hero split TOTAL, no hint on a tabbed face
flox activate -- task test:one -- module-face-lint

# 3. the contract MUST NOT move — an EMPTY diff is the pass
flox activate -- task docs:accept
flox activate -- git diff --exit-code -- packages/web/src/lib/docs/contract-lock.txt

# 4. the ratchets, after the drain edit
flox activate -- task test:one -- vrt-meta
flox activate -- task test:one -- push-card-schema

# 5. structure before pixels (pages 4→2), then the dock face
flox activate -- task e2e:serve
REPEAT=3 flox activate -- task e2e:one -- "faces-parity"     # cells still 9
REPEAT=3 flox activate -- task vrt:one  -- face-tomtom       # dock MOVES; compact MUST NOT

# 6. the four rows that MUST NOT move — a diff here is a FINDING, not a re-pin
flox activate -- task vrt:one -- tomtom                      # legacy card (vrt.spec)
flox activate -- task vrt:one -- tomtom-strike-held          # + simmons-zap, timbale-tight

# 7. the real source chain still sounds
REPEAT=3 flox activate -- task e2e:one -- tests/tomtom.spec.ts
flox activate -- task e2e:stop

# 8. strict where vitest is lenient
flox activate -- task typecheck
```

Then drain `vrt-exemptions.ts:1057-1058` + `SHARED_LINUX_PAIR_CEILING` 91→89 in ONE commit, push,
dispatch `vrt-update.yml -f platform=linux` **unscoped**, approve the `action_required` runs, and
lower `LINUX_DEFICIT_CEILING` 148→146 once the two PNGs are committed. A green dispatch that commits
nothing is a RED FLAG — `git rm` the baseline and re-dispatch rather than concluding "nothing to do".
