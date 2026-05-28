// packages/dsp/src/lib/wavetable-osc.ts
//
// Shared wavetable oscillator engine. WAVESCULPT (4-osc 3D scene engine)
// is the live consumer; the engine is kept generic enough that future
// wavetable modules can adopt it. Lives in `lib/` so the dist build
// script (packages/dsp/scripts/build.mjs) doesn't try to treat it as a
// worklet entry — that script reads top-level .ts files only and expects
// each one to call `registerProcessor(...)`. Files in `lib/` are pulled
// in transitively by esbuild's `bundle: true` when a top-level worklet
// imports them, so the shared code ends up inlined in each consumer with
// no duplication of intent.
//
// What's here:
//   1. Sample/frame interpolation (the single hot loop per output sample).
//   2. Symmetric wavefolder (drive=1+amt*4, foldback reflection).
//   3. Spread mixing (stereo equal-power tap blend) — kept here so the
//      math + clamps stay paired with the sampler.
//   4. WavetableOsc class — phase accumulator + per-sample step. Caller
//      configures pitch/morph/spread/fold per sample; class owns the phase
//      and the loaded frames.
//
// The class is deliberately stateful + per-instance: WAVESCULPT spins up
// four of them in one worklet, each with its own frames + phase.

/** Canonical E352 frame size — every consumer agrees on 256 samples per
 *  frame. */
export const WAVETABLE_FRAME_SIZE = 256;

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function clampRange(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Symmetric wavefolder. drive = 1 + amount * 4; foldback reflects values
 *  outside [-1, +1] back inside. amount<=0 → bypass. */
export function fold(x: number, amount: number): number {
  if (amount <= 0) return x;
  const drive = 1 + amount * 4;
  let y = x * drive;
  let guard = 0;
  while ((y > 1 || y < -1) && guard < 32) {
    if (y > 1) y = 2 - y;
    else y = -2 - y;
    guard++;
  }
  return y;
}

/** Linear-interpolate a single sample out of a frame array at a fractional
 *  frame index AND a fractional sample index. The (s1, s2, sFrac) split is
 *  pre-computed by the caller because in spread-multi-tap mode every tap
 *  shares the same oscillator phase — only `frameFloat` differs per tap.
 *  The frame size is taken from the frames themselves (so callers can mix
 *  in non-256-sample tables if a future loader path emits them — though
 *  WAVETABLE_FRAME_SIZE is the only validated size right now). */
export function sampleFrame(
  frames: readonly Float32Array[],
  frameFloat: number,
  FC: number,
  s1: number,
  s2: number,
  sFrac: number,
): number {
  const f1 = Math.max(0, Math.min(FC - 1, Math.floor(frameFloat)));
  const f2 = Math.max(0, Math.min(FC - 1, f1 + 1));
  const frameFrac = frameFloat - Math.floor(frameFloat);
  const a = frames[f1]!;
  const b = frames[f2]!;
  const va = a[s1]! + (a[s2]! - a[s1]!) * sFrac;
  const vb = b[s1]! + (b[s2]! - b[s1]!) * sFrac;
  return va + (vb - va) * frameFrac;
}

/** Compute the active-tap descriptors for the given spread + center frame.
 *  spread=1 → single tap at center, weight=1, pan=0 (mono).
 *  spread=N>1 → ceil(N) taps spaced 1 frame apart around center; outermost
 *  tap weights fade as the fractional spread leaves them behind. */
export interface SpreadTap {
  frameFloat: number;
  weight: number;
  pan: number;
}
export function spreadTaps(spread: number, centerFrame: number): SpreadTap[] {
  const N = clampRange(spread, 1, 5);
  const halfSpan = (N - 1) / 2;
  if (halfSpan === 0) {
    return [{ frameFloat: centerFrame, weight: 1, pan: 0 }];
  }
  const tapCount = Math.max(1, Math.ceil(N));
  const taps: SpreadTap[] = [];
  for (let t = 0; t < tapCount; t++) {
    const offset = t - (tapCount - 1) / 2;
    const edgeWeight = Math.max(0, Math.min(1, halfSpan + 0.5 - Math.abs(offset)));
    if (edgeWeight <= 0) continue;
    const norm = clampRange(offset / halfSpan, -1, 1);
    taps.push({ frameFloat: centerFrame + offset, weight: edgeWeight, pan: norm });
  }
  return taps;
}

/** Per-sample stereo spread mix. Equal-power pan across taps; sqrt(weight)
 *  normalization keeps RMS roughly flat as spread crosses integer
 *  boundaries (so a slow CV ramp on spread doesn't audibly click). */
export function spreadMix(
  frames: readonly Float32Array[],
  centerFrame: number,
  spread: number,
  s1: number,
  s2: number,
  sFrac: number,
): { l: number; r: number } {
  const FC = frames.length;
  const taps = spreadTaps(spread, centerFrame);
  if (taps.length === 1 && taps[0]!.pan === 0 && taps[0]!.weight === 1) {
    const s = sampleFrame(frames, taps[0]!.frameFloat, FC, s1, s2, sFrac);
    return { l: s, r: s };
  }
  let sumL = 0;
  let sumR = 0;
  let weightSum = 0;
  for (const tap of taps) {
    const sample = sampleFrame(frames, tap.frameFloat, FC, s1, s2, sFrac);
    const panAngle = (Math.PI / 4) * (1 + tap.pan);
    sumL += sample * Math.cos(panAngle) * tap.weight;
    sumR += sample * Math.sin(panAngle) * tap.weight;
    weightSum += tap.weight;
  }
  const norm = weightSum > 0 ? 1 / Math.sqrt(weightSum) : 0;
  return { l: sumL * norm, r: sumR * norm };
}

/** Pre-compute the (s1, s2, sFrac) sample-interpolation triplet from a
 *  normalized phase in [0, 1). Caller already wrapped the phase. */
export interface SampleSplit {
  s1: number;
  s2: number;
  sFrac: number;
}
export function sampleSplit(phase: number, frameSize = WAVETABLE_FRAME_SIZE): SampleSplit {
  const samplePos = phase * frameSize;
  const sFloor = Math.floor(samplePos);
  const sFrac = samplePos - sFloor;
  const s1 = sFloor % frameSize;
  const s2 = (sFloor + 1) % frameSize;
  return { s1, s2, sFrac };
}

const C4_HZ = 261.626;

/** Stateful wavetable oscillator. Owns its phase + frames. The caller
 *  pumps per-sample step() and reads back mono / stereo as needed. */
export class WavetableOsc {
  /** Loaded frames. Empty array → silent. */
  private frames: Float32Array[] = [];
  /** Previously-loaded frames, kept for a short post-`setFrames` crossfade.
   *  null when no swap is in flight (the steady-state). */
  private prevFrames: Float32Array[] | null = null;
  /** Crossfade samples remaining (counts down to 0). 0 = no fade. */
  private xfadeRemaining = 0;
  /** Initial xfadeRemaining so step() can compute the linear ratio. */
  private xfadeTotal = 0;
  /** Normalized phase accumulator in [0, 1). */
  private phase = 0;
  /** Cached, so step() doesn't reach into a setter on every sample. */
  private sr: number;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
  }

  /** Replace the loaded frames with a short sample-level crossfade between
   *  the old + new tables. The fade hides the sample-level discontinuity
   *  that an instant swap would otherwise produce — a per-swap click. This
   *  matters most for live-table producers like FOXY, which posts a fresh
   *  table ~24 Hz; without the fade, each swap risks an audible pop. The
   *  fade window is ~4 ms (sample-rate-scaled), short enough that param
   *  automation feels instant but long enough to mask the discontinuity.
   *  Validation is the caller's job (the worklet side rejects malformed
   *  transfers up front so we don't pollute step()). */
  setFrames(frames: Float32Array[]): void {
    if (this.frames.length > 0 && frames.length > 0) {
      this.prevFrames = this.frames;
      this.xfadeRemaining = Math.max(1, Math.round(this.sr * 0.004)); // ~4 ms
      this.xfadeTotal = this.xfadeRemaining;
    } else {
      // Cold start (or swap to empty): no old samples to fade from.
      this.prevFrames = null;
      this.xfadeRemaining = 0;
      this.xfadeTotal = 0;
    }
    this.frames = frames;
  }

  framesLoaded(): boolean {
    return this.frames.length > 0;
  }

  frameCount(): number {
    return this.frames.length;
  }

  /** Reset phase to zero (useful for re-trigger semantics if a host wants
   *  hard-sync; WAVESCULPT doesn't use it yet). */
  resetPhase(): void {
    this.phase = 0;
  }

  /** Read a snapshot of the active frame (the integer frame nearest to
   *  `morph * (frameCount-1)`). Returns a fresh Float32Array view of the
   *  underlying frame so the caller can upload it as a texture without
   *  worrying about concurrent mutation from a worklet step. Returns null
   *  if no frames are loaded. */
  snapshotFrame(morph: number): Float32Array | null {
    if (this.frames.length === 0) return null;
    const m = clamp01(morph);
    const idx = Math.max(
      0,
      Math.min(this.frames.length - 1, Math.round(m * (this.frames.length - 1))),
    );
    // Return a copy — the worklet may not be the only reader.
    return new Float32Array(this.frames[idx]!);
  }

  /** Sample one (l, r) pair from a given frames array at the current
   *  phase. Pure given (frames, s1, s2, sFrac, morph, spread, foldAmt) —
   *  no state mutation. Used both for the steady-state read and (during a
   *  setFrames crossfade) for the old-table half of the mix. */
  private sampleFrom(
    frames: readonly Float32Array[],
    s1: number,
    s2: number,
    sFrac: number,
    morph: number,
    spread: number,
    foldAmt: number,
  ): { l: number; r: number } {
    const FC = frames.length;
    const centerFrame = clamp01(morph) * (FC - 1);
    const { l: sl, r: sr } = spreadMix(frames, centerFrame, spread, s1, s2, sFrac);
    if (foldAmt > 0) {
      return { l: fold(sl, foldAmt), r: fold(sr, foldAmt) };
    }
    return { l: sl, r: sr };
  }

  /** Step the phase by one sample at the given pitch (V/oct, 0V = C4).
   *  Returns the (l, r) sample pair. spread=1 → mono on both channels.
   *  fold=0 → bypass folder. */
  step(
    voct: number,
    morph: number,
    spread: number,
    foldAmt: number,
  ): { l: number; r: number } {
    if (this.frames.length === 0) return { l: 0, r: 0 };

    // Pitch.
    let freq = C4_HZ * Math.pow(2, voct);
    if (freq < 1) freq = 1;
    else if (freq > this.sr * 0.5) freq = this.sr * 0.5;
    this.phase += freq / this.sr;
    while (this.phase >= 1) this.phase -= 1;
    while (this.phase < 0) this.phase += 1;

    const { s1, s2, sFrac } = sampleSplit(this.phase);
    const cur = this.sampleFrom(this.frames, s1, s2, sFrac, morph, spread, foldAmt);

    // Crossfade with the previous frames if a swap is in flight. Mixing
    // both reads at the SAME phase (one stream, two table snapshots) hides
    // the per-sample discontinuity that an instant swap would produce.
    if (this.xfadeRemaining > 0 && this.prevFrames !== null && this.prevFrames.length > 0) {
      const old = this.sampleFrom(this.prevFrames, s1, s2, sFrac, morph, spread, foldAmt);
      const t = 1 - this.xfadeRemaining / this.xfadeTotal; // 0 → 1 across the fade
      this.xfadeRemaining--;
      if (this.xfadeRemaining === 0) this.prevFrames = null;
      return {
        l: old.l * (1 - t) + cur.l * t,
        r: old.r * (1 - t) + cur.r * t,
      };
    }
    return cur;
  }
}
