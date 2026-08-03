// packages/dsp/src/lib/warrensspectrum-voice.ts
//
// The SHAPE morph — sine → saw → square — shared by BOTH of Warren's
// Spectrum's engines.
//
// It lives in its own module for two reasons:
//
// 1. **It removes an import cycle.** `warrensspectrum-dsp.ts` (SPECTRAL)
//    owns the `WsMassPass` instance, and MASSPASS needs the same morph. If
//    the morph stayed on the SPECTRAL module the two files would import each
//    other, which esbuild would flatten but the ART lane's classic-script
//    eval is a poor place to discover that assumption.
//
// 2. **It makes "one morph, two engines" STRUCTURAL.** The VST keeps two
//    hand-synchronised copies and says so in a comment — `MassPass.cpp:39-42`
//    reads *"Local copy of voiceWaveform / PolyBLEP from SpectralResynth.cpp.
//    … If you change one copy you must change the other — keep them in
//    sync."* A comment is not a mechanism. One import cannot drift.
//
// `warrensspectrum-dsp.ts` re-exports `wsVoiceWaveform`, so every existing
// importer keeps working and no test moved.

function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

function bandLimitedSaw(phase01: number, dt: number): number {
  return 2 * phase01 - 1 - polyBlep(phase01, dt);
}

function bandLimitedSquare(phase01: number, dt: number): number {
  const naive = phase01 < 0.5 ? 1 : -1;
  let falling = phase01 + 0.5;
  if (falling >= 1) falling -= 1;
  return naive + polyBlep(phase01, dt) - polyBlep(falling, dt);
}

/**
 * SHAPE morph: sine → saw → square. Verbatim from `voiceWaveform()`
 * (`SpectralResynth.cpp:83-98`, and its copy at `MassPass.cpp:84-101`)
 * including both 1e-4 endpoint snaps.
 *
 * ⚠ `Math.sin` rather than the VST's `fastSin2Pi` polynomial is DELIBERATE
 * and measured: plan §4.5 benchmarked the polynomial at **1.01x** — V8's
 * `Math.sin` is already a fast intrinsic, so the C++ win does not exist in
 * JS. Do not "optimise" this back.
 */
export function wsVoiceWaveform(phase01: number, dt: number, shape01: number): number {
  if (shape01 <= 1e-4) return Math.sin(2 * Math.PI * phase01);
  if (shape01 < 0.5) {
    const a = shape01 * 2;
    return (1 - a) * Math.sin(2 * Math.PI * phase01) + a * bandLimitedSaw(phase01, dt);
  }
  if (shape01 >= 1 - 1e-4) return bandLimitedSquare(phase01, dt);
  const a = (shape01 - 0.5) * 2;
  return (1 - a) * bandLimitedSaw(phase01, dt) + a * bandLimitedSquare(phase01, dt);
}
