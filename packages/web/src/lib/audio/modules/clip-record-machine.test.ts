// packages/web/src/lib/audio/modules/clip-record-machine.test.ts
//
// The KEYS record STATE MACHINE (redesign §2.1): idle → armed → recording →
// overdubbing, with arming DECOUPLED from capture. Pins the transitions + the
// robust loop-wrap detection (owner problem 1b — a skipped step 0 must still
// register as a wrap so the punch-in fires).

import { describe, it, expect } from 'vitest';
import {
  recPhase,
  isCapturing,
  armTransition,
  punchInTransition,
  stopTransition,
  overdubToggle,
  crossedLoopWrap,
} from './clip-record-machine';
import type { NoteRecState } from './clip-types';

const S = (o: Partial<NoteRecState> = {}): NoteRecState => ({
  lane: 0,
  slot: 0,
  armed: false,
  recording: false,
  overdub: false,
  ...o,
});

describe('recPhase', () => {
  it('derives the four phases', () => {
    expect(recPhase(null)).toBe('idle');
    expect(recPhase(S())).toBe('idle');
    expect(recPhase(S({ armed: true }))).toBe('armed');
    expect(recPhase(S({ recording: true }))).toBe('recording');
    expect(recPhase(S({ recording: true, overdub: true }))).toBe('overdubbing');
    // recording wins over a lingering armed flag
    expect(recPhase(S({ armed: true, recording: true }))).toBe('recording');
  });
  it('isCapturing is true only while recording', () => {
    expect(isCapturing(S({ armed: true }))).toBe(false);
    expect(isCapturing(S({ recording: true }))).toBe(true);
    expect(isCapturing(null)).toBe(false);
  });
});

describe('armTransition — arm decoupled from capture', () => {
  it('idle → armed', () => {
    expect(armTransition(S())).toEqual({ armed: true });
  });
  it('re-tap while armed cancels (armed → idle)', () => {
    expect(armTransition(S({ armed: true }))).toEqual({ armed: false });
  });
  it('a no-op while recording (EXIT stops a take, not arm) or with no state', () => {
    expect(armTransition(S({ recording: true }))).toBeNull();
    expect(armTransition(null)).toBeNull();
  });
});

describe('punchInTransition — armed → recording', () => {
  it('punches in only from armed, preserving overdub', () => {
    expect(punchInTransition(S({ armed: true }))).toEqual({ armed: false, recording: true });
    expect(punchInTransition(S({ armed: true, overdub: true }))).toEqual({
      armed: false,
      recording: true,
    });
  });
  it('is idempotent — no double-punch from a note + a wrap in the same window', () => {
    expect(punchInTransition(S({ recording: true }))).toBeNull();
    expect(punchInTransition(S())).toBeNull(); // not armed
    expect(punchInTransition(null)).toBeNull();
  });
});

describe('stopTransition', () => {
  it('recording/armed → idle', () => {
    expect(stopTransition(S({ recording: true }))).toEqual({ armed: false, recording: false });
    expect(stopTransition(S({ armed: true }))).toEqual({ armed: false, recording: false });
  });
  it('a no-op when already idle', () => {
    expect(stopTransition(S())).toBeNull();
    expect(stopTransition(null)).toBeNull();
  });
});

describe('overdubToggle', () => {
  it('flips the additive-layer flag', () => {
    expect(overdubToggle(S())).toEqual({ patch: { overdub: true }, stopAtWrap: false });
    expect(overdubToggle(S({ overdub: true }))).toEqual({
      patch: { overdub: false },
      stopAtWrap: false,
    });
  });
  it('ON→OFF WHILE overdubbing finishes the loop then stops (stopAtWrap)', () => {
    expect(overdubToggle(S({ recording: true, overdub: true }))).toEqual({
      patch: { overdub: false },
      stopAtWrap: true,
    });
  });
  it('OFF→ON while recording does not set stopAtWrap', () => {
    expect(overdubToggle(S({ recording: true, overdub: false }))).toEqual({
      patch: { overdub: true },
      stopAtWrap: false,
    });
  });
});

describe('crossedLoopWrap — never miss a wrap (owner problem 1b)', () => {
  it('a normal forward advance is NOT a wrap', () => {
    expect(crossedLoopWrap(4, 5)).toBe(false);
    expect(crossedLoopWrap(0, 1)).toBe(false);
    expect(crossedLoopWrap(5, 5)).toBe(false); // same step
  });
  it('entering step 0 from the top IS a wrap', () => {
    expect(crossedLoopWrap(15, 0)).toBe(true);
  });
  it('a SKIPPED step 0 (fast tempo poll jumped 14 → 2) still reads as a wrap', () => {
    expect(crossedLoopWrap(14, 2)).toBe(true);
  });
  it('the first service (prev = -1) is never a wrap', () => {
    expect(crossedLoopWrap(-1, 0)).toBe(false);
    expect(crossedLoopWrap(-1, 5)).toBe(false);
  });
});
