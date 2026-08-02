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
// PURE + browser-safe: no DOM, no registry, no fs. It reads only a passed def
// and a passed param-value reader.

import type {
  FaceReadout,
  FaceSidebarBlock,
  ModuleFace,
  ParamDef,
} from '$lib/graph/types';
import { formatParamNumber } from '$lib/ui/controls/param-format';
import { knobValueReadout } from '$lib/ui/controls/knob-vocabulary-model';
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
 * `face.title` / `face.hint` is a non-blank string, so a face that declares
 * nothing renders byte-identically to before this platform landed — which is
 * what keeps the ~19 existing dock baselines from moving for a feature they do
 * not use. Blank-but-present strings are treated as absent (an authoring typo
 * must not paint an empty 20px row).
 */
export function facePageHeader(def: FaceplateDefLike | undefined): FacePageHeader | null {
  const title = def?.face?.title?.trim() ?? '';
  const hint = def?.face?.hint?.trim() ?? '';
  if (!title && !hint) return null;
  return { title, hint };
}

// ── 2. THE HERO SLOT ────────────────────────────────────────────────────────

/** The resolved hero slot: the promoted cells (already REMOVED from the bands)
 *  plus its readouts. */
export interface HeroPlan {
  /** The big control, promoted out of its band. */
  control: FaceControl | null;
  /** The audition/action cell beside it, promoted out of its band. */
  action: FaceControl | null;
  /** Labelled values printed under the hero glyph. */
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
 * `control` and `action` naming the SAME key promotes it once — as the control
 * — and leaves `action` null, because promoting it twice would emit the cell
 * twice and break the very multiset this function exists to preserve.
 */
export function heroFacePlan(
  def: FaceplateDefLike | undefined,
  bands: readonly DockFaceBand[] | null,
): HeroFacePlan {
  if (!bands) return { hero: null, bands: [] };
  const decl = def?.face?.hero;
  if (!decl) return { hero: null, bands: [...bands] };

  const byKey = new Map(dockPlanControls(bands).map((c) => [c.key, c]));
  const control = decl.control ? (byKey.get(decl.control) ?? null) : null;
  const action =
    decl.action && decl.action !== decl.control ? (byKey.get(decl.action) ?? null) : null;

  const promoted = new Set<string>();
  if (control) promoted.add(control.key);
  if (action) promoted.add(action.key);

  const readouts = (decl.readouts ?? []).filter((r) => isUsableReadout(r));
  // A hero with NOTHING resolved paints nothing — no empty hero rail.
  if (!promoted.size && !readouts.length) return { hero: null, bands: [...bands] };

  return {
    hero: { control, action, readouts },
    bands: bands.map((b) => withoutKeys(b, promoted)),
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
    ...(after.hero?.control ? [after.hero.control.key] : []),
    ...(after.hero?.action ? [after.hero.action.key] : []),
  ];
  if (keysBefore.length !== keysAfter.length) return false;
  const a = [...keysBefore].sort();
  const b = [...keysAfter].sort();
  return a.every((k, i) => k === b[i]);
}

// ── 3. READOUTS ─────────────────────────────────────────────────────────────

/** A readout declaration is usable when it names EXACTLY ONE source. Both, or
 *  neither, is an authoring error — the lint fails it and the render skips it,
 *  so a typo never paints a caption over a blank. */
export function isUsableReadout(r: FaceReadout): boolean {
  const hasParam = typeof r.paramId === 'string' && r.paramId.length > 0;
  const hasText = typeof r.text === 'string' && r.text.length > 0;
  return hasParam !== hasText;
}

/**
 * The printed VALUE of a readout. A `text` readout prints its literal; a
 * `paramId` readout prints the param's value through the SAME ladder the dial
 * prints — `format` first, then `options`/`landmarks` names, then the numeric
 * ladder with units (`knobValueReadout`). One ladder is the whole point: a
 * faceplate whose hero readout says `50 Hz` while the knob under it says
 * `50.00` is two surfaces disagreeing about one number.
 *
 * An unresolvable paramId prints `'—'` rather than throwing or printing
 * `undefined`.
 */
export function readoutText(
  r: FaceReadout,
  params: readonly ParamDef[],
  read: (paramId: string) => number | undefined,
): string {
  if (r.text) return r.text;
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
 * that would render EMPTY (a `presets` block with no entries, a `signal-flow`
 * with no stages, a `readouts` whose every entry is malformed, a `custom` with
 * a blank panel id). An empty block is a labelled void — worse than no block —
 * and dropping it here means the shell never has to ask.
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
      case 'signal-flow':
        return b.stages.length > 0;
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

/** Does this def paint a dock sidebar? The ONE predicate both DockFullView's
 *  `.has-sidebar` grid class and the face-lint rules read, so the column and
 *  its contents can never disagree about whether it exists. */
export function hasDockSidebar(def: FaceplateDefLike | undefined): boolean {
  return sidebarPlan(def) !== null;
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
 * Which preset (if any) the module is currently sitting on: the FIRST entry
 * whose every declared param matches the live value. `null` when the patch has
 * been edited away from all of them, which is the honest answer — a preset list
 * that keeps a stale entry lit is lying about the module's state.
 *
 * FIRST rather than best-match: entries are an authored, ordered roster, and
 * two entries that both match are identical settings under two names, so the
 * earlier name wins deterministically instead of flickering.
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

/** Format a bare number for a sidebar row that has no ParamDef behind it —
 *  the same ladder every other surface uses (param-format), never a local
 *  `toFixed`. */
export function sidebarNumber(v: number, units = ''): string {
  return formatParamNumber(v, units);
}
