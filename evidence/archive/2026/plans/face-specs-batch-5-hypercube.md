# hypercube — the module is GONE; this file survives for one lesson and two numbers

**The `hypercube` MODULE was deleted wholesale on 2026-08-10 (#1448): no def, no card, no DSP.**
Every item in this spec's §7 ledger is moot and unverifiable. Nothing here is actionable.

⚠ **Do not re-open this by grep.** The surviving `hypercube()` in
`packages/web/src/lib/video/primitives.ts:191` is an **unrelated tesseract MESH PRIMITIVE** for the
toybox OBJ layer (16 vertices in 4D, perspective-projected 4D→3D, 32 edges as triangulated tubes).
It has nothing to do with the audio module. The other surviving mentions are the same primitive's
consumers plus a historical note at `packages/web/src/lib/audio/worklet-guard.test.ts:330`
("8→7 (2026-08-10): hypercube.ts was DELETED with the module").

---

## THE LESSON — the section title was the finding

> ### 1 · THE INSTRUMENT HAD TO BE REBUILT TWICE, AND BOTH FAILURES ARE THE FINDING

**Failure 1 — `max|Δ|` was unusable on this module.** A first pass read `Δ = 8.45e-1` for `alpha`
at 0.25 / 0.5 / 0.75 / 1 — the *same* number at all four, with `acRms` identical to six decimals. A
"big effect" that does not grow with the control is the tell, and a determinism control settled it.

**Failure 2 — RMS alone was not enough either.** RMS is blind to timbre, so "no change in RMS"
proves nothing on a wavetable oscillator. The instrument that settles it is **phase-invariant and
spectrum-sensitive**: rms to 8 s.f., peak to 6 d.p., Hann-windowed spectral centroid to 0.1 Hz, and
five log-band energies to 0.01 dB.

## THE VERDICT SHAPE — BLOCKED on a question it refused to answer from a possibly-broken harness

> **I cannot yet distinguish "dead controls" from "my harness never loaded the fourth wavetable",
> and the difference decides whether this is a face PR or a P1 bug.**

The honest form it was filed in: *"With the tables this harness delivered, ALPHA and MORPH_FC are
identical in every phase-invariant statistic. Whether that is the module or the harness is NOT
DETERMINED."* Putting a live-looking dial on a possibly-dead control is the precise defect
`macrooscillator`'s face was built to avoid — so the spec refused to paint one, and named the
half-day harness (bundle the worklet against stubbed globals, instantiate the processor directly,
hand it the four factory tables **synchronously**) that would settle it.

## THE TWO EXEMPLARY MEASUREMENTS

- **A DC offset LARGER than the signal.** At the factory defaults, `DC = −0.375433` against
  `acRms = 0.348243`. Present at every setting of every control (only `level = 0` removes it, by
  removing everything), scaling with level (−0.751 at `level = 2`), with `wrap = 1` the only control
  that flips its sign. **Invisible to any RMS-based check** — a plain rms probe reads 0.51 and calls
  it healthy.
- **A non-reproducibility control.** `max|run1 − run2|` on identical params was **8.453e-1** for
  hypercube against **0.000e+0** for every other module in that batch (swolevco, warrensspectrum,
  cofefve, ninelives) — near full scale in the sample domain while RMS was stable to eight
  significant figures, the signature of a random start phase. Every `Δ` figure in the first pass was
  phase noise dressed as a measurement.
