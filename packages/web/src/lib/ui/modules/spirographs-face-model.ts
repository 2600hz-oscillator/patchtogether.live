// packages/web/src/lib/ui/modules/spirographs-face-model.ts
//
// The PURE model behind the SPIROGRAPHS faceplate.
//
// THIRTY-ONE DIALS AND NOT ONE OF THEM SAYS WHAT THE PICTURE WILL BE. Three
// facts about this module are decided by JOINS over several dials, are the
// things a player actually wants to know, and appear nowhere in the product:
//
//   1. TWENTY OF THE THIRTY-ONE PARAMS ARE INERT AT SPAWN. `count` ships at 1,
//      so spiro 2 and spiro 3 render nothing at all — and their twenty dials sit
//      there reading plausible values while contributing zero pixels. Every
//      readout below is therefore computed over the LIVE spiros ONLY, which is
//      the blindness that makes them worth having: perturbing spiro 3 at
//      `count = 1` must move NOTHING.
//
//   2. ALMOST NO SETTING CLOSES. R and r are CONTINUOUS knobs, and a trochoid
//      closes only for a RATIONAL R:r. At R = 5 the module's own
//      `revolutionsToClose` gives 3 revolutions for r = 3 and hits its 200-cap
//      — a dense quasi-curve that never closes — for r = 2.4142. The two dials
//      are a millimetre apart on screen. Nothing on the module distinguishes
//      them.
//
//   3. WHETHER THE FIGURE CLIPS IS SCALE-INVARIANT, WHICH IS THE OPPOSITE OF
//      WHAT "ZOOM" SUGGESTS. Only the FIXED circle is kept in frame (radius
//      `R * scale`, bounced off an inset of its own size); the drawn curve may
//      overflow, which the module intends. So the curve reaches past the frame
//      exactly when `curveMaxReach > R` — and `scale` multiplies BOTH sides, so
//      it cancels. Zooming in never makes a figure start or stop clipping.
//      Measured at the shipped defaults: spiro 1 reaches 4.2 against R = 5 and
//      always fits; spiro 2 reaches 7.5 against R = 7 and spiro 3 reaches 9.0
//      against R = 5, so both can clip.
//
// EVERY DERIVATION IS THE MODULE'S OWN. `revolutionsToClose` and
// `curveMaxReach` are imported from `spirographs-math` — the same functions
// `sampleSpiro` and the draw path call — rather than re-implemented here, so a
// change to the curve maths cannot leave the faceplate describing the old one.
//
// PURE: no DOM, no engine, no store, no GPU.

import {
  curveMaxReach,
  gcdInt,
  REVS_MAX_DEFAULT,
  REVS_PRECISION,
  revolutionsToClose,
  type SpiroKind,
} from '$lib/video/modules/spirographs-math';
import {
  SPIRO_COUNT_MAX,
  SPIRO_PARAM_STEMS,
  spiroParamId,
  spirographsDef,
  type SpiroParamStem,
} from '$lib/video/modules/spirographs';

/** One spiro's live values, plus whether it is actually rendering. */
export interface SpiroFaceState {
  /** 1-based spiro index. */
  index: number;
  /** Is this spiro within the live `count`? */
  live: boolean;
  R: number;
  r: number;
  p: number;
  kind: SpiroKind;
  scale: number;
}

/** The def's own spawn defaults — read off the def, never retyped. */
const DEFAULT_OF: Record<string, number> = Object.fromEntries(
  spirographsDef.params.map((p) => [p.id, p.defaultValue]),
);

/**
 * Read the whole module off a live param reader.
 *
 * ⚠ `live` IS THE LOAD-BEARING FIELD. `count` decides how many spiros the draw
 * path visits, and every readout here filters on it — which is what makes them
 * blind to a dial that is genuinely doing nothing, and what a per-knob readback
 * cannot be.
 */
export function spirographsFaceState(
  read: (paramId: string) => number | undefined,
): { count: number; spiros: readonly SpiroFaceState[] } {
  const pick = (id: string): number => {
    const v = read(id);
    return typeof v === 'number' && Number.isFinite(v) ? v : (DEFAULT_OF[id] ?? 0);
  };
  const raw = pick('count');
  const count = Math.min(SPIRO_COUNT_MAX, Math.max(1, Math.round(raw)));
  const spiros: SpiroFaceState[] = [];
  for (let i = 1; i <= SPIRO_COUNT_MAX; i++) {
    const g = (stem: SpiroParamStem) => pick(spiroParamId(i, stem));
    spiros.push({
      index: i,
      live: i <= count,
      R: g('R'),
      r: g('r'),
      p: g('p'),
      kind: g('inside') >= 0.5 ? 'inside' : 'outside',
      scale: g('scale'),
    });
  }
  return { count, spiros };
}

// ── THE FIGURE ──────────────────────────────────────────────────────────────

/** How many revolutions of `t` before the figure closes — the module's own
 *  answer, cap included. At the cap the figure never closes. */
export function spiroRevolutions(s: SpiroFaceState): number {
  return revolutionsToClose(s.R, s.r);
}

/** TRUE when the ratio does not resolve inside the module's own cap: a dense
 *  quasi-curve that fills the annulus rather than closing. */
export function spiroIsDense(s: SpiroFaceState): boolean {
  return spiroRevolutions(s) >= REVS_MAX_DEFAULT;
}

/**
 * Petal (cusp) count — the reduced R numerator of the same integer reduction
 * `revolutionsToClose` performs on the denominator.
 *
 * ⚠ MEANINGLESS WHEN DENSE, and deliberately not printed there: the
 * rationalisation of an irrational-looking ratio yields a huge numerator (2500
 * at R = 5, r = 2.4142) which is an artifact of `REVS_PRECISION`, not a count
 * of anything a viewer could see.
 */
export function spiroPetals(s: SpiroFaceState): number {
  const ai = Math.max(1, Math.round(Math.abs(s.R) * REVS_PRECISION));
  const bi = Math.max(1, Math.round(Math.abs(s.r) * REVS_PRECISION));
  const g = gcdInt(ai, bi);
  return Math.round(ai / (g || 1));
}

/**
 * CAN THIS FIGURE REACH PAST THE FRAME?
 *
 * Only the FIXED circle is bound-constrained: its centre bounces inside a box
 * inset by its own screen radius `R * scale`, so at the worst position the
 * frame edge is exactly `R * scale` away. The pen reaches
 * `curveMaxReach * scale`. The figure can therefore clip exactly when
 * `curveMaxReach > R` — and `scale` MULTIPLIES BOTH SIDES, so it cancels out
 * entirely. That is the counter-intuitive half and the one worth printing:
 * zooming never makes a figure start or stop clipping.
 */
export function spiroCanClip(s: SpiroFaceState): boolean {
  return curveMaxReach(s.kind, s.R, s.r, s.p) > s.R;
}

/** The pen's maximum reach in spiro units — the module's own function. */
export function spiroReach(s: SpiroFaceState): number {
  return curveMaxReach(s.kind, s.R, s.r, s.p);
}

// ── WHAT THE FACEPLATE PRINTS ───────────────────────────────────────────────

/** Join the 1-based indices of a set of spiros, or `none`. */
function names(indices: readonly number[]): string {
  return indices.length === 0 ? 'none' : indices.join(', ');
}

/** HOW MANY SPIROS ARE ACTUALLY DRAWING — and therefore how many of the
 *  thirty parameter dials are doing anything at all. */
export function spirographsLiveText(read: (paramId: string) => number | undefined): string {
  const { count } = spirographsFaceState(read);
  return `${count} of ${SPIRO_COUNT_MAX}`;
}

/** WHICH LIVE FIGURES NEVER CLOSE. `all close` when every live spiro resolves
 *  inside the cap. Spiros above `count` are not consulted. */
export function spirographsClosesText(read: (paramId: string) => number | undefined): string {
  const { spiros } = spirographsFaceState(read);
  const dense = spiros.filter((s) => s.live && spiroIsDense(s)).map((s) => s.index);
  return dense.length === 0 ? 'all close' : `${names(dense)} dense`;
}

/** WHICH LIVE FIGURES CAN REACH PAST THE FRAME. Spiros above `count` are not
 *  consulted, and `scale` is structurally irrelevant (see `spiroCanClip`). */
export function spirographsClipText(read: (paramId: string) => number | undefined): string {
  const { spiros } = spirographsFaceState(read);
  const clipping = spiros.filter((s) => s.live && spiroCanClip(s)).map((s) => s.index);
  return clipping.length === 0 ? 'all fit' : `${names(clipping)} clip`;
}

/** ONE SPIRO'S FIGURE, for the sidebar table: its petal count and how many
 *  revolutions it takes to close — or `dense` when it never does, or `off`
 *  when `count` is not high enough to render it. */
export function spirographsFigureText(
  index: number,
  read: (paramId: string) => number | undefined,
): string {
  const { spiros } = spirographsFaceState(read);
  const s = spiros.find((x) => x.index === index);
  if (!s) return 'off';
  if (!s.live) return 'off';
  if (spiroIsDense(s)) return 'dense';
  return `${spiroPetals(s)} petals · ${spiroRevolutions(s)} rev`;
}

