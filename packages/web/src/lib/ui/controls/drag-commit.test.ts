// packages/web/src/lib/ui/controls/drag-commit.test.ts

import { describe, it, expect, vi } from 'vitest';
import { createDragCommit } from './drag-commit';

/**
 * Build a manual-rAF stand-in so the tests stay synchronous + deterministic
 * (real rAF would force every test to be async + flaky). `step()` runs all
 * pending callbacks queued since the previous step — the model the helper
 * actually relies on.
 */
function makeFakeRaf() {
  const queue: Array<{ id: number; cb: () => void }> = [];
  let nextId = 1;
  const raf = (cb: () => void): number => {
    const id = nextId++;
    queue.push({ id, cb });
    return id;
  };
  const cancel = (id: number): void => {
    const idx = queue.findIndex((q) => q.id === id);
    if (idx >= 0) queue.splice(idx, 1);
  };
  const step = (): void => {
    const pending = queue.splice(0);
    for (const { cb } of pending) cb();
  };
  return { raf, cancel, step, pendingCount: () => queue.length };
}

describe('createDragCommit', () => {
  it('commits the latest value at the next frame (coalesces bursts)', () => {
    const onchange = vi.fn<(v: number) => void>();
    const { raf, cancel, step } = makeFakeRaf();
    const dc = createDragCommit(onchange, raf, cancel);

    dc.commit(0.1);
    dc.commit(0.2);
    dc.commit(0.3);
    expect(onchange).not.toHaveBeenCalled();

    step();
    expect(onchange).toHaveBeenCalledTimes(1);
    expect(onchange).toHaveBeenCalledWith(0.3);
  });

  it('schedules at most one rAF per frame regardless of commit count', () => {
    const onchange = vi.fn<(v: number) => void>();
    const { raf, cancel, step, pendingCount } = makeFakeRaf();
    const dc = createDragCommit(onchange, raf, cancel);

    for (let i = 0; i < 50; i++) dc.commit(i);
    expect(pendingCount()).toBe(1);

    step();
    expect(onchange).toHaveBeenCalledTimes(1);
    expect(onchange).toHaveBeenCalledWith(49);
  });

  it('flush() commits the staged value synchronously', () => {
    const onchange = vi.fn<(v: number) => void>();
    const { raf, cancel, step } = makeFakeRaf();
    const dc = createDragCommit(onchange, raf, cancel);

    dc.commit(0.42);
    dc.flush();
    expect(onchange).toHaveBeenCalledTimes(1);
    expect(onchange).toHaveBeenCalledWith(0.42);

    // Subsequent rAF must NOT re-fire (flush cancelled it).
    step();
    expect(onchange).toHaveBeenCalledTimes(1);
  });

  it('flush() with nothing staged is a no-op', () => {
    const onchange = vi.fn<(v: number) => void>();
    const { raf, cancel } = makeFakeRaf();
    const dc = createDragCommit(onchange, raf, cancel);

    dc.flush();
    expect(onchange).not.toHaveBeenCalled();
  });

  it('dispose() drops pending values without invoking onchange', () => {
    const onchange = vi.fn<(v: number) => void>();
    const { raf, cancel, step } = makeFakeRaf();
    const dc = createDragCommit(onchange, raf, cancel);

    dc.commit(0.9);
    dc.dispose();
    step();
    expect(onchange).not.toHaveBeenCalled();

    // After dispose, further commits still work (helper is reusable —
    // though in practice callers create a fresh one). Verifies dispose
    // didn't permanently wedge the helper.
    dc.commit(1.1);
    step();
    expect(onchange).toHaveBeenCalledTimes(1);
    expect(onchange).toHaveBeenCalledWith(1.1);
  });

  it('multiple frames each commit their own latest value', () => {
    const onchange = vi.fn<(v: number) => void>();
    const { raf, cancel, step } = makeFakeRaf();
    const dc = createDragCommit(onchange, raf, cancel);

    dc.commit(0.1);
    dc.commit(0.2);
    step();
    dc.commit(0.3);
    dc.commit(0.4);
    step();

    expect(onchange).toHaveBeenCalledTimes(2);
    expect(onchange).toHaveBeenNthCalledWith(1, 0.2);
    expect(onchange).toHaveBeenNthCalledWith(2, 0.4);
  });

  it('typecheck against the real rAF signatures (no-op when not invoked)', () => {
    // Compile-time check that createDragCommit() with no injection still
    // returns a usable helper. Runtime intentionally doesn't fire anything.
    const onchange = vi.fn();
    const dc = createDragCommit(onchange);
    expect(typeof dc.commit).toBe('function');
    expect(typeof dc.flush).toBe('function');
    expect(typeof dc.dispose).toBe('function');
    dc.dispose();
    expect(onchange).not.toHaveBeenCalled();
  });
});
