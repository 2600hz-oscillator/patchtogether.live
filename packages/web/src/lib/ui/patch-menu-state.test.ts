// patch-menu-state.test.ts — unit coverage for the pure patch-menu reducer.

import { describe, it, expect } from 'vitest';
import {
  CLOSED,
  openFromTrigger,
  openFromJack,
  drillInto,
  back,
  clickPatchTo,
  commit,
  invalidDiscard,
  esc,
} from './patch-menu-state';

describe('patch-menu-state reducer', () => {
  it('openFromTrigger: root view, edge-aligned side, no cable', () => {
    const sLeft = openFromTrigger('left');
    expect(sLeft).toEqual({ open: true, view: { kind: 'root' }, side: 'left', carrying: false, cableHidden: false });
    const sRight = openFromTrigger('right');
    expect(sRight.side).toBe('right');
  });

  it('drillInto replaces the view IN PLACE (item 2 — no stacking)', () => {
    const s = openFromTrigger('left');
    const inputs = drillInto(s, { kind: 'inputs' });
    expect(inputs.view).toEqual({ kind: 'inputs' });
    expect(inputs.open).toBe(true);
    // The original root is gone — replaced, not stacked.
    const outputs = drillInto(inputs, { kind: 'outputs' });
    expect(outputs.view).toEqual({ kind: 'outputs' });
  });

  it('drillInto into a named section', () => {
    const s = openFromTrigger('right');
    const sec = drillInto(s, { kind: 'section', label: 'V1' });
    expect(sec.view).toEqual({ kind: 'section', label: 'V1' });
  });

  it('back returns to root in place, preserving side + carry', () => {
    const s = drillInto(openFromJack('right'), { kind: 'inputs' });
    const b = back(s);
    expect(b.view).toEqual({ kind: 'root' });
    expect(b.side).toBe('right');
    expect(b.carrying).toBe(true);
  });

  it('openFromJack starts carry mode with a visible cable + root view (item 4)', () => {
    const s = openFromJack('left');
    expect(s.carrying).toBe(true);
    expect(s.cableHidden).toBe(false);
    expect(s.view).toEqual({ kind: 'root' });
  });

  it('clickPatchTo hides the cable + shows the picker, retaining carry (item 4)', () => {
    const s = openFromJack('left');
    const after = clickPatchTo(s);
    expect(after.cableHidden).toBe(true);
    expect(after.carrying).toBe(true); // source/carry retained for commit
    expect(after.view).toEqual({ kind: 'picker' });
  });

  it('clickPatchTo is a no-op when not carrying', () => {
    const s = openFromTrigger('left');
    expect(clickPatchTo(s)).toEqual(s);
  });

  it('commit closes everything', () => {
    expect(commit()).toEqual(CLOSED);
  });

  it('invalidDiscard closes silently (terminal CLOSED, same shape as commit)', () => {
    expect(invalidDiscard()).toEqual(CLOSED);
  });

  it('esc discards + closes', () => {
    expect(esc()).toEqual(CLOSED);
  });

  it('drillInto / back are no-ops when closed', () => {
    expect(drillInto(CLOSED, { kind: 'inputs' })).toEqual(CLOSED);
    expect(back(CLOSED)).toEqual(CLOSED);
  });

  it('full carry flow: jack → patch-to → drill inputs → back → commit', () => {
    let s = openFromJack('right'); // cable dangles
    expect(s.carrying && !s.cableHidden).toBe(true);
    s = clickPatchTo(s); // cable hidden, picker shown
    expect(s.view).toEqual({ kind: 'picker' });
    s = drillInto(s, { kind: 'inputs' }); // drill into the target's inputs
    expect(s.view).toEqual({ kind: 'inputs' });
    s = back(s);
    expect(s.view).toEqual({ kind: 'root' });
    s = commit();
    expect(s).toEqual(CLOSED);
  });
});
