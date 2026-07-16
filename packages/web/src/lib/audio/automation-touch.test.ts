// packages/web/src/lib/audio/automation-touch.test.ts
//
// The TOUCH-SUSPEND registry (task #183): the decoupling seam between a grabbed
// control and the clip-player that automates it. A live grab anywhere calls
// notifyAutomationTouch; the registry fans it out to every registered
// AutomationController's notifyTouch, and the card reads back via
// overriddenKeysFor / clears via reEnableAllFor. Uses a REAL AutomationController
// (its touch/override API is what the card consumes) with no-op engine deps.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerAutomationController,
  unregisterAutomationController,
  notifyAutomationTouch,
  notifyAutomationRelease,
  overriddenKeysFor,
  reEnableAllFor,
  __resetAutomationTouchRegistry,
} from './automation-touch';
import { AutomationController } from './modules/clip-automation-controller';

/** A controller with inert engine deps — only its touch/override state matters. */
function makeController() {
  return new AutomationController({
    readNorm: () => null,
    curve: () => undefined,
    unitNorm: () => undefined,
    drive: () => {},
    readAutoTracks: () => [],
    commit: () => {},
  });
}

describe('automation-touch registry', () => {
  beforeEach(() => __resetAutomationTouchRegistry());

  it('routes notifyAutomationTouch to a registered controller', () => {
    const ctrl = makeController();
    registerAutomationController('cp1', ctrl);
    expect(overriddenKeysFor('cp1')).toEqual([]);

    notifyAutomationTouch({ nodeId: 'synth', paramId: 'cutoff' });

    expect(overriddenKeysFor('cp1')).toContain('synth::cutoff');
    expect(ctrl.isSuspended({ nodeId: 'synth', paramId: 'cutoff' })).toBe(true);
  });

  it('reEnableAllFor clears every override on that controller', () => {
    const ctrl = makeController();
    registerAutomationController('cp1', ctrl);
    notifyAutomationTouch({ nodeId: 'a', paramId: 'p' });
    notifyAutomationTouch({ nodeId: 'b', paramId: 'q' });
    expect(overriddenKeysFor('cp1').length).toBe(2);

    reEnableAllFor('cp1');

    expect(overriddenKeysFor('cp1')).toEqual([]);
    expect(ctrl.isSuspended({ nodeId: 'a', paramId: 'p' })).toBe(false);
  });

  it('unregister stops routing + leaves an unknown node with empty keys', () => {
    const ctrl = makeController();
    registerAutomationController('cp1', ctrl);
    unregisterAutomationController('cp1');

    notifyAutomationTouch({ nodeId: 'a', paramId: 'p' });

    expect(overriddenKeysFor('cp1')).toEqual([]);
    expect(ctrl.isSuspended({ nodeId: 'a', paramId: 'p' })).toBe(false);
  });

  it('fans out to MULTIPLE registered controllers (each player suspends)', () => {
    const a = makeController();
    const b = makeController();
    registerAutomationController('cpA', a);
    registerAutomationController('cpB', b);

    notifyAutomationTouch({ nodeId: 'x', paramId: 'y' });

    expect(overriddenKeysFor('cpA')).toContain('x::y');
    expect(overriddenKeysFor('cpB')).toContain('x::y');
  });

  it('is a safe no-op when nothing is registered (the cheap fast path)', () => {
    expect(() => notifyAutomationTouch({ nodeId: 'z', paramId: 'w' })).not.toThrow();
    expect(() => notifyAutomationRelease({ nodeId: 'z', paramId: 'w' })).not.toThrow();
    expect(overriddenKeysFor('missing')).toEqual([]);
    expect(() => reEnableAllFor('missing')).not.toThrow();
  });

  it('notifyAutomationRelease ends the override (touch → release round-trip)', () => {
    const ctrl = makeController();
    registerAutomationController('cp1', ctrl);
    notifyAutomationTouch({ nodeId: 'synth', paramId: 'cutoff' });
    expect(overriddenKeysFor('cp1')).toContain('synth::cutoff');

    notifyAutomationRelease({ nodeId: 'synth', paramId: 'cutoff' });

    expect(overriddenKeysFor('cp1')).toEqual([]);
    expect(ctrl.isSuspended({ nodeId: 'synth', paramId: 'cutoff' })).toBe(false);
  });

  it('a grab held across a wrap keeps its suspension via the registry (release ends it)', () => {
    // The registry seam mirrors the controller's grab-until-release semantics:
    // a touch stays overriding through record-lane wraps until an explicit release.
    const ctrl = makeController();
    registerAutomationController('cp1', ctrl);
    const t = { nodeId: 'synth', paramId: 'cutoff' };
    notifyAutomationTouch(t);
    ctrl.armLane(0);
    ctrl.recordLaneTick(0, 3, new Set([t.nodeId]), 6, 8);
    ctrl.recordLaneTick(0, 3, new Set([t.nodeId]), 0, 8); // wrap
    expect(ctrl.isSuspended(t)).toBe(true); // still grabbed → still overriding
    notifyAutomationRelease(t);
    expect(ctrl.isSuspended(t)).toBe(false);
  });

  it('forwards the HOLDER surface — one surface releasing leaves another\'s grip live', () => {
    // Per-surface grab ownership across the registry: a screen drag ('pointer')
    // and a MIDI twist ('midi') both grip the same param; the MIDI idle-release
    // must NOT clear the still-held pointer drag.
    const ctrl = makeController();
    registerAutomationController('cp1', ctrl);
    const t = { nodeId: 'synth', paramId: 'cutoff' };
    notifyAutomationTouch(t, 'pointer');
    notifyAutomationTouch(t, 'midi');
    notifyAutomationRelease(t, 'midi');
    expect(ctrl.isSuspended(t)).toBe(true); // pointer still grips it
    notifyAutomationRelease(t, 'pointer');
    expect(ctrl.isSuspended(t)).toBe(false); // last holder released
  });
});
