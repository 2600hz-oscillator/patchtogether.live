// clip-grid-spec.test.ts — the docs diagrams must stay in sync with the REAL
// grid layout constants. These assert the spec is derived from grid-clip-map,
// not hand-numbered (so a layout change surfaces here).

import { describe, it, expect } from 'vitest';
import { clipSessionGrid, clipEditGrid } from './clip-grid-spec';
import { GRID_WIDTH, GRID_HEIGHT } from '$lib/grid/mext';
import { CLIP_SLOTS, CLIP_LANES } from '$lib/audio/modules/clip-types';
import {
  CTRL_STOP_COL,
  CTRL_SCENE_COL,
  EDIT_PAD,
  STOPALL_PAD,
  TRANSPORT_PAD,
  SCALE_PAD,
  FUNC_ROW,
} from '$lib/grid/grid-clip-map';

describe('clipSessionGrid', () => {
  const g = clipSessionGrid();

  it('matches the live grid dimensions', () => {
    expect(g.cols).toBe(GRID_WIDTH);
    expect(g.rows).toBe(GRID_HEIGHT);
  });

  it('fills the full clip matrix + the STOP and SCENE columns', () => {
    const has = (x: number, y: number) => g.cells.some((c) => c.x === x && c.y === y);
    expect(has(0, 0)).toBe(true);
    expect(has(CLIP_SLOTS - 1, CLIP_LANES - 1)).toBe(true);
    expect(has(CTRL_STOP_COL, 0)).toBe(true);
    expect(has(CTRL_SCENE_COL, 0)).toBe(true);
  });

  it('brackets CLIPS over cols 0..7 and ticks STOP/SCENE at the real columns', () => {
    const clips = g.callouts.find((c) => c.label.startsWith('CLIPS'));
    expect(clips).toMatchObject({ fromCol: 0, toCol: CLIP_SLOTS - 1 });
    expect(g.callouts.find((c) => c.label === 'STOP')?.fromCol).toBe(CTRL_STOP_COL);
    expect(g.callouts.find((c) => c.label === 'SCENE')?.fromCol).toBe(CTRL_SCENE_COL);
  });

  it('side-labels the stacked right-column controls at their real pads', () => {
    const at = (label: string) => g.sideLabels?.find((s) => s.label.startsWith(label));
    expect(at('EDIT')).toMatchObject({ atX: EDIT_PAD.x, atY: EDIT_PAD.y });
    expect(at('STOP ALL')).toMatchObject({ atX: STOPALL_PAD.x, atY: STOPALL_PAD.y });
    expect(at('TRANSPORT')).toMatchObject({ atX: TRANSPORT_PAD.x, atY: TRANSPORT_PAD.y });
  });
});

describe('clipEditGrid', () => {
  const g = clipEditGrid();

  it('labels the function-row controls (SCALE at its real column, on the func row)', () => {
    expect(g.callouts.find((c) => c.label === 'SCALE')?.fromCol).toBe(SCALE_PAD.x);
    // the function pads live on the last row
    expect(g.cells.some((c) => c.y === FUNC_ROW)).toBe(true);
  });

  it('every callout points at a column inside the grid', () => {
    for (const c of g.callouts) {
      expect(c.fromCol).toBeGreaterThanOrEqual(0);
      expect(c.toCol ?? c.fromCol).toBeLessThan(GRID_WIDTH);
    }
  });
});
