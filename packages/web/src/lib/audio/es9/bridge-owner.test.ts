// packages/web/src/lib/audio/es9/bridge-owner.test.ts
//
// THE INVARIANT: the ES-9 hardware connection's lifetime is the NODE's, not a
// Svelte component's. Owner report 2026-08-05 — under ?shell=1 the stream died
// whenever the card wasn't expanded, because Es9Card constructed the client on
// mount and disconnected it in onDestroy.
//
// These tests drive the OWNER directly (no DOM, no Svelte), because the claim
// being pinned is precisely that the owner is independent of any view.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// `Es9BridgeClient` spawns a real Worker and allocates SharedArrayBuffers, so
// it is stubbed — what is under test here is OWNERSHIP AND LIFETIME, not the
// transport (which `es9-transport.test.ts` covers). The stub records every
// start/stop so a leaked or duplicated connection is visible.
const started: string[] = [];
const stopped: number[] = [];
let instances = 0;
/** The most recently constructed fake client, so a test can drive its state
 *  callbacks the way the transport worker would. */
let lastClient: { emitState: (s: string, d?: string) => void } | null = null;

vi.mock('./bridge-client', () => {
  class FakeClient {
    readonly inRing = { channels: 16, capacity: 8 } as never;
    readonly outRing = { channels: 16, capacity: 8 } as never;
    readonly supported = true;
    #events: Record<string, ((...a: never[]) => void) | undefined>;
    #id: number;
    constructor(events: Record<string, ((...a: never[]) => void) | undefined>) {
      this.#events = events;
      instances += 1;
      this.#id = instances;
      lastClient = this as unknown as { emitState: (s: string, d?: string) => void };
    }
    start(rate: number) { started.push(`c${this.#id}@${rate}`); }
    stop() { stopped.push(this.#id); }
    updateConfig() {}
    /** Test seam: drive the state callback the way the worker would. */
    emitState(s: string, detail?: string) {
      (this.#events.onState as ((s: string, d?: string) => void) | undefined)?.(s, detail);
    }
  }
  return { Es9BridgeClient: FakeClient };
});

const {
  acquireEs9Bridge, releaseEs9Bridge, subscribeEs9, es9Snapshot,
  hasEs9Bridge, __resetEs9Owners, es9BridgeAvailable, restartEs9Bridge,
} = await import('./bridge-owner');

const CFG = { inputChannels: [0], outputChannels: [0], outputModes: { '0': 'audio' } } as never;

// Node has SharedArrayBuffer but NOT the DOM `Worker`, so `es9BridgeAvailable()`
// is false here and every acquire would return null — the guard doing its job,
// but it would make these tests silently vacuous (they'd assert on an owner that
// was never created). Provide a dummy global: the client itself is mocked, so
// nothing ever constructs one. The negative-control test below deletes it again
// on purpose, which is what proves the guard still bites.
const FakeWorkerCtor = class {} as unknown as typeof Worker;

beforeEach(() => {
  (globalThis as Record<string, unknown>).Worker ??= FakeWorkerCtor;
  __resetEs9Owners();
  started.length = 0;
  stopped.length = 0;
  instances = 0;
  lastClient = null;
});

describe('es9 bridge OWNERSHIP — the connection outlives every view', () => {
  it('A CARD UNMOUNT DOES NOT STOP THE STREAM (the whole bug, in one test)', () => {
    acquireEs9Bridge('es9a', 48000, CFG);
    expect(hasEs9Bridge('es9a')).toBe(true);

    // A view mounts, then unmounts — twice, as dock collapse/expand would.
    const un1 = subscribeEs9('es9a', () => {});
    un1();
    const un2 = subscribeEs9('es9a', () => {});
    un2();

    // The connection is untouched: never stopped, never re-started.
    expect(stopped, 'unsubscribing must never stop the client').toEqual([]);
    expect(started.length, 'and must never re-start it').toBe(1);
    expect(hasEs9Bridge('es9a')).toBe(true);
  });

  it('THE REGRESSION: a view that subscribes BEFORE the connection exists still gets updates', () => {
    // ⚠ THIS IS THE REAL ORDERING AND THE ORIGINAL TESTS NEVER USED IT. The CARD
    // mounts when the node spawns; the ENGINE FACTORY creates the entry later,
    // via the reconciler. So the view always subscribes FIRST. `subscribeEs9`
    // used to `entries.get(nodeId)` and return a NO-OP when there was none — so
    // it never subscribed at all, and the card sat frozen on its initial idle
    // snapshot while the bridge behind it connected fine. Owner-reported as a
    // showstopper: "clicking connect does nothing, no console errors, no
    // connection". Every earlier test acquired first, so all of them passed.
    const seen: string[] = [];
    const un = subscribeEs9('es9late', (s) => seen.push(s.state));

    // Subscribing to a node with NO connection must still deliver a snapshot…
    expect(seen, 'an early subscriber gets the idle snapshot immediately').toEqual(['idle']);

    // …and must receive everything once the engine reconciles the node.
    acquireEs9Bridge('es9late', 48000, CFG);
    expect(seen.length, 'the early subscriber heard the connection appear').toBeGreaterThan(1);

    un();
  });

  it('a view subscribed before acquire hears LIVE state changes, not just the first one', () => {
    const states: string[] = [];
    subscribeEs9('es9live', (s) => states.push(s.state));
    acquireEs9Bridge('es9live', 48000, CFG);
    // Drive the client's state callback the way the worker would.
    const client = lastClient!;
    client.emitState('connecting');
    client.emitState('connected');
    expect(states, 'every transition reaches the early subscriber')
      .toEqual(expect.arrayContaining(['connecting', 'connected']));
  });

  it('CONNECT works when no entry exists yet — it acquires rather than no-opping', () => {
    // The other half of the dead button: restartEs9Bridge silently returned when
    // there was no entry, so pressing CONNECT before the engine reconciled (or
    // after a release) did literally nothing.
    expect(hasEs9Bridge('es9btn')).toBe(false);
    restartEs9Bridge('es9btn', 48000, CFG);
    expect(hasEs9Bridge('es9btn'), 'CONNECT must connect').toBe(true);
  });

  it('releasing tells subscribers the bridge is GONE rather than leaving stale state', () => {
    acquireEs9Bridge('es9rel', 48000, CFG);
    const seen: string[] = [];
    subscribeEs9('es9rel', (s) => seen.push(s.state));
    lastClient!.emitState('connected');
    releaseEs9Bridge('es9rel');
    expect(seen.at(-1), 'a dead bridge must not keep reading connected').toBe('idle');
  });

  it('only the ENGINE dispose tears it down', () => {
    acquireEs9Bridge('es9a', 48000, CFG);
    releaseEs9Bridge('es9a'); // what the node handle's dispose() calls
    expect(stopped).toEqual([1]);
    expect(hasEs9Bridge('es9a')).toBe(false);
  });

  it('SINGLE CLIENT per node — a double mount cannot wedge the bridge on "busy"', () => {
    // This is why the HeadlessSourceHost route was unusable: the native app
    // accepts ONE client, and an expand-time double mount (headless + dock
    // full-view) would open two. Acquiring twice must reuse, not reconnect.
    const a = acquireEs9Bridge('es9a', 48000, CFG);
    const b = acquireEs9Bridge('es9a', 48000, CFG);
    expect(instances, 'exactly one client was constructed').toBe(1);
    expect(started.length, 'exactly one start').toBe(1);
    expect(b!.inRing, 'the same rings are handed back').toBe(a!.inRing);
  });

  it('separate NODES get separate connections', () => {
    acquireEs9Bridge('es9a', 48000, CFG);
    acquireEs9Bridge('es9b', 48000, CFG);
    expect(instances).toBe(2);
    releaseEs9Bridge('es9a');
    expect(hasEs9Bridge('es9a')).toBe(false);
    expect(hasEs9Bridge('es9b'), 'releasing one node must not touch the other').toBe(true);
  });

  it('subscribers get the CURRENT snapshot immediately, then live updates', () => {
    acquireEs9Bridge('es9a', 48000, CFG);
    const seen: string[] = [];
    const un = subscribeEs9('es9a', (s) => seen.push(s.state));
    expect(seen.length, 'fires once on subscribe so a late view is not blank').toBe(1);
    un();
    // After unsubscribing, the view stops hearing — but the owner keeps state.
    expect(es9Snapshot('es9a').supported).toBe(true);
  });

  it('a non-connected state CLEARS device + rtt so a dead bridge cannot read live', () => {
    acquireEs9Bridge('es9a', 48000, CFG);
    let last = es9Snapshot('es9a');
    subscribeEs9('es9a', (s) => { last = s; });
    expect(last.device).toBeNull();
    expect(last.rtt).toBeNull();
  });

  it('NEGATIVE CONTROL — with no Worker/SAB the owner refuses rather than half-working', () => {
    // The engine FACTORY calls acquire, so an unguarded construction would break
    // every headless harness. Guard it here, once.
    const w = globalThis as Record<string, unknown>;
    const realWorker = w.Worker;
    try {
      delete w.Worker;
      expect(es9BridgeAvailable()).toBe(false);
      expect(acquireEs9Bridge('es9z', 48000, CFG)).toBeNull();
      expect(hasEs9Bridge('es9z')).toBe(false);
    } finally {
      if (realWorker !== undefined) w.Worker = realWorker;
    }
  });

  it('a PARTIAL window (no addEventListener) must not throw — capability, not environment', () => {
    // ⚠ Regression: the unload teardown guarded on `typeof window === 'undefined'`,
    // but this lane supplies a partial `window` WITHOUT addEventListener. The
    // guard passed and the call threw, taking out ten tests. Probe the thing you
    // are about to use, not the environment you assume you are in.
    const w = globalThis as Record<string, unknown>;
    const realWindow = w.window;
    try {
      w.window = {}; // present, but no addEventListener
      expect(() => acquireEs9Bridge('es9partial', 48000, CFG)).not.toThrow();
      expect(hasEs9Bridge('es9partial'), 'and the bridge is still acquired').toBe(true);
    } finally {
      if (realWindow === undefined) delete w.window;
      else w.window = realWindow;
    }
  });

  it('snapshot for an UNKNOWN node is idle, not a throw', () => {
    // A card can render before the engine has reconciled the node.
    const s = es9Snapshot('never-existed');
    expect(s.state).toBe('idle');
    expect(subscribeEs9('never-existed', () => {})).toBeTypeOf('function');
  });
});
