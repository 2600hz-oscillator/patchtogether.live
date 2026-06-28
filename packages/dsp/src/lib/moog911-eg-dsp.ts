// packages/dsp/src/lib/moog911-eg-dsp.ts
//
// Shared MOOG 911 contour-generator (envelope) core — the pure per-sample DSP
// extracted from the moog911 worklet so the SHIPPED envelope math is unit-tested
// (the ADSR-env / moog-ladder-dsp pattern). The 911 is a three-time-constant
// CONTOUR generator with a single sustain LEVEL (NOT a literal A-D-S-R):
//
//   T1  — ATTACK: rise 0 → peak (1.0) on gate open.
//   T2  — INITIAL DECAY: fall peak → Esus.
//   Esus— SUSTAIN LEVEL (0..1): held while gated.
//   T3  — FINAL DECAY: fall current → 0 on gate close (forced from ANY stage, so
//         a short trigger releasing mid-attack still decays over T3).
//
// OWN CODE — clean-room exponential-segment contour (NOT a Moog schematic/copyleft
// port; .myrobots/MOOG/LICENSING.md). Lives in `lib/` so the dist build does NOT
// treat it as a worklet entry; esbuild `bundle:true` inlines it into the worklet
// at no runtime cost. Consumer: moog911.ts.

/** Contour stages. */
export const MOOG911_STAGE = {
  IDLE: 0, // gate low, env at rest (0)
  ATTACK: 1, // rising 0 → 1 over T1
  DECAY: 2, // falling 1 → Esus over T2
  SUSTAIN: 3, // holding Esus while gated
  RELEASE: 4, // falling current → 0 over T3 (gate low)
} as const;

/** Gate high at >= 0.5 (S-trigger / unipolar convention; matches SEQUENCER.gate). */
export const GATE_THRESHOLD = 0.5;

/** Exponential one-pole "tau scale": cover ~99% of a segment's span within the
 *  configured time (5 RC time-constants ≈ 99.3%) → the classic Moog rounded
 *  contour rather than a linear ramp. */
export const TAU_DECADES = 5;

/** Smallest meaningful stage time (s). Below this, snap instantly (coeff → 1) so
 *  a near-zero T-knob doesn't divide-by-zero or stall. */
export const MIN_TIME_S = 1e-4;

/** Per-sample coefficient for an exponential approach toward a target over
 *  `timeS` seconds at sample-rate `sr` (covers ~99% within timeS). */
export function egCoeff(timeS: number, sr: number): number {
  if (timeS <= MIN_TIME_S) return 1;
  const samples = timeS * sr;
  // exp(-decades / samples): after `samples` steps, residual ≈ e^-5 ≈ 0.7%.
  return 1 - Math.exp(-TAU_DECADES / samples);
}

/** Stateful per-sample 911 contour generator. Drive one sample at a time with
 *  `step()`; read `.level` (0..1) or use the returned value. Pure + deterministic
 *  (no Web Audio deps) → unit-testable; the moog911 worklet wires I/O to this. */
export class Moog911Eg {
  readonly sr: number;
  stage: number = MOOG911_STAGE.IDLE;
  level = 0; // current envelope value (0..1)
  prevGate = false;

  constructor(sr: number) {
    this.sr = sr;
  }

  reset(): void {
    this.stage = MOOG911_STAGE.IDLE;
    this.level = 0;
    this.prevGate = false;
  }

  /** Advance one sample. `gateHigh` is the already-thresholded gate; t1/t2/t3 in
   *  seconds; esus 0..1 (clamped here). Returns the new envelope level (0..1). */
  step(gateHigh: boolean, t1: number, t2: number, esus: number, t3: number): number {
    if (esus < 0) esus = 0;
    else if (esus > 1) esus = 1;

    // ── Edge detection ──
    if (gateHigh && !this.prevGate) {
      this.stage = MOOG911_STAGE.ATTACK; // rising → (re)start contour
    } else if (!gateHigh && this.prevGate) {
      this.stage = MOOG911_STAGE.RELEASE; // falling → force final decay (T3)
    }
    this.prevGate = gateHigh;

    // ── Stage advance ──
    switch (this.stage) {
      case MOOG911_STAGE.ATTACK: {
        const c = egCoeff(t1, this.sr);
        this.level += (1.0 - this.level) * c;
        if (this.level >= 0.999) {
          this.level = 1.0;
          this.stage = MOOG911_STAGE.DECAY;
        }
        break;
      }
      case MOOG911_STAGE.DECAY: {
        const c = egCoeff(t2, this.sr);
        this.level += (esus - this.level) * c;
        if (Math.abs(this.level - esus) <= 1e-3) {
          this.level = esus;
          this.stage = MOOG911_STAGE.SUSTAIN;
        }
        break;
      }
      case MOOG911_STAGE.SUSTAIN:
        this.level = esus; // hold (track Esus if the knob/CV moves)
        break;
      case MOOG911_STAGE.RELEASE: {
        const c = egCoeff(t3, this.sr);
        this.level += (0 - this.level) * c;
        if (this.level <= 1e-4) {
          this.level = 0;
          this.stage = MOOG911_STAGE.IDLE;
        }
        break;
      }
      case MOOG911_STAGE.IDLE:
      default:
        this.level = 0;
        break;
    }

    return this.level;
  }
}
