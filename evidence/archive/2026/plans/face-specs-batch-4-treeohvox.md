# FACE SPEC — `treeohvox` (batch 4)

## 0. PROVENANCE

Measured against `main` at `ecc48f2e` (2026-08-09). **BANKED — not built.**

**Verdict: PROMOTE.** archetype: **monophonic gated VOICE with a filter-envelope
character** (the acid-bass family; nothing else in the rack is a 303).

Not in `STRICT_FACES`; no `face:` block. In `STRICT_DOCS`; **not** in
`STRICT_VRT_MODULES`. 7 params, 10 in, 1 out.

**Method.** `packages/dsp/src/treeohvox.ts` bundled with esbuild against stub
worklet globals and run offline at 48 kHz in 128-sample blocks — the shipping
worklet. Note gate on `gate_in` at t = 0.05 s. Spectral figures are Hann-windowed
Goertzel; the peak-find was negative-controlled against synthetic sines
(≤0.25 cents error) before any pitch claim below.

---

## 1. WHAT IT ACTUALLY DOES

A polyBLEP saw↔square oscillator into a **diode-feedback TB-303 ladder**
(`packages/dsp/src/lib/treeohvox-dsp.ts:117-250`), with a decay envelope on the
cutoff and an AR amp envelope. Two things about it are not obvious from the panel,
and both are *mappings*, not bugs:

1. **RESONANCE is exponentially skewed.** `resonanceSkew(r) = (1 − e^(−3r)) / (1 − e^(−3))`
   (`treeohvox-dsp.ts:150-153`). The knob is not the filter's resonance; it is a
   heavily compressed pre-image of it.
2. **CUTOFF's floor is a shared constant, already guarded.** `TB303_CUTOFF_FLOOR_HZ = 40`
   / `TB303_CUTOFF_CEILING_HZ = 6000` (`:145-148`) are read by the def, the AudioParam
   descriptor and the ladder, joined by `treeohvox-range-source.test.ts` — which exists
   because the def once offered 40 Hz while the ladder clamped at 200 and **the bottom
   ~25 % of the knob was bit-exactly dead.** That defect is fixed; the guard is the
   repo's best existing example of the two-sided-contract rule.

---

## 2. THE CONTROLS THAT MATTER — 7 params, and the lane cut

| rank | control | why |
|---|---|---|
| 1 | `cutoff` | the timbre control, and the one whose bottom quarter is a **22 dB level fade** rather than a filter move (§4-C). |
| 2 | `resonance` | ranked 2 because **91 % of what it does happens in the bottom quarter of its travel** (§4-A) and the shipped default already sits at effective 0.818. |
| 3 | `envelope` | env-mod depth. Real and clean: centroid at note-on 289 → 884 Hz across the travel (§4-D). |
| 4 | `decay` | the filter sweep time. Real: centroid at t = 70 ms runs 304 → 1091 Hz over 50 ms → 3 s. |
| 5 | `accent` | the 303's signature, and the control that pushes the module **over full scale** (§4-B). |
| 6 | `treeohvox-note-{n}` | **THE AUDITION.** Rank 6 = the last lane slot. Measured: **peak exactly 0.000e+0** with no gate — this voice cannot be heard from the UI at all today (§3, §7-A). |
| 7 | `waveform` | dock-only. Measured **textbook-exact** (§4-E) — the one control on the module with nothing to warn about, which is precisely why it does not need lane space. |
| 8 | `tune` | last. ±12 st setup offset; pitch accuracy is 0.0 cents everywhere (§4-F). |

**LOSERS, with the reason each lost:**
- **`waveform` loses to the audition** despite being the most *fun* control, because
  it is also the only one that behaves exactly as documented. Lane slots are for the
  controls that surprise you.
- **`tune` is last** by the standing rule for setup offsets, and because `pitch_in`
  is how this module is actually played.

---

## 3. INERT AT SPAWN — absolutely, and there is no way to play it from the UI

No gate, nothing patched: **output peak = 0.000e+0** over a 1 s render. There is no
free-run, no drone, no noise floor. `TreeohvoxCard.svelte` is seven faders and a
PatchPanel — **no play button, no note pad.** So a user who spawns TREE.oh.VOX and
sweeps every control hears silence until they patch a gate source.

That is the karplus/sixstrum complaint, and on the module most likely to be spawned
as "let me hear what this is".

---

## 4. WHAT THE FACE MUST MAKE VISIBLE — six measured facts

### A. RESONANCE: 91 % of its effect is in the bottom quarter, and the bottom TENTH is a 14 dB level cliff

The exponential skew, tabulated from `resonanceSkew`:

| knob | 0.00 | 0.05 | 0.10 | 0.25 | 0.50 | 0.75 | 1.00 |
|---|---|---|---|---|---|---|---|
| **effective resonance** | 0.0000 | 0.1466 | 0.2728 | **0.5553** | **0.8176** | 0.9415 | 1.0000 |

**The bottom quarter of the dial spans 55.5 % of the effective range; the top HALF
spans 18.2 %.** The shipped default of 0.5 is already 82 % of the way up.

*Measured* output RMS per quarter (defaults otherwise, 0.4 s gate):

| knob quarter | 0 → 0.25 | 0.25 → 0.5 | 0.5 → 0.75 | 0.75 → 1.0 |
|---|---|---|---|---|
| ΔRMS | **−10.20 dB** | +0.09 | +0.82 | +0.90 |

And the very bottom is a cliff, not a taper — fine sweep at the defaults:

| knob | 0 | 0.001 | 0.005 | 0.01 | 0.02 | 0.05 | 0.1 |
|---|---|---|---|---|---|---|---|
| RMS | **−14.10 dB** | −14.35 | −15.27 | −16.23 | −17.72 | −20.41 | −22.52 |
| peak | **0.8514** | 0.8131 | 0.7098 | 0.6201 | 0.5095 | 0.3632 | 0.2949 |

At `cutoff 6000, envelope 0` the same corner **clips**: RESONANCE 0 measures **peak
1.0226**. So the first 10 % of a control labelled "Reso" is a **13.9 dB volume fader**
that can push the module past full scale.

This is the ladder's feedback-gain structure (`k = k·r`, `treeohvox-dsp.ts:202`) with
no makeup compensation — **faithful to Open303, and invisible on the panel.** A face
that shows the *effective* resonance beside the knob turns an unusable-looking dial
into a legible one.

⚠ **NOT a DSP change for this wave.** Adding makeup gain would alter every existing
patch and the pinned ART baselines. The face's job is to *show* the mapping.

### B. ACCENT pushes the module over full scale — 33 of 144 corners exceed 0 dBFS

Sweeping `cutoff ∈ {200, 1k, 3k, 6k} × resonance ∈ {0, .5, 1} × envelope ∈ {0, .5, 1} ×
accent-knob ∈ {0, 1} × accent-gate ∈ {0, 1}`:

- **33 / 144 corners peak above 1.0.**
- worst: **peak 2.1626 = +6.70 dBFS**, at `cutoff 3000, resonance 0, envelope 0.5,
  accent 1, accent gate high`.
- at the **shipped defaults with an accent gate**: peak 0.5197 (−5.69 dBFS) — safe.

There is **no output limiter** on this module. A sequencer's accent lane can therefore
take a patch from −5.7 dBFS to +6.7 dBFS with no control moving. The ACCENT knob's own
contribution is measured and modest: +0 / +1.86 / +3.35 / +4.61 / **+5.69 dB** of RMS
at knob 0 / 0.25 / 0.5 / 0.75 / 1.0 — it is the *interaction* with a low RESONANCE
that gets to +6.7 dBFS.

### C. CUTOFF's bottom quarter is a 22 dB fade, and the docs half-say so

*Measured* at `envelope 0`:

| cutoff Hz | 40 | 60 | 100 | 150 | 200 | 300 | 1000 | 6000 |
|---|---|---|---|---|---|---|---|---|
| RMS | **−46.06 dB** | −44.64 | −39.79 | −30.46 | −24.51 | −24.94 | −23.85 | −25.01 |

From 200 Hz to 6 kHz the level is flat within 1.2 dB; below 200 Hz it falls off a
cliff, 22 dB by 40 Hz. `docs.controls.cutoff` says "The WHOLE travel is live — the
bottom of the knob really does reach a 40 Hz corner, which with EnvMod low is a
near-sub-audible thump", which is *true* and is the residue of the fixed dead-range
defect — but "near-sub-audible thump" is doing a lot of work for **−46 dBFS**. The face
should print the number.

### D. ENVELOPE and DECAY both work, and both are invisible in the level

Neither moves RMS by as much as 1 dB, so a meter tells you nothing about either.
*Measured* spectral centroid (harmonic-weighted, over 120 partials):

| `envelope` (cutoff 200, decay 600) | 0 | 0.25 | 0.5 | 0.75 | 1 |
|---|---|---|---|---|---|
| centroid at t = 70 ms | 289 Hz | 366 | 482 | 651 | **884** |
| centroid at t = 800 ms | 282 Hz | 282 | 282 | 282 | 282 |

| `decay` (cutoff 200, envelope 1) | 50 ms | 200 | 600 | 1500 | 3000 |
|---|---|---|---|---|---|
| centroid at 70 / 350 / 1000 ms | 304 / 278 / 278 | 587 / 281 / 278 | 884 / 415 / 282 | 1033 / 683 / 361 | **1091 / 874 / 579** |

Both are exactly what they claim to be. **The point for the face is that the module's
whole character lives in a quantity no meter and no knob readback can show** — which
is what a hero picture and a derived readout are for.

### E. WAVEFORM is textbook-exact — a measured NON-defect worth stating

`docs.controls.waveform` claims the morph is "monotone — the fundamental only ever
gets stronger … no dead spot or octave jump anywhere in the travel." *Measured* at
`cutoff 6000, envelope 0`:

| waveform | 0.0 | 0.5 | 0.9 | 0.99 | 0.995 | 1.0 |
|---|---|---|---|---|---|---|
| h1 | 51.03 | 54.56 | 56.61 | 57.01 | 57.03 | **57.05** |
| h2 | 44.15 | 38.13 | 24.15 | 4.15 | −1.87 | **−74.25** |

h1 rises monotonically by exactly **6.02 dB** end to end — which is `20·log10(2)`, the
exact ratio of a square's fundamental (4/π) to a saw's (2/π). h2 follows
`h2(0) + 20·log10(1 − w)` to two decimals at every point (−40.00 dB predicted at
w = 0.99, −46.02 at 0.995; measured −40.00 and −46.02). At w = 1 the even harmonics are
mathematically zero and read the numerical floor. **The doc is correct and the
implementation is exact.** No action; stated because "we checked and it is fine" is a
finding, and because a face that warns about everything teaches nothing.

### F. Pitch accuracy is 0.0 cents, everywhere tested

`tune −12 / 0 / +12` at `pitch_in` 0 V and `pitch_in −1 / 0 / +1 / +2 V`: **0.0 cents**
on all six, against a peak-find validated to 0.25 cents on synthetic sines. Another
measured non-defect.

### G. Gate handling is correct, including the release

Note length follows the gate exactly — T60 66 / 105 / 254 / 555 / 1055 / **2054 ms**
for gates of 0.01 / 0.05 / 0.2 / 0.5 / 1.0 / **2.0 s**. Held at 3 s the amp envelope
decays continuously (−19.73 dB at 0.1 s → −27.50 at 1.2 s → −38.34 at 2.9 s) rather
than dying at a fixed point; `docs.inputs.gate_in`'s "if you hold the gate longer than
the 303's fixed VCA decay (~1.2 s) the note fades out under you" is directionally right
but loose — at 1.2 s it is only **7.8 dB down** and it is still clearly audible at 2.9 s.
Worth tightening the prose; not a bug.

**And the release does not click.** Largest sample-to-sample step during the note:
**8.498e-2**; largest step anywhere around gate release: **2.920e-2**, i.e. *smaller*
than the ordinary steps. Amplitude at the release instant 0.01295, decaying to digital
zero over ~13 ms. A checked non-defect.

---

## 5. THE FACE

```ts
// ⚠ NO `title`, NO `hint` — owner no-prose ruling, 2026-08-11. The skew, the
// cliff and the missing limiter belong in `docs`, which right-click → annotate
// reads; the band LABELS below are what paints unconditionally.
face: {
  order: [
    'cutoff', 'resonance', 'envelope', 'decay', 'accent', 'treeohvox-note-{n}',  // 1-6 = the lane budget
    'treeohvox-sweep-{n}',                                                        // panel: first legal rank is 7
    'waveform', 'tune',
  ],
  pages: [
    { id: 'filter', label: '1 · the ladder',
      hint: 'CUTOFF is flat in level from 200 Hz up and falls 22 dB below it (−46 dBFS at 40 Hz). ' +
            'RESONANCE is (1 − e^−3r)/(1 − e^−3): knob 0.5 is already effective 0.818, and knob 0 ' +
            'is 14 dB LOUDER than knob 0.1 — that cliff is the ladder’s feedback gain, not a control.',
      controls: ['cutoff', 'resonance'] },
    { id: 'sweep', label: '2 · the sweep — neither of these shows on a meter',
      hint: 'ENVELOPE sets how far the cutoff jumps at note-on (centroid 289 → 884 Hz across the ' +
            'travel); DECAY sets how fast it falls back (centroid at 70 ms runs 304 → 1091 Hz over ' +
            '50 ms → 3 s). Both move output RMS by less than 1 dB.',
      controls: ['treeohvox-sweep-{n}', 'envelope', 'decay'] },
    { id: 'note',  label: '3 · the note',
      hint: 'GATE length is note length; the falling edge ends it and the release does not click. ' +
            'ACCENT is latched at the gate edge. Nothing limits the output: 33 of 144 measured ' +
            'control corners peak above full scale, worst +6.70 dBFS.',
      controls: ['treeohvox-note-{n}', 'accent', 'tune'] },
    { id: 'osc',   label: 'oscillator',
      hint: 'An exact saw↔square crossfade: the fundamental rises by exactly 6.02 dB end to end and ' +
            'the even harmonics follow 20·log10(1 − WAVE). No dead spot anywhere.',
      controls: ['waveform'] },
  ],
  glyph: 'scope',

  hero: {
    cell:    'treeohvox-sweep-{n}',
    control: 'cutoff',
    action:  'treeohvox-note-{n}',
    readouts: [
      { label: 'reso',      valueId: 'treeohvox-effective-reso' },
      { label: 'sweep top', valueId: 'treeohvox-sweep-top-hz' },
      { label: 'headroom',  valueId: 'treeohvox-headroom-db' },
    ],
  },

  // ⚠ THE `signal-flow` BLOCK THIS DRAFT CARRIED IS GONE — the KIND was deleted
  // (#1468, owner ruling): twelve modules declared hand-authored stage lists and
  // nothing verified any of them against the DSP. A chain picture must be
  // DERIVED from something the build can check, or it must not exist.
  sidebar: [
    { kind: 'presets', label: 'presets', entries: [
      /* classic squelch · dub sub · devil-fish long sweep · square lead —
         each pinned to a measured centroid + peak, so a preset is a claim. */
    ] },
  ],
}
```

**Why band 2 exists at all.** ENVELOPE and DECAY could sit with CUTOFF — they all
address the same filter. They are separate because §4-D is the module's real secret:
**the two controls that define an acid line are invisible to every meter in the rack.**
A band whose LABEL says that (`2 · the sweep — neither of these shows on a meter`) is
the whole finding delivered with the annotation switch OFF.

⚠ That label is 42 characters — **longer than the rings label this spec already flags**,
and label clipping is invisible to `faces-parity` (`toHaveText` reads `textContent`).
**Measure it in the dock before building.** Fallback that keeps the point:
`2 · the sweep — no meter sees this`.

⚠ Band **hints** are dock-only and a TABBED face renders none; four bands is under
`DOCK_TAB_MIN_BANDS = 7`, so they render here. Every fact that must survive
regardless is in a band LABEL or a readout.

⚠ `treeohvox-sweep-{n}` is rank 7 because `faceTierCap('full')` is 6 and a PANEL cell
cannot be selected at a lane tier. Nine keys total, so rank 7 is inside the roster.

---

## 6. DERIVED READOUTS

### A. `treeohvox-effective-reso` — the number the knob refuses to show

```
effective = (1 − exp(−3·resonance)) / (1 − exp(−3))
```
**NEGATIVE CONTROL — the knob itself.** A `paramId: 'resonance'` readout prints
`0.50`; the derived one prints **0.818**, and at knob 0.25 it prints 0.555 where the
knob says a quarter. **SECOND CONTROL — `res_cv`:** a knob readback is blind to a
CV-displaced resonance entirely, and this is the control most likely to be modulated.
**THIRD, and the one that makes it honest — print the LEVEL leg too:** the readout must
move when the effective resonance crosses ~0.15 (knob 0.05), because that is where the
14 dB cliff is. A derivation that prints only the skew is correct and still lets a
player walk into the cliff.

### B. `treeohvox-sweep-top-hz` — where the filter actually opens to at note-on

```
top_hz ≈ cutoff · f(envelope)     # env-mod scaler, Open303 calculateEnvModScalerAndOffset
```
*Measured anchor points* (cutoff 200, decay 600, centroid at t = 70 ms): env 0 →
289 Hz, 0.25 → 366, 0.5 → 482, 0.75 → 651, 1.0 → 884.
**NEGATIVE CONTROL — `decay`.** The top of the sweep must be **invariant** to DECAY
(measured: decay only changes how fast it comes back — centroid at 70 ms rises with
decay only because a 50 ms envelope has already collapsed by then, so probe at
t = 5 ms, not 70 ms, and confirm the number stops moving). **SECOND CONTROL —
`cutoff`:** it must scale with it. A readout that moves with only one of the two is
reading the wrong quantity.
⚠ **State the units in the label** (`Hz`, and *sweep top*, not *cutoff*) — this is the
exact confusion §4-D exists to prevent.

### C. `treeohvox-headroom-db` — the one readout that is a warning

`20·log10(1 / predicted_peak)` from the measured corner grid, printed **red at ≤ 0 dB**.
**NEGATIVE CONTROL — `accent` gate.** At the shipped defaults it reads +5.7 dB with the
gate low and must move when the gate goes high (measured peak 0.3416 → 0.5197).
**SECOND CONTROL — `resonance`:** it must get WORSE as resonance goes DOWN
(peak 0.3416 at 0.5 → 0.8514 at 0), which is the counter-intuitive direction and the
whole reason to print it.
⚠ This readout needs the live AudioParam values (`readLive`) to be worth anything,
because `accent_cv` and `res_cv` are exactly the paths that get automated.
`FaceReadoutValue` is params-only today — **until the widened reader lands, label it
`knob headroom`.**

---

## 7. THE BESPOKE CELL, AND WHAT MUST SHIP WITH IT

**LEGITIMATE — `treeohvox-sweep-{n}`: the filter-envelope sweep, drawn.** Cutoff on a
log axis against time: the resting corner, the note-on peak (`envelope`), the decay
curve back down (`decay`), the ladder's resonant peak height (effective resonance) and
a dashed accent trace showing where the ACCENT gate puts all three. Every number in §4-A
and §4-D becomes a picture, and it is the one thing def introspection cannot synthesise.

### 7-A. ⚠ THE AUDITION NEEDS A FACTORY SEAM — and it needs the GATE shape, not the trigger one

Like rings, `gate_in` is worklet INPUT 1 (`treeohvox.ts:186`), not a param, so an
`action` cell must reach the engine through a `read()` key the handle does not have.
**Unlike rings, the correct shape here is a HELD gate, not a pulse**, because on this
module gate length *is* note length (§4-G) — a `fireTrigger` pulse would audition a
10 ms blip and teach the wrong thing. `shell-cells.ts` already carries both edge shapes
(`fireManualStrike` for a pulse, the held form for snaredrum's ROLL); this face wants
the held one, with a sensible default note length.

Scope, same PR as the face:
1. factory: a host-side `ConstantSource` on input 1 + `read('manualGate')` returning
   press/release callables;
2. `SHELL_CELLS`: a `mode:'gate'` action with
   `probe: { effect: { kind: 'audition', seam: 'manual-strike' } }`;
3. a bespoke spec with a before/after negative control on the audition ledger.

**`ShellActionCell.probe` is required** and `faces-parity`'s `toBeEnabled()` + `click()`
cannot see a dead audition — that is the sixstrum defect, verbatim.

---

## 8. ALREADY-WRONG

- **A · RESONANCE 0 clips.** Measured **peak 1.0226** at `resonance 0, cutoff 6000,
  envelope 0` with everything else default and no accent — a bare note, over full
  scale. §4-A. **Its own PR** (a makeup-gain change moves every pinned baseline).
- **B · 33 of 144 control corners exceed full scale, worst +6.70 dBFS.** §4-B. There is
  no limiter. This and A are the same underlying gap — the module has no output stage.
- **C · the card re-types every range as a literal.** `TreeohvoxCard.svelte:65-144`:
  `min={-12} max={12}`, `min={40} max={6000}`, `min={50} max={3000}` … seven times.
  ⚠ **Especially bad here**, because `treeohvox-range-source.test.ts` exists *precisely*
  to keep the CUTOFF numbers in one place — and it joins the **def, the AudioParam
  descriptor and the DSP constant**, three of the four sides, while the **card** re-types
  `40` and `6000` a fourth time, unguarded. `treeohvox` is not in `RANGE_BOUND_CARDS`.
  **Enroll it and convert to `paramSpec()`.**
- **D · `docs.inputs.gate_in`'s "~1.2 s and the note fades out under you" is loose.**
  Measured: 7.8 dB down at 1.2 s, still audible at 2.9 s, no fixed fade point. §4-G.
  In `STRICT_DOCS`.
- **E · `docs.controls.resonance` — "low for a round bass, high for the whistling 303
  squelch"** — describes a linear control. Measured, knob 0.5 is already effective 0.818
  and the top half of the dial is 18 % of the range. §4-A. In `STRICT_DOCS`.
- **F · `docs.controls.cutoff`'s "near-sub-audible thump"** is **−46.06 dBFS**. §4-C.
- **No dead controls.** All seven params measurably move the output, and the one former
  dead range (CUTOFF below 200 Hz) is fixed and guarded.

---

## 9. WHAT THE BUILD MUST KEEP SEPARATE

- **`art/scenarios/treeohvox/voice-character.test.ts` + `art/baselines/treeohvox/`
  both exist.** §8-A/B are real audio changes and each needs `task art:update`
  plus an owner audition — **keep them out of the face PR.**
- **The audition factory seam (§7-A) is ~25 lines and is NOT a DSP change** — no
  ART re-pin, no attest. It ships in the SAME PR as the face, because a face that
  ranks an audition it cannot deliver is the sixstrum defect.
- The compact `scope` glyph captures on a silent graph (§3), so #1420's
  pre-frame `AudioContext` freeze covers it.
