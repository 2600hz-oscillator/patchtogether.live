// packages/web/src/lib/ui/media/node-extras-registry.test.ts
//
// The PURE core of the extras-channel producer seam (#1720) — no DOM, no GL, no
// engine, zero-flake. Everything the registry touches is injected, so this runs
// under the web package's `environment: 'node'` vitest and drives the real
// control flow with fakes.
//
// WHAT THIS FILE OWNS: the LIFETIME rules — when a producer runs, when it does
// NOT, who wins when a card claims the binding, what a sweep destroys, and that
// there is no teardown a card can reach.
//
// WHAT IT DOES NOT OWN, stated so a green run is not over-read: whether a
// producer's OUTPUT is right. That is pixels — e2e/tests/extras-producer-lifetime.spec.ts
// spawns each producer type with persisted content, expands nothing, and reads
// the node's own output texture. Nothing here draws anything.

import { describe, it, expect, vi } from 'vitest';

import {
  createNodeExtrasRegistry,
  PUMP_INTERVAL_MS,
  RETRY_DELAY_MS,
  type ExtrasEngine,
  type ExtrasProducer,
  type ExtrasSurface,
  type NodeExtrasOps,
} from './node-extras-registry';
import type { ModuleNode } from '$lib/graph/types';

function node(id: string, type: string, data: Record<string, unknown> = {}): ModuleNode {
  return {
    id,
    type,
    domain: 'video',
    position: { x: 0, y: 0 },
    params: {},
    data,
  } as unknown as ModuleNode;
}

/** A surface fake — the registry only ever hands it to a producer. */
function fakeSurface(): ExtrasSurface {
  return { width: 4, height: 4, getContext: () => ({}) };
}

interface Harness {
  ops: NodeExtrasOps;
  /** Every produce() call, in order: [nodeId, signature]. */
  runs: Array<[string, string]>;
  /** Every pump() call, in order. */
  pumps: string[];
  /** Surfaces minted, keyed by nodeId — proves ONE per node for its lifetime. */
  surfaces: Map<string, ExtrasSurface>;
  surfaceMints: number;
  /** Pending retry callbacks, fired manually (no fake timers needed). */
  retries: Array<() => void>;
  retryDelays: number[];
  /** Ticker control. */
  tickerStarts: number;
  tickerStops: number;
  tickerIntervals: number[];
  fireTick(): void;
}

function harness(): Harness {
  const h: Partial<Harness> & { tick?: () => void } = {
    runs: [],
    pumps: [],
    surfaces: new Map(),
    surfaceMints: 0,
    retries: [],
    retryDelays: [],
    tickerStarts: 0,
    tickerStops: 0,
    tickerIntervals: [],
  };
  h.ops = {
    createSurface(nodeId) {
      h.surfaceMints = (h.surfaceMints ?? 0) + 1;
      const s = fakeSurface();
      h.surfaces!.set(nodeId, s);
      return s;
    },
    measureContext: () => ({}),
    startTicker(tick, intervalMs) {
      h.tickerStarts = (h.tickerStarts ?? 0) + 1;
      h.tickerIntervals!.push(intervalMs);
      h.tick = tick;
      return () => {
        h.tickerStops = (h.tickerStops ?? 0) + 1;
        h.tick = undefined;
      };
    },
    scheduleRetry(fn, delayMs) {
      h.retryDelays!.push(delayMs);
      h.retries!.push(fn);
      return () => {
        h.retries = h.retries!.filter((r) => r !== fn);
      };
    },
  };
  h.fireTick = () => h.tick?.();
  return h as Harness;
}

/** A producer that records every run and pushes nothing. */
function recorder(h: Harness, type: string, opts: { pump?: boolean } = {}): ExtrasProducer {
  return {
    type,
    why: 'a test double — records its runs so the LIFETIME rules can be asserted',
    signature: (n) => String((n.data as { sig?: unknown } | undefined)?.sig ?? ''),
    produce(ctx) {
      h.runs.push([ctx.node.id, this.signature(ctx.node)]);
      // Touch the surface so the ONE-PER-NODE claim is exercised.
      ctx.surface();
    },
    ...(opts.pump
      ? {
          pump(ctx) {
            h.pumps.push(ctx.node.id);
          },
        }
      : {}),
  };
}

/** A module-handle fake shaped like a real one: an object of METHODS that are
 *  the factory's own closures. `read('extras')` may hand back a fresh literal
 *  wrapping them (PICTUREBOX does exactly that), so the registry fingerprints
 *  the methods rather than the wrapper. */
function fakeHandle(): { setThing: () => void; readThing: () => void } {
  return { setThing: () => {}, readThing: () => {} };
}

/** An engine fake whose per-node HANDLE is controllable — a new handle is how
 *  the registry detects a RE-MATERIALIZED node. `freshLiteral` reproduces
 *  picturebox's shape: a new wrapper object on every read, same methods. */
function fakeEngine(
  initial: Record<string, ReturnType<typeof fakeHandle> | null> = {},
  freshLiteral = false,
): ExtrasEngine & {
  set(nodeId: string, extras: ReturnType<typeof fakeHandle> | null): void;
  params: Map<string, number>;
} {
  const handles = new Map<string, ReturnType<typeof fakeHandle> | null>(Object.entries(initial));
  const params = new Map<string, number>();
  return {
    params,
    set(nodeId, extras) {
      handles.set(nodeId, extras);
    },
    read(n, key) {
      if (key !== 'extras') return undefined;
      if (!handles.has(n.id)) handles.set(n.id, fakeHandle());
      const h = handles.get(n.id) ?? null;
      if (!h) return null;
      return freshLiteral ? { ...h } : h;
    },
    readParam(n, paramId) {
      return params.get(`${n.id}/${paramId}`);
    },
  };
}

describe('node-extras-registry — the LIFETIME rules', () => {
  it('produces once per node, and not again while nothing has changed', () => {
    const h = harness();
    const reg = createNodeExtrasRegistry([recorder(h, 'painter')], h.ops);
    const eng = fakeEngine();
    const nodes = [node('a', 'painter', { sig: 'v1' })];

    reg.sync(nodes, eng);
    reg.sync(nodes, eng);
    reg.sync(nodes, eng);

    expect(h.runs).toEqual([['a', 'v1']]);
  });

  it('re-produces when the node DATA changes, and only for the node that moved', () => {
    const h = harness();
    const reg = createNodeExtrasRegistry([recorder(h, 'painter')], h.ops);
    const eng = fakeEngine();

    reg.sync([node('a', 'painter', { sig: 'v1' }), node('b', 'painter', { sig: 'x' })], eng);
    reg.sync([node('a', 'painter', { sig: 'v2' }), node('b', 'painter', { sig: 'x' })], eng);

    expect(h.runs).toEqual([
      ['a', 'v1'],
      ['b', 'x'],
      ['a', 'v2'],
    ]);
  });

  it('re-produces when the ENGINE HANDLE is replaced, even with unchanged data', () => {
    // A re-materialized node (patch load, engine restart) hands back a DIFFERENT
    // extras object. Signature-only comparison would suppress the re-push and
    // the node would keep whatever the DISPOSED handle had — which is nothing.
    const h = harness();
    const reg = createNodeExtrasRegistry([recorder(h, 'painter')], h.ops);
    const eng = fakeEngine();
    const nodes = [node('a', 'painter', { sig: 'v1' })];

    reg.sync(nodes, eng);
    reg.sync(nodes, eng);
    expect(h.runs).toHaveLength(1);

    eng.set('a', fakeHandle());
    reg.sync(nodes, eng);
    expect(h.runs).toEqual([
      ['a', 'v1'],
      ['a', 'v1'],
    ]);
  });

  it('re-produces for a NEW engine — a fresh graph invalidates every recorded handle', () => {
    const h = harness();
    const reg = createNodeExtrasRegistry([recorder(h, 'painter')], h.ops);
    const nodes = [node('a', 'painter', { sig: 'v1' })];

    reg.sync(nodes, fakeEngine());
    expect(h.runs).toHaveLength(1);
    reg.sync(nodes, fakeEngine());
    expect(h.runs).toHaveLength(2);
  });

  it('a FRESH extras LITERAL over the same methods is NOT a new handle (the picturebox shape)', () => {
    // NEGATIVE CONTROL for `handleFingerprint`, and it is not hypothetical:
    // picturebox.ts builds a new extras object literal on EVERY `read`. An
    // object-identity comparison would call that a re-materialized node every
    // sync and re-decode every base64 asset on every graph change.
    const h = harness();
    const reg = createNodeExtrasRegistry([recorder(h, 'picturebox')], h.ops);
    const eng = fakeEngine({}, true);
    const nodes = [node('b', 'picturebox', { sig: 'v1' })];
    reg.sync(nodes, eng);
    reg.sync(nodes, eng);
    reg.sync(nodes, eng);
    expect(h.runs, 'a rebuilt wrapper over stable methods must not re-decode').toEqual([
      ['b', 'v1'],
    ]);
    // ...and the POSITIVE half: a genuinely new handle still re-produces.
    eng.set('b', fakeHandle());
    reg.sync(nodes, eng);
    expect(h.runs).toHaveLength(2);
  });

  it('never produces for a type with no declared producer (deny by default)', () => {
    const h = harness();
    const reg = createNodeExtrasRegistry([recorder(h, 'painter')], h.ops);
    reg.sync([node('z', 'acidwarp', { sig: 'v1' })], fakeEngine());
    expect(h.runs).toEqual([]);
    expect(reg.snapshot()).toEqual([]);
  });

  it('mints EXACTLY ONE surface per node, for the life of the node', () => {
    const h = harness();
    const reg = createNodeExtrasRegistry([recorder(h, 'painter')], h.ops);
    const eng = fakeEngine();
    reg.sync([node('a', 'painter', { sig: '1' })], eng);
    reg.sync([node('a', 'painter', { sig: '2' })], eng);
    reg.sync([node('a', 'painter', { sig: '3' })], eng);
    expect(h.runs).toHaveLength(3);
    expect(h.surfaceMints, 'one canvas per NODE, not one per produce').toBe(1);
  });

  it('defers a node whose engine handle is not ready, and RETRIES (the patch-load race)', () => {
    const h = harness();
    const reg = createNodeExtrasRegistry([recorder(h, 'painter')], h.ops);
    const eng = fakeEngine({ a: null });
    const nodes = [node('a', 'painter', { sig: 'v1' })];

    reg.sync(nodes, eng);
    expect(h.runs, 'nothing to push into yet').toEqual([]);
    expect(h.retries, 'a retry is scheduled').toHaveLength(1);
    expect(h.retryDelays[0]).toBe(RETRY_DELAY_MS);

    // The reconciler builds the engine node, then the retry fires.
    eng.set('a', fakeHandle());
    h.retries.shift()!();
    expect(h.runs).toEqual([['a', 'v1']]);
  });

  it('stops retrying once every node is ready (the retry does not run forever)', () => {
    const h = harness();
    const reg = createNodeExtrasRegistry([recorder(h, 'painter')], h.ops);
    const eng = fakeEngine({ a: null });
    reg.sync([node('a', 'painter', { sig: 'v1' })], eng);
    eng.set('a', fakeHandle());
    h.retries.shift()!();
    expect(h.runs).toHaveLength(1);
    expect(h.retries, 'no follow-up retry after a clean pass').toHaveLength(0);
  });
});

describe('node-extras-registry — the CARD LEASE (painter is the only claimant)', () => {
  it('a claim stops the registry pushing, and a release resumes it', () => {
    const h = harness();
    const reg = createNodeExtrasRegistry([recorder(h, 'painter')], h.ops);
    const eng = fakeEngine();
    const nodes = [node('a', 'painter', { sig: 'v1' })];

    reg.sync(nodes, eng);
    expect(h.runs).toHaveLength(1);

    const card = {};
    const lease = reg.claim('a', card);
    // The card owns the binding: a data change must NOT make the registry
    // overwrite the card's LIVE canvas mid-stroke.
    reg.sync([node('a', 'painter', { sig: 'v2' })], eng);
    expect(h.runs, 'the registry stands down while a card holds the claim').toHaveLength(1);
    expect(reg.snapshot()[0]!.claimed).toBe(true);

    lease.release();
    expect(reg.snapshot()[0]!.claimed).toBe(false);
    expect(h.runs, 'release re-pushes immediately, so the node keeps a picture').toHaveLength(2);
  });

  it('release is OWNER-CHECKED: a stale unmount cannot revoke the live card', () => {
    // Svelte gives no cross-tree mount/unmount ORDER guarantee, so the dock
    // card can mount before the headless one unmounts. If release were a plain
    // boolean the stale teardown would hand the binding back to the registry
    // while a live card was still drawing into it.
    const h = harness();
    const reg = createNodeExtrasRegistry([recorder(h, 'painter')], h.ops);
    const eng = fakeEngine();
    reg.sync([node('a', 'painter', { sig: 'v1' })], eng);

    const first = {};
    const second = {};
    const leaseA = reg.claim('a', first);
    const leaseB = reg.claim('a', second); // the new card takes over
    leaseA.release(); // the OLD card unmounts afterwards

    expect(reg.snapshot()[0]!.claimed, 'the live card still holds it').toBe(true);
    leaseB.release();
    expect(reg.snapshot()[0]!.claimed).toBe(false);
  });

  it('release is idempotent', () => {
    const h = harness();
    const reg = createNodeExtrasRegistry([recorder(h, 'painter')], h.ops);
    const eng = fakeEngine();
    reg.sync([node('a', 'painter', { sig: 'v1' })], eng);
    const lease = reg.claim('a', {});
    lease.release();
    const after = h.runs.length;
    lease.release();
    lease.release();
    expect(h.runs).toHaveLength(after);
  });

  it('claiming a node the registry has never seen does not throw', () => {
    const h = harness();
    const reg = createNodeExtrasRegistry([recorder(h, 'painter')], h.ops);
    expect(() => reg.claim('ghost', {}).release()).not.toThrow();
  });

  it('a claim made BEFORE the first sync is honoured (the mount-order race)', () => {
    // A card claims from `onMount`, and nothing orders that against the graph
    // effect that creates the entry. If the early claim were dropped, the
    // registry would push its replay canvas OVER the live card canvas the first
    // time the entry was created — for PAINTER, an in-progress stroke vanishing
    // from the output.
    const h = harness();
    const reg = createNodeExtrasRegistry([recorder(h, 'painter')], h.ops);
    const card = {};
    const lease = reg.claim('a', card);
    reg.sync([node('a', 'painter', { sig: 'v1' })], fakeEngine());
    expect(h.runs, 'the registry must stand down for a claim it has not seen an entry for yet')
      .toEqual([]);
    expect(reg.snapshot()[0]!.claimed).toBe(true);
    lease.release();
    expect(h.runs, 'and push as soon as the card lets go').toHaveLength(1);
  });

  it('a pending claim is dropped when the node never joins the graph', () => {
    // The other direction: an early claim must not outlive a node that was
    // removed before it materialised, or a LATER node reusing that id would
    // come up permanently claimed by a card that no longer exists.
    const h = harness();
    const reg = createNodeExtrasRegistry([recorder(h, 'painter')], h.ops);
    reg.claim('a', {});
    reg.sweep([]);
    reg.sync([node('a', 'painter', { sig: 'v1' })], fakeEngine());
    expect(reg.snapshot()[0]!.claimed).toBe(false);
    expect(h.runs).toEqual([['a', 'v1']]);
  });
});

describe('node-extras-registry — the PUMP ticker (picturebox asset gate)', () => {
  it('starts ONE shared ticker when a pumped node exists, and stops it when none do', () => {
    const h = harness();
    const reg = createNodeExtrasRegistry(
      [recorder(h, 'painter'), recorder(h, 'picturebox', { pump: true })],
      h.ops,
    );
    const eng = fakeEngine();

    reg.sync([node('p', 'painter', { sig: '1' })], eng);
    expect(h.tickerStarts, 'no pumped node yet').toBe(0);

    reg.sync(
      [node('p', 'painter', { sig: '1' }), node('b1', 'picturebox', { sig: '1' })],
      eng,
    );
    expect(h.tickerStarts).toBe(1);
    expect(h.tickerIntervals[0]).toBe(PUMP_INTERVAL_MS);

    // A SECOND pumped node must not start a second ticker.
    reg.sync(
      [
        node('p', 'painter', { sig: '1' }),
        node('b1', 'picturebox', { sig: '1' }),
        node('b2', 'picturebox', { sig: '1' }),
      ],
      eng,
    );
    expect(h.tickerStarts, 'one ticker for every pumped node').toBe(1);

    h.fireTick();
    expect(h.pumps.sort()).toEqual(['b1', 'b2']);

    reg.sync([node('p', 'painter', { sig: '1' })], eng);
    expect(h.tickerStops, 'the ticker stops when the last pumped node leaves').toBe(1);
  });

  it('a throwing pump does not take the ticker down with it', () => {
    const h = harness();
    const boom: ExtrasProducer = {
      type: 'picturebox',
      why: 'a test double whose pump throws — the ticker must survive it',
      signature: () => 'x',
      produce: () => {},
      pump: () => {
        throw new Error('boom');
      },
    };
    const reg = createNodeExtrasRegistry([boom, recorder(h, 'toybox', { pump: true })], h.ops);
    reg.sync([node('b', 'picturebox'), node('t', 'toybox')], fakeEngine());
    expect(() => h.fireTick()).not.toThrow();
    expect(h.pumps, 'the other node still pumped').toEqual(['t']);
  });

  it('does not pump a node whose engine handle is absent', () => {
    const h = harness();
    const reg = createNodeExtrasRegistry([recorder(h, 'picturebox', { pump: true })], h.ops);
    const eng = fakeEngine({ b: null });
    reg.sync([node('b', 'picturebox')], eng);
    h.fireTick();
    expect(h.pumps).toEqual([]);
    eng.set('b', fakeHandle());
    h.fireTick();
    expect(h.pumps).toEqual(['b']);
  });
});

describe('node-extras-registry — GRAPH-KEYED teardown, and the structural guard', () => {
  it('sweep drops entries for nodes that left the graph, and keeps the rest', () => {
    const h = harness();
    const reg = createNodeExtrasRegistry([recorder(h, 'painter')], h.ops);
    const eng = fakeEngine();
    reg.sync([node('a', 'painter', { sig: '1' }), node('b', 'painter', { sig: '1' })], eng);
    expect(reg.snapshot().map((r) => r.nodeId).sort()).toEqual(['a', 'b']);

    reg.sweep(['b']);
    expect(reg.snapshot().map((r) => r.nodeId)).toEqual(['b']);
  });

  it('a swept node that comes BACK gets a fresh surface and a fresh push', () => {
    const h = harness();
    const reg = createNodeExtrasRegistry([recorder(h, 'painter')], h.ops);
    const eng = fakeEngine();
    reg.sync([node('a', 'painter', { sig: '1' })], eng);
    reg.sweep([]);
    reg.sync([node('a', 'painter', { sig: '1' })], eng);
    expect(h.runs).toHaveLength(2);
    expect(h.surfaceMints).toBe(2);
  });

  it('disposeNode also stops the ticker when it removes the last pumped node', () => {
    const h = harness();
    const reg = createNodeExtrasRegistry([recorder(h, 'picturebox', { pump: true })], h.ops);
    reg.sync([node('b', 'picturebox')], fakeEngine());
    expect(h.tickerStarts).toBe(1);
    reg.disposeNode('b');
    expect(h.tickerStops).toBe(1);
    expect(reg.snapshot()).toEqual([]);
  });

  it('THE STRUCTURAL GUARD: there is no teardown method a CARD can call', () => {
    // The whole class this fix belongs to (#1531 / #1574 / #1588 / #1590) is
    // "a card destroyed something whose lifetime was the NODE". The guard that
    // makes it unrepresentable is the ABSENCE of a reachable teardown, so it is
    // asserted rather than trusted to review. `sweep` and `disposeNode` are the
    // only two, and both are GRAPH-keyed — Canvas is their only caller.
    const h = harness();
    const reg = createNodeExtrasRegistry([recorder(h, 'painter')], h.ops);
    const surface = Object.keys(reg).sort();
    expect(surface).toEqual(['claim', 'disposeNode', 'snapshot', 'sweep', 'sync']);
    for (const forbidden of ['dispose', 'destroy', 'teardown', 'detach', 'release', 'clear']) {
      expect(
        forbidden in reg,
        `a card must not be able to call ${forbidden}() on this registry`,
      ).toBe(false);
    }
    // NEGATIVE CONTROL for the check above: it can actually SEE a method.
    expect('sweep' in reg).toBe(true);
  });

  it('a producer that THROWS does not wedge the registry for the other nodes', () => {
    const h = harness();
    const boom: ExtrasProducer = {
      type: 'painter',
      why: 'a test double whose produce throws — one bad node must not stop the rest',
      signature: () => 'x',
      produce: () => {
        throw new Error('boom');
      },
    };
    const reg = createNodeExtrasRegistry([boom, recorder(h, 'toybox')], h.ops);
    expect(() =>
      reg.sync([node('a', 'painter'), node('t', 'toybox', { sig: 'z' })], fakeEngine()),
    ).not.toThrow();
    expect(h.runs).toEqual([['t', 'z']]);
  });

  it('an ASYNC producer settles before its signature is recorded, and coalesces a burst', async () => {
    // A decode is async (base64 → ImageBitmap). Two graph changes arriving
    // inside one decode must not interleave two pushes for the same node, and
    // the LAST signature must be the one that lands.
    const h = harness();
    let resolveFirst: (() => void) | null = null;
    const seen: string[] = [];
    const slow: ExtrasProducer = {
      type: 'picturebox',
      why: 'a test double whose produce is async, to pin the coalescing rule',
      signature: (n) => String((n.data as { sig?: unknown } | undefined)?.sig ?? ''),
      produce(ctx) {
        seen.push(this.signature(ctx.node));
        if (seen.length === 1) return new Promise<void>((r) => (resolveFirst = () => r()));
        return undefined;
      },
    };
    const reg = createNodeExtrasRegistry([slow], h.ops);
    const eng = fakeEngine();

    reg.sync([node('b', 'picturebox', { sig: 'v1' })], eng);
    expect(seen).toEqual(['v1']);
    expect(reg.snapshot()[0]!.produced, 'not recorded until the decode settles').toBe(false);

    // Two more changes land while v1 is still decoding.
    reg.sync([node('b', 'picturebox', { sig: 'v2' })], eng);
    reg.sync([node('b', 'picturebox', { sig: 'v3' })], eng);
    expect(seen, 'no interleaved second decode').toEqual(['v1']);

    resolveFirst!();
    await vi.waitFor(() => expect(seen).toEqual(['v1', 'v3']));
    expect(reg.snapshot()[0]!.signature).toBe('v3');
  });
});
