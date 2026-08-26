// packages/web/src/lib/ui/modules/code-buffer-face.ts
//
// The geometry the two CODE-BUFFER faceplates share — LIVECODE and the CLOCKED
// RUNNER it spawns. ONE place, imported by both bodies and read back by both
// `*-face-model.test.ts` files, so the number cannot drift between two surfaces
// that are meant to look like the same instrument.
//
// ── WHY A CODE BUFFER IS A GENUINE WIDTH EARNER ─────────────────────────────
//
// "Compact is the DEFAULT and width must be EARNED" (owner, 2026-08-17). A
// buffer earns it the same way a scope trace or an XY pad does: it is the
// surface the module is OPERATED from, and below a certain width it stops being
// operable rather than merely getting tighter. Both legacy cards already carried
// that judgement as `MIN_WIDTH = 360` with 12 px of chrome each side, i.e. ~336
// CSS px of actual buffer — so this is a number the modules have always had,
// moved rather than invented.
//
// ⚠ AND WITHOUT IT THE PLATE COLLAPSES ONTO ITS OWN TITLE ROW. `.faceplate-body`
// is `width: max-content` and `.dock-ext-body` is `width: 100%`, which
// contributes NOTHING to an intrinsic size — and CodeMirror's own `.cm-scroller`
// is `overflow-x: auto`, so a long line does not push either. So with no floor
// the widest thing on a LIVECODE plate is the 58 px RUN cell against the ~148 px
// module-name row, and the code buffer would render about 170 px wide. That is
// the moog912 shape (a face whose name row out-measures its controls) with the
// module's entire working surface inside it.
//
// ⚠ IT IS DELIBERATELY BELOW BOTH CARDS' DEFAULTS. LIVECODE's card opens at
// 540 and the runner's at 360; a faceplate is not a card and does not owe the
// card's size, so this is the runner's floor rather than LIVECODE's default —
// the narrower of the two judgements the modules already made, applied to both
// so the parent and its child read as one instrument. The dock pane scrolls, so
// a wider plate would cost the player pane width they cannot get back.

/**
 * The minimum width of a faceplate code buffer, CSS px.
 *
 * ⚠ NOT A POPULATION COUNT — a LAYOUT constant, which `population-counts.md`
 * names as one of the four things not to mistake for a ratchet. Its value is a
 * legibility threshold (how narrow a JavaScript line may get before wrapping
 * makes it unreadable), not how many of anything there are.
 */
export const CODE_BUFFER_FACE_MIN_W = 336;

/**
 * The height of a faceplate code buffer, CSS px.
 *
 * ⚠ A FIXED HEIGHT RATHER THAN A GRIP, and the fold is why the number is this
 * one. The dock scene captures the TOP ~425 CSS px of the plate
 * (`DockFullView`'s `max-height: min(60vh, 680px)` over its own scroll region),
 * and the extension body sits ABOVE the bands — so every pixel of buffer pushes
 * the module's ranked cell toward the fold. 208 px is ~11 lines at the editor's
 * own 0.78rem/1.5 metrics, which keeps the band comfortably in frame while
 * still showing a real callback body without scrolling.
 */
export const CODE_BUFFER_FACE_H = 208;

/**
 * The tallest a LIVECODE output log grows before it scrolls, CSS px.
 *
 * The log is ABSENT until a run produces lines, so this is a ceiling on a
 * surface that does not exist at rest — which is what keeps the resting plate
 * both compact and pixel-deterministic.
 */
export const CODE_BUFFER_LOG_MAX_H = 96;
