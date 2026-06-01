// packages/dsp/src/lib/bluebox-dsp.ts
//
// BLUEBOX pure-math helpers.
//
// Two surfaces live here so unit tests + the worklet share one source of
// truth for the tone table:
//
//   1. dtmfFreqs(digit)        → [rowHz, colHz] for digits 0..9
//                                 (Bell System DTMF row/col grid).
//   2. BLUEBOX_TONES           → [2600]              (in-band supervisory tone)
//   3. REDBOX_TONES            → [1700, 2200]        (coin-acceptance pair)
//   4. tonesForButton(name)    → union of (1)+(2)+(3) dispatch helper.
//
// The worklet imports the constants directly so the dsp build inlines them
// into the worklet bundle. Tests pin the table values exactly — any
// algorithmic regression in the digit→frequency map fires a failed
// assertion, not a subtle audio drift.
//
// Bell System DTMF reference (ITU-T Q.23):
//   col1=1209 col2=1336 col3=1477  ┐
//   row1=697  | 1 | 2 | 3 |       │
//   row2=770  | 4 | 5 | 6 |       │  digits 0..9 below.
//   row3=852  | 7 | 8 | 9 |       │
//   row4=941  | * | 0 | # |       ┘
//
// BLUEBOX (the historical name; the phreaking device) emits a single
// 2600 Hz sine — AT&T's in-band supervisory frequency that, when injected
// during the post-dial silence on a long-distance trunk, signalled
// "hang-up" to the upstream trunk while keeping the local line up, after
// which MF tones could route a free call. Single-frequency.
//
// REDBOX emits a pair of sines (1700 + 2200 Hz) — the coin-acceptance
// "ack" tone US payphones played upstream after a coin drop. Two
// simultaneous sines summed.

/**
 * Bell System DTMF row/col frequency table.
 *
 * Index by digit 0..9 → [rowHz, colHz]. Pinned exactly to the Bell
 * specification; do not "round" these values.
 */
export const DTMF_TABLE: Readonly<Record<number, readonly [number, number]>> = Object.freeze({
  0: [941, 1336],
  1: [697, 1209],
  2: [697, 1336],
  3: [697, 1477],
  4: [770, 1209],
  5: [770, 1336],
  6: [770, 1477],
  7: [852, 1209],
  8: [852, 1336],
  9: [852, 1477],
});

/**
 * Per-button tone list for the BLUEBOX phreaker key — a single 2600 Hz
 * sine. Frozen so the worklet can rely on identity.
 */
export const BLUEBOX_TONES: readonly number[] = Object.freeze([2600]);

/**
 * Per-button tone list for the REDBOX phreaker key — 1700 + 2200 Hz sines
 * summed (the coin-acceptance "ack" pair).
 */
export const REDBOX_TONES: readonly number[] = Object.freeze([1700, 2200]);

/** All 12 button names in card-layout order. */
export const BLUEBOX_BUTTON_NAMES = [
  '1', '2', '3',
  '4', '5', '6',
  '7', '8', '9',
  '0',
  'bluebox', 'redbox',
] as const;
export type BlueboxButtonName = (typeof BLUEBOX_BUTTON_NAMES)[number];

/**
 * Param/gate ID for a button name. Mirrors the worklet's AudioParam +
 * input port names: `btn_<digit>` for digits, `btn_bluebox`/`btn_redbox`
 * for the two phreaker buttons.
 */
export function buttonParamId(name: BlueboxButtonName): string {
  return `btn_${name}`;
}

/** Gate-input port id for a button name. Same shape as buttonParamId. */
export function buttonGateId(name: BlueboxButtonName): string {
  return `gate_${name}`;
}

/**
 * Return the list of tone frequencies (Hz) a single button emits.
 *
 *   - '0'..'9' → [row, col] from DTMF_TABLE
 *   - 'bluebox' → [2600]
 *   - 'redbox' → [1700, 2200]
 */
export function tonesForButton(name: BlueboxButtonName): readonly number[] {
  if (name === 'bluebox') return BLUEBOX_TONES;
  if (name === 'redbox') return REDBOX_TONES;
  const digit = Number(name);
  return DTMF_TABLE[digit]!;
}

/**
 * Convenience pure helper for the digit case — the spec calls this out
 * separately because most unit tests of the DTMF table want the [row, col]
 * tuple specifically (no phreaker buttons).
 */
export function dtmfFreqs(digit: number): readonly [number, number] {
  const pair = DTMF_TABLE[digit];
  if (!pair) throw new Error(`dtmfFreqs: invalid digit ${digit} (must be 0..9)`);
  return pair;
}
