# FACE SPEC — `swolevco` (batch 5)

## 0. PROVENANCE

Measured against `main` at `153e5c36` (2026-08-10). **BANKED — not built.**

**Verdict: PROMOTE — and the ranking argument is handed to us by the
measurement: the two knobs that rank OFF the lane are the two that are
bit-exactly inert at the shipped default.**

archetype: **the COMPLEX (West-Coast) oscillator** — Buchla 259-style, a primary
+ a sine modulator in one box.

Not in `STRICT_FACES`; no `face:` block. In `STRICT_DOCS`; **not** in
`STRICT_VRT_MODULES`; **not** in `PUSH_CARD_CONTROLS`. 8 params, 7 in, 4 out
(3 audio + 1 `mono-video`).

**Method.** The REAL `swolevcoDef.factory` under `node-web-audio-api`'s
`OfflineAudioContext` via `art/setup/offline.ts` `renderOfflineDef` — swolevco is
a pure Web Audio node graph (3 `OscillatorNode`s + crossfade gains + a 4×
oversampled `WaveShaperNode` folder + a sine modulator), **no worklet, no
Faust**, so the shipping factory *is* the instrument. 48 kHz; statistics over the
**tail half** of a 0.5 s render. `Δ` is `max|x − x_ref|` against the first step of
that param's own sweep, so a bit-exactly inert control prints `0.00e+0`.

---

## 1. WHAT IT ACTUALLY IS

Two oscillators and three taps:

```
PRIMARY  saw ─┐
         tri ─┼─ SYMMETRY 3-way crossfade ─→ FOLD (4× WaveShaper) ─→ OUT ──┐
         sqr ─┘            ▲                                               ├─ ×0.5 → SUM OUT
MODULATOR sine ────────────┴─ TIMBRE × 200 Hz → primary .frequency         │
              └────────────────────────────────────────→ MOD OUT ──────────┘
SCOPE = AnalyserNode on the OUT bus, post-fold, pre-sum.
```

*Measured*, unpatched, factory defaults:

| tap | peak | rms | rms dB | centroid |
|---|---|---|---|---|
| `out` | 0.99863 | 0.57725 | **−4.77** | 637 Hz |
| `mod_out` | 1.00000 | 0.70700 | **−3.01** | 262 Hz |
| `sum_out` | **0.50060** | 0.37826 | **−8.44** | 560 Hz |

**It is FREE-RUNNING** — full scale the instant it spawns, no gate, no note.
That matters twice: it makes swolevco the **third** free-running module to hold a
face (after `analogVco` and `macrooscillator`), so its `scope` glyph exercises
#1420's pre-frame `AudioContext` freeze; and it means the module never has a
"silent" tier for the face to fall back on.

**`sum_out` is EXACTLY `0.5·(out + mod_out)`** — `max|sum − 0.5(out+mod)| =
0.000e+0`. Not approximately: bit-identical. So the SUM tap has no independent
state and the face never needs to explain it as a third voice.

---

## 2. THE CONTROLS — 8 params, and the ranking the measurement dictates

| rank | control | tier | why |
|---|---|---|---|
| 1 | `fold` | mini | **the largest measured timbral travel on the module**: centroid 637 → 3264 Hz (5.1×) across 0..1, with only 1.8 dB of level change. It is what a hand rides. |
| 2 | `symmetry` | compact | the waveform identity **and** the level hazard (§4-C): 4.8 dB of non-monotonic swing and over-full-scale at both ends. |
| 3 | `ratio` | plate | the modulator's whole behaviour, including the cliff at 0 (§4-A). |
| 4 | `timbre` | plate | the marquee FM control — ranked 4, not 1, **because it is the weakest of the four** (§4-D): +23 % of centroid across its whole range. |
| 5 | `tune` | plate | pitch. |
| 6 | `fine` | plate | pitch. |
| 7 | `mod_tune` | **dock only** | **bit-exactly inert at the shipped default** (§4-B). |
| 8 | `mod_fine` | **dock only** | ditto. |
| 9 | `swolevco-routing-{n}` | dock only (panel) | the picture — §7. |

⚠ **Ranks 7 and 8 are an argument, not a leftover.** `faceTierCap('full')` is 6,
so ranks 7+ are dock-only by construction. `mod_tune` and `mod_fine` are
**measured bit-exactly inert** in the state a rack spawns in (`ratio = 1`), and a
192×180 lane tile that paints two dead dials is a tile that lies. In the dock
they are live **and** the sidebar can say the one sentence that makes them make
sense. This is the cleanest instance in the batch of the rank-encodes-an-argument
rule, because the argument is a number.

⚠ **A PANEL's first legal rank is 7** (`module-face-lint` refuses a panel
selected at a lane tier; `faceTierCap('full') = 6`) — the drummergirl wall.
swolevco has **8** params, so rank 9 is reachable and the picture can be a real
`hero.cell` rather than a sidebar `custom` block. That is the difference between
this module and `resofilter`/`attenumix` in batch 4, and it is purely arithmetic.

**NO AUDITION.** swolevco free-runs; there is nothing to strike. An `action` cell
would need a `ShellActionCell.probe` reaching a callable that does not exist.

---

## 3. INERT AT SPAWN

**Two of eight**: `mod_tune` and `mod_fine`, `Δ = 0.00e+0` on all three audio
outputs across their full declared ranges (±36 st, ±100 ¢) at the default
`ratio = 1`. Not a defect — `docs.controls` already says *"Active when Ratio = 0
(free-run); when Ratio is greater than 0 the modulator follows the primary ×
Ratio and this is ignored"* — but **nothing on the panel says it**, and the card
renders them as two ordinary faders identical to the six live ones.

*Positive control* (the same two params at `ratio = 0`), `mod_out` centroid:

| `mod_tune` | −36 | −18 | 0 | +18 | +36 |
|---|---|---|---|---|---|
| centroid | 33 Hz | 93 | 262 | 740 | 2093 |

So the probe is not blind: it reads them moving the moment they are legal.

---

## 4. WHAT THE FACE MUST MAKE VISIBLE — four measured facts

### A. The bottom of RATIO is a 10-octave CLIFF, and the first 1 % of it puts DC on an AUDIO jack

`ratio = 0` means *free-run*; `ratio > 0` means *modulator = primary × ratio*.
The branch is `initial.ratio > 0` (`swolevco.ts:312`, `:443`, `:452`) — a
**strict** comparison, so the transition is at the very bottom of the fader.

*Measured*, `mod_out`, tail of a 0.5 s render:

| `ratio` | 0 | 1e-4 | 1e-3 | 0.01 | 0.1 | 0.5 | 1 | 2 |
|---|---|---|---|---|---|---|---|---|
| peak | 1.000 | **0.082** | **0.732** | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |
| rms dB | −3.01 | −24.05 | −4.70 | −2.24 | −3.03 | −2.99 | −3.01 | −3.01 |
| **DC** | −0.003 | **+0.0616** | **+0.5741** | −0.0511 | −0.0448 | +0.0026 | −0.0029 | +0.0013 |
| centroid | 262 Hz | 6 | 6 | 8 | 26 | 131 | 262 | 523 |

**At `ratio = 0` the modulator is a 261.6 Hz sine at full scale. One
ten-thousandth of the dial later it is at 0.026 Hz** — i.e. a DC rail that
inches. At `ratio = 1e-3` the measured **DC offset is +0.574** on `mod_out`, an
`audio`-typed jack, and `sum_out` carries +0.286 of it. A plain RMS/peak silence
guard reads that as a healthy −4.7 dB signal.

This is the cube-rebuild DC class on a second module, with one difference worth
stating: **cube's fault is at a knob's MAXIMUM, swolevco's is one pixel above its
MINIMUM** — the place a player passes through on the way to free-run, every time.

> **Face consequence:** the modulator's *actual frequency* must be a READOUT, not
> something the player infers from a 0..8 fader. §6-A.

### B. Two of eight knobs are inert in the state the rack spawns in

§3. **The mode word — `free-run` vs `×N` — is the missing information**, and it
is a function of one control, so it is a readout, not a hint.

### C. SYMMETRY's level is NON-MONOTONIC and both ends exceed full scale

*Measured*, `out`:

| `symmetry` | 0 (saw) | 0.25 | 0.5 (tri) | 0.75 | 1 (sqr) |
|---|---|---|---|---|---|
| peak | **1.0286** | 0.7493 | 0.9986 | 0.9993 | **1.0428** |
| rms dB | −4.87 | −5.38 | −4.77 | −2.36 | **−0.07** |
| centroid | 3750 Hz | 3126 | **637** | 2832 | 3258 |

Three things at once. **(i) 4.8 dB of level spread** across a control the docs
describe purely as a waveform morph. **(ii) Both ends clip** — 1.0286 and 1.0428
peak, with no output stage anywhere in the module. **(iii) The triangle is a
single point**: at 0.5 the centroid is 637 Hz; at 0.4 it is 1986 Hz and at 0.6 it
is 1925 Hz. A 0.1 move off centre **triples** the brightness, because saw and
square carry far more HF than triangle and the crossfade is linear in amplitude.

That last one is a *layout* fact, not a defect — a 3-way linear crossfade does
exactly this — but it is invisible from the panel and it is why the default
position feels like a detent that is not there.

### D. TIMBRE — the marquee control — is the WEAKEST of the four timbral knobs

*Measured*, full sweep 0..1:

| | `out` rms dB | `out` centroid | `sum_out` rms dB |
|---|---|---|---|
| `timbre = 0` | −4.77 | 637 Hz | −8.44 |
| `timbre = 0.5` (interp.) | −4.55 | ~704 | −10.8 |
| `timbre = 1` | −4.95 | **786 Hz** | **−12.52** |

**+23 % of spectral centroid for the whole travel**, against FOLD's **+412 %**.
The declared law is ±200 Hz of deviation at full knob, which on a 261.6 Hz
carrier is a modulation index of 0.76 — modest by construction, and the number
in `docs.controls` is honest. But the panel gives TIMBRE the same fader as FOLD,
and a player reasonably expects the Buchla word to be the big one.

⚠ **And TIMBRE makes SUM OUT 4.1 dB QUIETER** (−8.44 → −12.52 dB) while leaving
OUT alone. Turning up the cross-modulation *reduces* the two-oscillator tap.

### E. SUM OUT is 6 dB down at the FACTORY DEFAULT and nowhere else

*Measured*, `sum_out` peak by `ratio`: **0.5006 at ratio 1**, 0.998 / 0.998 /
0.992 / 0.880 at 0.01 / 0.1 / 0.5 / 2. The default is unison, and a triangle
against a sine at the same frequency partially cancels.

⚠ **AND MY FIRST READING OF THIS WAS INCOMPLETE — see §8.** Sweeping `tune` at a
fixed `ratio = 1` moved `sum_out` by **15.2 dB** (−4.11 dB at −36 st, **−19.23 dB
at −7.2 st**, −4.00 at +7.2), which cannot happen if the two oscillators are
rigidly phase-locked at unison. Recorded as *measured*, mechanism **inferred**
(a residual frequency/phase difference between the primary's base-Hz path and
`baseHz × ratio`), and flagged for the DSP owner rather than asserted.

---

## 5. THE FACE

```ts
// ⚠ NO `title`, NO `hint` — owner no-prose ruling, 2026-08-11. "RATIO decides
// everything about the modulator" is a `docs` sentence; what the panel carries
// is the band label, the band hint and the readouts below.
face: {
  order: [
    // hero ladder — mini 1 / compact 2 + glyph / plate 6
    'fold',        // largest measured timbral travel (5.1x centroid)
    'symmetry',    // waveform identity + the 4.8 dB level hazard
    'ratio',       // the mode switch AND the cliff
    'timbre',      // the FM index (ranked 4 on measurement, not on branding)
    'tune',
    'fine',
    // DOCK-ONLY, deliberately: bit-exactly inert while RATIO > 0.
    'mod_tune',
    'mod_fine',
    // PANEL — rank 9. Legal because this module has 8 params (a panel's first
    // legal rank is 7); resofilter and attenumix could not reach it.
    'swolevco-routing-{n}',
  ],

  pages: [
    // ⚠ TWO bands, not three. DOCK_TAB_MIN_BANDS is 7 and PF-21 packs
    // consecutive packable bands onto one row at <=10 cells; 4 + 4 cells fits
    // one packed row, so the whole faceplate is one row of bands plus the hero.
    { id: 'primary', label: 'primary oscillator',
      hint: 'saw -> tri -> sqr crossfade, then the folder',
      controls: ['tune', 'fine', 'symmetry', 'fold'] },
    { id: 'modulator', label: 'modulator + cross-mod',
      hint: 'RATIO 0 = free-run; above 0 M.TUNE / M.FINE are ignored',
      controls: ['ratio', 'timbre', 'mod_tune', 'mod_fine', 'swolevco-routing-{n}'] },
  ],

  glyph: 'scope',
  hero: {
    cell: 'swolevco-routing-{n}',
    control: 'fold',
    readouts: [
      { label: 'mod',   valueId: 'swolevco-mod-hz' },
      { label: 'lock',  valueId: 'swolevco-mod-lock' },
      { label: 'shape', valueId: 'swolevco-shape-name' },
      { label: 'peak',  valueId: 'swolevco-peak-est' },
    ],
  },

  // ⚠ THE `signal-flow` BLOCK THIS DRAFT CARRIED IS GONE — the KIND was deleted
  // (#1468, owner ruling). Twelve modules declared hand-authored stage lists
  // that nothing verified against the DSP; a chain picture must be DERIVED from
  // something the build can check, or it must not exist. The `×0.5 exactly` fact
  // it carried is bit-verified (§1) and belongs in `docs` and in the picture.
  sidebar: [
    { kind: 'readouts', label: 'what M.TUNE / M.FINE do here', entries: [
      { label: 'RATIO = 0',  text: "the modulator's own pitch" },
      { label: 'RATIO > 0',  text: 'nothing — primary x RATIO wins' },
    ] },
  ],
}
```

⚠ Every load-bearing fact above is a **band label**, a **band hint**, a
**READOUT** or a **sidebar `text` entry** — the four surfaces that paint without
annotations.

⚠ **Band-hint budget.** `'RATIO 0 = free-run; above 0 M.TUNE / M.FINE are
ignored'` is **56 characters**. Band hints are dock-only and never render on a
tabbed face; this face has **2** bands, well under `DOCK_TAB_MIN_BANDS` (7), so
they do render. Shorter fallback that keeps the fact, **31 chars**:
`'RATIO 0 -> M.TUNE; else ignored'`.

⚠ **`swolevco-routing-{n}` as a control FAMILY vs. a sidebar `custom` block.**
Both are correct; the family costs a `contract-lock` line and buys a real
`hero.cell`, the sidebar block costs nothing and carries no rank. **The
`hero.cell` is better here because it suppresses the dock glyph, and on a
free-running oscillator that glyph is a 40 px wobbling line.**

---

## 6. DERIVED READOUTS — every one negative-controlled in BOTH directions

### A. `swolevco-mod-hz` — the readout that IS the face

```
mod_hz = ratio > 0 ? baseHz(tune, fine) * ratio
                   : baseHz(mod_tune, mod_fine)          // baseHz(0,0) = 261.626
```
*Anchors, measured*: `ratio 0` → 262 Hz · `ratio 1e-3` → **0.26 Hz** · `ratio 1`
→ 262 · `ratio 2` → 523 · (`ratio 0`, `mod_tune −36`) → 33 Hz.

**NEGATIVE CONTROL — `mod_tune`.** The readout must be **invariant** to it while
`ratio > 0` (measured `Δ = 0.00e+0` on the audio) and must move with it at
`ratio = 0` (measured 33 → 2093 Hz). A `paramId: 'mod_tune'` readout would print
a moving number in the state where the control is dead — the exact
knob-relabelled-as-readout trap.
**SECOND CONTROL — `ratio` across 0.** It must jump ~10 octaves between 0 and
1e-4; a readout that interpolated smoothly there would be smoothing over the
defect.

### B. `swolevco-mod-lock` — the mode word

Prints `free-run` at `ratio = 0`, `×1.00 unison` at 1, `×2.00 +1 oct` at 2,
and **`×0.001 — DC`** below ~0.01 (measured DC +0.574 at 1e-3, +0.062 at 1e-4).
**NEGATIVE CONTROL — `mod_tune`:** must not move it at all.
**SECOND — `ratio`:** must change word class exactly at 0, matching the strict
`> 0` branch in the factory. Publishing A and B together is their own control: A
must move where B does not and vice versa.

### C. `swolevco-shape-name` — where SYMMETRY actually is

`saw` / `saw+tri 60/40` / **`triangle`** (only within a stated tolerance of 0.5)
/ `tri+sqr` / `square`. **NEGATIVE CONTROL — `fold`:** must not move it (fold
changes the centroid by 5.1× and the shape name by nothing). The readout exists
because the measured centroid ladder (3750 / 3126 / **637** / 2832 / 3258 Hz)
says `triangle` is a point, and a fader gives no detent.

### D. `swolevco-peak-est` — the clip warning, before you hear it

A pure function of `symmetry` and `fold`, anchored on the measured table in §4-C
(1.029 / 0.749 / 0.999 / 0.999 / 1.043) and §4 fold peaks (1.000 / 1.003 /
1.001). Print **red above 1.00**. **NEGATIVE CONTROL — `tune`:** the peak is
frequency-invariant (measured 0.990–1.000 across ±36 st), so a derivation that
moved with TUNE is reading the wrong thing. **SECOND — `symmetry` at 0 and 1**,
which must both read over 1.0 while 0.25 reads 0.75.

---

## 7. THE PICTURE

**The routing map, in the HERO** (rank 9, legal here — §2). Not a scope trace:
the module's identity is *which oscillator drives what*, and that is exactly the
thing the panel cannot say. It draws

- the **primary** as the actual current shape (saw / tri / sqr blend from
  `symmetry`), post-fold,
- the **modulator** as a sine whose drawn frequency is `swolevco-mod-hz` relative
  to the primary — so the **cliff is visible as a picture**: at `ratio = 1e-3`
  the modulator line goes flat,
- the **FM arrow** thickness from `timbre`,
- the **SUM** tap annotated `×0.5`.

Do **not** draw a bare OUT waveform here. A free-running triangle looks the same
at every setting of the two controls that matter most.

---

## 8. THE INSTRUMENT WAS WRONG ONCE, AND IT LOOKED AUTHORITATIVE

**"`mod_tune` and `mod_fine` are dead controls."** They are not: they are
**mode-gated**, and the first sweep held `ratio` at its default of 1, which is
precisely the mode in which they are specified to do nothing. `Δ = 0.00e+0` on
three outputs across the full range is about as convincing a dead-control read as
exists, and it was wrong about the *cause*. **Re-running the same sweep at
`ratio = 0` moved the centroid 33 → 2093 Hz.**

The general form: **a param sweep that holds every other param at its default is
blind to every mode-gated control on the module** — and mode-gated controls are
exactly the ones a face is for. The batch-wide fix is in the INDEX (§6).

---

## 9. ALREADY-WRONG

- **A · `ratio ∈ (0, ~0.01]` puts up to +0.574 of DC on `mod_out`** (an `audio`
  jack) and +0.286 on `sum_out`. §4-A. **Its own DSP PR** — either clamp the
  ratio-locked modulator to a musical floor, or make the free-run branch
  `>= some epsilon` instead of `> 0`. Not a face change.
- **B · SYMMETRY peaks at 1.0286 (saw) and 1.0428 (square)** with no output
  stage. §4-C. Same DSP PR class; would move `art/baselines/` if swolevco is
  ever ART-profiled (it is not today).
- **C · `sum_out` swings 15.2 dB with TUNE at a fixed RATIO = 1.** §4-E.
  Measured; mechanism inferred. Needs an owner/DSP look before anyone builds a
  headroom readout on the SUM tap.
- **D · the card re-types all eight ranges.** `SwolevcoCard.svelte:38-47` passes
  literal `min={-36} max={36}`, `min={0} max={8}`, … for every one of the eight
  faders, and **`swolevco` is not in `RANGE_BOUND_CARDS`**, so `card-range-source`
  cannot see a divergence. The backdraft class, unguarded.
- **E · the docs oversell TIMBRE by an order of magnitude.**
  `docs.explanation` says "pour FM in with Timbre to climb from sweet to
  screaming" and `docs.controls.timbre` promises "clangorous, bell-like and noisy
  Buchla-style timbres" — for a control worth **+23 %** of centroid against
  FOLD's **+412 %** (§4-D). Neither is false; both mis-rank it. `swolevco` is in
  `STRICT_DOCS`. (Exact phrasings re-read on `main` 2026-08-12; both stand.)
- **No dead controls** — but **two mode-dead ones**, which is the face's whole
  argument (§3).

---

## 10. THE ONE COST THAT IS NOT ARITHMETIC

⚠ **swolevco FREE-RUNS**, which makes its face baselines the third test of
#1420's pre-frame `AudioContext` freeze (after `analogVco` and
`macrooscillator`). **Derive glyph determinism the analogVco way — 10 separate
processes, unmasked — do not assume the freeze covers it.** Face baselines are
now captured in the REQUIRED `vrt-strict` lane (#1483), so a non-deterministic
glyph is a merge blocker rather than an informational diff.

swolevco has **no** ART scenario today; §9-A/B are real audio changes and are
not in the face PR.
