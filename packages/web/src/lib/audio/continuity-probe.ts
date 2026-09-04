// packages/web/src/lib/audio/continuity-probe.ts
//
// THE GRAPH-CONTINUITY PROBE — an audio-thread instrument for "did the output
// break?", and an honest statement of what it can and cannot see.
//
// ── ⚠ THE NAMING CORRECTION THIS FILE EXISTS TO MAKE ───────────────────────
// The continuity work was specified as an "AudioWorklet-resident min-RMS /
// UNDERRUN accumulator" at the master tap. A minimum-RMS floor on a graph tap
// is not an underrun detector, and calling it one is precisely the hazard
// `playback-stats.ts`'s header (:13-25) was written to stop — that header
// documents a plan that named two properties which do not exist, and notes
// "anyone implementing the plan as written would have probed the wrong
// property". Same failure shape, one layer up: implement a graph-silence floor,
// name it an underrun counter, and every reader downstream believes device
// starvation is covered when it is not.
//
// So: this is a GRAPH-CONTINUITY probe. Device starvation is a different
// disease with a different detector, already in the tree (mode A below).
//
// ── THE FOUR DISEASES ALREADY NAMED, AND WHERE THIS FITS ───────────────────
// `audio-health.svelte.ts:3-13` already ships a four-mode taxonomy:
//   A device underruns        → playback-stats.ts (`AudioContext.playbackStats`)
//   B permanent worklet death → worklet-guard.ts
//   C context suspension      → audio-gate.svelte.ts
//   D main-thread starvation  → tick-latency.ts
// This probe is NOT a fifth copy of any of them. It answers what none of them
// can: is the SIGNAL still continuous — present, moving, and free of
// discontinuities — through a workflow that is supposed to be seamless.
//
// ── WHAT A MIN-RMS FLOOR IS STRUCTURALLY BLIND TO ──────────────────────────
// All four are proven in continuity-probe.test.ts against the shipped source:
//
//  1. A FROZEN / REPEATED BUFFER. A stuck buffer has a perfectly healthy RMS —
//     it is a real signal, replayed. A minimum-tracker cannot move. → `repeatRun`
//     compares each block to the previous one EXACTLY, sample for sample.
//  2. A STALLED PROBE. If the worklet stops being pulled, an accumulator
//     records nothing and its minimum stays wherever it was: SILENTLY GREEN,
//     the worst failure an instrument has. → `blocks`/`frames` are MONOTONIC
//     COUNTERS, so the reader sees "no progress", and staleness is a violation.
//  3. A CLICK. A discontinuity is a positive amplitude excursion: it RAISES
//     RMS in its window, so a minimum-tracker is green THROUGH the failure it
//     was deployed for. The one binding owner requirement in this area is a
//     CLICK-FREE CROSSFADE, and a min-RMS floor cannot fail on a click at all.
//     → `maxStep` = max |x[n] − x[n−1]|, INCLUDING the block seam.
//  4. EXPECTED PATCH SILENCE. A master-tap floor cannot tell "the patch is
//     quiet on purpose" from "the infrastructure died", which forces every
//     continuity spec to be authored around a hand-picked tone patch and makes
//     any legitimately-quiet patch unassertable. → `pilot`, a Goertzel readout
//     of a persistent low-level tone. Assert the PILOT's floor and patch
//     content stops being part of the measurement.
//
// ── ⚠ WHAT THIS PROBE CANNOT SEE, STATED PLAINLY ───────────────────────────
// DEVICE-CALLBACK REPEATS AND DROPOUTS ARE INVISIBLE IN-GRAPH. When the output
// device starves, the platform replays or zero-fills BELOW every graph tap;
// nothing in the render graph observes it. `AudioContext.playbackStats` is the
// only detector (`underrunDuration` is documented as "silence/**repeat**
// played"), and `diffAudioHealth` in playback-stats.ts is the delta reader for
// asserting it across a workflow.
//
// ⚠ AND playbackStats IS VACUOUS ON HEADLESS CI. `e2e/tests/
// audio-health-readout.spec.ts:6-11` measured it on this runner: a NULL AUDIO
// SINK, `outputLatency` 0, and "an underrun literally cannot occur". So the
// device leg is real only on a machine with a real device, and this probe is
// the only instrument that can go red on the headless lane. Neither replaces
// the other; a continuity claim needs both legs named.
//
// ── ⚠ WHERE THE TAP LIVES (read before mounting it at "the master") ────────
// There is NO app-lifetime master bus today. `audio/modules/audio-out.ts` is a
// MODULE — patch content — so a probe mounted on the terminal chain is
// DESTROYED BY A PATCH LOAD, which is the exact event a continuity instrument
// is deployed to measure. Until the terminal chain is slot-keyed and outlives a
// patch swap, mount this on a source you control for the duration of the thing
// you are measuring, and do not describe a patch-owned tap as an app-lifetime
// one. The pilot injector below has the same dependency: it belongs in the
// app-lifetime chain, post-patch and pre-limiter.
//
// The worklet is built from an INLINE BLOB (the `gate-edge-worklet.ts` /
// `scheduler-clock.ts` pattern), so it needs no packages/dsp build artifact, no
// SHA pin, and no ART attest basis churn. The source is a plain string literal,
// and continuity-probe.test.ts evaluates THIS EXACT STRING, so the shipped code
// and the tested code cannot drift.

/** Registered processor name (also used by the unit test). */
export const CONTINUITY_PROBE_PROCESSOR = 'patchtogether-continuity-probe';

/**
 * PILOT FREQUENCY — the persistent low-level tone that makes the floor
 * patch-INDEPENDENT.
 *
 * Chosen so that its period divides neither render quantum: at 48 kHz a block
 * is 375 Hz worth of time and 19000/375 = 50.67 cycles per block; at 44.1 kHz
 * it is 55.15. Non-integer in both, which matters twice — the Goertzel readout
 * is stable, and the pilot alone guarantees consecutive blocks DIFFER, which is
 * what removes the one false positive `repeatRun` has on its own (see
 * `maxRepeatBlocks`).
 *
 * 19 kHz is above the musical range and effectively inaudible at the default
 * level; it is high enough to be trimmed by a hostile downsample, which is why
 * the pilot leg is asserted where it is injected rather than assumed globally.
 */
export const CONTINUITY_PILOT_HZ = 19_000;

/** Default pilot amplitude: −80 dBFS. Below the noise floor of anything a
 *  listener will hear, far above the resolution of a Goertzel over a window. */
export const CONTINUITY_PILOT_GAIN = 1e-4;

/** Blocks per report. 64 x 128 samples ≈ 170 ms at 48 kHz → ~6 messages/sec,
 *  so the port is never a bottleneck and a fault surfaces within a beat. */
export const CONTINUITY_REPORT_BLOCKS = 64;

/**
 * One windowed report from the audio thread.
 *
 * ⚠ `blocks` and `frames` are MONOTONIC SINCE CONSTRUCTION; every other field
 * is WINDOWED (reset each report). The unit is in the name wherever a human
 * reads it, because half this repo's instrument bugs were unit confusions.
 */
export interface ContinuityReport {
  /** Monotonic report sequence number, from 1. Gaps mean lost messages. */
  seq: number;
  /** Monotonic count of `process()` calls since construction. */
  blocks: number;
  /** Monotonic count of sample frames observed since construction. */
  frames: number;
  /** The audio clock at the end of this window, seconds. */
  audioTime: number;
  /** Sample rate the processor is running at. */
  sampleRate: number;
  /** Blocks summarised by this report. */
  windowBlocks: number;
  /** LOWEST per-block RMS in the window, worst channel. The graph-continuity
   *  floor — and, on its own, blind to items 1-4 in the header. */
  minRms: number;
  /** Highest per-block RMS in the window, worst channel. */
  maxRms: number;
  /** Largest |x| in the window, any channel. */
  peak: number;
  /** Largest |x[n] − x[n−1]| in the window, INCLUDING the seam between blocks.
   *  The click / discontinuity metric. */
  maxStep: number;
  /** Estimated amplitude at CONTINUITY_PILOT_HZ over the window (Goertzel).
   *  ~0 when no pilot is injected. */
  pilot: number;
  /** Longest run of consecutive BIT-IDENTICAL blocks, carried across windows.
   *  A frozen/repeated buffer; healthy RMS, healthy peak, unmoving content. */
  repeatRun: number;
  /** True while the current block is still identical to the previous one, so a
   *  freeze in progress is visible before the run ends. */
  repeating: boolean;
}

/**
 * Processor source. Self-contained — an AudioWorkletGlobalScope has no module
 * graph here — so every constant is baked in at build time.
 *
 * Reads `sampleRate` / `currentTime` / `currentFrame` defensively: they are
 * AudioWorkletGlobalScope globals in a real worklet and shimmed in the test.
 */
export const CONTINUITY_PROBE_SOURCE = `
class ContinuityProbeProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this._reportBlocks = o.reportBlocks > 0 ? (o.reportBlocks | 0) : ${CONTINUITY_REPORT_BLOCKS};
    this._sr = typeof sampleRate === 'number' && sampleRate > 0 ? sampleRate : 48000;
    const pilotHz = o.pilotHz > 0 ? o.pilotHz : ${CONTINUITY_PILOT_HZ};
    this._coeff = 2 * Math.cos((2 * Math.PI * pilotHz) / this._sr);
    // ⚠ PRE-EMPHASIS, AND WHY THE PILOT READOUT IS WRONG WITHOUT IT.
    // A bare Goertzel at 19 kHz is not a filter — a rectangular-window DFT bin
    // leaks from every other component as ~A/(pi*binDistance). MEASURED on the
    // first draft: 0.8 amplitude of 441 Hz music with NO pilot present read
    // 3.85e-4 in the pilot bin — nearly 4x the 1e-4 pilot level, so "the pilot
    // is gone" was unfalsifiable while the patch was loud. That is a dead
    // instrument, not a conservative one.
    // A second-order difference (a 12 dB/octave high-pass, two adds) fixes it:
    // its gain is (2*sin(pi*f/fs))^2, which is 3.42 at 19 kHz and 0.0033 at
    // 441 Hz — a ~1000x relative rejection, dropping that leakage to ~1e-6.
    // Divide the magnitude back out by the pilot-frequency gain and the readout
    // is an amplitude again.
    this._preGain = Math.pow(2 * Math.sin((Math.PI * pilotHz) / this._sr), 2);
    this._d1 = 0;
    this._d2 = 0;

    this._seq = 0;
    this._blocks = 0;
    this._frames = 0;
    // Per-channel last sample, for the BLOCK SEAM. A click that lands exactly
    // on a block boundary is the crossfade case, so the seam is not optional:
    // resetting prev to 0 each block would both miss that click and invent a
    // step of |x[0]| on every single block.
    this._prevSample = [];
    this._prevBlock = null;   // Float32Array copy of the previous block, ch-major
    this._prevChans = 0;
    this._prevLen = 0;
    this._repeatRunCur = 0;
    this._repeating = false;
    this._resetWindow();
  }

  _resetWindow() {
    this._wBlocks = 0;
    this._minRms = Infinity;
    this._maxRms = 0;
    this._peak = 0;
    this._maxStep = 0;
    this._repeatRunMax = this._repeatRunCur; // carry an in-progress freeze
    this._g1 = 0;
    this._g2 = 0;
    this._gN = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;
    const nch = input.length;
    const len = input[0].length;
    if (len === 0) return true;

    this._blocks++;
    this._frames += len;
    this._wBlocks++;

    // ── per-channel RMS / peak / max step (seam-aware) ────────────────────
    let blockMinRms = Infinity;
    let blockMaxRms = 0;
    for (let c = 0; c < nch; c++) {
      const ch = input[c];
      if (!ch) continue;
      let sum = 0;
      let prev = this._prevSample.length > c ? this._prevSample[c] : ch[0];
      for (let i = 0; i < len; i++) {
        const v = ch[i];
        sum += v * v;
        const a = v < 0 ? -v : v;
        if (a > this._peak) this._peak = a;
        let d = v - prev;
        if (d < 0) d = -d;
        if (d > this._maxStep) this._maxStep = d;
        prev = v;
      }
      this._prevSample[c] = prev;
      const rms = Math.sqrt(sum / len);
      if (rms < blockMinRms) blockMinRms = rms;
      if (rms > blockMaxRms) blockMaxRms = rms;
    }
    if (blockMinRms < this._minRms) this._minRms = blockMinRms;
    if (blockMaxRms > this._maxRms) this._maxRms = blockMaxRms;

    // ── FROZEN BUFFER: exact, sample-for-sample, every channel ────────────
    // An EXACT compare rather than a hash: a stuck buffer is bit-identical, so
    // there is no reason to accept a collision probability in exchange for
    // nothing. 128 comparisons per block is noise next to the RMS loop above.
    let same = this._prevBlock !== null && this._prevChans === nch && this._prevLen === len;
    if (same) {
      outer:
      for (let c = 0; c < nch; c++) {
        const ch = input[c];
        const base = c * len;
        for (let i = 0; i < len; i++) {
          if (ch[i] !== this._prevBlock[base + i]) { same = false; break outer; }
        }
      }
    }
    if (same) {
      this._repeatRunCur++;
      this._repeating = true;
    } else {
      this._repeatRunCur = 0;
      this._repeating = false;
    }
    if (this._repeatRunCur > this._repeatRunMax) this._repeatRunMax = this._repeatRunCur;

    if (this._prevBlock === null || this._prevChans !== nch || this._prevLen !== len) {
      this._prevBlock = new Float32Array(nch * len);
      this._prevChans = nch;
      this._prevLen = len;
    }
    for (let c = 0; c < nch; c++) {
      const ch = input[c];
      if (ch) this._prevBlock.set(ch, c * len);
    }

    // ── PILOT: Goertzel accumulated across the whole window ───────────────
    // Channel 0 only: the pilot is injected once, into the master chain.
    const ch0 = input[0];
    let s1 = this._g1;
    let s2 = this._g2;
    let d1 = this._d1;
    let d2 = this._d2;
    const coeff = this._coeff;
    for (let i = 0; i < len; i++) {
      const x = ch0[i];
      const y = x - 2 * d1 + d2; // pre-emphasis; see the constructor
      d2 = d1;
      d1 = x;
      const s = y + coeff * s1 - s2;
      s2 = s1;
      s1 = s;
    }
    this._g1 = s1;
    this._g2 = s2;
    this._d1 = d1;
    this._d2 = d2;
    this._gN += len;

    if (this._wBlocks >= this._reportBlocks) this._emit();
    return true;
  }

  _emit() {
    const n = this._gN;
    // |X(f)| from the Goertzel state, scaled to an AMPLITUDE estimate.
    const power = this._g2 * this._g2 + this._g1 * this._g1 - this._coeff * this._g1 * this._g2;
    // Divide the pre-emphasis gain back out so the reported pilot is an
    // AMPLITUDE, comparable to CONTINUITY_PILOT_GAIN, not a filtered proxy.
    const pilot =
      n > 0 && power > 0 && this._preGain > 0 ? (2 * Math.sqrt(power)) / n / this._preGain : 0;
    this._seq++;
    this.port.postMessage({
      seq: this._seq,
      blocks: this._blocks,
      frames: this._frames,
      audioTime: typeof currentTime === 'number' ? currentTime : this._frames / this._sr,
      sampleRate: this._sr,
      windowBlocks: this._wBlocks,
      minRms: this._minRms === Infinity ? 0 : this._minRms,
      maxRms: this._maxRms,
      peak: this._peak,
      maxStep: this._maxStep,
      pilot: pilot,
      repeatRun: this._repeatRunMax,
      repeating: this._repeating,
    });
    this._resetWindow();
  }
}
registerProcessor(${JSON.stringify(CONTINUITY_PROBE_PROCESSOR)}, ContinuityProbeProcessor);
`;

// ── THE EVALUATOR (pure, main thread) ──────────────────────────────────────

export type ContinuityViolationKind =
  /** The tapped signal fell below the graph-continuity floor. */
  | 'silence'
  /** The persistent pilot is gone: infrastructure, not patch content. */
  | 'pilotLost'
  /** A discontinuity — the click metric the crossfade requirement needs. */
  | 'click'
  /** Bit-identical blocks: a frozen / repeated buffer. Healthy RMS throughout. */
  | 'frozen'
  /** The probe stopped advancing: the worklet is not being pulled. */
  | 'stalled';

export interface ContinuityViolation {
  kind: ContinuityViolationKind;
  /** The measured value that broke the limit. */
  value: number;
  /** The limit it broke. */
  limit: number;
  /** Report sequence number this was observed at (0 for a staleness verdict,
   *  which is about reports that never arrived). */
  seq: number;
}

export interface ContinuityThresholds {
  /** Floor for the tapped signal's per-block RMS. 0 disables (use the pilot
   *  leg instead whenever the patch is allowed to be legitimately quiet). */
  minRms: number;
  /** Floor for the pilot amplitude. 0 = no pilot injected, leg disabled. */
  minPilot: number;
  /** Ceiling for |x[n] − x[n−1]|. A full-scale square edge is 2.0, so this is
   *  a per-sample slew limit, not a level limit. */
  maxStep: number;
  /** Longest tolerated run of bit-identical blocks.
   *
   *  ⚠ THE ONE KNOWN FALSE POSITIVE: a perfectly periodic signal whose period
   *  divides the 128-sample quantum (at 48 kHz: 375 Hz and its harmonics) is
   *  bit-identical block to block and is NOT frozen. That is why the pilot
   *  exists at a frequency that divides neither quantum — with the pilot mixed
   *  in, consecutive blocks always differ, and this leg has no false positive
   *  left. Without a pilot, keep the threshold generous and know the caveat.
   *  continuity-probe.test.ts carries this exact case as a negative control. */
  maxRepeatBlocks: number;
  /** Longest tolerated gap, in wall-clock ms, with no advance in `frames`. */
  maxStaleMs: number;
}

/** Defaults sized for a 48 kHz master tap. Every one is overridable per call —
 *  a floor is a property of what you tapped, not of the instrument. */
export const DEFAULT_CONTINUITY_THRESHOLDS: ContinuityThresholds = Object.freeze({
  minRms: 0,
  minPilot: 0,
  maxStep: 0.5,
  maxRepeatBlocks: 24, // ≈ 64 ms at 48 kHz
  maxStaleMs: 500,
});

/**
 * Judge ONE report. PURE — no clock, no state, unit-testable with a literal.
 *
 * Returns every violation, not the first: a crossfade that clicks AND drops the
 * pilot is two findings, and collapsing them to one hides half the diagnosis.
 */
export function evaluateContinuity(
  report: ContinuityReport,
  thresholds: Partial<ContinuityThresholds> = {},
): ContinuityViolation[] {
  const t = { ...DEFAULT_CONTINUITY_THRESHOLDS, ...thresholds };
  const out: ContinuityViolation[] = [];
  if (t.minRms > 0 && report.minRms < t.minRms) {
    out.push({ kind: 'silence', value: report.minRms, limit: t.minRms, seq: report.seq });
  }
  if (t.minPilot > 0 && report.pilot < t.minPilot) {
    out.push({ kind: 'pilotLost', value: report.pilot, limit: t.minPilot, seq: report.seq });
  }
  if (report.maxStep > t.maxStep) {
    out.push({ kind: 'click', value: report.maxStep, limit: t.maxStep, seq: report.seq });
  }
  if (report.repeatRun > t.maxRepeatBlocks) {
    out.push({ kind: 'frozen', value: report.repeatRun, limit: t.maxRepeatBlocks, seq: report.seq });
  }
  return out;
}

/**
 * Judge PROGRESS between two reports — the leg a minimum-tracker cannot have.
 *
 * ⚠ THIS IS NOT THE `currentTime` VS `performance.now()` COMPARISON THAT
 * playback-stats.ts's header calls structurally blind, and the difference is
 * the whole point. That one is invariant to what it claims to measure because
 * the DEVICE clock keeps consuming samples at the sample rate whether the
 * buffer held audio or silence, so it reads clean straight through a dropout.
 * `frames` here is the PROBE'S OWN count of blocks it was handed. If the
 * worklet stops being pulled — the graph stalled, the node was torn down, the
 * context suspended — that counter stops while wall-clock advances. Variant to
 * the thing it measures, and it is exactly the "silently green because it
 * recorded nothing" failure that makes an accumulator worse than no gate.
 *
 * `prev`/`cur` may be the same report (nothing arrived since): then `advanced`
 * is 0 and any `wallElapsedMs` over the limit is a stall.
 */
export function evaluateContinuityProgress(
  prev: ContinuityReport | null,
  cur: ContinuityReport | null,
  wallElapsedMs: number,
  thresholds: Partial<ContinuityThresholds> = {},
): ContinuityViolation | null {
  const t = { ...DEFAULT_CONTINUITY_THRESHOLDS, ...thresholds };
  if (wallElapsedMs <= t.maxStaleMs) return null;
  const advanced = prev && cur ? cur.frames - prev.frames : cur ? cur.frames : 0;
  if (advanced > 0) return null;
  return { kind: 'stalled', value: wallElapsedMs, limit: t.maxStaleMs, seq: 0 };
}

// ── MOUNTING ───────────────────────────────────────────────────────────────

/** Contexts whose audioWorklet already has the module registered. */
const REGISTERED = new WeakSet<BaseAudioContext>();
/** In-flight registrations, so N concurrent probes share ONE addModule. */
const PENDING = new WeakMap<BaseAudioContext, Promise<boolean>>();

/**
 * Idempotently register the processor on `ctx`. Resolves true when available,
 * FALSE (never throws) when the environment can't take it — a CSP that forbids
 * blob: worklets, a stubbed test context, an older browser. Same contract as
 * `ensureGateEdgeWorklet`: a probe that cannot mount must degrade to "no
 * instrument", never to a broken graph.
 */
export function ensureContinuityProbeWorklet(ctx: BaseAudioContext): Promise<boolean> {
  if (REGISTERED.has(ctx)) return Promise.resolve(true);
  const inFlight = PENDING.get(ctx);
  if (inFlight) return inFlight;
  const p = (async (): Promise<boolean> => {
    try {
      const aw = (ctx as unknown as { audioWorklet?: { addModule(u: string): Promise<void> } })
        .audioWorklet;
      if (!aw || typeof aw.addModule !== 'function') return false;
      if (
        typeof Blob === 'undefined' ||
        typeof URL === 'undefined' ||
        typeof URL.createObjectURL !== 'function'
      ) {
        return false;
      }
      const blob = new Blob([CONTINUITY_PROBE_SOURCE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      try {
        await aw.addModule(url);
      } finally {
        try {
          URL.revokeObjectURL(url);
        } catch {
          /* */
        }
      }
      REGISTERED.add(ctx);
      return true;
    } catch {
      return false;
    }
  })();
  PENDING.set(ctx, p);
  return p;
}

/** Test-only: forget registration state between cases. */
export function __resetContinuityProbeForTests(ctx: BaseAudioContext): void {
  REGISTERED.delete(ctx);
  PENDING.delete(ctx);
}

/**
 * The persistent PILOT source: an oscillator at CONTINUITY_PILOT_HZ scaled to
 * an inaudible level, returned unstarted-but-started and ready to connect.
 *
 * ⚠ WHERE IT BELONGS. The pilot must live in an APP-LIFETIME chain, injected
 * post-patch and pre-limiter, or it is destroyed by the same patch load the
 * instrument is measuring — `audio/modules/audio-out.ts` is a MODULE, so the
 * terminal chain today is patch content. Until that chain is slot-keyed, mount
 * this beside whatever source you control for the span you are measuring, and
 * do not describe the result as an app-lifetime floor.
 *
 * `dispose()` stops and disconnects; calling it twice is safe.
 */
export function createContinuityPilot(
  ctx: BaseAudioContext,
  opts: { hz?: number; gain?: number } = {},
): { output: AudioNode; dispose: () => void } {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = opts.hz ?? CONTINUITY_PILOT_HZ;
  const g = ctx.createGain();
  g.gain.value = opts.gain ?? CONTINUITY_PILOT_GAIN;
  osc.connect(g);
  osc.start();
  let disposed = false;
  return {
    output: g,
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        osc.stop();
      } catch {
        /* already stopped */
      }
      try {
        osc.disconnect();
      } catch {
        /* */
      }
      try {
        g.disconnect();
      } catch {
        /* */
      }
    },
  };
}
