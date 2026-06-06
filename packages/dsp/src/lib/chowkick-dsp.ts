// packages/dsp/src/lib/chowkick-dsp.ts
//
// CHOWKICK — pure DSP helpers for the kick voice. Lives in `lib/` so esbuild
// inlines it into packages/dsp/src/chowkick.ts at build time (the top-level
// .ts file in packages/dsp/src/ is the worklet entry; its helpers go here
// and `export` freely — see project memory `dsp-worklet-no-top-level-export`).
//
// ─────────────────────────────────────────────────────────────────────────
// Canonical references (BSD-3-Clause):
//   ChowKick by Jatin Chowdhury / chowdsp — github.com/Chowdhury-DSP/ChowKick
//     - src/dsp/PulseShaper.{h,cpp}     — WDF diode-RC pulse with sustain
//                                          (modeled here behaviourally; the
//                                          upstream WDF circuit reduces to a
//                                          decaying-square envelope with a
//                                          sustain floor that the user can
//                                          probe in plain English on the
//                                          source plugin's UI).
//     - src/dsp/Noise.{h,cpp}            — gated noise burst → state-variable
//                                          LPF; the noise type maps to chow's
//                                          chowdsp::Noise template variants
//                                          (Uniform/Gaussian/Pink/Velvet).
//     - src/dsp/ResonantFilter.{h,cpp}   — 2nd-order peaking IIR; G mapped
//                                          exponentially from `damping`
//                                          (G = 0.0001 * (0.5/0.0001)^damp).
//     - src/dsp/ResonantFilterProcs.h    — BouncyFilterProc + tanh saturation
//                                          driven by `tight` + `bounce`
//                                          (d1, d2, d3 from getDriveValues).
//     - src/dsp/OutputFilter.{h,cpp}     — first-order LPF + linear level.
//     - src/dsp/Trigger.{h,cpp}          — width / amp / portamento glide.
// ─────────────────────────────────────────────────────────────────────────
//
// Signal flow (matches the source plugin's block diagram):
//
//   gate_in (rising edge) ──► Trigger (width, amp)
//                                    │
//                                    ▼
//                             PulseShaper (decay, sustain)
//                                    │              │
//                                    │              ▼
//                                    │      Noise burst (amount, decay,
//                                    │      cutoff, type)
//                                    │              │
//                                    └────► sum ◄───┘
//                                              │
//                                              ▼
//                             Resonant 2nd-order peaking IIR
//                              (freq + pitch_cv via 1V/oct, Q, damping,
//                               tight + bounce → tanh saturation)
//                                              │
//                                              ▼
//                              First-order LPF (tone) × level (dB→lin)
//                                              │
//                                              ▼
//                                          audio_out
//
// Determinism: all helpers are state-only-via-explicit-state-objects so the
// unit tests can pin per-sample math without touching the worklet itself.

// ─────────────────────────────────────────────────────────────────────────
// Constants + small helpers
// ─────────────────────────────────────────────────────────────────────────

/** Frequency (Hz) corresponding to 1V/oct = 0V (C4 = 261.63 Hz in this
 *  codebase's 1V/oct convention; see analog-vco.ts). We multiply the knob
 *  freq by 2^pitch_cv so pitch_cv = +1V doubles the resonator freq. */
export const PITCH_CV_BASE_HZ = 1; // a multiplier — knobs carry the absolute Hz.

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Linear interpolate two values by a 0..1 mix. */
export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ─────────────────────────────────────────────────────────────────────────
// Trigger / Pulse shaper
//
// Source: ChowKick/src/dsp/PulseShaper.cpp. The upstream impl is a Wave
// Digital Filter circuit (diode + capacitor) — too involved to port
// faithfully, but the upstream README + the visible envelope on the source
// plugin's UI show the behavior reduces to:
//
//   1. on gate rising edge, jump to `amp` and hold for `width` ms (square);
//   2. after `width` ms, decay exponentially with time constant
//      tau = mapDecayKnobToTau(decay), toward `sustain` (the floor);
//   3. when gate falls (we treat gate>=0.5 as "high"), continue decaying
//      toward 0 (sustain is the floor while held; when released, the
//      whole envelope decays to silence).
//
// `decay` knob is 0..1 (0..100%); tau ∈ [1ms, 200ms] log-mapped so the
// shortest decay is a percussive click and the longest is a tom-like body.
//
// `sustain` knob is 0..1; floor amplitude is `sustain * amp` (units pinned
// to the pulse amplitude so 100% sustain = held square pulse).
// ─────────────────────────────────────────────────────────────────────────

export interface PulseState {
  /** 0 = idle, 1 = holding (in `width` window), 2 = decaying. */
  phase: 0 | 1 | 2;
  /** Samples remaining in the hold window. */
  holdRemain: number;
  /** Last-sample pulse-shaper output. */
  y: number;
  /** Last-sample gate value (for edge detection). */
  gatePrev: number;
}

export function makePulseState(): PulseState {
  return { phase: 0, holdRemain: 0, y: 0, gatePrev: 0 };
}

/** Map the 0..1 decay knob to an exponential time constant (seconds). */
export function decayKnobToTau(decay01: number): number {
  // 1 ms .. 200 ms log span. At decay=0 → tau=1ms (super-snappy click);
  // at decay=1 → tau=200ms (long boom). decay=0.5 → ~14ms.
  const lo = 0.001;
  const hi = 0.2;
  const d = clamp(decay01, 0, 1);
  return lo * Math.pow(hi / lo, d);
}

/** Per-sample pulse shaper step. Returns the new pulse amplitude.
 *
 *  gate: current gate sample (>= 0.5 == high).
 *  width_ms: pulse width knob in milliseconds (0.1..50).
 *  amp: pulse amplitude knob (0..2.0 in the source plugin's ±200% range).
 *  decay01: pulse decay knob (0..1).
 *  sustain01: pulse sustain knob (0..1).
 *  sr: sample rate.
 */
export function pulseShaperStep(
  gate: number,
  width_ms: number,
  amp: number,
  decay01: number,
  sustain01: number,
  sr: number,
  state: PulseState,
): number {
  const gateHigh = gate >= 0.5;
  const gatePrevHigh = state.gatePrev >= 0.5;
  state.gatePrev = gate;

  // Rising edge → enter hold phase.
  if (gateHigh && !gatePrevHigh) {
    state.phase = 1;
    state.holdRemain = Math.max(1, Math.round((width_ms / 1000) * sr));
    state.y = amp;
    return state.y;
  }

  // Holding the square.
  if (state.phase === 1) {
    state.holdRemain--;
    state.y = amp;
    if (state.holdRemain <= 0) state.phase = 2;
    return state.y;
  }

  // Decaying.
  if (state.phase === 2 || state.y !== 0) {
    const tau = decayKnobToTau(decay01);
    // One-pole decay coefficient: y[n] = a * y[n-1] + (1-a) * floor.
    const a = Math.exp(-1 / (tau * sr));
    // Floor: while gate is HIGH the floor is `sustain * amp`. When gate
    // falls, the floor drops to 0 (envelope releases). This matches the
    // upstream PulseShaper behavior — sustain is a per-pulse plateau, not
    // a held-amp like ADSR's release-to-0.
    const floor = gateHigh ? sustain01 * amp : 0;
    state.y = a * state.y + (1 - a) * floor;
    // Snap very small to 0 + drop to idle (denormal hygiene + clean state).
    if (!gateHigh && Math.abs(state.y) < 1e-6) {
      state.y = 0;
      state.phase = 0;
    }
    return state.y;
  }

  return 0;
}

// ─────────────────────────────────────────────────────────────────────────
// Noise burst
//
// Source: ChowKick/src/dsp/Noise.cpp. The upstream impl gates an internal
// noise generator with a multiplicative smoother (decay) and runs it
// through a state-variable LPF (cutoff). NoiseType selects:
//   0 = Uniform   — white-rectangular (chowdsp::Noise::Uniform)
//   1 = Gaussian  — Box-Muller white (chowdsp::Noise::Normal)
//   2 = Pink      — 1/f via Voss-McCartney (5-octave) approximation
//   3 = Velvet    — sparse +1/-1 impulses (Faust ne.velvet equiv.)
//
// We port the noise generators in pure JS using a seeded xorshift32 PRNG
// so the per-sample math is deterministic per voice (matches the upstream
// "Noise" instance owning its own RNG state).
// ─────────────────────────────────────────────────────────────────────────

export type NoiseType = 0 | 1 | 2 | 3; // Uniform / Gaussian / Pink / Velvet

export interface NoiseState {
  /** xorshift32 state. Initialized to a non-zero deterministic seed. */
  rng: number;
  /** Gated burst envelope (multiplicative; 0 = silent, 1 = full). */
  env: number;
  /** Pink-noise Voss-McCartney accumulators (5 octaves). */
  pinkBuf: Float32Array;
  /** Pink-noise update counter. */
  pinkCounter: number;
  /** Velvet sample counter (impulses every velvetPeriod samples). */
  velvetCounter: number;
  /** SVF LPF state. */
  svfZ1: number;
  svfZ2: number;
}

export function makeNoiseState(seed = 0xC0FFEE): NoiseState {
  return {
    rng: seed >>> 0,
    env: 0,
    pinkBuf: new Float32Array(5),
    pinkCounter: 0,
    velvetCounter: 0,
    svfZ1: 0,
    svfZ2: 0,
  };
}

/** xorshift32. Returns a uniform [-1, +1] sample + advances state. */
export function xorshift32Bipolar(state: NoiseState): number {
  let x = state.rng;
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5; x >>>= 0;
  state.rng = x >>> 0;
  // 32-bit unsigned → [-1, +1).
  return (x / 0x80000000) - 1;
}

/** Box-Muller Gaussian — two uniforms in → one Gaussian sample out. We
 *  burn one uniform per call (instead of caching the pair) — at audio
 *  rate the extra div is in the noise floor of the worklet's per-sample
 *  budget. Output stddev ≈ 1 (clipped to ±3 for click-safety). */
export function gaussianStep(state: NoiseState): number {
  // u1 ∈ (0,1) to avoid log(0); use the rng to step uniform [-1,1] and
  // remap.
  const u1raw = (xorshift32Bipolar(state) + 1) * 0.5;
  const u1 = Math.max(1e-9, u1raw);
  const u2 = (xorshift32Bipolar(state) + 1) * 0.5;
  const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  // Tame the long tail so a stray ±5σ event doesn't pop the LPF.
  return clamp(g * 0.4, -1, 1);
}

/** Voss-McCartney 1/f-ish pink. 5 octaves; each octave updates on a
 *  geometric-2 counter. Output divided by 5 to keep ≈ [-1, +1]. */
export function pinkStep(state: NoiseState): number {
  state.pinkCounter = (state.pinkCounter + 1) | 0;
  // Find lowest bit that changed since the last call (octave index).
  let bit = 0;
  let v = state.pinkCounter;
  while ((v & 1) === 0 && bit < 4) { v >>= 1; bit++; }
  state.pinkBuf[bit] = xorshift32Bipolar(state);
  let sum = 0;
  for (let i = 0; i < 5; i++) sum += state.pinkBuf[i] ?? 0;
  return sum * 0.2;
}

/** Velvet noise — sparse ±1 impulses, zero otherwise. Density set to ~1
 *  impulse per ~20 samples (matches Faust ne.velvet default density).
 *  Cheap + perceptually "smooth" — great for transient padding. */
export function velvetStep(state: NoiseState): number {
  state.velvetCounter--;
  if (state.velvetCounter > 0) return 0;
  state.velvetCounter = 12 + Math.floor((xorshift32Bipolar(state) + 1) * 8);
  return xorshift32Bipolar(state) >= 0 ? 1 : -1;
}

/** Get a raw noise sample for the selected type. */
export function noiseSample(type: NoiseType, state: NoiseState): number {
  switch (type) {
    case 0: return xorshift32Bipolar(state); // Uniform
    case 1: return gaussianStep(state);      // Gaussian
    case 2: return pinkStep(state);          // Pink
    case 3: return velvetStep(state);        // Velvet
    default: return 0;
  }
}

/** Map 0..1 noise_decay knob → multiplicative per-sample decay coeff.
 *  decay=0 → coeff=0 (instant kill); decay=1 → coeff close to 1 (long
 *  noise tail; ~500 ms at 48 kHz). */
export function noiseDecayCoeff(decay01: number, sr: number): number {
  // tau ∈ [1ms, 500ms]; coeff = exp(-1/(tau*sr))
  const lo = 0.001;
  const hi = 0.5;
  const d = clamp(decay01, 0, 1);
  const tau = lo * Math.pow(hi / lo, d);
  return Math.exp(-1 / (tau * sr));
}

/**
 * Per-sample noise burst step.
 *
 *   gate: gate sample. Rising edge re-triggers the noise envelope to 1.
 *   amount01: knob 0..1 — gain of the noise contribution.
 *   decay01: knob 0..1 — multiplicative decay rate.
 *   cutoffHz: SVF LPF cutoff (20..5000 Hz).
 *   type: NoiseType.
 *   sr: sample rate.
 *
 * Returns the filtered + envelope-shaped noise sample.
 */
export function noiseBurstStep(
  gate: number,
  amount01: number,
  decay01: number,
  cutoffHz: number,
  type: NoiseType,
  sr: number,
  state: NoiseState,
  prevGateHigh: { v: boolean },
): number {
  const gateHigh = gate >= 0.5;
  if (gateHigh && !prevGateHigh.v) {
    state.env = 1;
  }
  prevGateHigh.v = gateHigh;

  // Decay the envelope.
  const coeff = noiseDecayCoeff(decay01, sr);
  state.env *= coeff;
  // Cheap denormal-floor.
  if (state.env < 1e-7) state.env = 0;

  const raw = noiseSample(type, state) * amount01 * state.env;

  // Cytomic-style state-variable LPF (Andy Simper 2013, eq 10/11/12).
  // f = 2*sin(π*fc/sr); g = f / (1 + f*Q) with Q=0.707 (fixed Butterworth).
  const f = 2 * Math.sin(Math.PI * clamp(cutoffHz, 20, 0.45 * sr) / sr);
  const Q = 0.707;
  const g = f;
  const denom = 1 + g * g + g / Q;
  const hp = (raw - state.svfZ1 * (g + 1 / Q) - state.svfZ2) / denom;
  const bp = hp * g + state.svfZ1;
  const lp = bp * g + state.svfZ2;
  state.svfZ1 = bp + hp * g;
  state.svfZ2 = lp + bp * g;
  return lp;
}

// ─────────────────────────────────────────────────────────────────────────
// Resonant Filter — 2nd-order peaking biquad with tanh saturation.
//
// Source: ChowKick/src/dsp/ResonantFilter.cpp + ResonantFilterProcs.h.
// Upstream uses the RBJ peaking-EQ coefficient set:
//   wc = freq * 2π / fs
//   alpha = sin(wc) / (2 Q)
//   a0 = (G + 1) + alpha * G
// with G mapped exponentially from `damping`:
//   G = 0.0001 * (0.5 / 0.0001)^damping
// and a tanh saturator on the feedback path driven by (d1, d2, d3) which
// the BouncyFilterProc derives from `tight` and `bounce`. We mirror that
// driver-set: more `tight` → more saturation (sharper attack), more
// `bounce` → asymmetric secondary resonance.
// ─────────────────────────────────────────────────────────────────────────

export interface ResonantState {
  z1: number;
  z2: number;
}

export function makeResonantState(): ResonantState {
  return { z1: 0, z2: 0 };
}

export interface ResCoefs {
  b0: number; b1: number; b2: number;
  a1: number; a2: number;
  d1: number; d2: number; d3: number;
}

/** Compute RBJ peaking-EQ coefficients for the resonant body. */
export function resonantCoefs(
  freqHz: number,
  q: number,
  damping01: number,
  tight01: number,
  bounce01: number,
  sr: number,
): ResCoefs {
  const f = clamp(freqHz, 10, 0.45 * sr);
  const wc = 2 * Math.PI * f / sr;
  const sw = Math.sin(wc);
  const cw = Math.cos(wc);
  const qC = Math.max(0.05, q);
  const alpha = sw / (2 * qC);
  // G from upstream's exponential damping map.
  const G = 0.0001 * Math.pow(0.5 / 0.0001, clamp(damping01, 0, 1));
  // Peaking EQ (RBJ Cookbook):
  //   b0 =  1 + alpha * A     (A = sqrt(G))
  //   b1 = -2 * cos(wc)
  //   b2 =  1 - alpha * A
  //   a0 =  1 + alpha / A
  //   a1 = -2 * cos(wc)
  //   a2 =  1 - alpha / A
  // Upstream uses G directly (the "gain on the resonant peak"). Empirically
  // sqrt(G) maps the damping knob into a perceptually flat damping range.
  const A = Math.sqrt(G);
  const a0 = 1 + alpha / A;
  const b0 = (1 + alpha * A) / a0;
  const b1 = (-2 * cw) / a0;
  const b2 = (1 - alpha * A) / a0;
  const a1 = (-2 * cw) / a0;
  const a2 = (1 - alpha / A) / a0;
  // Drive values for the tanh feedback saturator (BouncyFilterProc).
  // Higher tight → more drive on the body; bounce adds asymmetric drive on
  // the secondary state variable.
  const t = clamp(tight01, 0, 1);
  const bo = clamp(bounce01, 0, 1);
  const d1 = 1 + t * 4;            // primary drive — sharpens transient
  const d2 = 1 + (t + bo) * 3;     // secondary drive — bounce skews it
  const d3 = 1 + t * 2 + bo * 4;   // output drive — keeps level in check
  return { b0, b1, b2, a1, a2, d1, d2, d3 };
}

/** Per-sample resonant-filter step with tanh feedback saturation. */
export function resonantFilterStep(
  x: number,
  c: ResCoefs,
  state: ResonantState,
): number {
  // Transposed Direct Form II with feedback tanh saturation (matches the
  // BouncyFilterProc structure in upstream ResonantFilterProcs.h).
  const y = state.z1 + x * c.b0;
  const yDrive = Math.tanh(y * c.d3) / c.d3;
  state.z1 = state.z2 + x * c.b1 - yDrive * c.a1 * c.d1;
  state.z1 = Math.tanh(state.z1 * c.d1) / c.d1;
  state.z2 = x * c.b2 - yDrive * c.a2 * c.d2;
  state.z2 = Math.tanh(state.z2 * c.d2) / c.d2;
  return y;
}

// ─────────────────────────────────────────────────────────────────────────
// Output filter — first-order LPF (tone) × level (linear).
//
// Source: ChowKick/src/dsp/OutputFilter.cpp. First-order one-pole LPF
// with cutoff = `tone` (50..2000 Hz) followed by a linear gain stage
// driven by the `level` knob (-60..0 dB).
// ─────────────────────────────────────────────────────────────────────────

export interface OutputState {
  z1: number;
}

export function makeOutputState(): OutputState {
  return { z1: 0 };
}

/** One-pole LPF + dB→linear gain. */
export function outputFilterStep(
  x: number,
  toneHz: number,
  levelDb: number,
  sr: number,
  state: OutputState,
): number {
  // One-pole LPF coefficient: a = exp(-2π fc / sr).
  const fc = clamp(toneHz, 20, 0.45 * sr);
  const a = Math.exp(-2 * Math.PI * fc / sr);
  const y = (1 - a) * x + a * state.z1;
  state.z1 = y;
  // -60dB ≈ 0.001; 0dB = 1.0. Below -59.9 clamp to 0 to avoid -inf-ish gains.
  const g = levelDb <= -59.9 ? 0 : Math.pow(10, levelDb / 20);
  return y * g;
}

// ─────────────────────────────────────────────────────────────────────────
// Portamento (pitch glide) — simple one-pole smoother for freq targets.
//
// Source: ChowKick/src/dsp/Trigger.cpp (the `portamento` param controls a
// one-pole smoother on the pitch CV target). 0 ms = instant, 100 ms = slow.
// ─────────────────────────────────────────────────────────────────────────

export function portamentoCoeff(portamento_ms: number, sr: number): number {
  if (portamento_ms <= 0.05) return 1; // instant
  const tau_s = portamento_ms / 1000;
  return 1 - Math.exp(-1 / (tau_s * sr));
}

/** Apply 1-pole portamento smoother. yPrev → returns new smoothed freq. */
export function portamentoStep(
  targetHz: number,
  yPrev: number,
  alpha: number,
): number {
  return yPrev + alpha * (targetHz - yPrev);
}
