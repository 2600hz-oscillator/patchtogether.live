// packages/web/src/lib/audio/modules/clip-automation-controller.test.ts
import { describe, it, expect } from 'vitest';
import {
  AutomationController,
  type AutomationControllerDeps,
} from './clip-automation-controller';
import type {
  AutomationClipRecord,
  AutomationTarget,
  AutomationTrack,
} from './clip-types';

const tgt = (nodeId: string, paramId: string): AutomationTarget => ({ nodeId, paramId });

function clip(tracks: AutomationTrack[], lengthSteps = 8): AutomationClipRecord {
  return { kind: 'automation', lengthSteps, loop: true, tracks };
}

/** A fake harness: a value store per target, capture of drive() + commit(). */
function harness(overrides: Partial<AutomationControllerDeps> = {}) {
  const values = new Map<string, number>();
  const drives: { target: AutomationTarget; n: number }[] = [];
  let committed: AutomationTrack[] | null = null;
  const deps: AutomationControllerDeps = {
    readNorm: (t) => values.get(`${t.nodeId} ${t.paramId}`) ?? null,
    curve: () => undefined,
    unitNorm: () => undefined,
    drive: (target, points) => drives.push({ target, n: points.length }),
    commit: (tracks) => (committed = tracks),
    ...overrides,
  };
  const set = (t: AutomationTarget, v: number) => values.set(`${t.nodeId} ${t.paramId}`, v);
  return {
    ctrl: new AutomationController(deps),
    set,
    drives,
    get committed() {
      return committed;
    },
  };
}

describe('AutomationController — playback', () => {
  it('drives ramp points for a track with breakpoints', () => {
    const h = harness();
    const track: AutomationTrack = {
      target: tgt('synth', 'cutoff'),
      events: [
        { step: 0, value: 0.2 },
        { step: 4, value: 0.8 },
      ],
    };
    h.ctrl.playbackStep(track, 0, 0.5, 100);
    expect(h.drives.length).toBe(1);
    expect(h.drives[0]!.target).toEqual(tgt('synth', 'cutoff'));
  });
  it('does NOT drive a suspended (touched) param — live wins', () => {
    const h = harness();
    const track: AutomationTrack = { target: tgt('a', 'p'), events: [{ step: 0, value: 0.5 }] };
    h.ctrl.notifyTouch(tgt('a', 'p'));
    h.ctrl.playbackStep(track, 0, 0.5, 100);
    expect(h.drives.length).toBe(0);
    expect(h.ctrl.overriddenKeys()).toContain('a::p');
    h.ctrl.reEnable(tgt('a', 'p'));
    h.ctrl.playbackStep(track, 0, 0.5, 100);
    expect(h.drives.length).toBe(1);
  });
  it('does NOT play back its own clip while recording (self-capture guard)', () => {
    const h = harness();
    const track: AutomationTrack = { target: tgt('a', 'p'), events: [{ step: 0, value: 0.5 }] };
    // drive into recording state
    h.ctrl.arm();
    h.ctrl.recordTick(clip([track]), 5, 8);
    h.ctrl.recordTick(clip([track]), 0, 8); // wrap → punch-in → recording
    expect(h.ctrl.recording).toBe(true);
    h.ctrl.playbackStep(track, 0, 0.5, 100);
    expect(h.drives.length).toBe(0);
  });
});

describe('AutomationController — quantized record + move detection', () => {
  const target = tgt('synth', 'cutoff');
  const track: AutomationTrack = { target, events: [] };

  it('arm → punch-in at wrap → capture a moving param → punch-out commits it', () => {
    const h = harness();
    h.set(target, 0.1);
    h.ctrl.arm();
    const c = clip([track]);
    // climbing toward the wrap, still armed (not yet recording)
    h.ctrl.recordTick(c, 6, 8);
    expect(h.ctrl.recording).toBe(false);
    // wrap → punch-in
    h.ctrl.recordTick(c, 0, 8);
    expect(h.ctrl.recording).toBe(true);
    // sweep the param across the loop
    h.set(target, 0.3);
    h.ctrl.recordTick(c, 2, 8);
    h.set(target, 0.7);
    h.ctrl.recordTick(c, 4, 8);
    h.set(target, 0.9);
    h.ctrl.recordTick(c, 6, 8);
    // wrap → punch-out → commit
    h.ctrl.recordTick(c, 0, 8);
    expect(h.ctrl.recording).toBe(false);
    expect(h.committed).not.toBeNull();
    const rec = h.committed!.find((t) => t.target.paramId === 'cutoff')!;
    expect(rec.events.length).toBeGreaterThan(1);
    // captured the sweep (min ~0.1 seed, max ~0.9)
    const vals = rec.events.map((e) => e.value);
    expect(Math.min(...vals)).toBeLessThan(0.2);
    expect(Math.max(...vals)).toBeGreaterThan(0.8);
  });

  it('an UNTOUCHED track keeps its existing automation (not overwritten)', () => {
    const moved = tgt('a', 'moved');
    const still = tgt('b', 'still');
    const tracks: AutomationTrack[] = [
      { target: moved, events: [{ step: 0, value: 0.0 }] },
      { target: still, events: [{ step: 0, value: 0.42 }, { step: 4, value: 0.42 }] },
    ];
    const c = clip(tracks);
    const h = harness();
    h.set(moved, 0.0);
    h.set(still, 0.42);
    h.ctrl.arm();
    h.ctrl.recordTick(c, 6, 8);
    h.ctrl.recordTick(c, 0, 8); // punch-in
    // only `moved` changes; `still` holds 0.42
    h.set(moved, 0.5);
    h.ctrl.recordTick(c, 3, 8);
    h.set(moved, 0.9);
    h.ctrl.recordTick(c, 6, 8);
    h.ctrl.recordTick(c, 0, 8); // punch-out → commit
    const committed = h.committed!;
    const stillTrack = committed.find((t) => t.target.paramId === 'still')!;
    // untouched → the ORIGINAL events preserved verbatim
    expect(stillTrack.events).toEqual([
      { step: 0, value: 0.42 },
      { step: 4, value: 0.42 },
    ]);
    const movedTrack = committed.find((t) => t.target.paramId === 'moved')!;
    expect(Math.max(...movedTrack.events.map((e) => e.value))).toBeGreaterThan(0.8);
  });

  it('does not commit when NOTHING moved (flat pass = no-op)', () => {
    const c = clip([track]);
    const h = harness();
    h.set(target, 0.5);
    h.ctrl.arm();
    h.ctrl.recordTick(c, 6, 8);
    h.ctrl.recordTick(c, 0, 8); // punch-in
    h.ctrl.recordTick(c, 3, 8); // value stays 0.5
    h.ctrl.recordTick(c, 6, 8);
    h.ctrl.recordTick(c, 0, 8); // punch-out
    expect(h.committed).toBeNull();
  });

  it('disarm mid-pass drops the capture (no commit)', () => {
    const c = clip([track]);
    const h = harness();
    h.set(target, 0.1);
    h.ctrl.arm();
    h.ctrl.recordTick(c, 6, 8);
    h.ctrl.recordTick(c, 0, 8); // punch-in
    h.set(target, 0.9);
    h.ctrl.recordTick(c, 3, 8);
    h.ctrl.disarm();
    expect(h.ctrl.recording).toBe(false);
    expect(h.committed).toBeNull();
  });

  it('clears touch suspensions at the loop wrap', () => {
    const c = clip([track]);
    const h = harness();
    h.set(target, 0.1);
    h.ctrl.notifyTouch(target);
    expect(h.ctrl.isSuspended(target)).toBe(true);
    h.ctrl.arm();
    h.ctrl.recordTick(c, 6, 8);
    h.ctrl.recordTick(c, 0, 8); // wrap → punch-in clears suspensions
    expect(h.ctrl.isSuspended(target)).toBe(false);
  });
});

describe('AutomationController — long/slow clip (low div, long length)', () => {
  it('records a full pass on a 64-step clip with sub-step motion, bounded events', () => {
    const target = tgt('filter', 'freq');
    const track: AutomationTrack = { target, events: [] };
    const c = clip([track], 64);
    const h = harness();
    h.set(target, 0);
    h.ctrl.arm();
    h.ctrl.recordTick(c, 60, 64);
    h.ctrl.recordTick(c, 0, 64); // punch-in
    // simulate ~40 ticks across the 64-step loop with a rising sweep
    for (let i = 1; i <= 40; i++) {
      const frac = (i / 41) * 64;
      h.set(target, i / 41);
      h.ctrl.recordTick(c, frac, 64);
    }
    h.ctrl.recordTick(c, 0, 64); // punch-out
    const rec = h.committed!.find((t) => t.target.paramId === 'freq')!;
    expect(rec.events.length).toBeGreaterThan(5);
    expect(rec.events.length).toBeLessThanOrEqual(64); // decimation kept it bounded
    // events span the whole loop
    expect(rec.events[0]!.step).toBeLessThan(2);
    expect(rec.events[rec.events.length - 1]!.step).toBeGreaterThan(60);
  });
});
