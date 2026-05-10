// Shared corner-drag resize helper for video cards (OUTPUT, RUTTETRA,
// MONOGLITCH). Pointer deltas are divided by the live svelte-flow
// viewport zoom so a 1px screen drag always maps to 1px of card size,
// regardless of canvas zoom. Width/height are persisted onto the node
// via the supplied `apply` callback so Y.Doc syncs them to other
// collaborators in the same rackspace.

import type { useStore } from '@xyflow/svelte';

type FlowStore = ReturnType<typeof useStore>;

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

  const onMove = (mev: PointerEvent) => {
    const zoom = opts.flowStore.viewport.zoom || 1;
    const dx = (mev.clientX - startX) / zoom;
    const dy = (mev.clientY - startY) / zoom;
    const w = Math.max(opts.minWidth, Math.round(startW + dx));
    const h = Math.max(opts.minHeight, Math.round(startH + dy));
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
