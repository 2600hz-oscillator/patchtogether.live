// use-present.test.ts
//
// The CARD-SIDE view of the present controller: it resolves the video engine
// and the target screen's rect, then delegates every session to the NODE-scoped
// registry (node-present-registry). Driven here with a fake registry-backing
// `start` seam and a fake engine so it runs under node with no window.open and
// no DOM. (The $state runes resolve to plain values under the vitest svelte
// transform.)
//
// The multi-display semantics asserted here — one popup PER screen, presentAll
// fanning out in one gesture — are the card-facing contract. Their node-keyed
// storage, the render lease and the graph-lifetime teardown are pinned in
// node-present-registry.test.ts.

import { describe, it, expect, vi } from 'vitest';
import { createPresent } from './use-present.svelte';
import { createNodePresentRegistry, type PresentEngine } from './node-present-registry.svelte';
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

function fakeVideoEngine(): PresentEngine & { releases: number } {
  const e = {
    canvas: { width: 1920, height: 1080 } as unknown as PresentEngine['canvas'],
    blitOutputToDrawingBuffer: vi.fn(),
    releases: 0,
    acquireRenderLease: vi.fn(() => () => { e.releases++; }),
  };
  return e;
}

function makeController(opts: { engine?: boolean; blocked?: boolean; nodeId?: string } = {}) {
  const created: ReturnType<typeof fakeSession>[] = [];
  const start = vi.fn((_args: StartPresentArgs): PresentSession | null => {
    if (opts.blocked) return null;
    const session = fakeSession();
    created.push(session);
    return session;
  });
  const registry = createNodePresentRegistry({
    start,
    setInterval: () => null,
    clearInterval: () => {},
  });
  const engine = fakeVideoEngine();
  const host = opts.engine === false
    ? null
    : { getDomain: <T,>(_d: string) => engine as unknown as T };
  const ctrl = createPresent({
    nodeId: () => opts.nodeId ?? 'n1',
    engine: () => host as never,
    fullscreen: { getScreenRect: () => ({ left: 0, top: 0, width: 1920, height: 1080 }) },
    registry,
  });
  return { ctrl, start, created, registry, engine };
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
    expect(created[0]!.stop).toHaveBeenCalledTimes(1); // old one torn down
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

  it('no engine → present is a no-op (returns false, nothing opened)', () => {
    const { ctrl, start } = makeController({ engine: false });
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

  // ── THE OWNER P0, AT THE SEAM THE CARD SEES ───────────────────────────────
  // A card CANNOT tear a projector down, because the only method that ever did
  // is gone from the interface. `tsc` is the gate; this asserts the runtime
  // shape too, so a JS caller cannot resurrect it either.
  it('exposes NO dispose() — a view unmount has no way to close a projector', () => {
    const { ctrl } = makeController();
    expect((ctrl as unknown as { dispose?: unknown }).dispose).toBeUndefined();
  });

  // The reactive read is off the REGISTRY, not a closure, which is what lets a
  // card that mounted AFTER the projector opened show "Stop presenting".
  it('a FRESH controller for the same node sees the projector the old one opened', () => {
    const { ctrl, registry } = makeController();
    ctrl.present('s1');
    const reMounted = createPresent({
      nodeId: () => 'n1',
      engine: () => null,
      fullscreen: { getScreenRect: () => null },
      registry,
    });
    expect(reMounted.isPresenting, 'the re-expanded card knows it is presenting').toBe(true);
    expect(reMounted.presentingCount).toBe(1);
  });

  it('controllers for DIFFERENT nodes do not see each other', () => {
    const a = makeController({ nodeId: 'a' });
    const b = createPresent({
      nodeId: () => 'b',
      engine: () => null,
      fullscreen: { getScreenRect: () => null },
      registry: a.registry,
    });
    a.ctrl.present('s1');
    expect(a.ctrl.isPresenting).toBe(true);
    expect(b.isPresenting).toBe(false);
  });
});
