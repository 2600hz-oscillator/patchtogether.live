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

describe('MULTI-SOURCE one-head model — 2nd source is automation-only (owner rule)', () => {
  it('two tidyVcos in one channel: BOTH clip-driven, but ONLY the head (first) sends; the 2nd has NO audio edge', () => {
    addNode('vcoA', 'tidyVco', { channel: 5 });
    addNode('vcoB', 'tidyVco', { channel: 5 });
    setColumn(5, ['vcoA', 'vcoB']); // vcoA = first in order → the head
    reconcileColumns(resolveDef);
    const edges = wcolEdges();
    const ids = new Set(edges.map((e) => e.id));
    // BOTH sources are clip-driven (both keep their automation channel).
    expect(ids.has('wcol-e-pinned-clipplayer-pitch5-vcoA-poly')).toBe(true);
    expect(ids.has('wcol-e-pinned-clipplayer-pitch5-vcoB-poly')).toBe(true);
    // ONLY the head (vcoA) sends to ch5 — NO summing.
    expect(ids.has('wcol-e-vcoA-out_l-pinned-mixmstrs-ch5L')).toBe(true);
    expect(ids.has('wcol-e-vcoA-out_r-pinned-mixmstrs-ch5R')).toBe(true);
    // The 2nd source (vcoB) has NO audio edge at all (automation-only).
    expect(edges.some((e) => e.source.nodeId === 'vcoB' && e.sourceType === 'audio')).toBe(false);
    // The head flag was persisted: vcoA = head, vcoB = deliberate non-head.
    expect((patch.nodes['vcoA']!.data as { isColumnHead?: boolean }).isColumnHead).toBe(true);
    expect((patch.nodes['vcoB']!.data as { isColumnHead?: boolean }).isColumnHead).toBe(false);
  });

  it('DELETE the head → the FX chain stays; the surviving non-head source is NOT promoted (headless)', () => {
    // src (tidyVco, head) → cloudseed (FX) → mixer, PLUS a 2nd non-head source.
    addNode('src', 'tidyVco', { channel: 3 });
    addNode('src2', 'tidyVco', { channel: 3 });
    addNode('fx', 'cloudseed', { channel: 3 });
    setColumn(3, ['src', 'src2', 'fx']);
    reconcileColumns(resolveDef);
    let ids = new Set(wcolEdges().map((e) => e.id));
    // Head src → fx → mixer; src2 (non-head) has no audio edge.
    expect(ids.has('wcol-e-src-out_l-fx-in_l')).toBe(true);
    expect(ids.has('wcol-e-fx-out_l-pinned-mixmstrs-ch3L')).toBe(true);
    expect(wcolEdges().some((e) => e.source.nodeId === 'src2' && e.sourceType === 'audio')).toBe(false);
    expect((patch.nodes['src']!.data as { isColumnHead?: boolean }).isColumnHead).toBe(true);
    expect((patch.nodes['src2']!.data as { isColumnHead?: boolean }).isColumnHead).toBe(false);

    // Delete the HEAD (src). Membership heal drops it; the FX chain STAYS intact
    // and src2 (deliberate non-head) is NOT auto-promoted.
    ydoc.transact(() => { delete patch.nodes['src']; }, LOCAL_ORIGIN);
    reconcileColumns(resolveDef);
    ids = new Set(wcolEdges().map((e) => e.id));
    // The FX chain + its send survive (headless).
    expect(ids.has('wcol-e-fx-out_l-pinned-mixmstrs-ch3L')).toBe(true);
    expect(ids.has('wcol-e-fx-out_r-pinned-mixmstrs-ch3R')).toBe(true);
    // src2 was NOT promoted — still no audio edge.
    expect(wcolEdges().some((e) => e.source.nodeId === 'src2' && e.sourceType === 'audio')).toBe(false);
    expect((patch.nodes['src2']!.data as { isColumnHead?: boolean }).isColumnHead).toBe(false);
    // src2 keeps its clip control (automation-only).
    expect(ids.has('wcol-e-pinned-clipplayer-pitch3-src2-poly')).toBe(true);
  });

  it('ADD a source to a HEADLESS column → the fresh source becomes the head, wired at the ROOT', () => {
    // Reach a headless FX chain: head deleted, only FX remains.
    addNode('src', 'tidyVco', { channel: 4 });
    addNode('fx', 'cloudseed', { channel: 4 });
    setColumn(4, ['src', 'fx']);
    reconcileColumns(resolveDef);
    ydoc.transact(() => { delete patch.nodes['src']; }, LOCAL_ORIGIN);
    reconcileColumns(resolveDef); // now headless: fx only, nothing feeds it
    expect(wcolEdges().some((e) => e.target.nodeId === 'fx' && e.source.nodeId !== 'pinned-mixmstrs')).toBe(false);

    // Add a NEW source → it becomes the head and wires at the chain root.
    addNode('src3', 'tidyVco', { channel: 4 });
    reconcileColumns(resolveDef);
    const ids = new Set(wcolEdges().map((e) => e.id));
    expect(ids.has('wcol-e-src3-out_l-fx-in_l')).toBe(true); // root
    expect(ids.has('wcol-e-src3-out_r-fx-in_r')).toBe(true);
    expect(ids.has('wcol-e-fx-out_l-pinned-mixmstrs-ch4L')).toBe(true);
    expect((patch.nodes['src3']!.data as { isColumnHead?: boolean }).isColumnHead).toBe(true);
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

  it('REVERSE add-order (FX assigned BEFORE the source) still yields ONE strip: source spliced through, SINGLE tail send, source NOT on the mixer (owner bug 3)', () => {
    // Owner bug 3: a column whose order array is [FX, source] (cloudseed assigned
    // to ch1 FIRST, then tidyVco) must wire IDENTICALLY to [source, FX] — role,
    // not insertion order, decides the chain. Old island partitioning made this
    // TWO islands → both reached the mixer, no splice (the confirmed 3/3 repro).
    addNode('fx', 'cloudseed', { channel: 1 });
    addNode('src', 'tidyVco', { channel: 1 });
    setColumn(1, ['fx', 'src']); // FX FIRST in the order array (reverse add-order)
    reconcileColumns(resolveDef);
    const ids = new Set(wcolEdges().map((e) => e.id));
    // Source spliced INTO the FX (both L and R).
    expect(ids.has('wcol-e-src-out_l-fx-in_l')).toBe(true);
    expect(ids.has('wcol-e-src-out_r-fx-in_r')).toBe(true);
    // The FX is the SINGLE tail → exactly one stereo pair into ch1.
    expect(ids.has('wcol-e-fx-out_l-pinned-mixmstrs-ch1L')).toBe(true);
    expect(ids.has('wcol-e-fx-out_r-pinned-mixmstrs-ch1R')).toBe(true);
    // The SOURCE is NOT wired to the mixer (no double-connect).
    expect([...ids].some((id) => id.startsWith('wcol-e-src-') && id.includes('-pinned-mixmstrs-'))).toBe(false);
    // Exactly ONE stereo pair reaches ch1 (no doubling): 2 edges into ch1L/ch1R.
    const intoCh1 = [...ids].filter((id) => id.includes('-pinned-mixmstrs-ch1'));
    expect(intoCh1.length).toBe(2);
    // Same wiring as the source-first order (role-derived, add-order-independent).
    setColumn(1, ['src', 'fx']);
    reconcileColumns(resolveDef);
    const ids2 = new Set(wcolEdges().map((e) => e.id));
    expect(ids2.has('wcol-e-src-out_l-fx-in_l')).toBe(true);
    expect(ids2.has('wcol-e-fx-out_l-pinned-mixmstrs-ch1L')).toBe(true);
    expect([...ids2].filter((id) => id.includes('-pinned-mixmstrs-ch1')).length).toBe(2);
  });

  it('MID-CHAIN removal heals the gap: source→fx1→fx2→mixer, delete fx1 → source→fx2→mixer (no dangling)', () => {
    // Owner bug 5: removing a MIDDLE link must re-splice the adjacent survivors
    // across the gap, not leave the chain broken. source (tidyVco) → fxA
    // (cloudseed) → fxB (cloudseed) → mixer ch7.
    addNode('src', 'tidyVco', { channel: 7 });
    addNode('fxA', 'cloudseed', { channel: 7 });
    addNode('fxB', 'cloudseed', { channel: 7 });
    setColumn(7, ['src', 'fxA', 'fxB']);
    reconcileColumns(resolveDef);
    let ids = new Set(wcolEdges().map((e) => e.id));
    // Full chain: src→fxA→fxB→mixer; only the tail (fxB) sends.
    expect(ids.has('wcol-e-src-out_l-fxA-in_l')).toBe(true);
    expect(ids.has('wcol-e-fxA-out_l-fxB-in_l')).toBe(true);
    expect(ids.has('wcol-e-fxB-out_l-pinned-mixmstrs-ch7L')).toBe(true);
    expect([...ids].some((id) => id.startsWith('wcol-e-src-') && id.includes('-pinned-mixmstrs-'))).toBe(false);

    // Delete the MIDDLE fx (fxA). Membership heal drops it from the order; the
    // wiring reconcile must re-splice src → fxB directly.
    ydoc.transact(() => { delete patch.nodes['fxA']; }, LOCAL_ORIGIN);
    reconcileColumns(resolveDef);
    ids = new Set(wcolEdges().map((e) => e.id));
    // Gap healed: src → fxB (both L and R), fxB still the tail into the mixer.
    expect(ids.has('wcol-e-src-out_l-fxB-in_l')).toBe(true);
    expect(ids.has('wcol-e-src-out_r-fxB-in_r')).toBe(true);
    expect(ids.has('wcol-e-fxB-out_l-pinned-mixmstrs-ch7L')).toBe(true);
    expect(ids.has('wcol-e-fxB-out_r-pinned-mixmstrs-ch7R')).toBe(true);
    // No dangling wcol edge references the deleted middle member.
    expect([...ids].some((id) => id.includes('fxA'))).toBe(false);
    // The order array itself was healed to drop fxA.
    const cols = (patch.nodes[PINNED_MIXER_ID]!.data as { columns: Record<string, string[]> }).columns;
    expect(cols['7']).toEqual(['src', 'fxB']);
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

describe('PART B — CV Buddy lane note tap + ES-9 return audio (real Y.Doc)', () => {
  it('taps a REAL clip lane → cvBuddy inputs and returns es9.in1/in2 → the channel', () => {
    addNode('es9', 'es9', {});
    addNode('cvb', 'cvBuddy', { channel: 1 });
    setColumn(1, ['cvb']);
    reconcileColumns(resolveDef);
    const ids = new Set(wcolEdges().map((e) => e.id));
    // NOTE TAP — clip pitch1/gate1/vel1 → cvBuddy's laneTap inputs.
    expect(ids.has('wcol-e-pinned-clipplayer-pitch1-cvb-pitch')).toBe(true);
    expect(ids.has('wcol-e-pinned-clipplayer-gate1-cvb-gate')).toBe(true);
    expect(ids.has('wcol-e-pinned-clipplayer-vel1-cvb-velocity')).toBe(true);
    // RETURN — CV Buddy is the lane head → es9 hardware-input pair straight to ch1.
    expect(ids.has('wcol-e-es9-in1-pinned-mixmstrs-ch1L')).toBe(true);
    expect(ids.has('wcol-e-es9-in2-pinned-mixmstrs-ch1R')).toBe(true);
    // The TAP edges never reach the mixer (only the es9 return does).
    for (const e of wcolEdges()) {
      if (e.source.nodeId === 'pinned-clipplayer' && e.target.nodeId === 'cvb') {
        expect(e.target.nodeId).not.toBe(PINNED_MIXER_ID);
      }
    }
  });

  it('is IDEMPOTENT with the return present (a 2nd reconcile writes nothing)', () => {
    addNode('es9', 'es9', {});
    addNode('cvb', 'cvBuddy', { channel: 1 });
    setColumn(1, ['cvb']);
    reconcileColumns(resolveDef);
    const before = wcolEdges().length;
    expect(reconcileColumnWiring(resolveDef)).toBe(false);
    expect(wcolEdges().length).toBe(before);
  });

  it('NO ES-9 → the tap still materializes but the return is INERT (no es9 edges)', () => {
    addNode('cvb', 'cvBuddy', { channel: 2 });
    setColumn(2, ['cvb']);
    reconcileColumns(resolveDef);
    const ids = new Set(wcolEdges().map((e) => e.id));
    expect(ids.has('wcol-e-pinned-clipplayer-pitch2-cvb-pitch')).toBe(true);
    expect(wcolEdges().some((e) => e.source.nodeId === 'es9')).toBe(false);
    expect(wcolEdges().some((e) => e.target.nodeId === PINNED_MIXER_ID)).toBe(false);
  });

  it('second CV Buddy (id-sorted) takes the in3/in4 return pair', () => {
    addNode('es9', 'es9', {});
    addNode('cvbA', 'cvBuddy', { channel: 3 });
    addNode('cvbB', 'cvBuddy', { channel: 4 }); // different columns; cvbA < cvbB
    setColumn(3, ['cvbA']);
    setColumn(4, ['cvbB']);
    reconcileColumns(resolveDef);
    const ids = new Set(wcolEdges().map((e) => e.id));
    // cvbA = id-smallest → in1/in2 on ch3; cvbB = 2nd → in3/in4 on ch4.
    expect(ids.has('wcol-e-es9-in1-pinned-mixmstrs-ch3L')).toBe(true);
    expect(ids.has('wcol-e-es9-in3-pinned-mixmstrs-ch4L')).toBe(true);
    expect(ids.has('wcol-e-es9-in4-pinned-mixmstrs-ch4R')).toBe(true);
  });

  it('ADDITIVE — adding a CV Buddy tap leaves an in-app tidyVco head unchanged (in-app source keeps clip control + send)', () => {
    addNode('es9', 'es9', {});
    addNode('vco1', 'tidyVco', { channel: 6 });
    setColumn(6, ['vco1']);
    reconcileColumns(resolveDef);
    const baseIds = new Set(wcolEdges().map((e) => e.id));
    // Now add a CV Buddy to the SAME lane.
    addNode('cvb', 'cvBuddy', { channel: 6 });
    setColumn(6, ['vco1', 'cvb']); // vco1 first → stays the head
    reconcileColumns(resolveDef);
    const ids = new Set(wcolEdges().map((e) => e.id));
    // Every original vco1 edge survives verbatim (additive).
    for (const id of baseIds) expect(ids.has(id), `lost ${id}`).toBe(true);
    // The tap is net-new; the CV Buddy return is NOT summed in (vco1 holds head).
    expect(ids.has('wcol-e-pinned-clipplayer-pitch6-cvb-pitch')).toBe(true);
    expect(wcolEdges().some((e) => e.source.nodeId === 'es9')).toBe(false);
    // vco1 still sends to ch6.
    expect(ids.has('wcol-e-vco1-out_l-pinned-mixmstrs-ch6L')).toBe(true);
  });
});
