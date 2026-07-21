// packages/web/src/lib/graph/column-reconcile.test.ts
//
// REAL-Y.Doc tests for the workflow channel-columns RECONCILER APPLICATOR. Run
// against the live syncedStore + Y.Doc (graph/store.ts) + the live audio module
// registry, so the wcol- edge writes exercise the real ports of mixmstrs /
// clipplayer / tidyVco. Proves the collab-critical properties:
//   * the drop wires clip-control + send-to-mixer under wcol- ids;
//   * IDEMPOTENCE — a second reconcile writes nothing;
//   * DELETE-HEAL — removing a member prunes its wcol edges + relinks;
//   * YIELD — a hand cable on a managed target port makes the reconciler back off;
//   * validateEdge safety — a bogus member id is dropped, not fatal;
//   * membership ADOPT — a node with data.channel but missing from the order
//     array is adopted at the bottom.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '$lib/audio/modules';
import { patch, ydoc, LOCAL_ORIGIN } from './store';
import type { Edge, ModuleNode } from './types';
import { getModuleDef } from '$lib/audio/module-registry';
import {
  reconcileColumns,
  reconcileColumnWiring,
  reconcileColumnMembership,
  PINNED_MIXER_ID,
  PINNED_CLIP_ID,
  type ColumnDefResolver,
} from './column-reconcile';

const resolveDef: ColumnDefResolver = (t) => getModuleDef(t) as never;

function addNode(id: string, type: string, data?: Record<string, unknown>): void {
  ydoc.transact(() => {
    patch.nodes[id] = { id, type, domain: 'audio', position: { x: 0, y: 0 }, params: {}, data: data ?? {} } as ModuleNode;
  }, LOCAL_ORIGIN);
}

function setColumn(ch: number, ids: string[]): void {
  ydoc.transact(() => {
    const m = patch.nodes[PINNED_MIXER_ID] as ModuleNode;
    if (!m.data) m.data = {};
    const d = m.data as { columns?: Record<string, string[]> };
    if (!d.columns) d.columns = {};
    d.columns[String(ch)] = ids;
  }, LOCAL_ORIGIN);
}

function wcolEdges(): Edge[] {
  return (Object.entries(patch.edges) as [string, Edge][])
    .filter(([id, e]) => e && id.startsWith('wcol-e-'))
    .map(([, e]) => e);
}

beforeEach(() => {
  for (const id of Object.keys(patch.nodes)) delete patch.nodes[id];
  for (const id of Object.keys(patch.edges)) delete patch.edges[id];
  // The always-on pinned singletons the columns anchor to.
  addNode(PINNED_MIXER_ID, 'mixmstrs', { pinned: true });
  addNode(PINNED_CLIP_ID, 'clipplayer', { pinned: true });
});

afterEach(() => {
  for (const id of Object.keys(patch.nodes)) delete patch.nodes[id];
  for (const id of Object.keys(patch.edges)) delete patch.edges[id];
});

describe('reconcileColumns — a single tidyVco on channel 1', () => {
  beforeEach(() => {
    addNode('vco1', 'tidyVco', { channel: 1 });
    setColumn(1, ['vco1']);
  });

  it('wires clip poly control + stereo send-to-mixer under wcol- ids', () => {
    reconcileColumns(resolveDef);
    const ids = new Set(wcolEdges().map((e) => e.id));
    // clip: pitch1 (polyPitchGate) → vco1.poly
    expect(ids.has('wcol-e-pinned-clipplayer-pitch1-vco1-poly')).toBe(true);
    // tail send: out_l → ch1L, out_r → ch1R
    expect(ids.has('wcol-e-vco1-out_l-pinned-mixmstrs-ch1L')).toBe(true);
    expect(ids.has('wcol-e-vco1-out_r-pinned-mixmstrs-ch1R')).toBe(true);
    // Every managed edge is wcol-namespaced.
    for (const e of wcolEdges()) expect(e.id.startsWith('wcol-e-')).toBe(true);
  });

  it('is IDEMPOTENT — a second wiring reconcile writes nothing', () => {
    reconcileColumns(resolveDef);
    const before = wcolEdges().length;
    const wrote = reconcileColumnWiring(resolveDef); // second pass
    expect(wrote).toBe(false);
    expect(wcolEdges().length).toBe(before);
  });

  it('DELETE-HEAL — removing the member prunes its wcol edges', () => {
    reconcileColumns(resolveDef);
    expect(wcolEdges().length).toBeGreaterThan(0);
    // User deletes the module: node gone + membership cleared.
    ydoc.transact(() => {
      delete patch.nodes['vco1'];
    }, LOCAL_ORIGIN);
    setColumn(1, []); // membership heal would also do this
    reconcileColumns(resolveDef);
    expect(wcolEdges().length).toBe(0);
  });

  it('YIELD is ALL-OR-NOTHING per stereo pair — a hand cable on ch1L yields the WHOLE send pair (MAJOR 2)', () => {
    // A deliberate hand-drawn (non-wcol) cable into ONE side of the managed
    // stereo target. The whole managed send pair must back off — never a broken
    // split image where only ch1R stays wcol-managed.
    ydoc.transact(() => {
      patch.edges['hand-1'] = {
        id: 'hand-1',
        source: { nodeId: 'vco1', portId: 'out_l' },
        target: { nodeId: PINNED_MIXER_ID, portId: 'ch1L' },
        sourceType: 'audio', targetType: 'audio',
      };
    }, LOCAL_ORIGIN);
    reconcileColumns(resolveDef);
    const ids = new Set(wcolEdges().map((e) => e.id));
    // The hand cable survives; NEITHER side of the wcol send pair is managed.
    expect(patch.edges['hand-1']).toBeTruthy();
    expect(ids.has('wcol-e-vco1-out_l-pinned-mixmstrs-ch1L')).toBe(false);
    expect(ids.has('wcol-e-vco1-out_r-pinned-mixmstrs-ch1R')).toBe(false);
  });

  it('DURABLE REMOVAL — a user-detached wcol edge is NOT re-added, and its stereo sibling yields too (MAJOR 1)', () => {
    reconcileColumns(resolveDef);
    // The managed send pair exists.
    expect(new Set(wcolEdges().map((e) => e.id)).has('wcol-e-vco1-out_l-pinned-mixmstrs-ch1L')).toBe(true);
    // User deletes ONE side + records the durable detach (as the Canvas seam does).
    ydoc.transact(() => {
      delete patch.edges['wcol-e-vco1-out_l-pinned-mixmstrs-ch1L'];
      const m = patch.nodes[PINNED_MIXER_ID]!;
      const d = m.data as { wcolDetached?: Record<string, string[]> };
      if (!d.wcolDetached) d.wcolDetached = {};
      d.wcolDetached['1'] = ['wcol-e-vco1-out_l-pinned-mixmstrs-ch1L'];
    }, LOCAL_ORIGIN);
    reconcileColumns(resolveDef);
    const ids = new Set(wcolEdges().map((e) => e.id));
    // Neither side snaps back (all-or-nothing + durable suppression).
    expect(ids.has('wcol-e-vco1-out_l-pinned-mixmstrs-ch1L')).toBe(false);
    expect(ids.has('wcol-e-vco1-out_r-pinned-mixmstrs-ch1R')).toBe(false);
    // Clearing the suppression (a fresh column edit) re-manages the pair.
    ydoc.transact(() => {
      const d = patch.nodes[PINNED_MIXER_ID]!.data as { wcolDetached?: Record<string, string[]> };
      d.wcolDetached!['1'] = [];
    }, LOCAL_ORIGIN);
    reconcileColumns(resolveDef);
    const ids2 = new Set(wcolEdges().map((e) => e.id));
    expect(ids2.has('wcol-e-vco1-out_l-pinned-mixmstrs-ch1L')).toBe(true);
    expect(ids2.has('wcol-e-vco1-out_r-pinned-mixmstrs-ch1R')).toBe(true);
  });
});

describe('MULTI-SOURCE parallel islands (BLOCKER) — both instruments driven + both audible', () => {
  it('two tidyVcos in one channel: BOTH get clip control AND BOTH send (sum at ch bus)', () => {
    addNode('vcoA', 'tidyVco', { channel: 5 });
    addNode('vcoB', 'tidyVco', { channel: 5 });
    setColumn(5, ['vcoA', 'vcoB']);
    reconcileColumns(resolveDef);
    const ids = new Set(wcolEdges().map((e) => e.id));
    // BOTH sources are clip-driven (layered).
    expect(ids.has('wcol-e-pinned-clipplayer-pitch5-vcoA-poly')).toBe(true);
    expect(ids.has('wcol-e-pinned-clipplayer-pitch5-vcoB-poly')).toBe(true);
    // BOTH tails send to ch5 (they sum at the mixer input bus).
    expect(ids.has('wcol-e-vcoA-out_l-pinned-mixmstrs-ch5L')).toBe(true);
    expect(ids.has('wcol-e-vcoB-out_l-pinned-mixmstrs-ch5L')).toBe(true);
    // No spurious chain link between the two independent sources.
    expect([...ids].some((id) => id.startsWith('wcol-e-vcoA-') && id.includes('vcoB'))).toBe(false);
  });
});

describe('AUTOMATION-LANE heal (MAJOR 3) — non-drag membership still binds the lane', () => {
  it('a member whose data.channel arrives WITHOUT a drag (paste/import) gets its lane on reconcile', () => {
    // Simulate a paste: node carries data.channel + is in the column order, but
    // NO automation assignment exists on the clip player (autoAssign is not on
    // the node's own data).
    addNode('pasted', 'tidyVco', { channel: 6 });
    setColumn(6, ['pasted']);
    // Precondition: no lane yet.
    const before = page_autoAssign();
    expect(before['pasted']).toBeUndefined();
    reconcileColumns(resolveDef);
    const after = page_autoAssign();
    expect(after['pasted']).toBe(5); // channel 6 → lane 5 (0-based)
  });
});

/** The clip player's autoAssign map. */
function page_autoAssign(): Record<string, number> {
  const d = patch.nodes[PINNED_CLIP_ID]?.data as { autoAssign?: Record<string, number> } | undefined;
  return d?.autoAssign ?? {};
}

describe('reconcileColumns — chain + heal', () => {
  it('VCO → reverb chain: internal link + ONLY the tail sends; drop reverb re-links VCO', () => {
    addNode('vco1', 'tidyVco', { channel: 2 });
    addNode('rev1', 'reverb', { channel: 2 });
    setColumn(2, ['vco1', 'rev1']);
    reconcileColumns(resolveDef);
    let ids = new Set(wcolEdges().map((e) => e.id));
    // internal: vco1.out_l/out_r → reverb.in (reverb is the downstream); tail =
    // reverb → mixer ch2. The VCO must NOT send directly to the mixer.
    expect([...ids].some((id) => id.startsWith('wcol-e-rev1-') && id.includes('-pinned-mixmstrs-ch2'))).toBe(true);
    expect([...ids].some((id) => id.startsWith('wcol-e-vco1-') && id.includes('-pinned-mixmstrs-ch2'))).toBe(false);
    // Now drop the reverb → the VCO becomes the tail and sends to the mixer.
    ydoc.transact(() => { delete patch.nodes['rev1']; }, LOCAL_ORIGIN);
    setColumn(2, ['vco1']);
    reconcileColumns(resolveDef);
    ids = new Set(wcolEdges().map((e) => e.id));
    expect([...ids].some((id) => id.startsWith('wcol-e-rev1-'))).toBe(false); // reverb edges gone
    expect(ids.has('wcol-e-vco1-out_l-pinned-mixmstrs-ch2L')).toBe(true); // vco now the tail
  });
});

describe('membership heal + validate safety', () => {
  it('ADOPTS a node with data.channel that is missing from the order array', () => {
    addNode('vco1', 'tidyVco', { channel: 3 });
    // Note: columns[3] deliberately NOT set (a lost concurrent append).
    const wrote = reconcileColumnMembership();
    expect(wrote).toBe(true);
    const cols = (patch.nodes[PINNED_MIXER_ID]!.data as { columns: Record<string, string[]> }).columns;
    expect(cols['3']).toEqual(['vco1']);
  });

  it('a bogus member id in the order array is dropped, not fatal', () => {
    addNode('vco1', 'tidyVco', { channel: 4 });
    setColumn(4, ['ghost-does-not-exist', 'vco1']);
    expect(() => reconcileColumns(resolveDef)).not.toThrow();
    // The real member still wired despite the ghost id.
    const ids = new Set(wcolEdges().map((e) => e.id));
    expect(ids.has('wcol-e-vco1-out_l-pinned-mixmstrs-ch4L')).toBe(true);
  });

  it('no pinned mixer → reconcile is a no-op', () => {
    delete patch.nodes[PINNED_MIXER_ID];
    expect(() => reconcileColumns(resolveDef)).not.toThrow();
    expect(reconcileColumnMembership()).toBe(false);
  });
});
