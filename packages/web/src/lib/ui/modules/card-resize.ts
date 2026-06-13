// Shared corner-drag resize helper for video cards (OUTPUT, RESHAPER,
// RUTTETRA, MONOGLITCH). Pointer deltas are divided by the live svelte-flow
// viewport zoom so a 1px screen drag always maps to 1px of card size,
// regardless of canvas zoom. Width/height are persisted onto the node
// via the supplied `apply` callback so Y.Doc syncs them to other
// collaborators in the same rackspace.

import type { useStore } from '@xyflow/svelte';

type FlowStore = ReturnType<typeof useStore>;

/** The rack grid tile (px). Resizable cards snap to whole-tile (Nu) multiples
 *  so they stay on the 1u×1u rack grid — see _module-card.css `--rack-unit`. */
const RACK_UNIT = 180;

export interface ResizeOptions {
  flowStore: FlowStore;
  minWidth: number;
  minHeight: number;
  /** Read the card's current width at the moment the drag starts. */
  getStartSize: () => { width: number; height: number };
  /** Persist a new width/height. */
  apply: (w: number, h: number) => void;
  /** Optional: notify when a drag begins / ends so the card can suppress
   *  hover transitions or set an aria attribute. */
  onStart?: () => void;
  onEnd?: () => void;
  /** Grid quantum for snapping the resized size (px). Defaults to RACK_UNIT
   *  (180) so resizable cards snap to whole-u tiles, ROUNDING UP — the card
   *  always lands on the rack grid. Pass 1 to disable snapping (STICKY, the
   *  free-form note). */
  snapTo?: number;
}

export function startCornerResize(ev: PointerEvent, opts: ResizeOptions): AbortController {
  ev.preventDefault();
  ev.stopPropagation();
  const startX = ev.clientX;
  const startY = ev.clientY;
  const { width: startW, height: startH } = opts.getStartSize();
  const ctl = new AbortController();
  const sig = ctl.signal;
  opts.onStart?.();

  const snap = opts.snapTo ?? RACK_UNIT;
  // Snap to the next whole grid tile, ROUNDING UP, so the card always lands on
  // the rack grid (a -1..+1 drag past a tile boundary jumps a full u). min is
  // honoured first, then rounded up to the grid too. snap<=1 → free (STICKY).
  const quantize = (raw: number, min: number) => {
    const v = Math.max(min, Math.round(raw));
    return snap > 1 ? Math.ceil(v / snap) * snap : v;
  };
  const onMove = (mev: PointerEvent) => {
    const zoom = opts.flowStore.viewport.zoom || 1;
    const dx = (mev.clientX - startX) / zoom;
    const dy = (mev.clientY - startY) / zoom;
    const w = quantize(startW + dx, opts.minWidth);
    const h = quantize(startH + dy, opts.minHeight);
    opts.apply(w, h);
  };
  const stop = () => {
    opts.onEnd?.();
    ctl.abort();
  };
  window.addEventListener('pointermove', onMove, { signal: sig });
  window.addEventListener('pointerup', stop, { signal: sig });
  window.addEventListener('pointercancel', stop, { signal: sig });
  return ctl;
}
