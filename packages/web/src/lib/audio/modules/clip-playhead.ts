// packages/web/src/lib/audio/modules/clip-playhead.ts
//
// Per-machine, IN-MEMORY playhead positions for the clip player — the step each
// lane is currently SOUNDING. This is render state (the card editor + the grid
// LEDs read it to draw the moving playhead), so it lives here, NOT on the synced
// Y.Doc: writing a position every scheduler tick into the synced store would be
// the per-frame ydoc.update storm that leaks SvelteFlow edge SVG + spikes heap
// (see the cv-modulation-live-store-write rule). The factory updates it each
// tick; consumers read it; it's cleared on dispose.

const playheads = new Map<string, number[]>();

/** Record lane L's currently-sounding step for node `nodeId` (-1 = silent). */
export function setLanePlayhead(nodeId: string, lane: number, step: number): void {
  let arr = playheads.get(nodeId);
  if (!arr) {
    arr = [];
    playheads.set(nodeId, arr);
  }
  arr[lane] = step;
}

/** Lane L's currently-sounding step (-1 if silent / unknown). */
export function getLanePlayhead(nodeId: string, lane: number): number {
  const v = playheads.get(nodeId)?.[lane];
  return typeof v === 'number' ? v : -1;
}

/** Drop all playhead state for a node (call on factory dispose). */
export function clearPlayheads(nodeId: string): void {
  playheads.delete(nodeId);
}
