// art/scenarios/moog960/profile.test.ts
//
// AUDIO PROFILE for MOOG 960 (sequential controller) (backfill batch 4 —
// spec §4.1/§4.3, .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md),
// through the shared capture harness (art/setup/capture.ts + drivers.ts).
//
// Category: clocked STEP SOURCE — driven by the canonical 240 BPM CLOCK
// (spec §4.2: clockTrain, epoch pinned to sample 0), 2.0 s so a full lap of
// the 8 columns (including the 7→0 wrap) is visible. Following the module's
// external-clock contract (and the moog962 epoch-0 precedent): the transport
// auto-runs presenting column 0, and the clock's FIRST rising edge at sample
// 0 advances immediately — the walk starts on column 1 and column 0's pots
// appear at the wrap segment near the end.
//
// Patch: column 3 is SKIP (mode3) — the walk hops straight over it (that
// column's pot values NEVER appear on any row; asserted). The three rows are
// three genuinely different stepped CV streams sharing ONE playhead — the
// 960's signature — each with its own RANGE switch:
//   row1 ×1 (0..1)  melodic up/down contour
//   row2 ×2 (0..2)  alternating high/low
//   row3 ×4 (0..4)  straight descending staircase
//
// Rendering path: the pure-TS core (packages/dsp/src/lib/seq960-dsp.ts —
// Seq960Stepper.advance + rowOutput), the EXACT column/mode/range math the
// web factory runs per clock edge. The factory-side emission semantics this
// render mirrors (ConstantSource CV HELD between advances; a ~10 ms clock
// pulse per advance) live in moog960.ts's plain-JS factory — deliberately
// NOT pinned: that file co-locates the module docs, and docs edits must
// never invalidate audio pins (the moog907a def-file precedent).
//
// SIGNATURE outputs (owner decision §6b.2): row1 / row2 / row3 — three
// distinct staircases. clock_out is a fixed-shape 10 ms pulse per advance
// (no independent information beyond the step edges already visible on the
// rows) — asserted sample-exact below, not pinned.

import { describe, expect, it } from 'vitest';
import {
  MODE_NORMAL,
  MODE_SKIP,
  Seq960Stepper,
  rowOutput,
} from '../../../packages/dsp/src/lib/seq960-dsp';
import { captureOutputs, dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { CLOCK_BPM, clockTrain } from '../../setup/drivers';

const SR = SAMPLE_RATE;
const DURATION_S = 2.0;
const STEP_N = Math.round((60 / CLOCK_BPM) * SR); // 12000 samples per column
/** The factory's clock_out pulse width (~10 ms — moog960.ts emitClockPulse). */
const CLOCK_PULSE_N = Math.round(0.01 * SR);

// Per-column MODE switches: column 3 (index 2) is SKIP, the rest NORMAL.
const MODES = [MODE_NORMAL, MODE_NORMAL, MODE_SKIP, MODE_NORMAL, MODE_NORMAL, MODE_NORMAL, MODE_NORMAL, MODE_NORMAL];

// The 24 step pots (r{row}s{col}), 0..1 — three distinct patterns.
const POTS: readonly (readonly number[])[] = [
  [0.1, 0.3, 0.5, 0.7, 0.9, 0.6, 0.4, 0.2], // row1: melodic contour
  [0.9, 0.1, 0.5, 0.2, 0.7, 0.3, 0.6, 0.4], // row2: alternating
  [1.0, 0.875, 0.75, 0.625, 0.5, 0.375, 0.25, 0.125], // row3: descending
];
// Per-row RANGE switches: ×1 / ×2 / ×4.
const RANGES = [0, 1, 2] as const;

function renderProfile(): Record<string, Float32Array> {
  const clock = clockTrain(DURATION_S);
  const stepper = new Seq960Stepper();
  let col = stepper.column; // transport auto-runs presenting column 0
  let prev = 0;
  let pulseRemaining = 0;
  return captureOutputs(
    { durationS: DURATION_S, outputs: ['row1', 'row2', 'row3', 'clock_out'] },
    (i) => {
      const g = clock[i]!;
      if (prev < 0.5 && g >= 0.5) {
        const res = stepper.advance(MODES);
        if (res.stopped) throw new Error('no STOP column in this patch');
        col = res.column;
        pulseRemaining = CLOCK_PULSE_N;
      }
      prev = g;
      const frame = {
        row1: rowOutput(POTS[0]![col]!, RANGES[0]),
        row2: rowOutput(POTS[1]![col]!, RANGES[1]),
        row3: rowOutput(POTS[2]![col]!, RANGES[2]),
        clock_out: pulseRemaining > 0 ? 1 : 0,
      };
      if (pulseRemaining > 0) pulseRemaining--;
      return frame;
    },
  );
}

// The expected column walk: 8 edges (epoch 0), starting from column 0, with
// column index 2 skipped → 1, 3, 4, 5, 6, 7, 0 (wrap), 1.
const WALK = [1, 3, 4, 5, 6, 7, 0, 1];

describe('ART moog960 / audio profile (240 BPM clock walks 3 range-scaled rows, column 3 skipped)', () => {
  it('holds each column exactly one clock period, skips column 3, wraps 7→0', () => {
    const bufs = renderProfile();
    const n = Math.round(SR * DURATION_S);
    for (const name of ['row1', 'row2', 'row3'] as const) {
      expect(bufs[name]!.length).toBe(n);
      expect(bufs[name]!.every(Number.isFinite)).toBe(true);
    }

    // Sample-exact held segments: segment k = [k·STEP_N, (k+1)·STEP_N) rests
    // on WALK[k]; every sample equals rowOutput(pot, range) (float32-stored).
    for (let k = 0; k < WALK.length; k++) {
      const c = WALK[k]!;
      for (let r = 0; r < 3; r++) {
        const expected = Math.fround(rowOutput(POTS[r]![c]!, RANGES[r]!));
        const buf = bufs[`row${r + 1}`]!;
        for (let i = k * STEP_N; i < (k + 1) * STEP_N; i++) {
          if (buf[i]! !== expected) {
            throw new Error(
              `row${r + 1} sample ${i} (segment ${k}, column ${c}): ${buf[i]} != ${expected}`,
            );
          }
        }
      }
    }

    // The SKIP column's values never appear (its pots are unique per row).
    const skipRow1 = Math.fround(rowOutput(POTS[0]![2]!, RANGES[0]!)); // 0.5
    const skipRow2 = Math.fround(rowOutput(POTS[1]![2]!, RANGES[1]!)); // 1.0
    expect(bufs.row1!.every((v) => v !== skipRow1)).toBe(true);
    expect(bufs.row2!.every((v) => v !== skipRow2)).toBe(true);

    // clock_out: a 10 ms pulse starting exactly at each clock edge, silent
    // elsewhere (one pulse per advance — 8 in the window).
    const co = bufs.clock_out!;
    let high = 0;
    for (const v of co) high += v;
    expect(high).toBe(WALK.length * CLOCK_PULSE_N);
    for (let k = 0; k < WALK.length; k++) {
      const s = k * STEP_N;
      expect(co[s]).toBe(1);
      expect(co[s + CLOCK_PULSE_N - 1]).toBe(1);
      expect(co[s + CLOCK_PULSE_N]).toBe(0);
    }

    // Deterministic re-render is bit-identical (fresh stepper).
    const again = renderProfile();
    for (const name of ['row1', 'row2', 'row3', 'clock_out'] as const) {
      let diff = 0;
      const a = bufs[name]!;
      const b = again[name]!;
      for (let i = 0; i < n; i++) diff = Math.max(diff, Math.abs(a[i]! - b[i]!));
      expect(diff, name).toBe(0);
    }
  });

  it('pins the row1/row2/row3 profile baselines (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('lib/seq960-dsp.ts');
    const bufs = renderProfile();
    await pinAll('moog960', srcSha, {
      row1: bufs.row1!,
      row2: bufs.row2!,
      row3: bufs.row3!,
    });
  });
});
