// packages/web/src/lib/control/push2/push-card-model.ts
//
// WHAT a module's PUSH CARD shows, for a live node — the pure view model the
// Push 2's 960×160 display (and its DOM preview) paint. Given a resolved
// PushCardSpec plus the node's current params, it produces EIGHT strips: a
// name, a formatted readout, and a normalized bar position.
//
// PURE — no DOM, no canvas, no engine, no registry. The layout/paint half is a
// separate, browser-only file (a later PR); everything interesting is here.
//
// ── THE BAR IS THE PART THAT MUST NOT LIE ─────────────────────────────────
//
// `frac` comes from `knobValueToFrac` — the SAME function KnobConic.svelte
// drives its `--v` value arc from. That is mandatory, not a convenience: the
// Push bar and the on-screen dial then sit at the same position BY
// CONSTRUCTION. Rolling a local `(v - min) / (max - min)` here is exactly the
// "a card silently disagrees with its def" failure class, and it is invisible
// at the endpoints — a log param drawn linearly looks perfectly fine at min
// and max and is wrong everywhere between. It matters in the real windows:
// `filter.cutoff` is log 20..20000 (its geometric midpoint 632 Hz would draw at
// 3 % of the bar under a linear map instead of 50 %), `tomtom.tune` is log
// 60..400, `kickdrum.sub_decay` log 50..800 ms.
//
// BIPOLAR params are all over the windows too — `vca.cvAmount` (−1..1),
// `tidyVco.detune` (−50..50), `tidyVco.oct2` (−1..1), `tidyVco.env` (−1..1),
// `filter.cutoff_cv_amt` / `res_cv_amt` (−1..1). Their bar is anchored at the
// ZERO position, not at the left edge; without that anchor an attenuverter at
// rest draws a half-full bar and reads as "turned up".
//
// DISCRETE params with a small state count draw CELLS, not a continuous fill,
// so a 3-state filter MODE cannot look like a sweep. Above CELL_MAX_STEPS the
// cells would be unreadable (dx7's `algorithm` is 1..32 → ~3 px each) and the
// bar falls back to a continuous fill.
//
// Readout text goes through `knobReadout` (the app's own vocabulary resolver:
// a declared `format`, then an `options` NAME, then the nearest `landmark`)
// and falls back to `formatParamNumber` — the same ladder Knob / KnobConic /
// Fader print. So the hardware screen and the dial show identical strings.

import type { ModuleNode, ParamDef } from '$lib/graph/types';
import { knobValueToFrac } from '$lib/ui/controls/knob-conic-model';
import { knobMarks, knobReadout, nearestByValue } from '$lib/ui/controls/knob-vocabulary-model';
import { formatParamNumber, isBipolarRange } from '$lib/ui/controls/param-format';
import { resolveDisplayName } from '$lib/multiplayer/module-naming';
import type { PushCardSource, PushCardSpec } from './push-card-schema';

/**
 * Most named states a discrete param may have before its bar stops drawing
 * one cell per state. Sixteen cells across the ~102 px strip interior is ~6 px
 * apiece — the last width at which a lit/unlit cell is still legible from
 * behind a keyboard. dx7's 32 algorithms are the case this bound exists for.
 */
export const CELL_MAX_STEPS = 16;

/** How a celled bar reads its cells. */
export type PushCellStyle =
  /** A small QUANTITY (dx7 `feedback` 0..7) — cells 0..cellIndex are lit. */
  | 'fill'
  /** A named/centred STATE (filter `mode`, tidyVco `oct2`) — only cellIndex
   *  is lit, because "3 of 3 lit" would read as a maximum rather than a mode. */
  | 'select';

/** One encoder strip. `kind: 'empty'` is a deliberately blank slot. */
export interface PushStripView {
  kind: 'param' | 'empty';
  /** Physical display encoder, 1..8, left to right. Always set. */
  encoder: number;
  /** '' for an empty strip. */
  paramId: string;
  /** UPPERCASED param label, un-ellipsized (the layout owns truncation). */
  label: string;
  /** The readout, identical to what the on-screen dial prints. */
  valueText: string;
  /** The raw live value (unclamped — what is actually stored on the node). */
  value: number;
  /** Bar position 0..1 under the param's OWN curve. */
  frac: number;
  /** Bar ORIGIN 0..1 — the zero position for a bipolar param, else 0. */
  zeroFrac: number;
  bipolar: boolean;
  /** Cell count for a small discrete param, else null (continuous fill). */
  cells: number | null;
  /** 0-based active cell; 0 when `cells` is null. */
  cellIndex: number;
  cellStyle: PushCellStyle;
  /** Detent tick positions 0..1 (declared options / landmarks only). */
  pips: readonly number[];
}

/** Optional LANE context. PR-1 does not resolve lanes — the lane member list
 *  and the "most recently added / last viewed" focus rule are a separate pure
 *  module — so these ride through as nulls until that lands. Keeping the
 *  fields here means the header's shape is fixed now and the lane PR only
 *  fills them in. */
export interface PushCardContext {
  lane?: number | null;
  /** Lane accent colour (the same hue as the Push's LED row), '#rrggbb'. */
  laneHex?: string | null;
  /** 1-based position of this module within its lane, and the lane size. */
  index?: number | null;
  count?: number | null;
  /** The rack's nodes — only consulted for the legacy unnamed-node fallback
   *  inside `resolveDisplayName`, which a supplied `def.label` short-circuits. */
  nodes?: Record<string, ModuleNode | undefined>;
}

export interface PushCardView {
  moduleType: string;
  domain: string;
  source: PushCardSource;
  /** The module's display name — the node's user-set name, else its label. */
  title: string;
  /** The module's palette category ('voices', 'effects', …). */
  subtitle: string;
  lane: number | null;
  laneHex: string | null;
  index: number | null;
  count: number | null;
  /** ALWAYS length 8. */
  strips: readonly PushStripView[];
  /** Non-null when the card has nothing to show. PR-1 can only produce
   *  'no-controls'; the lane states arrive with the lane resolver. */
  empty: null | 'no-lane' | 'no-modules' | 'no-controls';
}

/** Minimal def shape the view needs (title fallback + subtitle). */
export interface PushCardViewDefLike {
  type: string;
  label?: string;
  category?: string;
}

const NO_NODES: Record<string, ModuleNode | undefined> = {};

/**
 * How many discrete states a param has, or null when it should draw a
 * continuous fill. An `options` roster is authoritative (it is the declared
 * state list); otherwise a `discrete` curve spans `max - min + 1` integers.
 */
export function discreteSteps(p: ParamDef): number | null {
  if (p.curve !== 'discrete') return null;
  // `||`, not `??`: an EMPTY roster must fall back to the integer span, or a
  // `options: []` authoring slip would silently turn a 3-state param into a
  // continuous sweep — the exact lie the cells exist to prevent.
  const steps = p.options?.length || Math.round(p.max - p.min) + 1;
  if (!Number.isFinite(steps) || steps < 2 || steps > CELL_MAX_STEPS) return null;
  return steps;
}

/** Live value for a param on a node, falling back to the def default. */
export function paramValue(node: Pick<ModuleNode, 'params'>, p: ParamDef): number {
  const v = node.params?.[p.id];
  return typeof v === 'number' && Number.isFinite(v) ? v : p.defaultValue;
}

/**
 * The strip view for one param at one value.
 *
 * `frac` clamps (via knobValueToFrac) while `value`/`valueText` do NOT — which
 * is exactly what KnobConic does: the arc pins at the endpoint but the readout
 * still tells you the out-of-range number that is really stored.
 */
export function pushStrip(p: ParamDef, value: number, encoder: number): PushStripView {
  const bipolar = isBipolarRange(p.min, p.max);
  const frac = knobValueToFrac(value, p.min, p.max, p.curve);
  const zeroFrac = bipolar ? knobValueToFrac(0, p.min, p.max, p.curve) : 0;

  const cells = discreteSteps(p);
  let cellIndex = 0;
  if (cells !== null) {
    if (p.options?.length) {
      // A DECLARED roster indexes by the option `knobReadout` is about to
      // NAME — via the same `nearestByValue` — so the lit cell and the printed
      // state can never disagree. Deriving it from the arc instead would let
      // the screen light cell 2 while spelling out the name of cell 1 whenever
      // the roster is sparse (states at 0, 4 and 9 of a 0..9 range).
      const near = nearestByValue(value, p.options);
      cellIndex = near ? p.options.indexOf(near) : 0;
    } else {
      // No roster ⇒ one cell per integer, so the arc form and (value - min)
      // are the SAME expression (cells - 1 === max - min). The arc form is
      // used because it stays correct if that ever stops holding.
      cellIndex = Math.round(frac * (cells - 1));
    }
    // NO CLAMP: both branches are already bounded to [0, cells - 1] — an
    // `indexOf` into the roster that DEFINED `cells`, and a `frac` that
    // `knobValueToFrac` clamps to [0,1]. A clamp here could never fire, and a
    // guard that cannot fire is decoration that reads like a safety net. The
    // bound is asserted for real by the all-modules sweep in the spec.
  }
  // A named roster or a centre-anchored range is a STATE, not a quantity.
  const cellStyle: PushCellStyle = p.options?.length || bipolar ? 'select' : 'fill';

  const vocab = { options: p.options, landmarks: p.landmarks, format: p.format };
  return {
    kind: 'param',
    encoder,
    paramId: p.id,
    label: p.label.toUpperCase(),
    valueText: knobReadout(value, vocab) ?? formatParamNumber(value, p.units ?? ''),
    value,
    frac,
    zeroFrac,
    bipolar,
    cells,
    cellIndex,
    cellStyle,
    pips: knobMarks(vocab, p.min, p.max, p.curve).map((m) => m.frac),
  };
}

/** A blank strip — the common case, not an error (9 of the 17 curated modules
 *  have fewer than 8 controls in total). */
export function emptyStrip(encoder: number): PushStripView {
  return {
    kind: 'empty',
    encoder,
    paramId: '',
    label: '',
    valueText: '',
    value: 0,
    frac: 0,
    zeroFrac: 0,
    bipolar: false,
    cells: null,
    cellIndex: 0,
    cellStyle: 'fill',
    pips: [],
  };
}

/**
 * The full push-card view for a node. PURE.
 *
 * The title goes through `resolveDisplayName` — the same precedence the card
 * title bar and the dock stub use — rather than re-implementing "name else
 * label", so a renamed module is named identically on the hardware.
 */
export function pushCardView(
  spec: PushCardSpec,
  node: ModuleNode,
  def: PushCardViewDefLike,
  ctx: PushCardContext = {},
): PushCardView {
  const strips = spec.slots.map((slot, i) =>
    slot.kind === 'param' ? pushStrip(slot.param, paramValue(node, slot.param), i + 1) : emptyStrip(i + 1),
  );
  const hasControls = strips.some((s) => s.kind === 'param');
  return {
    moduleType: spec.moduleType,
    domain: spec.domain,
    source: spec.source,
    title: resolveDisplayName(node, ctx.nodes ?? NO_NODES, def.label ?? def.type),
    subtitle: def.category ?? '',
    lane: ctx.lane ?? null,
    laneHex: ctx.laneHex ?? null,
    index: ctx.index ?? null,
    count: ctx.count ?? null,
    strips,
    empty: hasControls ? null : 'no-controls',
  };
}
