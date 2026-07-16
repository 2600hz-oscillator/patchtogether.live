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

describe('AutomationController — continuous overdub + move detection', () => {
  const target = tgt('synth', 'cutoff');
  const track: AutomationTrack = { target, events: [] };

  it('arm → punch-in at the clip’s own wrap → capture a moving param → commit at the NEXT wrap (recording continues)', () => {
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
    // wrap → commit this pass — but recording CONTINUES (continuous overdub)
    h.ctrl.recordTick(c, 0, 8);
    expect(h.ctrl.recording).toBe(true);
    expect(h.committed).not.toBeNull();
    const rec = h.committed!.find((t) => t.target.paramId === 'cutoff')!;
    expect(rec.events.length).toBeGreaterThan(1);
    // captured the sweep (min ~0.1 seed, max ~0.9)
    const vals = rec.events.map((e) => e.value);
    expect(Math.min(...vals)).toBeLessThan(0.2);
    expect(Math.max(...vals)).toBeGreaterThan(0.8);
  });

  it('MULTI-PASS overdub: pass1 records A; pass2 moves B (A preserved, B added); pass3 re-moves A (A’s loop replaced)', () => {
    const A = tgt('a', 'pa');
    const B = tgt('b', 'pb');
    const c = clip([
      { target: A, events: [] },
      { target: B, events: [] },
    ]);
    const h = harness();
    h.set(A, 0.0);
    h.set(B, 0.5);
    h.ctrl.arm();
    h.ctrl.recordTick(c, 6, 8);
    h.ctrl.recordTick(c, 0, 8); // punch-in (pass 1)

    // PASS 1: move A only (0 → 0.9), B flat.
    h.set(A, 0.4); h.ctrl.recordTick(c, 3, 8);
    h.set(A, 0.9); h.ctrl.recordTick(c, 6, 8);
    h.ctrl.recordTick(c, 0, 8); // wrap → commit pass 1 (A moved, B not)
    const afterP1 = h.committed!;
    expect(afterP1.find((t) => t.target.paramId === 'pa')!.events.length).toBeGreaterThan(1);
    expect(afterP1.find((t) => t.target.paramId === 'pb')!.events).toEqual([]); // B untouched

    // Feed the committed events back onto the clip (as the real store commit does)
    // so pass 2 overdubs against the recorded A.
    const c2 = clip(afterP1);
    const aEventsAfterP1 = afterP1.find((t) => t.target.paramId === 'pa')!.events;

    // PASS 2: move B only (0.5 → 0.05); A held flat at its last value → NOT re-moved.
    h.set(A, 0.9); // hold A where it ended (no movement)
    h.set(B, 0.5);
    h.ctrl.recordTick(c2, 3, 8);
    h.set(B, 0.05); h.ctrl.recordTick(c2, 6, 8);
    h.ctrl.recordTick(c2, 0, 8); // wrap → commit pass 2 (B moved, A preserved)
    const afterP2 = h.committed!;
    expect(afterP2.find((t) => t.target.paramId === 'pb')!.events.length).toBeGreaterThan(1); // B now recorded
    expect(afterP2.find((t) => t.target.paramId === 'pa')!.events, 'A preserved across pass 2')
      .toEqual(aEventsAfterP1);

    // PASS 3: re-move A (0.9 → 0.1) → A’s loop REPLACED with the new sweep.
    const c3 = clip(afterP2);
    h.set(A, 0.9); h.ctrl.recordTick(c3, 2, 8);
    h.set(A, 0.1); h.ctrl.recordTick(c3, 6, 8);
    h.ctrl.recordTick(c3, 0, 8); // wrap → commit pass 3
    const afterP3 = h.committed!;
    const aP3 = afterP3.find((t) => t.target.paramId === 'pa')!.events;
    expect(Math.min(...aP3.map((e) => e.value))).toBeLessThan(0.2); // the new downward sweep
    expect(afterP3.find((t) => t.target.paramId === 'pb')!.events.length).toBeGreaterThan(1); // B still there
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
    h.ctrl.recordTick(c, 0, 8); // wrap → commit
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
    h.ctrl.recordTick(c, 0, 8); // wrap
    expect(h.committed).toBeNull();
  });

  it('DISARM mid-pass commits the PARTIAL pass, preserving the untouched tail', () => {
    // Prior automation spans the whole loop; a partial re-record over [0..~4]
    // must replace only that window and KEEP the tail events (step 6).
    const prior: AutomationTrack = {
      target,
      events: [
        { step: 0, value: 0.1 },
        { step: 6, value: 0.7 }, // the TAIL — must survive a partial disarm
      ],
    };
    const c = clip([prior]);
    const h = harness();
    h.set(target, 0.1);
    h.ctrl.arm();
    h.ctrl.recordTick(c, 6, 8);
    h.ctrl.recordTick(c, 0, 8); // punch-in
    // move across the FIRST part of the loop only, then STOP mid-loop (~step 4).
    h.set(target, 0.5); h.ctrl.recordTick(c, 2, 8);
    h.set(target, 0.9); h.ctrl.recordTick(c, 4, 8);
    h.ctrl.disarm(); // manual stop mid-pass → commit partial
    expect(h.ctrl.recording).toBe(false);
    expect(h.committed).not.toBeNull();
    const rec = h.committed!.find((t) => t.target.paramId === 'cutoff')!;
    // the untouched TAIL (step 6 = 0.7) is preserved…
    expect(rec.events.some((e) => e.step === 6 && Math.abs(e.value - 0.7) < 1e-9)).toBe(true);
    // …and the new capture landed only in the recorded window (≤ ~step 4).
    const recorded = rec.events.filter((e) => e.step <= 4.001);
    expect(Math.max(...recorded.map((e) => e.value))).toBeGreaterThan(0.8);
  });

  it('LIGHT/STATE MACHINE never gets stuck: arm → record → disarm → idle (no ‘done’ phase)', () => {
    const c = clip([track]);
    const h = harness();
    h.set(target, 0.1);
    expect(h.ctrl.armed).toBe(false);
    expect(h.ctrl.recording).toBe(false);
    h.ctrl.arm();
    expect(h.ctrl.armed).toBe(true);
    h.ctrl.recordTick(c, 6, 8);
    h.ctrl.recordTick(c, 0, 8); // punch-in
    expect(h.ctrl.recording).toBe(true);
    // many loops go by — it NEVER auto-stops (no punch-out/'done')
    for (let loop = 0; loop < 5; loop++) {
      h.set(target, loop % 2 === 0 ? 0.2 : 0.8);
      h.ctrl.recordTick(c, 4, 8);
      h.ctrl.recordTick(c, 0, 8); // wrap
      expect(h.ctrl.recording, `still recording after loop ${loop}`).toBe(true);
    }
    h.ctrl.disarm(); // manual stop
    expect(h.ctrl.recording).toBe(false);
    expect(h.ctrl.armed).toBe(false); // fully idle — nothing left lit
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
    h.ctrl.recordTick(c, 0, 64); // wrap → commit
    const rec = h.committed!.find((t) => t.target.paramId === 'freq')!;
    expect(rec.events.length).toBeGreaterThan(5);
    expect(rec.events.length).toBeLessThanOrEqual(64); // decimation kept it bounded
    // events span the whole loop
    expect(rec.events[0]!.step).toBeLessThan(2);
    expect(rec.events[rec.events.length - 1]!.step).toBeGreaterThan(60);
  });
});
