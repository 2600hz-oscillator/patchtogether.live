// packages/web/src/lib/video/worker/worker-bridge.test.ts
//
// Fix E Phase 1 unit tests — the flag gate, the capability gate, and the
// latest-bitmap-wins frame queue of the main-thread bridge. The real worker
// (OffscreenCanvas + WebGL2) is exercised in the e2e (jsdom has no worker GL);
// here we mock Worker so we can drive the message protocol deterministically.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isWorkerFlagOn,
  workerCapable,
  workerFlagState,
  workerLocusEligible,
} from './worker-bridge';
import type { WorkerInboundMsg, WorkerOutboundMsg } from './protocol';

const g = globalThis as unknown as {
  __videoWorkerEnabled?: boolean;
  __videoEngineFreezeTime?: number;
  __videoEnginePause?: boolean;
  Worker?: unknown;
  OffscreenCanvas?: unknown;
  createImageBitmap?: unknown;
};

describe('workerFlagState / isWorkerFlagOn (tri-state; default ON since PR V2)', () => {
  afterEach(() => { delete g.__videoWorkerEnabled; });

  it("is 'default' with nothing set — and the boolean view reads ON", () => {
    expect(workerFlagState()).toBe('default');
    expect(isWorkerFlagOn()).toBe(true);
  });
  it('runtime override true → explicit on', () => {
    g.__videoWorkerEnabled = true;
    expect(workerFlagState()).toBe('on');
    expect(isWorkerFlagOn()).toBe(true);
  });
  it('runtime override false is the kill switch (even if a build env said true)', () => {
    g.__videoWorkerEnabled = false;
    expect(workerFlagState()).toBe('off');
    expect(isWorkerFlagOn()).toBe(false);
  });
});

describe('workerFlagState — URL param (reviewer A/B toggle)', () => {
  afterEach(() => { vi.unstubAllGlobals(); delete g.__videoWorkerEnabled; });

  it('?videoworker=1 turns it explicitly on', () => {
    vi.stubGlobal('location', { search: '?videoworker=1' });
    expect(workerFlagState()).toBe('on');
  });
  it('?videoworker=true turns it explicitly on', () => {
    vi.stubGlobal('location', { search: '?foo=bar&videoworker=true' });
    expect(workerFlagState()).toBe('on');
  });
  it('?videoworker=0 is the kill switch', () => {
    vi.stubGlobal('location', { search: '?videoworker=0' });
    expect(workerFlagState()).toBe('off');
    expect(isWorkerFlagOn()).toBe(false);
  });
  it("no videoworker param leaves the 'default' state (boolean view ON)", () => {
    vi.stubGlobal('location', { search: '?other=1' });
    expect(workerFlagState()).toBe('default');
    expect(isWorkerFlagOn()).toBe(true);
  });
  it('globalThis override still beats the URL param', () => {
    vi.stubGlobal('location', { search: '?videoworker=1' });
    g.__videoWorkerEnabled = false;
    expect(workerFlagState()).toBe('off');
  });
});

describe('workerLocusEligible — per-module worker decision', () => {
  it("kill switch ('off') disables every locus", () => {
    expect(workerLocusEligible('worker', 'off')).toBe(false);
    expect(workerLocusEligible('worker-experimental', 'off')).toBe(false);
    expect(workerLocusEligible('main', 'off')).toBe(false);
  });
  it("parity-complete 'worker' modules run in the worker on BOTH 'default' and 'on'", () => {
    expect(workerLocusEligible('worker', 'default')).toBe(true);
    expect(workerLocusEligible('worker', 'on')).toBe(true);
  });
  it("'worker-experimental' modules (TOYBOX black video layers, VFPGA probe double-render) need the EXPLICIT flag", () => {
    expect(workerLocusEligible('worker-experimental', 'default')).toBe(false);
    expect(workerLocusEligible('worker-experimental', 'on')).toBe(true);
  });
  it("'main' / undefined never use the worker", () => {
    expect(workerLocusEligible('main', 'on')).toBe(false);
    expect(workerLocusEligible(undefined, 'on')).toBe(false);
    expect(workerLocusEligible(undefined, 'default')).toBe(false);
  });
});

describe('workerCapable', () => {
  const saved = {
    Worker: g.Worker,
    OffscreenCanvas: g.OffscreenCanvas,
    createImageBitmap: g.createImageBitmap,
  };
  afterEach(() => {
    g.Worker = saved.Worker;
    g.OffscreenCanvas = saved.OffscreenCanvas;
    g.createImageBitmap = saved.createImageBitmap;
  });

  it('false when OffscreenCanvas is missing (the main-thread fallback case)', () => {
    g.Worker = class {};
    g.createImageBitmap = () => {};
    delete g.OffscreenCanvas;
    expect(workerCapable()).toBe(false);
  });
  it('true when all primitives are present', () => {
    g.Worker = class {};
    g.OffscreenCanvas = class {};
    g.createImageBitmap = () => {};
    expect(workerCapable()).toBe(true);
  });
});

// ---- bridge protocol behavior with a mock Worker ----

class MockWorker {
  static instances: MockWorker[] = [];
  onmessage: ((e: MessageEvent<WorkerOutboundMsg>) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  sent: WorkerInboundMsg[] = [];
  terminated = false;
  constructor(_url: unknown, _opts: unknown) { MockWorker.instances.push(this); }
  postMessage(msg: WorkerInboundMsg) { this.sent.push(msg); }
  terminate() { this.terminated = true; }
  /** Simulate the worker posting a message back to the main thread. */
  emit(msg: WorkerOutboundMsg) { this.onmessage?.({ data: msg } as MessageEvent<WorkerOutboundMsg>); }
}

class FakeBitmap {
  closed = false;
  close() { this.closed = true; }
}

describe('RenderWorkerBridge frame queue + lifecycle', () => {
  let RenderWorkerBridge: typeof import('./worker-bridge').RenderWorkerBridge;
  const saved = {
    Worker: g.Worker,
    OffscreenCanvas: g.OffscreenCanvas,
    createImageBitmap: g.createImageBitmap,
  };

  beforeEach(async () => {
    MockWorker.instances = [];
    g.Worker = MockWorker as unknown as typeof Worker;
    g.OffscreenCanvas = class {} as unknown;
    g.createImageBitmap = (() => {}) as unknown;
    g.__videoWorkerEnabled = true;
    // import after globals are stubbed (module reads them at call time, but be safe)
    ({ RenderWorkerBridge } = await import('./worker-bridge'));
  });
  afterEach(() => {
    g.Worker = saved.Worker;
    g.OffscreenCanvas = saved.OffscreenCanvas;
    g.createImageBitmap = saved.createImageBitmap;
    delete g.__videoWorkerEnabled;
    vi.restoreAllMocks();
  });

  function node(id: string) {
    return { id, type: 'acidwarp', domain: 'video' as const, position: { x: 0, y: 0 }, params: {} };
  }

  it('sends init on construction and is supported but not ready until glOk', () => {
    const b = new RenderWorkerBridge({ res: { width: 320, height: 240 } });
    expect(b.supported).toBe(true);
    expect(b.ready()).toBe(false);
    const w = MockWorker.instances[0]!;
    expect(w.sent[0]).toEqual({ type: 'init', res: { width: 320, height: 240 } });

    w.emit({ type: 'ready', glOk: true });
    expect(b.ready()).toBe(true);
    b.dispose();
  });

  it('a glOk:false report fails over to main (not supported, worker terminated)', () => {
    const b = new RenderWorkerBridge({ res: { width: 320, height: 240 } });
    const w = MockWorker.instances[0]!;
    w.emit({ type: 'ready', glOk: false, initErr: 'no webgl2' });
    expect(b.supported).toBe(false);
    expect(b.ready()).toBe(false);
    expect(w.terminated).toBe(true);
  });

  it('latest-bitmap-wins: a 2nd frame closes the 1st pending one; takeFrame drains', () => {
    const b = new RenderWorkerBridge({ res: { width: 320, height: 240 } });
    const w = MockWorker.instances[0]!;
    w.emit({ type: 'ready', glOk: true });
    b.addNode(node('n1'));

    const f1 = new FakeBitmap();
    const f2 = new FakeBitmap();
    w.emit({ type: 'frame', nodeId: 'n1', bitmap: f1 as unknown as ImageBitmap });
    w.emit({ type: 'frame', nodeId: 'n1', bitmap: f2 as unknown as ImageBitmap });
    // The stale first bitmap is closed; only the newest survives.
    expect(f1.closed).toBe(true);
    expect(f2.closed).toBe(false);

    const taken = b.takeFrame('n1') as unknown as FakeBitmap;
    expect(taken).toBe(f2);
    // Drained — a second take returns null.
    expect(b.takeFrame('n1')).toBeNull();
    b.dispose();
  });

  it('frames for unknown nodes are closed, not queued (no leak)', () => {
    const b = new RenderWorkerBridge({ res: { width: 320, height: 240 } });
    const w = MockWorker.instances[0]!;
    w.emit({ type: 'ready', glOk: true });
    const orphan = new FakeBitmap();
    w.emit({ type: 'frame', nodeId: 'ghost', bitmap: orphan as unknown as ImageBitmap });
    expect(orphan.closed).toBe(true);
    expect(b.takeFrame('ghost')).toBeNull();
    b.dispose();
  });

  it('removeNode closes a pending bitmap + tells the worker', () => {
    const b = new RenderWorkerBridge({ res: { width: 320, height: 240 } });
    const w = MockWorker.instances[0]!;
    w.emit({ type: 'ready', glOk: true });
    b.addNode(node('n1'));
    const f = new FakeBitmap();
    w.emit({ type: 'frame', nodeId: 'n1', bitmap: f as unknown as ImageBitmap });
    b.removeNode('n1');
    expect(f.closed).toBe(true);
    expect(w.sent.some((m) => m.type === 'removeNode' && m.nodeId === 'n1')).toBe(true);
    b.dispose();
  });

  it('forwards setParam + setResolution to the worker', () => {
    const b = new RenderWorkerBridge({ res: { width: 320, height: 240 } });
    const w = MockWorker.instances[0]!;
    w.emit({ type: 'ready', glOk: true });
    b.addNode(node('n1'));
    b.setParam('n1', 'speed', 0.8);
    b.setResolution(1366, 768);
    expect(w.sent).toContainEqual({ type: 'setParam', nodeId: 'n1', paramId: 'speed', value: 0.8 });
    expect(w.sent).toContainEqual({ type: 'setResolution', width: 1366, height: 768 });
    b.dispose();
  });

  it('replays nodes added before glOk once the worker reports ready', () => {
    const b = new RenderWorkerBridge({ res: { width: 320, height: 240 } });
    const w = MockWorker.instances[0]!;
    // Add a node BEFORE ready — the bridge sends addNode immediately, then
    // replays it on ready so a slow-init worker still gets it.
    b.addNode(node('early'));
    const before = w.sent.filter((m) => m.type === 'addNode').length;
    w.emit({ type: 'ready', glOk: true });
    const after = w.sent.filter((m) => m.type === 'addNode').length;
    expect(after).toBeGreaterThan(before);
    b.dispose();
  });

  it('determinism forwarding: constructor snapshots the globals; syncDeterminism posts on CHANGE only', () => {
    // Pre-set the harness globals the way installRenderSmokeHooks does
    // (addInitScript BEFORE boot): the bridge must forward them immediately.
    g.__videoEngineFreezeTime = 2;
    g.__videoEnginePause = true;
    try {
      const b = new RenderWorkerBridge({ res: { width: 320, height: 240 } });
      const w = MockWorker.instances[0]!;
      expect(w.sent[0]!.type).toBe('init');
      expect(w.sent[1]).toEqual({ type: 'determinism', freezeTimeSec: 2, paused: true });

      // Unchanged globals → no re-send.
      b.syncDeterminism();
      expect(w.sent.filter((m) => m.type === 'determinism')).toHaveLength(1);

      // Un-freeze + un-pause → exactly one more message with the new state.
      delete g.__videoEngineFreezeTime;
      delete g.__videoEnginePause;
      b.syncDeterminism();
      const dets = w.sent.filter((m) => m.type === 'determinism');
      expect(dets).toHaveLength(2);
      expect(dets[1]).toEqual({ type: 'determinism', freezeTimeSec: null, paused: false });
      b.dispose();
    } finally {
      delete g.__videoEngineFreezeTime;
      delete g.__videoEnginePause;
    }
  });

  it('dispose posts dispose + terminates + closes pending bitmaps', () => {
    const b = new RenderWorkerBridge({ res: { width: 320, height: 240 } });
    const w = MockWorker.instances[0]!;
    w.emit({ type: 'ready', glOk: true });
    b.addNode(node('n1'));
    const f = new FakeBitmap();
    w.emit({ type: 'frame', nodeId: 'n1', bitmap: f as unknown as ImageBitmap });
    b.dispose();
    expect(w.sent.some((m) => m.type === 'dispose')).toBe(true);
    expect(w.terminated).toBe(true);
    expect(f.closed).toBe(true);
    expect(b.supported).toBe(false);
  });

  // ── #1905: a state message that arrives before its node must not be lost ────
  //
  // The TOYBOX snapshot originates in a card `$effect` that fires ONCE PER
  // `node.data` CHANGE. Both of its consumers used to drop it silently when
  // they were not ready — `syncNodeData` is a no-op while the bridge is still
  // null, and the worker's `syncToyboxState` returns early for a node it has
  // not materialized yet. Nothing re-sends a snapshot for unchanged data, so
  // either drop was PERMANENT: the worker rendered default layers for the rest
  // of the session while the card showed the user's real ones.
  describe('#1905 toybox-sync replay', () => {
    const syncsFor = (w: MockWorker, id: string) =>
      w.sent.filter((m) => m.type === 'toybox-sync' && m.nodeId === id);

    it('a sync sent BEFORE addNode is re-sent after it (and lands after, per FIFO)', () => {
      const b = new RenderWorkerBridge({ res: { width: 320, height: 240 } });
      const w = MockWorker.instances[0]!;
      w.emit({ type: 'ready', glOk: true });

      // The card pushes state for a node the worker does not have yet.
      b.sendToyboxSync('n1', { layers: ['real'] });
      b.addNode(node('n1'));

      const syncs = syncsFor(w, 'n1');
      expect(syncs.length, 'the snapshot is sent again after addNode').toBe(2);
      // Ordering is what makes the replay effective: the last toybox-sync must
      // come AFTER the addNode, or the worker drops it exactly as before.
      const addIdx = w.sent.findIndex((m) => m.type === 'addNode');
      const lastSyncIdx = w.sent.map((m) => m.type).lastIndexOf('toybox-sync');
      expect(lastSyncIdx).toBeGreaterThan(addIdx);
      expect((syncs[1] as { state: unknown }).state).toEqual({ layers: ['real'] });
      b.dispose();
    });

    it('the ready handshake replays the snapshot alongside the node', () => {
      const b = new RenderWorkerBridge({ res: { width: 320, height: 240 } });
      const w = MockWorker.instances[0]!;
      // Node + state both pushed while the worker is still initialising.
      b.addNode(node('n1'));
      b.sendToyboxSync('n1', { layers: ['real'] });
      w.emit({ type: 'ready', glOk: true });

      const addNodes = w.sent.filter((m) => m.type === 'addNode');
      expect(addNodes.length, 'node replayed on ready').toBe(2);
      const syncs = syncsFor(w, 'n1');
      expect(syncs.length, 'state replayed on ready too').toBe(2);
      const lastAddIdx = w.sent.map((m) => m.type).lastIndexOf('addNode');
      const lastSyncIdx = w.sent.map((m) => m.type).lastIndexOf('toybox-sync');
      expect(lastSyncIdx, 'the replayed state lands after the replayed node').toBeGreaterThan(lastAddIdx);
      b.dispose();
    });

    it('NEGATIVE CONTROL: a node with no snapshot never fabricates one', () => {
      const b = new RenderWorkerBridge({ res: { width: 320, height: 240 } });
      const w = MockWorker.instances[0]!;
      w.emit({ type: 'ready', glOk: true });
      b.addNode(node('n1'));
      expect(syncsFor(w, 'n1').length).toBe(0);
      b.dispose();
    });

    it('removeNode forgets the snapshot (no resurrection on a later re-add)', () => {
      const b = new RenderWorkerBridge({ res: { width: 320, height: 240 } });
      const w = MockWorker.instances[0]!;
      w.emit({ type: 'ready', glOk: true });
      b.sendToyboxSync('n1', { layers: ['old'] });
      b.addNode(node('n1'));
      b.removeNode('n1');
      const before = syncsFor(w, 'n1').length;
      b.addNode(node('n1'));
      expect(syncsFor(w, 'n1').length, 'a removed node carries no stale state forward').toBe(before);
      b.dispose();
    });
  });

  // ── #1905: a worker that dies AFTER init must still fail over ──────────────
  //
  // The render worker reports a post-init GL context loss with the SAME
  // `ready:{glOk:false}` it uses for a failed init, so the bridge takes its
  // existing documented path and the proxy re-materializes the main-thread
  // fallback. Before, a context loss inside the render loop threw, voided the
  // reschedule, and left `ready()` TRUE forever — a live worker delivering
  // nothing, which is the #1905 signature exactly.
  it('#1905: a glOk:false arriving AFTER a successful ready still fails over', () => {
    const b = new RenderWorkerBridge({ res: { width: 320, height: 240 } });
    const w = MockWorker.instances[0]!;
    w.emit({ type: 'ready', glOk: true });
    b.addNode(node('n1'));
    expect(b.ready()).toBe(true);

    w.emit({ type: 'ready', glOk: false, initErr: 'worker GL context lost after init' });
    expect(b.ready(), 'the proxy must stop consuming worker frames').toBe(false);
    expect(b.supported, 'and must not come back on its own').toBe(false);
    expect(b.bridgeTrace().failReason).toContain('context lost');
  });

  // ── #1905: the trace makes the silent drops countable ─────────────────────
  it('#1905: bridgeTrace counts frames dropped for an unknown node', () => {
    const b = new RenderWorkerBridge({ res: { width: 320, height: 240 } });
    const w = MockWorker.instances[0]!;
    w.emit({ type: 'ready', glOk: true });
    b.addNode(node('n1'));

    const f = new FakeBitmap();
    // A frame for n1 that arrives after the bridge forgot it (removeNode
    // clears the trace entry, so use a live node whose knownNodes entry is
    // dropped by a remove-then-frame ordering).
    b.removeNode('n1');
    b.addNode(node('n1'));
    w.emit({ type: 'frame', nodeId: 'n1', bitmap: f as unknown as ImageBitmap });
    expect(b.bridgeTrace().nodes.find((n) => n.id === 'n1')?.framesReceived).toBe(1);

    // A frame for a node the bridge never knew is closed, not queued.
    const orphan = new FakeBitmap();
    w.emit({ type: 'frame', nodeId: 'ghost', bitmap: orphan as unknown as ImageBitmap });
    expect(orphan.closed, 'an orphan bitmap is closed, never leaked').toBe(true);
    expect(b.takeFrame('ghost')).toBeNull();
    b.dispose();
  });

  it('#1905: workerTrace resolves null when the worker never answers', async () => {
    const b = new RenderWorkerBridge({ res: { width: 320, height: 240 } });
    const w = MockWorker.instances[0]!;
    w.emit({ type: 'ready', glOk: true });
    // MockWorker never replies to trace-request.
    const snap = await b.workerTrace(20);
    expect(snap, 'no reply is a READING (wedged message loop), not an error').toBeNull();
    expect(w.sent.some((m) => m.type === 'trace-request')).toBe(true);
    b.dispose();
  });
});
