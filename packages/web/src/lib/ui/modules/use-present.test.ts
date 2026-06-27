// use-present.test.ts
//
// Multi-display present controller: holds one popup session PER screen so a
// venue can light up every projector, and `presentAll` fans out in one call
// (one user gesture). Drives the controller with a fake `start` seam + a fake
// canvas so it runs under node with no real window.open / DOM. (The $state runes
// resolve to plain values under the vitest svelte transform.)

import { describe, it, expect, vi } from 'vitest';
import { createPresent } from './use-present.svelte';
import type { PresentSession, StartPresentArgs } from './present-window';

/** A controllable fake session — flip `closed` to simulate the user closing the
 *  popup window directly. */
function fakeSession(): PresentSession & { stop: ReturnType<typeof vi.fn> } {
  let closed = false;
  return {
    stop: vi.fn(() => { closed = true; }),
    get closed() { return closed; },
  };
}

function makeController(opts: { canvas?: HTMLCanvasElement | null; blocked?: boolean } = {}) {
  const created: { id?: string; session: ReturnType<typeof fakeSession> }[] = [];
  const canvas = opts.canvas === undefined ? ({} as HTMLCanvasElement) : opts.canvas;
  let nextRectId = 0;
  const start = vi.fn((_args: StartPresentArgs): PresentSession | null => {
    if (opts.blocked) return null;
    const session = fakeSession();
    created.push({ id: String(nextRectId++), session });
    return session;
  });
  const ctrl = createPresent({
    getCanvas: () => canvas,
    fullscreen: { getScreenRect: () => ({ left: 0, top: 0, width: 1920, height: 1080 }) },
    start,
  });
  return { ctrl, start, created };
}

describe('present controller — multi-display sessions', () => {
  it('present(id) opens one popup and reports presenting', () => {
    const { ctrl, start } = makeController();
    expect(ctrl.isPresenting).toBe(false);
    expect(ctrl.present('screen-a')).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(ctrl.isPresenting).toBe(true);
    expect(ctrl.presentingCount).toBe(1);
  });

  it('present() on a SECOND display keeps the first open (one popup per screen)', () => {
    const { ctrl, start } = makeController();
    ctrl.present('screen-a');
    ctrl.present('screen-b');
    expect(start).toHaveBeenCalledTimes(2);
    expect(ctrl.presentingCount).toBe(2); // both live — not replaced
  });

  it('present() on the SAME display replaces that screen only (stops the old)', () => {
    const { ctrl, created } = makeController();
    ctrl.present('screen-a');
    ctrl.present('screen-a');
    expect(created[0].session.stop).toHaveBeenCalledTimes(1); // old one torn down
    expect(ctrl.presentingCount).toBe(1);
  });

  it('THE FEATURE: presentAll fans a popup out to every display in one call', () => {
    const { ctrl, start } = makeController();
    const opened = ctrl.presentAll(['s1', 's2', 's3']);
    expect(opened).toBe(3);
    expect(start).toHaveBeenCalledTimes(3);
    expect(ctrl.presentingCount).toBe(3);
  });

  it('presentAll skips displays already presenting (idempotent top-up)', () => {
    const { ctrl } = makeController();
    ctrl.present('s1');
    const opened = ctrl.presentAll(['s1', 's2']); // s1 already lit
    expect(opened).toBe(1); // only s2 newly opened
    expect(ctrl.presentingCount).toBe(2);
  });

  it('stop(id) closes one display; stop() closes all', () => {
    const { ctrl } = makeController();
    ctrl.presentAll(['s1', 's2', 's3']);
    ctrl.stop('s2');
    expect(ctrl.presentingCount).toBe(2);
    ctrl.stop();
    expect(ctrl.presentingCount).toBe(0);
    expect(ctrl.isPresenting).toBe(false);
  });

  it('no canvas → present is a no-op (returns false, nothing opened)', () => {
    const { ctrl, start } = makeController({ canvas: null });
    expect(ctrl.present('s1')).toBe(false);
    expect(ctrl.presentAll(['s1', 's2'])).toBe(0);
    expect(start).not.toHaveBeenCalled();
  });

  it('popup blocked → counts nothing as opened', () => {
    const { ctrl } = makeController({ blocked: true });
    expect(ctrl.present('s1')).toBe(false);
    expect(ctrl.presentAll(['s1', 's2'])).toBe(0);
    expect(ctrl.presentingCount).toBe(0);
  });

  it('dispose tears every popup down', () => {
    const { ctrl, created } = makeController();
    ctrl.presentAll(['s1', 's2']);
    ctrl.dispose();
    expect(ctrl.presentingCount).toBe(0);
    for (const c of created) expect(c.session.stop).toHaveBeenCalled();
  });
});
