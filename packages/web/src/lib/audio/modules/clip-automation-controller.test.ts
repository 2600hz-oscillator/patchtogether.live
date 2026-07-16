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
  const holds: {
    target: AutomationTarget;
    toValueNorm: number | null;
    glideS: number;
    atTime: number | undefined;
  }[] = [];
  let committed: AutomationTrack[] | null = null;
  const trackKeys = new Set<string>();
  const deps: AutomationControllerDeps = {
    readNorm: (t) => values.get(`${t.nodeId} ${t.paramId}`) ?? null,
    curve: () => undefined,
    unitNorm: () => undefined,
    drive: (target, points) => drives.push({ target, n: points.length }),
    hold: (target, toValueNorm, glideS, atTime) => holds.push({ target, toValueNorm, glideS, atTime }),
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
    /** physical release of a grabbed control. */
    release: (t: AutomationTarget) => ctrl.notifyRelease(t),
    drives,
    added,
    holds,
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

  it('a GRABBED gesture KEEPS its suspension across the loop wrap (released only on physical release)', () => {
    // Phase 0 param-jump policy: the override ends on the hand lifting, NOT the
    // wrap — so a knob gesture spanning a loop isn't yanked to the envelope
    // mid-drag. (Was: suspensions cleared at every wrap — the live bug.)
    const c = clip([track]);
    const h = harness();
    h.set(target, 0.1);
    h.ctrl.notifyTouch(target); // grab (pointer-down), never released
    expect(h.ctrl.isSuspended(target)).toBe(true);
    h.ctrl.arm();
    h.ctrl.recordTick(c, 6, 8);
    h.ctrl.recordTick(c, 0, 8); // wrap → punch-in: grabbed param STAYS suspended
    expect(h.ctrl.isSuspended(target)).toBe(true);
    // The hand lifts → NOW it re-enables (playback resumes next loop).
    h.ctrl.notifyRelease(target);
    expect(h.ctrl.isSuspended(target)).toBe(false);
  });

  it('a RELEASED (non-grabbed) suspension still clears at the wrap', () => {
    // A momentary touch that was released before the wrap must not linger.
    const c = clip([track]);
    const h = harness();
    h.set(target, 0.1);
    h.ctrl.notifyTouch(target);
    h.ctrl.notifyRelease(target); // released before the wrap
    expect(h.ctrl.isSuspended(target)).toBe(false);
    h.ctrl.arm();
    h.ctrl.recordTick(c, 6, 8);
    h.ctrl.recordTick(c, 0, 8);
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

describe('AutomationController — param-jump policy (Phase 0 seams)', () => {
  const target = tgt('synth', 'cutoff');

  it('holdLastValue: DETERMINISTIC resting recompute (linear interp at the stop step)', () => {
    // A stop at step 3 on a 0→8 ramp (0.2 at 0, 0.8 at 8) resolves to 0.2 + 6/8·(0.6)…
    // exactly automationLinearAt at step 3 = 0.2 + (3/8)*(0.8-0.2)/1 …computed below.
    const track: AutomationTrack = {
      target,
      events: [{ step: 0, value: 0.2 }, { step: 8, value: 0.8 }],
    };
    const h = harness();
    h.ctrl.holdLastValue(clip([track]), 3, 0.012);
    expect(h.holds.length).toBe(1);
    const hd = h.holds[0]!;
    expect(hd.target).toEqual(target);
    expect(hd.glideS).toBe(0.012);
    // linear at step 3: 0.2 + (3-0)/(8-0)*(0.8-0.2) = 0.2 + 0.375*0.6 = 0.425
    expect(hd.toValueNorm).toBeCloseTo(0.425, 9);
  });

  it('holdLastValue is a PURE function of clip+step (same input → same value, multiplayer-safe)', () => {
    const track: AutomationTrack = {
      target,
      events: [{ step: 0, value: 0.1 }, { step: 4, value: 0.9 }, { step: 8, value: 0.3 }],
    };
    const c = clip([track]);
    const a = harness();
    const b = harness();
    a.ctrl.holdLastValue(c, 5.5, 0.012);
    b.ctrl.holdLastValue(c, 5.5, 0.012);
    // Two independent "peers" converge on the identical resting value by construction.
    expect(a.holds[0]!.toValueNorm).toBe(b.holds[0]!.toValueNorm);
  });

  it('holdLastValue skips a param a hand is holding (the hand owns it) + one with no value yet', () => {
    const held = tgt('a', 'held');
    const future = tgt('b', 'future');
    const c = clip([
      { target: held, events: [{ step: 0, value: 0.5 }] },
      { target: future, events: [{ step: 6, value: 0.5 }] }, // no value at step 2
    ]);
    const h = harness();
    h.ctrl.notifyTouch(held); // grabbed → excluded from hold-last-value
    h.ctrl.holdLastValue(c, 2, 0.012);
    expect(h.holds.map((x) => x.target.paramId)).toEqual([]); // held excluded, future has no value yet
  });

  it('holdLastValue NEVER snaps to zero/default (holds the real envelope value)', () => {
    const track: AutomationTrack = { target, events: [{ step: 0, value: 0.7 }, { step: 8, value: 0.7 }] };
    const h = harness();
    h.ctrl.holdLastValue(clip([track]), 4, 0.012);
    expect(h.holds[0]!.toValueNorm).toBeCloseTo(0.7, 9); // NOT 0
  });

  it('touch TRUNCATES the scheduled tail (hold with null value) for a DRIVEN param', () => {
    const track: AutomationTrack = { target, events: [{ step: 0, value: 0.3 }, { step: 4, value: 0.9 }] };
    const h = harness();
    // Drive it so it's a "currently driven" target (scopes the truncate).
    h.ctrl.playbackStep(track, 0, 0.5, 100);
    h.holds.length = 0; // ignore any earlier
    h.ctrl.notifyTouch(target); // grab → truncate the tail
    expect(h.holds.length).toBe(1);
    expect(h.holds[0]!.toValueNorm).toBeNull(); // truncate-only (manual input is the new writer)
    expect(h.holds[0]!.glideS).toBe(0);
  });

  it('touch does NOT truncate a param this player is NOT driving (no cross-writer cancel)', () => {
    const other = tgt('other', 'p');
    const h = harness();
    // never played `other` → not in drivenKeys → grabbing it truncates nothing here.
    h.ctrl.notifyTouch(other);
    expect(h.holds.length).toBe(0);
  });

  it('touch truncates ONCE per grab (idempotent while held)', () => {
    const track: AutomationTrack = { target, events: [{ step: 0, value: 0.3 }] };
    const h = harness();
    h.ctrl.playbackStep(track, 0, 0.5, 100);
    h.holds.length = 0;
    h.ctrl.notifyTouch(target);
    h.ctrl.notifyTouch(target); // re-touch (e.g. per CC message) → no second truncate
    expect(h.holds.length).toBe(1);
  });

  it('playbackStep passes the seam glide through to the drive points (wrap de-zipper)', () => {
    const track: AutomationTrack = { target, events: [{ step: 0, value: 0.2 }, { step: 4, value: 0.8 }] };
    const drivePts: import('./clip-automation-engine').RampPoint[][] = [];
    const h = harness({ drive: (_t, pts) => drivePts.push(pts) });
    // WRAP seam: step 0 with a glide → the anchor point is a RAMP, not a hard step.
    h.ctrl.playbackStep(track, 0, 0.5, 10, 0.012);
    expect(drivePts.length).toBe(1);
    expect(drivePts[0]![0]!.ramp).toBe(true);
    expect(drivePts[0]![0]!.at).toBeCloseTo(10.012, 9);
  });

  it('a gesture spanning a wrap keeps CAPTURING (still sampled next pass while grabbed)', () => {
    // The live bug: at the wrap the capture stopped sampling a still-held param
    // ("second loop records nothing"). Now a grabbed param keeps being sampled.
    const track: AutomationTrack = { target, events: [] };
    const c = clip([track]);
    const h = harness();
    h.set(target, 0.1);
    h.ctrl.arm();
    h.ctrl.recordTick(c, 6, 8);
    h.ctrl.recordTick(c, 0, 8); // punch-in
    h.move(target, 0.5); h.ctrl.recordTick(c, 4, 8); // move in pass 1
    h.ctrl.recordTick(c, 0, 8); // WRAP (commit pass 1) — param still grabbed
    // Pass 2: keep moving WITHOUT re-touching every tick (still physically held).
    h.set(target, 0.9); h.ctrl.recordTick(c, 4, 8);
    h.ctrl.recordTick(c, 0, 8); // wrap → commit pass 2 captured the held motion
    const rec = h.committed!.find((t) => t.target.paramId === 'cutoff')!;
    expect(Math.max(...rec.events.map((e) => e.value))).toBeGreaterThan(0.8); // pass-2 motion captured
  });

  // ── fix #5: per-surface grab ownership ─────────────────────────────────────
  it('DUAL-SURFACE grab: the first surface releasing does NOT clear the other surface\'s grip', () => {
    const h = harness();
    h.ctrl.notifyTouch(target, 'pointer'); // screen drag grabs it
    h.ctrl.notifyTouch(target, 'midi'); // a MIDI twist grabs it too
    expect(h.ctrl.isSuspended(target)).toBe(true);
    // The MIDI stream idles → its holder releases. The POINTER still grips it:
    // the override must NOT end (the yank-mid-drag regression).
    h.ctrl.notifyRelease(target, 'midi');
    expect(h.ctrl.isSuspended(target)).toBe(true);
    // ...and it still survives a wrap while the pointer holds.
    h.ctrl.arm();
    h.ctrl.recordTick(clip([{ target, events: [] }]), 6, 8);
    h.ctrl.recordTick(clip([{ target, events: [] }]), 0, 8); // wrap
    expect(h.ctrl.isSuspended(target)).toBe(true);
    // The LAST holder releases → now the override ends.
    h.ctrl.notifyRelease(target, 'pointer');
    expect(h.ctrl.isSuspended(target)).toBe(false);
  });

  it('DUAL-SURFACE: releasing a holder that never grabbed is a no-op on the live grip', () => {
    const h = harness();
    h.ctrl.notifyTouch(target, 'pointer');
    h.ctrl.notifyRelease(target, 'electra'); // wrong surface → grip intact
    expect(h.ctrl.isSuspended(target)).toBe(true);
    h.ctrl.notifyRelease(target, 'pointer');
    expect(h.ctrl.isSuspended(target)).toBe(false);
  });

  // ── fix #6: per-track commit window ────────────────────────────────────────
  it('a wrap-spanning gesture does NOT erase its own pass-1 recording past its pass-2 release point', () => {
    // Pass 1: hold + move across the WHOLE loop → commit records the full loop.
    // Pass 2 (gesture continues past the wrap): release at ~step 3 → the wrap
    // commit must merge only [0, 3.x] and PRESERVE pass-1's events in (3.x, len)
    // — the old single global [0,len) window wiped them.
    const track: AutomationTrack = { target, events: [] };
    const h = harness();
    h.set(target, 0.1);
    h.ctrl.arm();
    h.ctrl.recordTick(clip([track]), 6, 8);
    h.ctrl.recordTick(clip([track]), 0, 8); // punch-in (pass 1)
    // PASS 1: full-loop sweep 0.1 → 0.9 while held.
    h.move(target, 0.3); h.ctrl.recordTick(clip([track]), 2, 8);
    h.move(target, 0.6); h.ctrl.recordTick(clip([track]), 4, 8);
    h.move(target, 0.9); h.ctrl.recordTick(clip([track]), 7, 8);
    h.ctrl.recordTick(clip([track]), 0, 8); // wrap → commit pass 1 (still grabbed)
    const pass1 = h.committed!.find((t) => t.target.paramId === 'cutoff')!.events;
    const pass1Tail = pass1.filter((e) => e.step > 4);
    expect(pass1Tail.length, 'pass 1 recorded into the loop tail').toBeGreaterThan(0);
    // PASS 2 (same physical gesture): keep moving until ~step 3, then RELEASE.
    const c2 = clip([{ target, events: pass1 }]); // the store now holds pass 1
    h.set(target, 0.2); h.ctrl.recordTick(c2, 1, 8);
    h.set(target, 0.05); h.ctrl.recordTick(c2, 3, 8);
    h.release(target); // hand lifts at step 3 — capture stops extending
    h.ctrl.recordTick(c2, 5, 8);
    h.ctrl.recordTick(c2, 0, 8); // wrap → commit pass 2
    const pass2 = h.committed!.find((t) => t.target.paramId === 'cutoff')!.events;
    // The re-covered window [0, ~3] holds the new downward move…
    const head = pass2.filter((e) => e.step <= 3.001);
    expect(Math.min(...head.map((e) => e.value))).toBeLessThan(0.1);
    // …and pass 1's tail PAST the release point survives verbatim.
    for (const e of pass1Tail) {
      expect(
        pass2.some((p) => p.step === e.step && Math.abs(p.value - e.value) < 1e-9),
        `pass-1 tail event @${e.step} preserved`,
      ).toBe(true);
    }
  });

  it('DISARM partial still bounds each track to its OWN sampled window (per-track, not global)', () => {
    // Two tracks; A sampled to step 2, B sampled to step 5. The global
    // passLastStep is 5, but A's window must end at 2 — B's motion must not
    // widen A's replace window over A's existing later events.
    const A = tgt('a', 'pa');
    const B = tgt('b', 'pb');
    const priorA: AutomationTrack = {
      target: A,
      events: [{ step: 0, value: 0.5 }, { step: 4, value: 0.9 }], // step-4 must survive
    };
    const trB: AutomationTrack = { target: B, events: [] };
    const c = clip([priorA, trB]);
    const h = harness();
    h.set(A, 0.5);
    h.set(B, 0.1);
    h.ctrl.arm();
    h.ctrl.recordTick(c, 6, 8);
    h.ctrl.recordTick(c, 0, 8); // punch-in
    h.move(A, 0.1); h.move(B, 0.3); h.ctrl.recordTick(c, 2, 8);
    h.release(A); // A's gesture ends at step 2
    h.move(B, 0.8); h.ctrl.recordTick(c, 5, 8); // B keeps going to step 5
    h.ctrl.disarm(); // partial commit (global end = 5)
    const outA = h.committed!.find((t) => t.target.paramId === 'pa')!.events;
    expect(
      outA.some((e) => e.step === 4 && Math.abs(e.value - 0.9) < 1e-9),
      "A's existing step-4 event survives (A's window ended at 2)",
    ).toBe(true);
  });

  // ── fix #7: release-resume glide ───────────────────────────────────────────
  it('release PINS the hand-off value and the next driven step RAMPS back (no hard snap)', () => {
    const track: AutomationTrack = {
      target,
      events: [{ step: 0, value: 0.2 }, { step: 8, value: 0.9 }],
    };
    const drivePts: import('./clip-automation-engine').RampPoint[][] = [];
    const h = harness({ drive: (_t, pts) => drivePts.push(pts) });
    h.set(target, 0.55);
    // Drive once (mid-loop, NO seam) → it's a driven key; anchor is a hard step.
    h.ctrl.playbackStep(track, 2, 0.5, 100, 0);
    expect(drivePts[0]![0]!.ramp).toBe(false);
    // Grab (truncate) … then RELEASE: the hand-off pin fires with the user's
    // final value (readNorm), a real event for the resume ramp to start from.
    h.ctrl.notifyTouch(target, 'pointer');
    h.holds.length = 0;
    h.ctrl.notifyRelease(target, 'pointer');
    expect(h.holds.length).toBe(1);
    expect(h.holds[0]!.toValueNorm).toBeCloseTo(0.55, 9); // the released value, pinned
    expect(h.holds[0]!.glideS).toBe(0);
    // The FIRST driven step after the release de-zippers (anchor is a RAMP)…
    drivePts.length = 0;
    h.ctrl.playbackStep(track, 4, 0.5, 101, 0); // mid-loop step, caller passes NO seam
    expect(drivePts[0]![0]!.ramp).toBe(true);
    // …and the flag is consumed — the next step is a normal hard anchor again.
    drivePts.length = 0;
    h.ctrl.playbackStep(track, 5, 0.5, 102, 0);
    expect(drivePts[0]![0]!.ramp).toBe(false);
  });

  // ── fix #1 support: holdLastValue seam options ─────────────────────────────
  it('holdLastValue skipKeys leaves boundary-shared params entirely alone', () => {
    const shared = tgt('s', 'p');
    const solo = tgt('o', 'q');
    const c = clip([
      { target: shared, events: [{ step: 0, value: 0.4 }] },
      { target: solo, events: [{ step: 0, value: 0.6 }] },
    ]);
    const h = harness();
    h.ctrl.holdLastValue(c, 8, 0.012, { atTime: 123, skipKeys: new Set(['s::p']) });
    expect(h.holds.map((x) => x.target.nodeId)).toEqual(['o']); // shared skipped
    expect(h.holds[0]!.atTime).toBe(123); // the boundary time reaches the dep
    expect(h.holds[0]!.toValueNorm).toBeCloseTo(0.6, 9);
  });

  it('holdLastValue truncateKeys cancel-only immediate-switch shared params (no resting pin)', () => {
    const shared = tgt('s', 'p');
    const c = clip([{ target: shared, events: [{ step: 0, value: 0.4 }] }]);
    const h = harness();
    h.ctrl.holdLastValue(c, 3, 0.012, { truncateKeys: new Set(['s::p']) });
    expect(h.holds.length).toBe(1);
    expect(h.holds[0]!.toValueNorm).toBeNull(); // truncate-only — incoming repossesses
    expect(h.holds[0]!.glideS).toBe(0);
  });

  it('holdLastValue only releases THIS clip\'s driven keys (other lanes keep touch-truncate scoping)', () => {
    const mine = tgt('m', 'p');
    const other = tgt('x', 'q');
    const myClip = clip([{ target: mine, events: [{ step: 0, value: 0.5 }] }]);
    const otherTrack: AutomationTrack = { target: other, events: [{ step: 0, value: 0.5 }] };
    const h = harness();
    h.ctrl.playbackStep(otherTrack, 0, 0.5, 100); // another lane drives `other`
    h.ctrl.holdLastValue(myClip, 8, 0.012); // stopping MY clip…
    h.holds.length = 0;
    h.ctrl.notifyTouch(other); // …must not un-scope the other lane's truncate
    expect(h.holds.length).toBe(1); // grab still truncates the driven param
  });
});
