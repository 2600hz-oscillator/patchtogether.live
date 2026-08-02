// packages/web/src/lib/ui/workflow/lane-readout-fit.ts
//
// DOES A PERSISTENT KNOB READOUT FIT THE LANE COLUMN? — in CSS PIXELS, which is
// the unit the constraint is actually expressed in.
//
// ── WHAT ACTUALLY HAPPENS TO AN OVER-LONG READOUT (measured, not reasoned) ──
//
// In the LANE body the knob column is CAPPED:
//
//     .rl-tile .tile-body .kcol { max-width: var(--kcol-max, 46px) }   ← 46 px
//                                  (_rackline-tile.css)
//
// and that rule's own comment states the guarantee: "a long param label
// ellipsizes inside the cap instead of widening the column and pushing later
// cells past the fixed tile edge."
//
// FOR ANYTHING KnobConic DRAWS, THAT GUARANTEE IS NOT DELIVERED. `.label` and
// `.readout` do carry `max-width:100%; overflow:hidden; text-overflow:ellipsis`
// — but their `100%` resolves against `.knob-wrap`, KnobConic's own column,
// which has `max-width: none`. `.knob-wrap` therefore grows to the text, the
// ellipsis machinery never engages, and `.kcol` (`overflow: visible`) simply
// lets the text SPILL. Measured in the real lane at `base = 0.25`, all three
// lane tiers, deviceScaleFactor 1:
//
//     readout      .readout ow   .knob-wrap ow   .kcol ow   ellipsized?
//     "-12 dB"      36            40              40         no
//     "-12.0 dB"    48            48              46         NO — spills ~1 px
//     "-12.00 dBFS" 66            66              46         NO — spills 10 px
//     16 glyphs     95            95              46         NO — spills 24 px
//
// `scrollWidth === clientWidth` on `.readout` in EVERY row, so "does Chromium
// draw the ellipsis" is a metric that can never fire here — it is invariant to
// the very thing under test (CLAUDE.md: validate the instrument). The failure is
// OVERFLOW, not truncation, and the number that moves is the readout's own
// width against the column cap.
//
// So the string length is the ONLY thing holding the line, which is exactly why
// this fit check has to exist and has to be right. Two consequences at 8 glyphs
// (`-12.0 dB`, 47.7 px): the readout escapes its column, and it drags `.kcol`
// from its natural 40 px (the knob) up to the 46 px CAP — i.e. it consumes the
// whole margin `laneBodyPlan` budgets per cell, with the next glyph landing
// outside. (⚠ FOLLOW-UP, deliberately NOT taken in this PR: giving
// `.rl-tile .tile-body .kcol .knob-wrap` a `max-width:100%; min-width:0` would
// make the documented cap self-enforcing for every face at once — and would
// move every VRT baseline that currently has an over-wide label, which is not a
// change to land while a platform baseline regen is in flight.)
//
// WHY A MODULE FOR TWO NUMBERS. Because a `format` fit-check that lives in one
// module's test file is a second copy of the layout contract, and the unit test
// and the browser test would then each carry their own copy of `46`. There is
// exactly one home for both numbers, and `vca-face.spec.ts` asserts BOTH of
// them against a live render — so the constants below are browser-verified
// rather than asserted from a comment.
//
// PURE + import-free: runs in the `unit` lane and imports cleanly into an e2e
// spec (no `$lib` alias, no DOM, no registry).

/**
 * The LANE knob column's hard cap, in CSS px.
 *
 * MIRRORS `--kcol-max` (`_rackline-tile.css`, `.rl-tile .tile-body .kcol`) —
 * which mirrors `laneBodyPlan`'s 46 px fit constant. `vca-face.spec.ts` reads
 * `getComputedStyle(kcol).maxWidth` off a live lane tile and asserts it equals
 * this number, so the mirror cannot rot silently.
 */
export const LANE_KCOL_MAX_PX = 46;

/**
 * The per-glyph advance of `.readout` text, in CSS px — MEASURED, not assumed.
 *
 * `.readout` is `font-size: 9px` + `letter-spacing: 0.06em` in `--mono`
 * (`ui-monospace, 'SF Mono', Menlo, Consolas, monospace`), all of which are
 * 0.6 em fixed-advance faces, so one glyph is `9 × 0.6 + 9 × 0.06 = 5.94 px`
 * nominal. Measured in headless Chromium at deviceScaleFactor 1 (the renderer
 * the VRT/e2e lanes use): **5.9609 px/glyph**, constant across `OPEN` (4) →
 * `-46.0 dB` (8) and independent of WHICH glyphs are used (`00000000` and
 * `WWWWWWWW` measure identically — it is a monospace advance, not an ink
 * extent). Cross-checked against the live lane: 6 glyphs → `offsetWidth` 36,
 * 8 glyphs → 48, 11 glyphs → 66.
 *
 * 5.97 is that measurement rounded UP, so this is an UPPER BOUND on the real
 * advance and the fit check errs toward refusing a string that would have just
 * fit — never toward passing one that overflows. Linux's fallback
 * (DejaVu Sans Mono, 0.60205 em → 5.958 px) is narrower, so the bound holds
 * there too.
 *
 * That claim is CHECKED rather than reasoned: `vca-face.spec.ts` measures the
 * advance on the ACTUAL runner with an in-page probe span and asserts that
 * `READOUT_MAX_CHARS × measured ≤ LANE_KCOL_MAX_PX` — i.e. that the budget this
 * constant hands the unit guard still fits over there. It gates the VERDICT
 * rather than the constant itself, because the runner's `monospace` resolution
 * is platform-dependent and a hundredth of a px is noise; 7 glyphs no longer
 * fitting is not.
 *
 * ⚠ This is NOT an ink extent. Measuring glyph ink off a screenshot over-reads
 * the advance by roughly a glyph's side-bearings (that route gave 6.5 px/char
 * on this same text — 9 % high). Use a layout width (`offsetWidth` /
 * `getBoundingClientRect`), not pixels in a PNG.
 */
export const READOUT_CHAR_PX = 5.97;

/** Rendered width of a readout string in the lane, in CSS px. */
export function readoutWidthPx(text: string): number {
  return text.length * READOUT_CHAR_PX;
}

/**
 * The longest readout that stays INSIDE the lane column.
 * `floor(46 / 5.97)` = 7 glyphs (41.79 px). 8 glyphs is 47.76 px and spills.
 */
export const READOUT_MAX_CHARS = Math.floor(LANE_KCOL_MAX_PX / READOUT_CHAR_PX);

/** Whether a readout string renders inside the lane knob column rather than
 *  escaping it. */
export function readoutFitsLane(text: string): boolean {
  return readoutWidthPx(text) <= LANE_KCOL_MAX_PX;
}
