// packages/web/src/lib/ui/workflow/param-override-badges.test.ts
//
// The live-override badge registry (param-override-badges.ts): every entry is
// anchored to the ARTIFACT — a live def and a real ParamDef — so a module or
// param rename reddens here instead of orphaning the badge silently. The
// backdraft.delay entry's predicate is exercised against the REAL store in
// both directions (patched / unpatched / unrelated cable), because a predicate
// nobody negative-controls can go green-and-blind on edge-shape drift.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { paramOverrideBadge, paramOverrideEntries } from './param-override-badges';
import { NO_USER_CONTROL_WHY_MIN } from './no-user-control';
import { getVideoModuleDef } from '$lib/video/module-registry';
import { getModuleDef } from '$lib/audio/module-registry';
import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import { backdraftDelayClockPatched } from '$lib/ui/modules/backdraft-clocked-delay';
import type { Edge } from '$lib/graph/types';
import '$lib/video/modules';

function defFor(type: string) {
  return getVideoModuleDef(type) ?? getModuleDef(type as never);
}

function clearEdges(): void {
  for (const k of Object.keys(patch.edges)) delete patch.edges[k];
}

beforeEach(clearEdges);
afterEach(clearEdges);

describe('param-override-badges — the registry is anchored to live defs', () => {
  it('every entry names a live def, a real ParamDef, and carries a substantive why', () => {
    const entries = paramOverrideEntries();
    expect(entries.length, 'the registry is not inert').toBeGreaterThan(0);
    for (const { moduleType, paramId, entry } of entries) {
      const def = defFor(moduleType);
      expect(def, `'${moduleType}' resolves to a registered def`).toBeTruthy();
      expect(
        def!.params.some((p) => p.id === paramId),
        `'${moduleType}.${paramId}' is a real ParamDef`,
      ).toBe(true);
      expect(entry.badge.length, 'badge text present').toBeGreaterThan(0);
      expect(entry.title.length, 'title present').toBeGreaterThan(0);
      expect(entry.why.length, 'why is prose, not a token').toBeGreaterThan(NO_USER_CONTROL_WHY_MIN);
    }
  });

  it('backdraft.delay is registered and resolves; an unregistered pair is null', () => {
    expect(paramOverrideBadge('backdraft', 'delay')).not.toBeNull();
    expect(paramOverrideBadge('backdraft', 'mix')).toBeNull();
    expect(paramOverrideBadge('no-such-module', 'delay')).toBeNull();
  });
});

describe('backdraftDelayClockPatched — the shared predicate, on the real store', () => {
  const NID = 'bd-ovr-test';

  function addEdge(id: string, targetPort: string, targetNode = NID): void {
    ydoc.transact(() => {
      patch.edges[id] = {
        id,
        source: { nodeId: 'some-lfo', portId: 'out' },
        target: { nodeId: targetNode, portId: targetPort },
        sourceType: 'gate',
        targetType: 'cv',
      } as Edge;
    }, LOCAL_ORIGIN);
  }

  it('false on an empty graph; true iff a cable lands on delay_clock; false again on unpatch', () => {
    expect(backdraftDelayClockPatched(NID)).toBe(false);
    // NEGATIVE CONTROL, both directions: an unrelated port on the same node,
    // and the right port on a DIFFERENT node, must both stay false.
    addEdge('e-other-port', 'mix');
    addEdge('e-other-node', 'delay_clock', 'someone-else');
    expect(backdraftDelayClockPatched(NID)).toBe(false);
    addEdge('e-clk', 'delay_clock');
    expect(backdraftDelayClockPatched(NID)).toBe(true);
    ydoc.transact(() => { delete patch.edges['e-clk']; }, LOCAL_ORIGIN);
    expect(backdraftDelayClockPatched(NID)).toBe(false);
  });

  it('IS the registry entry\'s predicate — one source for both surfaces', () => {
    expect(paramOverrideBadge('backdraft', 'delay')!.isActive).toBe(backdraftDelayClockPatched);
  });
});
