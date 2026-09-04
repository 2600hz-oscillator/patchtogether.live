// packages/web/src/lib/audio/continuity-probe.test.ts
//
// The graph-continuity probe, tested by EVALUATING THE SHIPPED SOURCE STRING —
// `CONTINUITY_PROBE_SOURCE` is what `ensureContinuityProbeWorklet` hands to
// `addModule`, and it is what these tests drive, so the tested code and the
// shipped code cannot drift. (Same discipline as gate-edge-worklet.test.ts.)
//
// ── THE PROOFS THIS FILE OWES ──────────────────────────────────────────────
// The instrument this replaces was specified as a min-RMS floor called an
// "underrun accumulator". Every case below is written as a PAIRED assertion:
// what the min-RMS floor reports, and what the probe reports, on the SAME
// samples. A case that only asserted the probe fires would not show that the
// floor is blind, and "the floor is blind" is the entire finding.
//
//   1. FROZEN BUFFER — a repeated buffer has a perfectly healthy RMS.
//   2. STALLED PROBE — an accumulator that is never called stays green.
//   3. CLICK — a discontinuity RAISES RMS, so a MINIMUM tracker cannot move.
//   4. PATCH SILENCE — a floor cannot tell "quiet on purpose" from "dead".
//
// Zero wall-clock and zero rAF: the processor is driven block by block with
// synthesized sample data.

import { describe, it, expect } from 'vitest';
import {
  CONTINUITY_PROBE_SOURCE,
  CONTINUITY_PROBE_PROCESSOR,
  CONTINUITY_PILOT_HZ,
  CONTINUITY_PILOT_GAIN,
  CONTINUITY_REPORT_BLOCKS,
  DEFAULT_CONTINUITY_THRESHOLDS,
  evaluateContinuity,
  evaluateContinuityProgress,
  type ContinuityReport,
} from './continuity-probe';

const BLOCK = 128;
const SR = 48_000;

interface Harness {
  /** Feed one block per channel; `gen(i, c)` returns the sample value. */
  block(gen: (i: number, c: number) => number, channels?: number): void;
  /** Feed `n` blocks from a continuous sample-index generator. */
  run(n: number, gen: (n: number) => number, channels?: number): void;
  /** Feed `n` blocks of the SAME Float32Array — a frozen buffer. */
  freeze(buf: Float32Array, n: number, channels?: number): void;
  reports: ContinuityReport[];
  name: string;
  /** Absolute sample index consumed so far (for a continuous generator). */
  cursor: number;
}

/** Evaluate the shipped worklet source with shimmed AudioWorkletGlobalScope
 *  globals and return a driveable processor instance. */
function makeProbe(processorOptions: Record<string, unknown> = {}): Harness {
  const reports: ContinuityReport[] = [];
  let Ctor:
    | (new (o?: { processorOptions?: Record<string, unknown> }) => {
        process(inputs: Float32Array[][]): boolean;
      })
    | undefined;
  let name = '';
  const g = globalThis as unknown as Record<string, unknown>;
  const prev = {
    base: g.AudioWorkletProcessor,
    reg: g.registerProcessor,
    sr: g.sampleRate,
    ct: g.currentTime,
  };
  g.AudioWorkletProcessor = class {
    port = {
      postMessage: (m: ContinuityReport) => {
        reports.push(m);
      },
    };
  };
  g.registerProcessor = (n: string, c: unknown) => {
    name = n;
    Ctor = c as typeof Ctor;
  };
  g.sampleRate = SR;
  g.currentTime = 0;
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    new Function(CONTINUITY_PROBE_SOURCE)();
  } finally {
    g.AudioWorkletProcessor = prev.base;
    g.registerProcessor = prev.reg;
    g.sampleRate = prev.sr;
    g.currentTime = prev.ct;
  }
  if (!Ctor) throw new Error('worklet source did not registerProcessor');
  const proc = new Ctor({ processorOptions });

  const h: Harness = {
    name,
    reports,
    cursor: 0,
    block(gen, channels = 1) {
      const chans: Float32Array[] = [];
      for (let c = 0; c < channels; c++) {
        const ch = new Float32Array(BLOCK);
        for (let i = 0; i < BLOCK; i++) ch[i] = gen(i, c);
        chans.push(ch);
      }
      h.cursor += BLOCK;
      proc.process([chans]);
    },
    run(n, gen, channels = 1) {
      for (let b = 0; b < n; b++) {
        const start = h.cursor;
        h.block((i) => gen(start + i), channels);
      }
    },
    freeze(buf, n, channels = 1) {
      // The SAME array object, handed over repeatedly — a stuck buffer.
      const chans = Array.from({ length: channels }, () => buf);
      for (let b = 0; b < n; b++) {
        h.cursor += BLOCK;
        proc.process([chans]);
      }
    },
  };
  return h;
}

/** A steady sine at `hz`, amplitude `amp`, as a function of absolute sample. */
function sine(hz: number, amp = 0.5) {
  return (n: number) => amp * Math.sin((2 * Math.PI * hz * n) / SR);
}

/** What a MIN-RMS-FLOOR-ONLY instrument would report over the same reports:
 *  the lowest per-block RMS it ever saw. This is the whole of the instrument
 *  being replaced, so every proof below is stated against it. */
function floorOnlyVerdict(reports: ContinuityReport[], floor: number): 'green' | 'red' {
  return reports.some((r) => r.minRms < floor) ? 'red' : 'green';
}

describe('continuity probe — registration + shape', () => {
  it('registers under the exported processor name', () => {
    expect(makeProbe().name).toBe(CONTINUITY_PROBE_PROCESSOR);
  });

  it('emits one report every CONTINUITY_REPORT_BLOCKS blocks, monotonically', () => {
    const h = makeProbe();
    h.run(CONTINUITY_REPORT_BLOCKS * 3, sine(440));
    expect(h.reports).toHaveLength(3);
    expect(h.reports.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(h.reports.map((r) => r.blocks)).toEqual([
      CONTINUITY_REPORT_BLOCKS,
      CONTINUITY_REPORT_BLOCKS * 2,
      CONTINUITY_REPORT_BLOCKS * 3,
    ]);
    expect(h.reports.map((r) => r.frames)).toEqual([
      CONTINUITY_REPORT_BLOCKS * BLOCK,
      CONTINUITY_REPORT_BLOCKS * BLOCK * 2,
      CONTINUITY_REPORT_BLOCKS * BLOCK * 3,
    ]);
    expect(h.reports.every((r) => r.windowBlocks === CONTINUITY_REPORT_BLOCKS)).toBe(true);
  });

  it('measures a steady tone the way a level meter would', () => {
    const h = makeProbe({ reportBlocks: 8 });
    h.run(8, sine(440, 0.5));
    const r = h.reports[0]!;
    expect(r.minRms).toBeGreaterThan(0.3); // 0.5/√2 ≈ 0.354
    expect(r.minRms).toBeLessThan(0.4);
    expect(r.peak).toBeGreaterThan(0.45);
    expect(r.peak).toBeLessThanOrEqual(0.5 + 1e-6);
    expect(r.sampleRate).toBe(SR);
  });
});

// ── PROOF 1: THE FROZEN BUFFER ─────────────────────────────────────────────
describe('PROOF 1 — a frozen buffer has a perfectly healthy RMS', () => {
  it('the min-RMS floor is GREEN through a total freeze; the probe is RED', () => {
    const h = makeProbe({ reportBlocks: 8 });
    // A real, loud block of audio...
    const stuck = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) stuck[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
    // ...replayed forever. This is what a stuck upstream buffer looks like.
    h.freeze(stuck, 64);

    const reports = h.reports;
    expect(reports.length).toBeGreaterThan(0);

    // THE FLOOR: every block is a healthy 0.35 RMS. A minimum-tracker with any
    // sane floor sees nothing wrong, for as long as the freeze lasts.
    expect(Math.min(...reports.map((r) => r.minRms))).toBeGreaterThan(0.3);
    expect(floorOnlyVerdict(reports, 0.05)).toBe('green');
    // The peak meter is equally blind — the signal really is at 0.5.
    expect(Math.min(...reports.map((r) => r.peak))).toBeGreaterThan(0.45);

    // THE PROBE: bit-identical blocks, counted, and the run grows past the
    // window boundary rather than resetting with it.
    const last = reports[reports.length - 1]!;
    expect(last.repeatRun).toBeGreaterThan(DEFAULT_CONTINUITY_THRESHOLDS.maxRepeatBlocks);
    expect(last.repeating).toBe(true);
    expect(evaluateContinuity(last).map((v) => v.kind)).toContain('frozen');
  });

  it('NEGATIVE CONTROL: a LIVE signal of the same level is not called frozen', () => {
    // The same amplitude, the same peak, the same RMS — only the content moves.
    // Without this, "frozen" could be firing on level and nobody would know.
    const h = makeProbe({ reportBlocks: 8 });
    h.run(64, sine(441, 0.5)); // 441 Hz: NOT block-periodic at 48 kHz
    for (const r of h.reports) {
      expect(r.repeatRun).toBe(0);
      expect(r.repeating).toBe(false);
      expect(evaluateContinuity(r).map((v) => v.kind)).not.toContain('frozen');
    }
  });

  it('a freeze that THAWS ends the run, and the ongoing run is visible mid-freeze', () => {
    const h = makeProbe({ reportBlocks: 8 });
    const stuck = new Float32Array(BLOCK).fill(0.4);
    h.freeze(stuck, 16);
    expect(h.reports[h.reports.length - 1]!.repeating).toBe(true);
    h.run(16, sine(441, 0.5)); // recovery
    const after = h.reports[h.reports.length - 1]!;
    expect(after.repeating).toBe(false);
    expect(after.repeatRun).toBe(0);
  });

  it('a freeze on ONE channel of a stereo pair still counts as moving', () => {
    // Blocks are only "identical" when EVERY channel is; a half-frozen bus is a
    // different disease (and the RMS floor catches a dead channel via the
    // worst-channel minimum, asserted in PROOF 4).
    const h = makeProbe({ reportBlocks: 8 });
    h.run(16, sine(441, 0.5), 2);
    for (const r of h.reports) expect(r.repeatRun).toBe(0);
  });

  it('KNOWN FALSE POSITIVE, bounded and controlled: a BIT-EXACT periodic block', () => {
    // 375 Hz at 48 kHz is exactly one cycle per 128-sample quantum. If a source
    // emits the SAME COMPUTED VALUES each block — a table replay, a synthesized
    // fixture — its blocks are bit-identical while it is perfectly live, and
    // `repeatRun` fires. Pinned here so nobody rediscovers it as a new bug.
    const h = makeProbe({ reportBlocks: 8 });
    const tone = sine(SR / BLOCK, 0.5); // 375 Hz
    for (let b = 0; b < 64; b++) h.block((i) => tone(i)); // values re-derived from i
    expect(h.reports[h.reports.length - 1]!.repeatRun).toBeGreaterThan(0);

    // ⚠ HOW NARROW IT ACTUALLY IS: it needs BIT-exact repetition. The same
    // 375 Hz from a phase-ACCUMULATING oscillator (argument derived from the
    // absolute sample index, as any real VCO does it) differs in the low bits
    // block to block, so it never trips.
    const real = makeProbe({ reportBlocks: 8 });
    real.run(64, sine(SR / BLOCK, 0.5));
    for (const r of real.reports) expect(r.repeatRun).toBe(0);

    // And the general answer: with the pilot mixed in — at a frequency that
    // divides NEITHER quantum — consecutive blocks always differ, so even the
    // bit-exact case is clean. A second reason the pilot exists.
    const p = makeProbe({ reportBlocks: 8 });
    const pilot = sine(CONTINUITY_PILOT_HZ, CONTINUITY_PILOT_GAIN);
    for (let b = 0; b < 64; b++) p.block((i) => tone(i) + pilot(b * BLOCK + i));
    for (const r of p.reports) expect(r.repeatRun).toBe(0);
  });
});

// ── PROOF 2: THE STALLED PROBE ─────────────────────────────────────────────
describe('PROOF 2 — an accumulator that is never called stays silently green', () => {
  it('a stalled probe reports NO progress, and progress is what is judged', () => {
    const h = makeProbe({ reportBlocks: 8 });
    h.run(16, sine(441, 0.5));
    const last = h.reports[h.reports.length - 1]!;

    // THE FLOOR: the worklet stops being pulled. The accumulator records
    // nothing, so its minimum never moves and the verdict stays green — the
    // worst failure an instrument can have, because it is indistinguishable
    // from health.
    expect(floorOnlyVerdict(h.reports, 0.05)).toBe('green');
    const before = h.reports.length;
    // ...simulate the stall: no further process() calls at all.
    expect(h.reports.length).toBe(before);

    // THE PROBE: `frames` is a MONOTONIC counter, so "the same report as last
    // time" is itself the signal. 2 s of wall clock with no advance is a stall.
    expect(evaluateContinuityProgress(last, last, 2000)).toEqual({
      kind: 'stalled',
      value: 2000,
      limit: DEFAULT_CONTINUITY_THRESHOLDS.maxStaleMs,
      seq: 0,
    });
  });

  it('NEGATIVE CONTROL: a probe that IS advancing is never called stalled', () => {
    const h = makeProbe({ reportBlocks: 8 });
    h.run(8, sine(441, 0.5));
    const a = h.reports[h.reports.length - 1]!;
    h.run(8, sine(441, 0.5));
    const b = h.reports[h.reports.length - 1]!;
    expect(b.frames).toBeGreaterThan(a.frames);
    expect(evaluateContinuityProgress(a, b, 5000)).toBeNull();
  });

  it('a short gap under the limit is not a stall (no hair trigger)', () => {
    const h = makeProbe({ reportBlocks: 8 });
    h.run(8, sine(441, 0.5));
    const a = h.reports[0]!;
    expect(evaluateContinuityProgress(a, a, 100)).toBeNull();
  });

  it('NOTHING EVER ARRIVED is a stall, not an absence of evidence', () => {
    // A probe that never produced a first report is the mount having failed.
    // Reading that as "no violations" is how a dead instrument ships green.
    expect(evaluateContinuityProgress(null, null, 2000)?.kind).toBe('stalled');
  });
});

// ── PROOF 3: THE CLICK ─────────────────────────────────────────────────────
describe('PROOF 3 — a click RAISES RMS, so a MINIMUM tracker cannot fail on it', () => {
  it('the floor is GREEN through a full-scale discontinuity; the probe is RED', () => {
    const h = makeProbe({ reportBlocks: 8 });
    const tone = sine(441, 0.3);
    // A hard jump to −1 for one sample, mid-block: exactly what an unfaded
    // patch swap sounds like.
    h.run(4, tone);
    const start = h.cursor;
    h.block((i) => (i === 64 ? -1 : tone(start + i)));
    h.run(3, tone);

    const r = h.reports[0]!;
    // THE FLOOR: the click ADDED energy. Minimum RMS is unchanged, and the peak
    // moved the WRONG WAY for a "did we lose audio" test.
    expect(r.minRms).toBeGreaterThan(0.15);
    expect(floorOnlyVerdict(h.reports, 0.05)).toBe('green');
    expect(r.peak).toBe(1);

    // THE PROBE: the per-sample derivative is what a click actually is.
    expect(r.maxStep).toBeGreaterThan(1);
    expect(evaluateContinuity(r).map((v) => v.kind)).toContain('click');
  });

  it('CATCHES A CLICK ON THE BLOCK SEAM (the crossfade case)', () => {
    // A crossfade splices at a render-quantum boundary, so a seam-blind
    // implementation — one that resets `prev` to 0 each block — would miss the
    // one discontinuity it exists to catch. It would also invent a step of
    // |x[0]| on every block, which the negative control below rules out.
    const h = makeProbe({ reportBlocks: 4 });
    h.run(2, () => 0.5); // steady DC-ish level A
    h.run(2, () => -0.5); // spliced to level B on the boundary
    const r = h.reports[0]!;
    expect(r.maxStep).toBeCloseTo(1, 5);
    expect(evaluateContinuity(r).map((v) => v.kind)).toContain('click');
  });

  it('NEGATIVE CONTROL: a smooth loud tone never trips the click limit', () => {
    // If `maxStep` fired on level rather than slew, this would be red — and the
    // instrument would be useless on any real patch.
    const h = makeProbe({ reportBlocks: 8 });
    h.run(32, sine(441, 1.0));
    for (const r of h.reports) {
      expect(r.peak).toBeGreaterThan(0.95); // genuinely full scale
      expect(evaluateContinuity(r).map((v) => v.kind)).not.toContain('click');
    }
  });

  it('NEGATIVE CONTROL: an EQUAL-POWER CROSSFADE is clean; a hard cut is not', () => {
    // The acceptance shape the crossfade requirement needs: the same two
    // signals, faded vs spliced, judged by the same instrument.
    const a = sine(441, 0.6);
    const b = sine(661, 0.6);
    const N = 8 * BLOCK;

    const faded = makeProbe({ reportBlocks: 8 });
    faded.run(8, (n) => {
      const t = Math.min(1, n / N);
      return a(n) * Math.cos((t * Math.PI) / 2) + b(n) * Math.sin((t * Math.PI) / 2);
    });
    for (const r of faded.reports) {
      expect(evaluateContinuity(r).map((v) => v.kind)).not.toContain('click');
    }

    const cut = makeProbe({ reportBlocks: 8 });
    // Splice mid-block at the worst phase — a hard cut with no fade at all.
    cut.run(4, a);
    const s = cut.cursor;
    cut.block((i) => (i < 64 ? a(s + i) : b(s + i) + 0.9));
    cut.run(3, b);
    expect(evaluateContinuity(cut.reports[0]!).map((v) => v.kind)).toContain('click');
  });
});

// ── PROOF 4: EXPECTED PATCH SILENCE ────────────────────────────────────────
describe('PROOF 4 — a master floor cannot tell quiet-on-purpose from dead', () => {
  it('a legitimately silent patch is a FALSE ALARM for the floor, clean for the pilot', () => {
    const h = makeProbe({ reportBlocks: 8 });
    const pilot = sine(CONTINUITY_PILOT_HZ, CONTINUITY_PILOT_GAIN);
    h.run(32, pilot); // the patch is silent; the infrastructure is fine

    const r = h.reports[0]!;
    // THE FLOOR: with any floor above the pilot level this is RED, on a patch
    // that is behaving exactly as intended. That is why every continuity spec
    // had to be authored around a hand-picked tone patch.
    expect(floorOnlyVerdict(h.reports, 0.05)).toBe('red');

    // THE PROBE: assert the PILOT, and patch content leaves the measurement.
    expect(r.pilot).toBeGreaterThan(CONTINUITY_PILOT_GAIN * 0.7);
    expect(r.pilot).toBeLessThan(CONTINUITY_PILOT_GAIN * 1.4);
    expect(
      evaluateContinuity(r, { minPilot: CONTINUITY_PILOT_GAIN * 0.5, minRms: 0 }),
    ).toEqual([]);
  });

  it('the pilot READS THROUGH loud patch content (it is not a level meter)', () => {
    const h = makeProbe({ reportBlocks: 16 });
    const pilot = sine(CONTINUITY_PILOT_HZ, CONTINUITY_PILOT_GAIN);
    h.run(32, (n) => sine(441, 0.8)(n) + pilot(n));
    const r = h.reports[0]!;
    // 0.8 amplitude of music on top, and the 1e-4 pilot is still resolved.
    expect(r.minRms).toBeGreaterThan(0.5);
    expect(r.pilot).toBeGreaterThan(CONTINUITY_PILOT_GAIN * 0.5);
    expect(evaluateContinuity(r, { minPilot: CONTINUITY_PILOT_GAIN * 0.5 })).toEqual([]);
  });

  it('THE FAILURE IT EXISTS FOR: the pilot vanishing while the patch plays on', () => {
    // Infrastructure died — the master chain was rebuilt without the pilot —
    // but the patch is loud, so every level-based instrument is green.
    const h = makeProbe({ reportBlocks: 16 });
    h.run(32, sine(441, 0.8)); // loud, no pilot
    const r = h.reports[0]!;
    expect(floorOnlyVerdict(h.reports, 0.05)).toBe('green'); // the floor: fine
    expect(r.pilot).toBeLessThan(CONTINUITY_PILOT_GAIN * 0.2);
    expect(
      evaluateContinuity(r, { minPilot: CONTINUITY_PILOT_GAIN * 0.5 }).map((v) => v.kind),
    ).toContain('pilotLost');
  });

  it('the RMS floor still catches a DEAD CHANNEL (worst-channel minimum)', () => {
    // The pilot leg does not make the floor useless — a silent right channel is
    // a real fault, and `minRms` is the per-channel WORST so a dead side is
    // visible even while the other one is loud. This is the case a
    // sum-to-mono or left-only meter would miss entirely.
    const live = makeProbe({ reportBlocks: 8 });
    live.run(16, sine(441, 0.5), 2);
    expect(live.reports[0]!.minRms).toBeGreaterThan(0.3);

    const dead = makeProbe({ reportBlocks: 8 });
    const tone = sine(441, 0.5);
    for (let b = 0; b < 8; b++) dead.block((i, c) => (c === 0 ? tone(b * BLOCK + i) : 0), 2);
    const r = dead.reports[0]!;
    expect(r.minRms).toBe(0); // the dead side
    expect(r.maxRms).toBeGreaterThan(0.3); // ...while the live side is loud
    expect(evaluateContinuity(r, { minRms: 0.05 }).map((v) => v.kind)).toContain('silence');
  });
});

// ── THE EVALUATOR ──────────────────────────────────────────────────────────
describe('evaluateContinuity — the pure verdict', () => {
  const base: ContinuityReport = {
    seq: 4,
    blocks: 640,
    frames: 81_920,
    audioTime: 1.7,
    sampleRate: SR,
    windowBlocks: 64,
    minRms: 0.3,
    maxRms: 0.4,
    peak: 0.5,
    maxStep: 0.01,
    pilot: 1e-4,
    repeatRun: 0,
    repeating: false,
  };

  it('a healthy report yields no violations', () => {
    expect(evaluateContinuity(base)).toEqual([]);
  });

  it('the RMS floor is OFF by default (a patch may be legitimately quiet)', () => {
    expect(evaluateContinuity({ ...base, minRms: 0 })).toEqual([]);
    expect(evaluateContinuity({ ...base, minRms: 0 }, { minRms: 0.05 }).map((v) => v.kind)).toEqual(
      ['silence'],
    );
  });

  it('the pilot leg is OFF by default (no pilot injected ⇒ nothing to assert)', () => {
    expect(evaluateContinuity({ ...base, pilot: 0 })).toEqual([]);
  });

  it('reports EVERY violation, not just the first', () => {
    const kinds = evaluateContinuity(
      { ...base, minRms: 0, pilot: 0, maxStep: 1.9, repeatRun: 999 },
      { minRms: 0.05, minPilot: 1e-5 },
    ).map((v) => v.kind);
    expect(kinds.sort()).toEqual(['click', 'frozen', 'pilotLost', 'silence']);
  });

  it('carries the measured value, the limit and the sequence number', () => {
    const [v] = evaluateContinuity({ ...base, maxStep: 1.25 });
    expect(v).toEqual({
      kind: 'click',
      value: 1.25,
      limit: DEFAULT_CONTINUITY_THRESHOLDS.maxStep,
      seq: 4,
    });
  });
});
