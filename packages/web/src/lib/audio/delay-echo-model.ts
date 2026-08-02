// packages/web/src/lib/audio/delay-echo-model.ts
//
// The DELAY's echo arithmetic as a pure model — the repeat count a feedback
// setting buys, the equal-power dry/wet split, and the three knob READOUTS the
// curated face paints.
//
// WHY A MODEL MODULE FOR A THREE-KNOB PRIMITIVE. Not for tidiness — because
// two of the three numbers this module shows a player are numbers that DO NOT
// MEAN WHAT THEY SAY, and the answers already existed only as PROSE:
//
//  1. **`feedback` is a ratio pretending to be a count.** `delay.ts`'s docs
//     already assert "the 0.4 default gives about 8 audible repeats" and "at
//     the 0.95 ceiling the tail takes roughly 135 repeats to fall below
//     −60 dB". Those two sentences are the ONLY place that arithmetic lived, so
//     nothing could check them and the dial went on printing `0.40`. Here it is
//     a function with a test, and the test's oracle is a real recirculation
//     simulation rather than the closed form restated (see the test header) —
//     a readout checked only against its own table is a tautology.
//
//  2. **`mix` is a crossfade pretending to be a percentage**, and the FACTORY
//     applies √ to both legs (`delay.ts`, `dry.gain = √(1−mix)` /
//     `wet.gain = √mix`). `equalPowerBlend` is that law, so the endpoints the
//     readout names (`DRY` / `WET`) are pinned to what the audio graph actually
//     does at those values instead of to a comment.
//
// THE 7-GLYPH BUDGET IS A HARD CONSTRAINT, NOT A STYLE. The lane knob column is
// capped at `LANE_KCOL_MAX_PX` (46) and `.knob-wrap` is uncapped, so an
// over-long readout does NOT ellipsize — it ESCAPES the column and spills into
// the next cell (measured; see `lane-readout-fit.ts`). Every formatter below is
// bounded at `READOUT_MAX_CHARS` = 7 over its param's WHOLE declared range, and
// the test sweeps the range in px rather than spot-checking the defaults.
//
// PURE + dependency-free apart from the fit constants, so it runs in the `unit`
// lane at ~0 added CI wall-time and needs no browser and no AudioContext.

/**
 * The tail floor, in dB, that "how many repeats" is counted down to.
 *
 * −60 dB is the number `delay.ts`'s own docs already reason with, and it is the
 * conventional "gone" threshold (a millionth of the power, RT60's definition).
 * It lives here so the readout and the prose cannot drift apart.
 */
export const ECHO_FLOOR_DB = -60;

/**
 * How many audible repeats a feedback ratio buys — the count of recirculations
 * before the tail falls below `ECHO_FLOOR_DB`.
 *
 * `g^n < 10^(floor/20)`, solved for the first integer n. At the 0.4 default
 * that is 8; at the 0.95 ceiling it is 135 — the two numbers `delay.ts` has
 * always claimed in prose.
 *
 * ⚠ `floor(x) + 1`, NOT `ceil(x)`, and the difference is the definition rather
 * than a rounding preference. The count is of repeats until the tail falls
 * BELOW the floor, so at a ratio where `g^n` lands EXACTLY on it — g = 0.1
 * (x = 3) and g = 0.001 (x = 1) both do, at a −60 dB floor — the tail has not
 * yet fallen below and one more repeat is needed. `ceil` returns x there and
 * under-counts by one; `floor(x) + 1` is the strict inequality at every input,
 * tie or not. The two disagree at exactly two points of the declared range,
 * which is why it took a simulation to notice (delay-echo-model.test.ts) —
 * a spot-check at the defaults would never have found it.
 *
 * FLOORED AT 1, and that is a fact about the module rather than a guard: with
 * feedback at exactly 0 the line still emits its ONE echo (the delayed signal
 * reaches the wet leg before it reaches the feedback gain), which is what the
 * docs mean by "at 0 you get exactly one echo".
 *
 * Total for every finite input: a negative or ≥1 ratio cannot come from the
 * declared 0..0.95 range, but `format` is called on live values and must never
 * throw, so they resolve to 1 and to `Infinity` respectively.
 */
export function echoRepeats(feedback: number): number {
  if (!Number.isFinite(feedback) || feedback <= 0) return 1;
  if (feedback >= 1) return Infinity; // never reaches the floor — unreachable here
  return Math.floor(ECHO_FLOOR_DB / (20 * Math.log10(feedback))) + 1;
}

/** The EQUAL-POWER dry/wet split the factory applies — `dry = √(1−mix)`,
 *  `wet = √mix`. The oracle the `mix` readout's endpoints are checked against,
 *  and the reason the halfway point sounds full instead of scooped. */
export function equalPowerBlend(mix: number): { dry: number; wet: number } {
  const m = Math.max(0, Math.min(1, mix));
  return { dry: Math.sqrt(1 - m), wet: Math.sqrt(m) };
}

/**
 * `time`'s readout: the delay in the unit a player actually thinks in.
 *
 * A bare `0.25` is the least useful rendering of this knob — it is neither the
 * milliseconds a slapback is specified in nor the seconds an ambient tail is,
 * and the log curve means the number moves by two decades across the travel. So
 * the unit SWITCHES at 1 s, which is also roughly where the character switches
 * (below it you hear a rhythm; above it you hear separate events).
 *
 * WIDTH: 6 glyphs worst case (`999 MS`, `2.00 S`) — inside the 7-glyph column
 * budget with a glyph to spare. The switch is decided on the ROUNDED
 * milliseconds, not on the raw seconds, so 0.9996 s renders `1.00 S` rather
 * than the `1000 MS` a raw comparison would produce.
 */
export function formatDelayTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0 MS';
  const ms = Math.round(Math.max(0, seconds) * 1000);
  if (ms < 1000) return `${ms} MS`;
  return `${(ms / 1000).toFixed(2)} S`;
}

/**
 * `feedback`'s readout: the REPEAT COUNT, not the ratio.
 *
 * This is the readout that earns its row. "0.40" says nothing a patcher can
 * act on; "8 REP" is the whole reason the knob exists, and it makes the
 * module's one safety property legible — at the 0.95 ceiling it reads `135 REP`,
 * i.e. very long but FINITE, which is exactly what the hard clamp below 1.0
 * buys and what a self-oscillating delay would not show.
 *
 * `REP` rather than `REPS`/`ECHOES`: the count reaches three digits before the
 * ceiling (`123 REP` at 0.945, `135 REP` at 0.95) and a plural would spend the
 * 8th glyph, which spills the column. Singular at every count is the price of
 * the whole range fitting one budget.
 */
export function formatDelayFeedback(feedback: number): string {
  const n = echoRepeats(feedback);
  return Number.isFinite(n) ? `${n} REP` : 'INF';
}

/**
 * `mix`'s readout: the two ENDS by name, the wet percentage in between.
 *
 * `DRY` and `WET` are named because they are the two settings that change what
 * the module IS — a bypass and an aux-send return — and because "1.00" on an
 * equal-power crossfade does not read as "the dry signal is gone". Between them
 * the percentage is of the WET leg, matching the knob's own direction.
 *
 * The ends are decided on the ROUNDED percentage so the readout can never
 * contradict itself: `0.996` displays as `WET` rather than as a `100% WET`
 * that is both 8 glyphs and a lie about the remaining dry.
 *
 * WIDTH: 7 glyphs worst case (`99% WET`) — exactly the column budget.
 */
export function formatDelayMix(mix: number): string {
  if (!Number.isFinite(mix)) return 'DRY';
  const pct = Math.round(Math.max(0, Math.min(1, mix)) * 100);
  if (pct <= 0) return 'DRY';
  if (pct >= 100) return 'WET';
  return `${pct}% WET`;
}
