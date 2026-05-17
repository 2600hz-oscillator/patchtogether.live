// packages/web/src/lib/carl/controller.test.ts
//
// Lifecycle + cancellation tests for the Carl tick loop. Uses fake
// timers so the tests run synchronously regardless of the baseTickMs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCarlController } from './controller';
import { createPatch } from '$lib/graph/store';
import type { Catalog } from './catalog';

const FAKE_CATALOG: Catalog = [
  {
    type: 'analogVco',
    category: 'sources',
    inputs: [{ id: 'pitch', cableType: 'cv' }],
    outputs: [{ id: 'out', cableType: 'audio' }],
    params: [{ id: 'detune', min: -100, max: 100, defaultValue: 0 }],
  },
  {
    type: 'filter',
    category: 'filters',
    inputs: [{ id: 'in', cableType: 'audio' }],
    outputs: [{ id: 'out', cableType: 'audio' }],
    params: [{ id: 'cutoff', min: 20, max: 20000, defaultValue: 1000 }],
  },
];

describe('createCarlController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing until start() is called', () => {
    const { patch, ydoc } = createPatch();
    const ctrl = createCarlController({
      catalog: FAKE_CATALOG,
      driver: { patch, ydoc },
      seed: 1,
      baseTickMs: 100,
    });
    vi.advanceTimersByTime(1000);
    expect(ctrl.intentsApplied).toBe(0);
    expect(ctrl.running).toBe(false);
  });

  it('applies intents on each tick after start()', () => {
    const { patch, ydoc } = createPatch();
    const ctrl = createCarlController({
      catalog: FAKE_CATALOG,
      driver: { patch, ydoc },
      seed: 1,
      baseTickMs: 100,
    });
    ctrl.start();
    expect(ctrl.running).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(ctrl.intentsApplied).toBeGreaterThan(0);
    ctrl.stop();
  });

  it('stop() halts the tick loop immediately', () => {
    const { patch, ydoc } = createPatch();
    const ctrl = createCarlController({
      catalog: FAKE_CATALOG,
      driver: { patch, ydoc },
      seed: 1,
      baseTickMs: 50,
    });
    ctrl.start();
    vi.advanceTimersByTime(500);
    const intentsBefore = ctrl.intentsApplied;
    ctrl.stop();
    expect(ctrl.running).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(ctrl.intentsApplied).toBe(intentsBefore);
  });

  it('mutates the patch via the SyncedStore proxy', () => {
    const { patch, ydoc } = createPatch();
    const ctrl = createCarlController({
      catalog: FAKE_CATALOG,
      driver: { patch, ydoc },
      seed: 1,
      baseTickMs: 50,
      idPrefix: 'carl',
    });
    ctrl.start();
    vi.advanceTimersByTime(2000);
    ctrl.stop();
    // At least one Carl-owned node should exist.
    const ownedNodes = Object.values(patch.nodes).filter((n) =>
      n?.id.startsWith('carl-'),
    );
    expect(ownedNodes.length).toBeGreaterThan(0);
  });
});
