// packages/web/src/lib/ui/modules/card-def-agreement.ts
//
// THE TREE-WIDE HALF of "a card can silently disagree with its def".
//
// ── The hole this closes (the blind-gate finding, 2026-08-02) ───────────────
// `card-range-source.test.ts` is the guard for the backdraft class (a card
// passing `xMin={-1}` against a def declaring ±0.2). It is a good guard. It was
// **OPT-IN BY FILENAME**: `RANGE_BOUND_CARDS` listed **7** cards out of **193**,
// so 186 cards — 96 % of the surface — were never looked at by the gate written
// for exactly their failure mode. `card-control-ranges.test.ts` has the same
// shape and its header says so out loud: *"Repo-wide enforcement is
// deliberately NOT attempted here."*
//
// `analogVco` is the proof it mattered: the def declares `fmAmount`/`pmAmount`
// as `min: -1, max: 1` and the card passed `min={0}` on both, so the knob
// reached half the contract while the DEF-DRIVEN dock face reached all of it.
// One param, two ranges, depending on which surface you looked at — and every
// existing gate green, because they all read the def.
//
// ── Why this is a SECOND gate, not a bigger version of the first ────────────
// The two ask different questions, and conflating them is what made the first
// one opt-in:
//
//   * `RANGE_BOUND_CARDS` asks **"is the divergence UNREPRESENTABLE?"** — the
//     card must not restate the def's numbers at all. That is the strong
//     property, it requires converting a card, and it can only ever be a
//     growing allowlist.
//   * This module asks **"does the restated number AGREE?"** — which every card
//     can be held to TODAY, with no conversion, and which catches the live bug.
//
// So the first stays an opt-in ratchet and this one is deny-by-default over the
// whole tree. A card that re-types a number is a HAZARD; a card that re-types it
// WRONG is a BUG, and there is no reason to wait for the first to be drained
// before refusing the second.
//
// ── Two tiers, because the two halves have different blast radii ────────────
//   OPERATIONAL (`min`, `max`, `defaultValue`, `curve`) decides WHAT VALUES A
//   CONTROL CAN WRITE and HOW ITS TRAVEL MAPS. A disagreement here is the
//   backdraft bug: values the contract forbids, or contract the knob cannot
//   reach, or a fader whose midpoint sits a decade from where the def puts it.
//   VOCABULARY (`label`, `units`) decides WHAT THE CONTROL IS CALLED. A
//   disagreement is the ringback `FB`-vs-`Feedback` / snaredrum `Tone`-×3 class:
//   the card, the rear jack and the doc page name one control several ways.
//
// Both are gated. They carry separate ledgers because the vocabulary tier is
// large (a 46 px lane knob column genuinely cannot print `Early Diffuse Mod
// Amt`) and every fix repaints a card, so draining it moves VRT baselines —
// while the operational tier is nearly empty and its fixes are pure logic.
//
// ── What this is STRUCTURALLY UNABLE TO SEE, stated so it cannot read as
//    coverage ─────────────────────────────────────────────────────────────────
//   * a control with no `paramId=` prop (POSITIONAL indexing — `def.params[3]`
//     — as qbrt, reverb and filter do). `uncheckableControls()` counts those.
//   * a prop whose value is an EXPRESSION rather than a literal (`min={lo}`):
//     that is either already def-bound or indirected past what a textual scan
//     can resolve.
//   * a card the registry cannot resolve (no `card:` override and no
//     conventional `PascalCase(type)Card.svelte`).
//   * anything about a control the card renders but the def does not declare.
//
// It reads the SOURCE, deliberately: a rendered-value check would build its
// expectation FROM the def and inherit exactly the blind spot it exists to
// close.

import { conventionalCardName } from '../modules-card-map';

/** The fields whose disagreement changes what a control DOES. */
export const OPERATIONAL_FIELDS = ['min', 'max', 'defaultValue', 'curve'] as const;
/** The fields whose disagreement changes what a control is CALLED. */
export const VOCABULARY_FIELDS = ['label', 'units'] as const;

export type AgreementField =
  | (typeof OPERATIONAL_FIELDS)[number]
  | (typeof VOCABULARY_FIELDS)[number];

/** Just enough of a ParamDef for the comparison. */
interface ParamLike {
  id: string;
  label?: string;
  min?: number;
  max?: number;
  defaultValue?: number;
  curve?: string;
  units?: string;
}
/** Just enough of a ModuleDef. */
export interface DefLike {
  type: string;
  card?: string;
  params?: readonly ParamLike[];
}

export interface Divergence {
  /** Card component basename, e.g. `AnalogVcoCard.svelte`. */
  card: string;
  /** 1-based line in the card source. */
  line: number;
  type: string;
  paramId: string;
  field: AgreementField;
  /** The literal the CARD passes. */
  card_: string | number;
  /** What the DEF declares. */
  def_: string | number | undefined;
}

/**
 * A range prop under ANY prefix. Mirrors `LITERAL_RANGE` in
 * card-range-source.test.ts: `min` / `xMin` / `valueMin` / `yMax` all mean the
 * same thing to the control underneath, and anticipating only the two prefixes
 * already known to have failed is how a source-level guard quietly stops
 * guarding.
 */
const NUM_PROP = (field: 'min' | 'max' | 'defaultValue'): RegExp => {
  const body =
    field === 'defaultValue' ? 'defaultValue' : `[A-Za-z]*${field[0]!.toUpperCase()}${field.slice(1)}|${field}`;
  return new RegExp(`(?:^|[^A-Za-z0-9_])(?:${body})=\\{\\s*(-?[0-9][0-9._eE+-]*)\\s*\\}`);
};
const STR_PROP = (field: string): RegExp =>
  new RegExp(`(?:^|[^A-Za-z0-9_])${field}=(["'])([^"']*)\\1`);

/** Every self-closing `<Control … />` tag, with its `paramId` when it has one. */
export function controlTags(src: string): { paramId: string | null; props: string; line: number }[] {
  const out: { paramId: string | null; props: string; line: number }[] = [];
  for (const m of src.matchAll(/<[A-Z][A-Za-z0-9]*\b([^>]*?)\/>/gs)) {
    const props = m[1] ?? '';
    out.push({
      paramId: /paramId="([^"]+)"/.exec(props)?.[1] ?? null,
      props,
      line: src.slice(0, m.index).split('\n').length,
    });
  }
  return out;
}

/** The card component basename a def resolves to (registry rule, not a guess). */
export function cardBasename(def: DefLike): string {
  return `${def.card ?? conventionalCardName(def.type)}.svelte`;
}

/**
 * Compare one card's control tags against its def. `read` returns the card
 * source or null when the card does not exist (the caller owns fs access so
 * this module stays importable from anywhere).
 */
export function scanCardDefDivergence(
  defs: readonly DefLike[],
  read: (basename: string) => string | null = () => null,
): Divergence[] {
  const out: Divergence[] = [];
  for (const def of defs) {
    const basename = cardBasename(def);
    const src = read(basename);
    if (src === null) continue;
    for (const t of controlTags(src)) {
      if (!t.paramId) continue;
      const p = def.params?.find((q) => q.id === t.paramId);
      if (!p) continue;
      const push = (field: AgreementField, card_: string | number, def_: string | number | undefined) =>
        out.push({ card: basename, line: t.line, type: def.type, paramId: t.paramId!, field, card_, def_ });

      for (const field of ['min', 'max', 'defaultValue'] as const) {
        const m = NUM_PROP(field).exec(t.props);
        if (!m) continue;
        const got = Number(m[1]);
        const want = p[field];
        if (want !== undefined && got !== want) push(field, got, want);
      }
      const curve = STR_PROP('curve').exec(t.props)?.[2];
      // An undeclared `curve` IS `linear` — that is what every primitive
      // defaults to — so a card typing `curve="linear"` against a silent def
      // agrees. Only a real mismatch counts.
      if (curve !== undefined && curve !== (p.curve ?? 'linear')) push('curve', curve, p.curve ?? 'linear');
      const units = STR_PROP('units').exec(t.props)?.[2];
      if (units !== undefined && p.units !== undefined && units !== p.units) push('units', units, p.units);
      const label = STR_PROP('label').exec(t.props)?.[2];
      if (label !== undefined && p.label !== undefined && label !== p.label) push('label', label, p.label);
    }
  }
  return out;
}

/** Controls a card renders with no LITERAL `paramId="…"`, so the textual
 *  comparison above cannot key on them. Reported, not ignored: an unmeasured
 *  control must not read as a clean one.
 *
 *  `props` comes back with each row so a caller can tell the two causes apart.
 *  They are NOT the same defect:
 *
 *   * `paramId={expr}` — a LOOP VARIABLE or a TEMPLATE id (`wsBand${b}-${f}`,
 *     `ch${ch}_volume`). The control names its param; `controlTags` just cannot
 *     resolve the name statically. Structurally uncheckable BY THIS GATE.
 *   * no `paramId` at all — POSITIONAL indexing (`def.params[3]`). The control
 *     does not name its param anywhere, which is the lazily-unlabelled case and
 *     is held at ZERO by the caller. */
export function uncheckableControls(
  defs: readonly DefLike[],
  read: (basename: string) => string | null,
): { card: string; line: number; props: string }[] {
  const out: { card: string; line: number; props: string }[] = [];
  for (const def of defs) {
    const basename = cardBasename(def);
    const src = read(basename);
    if (src === null) continue;
    for (const t of controlTags(src)) {
      // Only tags that carry a range prop AND a value/onchange are controls —
      // a `<Foo width={4} />` is layout, not a control.
      if (t.paramId) continue;
      const hasRangeish =
        /(?:^|[^A-Za-z0-9_])(?:[A-Za-z]*(?:Min|Max)|min|max|defaultValue)=\{/.test(t.props) &&
        /(?:^|[^A-Za-z0-9_])(?:onchange|value)=/.test(t.props);
      if (hasRangeish) out.push({ card: basename, line: t.line, props: t.props });
    }
  }
  return out;
}

/** True when a control declares its param through an EXPRESSION rather than a
 *  double-quoted literal — the structurally-uncheckable shape above. Exported
 *  so the gate and its negative control call the SAME predicate; a re-typed
 *  copy in a self-test is how this file's sibling guards went blind. */
export const namesParamByExpression = (props: string): boolean => /\bparamId=\{/.test(props);
