// packages/web/src/lib/audio/modules/kickdrum-format.ts
//
// KICK DRUM's READOUT VOCABULARY — the `ParamDef.format` (PF-3) functions the
// def attaches to its own params, so every knob on the faceplate prints a
// value that says what it MEANS.
//
// WHY IT LIVES BESIDE THE DEF AND NOT WITH THE FACE. `format` is a field of
// `ParamDef`; the def is the ONE place a param's range, curve, units and now
// its readout are authored, and an audio def must not reach into `$lib/ui`
// (nothing in `audio/modules` does). The faceplate model re-exports these for
// its caption, which is the only direction that keeps the layering intact.
//
// WHY NOT `formatParamNumber` (the shared ladder). It IS the right answer for
// most params and is what an un-formatted knob already prints on hover. It is
// the wrong answer for three of this module's units, and the differences are
// what makes the faceplate read like an instrument instead of a spreadsheet:
//
//   click_tone 2800 Hz  → the ladder says `2.80k Hz`; a producer says `2.8 kHz`
//   body_eq        3 dB → the ladder says `3.00 dB`; an EQ ALWAYS carries its
//                         sign, because −3 and +3 are opposite moves
//   tilt           0    → a bare `0.00` says nothing about a bipolar
//                         dark↔bright control; `0.00` with a forced sign does
//
// Every function here is PURE and TOTAL: `KnobConic` calls the attached
// formatter on every animation frame while a value moves, so a throw on a
// transient NaN would take the faceplate down mid-drag.

/** Hz, switching to kHz at 1000 with ONE decimal (`2.8 kHz`, `500 Hz`). */
export function fmtHz(v: number): string {
  if (!Number.isFinite(v)) return `${v}`;
  return Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`;
}

/** Milliseconds, integer (`450 ms`) — sub-ms precision is noise on a drum. */
export function fmtMs(v: number): string {
  if (!Number.isFinite(v)) return `${v}`;
  return `${Math.round(v)} ms`;
}

/** SIGNED decibels, one decimal (`+3.0 dB`, `-12.0 dB`, `0.0 dB`). */
export function fmtDb(v: number): string {
  if (!Number.isFinite(v)) return `${v}`;
  const s = v.toFixed(1);
  return v > 0 ? `+${s} dB` : `${s} dB`;
}

/** Semitones, integer + sign (`+24 st`). */
export function fmtSemitones(v: number): string {
  if (!Number.isFinite(v)) return `${v}`;
  const n = Math.round(v);
  return n > 0 ? `+${n} st` : `${n} st`;
}

/** A plain 0..1 amount, two decimals (`0.70`) — the mock's mix/blend readout. */
export function fmtAmount(v: number): string {
  if (!Number.isFinite(v)) return `${v}`;
  return v.toFixed(2);
}

/**
 * A BIPOLAR −1..1 amount: signed, two decimals (`+0.20`, `−0.35`).
 *
 * The minus is U+2212 MINUS SIGN, not a hyphen, so it aligns with the `+` at
 * the same optical weight in the tabular-numeral readout the knob uses.
 */
export function fmtBipolar(v: number): string {
  if (!Number.isFinite(v)) return `${v}`;
  const s = Math.abs(v).toFixed(2);
  if (v > 0) return `+${s}`;
  if (v < 0) return `−${s}`;
  return '0.00';
}
