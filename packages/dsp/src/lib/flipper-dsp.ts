// packages/dsp/src/lib/flipper-dsp.ts
//
// Pure flip-flop logic for the FLIPPER module. A gate on EITHER input
// alternately routes to the FLIP output, then the FLOP output, then back.
// The first gate after construction (or reset) fires FLIP.
//
// `lib/` files MAY export freely (esbuild inlines them into the worklet
// bundle); the worklet entry (../flipper.ts) must NOT — see resofilter.ts.

/** A combined input at/above this counts as a gate-high. Matches the 0.5
 *  threshold the gate-logic modules (ILLOGIC) use. */
export const FLIPPER_THRESHOLD = 0.5;

export class FlipperState {
  private wasHigh = false;
  /** Which output the CURRENT high gate is routed to. */
  private routeToFlip = true;
  /** Which output the NEXT new gate will select. Starts FLIP. */
  private nextIsFlip = true;

  /**
   * Advance one sample. `in1`/`in2` are the two gate inputs; the gate is
   * "high" when EITHER input is at/above FLIPPER_THRESHOLD. Returns the two
   * output gate values `[flip, flop]` — while a gate is high it is mirrored to
   * the currently-selected output (so the trigger keeps the input's width) and
   * the other output is 0; both are 0 when the input is low.
   */
  step(in1: number, in2: number): [number, number] {
    const combined = in1 > in2 ? in1 : in2; // OR: either input drives the gate
    const high = combined >= FLIPPER_THRESHOLD;
    if (high && !this.wasHigh) {
      // Rising edge: fire the currently-armed output, then arm the other for
      // the next gate.
      this.routeToFlip = this.nextIsFlip;
      this.nextIsFlip = !this.nextIsFlip;
    }
    this.wasHigh = high;
    if (!high) return [0, 0];
    return this.routeToFlip ? [combined, 0] : [0, combined];
  }

  /** Reset so the next gate fires FLIP again. */
  reset(): void {
    this.wasHigh = false;
    this.routeToFlip = true;
    this.nextIsFlip = true;
  }
}
