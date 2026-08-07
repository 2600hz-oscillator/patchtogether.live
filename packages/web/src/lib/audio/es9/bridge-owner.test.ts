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
  hasEs9Bridge, __resetEs9Owners, es9BridgeAvailable,
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

  it('snapshot for an UNKNOWN node is idle, not a throw', () => {
    // A card can render before the engine has reconciled the node.
    const s = es9Snapshot('never-existed');
    expect(s.state).toBe('idle');
    expect(subscribeEs9('never-existed', () => {})).toBeTypeOf('function');
  });
});
