// packages/web/src/lib/ui/workflow/console-grid.ts
//
// THE CONSOLE GRID — when a band's clusters are COLUMNS OF ONE TABLE rather
// than four independent rows.
//
// ── THE DEFECT THIS FIXES, MEASURED ────────────────────────────────────────
//
// Owner review of #1738: *"the level settings need to be above the rows of
// dials perfectly"*, and *"all the unused negative space on the side here needs
// to go away"*. Those are ONE defect with one cause.
//
// `.page-controls` is a left-packed `flex-wrap` row, and each cluster is its
// OWN `.page-controls`. So a cluster of eight FADER cells (22.0 px each) and a
// cluster of eight KNOB cells (41.7 px each) lay out independently: on the
// shipped mixmstrs faceplate, fader 1 sat 9.9 px left of knob 1 and the error
// ACCUMULATED down the bank — measured Δcx per channel:
//
//     ch1 −9.9   ch2 −29.6   ch3 −49.3   …   ch8 ≈ −138
//
// A "console" whose fader is 138 px away from the channel it controls is not a
// console. And the same flex-wrap is why the face was 805.1 px wide while its
// widest real row of cells was ~414 px: `width: max-content` on the dock host
// asks "how wide if nothing wraps", each cluster answers with its own packing,
// and every band then STRETCHES to the widest answer. Squeezing the host to
// 200 px was the proof — NOTHING in the face refused to shrink, i.e. no content
// ever needed 805 px. The surplus was blank.
//
// ── THE RULE, AND WHY IT IS DERIVED RATHER THAN DECLARED ───────────────────
//
// A band is a CONSOLE GRID when its clusters all hold the SAME number of cells
// (and there are at least two of them). That is not a heuristic about mixers —
// it is the definition of a table: N clusters × M cells where column j of every
// cluster is the same thing. mixmstrs' face-model test already pins exactly
// this property for its own bands ("every cluster is `MIXMSTRS_CHANNELS.length`
// wide by construction"), so the layout now READS the property the def already
// guarantees instead of asking the def to declare a second, drift-prone flag.
//
// The consequence is that a band stops being N independent flex rows and
// becomes one grid of FIXED-WIDTH columns: column j has the same centre in
// every cluster, by construction rather than by tuning, and the band's width
// becomes M columns of real content instead of the widest unwrapped packing.
//
// ⚠ WHAT THIS IS NOT: it is not `1fr` columns. Two SEPARATE grids with `1fr`
// resolve their own content widths and would drift apart again exactly as the
// flex rows did. The column width is the shared `DOCK_KCOL_W` layout constant —
// the same one the hero glyph cap is already derived from — so every cluster in
// every band lands on one ruler.
//
// PURE: no DOM, no registry. The caller passes the band.

/** The minimal band shape this reads — a subset of `DockFaceBand`. */
export interface ConsoleGridBandLike {
  clusters: readonly { readonly controls: readonly unknown[] }[];
}

/**
 * Fewest clusters that can form a table. One cluster is a row, not a grid —
 * and it already lays out correctly, because there is nothing to align it to.
 */
export const CONSOLE_MIN_CLUSTERS = 2;

/**
 * Fewest cells per cluster for the grid to mean anything. A one-cell cluster
 * pair is two captions side by side; forcing them onto a fixed column ruler
 * would widen them for no reading benefit.
 */
export const CONSOLE_MIN_CELLS = 2;

/**
 * How many COLUMNS this band's clusters share, or `null` when the band is not a
 * console grid and keeps the flex-wrap layout every faceplate has today.
 *
 * `null` is the answer for the overwhelming majority of bands — a band with no
 * clusters, one cluster, or clusters of differing size is unchanged, byte for
 * byte, which is what keeps the rest of the roster's baselines still.
 */
export function consoleGridCols(band: ConsoleGridBandLike | null | undefined): number | null {
  const clusters = band?.clusters ?? [];
  if (clusters.length < CONSOLE_MIN_CLUSTERS) return null;
  const cols = clusters[0]!.controls.length;
  if (cols < CONSOLE_MIN_CELLS) return null;
  for (const c of clusters) if (c.controls.length !== cols) return null;
  return cols;
}
