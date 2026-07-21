// packages/web/src/lib/ui/modules/clipplayer-prob-color.ts
//
// PURE cell-fill colour for the clipplayer card's note grid — extracted from
// ClipplayerCard.svelte so the SOURCE-AWARE probability colouring (white /
// purple / orange) is unit-testable without rendering the component (the repo's
// card-logic convention, cf. clipplayer-prob-menu.ts / clipplayer-keyboard.ts).
// It MIRRORS the Launchpad's `noteProbRgb` bucket-for-bucket (same white/purple/
// orange decision via `probColorBucket`, same monotonic brightness ramp), just
// emitting an `hsl(...)` string for the DOM instead of a 0..127 LED triple.

import {
  noteCovering,
  noteEffProb,
  probColorBucket,
  playEveryEff,
  type NoteClipRecord,
} from '$lib/audio/modules/clip-types';

/** The note cell's FILL colour driven by EFFECTIVE probability + its SOURCE:
 *   - '' for an EMPTY cell (the CSS handles the dark/beat background);
 *   - WHITE (`hsl(0 0% 96%)`) at effective 100% (either source);
 *   - a deeper PURPLE (`hsl(280 …)`) as a note's OWN probability drops;
 *   - a deeper ORANGE (`hsl(30 …)`) as the CLIP DEFAULT drops (a note with no
 *     own prob following the clip).
 *  Lightness ramps 30%→72% with probability (brighter = more likely), monotonic
 *  in both hues — the same brightness ordering as the Launchpad ramp. PURE. */
export function noteProbCellFill(clip: NoteClipRecord, step: number, midi: number): string {
  const ev = noteCovering(clip, step, midi);
  if (!ev) return '';
  const p = noteEffProb(clip, ev);
  if (p >= 1) return 'hsl(0 0% 96%)'; // effective 100% → white
  const l = 30 + Math.round(p * 42); // 30%..72% lightness — brighter = more likely
  // SOURCE-AWARE hue: orange for a note following the clip default, purple for a
  // note using its own prob (when p < 1 the source is never 'none', so this is
  // exhaustive).
  return probColorBucket(clip, ev) === 'orange'
    ? `hsl(30 90% ${l}%)` // following the clip default → orange ramp
    : `hsl(280 72% ${l}%)`; // note's own prob → purple ramp
}

// ── PLAY EVERY overlay (mirrors the Launchpad `noteRgb`). A note with
// `playEvery` > 1 tints RED, dimmer the higher N (brightness ∝ 1/N); a note
// that is BOTH probabilistic (< 1) AND play-every > 1 shows the AVERAGE of its
// probability colour and the red. `noteCellFill` is the combined truth the card
// grid paints — prob-only cells keep the EXACT `noteProbCellFill` hsl above (so
// the probability permutation table stays pinned). ──
type Rgb = [number, number, number];
const PE_RED: Rgb = [210, 45, 45]; // card play-every base (0..255), scaled by 1/N
const PROB_PURPLE: Rgb = [178, 70, 235]; // note's-own-prob RGB anchor (for the average)
const PROB_ORANGE: Rgb = [235, 140, 30]; // clip-default RGB anchor
const scale = (c: Rgb, f: number): Rgb => [
  Math.round(c[0] * f), Math.round(c[1] * f), Math.round(c[2] * f),
];
const avg = (a: Rgb, b: Rgb): Rgb => [
  Math.round((a[0] + b[0]) / 2), Math.round((a[1] + b[1]) / 2), Math.round((a[2] + b[2]) / 2),
];
const rgbCss = (c: Rgb): string => `rgb(${c[0]} ${c[1]} ${c[2]})`;

/** The COMBINED note cell fill = probability colour ⊕ play-every red:
 *   - play-every 1 (default) → the exact `noteProbCellFill` hsl (unchanged);
 *   - play-every > 1 at 100% prob → RED, dimmer the higher N (∝ 1/N);
 *   - play-every > 1 AND prob < 1 → the AVERAGE of the probability colour and
 *     the red.
 *  PURE. */
export function noteCellFill(clip: NoteClipRecord, step: number, midi: number): string {
  const ev = noteCovering(clip, step, midi);
  if (!ev) return '';
  const n = playEveryEff(ev);
  if (n <= 1) return noteProbCellFill(clip, step, midi); // prob-only → unchanged hsl
  const red = scale(PE_RED, 1 / n);
  const p = noteEffProb(clip, ev);
  if (p >= 1) return rgbCss(red); // play-every only → red
  const base = probColorBucket(clip, ev) === 'orange' ? PROB_ORANGE : PROB_PURPLE;
  const probRgb = scale(base, 0.45 + 0.55 * Math.max(0, Math.min(1, p))); // brighter = likelier
  return rgbCss(avg(probRgb, red)); // both indicators → average
}
