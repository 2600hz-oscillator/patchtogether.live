// packages/web/src/lib/ui/workflow/band-focus-model.ts
//
// BAND FOCUS — a param VALUE decides which control bands a faceplate shows.
//
// ── What it is for ─────────────────────────────────────────────────────────
// Owner ruling, 2026-08-20, on `colourofmagic`: *"we can rgb by default and only
// show rgb controls (incluing the color pickers, for RGB only, the other types
// are not like that). if i select passthrough manually that's the only time i
// see all controls."*
//
// The module runs FIVE colorspace blocks in parallel and its `preview` param
// chooses which of 22 outputs you are looking at. Showing all five blocks' knobs
// while you are looking at ONE of them is 35 controls to find 6 in — so the
// picture and the controls that steer it are brought together: pick a family or
// one of its channels and only that family's band is on the plate.
//
// ⚠ THIS IS STRUCTURE, NOT TEXT, which is why it is free under the resting-text
// rulings. Nothing here paints; it decides which bands RENDER. That is the same
// shape `face.monitor` uses (a declaration the shell reads as a condition on
// what to draw), one step further: a PER-BAND predicate rather than a
// whole-plate boolean.
//
// ── Why the mapping is DECLARED and not sniffed ────────────────────────────
// The temptation is to derive it — on this module the map falls out of the
// output port ids, and it was VERIFIED that way before being written down
// (every one of the 22 preview values resolves to exactly one block, LUMA to
// `rgb` and the whole YCC family to `ycc`, with `pass` the only value that maps
// to no block). But deriving it would couple band visibility to the REAR CARD's
// port grouping, which is a different concern that a later edit is free to
// re-organise. Declared, the coupling is visible and the gate can check it.
//
// ⚠ AND THE GATE CHECKS TOTALITY, which is what keeps the declaration honest as
// the module changes: every value the param can hold must be claimed exactly
// once, so a NEW preview tap with no home is RED rather than silently falling
// through to "show everything".

/** The declaration (`face.bandFocus`). Serialisable data, like the rest of
 *  `face` — the shell reads it, never a closure. */
export interface FaceBandFocus {
  /** The param whose value selects the focused band. */
  param: string;
  /**
   * Why hiding the other bands is right for THIS module — required, and an
   * argument rather than a label. Never painted (see the note in
   * `face-resting-text-source`'s roster): it is for the reviewer and the gate.
   */
  why: string;
  /** Values that show EVERY band. The escape hatch the player selects on
   *  purpose — `preview: 0` (PASS) here. */
  showAllOn: readonly number[];
  /** band (page) id → the param values that reveal it, and only it. */
  bands: Readonly<Record<string, readonly number[]>>;
}

/**
 * Which bands are visible at `value`.
 *
 * Returns `null` for "ALL BANDS" rather than a set containing everything,
 * because the two are different statements and the caller renders them
 * differently: `null` is "this face is not focused right now", and an empty set
 * would be "focused on nothing", which is a blank plate and a bug. Callers that
 * treat a missing declaration as `null` therefore degrade to today's behaviour.
 */
export function visibleBandIds(
  focus: FaceBandFocus | undefined,
  value: number | undefined,
): ReadonlySet<string> | null {
  if (!focus) return null;
  if (value === undefined || Number.isNaN(value)) return null;
  const v = Math.round(value);
  if (focus.showAllOn.includes(v)) return null;
  for (const [band, values] of Object.entries(focus.bands)) {
    if (values.includes(v)) return new Set([band]);
  }
  // ⚠ AN UNCLAIMED VALUE SHOWS EVERYTHING rather than nothing. The gate refuses
  // this state at build time, so it should be unreachable — but if it ever is
  // reached, failing OPEN keeps every control reachable, and failing closed
  // would hide the whole plate. The safe direction is the one that cannot lose
  // a control.
  return null;
}

/** What `bandFocusIsTotal` found wrong, empty when the declaration is sound. */
export interface BandFocusProblems {
  /** Param values claimed by nobody — they would silently show every band. */
  unclaimed: number[];
  /** Values claimed more than once (two bands, or a band and `showAllOn`). */
  duplicated: number[];
  /** `bands` keys that are not declared page ids. */
  unknownBands: string[];
  /** Values outside the param's own declared roster/range. */
  outOfRange: number[];
}

/**
 * TOTALITY — every value the param can hold is claimed EXACTLY once.
 *
 * This is the whole reason the declaration is safe to hand-write. Without it a
 * new preview tap would fall through `visibleBandIds` to "show everything",
 * which looks fine on screen and quietly means the feature stopped applying to
 * part of the module.
 *
 * Pure, and takes the legal values + page ids rather than reading a registry, so
 * the gate can run it on synthetic input as well as on the live def.
 */
export function bandFocusIsTotal(
  focus: FaceBandFocus,
  legalValues: readonly number[],
  pageIds: readonly string[],
): BandFocusProblems {
  const seen = new Map<number, number>();
  const bump = (v: number) => seen.set(v, (seen.get(v) ?? 0) + 1);
  for (const v of focus.showAllOn) bump(v);
  for (const values of Object.values(focus.bands)) for (const v of values) bump(v);

  const legal = new Set(legalValues);
  const pages = new Set(pageIds);
  return {
    unclaimed: legalValues.filter((v) => !seen.has(v)),
    duplicated: [...seen.entries()].filter(([, n]) => n > 1).map(([v]) => v).sort((a, b) => a - b),
    unknownBands: Object.keys(focus.bands).filter((b) => !pages.has(b)),
    outOfRange: [...seen.keys()].filter((v) => !legal.has(v)).sort((a, b) => a - b),
  };
}

/** Does this declaration say anything at all? A face declaring `bandFocus` with
 *  no bands would hide nothing and is refused by the gate rather than rendering
 *  a face that silently ignores its own declaration. */
export function bandFocusIsInert(focus: FaceBandFocus): boolean {
  return Object.keys(focus.bands).length === 0;
}
