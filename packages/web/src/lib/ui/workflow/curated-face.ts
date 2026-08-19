// packages/web/src/lib/ui/workflow/curated-face.ts
//
// The PURE top-N selector for the workflow-mode ModuleShell's semantic-zoom
// (STRATA) tiers. Given a module def's co-located `face` (see ModuleFace in
// $lib/graph/types) and a curation TIER, it resolves each ranked control key to
// a lightweight descriptor and returns the first N controls for that tier:
//
//   mini    → 1   (the hero control + live glyph)
//   compact → 2 with a glyph / 3 without  (the design-point lane tile — the
//                 cap RECONCILED with laneBodyPlan's fit, see faceTierCap)
//   full    → 6   (the full-in-lane 3×2 plate — likewise reconciled)
//   dock    → ALL (the sectioned dock faceplate — order + pages)
//
// PURE + browser-safe (no fs, no registry import): it reads ONLY the passed
// `def` (its `face`, `params`, `controlFamilies`), so it is trivially
// unit-testable and zero-flake. Key resolution uses the SAME unified
// control-key space the docs system defines (control-doc-resolver.ts):
//   - a ParamDef.id                      → kind 'param'
//   - a control-family template `<f>-{n}` → kind 'family' (whole grid/cluster)
//   - anything else (a static button/select) → kind 'static'
// A 'static' key can only be VALIDATED against the numbered legend (an fs read)
// — that is the lint gate's job (module-face-lint.test.ts). The selector treats
// an unrecognized key as a humanized static control so it stays pure.

import { paintsReadout } from '$lib/ui/controls/knob-vocabulary-model';
import type { ModuleFace, ModuleFacePage, ParamLandmark, ParamOption } from '$lib/graph/types';
import {
  LANE_CELL_H,
  LANE_KNOB_READOUT_H,
  LANE_ROW_MAX_CELLS,
  LANE_ROW_MAX_CELLS_WITH_GLYPH,
  PLATE_COLS,
  PLATE_MAX_ROWS,
  PLATE_ROW_H,
  laneBodyPlan,
  laneGlyphFor,
  type LaneGlyph,
} from './module-shell-model';

/** The curation LADDER — the tiers a face is sliced into. Distinct from the
 *  LOD zoom tiers (mini/compact/full/native in lod.ts): 'dock' is the sectioned
 *  full faceplate (view = 'dock-full'), which renders ALL controls + pages. The
 *  LOD 'native' tier maps to 'full' or 'dock' at the call site (a P1 concern). */
export type FaceTier = 'mini' | 'compact' | 'full' | 'dock';

/**
 * The 'full' (full-in-lane) ceiling: laneBodyPlan's PLATE grid is 3 columns ×
 * 2 whole rows inside the fixed 192×180 tile, so SIX cells is every control the
 * lane can ever paint at this tier. Ranks 7+ are DOCK-ONLY — which is a design
 * fact every face author needs while ranking, not a truncation to discover
 * afterwards.
 */
export const LANE_PLATE_MAX_CELLS = PLATE_COLS * PLATE_MAX_ROWS;

/**
 * How many controls each tier surfaces. `dock` = every ranked control.
 *
 * BOTH lane tiers are decided by GEOMETRY, not by an authored ladder — the tile
 * is a fixed 192×180 box, so its whole-cell fit is a design-time constant:
 *   compact → three md knob columns, or TWO plus the glyph
 *             (laneBodyPlan's LANE_ROW_MAX_CELLS / LANE_ROW_MAX_CELLS_WITH_GLYPH);
 *   full    → the 3×2 plate grid = SIX cells (LANE_PLATE_MAX_CELLS).
 * Use `faceTierCap(tier, laneGlyphFor(def))` — never a raw FACE_TIER_CAPS
 * lookup, and never a hand-rolled glyph predicate (#1785) — so
 * the SELECTED count and the RENDERED count are the same number by
 * construction (the authored-intent mismatch this reconciles: faces documented
 * a 3-control compact tile the shell truncated to 2, and an 8-control full face
 * the plate truncated to 6 — both silently).
 */
export const FACE_TIER_CAPS: Record<FaceTier, number> = {
  mini: 1,
  compact: LANE_ROW_MAX_CELLS,
  full: LANE_PLATE_MAX_CELLS,
  dock: Infinity,
};

/**
 * PF-22 — `face.order` MINUS the keys that can never paint in a lane.
 *
 * Today that is exactly one key: `face.hero.cell`, the module's own PICTURE.
 * Everything under `face.hero` is DOCK-ONLY by construction (see ModuleFace:
 * "ALL FOUR ARE DOCK-ONLY"), and `module-face-lint` already proves `hero.cell`
 * resolves to a PF-14 **panel** shell cell — a hand-written component that
 * declares its own `minWidth`, 280–560 px measured. A 46 px `--kcol-max` lane
 * knob column cannot hold one.
 *
 * ⚠ WHY THIS FUNCTION EXISTS AT ALL, because the bug it fixes is invisible and
 * expensive. `face.order` is documented as "the priority RANKING — earliest =
 * highest priority", and it was ALSO the lane budget selector. One list, two
 * jobs. A panel selected at a lane tier fails the lint, the 'full' lane cap is
 * SIX, and therefore **a panel's first legal rank was 7** — a floor a module
 * with fewer than six other rankable keys can never reach. That is not a
 * theoretical limit; it is a live design distortion, in three shapes:
 *
 *   bluebox      ranks its hero picture THIRTEENTH — dead last, behind all
 *                twelve keypad buttons — and says so in a comment. The face
 *                that declares that cell as its HERO also declares it the
 *                lowest-priority control on the module. Both statements are in
 *                the same object.
 *   meowbox      (four params + one audition) could not reach rank 7, so its
 *                formant bank became a `custom` SIDEBAR block instead — a
 *                different mechanism, chosen for arithmetic rather than design.
 *   drummergirl  (five params) deferred its picture entirely.
 *
 * And two modules cannot have a faceplate AT ALL: `kria` (two params + one
 * step-grid family = three rankable keys) and `macseq` (five + two = seven,
 * with a family landing on rank 6). Their grid is the module.
 *
 * The fix is NOT to widen a constant — the 46 px column is real and the lint's
 * own comment is right that delegating to `PLATE_COLS * PLATE_MAX_ROWS = 6`
 * would be a coincidence of the current numbers. The fix is that a DOCK-ONLY
 * key should not consume a LANE rank in the first place. Ranking becomes what
 * it says it is, the panel still cannot reach a knob column, and the protection
 * is unchanged.
 *
 * ⚠ NOTHING THAT RENDERS TODAY MOVES. Every shipped `hero.cell` already ranks
 * at 7 or later — it had to, or it would be failing the lint — and dropping an
 * item at index ≥6 cannot change the first six. `curated-face.test.ts` asserts
 * that as a property over the live registry rather than leaving it as a claim,
 * so the day a face ranks its hero picture FIRST the assertion is what tells
 * you the lane content legitimately changed.
 *
 * DOCK IS UNTOUCHED: the dock renders the hero, so this is only ever applied to
 * a lane tier. Pure.
 */
export function laneOrder(face: ModuleFace): readonly string[] {
  const dockOnly = new Set<string>();
  if (face.hero?.cell) dockOnly.add(face.hero.cell);
  // A declared 2-D pad is dock-only for the same MEASURED reason a panel is: it
  // is square, and a lane knob column is 46 px (`--kcol-max`). Squeezing it to
  // 46×46 would keep the gesture and lose the precision; splitting it into two
  // dials would keep the precision and lose the gesture, which is the exact
  // downgrade the kind exists to end. So the lane simply shows the next
  // controls — and because the pad costs no rank, it may rank FIRST.
  for (const pad of face.xyPads ?? []) dockOnly.add(pad.x);
  if (!dockOnly.size) return face.order;
  return face.order.filter((k) => !dockOnly.has(k));
}

/**
 * `face.order` with each pad's PARTNER axis folded away — the roster EVERY tier
 * reads, dock included.
 *
 * A pad is one cell over two params. Its `y` key stays in `face.order` (that is
 * what proves no control was dropped, and it is what the docs + rear card key
 * off) but it must not also render a cell of its own, or the dock paints the
 * partner twice: once inside the pad and once as a stray dial beside it —
 * which would ALSO break faces-parity's exact `control-*` multiset, since the
 * pad already emits the partner's testid. Pure.
 */
export function foldedOrder(face: ModuleFace): readonly string[] {
  const pads = face.xyPads ?? [];
  if (!pads.length) return face.order;
  const partners = new Set(pads.map((p) => p.y));
  return face.order.filter((k) => !partners.has(k));
}

/**
 * Does this param paint a readout line under its dial?
 *
 * ⚠ IT CALLS THE RENDERER'S OWN PREDICATE — it does not mirror it. This used to
 * be a re-typed copy of `knobReadout`'s condition with a comment claiming the
 * HEIGHT here and the RENDER there "answer one question once", and the moment
 * the render gate changed (a declared numeric `format` stopped painting, owner
 * 2026-08-17) the copy went on reserving `LANE_KNOB_READOUT_H` for a line
 * nothing draws — 15 px of blank per cell on adsr, delay, kickdrum, ringback,
 * vca and sidecar, i.e. exactly the useless space the same review was about.
 * Importing the predicate is what makes the claim true instead of aspirational.
 */
function earnsReadout(p: FaceParamLike): boolean {
  return paintsReadout(p);
}

/**
 * The height of EVERY lane cell a face paints, in CSS px, in rank order — what
 * the plate's per-ROW track geometry is computed from.
 *
 * ⚠ A LIST, NOT A MAX, AND THAT IS THE WHOLE FIX. This used to return the
 * tallest cell on the face, which forced `grid-auto-rows` to that height for
 * every row and then made `plateRowsFor` divide the body by it. Two faces with
 * one 57 px cell each got the same punishment whether that cell sat in row 1
 * (where it can paint over the row below) or row 2 (where nothing is beneath
 * it). Measured over the live roster: 4 of the 11 readout-bearing faces —
 * cofefve, filter, resofilter, tidyVco — are in the second group and lose
 * nothing under a per-row rule.
 *
 * TWO ways a cell outgrows the 42 px design row, and they differ in KIND:
 *
 *   1. A DECLARED tall cell — `fader` (#1464), 96 px. Nothing in a ParamDef
 *      implies it, so it can only arrive through `face.paramCells`.
 *      `curated-face.test.ts` asserts EVERY kind in `LANE_CELL_H` taller than
 *      `PLATE_ROW_H` is declarable, so an inferred kind that grows tall fails
 *      there rather than silently reading as short here.
 *   2. An EARNED READOUT — `LANE_KNOB_READOUT_H`. NOT declarable and NOT a
 *      property of the cell kind: any param declaring `options` / `landmarks` /
 *      `format` makes its 'knob' cell 15 px taller, so one kind is two heights
 *      in one plate. That is why this needs the DEF's params and not only the
 *      face. Still pure — it reads declarations, never a registry.
 *
 * Scanned over the ranked prefix that can REACH the lane, not the whole order —
 * a fader parked at rank 9 is dock-only and must not shrink the lane plate.
 * `laneOrder` for the same reason one step further out: a hero picture never
 * reaches the lane either, so it must not displace a cell that does.
 *
 * ⚠ `foldedOrder` ON TOP OF `laneOrder`, AND THE OMISSION WAS A LATENT BUG.
 * This used to call `laneOrder` alone, which is a THIRD answer to "which keys
 * reach the lane" beside `curatedFace`'s — and `curatedFace` composes BOTH
 * (`foldedOrder({...face, order: laneOrder(face)})`). A pad's PARTNER axis
 * renders no cell of its own by `foldedOrder`'s own contract, so reserving a
 * cell height for it was never right; the paragraph above already said this
 * function is scanned over "the ranked prefix that can REACH the lane", and a
 * folded partner cannot.
 *
 * It went unnoticed because the TIER CAP masked it: the discrepancy is one
 * entry per declared pad, and on a face with enough controls the `slice` and
 * the per-tier cap take the same prefix either way. Measured over the live
 * registry at the time of the fix: `backdraft` is the only shipped pad-bearing
 * face, its partners (`camTiltY`, `camPosY`) rank outside the first six, and
 * its height list is byte-identical before and after — so this moves no pixel
 * on anything that ships today. It is `joystick` (a pad and nothing else) that
 * unmasks it, because there the cap cannot hide a one-entry difference from
 * ZERO, and `module-face-lint`'s cap-vs-fit-plan gate says so by name.
 */
export function faceLaneCellHeights(def: FaceDefLike): number[] {
  const face = def.face;
  if (!face) return [];
  const declared = face.paramCells ?? {};
  const momentary = new Set(face.momentary ?? []);
  const byId = new Map((def.params ?? []).map((p) => [p.id, p]));
  return foldedOrder({ ...face, order: laneOrder(face) })
    .slice(0, LANE_PLATE_MAX_CELLS)
    .map((key) => {
      const kind = declared[key as keyof typeof declared];
      // A DECLARED cell is that primitive, not a dial — it paints no readout.
      if (kind) return LANE_CELL_H[kind];
      // A press-pad is a <Button>, not a KnobConic. Everything else a PARAM key
      // resolves to in the LANE is a dial (`paramCellKind` returns 'knob' at
      // every non-dock tier, an `options` roster included), so the vocabulary
      // gate is the whole question. Over-reserving on a shape this misses costs
      // airiness; under-reserving is the overlap — which is why `momentary` is
      // the ONLY exclusion taken.
      if (momentary.has(key)) return PLATE_ROW_H;
      const p = byId.get(key);
      return p && earnsReadout(p) ? LANE_KNOB_READOUT_H : PLATE_ROW_H;
    });
}

/**
 * The EFFECTIVE cap for a tier — the ladder, reconciled with the lane fit plan.
 * At 'compact' a glyph-bearing face surfaces two cells (the glyph takes the
 * third column's room) and a glyph-less face three; at 'full' the plate holds
 * six DESIGN cells (ranked controls outrank a `'trace'` glyph, which simply
 * drops when the cells need both rows) — fewer when the face's own cells are
 * too tall for two rows, e.g. a face of 96 px faders, which leaves room for one
 * plate row. A `'picture'` glyph INVERTS that precedence (#1785): it is
 * reserved first and the cells take what is left.
 *
 * ⚠ THE CAP IS THE PLAN'S OWN ANSWER, not a parallel derivation. It hands
 * `laneBodyPlan` the SAME per-cell heights the shell will render, so "selected"
 * and "rendered" cannot drift BY CONSTRUCTION rather than by a test noticing.
 * They previously drifted twice (compact promised 3 and painted 2; full
 * promised 8 and painted 6), and the marbles overlap would have made it three:
 * the cap would have kept saying 6 while the tile could only hold 3.
 *
 * ⚠ IT TAKES THE HEIGHT LIST. The old signature asked "what would you render
 * given unlimited controls, if every cell were this tall?" — which only worked
 * while every cell WAS the same height. With per-row tracks the answer depends
 * on WHICH rows the tall cells are in, so the real question can only be asked
 * of a real list; `faceLaneCellHeights` is already capped at the six a plate
 * can ever hold. A bare number is still accepted and still means "every
 * lane-reachable cell is this tall", exactly as before.
 * Pure.
 */
export function faceTierCap(
  tier: FaceTier,
  glyph: LaneGlyph,
  cells: number | readonly number[] = PLATE_ROW_H,
): number {
  if (tier === 'dock') return FACE_TIER_CAPS.dock;
  const plan =
    typeof cells === 'number'
      ? laneBodyPlan(LANE_PLATE_MAX_CELLS, glyph, tier, cells)
      : laneBodyPlan(cells, glyph, tier);
  return plan.cellCount;
}

export type FaceControlKind = 'param' | 'family' | 'static';

/** A resolved control from `face.order` — enough for the shell to pick a
 *  primitive (param → Knob/Fader, family → grid/cluster, static → select/
 *  button) and label it, WITHOUT the selector needing the live registry. */
export interface FaceControl {
  /** The raw `face.order` key this descriptor came from. */
  key: string;
  kind: FaceControlKind;
  /** Present iff kind === 'param' — the ParamDef id to bind. */
  paramId?: string;
  /** Present iff kind === 'family' — the declared ControlFamily id. */
  familyId?: string;
  /** Friendly display name (ParamDef.label / humanized family or static key). */
  label: string;
  /**
   * Present iff this cell is a declared 2-D PAD (`face.xyPads`) — the PARTNER
   * axis's ParamDef id, i.e. the second param this ONE cell binds.
   *
   * ⚠ IT EXISTS BECAUSE `xy` IS THE ONLY CELL KIND WITH ARITY 2, and every
   * coverage rule in the repo counts params per CELL. Without it a pad's `y`
   * axis is invisible to the dock render-plan parity gate — the gate that
   * exists to prove no control silently fails to reach the user — so the two
   * available authorings were BOTH red and neither was wrong:
   *
   *   `y` listed in the page  → the page resolves it to its OWN cell, so the
   *                             dock paints a stray dial beside the pad that
   *                             already contains it (faces-parity: two unbacked
   *                             extras in the control multiset);
   *   `y` omitted from the page → the plan sees it ZERO times and parity calls
   *                             it a dropped control.
   *
   * Found by `backdraft`, the first `face.xyPads` adopter in the repo: the kind
   * shipped one PR ahead of any consumer, and the FOLD half never landed. The
   * pure gate and the DOM gate disagreed, which is exactly the signature of a
   * model that is blind to something the renderer does.
   */
  padPartnerParamId?: string;
}

/** A resolved cluster sub-header inside a page/band (the front-side mirror of
 *  RearCluster): a label + the cells PULLED OUT of the band's flat row. */
export interface FaceCluster {
  label: string;
  controls: FaceControl[];
}

/** One resolved dock page — its control keys turned into descriptors.
 *  `controls` holds the UN-clustered cells (they render first); `clusters`
 *  holds the labeled sub-groups, in declaration order. Together they are the
 *  page's full membership, exactly once each. */
export interface ResolvedFacePage {
  id: string;
  label: string;
  /** PF-20 — the band header's description line (`ModuleFacePage.hint`), '' when
   *  the page declares none. */
  hint: string;
  controls: FaceControl[];
  clusters: FaceCluster[];
  /** `ModuleFacePage.clusterFlow`, resolved — 'stack' when the page declares
   *  none, so every existing band keeps exactly the layout it had. */
  clusterFlow: 'stack' | 'row';
}

/** The selector's result. `pages` is present only for the 'dock' tier (and only
 *  when the face declares pages). `glyph` is resolved to a concrete value
 *  ('none' when unset). */
export interface CuratedFace {
  tier: FaceTier;
  /** Top-N resolved controls in priority order (all of them for 'dock'). */
  controls: FaceControl[];
  glyph: NonNullable<ModuleFace['glyph']>;
  pages?: ResolvedFacePage[];
  /**
   * The height of every LANE CELL this face paints (CSS px, rank order) —
   * `faceLaneCellHeights`. Carried on the result so the SHELL and the CAP read
   * the same list from the same call instead of each re-deriving it; a second
   * derivation is how the planner and the renderer disagreed in the first place.
   */
  cellHeights: number[];
}

/** Minimal def shape the selector reads — works for AudioModuleDef,
 *  VideoModuleDef, or a hand-built test fixture. */
/**
 * The param fields the selector reads. `options` / `landmarks` / `format` are
 * here for ONE reason and it is geometric: they are `knobReadout`'s gate, so
 * they decide whether a lane knob cell is 42 px or 57 — see
 * `faceLaneCellHeights`. Everything else about them is the renderer's business.
 */
export interface FaceParamLike {
  id: string;
  label?: string;
  options?: readonly ParamOption[];
  landmarks?: readonly ParamLandmark[];
  format?: (v: number) => string;
}

export interface FaceDefLike {
  face?: ModuleFace;
  params?: readonly FaceParamLike[];
  controlFamilies?: readonly { id: string; label?: string }[];
  /**
   * The def's signal DOMAIN — read for exactly one reason, and it is the same
   * geometric one the param fields above are here for: `domain === 'video'`
   * means the tile's glyph slot holds the module's LIVE PICTURE rather than a
   * decorative trace, and a picture OUTRANKS ranked cells in the lane fit plan
   * (#1785, `laneGlyphFor`). Without it the selector sized every video face as
   * though it had no glyph at all while the shell rendered one — two answers to
   * one question, and a promoted video module lost its rack thumbnail between
   * them.
   */
  domain?: string;
}

const FAMILY_TEMPLATE = /^(.+)-\{n\}$/;

/** Humanize a raw key into a display label: `sub_decay` → 'Sub decay',
 *  `filter-type` → 'Filter type'. */
function humanize(key: string): string {
  const pretty = key.replace(/[-_]/g, ' ').trim();
  return pretty.charAt(0).toUpperCase() + pretty.slice(1);
}

/** Resolve ONE face key to a control descriptor using only the def's params +
 *  declared families (pure). A `<prefix>-{n}` template whose prefix is a
 *  declared family → 'family'; an exact param-id match → 'param'; anything else
 *  → 'static' (a card-only button/select — validated against the legend by the
 *  lint gate, not here). */
export function resolveFaceControl(key: string, def: FaceDefLike): FaceControl {
  const params = def.params ?? [];
  const families = def.controlFamilies ?? [];

  const fam = key.match(FAMILY_TEMPLATE);
  if (fam) {
    // The DECLARED family label is the authored name ('Preset / voice
    // selector'); humanizing the id would print the raw key back at the user
    // ('Dx7 preset select'). Fall back to humanize only for a family with no
    // label (the type makes it optional for hand-built fixtures).
    const declared = families.find((f) => f.id === fam[1]);
    if (declared) {
      return {
        key,
        kind: 'family',
        familyId: fam[1],
        label: declared.label?.trim() || humanize(fam[1]),
      };
    }
  }
  const param = params.find((p) => p.id === key);
  if (param) {
    const ctl: FaceControl = { key, kind: 'param', paramId: key, label: param.label || humanize(key) };
    // A declared pad ANCHORS at its `x` key and binds `y` in the SAME cell.
    // Recorded here so every coverage consumer credits both axes to one cell
    // instead of losing the partner (see `padPartnerParamId`).
    const pad = (def.face?.xyPads ?? []).find((p) => p.x === key);
    if (pad) ctl.padPartnerParamId = pad.y;
    return ctl;
  }
  return { key, kind: 'static', label: humanize(key) };
}

/**
 * Resolve one page, PULLING its declared clusters out of the flat control row
 * — the exact shape rearFieldPlan uses for `face.rear.clusters` (band.holes
 * keeps the un-clustered holes; band.clusters carries the rest). Membership
 * comes from `page.controls` alone, so a cluster naming a key the page does not
 * claim contributes NOTHING (it cannot smuggle an unranked control into the
 * dock); module-face-lint fails that authoring mistake loudly.
 */
function resolvePage(page: ModuleFacePage, def: FaceDefLike): ResolvedFacePage {
  // ⚠ THE FOLD APPLIES HERE TOO, and it did not used to. `curatedFace` folds
  // pad partners out of `order` (`foldedOrder`) but pages were resolved from
  // the RAW `page.controls`, so a face that listed both axes — which the xyPads
  // lint REQUIRES in `face.order`, and which reads natural to write in a page —
  // painted the partner twice: once inside the pad, once as a stray dial. One
  // fold seam, applied at every place a control roster is resolved.
  const partners = new Set((def.face?.xyPads ?? []).map((p) => p.y));
  const all = page.controls
    .filter((k) => !partners.has(k))
    .map((k) => resolveFaceControl(k, def));
  const hint = page.hint?.trim() ?? '';
  const declared = page.clusters ?? [];
  const clusterFlow = page.clusterFlow ?? 'stack';
  if (!declared.length) {
    return { id: page.id, label: page.label, hint, controls: all, clusters: [], clusterFlow };
  }
  const byKey = new Map(all.map((c) => [c.key, c]));
  const claimed = new Set<string>();
  const clusters: FaceCluster[] = [];
  for (const c of declared) {
    const controls: FaceControl[] = [];
    for (const key of c.controls) {
      const ctl = byKey.get(key);
      // Not on this page, or already claimed by an earlier cluster → skip.
      // Exactly-once is the invariant the dock parity gate reads.
      if (!ctl || claimed.has(key)) continue;
      claimed.add(key);
      controls.push(ctl);
    }
    if (controls.length) clusters.push({ label: c.label, controls });
  }
  return {
    id: page.id,
    label: page.label,
    hint,
    controls: all.filter((c) => !claimed.has(c.key)),
    clusters,
    clusterFlow,
  };
}

/**
 * The curated face for a module at a given tier. Returns `null` for an
 * un-faced module (no `face`) — the caller reads that as "un-migrated" and
 * renders the legacy-fallback placeholder. Otherwise returns the top-N resolved
 * controls (all for 'dock'), the resolved glyph, and — for the 'dock' tier —
 * the resolved pages when the face declares them.
 */
export function curatedFace(def: FaceDefLike, tier: FaceTier): CuratedFace | null {
  const face = def.face;
  if (!face) return null;

  const glyph = face.glyph ?? 'none';
  const cellHeights = faceLaneCellHeights(def);
  // ⚠ `laneGlyphFor(def)`, NOT `glyph !== 'none'` (#1785). The declared glyph
  // is only half the question: a VIDEO-domain def paints a live picture in the
  // same slot while declaring `glyph: 'none'` (it must — a trace on a def with
  // no audio output is a dead glyph the face lint refuses). Asking the declared
  // half alone sized every video face as glyph-LESS while the shell rendered it
  // glyph-BEARING, so `curatedFace` selected three compact cells and the tile
  // painted two. `laneGlyphFor` is the one derivation the shell reads too.
  const cap = faceTierCap(tier, laneGlyphFor(def), cellHeights);
  // PF-22 — the DOCK renders the hero picture, so it keeps the whole order; a
  // LANE cannot paint a 280px panel in a 46px column, so the picture does not
  // consume a lane rank. See `laneOrder`. `foldedOrder` applies at EVERY tier:
  // a pad's partner axis is inside the pad, never a cell of its own.
  const order = foldedOrder({
    ...face,
    order: tier === 'dock' ? face.order : laneOrder(face),
  });
  const ranked = order.map((k) => resolveFaceControl(k, def));
  const controls = Number.isFinite(cap) ? ranked.slice(0, cap) : ranked;

  const out: CuratedFace = {
    tier,
    controls,
    glyph,
    cellHeights,
  };
  if (tier === 'dock' && face.pages && face.pages.length) {
    out.pages = face.pages.map((p) => resolvePage(p, def));
  }
  return out;
}

// ── The DOCK RENDER PLAN — the "dock shows ALL" seam, made pure ─────────────
//
// ModuleShell's dock full-view renders EXACTLY this plan (one labeled section
// band per declared page + the defensive '__unpaged' tail band for any ranked
// control no page claimed; a page-less face renders one unlabeled '__all'
// band). Extracting the derivation makes the CONTROL-LOSS guarantee unit-
// testable WITHOUT a browser: the render-parity gate asserts the flattened
// plan covers every param + declared control family EXACTLY once (the tidyVco
// tune/fine loss class — a control that exists in the schema but silently
// never renders). The e2e faces-parity spec is the authoritative DOM-level
// twin of this seam.

/** The '__unpaged' defensive tail band id + the page-less '__all' band id. */
export const DOCK_UNPAGED_BAND_ID = '__unpaged';
export const DOCK_ALL_BAND_ID = '__all';

/** One dock section band: a declared face page, the '__unpaged' tail, or the
 *  page-less '__all' roster. `label` may be '' (rendered without a header).
 *  `controls` = the un-clustered cells (rendered first); `clusters` = the
 *  labeled sub-groups (ModuleFacePage.clusters). A consumer that walks the plan
 *  MUST read both — `dockPlanControls()` does it for you. */
export interface DockFaceBand {
  id: string;
  label: string;
  /** PF-20 — the band header's description line, '' when none is declared. */
  hint: string;
  controls: FaceControl[];
  clusters: FaceCluster[];
  /** How the band's clusters flow — 'stack' (one per row, the default and the
   *  only behaviour before `ModuleFacePage.clusterFlow` existed) or 'row'
   *  (side by side, wrapping). A 'row' band is never a CONSOLE GRID: a shared
   *  column ruler and a side-by-side flow are contradictory requests. */
  clusterFlow: 'stack' | 'row';
}

/** EVERY cell a dock plan paints, band order, un-clustered before clustered.
 *  The one flattening the parity gates + the shell-cell coverage gate use, so a
 *  control moved into a cluster can never read as "dropped from the dock". */
export function dockPlanControls(bands: readonly DockFaceBand[]): FaceControl[] {
  return bands.flatMap((b) => [...b.controls, ...b.clusters.flatMap((c) => c.controls)]);
}

/**
 * The dock full-view SECTION-BAND plan for a module face — the exact bands
 * ModuleShell renders at view='dock-full'. Returns `null` for an un-faced def
 * (the caller falls back to the legacy card). INVARIANT (gated by
 * module-face-lint's render-parity test): the flattened plan contains every
 * `face.order` key exactly once — pages claim their keys, the tail sweeps the
 * rest, so nothing ranked can silently drop out of the dock.
 */
export function dockFacePlan(def: FaceDefLike): DockFaceBand[] | null {
  const dock = curatedFace(def, 'dock');
  if (!dock) return null;

  const pages = dock.pages ?? [];
  if (!pages.length) {
    return [
      {
        id: DOCK_ALL_BAND_ID,
        label: '',
        hint: '',
        controls: dock.controls,
        clusters: [],
        clusterFlow: 'stack',
      },
    ];
  }

  const bands: DockFaceBand[] = pages.map((p) => ({
    id: p.id,
    label: p.label,
    hint: p.hint,
    controls: p.controls,
    clusters: p.clusters,
    clusterFlow: p.clusterFlow,
  }));
  // A clustered cell is still CLAIMED by its page — the tail must sweep only
  // what no page mentions at all, never a cell a cluster pulled aside.
  const claimed = new Set(
    pages.flatMap((p) => [...p.controls, ...p.clusters.flatMap((c) => c.controls)]).map((c) => c.key),
  );
  const unpaged = dock.controls.filter((c) => !claimed.has(c.key));
  if (unpaged.length) {
    bands.push({
      id: DOCK_UNPAGED_BAND_ID,
      label: 'more',
      hint: '',
      controls: unpaged,
      clusters: [],
      clusterFlow: 'stack',
    });
  }
  return bands;
}
