# FACE SPEC — `score` (batch 7)

## 0. STATUS AND VERDICT

**Authored 2026-08-11 against `main` at `2af79daf`.** Nothing here is
implemented. Every number below was measured against that tree — the ADSR
figures through the REAL shipping `packages/dsp/dist/adsr.{wasm,json}`, the
timing figures through the REAL exported `score-data` helpers.

**Verdict: NO FACE ON MERIT, THIS BATCH.** It is the closest call of the three
and the argument runs both ways; §0b states the case FOR in full before §0c
states why it loses. **The conditions under which it flips are named in §0d and
both are reachable** — this is a "not yet", not a "never".

**What SHOULD ship instead, now, at zero risk:** the four measured facts in
§2–§3 as `docs` corrections on the def plus two wrong prose lines in shared
files (§6), and the remaining scheduler defect (§3-D, the #229 clock ring) as
its own owner-audition PR. That is a small, uncontroversial PR that pays most of
what a face would have paid. (§3-A, the triplet dead slots, **shipped in
#1483**.)

archetype: **the notation sequencer.** A treble staff of up to 4 pages × 16 bars
in 4/4, played back at a 16th-note resolution into pitch / gate / env / clock CV,
with a built-in ADSR scaled by the dynamic marking in force.

Registry position: **not** in `STRICT_FACES`; no `face:` block. In `STRICT_DOCS`
(`strict-docs.ts:238`). In `STRICT_VRT_MODULES` (`vrt-exemptions.ts:1060`) — the
REQUIRED `vrt-strict` gate, with a committed `vrt.spec.ts/score.png`. **Not** in
`DOCKABLE_TYPES`. **Not** in `PUSH_CARD_CONTROLS`. **Deliberately excluded from
`INTERACTIVE_DOC_MODULES`** (`interactive-doc-modules.ts:171`, reason quoted in
§0c). `rack-sizes.ts:125` — `4u / hp 4`, 597×720 px.

---

## 0b. THE CASE FOR A FACE, STATED PROPERLY

It is not weak, and it is the `noise` case almost exactly.

1. **Its lane render TODAY is a lossy placeholder.** `score` is not on
   `NON_SHELL_LANE_TYPES` (`legacy-fallback.ts:66-77`), so
   `laneRenderKind({shellFaces: true, hasCard: true, migrated: false})` returns
   `'placeholder'` (`:107-111`) — a uniform styled tile with none of its
   controls. Faceplates are the product now (that file's own comment: *"until
   faceplates became the product"*), so score's canvas presence is currently a
   grey rectangle with an EXPAND button. A face would at minimum put BPM and the
   ADSR in the lane.
2. **Four true things about it are stated nowhere and all four are invisible to
   its own controls** — the `noise` argument verbatim. §2 and §3 measure them.
3. **It is small.** 6 params + 3 families = 9 cells, against `mixmstrs`' 91 and
   `cube`'s 28.
4. **All five of its faders are CONTINUOUS**, so unlike `writeseq` (whose
   `length`/`octave` throws the lint refuses) score's card look reproduces
   exactly under `face.paramCells`. `bpm` linear, `attack`/`decay`/`release`
   log, `sustain` linear — every one passes
   `module-face-lint.test.ts:593-606`'s continuous-only clause.

If the module's identity were its ADSR, this would be a promote.

---

## 0c. WHY IT LOSES — three reasons, in order of weight

### 1 · Promotion REPLACES the staff, and the staff is the module

`DockFullView` switches on `migrated(type)` — bare `STRICT_FACES` membership —
so the day score joins that set, the dock full-view stops rendering
`ScoreCard.svelte` and starts rendering a faceplate. There is no flag: the
`?shell=1` gate covers the LANE only, and the owner has ruled (2026-07-26) that
the dock's flag-free behaviour is intended and must not be conjoined.

Reproducing the staff means extracting a **1257-line** card's SVG renderer
(`ScoreCard.svelte:841-1006`: 4 rows × 5 lines, per-row clef and key signature,
tie arcs, note glyphs with stems and flags, dynamics, a draggable stop-bar with
a 16 px hit rect, a playhead highlight fed by an rAF poll, and a
seven-branch pointer model at `:402-525`) into a shared surface both mounts use.
That is the **cube precedent** — `CubeVizSurface.svelte`, #1452 — and it is
exactly as expensive as it sounds: cube's extraction moved the WebGL attest
BASIS SET and required an owner ruling plus a real-GPU re-attest.

And then it must be re-cut. `TOTAL_HEIGHT = 374` (`ScoreCard.svelte:164`, =
18 + 4×80 + 36) against the measured **~352 px** dock scrollport. That is the
wavesculpt shape — a **445 px** hero against the same 352 px box, which pushed
every band below the fold and made all eight tabs of its rail look identical.
One staff ROW is 80 px and would fit, but a one-row staff is a different
instrument from a four-row page: you cannot see a phrase.

### 2 · Three control families for ONE surface

`STRICT_FACES` completeness requires every declared `controlFamily` in
`face.order` (`module-face-lint.test.ts:243-248`), and every one of those keys
must resolve to a registered `shell-cells.ts` spec or it renders
`data-cell-inert="true"` — which **two** gates fail on (`shell-cells.test.ts:55`
and faces-parity's `not.toBe('inert')`, `faces-parity.spec.ts:460`).

score declares three: `score-note`, `score-tie`, `score-dyn`. They are three
FACETS of one staff, not three controls. The least-bad shape is one panel plus
two tool selectors — and both selectors run straight into a state problem: the
active tool is card-LOCAL `$state` today (`ScoreCard.svelte:235`, `:248`), while
`ShellToggleCell` / `ShellSelectorCell` are both backed by `node.data`
(`shell-cells.ts:186-192`, `:78-85`), which rides the Y.Doc. Moving the tool
selection into `node.data` means one collaborator's choice of "tie tool"
switches everyone's, and dirties the patch. The `text`-probe escape hatch exists
for exactly this ("a private VIEW setting … must not re-zoom everyone else's
screen") but it applies to a PANEL, not to a toggle cell.

So the honest cell set is: one big panel and two more panels, or one panel and
two cells that write shared state they should not. Neither is a batch item.

### 3 · The platform has already declined to generalise over this card, twice

- `DOCKABLE_TYPES` (`dockable.ts`) is the control-first allowlist and score is
  not on it, though `sequencer`, `drumseqz`, `polyseqz`, `writeseq` and `macseq`
  all are.
- `INTERACTIVE_DOC_MODULES` excludes it **by name and with a reason**:
  *"score's card is an SVG staff with mouse note-entry"*
  (`interactive-doc-modules.ts:171`, echoed at `strict-docs.ts:230-236`).

Two independent systems that generalise across modules have both carved score
out for the same property. A third — the face system — reaching a different
conclusion needs a better argument than "it has four undocumented facts."

### And the discriminator against `noise`, in one line

`noise` is the precedent for "promote a module the tier ladder says no to," and
it holds only because **noise's card was reproducible by the faceplate**: one
param, zero families, and `paramCells: {level:'fader'}` made the dock render the
same throw the card draws. Its legacy VRT baseline passed **pixel-identical**.
score's card cannot be reproduced by any arrangement of shell cells, and its
`vrt.spec.ts/score.png` is a REQUIRED `vrt-strict` baseline.

---

## 0d. WHAT WOULD FLIP IT

1. ✅ **The triplet dead-slot fix lands** (§3-A). **DONE — #1483.** This
   condition is MET. (The reasoning stands as a rule: a faceplate that
   documented "8 of 12 triplet positions never sound" would have painted a
   REPAIRABLE defect as permanent — the mistake `clouds` made with its SIZE
   `CLAMPED` badge before #1456 raised the ceiling and the badge had to be
   deleted.)
2. **The staff renderer gets extracted for some other reason** — a doc-page
   renderer, a print/export view, a second mount of any kind. The moment
   `ScoreStaffSurface.svelte` exists and both mounts use it, reason 1 above
   drops from "a 1257-line extraction" to "declare a panel", and the case for
   is strong.

---

## 1. THE CONTRACT

### 1a. Params — 6 (`score.ts:130-137`)

| id | label | range | curve | default | units | card draws |
|---|---|---|---|---|---|---|
| `bpm` | `BPM` | 30 .. 300 | linear | 120 | — | Fader |
| `attack` | `A` | 0.001 .. 10 | log | 0.005 | s | Fader |
| `decay` | `D` | 0.001 .. 10 | log | 0.1 | s | Fader |
| `sustain` | `S` | 0 .. 1 | linear | 0.7 | — | Fader |
| `release` | `R` | 0.001 .. 10 | log | 0.3 | s | Fader |
| `isPlaying` | `Play` | 0 .. 1 | **discrete** | 0 | — | button |

One switch-shaped param → **one `ACKNOWLEDGED_LATCHING` entry** if promoted.

### 1b. Ports — 11 in, 4 out

`clock` (gate, trigger) · `attack`/`decay`/`release` (cv, `paramTarget`, log) ·
`sustain` (cv, `paramTarget`, linear) · the six transport CV ports.
Out: `pitch` (pitch) · `gate` (gate, `edge:'gate'`) · `env` (cv) · `clock`
(gate, trigger).

### 1c. Control families — 3

`score-note` · `score-tie` · `score-dyn`, all `kind: 'cell'` (`score.ts:186-190`).

**9 cells.** `contract-lock.txt:2764-2789` already pins all of it; a `face` adds
zero lines.

⚠ The card's family testids are `score-note-{id}-{noteId}` where `noteId` is a
random `genId()` (`ScoreCard.svelte:258-260`, `:944`), while `docs.controls`
keys them `score-note-{n}`. Harmless today (there is no numbered legend for
score, so `legendStaticKeys` is empty), but a legend would not line up.

---

## 2. WHAT THE ENVELOPE ACTUALLY DOES — measured on the real DSP

**Method.** `packages/dsp/dist/adsr.{wasm,json}` — the exact bytes
`score.ts:197`'s `instantiateFaustModule` loads in the browser — through
`@grame/faustwasm`'s headless `FaustMonoOfflineProcessor`, the path
`art/setup/faust-offline.ts` uses. 48 kHz, 128-sample blocks. Gate trains built
from SCORE's own timing law (`score.ts:377-379`: a stand-alone note's gate is
high for `tickWidth/3 × slotDur × 0.95`, `slotDur = 60/bpm/4`).

**Determinism control: two identical renders bit-equal — `true`.**

### A · THE ENVELOPE IS LINEAR IN ALL THREE SEGMENTS

Not exponential, not the `tau`-based curve the DX7 worklet uses. Measured with
the gate held:

| claim | probe | result |
|---|---|---|
| ATTACK is a linear ramp of exactly `attack` seconds | peak time, t63, t99 | attack 0.05 → peak at **0.0500 s**, t63 **0.0315**, t99 **0.0495** (0.63× and 0.99× of the setting, to three places, at every setting from 0.001 to 2) |
| …and it does not saturate | env at t = 2.000 s | attack 3 → **0.666674** (law: 0.666667) · attack 6 → **0.333337** (0.333333) · attack 10 → **0.200002** (0.200000) |
| DECAY is a linear ramp of exactly `decay` seconds | time from peak to sustain | 0.001→**0.0010** · 0.01→**0.0100** · 0.1→**0.1000** · 0.3→**0.3000** · 1→**0.9998** · 3→**2.9994** · 10→**9.9980** s |
| …and the midpoint is the midpoint | env at `t_peak + decay/2`, sustain 0.5 | **0.750000** at every one of the seven settings |
| RELEASE is a linear ramp of `release` seconds | time from gate-off to <1e-3 | 0.001→**1.0 ms** · 0.01→**10.0** · 0.1→**99.9** · 0.3→**299.6** · 1→**998.6** · 3→**2995.7** ms |

⚠ **The DECAY probe was WRONG on its first pass and printed a clean number.** It
searched from sample 0 for the first value at or below the sustain level — and
the envelope STARTS at 0, so it reported *"reaches sustain at 0.0000 s"* for
every setting, which reads exactly like a dead control. Searching **after the
peak** gives the table above. **NEGATIVE CONTROL on the corrected probe:** driven
with `attack` 0.001 and 0.5 against a fixed `decay` 1, the measured decay span
stays **0.9998 s** in both — the probe is invariant to the thing it must be
invariant to, which is the half the first pass could not have told you.

### B · ATTACK'S TOP OF TRAVEL CANNOT COMPLETE INSIDE A NOTE

Because the attack is a linear ramp of `attack` seconds and SCORE's longest
single note is a whole note gated at 0.95 of its length, the ramp only reaches
full level if `attack` is under that. In LOG travel (the param's declared curve):

| BPM | longest gate | ATTACK travel that completes | that does NOT |
|---|---|---|---|
| 30 | 7.600 s | 97.0 % | 3.0 % |
| **120** (default) | **1.900 s** | **82.0 %** | **18.0 %** |
| 300 | 0.760 s | 72.0 % | 28.0 % |

It is not INERT — a longer attack still lowers the level reached, which is
audible — so this is stated as a ceiling, never as a dead control. What no
surface says is that past 1.9 s at the default tempo the knob stops being an
attack TIME and becomes a level attenuator.

### C · RELEASE IS BOUNDED BY A GAP SCORE FIXES AT 5 %

`score.ts:379` schedules gate-off at `atTime + noteSec * 0.95`, so back-to-back
notes leave the release exactly 5 % of a note. Measured as the envelope value
**at the instant the next note re-gates** (default A/D/S = 0.005/0.1/0.7):

| note | note len | gap | release 0.001 / 0.01 / 0.1 / 0.3 / 1 / 3 / 10 |
|---|---|---|---|
| 16th | 125.0 ms | 6.3 ms | 0.0000 0.2625 0.6563 **0.6854** 0.6956 0.6985 0.6996 |
| eighth | 250.0 ms | 12.5 ms | 0.0000 0.0000 0.6125 **0.6708** 0.6913 0.6971 0.6991 |
| quarter | 500.0 ms | 25.0 ms | 0.0000 0.0000 0.5250 **0.6417** 0.6825 0.6942 0.6982 |
| half | 1000.0 ms | 50.0 ms | 0.0000 0.0000 0.3500 **0.5833** 0.6650 0.6883 0.6965 |
| whole | 2000.0 ms | 100.0 ms | 0.0000 0.0000 0.0000 **0.4667** 0.6300 0.6767 0.6930 |

At 16ths, the four settings from the DEFAULT 0.3 s upward — **38.1 % of the log
travel** — span **0.0142**, i.e. 2.0 % of the sustain level, over a 33× change
in release time. On a stream of 16th notes the top third of the RELEASE knob
does nothing you can hear.

⚠ **THE FIRST PASS OF THIS MEASUREMENT WAS WRONG AND ITS OUTPUT LOOKED
AUTHORITATIVE.** Pass 1 took `max|Δ|` over the whole render between release
0.001 and release 10, and printed **6.999e-1 for every note value AND for a
quarter note followed by 2.5 s of rest** — identical to four figures across a
16× change in the gap, which is the signature of a metric blind to the dimension
under test. It was catching the INSTANT at gate-off, where the two settings
differ by the sustain level no matter how much room follows. **NEGATIVE CONTROL
on the corrected probe** — perturb the gap and confirm the reading moves: duty
0.95 / 0.75 / 0.50 / 0.25 (gap 25 / 125 / 250 / 375 ms) gives env-at-re-gate
**0.641667 / 0.408333 / 0.116667 / 0.000000**. It moves.

### D · THE FULL SWEEP — nothing on this module is inert

Every param at min / mid / max against the default render, on a quarter-note
train at 120 bpm, `max|Δ|` over the env output:

`attack` **9.995e-1** · `sustain` **7.000e-1** · `release` **6.977e-1** ·
`decay` **2.970e-1**.

**Plateau and floor, both.** No setting of any param produced a bit-exactly
identical render, and the module's **quantisation floor** — the smallest
non-zero move anything made over that sweep — is **5.483e-2** (`release` at
mid). So there is no enabler pair here and no sleeping control: unlike
`cofefve` (7 asleep) or `mixmstrs` (18), score's four envelope knobs all work.
That is worth stating because it is the shape of finding a face usually carries,
and score does not have it.

---

## 3. FOUR DEFECTS

### A · ~~EIGHT OF TWELVE TRIPLET POSITIONS NEVER SOUND~~ — **FIXED in #1483**

The scheduler emitted only at `tickIndex * 3` while `quantizeTick` snapped
`triplet8th` to its 4-tick width; 3 and 4 are coprime, so 8 of the 12 triplet
positions in a bar were drawn, coloured, tie-able, selectable — and silent.
Fixed by `slotEmitPlan` (`score-data.ts`, `score.ts`), which keeps the SLOT as
the transport unit but emits at sub-slot grid ticks. A source-join gate now
asserts `score.ts` calls `slotEmitPlan` and contains no bare `tickIndex * 3`,
plus an e2e through the real seed → Y.Doc → engine chain.

⚠ **Keep the WHY, because it is the transferable half.**
`score-data.test.ts`'s *"three triplet-8th notes at 0, 4, 8 fit inside one beat"*
was **green throughout** — `canPlace` is a PACKING predicate and knows nothing
about the scheduler's stride, so it "would read identically green with score.ts
deleted" (#1483's own words). A gate reading one side of a two-sided contract
proves nothing about the other.

### B · THE ENV OUTPUT NEVER REACHES UNITY, AND ff EXCEEDS IT

The raw ADSR peaks at **1.000000** (measured, single note, every note value), and
`dynGain` multiplies it by `DYNAMIC_SCALE[level]` (`score.ts:355`,
`score-data.ts:96-102`):

| marking | gain | dB |
|---|---|---|
| pp | 0.2250 | −12.96 |
| p | 0.4000 | −7.96 |
| **mf (the default, no marker)** | **0.5500** | **−5.19** |
| f | 0.7500 | −2.50 |
| **ff** | **1.0450** | **+0.38 — above full scale** |

So a fresh score patched `env → VCA` runs **5.19 dB under** what an ADSR module
would give, forever, until a dynamic marker is placed — and the loudest marking
overshoots by 0.38 dB. Total authored range **4.644× = 13.34 dB**.

### C · `PORT_NOTES` STATES THE ff GAIN AND STATES IT WRONG

`module-manifest.ts`'s `PORT_NOTES.score.env` says **ff = 0.95**. The shipped
constant is **1.045** (`score-data.ts:102`), and its own comment explains the
change (*"ff 0.95 -> 1.045"*). The note was not updated with it. One line.

`DESCRIPTIONS.score` (`module-manifest.ts:287`) is stale the same way — *"8-bar
treble-clef staff"* against today's up-to-4-pages × 16 bars = **64 bars**.

### D · THE CLOCK RING IS 42.7 ms WHERE THE FIX FOR #229 MADE IT 341 ms

`score.ts:230` sets `clockInAnalyser.fftSize = 2048`. `sequencer.ts:245-261`
carries the fix and its reason verbatim:

> *"At fftSize=2048 the ring only holds ~42 ms — so when the main thread stalls
> longer than that (a canvas pan/drag event-storm can block for 80–150 ms),
> clock edges that arrived during the stall are OVERWRITTEN before the tick gets
> to read them. Those edges are lost ⇒ dropped/late steps ⇒ tempo jitter on
> EXTERNAL clock, which is exactly #229's 'drag disturbs tempo even on MIDI
> clock'. Widen the ring to 16384 samples (~341 ms at 48 kHz)."*

`writeseq.ts:334` took the widening. **score, `macseq.ts:335` and
`cartesian.ts:199` did not** — so #229 is still live on three modules' external
clock inputs, and score is one of them. Being a three-module class, this is its
own PR, not a score PR and certainly not a face PR.

(score also hand-rolls the edge scan rather than calling
`createEdgeCounter`. Its window math is correct — it scans only
`ceil(elapsed × sampleRate)` new samples — so this is a boy-scout item, not a
double-count. `macseq` already calls the seam; score is the last sequencer that
does not.)

---

## 4. IF IT WERE BUILT — the face, for the record

Recorded so §0d does not have to be re-derived. **Do not build this now.**

- **`order`:** `isPlaying`, `bpm`, `attack`, `decay`, `sustain`, `release`
  (ranks 1–6, the lane budget), then `score-note-{n}`, `score-dyn-{n}`,
  `score-tie-{n}` (7–9, dock-only panels).
  Ranking rule: the transport first because a notation module that is not
  running shows a static page and a player needs the run state at mini; then BPM
  (the one thing that changes what the page SOUNDS like without editing it);
  then the ADSR in its own order, which is the only order it has.
- **`paramCells`:** all five continuous params `'fader'` — the card draws
  throws and all five pass the continuous-only clause. The `fader` kind exists
  (#1480), so this reproduces the card's affordance exactly.
- **`glyph: 'envelope'`** — a param-reactive ADSR curve, live from the four
  knobs and deterministic on a frozen graph. `'scope'`/`'meter'` cannot bind:
  score declares no `audio`-typed output.
- **`pages`:** 3 — `transport` (isPlaying, bpm) · `envelope` (a d s r) ·
  `page` (the three family panels). Under `DOCK_TAB_MIN_BANDS = 7`, so one
  scrolling column.
- **Hero:** `cell: 'score-note-{n}'` at **one staff row (80 px)**, never four
  (374 px against a 352 px scrollport is the wavesculpt failure). ⚠ A one-row
  hero cannot show a phrase, which is the unresolved design problem and the
  second half of why this is deferred.
- **Readouts — bare values only**, per the 2026-08-11 ruling:

  | valueId | prints at the defaults | why no control shows it |
  |---|---|---|
  | `score-env-ceiling` | `0.55` | the ENV jack's actual ceiling — `DYNAMIC_SCALE[mf]` × the measured ADSR peak of 1.000000. Not a knob and not a marker; it is the product. |
  | `score-note-ms` | `500 ms` | one quarter at the live BPM, i.e. what the ADSR times are being spent against. |
  | `score-attack-reach` | `100 %` | how far the attack ramp gets inside the longest note at the live BPM (§2-B): drops below 100 % the moment `attack` passes `0.95 × 16 × 60/bpm/4`. |

  Each negative-controlled in BOTH directions against the same predicate the
  readout calls: `score-env-ceiling` must move when a dynamic marker changes and
  NOT when `sustain` does; `score-attack-reach` must move with `attack` AND with
  `bpm`, and not with `decay`.

- **Cost if built:** +0 contract lines, +1 `ACKNOWLEDGED_LATCHING`, **3 shell
  cells (one of them the extracted staff surface)**, 3 `face-readout-values`
  entries, `{ type: 'score', pages: 3 }` in the VRT roster, +2 face baselines,
  +1 faces-parity row at 9 cells (30 000 + 600×9 = **35.4 s**; 45 000 + 1 800×9 =
  **61.2 s** under `SLOW_RENDER`). ⚠ **`score` is in `STRICT_VRT_MODULES`**, so
  any card edit — including the renderer extraction — moves a REQUIRED
  `vrt-strict` baseline, not an informational one.

---

## 5. THE REAR, IF IT WERE BUILT

15 holes (11 in + 4 out), no stereo pairs. Four inputs DO carry `paramTarget`
(`attack`/`decay`/`sustain`/`release`), so unlike `writeseq` the derivation has
something to work with: those four land in the `envelope` page's band on their
own. Only `clock` needs curating out of the orphan rail — it is the one input
that changes the module's whole timebase and the derivation would file it beside
`queue3_cv`.

```ts
rear: { groups: [{ id: 'clock', label: 'clock in', ports: ['clock'] }] }
```

---

## 6. ALREADY-WRONG — the list, ordered by cost to a user

- ~~**A · 8 of 12 triplet positions never sound**~~ — **FIXED, #1483** (§3-A).
- **B · the external clock still has #229**: a 42.7 ms ring against
  main-thread stalls measured at 80–150 ms (§3-D). Shared with `macseq` and
  `cartesian`; one PR for the three.
- **C · `PORT_NOTES.score.env` says ff = 0.95; it is 1.045** (§3-C). One line,
  free, ship now.
- **D · `DESCRIPTIONS.score` says "8-bar"; it is up to 64 bars** (§3-C). One
  line, free, ship now.
- **E · nothing states the ENV ceiling.** A fresh score is 5.19 dB quiet on the
  ENV jack and `ff` is +0.38 dB hot (§3-B). Belongs in `docs.outputs.env` and
  `docs.controls` — a `docs` fix, free, ship now.
- **F · nothing states that the envelope is LINEAR** (§2-A), which is the
  difference between "decay 0.1" meaning a 100 ms ramp and meaning a 100 ms time
  constant. `docs.controls.{attack,decay,release}`, free, ship now.
- **G · `ScoreCard.svelte` re-types every range the def declares** (`:1010-1014`)
  and re-types the defaults twice more (`:84-87`, `:689-692`). It is in neither
  `RANGE_BOUND_CARDS` nor `MAPPING_BOUND_CARDS`, so no gate sees it. It also
  keeps a **second** encoding of the cycle of fifths (`sharpStaffStep` /
  `flatStaffStep`, `:633`/`:643`) beside `score-data.ts:211-212`'s
  `SHARPS_LETTER_ORDER` / `FLATS_LETTER_ORDER`, and a third copy of the card
  width (`CARD_WIDTH = 720` at `:149`, the CSS at `:1065`, `rack-sizes.ts:125`'s
  `hp: 4`).
- **H · `ScoreCard.svelte:891-893` is a dead `{#each}`** rendering
  `{idx === 0 ? '' : ''}`.
- **I · score hand-rolls the edge scan** where `macseq` calls
  `createEdgeCounter` (§3-D parenthetical). Correct today.

**C, D, E, F, H and I are one small PR with no audio change and no baseline
movement. That PR should ship in this batch's place.**

---

## 7. THE BOTTOM LINE

score has the facts a face is built to state and not the shape to state them in.
Its four true-and-unsaid things are worth **six lines of `docs` and two
one-line corrections in shared files** — which is the whole payload, delivered
for none of the cost. What a face would additionally buy is a non-lossy lane
tile, and what it would cost is the staff: a 1257-line extraction, a 374 px
surface cut to 80, three shell cells for one idea, and a REQUIRED `vrt-strict`
baseline in motion.

⚠ **The triplets are fixed (#1483), so §0d's first condition is MET.** The
verdict now rests entirely on §0d-2 — the staff extraction. Ask again the moment
`ScoreStaffSurface.svelte` exists for any reason.
