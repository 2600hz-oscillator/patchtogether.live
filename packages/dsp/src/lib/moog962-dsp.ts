// packages/dsp/src/lib/moog962-dsp.ts
//
// Pure sequential-switch logic for the MOOG 962 (Sequential Switch) — the
// "SHIFT advances the selected input" core, modeled after the 4PLEXER's
// gate-advanced selector but trimmed to a SINGLE output that cycles through
// up to three signal inputs. This is the testable lib half of the
// stateful-timing rule (cf. flipper-dsp.ts / resofilter-dsp.ts); the worklet
// entry (../moog962.ts) wraps a Moog962Switch in an AudioWorkletProcessor.
//
// `lib/` files MAY export freely (esbuild inlines them into the worklet
// bundle); the worklet entry must NOT — see resofilter.ts.
//
// Behaviour:
//   • The switch holds a 0-based selector index 0..(stages−1).
//   • Each RISING EDGE on the SHIFT gate advances the selector to the next
//     input, wrapping back to 0 after the last (1→2→3→1 for stages=3, or
//     1↔2 for stages=2).
//   • The selected input passes through to the output; the others are muted.
//   • Rising-edge detect uses the codebase convention: track a `wasHigh`
//     flag and fire when `gate >= THRESHOLD && !wasHigh`.

/** A SHIFT input at/above this counts as gate-high. Matches the 0.5
 *  threshold the gate-logic + 4PLEXER selector modules use. */
export const MOOG962_THRESHOLD = 0.5;

/** Hard upper bound on inputs the switch can cycle through (in1..in3). */
export const MOOG962_MAX_STAGES = 3;
/** Lower bound — a sequential switch needs at least two positions. */
export const MOOG962_MIN_STAGES = 2;

/** Clamp + round an arbitrary `stages` value into 2..3. A corrupt saved
 *  value can't make the selector cycle through phantom positions. */
export function moog962ClampStages(stages: number): number {
  if (!Number.isFinite(stages)) return MOOG962_MAX_STAGES;
  const r = Math.round(stages);
  if (r < MOOG962_MIN_STAGES) return MOOG962_MIN_STAGES;
  if (r > MOOG962_MAX_STAGES) return MOOG962_MAX_STAGES;
  return r;
}

/**
 * Advance a selector index to the NEXT input, wrapping (stages−1) → 0.
 * `cur` is the 0-based index; non-integer / out-of-range values are
 * normalised against the current `stages` first so a corrupt index can't
 * desync the selector. Returns the next 0-based index 0..(stages−1).
 */
export function moog962NextSelector(cur: number, stages: number): number {
  const n = moog962ClampStages(stages);
  const norm = ((Math.round(cur) % n) + n) % n;
  return (norm + 1) % n;
}

export class Moog962Switch {
  /** Current 0-based selector index (which input passes through). */
  private cur = 0;
  /** Rising-edge detector state for the SHIFT gate. */
  private wasHigh = false;
  /** How many inputs to cycle through (2..3). */
  private stages: number;

  constructor(stages: number = MOOG962_MAX_STAGES) {
    this.stages = moog962ClampStages(stages);
  }

  /** Update the number of cycled positions (2..3). If the live selector now
   *  points past the last valid position (because stages shrank), it is
   *  wrapped back into range so the output never selects a dead input. */
  setStages(stages: number): void {
    this.stages = moog962ClampStages(stages);
    if (this.cur >= this.stages) this.cur = this.cur % this.stages;
  }

  /** The currently-selected 0-based index. */
  selected(): number {
    return this.cur;
  }

  /**
   * Advance one sample.
   *   `inputs` — the (up to three) signal inputs, indexed by selector.
   *   `shift`  — the SHIFT gate value this sample.
   * On a SHIFT rising edge the selector advances FIRST, then the (new)
   * selected input is returned (matching hardware: the shift selects the
   * next stage, which is then heard). Returns the selected input's sample
   * (0 if that input is unpatched).
   */
  step(inputs: ArrayLike<number>, shift: number): number {
    const high = shift >= MOOG962_THRESHOLD;
    if (high && !this.wasHigh) {
      this.cur = moog962NextSelector(this.cur, this.stages);
    }
    this.wasHigh = high;
    const v = inputs[this.cur];
    return typeof v === 'number' ? v : 0;
  }

  /** Reset the selector to input 1 (index 0) and clear the edge detector. */
  reset(): void {
    this.cur = 0;
    this.wasHigh = false;
  }
}
