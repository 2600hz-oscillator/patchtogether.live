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
function harness(overrides: Partial<AutomationControllerDeps> = {}, maxTracks = 16) {
  const values = new Map<string, number>();
  const drives: { target: AutomationTarget; n: number }[] = [];
  const added: AutomationTarget[] = [];
  let committed: AutomationTrack[] | null = null;
  const trackKeys = new Set<string>();
  const deps: AutomationControllerDeps = {
    readNorm: (t) => values.get(`${t.nodeId} ${t.paramId}`) ?? null,
    curve: () => undefined,
    unitNorm: () => undefined,
    drive: (target, points) => drives.push({ target, n: points.length }),
    commit: (tracks) => (committed = tracks),
    // AUTO-CAPTURE: add an empty track (respecting a MAX), like the store write.
    addTrack: (t) => {
      const k = `${t.nodeId}::${t.paramId}`;
      if (trackKeys.has(k)) return true;
      if (trackKeys.size >= maxTracks) return false;
      trackKeys.add(k);
      added.push(t);
      return true;
    },
    ...overrides,
  };
  const ctrl = new AutomationController(deps);
  const set = (t: AutomationTarget, v: number) => values.set(`${t.nodeId} ${t.paramId}`, v);
  return {
    ctrl,
    set,
    /** set the store value AND mark the param actively touched (record gate). */
    move: (t: AutomationTarget, v: number) => {
      values.set(`${t.nodeId} ${t.paramId}`, v);
      ctrl.notifyTouch(t);
    },
    /** mark a param touched WITHOUT moving it (a hold / re-touch each tick). */
    touch: (t: AutomationTarget) => ctrl.notifyTouch(t),
    drives,
    added,
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
  it('TOUCH-GATED while recording: an UNtouched track PLAYS BACK; a TOUCHED one does not (record wins)', () => {
    const h = harness();
    const track: AutomationTrack = { target: tgt('a', 'p'), events: [{ step: 0, value: 0.5 }] };
    // drive into recording state
    h.ctrl.arm();
    h.ctrl.recordTick(clip([track]), 5, 8);
    h.ctrl.recordTick(clip([track]), 0, 8); // wrap → punch-in → recording
    expect(h.ctrl.recording).toBe(true);
    // NOT touched → it keeps PLAYING BACK even while recording (visible continuity,
    // the fix for "looks like it recorded one pass then stopped").
    h.ctrl.playbackStep(track, 0, 0.5, 100);
    expect(h.drives.length).toBe(1);
    // Now the user TOUCHES it → playback suppressed (live/record wins).
    h.ctrl.notifyTouch(tgt('a', 'p'));
    h.ctrl.playbackStep(track, 0, 0.5, 100);
    expect(h.drives.length).toBe(1); // no new drive
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
    // sweep the param across the loop WHILE TOUCHING it (move = set + touch).
    h.move(target, 0.3);
    h.ctrl.recordTick(c, 2, 8);
    h.move(target, 0.7);
    h.ctrl.recordTick(c, 4, 8);
    h.move(target, 0.9);
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

    // PASS 1: TOUCH + move A only (0 → 0.9); B untouched.
    h.move(A, 0.4); h.ctrl.recordTick(c, 3, 8);
    h.move(A, 0.9); h.ctrl.recordTick(c, 6, 8);
    h.ctrl.recordTick(c, 0, 8); // wrap → commit pass 1 (A moved, B not)
    const afterP1 = h.committed!;
    expect(afterP1.find((t) => t.target.paramId === 'pa')!.events.length).toBeGreaterThan(1);
    expect(afterP1.find((t) => t.target.paramId === 'pb')!.events).toEqual([]); // B untouched

    // Feed the committed events back onto the clip (as the real store commit does)
    // so pass 2 overdubs against the recorded A.
    const c2 = clip(afterP1);
    const aEventsAfterP1 = afterP1.find((t) => t.target.paramId === 'pa')!.events;

    // PASS 2: TOUCH + move B only (0.5 → 0.05); A is NOT touched → preserved + playing.
    h.set(A, 0.9); // A's store value stays (not touched → not recorded)
    h.move(B, 0.5);
    h.ctrl.recordTick(c2, 3, 8);
    h.move(B, 0.05); h.ctrl.recordTick(c2, 6, 8);
    h.ctrl.recordTick(c2, 0, 8); // wrap → commit pass 2 (B moved, A preserved)
    const afterP2 = h.committed!;
    expect(afterP2.find((t) => t.target.paramId === 'pb')!.events.length).toBeGreaterThan(1); // B now recorded
    expect(afterP2.find((t) => t.target.paramId === 'pa')!.events, 'A preserved across pass 2')
      .toEqual(aEventsAfterP1);

    // PASS 3: TOUCH + re-move A (0.9 → 0.1) → A’s loop REPLACED with the new sweep.
    const c3 = clip(afterP2);
    h.move(A, 0.9); h.ctrl.recordTick(c3, 2, 8);
    h.move(A, 0.1); h.ctrl.recordTick(c3, 6, 8);
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
    // TOUCH + move `moved`; `still` is NOT touched → preserved.
    h.move(moved, 0.5);
    h.ctrl.recordTick(c, 3, 8);
    h.move(moved, 0.9);
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

  it('does not commit when a touched param is held FLAT (no motion = no-op)', () => {
    const c = clip([track]);
    const h = harness();
    h.set(target, 0.5);
    h.ctrl.arm();
    h.ctrl.recordTick(c, 6, 8);
    h.ctrl.recordTick(c, 0, 8); // punch-in
    // Touch it every tick but never MOVE it (held flat) → a pre-existing track
    // with no motion is not re-committed.
    h.touch(target); h.ctrl.recordTick(c, 3, 8);
    h.touch(target); h.ctrl.recordTick(c, 6, 8);
    h.ctrl.recordTick(c, 0, 8); // wrap
    expect(h.committed).toBeNull();
  });

  it('does not record a track the user NEVER touches (touch-gated)', () => {
    const c = clip([track]);
    const h = harness();
    h.set(target, 0.5);
    h.ctrl.arm();
    h.ctrl.recordTick(c, 6, 8);
    h.ctrl.recordTick(c, 0, 8); // punch-in
    // The store value even CHANGES (e.g. driven by playback), but with no TOUCH it
    // is not captured — no self-capture feedback.
    h.set(target, 0.9); h.ctrl.recordTick(c, 3, 8);
    h.set(target, 0.2); h.ctrl.recordTick(c, 6, 8);
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
    // TOUCH + move across the FIRST part of the loop, then STOP mid-loop (~step 4).
    h.move(target, 0.5); h.ctrl.recordTick(c, 2, 8);
    h.move(target, 0.9); h.ctrl.recordTick(c, 4, 8);
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

describe('AutomationController — auto-capture (just move a knob, no pre-assign)', () => {
  it('touching an UN-TRACKED param while recording auto-adds it + records its move', () => {
    const A = tgt('a', 'pa');
    const NEW = tgt('b', 'pb');
    const h = harness();
    h.set(A, 0.5);
    h.set(NEW, 0.1);
    h.ctrl.arm();
    const c0 = clip([{ target: A, events: [] }]);
    h.ctrl.recordTick(c0, 6, 8);
    h.ctrl.recordTick(c0, 0, 8); // punch-in
    // The user GRABS an un-assigned control (NEW) mid-pass → auto-add next tick.
    h.move(NEW, 0.3); h.ctrl.recordTick(c0, 2, 8);
    expect(h.added.some((t) => t.paramId === 'pb'), 'NEW was auto-added as a track').toBe(true);
    // The store now holds NEW as a track (the addTrack write) — mirror it.
    const c1 = clip([{ target: A, events: [] }, { target: NEW, events: [] }]);
    h.move(NEW, 0.7); h.ctrl.recordTick(c1, 4, 8);
    h.move(NEW, 0.95); h.ctrl.recordTick(c1, 6, 8);
    h.ctrl.recordTick(c1, 0, 8); // wrap → commit
    const rec = h.committed!.find((t) => t.target.paramId === 'pb');
    expect(rec, 'NEW committed to the clip').toBeTruthy();
    expect(Math.max(...rec!.events.map((e) => e.value))).toBeGreaterThan(0.9);
    // A was never touched → preserved (empty), not overwritten.
    expect(h.committed!.find((t) => t.target.paramId === 'pa')!.events).toEqual([]);
  });

  it('does NOT auto-add past MAX (addTrack returns false → the param is skipped)', () => {
    const NEW = tgt('b', 'pb');
    const c = clip([{ target: tgt('a', 'pa'), events: [] }]);
    const h = harness({ addTrack: () => false }); // simulate the sanity cap reached
    h.set(NEW, 0.1);
    h.ctrl.arm();
    h.ctrl.recordTick(c, 6, 8);
    h.ctrl.recordTick(c, 0, 8); // punch-in
    h.move(NEW, 0.9); h.ctrl.recordTick(c, 3, 8);
    h.ctrl.recordTick(c, 0, 8); // wrap
    // NEW never became a track → nothing committed for it.
    expect(h.committed?.find((t) => t.target.paramId === 'pb')).toBeUndefined();
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
    // simulate ~40 ticks across the 64-step loop with a rising sweep (touching it)
    for (let i = 1; i <= 40; i++) {
      const frac = (i / 41) * 64;
      h.move(target, i / 41);
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
