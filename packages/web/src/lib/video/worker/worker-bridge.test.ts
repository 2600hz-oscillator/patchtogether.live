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
});
