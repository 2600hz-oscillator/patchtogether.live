// skifree-bridge.test.ts
//
// #1590 — SKIFREE's GATE output died permanently after one collapse-and-re-expand.
//
// The bridge is ONE object with TWO owners on DIFFERENT lifetimes: `onGate` belongs to the
// FACTORY (set once at materialize, node-lifetime), `controller` belongs to the CARD.
// The card's teardown deleted the whole object, so the factory's callback went with it —
// and since the factory never runs again, GATE was dead for the life of the node while the
// game, HUD and video all came back looking healthy.
//
// So the property under test is OWNERSHIP: each side clears only what it set, and neither
// removes the container.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  ensureSkifreeBridge,
  releaseSkifreeCardState,
  releaseSkifreeGate,
} from './skifree-bridge';
import type { SkifreeBridge } from './skifree';

function peek(): SkifreeBridge | undefined {
  return (globalThis as unknown as { __skifree?: SkifreeBridge }).__skifree;
}

beforeEach(() => {
  delete (globalThis as unknown as { __skifree?: unknown }).__skifree;
});

describe('two owners, one bridge', () => {
  it('THE REGRESSION: a card teardown must not take the factory\'s onGate with it', () => {
    // Materialize (factory), then the card publishes its controller.
    const bridge = ensureSkifreeBridge();
    const onGate = () => {};
    bridge.onGate = onGate;
    const controller = { dispose() {} } as unknown as SkifreeBridge['controller'];
    bridge.controller = controller;

    // COLLAPSE — the card unmounts.
    releaseSkifreeCardState();

    expect(peek(), 'the container itself must survive — deleting it was the bug').toBeDefined();
    expect(
      peek()?.onGate,
      'GATE is dead for the life of the node if this is null (#1590)',
    ).toBe(onGate);
    expect(peek()?.controller, 'the card DOES release its own field').toBeNull();
  });

  it('re-expanding finds a working gate', () => {
    // The end-to-end statement of the bug, in one test.
    const bridge = ensureSkifreeBridge();
    let pulses = 0;
    bridge.onGate = () => { pulses++; };
    bridge.controller = { dispose() {} } as unknown as SkifreeBridge['controller'];

    releaseSkifreeCardState();          // collapse
    const remounted = ensureSkifreeBridge(); // re-expand
    remounted.controller = { dispose() {} } as unknown as SkifreeBridge['controller'];

    remounted.onGate?.({ type: 'crash' });
    expect(pulses, 'a crash after re-expanding must still pulse the gate').toBe(1);
  });

  it('NEGATIVE CONTROL: the FACTORY can still clear its own callback', () => {
    // Without this leg, `releaseSkifreeCardState` preserving onGate would be
    // indistinguishable from onGate simply being unclearable — i.e. a leak dressed up as
    // a fix. This proves the field is releasable by its actual owner.
    const bridge = ensureSkifreeBridge();
    const onGate = () => {};
    bridge.onGate = onGate;

    releaseSkifreeGate(onGate);
    expect(peek()?.onGate, 'the factory owns onGate and may release it').toBeNull();
    expect(peek(), 'still without deleting the container').toBeDefined();
  });

  it('the factory will not clobber a NEWER callback than its own', () => {
    // A re-materialize can install a fresh onGate before the old node's dispose runs.
    const bridge = ensureSkifreeBridge();
    const older = () => {};
    const newer = () => {};
    bridge.onGate = older;
    bridge.onGate = newer;

    releaseSkifreeGate(older); // the OLD materialization tearing down late
    expect(peek()?.onGate, 'the newer registration must survive').toBe(newer);
  });

  it('the card will not clobber a NEWER controller than its own', () => {
    const bridge = ensureSkifreeBridge();
    const oldCtl = { dispose() {} } as unknown as SkifreeBridge['controller'];
    const newCtl = { dispose() {} } as unknown as SkifreeBridge['controller'];
    bridge.controller = oldCtl;
    bridge.controller = newCtl;

    releaseSkifreeCardState(oldCtl); // the OLD card unmounting after the new one mounted
    expect(peek()?.controller, 'the newer card keeps its controller').toBe(newCtl);
  });

  it('ensure is idempotent and shared — one object, not two shapes', () => {
    // The two owners each hand-wrote the same initializer literal, which is how they came
    // to disagree. One seam means they cannot.
    const a = ensureSkifreeBridge();
    a.onGate = () => {};
    const b = ensureSkifreeBridge();
    expect(b, 'same object').toBe(a);
    expect(b.onGate, 'a second ensure must not reset live state').not.toBeNull();
  });

  it('releasing before anything exists is a no-op, not a crash', () => {
    expect(() => releaseSkifreeCardState()).not.toThrow();
    expect(() => releaseSkifreeGate(null)).not.toThrow();
    expect(peek(), 'and does not conjure a bridge').toBeUndefined();
  });

  it('exposes no way to remove the container — the absence IS the guard', async () => {
    const mod = await import('./skifree-bridge');
    for (const forbidden of ['deleteBridge', 'resetBridge', 'clearBridge', 'disposeBridge']) {
      expect(
        forbidden in mod,
        `skifree-bridge.${forbidden}() would re-enable the #1590 regression`,
      ).toBe(false);
    }
    // POSITIVE CONTROL: the probe can see the exports that DO exist.
    expect('ensureSkifreeBridge' in mod).toBe(true);
    expect('releaseSkifreeCardState' in mod).toBe(true);
  });
});
