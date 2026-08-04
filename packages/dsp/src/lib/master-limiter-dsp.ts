// packages/dsp/src/lib/master-limiter-dsp.ts
//
// MASTER LIMITER — the terminal safety stage for `audioOut`, replacing the
// full-band stereo-linked `DynamicsCompressorNode` that the DSP audit indicts
// as P0-A1 (.myrobots/plans/dsp-stack-bass-freq-audit-2026-07-01.md):
//
//   "It is full-band and stereo-linked. Attack 3 ms + release 50 ms is on the
//    order of the sub period (40 Hz = 25 ms), so on a −6 dBFS+ kick it
//    modulates the sub waveform itself and pulls the whole mix down each
//    strike."
//
// The audit's prescribed remedy, option 2: "Replace with a look-ahead
// brickwall limiter worklet (own-code): raise the ceiling to ~−1 dB, sub passes
// at full level, true peak control." This is that limiter's pure core — no
// worklet globals, so every guarantee below is unit-testable in node
// (master-limiter-dsp.test.ts). Own code; no port.
//
// ── WHY LOOK-AHEAD IS THE WHOLE POINT ──────────────────────────────────────
// A feedback/feed-forward compressor has to *react*, so it needs a fast attack
// to catch a transient — and a fast attack on a full-band detector is exactly
// what modulates a 40 Hz waveform. A look-ahead limiter instead DELAYS the
// audio by the look-ahead window and shapes the gain over that window, so it is
// already at the right value when the peak arrives. Two consequences:
//
//   1. Below the ceiling the gain is EXACTLY 1. Not "nearly 1", not "1 plus
//      auto-makeup" — the identity, sample for sample. A mix that never touches
//      the ceiling is bit-transparent, so there is no ducking to measure.
//   2. Above the ceiling the reduction is the MINIMUM that reaches the ceiling
//      (∞:1 on the overshoot only), not a 4:1 slope applied to everything.
//
// ── THE NO-OVERSHOOT GUARANTEE (why the output is truly bounded) ────────────
// Let D = look-ahead in samples and gt[n] = min(1, ceiling / max(|L[n]|,|R[n]|))
// — the gain sample n would need. The applied gain is built in three steps:
//
//   gmin[n] = min over k ∈ [n−D, n] of gt[k]        (running minimum)
//   env[n]  ≤ gmin[n], by the release stage below   (never rises above it)
//   s[n]    = mean of env[n−D … n]                  (a D+1-tap moving average)
//
// and sample n−D is what leaves the delay line at step n. Every term env[n−j],
// j ∈ [0, D], is ≤ gmin[n−j] = min over [n−j−D, n−j], an interval that always
// CONTAINS n−D. So every term is ≤ gt[n−D], hence their mean s[n] ≤ gt[n−D],
// hence |out[n]| ≤ ceiling. The bound is structural, not tuned — it holds for
// any release time and any input. `masterLimiterCeilingProof` in the test suite
// is the empirical restatement of it.
//
// The moving average is also what makes the gain CONTINUOUS: a bare running
// minimum steps, and a step in gain is a click. Averaging D+1 of them turns
// every step into a ramp of exactly the look-ahead length, which is the longest
// ramp that still satisfies the bound above.
//
// ── STEREO LINKING IS CORRECT HERE ─────────────────────────────────────────
// The detector takes max(|L|,|R|), i.e. one gain across both channels. That is
// deliberate and is NOT the defect the audit names: an unlinked stereo limiter
// wanders the image on every peak. What was wrong was the FULL-BAND 4:1 slope
// engaging at −6 dB, not the linking.

/** Ceiling in dBFS. −1 dB, per the audit's prescription ("raise the ceiling to
 *  ~−1 dB, sub passes at full level"). Leaves ~1 dB of head for inter-sample
 *  peaks the device's reconstruction filter can produce. */
export const MASTER_CEILING_DB = -1;

/** Ceiling in linear amplitude (≈ 0.8913). */
export const MASTER_CEILING = Math.pow(10, MASTER_CEILING_DB / 20);

/** Look-ahead, seconds. 2 ms is ~1/12 of a 40 Hz period, so the gain ramp is
 *  far shorter than the sub waveform it must not smear, while still being long
 *  enough that the ramp itself is inaudible. */
export const MASTER_LOOKAHEAD_S = 0.002;

// ── WHY THE RELEASE IS LONG (1.5 s), WHICH IS NOT A TYPICAL LIMITER SETTING ──
//
// For a stage whose stated job is "never pump the sub", release time IS the
// design. Measured on the harness in
// art/scenarios/audio-out/master-limiter-sub-pump.test.ts, driving 4 dB past
// the ceiling with a kick every 500 ms:
//
//   release   sub-band ripple   recovery after ONE isolated burst
//    0.05 s       3.74 dB         immediate
//    0.25 s       3.33 dB         0.56 s
//    0.60 s       2.28 dB         1.36 s
//    1.50 s       1.20 dB         > 2.3 s
//    5.00 s       0.43 dB         » 2.3 s
//
// Anything short enough to recover between strikes ripples AT the strike rate —
// which is the defect A1 names, merely relocated. 1.5 s is past that: the gain
// rides a near-steady reduction through a passage instead of breathing at the
// beat, and the cost is that one stray peak leaves the mix quietly ducked for
// a second or two afterwards. That is the right trade for a stage that should
// essentially never engage (the correct response to constant limiting is to
// lower MASTER, not to let the limiter chase the beat), and the recovery is a
// smooth monotonic swell rather than anything that reads as pumping.
//
// A two-branch program-dependent release (slow branch for the sustained
// reduction, fast branch for the residual) was built and MEASURED here first.
// It was worse on both axes — 2.90 dB ripple with 2.16 s recovery at the same
// drive — because the fast branch always recovers between strikes and so
// reinstates exactly the ripple it was added to remove. It was removed rather
// than kept as unearned complexity; this note is so nobody re-derives it.

/** Release, seconds. See the measured table above before changing it. */
export const MASTER_RELEASE_S = 1.5;

export interface MasterLimiterConfig {
  ceiling: number;
  lookaheadS: number;
  releaseS: number;
}

export const MASTER_LIMITER_DEFAULTS: MasterLimiterConfig = {
  ceiling: MASTER_CEILING,
  lookaheadS: MASTER_LOOKAHEAD_S,
  releaseS: MASTER_RELEASE_S,
};

export interface MasterLimiterState {
  readonly ceiling: number;
  /** Look-ahead in SAMPLES (the node's added latency). */
  readonly delaySamples: number;
  readonly relCoef: number;

  // Audio delay line (length delaySamples + 1, circular).
  dl: Float32Array;
  dr: Float32Array;
  di: number;

  // Monotonic deque over the last delaySamples+1 gain targets, for an O(1)
  // running minimum. `dqVal` is non-decreasing front→back; `dqIdx` holds the
  // absolute sample index each value was pushed at, so entries can expire.
  // f64 throughout: rounding a gain target UP to f32 would break the ≤ chain
  // the ceiling proof rests on.
  dqVal: Float64Array;
  dqIdx: Float64Array;
  dqHead: number;
  dqTail: number;

  // Moving-average ring over env (length delaySamples + 1). Also f64, and the
  // running sum only ever subtracts the exact value it added, so it cannot
  // accumulate a systematic drift over a session-length run.
  ma: Float64Array;
  mi: number;
  maSum: number;

  /** The release envelope — never above the running-minimum target. */
  env: number;
  /** Absolute sample counter (drives deque expiry). */
  n: number;
}

export function makeMasterLimiterState(
  sampleRate: number,
  cfg: Partial<MasterLimiterConfig> = {},
): MasterLimiterState {
  const c = { ...MASTER_LIMITER_DEFAULTS, ...cfg };
  const sr = sampleRate > 0 ? sampleRate : 48000;
  const delaySamples = Math.max(1, Math.round(c.lookaheadS * sr));
  const len = delaySamples + 1;
  const st: MasterLimiterState = {
    ceiling: c.ceiling,
    delaySamples,
    relCoef: Math.exp(-1 / Math.max(1, c.releaseS * sr)),
    dl: new Float32Array(len),
    dr: new Float32Array(len),
    di: 0,
    dqVal: new Float64Array(len + 1),
    dqIdx: new Float64Array(len + 1),
    dqHead: 0,
    dqTail: 0,
    ma: new Float64Array(len),
    mi: 0,
    maSum: len, // every slot starts at unity gain
    env: 1,
    n: 0,
  };
  st.ma.fill(1);
  return st;
}

export function masterLimiterReset(st: MasterLimiterState): void {
  st.dl.fill(0);
  st.dr.fill(0);
  st.di = 0;
  st.dqHead = 0;
  st.dqTail = 0;
  st.ma.fill(1);
  st.mi = 0;
  st.maSum = st.ma.length;
  st.env = 1;
  st.n = 0;
}

/**
 * Process ONE stereo frame. Writes the limited pair into `out` (length ≥ 2).
 * Returns the gain that was applied to this output frame (1 = untouched) —
 * exposed so a meter or a test can read the reduction without re-deriving it.
 */
export function masterLimiterStepStereo(
  l: number,
  r: number,
  st: MasterLimiterState,
  out: Float32Array,
): number {
  const len = st.dl.length;

  // ── the gain sample n would need, if it were applied instantaneously ──
  const mag = Math.max(Math.abs(l), Math.abs(r));
  const gt = mag > st.ceiling ? st.ceiling / mag : 1;

  // ── running minimum of gt over the last `delaySamples + 1` samples ──
  // Pop any tail entries no smaller than gt (they can never be the minimum
  // again), then push; then drop the front if it has aged out of the window.
  let tail = st.dqTail;
  while (tail !== st.dqHead) {
    const prev = (tail - 1 + st.dqVal.length) % st.dqVal.length;
    if (st.dqVal[prev]! >= gt) tail = prev;
    else break;
  }
  st.dqVal[tail] = gt;
  st.dqIdx[tail] = st.n;
  st.dqTail = (tail + 1) % st.dqVal.length;
  while (st.dqIdx[st.dqHead]! <= st.n - len) {
    st.dqHead = (st.dqHead + 1) % st.dqVal.length;
  }
  const gmin = st.dqVal[st.dqHead]!;

  // ── release: duck instantly (the look-ahead covers the ramp), recover slowly.
  //    `env ≤ gmin` in both arms, which is the step the ceiling proof needs. ──
  st.env = gmin <= st.env ? gmin : gmin + (st.env - gmin) * st.relCoef;

  // ── moving average over the look-ahead window → a continuous applied gain ──
  st.maSum += st.env - st.ma[st.mi]!;
  st.ma[st.mi] = st.env;
  st.mi = st.mi + 1 === len ? 0 : st.mi + 1;
  const g = st.maSum / len;

  // ── delay the audio by exactly the look-ahead, then apply the gain ──
  const rd = st.di + 1 === len ? 0 : st.di + 1; // oldest slot = sample n − delay
  const dLo = st.dl[rd]!;
  const dRo = st.dr[rd]!;
  st.dl[st.di] = l;
  st.dr[st.di] = r;
  st.di = rd;
  st.n++;

  // The clamp is unreachable given the proof in the header — it exists so the
  // ceiling is guaranteed by the CODE and not only by the argument, on a stage
  // whose failure mode is a blown speaker. (Negative-controlled in the test
  // suite: with the moving-average smoothing disabled the proof no longer
  // applies and the clamp is what still holds the bound.)
  const ol = dLo * g;
  const or = dRo * g;
  out[0] = ol > st.ceiling ? st.ceiling : ol < -st.ceiling ? -st.ceiling : ol;
  out[1] = or > st.ceiling ? st.ceiling : or < -st.ceiling ? -st.ceiling : or;
  return g;
}
