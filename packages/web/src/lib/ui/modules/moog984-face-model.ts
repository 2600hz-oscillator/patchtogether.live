// packages/web/src/lib/ui/modules/moog984-face-model.ts
//
// The PURE model behind the MOOG 984 faceplate — the four numbers a 4×4 matrix
// cannot print from any one of its sixteen knobs.
//
// ── WHY IT EXISTS ──────────────────────────────────────────────────────────
//
// The factory wires `fanIn[i] → cross[i][j] → sumOut[j]` with `cross[i][j].gain
// = m(i+1)(j+1)` and every fan/sum gain at unity (`moog984.ts:120-152`), so
//
//     out_j = Σ_i  in_i · m_ij
//
// An OUTPUT's gain is therefore a JOIN over a whole COLUMN of the matrix, and
// no cross-point knob is a proxy for it. This is the kickdrum-TAIL trap in its
// sharpest form, because the matrix makes the blindness geometric rather than
// merely surprising:
//
//   a readback of `m11` MOVES when you turn `m11` — it looks like OUT 1's level
//   — and is INVARIANT to `m21`, `m31` and `m41`, which are three quarters of
//   what OUT 1 actually carries. It is ALSO wrongly sensitive to nothing at
//   all, so a reviewer perturbing "the nearest knob" gets a green every time.
//
// The number below is the WORST-CASE (correlated) bus gain, exactly as
// `moogCp3BusGain` is for the CP3: the factor an output applies when every
// input carries the same full-scale signal. That is the case that clips, and
// there is no clamp or saturator anywhere in the 984's path — it is a passive
// router modelled with unity summing gains, so four cross-points at 1.0 put
// ×4.0 (+12.041 dB) on a bus with nothing to catch it.
//
// ⚠ WHAT THIS NUMBER IS NOT. It is not a level meter. With UNCORRELATED inputs
// the sum is not the arithmetic sum of the gains, and with an anti-phase pair
// it can be zero while this reads ×2. It is the COLUMN SUM — a property of the
// PATCH, computed from the params the same way the graph computes the gain —
// and the face labels it per output bus rather than as a level for that reason.
//
// ── DERIVATION ────────────────────────────────────────────────────────────
//
// Every figure here is DERIVED from `moog984Def` at module load: the param ids
// come from the def's own `params` roster (which the def BUILDS from `N = 4` in
// a loop), and the fallbacks come from each `ParamDef.defaultValue`. Nothing is
// re-typed, so a def change cannot drift this model — and there is no literal
// whose value is "how many cross-points there are".
//
// PURE: no DOM, no engine, no store, no fs, no sample rate.

import { moog984Def } from '$lib/audio/modules/moog984';

/**
 * The cross-point ids that feed one output column, in INPUT order.
 *
 * DERIVED from the def by parsing its own param ids rather than re-deriving the
 * `m${i}${j}` convention here: `mIJ` is input I, output J, so column `j` is
 * every param whose id ends in `j`. Building it off `moog984Def.params` means
 * this model cannot disagree with the roster the factory wires.
 */
function columnIds(outIndex: number): readonly string[] {
  const suffix = String(outIndex);
  return moog984Def.params
    .map((p) => p.id)
    .filter((id) => id.length === 3 && id[0] === 'm' && id[2] === suffix)
    .sort();
}

/** The four output columns, in bus order — `COLUMNS[0]` is OUT 1. DERIVED. */
export const MOOG984_COLUMNS: readonly (readonly string[])[] = moog984Def.outputs.map((_, k) =>
  columnIds(k + 1),
);

/** Every cross-point's declared default, keyed by id. DERIVED, never re-typed. */
const DEFAULTS: ReadonlyMap<string, number> = new Map(
  moog984Def.params.map((p) => [p.id, p.defaultValue]),
);

/** One cross-point read off a live reader, clamped to its DECLARED travel.
 *
 *  ⚠ THE CLAMP IS LOAD-BEARING AND IT IS NOT COSMETIC. `read` is fed by the
 *  live param store, which MIDI learn, automation, a preset load and any
 *  persisted patch can reach with an arbitrary float — the same seam
 *  `moog993RouteState` was written for. Without it a single out-of-contract
 *  write makes all four readouts nonsense, and a NaN one makes them `NaN dB`
 *  on every render, which is a faceplate-wide failure from one bad key. */
function crossValue(read: (paramId: string) => number | undefined, id: string): number {
  const fallback = DEFAULTS.get(id) ?? 0;
  const v = read(id);
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  const p = moog984Def.params.find((q) => q.id === id);
  const min = p?.min ?? 0;
  const max = p?.max ?? 1;
  return v < min ? min : v > max ? max : v;
}

/**
 * THE WORST-CASE BUS GAIN for one output — `Σ_i m_ij`, the factor OUT `j`
 * applies when all four inputs carry the same full-scale signal.
 *
 * `outIndex` is 1-based (OUT 1 = 1). An index naming no bus returns 0 rather
 * than throwing: this runs on every render and a throw takes the faceplate down
 * mid-drag (`face-readout-values.ts` totality rule).
 */
export function moog984ColumnGain(
  read: (paramId: string) => number | undefined,
  outIndex: number,
): number {
  const ids = MOOG984_COLUMNS[outIndex - 1];
  if (!ids) return 0;
  let sum = 0;
  for (const id of ids) sum += crossValue(read, id);
  return sum;
}

/** The same figure in dB. `-Infinity` when every cross-point on the bus is shut. */
export function moog984ColumnDb(
  read: (paramId: string) => number | undefined,
  outIndex: number,
): number {
  const g = moog984ColumnGain(read, outIndex);
  return g > 0 ? 20 * Math.log10(g) : Number.NEGATIVE_INFINITY;
}

/**
 * `out N` — how far over full scale a correlated patch lands on that bus.
 *
 * ⚠ ONE NUMBER WITH ONE UNIT, following `moogCp3BusText` exactly. The composite
 * form (`x2.00 · +6.0 dB`) is within a character of the readout the owner
 * deleted from mixmstrs.
 *
 * `'silent'` rather than `-Infinity dB` at the shipped defaults, which is where
 * this module SPAWNS: every cross-point defaults to 0, so a fresh 984 reads
 * `silent` on all four buses — a true and useful statement ("nothing is patched
 * yet"), not a formatting evasion.
 */
export function moog984ColumnText(
  read: (paramId: string) => number | undefined,
  outIndex: number,
): string {
  const dbv = moog984ColumnDb(read, outIndex);
  if (dbv === Number.NEGATIVE_INFINITY) return 'silent';
  if (!Number.isFinite(dbv)) return `${dbv}`;
  const s = dbv.toFixed(1);
  return dbv > 0 ? `+${s} dB` : `${s} dB`;
}

/** The four registry entries, one per output bus. DERIVED from the def's own
 *  output roster, so a fifth bus would arrive here without an edit. */
export const MOOG984_COLUMN_READOUTS: readonly {
  readonly valueId: string;
  readonly label: string;
  readonly text: (read: (paramId: string) => number | undefined) => string;
}[] = moog984Def.outputs.map((port, k) => ({
  valueId: `moog984-${port.id}-sum`,
  label: `out ${k + 1}`,
  text: (read) => moog984ColumnText(read, k + 1),
}));
