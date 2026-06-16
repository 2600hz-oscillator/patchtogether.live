// packages/web/src/lib/audio/modules/timelorde-wizard.ts
//
// Pure, unit-tested helpers for TIMELORDE's dot-matrix neon WIZARD graphic
// (the beat-pulsing card art). Everything that has real logic lives here so
// TimelordeCard.svelte stays a thin renderer:
//
//   1. WIZARD_BITMAP + bitmapToDots()  — the hand-authored pixel-art wizard,
//      data-driven so the owner can swap in their own painting in ONE place.
//   2. beatPulse()                     — the brightness/scale a beat-synced
//      pulse should have RIGHT NOW (flash on the beat, decay before the next).
//   3. gateLevelToWizardOn()           — interpret the `gate` INPUT level as
//      the on/off state (level-sensitive — see gate semantics below).
//
// None of these touch the DOM / AudioContext / Svelte, so they run in vitest
// with no browser. See timelorde-wizard.test.ts.

import { GATE_HI } from '$lib/audio/gate-trigger';

// ─────────────────────────────────────────────────────────────────────────
// 1. The wizard bitmap (PLACEHOLDER ART)
// ─────────────────────────────────────────────────────────────────────────
//
// PLACEHOLDER: ▼▼▼ THE OWNER'S PAINTING REPLACES *THIS CONSTANT* ▼▼▼
//
// `WIZARD_BITMAP` is the single, easily-replaced source of the wizard art.
// It is a small string grid — one character per dot — rendered as a glowing
// "neon" dot-matrix display by the card. To swap in the owner's own art,
// replace ONLY this constant (keep the same export name + the `.` = off /
// any-other-char = on convention, OR extend the legend below for colours).
// Nothing else in the card or the rest of the app needs to change.
//
// Current placeholder: an "open-source video-game pixel-art wizard" vibe —
// pointy hat, face, robe, and a staff with a glowing orb. Authored by hand
// (no vendored image asset → zero licensing concern for a placeholder).
//
// Legend (per-character dot colour — lets the owner paint in colour):
//   '.' → OFF (no dot)
//   '#' → HAT / ROBE   (deep neon — the body colour, themable)
//   '*' → SKIN / FACE  (warm highlight)
//   '@' → STAFF + ORB  (the brightest accent — the "magic")
//   any other non-'.' char → ON at the body colour (forgiving for hand-edits)
//
// 16 wide × 18 tall. Square-ish so the card stays compact.
export const WIZARD_BITMAP = [
  '.......@........',
  '......@@@.......',
  '.....##@##......',
  '.....#####......',
  '....#######.....',
  '....#######..@..',
  '...#########.@..',
  '...##*****##.@..',
  '...#*#***#*#.@..',
  '...#*******#@@..',
  '...##*****##@@@.',
  '....#######..@..',
  '...#########....',
  '..###########...',
  '..##.#####.##...',
  '..##.#####.##...',
  '..##..###..##...',
  '..##.......##...',
] as const;

// PLACEHOLDER: ▲▲▲ THE OWNER'S PAINTING REPLACES *THE CONSTANT ABOVE* ▲▲▲

/** A single rendered dot: grid coordinates + which palette role it carries. */
export interface WizardDot {
  /** Column (x) index in the bitmap grid. */
  col: number;
  /** Row (y) index in the bitmap grid. */
  row: number;
  /** Palette role, driving the dot's colour in the card. */
  role: 'hat' | 'skin' | 'staff' | 'body';
}

/** The bitmap's grid dimensions (cols × rows), derived from the constant. */
export function bitmapSize(bitmap: readonly string[] = WIZARD_BITMAP): {
  cols: number;
  rows: number;
} {
  const rows = bitmap.length;
  let cols = 0;
  for (const line of bitmap) cols = Math.max(cols, line.length);
  return { cols, rows };
}

/** Map a bitmap character to its palette role (or null = OFF). */
function charToRole(ch: string): WizardDot['role'] | null {
  switch (ch) {
    case '.':
    case ' ':
      return null;
    case '#':
      return 'hat';
    case '*':
      return 'skin';
    case '@':
      return 'staff';
    default:
      // Any other non-blank char is a lit "body" dot — forgiving for the
      // owner's hand-edits so a stray glyph still shows rather than vanishing.
      return 'body';
  }
}

/**
 * Convert the string bitmap into the list of LIT dots (the off cells are
 * dropped). Pure — the card maps each dot to a positioned glowing element.
 * Data-driven: the owner's art swap (WIZARD_BITMAP) flows through unchanged.
 */
export function bitmapToDots(bitmap: readonly string[] = WIZARD_BITMAP): WizardDot[] {
  const dots: WizardDot[] = [];
  for (let row = 0; row < bitmap.length; row++) {
    const line = bitmap[row] ?? '';
    for (let col = 0; col < line.length; col++) {
      const role = charToRole(line[col] ?? '.');
      if (role) dots.push({ col, row, role });
    }
  }
  return dots;
}

// ─────────────────────────────────────────────────────────────────────────
// 2. Beat-pulse math
// ─────────────────────────────────────────────────────────────────────────

export interface BeatPulseArgs {
  /** Master tempo in BPM (the SAME value TIMELORDE's worklet uses — when an
   *  external clock is locked the card reads the measured BPM into this). */
  bpm: number;
  /** Transport state: false = STOPPED (wizard idle/dim, no pulse). */
  running: boolean;
  /** Wall-clock "now" in ms (performance.now() at the render frame). */
  nowMs: number;
  /** Wall-clock ms captured when the transport last STARTED — the beat
   *  phase is measured from here so the flash lands on the downbeat after a
   *  start, instead of at an arbitrary offset. */
  anchorMs: number;
  /** Fraction of one beat the flash takes to decay back to idle (0..1).
   *  0.6 = bright on the beat, faded by 60% of the way to the next beat. */
  decayFraction?: number;
}

/**
 * The pulse intensity (0 = idle/dim … 1 = full flash) the wizard should show
 * RIGHT NOW. The wizard flashes to 1 exactly on each beat and decays toward 0
 * before the next beat.
 *
 * Phase is derived from the SAME `bpm` the clock runs at + a start anchor — it
 * does NOT spin up a second clock (no setInterval / no audio tap). It's a
 * cheap deterministic function of (bpm, now − anchor). When `running` is false
 * (or bpm is non-positive) it returns 0 so the wizard sits idle while stopped.
 *
 * Shape: a linear decay across `decayFraction` of the beat. At phase 0 → 1; at
 * phase ≥ decayFraction → 0; linear in between. Linear (not exponential) keeps
 * the math trivially testable and the visual "snappy".
 */
export function beatPulse(args: BeatPulseArgs): number {
  const { bpm, running, nowMs, anchorMs } = args;
  const decayFraction = clamp01(args.decayFraction ?? 0.6);
  if (!running) return 0;
  if (!(bpm > 0)) return 0;
  if (decayFraction <= 0) return 0;

  const beatMs = 60_000 / bpm; // ms per quarter-note beat
  const elapsed = nowMs - anchorMs;
  // Phase within the current beat, 0..1. Math.floor handles negative elapsed
  // (now before anchor) by wrapping into [0,1) just like a positive value.
  const beats = elapsed / beatMs;
  const phase = beats - Math.floor(beats);

  if (phase >= decayFraction) return 0;
  // 1 at phase 0, linearly to 0 at phase === decayFraction.
  return 1 - phase / decayFraction;
}

// ─────────────────────────────────────────────────────────────────────────
// 3. Gate → on/off interpretation
// ─────────────────────────────────────────────────────────────────────────
//
// GATE SEMANTICS (chosen — documented so the owner can correct it):
//
//   The `gate` INPUT is LEVEL-SENSITIVE (declared `edge: 'gate'`):
//     • gate HIGH (level ≥ GATE_HI)  → wizard ON  (shown + pulsing)
//     • gate LOW  (level <  GATE_HI) → wizard OFF (hidden)
//
//   It is NOT edge-triggered: holding the gate high keeps the wizard on; it
//   does not toggle on each rising edge. This matches the owner's phrasing
//   "that button is on a gate" — an external gate can SHOW/HIDE the wizard
//   exactly like the on-card button, and the two converge on one on/off state
//   (the button is a manual override; the gate is external control). When no
//   gate cable is patched, only the button governs.
//
//   To FLIP the meaning (gate HIGH = off), the owner inverts the comparison
//   here in one place.

/** Interpret a gate INPUT level (0..1 CV) as the wizard on/off state.
 *  HIGH (≥ GATE_HI) = on (true); LOW = off (false). Level-sensitive. */
export function gateLevelToWizardOn(level: number): boolean {
  return level >= GATE_HI;
}

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
