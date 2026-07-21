// packages/web/src/lib/audio/modules/clip-play-every.test.ts
//
// PER-NOTE PLAY EVERY — the count-divider that STACKS with per-note PROBABILITY.
// Pins the pure model (coerce / effective / write seam), the DETERMINISTIC
// loop-gate (notePlaysThisLoop — collab-safe: no dice, driven by the shared
// loop count), and the STACKING firing decision in notesFiringAt (play-every
// gate FIRST, then the probability roll). No engine — deterministic + fast.
//
// PHASE (owner-locked, tweakable on preview): a note plays on the Nth, 2Nth, …
// occurrence — 1-based pass p = loopCount+1 fires when p % N === 0. So
// play-every-2 fires on passes 2,4,6 (0-based loopCount 1,3,5), silent on the
// first pass; play-every-1 (default) fires on every pass.

import { describe, it, expect } from 'vitest';
import { mulberry32 } from '$lib/sync/prng';
import {
  defaultNoteClip,
  coercePlayEvery,
  playEveryEff,
  notePlaysThisLoop,
  setNotePlayEvery,
  coerceNoteEvent,
  notesFiringAt,
  PLAY_EVERY_MAX,
  PLAY_EVERY_DEFAULT,
  type NoteClipRecord,
  type NoteEvent,
} from './clip-types';

function clipWith(ev: Partial<NoteEvent>): NoteClipRecord {
  return { ...defaultNoteClip(), steps: [{ step: 0, midi: 60, velocity: 100, lengthSteps: 1, ...ev }] };
}

describe('play-every model (coerce / effective / write seam)', () => {
  it('coercePlayEvery clamps to an int 1..8; non-finite ⇒ default 1', () => {
    expect(coercePlayEvery(1)).toBe(1);
    expect(coercePlayEvery(8)).toBe(8);
    expect(coercePlayEvery(0)).toBe(1); // below range → clamp up to default
    expect(coercePlayEvery(99)).toBe(PLAY_EVERY_MAX);
    expect(coercePlayEvery(3.4)).toBe(3); // rounds
    expect(coercePlayEvery('x')).toBe(PLAY_EVERY_DEFAULT);
    expect(coercePlayEvery(undefined)).toBe(PLAY_EVERY_DEFAULT);
  });

  it('playEveryEff reads the note’s own value, else 1', () => {
    expect(playEveryEff({ playEvery: 4 })).toBe(4);
    expect(playEveryEff({})).toBe(1);
    expect(playEveryEff(undefined)).toBe(1);
    expect(playEveryEff({ playEvery: 0 })).toBe(1); // invalid → default
  });

  it('coerceNoteEvent stores 2..8 but DROPS the default 1 (byte-identical legacy)', () => {
    expect(coerceNoteEvent({ step: 0, midi: 60, playEvery: 3 })?.playEvery).toBe(3);
    expect(coerceNoteEvent({ step: 0, midi: 60, playEvery: 1 })).not.toHaveProperty('playEvery');
    expect(coerceNoteEvent({ step: 0, midi: 60 })).not.toHaveProperty('playEvery'); // legacy note untouched
    expect(coerceNoteEvent({ step: 0, midi: 60, playEvery: 20 })?.playEvery).toBe(8); // clamped
  });

  it('setNotePlayEvery stores 2..8, deletes the key at 1, and never creates a note', () => {
    const clip = clipWith({ playEvery: 5 });
    // set to 2 → stored
    expect(setNotePlayEvery(clip, 0, 60, 2).steps[0]!.playEvery).toBe(2);
    // set to 1 (default) → key deleted (byte-identical)
    expect(setNotePlayEvery(clip, 0, 60, 1).steps[0]!).not.toHaveProperty('playEvery');
    // an empty cell → SAME reference (caller skips the write)
    expect(setNotePlayEvery(clip, 3, 72, 4)).toBe(clip);
  });
});

describe('notePlaysThisLoop (DETERMINISTIC loop gate — collab-safe)', () => {
  it('play-every-1 (default) fires on every loop', () => {
    for (let lc = 0; lc < 8; lc++) expect(notePlaysThisLoop({ playEvery: 1 }, lc)).toBe(true);
    for (let lc = 0; lc < 8; lc++) expect(notePlaysThisLoop({}, lc)).toBe(true);
  });

  it('play-every-2 fires on passes 2,4,6 (0-based loopCount 1,3,5) — silent on the first pass', () => {
    const fires = [0, 1, 2, 3, 4, 5].map((lc) => notePlaysThisLoop({ playEvery: 2 }, lc));
    expect(fires).toEqual([false, true, false, true, false, true]);
  });

  it('play-every-3 fires on passes 3,6,9 (loopCount 2,5,8)', () => {
    const fires = Array.from({ length: 9 }, (_, lc) => notePlaysThisLoop({ playEvery: 3 }, lc));
    expect(fires).toEqual([false, false, true, false, false, true, false, false, true]);
  });
});

describe('notesFiringAt: play-every STACKS with probability', () => {
  it('prob=1 + play-every-2 → fires on its loops ONLY, deterministic (no dice)', () => {
    const clip = clipWith({ prob: 1, playEvery: 2 });
    // A dice source that would ALWAYS pass — proves the gate, not the roll, decides.
    const always = () => 0;
    const fired = [0, 1, 2, 3].map((lc) => notesFiringAt(clip, 0, always, lc).length === 1);
    expect(fired).toEqual([false, true, false, true]);
  });

  it('unset prob + play-every-2 → same deterministic every-other-loop firing', () => {
    const clip = clipWith({ playEvery: 2 }); // no prob → effProb 1 → always-fire half
    const fired = [0, 1, 2, 3, 4, 5].map((lc) => notesFiringAt(clip, 0, () => 0.999, lc).length === 1);
    expect(fired).toEqual([false, true, false, true, false, true]);
  });

  it('prob<1 + play-every-1 → rolls exactly like today (loopCount does not gate)', () => {
    const clip = clipWith({ prob: 0.5 }); // playEvery default 1
    const rng = mulberry32(42);
    // With a fixed seed the sequence is stable; every loop is eligible (only the
    // dice decides), so over many loops ~half fire — never a play-every skip.
    let fires = 0;
    for (let lc = 0; lc < 400; lc++) if (notesFiringAt(clip, 0, rng, lc).length === 1) fires++;
    expect(fires).toBeGreaterThan(150);
    expect(fires).toBeLessThan(250); // ~200/400, a wide statistical band
  });

  it('prob<1 + play-every-2 → BOTH gates: eligible only every other loop AND must win the roll', () => {
    const clip = clipWith({ prob: 0.5, playEvery: 2 });
    // On NON-eligible loops (loopCount 0,2,4…) it can NEVER fire, even with a
    // guaranteed-pass dice — the deterministic gate blocks it first.
    for (const lc of [0, 2, 4, 6]) {
      expect(notesFiringAt(clip, 0, () => 0, lc).length, `loop ${lc} blocked by play-every`).toBe(0);
    }
    // On eligible loops (1,3,5…) a guaranteed-pass dice fires it, a guaranteed-
    // fail dice does not — so the probability roll still applies.
    for (const lc of [1, 3, 5]) {
      expect(notesFiringAt(clip, 0, () => 0, lc).length, `loop ${lc} eligible + wins`).toBe(1);
      expect(notesFiringAt(clip, 0, () => 0.999, lc).length, `loop ${lc} eligible but loses`).toBe(0);
    }
  });

  it('loopCount UNDEFINED skips the play-every gate (preview shows every note)', () => {
    const clip = clipWith({ playEvery: 8 }); // would rarely fire under the gate
    expect(notesFiringAt(clip, 0, () => 0).length).toBe(1); // no gate → shown
  });
});
