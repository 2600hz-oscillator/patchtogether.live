// packages/web/src/lib/ui/modules/ninelives-face-model.ts
//
// THE PURE MODEL BEHIND THE NINE LIVES FACEPLATE — the ladder arithmetic behind
// its three hero readouts and its nine-row cycle-time table.
//
// WHY A MODEL AT ALL FOR A TWO-KNOB MODULE. Because the knob that matters is
// the one that cannot say what the module does. RATE is a single log fader
// printing ONE frequency, and it drives NINE outputs whose rates span 6561×
// — so `{ paramId: 'rate' }` prints `1.00 Hz` while out9 is taking 1.8 HOURS
// per cycle. That is not a readback that is merely incomplete about the taps;
// it is INVARIANT to which tap you are asking about, which is exactly the
// blindness `FaceReadout.valueId` exists for (see face-readout-values.ts). It
// is the same shape as `noise`, where one LEVEL knob drives three outputs
// 12.3 dB apart.
//
// ⚠ NOTHING HERE RESTATES THE LADDER. `NINE_LIVES_RATE_MULTIPLIERS` is
// IMPORTED from `packages/dsp/src/lib/ninelives-dsp.ts` — the file the worklet
// is built from and the file the ART ladder scenario measures against — so a
// change to the ⅓ ratio or to the number of rungs moves the printed numbers
// instead of leaving the faceplate insisting on the old ones. A restated
// constant would be a drift hazard with no gate joining the two copies;
// `ninelives-face-model.test.ts` additionally asserts the identity in both
// directions, so the import cannot quietly become a copy.
//
// RELATIVE path, not the `@patchtogether.live/dsp/src/...` alias, for the
// reason `sidecar-face-model.ts` / `resofilter-face-model.ts` both document: a
// worktree may not symlink the workspace package under node_modules, and the TS
// path-alias rules do not reliably resolve TS source out of there.
//
// PURE — no DOM, no Svelte, no engine, no fs. Node-testable.

import { ninelivesDef } from '$lib/audio/modules/ninelives';
import { NINE_LIVES_RATE_MULTIPLIERS } from '../../../../../dsp/src/lib/ninelives-dsp';

/**
 * Each tap's rate multiplier relative to `rate`, in DECLARATION order — the DSP
 * core's own ladder, re-exported under this face's name rather than restated.
 * Index n is the port `out{n+1}`.
 */
export const NINELIVES_TAP_MULTIPLIERS: readonly number[] = NINE_LIVES_RATE_MULTIPLIERS;

/**
 * The DECLARED tap port ids, in ladder order, read off the def.
 *
 * DERIVED, never typed. The face's sidebar table, this model and the def's own
 * `outputs` roster all resolve the population the same way, so there is one
 * place a tenth tap has to be added and no count anywhere.
 */
export const NINELIVES_TAP_PORT_IDS: readonly string[] = ninelivesDef.outputs.map((o) => o.id);

/**
 * The cycle-time threshold the `≤ 1 min` readout is stated AT, in seconds.
 *
 * A POLICY THRESHOLD ON A DERIVED MEASUREMENT, not a population count: it is
 * the boundary the readout's own LABEL prints, so it cannot go stale silently
 * — a reader sees `≤ 1 min` and the number that produced it in the same glance.
 * One minute is chosen because it is roughly the longest a patcher will stare
 * at a scope before deciding a jack is dead, which is the confusion this
 * readout exists to remove.
 */
export const NINELIVES_LIVELY_PERIOD_S = 60;

export interface NinelivesFaceParams {
  /** OUT 1's frequency in Hz — the top rung. Every other tap is this × its
   *  ladder multiplier. */
  rate: number;
  /** The SHARED waveform morph, 0 = sine, 1 = saw, 2 = square. */
  shape: number;
}

/**
 * Live values in, resolving the DEF DEFAULT for anything untouched.
 * `node.params` is a SPARSE overlay of what has been TOUCHED, so reading it
 * bare prints `undefined`-shaped nonsense on a freshly spawned node.
 */
export function ninelivesFaceParams(
  read: (paramId: string) => number | undefined,
): NinelivesFaceParams {
  const val = (id: string): number => {
    const v = read(id);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const pd = ninelivesDef.params.find((p) => p.id === id);
    if (!pd) throw new Error(`ninelives-face-model: ninelives has no param '${id}'`);
    return pd.defaultValue;
  };
  return { rate: val('rate'), shape: val('shape') };
}

/** Tap `n` (0-based, `out{n+1}`) in Hz at the live RATE. */
export function ninelivesTapHz(n: number, p: NinelivesFaceParams): number {
  const mult = NINELIVES_TAP_MULTIPLIERS[n];
  if (mult === undefined) return Number.NaN;
  return Math.max(0, p.rate) * mult;
}

/** Tap `n`'s cycle time in SECONDS. `Infinity` at rate 0 (the dial's floor is
 *  0.01 Hz, but a NaN/0 read must not produce a division artefact). */
export function ninelivesTapPeriodS(n: number, p: NinelivesFaceParams): number {
  const hz = ninelivesTapHz(n, p);
  return hz > 0 ? 1 / hz : Number.POSITIVE_INFINITY;
}

/**
 * A cycle time, formatted with the unit the number is actually in.
 *
 * ⚠ THE ADAPTIVE UNIT IS THE WHOLE POINT and not a nicety. This module's taps
 * span 0.01 s (out1 at Rate 100) to 656 100 s (out9 at Rate 0.01) — SEVEN AND A
 * HALF ORDERS OF MAGNITUDE. Any single unit is unreadable at one end: `656100 s`
 * and `0.00000002 d` are both technically correct and neither is a fact anyone
 * can use.
 */
export function fmtNinelivesPeriod(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'still';
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  if (seconds < 60) return `${seconds.toFixed(2)} s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)} min`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86400).toFixed(1)} d`;
}

/** What the sidebar table prints for tap `n` — its cycle time. */
export function ninelivesTapPeriodText(n: number, p: NinelivesFaceParams): string {
  return fmtNinelivesPeriod(ninelivesTapPeriodS(n, p));
}

/**
 * BOTH ENDS OF THE LADDER as cycle times, e.g. `1.00 s → 1.8 h`.
 *
 * The string the RATE dial is structurally unable to produce: the dial is one
 * number and this is a span. WAVEFORM-invariant by construction — `shape`
 * chooses what is read off the accumulators and never how fast they advance,
 * which is a permanent leg of the model test AND of the ART scenario.
 */
export function ninelivesLadderSpanText(p: NinelivesFaceParams): string {
  const last = NINELIVES_TAP_MULTIPLIERS.length - 1;
  return `${ninelivesTapPeriodText(0, p)} → ${ninelivesTapPeriodText(last, p)}`;
}

/**
 * The taps whose cycle is `NINELIVES_LIVELY_PERIOD_S` or shorter, as a port
 * range — `out 1–4` at the shipped Rate, `out 1` just above the knee, `none`
 * below it.
 *
 * ⚠ IT IS ALWAYS A PREFIX, and that is a property of the ladder rather than an
 * assumption: the multipliers are strictly decreasing, so the periods are
 * strictly increasing and the qualifying set is `[0, k)`. The model test
 * asserts the monotonicity directly so the range form cannot become a lie.
 */
export function ninelivesFastTaps(p: NinelivesFaceParams): number {
  let k = 0;
  for (let n = 0; n < NINELIVES_TAP_MULTIPLIERS.length; n++) {
    if (ninelivesTapPeriodS(n, p) <= NINELIVES_LIVELY_PERIOD_S) k = n + 1;
    else break;
  }
  return k;
}

/** What the hero prints for the `≤ 1 min` readout. */
export function ninelivesFastTapsText(p: NinelivesFaceParams): string {
  const k = ninelivesFastTaps(p);
  if (k === 0) return 'none';
  if (k === 1) return 'out 1';
  return `out 1–${k}`;
}

/**
 * The WAVEFORM the 0..2 morph dial is sitting on, NAMED.
 *
 * `morph()` (ninelives-dsp.ts) crossfades sine→saw below 1 and saw→square
 * above it, so the dial's number is a position on a two-segment path with three
 * named vertices and the dial can print none of them. RATE-invariant by
 * construction — which is what makes it the negative control for the two
 * readouts above, and them for it.
 */
export function ninelivesWaveText(p: NinelivesFaceParams): string {
  const s = Math.min(2, Math.max(0, Number.isFinite(p.shape) ? p.shape : 0));
  const EPS = 5e-3;
  if (s < EPS) return 'sine';
  if (Math.abs(s - 1) < EPS) return 'saw';
  if (s > 2 - EPS) return 'square';
  return s < 1
    ? `sine→saw ${Math.round(s * 100)}%`
    : `saw→square ${Math.round((s - 1) * 100)}%`;
}
