# face re-do — tidyVco

> ⚠ **STATUS CORRECTED 2026-08-04 — read `face-redo-INDEX.md` §0 before building.**
> PF-20 (**PR #1301**) **HAS MERGED** (`c6ff9253`); every "unmerged branch" citation below
> now resolves on `main` — including §11's "on the **unmerged** platform branch, not main,
> so not a shipped defect", which no longer holds. **`face.title` and `face.hint` do NOT
> paint by default** — `facePageHeader()` returns `null` before reading anything unless
> annotate mode is on (`packages/web/src/lib/ui/workflow/dock-faceplate-model.ts:90`), and
> the owner ruled on 2026-08-03 that `face.title` stays annotation-only. **Any argument
> below that parks a load-bearing fact in `face.hint` because it "still paints" is VOID.**
> PF-21 dock ROW PACKING (`9bf12df7`) also landed after this was written. **This re-do is
> NOT built** — the shipped `face` still declares no `hero` and no `sidebar`. Live backlog.

**Verdict: MECHANICAL ONLY.** The shipped ranking, bands, clusters, rear and glyph are right and are
pinned by a bespoke unit spec plus an owner-regression e2e — nothing in them should move. What this
face is missing is the PF-20 declaration surface: a title, a hint, five band hints, a hero
(CUTOFF + the HOLD audition), a three-entry **derived** readout strip, and a two-block sidebar.

---

## 1. WHAT THE MODULE ACTUALLY DOES

**It is not a VCO.** It is the rack's one complete subtractive VOICE, and its only outputs are the
post-VCA stereo pair `out_l`/`out_r` (`tidy-vco.ts:126-129`). There is no raw-oscillator tap, no
sub tap, no filter-only tap. Consequence for the face: **an unpatched tidyVco is silent** — the amp
EG gates everything (`tidy-vco-dsp.ts:1012` `vs.vcaG = aeg`, and `tidyOtaVca` returns exactly 0 at
gEnv 0, `:529-533`). That puts it in the same structural class as kickdrum and karplus, and it is
the single fact that decides the hero.

**Signal path, in the DSP's real order** (`renderTidyVco`, `tidy-vco-dsp.ts:961-1038`, and the
per-channel closures at `:788-799`):

    OSC1 ⨉ OSC2 (equal-power MIX) + SUB → ×OSC_NORM 0.5   [1× rate]
      → WAVEFOLDER (ADAA triangle, L/R antiphase) → DRIVE tanh×makeup
      → ×comp (1+k)^0.6 → ZDF DIODE LADDER → OTA VCA   [2×, PER CHANNEL]
      → equal-power PAN (WIDTH) → 1/√n → LEVEL dB → DC block → tanh true-peak

The two RC-punch ADSRs are **modulators, not stages**: the filter EG enters only through
`tidyCutoffHz` (`:363-377`), the amp EG only through `vcaG`. Nothing on the audio spine is an envelope.

**What each control genuinely changes about the SOUND** (measured — numbers from
`tidy-vco-dsp.sonic-range.test.ts`):

- `cutoff` is **calibrated to the RESONANT pitch**, not the −3 dB knee: the prewarp `√2·tan(π·fc/fs)`
  puts the limit cycle exactly at the knob (`:179-184`, `:381-383`); the zero-res brightness knee sits
  ~3.2 octaves *below* the dial (`:48-51`). Centroid >4× across the travel (`sonic-range:133-141`).
- `res` is **timbre**: `k = 19.6·res^1.2` (`:351-353`), self-osc at `k ≥ 17` (`:172`) ⇒ **onset at
  res ≈ 0.888**; high res drops the passband ~10 dB after half-compensation (`:186-188`).
- `drive` grows odd harmonics **>20 dB** while the 0.57 makeup exponent holds RMS flat (`:196-200`,
  `sonic-range:152-167`) — a timbre knob wearing a gain knob's name. `env` is ±4 octaves of cutoff
  sweep (`FILTER_ENV_OCT = 4`, `:226`), the biggest lever here, and **rank 8, dock-only**.
- `fold` is a **true bypass at 0** (`foldAdaaStep` early-returns `x`, `:583-587`), centroid >3× across
  its travel (`sonic-range:349-355`); `sym` is scaled *by* fold (`:406-408`), inert at FOLD 0.
- `pw` is **INERT AT SPAWN** — confirmed. `tidyOscSample` crossfades `(1-s)·saw + s·pul` and both
  SHAPE defaults are 0 (`:453-458`, `:315-316`), so the pulse leg carries zero weight. **Stronger than
  the design program states:** the whole term is zero-weighted, so the `pwm_cv` **jack** is inert at
  spawn too — a patched LFO does nothing until a SHAPE moves. Checked, not asserted
  (`tidy-vco-face.test.ts:208-233`, bit-identity across PW's travel, SHAPE-at-pulse as its negative
  control). `sub` is unreachable by PW at any setting: a fixed 0.5 duty literal (`:996`).
- `width` is the stereo engine three times over — poly pan fan, mono ±(7 ¢ · WIDTH) unison drift, and
  the folder's L/R decorrelation (`tidyFoldSpread`, `:413-415`). At WIDTH 0 the folder is exactly mono.

**Load-bearing:** cutoff, res, env, shape1, drive, width. **Inert at spawn:** `pw` + `pwm_cv` (above),
`sym` (gated by fold), `fold` (bypass at 0), `track` (0 V = C4 ⇒ nothing until a pitch source is patched).

**Facts worth printing:** the filter EG's **reach** (`cutoff·2^(4·env)` = 3.1 kHz at the defaults) and
its **settled** value (`cutoff·2^(4·env·fsus)` = 1.2 kHz). Neither is any knob — see §5.

---

## 2. WHAT THE CURRENT SHIPPED FACE GETS WRONG

**Very little.** The ranking is argued from the DSP and pinned (`tidy-vco-face.test.ts`, 5
describes); the five pages, the PF-9 envelope clusters, the curated `play` rear band and the
`audioRate` audit are all correct and independently gated. The genuine gaps are all PF-20-shaped:

1. **No `title`, no `hint`, no page hints** — the dock opens on five bare band labels
   (`tidy-vco.ts:330-357`). The baseline shows it: `face-tidyVco-dock.png` is "TIDYVCO / SOURCES"
   over a glyph, then `OSCILLATOR`, then knobs. Nothing on the plate says what the instrument is.
2. **No hero, so the audition is buried.** `hold` sits in band 5 (`output`) between WIDTH and LEVEL
   (`:356`). On the one module in the rack that is *silent until gated*, its only self-audition is
   last on the plate. (Rank 25 is fine; the band placement is not — the fix is the hero, not a
   re-rank. See §5.)
3. **No readouts.** The two numbers that describe this voice — where the filter sweeps to and where it
   settles — appear on neither surface, and neither is derivable by eye from the three dials that
   produce them.
4. **No sidebar.** The signal order (fold **before** the filter — the whole West-Coast argument in
   `docs.explanation`, `:458`) is taught only in prose no surface renders.
5. **The picture is blind to the wavefolder.** The dual glyph draws
   `sawPulseMixWaveSamples(shape1, shape2, pw, mix)` (`scope-screen-model.ts:135-165`); it ignores
   `sub` and, more importantly, FOLD entirely — the one control whose entire purpose is to change the
   waveshape does not change the waveform picture.

Not a gap: the glyph does **not** flatline on a silent rack. It is the set's only DUAL binding
(`shell-glyph-live.ts:136-156`) — a param-derived core wave always drawn beside the live trace.

---

## 3. THE ~8 CONTROLS THAT MATTER

**Unchanged from what ships.** The order is asserted key-by-key at `tidy-vco-face.test.ts:91` and
`:119`; re-ranking is not a cosmetic edit here, it breaks pinned assertions and (for ranks 4-5) an
owner-regression e2e. The arguments, restated with the measurements that back them:

| rank | key | why it earns the rank (an argument that is WRONG for another module) | what it costs below |
|---|---|---|---|
| 1 | `cutoff` | On a *diode ladder calibrated to the resonant pitch* the cutoff dial is simultaneously the brightness gesture and the self-osc **tuning** knob (`:46-51`). That is false of every SVF and every transistor ladder in the catalog. | Demotes `shape1` off the mini tile — priced and pinned at `tidy-vco-face.test.ts:69-87`. |
| 2 | `shape1` | The param the `waveform` glyph literally **draws** (`sawPulseMixWaveSamples`), so knob and picture are adjacent from `compact` up. | — |
| 3 | `res` | On *this* filter resonance is timbre, not trim: it compresses through the squelch limiter and drops the passband ~10 dB (`:186-192`). On a clean SVF it would be a trim. | Pushes `detune`/`oct2` to 4-5. |
| 4-5 | `detune`, `oct2` | **Not a taste call.** `faces-parity.spec.ts:690-716` is a named regression block ("the owner control-loss report") asserting both visible in the lane `full` face *and* in the dock `oscillator` band. Ranking either at 7+ manufactures the loss the block exists to catch. | Takes the last two plate cells. |
| 6 | `pw` | Inert at spawn (§1) — but its **activator is on the same plate** (`shape1`, rank 2), so PW-plus-SHAPE is one gesture without leaving the lane. That distinction is what separates it from FOLD (`tidy-vco-face.test.ts:126-155`). | — |
| 7 | `fold` | Dock-only: a true bypass at 0 **and its own activator**, so a lane cell would do nothing until spent twice on the same knob. | — |
| 8 | `env` | ±4 octaves — the biggest lever here — but a patch decision, not a performance gesture. | — |

**THE LOSERS, NAMED** (ranks 9-25, all dock-reachable — the dock renders every control):
`shape2`, `mix`, `sub` lose to `shape1` because one oscillator's identity is the voice's identity and
the second is a thickener. `sym` loses because it is *gated by* `fold`, which itself lost. `drive`,
`track` lose to `res`/`cutoff`: both are set-and-forget on a 303 patch. The eight EG knobs
(`fatk`…`rel`) lose as a block — they are two ADSRs, i.e. one idea twice, and the PF-9 clusters are
how the face pays for them. `width`, `level` are output trims. `hold` is rank 25 and stays there: it
is not a value, and its promotion into the hero is **rank-independent** (see §5).

---

## 4. BAND STRUCTURE + THE ANNOTATION PROSE

Five pages, ids and labels **UNCHANGED** (renaming `oscillator` desyncs it from the pinned rear group
of the same id — `tidy-vco.ts:398-402`, `rear-card-model.test.ts:56-90`). The only structural change
is that `hold` leaves band 5 by promotion, not by deletion.

```ts
pages: [
  {
    id: 'oscillator', label: 'oscillator',
    hint: 'two band-limited saw↔pulse oscillators over a −1-octave sub square; PW is shared, and it does nothing until a SHAPE leaves saw.',
    controls: ['shape1', 'shape2', 'pw', 'detune', 'oct2', 'mix', 'sub'],
  },
  {
    id: 'wavefolder', label: 'wavefolder',
    hint: 'a reflecting triangle folder BEFORE the filter — the West-Coast move; 0 is a bit-exact bypass and SYM only bites while FOLD is up.',
    controls: ['fold', 'sym'],
  },
  {
    id: 'filter', label: 'diode filter',
    hint: 'EMS/303 diode ladder — CUTOFF is the resonant pitch, not the −3 dB knee, and RES whistles past about 0.89.',
    controls: ['cutoff', 'res', 'drive', 'env', 'track'],
  },
  {
    id: 'envelopes', label: 'envelopes',
    hint: 'two RC-punch ADSRs — the filter EG sweeps CUTOFF up to ±4 octaves, the amp EG drives the VCA; both retrigger from their current level.',
    controls: ['fatk', 'fdec', 'fsus', 'frel', 'atk', 'dec', 'sus', 'rel'],
    clusters: [
      { label: 'filter eg', controls: ['fatk', 'fdec', 'fsus', 'frel'] },
      { label: 'amp eg',    controls: ['atk', 'dec', 'sus', 'rel'] },
    ],
  },
  {
    id: 'output', label: 'output',
    hint: 'WIDTH is the stereo engine three times over: the poly pan fan, the mono unison spread, and the folder’s own L/R split.',
    controls: ['width', 'level', 'hold'],   // `hold` is PROMOTED out by face.hero
  },
],
```

**Does this read with every hint hidden?** Yes, and deliberately. Each label is a noun the controls
under it name; nothing in a hint is load-bearing. The three facts a player must have — where the
filter sweeps to, what interval OSC2 plays, and that HOLD auditions the voice — live in the readout
strip and the hero rail, which paint by default. The hints only add *why*.

---

## 5. THE HERO + THE READOUT STRIP

### No `hero.cell`. Keep the glyph.

Declaring a `hero.cell` **suppresses the shell glyph at the dock** —
`heroGlyph = hasGlyph && !(view === 'dock-full' && hero?.cell)` (branch `ModuleShell.svelte:353`).
tidyVco's glyph is the platform's only DUAL binding: a param-derived single-cycle core wave *plus* the
live output trace (`shell-glyph-live.ts:136-156`). **The "single-cycle waveform hero picture" the
analogVco batch-3 spec proposed for a sibling module is therefore already shipped here, generically**
— and unlike `analog-vco-scope.ts` (a bespoke zero-crossing windower + 2D draw for the AnalogVco
card) tidyVco has **no** bespoke scope helper and needs none. Trading a live dual picture for a static
bespoke one to satisfy the word "hero" is exactly the case the brief forbids.

**The one picture change worth making** (the single non-mechanical build item — not a bespoke panel):
teach the core wave to **fold**. `triFold`, `tidyFoldGain`, `tidyFoldBias` are already exported
(`:545`, `:399`, `:406`), so it costs no DSP edit. Two hard requirements:

- **Gate on `amt > 0` exactly as the DSP does** (`foldAdaaStep:583-587`). Do *not* apply `triFold`
  unconditionally: the display buffer is an equal-power sum reaching ±1.414 at MIX 0.5 *before* its
  peak-normalisation, so an ungated `triFold` would **reflect at FOLD 0** and move every tidyVco
  baseline for a feature that is off. Bit-exactness at fold 0 is the acceptance test.
- State the limit honestly: the display input is peak-normalised where the DSP's is `OSC_NORM`-scaled
  and includes SUB. Both are **private** consts, and exporting them edits `tidy-vco-dsp.ts` — whose
  text is inside the ART source-SHA (`art/scenarios/tidy-vco/profile.test.ts:37-41`) → a forced
  re-capture of two `.f32` baselines for zero audio change. Not worth it: the picture shows the
  fold's *character*, not a calibrated waveform.

### `hero.control: 'cutoff'` · `hero.action: 'hold'`

`cutoff` because it is rank 1 for a reason about *this* filter (§3), and because both derived
readouts are anchored to it — the big dial and the strip under it are then one instrument.

`hold` because this module makes **no sound at all** until something gates it (§1) and `hold` is its
only self-audition. Three things make it cheap:

- Already declared momentary (`face.momentary: ['hold']`, `tidy-vco.ts:369`), and the shell renders
  `hero.action` through the ordinary cell renderer (`controlCell(hero.action)`, branch
  `ModuleShell.svelte:913-915`) — a press-pad Button with no new code.
- Unlike kickdrum it needs **no PF-6f family and no `getActiveEngine()` plumbing**: `hold` is a real
  AudioParam the worklet ORs into the mono gate (`packages/dsp/src/tidy-vco.ts:239-241`).
- **Do NOT re-rank it to 7 the way kickdrum ranked its strike.** `heroFacePlan` resolves the key
  through the flattened dock plan, not the rank (branch `dock-faceplate-model.ts:127-146`), and
  `tidy-vco-face.test.ts:119` asserts `face.order.slice(6,8) === ['fold','env']`. Rank 25 is correct;
  it must simply stay listed in `pages[4].controls` or it falls into the defensive `__unpaged` band.

### THE READOUT STRIP — three entries, all DERIVED

**Why zero `paramId` entries.** PF-20 also gives every dock dial a persistent value readout
(`persistentReadout`, branch `KnobConic.svelte:58-68`). After that, a `paramId` hero readout prints
the *same string that is already printed under the dial*. (This is visible on the reference face:
kickdrum promotes `tune` to `hero.control` **and** declares `{ label: 'settles to', paramId: 'tune' }`
— the hero dial's own number, twice, side by side.) So on this face the strip carries only quantities
no dial can print.

```ts
hero: {
  control: 'cutoff',
  action: 'hold',
  readouts: [
    { label: 'osc 2',      valueId: 'tidyvco-osc2-interval' },
    { label: 'sweeps to',  valueId: 'tidyvco-filter-peak' },
    { label: 'settles at', valueId: 'tidyvco-filter-sustain' },
  ],
},
```

**1 · `tidyvco-osc2-interval`** — what OSC2 actually plays. Mirrors `tidy-vco-dsp.ts:942-944` + `:990`
(`oct2` rounded/clamped to −1/0/+1, `detOct = detune/1200`, `f2 = f1·2^(oct2 + detune/1200)`). Prints
`+6 ¢` at the defaults, `−1 oct +18 ¢`, `+1 oct −12 ¢`. *Negative control:* flip `oct2` −1↔+1 — the
string moves while a `detune` readback is invariant (and an `oct2` readback is blind to the cents).
*Must-not-move leg:* `mix`.

**2 · `tidyvco-filter-peak`** — where the filter EG opens to. **It calls the DSP's own function**, so
there is nothing to re-derive: `tidyCutoffHz(cutoff, 0, 0, env, 1, 0, 2*48000)` (`:363-377`, already
exported). At the defaults 900·2^(4·0.45) = **3134 Hz → "3.1 kHz"**. *Negative control:* `env`
0.45 → −0.45 gives 259 Hz, a 12× move, while a `cutoff` readback does not budge. *Must-not-move
legs:* `res`, `fsus`.

**3 · `tidyvco-filter-sustain`** — where it settles under a held note: the same call with `feg = fsus`.
At the defaults 900·2^(4·0.45·0.2) = **1155 Hz → "1.2 kHz"**. *Negative control:* `fsus` 0.2 → 0.9
gives 2.8 kHz while `cutoff` **and** `env` readbacks are both invariant. *Must-not-move leg:* `fdec`
(a time, not a level).

Both filter readouts are honest about `track`: at 0 V (C4) the keytracking term is exactly 0, so a
params-only value is exact there and low by `track·voct` octaves elsewhere — say so in the registry
comment. `2*48000` is the clamp argument only; it bites above ~23 kHz commanded (`:207`).

**Two rejections, stated because stating them is the point.** (a) A `res`/self-osc readout
(`k = 19.6·res^1.2`, "SELF-OSC past 0.89"): **no perturbation moves it without moving a `res` knob
readback** — a monotone relabel of one knob, i.e. a param readout wearing a derived id. It goes in
the `diode filter` band hint. (b) A **poly / mono** indicator — the most useful runtime fact this
module has (poly wins the moment any lane gates, `tidy-vco-dsp.ts:880-890`) and one that **cannot be
honest today**: `FaceReadoutValue` is `(paramId) => number|undefined` (branch
`face-readout-values.ts:37`), params only, and the answer depends entirely on a patched input. It
goes in the sidebar diagram and the `play` rear band label.

---

## 6. THE SIDEBAR — two blocks

**`signal-flow`**, because the one thing this instrument teaches wrongly by default is its own order:
the folder sits **before** the filter, and DRIVE is inside the oversampled section, not a front-panel
input gain. Stages in the DSP's real order (`:788-799`, `:1021-1037`):

`OSC 1` (generator, "saw↔pulse") · `OSC 2` (generator, "oct · detune") · `SUB` (generator, "−1 oct
square") · `WAVEFOLDER` (bus, "stereo splits here") · `DRIVE` (bus, "tanh, 2×") · `DIODE LADDER`
(bus, "24 dB/oct · squelch") · `OTA VCA` (bus, "amp eg") · `PAN · WIDTH` (bus, "equal-power") ·
`LEVEL · CEILING` (bus, "dB → true-peak").

**No `parallel` stage, and no envelopes in the diagram.** Nothing here taps and rejoins. The two EGs
are modulators — putting an EG on the audio spine is precisely the "a diagram that teaches the wrong
chain is worse than none" failure the field's own doc warns about (branch `types.ts`, `FaceFlowStage`).
The `envelopes` band and its two clusters already teach that split.

**`presets`**, 4 entries, each a **complete 25-param recall** (kickdrum's stated bar). Source the three
voicings from the corners already authored for this module — `tidyvco-acid`, `tidyvco-pad`,
`tidyvco-bass` (`e2e/vrt/vrt-tidy-vco.spec.ts:49-81`, complete 25-key sets, every value already in
range) — plus an `INIT` entry that is `TIDY_VCO_DEFAULTS`. Three deliberate edits when copying:

- **`level: 0` everywhere.** The scenes use +3/+6 dB and the output ends in `Math.tanh(l)` (`:1036`),
  so +6 dB is ~3 dB of saturation — a timbre change disguised as a level.
- **`hold: 0` everywhere**, which makes the recall total 25/25 *and* guarantees a preset can never
  arrive with the drone pad latched.
- The values are a **copy, not a reference**: those scenes were tuned so "every fader lands at a
  clearly different position" for pixel coverage (`vrt-tidy-vco.spec.ts:44-47`), not auditioned as
  voices. Audition and adjust freely — **never by editing the VRT spec**, which would move three
  baselines for a sidebar edit.

No `readouts` block (the hero strip covers it) and no `custom` panel (`stereo-crossover` is the only
registered id, this module has no crossover, and a new one costs a component + a registry line for
nothing the glyph does not already show).

---

## 7. RANGE / CURVE / VOCABULARY CHANGES

**None proposed.** Two findings, both hazards rather than bugs:

- **`TidyVcoCard.svelte` re-types all 24 ranges — 48 literal numbers** (`:182-235`). Every one
  currently **AGREES** with the def (checked pair by pair against `tidy-vco.ts:133-180`), so this is
  the *hazard*, not the backdraft bug. No runtime gate can see a future divergence. The cheap fix is
  the ringback precedent — the def exports the ranges and the card imports them — and because the
  numbers are identical it renders byte-for-byte the same, so it costs **zero** VRT movement. Fold it
  into this PR or ticket it; do not leave it undocumented.
- **`pw.max = 0.5` looks narrow and is correct.** `tidyPwEff` re-clamps the knob to 0.05–0.5 before
  adding CV (`:386-388`), so widening the def's max would be a **silent no-op** — and duty > 0.5 is
  the spectral mirror of duty < 0.5, so the knob already spans every distinct timbre. The CV jack
  reaching 0.95 is the mirror side, not extra range. Flagged so a future author does not "fix" it.
- Considered and rejected: renaming the filter-EG labels `F.A/F.D/F.S/F.R` → `A/D/S/R` now that the
  `filter eg` cluster header supplies the context. Labels are also the MIDI-assign and Push-card
  vocabulary, where no cluster header exists, and the rename moves the dock baseline for nothing.

---

## 8. COST

- **contract-lock: ZERO.** `face` is UI metadata with no branch in `contract-signature.ts` (branch
  `types.ts`, `ModuleFace` doc). No `ParamDef`/`PortDef`/`ControlFamily`/`edge` change —
  `contract-lock.txt` must be **byte-identical**, and that is a verification row, not an assumption.
- **ART / attest: NIL, by design.** The only symbol the readouts pull from `tidy-vco-dsp.ts`
  (`tidyCutoffHz`) is *already* exported. Adding an `export` to a private const there changes the
  text hashed by `dspSourceSha` and forces an `art:update` re-capture of `out_l`/`out_r` **plus** the
  fingerprint manifest, for zero audio change. Do not.
- **VRT:** `face-tidyVco-dock` (darwin **and** linux) **MOVES** — title, hint, hero rail, readout
  strip, sidebar column, `hold` leaving band 5. The height grows, so it is a **dimension change**:
  Playwright hard-fails on size before computing a ratio and `--update-snapshots` will not help.
  **`git rm` both dock PNGs, then dispatch `vrt-update.yml`.** (It would have moved regardless:
  PF-20's `persistentReadout` adds a value line under all 24 dials.) `face-tidyVco-compact` **must
  NOT move** — every PF-20 field is dock-only and the lane ranking is untouched; a diff there is a
  finding. `rear-tidyVco`, the legacy `vrt.spec.ts` `tidyVco` scene and the three `vrt-tidy-vco`
  composites **must NOT move**. tidyVco is *not* in `STRICT_VRT_MODULES`, and `linux/tidyVco` + the
  three composites are linux-exempt (`vrt-exemptions.ts:1642-1650`), so the required `vrt-strict`
  lane is untouched.
- **e2e: cell-count delta ZERO.** The hero PROMOTES; `heroFacePlanIsTotal` is asserted on every faced
  module (branch `dock-faceplate-model.ts:165-186`), and the hero rail renders **inside** the shell
  subtree faces-parity walks, so `control-hold` stays in the multiset and stays driven. The
  tune-cluster regression (`faces-parity.spec.ts:690-716`) is untouched. `toHaveCount(pages)` still
  sees 5 (a hero is not a `face-page`). No new bespoke spec.
- **New code:** `$lib/ui/modules/tidy-vco-face-model.ts` (~60 LOC, the kickdrum-face-model precedent)
  + 3 lines in `face-readout-values.ts` + `tidy-vco-face-model.test.ts` (~90 LOC of permanent negative
  controls). `fmtHz` is reused from `kickdrum-format.ts` (branch `:29`) — a second consumer proves
  that file is platform, not kickdrum; renaming it is a follow-up.
- **CI wall-time: ≈ +0.3 s** — unit lane only, ~25 assertions over a pure-math model, no browser and
  no worklet. The VRT re-capture is a one-off dispatch, not lane time.

---

## 9. DEFECTS FOUND IN SHIPPED CODE

**PF-0 (`hold` renders as a latching rotary) is NOT live — it was fixed on 2026-07-27 and shipped.**
Verified on all four legs the design program named: `face.momentary: ['hold']` is declared
(`tidy-vco.ts:369`); `'tidyVco:hold'` was **deleted** from `ACKNOWLEDGED_LATCHING`
(`module-face-lint.test.ts:354`, with the removal reason in place); the systemic cross-check the fix
demanded exists and runs (`module-face-lint.test.ts:362-390` — no acknowledged-latching param may be
*documented* as momentary); and the shell renders the declared press-pad as a `Button` that writes
REST on release (`ModuleShell.svelte:468-476`, `firePressParam`). The face must not paper over it
because there is nothing left to paper over. It is also *why* `hold` can be the hero action for free.

Two real defects, both minor, both follow-ups:

1. **The lane-plate `oct2` readout still overflows, still ungated.** `tidy-vco.ts:209-233` reports it
   as "KNOWN, MEASURED, UNGATED — OWNER CALL"; **it is still live on main, and the platform branch
   does not fix it.** Mechanism unchanged: `.tile-body.plate` is `overflow: hidden` with
   `grid-auto-rows: var(--plate-row-h, 42px)` (`_rackline-tile.css:246,251`), and `KnobConic` renders
   the persistent 9 px `.readout` for any param with a vocabulary at **every** size including `sm`
   (`KnobConic.svelte:275-276`, `:404-406`). PF-20's `KnobConic` change only *adds* readouts at the
   dock (branch `:58-68`, `:176-184`); the lane path is byte-identical. **Cost:** OCT 2 is rank 5, the
   last plate row, so its state name is clipped at exactly the tier where the dial has no other label.
   **Why nothing catches it:** `workflow-shell-faces.spec.ts` captures only `-compact` and `-dock`
   (`:182`, `:205`) — the `full` lane plate is the one tier that renders it and the one tier no scene
   covers. That coverage gap is the fixable half; both candidate fixes move other faces' baselines, so
   it stays a separate PR.
2. **Stale count in a comment that calls itself the single source.** `packages/dsp/src/tidy-vco.ts:95`
   reads "The frozen 23-param contract" above a `PARAM_TABLE` of **25** rows (`:100-126`) — `fold` and
   `sym` were added under it. Costs a reader who trusts the number; no test can catch a comment.

Cross-face observation (on the **unmerged** platform branch, not main, so not a shipped defect):
kickdrum declares `{ label: 'settles to', paramId: 'tune' }` while also promoting `tune` to
`hero.control` — with PF-20's `persistentReadout` live, that prints the hero dial's own value twice
in one rail. It is the reason this face's strip carries no `paramId` (§5).

---

## 10. VERIFICATION GATE

Run in this order. Rows 1-6 are unit and take seconds.

```sh
# 1. the derived readouts + their PERMANENT negative controls (NEW — flake-check 3×)
REPEAT=3 flox activate -- task test:one -- tidy-vco-face-model
# 2. the shipped face decisions must be UNTOUCHED (ranks, plate, pw-inertness, oct2, dock plan, rear lockstep)
flox activate -- task test:one -- tidy-vco-face
# 3. hero keys ranked + promoted once, valueIds registered, preset values in range, hero split total
flox activate -- task test:one -- module-face-lint
# 4. the platform model itself (hero split totality, readoutText ladder, preset arithmetic)
flox activate -- task test:one -- dock-faceplate-model
# 5. the rear must not have moved (pins tidyVco's play band + EG clusters + audio-rate ticks)
flox activate -- task test:one -- rear-card-model
# 6. THE NEGATIVE CONTROL ON "face is UI metadata": this must be BYTE-UNCHANGED
flox activate -- task test:one -- contract-lock
# 7. dock multiset unchanged (hold moved, not added) + the owner tune-cluster regression
flox activate -- task e2e:serve
flox activate -- task e2e:one -- faces-parity --grep tidyVco
# 8. compact must NOT move; dock is re-captured (git rm the two dock PNGs FIRST — dimension change)
flox activate -- task vrt:one -- face-tidyVco-compact
flox activate -- task vrt:one -- rear-tidyVco
flox activate -- task vrt:one -- tidyvco          # legacy card + the 3 composite scenes
flox activate -- task e2e:stop
```

The negative controls in row 1 are the load-bearing ones and must be **permanent legs**, not
authoring-time checks: `env` perturbs `tidyvco-filter-peak` while a `cutoff` readback is invariant;
`fsus` perturbs `tidyvco-filter-sustain` while `cutoff` **and** `env` readbacks are both invariant;
`oct2` perturbs `tidyvco-osc2-interval` while a `detune` readback is invariant. Each also carries a
must-NOT-move leg (`res`, `fdec`, `mix` respectively) so the metric cannot pass by moving on
everything.
