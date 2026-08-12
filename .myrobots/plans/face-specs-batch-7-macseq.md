# FACE SPEC — `macseq` (batch 7)

## 0. STATUS

**Authored 2026-08-11 against `main` at `2af79daf`.** Nothing here is
implemented; no def, card, DSP or test file is touched. Every number below was
measured or read against that tree.

**Verdict: PROMOTE — the best of the three sequencers in this batch, and the one
that is STRUCTURALLY BLOCKED by the smallest platform gap.** Its five params are
all live on the internal clock, its MODELCV round-trips exactly on all fourteen
engines, and it is already `DOCKABLE` — the only one of the three. But:

> **macseq declares TWO `controlFamily` grids and has SEVEN ranked cells. A
> grid can only be painted by a `panel`, and a panel's first legal rank is 7.
> Two panels, one legal rank. There is no ordering that passes
> `module-face-lint` today.**

That is one rule away from shippable, and the rule is the same one `cartesian`
and `kria` hit — see the cartesian spec §11-A (PF-22).

archetype: **the timbre sequencer.** The only module in the registry that
sequences *which synthesis engine plays*, not just what note.

Not in `STRICT_FACES`; **no `face:` block**. In `STRICT_DOCS`
(`strict-docs.ts:191`). In **`DOCKABLE_TYPES`** (`dockable.ts:35`). In
`ALLOWED_PERMANENT_EXEMPT` — permanently exempt from VRT
(`vrt-exemptions.ts:985`), so it ships **no** card baseline at all. **Not** in
`PUSH_CARD_CONTROLS`. **Not** in `card-range-source.test.ts`'s allowlist (§9-F).
`rack-sizes.ts:73` — `2u / hp 5`, 282×880 px. contract-lock **27 lines**
(`contract-lock.txt:1584-1610`).

**Method.** No worklet: a main-thread scheduler writing `ConstantSourceNode`s
off `getSchedulerClock()`. The REAL shipped `factory()` was driven headless over
a deterministic fake `AudioContext` — every `setValueAtTime` /
`cancelScheduledValues` logged with node, time and value — with
`getSchedulerClock` replaced by a captured subscriber the probe steps by hand,
and the real `$lib/graph/store` patch supplying params, `node.data.steps` and
edges (so `isInputPortConnected` and `shouldSequencerRun` see real cables).
Analysers are fed programmable signals sampled over the real
`fftSize`/`sampleRate` window, so `createEdgeCounter`'s window math runs for
real. `mapModelIndexToCv` is round-tripped through the ENGINE's own
`scaleCv(cv, knob, min, max, {mode:'discrete'})`, not through a re-typed copy of
the bucketing formula.

**Determinism control: two identical 1.0 s renders bit-equal — `true`, 44 logged
events.** Instrument negative control: `isPlaying` 0 vs 1 with `clock` **and**
`play_cv` patched **does** move the log (`identical = false`), so a "logs
identical" verdict below is about the parameter, not about a blind probe.

---

## 1. THE CONTRACT

### 1a. Params — 5

| id | label | range | curve | default | card primitive |
|---|---|---|---|---|---|
| `bpm` | `BPM` | 30 .. 300 | linear | 120 | `<Fader>` |
| `length` | `Len` | 1 .. 128 | discrete | 16 | `<Fader>` |
| `octave` | `Oct` | −2 .. 2 | discrete | 0 | `<Fader>` |
| `gateLength` | `Gate` | 0.1 .. 0.95 | linear | 0.5 | `<Fader>` |
| `isPlaying` | `Play` | 0 .. 1 | discrete | 0 | header `<button>` ▶/■ |

**All four continuous/stepped params are `<Fader>` on the card**
(`MacseqCard.svelte:360-363`), so all four take `face.paramCells: 'fader'` — the
primitive that landed with `noise` (`shell-control-kind.ts:63-70`). Substituting
a dial for a throw is the regression that cell kind exists to prevent, and this
card is a fader card top to bottom.

`isPlaying` is `0..1 discrete default 0` → `looksLikeSwitch()` → it needs an
`ACKNOWLEDGED_LATCHING` entry (`'macseq:isPlaying'`); it is a transport state you
leave engaged, not a press-pad.

Plus two contract lines that are not params:
`macseq meta domain=audio **exposesSequence**` and
`macseq expose playStop param=isPlaying kind=button` — the GROUP! bar's
atomically-exposable 16-step grid and its play button. Both are already pinned;
a face touches neither.

### 1b. Ports — 15 in, 4 out

| dir | ids | type | edge |
|---|---|---|---|
| in | `clock` | gate | **trigger** |
| in | `play_cv`, `reset_cv` | gate | **trigger** |
| in | `queue1_cv` … `queue8_cv` | gate | **trigger** |
| in | `next_cv`, `prev_cv`, `random_cv` | gate | **trigger** |
| out | `pitch` | pitch | — |
| out | `gate` | gate | **gate** |
| out | `modelcv` | cv | — |
| out | `clock` | gate | **trigger** |

Every `edge` declaration is right, read against `$lib/audio/gate-trigger`: the
fourteen inputs all fire once per rising edge through
`createEdgeCounter`/`createTransportCv`'s windowed drain, and `gate` out is
level-held for a computed width. macseq is a good citizen here — it routes its
clock through the canonical `$lib/audio/edge-detect` seam (`macseq.ts:347-351`)
with a comment naming the NUMPAD+ double-count class it avoids.

**Zero CV inputs target a param.** All fourteen are event inputs with no
`paramTarget` (`transport-cv.ts:196-216`), so the rear derivation has no
per-page CV bands to build and would file all fourteen into an orphan band —
which is the one real argument for a curated `face.rear` here (§7).

### 1c. `node.data` — 128 × 3, plus eight snapshots

`steps: MacseqStep[128]`, each `{ on, midi, model }` — **384 values** — plus
`slots` (8 pattern snapshots, each carrying its own `steps` array **and** copies
of `bpm`/`length`/`octave`/`gateLength`), `queuedSlot`, `queuedNav`,
`lastLoadedSlot`. None of it is reachable by `FaceReadoutValue`, which is
params-only (§6).

---

## 2. AT SPAWN — measured

`isPlaying` defaults to **0**, so a freshly spawned macseq schedules nothing:
`totalAdvances = 0`. The four `ConstantSourceNode`s sit at their construction
values, and one of those is deliberate and worth knowing:

```js
modelCvSrc.offset.value = mapModelIndexToCv(0);   // = -1, NOT 0
```

`macseq.ts:322-324`. **A macseq that has never run still holds MODEL CV at
−1**, which the discrete scaler recovers as model 0 (VA) at the far end — as
opposed to 0, which would recover as **model 7 (MODAL)**. That is the correct
choice and the def's header explains it; it is also the kind of fact a
faceplate's MODEL readout must not contradict.

Once running at 120 BPM, over 1.0 s: **9 advances** (8 sixteenths plus the
200 ms lookahead's ninth), 44 scheduled writes.

---

## 3. THE MEASURED DEFECTS — two, both about the external clock

### A · `isPlaying` IS BIT-EXACTLY INERT WHILE `clock` IS PATCHED

`shouldSequencerRun(isPlaying, externalClock, playCvPatched)`
(`transport-helpers.ts`) implements the base-Sequencer orthogonality rule: if
`play_cv` is unpatched, a patched clock's pulses **are** the play signal.
Measured, 60 ticks (1.5 s), an 8 Hz cable clock:

| topology | `isPlaying` 0 vs 1 | events |
|---|---|---|
| `clock` patched, `play_cv` unpatched | **logs identical = true** | 74 |
| `clock` patched **and** `play_cv` patched *(positive control)* | **identical = false** | — |
| nothing patched | 0 advances vs 9 advances | — |

The positive control is the important half: the probe **can** see `isPlaying`
move the render, in the one topology where the param has authority. So the
inertness in row 1 is the module's behaviour, not the instrument's blindness.

**This is correct-by-design and invisible on the card.** The ▶/■ button
(`MacseqCard.svelte:303-311`) paints `isPlaying`, and while a clock is patched
pressing ■ stops nothing. The def's own docs say so
(*"An external clock can drive stepping even while this reads stopped"*), the
UI does not, and — under the 2026-08-11 no-prose ruling — a faceplate cannot say
it in words either. The honest surface is a **greyed control**, which is a
platform capability the shell does not have and which three modules in this
batch now want (see §10).

### B · UNDER AN EXTERNAL CLOCK, THE GATE IS SET BY THE `bpm` PARAM

`emitStep` takes `stepDurForGate = 60 / bpm / 4` in **both** branches
(`macseq.ts:562`, `:583`), so with a cable clock the gate width is computed from
a param that no longer sets the tempo. Measured:

| clock | real step | `bpm` param | `gateLength` | gate width | % of the REAL step |
|---|---|---|---|---|---|
| internal 120 BPM | 0.1250 s | 120 | 0.5 | 0.062500 s | **50.00 %** ✔ |
| internal 120 BPM | 0.1250 s | 120 | 0.1 | 0.012500 s | 10.00 % ✔ |
| internal 120 BPM | 0.1250 s | 120 | 0.95 | 0.118750 s | 95.00 % ✔ |
| internal 30 BPM | 0.5000 s | 30 | 0.5 | 0.250000 s | 50.00 % ✔ |
| **external 2 Hz** | **0.5000 s** | 120 | 0.5 | **0.062500 s** | **12.50 %** ✘ |

On its own clock `gateLength` is exactly what it claims — 50.00 / 10.00 / 95.00
per cent, to two decimals, at two tempi. Patch a cable and the same 0.5 becomes
12.5 %, and the docs entry (*"used only when nothing is patched into CLOCK IN"*)
is wrong: `bpm` is not ignored, it is repurposed.

**macseq has the mildest version of this in the batch, and it is worth saying
so.** `kria` has the same bug with a worse tail (at `bpm` 30 against a fast
cable clock the gates overlap — its spec §3-B); `cartesian` derives the gate
from the SCHEDULER TICK and is tempo-invariant in *every* topology (its spec
§3-C). One family of bug, three severities, three sequencers.

**Fix: measure the cable interval and use it.** The edge counter already has the
timestamps. It is a DSP-shaped change — it moves the sound of any saved rack
driven by an external clock — so it is an owner-audition PR of its own and
must NOT ride a face PR.

### C · WHAT IS *NOT* WRONG — measured, because a face would otherwise guess

**MODELCV round-trips exactly on all fourteen engines.** `mapModelIndexToCv(idx)`
→ the ENGINE's `scaleCv(cv, 0, 0, MACRO_MAX_MODEL, {mode:'discrete'})`:

| idx | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| cv | −1.0000 | −0.8462 | −0.6923 | −0.5385 | −0.3846 | −0.2308 | −0.0769 | 0.0769 | 0.2308 | 0.3846 | 0.5385 | 0.6923 | 0.8462 | 1.0000 |
| back | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 |

Fourteen of fourteen. `MACRO_MAX_MODEL` is **13**, DERIVED from
`MACRO_ENGINES.length - 1` (`macro-engine-roster.ts:314`), so a fifteenth engine
re-spaces the ladder automatically and this table is re-derived rather than
pinned.

**`length` has real authority across its whole range.** At 240 BPM over 1.5 s
(26 advances):

| `length` | sequence-ends |
|---|---|
| 1 | 26 |
| 4 | 6 |
| 16 | 1 |
| 128 | 0 |

**MODELCV emits on OFF steps; PITCH does not.** Measured over the same window
with 1 of 4 steps ON: **26 modelcv writes** against **7 pitch writes**. That is
the documented and correct pair — the model is a continuous param that wants
priming before the next gated step, while pitch holds through rests
(hold-on-off-gate). It is also the single most useful thing a picture could show
and no dial can (§8).

---

## 4. THE RANKING — 7 cells, a lane budget of six

`faceTierCap`: mini **1**, compact **2** with a glyph / **3** without, full
**6**. Dock: all 7.

⚠ **DECLARE `glyph: 'none'`.** `glyphBinding` (`shell-glyph-live.ts:112-172`)
resolves every kind except `envelope`/`algorithm` through
`primaryAudioOutPortId` = `outputs.find(o => o.type === 'audio')`. macseq's four
outputs are `pitch`, `gate`, `cv`, `gate` — **no `audio` port** — and it has no
`algorithm` param, no A/D/S/R set and no 0..2 `shape`. Any glyph falls through to
`{ kind: 'static' }`: a dead rectangle. Spending the compact tile's third column
on a control instead is a strict win.

| rank | key | tier | why |
|---|---|---|---|
| 1 | `macseq-model-{n}` | — **blocked** — | the MODEL lane is the module. Every other sequencer in the registry sequences notes; this is the only one that sequences the *engine*, and a face that ranks BPM above it is a generic step box with a dropdown. |
| 2 | `macseq-pitch-{n}` | — **blocked** — | the note lane. Second because a macseq with no models set is a worse `sequencer`; a macseq with no notes set still switches timbres on a held drone. |
| 3 | `isPlaying` | mini | the transport. Already `expose playStop kind=button`. |
| 4 | `bpm` | compact | and it is the gate law too, in one topology (§3-B). |
| 5 | `length` | plate | real authority across 1..128 (§3-C). |
| 6 | `gateLength` | plate | honest on the internal clock, to two decimals. |
| 7 | `octave` | plate | — *lane budget ends here* — a global transpose; the one control that never changes what the pattern *is*. |

**The rule the ranking follows, and the alternative it rejects.** Rank by
**what this module does that its siblings do not**. `sequencer`, `drumseqz`,
`polyseqz` and `writeseq` all rank a pitch grid and a transport; only macseq has
a MODEL lane, so the model lane leads. The obvious alternative — transport
first, the way a tape machine ranks — makes the mini tile identical to four
other modules' mini tiles, which is the bluebox failure mode in reverse: a
prefix that is a *correct* instrument but not *this* instrument.

### ⚠ AND THE PLATFORM REFUSES BOTH OF THE TOP TWO

`curatedFace` resolves both `macseq-model-{n}` and `macseq-pitch-{n}` to
`kind: 'family'`; `ModuleShell` paints a family through
`shellCellFor(type, ctl)` (`ModuleShell.svelte:774`), and an unregistered key
renders `data-cell-control="inert"` (`:865`) — which fails `module-face-lint`
**and** `faces-parity`. The registry's five kinds are `selector` / `action` /
`file` / `toggle` / `panel` (`shell-cells.ts:271-274`); **only `panel` can paint
a per-step grid**, and `panelTierProblems` (`module-face-lint.test.ts:652-666`)
fails a panel SELECTED at `mini`, `compact` or `full`.

With seven cells there is **exactly one** dock-only rank. Two panels need two.

| ordering | rank of `macseq-model-{n}` | rank of `macseq-pitch-{n}` | legal |
|---|---|---|---|
| the one above | 1 | 2 | ✘ ✘ |
| grids last | 6 | 7 | ✘ (rank 6 is `full`) |
| grids last, folded into ONE family | — | — | ✘ contract change; both keys are pinned and `docs.controls` keys them |

**Three shapes, none legal.** The block is real and it is one rule wide.

**PF-22 (cartesian spec §11-A) unblocks it two ways**, and for macseq the
stronger form matters: (i) a lane-selectable `ShellGridCell` puts the model lane
on the *compact tile*, which is the whole point — a rack of sequencers where you
can see at a glance which one is switching engines; or (ii) relaxing
`panelTierProblems` from *"a panel may not be RANKED above 7"* to *"a panel is
never SELECTED at a lane tier"*, which is the smaller change and legalises the
ranking above verbatim while the lane simply shows ranks 3–8.

---

## 5. THE LAYOUT — three bands, and the fold budget

**Bands: 3.** Far below `DOCK_TAB_MIN_BANDS = 7` (`dock-tabs-model.ts:56`), so
the dock is ONE scrolling column with every band visible together. Seven cells
cannot justify a rail, and a rail would be actively wrong here: the whole
argument for a macseq faceplate is seeing the MODEL lane and the NOTE lane in
one frame.

```ts
face: {
  title: 'Steps',
  hint: 'A note lane and a model lane over the same playhead.',

  // `order` is a PRIORITY ranking for the tiers that show a SUBSET;
  // `pages` is FUNCTION order for the tier that shows EVERYTHING.
  // They answer different questions — do not "fix" one to match the other.
  order: [
    'macseq-model-{n}',   // 1 — needs PF-22
    'macseq-pitch-{n}',   // 2 — needs PF-22
    'isPlaying',          // 3
    'bpm',                // 4
    'length',             // 5
    'gateLength',         // 6   ← the lane budget ends HERE
    'octave',             // 7
  ],

  pages: [
    { id: 'pattern',   label: 'pattern',   controls: ['macseq-model-{n}', 'macseq-pitch-{n}', 'length'] },
    { id: 'transport', label: 'transport', controls: ['isPlaying', 'bpm'] },
    { id: 'voice',     label: 'voice',     controls: ['gateLength', 'octave'] },
  ],

  glyph: 'none',        // no `audio` output ⇒ every kind resolves to `static`

  paramCells: {
    bpm:        'fader',
    length:     'fader',
    octave:     'fader',
    gateLength: 'fader',
  },

  hero: {
    cell: 'macseq-model-{n}',
    control: 'isPlaying',
    readouts: [{ label: 'gate', valueId: 'macseq-gate-ms' }],
  },

  rear: { /* §7 */ },
  sidebar: [ /* §8 */ ],
}
```

`heroFacePlan` removes `macseq-model-{n}` and `isPlaying` from their bands, so
the `pattern` band renders two cells and `transport` renders one; no band
empties and the roster row stays `{ type: 'macseq', pages: 3 }`.

### Band labels are LABELS

Per the 2026-08-11 ruling: `pattern`, `transport`, `voice`. No editorial
sentences, no captions, no per-page `hint`. The findings in §3 live here, in
`docs:` and in the PR body. (`face.hint` above is annotate-mode-only in any
case — `faceAnnotations` gates `title`, `hint` and every band hint,
`dock-faceplate-model.ts:182-191`.)

### The fold, at 1280×720 — stated as the brief requires

`.dock-faceplate` is `max-height: min(60vh, 680px)`
(`DockFullView.svelte:371`). At 720 px tall, **60vh = 432 CSS px**; the captured
faceplate is **425 px** (`LEGACY_FOLD_PX`, `_shell-faces.ts:325`). Measured off
`face-cloudseed-dock.png`, the chrome above the bands costs ~130 px and the band
region runs **y ≈ 130 … 425 = ~295 px**, at a `DOCK_BAND_PX = 90` pitch
(`dock-tabs-model.ts:21-35, 53`).

**This face's budget:**

| | px |
|---|---|
| band region at 1280×720 | **~295** |
| hero — 16 model chips in 2 rows of 8 at 26 px + a 16 px step ruler + a 20 px caption row | **~114** |
| remaining | **~181** |
| `pattern` band (label + one row) | ~90 |
| `transport` band | ~90 |
| **visible without scrolling** | hero **and two full bands**, with ~1 px spare |

The `voice` band is below the fold and `.faceplate-scroll` is `overflow:auto`,
so it scrolls — say so rather than claim it folds.

⚠ **THE HERO MUST BE 2 × 8, NOT 1 × 16, AND THAT IS THE FOLD DECISION.** The
dock hero bay is `min(var(--dock-hero-glyph-w, 214px), 100%)` wide
(`ModuleShell.svelte:1411`); sixteen 26 px chips in one row is 416 px + gaps,
which either overflows the bay or shrinks each chip to ~12 px — unreadable for a
14-name roster. Two rows of eight at 26 px is 208 px wide and **114 px tall**,
which is what leaves two bands above the fold.

⚠ **AND THIS IS WHERE `length` BITES.** The hero draws the pattern, and
`length` runs to **128**. Sixteen chips is `PAGE_SIZE`, not the pattern — so the
hero must show **one page** with a page indicator, exactly as the card does
(`SequencerPageNav`), or it will either lie about the pattern's extent or grow
eight-fold and reproduce the wavesculpt failure: a 445 px hero against a ~352 px
box renders every band below the fold, and the dock looks broken while being
correct. A 128-step hero at 26 px chips in 8 rows is **~236 px** — over budget
before the first band header.

---

## 6. READOUTS — exactly one, and it is a bare value

Under the 2026-08-11 ruling a readout is **a value and its unit, nothing more.**
One qualifies.

### `macseq-gate-ms` → `62.5 ms`

`(60 / bpm / 4) × gateLength × 1000`. At the shipped defaults, **62.5 ms**.

It earns the slot on a specific and checkable property: **it is TRUE in both
topologies while the percentage is not.** `emitStep` computes the gate from
`60 / bpm / 4` in the internal *and* the external-clock branch (§3-B), so the
absolute width really is 62.5 ms whether the tempo comes from the param or from
a cable — while the dial's own `0.50` reads as "half the step" and is 50 % on
the internal clock and 12.5 % against a 2 Hz cable. The derived value prints the
number that survives the topology change; the percentage would be the
blind-metric trap.

- **NEGATIVE CONTROL (permanent, in `macseq-face-model.test.ts`):** the printed
  value must NOT move when `length`, `octave` or `isPlaying` move. A readout
  that drifted with `length` would be reading the loop, not the gate.
- **SECOND LEG — it must move with BOTH of its inputs:** `gateLength` 0.5 → 0.95
  gives `118.75 ms` (×1.9) and `bpm` 120 → 30 gives `250 ms` (×4). A one-sided
  test passes on a readout that echoes `gateLength` alone, which is exactly the
  half that is *not* the finding.
- **THE ORACLE:** derive the step from `60 / bpm / 4` in the model module and
  have `macseq.ts` import it, so the §3-B DSP fix turns the readout's model test
  RED rather than leaving the faceplate printing a stale law.

### Rejected, with the reason

- **`macseq-loop-s`** (`length × 60 / bpm / 4` = `2.00 s` at the defaults).
  **Rejected: false under an external clock**, where the cable sets the step and
  the loop's duration is unknowable from params. A loop readout in *steps* is
  just `length`'s own value.
- **`macseq-models-set`** (how many of the `length` steps set a model — the one
  number that says whether this module is doing its job rather than acting as a
  worse `sequencer`). **Rejected: `node.data.steps` is not params.** This is the
  best readout macseq has and the platform cannot compute it.
- **`macseq-model-here`** (the model name at the playhead). **Rejected twice:**
  `node.data`, and it is a word rather than a value.
- **A transport-source readout** (INTERNAL / CABLE). **Rejected:** the answer is
  whether `clock` is patched, which `FaceReadoutValue` cannot see, and it is a
  word.

⚠ **Three of the four rejections are the same platform gap** — see §10.

---

## 7. THE REAR — 19 holes, and 14 of them are why it needs curating

`rear-card-model.ts` renders every declared port, one hole each: **15 input
holes + 4 output holes = 19**. No stereo pairs. **No CV hole targets a param**
(§1-B), so the derivation has no per-page CV bands and would drop all fourteen
transport inputs into a single orphan CV band beside `clock` — nineteen
identically-shaped `gate` jacks in two undifferentiated groups. That is the case
a curated `face.rear` exists for.

```ts
rear: {
  groups: [
    { id: 'signal',    label: 'clock',    ports: ['clock'] },
    { id: 'transport', label: 'transport', ports: ['play_cv', 'reset_cv'] },
    { id: 'patterns',  label: 'patterns',  ports: [
        'queue1_cv','queue2_cv','queue3_cv','queue4_cv',
        'queue5_cv','queue6_cv','queue7_cv','queue8_cv',
        'next_cv','prev_cv','random_cv' ] },
  ],
  clusters: [
    { group: 'patterns', label: 'slots', ports: [
        'queue1_cv','queue2_cv','queue3_cv','queue4_cv',
        'queue5_cv','queue6_cv','queue7_cv','queue8_cv' ] },
    { group: 'patterns', label: 'nav',   ports: ['next_cv','prev_cv','random_cv'] },
  ],
}
```

⚠ **`clock` is its own group and not part of `transport`, deliberately.** It is
the one input whose presence changes what `isPlaying` means (§3-A) — everything
else in the transport group is an event that fires and is forgotten. A rear that
files them together teaches the wrong model of the module.

⚠ **Check `rear-card-model.test.ts` for a pin before landing this** — a curated
group id that matches a `pages` page id claims that page's slot and its label
wins, and `transport` here is deliberately NOT the `transport` page (the page
holds `isPlaying` + `bpm`; the group holds two jacks). Rename the group
`run` if the collision is real; the derivation's group/page matching is by id
(`ModuleFaceRear.groups` doc, `graph/types.ts:820-824`).

`audioRate`: **nothing ticks.** All fifteen inputs are polled once per ~25 ms
scheduler tick through `AnalyserNode` rings (`createEdgeCounter` /
`createTransportCv.drain`). Cited per Step 6 of the recipe.

---

## 8. THE PICTURE

**`macseq-model-{n}` — the MODEL LANE, promoted to `hero.cell`.** One page of
sixteen chips, 2 rows × 8 (§5), each showing its step's engine or `—`. Three
things only this can show, all pictures rather than sentences:

- **the playhead**, from `read('currentStep')` off the live handle — the single
  genuinely live surface this module has;
- **which steps SET a model versus which HOLD the previous one.** This is the
  module's whole semantic and it is invisible everywhere today: `—` on the card
  is a `<select>` with an empty option, and nothing draws the *reach* of a set
  model forward across the rests that follow it. A held run drawn as a bar from
  its setter to the next setter is the picture;
- **the currently-emitted index**, `read('modelCv')`, which after a rest is the
  held value rather than anything on the current step.

`minWidth: 220`. Probe (required, `ShellPanelProbe`):

```ts
'macseq-model-{n}': {
  kind: 'panel',
  label: 'models',
  component: MacseqModelLane,
  minWidth: 220,
  probe: {
    testid: 'macseq-model-chip-3',           // NOT `control-<paramId>` — rule 1
    action: 'click',
    effect: { kind: 'data', key: 'steps[3].model', expect: 'changed' },
  },
}
```

⚠ **`data`, not `data-rev`.** A revision counter passes on a dead chip.

`macseq-pitch-{n}` is the second panel (`minWidth: 220`, probe on
`steps[3].midi`), rendered in the `pattern` band directly under the hero — same
16-column geometry, same page, so the two lanes line up column-for-column and a
step reads as one vertical slice. **That alignment is the reason both lanes are
in one band rather than two**, and it is why the module wants two panels at all
rather than one merged grid: the merged form cannot be probed per-lane, and
`docs.controls` already keys the two separately.

**Sidebar** — one block, and it is a diagram:

```ts
sidebar: [
  { kind: 'signal-flow', label: 'signal flow', stages: [
    { label: 'CLOCK',    role: 'generator', note: 'internal or cable' },
    { label: 'PLAYHEAD', role: 'bus' },
    { label: 'STEP',     role: 'bus' },
    { label: 'PITCH',    role: 'bus' },
    { label: 'GATE',     role: 'bus', parallel: true },
    { label: 'MODEL CV', role: 'bus', parallel: true, note: 'every step, on or off' },
  ] },
]
```

`parallel: true` on MODEL CV is correctness, not decoration: it is emitted on
**every** step including OFF ones (26 writes vs 7, §3-C), so drawing it inline
after GATE would teach that a rest does not change the engine. It does.

**No `presets` block.** There are no enabler pairs on this module; every param
is live on the internal clock.

---

## 9. ALREADY-WRONG — ordered by cost to a user

- **A · under an external clock the gate is computed from the `bpm` param**
  (§3-B): 12.5 % where the dial says 50 %. DSP PR, owner audition, changes saved
  racks. Same family as `kria` §3-B and `cartesian` §3-C.
- **B · `isPlaying` is inert while `clock` is patched** (§3-A) and the ▶/■
  button gives no sign. Correct by design; the missing surface is a greyed
  control (§10).
- **C · `docs.controls.bpm` is wrong.** *"used only when nothing is patched into
  CLOCK IN"* — `bpm` is still read in the external-clock branch and sets the
  gate. One-line docs fix; ride the face PR.
- **D · a third per-step control with no declared family.** The card emits
  `macseq-pitch-{id}-{i}`, `macseq-model-{id}-{i}` **and**
  `macseq-gate-{id}-{i}` (the NoteEntry gate toggle,
  `MacseqCard.svelte:339`); the def declares two families. `module-face-lint`'s
  completeness enumerates params + declared families + **numbered-legend**
  statics, and only three legend files exist in the whole repo
  (`e2e/vrt/__annotated__/`: adsr, lfo, sequencer) — so the gate toggle is
  invisible to CI. Declaring `macseq-gate` is +1 contract-lock line and +1
  `docs.controls` entry.
- **E · the page nav and the 8-slot quicksave bar are card-only statics.**
  `SequencerPageNav` and `QuicksaveControls` (`MacseqCard.svelte:316-325`,
  `:366-377`) carry real controls — page, HOLD, eight slots, the pending-mode
  toggle, RESET — none of which is a param, a family or a legend entry. A
  `STRICT_FACES` face is complete over what it can enumerate and **silently
  drops all of them**. That is the largest control-loss surface on this module
  and it needs a written exemption with an argument, not a shrug: the quicksave
  bar is reachable from the card and from `queue1..8_cv`, and the page nav is a
  view control the hero replaces. Say that in the def, in this file and in the
  PR body.
- **F · `MacseqCard.svelte` re-types four ranges as literals** (`:360-363` —
  `min={30} max={300}`, `min={1} max={STEP_COUNT}`, `min={-2} max={2}`,
  `min={0.1} max={0.95}`) while importing `macseqDef`, and macseq is **not** in
  `card-range-source.test.ts`'s allowlist. Bind through `paramSpec()` and enrol
  in the SAME PR that touches the card — the boy-scout precedent every recent
  face PR followed. (Note `min={1} max={STEP_COUNT}` is bound to the right
  constant and still not to the *def*, which is the divergence the gate exists
  for.)

---

## 10. COST

| | |
|---|---|
| **contract-lock** | **+1 line** if D lands with the face (`macseq-gate` family). `face` itself is contract-transparent. |
| **`ACKNOWLEDGED_LATCHING`** | +1 (`macseq:isPlaying`). |
| **blocking platform** | **PF-22** (cartesian spec §11-A). Two panel-shaped families, one legal dock-only rank. Nothing else on this module is blocked. |
| **shared registries** | `strict-faces.ts`, `e2e/vrt/_shell-faces.ts` (`{ type: 'macseq', pages: 3 }`), `shell-cells.ts` (two panel cells + two probes), `face-readout-values.ts` (1 `valueId`), `card-range-source.test.ts` (§9-F), `push-card-config.ts`. |
| **VRT** | +`face-macseq-{compact,dock}` = **2 baselines**, authored by linux CI — never commit one. ⚠ macseq has **no** card baseline today: `EXEMPT_FROM_VRT` (`vrt-exemptions.ts:196`) plus `ALLOWED_PERMANENT_EXEMPT` (`:626`). Adding face scenes gives it its first two, and `ALLOWED_PERMANENT_EXEMPT` is anchored to `EXEMPT_FROM_VRT` (an entry naming a module NOT in the exempt set is RED), so **check whether that membership survives before landing**. ⚠ And the two disagree in prose already: the "permanent" allowlist holds a module whose exemption reason is *"VRT baseline pending"* — a temporary reason parked on a permanent list, which is precisely the stale-exemption class the anchoring rule exists to catch and which the anchor cannot see (it checks the NAME, not the REASON). |
| **e2e** | +1 `faces-parity` row at **7 cells** ≈ 30 000 + 600×7 = **34.2 s** (57.6 s under `SLOW_RENDER`). Well inside the ~2 min flag threshold. |
| **ART** | macseq has no ART scenario and no `.sha` pin. A face touches nothing; the §3-B DSP fix would need one authored, and must not ride the face PR. |
| **Push 2** | No `PUSH_CARD_CONTROLS` entry, so its eight push controls are whatever the generic ranker picks over five params — and it will silently re-rank if a param is ever added. Give it an explicit entry in the face PR (CLAUDE.md's standing warning). |
| **the bottom line** | The strongest face in the batch and the smallest blocker. Five live params, an exactly-correct MODELCV ladder, and one picture — the model lane with its held runs drawn — that says the module's whole idea and exists on no surface today. |

---

## 11. THE PLATFORM ITEMS THIS SPEC ADDS

Both are shared with the other two specs in this batch; recorded here with
macseq's instance so the count is countable.

### PF-22 — a lane-selectable grid cell

See cartesian spec §11-A for the full statement and the seven affected modules.
**macseq is the instance that proves the rank-7 escape is not a fix**: even
granting the escape, macseq needs *two* dock-only ranks and has one.

### A GREYED / INAPPLICABLE control state

Three modules in this batch have a control that is **correct, live, and inert in
the current topology**, with nothing to say so:

| module | control | inert when |
|---|---|---|
| `macseq` | `isPlaying` | `clock` patched, `play_cv` unpatched |
| `kria` | `running`, `bpm` | a `timelorde` node exists, or `clock` patched |
| `cartesian` | `mode` | always (it is dead — a def bug, not this) |

Before 2026-08-11 the answer was a readout printing a sentence. **That is now
forbidden**, and it was always the weaker answer: a sentence beside a control
that still looks operable is worse than a control that looks inoperable. The
platform shape is a `ShellControlState` — dimmed + `aria-disabled`, resolved from
the same predicate the engine branches on. It needs the graph, so it lands with
the `FaceReadoutValue` widening rather than before it.

### `FaceReadoutValue` is params-only — the count is now NINE

`(read: (paramId) => number | undefined) => string`
(`face-readout-values.ts:149`). macseq contributes two of the nine (§6's
rejections): `node.data.steps` for the model coverage, and patch topology for
the transport source. The full table is in the cartesian spec §11-C.
