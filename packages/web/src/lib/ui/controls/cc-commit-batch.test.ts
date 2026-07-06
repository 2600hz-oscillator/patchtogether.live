// Unit tests for the PURE two-lane CC batcher (cc-commit-batch.ts).
// Fake timers/microtasks throughout — no Y imports (the store binding is
// covered by cc-batch-store.test.ts).

import { describe, it, expect } from 'vitest';
import {
  createCcBatcher,
  type CcBatchSink,
  type CcLane,
  type CcTickClient,
} from './cc-commit-batch';

interface Harness {
  batcher: ReturnType<typeof createCcBatcher>;
  runs: Array<{ lane: CcLane; values: number[] }>;
  fireTick(): void;
  hasTick(): boolean;
  flushMicro(): void;
  sinkThrows: { on: boolean };
}

function harness(): Harness {
  const runs: Array<{ lane: CcLane; values: number[] }> = [];
  const sinkThrows = { on: false };
  const sink: CcBatchSink = {
    runLane(lane, thunks) {
      if (sinkThrows.on) throw new Error('sink boom');
      const values: number[] = [];
      // Thunks record into `values` via closure (see client()).
      currentValues = values;
      for (const t of thunks) t();
      currentValues = null;
      runs.push({ lane, values });
    },
  };
  let currentValues: number[] | null = null;
  const micro: Array<() => void> = [];
  let tickCb: (() => void) | null = null;
  const batcher = createCcBatcher(sink, {
    tickMs: 150,
    schedule: (cb) => {
      tickCb = cb;
      return {};
    },
    cancel: () => {
      tickCb = null;
    },
    queueTask: (cb) => micro.push(cb),
  });
  return {
    batcher,
    runs,
    fireTick() {
      const cb = tickCb;
      tickCb = null;
      cb?.();
    },
    hasTick: () => tickCb !== null,
    flushMicro() {
      while (micro.length) micro.shift()!();
    },
    sinkThrows,
    // expose the recorder for thunk factories
    record: (v: number) => () => {
      currentValues?.push(v);
    },
  } as Harness & { record: (v: number) => () => void };
}

type H = ReturnType<typeof harness> & { record: (v: number) => () => void };

function client(lane: CcLane, h: H): CcTickClient & { setPending(v: number | null): void } {
  let pending: number | null = null;
  return {
    lane,
    setPending(v) {
      pending = v;
    },
    takeDue() {
      if (pending === null) return null;
      const v = pending;
      pending = null;
      return h.record(v);
    },
  };
}

describe('createCcBatcher', () => {
  it('enqueue merges same-task thunks into ONE runLane per lane (microtask flush)', () => {
    const h = harness() as H;
    h.batcher.enqueue('undoable', h.record(1));
    h.batcher.enqueue('undoable', h.record(2));
    h.batcher.enqueue('bare', h.record(3));
    expect(h.runs).toHaveLength(0); // nothing until the microtask
    h.flushMicro();
    expect(h.runs).toEqual([
      { lane: 'undoable', values: [1, 2] },
      { lane: 'bare', values: [3] },
    ]);
    // The flush disarms — a later enqueue arms a fresh microtask.
    h.batcher.enqueue('bare', h.record(4));
    h.flushMicro();
    expect(h.runs).toHaveLength(3);
    expect(h.runs[2]).toEqual({ lane: 'bare', values: [4] });
  });

  it('N hot clients drain into ONE transaction per lane per tick (the multi-knob fix)', () => {
    const h = harness() as H;
    const a = client('undoable', h);
    const b = client('undoable', h);
    const c = client('bare', h);
    a.setPending(10);
    b.setPending(11);
    c.setPending(12);
    h.batcher.markHot(a);
    h.batcher.markHot(b);
    h.batcher.markHot(c);
    h.fireTick();
    expect(h.runs).toEqual([
      { lane: 'undoable', values: [10, 11] },
      { lane: 'bare', values: [12] },
    ]);
    // Ticker re-arms while anything is hot; a due-less tick is a no-op.
    expect(h.hasTick()).toBe(true);
    h.fireTick();
    expect(h.runs).toHaveLength(2);
  });

  it('ticker stops when the last client goes cold and re-arms on the next markHot', () => {
    const h = harness() as H;
    const a = client('undoable', h);
    h.batcher.markHot(a);
    expect(h.hasTick()).toBe(true);
    h.batcher.markCold(a);
    expect(h.hasTick()).toBe(false);
    h.batcher.markHot(a);
    expect(h.hasTick()).toBe(true);
  });

  it('flushNow drains hot clients AND queues synchronously (save/export path)', () => {
    const h = harness() as H;
    const a = client('undoable', h);
    a.setPending(7);
    h.batcher.markHot(a);
    h.batcher.enqueue('bare', h.record(8));
    h.batcher.flushNow();
    expect(h.runs).toEqual([
      { lane: 'undoable', values: [7] },
      { lane: 'bare', values: [8] },
    ]);
    // The already-armed microtask finds empty queues → no extra run.
    h.flushMicro();
    expect(h.runs).toHaveLength(2);
  });

  it('a tick merges queued leading-edge thunks with due hot drains (one txn per lane per window)', () => {
    const h = harness() as H;
    const a = client('undoable', h);
    a.setPending(20);
    h.batcher.markHot(a);
    // A different pump's leading edge queued in the same window, before the
    // microtask fired (macrotask starvation) — the tick still merges it.
    h.batcher.enqueue('undoable', h.record(21));
    h.fireTick();
    expect(h.runs).toEqual([{ lane: 'undoable', values: [21, 20] }]);
  });

  it('a throwing sink cannot kill the ticker chain or the other lane', () => {
    const h = harness() as H;
    const a = client('undoable', h);
    const b = client('bare', h);
    a.setPending(1);
    b.setPending(2);
    h.batcher.markHot(a);
    h.batcher.markHot(b);
    h.sinkThrows.on = true;
    h.fireTick(); // both runLane calls throw — swallowed
    expect(h.runs).toHaveLength(0);
    expect(h.hasTick()).toBe(true); // chain survived
    h.sinkThrows.on = false;
    a.setPending(3);
    h.fireTick();
    expect(h.runs).toEqual([{ lane: 'undoable', values: [3] }]);
  });
});
