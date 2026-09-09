# FACE SPEC — `featurecv` (batch 5)

## 0. PROVENANCE

Measured against `main` at `153e5c36` (2026-08-10). **BANKED — not built.**
⚠ The DSP is untouched since the module shipped (`packages/dsp/src/featurecv.ts`,
last functional change #937), so **§2 and §7-A are still open as written.**

**Verdict: PROMOTE — blocked on §7-A being ANSWERED (not necessarily fixed).
BRIGHT reads bit-identically for a 261 Hz SINE and a 261 Hz SAW, which is a
spectral impossibility for anything that measures spectrum.**

archetype: **the AUDIO → CV FEATURE EXTRACTOR** — one audio input, four CV/gate
outputs. Named in the memory `project_audio_to_cv_modules` as the head of that
family.

Not in `STRICT_FACES`; no `face:` block. In `STRICT_DOCS`; **not** in
`STRICT_VRT_MODULES`; **not** in `PUSH_CARD_CONTROLS`. 6 params, 1 in, 4 out
(`loud` cv, `bright` cv, `punch` cv, `onset` gate `edge=trigger`).

**Method.** REAL factory → REAL worklet (`packages/dsp/src/featurecv.ts`) under
`node-web-audio-api`'s `OfflineAudioContext`, 48 kHz. Two stimulus sets: a
4-burst-per-second decaying saw train (for the envelope controls) and **four
static sources of graded brightness** (for the positive control in §2).

---

## 1. WHAT THE FOUR OUTPUTS DO — measured on the burst train, defaults

| out | peak | rms dB | mean | reading |
|---|---|---|---|---|
| `loud` | 0.86010 | −4.85 | −0.495 | tracks the envelope |
| `bright` | 0.99278 | −0.21 | **−0.976** | pinned at its floor |
| `punch` | 0.83409 | −6.13 | **−0.434** | tracks the derivative |
| `onset` | 1.00000 | −18.45 | — | a trigger train |

⚠ **`bipolar` (default 1) means "no signal" is −1, not 0.** On a steady source
`punch` idles at **−0.83** and `bright` at **−0.95**. Two of four CV outputs sit
near their negative rail whenever nothing is happening, which is correct for a
bipolar mapping and is a large standing offset for a downstream destination that
expected 0. The face has to say which polarity is in force; the card cannot.

---

## 2. THE FINDING — BRIGHT cannot tell a SINE from a SAW

*Measured*, four sources at the same fundamental or the same bandwidth, mean of
the settled output:

| source | `bright` (bipolar 1) | `bright` (bipolar 0) | `loud` | `punch` |
|---|---|---|---|---|
| **sine 261 Hz** | **−0.9544** | **0.0228** | 0.9885 | −0.8318 |
| **saw 261 Hz** | **−0.9544** | **0.0228** | 0.6485 | −0.6919 |
| sine 6 kHz | 0.0008 | 0.5004 | 0.9799 | −0.8339 |
| white noise | 0.9954 | 0.9977 | 1.0000 | −0.7016 |

**A 261 Hz sine has one partial. A 261 Hz saw has hundreds. BRIGHT reads
identically — to four decimal places, in both polarity modes.** Meanwhile
`loud` correctly separates them (0.9885 vs 0.6485 — a saw's RMS at the same
amplitude is lower) and `punch` separates them too (−0.83 vs −0.69), so the
probe is demonstrably not blind.

The ladder that *does* move BRIGHT is **fundamental frequency**: 261 Hz → −0.954,
6 kHz → 0.001, white noise → 0.995. **BRIGHT is behaving as a pitch/energy-centre
tracker, not a timbre descriptor.** Whether that is a bug or an
under-documented design choice is §7-A — but a faceplate must not label it
"brightness" while it reports pitch, and the CV a patch is steering with it is
not the CV the panel promises.

**INSTRUMENT NOTE.** The first pass measured only the burst train and read
`bright` "pinned at −0.976" — a plausible "the control is broken" conclusion off
one stimulus. **A single-source probe cannot tell "pinned" from "correct for this
source".** The four-source ladder is a *positive* control (a known magnitude
ordering: sine < saw ≈ sine < 6 kHz sine < noise) and it is the only reason the
finding is stateable.

---

## 3. THE SIX CONTROLS, MEASURED

| param | range | measured |
|---|---|---|
| `gain` | 0.25..4 log | moves **`loud` and `onset` only**. `bright` and `punch` are **`Δ = 0.00e+0`** across the whole range. |
| `attack` | 0.5..500 ms log | strong on `loud` (−5.59 → −0.52 dB) and `punch` (−6.54 → −0.59); **0.20 dB on `bright`**; `Δ = 0.00e+0` on `onset`. |
| `release` | 1..2000 ms log | strong on `loud` (−0.80 → −18.92 dB) and `punch`; 0.31 dB on `bright`; `Δ = 0.00e+0` on `onset`. |
| `bipolar` | 0/1 discrete | rescales `loud`, `bright`, `punch`; `Δ = 0.00e+0` on `onset`. |
| `onset_sens` | 0..1 linear | `Δ = 0.00e+0` on all three CV outs; on `onset`, **0 differs from 0.25, and 0.25 / 0.5 / 0.75 / 1.0 are all −18.45 dB** — i.e. the top 75 % of the fader produced the identical trigger train on this source. |
| `onset_debounce` | 20..1000 ms log | the strongest onset control: 20 ms → −15.44 dB (more triggers), 80 → −18.45, 376 → −21.46, **1000 → −240.00 dB (bit-silent)**. |

**Two structural facts fall out.** *(i)* **`gain` is a `loud`/`onset` trim, not an
input gain** — it is bit-exactly invisible to two of four outputs. *(ii)* **the
top of `onset_debounce` silences the ONSET output entirely** for any source
faster than 1 Hz: at 1000 ms with a 4 Hz burst train, zero triggers reach the
settled window.

---

## 4. THE RANKING

| rank | key | tier | why |
|---|---|---|---|
| 1 | `bipolar` | mini | it is the only control that changes **what every output's zero means**, and there is no other way to know. |
| 2 | `release` | compact | the largest measured travel on `loud`/`punch` (18.1 dB). |
| 3 | `attack` | plate | 5.1 dB on `loud`, 6.0 on `punch`. |
| 4 | `onset_debounce` | plate | owns `onset`, and silences it at the top. |
| 5 | `gain` | plate | **ranked 5, not 1**, because it is measured invisible to half the module. |
| 6 | `onset_sens` | plate | the weakest measured control on the module. |
| 7 | `featurecv-meters-{n}` | dock (panel) | the picture — §6. |

⚠ **`bipolar` at rank 1 is the argument.** It is a two-position switch and the
least "performable" thing here, and it still ranks first because a CV utility's
lane tile has exactly one job: tell you what is coming out of the jacks. A
`0..1` vs `−1..+1` mapping changes every one of the four numbers, and the
measured idle values (−0.95, −0.83) are far from zero.

**NO AUDITION.** An extractor with nothing to strike.

---

## 5. THE FACE

```ts
// ⚠ NO `title`, NO `hint` — owner no-prose ruling, 2026-08-11. The two facts a
// draft would have put there are load-bearing, so they move into a band HINT
// and the sidebar `text` entries below, which paint without annotations.
face: {
  order: [
    'bipolar', 'release', 'attack', 'onset_debounce', 'gain', 'onset_sens',
    'featurecv-meters-{n}',   // PANEL, rank 7 — the FIRST legal rank for a panel
  ],

  pages: [
    { id: 'env', label: 'envelope followers',
      hint: 'ATTACK / RELEASE shape LOUD and PUNCH; BRIGHT barely moves',
      controls: ['attack', 'release', 'gain', 'featurecv-meters-{n}'] },
    { id: 'onset', label: 'onset trigger',
      hint: 'DEBOUNCE 1000 ms emits nothing above 1 Hz',
      controls: ['onset_sens', 'onset_debounce'] },
    { id: 'range', label: 'output range',
      hint: 'BIPOLAR: idle is -1, not 0',
      controls: ['bipolar'] },
  ],

  glyph: 'meter',
  hero: {
    cell: 'featurecv-meters-{n}',
    control: 'release',
    readouts: [
      { label: 'range',  valueId: 'featurecv-range' },
      { label: 'idle',   valueId: 'featurecv-idle-cv' },
      { label: 'gain to', valueId: 'featurecv-gain-scope' },
    ],
  },

  sidebar: [
    { kind: 'readouts', label: 'what each jack carries', entries: [
      { label: 'LOUD',   text: 'envelope — GAIN applies' },
      { label: 'BRIGHT', text: 'tracks PITCH, not partials (measured)' },
      { label: 'PUNCH',  text: 'derivative — GAIN does NOT apply' },
      { label: 'ONSET',  text: 'trigger — DEBOUNCE owns it' },
    ] },
  ],
}
```

⚠ **`glyph: 'meter'`, and it needs a stated source.** `primaryAudioOutPortId`
picks the first **audio** output in declaration order — **featurecv has NONE**
(all four outputs are `cv`/`gate`). This is the `drumseqz` case from batch 4, and
the honest options are `glyph: 'none'` or a platform change that lets a face
declare its glyph source. **Written here as `'meter'` on the assumption the
platform gains a declared source; if it does not, ship `'none'` and let the hero
panel carry the picture.** Do not ship a glyph that silently taps nothing.

⚠ **THREE bands** — under `DOCK_TAB_MIN_BANDS` (7), so hints render, and PF-21
packs 4 + 2 + 1 = 7 cells onto one row.

⚠ **Band-label budget**: `'output range'` (12) and `'onset trigger'` (13) are
safe. The hint `'ATTACK / RELEASE shape LOUD and PUNCH; BRIGHT barely moves'` is
**56 characters** — fallback **30**: `'shapes LOUD + PUNCH only'`.

---

## 6. DERIVED READOUTS + THE PICTURE

### A. `featurecv-idle-cv` — the standing offset

Prints what the jacks read with **no input**: `−1.00 V` in bipolar, `0.00 V` in
unipolar. Anchored on the measured idle means (−0.954 `bright`, −0.832 `punch` on
a steady tone). **NEGATIVE CONTROL — `release`:** must not move it. **SECOND —
`bipolar`:** must be the only input, and must flip the sign class.

### B. `featurecv-gain-scope` — the one that pays for the module

Prints **`LOUD + ONSET`** — literally, which outputs GAIN reaches — because the
measurement says two of four are `Δ = 0.00e+0` across the whole 0.25..4 range.
**NEGATIVE CONTROL — `gain` itself:** the readout must be *invariant* to the gain
value (it names a routing, not a level), while `featurecv-idle-cv` moves with
`bipolar` and this one does not. Publishing both is the pair's own control.

### C. `featurecv-range` — `0..1` / `−1..+1`

Trivial, and it is the label the four jacks do not have.

### D. THE PICTURE — four live meters in the HERO

One horizontal meter per output, **drawn on the current polarity's scale** with
the zero mark where the polarity puts it, and BRIGHT annotated with what it
actually tracks. Rank 7 is a panel's first legal rank and this face has exactly
6 params, so rank 7 is reachable **by one.**

---

## 7. ALREADY-WRONG

- **A · BLOCKER (to answer, not necessarily to fix): BRIGHT is bit-identical for
  a sine and a saw at 261 Hz** (§2), while separating 261 Hz / 6 kHz / noise
  cleanly. Either the extractor is measuring a spectral *centre of energy* that
  a naive saw does not move (possible, and then the **name and the doc** are
  wrong), or it is measuring pitch (and then the **output** is wrong). **A face
  cannot label this jack until someone says which.** Its own investigation, ahead
  of the face.
- **B · `gain` is bit-exactly invisible to `bright` and `punch`** (§3). Its doc
  should say so; `featurecv` is in `STRICT_DOCS`.
- **C · `onset_debounce = 1000 ms` bit-silences the ONSET output** (§3) for any
  source above 1 Hz. Correct by construction; undocumented, and it is the top of
  the fader.
- **D · the top 75 % of `onset_sens` produced an identical trigger train** on the
  4 Hz burst source (§3). Measured on ONE source — marked **NOT DETERMINED** as a
  general claim; a source with graded transient sizes is the right probe and was
  not run.
- **E · `FeaturecvCard.svelte` re-types 10 literal range props**; `featurecv` is
  **not** in `RANGE_BOUND_CARDS`.
- **F · the module has no audio output**, so the shell glyph has nothing to tap
  (§5). The `noise` white-tap finding, a third time.

---

## 8. THE ORDER OF WORK

⚠ **`featurecv` HAS an ART scenario and four pinned baselines**
(`art/scenarios/featurecv/feature-extract.test.ts`,
`art/baselines/featurecv/{noise-bright,ramp-loud,sine-punch,transient-onset}.f32`).
If §7-A resolves as a DSP fix it **re-pins `noise-bright` at minimum** —
`task art:update`, which chains the fingerprint manifest, plus an owner audition.

**Build the face AFTER §7-A gets an answer**, because the hero picture labels the
BRIGHT jack and the face cannot name a quantity nobody has decided the meaning of.
