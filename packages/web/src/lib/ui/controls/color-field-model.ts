// packages/web/src/lib/ui/controls/color-field-model.ts
//
// PURE model for <ColorField> — the RACKLINE COLOUR CELL, the primitive for a
// param whose value is a PACKED 24-BIT RGB INTEGER rather than a scalar.
//
// WHY IT EXISTS. `wavesculpt` declares `red_color` / `grn_color` / `blu_color`
// as `0..16777215 discrete` (a packed `0xRRGGBB`). Every primitive the shell
// owned resolved that shape to a KNOB — so the face would have painted three
// dials sweeping SIXTEEN POINT SEVEN MILLION values, each drag step landing on
// an unpredictable hue, and `faces-parity` would have PASSED all three: it
// drags the knob and asserts the param moved, which it does. A green gate
// certifying three unusable controls.
//
// ⚠ THE UNITS ARE THE WHOLE BUG, AND THEY ARE INVISIBLE IN THE NUMBER.
// `0..16777215 discrete` and `1..32 discrete` (dx7's algorithm chart) are the
// SAME SHAPE to every resolver in the repo — only the magnitude differs, and no
// gate reads magnitude. That is why `'color'` is DECLARED on `face.paramCells`
// beside `'grid'` rather than sniffed from the range: "this integer is a
// colour" is knowledge only the module has, and a heuristic on the span would
// be a rule about how big a number is.
//
// THE OBSERVABLE (the reason this file is separate from the component).
// A colour control has a failure mode a knob does not: it can render a SWATCH
// that is decoration. The parity probe therefore has to distinguish "the user
// changed the colour" from "a coloured rectangle exists", and it does that by
// driving the input and watching a WITNESS whose text is derived from the LIVE
// param — the `text`-probe discipline the PANEL cells already use, applied one
// cell kind over. Everything that probe needs to be non-vacuous is here and is
// negative-controlled in BOTH directions on every unit run
// (color-field-model.test.ts):
//
//   * `hexToPacked` ∘ `packedToHex` is the IDENTITY over the whole 24-bit
//     space. If the round-trip collapsed colours the witness could not move.
//   * `packedToHex` is INJECTIVE. If two packed values printed one hex the
//     witness would read identical across a real change.
//   * `nextProbeColor(v) !== v` for EVERY v in range. This is the one that can
//     silently make the e2e vacuous: a probe that "picks a different colour"
//     and picks the same one asserts nothing about the write path.
//
// Pure + total: no DOM, no Svelte, node-testable.

/** The packed-RGB space. `value = r*65536 + g*256 + b`, each channel 0..255. */
export const PACKED_RGB_MIN = 0;
export const PACKED_RGB_MAX = 0xffffff;

/** How many distinct values a colour param spans. Stated so the "a knob would
 *  sweep this many" claim in the docs above is a number the code owns. */
export const PACKED_RGB_STATES = PACKED_RGB_MAX - PACKED_RGB_MIN + 1; // 16_777_216

/**
 * Clamp + round an arbitrary number onto the packed-RGB space. Defensive
 * against NaN/±Infinity so a corrupt param value can never reach the DOM as
 * `#NaNNaNNaN` (an `<input type="color">` silently resets itself to black when
 * handed a malformed value, which would look exactly like a user edit).
 */
export function clampPacked(v: number): number {
  // NaN is the only input with no defensible clamp (it is not high or low), so
  // it takes the floor. ±Infinity SATURATES like any out-of-range number —
  // rejecting it to 0 would turn "far too bright" into BLACK, which is the
  // wrong end of the space and the harder failure to recognise on screen.
  if (Number.isNaN(v)) return PACKED_RGB_MIN;
  return Math.max(PACKED_RGB_MIN, Math.min(PACKED_RGB_MAX, Math.round(v)));
}

/**
 * Packed integer → the `#rrggbb` string an `<input type="color">` accepts.
 *
 * ⚠ LOWERCASE AND ALWAYS SEVEN CHARACTERS. Chromium normalises the input's
 * `value` to lowercase `#rrggbb`, so emitting `#FF3333` would make every
 * round-trip comparison a case mismatch and every `toHaveValue` assertion a
 * coin flip on the browser's normalisation.
 */
export function packedToHex(v: number): string {
  return `#${clampPacked(v).toString(16).padStart(6, '0')}`;
}

/**
 * `#rrggbb` (or the shorthand `#rgb`) → a packed integer, or `null` when the
 * string is not a colour.
 *
 * ⚠ IT RETURNS `null` RATHER THAN 0 ON GARBAGE, deliberately. 0 is BLACK — a
 * perfectly legal colour — so a lenient parser would turn "the browser handed
 * us something unexpected" into "the user picked black", writing a real value
 * into the Y.Doc off a parse failure. The caller keeps the current value.
 */
export function hexToPacked(hex: string): number | null {
  const s = hex.trim().toLowerCase();
  const long = /^#([0-9a-f]{6})$/.exec(s);
  if (long) return parseInt(long[1]!, 16);
  const short = /^#([0-9a-f]{3})$/.exec(s);
  if (!short) return null;
  const [r, g, b] = short[1]!.split('') as [string, string, string];
  return parseInt(`${r}${r}${g}${g}${b}${b}`, 16);
}

/** The three 0..255 channels of a packed value (render + readout helper). */
export function packedChannels(v: number): [number, number, number] {
  const p = clampPacked(v);
  return [(p >> 16) & 0xff, (p >> 8) & 0xff, p & 0xff];
}

/**
 * The mask `nextProbeColor` flips: the TOP BIT of each channel, so every
 * channel moves by exactly 128 — half its range — in one direction or the
 * other. Exported so the assertion can state the number rather than restate
 * the arithmetic.
 */
export const PROBE_CHANNEL_STEP = 0x80;
const PROBE_MASK = 0x808080;

/**
 * A colour GUARANTEED to differ from `current`, for every value in the space,
 * VISIBLY, and in all three channels at once.
 *
 * ⚠ THIS IS THE PARITY PROBE'S "pick a different one", AND ITS TOTALITY IS THE
 * WHOLE POINT: a probe that "changes" the colour to the colour already showing
 * asserts nothing about the write path, and `.not.toBe(before)` would fail as a
 * false NEGATIVE rather than reveal it. XOR against a non-zero mask has no
 * fixed point by construction.
 *
 * ⚠ AND THE OBVIOUS CHOICE — THE 24-BIT COMPLEMENT — IS WRONG, WHICH IS WHY
 * THE MASK IS SPELLED OUT. `0xffffff - v` is provably different (2x = 0xffffff
 * is odd, so there is no fixed point) and was the first implementation here.
 * Its own test caught it: for a MID-GREY the complement is nearly the same
 * colour — channel 0x87 complements to 0x78, a distance of 15 — so
 * `#1a8778 → #e57887` moved 233 of a possible 765 and a human reading a
 * failure artifact would see two similar teals. "Provably different" and
 * "different enough to diagnose from" are separate properties and only the
 * first is automatic.
 *
 * Flipping each channel's top bit gives both: never a fixed point, and every
 * channel displaced by exactly `PROBE_CHANNEL_STEP`. It also moves all THREE
 * channels independently, so a component that dropped or aliased one of them
 * cannot round-trip the probe.
 */
export function nextProbeColor(current: number): number {
  return clampPacked(current) ^ PROBE_MASK;
}

/**
 * Is this ParamDef the shape a colour cell can back? The predicate
 * `module-face-lint` runs over every `face.paramCells['x'] = 'color'`.
 *
 * The range check is not pedantry: a `'color'` declared on a `0..2 discrete`
 * mode param would paint a picker that can only ever write near-black values
 * (0, 1 and 2 are all `#000000`-ish), and the def-reading gates would all stay
 * green — the same class as `'grid'` on a 20..20000 Hz cutoff, one kind over.
 * Anchoring to the constants above also means the def and the primitive cannot
 * disagree about the space's bounds: there is one pair of numbers.
 */
export function isPackedRgbParam(p: {
  min: number;
  max: number;
  curve: string;
}): boolean {
  return p.curve === 'discrete' && p.min === PACKED_RGB_MIN && p.max === PACKED_RGB_MAX;
}
