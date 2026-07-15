// packages/web/src/lib/audio/modules/clip-automation.test.ts
import { describe, it, expect } from 'vitest';
import {
  MAX_AUTOMATION_TRACKS,
  defaultAutomationClip,
  type AutomationClipRecord,
  type AutomationTarget,
} from './clip-types';
import { ensureAutomationTrack, automationCapacityRemaining } from './clip-automation';

const tgt = (nodeId: string, paramId: string): AutomationTarget => ({ nodeId, paramId });

function recWith(targets: AutomationTarget[]): AutomationClipRecord {
  return {
    kind: 'automation',
    lengthSteps: 16,
    loop: true,
    tracks: targets.map((t) => ({ target: t, events: [] })),
  };
}

describe('ensureAutomationTrack ("Assign to automation lane")', () => {
  it('creates a new empty track for a fresh param', () => {
    const rec = defaultAutomationClip();
    const res = ensureAutomationTrack(rec, tgt('synth', 'cutoff'));
    expect(res.created).toBe(true);
    expect(res.track).not.toBeNull();
    expect(res.track!.target).toEqual(tgt('synth', 'cutoff'));
    expect(res.track!.events).toEqual([]);
    expect(res.rec.tracks.length).toBe(1);
    expect(rec.tracks.length).toBe(0); // original untouched (pure)
  });
  it('reuses the existing track (no-op) when the param is already automated', () => {
    const rec = recWith([tgt('synth', 'cutoff')]);
    const res = ensureAutomationTrack(rec, tgt('synth', 'cutoff'));
    expect(res.created).toBe(false);
    expect(res.track!.target).toEqual(tgt('synth', 'cutoff'));
    expect(res.rec.tracks.length).toBe(1);
  });
  it('refuses a new param at the track cap (track=null, record unchanged)', () => {
    let rec = defaultAutomationClip();
    for (let i = 0; i < MAX_AUTOMATION_TRACKS; i++) {
      rec = ensureAutomationTrack(rec, tgt('n' + i, 'p')).rec;
    }
    expect(rec.tracks.length).toBe(MAX_AUTOMATION_TRACKS);
    const res = ensureAutomationTrack(rec, tgt('one-too-many', 'p'));
    expect(res.track).toBeNull();
    expect(res.created).toBe(false);
    expect(res.rec.tracks.length).toBe(MAX_AUTOMATION_TRACKS);
  });
});

describe('automationCapacityRemaining', () => {
  it('counts down to the cap', () => {
    expect(automationCapacityRemaining(defaultAutomationClip())).toBe(MAX_AUTOMATION_TRACKS);
    expect(automationCapacityRemaining(recWith([tgt('a', 'p')]))).toBe(MAX_AUTOMATION_TRACKS - 1);
  });
});
