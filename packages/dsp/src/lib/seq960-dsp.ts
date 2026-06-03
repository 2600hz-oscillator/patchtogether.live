// packages/dsp/src/lib/seq960-dsp.ts
//
// Pure column-stepping logic for the MOOG 960 SEQUENTIAL CONTROLLER — a
// 3-row × 8-step analog step sequencer. This file is the deterministic,
// AudioContext-free core: it owns the current COLUMN index (0..7, shared by
// all three rows, exactly like the hardware's single sequential switch) and
// advances it one column at a time, honoring the per-column MODE switch
// (NORMAL / SKIP / STOP).
//
// `lib/` files MAY export freely (esbuild inlines them into a worklet bundle
// where applicable); the 960 is a PLAIN-JS module (no worklet — it mirrors
// sequencer.ts), so this file is consumed directly by the web factory + tests.
//
// Per-column MODE values (match the def's mode1..mode8 params):
//   0 = NORMAL — play this column, advance to the next.
//   1 = SKIP   — never rest on this column; advance straight through it.
//   2 = STOP   — when the playhead would LAND on this column, the sequencer
//                halts here (the analog 960's "stop" position). The column is
//                still the current/selected one (its CV is held), but no
//                further advance happens until the transport is restarted.
//
// V2 DEFERRALS (intentionally NOT built here; tracked for the follow-up):
//   - per-step trigger in/out jacks
//   - the third-row-controls-timing switch
//   - the ×2 parallel outputs per row
//   - precise 1V/oct clock_cv
//   - manual per-column trigger buttons
//   - the 9th skip/stop position (here STOP/SKIP live on the 8 columns)

/** Number of columns (steps) per row. The 960 is fixed 8-wide in v1. */
export const SEQ960_COLUMNS = 8;
/** Number of CV rows. Fixed 3 in v1. */
export const SEQ960_ROWS = 3;

/** Per-column mode enum (mirrors the discrete mode1..mode8 params, 0..2). */
export const MODE_NORMAL = 0;
export const MODE_SKIP = 1;
export const MODE_STOP = 2;

/**
 * Range-switch multiplier table. Each row has a RANGE switch (range1..range3,
 * discrete 0..2). The selected position scales that row's normalized step
 * value before it hits the CV output:
 *
 *   0 → ×1   1 → ×2   2 → ×4
 *
 * CV SCALE DECISION: step pots are normalized 0..1 (knob units). At ×1 a row
 * emits 0..1 on its ConstantSource CV output (the project's standard unipolar
 * CV span, same magnitude the sequencer's pitch/gate sources use). ×2 / ×4
 * widen that to 0..2 / 0..4 — so a downstream VCO/VCA patched off a 960 row
 * sweeps two/four times as far per the front-panel RANGE switch, matching the
 * hardware's "attenuate vs. boost" feel. The multiplier is applied in
 * `rowOutput()` so both the factory and tests share one source of truth.
 */
export const RANGE_MULTIPLIERS = [1, 2, 4] as const;

/** Clamp a (possibly stale/float) range param to a valid multiplier. */
export function rangeMultiplier(range: number): number {
  const idx = Math.max(0, Math.min(RANGE_MULTIPLIERS.length - 1, Math.round(range)));
  return RANGE_MULTIPLIERS[idx]!;
}

/**
 * The CV a row emits for a given step pot + range switch.
 * `stepValue01` is the pot's 0..1 position; the result is `stepValue01 *
 * rangeMultiplier(range)` (0..1 / 0..2 / 0..4). Pure — shared by the factory's
 * CV-write path and the lib tests.
 */
export function rowOutput(stepValue01: number, range: number): number {
  return stepValue01 * rangeMultiplier(range);
}

/** Result of one `advance()` call. */
export interface Seq960AdvanceResult {
  /** The column the playhead landed on after advancing (0..COLUMNS-1). */
  column: number;
  /** True iff the landed-on column is a STOP column — the host should halt
   *  the transport (hold this column's CV, emit no further advances until
   *  restarted). */
  stopped: boolean;
}

/**
 * The 960's shared column pointer + advance logic. Deterministic and pure (no
 * timing, no audio) — the web factory calls `advance()` once per clock edge /
 * internal-rate tick and writes each row's `rowOutput()` to its CV source.
 */
export class Seq960Stepper {
  private col = 0;

  /** The current (selected) column index, 0..COLUMNS-1. */
  get column(): number {
    return this.col;
  }

  /** Reset the playhead to column 0 (transport restart). */
  reset(): void {
    this.col = 0;
  }

  /** Test/host seam: force the current column (clamped to range). */
  setColumn(c: number): void {
    this.col = ((Math.round(c) % SEQ960_COLUMNS) + SEQ960_COLUMNS) % SEQ960_COLUMNS;
  }

  /**
   * Advance to the next column the playhead should rest on, honoring per-column
   * modes. Walks forward from the current column, wrapping 7→0, skipping any
   * SKIP column. Lands on the first NORMAL/STOP column found; if that column is
   * STOP, reports `stopped: true`.
   *
   * Degenerate guard: if EVERY column is SKIP there is no valid resting place,
   * so the pointer is left unchanged and `stopped: false` is returned (the
   * caller simply doesn't advance — graceful no-op rather than an infinite
   * loop).
   *
   * @param modes per-column mode array (length COLUMNS; missing entries treated
   *              as NORMAL). Read fresh each call so live front-panel switch
   *              changes take effect immediately.
   */
  advance(modes: ReadonlyArray<number>): Seq960AdvanceResult {
    const modeAt = (i: number): number => Math.round(modes[i] ?? MODE_NORMAL);

    // All-skip degrades gracefully: nothing is a valid resting column, so the
    // pointer holds and we report no stop. Checked up front so the wrap loop
    // below can assume at least one non-SKIP column exists (it can therefore
    // terminate within one full lap).
    let anyRestable = false;
    for (let i = 0; i < SEQ960_COLUMNS; i++) {
      if (modeAt(i) !== MODE_SKIP) {
        anyRestable = true;
        break;
      }
    }
    if (!anyRestable) {
      return { column: this.col, stopped: false };
    }

    // Step forward one column at a time, skipping SKIP columns, until we hit a
    // column we may rest on. Bounded to one full lap (COLUMNS iterations) — the
    // anyRestable guard guarantees we find one.
    let next = this.col;
    for (let n = 0; n < SEQ960_COLUMNS; n++) {
      next = (next + 1) % SEQ960_COLUMNS;
      if (modeAt(next) !== MODE_SKIP) break;
    }

    this.col = next;
    return { column: next, stopped: modeAt(next) === MODE_STOP };
  }
}
