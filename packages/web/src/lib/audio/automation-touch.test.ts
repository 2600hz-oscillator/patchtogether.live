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
    expect(overriddenKeysFor('missing')).toEqual([]);
    expect(() => reEnableAllFor('missing')).not.toThrow();
  });
});
