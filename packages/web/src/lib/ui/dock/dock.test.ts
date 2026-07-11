// packages/web/src/lib/ui/dock/dock.test.ts
//
// DOCKING — zone model + local store semantics (P1: bottom zone only).
// The store is a rune class (dock-store.svelte.ts) compiled by the svelte
// vitest plugin — same pattern as the audio-gate store tests.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  IMPLEMENTED_DOCK_ZONES,
  isImplementedDockZone,
  toggleDockedId,
  DEFAULT_DOCK_SCALE,
} from './dock';
import { dockStore } from './dock-store.svelte';

describe('dock zone model', () => {
  it('P1 implements exactly the bottom zone; the rest are typed-but-unimplemented', () => {
    expect(IMPLEMENTED_DOCK_ZONES).toEqual(['bottom']);
    expect(isImplementedDockZone('bottom')).toBe(true);
    expect(isImplementedDockZone('top')).toBe(false);
    expect(isImplementedDockZone('left')).toBe(false);
    expect(isImplementedDockZone('right')).toBe(false);
  });

  it('toggleDockedId: same id closes, different id replaces (single occupancy)', () => {
    expect(toggleDockedId(null, 'a')).toBe('a');
    expect(toggleDockedId('a', 'a')).toBeNull();
    expect(toggleDockedId('a', 'b')).toBe('b');
  });
});

describe('dockStore (local view state)', () => {
  beforeEach(() => {
    dockStore.closeAll();
  });

  it('toggle docks / re-toggle closes / other id replaces — one card per zone', () => {
    expect(dockStore.dockedNodeId('bottom')).toBeNull();
    dockStore.toggle('bottom', 'pinned-mixmstrs');
    expect(dockStore.dockedNodeId('bottom')).toBe('pinned-mixmstrs');
    expect(dockStore.anyOpen).toBe(true);
    // M then E: the electra drawer REPLACES the mixmstrs one (one at a time).
    dockStore.toggle('bottom', 'pinned-electraControl');
    expect(dockStore.dockedNodeId('bottom')).toBe('pinned-electraControl');
    // E again: closes.
    dockStore.toggle('bottom', 'pinned-electraControl');
    expect(dockStore.dockedNodeId('bottom')).toBeNull();
    expect(dockStore.anyOpen).toBe(false);
  });

  it('toggling an unimplemented zone is a no-op', () => {
    dockStore.toggle('left', 'pinned-clipplayer');
    expect(dockStore.dockedNodeId('left')).toBeNull();
    expect(dockStore.anyOpen).toBe(false);
  });

  it('close / closeAll clear occupancy', () => {
    dockStore.toggle('bottom', 'x');
    dockStore.close('bottom');
    expect(dockStore.dockedNodeId('bottom')).toBeNull();
    dockStore.toggle('bottom', 'y');
    dockStore.closeAll();
    expect(dockStore.anyOpen).toBe(false);
  });

  it('scale defaults to 1, is settable (no UI yet) and clamped', () => {
    expect(dockStore.scaleFor('bottom')).toBe(DEFAULT_DOCK_SCALE);
    dockStore.setScale('bottom', 2);
    expect(dockStore.scaleFor('bottom')).toBe(2);
    dockStore.setScale('bottom', 0.01);
    expect(dockStore.scaleFor('bottom')).toBe(0.25); // clamp floor
    dockStore.setScale('bottom', 99);
    expect(dockStore.scaleFor('bottom')).toBe(4); // clamp ceiling
    dockStore.setScale('bottom', Number.NaN);
    expect(dockStore.scaleFor('bottom')).toBe(4); // NaN ignored
    dockStore.setScale('bottom', 1);
    expect(dockStore.scaleFor('bottom')).toBe(1);
  });
});
