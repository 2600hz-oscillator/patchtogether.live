// packages/dsp/src/lib/moog-vco-dsp.ts
//
// Shared Moog-VCO oscillator core. OWN CODE — a clean-room polyBLEP
// oscillator written for this project; it is NOT a port of any Moog
// schematic or copyleft DSP source (per .myrobots/MOOG/LICENSING.md:
// permissive / own-code DSP only). The 921 VCO worklet (../moog921-vco.ts)
// is the first consumer; later Moog slices that need a VCO (e.g. the 901
// family) can adopt the same core.
//
// Lives in `lib/` so the dist build script (packages/dsp/scripts/build.mjs)
// does NOT treat it as a worklet entry — that script reads top-level .ts
// files only + expects each to call registerProcessor(). Files in lib/ are
// pulled in transitively by esbuild's bundle:true when a worklet imports
// them, so the shared code is inlined into each consumer with no runtime
// duplication.
//
// What's here:
//   1. A naive-vs-polyBLEP band-limited oscillator that emits the four
//      simultaneous Moog 921 waveforms from ONE shared phase accumulator:
//      sine, triangle, sawtooth, rectangular (variable pulse width). Real
//      921s present all four jacks at once off a common core; we mirror
//      that so a patch can tap any/all concurrently + they stay phase-
//      coherent.
//   2. polyBLEP / polyBLAMP residual correction so the saw + rectangular
//      (and the triangle, via integrated BLAMP) are anti-aliased rather
//      than naive ramps — the "clean" character a modern listener expects
//      while keeping the analog waveform shapes.
//   3. Hard + soft oscillator sync against an external sync signal's
//      rising edges (the 921's hard/soft/off sync switch).
//
// The C4 reference (0 V/oct = middle C) matches the rest of the codebase
// (analogVco, wavetableVco, the wavetable lib).

/** 0 V/oct reference pitch — middle C, shared across the codebase. */
export const MOOG_C4_HZ = 261.626;

/** Sync mode for the external sync input.
 *  off  = sync ignored.
 *  hard = a rising edge on the sync input resets phase to 0 (classic
 *         hard-sync timbre — forces the slave to restart each master cycle).
 *  soft = a rising edge nudges phase toward 0 only if it's past the
 *         half-cycle, a gentler reset that keeps more of the slave's pitch. */
export type MoogSyncMode = 'off' | 'hard' | 'soft';

/** Numeric encoding used by the AudioParam (a-rate float can't carry a
 *  string). -1 = soft, 0 = off, +1 = hard. Matches the 921's three-position
 *  centre-off switch (down = soft, centre = off, up = hard). */
export function syncModeFromParam(v: number): MoogSyncMode {
  if (v >= 0.5) return 'hard';
  if (v <= -0.5) return 'soft';
  return 'off';
}

/** Convert a pitch in V/oct (0 = C4) plus a coarse octave offset + fine
 *  tune (semitones) into a frequency in Hz, clamped to the 921's audible/
 *  sub-audio span. `linFmHz` is an additive linear-FM term (Hz), matching
 *  the 921's dedicated linear frequency-control input. */
export function moogFreqHz(
  voct: number,
  octave: number,
  tuneSemis: number,
  linFmHz: number,
  sr: number,
): number {
  let f = MOOG_C4_HZ * Math.pow(2, voct + octave + tuneSemis / 12) + linFmHz;
  // 921 spans .01 Hz .. 40 kHz; clamp the upper bound to just under Nyquist
  // so the band-limiting math stays well-defined.
  const hi = Math.min(40000, sr * 0.49);
  if (f < 0.01) f = 0.01;
  else if (f > hi) f = hi;
  return f;
}

/** polyBLEP residual. `t` is the normalized phase [0,1); `dt` is the
 *  per-sample phase increment (freq/sr). Returns the correction to ADD to a
 *  naive discontinuous waveform near a step so the alias energy is removed.
 *  Standard 2-sample polynomial BLEP (Välimäki/Huovilainen form). */
export function polyBlep(t: number, dt: number): number {
  if (dt <= 0) return 0;
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

/** polyBLAMP residual — the integral of polyBLEP, used to band-limit the
 *  SLOPE discontinuities of the triangle. Same 2-sample window. */
export function polyBlamp(t: number, dt: number): number {
  if (dt <= 0) return 0;
  if (t < dt) {
    let x = t / dt - 1;
    return (-1 / 3) * x * x * x;
  }
  if (t > 1 - dt) {
    let x = (t - 1) / dt + 1;
    return (1 / 3) * x * x * x;
  }
  return 0;
}

/** One band-limited sample set for the four 921 waveforms at phase `phase`
 *  with per-sample increment `dt` and pulse width `pw` in (0,1). Pure given
 *  its args (the caller owns the phase accumulator), so it is trivially
 *  unit-testable. All four share one phase → phase-coherent, exactly like
 *  the hardware's common core. */
export interface MoogWaveSet {
  sine: number;
  triangle: number;
  sawtooth: number;
  rectangular: number;
}

export function moogWaves(phase: number, dt: number, pw: number): MoogWaveSet {
  const p = phase - Math.floor(phase);
  const w = pw < 0.02 ? 0.02 : pw > 0.98 ? 0.98 : pw;

  // Sine — naturally band-limited; no residual needed.
  const sine = Math.sin(2 * Math.PI * p);

  // Sawtooth — naive ramp 2p-1, minus the rising-edge polyBLEP.
  let saw = 2 * p - 1;
  saw -= polyBlep(p, dt);

  // Rectangular / pulse — ±1 around the width threshold, with a polyBLEP at
  // BOTH edges (the rising edge at p=0 and the falling edge at p=w).
  let rect = p < w ? 1 : -1;
  rect += polyBlep(p, dt);
  // Falling edge sits at phase w; shift the residual window to that edge.
  let pf = p - w;
  pf -= Math.floor(pf);
  rect -= polyBlep(pf, dt);

  // Triangle — integrate a band-limited square. We build the triangle from
  // its slope discontinuities using two polyBLAMP corrections so its corners
  // are anti-aliased. Naive triangle: rises 0→0.5, falls 0.5→1.
  let tri = p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
  // BLAMP at the two slope reversals (phase 0 and phase 0.5). dt scales the
  // residual amplitude (slope step = 2 over a half cycle → factor 4*dt).
  tri += 4 * dt * polyBlamp(p, dt);
  let ph = p - 0.5;
  ph -= Math.floor(ph);
  tri -= 4 * dt * polyBlamp(ph, dt);

  return { sine, triangle: tri, sawtooth: saw, rectangular: rect };
}

/** Stateful single-voice Moog VCO. Owns the phase accumulator + sync edge
 *  detection. The worklet drives step() once per output sample. */
export class MoogVco {
  private phase = 0;
  private sr: number;
  private prevSync = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
  }

  resetPhase(): void {
    this.phase = 0;
  }

  /** Advance one sample. `freqHz` is the already-resolved frequency,
   *  `pw` the pulse width, `syncIn` the external sync sample, `syncMode`
   *  the hard/soft/off selection. Returns all four waveform taps. */
  step(freqHz: number, pw: number, syncIn: number, syncMode: MoogSyncMode): MoogWaveSet {
    const dt = freqHz / this.sr;

    // Sync: detect a rising edge through 0 on the external sync input.
    if (syncMode !== 'off') {
      const rising = this.prevSync <= 0 && syncIn > 0;
      if (rising) {
        if (syncMode === 'hard') {
          this.phase = 0;
        } else {
          // Soft sync: only reset if we're already past the midpoint, and
          // reflect rather than hard-zero so more of the slave pitch
          // survives (gentler timbre than hard sync).
          if (this.phase > 0.5) this.phase = 0;
        }
      }
    }
    this.prevSync = syncIn;

    const waves = moogWaves(this.phase, dt, pw);

    this.phase += dt;
    while (this.phase >= 1) this.phase -= 1;
    while (this.phase < 0) this.phase += 1;

    return waves;
  }
}
