// packages/web/src/lib/video/modules/gibribbon-spectral.ts
//
// GIBRIBBON — the PURE spectral front-end: FFT bins → the four COURSE BANDS
// + the ONSET flag the game engine consumes.
//
// This is the module's own half of the owner's audio-in redirect ("events
// should only happen based on audio ... doing what synesthesia does and
// extract spectral events"): the analysis that used to live in ANOTHER
// module's DSP (the synesthesia envelope chain whose gain calibration killed
// the game twice, #698/#701) now lives HERE, in-module, as a pure fold over
// the module's own AnalyserNode bins — and it deliberately extracts NO
// events itself. It produces four LEVELS and one FLUX number; deciding what
// is "interesting" is the adaptive prominence extractor's job
// (gibribbon-engine.ts), which measures each band against its own rolling
// baseline. That split is what the original game actually does: Vib-Ribbon
// analyzes the music and "generates obstacles based on 'interesting'
// frequency changes" — the fold is the ear, the extractor is the judgement
// of interesting.
//
// The band split is the MUSICAL one synesthesia settled on in #698 (and the
// reason that refactor happened at all): bass 20–200 / low-mid 200–1k /
// high-mid 1k–4k / treble 4k–16k, so a drum kit lands cleanly across the
// bands (kick→bass, snare body→low-mid, snare crack/melodic→high-mid,
// hats→treble). The fold shape mirrors graphic-eq-core.foldBands (the
// in-repo prior art for exactly this AnalyserNode byte-bin fold on a video
// module) with explicit musical edges instead of equal-ratio bands.
//
// PURE + shared: the factory feeds it live getByteFrequencyData bins; the
// unit/liveness tests feed it bins computed by a test-side FFT over rendered
// fixture audio. One fold, two callers, no drift.

/** The four musical band edges, Hz. Index = engine band index = event kind
 *  (bandEventMap): bass→LOOP, low-mid→JUMP, high-mid→IMP, treble→ZOMBIE. */
export const GIB_BAND_EDGES_HZ: ReadonlyArray<{ lo: number; hi: number }> = [
  { lo: 20, hi: 200 },
  { lo: 200, hi: 1000 },
  { lo: 1000, hi: 4000 },
  { lo: 4000, hi: 16000 },
];

export const GIB_FFT_SIZE = 2048;

/**
 * [loBin, hiBin) analyser-bin ranges for the four musical bands. Every band
 * is guaranteed ≥1 bin and clamped to the usable bin count (fftSize/2), so
 * the fold is total at any sample rate. Pure → unit-tested.
 */
export function gibBandBinRanges(
  sampleRate: number,
  fftSize: number = GIB_FFT_SIZE,
): Array<[number, number]> {
  const binCount = Math.floor(fftSize / 2);
  const binWidth = sampleRate / fftSize;
  return GIB_BAND_EDGES_HZ.map(({ lo, hi }) => {
    let loBin = Math.floor(lo / binWidth);
    let hiBin = Math.ceil(hi / binWidth);
    loBin = Math.max(0, Math.min(binCount - 1, loBin));
    hiBin = Math.max(loBin + 1, Math.min(binCount, hiBin));
    return [loBin, hiBin] as [number, number];
  });
}

/**
 * Fold a byte frequency buffer (0..255 per bin, the getByteFrequencyData
 * shape) into the four band levels in [0,1] — per-band average bin energy.
 * ⚠ NO GAIN PARAMETER, deliberately: level normalization is the adaptive
 * extractor's job (relative to each band's own rolling range), which is the
 * property that makes any source at any gain playable. A gain knob here
 * would be the #624 calibration coming back through the front door.
 */
export function gibFoldBands(
  freq: ArrayLike<number>,
  ranges: ReadonlyArray<readonly [number, number]>,
): number[] {
  const out = [0, 0, 0, 0];
  for (let b = 0; b < 4; b++) {
    const [lo, hi] = ranges[b]!;
    let sum = 0;
    let n = 0;
    for (let i = lo; i < hi && i < freq.length; i++) {
      sum += freq[i]!;
      n++;
    }
    out[b] = n ? sum / n / 255 : 0;
  }
  return out;
}

/**
 * Spectral FLUX between two band frames: the sum of POSITIVE band deltas —
 * energy arriving, never energy leaving. The classic onset feature, over the
 * four musical bands rather than raw bins (a kick and a hat both register;
 * a slow filter sweep barely does).
 */
export function gibSpectralFlux(prev: readonly number[], cur: readonly number[]): number {
  let flux = 0;
  for (let i = 0; i < 4; i++) {
    const d = (cur[i] ?? 0) - (prev[i] ?? 0);
    if (d > 0) flux += d;
  }
  return flux;
}

/** Rolling flux baseline for the onset decision. Ring buffer, pure. */
export interface GibOnsetState {
  hist: number[];
  idx: number;
  filled: number;
}

export function newOnsetState(): GibOnsetState {
  return { hist: [], idx: 0, filled: 0 };
}

const ONSET_WINDOW = 43; // ~1 s of scheduler ticks at 25 ms
const ONSET_RATIO = 1.5; // flux must beat 1.5× its own recent mean…
const ONSET_FLOOR = 0.02; // …and clear an absolute floor (silence ≠ onsets)

/**
 * Push this tick's flux and decide whether it is an ONSET: notably above the
 * flux's OWN recent mean (the same relative-to-own-baseline philosophy as
 * the extractor — a quiet track's onsets count like a loud track's) and
 * above a small absolute floor so digital silence never beats.
 * Pure (in-place ring write). The verdict is a BIAS downstream, never a
 * hard gate on spawning.
 */
export function pushFluxIsOnset(state: GibOnsetState, flux: number): boolean {
  let mean = 0;
  if (state.filled > 0) {
    let sum = 0;
    for (let i = 0; i < state.filled; i++) sum += state.hist[i]!;
    mean = sum / state.filled;
  }
  if (state.hist.length < ONSET_WINDOW) {
    state.hist.push(flux);
    state.filled = state.hist.length;
    state.idx = state.hist.length % ONSET_WINDOW;
  } else {
    state.hist[state.idx] = flux;
    state.idx = (state.idx + 1) % ONSET_WINDOW;
    state.filled = ONSET_WINDOW;
  }
  return flux > ONSET_FLOOR && flux > mean * ONSET_RATIO;
}
