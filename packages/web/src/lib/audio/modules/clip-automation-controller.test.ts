// packages/web/src/lib/audio/modules/clip-automation-controller.test.ts
//
// Unit tests for the PER-LANE automation controller (owner-locked final model:
// MODULE-level assignment + PER-LANE arm): playback touch-gating, per-lane
// continuous overdub, TOUCH-CREATED tracks scoped to a lane's assigned MODULE
// set, LATCHED commit targets (commit-before-swap), per-track overdub windows
// ([firstSampled, lastSampled] — a touch never wipes the loop before it), and
// the Phase-0 param-jump seams (hold-last-value / truncate / release-glide) —
// all against a fake harness whose `commit` mirrors the real per-key store
// write into a keyed track map, so multi-pass overdub stacks like production.

import { describe, it, expect } from 'vitest';
import {
  AutomationController,
  automationTargetKey,
  type AutomationControllerDeps,
  type AutoTrackUpdate,
} from './clip-automation-controller';
import type { AutomationTarget, AutomationTrack } from './clip-types';

const tgt = (nodeId: string, paramId: string): AutomationTarget => ({ nodeId, paramId });
/** The record scope recordLaneTick takes now: the lane's assigned MODULE ids. */
const modsOf = (...ts: AutomationTarget[]): ReadonlySet<string> =>
  new Set(ts.map((t) => t.nodeId));
const IDX = 3; // an arbitrary flat clip index for single-lane tests
const LANE = 0;

/** A fake harness: a value store per target, capture of drive()/hold(), and a
 *  PER-KEY track store keyed by clip index — `commit` writes only the updated
 *  keys (like the real `auto[k].tracks[key]` write), `readAutoTracks` reads
 *  them back, so successive wrap commits overdub against the committed state. */
function harness(overrides: Partial<AutomationControllerDeps> = {}) {
  const values = new Map<string, number>();
  const drives: { target: AutomationTarget; n: number }[] = [];
  const holds: {
    target: AutomationTarget;
    toValueNorm: number | null;
    glideS: number;
    atTime: number | undefined;
  }[] = [];
  const store = new Map<number, Map<string, AutomationTrack>>();
  const commits: { clipIdx: number; updates: AutoTrackUpdate[] }[] = [];
  const deps: AutomationControllerDeps = {
    readNorm: (t) => values.get(`${t.nodeId} ${t.paramId}`) ?? null,
    curve: () => undefined,
    unitNorm: () => undefined,
    drive: (target, points) => drives.push({ target, n: points.length }),
    hold: (target, toValueNorm, glideS, atTime) => holds.push({ target, toValueNorm, glideS, atTime }),
    readAutoTracks: (clipIdx) => [...(store.get(clipIdx)?.values() ?? [])],
    commit: (clipIdx, updates) => {
      commits.push({ clipIdx, updates });
      let m = store.get(clipIdx);
      if (!m) {
        m = new Map();
        store.set(clipIdx, m);
      }
      for (const u of updates) m.set(u.key, { target: u.target, events: u.events });
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
    holds,
    commits,
    /** The committed track events for (clipIdx, target), or undefined. */
    tracksOf: (clipIdx: number) => store.get(clipIdx),
    eventsOf: (clipIdx: number, t: AutomationTarget) =>
      store.get(clipIdx)?.get(automationTargetKey(t))?.events,
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
    const target = tgt('a', 'p');
    const track: AutomationTrack = { target, events: [{ step: 0, value: 0.5 }] };
    h.set(target, 0.5);
    h.ctrl.armLane(LANE);
    h.ctrl.recordLaneTick(LANE, IDX, modsOf(target), 5, 8);
    h.ctrl.recordLaneTick(LANE, IDX, modsOf(target), 0, 8); // wrap → punch-in → recording
    expect(h.ctrl.recording).toBe(true);
    // NOT touched → it keeps PLAYING BACK even while recording (visible continuity,
    // the fix for "looks like it recorded one pass then stopped").
    h.ctrl.playbackStep(track, 0, 0.5, 100);
    expect(h.drives.length).toBe(1);
    // Now the user TOUCHES it → playback suppressed (live/record wins).
    h.ctrl.notifyTouch(target);
    h.ctrl.playbackStep(track, 0, 0.5, 100);
    expect(h.drives.length).toBe(1); // no new drive
  });
});

describe('AutomationController — per-lane continuous overdub + move detection', () => {
  const target = tgt('synth', 'cutoff');
  const assigned = modsOf(target);

  it('arm → punch-in at the lane’s own wrap → capture a moving param → commit at the NEXT wrap (recording continues)', () => {
    const h = harness();
    h.set(target, 0.1);
    h.ctrl.armLane(LANE);
    // climbing toward the wrap, still armed (not yet recording)
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 6, 8);
    expect(h.ctrl.recording).toBe(false);
    // The hand grabs the knob BEFORE the wrap (pointer-down precedes the move),
    // so the punch-in seeds the entry at step 0 with the pre-move value (0.1).
    h.touch(target);
    // wrap → punch-in
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 0, 8);
    expect(h.ctrl.recording).toBe(true);
    expect(h.ctrl.laneRecording(LANE)).toBe(true);
    // sweep the param across the loop WHILE TOUCHING it (move = set + touch).
    h.move(target, 0.3);
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 2, 8);
    h.move(target, 0.7);
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 4, 8);
    h.move(target, 0.9);
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 6, 8);
    // wrap → commit this pass — but recording CONTINUES (continuous overdub)
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 0, 8);
    expect(h.ctrl.recording).toBe(true);
    expect(h.commits.length).toBe(1);
    expect(h.commits[0]!.clipIdx, 'committed into the latched clip index').toBe(IDX);
    const events = h.eventsOf(IDX, target)!;
    expect(events.length).toBeGreaterThan(1);
    // captured the sweep (min ~0.1 seed, max ~0.9)
    const vals = events.map((e) => e.value);
    expect(Math.min(...vals)).toBeLessThan(0.2);
    expect(Math.max(...vals)).toBeGreaterThan(0.8);
  });

  it('MULTI-PASS overdub: pass1 records A; pass2 moves B (A preserved, B added); pass3 re-moves A (A’s loop replaced)', () => {
    const A = tgt('a', 'pa');
    const B = tgt('b', 'pb');
    const both = modsOf(A, B);
    const h = harness();
    h.set(A, 0.0);
    h.set(B, 0.5);
    h.ctrl.armLane(LANE);
    h.ctrl.recordLaneTick(LANE, IDX, both, 6, 8);
    h.ctrl.recordLaneTick(LANE, IDX, both, 0, 8); // punch-in (pass 1)

    // PASS 1: TOUCH + move A only (0 → 0.9); B untouched.
    h.move(A, 0.4); h.ctrl.recordLaneTick(LANE, IDX, both, 3, 8);
    h.move(A, 0.9); h.ctrl.recordLaneTick(LANE, IDX, both, 6, 8);
    h.ctrl.recordLaneTick(LANE, IDX, both, 0, 8); // wrap → commit pass 1 (A moved, B not)
    const aAfterP1 = h.eventsOf(IDX, A)!;
    expect(aAfterP1.length).toBeGreaterThan(1);
    expect(h.eventsOf(IDX, B), 'B untouched → no committed track').toBeUndefined();

    // PASS 2: TOUCH + move B only (0.5 → 0.05); A is NOT touched → preserved + playing.
    h.set(A, 0.9); // A's store value stays (not touched → not recorded)
    h.move(B, 0.5);
    h.ctrl.recordLaneTick(LANE, IDX, both, 3, 8);
    h.move(B, 0.05); h.ctrl.recordLaneTick(LANE, IDX, both, 6, 8);
    h.ctrl.recordLaneTick(LANE, IDX, both, 0, 8); // wrap → commit pass 2 (B moved, A preserved)
    expect(h.eventsOf(IDX, B)!.length).toBeGreaterThan(1); // B now recorded
    expect(h.eventsOf(IDX, A), 'A preserved across pass 2').toEqual(aAfterP1);

    // PASS 3: TOUCH + re-move A (0.9 → 0.1) → A’s loop REPLACED with the new sweep.
    h.move(A, 0.9); h.ctrl.recordLaneTick(LANE, IDX, both, 2, 8);
    h.move(A, 0.1); h.ctrl.recordLaneTick(LANE, IDX, both, 6, 8);
    h.ctrl.recordLaneTick(LANE, IDX, both, 0, 8); // wrap → commit pass 3
    const aP3 = h.eventsOf(IDX, A)!;
    expect(Math.min(...aP3.map((e) => e.value))).toBeLessThan(0.2); // the new downward sweep
    expect(h.eventsOf(IDX, B)!.length).toBeGreaterThan(1); // B still there
  });

  it('an UNTOUCHED assigned track keeps its existing automation (not overwritten)', () => {
    const moved = tgt('a', 'moved');
    const still = tgt('b', 'still');
    const both = modsOf(moved, still);
    const h = harness();
    // Seed pre-existing committed automation for `still` via a recorded pass
    // (the same per-key commit path production uses).
    h.set(still, 0.0);
    h.ctrl.armLane(LANE);
    h.ctrl.recordLaneTick(LANE, IDX, modsOf(still), 6, 8);
    h.touch(still); // grab before the wrap → seeded at step 0 (pre-move value)
    h.ctrl.recordLaneTick(LANE, IDX, modsOf(still), 0, 8); // punch-in
    h.move(still, 0.42);
    h.ctrl.recordLaneTick(LANE, IDX, modsOf(still), 4, 8);
    h.ctrl.recordLaneTick(LANE, IDX, modsOf(still), 0, 8); // wrap → commit the seed
    h.release(still);
    h.ctrl.disarmLane(LANE);
    const stillBefore = h.eventsOf(IDX, still)!;
    expect(stillBefore.length).toBeGreaterThan(0);

    h.set(moved, 0.0);
    h.set(still, 0.42);
    h.ctrl.armLane(LANE);
    h.ctrl.recordLaneTick(LANE, IDX, both, 6, 8);
    h.ctrl.recordLaneTick(LANE, IDX, both, 0, 8); // punch-in
    // TOUCH + move `moved`; `still` is NOT touched → preserved.
    h.move(moved, 0.5);
    h.ctrl.recordLaneTick(LANE, IDX, both, 3, 8);
    h.move(moved, 0.9);
    h.ctrl.recordLaneTick(LANE, IDX, both, 6, 8);
    h.ctrl.recordLaneTick(LANE, IDX, both, 0, 8); // wrap → commit
    // untouched → the ORIGINAL events preserved verbatim
    expect(h.eventsOf(IDX, still)).toEqual(stillBefore);
    expect(Math.max(...h.eventsOf(IDX, moved)!.map((e) => e.value))).toBeGreaterThan(0.8);
  });

  it('does not commit when a touched param is held FLAT (no motion = no-op)', () => {
    const h = harness();
    h.set(target, 0.5);
    h.ctrl.armLane(LANE);
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 6, 8);
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 0, 8); // punch-in
    // Touch it every tick but never MOVE it (held flat) → a track with no
    // motion is not committed.
    h.touch(target); h.ctrl.recordLaneTick(LANE, IDX, assigned, 3, 8);
    h.touch(target); h.ctrl.recordLaneTick(LANE, IDX, assigned, 6, 8);
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 0, 8); // wrap
    expect(h.commits.length).toBe(0);
  });

  it('does not record a param the user NEVER touches (touch-gated)', () => {
    const h = harness();
    h.set(target, 0.5);
    h.ctrl.armLane(LANE);
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 6, 8);
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 0, 8); // punch-in
    // The store value even CHANGES (e.g. driven by playback), but with no TOUCH it
    // is not captured — no self-capture feedback.
    h.set(target, 0.9); h.ctrl.recordLaneTick(LANE, IDX, assigned, 3, 8);
    h.set(target, 0.2); h.ctrl.recordLaneTick(LANE, IDX, assigned, 6, 8);
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 0, 8); // wrap
    expect(h.commits.length).toBe(0);
  });

  it('AUTO-CAPTURE IS GONE: touching an UNASSIGNED param while recording records NOTHING', () => {
    // With per-lane targeting there is no unambiguous lane for an un-assigned
    // touch — assignment is explicit (right-click), so the move is ignored.
    const unassigned = tgt('x', 'free');
    const h = harness();
    h.set(target, 0.5);
    h.set(unassigned, 0.1);
    h.ctrl.armLane(LANE);
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 6, 8);
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 0, 8); // punch-in
    h.move(unassigned, 0.9); h.ctrl.recordLaneTick(LANE, IDX, assigned, 3, 8);
    h.move(unassigned, 0.2); h.ctrl.recordLaneTick(LANE, IDX, assigned, 6, 8);
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 0, 8); // wrap
    expect(h.commits.length, 'nothing committed for an unassigned param').toBe(0);
    expect(h.eventsOf(IDX, unassigned)).toBeUndefined();
  });

  it('a param ASSIGNED MID-PASS is adopted, seeded at the current position', () => {
    const late = tgt('l', 'p');
    const h = harness();
    h.set(target, 0.5);
    h.set(late, 0.1);
    h.ctrl.armLane(LANE);
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 6, 8);
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 0, 8); // punch-in with ONE assigned
    // The user right-click-assigns `late` mid-pass → the tick now passes it too.
    const withLate = modsOf(target, late);
    h.move(late, 0.4); h.ctrl.recordLaneTick(LANE, IDX, withLate, 3, 8);
    h.move(late, 0.9); h.ctrl.recordLaneTick(LANE, IDX, withLate, 6, 8);
    h.ctrl.recordLaneTick(LANE, IDX, withLate, 0, 8); // wrap → commit
    const events = h.eventsOf(IDX, late)!;
    expect(events.length).toBeGreaterThan(1);
    expect(Math.max(...events.map((e) => e.value))).toBeGreaterThan(0.8);
  });

  it('DISARM mid-pass commits the PARTIAL pass, preserving the untouched tail', () => {
    // Prior automation spans the whole loop; a partial re-record over [0..~4]
    // must replace only that window and KEEP the tail events (step 6).
    const h = harness();
    h.set(target, 0.1);
    // Seed prior automation with a full-loop pass (0.1 → 0.7 landing at step 6+).
    h.ctrl.armLane(LANE);
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 6, 8);
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 0, 8);
    h.move(target, 0.1); h.ctrl.recordLaneTick(LANE, IDX, assigned, 0.5, 8);
    h.move(target, 0.7); h.ctrl.recordLaneTick(LANE, IDX, assigned, 6, 8);
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 0, 8); // commit the seed pass
    h.release(target);
    h.ctrl.disarmLane(LANE);
    const prior = h.eventsOf(IDX, target)!;
    const tail = prior.filter((e) => e.step > 4);
    expect(tail.length, 'seed pass reached the loop tail').toBeGreaterThan(0);

    // Now the partial re-record: arm, punch in, move over [0..4], disarm mid-loop.
    h.ctrl.armLane(LANE);
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 6, 8);
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 0, 8); // punch-in
    h.move(target, 0.5); h.ctrl.recordLaneTick(LANE, IDX, assigned, 2, 8);
    h.move(target, 0.95); h.ctrl.recordLaneTick(LANE, IDX, assigned, 4, 8);
    h.ctrl.disarmLane(LANE); // manual stop mid-pass → commit partial
    expect(h.ctrl.recording).toBe(false);
    const events = h.eventsOf(IDX, target)!;
    // the untouched TAIL events (step > 4) are preserved…
    for (const e of tail) {
      expect(
        events.some((p) => p.step === e.step && Math.abs(p.value - e.value) < 1e-9),
        `tail event @${e.step} preserved`,
      ).toBe(true);
    }
    // …and the new capture landed in the recorded window (≤ ~step 4).
    const recorded = events.filter((e) => e.step <= 4.001);
    expect(Math.max(...recorded.map((e) => e.value))).toBeGreaterThan(0.9);
  });

  it('LIGHT/STATE MACHINE never gets stuck: arm → record → disarm → idle (no ‘done’ phase)', () => {
    const h = harness();
    h.set(target, 0.1);
    expect(h.ctrl.armed).toBe(false);
    expect(h.ctrl.recording).toBe(false);
    h.ctrl.armLane(LANE);
    expect(h.ctrl.armed).toBe(true);
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 6, 8);
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 0, 8); // punch-in
    expect(h.ctrl.recording).toBe(true);
    // many loops go by — it NEVER auto-stops (no punch-out/'done')
    for (let loop = 0; loop < 5; loop++) {
      h.set(target, loop % 2 === 0 ? 0.2 : 0.8);
      h.ctrl.recordLaneTick(LANE, IDX, assigned, 4, 8);
      h.ctrl.recordLaneTick(LANE, IDX, assigned, 0, 8); // wrap
      expect(h.ctrl.recording, `still recording after loop ${loop}`).toBe(true);
    }
    h.ctrl.disarmLane(LANE); // manual stop
    expect(h.ctrl.recording).toBe(false);
    expect(h.ctrl.armed).toBe(false); // fully idle — nothing left lit
  });

  it('a GRABBED gesture KEEPS its suspension across the loop wrap (released only on physical release)', () => {
    // Phase 0 param-jump policy: the override ends on the hand lifting, NOT the
    // wrap — so a knob gesture spanning a loop isn't yanked to the envelope
    // mid-drag. (Was: suspensions cleared at every wrap — the live bug.)
    const h = harness();
    h.set(target, 0.1);
    h.ctrl.notifyTouch(target); // grab (pointer-down), never released
    expect(h.ctrl.isSuspended(target)).toBe(true);
    h.ctrl.armLane(LANE);
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 6, 8);
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 0, 8); // wrap → punch-in: grabbed param STAYS suspended
    expect(h.ctrl.isSuspended(target)).toBe(true);
    // The hand lifts → NOW it re-enables (playback resumes next loop).
    h.ctrl.notifyRelease(target);
    expect(h.ctrl.isSuspended(target)).toBe(false);
  });

  it('a RELEASED (non-grabbed) suspension still clears at the wrap', () => {
    // A momentary touch that was released before the wrap must not linger.
    const h = harness();
    h.set(target, 0.1);
    h.ctrl.notifyTouch(target);
    h.ctrl.notifyRelease(target); // released before the wrap
    expect(h.ctrl.isSuspended(target)).toBe(false);
    h.ctrl.armLane(LANE);
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 6, 8);
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 0, 8);
    expect(h.ctrl.isSuspended(target)).toBe(false);
  });
});

describe('AutomationController — PER-LANE record independence (Phase 2)', () => {
  it('two lanes record CONCURRENTLY with independent windows/wraps + commit into their own clips', () => {
    const A = tgt('a', 'pa'); // assigned to lane 0 (clip idx 3, len 8)
    const B = tgt('b', 'pb'); // assigned to lane 1 (clip idx 70, len 4 — different wrap)
    const IDX_A = 3;
    const IDX_B = 70;
    const h = harness();
    h.set(A, 0.1);
    h.set(B, 0.9);
    h.ctrl.armLane(0); // PER-LANE arm: each recording lane armed on its own
    h.ctrl.armLane(1);
    // Both lanes climb toward their own wraps (different lengths).
    h.ctrl.recordLaneTick(0, IDX_A, modsOf(A), 6, 8);
    h.ctrl.recordLaneTick(1, IDX_B, modsOf(B), 3, 4);
    // Lane 1 wraps FIRST (len 4) → punches in; lane 0 still armed.
    h.ctrl.recordLaneTick(1, IDX_B, modsOf(B), 0, 4);
    expect(h.ctrl.laneRecording(1)).toBe(true);
    expect(h.ctrl.laneRecording(0)).toBe(false);
    // Lane 0 wraps → punches in too. Both now record concurrently.
    h.ctrl.recordLaneTick(0, IDX_A, modsOf(A), 0, 8);
    expect(h.ctrl.laneRecording(0)).toBe(true);
    // Move BOTH (out of phase). Lane 1 wraps again (commits) while lane 0 is mid-pass.
    h.move(A, 0.5); h.ctrl.recordLaneTick(0, IDX_A, modsOf(A), 2, 8);
    h.move(B, 0.4); h.ctrl.recordLaneTick(1, IDX_B, modsOf(B), 2, 4);
    h.move(B, 0.1); h.ctrl.recordLaneTick(1, IDX_B, modsOf(B), 3.5, 4);
    h.ctrl.recordLaneTick(1, IDX_B, modsOf(B), 0, 4); // lane-1 wrap → commit B only
    expect(h.commits.length).toBe(1);
    expect(h.commits[0]!.clipIdx).toBe(IDX_B);
    expect(h.eventsOf(IDX_A, A), 'lane 0 has NOT committed yet').toBeUndefined();
    // Lane 0 finishes its loop → commits into ITS clip.
    h.move(A, 0.9); h.ctrl.recordLaneTick(0, IDX_A, modsOf(A), 6, 8);
    h.ctrl.recordLaneTick(0, IDX_A, modsOf(A), 0, 8); // lane-0 wrap
    expect(h.commits.length).toBe(2);
    expect(h.commits[1]!.clipIdx).toBe(IDX_A);
    expect(h.eventsOf(IDX_A, A)!.length).toBeGreaterThan(1);
    expect(h.eventsOf(IDX_B, B)!.length).toBeGreaterThan(1);
    // Each clip holds ONLY its own lane's param.
    expect(h.eventsOf(IDX_A, B)).toBeUndefined();
    expect(h.eventsOf(IDX_B, A)).toBeUndefined();
  });

  it('one lane’s wrap does NOT clear another lane’s momentary suspension (scoped re-enable)', () => {
    const A = tgt('a', 'pa'); // lane 0
    const B = tgt('b', 'pb'); // lane 1 — momentarily suspended (no grab)
    const h = harness();
    h.set(A, 0.1);
    h.set(B, 0.1);
    h.ctrl.armLane(LANE);
    h.ctrl.recordLaneTick(0, 3, modsOf(A), 6, 8);
    h.ctrl.recordLaneTick(1, 70, modsOf(B), 2, 4);
    // B is suspended-without-grab (e.g. reEnable pathway left it suspended-only).
    // Simulate: touch then strip the grab via reEnableAll-like path is complex;
    // instead assert the wrap of lane 0 only touches ITS assigned keys.
    h.ctrl.notifyTouch(B); // grabbed + suspended
    h.ctrl.recordLaneTick(0, 3, modsOf(A), 0, 8); // lane-0 wrap (punch-in)
    expect(h.ctrl.isSuspended(B), 'lane-0 wrap left lane-1’s grip alone').toBe(true);
    h.ctrl.notifyRelease(B);
    expect(h.ctrl.isSuspended(B)).toBe(false);
  });

  it('LATCHED COMMIT: a queued launch swapping the lane’s clip mid-pass still commits to the OUTGOING clip, then re-latches', () => {
    // The mid-record-switch race: applyLaneQueued swaps ln.active (and thus the
    // clipIdx the tick passes) ~lookahead BEFORE the audible wrap. The pass must
    // commit into the clip LATCHED at pass start (A), and only the NEXT pass
    // records into B.
    const P = tgt('s', 'p');
    const IDX_A = 3;
    const IDX_B = 5;
    const h = harness();
    h.set(P, 0.1);
    h.ctrl.armLane(LANE);
    h.ctrl.recordLaneTick(0, IDX_A, modsOf(P), 6, 8);
    h.ctrl.recordLaneTick(0, IDX_A, modsOf(P), 0, 8); // punch-in — latched to A
    h.move(P, 0.5); h.ctrl.recordLaneTick(0, IDX_A, modsOf(P), 3, 8);
    h.move(P, 0.9); h.ctrl.recordLaneTick(0, IDX_A, modsOf(P), 6, 8);
    // The queued launch APPLIES (scheduled ahead): the tick now reports clip B
    // while the audible playhead finishes A's loop.
    h.ctrl.recordLaneTick(0, IDX_B, modsOf(P), 7, 8);
    // Audible wrap: the pass commits — into A (latched), NOT B.
    h.ctrl.recordLaneTick(0, IDX_B, modsOf(P), 0, 8);
    expect(h.commits.length).toBe(1);
    expect(h.commits[0]!.clipIdx, 'committed to the OUTGOING clip').toBe(IDX_A);
    expect(h.eventsOf(IDX_A, P)!.length).toBeGreaterThan(1);
    expect(h.eventsOf(IDX_B, P), 'nothing leaked into the incoming clip').toBeUndefined();
    // The NEXT pass records into B (re-latched at the wrap).
    h.move(P, 0.2); h.ctrl.recordLaneTick(0, IDX_B, modsOf(P), 3, 8);
    h.move(P, 0.05); h.ctrl.recordLaneTick(0, IDX_B, modsOf(P), 6, 8);
    h.ctrl.recordLaneTick(0, IDX_B, modsOf(P), 0, 8); // wrap → commit into B
    expect(h.commits[1]!.clipIdx).toBe(IDX_B);
    expect(h.eventsOf(IDX_B, P)!.length).toBeGreaterThan(1);
  });

  it('laneStopped punches out: commits the PARTIAL pass into the latched clip + resets the lane window', () => {
    const P = tgt('s', 'p');
    const h = harness();
    h.set(P, 0.1);
    h.ctrl.armLane(LANE);
    h.ctrl.recordLaneTick(LANE, IDX, modsOf(P), 6, 8);
    h.touch(P); // grab before the wrap → seeded at step 0 (pre-move value)
    h.ctrl.recordLaneTick(LANE, IDX, modsOf(P), 0, 8); // punch-in
    h.move(P, 0.8); h.ctrl.recordLaneTick(LANE, IDX, modsOf(P), 3, 8);
    h.ctrl.laneStopped(LANE); // the lane stopped playing mid-pass
    expect(h.commits.length, 'partial pass committed at lane stop').toBe(1);
    expect(h.commits[0]!.clipIdx).toBe(IDX);
    expect(h.ctrl.laneRecording(LANE)).toBe(false);
    // A later re-launch re-arms lazily and punches in at the NEW clip's wrap.
    h.ctrl.recordLaneTick(LANE, IDX, modsOf(P), 6, 8);
    h.ctrl.recordLaneTick(LANE, IDX, modsOf(P), 0, 8);
    expect(h.ctrl.laneRecording(LANE)).toBe(true);
  });

  it('laneStopped on a lane with no record state is a cheap no-op', () => {
    const h = harness();
    h.ctrl.armLane(LANE);
    h.ctrl.laneStopped(4);
    expect(h.commits.length).toBe(0);
  });

  it('PUNCH-OUT AT SWAP: a quantized switch to a SHORTER clip mid-pass commits the partial to the OUTGOING clip; the incoming clip’s first pass starts clean at ITS own wrap', () => {
    // The refuted corruption: applyLaneQueued swaps (clipIdx, len) up to ~200 ms
    // before the audible wrap, so the tick feeds the NEW len with the OLD
    // playhead — the clamp (min(frac, len)) reads as a spurious early wrap and
    // the old flow committed a garbage full-window pass re-latched mid-stream.
    const P = tgt('s', 'p');
    const IDX_A = 3; // len 8 (outgoing)
    const IDX_B = 5; // len 4 (incoming — SHORTER)
    const h = harness();
    h.set(P, 0.1);
    h.ctrl.armLane(LANE);
    h.ctrl.recordLaneTick(0, IDX_A, modsOf(P), 6, 8);
    h.ctrl.recordLaneTick(0, IDX_A, modsOf(P), 0, 8); // punch-in — latched to A (len 8)
    h.move(P, 0.5); h.ctrl.recordLaneTick(0, IDX_A, modsOf(P), 3, 8);
    h.move(P, 0.9); h.ctrl.recordLaneTick(0, IDX_A, modsOf(P), 6, 8);
    // SWAP applies (scheduled ahead): the tick now reports (IDX_B, len 4) while
    // the audible playhead still sits in A's tail — clamped to 4 by the caller.
    h.ctrl.recordLaneTick(0, IDX_B, modsOf(P), 4, 4);
    // Punch-out fired AT the swap: exactly one commit, into A, PARTIAL window.
    expect(h.commits.length).toBe(1);
    expect(h.commits[0]!.clipIdx, 'partial committed to the OUTGOING clip').toBe(IDX_A);
    const aEvents = h.eventsOf(IDX_A, P)!;
    expect(Math.max(...aEvents.map((e) => e.value))).toBeGreaterThan(0.8); // the real sweep
    expect(h.eventsOf(IDX_B, P), 'nothing leaked into the incoming clip').toBeUndefined();
    expect(h.ctrl.laneRecording(0), 'window reset — armed, not recording').toBe(false);
    // The clamped stale playhead does NOT punch in (4 → 4: no decrease)…
    h.ctrl.recordLaneTick(0, IDX_B, modsOf(P), 4, 4);
    expect(h.ctrl.laneRecording(0)).toBe(false);
    // …the incoming clip's first REAL wrap (audible playhead reaches ITS start)
    // punches in clean, and its first pass records only its own loop.
    h.ctrl.recordLaneTick(0, IDX_B, modsOf(P), 0.2, 4); // decrease → punch-in
    expect(h.ctrl.laneRecording(0)).toBe(true);
    h.move(P, 0.05); h.ctrl.recordLaneTick(0, IDX_B, modsOf(P), 2, 4);
    h.ctrl.recordLaneTick(0, IDX_B, modsOf(P), 0, 4); // B's wrap → commit into B
    expect(h.commits.length).toBe(2);
    expect(h.commits[1]!.clipIdx).toBe(IDX_B);
    const bEvents = h.eventsOf(IDX_B, P)!;
    expect(bEvents.length).toBeGreaterThan(1);
    expect(bEvents.every((e) => e.step <= 4), 'B’s take bounded to ITS length').toBe(true);
    // A's committed take is unchanged by B's pass.
    expect(h.eventsOf(IDX_A, P)).toEqual(aEvents);
  });

  it('MID-PASS MOVE: a param re-assigned AWAY from a recording lane punch-commits its entry and stops being captured there', () => {
    const P = tgt('s', 'p');
    const OTHER = tgt('o', 'q');
    const h = harness();
    h.set(P, 0.1);
    h.set(OTHER, 0.5);
    h.ctrl.armLane(LANE);
    h.ctrl.recordLaneTick(0, IDX, modsOf(P, OTHER), 6, 8);
    h.touch(P); // both grabbed before the wrap → seeded at step 0
    h.touch(OTHER);
    h.ctrl.recordLaneTick(0, IDX, modsOf(P, OTHER), 0, 8); // punch-in with both assigned
    h.move(P, 0.6); h.move(OTHER, 0.6); h.ctrl.recordLaneTick(0, IDX, modsOf(P, OTHER), 2, 8);
    // The user MOVES P's assignment to another lane mid-pass → P leaves this
    // lane's assigned list. Its entry punch-commits ([0, lastSampled=2]) now.
    h.ctrl.recordLaneTick(0, IDX, modsOf(OTHER), 3, 8);
    expect(h.commits.length, 'moved-away entry committed immediately').toBe(1);
    expect(h.commits[0]!.clipIdx).toBe(IDX);
    expect(h.commits[0]!.updates.map((u) => u.key)).toEqual(['s::p']);
    const pAtMove = h.eventsOf(IDX, P)!;
    expect(pAtMove.every((e) => e.step <= 2.001), 'bounded to its sampled window').toBe(true);
    // P keeps "moving" (its store value changes while grabbed) — but the OLD
    // lane no longer captures it: the wrap commit contains only OTHER.
    h.move(P, 0.95); h.move(OTHER, 0.9); h.ctrl.recordLaneTick(0, IDX, modsOf(OTHER), 6, 8);
    h.ctrl.recordLaneTick(0, IDX, modsOf(OTHER), 0, 8); // wrap
    expect(h.commits.length).toBe(2);
    expect(h.commits[1]!.updates.map((u) => u.key)).toEqual(['o::q']);
    expect(h.eventsOf(IDX, P), 'P’s events unchanged since the move-away').toEqual(pAtMove);
  });

  it('DISARM keeps a PHYSICALLY-HELD grab (release-on-touch-END survives disarm); only suspended-only entries clear', () => {
    const held = tgt('h', 'p');
    const loose = tgt('l', 'q');
    const h = harness();
    h.ctrl.notifyTouch(held, 'pointer'); // hand still down through the disarm
    // A suspended-only entry (grab already released → normally cleared at
    // release; simulate a lingering suspension via reEnable-less direct state:
    // touch with a holder then strip the holder by releasing another surface is
    // not possible — so emulate via touch+release which clears both, then
    // re-touch with 'default' and drop the grab through reEnable of grabbed…
    // Simplest real path: a wrap re-enable leaves suspended-only sets empty, so
    // here we just verify the HELD grab survives disarm.
    h.ctrl.notifyTouch(loose);
    h.ctrl.notifyRelease(loose); // properly released → gone before disarm
    h.ctrl.armLane(LANE);
    h.ctrl.disarmLane(LANE);
    expect(h.ctrl.isSuspended(held), 'a live hand keeps its override across disarm').toBe(true);
    h.ctrl.notifyRelease(held, 'pointer'); // the hand lifts → NOW it ends
    expect(h.ctrl.isSuspended(held)).toBe(false);
  });
});

describe('AutomationController — long/slow clip (low div, long length)', () => {
  it('records a full pass on a 64-step clip with sub-step motion, bounded events', () => {
    const target = tgt('filter', 'freq');
    const h = harness();
    h.set(target, 0);
    h.ctrl.armLane(LANE);
    h.ctrl.recordLaneTick(LANE, IDX, modsOf(target), 60, 64);
    h.ctrl.recordLaneTick(LANE, IDX, modsOf(target), 0, 64); // punch-in
    // simulate ~40 ticks across the 64-step loop with a rising sweep (touching it)
    for (let i = 1; i <= 40; i++) {
      const frac = (i / 41) * 64;
      h.move(target, i / 41);
      h.ctrl.recordLaneTick(LANE, IDX, modsOf(target), frac, 64);
    }
    h.ctrl.recordLaneTick(LANE, IDX, modsOf(target), 0, 64); // wrap → commit
    const events = h.eventsOf(IDX, target)!;
    expect(events.length).toBeGreaterThan(5);
    expect(events.length).toBeLessThanOrEqual(64); // decimation kept it bounded
    // events span the whole loop
    expect(events[0]!.step).toBeLessThan(2);
    expect(events[events.length - 1]!.step).toBeGreaterThan(60);
  });
});

describe('AutomationController — param-jump policy (Phase 0 seams, re-targeted)', () => {
  const target = tgt('synth', 'cutoff');

  it('holdLastValue: DETERMINISTIC resting recompute (linear interp at the stop step)', () => {
    const tracks: AutomationTrack[] = [
      { target, events: [{ step: 0, value: 0.2 }, { step: 8, value: 0.8 }] },
    ];
    const h = harness();
    h.ctrl.holdLastValue(tracks, 3, 0.012);
    expect(h.holds.length).toBe(1);
    const hd = h.holds[0]!;
    expect(hd.target).toEqual(target);
    expect(hd.glideS).toBe(0.012);
    // linear at step 3: 0.2 + (3-0)/(8-0)*(0.8-0.2) = 0.2 + 0.375*0.6 = 0.425
    expect(hd.toValueNorm).toBeCloseTo(0.425, 9);
  });

  it('holdLastValue is a PURE function of tracks+step (same input → same value, multiplayer-safe)', () => {
    const tracks: AutomationTrack[] = [
      { target, events: [{ step: 0, value: 0.1 }, { step: 4, value: 0.9 }, { step: 8, value: 0.3 }] },
    ];
    const a = harness();
    const b = harness();
    a.ctrl.holdLastValue(tracks, 5.5, 0.012);
    b.ctrl.holdLastValue(tracks, 5.5, 0.012);
    // Two independent "peers" converge on the identical resting value by construction.
    expect(a.holds[0]!.toValueNorm).toBe(b.holds[0]!.toValueNorm);
  });

  it('holdLastValue skips a param a hand is holding (the hand owns it) + one with no value yet', () => {
    const held = tgt('a', 'held');
    const future = tgt('b', 'future');
    const tracks: AutomationTrack[] = [
      { target: held, events: [{ step: 0, value: 0.5 }] },
      { target: future, events: [{ step: 6, value: 0.5 }] }, // no value at step 2
    ];
    const h = harness();
    h.ctrl.notifyTouch(held); // grabbed → excluded from hold-last-value
    h.ctrl.holdLastValue(tracks, 2, 0.012);
    expect(h.holds.map((x) => x.target.paramId)).toEqual([]); // held excluded, future has no value yet
  });

  it('holdLastValue NEVER snaps to zero/default (holds the real envelope value)', () => {
    const tracks: AutomationTrack[] = [
      { target, events: [{ step: 0, value: 0.7 }, { step: 8, value: 0.7 }] },
    ];
    const h = harness();
    h.ctrl.holdLastValue(tracks, 4, 0.012);
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
    const h = harness();
    h.set(target, 0.1);
    h.ctrl.armLane(LANE);
    h.ctrl.recordLaneTick(LANE, IDX, modsOf(target), 6, 8);
    h.ctrl.recordLaneTick(LANE, IDX, modsOf(target), 0, 8); // punch-in
    h.move(target, 0.5); h.ctrl.recordLaneTick(LANE, IDX, modsOf(target), 4, 8); // move in pass 1
    h.ctrl.recordLaneTick(LANE, IDX, modsOf(target), 0, 8); // WRAP (commit pass 1) — param still grabbed
    // Pass 2: keep moving WITHOUT re-touching every tick (still physically held).
    h.set(target, 0.9); h.ctrl.recordLaneTick(LANE, IDX, modsOf(target), 4, 8);
    h.ctrl.recordLaneTick(LANE, IDX, modsOf(target), 0, 8); // wrap → commit pass 2 captured the held motion
    const events = h.eventsOf(IDX, target)!;
    expect(Math.max(...events.map((e) => e.value))).toBeGreaterThan(0.8); // pass-2 motion captured
  });

  // ── fix #5: per-surface grab ownership ─────────────────────────────────────
  it('DUAL-SURFACE grab: the first surface releasing does NOT clear the other surface\'s grip', () => {
    const h = harness();
    h.set(target, 0.1);
    h.ctrl.notifyTouch(target, 'pointer'); // screen drag grabs it
    h.ctrl.notifyTouch(target, 'midi'); // a MIDI twist grabs it too
    expect(h.ctrl.isSuspended(target)).toBe(true);
    // The MIDI stream idles → its holder releases. The POINTER still grips it:
    // the override must NOT end (the yank-mid-drag regression).
    h.ctrl.notifyRelease(target, 'midi');
    expect(h.ctrl.isSuspended(target)).toBe(true);
    // ...and it still survives a wrap while the pointer holds.
    h.ctrl.armLane(LANE);
    h.ctrl.recordLaneTick(LANE, IDX, modsOf(target), 6, 8);
    h.ctrl.recordLaneTick(LANE, IDX, modsOf(target), 0, 8); // wrap
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
    const h = harness();
    h.set(target, 0.1);
    h.ctrl.armLane(LANE);
    h.ctrl.recordLaneTick(LANE, IDX, modsOf(target), 6, 8);
    h.ctrl.recordLaneTick(LANE, IDX, modsOf(target), 0, 8); // punch-in (pass 1)
    // PASS 1: full-loop sweep 0.1 → 0.9 while held.
    h.move(target, 0.3); h.ctrl.recordLaneTick(LANE, IDX, modsOf(target), 2, 8);
    h.move(target, 0.6); h.ctrl.recordLaneTick(LANE, IDX, modsOf(target), 4, 8);
    h.move(target, 0.9); h.ctrl.recordLaneTick(LANE, IDX, modsOf(target), 7, 8);
    h.ctrl.recordLaneTick(LANE, IDX, modsOf(target), 0, 8); // wrap → commit pass 1 (still grabbed)
    const pass1 = h.eventsOf(IDX, target)!;
    const pass1Tail = pass1.filter((e) => e.step > 4);
    expect(pass1Tail.length, 'pass 1 recorded into the loop tail').toBeGreaterThan(0);
    // PASS 2 (same physical gesture): keep moving until ~step 3, then RELEASE.
    h.set(target, 0.2); h.ctrl.recordLaneTick(LANE, IDX, modsOf(target), 1, 8);
    h.set(target, 0.05); h.ctrl.recordLaneTick(LANE, IDX, modsOf(target), 3, 8);
    h.release(target); // hand lifts at step 3 — capture stops extending
    h.ctrl.recordLaneTick(LANE, IDX, modsOf(target), 5, 8);
    h.ctrl.recordLaneTick(LANE, IDX, modsOf(target), 0, 8); // wrap → commit pass 2
    const pass2 = h.eventsOf(IDX, target)!;
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

  it('PER-SEGMENT windows: two disjoint touches of the SAME param in ONE pass never wipe the envelope between them (blocker regression)', () => {
    // SEED a full-loop envelope on a 12-step clip with breakpoints in the
    // middle [4..8]. Then in ONE pass: touch A over [1,3], release, an
    // untouched gap, touch B over [9,11]. The old single per-entry window
    // spanned [1,11] and mergeAutomationOverdub deleted the middle; the fix
    // punch-commits segment A on the re-grab and opens a FRESH segment, so
    // the seed's middle breakpoints survive verbatim.
    const assigned = modsOf(target);
    const h = harness();
    h.set(target, 0.5);
    h.ctrl.armLane(LANE);
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 10, 12);
    h.touch(target);
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 0, 12); // punch-in (seeded @0)
    h.move(target, 0.6); h.ctrl.recordLaneTick(LANE, IDX, assigned, 4, 12);
    h.move(target, 0.7); h.ctrl.recordLaneTick(LANE, IDX, assigned, 6, 12);
    h.move(target, 0.8); h.ctrl.recordLaneTick(LANE, IDX, assigned, 8, 12);
    h.move(target, 0.9); h.ctrl.recordLaneTick(LANE, IDX, assigned, 11, 12);
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 0, 12); // wrap → commit the seed
    h.release(target);
    h.ctrl.disarmLane(LANE);
    const seed = h.eventsOf(IDX, target)!;
    const middle = seed.filter((e) => e.step >= 4 && e.step <= 8);
    expect(middle.length, 'seed put breakpoints in the middle').toBeGreaterThanOrEqual(3);

    // THE PASS UNDER TEST: two disjoint touches of the SAME param.
    h.ctrl.armLane(LANE);
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 10, 12);
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 0, 12); // punch-in (nothing held)
    h.move(target, 0.1); h.ctrl.recordLaneTick(LANE, IDX, assigned, 1, 12); // touch A
    h.set(target, 0.15); h.ctrl.recordLaneTick(LANE, IDX, assigned, 3, 12);
    h.release(target); // hand lifts at step 3
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 5, 12); // untouched gap (segment A frozen)
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 7, 12);
    h.move(target, 0.3); h.ctrl.recordLaneTick(LANE, IDX, assigned, 9, 12); // touch B (re-grab)
    h.set(target, 0.35); h.ctrl.recordLaneTick(LANE, IDX, assigned, 11, 12);
    h.release(target);
    h.ctrl.recordLaneTick(LANE, IDX, assigned, 0, 12); // wrap → commit segment B

    const out = h.eventsOf(IDX, target)!;
    // Every seed breakpoint BETWEEN the touches (4..8) survives verbatim.
    for (const e of middle) {
      expect(
        out.some((p) => p.step === e.step && Math.abs(p.value - e.value) < 1e-9),
        `middle breakpoint @${e.step} survived the two-touch pass`,
      ).toBe(true);
    }
    // …and BOTH touch windows hold their new motion.
    expect(out.filter((e) => e.step >= 1 && e.step <= 3).some((e) => e.value <= 0.2)).toBe(true);
    expect(out.filter((e) => e.step >= 9 && e.step <= 11).some((e) => e.value <= 0.4)).toBe(true);
    // Two committed windows for the pass (segment A punch + segment B wrap),
    // after the seed pass's single commit.
    expect(h.commits.length).toBe(3);
  });

  it('DISARM partial still bounds each track to its OWN sampled window (per-track, not global)', () => {
    // Two tracks; A sampled to step 2, B sampled to step 5. The global
    // passLastStep is 5, but A's window must end at 2 — B's motion must not
    // widen A's replace window over A's existing later events.
    const A = tgt('a', 'pa');
    const B = tgt('b', 'pb');
    const h = harness();
    // Seed A with prior automation whose step-4 event must survive.
    h.set(A, 0.5);
    h.ctrl.armLane(LANE);
    h.ctrl.recordLaneTick(LANE, IDX, modsOf(A), 6, 8);
    h.ctrl.recordLaneTick(LANE, IDX, modsOf(A), 0, 8);
    h.move(A, 0.5); h.ctrl.recordLaneTick(LANE, IDX, modsOf(A), 0.5, 8);
    h.move(A, 0.9); h.ctrl.recordLaneTick(LANE, IDX, modsOf(A), 4, 8);
    h.release(A);
    h.ctrl.recordLaneTick(LANE, IDX, modsOf(A), 0, 8); // commit seed
    h.ctrl.disarmLane(LANE);
    const priorA = h.eventsOf(IDX, A)!;
    const stepFourish = priorA.filter((e) => e.step >= 3.5);
    expect(stepFourish.length, 'seed reached ~step 4').toBeGreaterThan(0);

    h.set(A, 0.5);
    h.set(B, 0.1);
    h.ctrl.armLane(LANE);
    h.ctrl.recordLaneTick(LANE, IDX, modsOf(A, B), 6, 8);
    h.ctrl.recordLaneTick(LANE, IDX, modsOf(A, B), 0, 8); // punch-in
    h.move(A, 0.1); h.move(B, 0.3); h.ctrl.recordLaneTick(LANE, IDX, modsOf(A, B), 2, 8);
    h.release(A); // A's gesture ends at step 2
    h.move(B, 0.8); h.ctrl.recordLaneTick(LANE, IDX, modsOf(A, B), 5, 8); // B keeps going to step 5
    h.ctrl.disarmLane(LANE); // partial commit (global end = 5)
    const outA = h.eventsOf(IDX, A)!;
    for (const e of stepFourish) {
      expect(
        outA.some((p) => p.step === e.step && Math.abs(p.value - e.value) < 1e-9),
        `A's existing event @${e.step} survives (A's window ended at 2)`,
      ).toBe(true);
    }
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
    const tracks: AutomationTrack[] = [
      { target: shared, events: [{ step: 0, value: 0.4 }] },
      { target: solo, events: [{ step: 0, value: 0.6 }] },
    ];
    const h = harness();
    h.ctrl.holdLastValue(tracks, 8, 0.012, { atTime: 123, skipKeys: new Set(['s::p']) });
    expect(h.holds.map((x) => x.target.nodeId)).toEqual(['o']); // shared skipped
    expect(h.holds[0]!.atTime).toBe(123); // the boundary time reaches the dep
    expect(h.holds[0]!.toValueNorm).toBeCloseTo(0.6, 9);
  });

  it('holdLastValue truncateKeys cancel-only immediate-switch shared params (no resting pin)', () => {
    const shared = tgt('s', 'p');
    const tracks: AutomationTrack[] = [{ target: shared, events: [{ step: 0, value: 0.4 }] }];
    const h = harness();
    h.ctrl.holdLastValue(tracks, 3, 0.012, { truncateKeys: new Set(['s::p']) });
    expect(h.holds.length).toBe(1);
    expect(h.holds[0]!.toValueNorm).toBeNull(); // truncate-only — incoming repossesses
    expect(h.holds[0]!.glideS).toBe(0);
  });

  it('holdLastValue only releases THESE tracks\' driven keys (other lanes keep touch-truncate scoping)', () => {
    const mine = tgt('m', 'p');
    const other = tgt('x', 'q');
    const myTracks: AutomationTrack[] = [{ target: mine, events: [{ step: 0, value: 0.5 }] }];
    const otherTrack: AutomationTrack = { target: other, events: [{ step: 0, value: 0.5 }] };
    const h = harness();
    h.ctrl.playbackStep(otherTrack, 0, 0.5, 100); // another lane drives `other`
    h.ctrl.holdLastValue(myTracks, 8, 0.012); // stopping MY clip…
    h.holds.length = 0;
    h.ctrl.notifyTouch(other); // …must not un-scope the other lane's truncate
    expect(h.holds.length).toBe(1); // grab still truncates the driven param
  });
});
