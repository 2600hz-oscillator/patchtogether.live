// packages/web/src/lib/ui/modules/unityscalemathematik-face-model.ts
//
// THE PURE MODEL BEHIND THE UNITYSCALEMATHEMATIK FACEPLATE — the four hero
// readouts, which are all one function of the module's own shaping law read at
// two probe magnitudes.
//
// WHY A MODEL AT ALL FOR A FIVE-KNOB MODULE. Because the knob that matters
// cannot say what it does. A CRV is a bare 0..1 fader; the thing it moves is an
// EXPONENT, `k = 1 + 2·curve`, and an exponent is not a gain — it PIVOTS the
// response about an input magnitude of 1. Measured on the shipped worklet: at
// full curve a 0.5 input leaves at 0.125 while a 2.0 input leaves at 8.0. So a
// `{ paramId: 'aCurve' }` readout prints `1.00` for a control that has just
// attenuated one end of the range by 12 dB and amplified the other by 12, and
// there is no single number a dial COULD print that carries that. The shipped
// docs asserted the wrong half of it in prose (#1715); these readouts state
// both halves as live numbers instead, so a DSP change moves them rather than
// leaving the faceplate insisting.
//
// ⚠ NOTHING HERE RESTATES THE LAW. `unityScaleMath` is IMPORTED from the def —
// the same exported helper the module's own unit tests exercise — so a change
// to `curveToK` or to `shape` moves the printed numbers. That import is also
// asserted to AGREE WITH THE RENDERED AUDIO, to 9.02e-8 RELATIVE (~0.76 float32
// ULP: float64 `Math.pow` here against a float32 worklet, and nothing else), in
// art/scenarios/unityscalemathematik/cv-path.test.ts. Nothing else in the repo
// compares the two — the module unit test exercises the helper alone and the
// ART profile renders the worklet alone — so a restated formula here would be a
// drift hazard with no gate joining the copies.
//
// PURE — no DOM, no Svelte, no engine, no fs. Node-testable.

import { unityscalemathematikDef, unityScaleMath } from '$lib/audio/modules/unityscalemathematik';

/**
 * The two probe magnitudes the hero readouts are stated AT.
 *
 * POLICY THRESHOLDS ON A DERIVED MEASUREMENT, not population counts, and they
 * are chosen so the PAIR straddles the module's one fixed point: `|x| = 1` is
 * the only magnitude any curve leaves alone, so a single probe below it would
 * make the curve look like a pure attenuator (which is what the shipped docs
 * claimed) and a single probe above it like a pure gain. Both readouts print
 * their own probe magnitude in their label's neighbourhood — `half` and `2×` —
 * so a reader sees the input the number answers for in the same glance.
 */
export const UNITYSCALE_PROBE_HALF = 0.5;
export const UNITYSCALE_PROBE_OVER = 2;

/** The two curve-shaped sections, DERIVED from the def's own param roster
 *  rather than typed: a section is an `<x>Atten` that has a matching
 *  `<x>Curve`. `unityAtten` has none, which is exactly what makes it the plain
 *  channel and why it carries no readout. */
export const UNITYSCALE_SHAPED_SECTIONS: readonly string[] = unityscalemathematikDef.params
  .filter((p) => p.id.endsWith('Curve'))
  .map((p) => p.id.slice(0, -'Curve'.length));

export interface UnityscaleFaceParams {
  unityAtten: number;
  aAtten: number;
  aCurve: number;
  bAtten: number;
  bCurve: number;
}

/**
 * Live values in, resolving the DEF DEFAULT for anything untouched.
 * `node.params` is a SPARSE overlay of what has been TOUCHED, so reading it
 * bare prints `undefined`-shaped nonsense on a freshly spawned node.
 */
export function unityscaleFaceParams(
  read: (paramId: string) => number | undefined,
): UnityscaleFaceParams {
  const val = (id: string): number => {
    const v = read(id);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const pd = unityscalemathematikDef.params.find((p) => p.id === id);
    if (!pd) throw new Error(`unityscalemathematik-face-model: no param '${id}'`);
    return pd.defaultValue;
  };
  return {
    unityAtten: val('unityAtten'),
    aAtten: val('aAtten'),
    aCurve: val('aCurve'),
    bAtten: val('bAtten'),
    bCurve: val('bCurve'),
  };
}

/** What section `section` ('a' | 'b') turns an input of `x` into, through the
 *  module's OWN shaping law. */
export function unityscaleResponse(
  section: string,
  x: number,
  p: UnityscaleFaceParams,
): number {
  const atten = (p as unknown as Record<string, number>)[`${section}Atten`];
  const curve = (p as unknown as Record<string, number>)[`${section}Curve`];
  if (typeof atten !== 'number' || typeof curve !== 'number') return Number.NaN;
  return unityScaleMath.shape(x, atten, curve);
}

/**
 * A response, formatted.
 *
 * ⚠ THE ADAPTIVE PRECISION IS NOT A NICETY. Across the dials' travel a
 * half-scale probe spans 0.5 down to 0.000 (at atten 0) and a 2× probe spans
 * 0 up to 8, so a single fixed precision is either unreadable at the bottom
 * (`0.00` for three genuinely different settings) or noise at the top
 * (`8.0000`). The sign is always printed for a negative result because an
 * INVERTED channel is the thing a player most needs to notice, and the shaping
 * law preserves it exactly (`sign(x)·|x|^k·atten`).
 */
export function fmtUnityscaleResponse(y: number): string {
  if (!Number.isFinite(y)) return '—';
  const a = Math.abs(y);
  if (a === 0) return '0';
  if (a < 0.001) return y.toExponential(1);
  if (a < 1) return y.toFixed(3);
  if (a < 10) return y.toFixed(2);
  return y.toFixed(1);
}

/** What the hero prints for `<section> half` — the response at a half-scale
 *  input, the end of the range the curve pushes DOWN. */
export function unityscaleHalfText(section: string, p: UnityscaleFaceParams): string {
  return fmtUnityscaleResponse(unityscaleResponse(section, UNITYSCALE_PROBE_HALF, p));
}

/** What the hero prints for `<section> 2×` — the response at a double-scale
 *  input, the end of the range the curve LIFTS. It is the other half of the
 *  same law and it moves the opposite way, which is what makes the two a
 *  negative-control pair rather than two views of one number. */
export function unityscaleOverText(section: string, p: UnityscaleFaceParams): string {
  return fmtUnityscaleResponse(unityscaleResponse(section, UNITYSCALE_PROBE_OVER, p));
}
