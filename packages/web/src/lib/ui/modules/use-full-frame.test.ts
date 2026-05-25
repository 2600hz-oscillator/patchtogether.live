// use-full-frame.test.ts
//
// Unit coverage for the in-app "Full Frame" controller: the enter/exit/toggle
// state writes, the mutual-exclusion-with-fullscreen contract, and the
// dblclick-to-exit lifecycle (attach). Runs in the `node` vitest env, so the
// DOM-touching test uses a minimal fake element that records listeners.

import { describe, it, expect, vi } from 'vitest';
import { createFullFrame } from './use-full-frame.svelte';

describe('createFullFrame', () => {
  it('enter() persists fullFrame=true', () => {
    const setFullFrame = vi.fn();
    const exitFullscreen = vi.fn();
    const ff = createFullFrame({ setFullFrame, exitFullscreen });
    ff.enter();
    expect(setFullFrame).toHaveBeenCalledWith(true);
  });

  it('exit() persists fullFrame=false', () => {
    const setFullFrame = vi.fn();
    const exitFullscreen = vi.fn();
    const ff = createFullFrame({ setFullFrame, exitFullscreen });
    ff.exit();
    expect(setFullFrame).toHaveBeenCalledWith(false);
  });

  it('entering full-frame first exits any active fullscreen (mutual exclusion)', () => {
    const setFullFrame = vi.fn();
    const exitFullscreen = vi.fn();
    const ff = createFullFrame({ setFullFrame, exitFullscreen });
    ff.enter();
    // exitFullscreen must be called before the fullFrame=true write, so the
    // card is never in both states at once.
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
    const exitOrder = exitFullscreen.mock.invocationCallOrder[0];
    const setOrder = setFullFrame.mock.invocationCallOrder[0];
    expect(exitOrder).toBeLessThan(setOrder);
  });

  it('toggle() flips based on current state', () => {
    const setFullFrame = vi.fn();
    const exitFullscreen = vi.fn();
    const ff = createFullFrame({ setFullFrame, exitFullscreen });

    ff.toggle(false); // currently off -> enter
    expect(setFullFrame).toHaveBeenLastCalledWith(true);

    ff.toggle(true); // currently on -> exit
    expect(setFullFrame).toHaveBeenLastCalledWith(false);
  });

  it('toggle(false) -> enter also drops fullscreen; toggle(true) -> exit does not', () => {
    const setFullFrame = vi.fn();
    const exitFullscreen = vi.fn();
    const ff = createFullFrame({ setFullFrame, exitFullscreen });

    ff.toggle(false); // enter
    expect(exitFullscreen).toHaveBeenCalledTimes(1);

    ff.toggle(true); // exit — no fullscreen drop needed
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
  });

  describe('attach() dblclick lifecycle', () => {
    function fakeEl() {
      const listeners: Record<string, ((e: unknown) => void)[]> = {};
      return {
        addEventListener: vi.fn((type: string, fn: (e: unknown) => void) => {
          (listeners[type] ??= []).push(fn);
        }),
        removeEventListener: vi.fn((type: string, fn: (e: unknown) => void) => {
          listeners[type] = (listeners[type] ?? []).filter((l) => l !== fn);
        }),
        fire(type: string, e: unknown) {
          for (const l of listeners[type] ?? []) l(e);
        },
        listenerCount(type: string) {
          return (listeners[type] ?? []).length;
        },
      };
    }

    it('a dblclick while active exits full-frame', () => {
      const setFullFrame = vi.fn();
      const ff = createFullFrame({ setFullFrame, exitFullscreen: vi.fn() });
      const el = fakeEl();
      let active = true;
      ff.attach(el as unknown as HTMLElement, () => active);

      const ev = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
      el.fire('dblclick', ev);
      expect(setFullFrame).toHaveBeenCalledWith(false);
      expect(ev.preventDefault).toHaveBeenCalled();
    });

    it('a dblclick while NOT active is ignored', () => {
      const setFullFrame = vi.fn();
      const ff = createFullFrame({ setFullFrame, exitFullscreen: vi.fn() });
      const el = fakeEl();
      ff.attach(el as unknown as HTMLElement, () => false);

      el.fire('dblclick', { preventDefault: vi.fn(), stopPropagation: vi.fn() });
      expect(setFullFrame).not.toHaveBeenCalled();
    });

    it('cleanup removes the dblclick listener', () => {
      const ff = createFullFrame({ setFullFrame: vi.fn(), exitFullscreen: vi.fn() });
      const el = fakeEl();
      const cleanup = ff.attach(el as unknown as HTMLElement, () => true);
      expect(el.listenerCount('dblclick')).toBe(1);
      cleanup();
      expect(el.listenerCount('dblclick')).toBe(0);
    });

    it('attach(null) is a no-op that returns a safe cleanup', () => {
      const ff = createFullFrame({ setFullFrame: vi.fn(), exitFullscreen: vi.fn() });
      const cleanup = ff.attach(null, () => true);
      expect(() => cleanup()).not.toThrow();
    });
  });
});
