// The device ↔ runtime seam: publish on one side, subscribe on the other,
// with nothing else in the loop.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_LINN_PROFILE } from './profile';
import { createSelectionState } from './selection-reducer';
import {
  __resetLinnstrumentSourceForTest,
  getLinnstrumentSource,
  linnstrumentSessionSnapshot,
  publishLinnstrumentSelection,
  setLinnstrumentSource,
  subscribeLinnstrumentEvents,
} from './source-registry';
import type { LinnstrumentSource, RuntimeEvent, RuntimeEventListener, SessionEvent } from './types';

function fakeSource(id: string, epoch = 1): LinnstrumentSource & { emit(e: RuntimeEvent): void; listeners: number; painted: unknown[] } {
  const listeners = new Set<RuntimeEventListener>();
  const painted: unknown[] = [];
  const session: SessionEvent = { kind: 'session', epoch, state: 'connected', userMode: true, time: 0 };
  return {
    id,
    kind: 'simulated',
    painted,
    get listeners() {
      return listeners.size;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    snapshot: () => session,
    onSelection: (s) => painted.push(s),
    emit: (e) => listeners.forEach((fn) => fn(e)),
  };
}

beforeEach(() => __resetLinnstrumentSourceForTest());

describe('source-registry', () => {
  it('starts disconnected; a subscriber gets the disconnected snapshot synchronously', () => {
    const seen: RuntimeEvent[] = [];
    subscribeLinnstrumentEvents((e) => seen.push(e));
    expect(seen).toEqual([{ kind: 'session', epoch: 0, state: 'disconnected', userMode: false, time: 0 }]);
    expect(getLinnstrumentSource()).toBeNull();
  });

  it('setting a source fans its snapshot and then every event to subscribers; a late subscriber gets the snapshot', () => {
    const seen: RuntimeEvent[] = [];
    subscribeLinnstrumentEvents((e) => seen.push(e));
    const src = fakeSource('sim');
    setLinnstrumentSource(src);
    expect(src.listeners).toBe(1);
    const edge: RuntimeEvent = { kind: 'control_edge', epoch: 1, control: 'r', down: true, time: 1 };
    src.emit(edge);
    expect(seen.slice(1)).toEqual([src.snapshot(), edge]);
    const late: RuntimeEvent[] = [];
    subscribeLinnstrumentEvents((e) => late.push(e));
    expect(late).toEqual([src.snapshot()]);
    expect(linnstrumentSessionSnapshot()).toEqual(src.snapshot());
  });

  it('replacing the source unsubscribes the old one; clearing announces disconnected', () => {
    const a = fakeSource('a', 1);
    const b = fakeSource('b', 2);
    const seen: RuntimeEvent[] = [];
    setLinnstrumentSource(a);
    subscribeLinnstrumentEvents((e) => seen.push(e));
    setLinnstrumentSource(b);
    expect(a.listeners).toBe(0);
    a.emit({ kind: 'control_edge', epoch: 1, control: 'r', down: true, time: 0 }); // orphaned: nobody hears it
    expect(seen.at(-1)).toEqual(b.snapshot());
    setLinnstrumentSource(null);
    expect(seen.at(-1)).toMatchObject({ kind: 'session', state: 'disconnected', epoch: 2 });
    expect(b.listeners).toBe(0);
    setLinnstrumentSource(null); // idempotent
    expect(seen.filter((e) => e.kind === 'session' && e.state === 'disconnected')).toHaveLength(1);
  });

  it('unsubscribe stops delivery; a throwing listener does not starve the others', () => {
    const src = fakeSource('sim');
    setLinnstrumentSource(src);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ok: RuntimeEvent[] = [];
    subscribeLinnstrumentEvents(() => {
      throw new Error('boom');
    });
    const stop = subscribeLinnstrumentEvents((e) => ok.push(e));
    src.emit({ kind: 'control_edge', epoch: 1, control: 'g', down: true, time: 0 });
    expect(ok).toHaveLength(2);
    stop();
    src.emit({ kind: 'control_edge', epoch: 1, control: 'g', down: false, time: 0 });
    expect(ok).toHaveLength(2);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('publishLinnstrumentSelection hands acknowledged state to the source, and is a no-op without one', () => {
    const state = createSelectionState(DEFAULT_LINN_PROFILE);
    expect(() => publishLinnstrumentSelection(state)).not.toThrow();
    const src = fakeSource('sim');
    setLinnstrumentSource(src);
    publishLinnstrumentSelection(state);
    expect(src.painted).toEqual([state]);
    const mute: LinnstrumentSource = { id: 'stock', kind: 'stock_mpe', subscribe: () => () => {}, snapshot: () => ({ kind: 'session', epoch: 3, state: 'connected', userMode: false, time: 0 }) };
    setLinnstrumentSource(mute);
    expect(() => publishLinnstrumentSelection(state)).not.toThrow();
  });
});
