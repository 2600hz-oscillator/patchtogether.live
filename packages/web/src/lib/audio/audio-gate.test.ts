// packages/web/src/lib/audio/audio-gate.test.ts
//
// Bug 2 (B5): the audio gate is the load-bearing fix for "post-F5 audio
// doesn't play". This test exercises the rune-state store in isolation
// using a fake AudioContext (Node has no real one). The Playwright suite
// covers the integration with Canvas + ensureEngine in a real browser.

import { describe, it, expect, vi } from 'vitest';
import { createAudioGate } from './audio-gate.svelte.js';

interface FakeCtx {
  state: 'running' | 'suspended' | 'closed';
  resume: () => Promise<void>;
  addEventListener: (e: string, l: () => void) => void;
  removeEventListener: (e: string, l: () => void) => void;
  _listeners: Set<() => void>;
  _setState: (s: 'running' | 'suspended' | 'closed') => void;
}

function fakeCtx(initial: 'running' | 'suspended' | 'closed' = 'suspended'): FakeCtx {
  const listeners = new Set<() => void>();
  const ctx: FakeCtx = {
    state: initial,
    _listeners: listeners,
    addEventListener(_e, l) { listeners.add(l); },
    removeEventListener(_e, l) { listeners.delete(l); },
    async resume() { ctx.state = 'running'; for (const l of listeners) l(); },
    _setState(s) { ctx.state = s; for (const l of listeners) l(); },
  };
  return ctx;
}

// Stub the global AudioContext class so `result instanceof AudioContext`
// in the gate's extractCtx() returns true for our fake. We attach the
// fake's prototype to a no-op constructor exposed as AudioContext.
class StubAudioContext {}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).AudioContext = StubAudioContext;

function asAudioCtx(c: FakeCtx): AudioContext {
  // Make instanceof checks pass; return the fake otherwise unchanged.
  Object.setPrototypeOf(c, StubAudioContext.prototype);
  return c as unknown as AudioContext;
}

describe('createAudioGate', () => {
  it('starts not running with no ctx bound', () => {
    const g = createAudioGate();
    expect(g.running).toBe(false);
    expect(g.busy).toBe(false);
    expect(g.error).toBeNull();
  });

  it('reflects the bound ctx state', () => {
    const g = createAudioGate();
    g.bind(asAudioCtx(fakeCtx('running')));
    expect(g.running).toBe(true);
  });

  it('updates running when the ctx fires statechange', async () => {
    const g = createAudioGate();
    const c = fakeCtx('suspended');
    g.bind(asAudioCtx(c));
    expect(g.running).toBe(false);
    c._setState('running');
    expect(g.running).toBe(true);
    c._setState('suspended');
    expect(g.running).toBe(false);
  });

  it('resume() boots the engine via the registered booter when no ctx is bound', async () => {
    const g = createAudioGate();
    const c = fakeCtx('suspended');
    const booter = vi.fn(async () => ({ ctx: asAudioCtx(c) }));
    g.setBooter(booter);
    expect(g.running).toBe(false);
    await g.resume();
    expect(booter).toHaveBeenCalledTimes(1);
    expect(g.running).toBe(true);
    expect(c.state).toBe('running');
  });

  it('resume() resumes a suspended ctx that is already bound', async () => {
    const g = createAudioGate();
    const c = fakeCtx('suspended');
    g.bind(asAudioCtx(c));
    expect(g.running).toBe(false);
    await g.resume();
    expect(g.running).toBe(true);
    expect(c.state).toBe('running');
  });

  it('resume() is a no-op when already running', async () => {
    const g = createAudioGate();
    const c = fakeCtx('running');
    const booter = vi.fn();
    g.bind(asAudioCtx(c));
    g.setBooter(booter);
    await g.resume();
    expect(booter).not.toHaveBeenCalled();
  });

  it('resume() captures booter errors into the error field', async () => {
    const g = createAudioGate();
    g.setBooter(async () => { throw new Error('boom'); });
    await g.resume();
    expect(g.running).toBe(false);
    expect(g.error).toBe('boom');
  });

  it('bind(null) detaches the listener and reports running=false', () => {
    const g = createAudioGate();
    const c = fakeCtx('running');
    g.bind(asAudioCtx(c));
    expect(g.running).toBe(true);
    g.bind(null);
    expect(g.running).toBe(false);
    // Subsequent ctx state changes do not affect the detached gate.
    c._setState('suspended');
    expect(g.running).toBe(false);
    c._setState('running');
    expect(g.running).toBe(false);
  });
});
