// packages/web/src/lib/ui/dock/dock.test.ts
//
// DOCKING — zone model + local store semantics (P2.5a: three zones — top
// rail, LEFT rail, bottom drawer — per-entry dock state with TOMBSTONE GC,
// per-card discrete zoom, rackspace-scoped persistence). The store is a
// rune class (dock-store.svelte.ts) compiled by the svelte vitest plugin.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  IMPLEMENTED_DOCK_ZONES,
  isImplementedDockZone,
  toggleDockedId,
} from './dock';
import {
  ZOOM_STEPS,
  clampScaleToStep,
  stepScale,
  parsePersistedDockState,
  DOCK_STORAGE_PREFIX,
  DRAWER_HEIGHT_STEPS,
  DRAWER_HEIGHT_MIN_PX,
  drawerCeilingPx,
  drawerHeightPx,
  drawerStepFor,
  nextDrawerStep,
} from './dock-entries';
import { DOCKABLE_TYPES, isDockableType } from './dockable';
import { dockStore, type DockStorage } from './dock-store.svelte';

/** Map-backed localStorage shim (node env). */
function memStorage(): DockStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

describe('dock zone model', () => {
  it('P2.5a implements top + left + bottom (owner Q5: three zones in v1)', () => {
    expect(IMPLEMENTED_DOCK_ZONES).toEqual(['bottom', 'top', 'left']);
    expect(isImplementedDockZone('bottom')).toBe(true);
    expect(isImplementedDockZone('top')).toBe(true);
    expect(isImplementedDockZone('left')).toBe(true);
    expect(isImplementedDockZone('right')).toBe(false);
  });

  it('toggleDockedId: same id closes, different id replaces (single occupancy)', () => {
    expect(toggleDockedId(null, 'a')).toBe('a');
    expect(toggleDockedId('a', 'a')).toBeNull();
    expect(toggleDockedId('a', 'b')).toBe('b');
  });
});

describe('discrete zoom ladder (50–150% in 25% steps)', () => {
  it('the ladder is exactly the owner-approved band', () => {
    expect(ZOOM_STEPS).toEqual([0.5, 0.75, 1, 1.25, 1.5]);
  });

  it('clampScaleToStep snaps arbitrary values onto the ladder', () => {
    expect(clampScaleToStep(1)).toBe(1);
    expect(clampScaleToStep(0.9)).toBe(1); // nearest — ties round toward the earlier step
    expect(clampScaleToStep(0.8)).toBe(0.75);
    expect(clampScaleToStep(0.1)).toBe(0.5); // clamp floor
    expect(clampScaleToStep(9)).toBe(1.5); // clamp ceiling
    expect(clampScaleToStep(Number.NaN)).toBe(1); // garbage → default
  });

  it('stepScale walks the ladder and clamps at both ends', () => {
    expect(stepScale(1, 1)).toBe(1.25);
    expect(stepScale(1.25, 1)).toBe(1.5);
    expect(stepScale(1.5, 1)).toBe(1.5); // ceiling
    expect(stepScale(1, -1)).toBe(0.75);
    expect(stepScale(0.5, -1)).toBe(0.5); // floor
  });
});

describe('dockable allowlist (control-first + scope, workflow-only gating in Canvas)', () => {
  it('includes the knob/fader-heavy control set + scope', () => {
    for (const t of ['mixer', 'mixmstrs', 'matrixMix', 'adsr', 'kria', 'cartesian', 'controlSurface', 'fader', 'scope']) {
      expect(isDockableType(t), t).toBe(true);
    }
  });

  it('excludes the audited hazards: WebGL-basis cards, Handle-in-body cards, roaming/free-form cards', () => {
    for (const t of ['wavesculpt', 'cube', 'foxy', 'bentbox', 'b3ntb0x', 'cadillac', 'sticky', 'group', 'toybox']) {
      expect(isDockableType(t), t).toBe(false);
    }
    expect(isDockableType(null)).toBe(false);
    expect(isDockableType(undefined)).toBe(false);
  });

  it('the allowlist stays deliberate — every entry is a known type id string', () => {
    for (const t of DOCKABLE_TYPES) expect(typeof t).toBe('string');
  });
});

describe('dockStore — pinned drawer occupancy (P1 semantics preserved)', () => {
  beforeEach(() => {
    dockStore.__setStorageForTest(memStorage());
    dockStore.bind('test-rack');
  });

  it('toggle docks / re-toggle closes / other id replaces — one pinned card per zone', () => {
    expect(dockStore.dockedNodeId('bottom')).toBeNull();
    dockStore.toggle('bottom', 'pinned-mixmstrs');
    expect(dockStore.dockedNodeId('bottom')).toBe('pinned-mixmstrs');
    expect(dockStore.anyOpen).toBe(true);
    dockStore.toggle('bottom', 'pinned-electraControl');
    expect(dockStore.dockedNodeId('bottom')).toBe('pinned-electraControl');
    dockStore.toggle('bottom', 'pinned-electraControl');
    expect(dockStore.dockedNodeId('bottom')).toBeNull();
    expect(dockStore.anyOpen).toBe(false);
  });

  it('toggling an unimplemented zone is a no-op', () => {
    dockStore.toggle('right', 'pinned-clipplayer');
    expect(dockStore.dockedNodeId('right')).toBeNull();
  });

  it('close / closeAll clear occupancy; bind() starts with a clean drawer', () => {
    dockStore.toggle('bottom', 'x');
    dockStore.close('bottom');
    expect(dockStore.dockedNodeId('bottom')).toBeNull();
    dockStore.toggle('bottom', 'y');
    dockStore.bind('test-rack'); // remount — drawer occupancy is transient
    expect(dockStore.anyOpen).toBe(false);
  });
});

describe('dockStore — P2.5a entries, zoom, ordering', () => {
  beforeEach(() => {
    dockStore.__setStorageForTest(memStorage());
    dockStore.bind('rack-a');
  });

  it('dock/undock round-trip returns the restorePosition captured at dock time', () => {
    dockStore.dock('n1', 'left', { x: 120, y: 340 });
    expect(dockStore.isDocked('n1')).toBe(true);
    expect(dockStore.entryFor('n1')).toMatchObject({
      zone: 'left',
      scale: 1,
      restorePosition: { x: 120, y: 340 },
    });
    const removed = dockStore.undock('n1');
    expect(removed?.restorePosition).toEqual({ x: 120, y: 340 });
    expect(dockStore.isDocked('n1')).toBe(false);
    expect(dockStore.undock('n1')).toBeNull(); // idempotent
  });

  it('zone lists come back order-ascending; re-dock MOVES zones keeping scale + restorePosition', () => {
    dockStore.dock('a', 'top', { x: 0, y: 0 });
    dockStore.dock('b', 'top', { x: 1, y: 1 });
    dockStore.dock('c', 'left', { x: 2, y: 2 });
    expect(dockStore.entriesFor('top').map((e) => e.nodeId)).toEqual(['a', 'b']);
    expect(dockStore.entriesFor('left').map((e) => e.nodeId)).toEqual(['c']);
    dockStore.setScaleOf('a', 1.5);
    dockStore.dock('a', 'left', { x: 999, y: 999 }); // move — NOT a fresh entry
    expect(dockStore.entriesFor('top').map((e) => e.nodeId)).toEqual(['b']);
    expect(dockStore.entriesFor('left').map((e) => e.nodeId)).toEqual(['c', 'a']);
    expect(dockStore.entryFor('a')).toMatchObject({
      scale: 1.5,
      restorePosition: { x: 0, y: 0 }, // original dock-time position kept
    });
  });

  it('per-entry zoom: steps clamp to the 50–150% ladder; reset via setScaleOf(1)', () => {
    dockStore.dock('n', 'top', { x: 0, y: 0 });
    dockStore.stepScaleOf('n', 1);
    dockStore.stepScaleOf('n', 1);
    expect(dockStore.scaleOf('n')).toBe(1.5);
    dockStore.stepScaleOf('n', 1);
    expect(dockStore.scaleOf('n')).toBe(1.5); // ceiling holds
    for (let i = 0; i < 8; i++) dockStore.stepScaleOf('n', -1);
    expect(dockStore.scaleOf('n')).toBe(0.5); // floor holds
    dockStore.setScaleOf('n', 1);
    expect(dockStore.scaleOf('n')).toBe(1);
    // Garbage never lands off-ladder.
    dockStore.setScaleOf('n', 7.3);
    expect(dockStore.scaleOf('n')).toBe(1.5);
  });

  it('pinned occupants (no entry) get a per-node scale through the same API', () => {
    expect(dockStore.scaleOf('pinned-mixmstrs')).toBe(1);
    dockStore.stepScaleOf('pinned-mixmstrs', -1);
    expect(dockStore.scaleOf('pinned-mixmstrs')).toBe(0.75);
  });
});

describe('dockStore — tombstone GC (the quicksave slot-switch scenario)', () => {
  beforeEach(() => {
    dockStore.__setStorageForTest(memStorage());
    dockStore.bind('rack-a');
  });

  const live = (...ids: string[]) => new Set(ids);

  it('slot switch round-trip: absent → RETIRED (not wiped) → REVIVED when the id returns', () => {
    // The verifier's exact failure case for naive pruning: quickload swaps
    // the whole node set; a prune-on-absence would wipe the dock state.
    dockStore.dock('mix-1', 'left', { x: 50, y: 60 });
    dockStore.setScaleOf('mix-1', 1.25);

    // Slot 2 loads: a different patch, mix-1 absent — several commits pass.
    dockStore.sweep(live('other-a', 'other-b'));
    expect(dockStore.isDocked('mix-1')).toBe(false); // retired, not rendered
    expect(dockStore.tombstoneCount).toBe(1);
    dockStore.sweep(live('other-a'));
    dockStore.sweep(live('other-a', 'other-c'));
    expect(dockStore.tombstoneCount).toBe(1); // aging, still held

    // Slot 1 reloads: mix-1 is back (quicksave/quickload keep node ids).
    dockStore.sweep(live('mix-1', 'other-z'));
    expect(dockStore.isDocked('mix-1')).toBe(true);
    expect(dockStore.entryFor('mix-1')).toMatchObject({
      zone: 'left',
      scale: 1.25,
      restorePosition: { x: 50, y: 60 },
    });
    expect(dockStore.tombstoneCount).toBe(0);
  });

  it('the revive survives a RELOAD between the switches (persisted tombstones)', () => {
    const storage = memStorage();
    dockStore.__setStorageForTest(storage);
    dockStore.bind('rack-a');
    dockStore.dock('mix-1', 'top', { x: 5, y: 6 });
    dockStore.sweep(live('unrelated')); // retire
    expect(storage.map.get(DOCK_STORAGE_PREFIX + 'rack-a')).toContain('mix-1');

    dockStore.bind('rack-a'); // simulated reload (same rackspace key)
    expect(dockStore.tombstoneCount).toBe(1);
    dockStore.sweep(live('mix-1'));
    expect(dockStore.entryFor('mix-1')).toMatchObject({ zone: 'top' });
  });

  // ⚠ 'peer-grouped nodes are EVICTED (hard) and reported for the toast' IS
  // DELETED WITH ITS SUBJECT. `sweep` took a second `groupedIds` set and
  // hard-dropped (no tombstone, no revive) any docked node a peer had folded
  // into a COLLAPSED GROUP, because such a node had no canvas presence left to
  // stub; Canvas toasted the returned ids. The GROUP! module is deleted, so
  // nothing can produce that state, the parameter is removed rather than left
  // permanently empty, and `sweep` no longer returns anything.

  it('an explicit LOCAL delete hard-drops entry + tombstone (never revives)', () => {
    dockStore.dock('doomed', 'bottom', { x: 0, y: 0 });
    expect(dockStore.noteExplicitDelete(['doomed', 'not-docked'])).toEqual(['doomed']);
    expect(dockStore.isDocked('doomed')).toBe(false);
    // Even if the id reappears (fresh module reusing an id), no revive:
    dockStore.sweep(live('doomed'));
    expect(dockStore.isDocked('doomed')).toBe(false);
  });

  it('tombstones hard-drop by age (bounded) and by cap (oldest-absent first)', () => {
    dockStore.dock('old', 'top', { x: 0, y: 0 });
    dockStore.sweep(live()); // retire
    for (let i = 0; i <= 400; i++) dockStore.sweep(live());
    expect(dockStore.tombstoneCount).toBe(0); // aged out past the budget

    // Cap: 70 retired entries collapse to the newest 64.
    for (let i = 0; i < 70; i++) dockStore.dock(`n${i}`, 'top', { x: i, y: i });
    dockStore.sweep(live());
    expect(dockStore.tombstoneCount).toBe(64);
  });

  it('dock state is scoped per rackspace key', () => {
    const storage = memStorage();
    dockStore.__setStorageForTest(storage);
    dockStore.bind('rack-a');
    dockStore.dock('n1', 'left', { x: 1, y: 2 });
    dockStore.bind('rack-b');
    expect(dockStore.isDocked('n1')).toBe(false);
    dockStore.bind('rack-a');
    expect(dockStore.entryFor('n1')).toMatchObject({ zone: 'left' });
  });

  it('corrupt persisted payloads degrade to a clean empty state', () => {
    expect(parsePersistedDockState('{{{nope')).toEqual({
      entries: {},
      tombstones: {},
      railSize: {},
      railCollapsed: {},
    });
    expect(parsePersistedDockState(JSON.stringify({ entries: { bad: { zone: 'weird' } } })).entries).toEqual({});
    expect(
      parsePersistedDockState(
        JSON.stringify({ entries: { ok: { zone: 'top', order: 0, scale: 1.25, restorePosition: { x: 1, y: 2 } } } }),
      ).entries.ok,
    ).toMatchObject({ zone: 'top', scale: 1.25 });
  });
});

// ── THE DRAWER HEIGHT LADDER (#1767) ───────────────────────────────────────
//
// The owner's two hard requirements on this control are "persist it" and
// "functional parity at every reachable size". The first is met by writing the
// SAME `railSize` the grabber writes (asserted in the store clauses above); the
// second is a property of the LADDER, and this is where it is held.
describe('drawer height ladder (#1767)', () => {
  const VH = 900;

  it('the ceiling mirrors the stylesheet: min(48vh, 620px), both arms', () => {
    // `.dock-rail-bottom { max-height: min(48vh, 620px) }`. A ladder resolving
    // against a ceiling CSS disagrees with would produce steps the drawer
    // silently refuses.
    expect(drawerCeilingPx(900), '48vh wins on a laptop').toBeCloseTo(432, 5);
    expect(drawerCeilingPx(2000), 'the 620px cap wins on a tall panel').toBe(620);
  });

  it('every step is REACHABLE and STRICTLY ORDERED, so the cycle is not a no-op', () => {
    const px = DRAWER_HEIGHT_STEPS.map((s) => drawerHeightPx(s.id, VH));
    for (let i = 1; i < px.length; i++) {
      expect(px[i]!, `${DRAWER_HEIGHT_STEPS[i]!.id} must be taller than ${DRAWER_HEIGHT_STEPS[i - 1]!.id}`)
        .toBeGreaterThan(px[i - 1]!);
    }
    expect(new Set(px).size, 'no two steps may resolve to the same height').toBe(px.length);
  });

  it('⚠ NO reachable step can collapse the drawer — the parity floor', () => {
    // `DockRail`'s grabber collapses below SNAP_COLLAPSE_PX (80). A ladder step
    // under that would let the button put the drawer into a state the button
    // itself is then hidden by. Checked at a deliberately CRUEL viewport.
    for (const vh of [400, 600, 900, 1440, 2160]) {
      for (const s of DRAWER_HEIGHT_STEPS) {
        expect(
          drawerHeightPx(s.id, vh),
          `step ${s.id} at ${vh}px viewport must stay above the collapse threshold`,
        ).toBeGreaterThanOrEqual(DRAWER_HEIGHT_MIN_PX);
      }
    }
  });

  it('the label READS the drawer — a grabber drag leaves it telling the truth', () => {
    for (const s of DRAWER_HEIGHT_STEPS) {
      expect(drawerStepFor(drawerHeightPx(s.id, VH), VH), `${s.id} round-trips`).toBe(s.id);
    }
    // An off-ladder height (a free drag) resolves to its NEAREST step rather
    // than to a remembered index.
    const mid = (drawerHeightPx('S', VH) + drawerHeightPx('M', VH)) / 2;
    expect(['S', 'M']).toContain(drawerStepFor(mid + 1, VH));
    // No stored size yet = the CSS default, i.e. the ceiling.
    expect(drawerStepFor(null, VH)).toBe('XL');
  });

  it('ONE control reaches EVERY size: the cycle wraps and visits all steps', () => {
    // The owner asked for one control, so "you can only go up" would be a
    // trap. Walking the cycle from any start must enumerate the whole ladder.
    let px: number | null = drawerHeightPx('S', VH);
    const seen: string[] = [];
    for (let i = 0; i < DRAWER_HEIGHT_STEPS.length; i++) {
      const next = nextDrawerStep(px, VH);
      seen.push(next);
      px = drawerHeightPx(next, VH);
    }
    expect(seen.slice().sort()).toEqual(DRAWER_HEIGHT_STEPS.map((s) => s.id).slice().sort());
    expect(seen[seen.length - 1], 'and it returns to where it started').toBe('S');
  });

  it('NEGATIVE CONTROL: an unknown step id falls back rather than producing NaN', () => {
    // The label is derived from a live measurement, so a stale/garbage id is
    // reachable in principle; a NaN height would blank the drawer.
    const px = drawerHeightPx('not-a-step', VH);
    expect(Number.isFinite(px)).toBe(true);
    expect(px).toBe(drawerHeightPx(DRAWER_HEIGHT_STEPS[0]!.id, VH));
  });
});
