// e2e/tests/support/cell-coverage.ts
//
// THE `control-<paramId>` CONVENTION, GENERALISED TO N-TO-1 CONTROLS.
//
// `faces-parity` asserts EXACT MULTISET EQUALITY between a dock's `control-*`
// testids and the def's param ids, and counts one cell per param. Both rest on
// an assumption that is true of every 1-D primitive and FALSE of a 2-D pad:
// that one element drives one param. `XyPad` is one element driving two, so
// under the un-generalised rules a faced pad reads as TWO LOST CONTROLS and a
// cell short — a working control, red.
//
// So an element may DECLARE the set it covers in `data-control-params`, and
// these two pure functions are the single place that convention is
// interpreted.
//
// ⚠ THEY LIVE HERE, IN NODE, RATHER THAN INSIDE THE `evaluateAll` CALLBACK,
// AND THAT IS DELIBERATE. A page-side callback is serialised to the browser
// and cannot close over an import, so putting the rule there would force every
// consumer to re-type it — and a re-typed copy of a rule in the place that
// checks it is exactly how the raw-write guard went blind (CLAUDE.md, "the
// ledger you invert it with is the next blind spot"). The browser now returns
// RAW ATTRIBUTES and the interpretation happens once, here, where
// `xy-pad-cell.spec.ts` can drive the same functions against a real pad's DOM.
// Without that, the two-param branch would never execute on any green run —
// no shipped face declares a pad yet.

/** The raw attributes one candidate element contributes. */
export interface CoverageAttrs {
  /** `data-testid`, e.g. `control-camTiltX`. */
  testid: string | null;
  /** `data-control-params`, e.g. `camTiltX,camTiltY`. Absent on 1-D controls. */
  covered: string | null;
}

/** Split a `data-control-params` value, tolerating spaces and trailing commas. */
function parseCovered(covered: string | null): string[] {
  return (covered ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The param ids ONE `control-*` element accounts for.
 *
 * A declared set WINS over the testid: the testid is only the element's anchor
 * (a pad's is its x axis), so trusting it alone would under-count by exactly
 * the partner axes. An element with neither contributes nothing rather than
 * contributing `''`, so a malformed control shows up as a MISSING param —
 * which is the loud direction.
 */
export function idsCoveredBy({ testid, covered }: CoverageAttrs): string[] {
  const declared = parseCovered(covered);
  if (declared.length) return declared;
  if (testid?.startsWith('control-')) return [testid.slice('control-'.length)];
  return [];
}

/**
 * How many DEF PARAMS one rendered CELL covers — the term of the params-covered
 * identity that replaced `cells.length === params + families`.
 *
 * Zero for a family/static cell (it has no ParamDef behind it). For a param
 * cell: the size of the declared set, else ONE. The `|| 1` is load-bearing —
 * every existing primitive declares nothing and covers exactly one param, so a
 * missing attribute must not read as "covers zero" and turn all 33 shipped
 * faces red.
 */
export function paramsCoveredByCell(cellKind: string | null, covered: string | null): number {
  if (cellKind !== 'param') return 0;
  return parseCovered(covered).length || 1;
}
