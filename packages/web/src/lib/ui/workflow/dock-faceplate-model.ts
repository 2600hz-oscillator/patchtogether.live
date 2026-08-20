// packages/web/src/lib/ui/workflow/dock-faceplate-model.ts
//
// PF-20 — the PURE model for the DOCK FACEPLATE's structure: the hero slot, the
// page header and the annotation layer.
//
// ⚠ THIS FILE USED TO OWN THREE MORE SECTIONS — readout text, the sidebar plan
// and the preset-selection arithmetic — and all three are DELETED, not moved.
// The owner ruled that the resting faceplate paints no derived-state text in
// any shape; `ModuleFaceHero` in graph/types.ts carries the rulings verbatim
// and `face-resting-text-source.test.ts` is the gate that keeps the shape out.
//
// WHY THIS FILE EXISTS. The shell could not render the mocked faceplate at all:
// it had no title, no hint, no hero and no per-band description, so
// every face built on it drifted from its mock in the SAME six ways. That was
// reported as per-card drift six times running; it was never per-card. The
// declaration surface is `ModuleFace` (types.ts); this is the arithmetic that
// turns a declaration into a layout, kept OUT of the .svelte file so the one
// genuinely dangerous operation in it — MOVING a control out of its band into
// the hero — is unit-testable without a browser.
//
// ⚠ THE DANGEROUS OPERATION, stated plainly. `face.hero.control` PROMOTES a
// key; it does not COPY it. faces-parity asserts exact multiset equality
// between the dock's `control-<paramId>` testids and the def's param ids, so a
// hero that duplicated its key would read as an unbacked extra control, and a
// hero that *dropped* one would read as a lost control. `heroFacePlan` is
// therefore total by construction and `heroFacePlanIsTotal` is asserted on
// EVERY faced module by module-face-lint — the same "the plan covers every
// control exactly once" guarantee `dockFacePlan` already carries, extended
// across the hero boundary.
//
// PURE + browser-safe: no DOM, no engine, no store, no fs. It reads only a
// passed def. It resolves NO registry — the one it used to resolve
// (`face-readout-values`) existed solely to print a readout's derived number,
// and both the registry and the readout are gone.

import type { ModuleFace, ParamDef } from '$lib/graph/types';
import {
  dockPlanControls,
  type DockFaceBand,
  type FaceControl,
  type FaceDefLike,
} from './curated-face';

/** The def shape this model reads — a superset of FaceDefLike with the full
 *  ParamDef list (readouts need `format`/`units`/`options` to print a value). */
export interface FaceplateDefLike extends FaceDefLike {
  face?: ModuleFace;
  params?: readonly ParamDef[];
}

// ── 1. THE PAGE HEADER ──────────────────────────────────────────────────────

/** The faceplate's title + hint rows, or `null` when the face declares
 *  neither (every un-migrated face today — the header simply does not paint). */
export interface FacePageHeader {
  title: string;
  hint: string;
}

/**
 * The page header for a face. Returns `null` unless at least one of
 * `face.title` / `face.hint` is a non-blank string AND `annotations` is on, so
 * a face that declares nothing renders byte-identically to before this platform
 * landed — which is what keeps the ~19 existing dock baselines from moving for a
 * feature they do not use. Blank-but-present strings are treated as absent (an
 * authoring typo must not paint an empty 20px row).
 *
 * ⚠ `annotations` GATES THE WHOLE HEADER — TITLE INCLUDED (owner, 2026-08-02):
 * "this text is still here, i said this is annotation mode text but otherwise
 * we don't want it. in all cases. no 'voice' etc section, no text on the
 * module… the name of the module as text is fine, it's the type/description
 * text that needs to go away."
 *
 * The first draft of this function exempted the title on the reasoning that it
 * is "a name, not a note". That reasoning was OVERRULED, and the distinction it
 * missed is worth stating so it is not re-derived: the module's NAME is already
 * painted, once, by the dock's TITLE BAR (`SHIMMERSHINE`, `KICKDRUM`) and that
 * is untouched. `face.title` is not that name — it is a CATEGORY WORD for the
 * page ("Voice", "halo"), which is description, and description is annotation.
 * Two names on one panel was the actual complaint.
 *
 * Default `false`, so the resting faceplate is the clean one: a caller that
 * forgets the flag under-paints rather than leaking prose onto every card.
 */
export function facePageHeader(
  def: FaceplateDefLike | undefined,
  annotations = false,
): FacePageHeader | null {
  if (!annotations) return null;
  const title = def?.face?.title?.trim() ?? '';
  const hint = def?.face?.hint?.trim() ?? '';
  if (!title && !hint) return null;
  return { title, hint };
}

// ── 1a. THE BAND HEADER ─────────────────────────────────────────────────────

/** What a band's header actually paints: its label, its hint, or neither.
 *  Blank means "do not emit the element" — never "emit an empty one". */
export interface BandHeaderPlan {
  label: string;
  hint: string;
}

/**
 * THE TWO SUPPRESSIONS ARE INDEPENDENT, and this function exists because the
 * markup asked them as ONE question and got the wrong answer for free.
 *
 * The shell used to gate the whole header on `{#if band.label && !dockTabs}`,
 * with the hint nested inside it. That reads as one rule and is two:
 *
 *   * THE LABEL is suppressed on a TABBED face because the rail already names
 *     the band, in the same words, ~14 px above it. Nothing to do with prose.
 *   * THE HINT is suppressed unless ANNOTATIONS are on, because it is a
 *     sentence about the band and that is what the switch reveals.
 *
 * Coupling them made the hint answer to `dockTabs`, so on a tabbed face it
 * could not paint even with annotations ON — the declaration was authored,
 * reviewed and rendered NOWHERE. That was latent only because
 * `module-face-lint` forbade declaring a hint on a tabbed face at all, which is
 * the lint standing in for a shell bug: an authoring rule invented to describe
 * a rendering defect. Both go together, and the lint's replacement asserts the
 * hint COUNT instead, so a tabbed adopter enrols itself.
 *
 * Pure and total: an absent field is `''`, whitespace is trimmed to `''`.
 */
export function bandHeaderPlan(
  band: { label?: string; hint?: string },
  opts: { tabbed: boolean; annotations: boolean },
): BandHeaderPlan {
  return {
    // the rail already says it
    label: opts.tabbed ? '' : (band.label?.trim() ?? ''),
    // answers to the switch, and to nothing else
    hint: opts.annotations ? (band.hint?.trim() ?? '') : '',
  };
}

// ── 1b. THE ANNOTATION LAYER ────────────────────────────────────────────────

/** Where one piece of annotation prose was declared. The KIND is carried rather
 *  than recovered by arithmetic downstream: `bandHints = total - pageHint` was
 *  the projection's old sum, and adding a third source to the total silently
 *  made it wrong by one. */
export type FaceAnnotationKind = 'title' | 'page-hint' | 'band-hint';

/** One declared annotation string, tagged with the field it came from. */
export interface FaceAnnotation {
  kind: FaceAnnotationKind;
  text: string;
}

/**
 * Every piece of ANNOTATION PROSE a face declares — the page-level `face.title`
 * and `face.hint`, then each page's `hint`, in declaration order, blanks
 * dropped.
 *
 * WHY THIS IS ONE FUNCTION AND NOT A `.filter` AT EACH CALL SITE. Three surfaces
 * need the same answer and they must not be able to disagree: ModuleShell
 * decides whether to PAINT each string, DockFullView decides whether the
 * faceplate offers the toggle AT ALL, and `module-specs` publishes the counts
 * the registry-driven e2e sweep asserts against the DOM. A toggle that reveals
 * nothing is exactly the "labelled void" the sidebar's empty-block drop already
 * refuses, and a face whose prose is unreachable because the toggle never
 * rendered is the mirror failure. All three read this list, so a FOURTH
 * annotation source added later is picked up by the affordance and by the sweep
 * the moment it is picked up by the render.
 *
 * ⚠ `title` IS IN THIS LIST as of the owner's 2026-08-02 direction (see
 * `facePageHeader`). That is not cosmetic bookkeeping: the title now paints
 * ONLY behind the toggle, so a face declaring a title and nothing else would —
 * had the roster not learned about it — get no toggle, and its title would be
 * authored, reviewed and unreachable in every state of the UI.
 *
 * ⚠ SCOPE, stated because an unstated scope reads as full coverage: this is the
 * DOCK FACEPLATE's prose only. It is not the module's authored living-docs
 * (`docs.explanation`, which the on-card AnnotateLayer hover popover resolves
 * through the same per-node annotate mode) — those two are separate content
 * behind ONE personal switch, which is the point.
 */
export function faceAnnotations(def: FaceplateDefLike | undefined): FaceAnnotation[] {
  const out: FaceAnnotation[] = [];
  const title = def?.face?.title?.trim() ?? '';
  if (title) out.push({ kind: 'title', text: title });
  const pageHint = def?.face?.hint?.trim() ?? '';
  if (pageHint) out.push({ kind: 'page-hint', text: pageHint });
  for (const p of def?.face?.pages ?? []) {
    const h = p.hint?.trim() ?? '';
    if (h) out.push({ kind: 'band-hint', text: h });
  }
  return out;
}

/** The prose strings alone, in the same order — the shape the emptiness check
 *  and the tests read. */
export function faceAnnotationProse(def: FaceplateDefLike | undefined): string[] {
  return faceAnnotations(def).map((a) => a.text);
}

/** How many annotations of each kind a face declares. The `module-specs`
 *  projection publishes this verbatim so the e2e sweep can assert a DOM count
 *  PER SURFACE (`.face-title`, `.face-hint`, `.page-hint`) rather than one
 *  aggregate that a miss in either direction can satisfy. */
export interface FaceAnnotationTally {
  title: number;
  pageHint: number;
  bandHints: number;
  total: number;
}

/** Count the declared annotations by kind. */
export function faceAnnotationTally(def: FaceplateDefLike | undefined): FaceAnnotationTally {
  const all = faceAnnotations(def);
  const n = (k: FaceAnnotationKind) => all.filter((a) => a.kind === k).length;
  return { title: n('title'), pageHint: n('page-hint'), bandHints: n('band-hint'), total: all.length };
}

/** Does this face have anything to say when annotations are turned ON? The
 *  gate on the dock's annotate toggle — no prose, no affordance. */
export function faceHasAnnotations(def: FaceplateDefLike | undefined): boolean {
  return faceAnnotationProse(def).length > 0;
}

// ── 2. THE HERO SLOT ────────────────────────────────────────────────────────

/** The resolved hero slot: the promoted cells, already REMOVED from the bands.
 *
 *  ⚠ THERE IS NO `readouts` MEMBER. The hero readout strip is deleted platform
 *  wide (owner, 2026-08-19 — see `ModuleFaceHero` in graph/types.ts); a hero is
 *  now exactly the module's picture, its big control and its audition, so a
 *  hero that resolves NO cell resolves to `null` and paints nothing. */
export interface HeroPlan {
  /** The module's own PICTURE (a PF-14 panel cell), promoted out of its band. */
  cell: FaceControl | null;
  /** The big control, promoted out of its band. */
  control: FaceControl | null;
  /** The audition/action cell beside it, promoted out of its band. */
  action: FaceControl | null;
}

/** `heroFacePlan`'s answer: the hero, and the bands with the promoted cells
 *  taken out. Together they are the SAME control multiset the input bands
 *  carried — see heroFacePlanIsTotal. */
export interface HeroFacePlan {
  hero: HeroPlan | null;
  bands: DockFaceBand[];
}

/** Pull `keys` out of one band (its flat controls AND its clusters), returning
 *  the reduced band. A cluster emptied by the pull is dropped: a sub-header
 *  over zero cells is a caption for nothing. */
function withoutKeys(band: DockFaceBand, keys: ReadonlySet<string>): DockFaceBand {
  if (!keys.size) return band;
  return {
    ...band,
    controls: band.controls.filter((c) => !keys.has(c.key)),
    clusters: band.clusters
      .map((cl) => ({ ...cl, controls: cl.controls.filter((c) => !keys.has(c.key)) }))
      .filter((cl) => cl.controls.length > 0),
  };
}

/**
 * Split a dock band plan into a HERO plus the remaining bands.
 *
 * A `face.hero` key that no band claims resolves to `null` rather than
 * throwing: the shell must keep rendering, and module-face-lint is what turns
 * the authoring mistake red (a stale hero key is exactly the orphan-rot the
 * face lint exists for). A hero key is looked up in the FLATTENED plan, so
 * promoting a control that lives inside a PF-9 cluster works too.
 *
 * TWO slots naming the SAME key promote it ONCE — the first of `cell`,
 * `control`, `action` to claim it wins and the others resolve null, because
 * promoting it twice would emit the cell twice and break the very multiset this
 * function exists to preserve.
 */
export function heroFacePlan(
  def: FaceplateDefLike | undefined,
  bands: readonly DockFaceBand[] | null,
): HeroFacePlan {
  if (!bands) return { hero: null, bands: [] };
  const decl = def?.face?.hero;
  if (!decl) return { hero: null, bands: [...bands] };

  const byKey = new Map(dockPlanControls(bands).map((c) => [c.key, c]));
  // ONE claim per key, in slot order. A `Set` of what has already been taken is
  // the whole guard: two slots naming one key is an authoring mistake the lint
  // reports, and the render must not turn it into a duplicated cell meanwhile.
  const promoted = new Set<string>();
  const claim = (key: string | undefined): FaceControl | null => {
    if (!key || promoted.has(key)) return null;
    const ctl = byKey.get(key);
    if (!ctl) return null;
    promoted.add(ctl.key);
    return ctl;
  };
  const cell = claim(decl.cell);
  const control = claim(decl.control);
  const action = claim(decl.action);

  // A hero with NOTHING resolved paints nothing — no empty hero rail.
  if (!promoted.size) return { hero: null, bands: [...bands] };

  return {
    hero: { cell, control, action },
    // ⚠ AND THE BAND ITSELF GOES when the promotion empties it. `withoutKeys`
    // already drops an emptied CLUSTER for exactly this reason — "a sub-header
    // over zero cells is a caption for nothing" — and then left the identical
    // defect one level up: promote a whole band's contents into the hero and
    // the face keeps a LABELLED VOID where they were, plus (on a tabbed face) a
    // tab that opens onto nothing. dx7 and mixer hit this independently while
    // drafting their heroes, which is what makes it a platform bug rather than
    // two authoring mistakes.
    //
    // SAFE FOR `heroFacePlanIsTotal` by construction: a band with no controls
    // and no clusters contributes zero keys to `dockPlanControls`, so removing
    // it cannot change the multiset the totality check compares. It is a no-op
    // on every face declared today (no current hero empties its band) — landed
    // now so the first face that needs it does not have to discover it.
    bands: bands
      .map((b) => withoutKeys(b, promoted))
      .filter((b) => b.controls.length > 0 || b.clusters.length > 0),
  };
}

/**
 * THE TOTALITY CHECK, and the reason the split lives in a pure module: does the
 * hero plan account for EXACTLY the controls the input plan carried — none
 * dropped, none duplicated?
 *
 * This is the unit-lane twin of faces-parity's DOM multiset assert. That e2e
 * can only see the failure after a browser boot on one module at a time; this
 * runs over every faced module in milliseconds, and it is what makes promoting
 * a control into the hero a safe edit rather than a gamble.
 */
export function heroFacePlanIsTotal(
  before: readonly DockFaceBand[] | null,
  after: HeroFacePlan,
): boolean {
  const keysBefore = dockPlanControls(before ?? []).map((c) => c.key);
  const keysAfter = [
    ...dockPlanControls(after.bands).map((c) => c.key),
    ...(after.hero?.cell ? [after.hero.cell.key] : []),
    ...(after.hero?.control ? [after.hero.control.key] : []),
    ...(after.hero?.action ? [after.hero.action.key] : []),
  ];
  if (keysBefore.length !== keysAfter.length) return false;
  const a = [...keysBefore].sort();
  const b = [...keysAfter].sort();
  return a.every((k, i) => k === b[i]);
}

