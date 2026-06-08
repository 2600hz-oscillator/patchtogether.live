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
// Resonant Filter — pinged 2-pole resonant BODY with tanh feedback drive.
//
// Source: ChowKick/src/dsp/ResonantFilter.cpp + ResonantFilterProcs.h.
//
// THE OOMPH FIX (PR feat/chowkick-oomph). The previous port built an RBJ
// *peaking-EQ* with A = sqrt(G); since G = 0.0001·(0.5/0.0001)^damp is < 1
// for all damp < 1, the `1+alpha·A` over `1+alpha/A` term CUT the body
// frequency (−43 dB at default) instead of resonating it. The body never
// oscillated — the module emitted a unipolar DC blob (measured: DC +0.62,
// ZERO zero-crossings in 50–600 ms, fundamental ≈14 Hz, 99.9 % of energy
// below 60 Hz, 0 % at the kick's own pitch). Cranking gain only grew the
// DC step; it was a topology/coefficient bug, not a level/headroom one.
//
// Upstream ChowKick's body is a resonator pinged into a decaying sine: its
// coefficients place the poles essentially ON the unit circle (poleR ≈
// 0.9999) so a single ping rings. We now build a true 2-pole resonant
// BANDPASS:
//
//   H(z) = g · (1 − z⁻²) / (1 + a1·z⁻¹ + a2·z⁻²),  a1 = −2r·cos(wc), a2 = r²
//
//   - pole ANGLE wc = 2π·freq/sr  → the body pitch (a bipolar decaying sine
//     AT freq, not a DC step).
//   - pole RADIUS r ∈ (0,1)       → the ring/decay time, mapped from
//     `damping`: low damp → r≈0.9997 (~280 ms tail), high damp → r≈0.9936
//     (~18 ms thud). `Q` sharpens the resonance (nudges r up a touch).
//     Clamped strictly < 1 so even damp=0 decays (upstream's poleR=1.0 at
//     damp=0 rings forever — not musical for a kick).
//   - numerator gain g = (1 − r)  normalizes the resonant peak to ≈ unit
//     gain across the whole freq/Q/damping range (freq-independent loudness).
//
// A tanh saturator on the feedback path (driven by `tight`/`bounce` →
// d1,d2,d3, mirroring upstream's BouncyFilterProc) adds harmonics so the
// fundamental reads on speakers that can't reproduce 60 Hz, and keeps the
// resonator bounded under hard pings.
// ─────────────────────────────────────────────────────────────────────────

export interface ResonantState {
  /** y[n-1] — recursive (denominator) history. */
  z1: number;
  /** y[n-2] — recursive (denominator) history. */
  z2: number;
  /** x[n-2] — feed-forward (numerator b2·z⁻²) history. */
  x2: number;
}

export function makeResonantState(): ResonantState {
  return { z1: 0, z2: 0, x2: 0 };
}

export interface ResCoefs {
  b0: number; b1: number; b2: number;
  a1: number; a2: number;
  d1: number; d2: number; d3: number;
}

/** Pole radius for the longest tail (damping = 0). r^n = 0.01 at n=280ms·sr. */
const RES_R_LONG = Math.pow(0.01, 1 / (0.28 * 48000));   // ≈ 0.99968 → ~280 ms
/** Pole radius for the shortest thud (damping = 1). ≈ 0.99362 → ~18 ms. */
const RES_R_SHORT = Math.pow(0.01, 1 / (0.018 * 48000));

/** Map the damping knob (0 = long boom … 1 = short thud) + Q (sharper ring)
 *  to a pole radius in (0,1). Log-interpolated so the perceived decay knob
 *  is roughly even. Hard-clamped < 1 so the resonator ALWAYS decays. */
export function resonantPoleRadius(damping01: number, q: number): number {
  const d = clamp(damping01, 0, 1);
  let r = Math.exp(Math.log(RES_R_LONG) * (1 - d) + Math.log(RES_R_SHORT) * d);
  // Higher Q lengthens the ring slightly (sharper, more sustained resonance).
  const qBoost = Math.max(0, (Math.max(0.05, q) - 0.5) * 0.00008);
  r += Math.min(0.0006, qBoost);
  return clamp(r, 0.9, 0.99975);
}

/** Compute the resonant-body coefficients (true pinged 2-pole bandpass). */
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
  const cw = Math.cos(wc);
  const r = resonantPoleRadius(damping01, q);
  // Denominator: poles at radius r, angle wc → rings at `freq`, decays per r.
  const a1 = -2 * r * cw;
  const a2 = r * r;
  // Bandpass numerator g·(1 − z⁻²). g = 1 normalizes a single PING (impulse)
  // to ≈ unit peak across the whole freq/Q/damping range (a kick is pinged,
  // not sine-driven — verified: impulse peak = 1.000 for every config). The
  // tanh feedback drive bounds the response when the pulse holds a square.
  const g = 1;
  const b0 = g;
  const b1 = 0;
  const b2 = -g;
  // Output-stage waveshaper drives (NOT in the feedback path — saturating the
  // near-unit-circle feedback collapses the resonance to silence). `tight`
  // adds symmetric tanh drive on the body output (fatter, more 2×/3×
  // harmonics → reads on small speakers); `bounce` adds an asymmetric (even-
  // harmonic) skew. d1 carries `tight`; d2 carries `bounce`. d3 is reserved.
  const t = clamp(tight01, 0, 1);
  const bo = clamp(bounce01, 0, 1);
  const d1 = t;
  const d2 = bo;
  const d3 = 0;
  return { b0, b1, b2, a1, a2, d1, d2, d3 };
}

/** Per-sample resonant-filter step — a LINEAR 2-pole resonant bandpass plus a
 *  bounded post-resonator waveshaper.
 *
 *  The recursion itself is kept linear: with pole radius r < 1 it is
 *  unconditionally stable, rings cleanly at `freq` (verified: 80 Hz ping →
 *  82 Hz fundamental, unit peak), and — crucially — saturating its feedback
 *  path (as an earlier draft did) crushes the resonance to silence because the
 *  near-unit-circle internal state is large. Instead the body OUTPUT is run
 *  through:
 *    1. a safety tanh that bounds the transient overshoot from a held pulse
 *       (a square step into a high-Q bandpass overshoots to ~±2.7 raw);
 *    2. `tight`-driven symmetric drive (fatter body, more odd harmonics);
 *    3. `bounce`-driven asymmetric skew (even harmonics — the "bouncy" tone).
 *  All three are transparent (≈ linear, unity gain) at small levels so a quiet
 *  ring isn't attenuated. */
export function resonantFilterStep(
  x: number,
  c: ResCoefs,
  state: ResonantState,
): number {
  // Linear Direct Form I over the bandpass numerator g(1 − z⁻²) (b1 = 0):
  //   y = b0·x + b2·x[n-2] − a1·y[n-1] − a2·y[n-2]
  const yLin = c.b0 * x + c.b2 * state.x2 - c.a1 * state.z1 - c.a2 * state.z2;
  // Advance the LINEAR recursion state (the shaper below must NOT feed back,
  // or it detunes/kills the resonance).
  state.z2 = state.z1;
  state.z1 = yLin;
  state.x2 = x;
  // ── Output shaping (does not affect the recursion) ──
  // 1. Safety bound: tanh with generous headroom (3) — ≈ linear for |y|<1,
  //    catches the ±2.7 held-pulse overshoot without touching the body tone.
  let y = Math.tanh(yLin / 3) * 3;
  // 2. tight → symmetric drive (odd harmonics). transparent at d1=0.
  if (c.d1 > 1e-6) {
    const pre = 1 + c.d1 * 1.5;
    y = Math.tanh(y * pre) / pre;
  }
  // 3. bounce → asymmetric skew (even harmonics). transparent at d2=0.
  if (c.d2 > 1e-6) {
    const k = c.d2 * 0.6;
    y = y + k * (y * y - 1 / 3) * (y >= 0 ? 1 : -1);
  }
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

// ─────────────────────────────────────────────────────────────────────────
// Pitch envelope (THE punch mechanism) — PR feat/chowkick-oomph.
//
// A kick's "punch" is a fast downward pitch sweep at the attack: the body
// starts ~3× the target freq and exponentially drops to the target over a
// few tens of ms. The previous port had NO per-trigger pitch envelope — only
// a portamento smoother chasing a static target — so the kick had no punch.
//
//   freq_env(t) = freq · (1 + amount·(startMult − 1)·exp(−t/tau))
//
// Retriggered on the gate rising edge. `amount` (0..1) scales how much sweep;
// `decay` (0..1) maps to tau ∈ [3ms, 80ms]. startMult is fixed at 3.5× (the
// canonical kick attack-pitch multiple).
// ─────────────────────────────────────────────────────────────────────────

/** Start-pitch multiple at the attack (3.5× target freq → punchy downward
 *  sweep). Chosen to match a typical 808/909-style kick attack chirp. */
export const PITCH_ENV_START_MULT = 3.5;

export interface PitchEnvState {
  /** Current envelope value 0..1 (1 at attack, decaying to 0). */
  env: number;
  /** Last gate value, for rising-edge retrigger. */
  gatePrev: number;
}

export function makePitchEnvState(): PitchEnvState {
  return { env: 0, gatePrev: 0 };
}

/** Map the 0..1 pitch_decay knob to a time constant (seconds), 3ms..80ms. */
export function pitchEnvTau(decay01: number): number {
  const lo = 0.003;
  const hi = 0.08;
  return lo * Math.pow(hi / lo, clamp(decay01, 0, 1));
}

/** Per-sample pitch-envelope step. Returns the swept frequency in Hz.
 *
 *  gate: current gate sample (rising edge retriggers the sweep).
 *  baseFreqHz: the target (knob) frequency the sweep settles to.
 *  amount01: 0 = no sweep (flat), 1 = full startMult sweep.
 *  decay01: pitch-env decay knob (→ tau via pitchEnvTau).
 */
export function pitchEnvStep(
  gate: number,
  baseFreqHz: number,
  amount01: number,
  decay01: number,
  sr: number,
  state: PitchEnvState,
): number {
  const gateHigh = gate >= 0.5;
  const gatePrevHigh = state.gatePrev >= 0.5;
  state.gatePrev = gate;
  if (gateHigh && !gatePrevHigh) {
    state.env = 1; // retrigger the sweep on the rising edge.
  }
  const tau = pitchEnvTau(decay01);
  const a = Math.exp(-1 / (tau * sr));
  const amt = clamp(amount01, 0, 1);
  const swept = baseFreqHz * (1 + amt * (PITCH_ENV_START_MULT - 1) * state.env);
  // Decay the envelope toward 0 for the next sample.
  state.env *= a;
  if (state.env < 1e-6) state.env = 0;
  return swept;
}

// ─────────────────────────────────────────────────────────────────────────
// DC blocker (post-body) — PR feat/chowkick-oomph.
//
// Even with a properly-ringing bipolar resonator, the hard attack ping can
// leave a small DC step. A tiny per-module 1-pole HPF (~25 Hz) removes it so
// the kick doesn't lean on audio-out's 5 Hz system HPF to clean up after it.
//   y[n] = x[n] − x[n-1] + R·y[n-1],  R = exp(−2π·fc/sr)
// ─────────────────────────────────────────────────────────────────────────

export interface DcBlockState {
  x1: number;
  y1: number;
}

export function makeDcBlockState(): DcBlockState {
  return { x1: 0, y1: 0 };
}

/** Per-sample 1-pole DC blocker. fc ≈ 25 Hz by default. */
export function dcBlockStep(
  x: number,
  state: DcBlockState,
  fcHz = 25,
  sr = 48000,
): number {
  const R = Math.exp(-2 * Math.PI * clamp(fcHz, 1, 0.45 * sr) / sr);
  const y = x - state.x1 + R * state.y1;
  state.x1 = x;
  state.y1 = y;
  return y;
}

// ─────────────────────────────────────────────────────────────────────────
// Body drive / makeup — PR feat/chowkick-oomph.
//
// Pushes the body into a tanh stage to add 2×/3× harmonics (so the
// fundamental reads on speakers that can't reproduce sub-bass) with makeup
// gain so the level stays hot. `drive01` 0 → transparent (×1, no saturation),
// 1 → hard drive (×6 pre-tanh). Gated by `tight` so the existing tightness
// knob also pushes the body harder.
// ─────────────────────────────────────────────────────────────────────────

/** Apply pre-gain → tanh → makeup. drive01 0 = transparent, 1 = hot. */
export function bodyDriveStep(x: number, drive01: number, tight01: number): number {
  const d = clamp(drive01, 0, 1);
  const t = clamp(tight01, 0, 1);
  // Pre-tanh input gain 1..6, with `tight` adding up to +50 %.
  const pre = 1 + d * 5 * (1 + 0.5 * t);
  if (pre <= 1.0001) return x; // transparent fast-path when drive is off.
  // tanh maps to (−1,1); makeup restores unity for small signals (≈ pre at 0)
  // so a quiet body isn't attenuated. We divide by tanh'(0)=1·pre → /pre, but
  // cap makeup so loud bodies still saturate (the harmonics we want).
  const driven = Math.tanh(x * pre);
  const makeup = Math.min(pre, 1 / Math.tanh(1)); // bounded makeup
  return driven * makeup;
}
