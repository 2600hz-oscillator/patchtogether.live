// packages/web/src/lib/ui/modules/b3ntb0x-face-model.ts
//
// The PURE model behind the B3NTB0X faceplate — the two numbers its twenty
// knobs cannot print, both of them JOINS over controls that sit on different
// pages of the face.
//
// ── 1. THE RIPPLE GAIN ────────────────────────────────────────────────────
//
// The bend shader's stages 2-4, with the bend A/B/C taps at rest:
//
//     vc = vc + (vc - neighborAvg) * uEnhance * 2.0;   // ENHANCE
//     vc = vc * uSyncCrush;                            // master gain
//     vc = vc + uBias;                                 // BIAS
//     float ripple = vc - neighborAvg;                 // BEND D
//     vc = vc + d * 0.8 * ripple;
//
// Writing `r` for the input ripple `vc₀ - neighborAvg`, this closes to
//
//     out = (1 + 0.8d)·(S·n + S·r·(1 + 2E) + B) - 0.8d·n
//
// VERIFIED, not derived on paper alone: a numeric replay of the shader against
// this closed form agrees to **1.776e-15** over 972 points spanning
// `vc₀ × neighborAvg × enhance × sync_crush × bias × bend_d`.
//
// So the gain the picture's high-frequency content receives is
//
//     RIPPLE GAIN = sync_crush · (1 + 2·enhance) · (1 + 0.8·bend_d)
//
// ⚠ WHY THIS IS NOT A KNOB RELABELLED, in three independent ways:
//
//   * it is a product of THREE params, which the face puts on TWO different
//     pages (`sync_crush`/`enhance` on `bend`, `bend_d` on `taps`), so no dial
//     is even adjacent to the others;
//   * expanding gives `1 + 2E + 0.8d + 1.6dE` — the **1.6·d·E cross term is
//     real**, so the number is not recoverable by reading two dials and adding.
//     At `E = d = 1` the gain is ×5.40 where two independent controls would
//     deliver ×3.80;
//   * `bias` does NOT appear in it. A reader who assumed "the bend stages
//     interact, so everything interacts" would print a number that moves with
//     BIAS, and it must not.
//
// ⚠ AND `enhance` AND `bend_d` ARE NOT THE SAME CONTROL, which an earlier
// reading claimed (#1940). They act at different points: ENHANCE lands BEFORE
// the `sync_crush` multiply and the `bias` add, BEND D after both. The ripple
// gain above is symmetric in form but the REST of the expression is not —
// `bend_d` multiplies the bias term by `(1+0.8d)` and shifts the baseline
// coefficient to `S + 0.8d(S−1)`, while `enhance` touches neither. That
// asymmetry is what makes them two stages rather than one; it is asserted in
// this module's test, so the refuted reading cannot quietly come back.
//
// ── 2. THE LINE SHIFT ─────────────────────────────────────────────────────
//
// `recoverLineOffset` (the decode pass) ends:
//
//     return (rawOffset + wobble) * (1.0 - tbc);
//
// so `(1 - tbc)` is the fraction of the recovered sync offset AND the analog
// timebase wobble that actually reaches the picture. ⚠ `tbc` DEFAULTS TO 1, so
// at the shipped settings that fraction is **exactly zero** and the picture
// cannot tear or roll however hard `sync_crush` and `bias` crush the sync tip —
// which is precisely the gesture the module's own docs instruct a player to
// perform (#1946). The readout prints `locked` in that state: the one-word
// statement of the finding, made where a player will meet it, without moving a
// single pixel.
//
// PURE: no DOM, no engine, no store, no GL.

import { b3ntb0xDef } from '$lib/video/modules/b3ntb0x';

/** The params the two readouts are functions of. */
export interface B3ntb0xFaceParams {
  sync_crush: number;
  enhance: number;
  bend_d: number;
  tbc: number;
}

const IDS = ['sync_crush', 'enhance', 'bend_d', 'tbc'] as const;

function paramDef(id: (typeof IDS)[number]) {
  const p = b3ntb0xDef.params.find((q) => q.id === id);
  if (!p) throw new Error(`b3ntb0x-face-model: no param '${id}' on b3ntb0xDef`);
  return p;
}

/** Read the four params, each CLAMPED to its declared travel, falling back to
 *  the declared default when absent or non-finite.
 *
 *  ⚠ The clamp mirrors the shader, which clamps every one of these itself
 *  (`clamp01`/`clampSym` at the uniform writes, `clamp(uBendD,-1,1)` inside).
 *  A readout that did not clamp would disagree with the picture for any
 *  out-of-contract write — the seam MIDI learn, automation and a preset load
 *  all reach. */
export function b3ntb0xFaceParams(
  read: (paramId: string) => number | undefined,
): B3ntb0xFaceParams {
  const one = (id: (typeof IDS)[number]): number => {
    const p = paramDef(id);
    const v = read(id);
    if (typeof v !== 'number' || !Number.isFinite(v)) return p.defaultValue;
    return v < p.min ? p.min : v > p.max ? p.max : v;
  };
  return {
    sync_crush: one('sync_crush'),
    enhance: one('enhance'),
    bend_d: one('bend_d'),
    tbc: one('tbc'),
  };
}

/**
 * THE RIPPLE GAIN — `sync_crush · (1 + 2·enhance) · (1 + 0.8·bend_d)`.
 *
 * ⚠ `bend_d` enters through `|d|`, matching the shader: stage D guards on
 * `abs(d) > 1e-4` and then uses the SIGNED `d`, but the gain a NEGATIVE `d`
 * applies to the ripple is `(1 + 0.8d) < 1` — an attenuation, not a sign flip
 * of the control's meaning. The signed form is therefore correct and is what
 * this returns; a magnitude here would print an attenuating tap as a boost.
 */
export function b3ntb0xRippleGain(p: B3ntb0xFaceParams): number {
  const d = p.bend_d < -1 ? -1 : p.bend_d > 1 ? 1 : p.bend_d;
  // The shader's stage-D guard: |d| <= 1e-4 leaves the stage out entirely.
  const dTerm = Math.abs(d) > 1e-4 ? 1 + 0.8 * d : 1;
  return p.sync_crush * (1 + 2 * p.enhance) * dTerm;
}

/** `ripple gain` — a bare multiplier, the unit the shader works in. */
export function b3ntb0xRippleGainText(read: (paramId: string) => number | undefined): string {
  const g = b3ntb0xRippleGain(b3ntb0xFaceParams(read));
  if (!Number.isFinite(g)) return '—';
  // A gain of exactly 0 is reachable (sync_crush bottoms at 0) and means the
  // bend circuit passes no picture content at all — worth saying in words,
  // because "x0.00" reads like a formatting failure.
  if (g === 0) return 'no signal';
  return `x${g.toFixed(2)}`;
}

/**
 * THE LINE SHIFT — `1 - tbc`, the fraction of the recovered sync offset and the
 * analog timebase wobble that reaches the picture.
 */
export function b3ntb0xLineShift(p: B3ntb0xFaceParams): number {
  return 1 - p.tbc;
}

/** `line shift` — `locked` at the shipped default, else the percentage that
 *  gets through. */
export function b3ntb0xLineShiftText(read: (paramId: string) => number | undefined): string {
  const f = b3ntb0xLineShift(b3ntb0xFaceParams(read));
  if (!Number.isFinite(f)) return '—';
  if (f <= 0) return 'locked';
  return `${(f * 100).toFixed(0)}%`;
}
