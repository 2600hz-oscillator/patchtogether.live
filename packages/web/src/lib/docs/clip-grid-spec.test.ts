// clip-grid-spec.test.ts — the docs diagrams must stay in sync with the REAL
// grid layout constants. These assert the spec is derived from grid-clip-map,
// not hand-numbered (so a layout change surfaces here).

import { describe, it, expect } from 'vitest';
import { clipSessionGrid, clipEditGrid, clipLengthEditGrid } from './clip-grid-spec';
import { GRID_WIDTH, GRID_HEIGHT } from '$lib/grid/mext';
import { CLIP_SLOTS, CLIP_LANES } from '$lib/audio/modules/clip-types';
import {
  CTRL_STOP_COL,
  CTRL_SCENE_COL,
  EDIT_PAD,
  COPY_PAD,
  PASTE_PAD,
  PASTE_REV_PAD,
  STOPALL_PAD,
  TRANSPORT_PAD,
  SCALE_PAD,
  FOLLOW_PAD,
  PAGE_LEFT_PAD,
  PAGE_RIGHT_PAD,
  DOUBLE_PAD,
  LENGTH_EDIT_PAD,
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

describe('clipSessionGrid — copy/paste controls', () => {
  const g = clipSessionGrid();
  it('places COPY / PASTE / PASTE-REV cells at their real pads', () => {
    const has = (x: number, y: number) => g.cells.some((c) => c.x === x && c.y === y);
    expect(has(COPY_PAD.x, COPY_PAD.y)).toBe(true);
    expect(has(PASTE_PAD.x, PASTE_PAD.y)).toBe(true);
    expect(has(PASTE_REV_PAD.x, PASTE_REV_PAD.y)).toBe(true);
  });
  it('side-labels COPY/PASTE + mentions held modifiers in the caption', () => {
    const at = (label: string) => g.sideLabels?.find((s) => s.label.startsWith(label));
    expect(at('COPY')).toMatchObject({ atX: COPY_PAD.x, atY: COPY_PAD.y });
    expect(at('PASTE')).toBeTruthy();
    expect(g.caption.toLowerCase()).toContain('held modifier');
  });
});

describe('clipEditGrid', () => {
  const g = clipEditGrid();

  it('labels the function-row controls (SCALE at its real column, on the func row)', () => {
    expect(g.callouts.find((c) => c.label === 'SCALE')?.fromCol).toBe(SCALE_PAD.x);
    // the function pads live on the last row
    expect(g.cells.some((c) => c.y === FUNC_ROW)).toBe(true);
  });

  it('labels the new FOLLOW / page-nav / DOUBLE / LENGTH pads at their columns', () => {
    expect(g.callouts.find((c) => c.label === 'FOLLOW')?.fromCol).toBe(FOLLOW_PAD.x);
    expect(g.callouts.find((c) => c.label === '◀')?.fromCol).toBe(PAGE_LEFT_PAD.x);
    expect(g.callouts.find((c) => c.label === '▶')?.fromCol).toBe(PAGE_RIGHT_PAD.x);
    expect(g.callouts.find((c) => c.label === 'x2')?.fromCol).toBe(DOUBLE_PAD.x);
    expect(g.callouts.find((c) => c.label === 'LEN')?.fromCol).toBe(LENGTH_EDIT_PAD.x);
    // every new pad has a cell on the function row.
    for (const p of [FOLLOW_PAD, PAGE_LEFT_PAD, PAGE_RIGHT_PAD, DOUBLE_PAD, LENGTH_EDIT_PAD]) {
      expect(g.cells.some((c) => c.x === p.x && c.y === p.y)).toBe(true);
    }
  });
  it('the caption documents pages + FOLLOW auto-scroll', () => {
    expect(g.caption.toLowerCase()).toContain('follow');
    expect(g.caption.toLowerCase()).toContain('page');
  });

  it('every callout points at a column inside the grid', () => {
    for (const c of g.callouts) {
      expect(c.fromCol).toBeGreaterThanOrEqual(0);
      expect(c.toCol ?? c.fromCol).toBeLessThan(GRID_WIDTH);
    }
  });
});

describe('clipLengthEditGrid', () => {
  it('matches the live grid dimensions', () => {
    const g = clipLengthEditGrid();
    expect(g.cols).toBe(GRID_WIDTH);
    expect(g.rows).toBe(GRID_HEIGHT);
  });
  it('renders a 2-row length editor with an EXIT pad on row 0', () => {
    const g = clipLengthEditGrid(48);
    // an EXIT side-label at the last column of row 0.
    expect(g.sideLabels?.find((s) => s.label === 'EXIT')).toMatchObject({ atX: GRID_WIDTH - 1, atY: 0 });
    // the END BLOCK callout brackets the 8-block row.
    expect(g.callouts.find((c) => c.label.startsWith('END BLOCK'))).toMatchObject({ fromCol: 0 });
  });
  it('every callout points at a column inside the grid', () => {
    for (const c of clipLengthEditGrid().callouts) {
      expect(c.fromCol).toBeGreaterThanOrEqual(0);
      expect(c.toCol ?? c.fromCol).toBeLessThan(GRID_WIDTH);
    }
  });
});
