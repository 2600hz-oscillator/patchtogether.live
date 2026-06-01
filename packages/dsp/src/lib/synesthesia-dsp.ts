// packages/dsp/src/lib/synesthesia-dsp.ts
//
// SYNESTHESIA — shared DSP for the audio-analysis module. Lives under lib/ so
// esbuild inlines it into the worklet entry (packages/dsp/src/synesthesia.ts);
// lib/ files MAY export freely. Also imported directly by the unit + ART tests
// so band-filtering / envelope / gate behaviour is verifiable without spinning
// up an AudioWorklet (the same pattern as renderResofilter()).
//
// Splits a mono signal into 4 spectral bands (0–200, 201–500, 501–2000, 2000+),
// applies a per-band gain combined with a master "floor" gain, and derives a
// fast + slow envelope follower, a gate, and a VU meter level per band. All
// state is per-instance so two independent copies (A/B) never share state.

import { svfStep, cutoffToG, makeSvfState, type SvfState } from './resofilter-dsp';

/** Crossover frequencies (Hz). 4 bands: [0,200] (200,500] (500,2000] (2000,∞). */
export const SYN_BAND_EDGES = [200, 500, 2000] as const;
export const SYN_NUM_BANDS = 4;

/** Envelope-follower release times (ms) — see module spec. */
export const ENV_FAST_MS = 50;
export const ENV_SLOW_MS = 500;

// Butterworth damping (Q≈0.707 → k = 1/Q = √2). Cascading two such 2nd-order
// SVF stages per crossover edge gives a ~24 dB/oct Linkwitz-Riley-style slope —
// steep enough that a test tone one band away is well rejected.
const K_BUTTERWORTH = Math.SQRT2;

/**
 * Combined per-band gain. The master gain (0.5..1.5, unity at 12:00) raises or
 * lowers the floor; the per-band gain (1..2) adds on top, clamped at 0:
 *   effGain = max(0, master + (bandGain - 1))
 */
export function combinedGain(master: number, bandGain: number): number {
  const g = master + (bandGain - 1);
  return g < 0 ? 0 : g;
}

// A 24 dB/oct cascade = two SVF stages picking the same tap.
interface TwoStage {
  s1: SvfState;
  s2: SvfState;
}
function makeTwoStage(): TwoStage {
  return { s1: makeSvfState(), s2: makeSvfState() };
}
function lp2(x: number, g: number, st: TwoStage): number {
  const a = svfStep(x, g, K_BUTTERWORTH, st.s1).lp;
  return svfStep(a, g, K_BUTTERWORTH, st.s2).lp;
}
function hp2(x: number, g: number, st: TwoStage): number {
  const a = svfStep(x, g, K_BUTTERWORTH, st.s1).hp;
  return svfStep(a, g, K_BUTTERWORTH, st.s2).hp;
}

export interface BandSplitter {
  /** Split one input sample into [band1, band2, band3, band4]. Mutates state. */
  split(x: number): [number, number, number, number];
}

/**
 * Build a 4-band splitter for the given sample rate. Bands:
 *   b1 = LP 200            (0–200 Hz)
 *   b2 = HP 200 → LP 500   (200–500 Hz)
 *   b3 = HP 500 → LP 2000  (500–2000 Hz)
 *   b4 = HP 2000           (2000+ Hz)
 * Each LP/HP is a 24 dB/oct two-stage SVF cascade.
 */
export function makeBandSplitter(sr: number): BandSplitter {
  const g200 = cutoffToG(SYN_BAND_EDGES[0], sr);
  const g500 = cutoffToG(SYN_BAND_EDGES[1], sr);
  const g2000 = cutoffToG(SYN_BAND_EDGES[2], sr);
  const b1lp = makeTwoStage();
  const b2hp = makeTwoStage();
  const b2lp = makeTwoStage();
  const b3hp = makeTwoStage();
  const b3lp = makeTwoStage();
  const b4hp = makeTwoStage();
  return {
    split(x: number): [number, number, number, number] {
      const b1 = lp2(x, g200, b1lp);
      const b2 = lp2(hp2(x, g200, b2hp), g500, b2lp);
      const b3 = lp2(hp2(x, g500, b3hp), g2000, b3lp);
      const b4 = hp2(x, g2000, b4hp);
      return [b1, b2, b3, b4];
    },
  };
}

/**
 * Peak envelope follower: instant attack, exponential release over `releaseMs`.
 * After `releaseMs` of silence the envelope decays to 1/e (~0.368) of its peak.
 */
export class EnvFollower {
  private env = 0;
  private readonly decay: number;
  constructor(sr: number, releaseMs: number) {
    this.decay = Math.exp(-1 / ((releaseMs / 1000) * sr));
  }
  step(x: number): number {
    const a = x < 0 ? -x : x;
    this.env = a > this.env ? a : this.env * this.decay;
    return this.env;
  }
}

/**
 * Schmitt-trigger gate driven by an envelope value: goes high when the envelope
 * crosses `thrHigh`, low when it falls back below `thrLow`. Returns 1 or 0.
 */
export class GateDetector {
  private on = false;
  constructor(
    private readonly thrHigh = 0.05,
    private readonly thrLow = 0.02,
  ) {}
  step(env: number): number {
    if (!this.on && env >= this.thrHigh) this.on = true;
    else if (this.on && env < this.thrLow) this.on = false;
    return this.on ? 1 : 0;
  }
}

/**
 * VU meter ballistics: fast attack, slower release, output 0..1. Maps the band
 * amplitude to a meter value the UI scales into 10 segments.
 */
export class MeterBallistics {
  private m = 0;
  private readonly att: number;
  private readonly rel: number;
  constructor(sr: number, attackMs = 10, releaseMs = 300) {
    this.att = 1 - Math.exp(-1 / ((attackMs / 1000) * sr));
    this.rel = 1 - Math.exp(-1 / ((releaseMs / 1000) * sr));
  }
  step(x: number): number {
    const a = x < 0 ? -x : x;
    const coef = a > this.m ? this.att : this.rel;
    this.m += coef * (a - this.m);
    return this.m > 1 ? 1 : this.m;
  }
}

export interface SynesthesiaRender {
  audio: Float32Array[];
  envSlow: Float32Array[];
  envFast: Float32Array[];
  gate: Float32Array[];
  level: Float32Array[];
}

/**
 * Pure offline render of ONE copy of the SYNESTHESIA circuit. Used by unit
 * tests and ART. Returns per-band arrays (4 entries each, length input.length).
 */
export function renderSynesthesia(
  input: Float32Array,
  opts: { sr: number; master?: number; gains?: [number, number, number, number] },
): SynesthesiaRender {
  const { sr } = opts;
  const master = opts.master ?? 1;
  const gains = opts.gains ?? [1, 1, 1, 1];
  const n = input.length;
  const splitter = makeBandSplitter(sr);
  const idx = [0, 1, 2, 3];
  const mk = (): Float32Array[] => idx.map(() => new Float32Array(n));
  const audio = mk(), envSlow = mk(), envFast = mk(), gate = mk(), level = mk();
  const fast = idx.map(() => new EnvFollower(sr, ENV_FAST_MS));
  const slow = idx.map(() => new EnvFollower(sr, ENV_SLOW_MS));
  const gates = idx.map(() => new GateDetector());
  const meters = idx.map(() => new MeterBallistics(sr));
  for (let i = 0; i < n; i++) {
    const bands = splitter.split(input[i] ?? 0);
    for (let b = 0; b < SYN_NUM_BANDS; b++) {
      const g = combinedGain(master, gains[b] ?? 1);
      const a = (bands[b] as number) * g;
      audio[b]![i] = a;
      const ef = fast[b]!.step(a);
      envFast[b]![i] = ef;
      envSlow[b]![i] = slow[b]!.step(a);
      gate[b]![i] = gates[b]!.step(ef);
      level[b]![i] = meters[b]!.step(a);
    }
  }
  return { audio, envSlow, envFast, gate, level };
}
