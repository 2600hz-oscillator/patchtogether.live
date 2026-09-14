import { it, expect, vi, afterEach } from 'vitest';
import { lfoDef, setActiveSharedClock, _liveLfoCount } from './lfo';
import type { SharedClockHandle } from '../shared-clock.svelte';

const handles: Array<{dispose(): void}> = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.dispose();
  setActiveSharedClock(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('the real factory maps output time, picks up a late clock, and listens for later resets', async () => {
  vi.useFakeTimers();
  const messages: unknown[] = [];
  class Worklet {
    port = { postMessage: (message: unknown) => messages.push(message), close() {}, onmessage: null };
    parameters = new Map();
    addEventListener() {}
    disconnect() {}
  }
  vi.stubGlobal('AudioWorkletNode', Worklet);
  const ctx = {
    currentTime: 1.016,
    getOutputTimestamp: () => ({ contextTime: 1, performanceTime: 2000 }),
    audioWorklet: { addModule: async () => {} },
  } as unknown as AudioContext;
  const handle = await lfoDef.factory(ctx, {
    id: 'lfo', type: 'lfo', domain: 'audio', params: {}, position: { x: 0, y: 0 },
  });
  handles.push(handle);
  expect(messages).toEqual([]);
  const resets = new Set<() => void>();
  let epoch = 10_000;
  const clock = {
    snapshot: { converged: false },
    get epoch_ms() { return epoch; },
    sharedTimeAt: (time: number) => time + 10_000,
    sharedTimeNow: () => 12_016,
    onReset: (fn: () => void) => { resets.add(fn); return () => resets.delete(fn); },
  } as unknown as SharedClockHandle;
  setActiveSharedClock(clock);
  expect(messages).toEqual([]);
  vi.advanceTimersByTime(5000);
  expect(messages, 'a noisy first exchange must not anchor the worklet').toEqual([]);
  (clock.snapshot as { converged: boolean }).converged = true;
  vi.advanceTimersByTime(5000);
  expect(messages.at(-1)).toMatchObject({
    type: 'resync', epoch_ms: 10_000, sharedNow_ms: 12_000, audioOrigin_s: 1,
  });
  epoch = 12_000;
  for (const reset of resets) reset();
  expect(messages.at(-1)).toMatchObject({ type: 'init', epoch_ms: 12_000 });
  handle.dispose(); handles.length = 0;
  expect(_liveLfoCount()).toBe(0);
  const count = messages.length;
  vi.advanceTimersByTime(10_000);
  expect(messages).toHaveLength(count);
});
