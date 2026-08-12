// packages/web/src/lib/ui/workflow/dock-faceplate-model.ts
//
// PF-20 — the PURE model for the DOCK FACEPLATE's structure: the hero slot, the
// page header, the sidebar blocks, and the preset selection arithmetic.
//
// WHY THIS FILE EXISTS. The shell could not render the mocked faceplate at all:
// it had no title, no hint, no hero, no sidebar and no per-band description, so
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
// passed def and a passed param-value reader. (It does resolve ONE registry —
// `face-readout-values` for a `valueId` readout — which is itself pure
// arithmetic over the same reader; see the note on `readoutText`.)

import type {
  FaceReadout,
  FaceSidebarBlock,
  ModuleFace,
  ParamDef,
} from '$lib/graph/types';
import { knobValueReadout } from '$lib/ui/controls/knob-vocabulary-model';
import { faceReadoutValueFor } from './face-readout-values';
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

/** The resolved hero slot: the promoted cells (already REMOVED from the bands)
 *  plus its readouts. */
export interface HeroPlan {
  /** The module's own PICTURE (a PF-14 panel cell), promoted out of its band. */
  cell: FaceControl | null;
  /** The big control, promoted out of its band. */
  control: FaceControl | null;
  /** The audition/action cell beside it, promoted out of its band. */
  action: FaceControl | null;
  /** Labelled values printed beside the hero picture. */
  readouts: readonly FaceReadout[];
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

  const readouts = (decl.readouts ?? []).filter((r) => isUsableReadout(r));
  // A hero with NOTHING resolved paints nothing — no empty hero rail.
  if (!promoted.size && !readouts.length) return { hero: null, bands: [...bands] };

  return {
    hero: { cell, control, action, readouts },
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

// ── 3. READOUTS ─────────────────────────────────────────────────────────────

/** A readout declaration is usable when it names EXACTLY ONE of its three
 *  sources (`paramId` / `valueId` / `text`). None, or more than one, is an
 *  authoring error — the lint fails it and the render skips it, so a typo never
 *  paints a caption over a blank. */
export function isUsableReadout(r: FaceReadout): boolean {
  let n = 0;
  if (typeof r.paramId === 'string' && r.paramId.length > 0) n++;
  if (typeof r.valueId === 'string' && r.valueId.length > 0) n++;
  if (typeof r.text === 'string' && r.text.length > 0) n++;
  return n === 1;
}

/**
 * The printed VALUE of a readout.
 *
 *   `text`    — its literal.
 *   `paramId` — the param's value through the SAME ladder the dial prints:
 *               `format` first, then `options`/`landmarks` names, then the
 *               numeric ladder with units (`knobValueReadout`). One ladder is
 *               the whole point — a faceplate whose hero readout says `50 Hz`
 *               while the knob under it says `50.00` is two surfaces
 *               disagreeing about one number.
 *   `valueId` — a DERIVED value from `face-readout-values`, computed from the
 *               live params by a registered pure function. For a quantity that
 *               is not any single knob (see the `FaceReadout` doc: printing the
 *               nearest knob is the blind-metric trap).
 *
 * An unresolvable source prints `'—'` rather than throwing or printing
 * `undefined` — the lint is where a stale id goes red, and a faceplate must
 * keep rendering meanwhile.
 */
export function readoutText(
  r: FaceReadout,
  params: readonly ParamDef[],
  read: (paramId: string) => number | undefined,
): string {
  if (r.text) return r.text;
  if (r.valueId) {
    const fn = faceReadoutValueFor(r.valueId);
    if (!fn) return '—';
    try {
      return fn(read);
    } catch {
      // TOTAL by contract, but a registered function is third-party code from
      // this file's point of view and it runs on every frame of a knob drag.
      return '—';
    }
  }
  if (!r.paramId) return '—';
  const pd = params.find((p) => p.id === r.paramId);
  const v = read(r.paramId);
  if (pd === undefined || v === undefined || !Number.isFinite(v)) return '—';
  return knobValueReadout(
    v,
    { options: pd.options, landmarks: pd.landmarks, format: pd.format },
    pd.units ?? '',
  );
}

// ── 4. THE SIDEBAR ──────────────────────────────────────────────────────────

/**
 * The sidebar blocks a face actually paints: declared blocks minus the ones
 * that would render EMPTY (a `presets` block with no entries, a `readouts`
 * whose every entry is malformed, a `custom` with a blank panel id). An empty
 * block is a labelled void — worse than no block — and dropping it here means
 * the shell never has to ask.
 *
 * Returns `null` (never `[]`) when nothing survives, because `null` is the
 * answer DockFullView branches on to decide whether the `.page` grid gets its
 * sidebar COLUMN at all. A face with no sidebar must keep the full-width
 * editor it has today.
 */
export function sidebarPlan(def: FaceplateDefLike | undefined): FaceSidebarBlock[] | null {
  const blocks = def?.face?.sidebar ?? [];
  const kept = blocks.filter((b) => {
    switch (b.kind) {
      case 'presets':
        return b.entries.length > 0;
      case 'readouts':
        return b.entries.some((r) => isUsableReadout(r));
      case 'custom':
        return b.panelId.trim().length > 0;
      default:
        return false;
    }
  });
  return kept.length ? kept : null;
}

// ── 5. PRESET SELECTION ─────────────────────────────────────────────────────

/**
 * The relative tolerance a saved param value may sit off a preset's value and
 * still count as "this preset is loaded".
 *
 * It is RELATIVE (scaled by the preset value's magnitude) because a preset
 * spans wildly different units in one entry — 50 Hz next to 0.42 mix next to
 * 480 ms. A single absolute epsilon is either far too coarse for the mix or far
 * too fine for the frequency, so it would report the wrong answer on one of
 * them whichever number you pick. The floor keeps a preset value of exactly 0
 * comparable.
 */
export const PRESET_MATCH_REL = 1e-3;
export const PRESET_MATCH_FLOOR = 1e-6;

/** Is `actual` close enough to `want` to read as the same setting? */
export function presetValueMatches(actual: number, want: number): boolean {
  if (!Number.isFinite(actual) || !Number.isFinite(want)) return false;
  const tol = Math.max(PRESET_MATCH_FLOOR, Math.abs(want) * PRESET_MATCH_REL);
  return Math.abs(actual - want) <= tol;
}

/**
 * Which preset the module's LIVE VALUES currently ARE: the FIRST entry whose
 * every declared param matches. `null` once anything has been edited away.
 *
 * FIRST rather than best-match: entries are an authored, ordered roster, and
 * two entries that both match are identical settings under two names, so the
 * earlier name wins deterministically instead of flickering.
 *
 * ⚠ THIS IS ONE OF TWO QUESTIONS, NOT THE WHOLE ANSWER — see `presetRowStates`.
 * On its own it un-lights the row the moment a knob moves, which throws away
 * where the sound came from.
 */
export function activePresetId(
  entries: readonly { id: string; values: Readonly<Record<string, number>> }[],
  read: (paramId: string) => number | undefined,
): string | null {
  for (const e of entries) {
    const pairs = Object.entries(e.values);
    if (!pairs.length) continue;
    let ok = true;
    for (const [pid, want] of pairs) {
      const got = read(pid);
      if (got === undefined || !presetValueMatches(got, want)) {
        ok = false;
        break;
      }
    }
    if (ok) return e.id;
  }
  return null;
}

/**
 * The param WRITES that applying a preset performs — a pure list, so the caller
 * runs them through the ordinary write path (`setNodeParam` / the PF-13
 * override) and a preset inherits undo, Y.Doc sync and MIDI parity for free.
 *
 * Values are CLAMPED to each param's declared range, and a key naming no
 * declared param is DROPPED. Both are load-bearing rather than defensive: a
 * preset is UI metadata that is not in the contract, so nothing stops a
 * contract edit from narrowing a range or deleting a param under it. Writing
 * out-of-range would let a decorative list push the model somewhere the def
 * forbids — the exact "the control lied about its own range" class CLAUDE.md
 * documents. (module-face-lint fails both cases loudly; this keeps the render
 * honest in the meantime.)
 */
export function presetWrites(
  values: Readonly<Record<string, number>>,
  params: readonly ParamDef[],
): { paramId: string; value: number }[] {
  const out: { paramId: string; value: number }[] = [];
  for (const [paramId, raw] of Object.entries(values)) {
    const pd = params.find((p) => p.id === paramId);
    if (!pd || !Number.isFinite(raw)) continue;
    out.push({ paramId, value: Math.max(pd.min, Math.min(pd.max, raw)) });
  }
  return out;
}

/** The right-aligned annotation a preset row prints. Declared `note` wins;
 *  otherwise nothing (a derived summary of 6 param values is noise, not a
 *  note). Exported so the row markup has no formatting logic of its own. */
export function presetNote(entry: { note?: string }): string {
  return entry.note?.trim() ?? '';
}

/**
 * The generic `node.data` key a sidebar `presets` block records its last RECALL
 * under. ONE key for every module — a preset roster is platform, so the state
 * behind it is platform too, and no module invents its own field name.
 */
export const FACE_PRESET_DATA_KEY = 'facePreset';

/** The preset a node last RECALLED, or null. Validated against the live roster,
 *  so a saved id whose entry a later build removed reads as "none" instead of
 *  lighting a row that no longer exists. */
export function recalledPresetId(
  entries: readonly { id: string }[],
  data: Record<string, unknown> | undefined,
): string | null {
  const v = data?.[FACE_PRESET_DATA_KEY];
  if (typeof v !== 'string') return null;
  return entries.some((e) => e.id === v) ? v : null;
}

/** How one preset row paints. */
export interface PresetRowState {
  id: string;
  /** Paint this row as the selected one. */
  lit: boolean;
  /** …and mark it MODIFIED: it is where the sound came from, but the values
   *  have since been edited away from it. */
  modified: boolean;
}

/**
 * THE PRESET ROW STATES — and this is a DESIGN DECISION with a stated reason,
 * because the two obvious answers are each wrong in one direction.
 *
 *   "un-light on the first knob move" — honest about the values, and it THROWS
 *   AWAY the single most useful thing the roster knows: which voice this sound
 *   started as. Nudging DRIVE by 0.01 erases the word `909 CLASSIC` from the
 *   panel, and nothing on the faceplate can tell you where you are any more.
 *
 *   "stay lit forever" — keeps the provenance and LIES about the state: the
 *   panel asserts a voice the patch is no longer set to, which is exactly the
 *   class of "a surface disagreeing with the model" this whole platform exists
 *   to end.
 *
 * So a row carries BOTH facts. `lit` says where the sound came from (the last
 * RECALL, or — with nothing recalled — an exact value match, so a patch that
 * loads sitting on a preset still shows it). `modified` says the values have
 * moved since. A recalled row that still matches exactly is lit and NOT
 * modified; edit one knob and it stays lit and gains the marker.
 *
 * Pure: the caller supplies the recalled id (off `node.data`) and the reader.
 */
export function presetRowStates(
  entries: readonly { id: string; values: Readonly<Record<string, number>> }[],
  recalled: string | null,
  read: (paramId: string) => number | undefined,
): PresetRowState[] {
  const matched = activePresetId(entries, read);
  return entries.map((e) => {
    const lit = recalled ? e.id === recalled : e.id === matched;
    return { id: e.id, lit, modified: lit && e.id !== matched };
  });
}
