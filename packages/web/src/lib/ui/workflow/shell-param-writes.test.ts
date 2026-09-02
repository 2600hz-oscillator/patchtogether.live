// packages/web/src/lib/ui/workflow/shell-param-writes.test.ts
//
// PF-13's registry. Small surface, but the WIRING is the whole thing: unhook
// `cloudseed.preset_index` and the shell silently falls back to writing one
// number, which is the shipped bug in a different disguise (the graph then
// holds a preset INDEX that names a space none of its other 45 values are in).
// So the clauses are (a) the entry exists on the pair that needs it, (b) it
// exists on NOTHING else — an override is a param whose write stops being the
// write every other param uses, and that must never spread by accident.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';
import { patch, ydoc, undoManager, LOCAL_ORIGIN } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import { SHELL_PARAM_WRITES, shellParamWrite, flushShellParamWrites } from './shell-param-writes';
import '$lib/audio/modules';
import '$lib/video/modules';

describe('SHELL_PARAM_WRITES — the macro-write registry', () => {
  it("cloudseed's preset_index is overridden (the whole-space recall)", () => {
    expect(typeof shellParamWrite('cloudseed', 'preset_index')).toBe('function');
  });

  it("mappy's surfaceCount and showGrid are overridden (the write SHAPE, not the number)", () => {
    // Raising `surfaceCount` must also drop each newly-live surface in as a
    // staggered inset quad — `addSurface`'s job. A bare `setNodeParam` would
    // leave every added surface at the full-frame UNIT_QUAD stacked exactly on
    // the one below it: a control that appears to do nothing while the value
    // moves correctly. `showGrid` is routed for SYMMETRY (it writes the same
    // param either way) so all three surfaces commit through one function.
    expect(typeof shellParamWrite('mappy', 'surfaceCount')).toBe('function');
    expect(typeof shellParamWrite('mappy', 'showGrid')).toBe('function');
  });

  it('nothing else is overridden — an override is not the default', () => {
    const pairs = Object.entries(SHELL_PARAM_WRITES).flatMap(([type, m]) =>
      Object.keys(m).map((pid) => `${type}.${pid}`),
    );
    expect(pairs.sort()).toEqual([
      'cloudseed.preset_index',
      'mappy.showGrid',
      'mappy.surfaceCount',
    ]);
  });

  it('an unlisted param / module falls through to the normal setter (null)', () => {
    expect(shellParamWrite('cloudseed', 'late_out')).toBeNull();
    expect(shellParamWrite('reverb', 'preset_index')).toBeNull();
    expect(shellParamWrite('not-a-module', 'preset_index')).toBeNull();
    expect(shellParamWrite('mappy', 'nope')).toBeNull();
  });

  it('every override key names a REAL param on a REAL module', () => {
    // An override on a renamed/typo'd param is a silent no-op that reads like a
    // shipped decision — the same trap `face.paramCells` is linted for.
    //
    // ⚠ ALL THREE REGISTRIES, and the widening is a repair rather than a
    // precaution. This walked `listModuleDefs()` alone — the AUDIO registry —
    // for as long as the only entry was an audio module, so the first VIDEO
    // override (mappy, 2026-09-01) reported "not a registered module" for a
    // perfectly real def. The gate would have failed OPEN in the other
    // direction just as easily: a typo'd video param id could never have been
    // caught, because the whole module was already unknown to it.
    const defs = new Map(
      ([
        ...listModuleDefs(),
        ...listVideoModuleDefs(),
        ...listMetaModuleDefs(),
      ] as unknown as { type: string; params?: { id: string }[] }[]).map((d) => [
        d.type,
        new Set((d.params ?? []).map((p) => p.id)),
      ]),
    );
    const bad: string[] = [];
    for (const [type, m] of Object.entries(SHELL_PARAM_WRITES)) {
      const ids = defs.get(type);
      if (!ids) { bad.push(`${type}: not a registered module`); continue; }
      for (const pid of Object.keys(m)) {
        if (!ids.has(pid)) bad.push(`${type}.${pid}: not a declared param`);
      }
    }
    expect(bad).toEqual([]);
  });
});

// ── THE WIRING, against the REAL Y.Doc ───────────────────────────────────────
//
// The registry test above proves an override EXISTS. It cannot prove the
// override still works once `preset_index` moves by a path the guard did not
// author — and that gap hid a total no-op: the storm guard deduped against its
// own page-lifetime memory of the last slot it committed, so after an undo (or
// a rack-mate's edit, or a rack load) clicking the segment whose value matched
// that memory did NOTHING AT ALL. Only a live graph can show it, so this block
// drives the real seam against the real store, exactly as the dx7 stamp tests do.

const NID = 'cloudseed-write-test';

function makeCloudseed(presetIndex = 0): void {
  ydoc.transact(() => {
    patch.nodes[NID] = {
      id: NID,
      type: 'cloudseed',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: { preset_index: presetIndex },
      data: {},
    } as ModuleNode;
  }, LOCAL_ORIGIN);
  undoManager.clear();
  undoManager.stopCapturing();
}

const liveParams = (): Record<string, number> =>
  (patch.nodes[NID] as ModuleNode).params as Record<string, number>;

describe('the cloudseed preset override, against the LIVE graph', () => {
  beforeEach(() => {
    flushShellParamWrites();
    for (const id of Object.keys(patch.nodes)) delete patch.nodes[id];
    undoManager.clear();
    undoManager.stopCapturing();
  });
  afterEach(() => {
    flushShellParamWrites();
    for (const id of Object.keys(patch.nodes)) delete patch.nodes[id];
    undoManager.clear();
  });

  const pick = (slot: number) => {
    shellParamWrite('cloudseed', 'preset_index')!(NID, slot);
    flushShellParamWrites(); // stand in for the 80 ms settle window closing
  };

  it('a pick stamps the WHOLE space, not just the index', () => {
    makeCloudseed(0);
    pick(1);
    expect(liveParams().preset_index).toBe(1);
    expect(
      Object.keys(liveParams()).length,
      'a recall that writes only the index leaves the other 45 values stale',
    ).toBeGreaterThan(40);
  });

  it('RE-PICKING a slot the graph left behind still lands (the undo case)', () => {
    // The reproduced sequence, verbatim: pick slot 1 → undo → click slot 1
    // again. Before the fix `preset_index` stayed 0 and nothing happened.
    makeCloudseed(0);
    pick(1);
    const afterFirst = { ...liveParams() };
    expect(afterFirst.preset_index).toBe(1);

    undoManager.undo(); // ⌘Z — one step, because the recall is one transaction
    expect(liveParams().preset_index, 'undo really did move the graph').toBe(0);

    pick(1); // the user clicks `short room` again
    expect(liveParams().preset_index, 'the re-pick was swallowed').toBe(1);
    expect(liveParams(), 'and the whole space came back with it').toEqual(afterFirst);
  });

  it('a pick of the slot the graph ALREADY holds writes nothing', () => {
    // The other side of the same dedupe: reality-based, so a genuine repeat is
    // still dropped and the 46-key transaction storm is still guarded.
    makeCloudseed(0);
    pick(2);
    const marker = 12345;
    ydoc.transact(() => { liveParams().late_line_decay = marker; }, LOCAL_ORIGIN);
    pick(2); // same slot, nothing moved it since
    expect(liveParams().late_line_decay, 'a redundant pick must not re-stamp').toBe(marker);
  });
});
