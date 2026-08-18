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

// ── ONE RULER FOR THE WHOLE FACE (#1825) ───────────────────────────────────
//
// ⚠ THE BAND-LEVEL GRID ABOVE ALIGNS CLUSTERS AND NOTHING ELSE, and on a
// multi-band console that is half a fix. Each band sizes its OWN `max-content`
// columns from its OWN widest cell, so two bands of eight channels land on two
// different rulers. MEASURED on the shipped mixmstrs faceplate (dock full view,
// 1280×720, CSS px, cell centres):
//
//   band        widest cell           pitch     ch1 cx    ch8 cx
//   channels    knob        41.72 px  51.72 px  105.86    467.89
//   dynamics    Toggle      52.00 px  62.00 px  111.00    545.00
//   sends       knob        40.00 px  50.00 px  105.00    455.00
//
// Three pitches, and by channel 8 the same channel's cells are **90.00 px
// apart** between `dynamics` and `sends`. Owner review of #1805: *"need to
// ensure all row content lines up, the channels and sliders and dynamics and
// compressors all need to be aligned so it's visually clear."* A column that
// means "channel N" in one band and "channel N ± two thirds of a column" in the
// next is not a console.
//
// THE FIX IS THE SAME ARGUMENT ONE LEVEL UP: if a band whose clusters agree on
// a width is one table, then a FACE whose bands agree on nothing but their
// column COUNT is still one table — the bands are its row groups. So the
// ruler moves to the page: `.dock-pages` owns the columns, every console band
// is a SUBGRID of it, and a column's width is `max-content` over every cell in
// that column ON THE WHOLE FACE. Derived once, consumed by every row — there is
// no per-section number to hand-tune and none to drift.
//
// ⚠ THE COLUMN OWNS THE WIDTH, NOT THE CONTROL. A `Toggle` (52 px), a
// `KnobConic` (40-47.7 px) and a `NeonFader` (23.8 px) have three different
// intrinsic widths; the track takes the widest and each cell centres inside it
// (`justify-self: center`, already the band rule). Sizing the other way round —
// making the controls equal — would either clip the switch or fatten the fader.
//
// ⚠ AND IT STAYS `max-content`, for the reason the band rule gives: a fixed
// ruler clips any cell wider than it. A wider cell WIDENS THE COLUMN, on every
// band at once, and nothing is ever cut off.

/**
 * Fewest CONSOLE BANDS on one face for a shared ruler to mean anything.
 *
 * One console band is already internally consistent — it has nothing to be
 * aligned to, and re-parenting it onto a page-level grid would move its pixels
 * for no reading benefit. Below this the face keeps the layout it has today,
 * byte for byte, which is what bounds this change's blast radius to the faces
 * that actually have the defect.
 */
export const FACE_CONSOLE_MIN_BANDS = 2;

/**
 * How many COLUMNS the WHOLE FACE's shared ruler carries, or `null` when the
 * face has fewer than `FACE_CONSOLE_MIN_BANDS` console bands and every band
 * keeps its own.
 *
 * The width is the WIDEST band's column count, so a band with fewer columns
 * spans a PREFIX of the ruler (`1 / span cols`) and its column j is still the
 * ruler's column j. On mixmstrs that is 9 — the `aux sends` clusters carry
 * eight channels plus their bus PRE/POST switch — and the eight-wide bands
 * occupy columns 1-8 of it, which is exactly the property the owner asked for.
 */
export function faceConsoleGridCols(
  bands: readonly (ConsoleGridBandLike | null | undefined)[] | null | undefined,
): number | null {
  const cols = (bands ?? []).map(consoleGridCols).filter((c): c is number => c != null);
  if (cols.length < FACE_CONSOLE_MIN_BANDS) return null;
  return Math.max(...cols);
}
