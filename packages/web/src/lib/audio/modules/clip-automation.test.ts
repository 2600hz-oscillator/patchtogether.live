// packages/web/src/lib/audio/modules/clip-automation.test.ts
import { describe, it, expect } from 'vitest';
import {
  MAX_AUTOMATION_TRACKS,
  defaultAutomationClip,
  type AutomationClipRecord,
  type AutomationTarget,
} from './clip-types';
import {
  AUTOMATION_DEFAULT_CC,
  usedAutomationChannels,
  assignAutomationIdentity,
  ensureAutomationTrack,
  automationCapacityRemaining,
} from './clip-automation';

const tgt = (nodeId: string, paramId: string): AutomationTarget => ({ nodeId, paramId });

function recWith(targets: Array<{ t: AutomationTarget; channel: number; cc: number }>): AutomationClipRecord {
  return {
    kind: 'automation',
    lengthSteps: 16,
    loop: true,
    tracks: targets.map(({ t, channel, cc }) => ({ target: t, channel, cc, events: [] })),
  };
}

describe('assignAutomationIdentity (scheme A: one channel per param)', () => {
  it('reuses an existing MIDI/Electra identity verbatim (no channel consumed)', () => {
    const id = assignAutomationIdentity({ channel: 7, cc: 74 }, new Set([0, 1, 2]));
    expect(id).toEqual({ channel: 7, cc: 74 });
  });
  it('clamps a reused identity into valid MIDI range', () => {
    expect(assignAutomationIdentity({ channel: 99, cc: 999 }, new Set())).toEqual({
      channel: 15,
      cc: 127,
    });
  });
  it('assigns the lowest free channel with the canonical automation CC', () => {
    expect(assignAutomationIdentity(null, new Set([0, 1, 3]))).toEqual({
      channel: 2,
      cc: AUTOMATION_DEFAULT_CC,
    });
  });
  it('returns null when all 16 channels are taken (the documented limit)', () => {
    const all = new Set(Array.from({ length: MAX_AUTOMATION_TRACKS }, (_, i) => i));
    expect(assignAutomationIdentity(null, all)).toBeNull();
  });
});

describe('usedAutomationChannels', () => {
  const rec = recWith([
    { t: tgt('a', 'x'), channel: 0, cc: 1 },
    { t: tgt('b', 'y'), channel: 3, cc: 1 },
  ]);
  it('collects channels in use', () => {
    expect([...usedAutomationChannels(rec)].sort()).toEqual([0, 3]);
  });
  it('can exclude one target so a re-assign keeps its own channel', () => {
    expect([...usedAutomationChannels(rec, tgt('b', 'y'))]).toEqual([0]);
  });
});

describe('ensureAutomationTrack ("Assign to automation lane")', () => {
  it('creates a new track for a fresh, unmapped param', () => {
    const rec = defaultAutomationClip();
    const res = ensureAutomationTrack(rec, tgt('synth', 'cutoff'), null);
    expect(res.created).toBe(true);
    expect(res.track).not.toBeNull();
    expect(res.track!.channel).toBe(0);
    expect(res.track!.cc).toBe(AUTOMATION_DEFAULT_CC);
    expect(res.rec.tracks.length).toBe(1);
    // original untouched (pure)
    expect(rec.tracks.length).toBe(0);
  });
  it('reuses the existing MIDI map for an already-mapped param', () => {
    const rec = defaultAutomationClip();
    const res = ensureAutomationTrack(rec, tgt('synth', 'cutoff'), { channel: 9, cc: 74 });
    expect(res.track!.channel).toBe(9);
    expect(res.track!.cc).toBe(74);
  });
  it('returns the existing track (no-op) when the param is already automated', () => {
    const rec = recWith([{ t: tgt('synth', 'cutoff'), channel: 5, cc: 1 }]);
    const res = ensureAutomationTrack(rec, tgt('synth', 'cutoff'), null);
    expect(res.created).toBe(false);
    expect(res.track!.channel).toBe(5);
    expect(res.rec.tracks.length).toBe(1);
  });
  it('assigns distinct channels across successive params', () => {
    let rec = defaultAutomationClip();
    rec = ensureAutomationTrack(rec, tgt('a', 'p'), null).rec;
    rec = ensureAutomationTrack(rec, tgt('b', 'p'), null).rec;
    rec = ensureAutomationTrack(rec, tgt('c', 'p'), null).rec;
    expect(rec.tracks.map((t) => t.channel)).toEqual([0, 1, 2]);
  });
  it('refuses a new param at the 16-track limit (track=null, record unchanged)', () => {
    let rec = defaultAutomationClip();
    for (let i = 0; i < MAX_AUTOMATION_TRACKS; i++) {
      rec = ensureAutomationTrack(rec, tgt('n' + i, 'p'), null).rec;
    }
    expect(rec.tracks.length).toBe(MAX_AUTOMATION_TRACKS);
    const res = ensureAutomationTrack(rec, tgt('one-too-many', 'p'), null);
    expect(res.track).toBeNull();
    expect(res.created).toBe(false);
    expect(res.rec.tracks.length).toBe(MAX_AUTOMATION_TRACKS);
  });
});

describe('automationCapacityRemaining', () => {
  it('counts down to the limit', () => {
    expect(automationCapacityRemaining(defaultAutomationClip())).toBe(MAX_AUTOMATION_TRACKS);
    const rec = recWith([{ t: tgt('a', 'p'), channel: 0, cc: 1 }]);
    expect(automationCapacityRemaining(rec)).toBe(MAX_AUTOMATION_TRACKS - 1);
  });
});
