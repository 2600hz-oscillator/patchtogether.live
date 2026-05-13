// packages/web/src/lib/audio/warrenspectrum-math.ts
//
// Pure DSP math used by the WARRENSPECTRUM worklet (packages/dsp/src/
// warrenspectrum.ts). Mirrored here so unit tests can pin the bleed
// matrix, the vactrol envelope shape, and the biquad bandpass coeffs
// without spinning an AudioWorkletGlobalScope.
//
// The worklet has its own private copies of these functions — any
// change here must be mirrored there. The unit tests assert behavior,
// not provenance.

export const WARRENSPECTRUM_NUM_BANDS = 8;
export const WARRENSPECTRUM_Q = 6.0;
export const WARRENSPECTRUM_CENTER_HZ = [80, 160, 320, 640, 1280, 2560, 5120, 10240] as const;
export const WARRENSPECTRUM_BLEED = [1.0, 0.35, 0.12] as const;

/** Tuning modes for the 8 bandpass centers.
 *  - 'log': fixed octave-spaced 80..10240 Hz (legacy spectral-EQ behavior).
 *  - 'harm': harmonic partials f[i] = rootHz * (i+1), root chosen by the
 *    `root` param (MIDI note number → Hz). Mimics Rings-style modal resonators. */
export type WarrenspectrumTuning = 'log' | 'harm';

/** Default root for harmonic mode = MIDI 60 = C4 (middle C, ~261.63 Hz). */
export const WARRENSPECTRUM_ROOT_DEFAULT_MIDI = 60;

/** MIDI note → Hz. A4 = 69 = 440. */
export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Center frequency for band index `i` (0..7) given mode + root MIDI. */
export function bandCenterHz(mode: WarrenspectrumTuning, rootMidi: number, i: number): number {
  if (mode === 'harm') {
    const rootHz = midiToHz(rootMidi);
    return rootHz * (i + 1);
  }
  return WARRENSPECTRUM_CENTER_HZ[i] ?? 0;
}

/** Equal-power constant-power pan. position is -1 (left) .. +1 (right). */
export function panGains(position: number): { l: number; r: number } {
  const p = Math.max(-1, Math.min(1, position));
  const theta = ((p + 1) / 2) * (Math.PI / 2);
  return { l: Math.cos(theta), r: Math.sin(theta) };
}

/** Pan position for band `i` with spread amount `s` (0..1).
 *  Even bands lean left, odd bands lean right; magnitude scales with
 *  distance from the band-array center so outer bands at spread=1 are
 *  fully hard-panned, and at spread=0 every band is centered (mono). */
export function bandPanPosition(i: number, n: number, spread: number): number {
  const center = (n - 1) / 2;
  const dist = Math.abs(i - center) / center; // 0 at center, 1 at edges
  const sign = i % 2 === 0 ? -1 : 1;
  const v = sign * dist * spread;
  return v === 0 ? 0 : Math.max(-1, Math.min(1, v));
}

export interface VactrolEnv {
  excitation: number;
  env: number;
  attackProgress: number;
  attackSamples: number;
  decayCoef: number;
  phase: 0 | 1 | 2;
  prevGate: number;
  /** Fast broadband click amplitude — decays per-sample at ~1ms. The
   *  worklet injects this into the bandpass to make it ring at fc.
   *  Mirrored here so the ART test can reproduce the worklet's
   *  signal-injection path exactly. */
  click: number;
}

export function makeEnv(): VactrolEnv {
  return {
    excitation: 0,
    env: 0,
    attackProgress: 0,
    attackSamples: 0,
    decayCoef: 0,
    phase: 0,
    prevGate: 0,
    click: 0,
  };
}

export function bleedWeight(n: number, k: number): number {
  const d = Math.abs(n - k);
  if (d >= WARRENSPECTRUM_BLEED.length) return 0;
  return WARRENSPECTRUM_BLEED[d]!;
}

export function vactrolShape(env: number, drive: number): number {
  return Math.tanh(env * drive) / Math.tanh(drive);
}

export function applyPing(
  envs: VactrolEnv[],
  n: number,
  pingDecaySec: number,
  attackMsBase: number,
  sr: number,
  rand: () => number,
): void {
  for (let k = 0; k < envs.length; k++) {
    const w = bleedWeight(n, k);
    if (w === 0) continue;
    const e = envs[k]!;
    e.excitation = Math.min(1.5, e.excitation + w);
    const aJ = 1 + (rand() - 0.5) * 0.2;
    const dJ = 1 + (rand() - 0.5) * 0.2;
    const attackMs = attackMsBase * aJ;
    const decaySec = Math.max(0.01, pingDecaySec * dJ);
    e.attackSamples = Math.max(1, Math.round((attackMs / 1000) * sr));
    e.attackProgress = 0;
    e.decayCoef = Math.exp(-1 / (decaySec * sr));
    e.phase = 1;
    e.click = Math.max(e.click, w * 0.8);
  }
}

/**
 * Step the per-sample click decay (independent of the slow vactrol
 * envelope). Returns the click amplitude BEFORE decay; mutates the
 * env so subsequent samples see a smaller click. ~1ms time constant
 * at 48kHz.
 */
export function stepClick(e: VactrolEnv): number {
  const c = e.click;
  e.click = e.click * 0.98;
  if (e.click < 1e-5) e.click = 0;
  return c;
}

export function stepEnv(e: VactrolEnv, drive: number): number {
  if (e.phase === 0) {
    e.env = 0;
    return 0;
  }
  if (e.phase === 1) {
    e.attackProgress += 1;
    const r = e.attackProgress / e.attackSamples;
    if (r >= 1) {
      e.env = e.excitation;
      e.phase = 2;
    } else {
      e.env = e.excitation * r;
    }
  } else {
    e.env = e.env * e.decayCoef;
    e.excitation = e.excitation * e.decayCoef;
    if (e.env < 1e-5) {
      e.env = 0;
      e.excitation = 0;
      e.phase = 0;
    }
  }
  return vactrolShape(e.env, drive);
}

export interface BiquadCoeffs {
  b0: number; b1: number; b2: number;
  a1: number; a2: number;
}

/** RBJ cookbook bandpass — constant 0dB peak, log-symmetric skirts. */
export function biquadBpfCoeffs(fc: number, q: number, sr: number): BiquadCoeffs {
  const w0 = (2 * Math.PI * fc) / sr;
  const cosW = Math.cos(w0);
  const sinW = Math.sin(w0);
  const alpha = sinW / (2 * q);
  const b0 = alpha;
  const b1 = 0;
  const b2 = -alpha;
  const a0 = 1 + alpha;
  const a1 = -2 * cosW;
  const a2 = 1 - alpha;
  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
  };
}
