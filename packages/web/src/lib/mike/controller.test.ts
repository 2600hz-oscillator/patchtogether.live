// packages/web/src/lib/mike/controller.test.ts
//
// Mike controller lifecycle + pacing assertions. Uses fake timers so we
// can advance through the 5–15 s window synchronously.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMikeController } from './controller';
import { createPatch } from '$lib/graph/store';
import type { Catalog } from './catalog';

const FAKE_CATALOG: Catalog = [
  {
    type: 'drumseqz',
    category: 'sequencers',
    inputs: [{ id: 'clock', cableType: 'gate' }],
    outputs: [
      { id: 'gate1', cableType: 'gate' },
      { id: 'pitch1', cableType: 'pitch' },
    ],
    params: [{ id: 'step1', min: 0, max: 1, defaultValue: 1 }],
  },
  {
    type: 'drummergirl',
    category: 'voices',
    inputs: [{ id: 'gate', cableType: 'gate' }],
    outputs: [{ id: 'audio', cableType: 'audio' }],
    params: [],
  },
  {
    type: 'mixer',
    category: 'utilities',
    inputs: [{ id: 'in1', cableType: 'audio' }],
    outputs: [{ id: 'audio', cableType: 'audio' }],
    params: [],
  },
];

describe('createMikeController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing until start()', () => {
    const { patch, ydoc } = createPatch();
    const ctrl = createMikeController({
      catalog: FAKE_CATALOG,
      driver: { patch, ydoc },
      seed: 1,
      baseTickMs: 100,
      maxTickMs: 200,
    });
    vi.advanceTimersByTime(1000);
    expect(ctrl.intentsApplied).toBe(0);
    expect(ctrl.running).toBe(false);
  });

  it('applies intents on each tick after start()', () => {
    const { patch, ydoc } = createPatch();
    const ctrl = createMikeController({
      catalog: FAKE_CATALOG,
      driver: { patch, ydoc },
      seed: 1,
      baseTickMs: 100,
      maxTickMs: 200,
    });
    ctrl.start();
    expect(ctrl.running).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(ctrl.intentsApplied).toBeGreaterThan(0);
    ctrl.stop();
  });

  it('stop() halts the tick loop immediately', () => {
    const { patch, ydoc } = createPatch();
    const ctrl = createMikeController({
      catalog: FAKE_CATALOG,
      driver: { patch, ydoc },
      seed: 1,
      baseTickMs: 50,
      maxTickMs: 100,
    });
    ctrl.start();
    vi.advanceTimersByTime(500);
    const before = ctrl.intentsApplied;
    ctrl.stop();
    vi.advanceTimersByTime(5000);
    expect(ctrl.intentsApplied).toBe(before);
    expect(ctrl.running).toBe(false);
  });

  it('default pacing falls in the 5000–15000 ms range when neither override is set', () => {
    const { patch, ydoc } = createPatch();
    const ctrl = createMikeController({
      catalog: FAKE_CATALOG,
      driver: { patch, ydoc },
      seed: 7,
      // omit baseTickMs / maxTickMs so defaults take effect
    });
    ctrl.start();
    // Advance enough to do a couple of ticks at the slow default
    // pace (16 s covers at least one).
    vi.advanceTimersByTime(16_000);
    expect(ctrl.lastSleepMs).toBeGreaterThanOrEqual(5000);
    expect(ctrl.lastSleepMs).toBeLessThanOrEqual(15_000);
    ctrl.stop();
  });

  it('mutates the patch via the SyncedStore proxy', () => {
    const { patch, ydoc } = createPatch();
    const ctrl = createMikeController({
      catalog: FAKE_CATALOG,
      driver: { patch, ydoc },
      seed: 1,
      baseTickMs: 20,
      maxTickMs: 40,
    });
    ctrl.start();
    vi.advanceTimersByTime(2000);
    ctrl.stop();
    const ownedNodes = Object.values(patch.nodes).filter((n) =>
      n?.id.startsWith('mike-'),
    );
    expect(ownedNodes.length).toBeGreaterThan(0);
  });
});
