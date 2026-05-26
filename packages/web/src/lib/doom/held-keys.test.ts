import { describe, it, expect, vi } from 'vitest';
import { HeldKeyTracker } from './held-keys';

describe('HeldKeyTracker', () => {
  it('forwards a keydown and tracks it', () => {
    const sink = vi.fn().mockReturnValue(true);
    const t = new HeldKeyTracker(sink);
    expect(t.down('KeyW')).toBe(true);
    expect(sink).toHaveBeenCalledWith('KeyW', true);
    expect(t.size).toBe(1);
    expect(t.has('KeyW')).toBe(true);
  });

  it('ignores OS key-repeat (does not re-forward an already-held key)', () => {
    const sink = vi.fn().mockReturnValue(true);
    const t = new HeldKeyTracker(sink);
    t.down('KeyW', false);
    sink.mockClear();
    expect(t.down('KeyW', true)).toBe(false);
    expect(sink).not.toHaveBeenCalled();
    expect(t.size).toBe(1);
  });

  it('does not track an unmapped key (sink returns false)', () => {
    const sink = vi.fn().mockReturnValue(false);
    const t = new HeldKeyTracker(sink);
    expect(t.down('KeyZ')).toBe(false);
    expect(t.size).toBe(0);
    expect(t.has('KeyZ')).toBe(false);
  });

  it('keyup forwards a release and stops tracking', () => {
    const sink = vi.fn().mockReturnValue(true);
    const t = new HeldKeyTracker(sink);
    t.down('ArrowUp');
    sink.mockClear();
    t.up('ArrowUp');
    expect(sink).toHaveBeenCalledWith('ArrowUp', false);
    expect(t.size).toBe(0);
    expect(t.has('ArrowUp')).toBe(false);
  });

  // The core regression: a key held while the card loses focus/selection
  // never gets a routed keyup; releaseAll must synthesise the release so
  // movement can't stick in the WASM input queue.
  it('releaseAll synthesises key-up for every still-held key and clears', () => {
    const sink = vi.fn().mockReturnValue(true);
    const t = new HeldKeyTracker(sink);
    t.down('KeyW');
    t.down('ArrowLeft');
    t.down('ControlLeft');
    sink.mockClear();

    t.releaseAll();

    expect(sink).toHaveBeenCalledTimes(3);
    expect(sink).toHaveBeenCalledWith('KeyW', false);
    expect(sink).toHaveBeenCalledWith('ArrowLeft', false);
    expect(sink).toHaveBeenCalledWith('ControlLeft', false);
    expect(t.size).toBe(0);
  });

  it('releaseAll is a no-op when nothing is held', () => {
    const sink = vi.fn().mockReturnValue(true);
    const t = new HeldKeyTracker(sink);
    t.releaseAll();
    expect(sink).not.toHaveBeenCalled();
  });

  it('does not double-release after an explicit keyup', () => {
    const sink = vi.fn().mockReturnValue(true);
    const t = new HeldKeyTracker(sink);
    t.down('KeyW');
    t.up('KeyW');
    sink.mockClear();
    t.releaseAll();
    expect(sink).not.toHaveBeenCalled();
  });

  // ---- Modifier-state reconciliation (stuck-Ctrl-after-swallowed-keyup) ----
  const ALL_DOWN = { ctrl: true, alt: true, shift: true, meta: true };
  const NONE_DOWN = { ctrl: false, alt: false, shift: false, meta: false };

  it('reconcileModifiers releases a tracked modifier the event reports UP', () => {
    const sink = vi.fn().mockReturnValue(true);
    const t = new HeldKeyTracker(sink);
    // Ctrl pressed (DOOM "fire"/run). Then a later event reports ctrlKey=false
    // (the OS swallowed the keyup — macOS screenshot shortcut).
    t.down('ControlLeft');
    sink.mockClear();
    const released = t.reconcileModifiers({ ...NONE_DOWN });
    expect(released).toEqual(['ControlLeft']);
    expect(sink).toHaveBeenCalledWith('ControlLeft', false);
    expect(t.has('ControlLeft')).toBe(false);
    expect(t.size).toBe(0);
  });

  it('reconcileModifiers keeps a modifier the event still reports DOWN', () => {
    const sink = vi.fn().mockReturnValue(true);
    const t = new HeldKeyTracker(sink);
    t.down('ControlLeft');
    sink.mockClear();
    const released = t.reconcileModifiers({ ...ALL_DOWN });
    expect(released).toEqual([]);
    expect(sink).not.toHaveBeenCalled();
    expect(t.has('ControlLeft')).toBe(true);
  });

  it('reconcileModifiers NEVER releases held movement keys (no round-4 dump)', () => {
    const sink = vi.fn().mockReturnValue(true);
    const t = new HeldKeyTracker(sink);
    // Holding forward + strafe while NO modifier is down. An event reporting
    // all modifiers up must NOT touch the movement keys.
    t.down('KeyW');
    t.down('ArrowLeft');
    t.down('ControlLeft');
    sink.mockClear();
    const released = t.reconcileModifiers({ ...NONE_DOWN });
    // Only the modifier was released; movement keys stay held.
    expect(released).toEqual(['ControlLeft']);
    expect(t.has('KeyW')).toBe(true);
    expect(t.has('ArrowLeft')).toBe(true);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith('ControlLeft', false);
  });

  it('reconcileModifiers releases left+right of the same modifier independently', () => {
    const sink = vi.fn().mockReturnValue(true);
    const t = new HeldKeyTracker(sink);
    t.down('ShiftLeft');
    t.down('AltRight');
    sink.mockClear();
    // Shift still down, Alt dropped.
    const released = t.reconcileModifiers({ ctrl: false, alt: false, shift: true, meta: false });
    expect(released).toEqual(['AltRight']);
    expect(t.has('ShiftLeft')).toBe(true);
    expect(t.has('AltRight')).toBe(false);
  });

  it('reconcileModifiers is a no-op when nothing is held', () => {
    const sink = vi.fn().mockReturnValue(true);
    const t = new HeldKeyTracker(sink);
    expect(t.reconcileModifiers({ ...NONE_DOWN })).toEqual([]);
    expect(sink).not.toHaveBeenCalled();
  });

  it('has() lets a caller route a keyup that arrives after deselection', () => {
    const sink = vi.fn().mockReturnValue(true);
    const t = new HeldKeyTracker(sink);
    t.down('ArrowRight');
    // Card got deselected; the keyup arrives later. Caller checks has()
    // to know it must still route the release for a key it pressed.
    expect(t.has('ArrowRight')).toBe(true);
    t.up('ArrowRight');
    expect(sink).toHaveBeenCalledWith('ArrowRight', false);
    expect(t.has('ArrowRight')).toBe(false);
  });
});
