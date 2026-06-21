// packages/web/src/lib/video/video-keepalive-registry.test.ts
//
// The identity invariant the multi-slot freeze fix hinges on: a per-element
// audio keep-alive is created AT MOST ONCE per element and is NEVER torn down on
// a slot switch. `createMediaElementSource` is once-per-element-permanent (a 2nd
// call throws InvalidStateError), so the pre-fix "tear down + re-create on every
// switch" path threw + left switched-away slots throttled on frame 0. These
// tests drive the registry with a FAKE `create` (no real AudioContext / <video>
// needed) and assert exactly that invariant.

import { describe, expect, it, vi } from 'vitest';
import {
  createKeepAliveRegistry,
  type DisposableKeepAlive,
} from './video-keepalive-registry';

/** A fake <video> — the registry only uses object identity as the key. */
function fakeEl(): HTMLVideoElement {
  return {} as unknown as HTMLVideoElement;
}

/** A counting keep-alive factory: one keep-alive per call, tracking disconnects. */
function countingFactory() {
  const created: DisposableKeepAlive[] = [];
  const create = vi.fn((_el: HTMLVideoElement): DisposableKeepAlive => {
    const ka = { disconnect: vi.fn() };
    created.push(ka);
    return ka;
  });
  return { create, created };
}

describe('createKeepAliveRegistry — identity invariant', () => {
  it('creates a keep-alive exactly ONCE per element (idempotent ensure)', () => {
    const { create } = countingFactory();
    const reg = createKeepAliveRegistry(create);
    const el = fakeEl();

    const a = reg.ensure(el);
    const b = reg.ensure(el);
    const c = reg.ensure(el);

    expect(create).toHaveBeenCalledTimes(1); // never re-created → never re-throws
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(reg.has(el)).toBe(true);
    expect(reg.size()).toBe(1);
  });

  it('repeated ensure of the SAME element across simulated switches never re-creates', () => {
    const { create } = countingFactory();
    const reg = createKeepAliveRegistry(create);
    const slotA = fakeEl();
    const slotB = fakeEl();

    // A → B → back to A → B → A : the exact switch churn that broke the engine.
    reg.ensure(slotA);
    reg.ensure(slotB);
    reg.ensure(slotA);
    reg.ensure(slotB);
    reg.ensure(slotA);

    // Two distinct elements → exactly two creates total, no matter the churn.
    expect(create).toHaveBeenCalledTimes(2);
    expect(reg.size()).toBe(2);
  });

  it('tracks distinct keep-alives per distinct element', () => {
    const { create } = countingFactory();
    const reg = createKeepAliveRegistry(create);
    const els = [fakeEl(), fakeEl(), fakeEl()];
    const kas = els.map((el) => reg.ensure(el));
    expect(create).toHaveBeenCalledTimes(3);
    expect(new Set(kas).size).toBe(3);
    expect(reg.size()).toBe(3);
    for (const el of els) expect(reg.has(el)).toBe(true);
  });

  it('does NOT tear a keep-alive down on switch — only disposeAll() disconnects', () => {
    const { create, created } = countingFactory();
    const reg = createKeepAliveRegistry(create);
    const slotA = fakeEl();
    const slotB = fakeEl();
    reg.ensure(slotA);
    reg.ensure(slotB);

    // Switching away (re-ensuring the other) must NOT disconnect anything.
    reg.ensure(slotB);
    reg.ensure(slotA);
    for (const ka of created) expect(ka.disconnect).not.toHaveBeenCalled();

    // Only an explicit module dispose tears everything down, exactly once each.
    reg.disposeAll();
    for (const ka of created) expect(ka.disconnect).toHaveBeenCalledTimes(1);
    expect(reg.size()).toBe(0);
    expect(reg.has(slotA)).toBe(false);
  });

  it('disposeAll is idempotent', () => {
    const { create, created } = countingFactory();
    const reg = createKeepAliveRegistry(create);
    reg.ensure(fakeEl());
    reg.disposeAll();
    reg.disposeAll();
    expect(created[0]!.disconnect).toHaveBeenCalledTimes(1);
  });

  it('a null create (no AudioContext) leaves the element unwired + retryable', () => {
    let ctxReady = false;
    const realKa = { disconnect: vi.fn() };
    const create = vi.fn((_el: HTMLVideoElement) => (ctxReady ? realKa : null));
    const reg = createKeepAliveRegistry(create);
    const el = fakeEl();

    expect(reg.ensure(el)).toBeNull();
    expect(reg.has(el)).toBe(false);
    expect(reg.size()).toBe(0);

    // Once the context is ready a later ensure succeeds (no stale "wired" state).
    ctxReady = true;
    expect(reg.ensure(el)).toBe(realKa);
    expect(reg.has(el)).toBe(true);
  });

  it('a throwing create (element already owns a MediaElementSource) is swallowed + retryable', () => {
    let shouldThrow = true;
    const realKa = { disconnect: vi.fn() };
    const create = vi.fn((_el: HTMLVideoElement) => {
      if (shouldThrow) throw new DOMException('already has a source', 'InvalidStateError');
      return realKa;
    });
    const reg = createKeepAliveRegistry(create);
    const el = fakeEl();

    expect(() => reg.ensure(el)).not.toThrow();
    expect(reg.ensure(el)).toBeNull();
    expect(reg.has(el)).toBe(false);

    shouldThrow = false;
    expect(reg.ensure(el)).toBe(realKa);
    expect(reg.has(el)).toBe(true);
  });
});
