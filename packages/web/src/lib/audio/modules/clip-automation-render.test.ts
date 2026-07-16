// packages/web/src/lib/audio/modules/clip-automation-render.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  automationCountdownColor,
  automationCountdownOn,
  AUTOMATION_COUNTDOWN_BEATS,
  setAutomationRender,
  getAutomationRender,
  clearAutomationRender,
  __resetAutomationRender,
} from './clip-automation-render';

beforeEach(() => __resetAutomationRender());

describe('automationCountdownColor — 🟡🟡🔴🔴 mapping over the last 4 beats', () => {
  it('4,3 beats → yellow · 2,1 beats → red · outside (0,4] → null', () => {
    expect(AUTOMATION_COUNTDOWN_BEATS).toBe(4);
    expect(automationCountdownColor(4)).toBe('yellow');
    expect(automationCountdownColor(3)).toBe('yellow');
    expect(automationCountdownColor(2)).toBe('red');
    expect(automationCountdownColor(1)).toBe('red');
    // outside the window
    expect(automationCountdownColor(5)).toBeNull();
    expect(automationCountdownColor(4.5)).toBeNull(); // > 4 beats
    expect(automationCountdownColor(0)).toBeNull();
    expect(automationCountdownColor(-1)).toBeNull();
  });
  it('buckets a continuous countdown onto its beat markers (ceil)', () => {
    expect(automationCountdownColor(3.5)).toBe('yellow'); // inside the "4th beat"
    expect(automationCountdownColor(2.5)).toBe('yellow'); // inside the "3rd beat"
    expect(automationCountdownColor(1.5)).toBe('red'); //    inside the "2nd beat"
    expect(automationCountdownColor(0.5)).toBe('red'); //    inside the "1st beat"
  });
});

describe('automationCountdownOn — beat-synced pulse (bright on the beat, dim between)', () => {
  it('bright for the first half of each beat by default', () => {
    expect(automationCountdownOn(0)).toBe(true);
    expect(automationCountdownOn(0.25)).toBe(true);
    expect(automationCountdownOn(0.5)).toBe(false);
    expect(automationCountdownOn(0.75)).toBe(false);
  });
  it('normalises the phase into [0,1) and honours a custom duty', () => {
    expect(automationCountdownOn(1.1)).toBe(true); // 0.1 after normalise
    expect(automationCountdownOn(-0.1)).toBe(false); // 0.9 after normalise
    expect(automationCountdownOn(0.2, 0.25)).toBe(true);
    expect(automationCountdownOn(0.3, 0.25)).toBe(false);
  });
});

describe('automation render state store', () => {
  it('set / get / clear a node’s render state', () => {
    expect(getAutomationRender('n1')).toBeNull();
    setAutomationRender('n1', { lane: 7, slot: 0, recording: true, beatsToLoopEnd: 2.5, beatPhase: 0.1 });
    expect(getAutomationRender('n1')).toEqual({
      lane: 7, slot: 0, recording: true, beatsToLoopEnd: 2.5, beatPhase: 0.1,
    });
    setAutomationRender('n1', null);
    expect(getAutomationRender('n1')).toBeNull();
    setAutomationRender('n1', { lane: 7, slot: 0, recording: true, beatsToLoopEnd: 1, beatPhase: 0 });
    clearAutomationRender('n1');
    expect(getAutomationRender('n1')).toBeNull();
  });
});
