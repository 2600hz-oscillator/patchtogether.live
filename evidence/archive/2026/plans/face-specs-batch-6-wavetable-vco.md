# FACE SPEC — `wavetableVco` (batch 6)

> **Two owner rulings, 2026-08-11, apply to this file** (verbatim at
> `rings.ts:585-590` and `:645-650`): *"we should prefer almost zero AI authored
> text, and all future faceplate work should reflect that"* and *"lets stop doing
> these and clean up the existing ones, get rid of them. lose the signal flow
> diagrams."* Every proposed `hint` and the `signal-flow` sidebar block have been
> **deleted** from §5; their measured content is in §3/§4/§8. Do not re-author
> them. Measurements belong in `docs.controls` (the `rings.ts:592-596` precedent),
> not on the panel.

# 0. STATUS — ⚠ THE SEQUENCING BLOCKER HAS SILENTLY CLEARED

**This spec says it is gated behind a platform gap. IT IS NOT, ANY MORE.** The
blocker was that all five params are `<Fader>` on the card while `'fader'` was not a
`ParamCellKind` on `main`, so `paramCellKind()` returned `'knob'` for all five and
promoting the module would silently convert five faders into five dials.

✅ **`'fader'` IS NOW A `ParamCellKind`** (`shell-control-kind.ts`, verified
2026-08-12), and `rings.ts:578-584` ships the first consumer:
`paramCells: { damping: 'fader', brightness: 'fader', … }`. **The gap is closed and
this spec is MORE BUILDABLE than its own text says.** §5 constraint 1 below is
retained only for its argument about *why* the affordance matters here.

**Authored 2026-08-11. UNBUILT** — no `face:` block. **Every number below was
MEASURED against the shipping worklet** (`packages/dsp/src/wavetable-vco.ts`),
pumped through `process()` in 128-sample blocks at 48 kHz.

⚠ **METHOD NOTE, load-bearing: the 16-frame table under test is not a retyped
mirror.** The shipping `generateBasicTable()` source text is lifted **verbatim** out
of `packages/web/src/lib/audio/modules/wavetable-vco.ts` and evaluated, then posted
through the processor's **real `port.onmessage`** load path — byte-for-byte the
table the factory transfers.

**Determinism control:** two identical renders are **bit-equal**
(`maxAbsDiff = 0.000e+0`). Before the load message the processor emits exactly `0`
(**`peak 0.0000`**), which is also the negative control on the loader.

**Verdict: PROMOTE — and it carries a LIVE CARD-vs-DEF DEFECT of the backdraft class
in the direction nothing has caught before.**

**Two headlines.**

1. **`WavetableVcoCard.svelte:36-37` ships `fmAmount` and `pmAmount` as
   `min={0} max={1}`. `wavetable-vco.ts:116-117` declares `min: -1, max: 1`.**
   (CONFIRMED 2026-08-12.) The bottom half of both bipolar dials is unreachable from
   the card, and the def's own `docs.controls` documents what lives there ("negative
   values invert the modulator's polarity"). **This is the CARD-narrower-than-DEF
   case: no value is written out of contract, so nothing clamps, nothing warns, and
   the feature is simply missing.** ⚠ **And a symmetric probe clears it.** Measured
   with a sine LFO, `fmAmount +1` and `−1` are spectrally identical (centroid 1031 vs
   1025 Hz, rms −4.78 vs −4.78 dB). With the modulator you would actually use — a
   unipolar 0→1 envelope — `+1` sweeps f0 **271 → 505.5 Hz** and `−1` sweeps it
   **253 → 135.5 Hz**, centroid **1004 vs 541 Hz**. The defect is real and the
   obvious probe cannot see it.
2. **Two of the five controls are bit-exactly inert at spawn, and so are two of the
   eight inputs — mutually.** `fmAmount` over its full travel with no cable:
   `max|Δ| = 0.000e+0`. The `fm` cable with `fmAmount` at its default 0:
   `maxAbsDiff = 0.000e+0`, bit-equal. Same for `pm`/`pmAmount`. **The enabler pair
   here is a control and a CABLE, and the face platform cannot see a cable** (§6-F).

archetype: **the single-table scanner — one continuous morph, two sleeping
modulation paths, and no band-limiting.**

Not in `STRICT_FACES`. **In `STRICT_DOCS`** (`strict-docs.ts:55`). **In
`STRICT_VRT_MODULES`** (`vrt-exemptions.ts:1075`) — its card baseline is in the
REQUIRED gate. Not in `PUSH_CARD_CONTROLS`. **On `ART_BACKLOG`**
(`art/setup/profile-coverage.ts:114`) — no audio pin exists. **5 params, 8 in,
1 out.** contract-lock block = **15 lines**. Declares
`chainWiring: { role: 'source' }`.

---

## 1. EVERY PARAM AND PORT

### Params (5)

| id | label | range (DEF) | range (CARD) | curve | default | units | measured authority `max\|Δ\|` (nothing patched) | centroid span |
|---|---|---|---|---|---|---|---|---|
| `tune` | Tune | −36 .. 36 | −36 .. 36 ✓ | linear | 0 | **st** | 1.981e+0 | 331 .. 6094 Hz |
| `fine` | Fine | −100 .. 100 | −100 .. 100 ✓ | linear | 0 | **¢** | 1.994e+0 | 439 .. 1646 Hz |
| `wavePos` | Wave | 0 .. 1 | 0 .. 1 ✓ | linear | **0** | — | 9.995e-1 | 260 .. 439 Hz |
| `fmAmount` | FM | **−1 .. 1** | **0 .. 1** ✗ | linear | 0 | — | **0.000e+0** | 439 .. 439 |
| `pmAmount` | PM | **−1 .. 1** | **0 .. 1** ✗ | linear | 0 | — | **0.000e+0** | 439 .. 439 |

The card additionally re-types every range as a literal, and `wavetableVco` is
**not** in `RANGE_BOUND_CARDS` — which is why the two ✗ rows have been shipping
unseen.

### Ports (8 in, 1 out)

| dir | id | type | notes |
|---|---|---|---|
| in | `pitch` | pitch | 1 V/oct, 0 V = C4. `semitones = pitch·12 + tune + fine/100 + fmAmount·fm·12`. |
| in | `fm` | audio | **EXPONENTIAL** FM, added in the semitone domain. Not through-zero; `freq` floored at 1 Hz, ceilinged at 20 kHz. **Bit-exactly inert at the default `fmAmount = 0`.** |
| in | `wavePos` | cv, `paramTarget: 'wavePos'`, **no `cvScale`** | summed per-sample in the worklet (`wp = wpKnob + wpCv`, clamped 0..1), so it is not on the CV→AudioParam fast path — `PASSTHROUGH_BY_DESIGN`. |
| in | `pm` | audio | phase offset in **cycles**; the accumulator is untouched. **Bit-exactly inert at the default `pmAmount = 0`.** |
| in | `tune` / `fine` / `fmAmount` / `pmAmount` | cv, `cvScale: { mode: 'linear' }` | CV→AudioParam fast path, WaveShaper-scaled to the param's natural range. |
| out | `audio` | audio | mono, peak pinned at ~1.0 across the whole table. |

---

## 2. AT SPAWN

*Measured*, nothing patched, 0.5 s:

```
peak 0.9998   rms 0.5774 (−4.77 dBFS)   dc −1.76e-4
f0 261.75 Hz (Goertzel, 0.25 Hz grid)   — C4 = 261.626
centroid 983 Hz
```

A **free-running, full-scale saw** the instant it spawns — the analogVco situation,
and the reason §5 picks the glyph the way it does. `wavePos = 0` is frame 0, and the
harmonic ratios confirm an ideal saw: `H2/H1 = 0.5000`, `H3/H1 = 0.3333` — exactly
`1/n`.

---

## 3. THE TABLE, MEASURED

`frameFloat = wavePos × (FRAME_COUNT − 1) = wavePos × 15`. The four canonical shapes
land at exact wavePos values that **nothing anywhere tells the user**:

| `wavePos` | frame | shape | peak | rms | rms dB | theory |
|---|---|---|---|---|---|---|
| **0.0000** | 0 | saw | 0.9998 | 0.5774 | **−4.770** | `1/√3 = −4.771` |
| **0.3333** | 5 | square | 1.0000 | 0.9997 | **−0.003** | `1 = 0.000` |
| **0.6667** | 10 | triangle | 1.0000 | 0.5775 | **−4.768** | `1/√3 = −4.771` |
| **1.0000** | 15 | sine | 1.0000 | 0.7073 | **−3.008** | `1/√2 = −3.010` |

Every one within 0.003 dB of the analytic crest factor, so the table is exactly what
the generator claims.

### 3-A. WAVE is CLEAN — the NEGATIVE RESULT, and it is worth saying out loud

**0 bit-identical adjacent pairs out of 300** steps across the dial. No plateau, no
quantiser, no dead half. **On a programme where four of the last five promotions
found a dead control, WAVE is a genuinely continuous control over its entire
travel, and the face should not imply otherwise.**

### 3-B. …but WAVE is also a 4.77 dB LOUDNESS control

`−4.770 dB` at saw → `−0.003 dB` at square → `−4.768` at triangle → `−3.008` at
sine. **Peak stays pinned at ~1.0 the whole way, so no peak meter and no clip
indicator can see it**; only rms can. Sweeping WAVE under a filter is a 4.8 dB level
ride, and the dial says `0.33`.

Full sweep, 21 points (excerpt):

| `wavePos` | 0.00 | 0.15 | 0.30 | **0.35** | 0.50 | 0.65 | 0.80 | 1.00 |
|---|---|---|---|---|---|---|---|---|
| rms dB | −4.78 | −2.59 | −0.44 | **−0.22** | −2.34 | −4.55 | −4.04 | −3.01 |
| centroid Hz | 439 | 368 | 355 | 349 | 297 | 262 | 260 | 260 |
| H2/H1 | 0.5000 | 0.1896 | 0.0263 | **4.5e-4** | 0.0015 | 0.0030 | 0.0030 | 0.0027 |
| H3/H1 | 0.3333 | 0.3333 | 0.3333 | 0.3189 | 0.1604 | 0.0772 | 0.0610 | 6.6e-6 |

The `H2/H1` collapse to 4.5e-4 at wavePos ≈ 1/3 is the square's even-harmonic null;
`H3/H1 → 6.6e-6` at 1.0 is the sine. Both are the table behaving as designed.

### 3-C. NO BAND-LIMITING — and the source comment understates it by an octave and a half

`packages/dsp/src/wavetable-vco.ts:10-11`: *"v1: no mip-mapping (some aliasing above
~8 kHz fundamental)"*. *Measured* as inharmonic power (total minus the power at every
`n·f0` below Nyquist), 0.4 s renders, pitch driven past the +36 st TUNE ceiling
through the `pitch` port:

| f0 | harmonics below Nyquist | inharmonic @ saw | @ square | @ sine |
|---|---|---|---|---|
| 261.6 Hz (C4) | 91 | **0.40 %** | 0.37 % | 0.07 % |
| 523.3 | 45 | 1.33 % | 0.81 % | 0.00 % |
| 1046.5 | 22 | 2.56 % | 1.77 % | 0.02 % |
| 2093.0 (max TUNE) | 11 | **5.20 %** | 3.29 % | 0.00 % |
| 4186.0 | 5 | **10.89 %** | 6.60 % | 0.00 % |
| 8372.0 | 2 | **23.90 %** | 18.86 % | 0.00 % |
| 16744.1 | 1 | 39.14 % | 18.87 % | 0.00 % |

**Already 5.20 % at 2.09 kHz — an octave and a half below the "~8 kHz" the comment
names — and 10.89 % at 4.19 kHz (C8)**, which is inside the range a sequencer will
reach. The sine frame is clean everywhere (a single partial), **so aliasing is a
function of BOTH pitch and frame**, which is what makes §6-C a real derivation
rather than a pitch readback.

### 3-D. The `wavePos` CV live window is EXACTLY 1.0 wide, at every knob setting

`wp = clamp(wpKnob + wpCv, 0, 1)`. Adjacent-cv bit-identity scan (step 0.02 over
cv ∈ [−1, +1], 0.15 s renders):

| knob | fraction of a ±1 CV that still moves the output |
|---|---|
| 0.00 | **50 %** |
| 0.25 | 51 % |
| 0.50 | **50 %** |
| 0.75 | 51 % |
| 1.00 | **50 %** |

The live cv window is `[−knob, 1−knob]` — always 1.0 wide out of a 2.0-wide
modulator. **There is no knob position at which a full-scale bipolar CV avoids
clamping.** And **at the shipped `wavePos = 0` the dead half is the NEGATIVE half**:
measured at knob 0, `maxAbsDiff` vs `cv = 0` is `0.000e+0` for cv = −1, −0.75, −0.5,
−0.25 and −0.1, and `3.000e-1 … 9.995e-1` for the positive mirror. **A bipolar LFO
into WAVE POSITION at the default knob is half-wave-rectified.**

**Instrument check:** the same metric reads `0.000e+0` for negative cv at knob 0 and
`3.0e-1 … 1.0e+0` for positive cv, so it is not blind to the dimension it is
testing.

---

## 4. FM AND PM, MEASURED

### 4-A. FM tracks the exponential law exactly, and the sign genuinely inverts

*Measured* f0 at a constant `fm` input (zero-crossing rate, 0.4 s window → 2.5 Hz
resolution):

| `fmAmount` | `fm = +1` measured (predicted) | `fm = −1` measured (predicted) |
|---|---|---|
| −1 | 130.00 (130.81) | 522.50 (523.25) |
| −0.5 | 182.50 (185.00) | 367.50 (370.00) |
| 0 | 260.00 (261.63) | 260.00 (261.63) |
| +0.5 | 367.50 (370.00) | 182.50 (185.00) |
| +1 | 522.50 (523.25) | 130.00 (130.81) |

±1 at full input is exactly ±12 semitones, and negative `fmAmount` is a clean
polarity inversion. **The FM floor is real but hard to reach**: at `fmAmount 1` with
a 2 Hz sine and pitch driven to −6 V (f0 = 4.088 Hz) the trough would be 2.044 Hz,
still above the 1 Hz floor; rms only moves −4.78 → −5.04 dB.

### 4-B. PM leaves the fundamental alone — proven with a valid instrument

⚠ **A zero-crossing counter is the WRONG instrument here and said so loudly.**
Round 1 read the output f0 as 260 → 1047 Hz across the PM dial, which looks like a
pitch change; PM adds crossings without touching `this.phase`. Re-measured with
Goertzel bins (1.0 s, `wavePos = 1` so the carrier is a single partial):

| `pmAmount` | mag @261.6 | mag @523.3 | mag @130.8 (a subharmonic would mean f0 MOVED) | centroid |
|---|---|---|---|---|
| 0 | 1.00e+0 | 1.03e-3 | 1.98e-3 | 260 Hz |
| 0.1 | 8.56e-1 | 3.04e-1 | 1.91e-3 | 265 |
| 0.25 | **2.23e-1** | **6.36e-1** | 9.94e-4 | 411 |
| 0.5 | 7.89e-1 | 6.18e-1 | 1.13e-3 | 303 |
| 1 | 5.08e-1 | 1.83e-1 | 1.23e-3 | 386 |
| −0.5 | 7.89e-1 | 6.18e-1 | 2.15e-3 | 301 |
| −1 | 5.07e-1 | 1.83e-1 | 9.23e-4 | 387 |

The 130.8 Hz bin never rises — the fundamental does not move. The harmonic
distribution moves violently and **non-monotonically** (H2 overtakes H1 at
`pmAmount 0.25`, then falls back). And `±0.5` / `±1` are pairwise identical to three
digits: **PM's sign is spectrally inaudible for a symmetric modulator**.

### 4-C. So how much does the card's clamp actually cost?

| | symmetric sine LFO | unipolar 0→1 envelope |
|---|---|---|
| **FM** `+1` vs `−1` | centroid 1031 vs 1025 Hz, rms −4.78 vs −4.78 — **identical** | f0 **271→505 Hz** vs **253→135 Hz**, centroid **1004 vs 541 Hz** — **an octave up vs an octave down** |
| **PM** `+1` vs `−1` | centroid 278 vs 271, rms −3.01 vs −3.01 — identical | centroid 261 vs 260, rms −3.01 vs −3.01 — identical |

**The card's `min={0}` costs a real, audible feature on FM (envelope polarity) and
essentially nothing audible on PM.** Both are still contract violations, and the FM
half is the one that matters. ⚠ Note what a level-only metric would have concluded:
`maxAbsDiff(+1, −1)` is **1.99** in every one of those four cells while `rms` differs
by **0.00–0.03 dB**. **Time-domain difference without level difference is the
signature of a control whose defect a loudness probe cannot see.**

### 4-D. The mutual deadlock, stated as measurements

| probe | result |
|---|---|
| `fm` cable patched, `fmAmount` at its default 0 | `maxAbsDiff = 0.000e+0`, **bit-equal** |
| `pm` cable patched, `pmAmount` at its default 0 | `maxAbsDiff = 0.000e+0`, **bit-equal** |
| `fmAmount` over its FULL travel, no cable | `max|Δ| = 0.000e+0` |
| `pmAmount` over its FULL travel, no cable | `max|Δ| = 0.000e+0` |

⚠ **These plateaus are NOT quantisation, and the distinction matters.** There is no
"plateau width vs resolution floor" to report because the DSP computes `fma * fm` —
with either factor zero the product is *identically* zero for every value of the
other. **A multiplicative annihilator, not a step size. The plateau is the WHOLE
dial, and it is exact by construction.**

**The test suite already knows.** `per-module-per-port-behavioral.spec.ts:805`
carries `wavetableVco: { fmAmount: 0.5, pmAmount: 0.5, wavePos: 0.5 }` with the
comment *"same shape as analogVco (fmAmount/pmAmount gating)"*, and four ports are
ledgered as *"cv-modulates-knob-that-modulates-zero-input"* (`:1360-1363`). **The
harness has to open the enablers to get coverage at all — and nothing the player
sees says the same thing.**

### 4-E. TUNE / FINE track exactly; DC is negligible

`tune` −36/−12/0/+12/+36 st → 32.500 / 130.000 / 260.000 / 522.500 / 2092.500 Hz
against predicted 32.703 / 130.813 / 261.626 / 523.252 / 2093.008 (the residual is
the 2.5 Hz zero-crossing grid, not a tracking error). `fine` ±100 ¢ → 246.000 /
276.000 against 246.942 / 277.183.

DC across the table: `2.9e-5` (saw) to `1.4e-3` (square). There is no DC blocker
anywhere, and none is needed.

---

## 5. THE FACE

### Three platform constraints that decide the shape

1. **THE AFFORDANCE — and this is now DECLARABLE, not a blocker.**
   `WavetableVcoCard.svelte` renders all five params with `<Fader>`. `'fader'` is now
   a `ParamCellKind` (§0), so `paramCells` below is legal on `main` and the face
   paints travels where the card has travels. **The argument for why it matters here
   is retained:** `wavePos` is a 0..1 scan whose four landmark shapes sit at
   0 / 0.3333 / 0.6667 / 1.0 (§3) — a vertical fader with tick marks reads that; a
   270° dial does not. `tune` is ±36 semitones and `fine` ±100 cents, both
   centre-detented travels. **Without the declaration `paramCellKind()` falls through
   to `'knob'` for all five** (none is switch-shaped, none declares `options`, none is
   `momentary`), which is the substitution the owner has rejected twice.
2. **5 params, so a panel cannot be ranked** — its rank-7 floor is unreachable here.
   The picture goes in the **sidebar** as a `custom` block (the meowbox precedent),
   and `hero.cell` stays unset so the glyph keeps painting at the dock.
3. **The glyph system resolves off an AUDIO OUTPUT, and this module has one**
   (`audio`, `type: 'audio'`), so `glyph: 'scope'` binds to a real analyser tap rather
   than falling through to a canned `{kind: 'static'}` trace.

```ts
face: {
  title: 'Table scanner',

  // WAVE outranks TUNE deliberately, against the "pitch first" instinct and
  // against the def's own declaration order: this module declares
  // chainWiring.role = 'source' and carries a V/oct port, so on a rack it plays
  // under a sequencer and TUNE is a trim. The macrooscillator `note` precedent.
  order: [
    'wavePos',    // 1 — the identity. Continuous over the whole dial (0/300 plateaus)
    'tune',       // 2 — largest raw authority, but a trim in practice
    'fine',       // 3
    'fmAmount',   // 4 — ENABLER for the `fm` port, and inert without it
    'pmAmount',   // 5 — ENABLER for the `pm` port, and inert without it
  ],

  pages: [
    { id: 'wave',  label: 'wave',  controls: ['wavePos'] },
    { id: 'pitch', label: 'pitch', controls: ['tune', 'fine'] },
    { id: 'mod',   label: 'modulation', controls: ['fmAmount', 'pmAmount'],
      clusters: [{ label: 'needs a cable', controls: ['fmAmount', 'pmAmount'] }] },
  ],

  // All five are FADERS on the card. `'fader'` is a ParamCellKind as of the
  // rings promotion — declare it or paramCellKind() silently returns 'knob'.
  paramCells: {
    wavePos: 'fader', tune: 'fader', fine: 'fader', fmAmount: 'fader', pmAmount: 'fader',
  },

  // A FREE-RUNNING oscillator — the analogVco case. #1420 suspends the
  // AudioContext in `bootWithFace` BEFORE the tile is framed, so the analyser
  // tap reads zeros and the compact scene pins deterministically. analogVco
  // measured 0 px frozen vs 394 px with the freeze off.
  glyph: 'scope',

  hero: {
    control: 'wavePos',
    readouts: [
      { label: 'frame', valueId: 'wt-frame' },
      { label: 'level', valueId: 'wt-level' },
      { label: 'alias', valueId: 'wt-alias' },
    ],
  },

  sidebar: [
    { kind: 'custom', label: 'the table', panelId: 'wavetable-frames',
      props: { paramId: 'wavePos', frameCount: 16 } },
    { kind: 'readouts', label: 'modulation', entries: [
      { label: 'FM',      valueId: 'wt-fm-depth' },
      { label: 'PM',      valueId: 'wt-pm-depth' },
      { label: 'WAVE CV', valueId: 'wt-wavecv-window' },
      { label: 'pitch',   valueId: 'wt-knob-hz' },
    ] },
    { kind: 'presets', label: 'the four shapes', entries: [
      { id: 'saw',  label: 'saw',      note: 'frame 0 · −4.77 dB',  values: { wavePos: 0 } },
      { id: 'sqr',  label: 'square',   note: 'frame 5 · 0.00 dB',   values: { wavePos: 1 / 3 } },
      { id: 'tri',  label: 'triangle', note: 'frame 10 · −4.77 dB', values: { wavePos: 2 / 3 } },
      { id: 'sine', label: 'sine',     note: 'frame 15 · −3.01 dB', values: { wavePos: 1 } },
      { id: 'fmwake', label: 'wake FM + PM', note: 'still needs the cables',
        values: { fmAmount: 0.5, pmAmount: 0.5, wavePos: 0.5 } },
    ] },
  ],
}
```

⚠ Everything load-bearing is in the three hero readouts, the four-line sidebar
`readouts` block, the four-shape presets and the picture — the surfaces that paint
unconditionally.

⚠ **The `saw`/`square`/`triangle`/`sine` presets are not decoration.** The four named
shapes sit at wavePos 0 / 0.3333 / 0.6667 / 1.0 and **no surface anywhere says so** —
a player hunting "square" by ear on a 0..1 fader is searching a continuum for a
point. Four clicks replaces that, through the ordinary param write path.

⚠ **`fmwake` is honest about its own limits.** It opens both amounts to 0.5 and sets
WAVE to 0.5; it CANNOT patch the cables, and the note says so. A preset labelled
"wake FM" that left the module bit-identical would be exactly the class of lie this
programme exists to remove.

---

## 6. DERIVED READOUTS

`FaceReadoutValue` is **params only**. Every entry below respects that; the two that
cannot be written under it are named in §6-F.

### A. `wt-frame` — where the scan is, and what is there

`frameFloat = wavePos × 15`, plus the shape the generator's own morph law puts there.
Prints `frame 7.5 · square → tri 50 %`.

- **NEGATIVE CONTROL — `tune`.** The frame is a function of `wavePos` alone; a
  readout that moved on TUNE would be reading the output, not the table.
- **SECOND LEG — it must NOT snap to the nearest named shape.** wavePos 0.3333 and
  0.35 must print *different* frames (5.00 vs 5.25) even though both sound like a
  square. Measured, they are different renders (`maxAbsDiff 5.00e-2`), so a readout
  that printed "square" for both would be flattening a continuous control.
  **0/300 adjacent pairs are bit-identical** — there is nothing to quantise to.

### B. `wt-level` — the 4.77 dB no meter can see

The rms of the interpolated frame at the current `wavePos`, in dB relative to full
scale, computed from the shipping table (§7 asks for it to be exported). Anchored:
−4.770 / −0.003 / −4.768 / −3.008 dB at the four canonical positions, all within
0.003 dB of the analytic crest factor.

- **NEGATIVE CONTROL — the PEAK.** Measured, `peak` is 0.9998–1.0000 across the
  entire dial. So a readout derived from peak is *constant* and useless here, and
  this one must differ from it by 4.77 dB at the extremes. That is the assertion:
  `wt-level` at wavePos 0 minus `wt-level` at 1/3 must be **4.77 ± 0.05 dB** while a
  peak reading of the same two states differs by under 0.001.
- **SECOND LEG — `tune`.** Level is frame-only; TUNE must not move it.

### C. `wt-alias` — a TWO-input derivation, which is what makes it honest

Prints the first aliased harmonic and the measured inharmonic fraction at the current
knob pitch AND the current frame: `h91 · 0.4 %` at the defaults, `h5 · 10.9 %` at
TUNE +36 with the pitch port at +2 V. Interpolated over §3-C's measured surface —
⚠ **labelled as measurement, not as a law**, since there is no closed form.

- **NEGATIVE CONTROL — `wavePos` to 1.0.** The sine frame measures **0.00 %
  inharmonic at every pitch tested up to 16.7 kHz**, so a readout that depended on
  pitch alone would print `39 %` for a pure sine. That is the failure this readout
  exists to avoid, and it is the same shape as macrooscillator's `macro-alias`:
  **aliasing is a property of the WAVEFORM and the pitch together.**
- **SECOND LEG — `tune`.** At a fixed saw frame it must climb 0.40 → 5.20 % from
  TUNE 0 to TUNE +36.
- ⚠ **It can only speak for the KNOB pitch.** With the `pitch` port patched the real
  fundamental is elsewhere and the reader cannot see it — the identical limitation
  `analogvco-knob-hz` carries. Label it `knob` in the caption.

### D. `wt-fm-depth` / `wt-pm-depth`

`wt-fm-depth`: `0.00 — the FM input is ignored` at the default; `±6.0 st at full
input` at `fmAmount 0.5`; `∓12.0 st (inverted)` at `fmAmount −1`. Derived from
`fmAmount·12` semitones (the DSP's own law), **with the SIGN spelled as a word
because that is exactly the half the card cannot reach today.**

`wt-pm-depth`: `0.00 — the PM input is ignored` / `±0.50 cycles`.

- **NEGATIVE CONTROL — `wavePos`.** Neither may move on a WAVE change.
- **SECOND LEG — the sign.** `fmAmount +0.5` and `−0.5` must print *different*
  strings, because measured they are genuinely different with an envelope (centroid
  1004 vs 541 Hz) even though they are identical with a sine.

### E. `wt-wavecv-window` — the clamp, in one line

`live cv −0.00 … +1.00 (50 %)` at the shipped knob; `−0.50 … +0.50 (50 %)` at knob
0.5. From `[−wavePos, 1 − wavePos]`.

- **NEGATIVE CONTROL — the WIDTH must never change.** Measured, the live fraction is
  50 / 51 / 50 / 51 / 50 % at knob 0 / 0.25 / 0.5 / 0.75 / 1. So a readout that made
  the window look wider in the middle would be wrong; what moves is the window's
  *position*, and at the shipped knob it sits entirely on one side. **Assert both:
  the width is invariant, the endpoints are not.**

### F. ⚠ TWO FACTS A `FaceReadout` CANNOT CARRY — AND WHERE THEY GO INSTEAD

`FaceReadoutValue` cannot see patch topology, the clock, or a port's live value. Two
of this module's most useful sentences fall outside it:

- **"is a cable patched into FM / PM?"** — a cable is a graph edge, and the shell's
  `readoutValue` reads `node.params`. §4-D measured that this is the single most
  consequential fact about the module at spawn (two params and two ports mutually
  inert), and it is the one thing the readout tier cannot say. **It goes in the
  `wavetable-frames` `custom` sidebar panel instead**, which *can* reach topology:
  `FilterResponsePanel.svelte:31` and `MeowboxFormantBankPanel.svelte:33` both
  `import { patch } from '$lib/graph/store'`, and `patch.edges` is a
  `Record<string, Edge>`. So the panel draws the FM and PM legs **greyed when no edge
  targets that port**, which is a stronger statement than any string.
- **"the actual playing pitch"** — needs the `pitch` port's live value, so §6-C's
  alias readout can only speak for the KNOB pitch.

⚠ **This is the fourth independent request to widen that reader** (analogVco and
macrooscillator both filed it; bluebox hit the same wall from the `face.momentary`
side). `engine.readParam` already returns *intrinsic + modulator tap*
(`engine.ts:737-747`), so a `{ read, readLive, sampleRate }` reader would close all
four at once. **The panel escape hatch works and should be used now; it should not be
mistaken for the fix**, because a `readouts` block is the right *shape* for a
one-line fact and a bespoke Svelte component is not.

---

## 7. THE PICTURE — `wavetable-frames`, and the model module it needs

A 16-frame waterfall: the frames drawn as a receding stack, the two frames the scan
currently sits between lit, and the **interpolated** waveform drawn solid in front.
Three things only this picture can say: **where the four named shapes are** (tick
marks at frames 0 / 5 / 10 / 15), **that the scan is continuous** between them, and,
because a panel can reach `patch.edges` (§6-F), **whether the WAVE POSITION CV, FM
and PM inputs actually have cables on them**, drawn as three greyed-or-lit legs.

To draw it, and to compute §6-A/§6-B, `generateBasicTable()` must leave the def.
**Recommend a `$lib/audio/wavetable-vco-table` model module** exporting `FRAME_SIZE`,
`FRAME_COUNT`, `generateBasicTable()` and a `frameRms(wavePos)`, imported by the def,
the card, the panel and the face model. That is the `vca-gain-model` /
`ringback-crush-model` pattern ("the ranges live in ONE model module the def AND the
card import"), and **it is also the natural place to fix §8-A so the card can never
disagree again.**

Per `sidebar-panels.ts`: the panel READS, it must never emit a `control-<paramId>`
testid, and it must resolve the def DEFAULT when `node.params` has no entry (the
crossover panel's `WIDTH 0%` bug).

---

## 8. ALREADY-WRONG

- **A · `WavetableVcoCard.svelte:36-37` contradicts the def on TWO bipolar params**
  (§0, §4-C). `min={0}` where `wavetable-vco.ts:116-117` says `min: -1`. **The
  backdraft class with the sign flipped — the card is *narrower* than the contract,
  so nothing clamps, nothing warns, and the feature is simply missing.** **Fix in the
  face PR: bind through `paramSpec()` and enrol `wavetableVco` in `RANGE_BOUND_CARDS`
  + `MAPPING_BOUND_CARDS`.** ⚠ **It is a card baseline move** — the two faders gain
  their negative halves, and **`wavetableVco` is in the REQUIRED `vrt-strict` set.
  Predict the diff and count the files the capture commits.**
- **B · The DSP's aliasing comment understates the measurement by an octave and a
  half** (§3-C): *"some aliasing above ~8 kHz fundamental"* against **5.20 % at
  2.09 kHz and 10.89 % at 4.19 kHz** on the saw frame. A comment edit; free (comments
  are out of every attest hash by design).
- **C · `docs.inputs.wavePos` overstates the CV** (§3-D): *"full-scale ±1 covers the
  whole table from the WAVE setting"*. Measured, **half of a ±1 modulator is clamped
  at EVERY knob position, and at the shipped knob of 0 it is the negative half.** A
  doc edit on an existing key — `module-docs-lint` accepts it.
- **D · The four canonical shapes are at un-guessable fader positions** (§3). Not a
  bug; a legibility hole the presets close.
- **E · No ART pin exists** (`ART_BACKLOG`, `profile-coverage.ts:114`). A face PR does
  not need one, but a module whose card is about to gain two half-dials (§8-A) is
  exactly when an audio regression pin is worth having. Its own PR.
- **F · Not in `PUSH_CARD_CONTROLS`**, so the push card is generic-tier over 5
  params. All five fit the 8-control card, so no re-rank risk today — but if the
  model module in §7 ever adds a param, give it an explicit entry.

---

## 9. COST

| | |
|---|---|
| **contract-lock** | **+0 lines.** No new param, port or family; the picture is a sidebar `custom` block and `face` is out of `contract-signature.ts`. §8-A changes no declared range (the DEF is already right), so it is 0 lines too. |
| **STRICT_DOCS** | already in it. No new keys; §8-C is an edit to an existing one. |
| **ART** | none — the module has no baseline (§8-E). |
| **VRT** | ⚠ **§8-A moves a REQUIRED baseline.** The `vrt-strict` lane holds `wavetableVco`, and widening two faders from `0..1` to `−1..1` changes the thumb position at the default (bottom of the track → middle) — a visible move, not a sub-tolerance one, so `--update-snapshots` will rewrite it rather than silently committing nothing. New face scenes: `face-wavetableVco-{compact,dock}` = **2 baselines**. |
| **e2e** | +1 `faces-parity` row, **5 cells**. ≈ +6 s. ⚠ Its `driveCell` arm enters the **`fader`** branch for all five, and `param-cell-coverage.test.ts`'s `UNEXERCISED_BY_FACES_PARITY` entry must be **deleted in the same PR** (that map ratchets in both directions: unlisted-and-unexercised and listed-and-exercised both fail). |
| **BLOCKER** | ✅ **CLEARED** — see §0. `'fader'` is a `ParamCellKind` on `main` and `rings` is the shipped precedent. |
| **the bottom line** | The only module in this batch with a live card-vs-def divergence, and it is the kind the whole gate set is blind to. It also has the batch's one genuinely clean control (WAVE, 0/300 plateaus) — **which the face should say plainly, because a programme that only ever reports defects trains people to distrust the ones that are real.** |
