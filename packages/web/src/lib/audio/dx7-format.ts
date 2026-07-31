// packages/web/src/lib/audio/dx7-format.ts
//
// THE READOUTS. Every number the operator panel shows a human is formatted
// here, from the RAW stored bytes, using the same laws the engine plays —
// `dx7Ratio` / `dx7FixedHz` / `dx7LevelToDb` / `dx7RateToDbPerSec` from
// dx7-syx.ts. Nothing in this file re-derives a constant.
//
// The point of a resolved readout is that raw coarse/fine is meaningless on
// its own: "COARSE 3 FINE 2" tells a player nothing, "×3.06" tells them the
// operator runs at three times the note. §3.3's rule is that the raw bytes are
// NEVER shown alone — they always sit beside the resolved value.
//
// UNITS, spelled out because three different scales collide here:
//   frequency   RATIO (a multiplier of the played note) or, in FIXED mode,
//               absolute Hz — and fixed mode ignores the note, the ratio table
//               and detune entirely.
//   level       the 0..99 OUTPUT LEVEL byte, shown in dB on the project's own
//               `(level - 99) * 0.75 dB` scale, where 99 = 0 dB = unity.
//   detune      stored 0..14, displayed SIGNED -7..+7 (7 = no detune).
//   rate        the 0..99 RATE byte, shown as the SECONDS a full-scale
//               traversal takes at that rate — 99 is fastest (~5.5 ms), 0 is
//               slowest (317.487 s). Never confuse the byte with the seconds.

import {
  dx7FixedHz,
  dx7LevelToDb,
  dx7Ratio,
  dx7RateToDbPerSec,
  DX7_EG_FLOOR_DB,
} from './dx7-syx';

/** The multiplication sign the ratio readout uses (U+00D7), named so a test
 *  asserts the glyph rather than pasting it. */
export const DX7_RATIO_PREFIX = '×';

function clampByte(v: number, hi = 99): number {
  const i = Math.round(Number.isFinite(v) ? v : 0);
  return i < 0 ? 0 : i > hi ? hi : i;
}

// ---------------- Frequency ----------------

/**
 * The resolved operator frequency readout.
 *
 * RATIO mode -> `×3.06` (a multiplier of the played note; `dx7Ratio` is
 * Yamaha's `base(coarse) * (1 + fine/100)`, where coarse 0 means the half-pitch
 * 0.5). FIXED mode -> an absolute frequency in Hz, `10^((coarse & 3) +
 * fine/100)`, so coarse picks the decade (1 / 10 / 100 / 1000 Hz) and fine
 * sweeps up to just under the next one.
 */
export function dx7FormatFrequency(coarse: number, fine: number, fixedMode = false): string {
  if (fixedMode) return dx7FormatHz(dx7FixedHz(clampByte(coarse, 31), clampByte(fine)));
  return dx7FormatRatio(dx7Ratio(clampByte(coarse, 31), clampByte(fine)));
}

/** A frequency ratio as the panel shows it: `×0.50`, `×1.00`, `×3.06`, `×14.0`. */
export function dx7FormatRatio(ratio: number): string {
  const r = Number.isFinite(ratio) ? ratio : 0;
  // Two decimals below 10 (where the fine steps are 0.01-0.09 and visible),
  // one above (where they are 0.1+ and a second decimal is noise).
  return `${DX7_RATIO_PREFIX}${r < 10 ? r.toFixed(2) : r.toFixed(1)}`;
}

/** An absolute frequency: `1.00 Hz`, `31.6 Hz`, `316 Hz`, `9.77 kHz`. */
export function dx7FormatHz(hz: number): string {
  const v = Number.isFinite(hz) && hz > 0 ? hz : 0;
  if (v >= 1000) return `${(v / 1000).toFixed(2)} kHz`;
  if (v >= 100) return `${v.toFixed(0)} Hz`;
  if (v >= 10) return `${v.toFixed(1)} Hz`;
  return `${v.toFixed(2)} Hz`;
}

// ---------------- Level ----------------

/**
 * An OUTPUT LEVEL / envelope LEVEL byte as dB: `0.0 dB` at 99 (unity) down to
 * `-73.5 dB` at 1. Level 0 is not `-74.2 dB` but a HARD ZERO — `dx7LevelToAmp`
 * returns 0 and the voice allocator can free the slot — so it reads `off`, not
 * a number a player might mistake for "very quiet".
 */
export function dx7FormatLevel(level: number): string {
  const l = clampByte(level);
  if (l === 0) return 'off';
  return `${dx7LevelToDb(l).toFixed(1)} dB`;
}

/** The dB behind `dx7FormatLevel`, for callers plotting rather than printing.
 *  Level 0 is `-Infinity` (a true silence), not the -74.25 dB floor. */
export function dx7LevelDbValue(level: number): number {
  const l = clampByte(level);
  return l === 0 ? Number.NEGATIVE_INFINITY : dx7LevelToDb(l);
}

// ---------------- Detune ----------------

/**
 * DETUNE is stored 0..14 and displayed SIGNED: 7 is centre, so 0 shows as
 * `-7` and 14 as `+7`. Getting this backwards is the classic off-by-seven —
 * the stored byte is never shown.
 */
export function dx7DetuneSigned(detune: number): number {
  return clampByte(detune, 14) - 7;
}

/** `+7`, `0`, `-3`. */
export function dx7FormatDetune(detune: number): string {
  const d = dx7DetuneSigned(detune);
  return d > 0 ? `+${d}` : `${d}`;
}

/** Inverse of `dx7DetuneSigned` — a signed -7..+7 from the UI back to the
 *  stored 0..14 byte. */
export function dx7DetuneFromSigned(signed: number): number {
  const s = Math.round(Number.isFinite(signed) ? signed : 0);
  return Math.max(0, Math.min(14, s + 7));
}

// ---------------- Rate ----------------

/**
 * SECONDS a rate byte takes to cross the FULL 74.25 dB envelope scale, falling.
 * This is the honest interpretation of a rate byte and the number the hover
 * readout shows: rate 99 is ~5.5 ms, rate 0 is 317.487 s (hexter's measured
 * `decay_duration[0]` — NOT the 90 s that a units confusion with Dexed's ~90
 * dB internal span produced).
 *
 * A real segment is shorter in proportion to how far it actually travels, and
 * an ATTACK at the same byte is ~8x faster still — `dx7EgSegmentSeconds` in
 * dx7-eg-curve.ts is the per-segment number. This one is the rate byte's own
 * scale-free meaning.
 */
export function dx7RateToSeconds(rate: number): number {
  const dbPerSec = dx7RateToDbPerSec(clampByte(rate));
  if (!(dbPerSec > 0)) return Number.POSITIVE_INFINITY;
  return -DX7_EG_FLOOR_DB / dbPerSec;
}

/** A duration: `5.5 ms`, `248 ms`, `2.48 s`, `5m 17s`. */
export function dx7FormatSeconds(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  if (s >= 60) {
    const m = Math.floor(s / 60);
    return `${m}m ${Math.round(s - m * 60)}s`;
  }
  if (s >= 1) return `${s.toFixed(2)} s`;
  const ms = s * 1000;
  return ms >= 100 ? `${ms.toFixed(0)} ms` : `${ms.toFixed(1)} ms`;
}

/** A RATE BYTE as the time it represents — `dx7FormatSeconds(dx7RateToSeconds(r))`. */
export function dx7FormatRate(rate: number): string {
  return dx7FormatSeconds(dx7RateToSeconds(rate));
}
