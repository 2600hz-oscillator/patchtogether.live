// packages/web/src/lib/ui/controls/segmented-model.ts
//
// PURE index/value logic for Segmented.svelte (the RACKLINE `.segmented` /
// `.seg` / `.seg.on` discrete N-way — filter type, wave shape, mode banks).
// A segmented control is a selector rendered inline as a button row; it shares
// the SelectorOption shape but always shows every option at once and one is
// `.on`. The component is a thin shell over these resolvers.

import type { SelectorOption } from './selector-model';

/** A segment is just a selector option shown as an inline button. */
export type Segment<T extends number | string = number | string> = SelectorOption<T>;

/**
 * Index of the active segment for `value` — an exact value match, else -1.
 * (Segmented controls are discrete: an unmatched value lights nothing rather
 * than snapping the highlight to a neighbour.)
 */
export function activeSegmentIndex<T extends number | string>(
  value: T,
  segments: readonly Segment<T>[],
): number {
  for (let i = 0; i < segments.length; i++) {
    if (segments[i]!.value === value) return i;
  }
  return -1;
}

/** The value emitted when the segment at `index` is pressed (undefined if OOB). */
export function segmentValueAt<T extends number | string>(
  segments: readonly Segment<T>[],
  index: number,
): T | undefined {
  if (index < 0 || index >= segments.length) return undefined;
  return segments[index]!.value;
}

/**
 * Map an inbound MIDI-CC fraction [0,1] to a segment index (evenly quantized),
 * so a learned CC steps across the row. Empty row → -1.
 */
export function ccFractionToSegmentIndex(frac: number, count: number): number {
  if (count <= 0) return -1;
  const f = frac < 0 ? 0 : frac > 1 ? 1 : frac;
  return Math.min(count - 1, Math.round(f * (count - 1)));
}
