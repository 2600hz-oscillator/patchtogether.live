// packages/web/src/lib/ui/meter-frame.test.ts
//
// The shared meter rAF ticker: ONE requestAnimationFrame drives every
// subscriber, off-screen subscribers are skipped (IntersectionObserver gate),
// and the loop halts once the last subscriber leaves.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---- controllable requestAnimationFrame (faithful: cancel actually cancels)
let rafPending = new Map<number, FrameRequestCallback>();
let rafSeq = 1;
let rafScheduleCount = 0;
/** Run every currently-queued frame callback once (the module re-arms rAF at
 *  the end of each frame, so a fresh callback is queued for the next flush). */
function flushFrame(now = 0) {
  const q = [...rafPending.values()];
  rafPending.clear();
  for (const cb of q) cb(now);
}

// ---- controllable IntersectionObserver ------------------------------------
class FakeIO {
  cb: IntersectionObserverCallback;
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
    fakeIOInstances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  report(el: Element, isIntersecting: boolean) {
    this.cb([{ target: el, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}
let fakeIOInstances: FakeIO[] = [];

// The web package's unit env is `node` (no DOM). Stub just what the service
// touches: window (hasDom gate), rAF, IntersectionObserver, and a mutable
// document.hidden. Elements are opaque identity tokens to the service.
vi.stubGlobal('window', {});
vi.stubGlobal('document', { hidden: false });
vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
  const id = rafSeq++;
  rafPending.set(id, cb);
  rafScheduleCount++;
  return id;
});
vi.stubGlobal('cancelAnimationFrame', (id: number) => {
  rafPending.delete(id);
});
vi.stubGlobal('IntersectionObserver', FakeIO as unknown as typeof IntersectionObserver);

import {
  onMeterFrame,
  __meterFrameSubscriberCount,
  __resetMeterFrameForTests,
} from './meter-frame';

let elSeq = 0;
function el(): Element {
  // The service only compares elements by identity + hands them to
  // observe/unobserve (no-ops in FakeIO), so an opaque token suffices.
  return { __id: elSeq++ } as unknown as Element;
}

beforeEach(() => {
  __resetMeterFrameForTests();
  rafPending = new Map();
  rafScheduleCount = 0;
  fakeIOInstances = [];
});
afterEach(() => {
  __resetMeterFrameForTests();
});

describe('meter-frame: shared ticker', () => {
  it('drives every subscriber from a SINGLE rAF (coalescing)', () => {
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    onMeterFrame(el(), a);
    onMeterFrame(el(), b);
    onMeterFrame(el(), c);
    expect(__meterFrameSubscriberCount()).toBe(3);
    // Three subscribers, but only ONE rAF was scheduled to start the loop.
    expect(rafScheduleCount).toBe(1);

    flushFrame(16);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith(16);

    // The frame re-armed exactly ONE rAF for the next tick (not one-per-sub).
    expect(rafScheduleCount).toBe(2);
    flushFrame(32);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('stop() unsubscribes and the loop halts when the last one leaves', () => {
    const a = vi.fn();
    const b = vi.fn();
    const ha = onMeterFrame(el(), a);
    const hb = onMeterFrame(el(), b);
    flushFrame();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    ha.stop();
    expect(__meterFrameSubscriberCount()).toBe(1);
    flushFrame();
    expect(a).toHaveBeenCalledTimes(1); // stopped — not called again
    expect(b).toHaveBeenCalledTimes(2);

    hb.stop();
    expect(__meterFrameSubscriberCount()).toBe(0);
    // Last one left: the frame did not re-arm, so there is nothing queued.
    expect(rafPending.size).toBe(0);
  });

  it('skips an OFF-SCREEN subscriber (IntersectionObserver gate)', () => {
    const onScreen = vi.fn();
    const offScreen = vi.fn();
    const e1 = el();
    const e2 = el();
    onMeterFrame(e1, onScreen);
    onMeterFrame(e2, offScreen);
    const io = fakeIOInstances[0]!;

    // e2 scrolls out of view.
    io.report(e2, false);
    flushFrame();
    expect(onScreen).toHaveBeenCalledTimes(1);
    expect(offScreen).toHaveBeenCalledTimes(0); // off-screen → skipped

    // e2 scrolls back in.
    io.report(e2, true);
    flushFrame();
    expect(onScreen).toHaveBeenCalledTimes(2);
    expect(offScreen).toHaveBeenCalledTimes(1);
  });

  it('skips ALL subscribers while the tab is hidden', () => {
    const a = vi.fn();
    onMeterFrame(el(), a);
    (globalThis.document as unknown as { hidden: boolean }).hidden = true;
    flushFrame();
    expect(a).toHaveBeenCalledTimes(0);
    (globalThis.document as unknown as { hidden: boolean }).hidden = false;
    flushFrame();
    expect(a).toHaveBeenCalledTimes(1);
  });
});
