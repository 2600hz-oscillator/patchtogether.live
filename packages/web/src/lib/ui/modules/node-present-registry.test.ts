// node-present-registry.test.ts
//
// THE NODE-OWNED PROJECTOR, pinned in both directions — pure unit, no DOM, no
// window.open, no GL.
//
// The owner P0 this registry exists for ("backdraft on dev when card is not
// expanded and its been sent to a projector, the output stops") had THREE
// independent card-owned failure points, so the tests come in pairs: for each
// one, a leg asserting a card unmount does NOT tear it down, and a leg asserting
// the thing DOES still tear down on the one event that should end it — the node
// leaving the graph.
//
// ⚠ WHY THE SECOND HALF OF EACH PAIR IS NOT OPTIONAL. "Never tears down" is a
// trivially passing implementation of "survives a card unmount", and it is a
// real leak: a deleted module would leave a projector on a wall with nothing
// driving it. Both directions are the permanent negative control on each other,
// and they call the SAME predicates the production code calls (no re-typed copy
// of the rule — that is how the previous generation of gates went blind).

import { describe, it, expect, vi } from 'vitest';
import {
  createNodePresentRegistry,
  type PresentEngine,
} from './node-present-registry.svelte';
import type { PresentSession, StartPresentArgs } from './present-window';

function fakeSession(): PresentSession & { stop: ReturnType<typeof vi.fn> } {
  let closed = false;
  return {
    stop: vi.fn(() => { closed = true; }),
    get closed() { return closed; },
  };
}

/** A fake VideoEngine that records lease refcounts and per-node blits — the two
 *  engine-side effects the registry is responsible for. */
function fakeEngine() {
  const leases = new Map<string, number>();
  const blits: string[] = [];
  const engine: PresentEngine = {
    canvas: { width: 1280, height: 720 } as unknown as PresentEngine['canvas'],
    blitOutputToDrawingBuffer: (nodeId: string) => { blits.push(nodeId); },
    acquireRenderLease: (nodeId: string) => {
      leases.set(nodeId, (leases.get(nodeId) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const n = (leases.get(nodeId) ?? 0) - 1;
        if (n <= 0) leases.delete(nodeId);
        else leases.set(nodeId, n);
      };
    },
  };
  return { engine, leases, blits, leasedIds: () => [...leases.keys()].sort() };
}

function harness(opts: { blocked?: boolean } = {}) {
  const started: StartPresentArgs[] = [];
  const sessions: ReturnType<typeof fakeSession>[] = [];
  const start = vi.fn((a: StartPresentArgs): PresentSession | null => {
    started.push(a);
    if (opts.blocked) return null;
    const s = fakeSession();
    sessions.push(s);
    return s;
  });
  const reg = createNodePresentRegistry({
    start,
    setInterval: () => null,
    clearInterval: () => {},
  });
  const eng = fakeEngine();
  const open = (nodeId: string, screenId: string) =>
    reg.present(nodeId, screenId, { engine: eng.engine, rect: null });
  return { reg, start, started, sessions, ...eng, open };
}

describe('node-present registry — sessions are keyed to the NODE', () => {
  it('opens one popup per (node, screen) and reports per node', () => {
    const h = harness();
    expect(h.open('bd', 's1')).toBe(true);
    expect(h.open('bd', 's2')).toBe(true);
    expect(h.open('other', 's1')).toBe(true);
    expect(h.reg.presentingCount('bd')).toBe(2);
    expect(h.reg.presentingCount('other')).toBe(1);
    expect(h.reg.presentingNodeIds()).toEqual(['bd', 'other']);
  });

  it('re-presenting the SAME screen replaces just that popup', () => {
    const h = harness();
    h.open('bd', 's1');
    h.open('bd', 's2');
    h.open('bd', 's1');
    expect(h.sessions[0]!.stop).toHaveBeenCalledTimes(1);
    expect(h.sessions[1]!.stop).not.toHaveBeenCalled();
    expect(h.reg.presentingCount('bd')).toBe(2);
  });

  it('a blocked popup leaves NO entry and NO lease behind', () => {
    const h = harness({ blocked: true });
    expect(h.open('bd', 's1')).toBe(false);
    expect(h.reg.presentingCount('bd')).toBe(0);
    expect(h.reg.presentingNodeIds()).toEqual([]);
    expect(h.leasedIds()).toEqual([]);
  });
});

describe('node-present registry — the BLIT SOURCE is the engine, not a card', () => {
  // Mechanism 3 of the P0: startPresent used to hold the CARD's <canvas>, which
  // the unmount detaches — so even an open popup with a live node would freeze
  // on the card's last frame. The registry hands it a getter onto the ENGINE.
  it('passes a source GETTER (re-read per frame), never a captured element', () => {
    const h = harness();
    h.open('bd', 's1');
    const args = h.started[0]!;
    expect(typeof args.source).toBe('function');
    expect(args.source()).toBe(h.engine.canvas);
  });

  it('prepare() renders THAT node into the shared drawing buffer', () => {
    const h = harness();
    h.open('bd', 's1');
    h.open('other', 's1');
    h.started[0]!.prepare!();
    h.started[1]!.prepare!();
    h.started[0]!.prepare!();
    expect(h.blits, 'each projector blits its OWN node before reading').toEqual(['bd', 'other', 'bd']);
  });

  it('an engine that throws mid-blit does not kill the frame', () => {
    const h = harness();
    h.open('bd', 's1');
    const boom = {
      ...h.engine,
      blitOutputToDrawingBuffer: () => { throw new Error('GL context lost'); },
    } as PresentEngine;
    // Re-present with the throwing engine so the entry holds it.
    h.reg.present('bd', 's1', { engine: boom, rect: null });
    expect(() => h.started.at(-1)!.prepare!()).not.toThrow();
  });
});

describe('node-present registry — the RENDER LEASE lives with the session', () => {
  // Mechanism 2 of the P0. Measured pre-fix with dispose() removed: the popup
  // survived the collapse and `pullStats().leased` was `[]`, so the node stopped
  // being a pull root and the projector went dead-but-open.
  it('the FIRST popup takes the lease; it is NOT re-taken per display', () => {
    const h = harness();
    h.open('bd', 's1');
    expect(h.leases.get('bd')).toBe(1);
    h.open('bd', 's2');
    expect(h.leases.get('bd'), 'one lease per node, not per screen').toBe(1);
  });

  it('the lease outlives a card unmount and is released only with the LAST popup', () => {
    const h = harness();
    h.open('bd', 's1');
    h.open('bd', 's2');
    // A card unmount is not an event this registry has — nothing to call. The
    // lease is simply still held.
    expect(h.leasedIds()).toEqual(['bd']);
    h.reg.stop('bd', 's1');
    expect(h.leasedIds(), 'still presenting on s2').toEqual(['bd']);
    h.reg.stop('bd', 's2');
    expect(h.leasedIds(), 'last popup closed → lease released').toEqual([]);
  });
});

describe('node-present registry — teardown is GRAPH lifetime, and only that', () => {
  it('THE BUG: nothing in the registry ends a session when a card goes away', () => {
    const h = harness();
    h.open('bd', 's1');
    // Everything a card unmount could plausibly touch: another node's sweep, a
    // sweep that still lists this node, an unrelated stop.
    h.reg.sweep(['bd', 'src']);
    h.reg.stop('other');
    expect(h.reg.isPresenting('bd')).toBe(true);
    expect(h.sessions[0]!.stop).not.toHaveBeenCalled();
    expect(h.leasedIds()).toEqual(['bd']);
  });

  it('THE NEGATIVE CONTROL: deleting the node DOES close the projector + drop the lease', () => {
    const h = harness();
    h.open('bd', 's1');
    h.open('bd', 's2');
    h.open('keep', 's1');
    h.reg.sweep(['keep']); // 'bd' left the graph
    expect(h.sessions[0]!.stop).toHaveBeenCalled();
    expect(h.sessions[1]!.stop).toHaveBeenCalled();
    expect(h.sessions[2]!.stop, 'the surviving node keeps its projector').not.toHaveBeenCalled();
    expect(h.reg.isPresenting('bd')).toBe(false);
    expect(h.leasedIds()).toEqual(['keep']);
  });

  it('sweep is idempotent and a no-op when every node is live', () => {
    const h = harness();
    h.open('bd', 's1');
    h.reg.sweep(['bd']);
    h.reg.sweep(['bd']);
    expect(h.sessions[0]!.stop).not.toHaveBeenCalled();
    h.reg.sweep([]);
    h.reg.sweep([]);
    expect(h.sessions[0]!.stop).toHaveBeenCalledTimes(1);
  });

  it('disposeAll closes every node (page teardown)', () => {
    const h = harness();
    h.open('a', 's1');
    h.open('b', 's1');
    h.reg.disposeAll();
    expect(h.reg.presentingNodeIds()).toEqual([]);
    expect(h.leasedIds()).toEqual([]);
  });

  it('a popup the USER closed is reconciled away on the next poll, lease and all', () => {
    let pollFn: (() => void) | null = null;
    const started: StartPresentArgs[] = [];
    const sessions: ReturnType<typeof fakeSession>[] = [];
    const reg = createNodePresentRegistry({
      start: (a) => { started.push(a); const s = fakeSession(); sessions.push(s); return s; },
      setInterval: (fn) => { pollFn = fn; return 1; },
      clearInterval: () => { pollFn = null; },
    });
    const eng = fakeEngine();
    reg.present('bd', 's1', { engine: eng.engine, rect: null });
    expect(eng.leasedIds()).toEqual(['bd']);
    sessions[0]!.stop(); // the user hit the OS window button
    expect(pollFn).not.toBeNull();
    pollFn!();
    expect(reg.isPresenting('bd')).toBe(false);
    expect(eng.leasedIds(), 'a user-closed popup must not strand a pull root').toEqual([]);
  });
});
