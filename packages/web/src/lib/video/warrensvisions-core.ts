// packages/web/src/lib/video/warrensvisions-core.ts
//
// WARREN'S VISIONS — the 2D SPECTRAL RESYNTH core.
//
// The visual analogue of the WARREN'S SPECTRUM audio engine
// (`packages/dsp/src/lib/warrensspectrum-dsp.ts`). Same architecture, one
// dimension more:
//
//   audio                              vision
//   ─────────────────────────────      ────────────────────────────────────
//   2048-pt FFT of the last window     N×N 2D FFT of the downsampled luma
//   bin b → frequency f (Hz)           bin (u,v) → WAVEVECTOR (kx,ky)
//                                        |k| = spatial frequency (detail)
//                                        ∠k  = orientation
//   partial amplitude                  component CONTRAST
//   partial phase (birth only)         component POSITION — see COHERENCE
//   harmonic comb k·F0                 LATTICE comb n·k0 (periodic texture)
//   McAulay-Quatieri track matching    same, in the (kx,ky) plane
//   16 log bands of unclaimed energy   16 log RINGS of unclaimed energy
//   band-passed noise residual         ring-weighted procedural texture
//   sine→saw→square PolyBLEP morph     sine→saw→square HARMONIC INJECTION
//
// This file is PURE: no browser APIs, no WebGL, no allocation after
// construction. It is imported by
//   * packages/web/src/lib/video/modules/warrensvisions.ts  — the WebGL module
//   * packages/web/src/lib/video/warrensvisions-core.test.ts — the unit gates
// so there is exactly ONE implementation of the algorithm.
//
// ── WHERE THE ANALOGY IS REAL, AND WHERE IT IS NOT ────────────────────────
//
// 1. PHASE IS THE WHOLE PROBLEM, and it is the one place the audio engine
//    gives no guidance. In audio, magnitude carries most of the percept, so
//    `warrensspectrum-dsp.ts` takes FFT phase ONCE at track birth
//    (`binPhase01`, :952-958) and lets the oscillator free-run from there. In
//    an image, phase carries the GEOMETRY — where the edges and the objects
//    are. Keep magnitudes, discard phase, and you get texture, not a picture.
//
//    So the defining new control is COHERENCE, which has no audio counterpart:
//      1 — every commit re-seats each component's phase on the phase measured
//          at its wavevector → a sparse but RECOGNISABLE reconstruction;
//      0 — phase is seated at track birth and then free-runs (the literal
//          port of the audio behaviour) → a moving interference painting;
//      between — the picture forms and melts.
//    Implemented as a shortest-arc pull of gain `coherence` applied at each
//    COMMIT (that is the only moment a fresh measurement exists).
//
// 2. DC IS A COMPONENT HERE AND IS NOT IN AUDIO. Bin (0,0) is the mean luma —
//    inaudible in audio, and the entire base level of a picture. It is carried
//    as a scalar outside the track bank rather than occupying a component slot.
//
// 3. SALIENCE NEEDED NO LOW-FREQUENCY TERM. The audio salience is
//    `amp × harmonic bonus` and nothing else; the reason thinning the bank
//    collapses toward the fundamental is that audio spectra fall off with
//    frequency. Natural IMAGE spectra fall off as 1/f the same way, so bare
//    amplitude already biases the survivors toward coarse structure. The
//    function is `wsPeakSalience` with the harmonic comb replaced by a lattice
//    comb — no extra term was invented.
//
// 4. THE HARMONIC LOCK BECOMES A LATTICE LOCK, and it is a real analogy but a
//    narrower one. A periodic texture (a fence, a brick wall, corduroy, a
//    halftone screen) puts energy at n·k0 along a ray exactly as a pitched
//    tone puts energy at n·F0. LOCK snaps wavevectors onto that comb and
//    cleans the texture up. On a photograph with no periodic content the z-
//    score confidence gate holds it off, exactly as the audio F0 gate holds
//    LOCK off on unpitched input. It does LESS work here than in audio,
//    because fewer images are periodic than sounds are pitched.
//
// 5. SHAPE IS SPECTRAL, NOT PolyBLEP. `wsVoiceWaveform` is a time-domain
//    waveform generator evaluated per sample; there is no per-sample loop
//    here. A saw/square at wavevector k is its harmonic series at n·k, so
//    SHAPE injects harmonics into the sparse spectrum instead. Harmonics past
//    the grid limit are simply not written, which is exact band-limiting —
//    the spectral equivalent of what PolyBLEP approximates.
//
// 6. SLICE IS IN FRAMES, NOT MILLISECONDS. The source only changes when a
//    frame is rendered, so committing "every 33 ms" on a renderer running at
//    8 fps means committing every frame. Frames are also the unit the CPU
//    budget is actually spent in. SLEW stays in SECONDS (it is a perceptual
//    envelope time, and the engine hands us a clamped `timeDelta`).
//
// 7. DRIFT (ω) has no audio counterpart as a CONTROL, but is the literal port
//    of the audio behaviour: an audio oscillator advances its phase at its own
//    frequency. Here the same law is `ω_i ∝ |k_i|`, so fine detail boils fast
//    and coarse structure drifts slowly. At DRIFT 0 the phases only move when
//    the servo moves them.

// ---------------------------------------------------------------------------
// Fixed algorithm constants.
// ---------------------------------------------------------------------------

/** Analysis + synthesis grid, one side. 128×128 = 16384 bins; the 2D FFT is
 *  2·N row/column transforms of length N. Deliberately NOT the engine
 *  resolution: the reconstruction is band-limited to this grid by
 *  construction, which is what makes the cost independent of output size. */
export const WV_GRID = 128;

/** Component-bank ceiling — the direct counterpart of `WS_MAX_TRACKS`, and
 *  the same number for the same reason (4× the VST's default bank). */
export const WV_MAX_COMPONENTS = 256;

/** Peak-list ceiling. A 2D local maximum needs a strictly lower neighbour in
 *  every direction, so at most a quarter of the canonical half-plane can be a
 *  peak. */
const MAX_PEAKS = (WV_GRID * WV_GRID) / 4;

/** SMS residual ring count — the counterpart of `RESIDUAL_BANDS` (16). */
export const WV_RESIDUAL_RINGS = 16;

/** Bins masked either side of a claimed peak, as a RADIUS in the 2D plane.
 *  The audio masks ±3 bins in 1D; a disc of radius 2 claims 13 bins, which is
 *  the closest 2D equivalent by area to the audio's 7. */
const RESIDUAL_MASK_RADIUS = 2;

/** MQ match tolerance, relative distance in the wavevector plane. The audio's
 *  `kMatchTolerance` (0.05) applied to |Δk| / max(|k₁|,|k₂|). */
const MATCH_TOLERANCE = 0.05;

/** Harmonics summed by the lattice-fundamental detector, and the ceiling on
 *  SHAPE's harmonic injection. `F0_MAX_HARMONICS` in the audio. */
export const WV_MAX_HARMONICS = 8;

/** LOCK snap window — a peak further than this (relative) from n·k0 is left
 *  alone. `SpectralResynth.cpp:621-652` uses 0.06 on |Δf|/f. */
const LATTICE_SNAP_TOL = 0.06;

/** SALIENCE comb window. The audio uses ±25 cents, i.e. ±1.45 % in frequency;
 *  0.015 relative distance in the plane is the same tolerance one dimension
 *  up. */
const LATTICE_SALIENCE_TOL = 0.015;

/**
 * Tukey taper fraction, per edge. An image is not periodic, so the FFT's wrap
 * discontinuity dumps a bright cross onto the kx=0 / ky=0 axes and spends
 * component slots reconstructing the frame border. The taper suppresses it.
 *
 * MEASURED (a pure 0.35-contrast grating vs a uniform-noise field, ring
 * energy after 20 commits — the closer to 0 the more the residual tracks
 * genuinely unclaimed content rather than the window's own sidelobes):
 *
 *   taper   grating/noise residual ratio   under-compensated border
 *   0.08    0.366                          3 %
 *   0.12    0.330                          5 %
 *   0.20    0.229                          8 %
 *   0.30    0.133                          12 %
 *   0.50    0.006                          40 %   (= a full Hann)
 *
 * 0.50 is a Hann window and is what the audio engine uses — audio can afford
 * it because overlap-add puts the tapered samples back. There is no overlap-
 * add here: the reconstruction reproduces the WINDOWED plane, so the taper is
 * a visible vignette. 0.30 buys most of the leakage suppression for a border
 * an eighth as wide, and what remains is divided back out at composite time.
 */
export const WV_TUKEY_TAPER = 0.3;

/** The reconstruction is divided by the analysis window; this floors the
 *  divisor so the corners do not explode. With `WV_TUKEY_TAPER` at 0.30 the
 *  window is above this floor over the inner 88 % of each axis. */
export const WV_TAPER_FLOOR = 0.35;

/** Anti-alias ramp on transposed wavevectors, as a fraction of the grid
 *  limit — the counterpart of the audio's 0.75/0.85-of-Nyquist ramp. */
const ALIAS_RAMP_START = 0.75;
const ALIAS_RAMP_END = 0.85;

/** Residual noise seed. Constant so the module is reproducible frame to
 *  frame — the counterpart of `WS_RESIDUAL_NOISE_SEED`, and what lets a VRT
 *  baseline exist at all. */
export const WV_NOISE_SEED = 0x9e3779b9;

/** Declared control ranges that the DEF must not re-type. Exported for the
 *  same one-place-only reason as `WS_SLICE_MIN_MS` et al. */
export const WV_COMPONENTS_MIN = 1;
export const WV_COMPONENTS_MAX = WV_MAX_COMPONENTS;
export const WV_FLOOR_MIN_DB = -90;
export const WV_FLOOR_MAX_DB = -20;
export const WV_STABILITY_MIN = 1;
export const WV_STABILITY_MAX = 16;
export const WV_SLEW_MIN_S = 0.02;
export const WV_SLEW_MAX_S = 4;
export const WV_SLICE_MIN_FRAMES = 1;
export const WV_SLICE_MAX_FRAMES = 16;
export const WV_CENTER_MIN_CENTS = -3600;
export const WV_CENTER_MAX_CENTS = 3600;

// ---------------------------------------------------------------------------
// Radix-2 complex FFT, strided, in place. One instance per grid size; the
// twiddles are shared by every transform of that size.
// ---------------------------------------------------------------------------

export class WvFft {
  readonly n: number;
  private readonly bits: number;
  private readonly rev: Uint16Array;
  private readonly wRe: Float32Array;
  private readonly wIm: Float32Array;

  constructor(n: number) {
    if (n < 2 || (n & (n - 1)) !== 0) throw new Error(`WvFft: n must be a power of two, got ${n}`);
    this.n = n;
    let bits = 0;
    while (1 << bits < n) bits++;
    this.bits = bits;
    this.rev = new Uint16Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      this.rev[i] = r;
    }
    // Twiddles laid out stage by stage: stage s (half = 1<<s) contributes
    // `half` entries. Total = n-1.
    this.wRe = new Float32Array(n);
    this.wIm = new Float32Array(n);
    let at = 0;
    for (let half = 1; half < n; half <<= 1) {
      for (let j = 0; j < half; j++) {
        const ang = (-Math.PI * j) / half;
        this.wRe[at] = Math.cos(ang);
        this.wIm[at] = Math.sin(ang);
        at++;
      }
    }
  }

  /**
   * Transform `n` complex values living at `re[off + i*stride]`.
   * `inverse` conjugates the twiddles; it does NOT scale (the 2D driver
   * scales once by 1/n² at the end, as the audio's inverse would).
   */
  run(re: Float32Array, im: Float32Array, off: number, stride: number, inverse: boolean): void {
    const n = this.n;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i]!;
      if (j > i) {
        const a = off + i * stride;
        const b = off + j * stride;
        let t = re[a]!;
        re[a] = re[b]!;
        re[b] = t;
        t = im[a]!;
        im[a] = im[b]!;
        im[b] = t;
      }
    }
    const sgn = inverse ? -1 : 1;
    let at = 0;
    for (let half = 1; half < n; half <<= 1) {
      const step = half << 1;
      for (let j = 0; j < half; j++) {
        const wr = this.wRe[at + j]!;
        const wi = sgn * this.wIm[at + j]!;
        for (let i = j; i < n; i += step) {
          const a = off + i * stride;
          const b = off + (i + half) * stride;
          const ar = re[a]!;
          const ai = im[a]!;
          const br = re[b]!;
          const bi = im[b]!;
          const tr = wr * br - wi * bi;
          const ti = wr * bi + wi * br;
          re[a] = ar + tr;
          im[a] = ai + ti;
          re[b] = ar - tr;
          im[b] = ai - ti;
        }
      }
      at += half;
    }
  }
}

/** 2D transform of an n×n plane stored row-major in `re`/`im`. */
export function wvFft2d(
  fft: WvFft,
  re: Float32Array,
  im: Float32Array,
  n: number,
  inverse: boolean,
): void {
  for (let y = 0; y < n; y++) fft.run(re, im, y * n, 1, inverse);
  for (let x = 0; x < n; x++) fft.run(re, im, x, n, inverse);
  if (inverse) {
    const s = 1 / (n * n);
    for (let i = 0; i < n * n; i++) {
      re[i] = re[i]! * s;
      im[i] = im[i]! * s;
    }
  }
}

// ---------------------------------------------------------------------------
// Salience — `wsPeakSalience` with the harmonic comb replaced by a lattice
// comb. Same shape, same constants, same purpose.
// ---------------------------------------------------------------------------

/**
 * @param kx,ky      the peak's wavevector, in cycles per grid
 * @param amp        its contrast
 * @param k0x,k0y    the detected lattice fundamental (0,0 when none)
 * @param k0Conf     the fundamental's z-score confidence
 * @param lock       the LOCK control, 0..1
 */
export function wvPeakSalience(
  kx: number,
  ky: number,
  amp: number,
  k0x: number,
  k0y: number,
  k0Conf: number,
  lock: number,
): number {
  const r = Math.hypot(kx, ky);
  if (r <= 0 || amp <= 0) return 0;
  let bonus = 1;
  const r0 = Math.hypot(k0x, k0y);
  if (r0 > 0.5 && k0Conf > 1 && lock > 1e-3) {
    const n = Math.round(r / r0);
    if (n >= 1) {
      const dx = kx - n * k0x;
      const dy = ky - n * k0y;
      if (Math.hypot(dx, dy) / r < LATTICE_SALIENCE_TOL) {
        const confTerm = Math.max(0, Math.min(1, (k0Conf - 1) / 1.4));
        bonus = 1 + 3 * (1 / Math.sqrt(n)) * confTerm * lock;
      }
    }
  }
  return amp * bonus;
}

// ---------------------------------------------------------------------------
// SHAPE — the harmonic weights of the sine→saw→square morph.
// ---------------------------------------------------------------------------

/**
 * Relative amplitude of harmonic `n` (1 = the fundamental) at morph position
 * `shape` (0 sine, 0.5 saw, 1 square).
 *
 * 0→0.5 fades the saw series (1/n, every n) in on top of the fundamental;
 * 0.5→1 fades the EVEN harmonics back out, which is precisely what turns a
 * saw into a square. The fundamental is always 1, so the morph does not
 * change the component's own contrast — the audio's PolyBLEP morph has the
 * same property.
 */
export function wvHarmonicWeight(n: number, shape: number): number {
  if (n === 1) return 1;
  const s = Math.max(0, Math.min(1, shape));
  const series = s <= 0.5 ? s * 2 : 1;
  const evenFade = s <= 0.5 ? 1 : 1 - (s - 0.5) * 2;
  const parity = n % 2 === 0 ? evenFade : 1;
  return (series * parity) / n;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface WvComponentSnapshot {
  kx: number;
  ky: number;
  amp: number;
  phase: number;
  framesAlive: number;
}

/** What `synthesize` reports about the field it just wrote. */
export interface WvFieldStats {
  min: number;
  max: number;
  /** Components that contributed a non-zero tap this frame. */
  live: number;
}

/**
 * The Warren's Visions spectral resynthesizer. One luma plane in, one luma
 * plane out, no allocation after construction.
 *
 * Deterministic given (grid, input sequence, parameter trajectory): every
 * stochastic element is seeded, which is what lets a VRT baseline and a
 * frame-counted e2e exist.
 */
export class WarrensVisionsEngine {
  readonly grid: number;
  private readonly cells: number;
  private readonly fft: WvFft;

  // ---- analysis buffers ----
  private readonly re: Float32Array;
  private readonly im: Float32Array;
  private readonly mag: Float32Array;
  private readonly claimed: Uint8Array;
  /** Separable Tukey window, one axis (the 2D window is the outer product). */
  private readonly window: Float32Array;
  private readonly windowCoherentGain: number;

  // ---- synthesis buffers ----
  private readonly sre: Float32Array;
  private readonly sim: Float32Array;

  // ---- peak list ----
  private readonly peakKx: Float32Array;
  private readonly peakKy: Float32Array;
  private readonly peakAmp: Float32Array;
  private readonly peakPhase: Float32Array;
  private readonly peakSal: Float32Array;
  private numPeaks = 0;

  // ---- component bank ----
  private readonly tAlive = new Uint8Array(WV_MAX_COMPONENTS);
  private readonly tKx = new Float32Array(WV_MAX_COMPONENTS);
  private readonly tKy = new Float32Array(WV_MAX_COMPONENTS);
  private readonly tAmp = new Float32Array(WV_MAX_COMPONENTS);
  private readonly tAmpTarget = new Float32Array(WV_MAX_COMPONENTS);
  private readonly tPhase = new Float32Array(WV_MAX_COMPONENTS);
  /** The phase measured at this component's wavevector on the last commit —
   *  the COHERENCE servo's set-point. */
  private readonly tPhaseMeas = new Float32Array(WV_MAX_COMPONENTS);
  private readonly tOmega = new Float32Array(WV_MAX_COMPONENTS);
  private readonly tFrames = new Int32Array(WV_MAX_COMPONENTS);
  private readonly matched = new Uint8Array(WV_MAX_COMPONENTS);
  private readonly activeIdx = new Int32Array(WV_MAX_COMPONENTS);
  private numActive = 0;

  // ---- SMS residual ----
  private readonly ringEdges: Int32Array;
  private readonly ringTarget = new Float32Array(WV_RESIDUAL_RINGS);
  private readonly ringEnv = new Float32Array(WV_RESIDUAL_RINGS);
  /**
   * The residual's noise source, in the SPECTRAL domain: a fixed
   * unit-magnitude random-phase plane, Hermitian by construction so the
   * inverse transform of any ring-weighted slice of it is real.
   *
   * This is where the residual actually lives, and it is a deliberate move
   * away from the obvious screen-space fBm. Measured under SwiftShader at
   * 1280×720, a 6-octave value-noise loop cost 12.4 ms per frame on top of a
   * 3.2 ms passthrough floor — more than the entire rest of the module. Here
   * the same 16 log-spaced rings ride into the inverse FFT we are already
   * doing, so the GPU pays nothing at all and the residual is band-limited on
   * exactly the same terms as the components. It is also the more faithful
   * port: the audio engine band-passes noise at 16 log bands, which IS a
   * spectral operation.
   *
   * The honest cost: the residual cannot carry detail finer than the grid, so
   * it renders foliage, smoke and boil well and cannot render fine film grain.
   */
  private readonly noiseRe: Float32Array;
  private readonly noiseIm: Float32Array;
  /** Canonical half-plane bin list + each entry's conjugate partner. */
  private readonly halfIdx: Int32Array;
  private readonly conjIdx: Int32Array;
  private readonly halfRing: Int32Array;
  private halfCount = 0;
  /** Per-half-plane-bin: is this bin unclaimed (so it carries residual)? */
  private readonly halfUnclaimed: Uint8Array;
  /** Per-ring rotation angle, advanced by DRIFT so the texture boils. */
  private readonly ringPhase = new Float32Array(WV_RESIDUAL_RINGS);
  private readonly ringBins = new Int32Array(WV_RESIDUAL_RINGS);
  private readonly ringNorm = new Float32Array(WV_RESIDUAL_RINGS);
  private readonly ringGainScratch = new Float32Array(WV_RESIDUAL_RINGS);
  private readonly ringCosScratch = new Float32Array(WV_RESIDUAL_RINGS);
  private readonly ringSinScratch = new Float32Array(WV_RESIDUAL_RINGS);

  // ---- detected lattice fundamental ----
  private k0x = 0;
  private k0y = 0;
  private k0Conf = 0;

  // ---- DC ----
  private dcTarget = 0;
  private dc = 0;

  // ---- parameters ----
  private components = 64;
  private thresholdDb = -42;
  private minBirthFrames = 3;
  private lock = 0.5;
  private residual = 0.5;
  private shape = 0;
  private slewSeconds = 0.25;
  private coherence = 1;
  private drift = 0;
  private transposeRatio = 1;
  private frozen = false;

  // ---- introspection ----
  private committedFrames = 0;

  constructor(grid: number = WV_GRID) {
    this.grid = grid;
    this.cells = grid * grid;
    this.fft = new WvFft(grid);
    this.re = new Float32Array(this.cells);
    this.im = new Float32Array(this.cells);
    this.mag = new Float32Array(this.cells);
    this.claimed = new Uint8Array(this.cells);
    this.sre = new Float32Array(this.cells);
    this.sim = new Float32Array(this.cells);
    this.peakKx = new Float32Array(MAX_PEAKS);
    this.peakKy = new Float32Array(MAX_PEAKS);
    this.peakAmp = new Float32Array(MAX_PEAKS);
    this.peakPhase = new Float32Array(MAX_PEAKS);
    this.peakSal = new Float32Array(MAX_PEAKS);

    // Separable Tukey window.
    this.window = new Float32Array(grid);
    const taper = Math.max(1, Math.round(grid * WV_TUKEY_TAPER));
    let sum = 0;
    for (let i = 0; i < grid; i++) {
      let w = 1;
      if (i < taper) w = 0.5 * (1 - Math.cos((Math.PI * i) / taper));
      else if (i >= grid - taper) w = 0.5 * (1 - Math.cos((Math.PI * (grid - 1 - i)) / taper));
      this.window[i] = w;
      sum += w;
    }
    this.windowCoherentGain = sum / grid;

    // 16 log-spaced radial rings over |k| ∈ [1, grid/2].
    this.ringEdges = new Int32Array(WV_RESIDUAL_RINGS + 1);
    const rMax = grid / 2;
    for (let i = 0; i <= WV_RESIDUAL_RINGS; i++) {
      const t = i / WV_RESIDUAL_RINGS;
      this.ringEdges[i] = Math.round(Math.pow(rMax, t));
    }
    this.ringEdges[0] = 1;
    this.ringEdges[WV_RESIDUAL_RINGS] = Math.ceil(rMax * Math.SQRT2) + 1;

    // Canonical half-plane index + the fixed random-phase noise plane.
    this.noiseRe = new Float32Array(this.cells);
    this.noiseIm = new Float32Array(this.cells);
    this.halfIdx = new Int32Array(this.cells >> 1);
    this.conjIdx = new Int32Array(this.cells >> 1);
    this.halfRing = new Int32Array(this.cells >> 1);
    this.halfUnclaimed = new Uint8Array(this.cells >> 1);
    let seed = WV_NOISE_SEED >>> 0;
    const rnd = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      return seed / 4294967296;
    };
    let h = 0;
    for (let iy = 0; iy < grid; iy++) {
      const fy = iy <= grid / 2 ? iy : iy - grid;
      for (let ix = 0; ix < grid; ix++) {
        const fx = ix <= grid / 2 ? ix : ix - grid;
        if (fy < 0 || (fy === 0 && fx <= 0)) continue;
        const r = Math.hypot(fx, fy);
        if (r < 1) continue;
        let ring = WV_RESIDUAL_RINGS - 1;
        for (let b = 0; b < WV_RESIDUAL_RINGS; b++) {
          if (r < this.ringEdges[b + 1]!) {
            ring = b;
            break;
          }
        }
        const idx = iy * grid + ix;
        const cIy = (grid - iy) % grid;
        const cIx = (grid - ix) % grid;
        const cIdx = cIy * grid + cIx;
        const ang = rnd() * 2 * Math.PI;
        this.noiseRe[idx] = Math.cos(ang);
        this.noiseIm[idx] = Math.sin(ang);
        this.noiseRe[cIdx] = this.noiseRe[idx]!;
        this.noiseIm[cIdx] = -this.noiseIm[idx]!;
        this.halfIdx[h] = idx;
        this.conjIdx[h] = cIdx;
        this.halfRing[h] = ring;
        h++;
      }
    }
    this.halfCount = h;
    // A ring's measured energy is the SUM over its bins, so putting that
    // energy back means dividing by sqrt(count) — otherwise the outer rings,
    // which hold far more bins, come back enormously louder than they were.
    for (let i = 0; i < h; i++) this.ringBins[this.halfRing[i]!]++;
    for (let b = 0; b < WV_RESIDUAL_RINGS; b++) {
      this.ringNorm[b] = 1 / Math.sqrt(Math.max(1, this.ringBins[b]!));
    }
  }

  reset(): void {
    this.tAlive.fill(0);
    this.tKx.fill(0);
    this.tKy.fill(0);
    this.tAmp.fill(0);
    this.tAmpTarget.fill(0);
    this.tPhase.fill(0);
    this.tPhaseMeas.fill(0);
    this.tOmega.fill(0);
    this.tFrames.fill(0);
    this.ringTarget.fill(0);
    this.ringEnv.fill(0);
    this.ringPhase.fill(0);
    this.halfUnclaimed.fill(0);
    this.numActive = 0;
    this.numPeaks = 0;
    this.k0x = 0;
    this.k0y = 0;
    this.k0Conf = 0;
    this.dc = 0;
    this.dcTarget = 0;
    this.committedFrames = 0;
  }

  // ---- setters (idempotent) ----

  setComponents(n: number): void {
    this.components = Math.max(WV_COMPONENTS_MIN, Math.min(WV_COMPONENTS_MAX, Math.round(n)));
  }
  setFloorDb(db: number): void {
    this.thresholdDb = Math.max(WV_FLOOR_MIN_DB, Math.min(WV_FLOOR_MAX_DB, db));
  }
  setStabilityFrames(n: number): void {
    this.minBirthFrames = Math.max(WV_STABILITY_MIN, Math.min(WV_STABILITY_MAX, Math.round(n)));
  }
  setLock(v: number): void {
    this.lock = Math.max(0, Math.min(1, v));
  }
  setResidual(v: number): void {
    this.residual = Math.max(0, v);
  }
  setShape(v: number): void {
    this.shape = Math.max(0, Math.min(1, v));
  }
  setSlewSeconds(s: number): void {
    this.slewSeconds = Math.max(WV_SLEW_MIN_S, Math.min(WV_SLEW_MAX_S, s));
  }
  setCoherence(v: number): void {
    this.coherence = Math.max(0, Math.min(1, v));
  }
  setDrift(v: number): void {
    this.drift = Math.max(0, Math.min(1, v));
  }
  setCenterCents(cents: number): void {
    const c = Math.max(WV_CENTER_MIN_CENTS, Math.min(WV_CENTER_MAX_CENTS, cents));
    this.transposeRatio = Math.pow(2, c / 1200);
  }
  setFrozen(f: boolean): void {
    this.frozen = f;
  }

  // ---- introspection (the tests read these) ----

  getCommittedFrames(): number {
    return this.committedFrames;
  }
  getLatticeFundamental(): { kx: number; ky: number; confidence: number } {
    return { kx: this.k0x, ky: this.k0y, confidence: this.k0Conf };
  }
  getRingEnergies(): Float32Array {
    return this.ringTarget;
  }
  getDc(): number {
    return this.dc;
  }
  /** Alive components, salience order not guaranteed. Allocates — test-only. */
  snapshot(): WvComponentSnapshot[] {
    const out: WvComponentSnapshot[] = [];
    for (let i = 0; i < WV_MAX_COMPONENTS; i++) {
      if (!this.tAlive[i]) continue;
      out.push({
        kx: this.tKx[i]!,
        ky: this.tKy[i]!,
        amp: this.tAmp[i]!,
        phase: this.tPhase[i]!,
        framesAlive: this.tFrames[i]!,
      });
    }
    return out;
  }

  // ---- analysis (one COMMIT) ----

  /**
   * Analyse one luma plane. `luma` is `grid*grid` values in 0..1, row-major,
   * top-left origin. FREEZE is handled by the CALLER not calling this — the
   * bank keeps running on the components it already has, exactly as the audio
   * skips `analyzeFrame` while frozen.
   */
  analyze(luma: Float32Array): void {
    const n = this.grid;
    this.committedFrames++;

    // (1) DC first, and REMOVE it before windowing.
    //
    //     Windowing a plane that still carries its mean convolves that mean
    //     with the window's transform, which puts a bright skirt on every
    //     low-|k| bin. Measured on a uniform-noise field: the skirt made the
    //     lattice detector confident (confNorm 1.0) about a fundamental that
    //     was pure DC leakage, and it dominated the residual rings. The audio
    //     engine never meets this because audio has no DC term. Subtracting
    //     the mean is exact, costs one pass, and is the whole fix.
    let mean = 0;
    for (let i = 0; i < this.cells; i++) mean += luma[i]!;
    mean /= this.cells;
    this.dcTarget = mean;

    const w = this.window;
    for (let y = 0; y < n; y++) {
      const wy = w[y]!;
      const row = y * n;
      for (let x = 0; x < n; x++) {
        this.re[row + x] = (luma[row + x]! - mean) * wy * w[x]!;
        this.im[row + x] = 0;
      }
    }
    wvFft2d(this.fft, this.re, this.im, n, false);

    // (2) Magnitudes. A real cosine of amplitude A at (u,v) transforms to
    //     |F| = A·N²·cg²/2, so ampScale inverts that.
    const cg = this.windowCoherentGain;
    const ampScale = 2 / (n * n * cg * cg);
    let maxMag = 0;
    for (let i = 0; i < this.cells; i++) {
      const rr = this.re[i]!;
      const ii = this.im[i]!;
      const m = Math.sqrt(rr * rr + ii * ii);
      this.mag[i] = m;
      if (i !== 0 && m > maxMag) maxMag = m;
    }

    // (3) Adaptive threshold — FLOOR is RELATIVE to the loudest component.
    const thr = maxMag * Math.pow(10, this.thresholdDb / 20);

    // (4) Lattice fundamental, with a z-score confidence.
    this.detectFundamental();

    // (5) Peak pick over the canonical half-plane, parabolic interpolation in
    //     LOG magnitude, independently per axis.
    this.pickPeaks(thr, ampScale);

    // (6) Salience cull — top-`components` by SALIENCE, not by contrast.
    this.cullBySalience();

    // (7) Lattice LOCK.
    this.applyLatticeLock();

    // (8) MQ tracking in the wavevector plane.
    this.matchTracks();

    // (9) The COHERENCE servo: pull live phases toward what was measured.
    this.servoPhases();

    // (10) SMS residual — the unclaimed energy, per ring.
    this.updateRingTargets();
  }

  /** Signed frequency of DFT index `i`. */
  private freqOf(i: number): number {
    const n = this.grid;
    return i <= n / 2 ? i : i - n;
  }

  /** Wrap a signed frequency back to a DFT index. */
  private indexOf(f: number): number {
    const n = this.grid;
    let i = Math.round(f) % n;
    if (i < 0) i += n;
    return i;
  }

  private magAtFreq(fx: number, fy: number): number {
    return this.mag[this.indexOf(fy) * this.grid + this.indexOf(fx)]!;
  }

  /**
   * The F0 detector, one dimension up: score every candidate fundamental in
   * the low-|k| annulus by its harmonic sum, take the best, and turn the
   * distribution's z-score into a confidence. `detectF0`
   * (`warrensspectrum-dsp.ts:960-1015`) line for line, with a 2D scan.
   */
  private detectFundamental(): void {
    const n = this.grid;
    const rMax = Math.floor(n / 2 / WV_MAX_HARMONICS);
    let bestScore = 0;
    let bestX = 0;
    let bestY = 0;
    let sumScores = 0;
    let sumSquares = 0;
    let nScores = 0;
    for (let vy = 0; vy <= rMax; vy++) {
      for (let vx = -rMax; vx <= rMax; vx++) {
        if (vy === 0 && vx <= 0) continue; // canonical half-plane, skip DC
        const r = Math.hypot(vx, vy);
        if (r < 2 || r > rMax) continue;
        let score = 0;
        for (let h = 1; h <= WV_MAX_HARMONICS; h++) {
          score += this.magAtFreq(vx * h, vy * h) / Math.sqrt(h);
        }
        sumScores += score;
        sumSquares += score * score;
        nScores++;
        if (score > bestScore) {
          bestScore = score;
          bestX = vx;
          bestY = vy;
        }
      }
    }
    let conf = 0;
    if (nScores >= 2 && bestScore > 0) {
      const mean = sumScores / nScores;
      const variance = sumSquares / nScores - mean * mean;
      const stddev = Math.sqrt(Math.max(0, variance) + 1e-12);
      const z = (bestScore - mean) / (stddev + 1e-12);
      conf = z / (Math.sqrt(Math.log(nScores + 1)) + 1e-12);
    }
    const smooth = 0.3;
    this.k0Conf += smooth * (conf - this.k0Conf);
    if (conf > 1.4) {
      if (Math.hypot(this.k0x, this.k0y) <= 0.5) {
        this.k0x = bestX;
        this.k0y = bestY;
      } else {
        this.k0x += smooth * (bestX - this.k0x);
        this.k0y += smooth * (bestY - this.k0y);
      }
    } else if (this.k0Conf < 0.7) {
      this.k0x *= 1 - 0.5 * smooth;
      this.k0y *= 1 - 0.5 * smooth;
      if (Math.hypot(this.k0x, this.k0y) < 0.5) {
        this.k0x = 0;
        this.k0y = 0;
      }
    }
  }

  private pickPeaks(thr: number, ampScale: number): void {
    const n = this.grid;
    const mag = this.mag;
    this.numPeaks = 0;
    for (let iy = 0; iy < n && this.numPeaks < MAX_PEAKS; iy++) {
      const fy = this.freqOf(iy);
      for (let ix = 0; ix < n; ix++) {
        const fx = this.freqOf(ix);
        // Canonical half-plane only: the other half is the conjugate.
        if (fy < 0 || (fy === 0 && fx <= 0)) continue;
        // Nyquist rows/columns have no distinct conjugate partner and their
        // parabolic neighbourhood wraps onto themselves — skip them, exactly
        // as the audio peak loop skips bin 0 and bin N/2-1.
        if (fy === n / 2 || fx === n / 2 || fx === -n / 2) continue;
        const c = mag[iy * n + ix]!;
        if (c < thr) continue;
        const xm = mag[iy * n + this.indexOf(fx - 1)]!;
        const xp = mag[iy * n + this.indexOf(fx + 1)]!;
        const ym = mag[this.indexOf(fy - 1) * n + ix]!;
        const yp = mag[this.indexOf(fy + 1) * n + ix]!;
        if (c < xm || c < xp || c < ym || c < yp) continue;
        // Diagonals too — an 8-neighbour maximum, so a ridge does not emit a
        // peak at every bin along it.
        const ixm = this.indexOf(fx - 1);
        const ixp = this.indexOf(fx + 1);
        const iym = this.indexOf(fy - 1);
        const iyp = this.indexOf(fy + 1);
        if (
          c < mag[iym * n + ixm]! ||
          c < mag[iym * n + ixp]! ||
          c < mag[iyp * n + ixm]! ||
          c < mag[iyp * n + ixp]!
        ) {
          continue;
        }

        const lc = Math.log(c + 1e-20);
        const dx = parabolicDelta(Math.log(xm + 1e-20), lc, Math.log(xp + 1e-20));
        const dy = parabolicDelta(Math.log(ym + 1e-20), lc, Math.log(yp + 1e-20));
        // Vertex height: the two axes' corrections are independent to first
        // order, so apply both.
        const vertex =
          lc -
          0.25 * (Math.log(xm + 1e-20) - Math.log(xp + 1e-20)) * dx -
          0.25 * (Math.log(ym + 1e-20) - Math.log(yp + 1e-20)) * dy;

        const p = this.numPeaks++;
        this.peakKx[p] = fx + dx;
        this.peakKy[p] = fy + dy;
        this.peakAmp[p] = Math.exp(vertex) * ampScale;
        this.peakPhase[p] = Math.atan2(this.im[iy * n + ix]!, this.re[iy * n + ix]!);
        if (this.numPeaks >= MAX_PEAKS) break;
      }
    }
  }

  private cullBySalience(): void {
    const nP = this.numPeaks;
    if (nP === 0) return;
    for (let p = 0; p < nP; p++) {
      this.peakSal[p] = wvPeakSalience(
        this.peakKx[p]!,
        this.peakKy[p]!,
        this.peakAmp[p]!,
        this.k0x,
        this.k0y,
        this.k0Conf,
        this.lock,
      );
    }
    const target = Math.min(nP, this.components);
    for (let i = 0; i < target; i++) {
      let best = i;
      for (let j = i + 1; j < nP; j++) if (this.peakSal[j]! > this.peakSal[best]!) best = j;
      if (best !== i) {
        swap(this.peakSal, i, best);
        swap(this.peakKx, i, best);
        swap(this.peakKy, i, best);
        swap(this.peakAmp, i, best);
        swap(this.peakPhase, i, best);
      }
    }
    this.numPeaks = target;
  }

  private applyLatticeLock(): void {
    const r0 = Math.hypot(this.k0x, this.k0y);
    if (!(this.lock > 1e-3 && r0 > 0.5)) return;
    const confNorm = Math.max(0, Math.min(1, (this.k0Conf - 1.3) / 1.1));
    const lock = this.lock * confNorm;
    if (lock <= 1e-3) return;
    for (let p = 0; p < this.numPeaks; p++) {
      const kx = this.peakKx[p]!;
      const ky = this.peakKy[p]!;
      const r = Math.hypot(kx, ky);
      const h = Math.round(r / r0);
      if (h < 1) continue;
      const sx = h * this.k0x;
      const sy = h * this.k0y;
      if (Math.hypot(kx - sx, ky - sy) / r > LATTICE_SNAP_TOL) continue;
      this.peakKx[p] = kx * (1 - lock) + sx * lock;
      this.peakKy[p] = ky * (1 - lock) + sy * lock;
    }
  }

  /** `matchTracks` (`warrensspectrum-dsp.ts:1107-1157`) in the plane. */
  private matchTracks(): void {
    this.matched.fill(0);
    for (let p = 0; p < this.numPeaks; p++) {
      const kx = this.peakKx[p]!;
      const ky = this.peakKy[p]!;
      const amp = this.peakAmp[p]!;
      const r = Math.hypot(kx, ky);
      let bestIdx = -1;
      let bestDist = MATCH_TOLERANCE;
      for (let a = 0; a < this.numActive; a++) {
        const i = this.activeIdx[a]!;
        if (!this.tAlive[i] || this.matched[i]) continue;
        const tr = Math.hypot(this.tKx[i]!, this.tKy[i]!);
        if (tr <= 0) continue;
        const rel = Math.hypot(this.tKx[i]! - kx, this.tKy[i]! - ky) / Math.max(tr, r);
        if (rel < bestDist) {
          bestDist = rel;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0) {
        // The wavevector itself moves at the commit rate (the audio slews
        // frequency with `freqCoefPerHop`; here a wavevector that jumped
        // would tear the picture, so it is a straight assignment at the
        // measured value — the SLEW control governs CONTRAST, as it does in
        // the audio bank).
        this.tKx[bestIdx] = kx;
        this.tKy[bestIdx] = ky;
        this.tAmpTarget[bestIdx] = amp;
        this.tPhaseMeas[bestIdx] = this.peakPhase[p]!;
        if (this.tFrames[bestIdx]! < 1000000) this.tFrames[bestIdx] = this.tFrames[bestIdx]! + 1;
        this.matched[bestIdx] = 1;
        continue;
      }
      let birth = -1;
      for (let i = 0; i < WV_MAX_COMPONENTS; i++) {
        if (!this.tAlive[i]) {
          birth = i;
          break;
        }
      }
      if (birth < 0) continue;
      this.tKx[birth] = kx;
      this.tKy[birth] = ky;
      this.tAmpTarget[birth] = amp;
      this.tPhaseMeas[birth] = this.peakPhase[p]!;
      this.tFrames[birth] = 1;
      // Phase is seated at BIRTH — the literal audio behaviour, and what
      // COHERENCE 0 leaves alone forever. Only reseat a slot that is already
      // dark, so a still-draining component does not jump.
      if (this.tAmp[birth]! < 1e-4) this.tPhase[birth] = this.peakPhase[p]!;
      // ω ∝ |k|: fine detail boils, coarse structure drifts. Signed by a
      // deterministic hash so components do not all move as one rigid sheet.
      this.tOmega[birth] = hashSign(kx, ky) * Math.hypot(kx, ky);
      this.tAlive[birth] = 1;
      this.matched[birth] = 1;
    }
    for (let i = 0; i < WV_MAX_COMPONENTS; i++) {
      if (this.tAlive[i] && !this.matched[i]) {
        this.tAmpTarget[i] = 0;
        this.tAlive[i] = 0;
        this.tFrames[i] = 0;
      }
    }
    this.rebuildActiveIndex();
  }

  /**
   * COHERENCE. The one mechanism with no audio counterpart, and the module's
   * whole artistic range.
   *
   * At 1 every live component's phase is REPLACED by the phase measured at
   * its wavevector this commit — the sparse sum is then a genuine (band-
   * limited, top-N) reconstruction of the source and reads as a picture. At 0
   * nothing here runs and phases free-run from birth, which is exactly what
   * the audio oscillator bank does. Between, the pull is a shortest-arc
   * fraction, so structure assembles over several commits and decays between
   * them.
   */
  private servoPhases(): void {
    const g = this.coherence;
    if (g <= 0) return;
    for (let a = 0; a < this.numActive; a++) {
      const i = this.activeIdx[a]!;
      if (!this.tAlive[i]) continue;
      const d = wrapPi(this.tPhaseMeas[i]! - this.tPhase[i]!);
      this.tPhase[i] = this.tPhase[i]! + d * g;
    }
  }

  private updateRingTargets(): void {
    const n = this.grid;
    this.claimed.fill(0);
    const R = RESIDUAL_MASK_RADIUS;
    for (let p = 0; p < this.numPeaks; p++) {
      const cx = Math.round(this.peakKx[p]!);
      const cy = Math.round(this.peakKy[p]!);
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          if (dx * dx + dy * dy > R * R) continue;
          // Mask the conjugate too — it carries the same energy.
          this.claimed[this.indexOf(cy + dy) * n + this.indexOf(cx + dx)] = 1;
          this.claimed[this.indexOf(-cy - dy) * n + this.indexOf(-cx - dx)] = 1;
        }
      }
    }
    // DC is never residual.
    this.claimed[0] = 1;
    this.ringTarget.fill(0);
    const scale = 1 / (n * n);
    for (let iy = 0; iy < n; iy++) {
      const fy = this.freqOf(iy);
      for (let ix = 0; ix < n; ix++) {
        if (this.claimed[iy * n + ix]) continue;
        const fx = this.freqOf(ix);
        const r = Math.hypot(fx, fy);
        if (r < 1) continue;
        let ring = WV_RESIDUAL_RINGS - 1;
        for (let b = 0; b < WV_RESIDUAL_RINGS; b++) {
          if (r < this.ringEdges[b + 1]!) {
            ring = b;
            break;
          }
        }
        const m = this.mag[iy * n + ix]!;
        this.ringTarget[ring] = this.ringTarget[ring]! + m * m;
      }
    }
    for (let b = 0; b < WV_RESIDUAL_RINGS; b++) {
      this.ringTarget[b] = Math.sqrt(this.ringTarget[b]!) * scale;
    }
    // Freeze the claim mask into half-plane order so synthesis does not have
    // to re-derive it every frame.
    for (let h = 0; h < this.halfCount; h++) {
      this.halfUnclaimed[h] = this.claimed[this.halfIdx[h]!] ? 0 : 1;
    }
  }


  private rebuildActiveIndex(): void {
    let n = 0;
    for (let i = 0; i < WV_MAX_COMPONENTS; i++) {
      if (this.tAlive[i] || this.tAmp[i]! > 1e-7 || this.tAmpTarget[i]! > 1e-9) {
        this.activeIdx[n++] = i;
      }
    }
    this.numActive = n;
  }

  // ---- per-frame advance ----

  /**
   * Advance contrast envelopes, DC and free-running phase by `dtSec`. Runs on
   * EVERY rendered frame, commit or not, which is what keeps the picture
   * moving between the (slower) analysis commits.
   */
  advance(dtSec: number): void {
    const dt = Math.max(0, Math.min(0.1, dtSec));
    if (dt <= 0) return;
    const ampCoef = 1 - Math.exp(-dt / this.slewSeconds);
    const envCoef = 1 - Math.exp(-dt / 0.05);
    this.dc += (this.dcTarget - this.dc) * ampCoef;
    for (let b = 0; b < WV_RESIDUAL_RINGS; b++) {
      this.ringEnv[b] = this.ringEnv[b]! + (this.ringTarget[b]! - this.ringEnv[b]!) * envCoef;
    }
    const om = this.drift * 2 * Math.PI * dt;
    // The residual rings boil at the same DRIFT rate, scaled by ring index so
    // fine texture churns faster than coarse — the same ω ∝ |k| law the
    // components follow.
    if (om > 0) {
      for (let b = 0; b < WV_RESIDUAL_RINGS; b++) {
        this.ringPhase[b] = this.ringPhase[b]! + om * (b + 1) * 0.25;
      }
    }
    let drained = false;
    for (let a = 0; a < this.numActive; a++) {
      const i = this.activeIdx[a]!;
      const amp0 = this.tAmp[i]!;
      const target = this.tAmpTarget[i]!;
      if (!this.tAlive[i] && amp0 < 1e-7 && target < 1e-9) {
        drained = true;
        continue;
      }
      this.tAmp[i] = amp0 + (target - amp0) * ampCoef;
      if (om > 0) this.tPhase[i] = this.tPhase[i]! + this.tOmega[i]! * om;
    }
    if (drained) this.rebuildActiveIndex();
  }

  // ---- synthesis ----

  /**
   * Write the reconstructed luma plane into `out` (`grid*grid`, row-major).
   *
   * Builds the sparse spectrum — one conjugate pair per component, plus its
   * SHAPE harmonics — and inverse-transforms it. That is O(N² log N) in the
   * GRID regardless of the output resolution, which is the property that
   * makes this affordable on a software renderer.
   */
  synthesize(out: Float32Array): WvFieldStats {
    const n = this.grid;
    const re = this.sre;
    const im = this.sim;
    re.fill(0);
    im.fill(0);

    // DC.
    re[0] = this.dc * n * n;

    const ratio = this.transposeRatio;
    const limit = n / 2;
    const rampStart = limit * ALIAS_RAMP_START;
    const rampEnd = limit * ALIAS_RAMP_END;
    const rampSpan = rampEnd - rampStart;
    const minBirth = this.minBirthFrames;
    const maxH = this.shape > 1e-4 ? WV_MAX_HARMONICS : 1;
    let live = 0;

    for (let a = 0; a < this.numActive; a++) {
      const i = this.activeIdx[a]!;
      const amp = this.tAmp[i]!;
      if (amp <= 1e-6) continue;

      // STABILITY: a component must have been matched on `minBirthFrames`
      // consecutive commits before it is visible; ramp so it fades in.
      let stability = 1;
      const frames = this.tFrames[i]!;
      if (minBirth > 1 && frames < minBirth) stability = frames / minBirth;
      if (stability <= 0) continue;

      const baseKx = this.tKx[i]! * ratio;
      const baseKy = this.tKy[i]! * ratio;
      const phase = this.tPhase[i]!;
      let contributed = false;

      for (let h = 1; h <= maxH; h++) {
        const hw = wvHarmonicWeight(h, this.shape);
        if (hw <= 1e-4) continue;
        const kx = baseKx * h;
        const ky = baseKy * h;
        const r = Math.hypot(kx, ky);
        // Exact band-limiting: past the grid limit the harmonic is simply not
        // written. The ramp below it mirrors the audio's alias fade.
        if (r >= rampEnd || r < 0.5) continue;
        let aliasGain = 1;
        if (r > rampStart) aliasGain = (rampEnd - r) / rampSpan;

        const gain = amp * stability * hw * aliasGain;
        if (gain <= 1e-7) continue;

        // A real cosine of amplitude `g` and phase `p` at wavevector k is the
        // conjugate pair (g·N²/2)·e^{ip} at +k and its conjugate at −k.
        const half = (gain * n * n) / 2;
        const ph = phase * h;
        const cr = half * Math.cos(ph);
        const ci = half * Math.sin(ph);
        const ixp = this.indexOf(kx);
        const iyp = this.indexOf(ky);
        const ixn = this.indexOf(-kx);
        const iyn = this.indexOf(-ky);
        const pIdx = iyp * n + ixp;
        const nIdx = iyn * n + ixn;
        re[pIdx] = re[pIdx]! + cr;
        im[pIdx] = im[pIdx]! + ci;
        if (nIdx !== pIdx) {
          re[nIdx] = re[nIdx]! + cr;
          im[nIdx] = im[nIdx]! - ci;
        }
        contributed = true;
      }
      if (contributed) live++;
    }

    // ---- SMS residual, in the spectral domain -------------------------
    // Every UNCLAIMED bin gets the fixed noise plane's phase at that bin,
    // scaled by its ring's smoothed energy, rotated by the ring's drift
    // angle. Writing the conjugate partner keeps the plane real.
    const rFraction = Math.max(
      0,
      Math.min(1, (this.components - 1) / (WV_MAX_COMPONENTS - 1)),
    );
    const rLevel = this.residual * Math.cbrt(rFraction);
    if (rLevel > 1e-4) {
      const gain = this.ringGainScratch;
      const cs = this.ringCosScratch;
      const sn = this.ringSinScratch;
      let anyRing = false;
      for (let b = 0; b < WV_RESIDUAL_RINGS; b++) {
        const g = this.ringEnv[b]! * rLevel * this.ringNorm[b]! * n * n;
        gain[b] = g;
        cs[b] = Math.cos(this.ringPhase[b]!);
        sn[b] = Math.sin(this.ringPhase[b]!);
        if (g > 1e-7) anyRing = true;
      }
      if (anyRing) {
        for (let h = 0; h < this.halfCount; h++) {
          if (!this.halfUnclaimed[h]) continue;
          const ring = this.halfRing[h]!;
          const g = gain[ring]!;
          if (g <= 1e-7) continue;
          const i = this.halfIdx[h]!;
          const nr = this.noiseRe[i]!;
          const ni = this.noiseIm[i]!;
          const c = cs[ring]!;
          const s = sn[ring]!;
          const vr = g * (nr * c - ni * s);
          const vi = g * (nr * s + ni * c);
          re[i] = re[i]! + vr;
          im[i] = im[i]! + vi;
          const j = this.conjIdx[h]!;
          re[j] = re[j]! + vr;
          im[j] = im[j]! - vi;
        }
      }
    }

    wvFft2d(this.fft, re, im, n, true);

    let mn = Infinity;
    let mx = -Infinity;
    for (let i = 0; i < this.cells; i++) {
      const v = re[i]!;
      out[i] = v;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    return { min: mn, max: mx, live };
  }

  /**
   * The 16 ring gains the texture pass consumes, smoothed. Scaled by the
   * RESIDUAL control and by cbrt of the component fraction, so thinning the
   * bank also cleans up the grain — `SpectralResynth.cpp:898-907`.
   */
  residualGains(out: Float32Array): void {
    const fraction = Math.max(
      0,
      Math.min(1, (this.components - 1) / (WV_MAX_COMPONENTS - 1)),
    );
    const g = this.residual * Math.cbrt(fraction);
    for (let b = 0; b < WV_RESIDUAL_RINGS; b++) out[b] = this.ringEnv[b]! * g;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function parabolicDelta(lm1: number, lm: number, lm2: number): number {
  const denom = lm1 - 2 * lm + lm2;
  let d = 0;
  if (Math.abs(denom) > 1e-12) d = (0.5 * (lm1 - lm2)) / denom;
  if (d < -0.5) d = -0.5;
  else if (d > 0.5) d = 0.5;
  return d;
}

function swap(a: Float32Array, i: number, j: number): void {
  const t = a[i]!;
  a[i] = a[j]!;
  a[j] = t;
}

function wrapPi(a: number): number {
  const twoPi = 2 * Math.PI;
  let x = a % twoPi;
  if (x > Math.PI) x -= twoPi;
  else if (x < -Math.PI) x += twoPi;
  return x;
}

/** Deterministic ±1 from a wavevector — the DRIFT direction. Stable across
 *  frames for the same component, so a drifting picture does not jitter. */
function hashSign(kx: number, ky: number): number {
  const h = Math.sin(Math.round(kx) * 12.9898 + Math.round(ky) * 78.233) * 43758.5453;
  return h - Math.floor(h) < 0.5 ? -1 : 1;
}
