// packages/dsp/src/lib/varispeed-shifter.ts
//
// VarispeedShifter — a from-scratch, OWN-CODE granular pitch shifter for a
// SINGLE channel. Written clean-room from first-principles DSP; it copies no
// upstream algorithm and shares no code with the retired GPL cocoadelay-core.
//
// It is the textbook two-tap, constant-power crossfaded delay-line pitch
// shifter (the "SOLA-less" varispeed grain reader): a ring buffer is written at
// one sample per sample while a fractional read pointer sweeps through it at
// `rate` samples per sample. When the read pointer would run into (or off the
// end of) the write head it wraps by one grain window; a second read tap runs
// half a window out of phase and the two are crossfaded with a raised-cosine
// window (env(x) + env(x + W/2) ≡ 1), so the wrap discontinuity is masked and
// the amplitude stays constant.
//
//   rate > 1  → the read consumes samples FASTER than they are written, so the
//               content is resampled UP in pitch (ratio = rate). CHARLOTTE'S
//               ECHOS drives this per cascade stage for the ascending shimmer.
//   rate < 1  → pitches DOWN (symmetric; unused by CHARLOTTE but supported).
//   rate == 1 → an EXACT bypass: `step` returns its input untouched, so a stage
//               that is not transposing is a strict no-op (no comb, no latency).
//
// DETERMINISM: no RNG, no allocation per sample; two identical `step` streams
// are bit-identical. Linear interpolation on the read keeps it cheap; the mild
// aliasing on large upward ratios is part of the intended "destructive" grain.

const TWO_PI = Math.PI * 2;

/** Raised-cosine grain envelope over [0, W): 0 at the edges, 1 at the centre.
 *  env(x) + env(x + W/2) ≡ 1, so the two crossfaded taps sum to unity gain. */
function grainEnv(pos: number, window: number): number {
  return 0.5 - 0.5 * Math.cos((TWO_PI * pos) / window);
}

export class VarispeedShifter {
  private buf: Float32Array;
  private size: number;
  private writeIdx = 0;

  /** Grain window length in samples (the wrap period of the read pointer). */
  private window: number;
  /** Fractional read LAG behind the write head, swept within [0, window). */
  private lag: number;

  /**
   * @param sampleRate host sample rate.
   * @param windowMs   grain window in ms (~30 ms ≈ a few periods of a bass
   *                   note — long enough to transpose cleanly, short enough to
   *                   keep the added latency small).
   */
  constructor(sampleRate: number, windowMs = 30) {
    const sr = sampleRate > 0 ? sampleRate : 48000;
    this.window = Math.max(8, Math.round((windowMs / 1000) * sr));
    // +4 samples of headroom so the second (half-window) tap and its linear
    // interpolation neighbour never read past the freshest `size` samples.
    this.size = this.window + 4;
    this.buf = new Float32Array(this.size);
    this.lag = this.window * 0.5;
  }

  reset(): void {
    this.buf.fill(0);
    this.writeIdx = 0;
    this.lag = this.window * 0.5;
  }

  /** Linear read `lag` samples behind the most-recently-written slot `w`. */
  private readAt(w: number, lag: number): number {
    let pos = w - lag;
    while (pos < 0) pos += this.size;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = this.buf[i0 % this.size]!;
    const b = this.buf[(i0 + 1) % this.size]!;
    return a + (b - a) * frac;
  }

  /**
   * Push one input sample and return one pitch-shifted output sample. `rate` is
   * the resample ratio (>1 up, <1 down, ==1 exact bypass).
   */
  step(x: number, rate: number): number {
    const v = Number.isFinite(x) ? x : 0;
    const w = this.writeIdx;
    this.buf[w] = v;
    this.writeIdx = w + 1 >= this.size ? 0 : w + 1;

    // Exact bypass at unity — a stage that is not transposing stays clean.
    if (!Number.isFinite(rate) || Math.abs(rate - 1) < 1e-9) return v;

    // Sweep the read lag. rate > 1 shrinks the lag (read catches the write →
    // higher pitch); wrap by one window to stay bounded inside the buffer.
    const win = this.window;
    this.lag -= rate - 1;
    if (this.lag < 0) this.lag += win;
    else if (this.lag >= win) this.lag -= win;

    let lag2 = this.lag + win * 0.5;
    if (lag2 >= win) lag2 -= win;

    const g1 = grainEnv(this.lag, win);
    const g2 = grainEnv(lag2, win);
    const y = this.readAt(w, this.lag) * g1 + this.readAt(w, lag2) * g2;
    return Number.isFinite(y) ? y : 0;
  }
}
