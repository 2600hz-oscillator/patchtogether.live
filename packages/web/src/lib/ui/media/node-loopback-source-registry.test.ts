// packages/web/src/lib/ui/media/node-loopback-source-registry.test.ts
//
// The node-owned LOOPBACK capture lifecycle (legacy-removal S1), driven against
// fakes.
//
// WHAT THIS GATE IS FOR. The defect class is "the capture exists only because a
// card is mounted", and its tell is that everything looks fine while a card
// happens to be there. So every leg below runs with NO card anywhere — there is
// no component in this file at all — and asserts the capture works regardless.
// A leg that needed a mount would be re-testing the bug.
//
// ⚠ THE LEG THAT MATTERS MOST IS THE ONE ABOUT WHAT `dispose` DOES NOT DO. The
// original bug was not that the card failed to stop the capture; it is that the
// card's `onDestroy` DID stop it. `getDisplayMedia` cannot be restarted without
// a fresh user gesture, so a collapse did not pause a capture — it ended one,
// permanently, and the user had to re-pick their tab. Every "view teardown"
// path below therefore asserts the tracks are STILL LIVE afterwards, and only
// the node leaving the graph is allowed to stop them.
//
// ⚠ AND THE GESTURE IS ASSERTED STRUCTURALLY, not just described. `acquire`
// must reach `getDisplayMedia` with no `await` before it, because the user
// activation that makes the call legal is consumed by the first suspension
// point. A fake that records whether it was called synchronously is the only
// way a unit test can see that at all — a real browser reports the failure as
// "the user dismissed the picker", which is indistinguishable from success
// followed by a cancel.

import { describe, it, expect } from 'vitest';
import type { ModuleNode } from '$lib/graph/types';
import type { CropUv } from '$lib/video/loopback-crop';
import {
  createNodeLoopbackSourceRegistry,
  LOOPBACK_SOURCE_SLOT,
  NO_LOOPBACK_SOURCE,
  NODE_LOOPBACK_SOURCE_TYPES,
  RETRY_ATTEMPTS,
  RETRY_INTERVAL_MS,
  type LoopbackSourceDeps,
  type LoopbackSourceStatus,
} from './node-loopback-source-registry';

// ---------------------------------------------------------------------------
// The fake world
// ---------------------------------------------------------------------------

function node(id: string, type = 'loopback', params: Record<string, number> = {}): ModuleNode {
  return { id, type, domain: 'video', position: { x: 0, y: 0 }, params } as unknown as ModuleNode;
}

interface FakeTrack {
  live: boolean;
  listeners: Set<() => void>;
}

/** A MediaStream stand-in whose track can be "ended" by the test (the share
 *  bar) and whose `stop` is observable (the teardown question). */
function makeStream() {
  const track: FakeTrack = { live: true, listeners: new Set() };
  const stream = {
    getVideoTracks: () => [track],
    getTracks: () => [{ stop: () => { track.live = false; } }],
  } as unknown as MediaStream;
  return { stream, track, endFromShareBar: () => { for (const f of [...track.listeners]) f(); } };
}

/** Timers fire only when the test advances them, so "the retry stopped" cannot
 *  pass on a real-timer accident. */
function makeClock() {
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  return {
    clock: {
      setInterval: (fn: () => void, ms: number) => { timers.set(next, { fn, ms }); return next++; },
      clearInterval: (h: unknown) => { timers.delete(h as number); },
    },
    tick(ms: number, times = 1): void {
      for (let i = 0; i < times; i++) for (const t of [...timers.values()]) if (t.ms === ms) t.fn();
    },
    live: () => timers.size,
  };
}

interface Harness {
  deps: LoopbackSourceDeps<{ id: string; stream: MediaStream | null; played: number }>;
  attached: Map<string, unknown>;
  crops: CropUv[];
  pumpRunning: Set<string>;
  pumpStarts: string[];
  statuses: Array<{ nodeId: string; status: LoopbackSourceStatus }>;
  elements: Map<string, { id: string; stream: MediaStream | null; played: number }>;
  streams: Map<string, MediaStream | null>;
  clock: ReturnType<typeof makeClock>;
  /** How the fake acquire resolves next. */
  setResult(r: { stream: MediaStream | null; error: { name: string; message: string } | null }): void;
  setSupported(v: boolean): void;
  setEngineMaterialized(v: boolean): void;
  /** Did the LAST acquire call reach getDisplayMedia with no prior await? */
  acquireWasSynchronous(): boolean;
  acquireCalls(): number;
  cropEnabledFor: Map<string, boolean>;
  /** The deps the controller handed the pump, per node — the only way to assert
   *  that `cropEnabled` is a fresh READ rather than a captured value. */
  pumpDeps: Map<string, { cropEnabled(): boolean; push(c: CropUv): void }>;
  settle(): Promise<void>;
}

function makeHarness(): Harness {
  type El = { id: string; stream: MediaStream | null; played: number };
  const attached = new Map<string, unknown>();
  const crops: CropUv[] = [];
  const pumpRunning = new Set<string>();
  const pumpStarts: string[] = [];
  const pumpDeps = new Map<string, { cropEnabled(): boolean; push(c: CropUv): void }>();
  const statuses: Array<{ nodeId: string; status: LoopbackSourceStatus }> = [];
  const elements = new Map<string, El>();
  const streams = new Map<string, MediaStream | null>();
  const cropEnabledFor = new Map<string, boolean>();
  const clock = makeClock();

  let supported = true;
  let materialized = true;
  let result: { stream: MediaStream | null; error: { name: string; message: string } | null } = {
    stream: null,
    error: null,
  };
  let calls = 0;
  let syncFlag = false;
  // A microtask that flips before `acquire` is entered. If the controller
  // awaited anything first, this will already be true when acquire runs — which
  // is exactly the "the activation was consumed" condition.
  let gateOpened = false;

  const deps: LoopbackSourceDeps<El> = {
    engine: null,
    media: {
      ensure: (nodeId) => {
        let el = elements.get(nodeId);
        if (!el) { el = { id: nodeId, stream: null, played: 0 }; elements.set(nodeId, el); }
        return el;
      },
      setStream: (nodeId, _slot, s) => {
        const prev = streams.get(nodeId);
        // The registry stops the PREVIOUS stream — mirror that so a test can see it.
        if (prev && prev !== s) prev.getTracks().forEach((t) => t.stop());
        streams.set(nodeId, s);
      },
      stream: (nodeId) => streams.get(nodeId) ?? null,
    },
    el: {
      setStream: (el, s) => { el.stream = s; },
      play: (el) => { el.played++; },
    },
    capture: {
      supported: () => supported,
      acquire: async () => {
        calls++;
        syncFlag = !gateOpened;
        return result;
      },
      onEnded: (stream, fn) => {
        const track = (stream as unknown as { getVideoTracks(): FakeTrack[] }).getVideoTracks()[0];
        track?.listeners.add(fn);
        return () => track?.listeners.delete(fn);
      },
    },
    pump: {
      start: (nodeId, d) => {
        pumpStarts.push(nodeId);
        pumpRunning.add(nodeId);
        pumpDeps.set(nodeId, d);
      },
      stop: (nodeId) => { pumpRunning.delete(nodeId); },
    },
    doc: { cropEnabled: (nodeId) => cropEnabledFor.get(nodeId) ?? true },
    clock: clock.clock,
    onStatus: (nodeId, status) => { statuses.push({ nodeId, status }); },
  };

  const engine = {
    attach: (nodeId: string, el: unknown | null) => {
      if (!materialized) return;
      if (el === null) attached.delete(nodeId);
      else attached.set(nodeId, el);
    },
    hasElement: (nodeId: string) => attached.get(nodeId) != null,
    setCrop: (_nodeId: string, crop: CropUv) => { crops.push(crop); },
  };
  deps.engine = engine;

  return {
    deps,
    attached,
    crops,
    pumpRunning,
    pumpStarts,
    statuses,
    elements,
    streams,
    clock,
    cropEnabledFor,
    pumpDeps,
    setResult: (r) => { result = r; },
    setSupported: (v) => { supported = v; },
    setEngineMaterialized: (v) => { materialized = v; },
    acquireWasSynchronous: () => syncFlag,
    acquireCalls: () => calls,
    async settle() {
      gateOpened = true;
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      gateOpened = false;
    },
  };
}

function build(h: Harness) {
  const r = createNodeLoopbackSourceRegistry(h.deps);
  return r;
}

// ---------------------------------------------------------------------------

describe('NODE_LOOPBACK_SOURCE_TYPES', () => {
  it('names loopback and nothing else', () => {
    expect([...NODE_LOOPBACK_SOURCE_TYPES].sort()).toEqual(['loopback']);
  });

  it('VACUITY: the set is non-empty, so every disjointness check that reads it means something', () => {
    // A registry whose type set silently emptied would make every "is this
    // module node-owned" assertion trivially false and every "are the owners
    // disjoint" assertion trivially true, at the same time.
    expect(NODE_LOOPBACK_SOURCE_TYPES.size).toBeGreaterThan(0);
  });
});

describe('sync — controllers live and die with the GRAPH', () => {
  it('creates a controller per loopback node and ignores every other type', () => {
    const h = makeHarness();
    const r = build(h);
    r.sync([node('a'), node('b'), node('c', 'videobox'), node('d', 'acidwarp')], h.deps.engine);
    expect(r.has('a')).toBe(true);
    expect(r.has('b')).toBe(true);
    expect(r.has('c')).toBe(false);
    expect(r.has('d')).toBe(false);
  });

  it('ensures the node-owned element with NO host — the whole point of the move', () => {
    const h = makeHarness();
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    // The element exists for a node nothing has mounted. Under the old shape
    // this could only happen because HeadlessSourceHost mounted the real card.
    expect(h.elements.get('a')).toBeTruthy();
    expect(r.view('a').state).toBe('idle');
  });

  it('a node leaving the graph disposes its controller; view() falls back to the null status', () => {
    const h = makeHarness();
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    r.sync([], h.deps.engine);
    expect(r.has('a')).toBe(false);
    expect(r.view('a')).toEqual(NO_LOOPBACK_SOURCE);
  });

  it('re-syncing an existing node does NOT rebuild it (no second element, no second retry)', () => {
    const h = makeHarness();
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    const el = h.elements.get('a');
    const timers = h.clock.live();
    r.sync([node('a')], h.deps.engine);
    r.sync([node('a')], h.deps.engine);
    expect(h.elements.get('a')).toBe(el);
    expect(h.clock.live()).toBe(timers);
  });
});

describe('the engine attach retry', () => {
  it('offers the element every RETRY_INTERVAL_MS and stops the moment the engine confirms', () => {
    const h = makeHarness();
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    expect(h.attached.has('a')).toBe(false);
    h.clock.tick(RETRY_INTERVAL_MS);
    expect(h.attached.get('a')).toBe(h.elements.get('a'));
    expect(r.view('a').attached).toBe(true);
    // Confirmed ⇒ the timer is gone rather than polling forever.
    expect(h.clock.live()).toBe(0);
  });

  it('gives up after RETRY_ATTEMPTS rather than polling for the life of the tab', () => {
    const h = makeHarness();
    h.setEngineMaterialized(false); // the engine never materialises this node
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    h.clock.tick(RETRY_INTERVAL_MS, RETRY_ATTEMPTS + 2);
    expect(h.clock.live()).toBe(0);
    expect(r.view('a').attached).toBe(false);
  });

  it('NEGATIVE CONTROL: with the engine never materialising, the attach reading stays false', () => {
    // The reading that separates "attached" from "an element exists" has to be
    // able to say NO, or `attached: true` above proved nothing.
    const h = makeHarness();
    h.setEngineMaterialized(false);
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    h.clock.tick(RETRY_INTERVAL_MS, 3);
    expect(h.attached.has('a')).toBe(false);
    expect(r.view('a').attached).toBe(false);
  });
});

describe('acquire — the gesture, and the three outcomes', () => {
  it('reaches getDisplayMedia SYNCHRONOUSLY — no await may precede it', async () => {
    // ⚠ THE LEG THAT PROTECTS THE PICKER. An `await` added anywhere above the
    // acquire consumes the user activation, and the browser then refuses the
    // call in a way that looks exactly like the user cancelling. Nothing else
    // in the suite can see that.
    const h = makeHarness();
    const s = makeStream();
    h.setResult({ stream: s.stream, error: null });
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    r.request('a', 'acquire');
    expect(h.acquireCalls()).toBe(1);
    expect(h.acquireWasSynchronous()).toBe(true);
    await h.settle();
  });

  it('a granted capture attaches the element, starts the pump and plays', async () => {
    const h = makeHarness();
    const s = makeStream();
    h.setResult({ stream: s.stream, error: null });
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    r.request('a', 'acquire');
    await h.settle();
    expect(r.view('a').state).toBe('capturing');
    expect(h.streams.get('a')).toBe(s.stream);
    expect(h.elements.get('a')!.stream).toBe(s.stream);
    expect(h.elements.get('a')!.played).toBe(1);
    expect(h.pumpRunning.has('a')).toBe(true);
    expect(h.attached.get('a')).toBe(h.elements.get('a'));
  });

  it('a DISMISSED picker returns to idle with NO error — it is a normal outcome', async () => {
    const h = makeHarness();
    h.setResult({ stream: null, error: { name: 'NotAllowedError', message: 'denied' } });
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    r.request('a', 'acquire');
    await h.settle();
    expect(r.view('a').state).toBe('idle');
    expect(r.view('a').errorMsg).toBeNull();
  });

  it('a REAL failure surfaces name + message so the recovery text is actionable', async () => {
    const h = makeHarness();
    h.setResult({ stream: null, error: { name: 'NotFoundError', message: 'no surface' } });
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    r.request('a', 'acquire');
    await h.settle();
    expect(r.view('a').state).toBe('error');
    expect(r.view('a').errorMsg).toBe('NotFoundError: no surface');
  });

  it('an UNSUPPORTED browser is reported once at creation and again on request', async () => {
    const h = makeHarness();
    h.setSupported(false);
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    expect(r.view('a').state).toBe('unsupported');
    expect(r.view('a').supported).toBe(false);
    // ...and no attach retry is armed for a browser that cannot capture.
    expect(h.clock.live()).toBe(0);
    r.request('a', 'acquire');
    await h.settle();
    expect(h.acquireCalls()).toBe(0);
    expect(r.view('a').state).toBe('unsupported');
  });

  it('re-sharing replaces the previous stream rather than stacking two', async () => {
    const h = makeHarness();
    const first = makeStream();
    h.setResult({ stream: first.stream, error: null });
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    r.request('a', 'acquire');
    await h.settle();
    const second = makeStream();
    h.setResult({ stream: second.stream, error: null });
    r.request('a', 'acquire');
    await h.settle();
    expect(h.streams.get('a')).toBe(second.stream);
    expect(first.track.live).toBe(false);
    expect(second.track.live).toBe(true);
  });

  it('a node deleted WHILE the picker is open stops the stream it was handed', async () => {
    // Otherwise a user who deletes the module mid-pick leaves a live screen
    // capture with no owner and no way to stop it from the UI.
    const h = makeHarness();
    const s = makeStream();
    h.setResult({ stream: s.stream, error: null });
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    r.request('a', 'acquire');
    r.sync([], h.deps.engine); // deleted before the picker resolved
    await h.settle();
    expect(s.track.live).toBe(false);
  });
});

describe('stop — a CONTENT event, and the only thing that ends a capture', () => {
  it('the stop command detaches, clears the element and stops the pump', async () => {
    const h = makeHarness();
    const s = makeStream();
    h.setResult({ stream: s.stream, error: null });
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    r.request('a', 'acquire');
    await h.settle();
    r.request('a', 'stop');
    expect(r.view('a').state).toBe('idle');
    expect(h.streams.get('a')).toBeNull();
    expect(h.elements.get('a')!.stream).toBeNull();
    expect(h.attached.has('a')).toBe(false);
    expect(h.pumpRunning.has('a')).toBe(false);
    expect(s.track.live).toBe(false);
  });

  it('the SHARE BAR ending the track lands on `ended`, not `idle`', async () => {
    // The two are different to the user: `ended` says "you stopped sharing" and
    // offers RE-CAPTURE; `idle` says nothing ever started.
    const h = makeHarness();
    const s = makeStream();
    h.setResult({ stream: s.stream, error: null });
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    r.request('a', 'acquire');
    await h.settle();
    s.endFromShareBar();
    expect(r.view('a').state).toBe('ended');
    expect(h.pumpRunning.has('a')).toBe(false);
  });

  it('a node LEAVING THE GRAPH stops the pump — the only view-independent teardown', async () => {
    const h = makeHarness();
    const s = makeStream();
    h.setResult({ stream: s.stream, error: null });
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    r.request('a', 'acquire');
    await h.settle();
    expect(h.pumpRunning.has('a')).toBe(true);
    r.sync([], h.deps.engine);
    expect(h.pumpRunning.has('a')).toBe(false);
    expect(h.clock.live()).toBe(0);
  });

  it('sweep disposes exactly the nodes the graph no longer has', async () => {
    const h = makeHarness();
    const r = build(h);
    r.sync([node('a'), node('b')], h.deps.engine);
    r.sweep(['a']);
    expect(r.has('a')).toBe(true);
    expect(r.has('b')).toBe(false);
  });
});

describe('the crop pump reads the STORE, never a captured value', () => {
  it('cropEnabled is a fresh read each call — a param change after start is seen', async () => {
    // ⚠ THE STUCK-VALUE SHAPE. The pump outlives every surface; a dependency
    // captured at start time freezes at whatever it was when the capture began,
    // and the symptom is a crop rectangle that stops following the toggle with
    // every gate still green.
    const h = makeHarness();
    const s = makeStream();
    h.setResult({ stream: s.stream, error: null });
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    h.cropEnabledFor.set('a', true);
    r.request('a', 'acquire');
    await h.settle();
    const d = h.pumpDeps.get('a')!;
    expect(d.cropEnabled()).toBe(true);
    h.cropEnabledFor.set('a', false);
    expect(d.cropEnabled()).toBe(false);
  });

  it('the pump PUSH reaches the engine\'s private _crop channel', async () => {
    const h = makeHarness();
    const s = makeStream();
    h.setResult({ stream: s.stream, error: null });
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    r.request('a', 'acquire');
    await h.settle();
    h.pumpDeps.get('a')!.push({ u0: 0.1, u1: 0.9, v0: 0.2, v1: 0.8 });
    expect(h.crops).toEqual([{ u0: 0.1, u1: 0.9, v0: 0.2, v1: 0.8 }]);
  });

  it('a capturing node re-syncing re-arms the pump (a CORRECTION, never a second loop)', async () => {
    const h = makeHarness();
    const s = makeStream();
    h.setResult({ stream: s.stream, error: null });
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    r.request('a', 'acquire');
    await h.settle();
    const startsBefore = h.pumpStarts.length;
    r.sync([node('a')], h.deps.engine);
    // The real pump's `start` is idempotent while running; the correction is
    // what re-arms one an engine restart or a sweep dropped.
    expect(h.pumpStarts.length).toBe(startsBefore + 1);
    expect(h.pumpRunning.has('a')).toBe(true);
  });
});

describe('rehydration — a controller rebuilt under a LIVE capture', () => {
  it('comes back capturing rather than telling the user it stopped', async () => {
    const h = makeHarness();
    const s = makeStream();
    h.setResult({ stream: s.stream, error: null });
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    r.request('a', 'acquire');
    await h.settle();
    // A sync race / undo round-trip: the controller is disposed and rebuilt
    // while nodeMedia still holds the stream.
    r.disposeNode('a');
    // ⚠ `disposeNode` must NOT have stopped the stream — that is the whole
    // no-view-teardown rule, and rehydration is only meaningful if it holds.
    expect(h.streams.get('a')).toBe(s.stream);
    r.sync([node('a')], h.deps.engine);
    expect(r.view('a').state).toBe('capturing');
    expect(h.pumpRunning.has('a')).toBe(true);
  });

  it('a node with no live stream comes back idle', () => {
    const h = makeHarness();
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    r.disposeNode('a');
    r.sync([node('a')], h.deps.engine);
    expect(r.view('a').state).toBe('idle');
  });
});

describe('the status seam', () => {
  it('publishes an INITIAL status at creation, so a surface never reads a default', () => {
    const h = makeHarness();
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    expect(h.statuses[0]).toMatchObject({ nodeId: 'a', status: { state: 'idle' } });
  });

  it('does NOT republish when nothing changed — a surface re-renders on real moves only', async () => {
    const h = makeHarness();
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    const n = h.statuses.length;
    r.request('a', 'stop'); // already idle and already detached
    expect(h.statuses.length).toBe(n);
  });

  it('request on an unknown node reports NOT delivered rather than throwing', () => {
    const h = makeHarness();
    const r = build(h);
    expect(r.request('nope', 'acquire')).toEqual({ delivered: false, error: null });
  });

  it('snapshot lists every live controller with its status', async () => {
    const h = makeHarness();
    const r = build(h);
    r.sync([node('a'), node('b')], h.deps.engine);
    expect(r.snapshot().map((s) => s.nodeId).sort()).toEqual(['a', 'b']);
    expect(r.snapshot().every((s) => s.state === 'idle')).toBe(true);
  });
});

describe('the slot is the one the surfaces adopt', () => {
  it('LOOPBACK_SOURCE_SLOT is the same key a card/faceplate adopts', () => {
    // If this drifts, the controller ensures one element and every surface
    // adopts a different, empty one — a black preview with a live capture.
    expect(LOOPBACK_SOURCE_SLOT).toBe('main');
  });
});
