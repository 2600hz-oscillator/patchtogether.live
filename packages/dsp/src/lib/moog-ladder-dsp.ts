// packages/dsp/src/lib/moog-ladder-dsp.ts
//
// Shared Moog transistor-ladder filter core (24 dB/oct, 4-pole).
//
// OWN CODE — CLEAN-ROOM. Re-derived from the unpatented textbook TPT /
// zero-delay-feedback algorithm (Zavalishin, "The Art of VA Filter
// Design") plus the Huovilainen *technique* of a tanh() nonlinearity per
// ladder stage for the Moog growl + self-oscillation. It is NOT a port of
// any copyleft source: NOT the LGPLv3 Huovilainen reference C / CSound
// `moogladder` opcodes, NOT the CC-BY-SA musicdsp.org "Moog VCF" model,
// NOT any Moog schematic. Per .myrobots/MOOG/LICENSING.md (permissive /
// own-code DSP only). It deliberately mirrors the repo's existing TPT
// idiom — lib/resofilter-dsp.ts (Cytomic/Zavalishin SVF) + blades.ts —
// so all the VA filters in the codebase stay consistent.
//
// Lives in `lib/` so the dist build (packages/dsp/scripts/build.mjs) does
// NOT treat it as a worklet entry (that script reads top-level .ts files
// only + expects each to call registerProcessor()). esbuild's bundle:true
// inlines it into each consumer worklet, so the shared code is duplicated
// at NO runtime cost.
//
// Consumers:
//   • 904A (LPF) — this slice. Uses lp4() (the 4-pole low-pass tap).
//   • 904B (HPF) — later slice. Reuses the same ladder via hpDerive()
//     (input minus the low-passed signal → high-pass family).
//   • 904C (filter coupler / fixed-filter-bank glue) — later slice. Reuses
//     the per-pole taps (lp1/lp2/lp3/lp4) to build multi-slope responses.
//
// ── The algorithm (zero-delay-feedback transistor ladder) ──
//
// A Moog ladder is four cascaded one-pole low-pass stages inside one
// global negative-feedback loop with resonance gain k. Naively delaying
// the feedback by a sample makes the filter blow up under audio-rate
// cutoff modulation (exactly what our cutoff_cv input drives), so we solve
// the feedback loop WITHOUT a unit delay (zero-delay feedback / TPT).
//
// One TPT one-pole stage, cutoff coefficient g = tan(π·fc/sr):
//     G  = g / (1 + g)                       (instantaneous stage gain)
//     v  = (x - s) * G                       (s = stage's integrator state)
//     y  = v + s                             (stage low-pass output)
//     s  = y + v                             (trapezoidal state update)
//
// Cascading four stages, the instantaneous part of stage n's output is
// G^n · u (where u is the ladder input after feedback), and the rest is a
// linear function of the four integrator states. Writing the ladder input
// as u = x_in - k · y4 (k = resonance, y4 = 4-pole output) and y4 as
//     y4 = G^4 · u + Sigma
// (Sigma = the state-only contribution, independent of u this sample),
// we can solve the loop in closed form:
//     u = (x_in - k · Sigma) / (1 + k · G^4)
// Then run the four stages forward once with that u. No iteration, no
// unit-delay in the feedback path → unconditionally stable under
// per-sample cutoff jumps.
//
// Optional tanh() feedback saturation (the Huovilainen TECHNIQUE — a tanh
// nonlinearity in the resonance loop — re-derived, NOT his code): when
// `drive > 0` we soft-clip the FED-BACK signal (the forward ladder stages
// stay linear so the passband is unity). That makes the resonance peak fold
// over into the warm Moog "growl", and — crucially — self-LIMITS the
// resonance so the filter SELF-OSCILLATES into a BOUNDED clean sine VC
// oscillator as k approaches/exceeds 4 (the linear self-oscillation
// threshold) instead of blowing up. The fed-back term is taken from last
// sample's output (a 1-sample delay ONLY on the saturated resonance term),
// keeping the forward solve the exact closed-form zero-delay solve — so the
// filter stays unconditionally stable even under audio-rate cutoff sweeps.
// The saturating path is only taken when drive>0; drive==0 uses the cheap
// exact LINEAR solve.
//
// The C4 reference (0 V/oct = middle C) matches the rest of the codebase.

/** 0 V/oct reference pitch — middle C, shared across the codebase. */
export const MOOG_LADDER_C4_HZ = 261.626;

/** Linear self-oscillation threshold of the 4-pole ladder. At k = 4 the
 *  loop gain reaches unity at the cutoff and the filter rings indefinitely
 *  (becomes a sine VC oscillator). We expose this so the worklet can map
 *  its REGENERATION knob (0..1) onto [0, slightly past 4]. */
export const MOOG_LADDER_SELF_OSC_K = 4;

/** Clamp + map a cutoff in Hz to the TPT coefficient g = tan(π·fc/sr).
 *  Clamped to a safe band away from DC + Nyquist so the tangent stays
 *  finite + the ladder math is well-defined. */
export function ladderCutoffToG(fcHz: number, sr: number): number {
  const fmin = 10;
  const fmax = sr * 0.49;
  const fc = fcHz < fmin ? fmin : fcHz > fmax ? fmax : fcHz;
  return Math.tan((Math.PI * fc) / sr);
}

/** Map the REGENERATION knob (0..1) to the ladder feedback gain k.
 *  0 → 0 (no resonance), 1 → just PAST the k=4 self-oscillation threshold
 *  so regeneration≈1 sustains a clean sine. Linear in k for predictable
 *  knob feel; the audible "sharpening" is naturally exponential in
 *  perceived Q near the top because loop gain → unity. */
export function regenToK(regen: number): number {
  const r = regen < 0 ? 0 : regen > 1 ? 1 : regen;
  // Reach ~4.1 at r=1 so the very top of the knob reliably self-oscillates
  // (k must EXCEED 4 to overcome the tanh's compressive loss in the loop).
  return r * 4.1;
}

/** RANGE switch → cutoff multiplier. The 904A's RANGE shifts the cutoff in
 *  2-octave steps (service-manual range refs ≈ 60–80 / 260–340 / 1.0–1.3k
 *  Hz — each ~2 octaves apart). Position 1/2/3 → ×1 / ×4 / ×16 (2 oct = ×4).
 *  Returns 1 for any out-of-range index (defensive). */
export function rangeMultiplier(range: number): number {
  switch (Math.round(range)) {
    case 1: return 1;   // low band  (~60–80 Hz at the knob's low end)
    case 2: return 4;   // +2 oct    (~260–340 Hz)
    case 3: return 16;  // +4 oct    (~1.0–1.3 kHz)
    default: return 1;
  }
}

/** Per-pole taps from one ladder tick. lp1..lp4 are the 6/12/18/24 dB-oct
 *  low-pass outputs; later slices (904B/904C) derive HP + multi-slope
 *  responses from these. */
export interface LadderTaps {
  /** 6 dB/oct (1-pole) low-pass. */
  lp1: number;
  /** 12 dB/oct (2-pole) low-pass. */
  lp2: number;
  /** 18 dB/oct (3-pole) low-pass. */
  lp3: number;
  /** 24 dB/oct (4-pole) low-pass — the 904A's main output. */
  lp4: number;
}

/** Stateful 4-pole transistor-ladder low-pass.
 *
 *  step() advances one sample and returns all four pole taps. The 904A
 *  worklet reads .lp4; 904B/904C read the other taps + hpDerive(). */
export class MoogLadder {
  // Four trapezoidal integrator states (one per ladder stage).
  private s1 = 0;
  private s2 = 0;
  private s3 = 0;
  private s4 = 0;
  // Previous 4-pole output, used to linearize the saturated feedback loop.
  private yPrev = 0;
  private sr: number;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
  }

  /** Zero all state (e.g. on a large reset / re-trigger). */
  reset(): void {
    this.s1 = this.s2 = this.s3 = this.s4 = 0;
    this.yPrev = 0;
  }

  /**
   * Advance one sample.
   *   x       — input sample.
   *   fcHz    — cutoff frequency this sample (Hz). Audio-rate-safe.
   *   k       — resonance feedback gain (0..~4.1; see regenToK).
   *   drive   — tanh feedback-saturation amount (0 = linear/clean exact
   *             solve, >0 adds the Moog growl + self-LIMITS the resonance so
   *             it self-oscillates into a BOUNDED sine near k=4). Typical
   *             0.5..1.3. Pass 0 to take the cheap exact linear solve.
   * Returns the four pole taps; .lp4 is the 24 dB/oct output.
   */
  step(x: number, fcHz: number, k: number, drive: number): LadderTaps {
    const g = ladderCutoffToG(fcHz, this.sr);
    const G = g / (1 + g); // instantaneous one-pole gain

    if (drive <= 0) {
      // ── Linear path: exact zero-delay-feedback solve (no iteration). ──
      // Each stage low-pass: y = G*(u - s) + s = G*u + (1-G)*s.
      // Express y4 as A*u + B where A = G^4 and B depends only on states.
      const G4 = G * G * G * G;
      const oneMinusG = 1 - G;
      // State-only contribution Sigma to y4 (set u=0 and propagate states):
      //   y1s = (1-G)*s1
      //   y2s = G*y1s + (1-G)*s2
      //   y3s = G*y2s + (1-G)*s3
      //   y4s = G*y3s + (1-G)*s4
      const y1s = oneMinusG * this.s1;
      const y2s = G * y1s + oneMinusG * this.s2;
      const y3s = G * y2s + oneMinusG * this.s3;
      const sigma = G * y3s + oneMinusG * this.s4;
      // Solve u = x - k*y4 with y4 = G4*u + sigma:
      const u = (x - k * sigma) / (1 + k * G4);

      // Run the four stages forward with the resolved input.
      const v1 = (u - this.s1) * G;
      const y1 = v1 + this.s1;
      this.s1 = y1 + v1;

      const v2 = (y1 - this.s2) * G;
      const y2 = v2 + this.s2;
      this.s2 = y2 + v2;

      const v3 = (y2 - this.s3) * G;
      const y3 = v3 + this.s3;
      this.s3 = y3 + v3;

      const v4 = (y3 - this.s4) * G;
      const y4 = v4 + this.s4;
      this.s4 = y4 + v4;

      this.yPrev = y4;
      return { lp1: y1, lp2: y2, lp3: y3, lp4: y4 };
    }

    // ── Saturated path: tanh in the FEEDBACK loop for the Moog growl. ──
    // We keep the four ladder STAGES linear (passband stays unity — no
    // level-killing per-stage gain) and put the transistor nonlinearity
    // where it physically lives + matters: the resonance feedback path.
    // Saturating the fed-back signal self-LIMITS the resonance (it can't
    // run away to infinite gain) and gives the warm fold-over growl + a
    // BOUNDED, sustained self-oscillation as k passes 4 — exactly the
    // Huovilainen *technique* (tanh per the loop), re-derived, not his code.
    //
    // The feedback term is evaluated from last sample's output (yPrev) so
    // the forward stage solve stays the same closed-form zero-delay solve
    // as the linear path (1-sample feedback delay ONLY on the saturated
    // resonance term — inaudible, and what keeps it unconditionally stable
    // under audio-rate cutoff sweeps). `drive` sets how hard the feedback
    // is pushed into the tanh knee (more drive = earlier fold-over / grit).
    // tanh(drive·y)/drive ≈ y for small y (resonance behaves linearly until
    // it gets loud) and compresses to ±1/drive as y grows (the self-limit).
    const d = drive > 0 ? drive : 1;
    const fb = (k * Math.tanh(d * this.yPrev)) / d;
    // Forward input is x minus the SATURATED feedback. The forward stages
    // stay linear so the passband is unity; the tanh (not the algebra) is
    // what tames the resonance.
    const u = x - fb;

    const v1 = (u - this.s1) * G;
    const y1 = v1 + this.s1;
    this.s1 = y1 + v1;

    const v2 = (y1 - this.s2) * G;
    const y2 = v2 + this.s2;
    this.s2 = y2 + v2;

    const v3 = (y2 - this.s3) * G;
    const y3 = v3 + this.s3;
    this.s3 = y3 + v3;

    const v4 = (y3 - this.s4) * G;
    const y4 = v4 + this.s4;
    this.s4 = y4 + v4;

    this.yPrev = y4;
    return { lp1: y1, lp2: y2, lp3: y3, lp4: y4 };
  }
}

/** High-pass derivation for 904B: a Moog ladder is fundamentally a
 *  low-pass, but the classic 904B HPF is built by SUBTRACTING low-passed
 *  bands from the input (input − lp gives the complementary high-pass
 *  family). Exposed here so 904B reuses this exact lib rather than
 *  re-deriving. `pole` selects how many low-pass poles to subtract
 *  (1 → 6 dB/oct HP, … 4 → steep HP shelf).
 *
 *  hp = x - lpN. Returns the high-passed sample. */
export function hpDerive(x: number, taps: LadderTaps, pole: 1 | 2 | 3 | 4 = 4): number {
  switch (pole) {
    case 1: return x - taps.lp1;
    case 2: return x - taps.lp2;
    case 3: return x - taps.lp3;
    case 4: return x - taps.lp4;
    default: return x - taps.lp4;
  }
}

/** Pure-math render helper — used by the unit + DSP-lib tests (+ later by
 *  904B/904C tests) so filter response can be pinned without spinning up an
 *  AudioWorklet. Returns a Float32Array of length input.length holding the
 *  selected pole tap (default the 24 dB/oct lp4). A constant cutoff/k/drive
 *  may be overridden per-sample via the *Arr options for sweep tests. */
export function renderLadder(
  input: Float32Array,
  opts: {
    cutoffHz: number;
    cutoffArr?: Float32Array;
    k: number;
    kArr?: Float32Array;
    drive?: number;
    sr: number;
    pole?: 1 | 2 | 3 | 4;
  },
): Float32Array {
  const ladder = new MoogLadder(opts.sr);
  const out = new Float32Array(input.length);
  const drive = opts.drive ?? 0;
  const pole = opts.pole ?? 4;
  for (let i = 0; i < input.length; i++) {
    const fc = opts.cutoffArr ? (opts.cutoffArr[i] ?? opts.cutoffHz) : opts.cutoffHz;
    const k = opts.kArr ? (opts.kArr[i] ?? opts.k) : opts.k;
    const taps = ladder.step(input[i] ?? 0, fc, k, drive);
    out[i] = pole === 1 ? taps.lp1 : pole === 2 ? taps.lp2 : pole === 3 ? taps.lp3 : taps.lp4;
  }
  return out;
}
