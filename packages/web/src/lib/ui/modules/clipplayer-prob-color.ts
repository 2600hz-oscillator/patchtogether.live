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
