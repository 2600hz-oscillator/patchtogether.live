// packages/web/src/lib/ui/modules/joystick-persist-model.test.ts
//
// THE PERMANENT LEGS BEHIND THE #1963 RULING — the stick STAYS where you put it.
//
// The owner's answer on #1963 (verbatim "1 - persist") turned a value that was
// previously wiped on every pointer-release into a genuinely persisted one, so
// what `clampJoy` does is now load-bearing rather than incidental. Two things
// here that no other gate sees:
//
//  1. A NON-FINITE value resolves to the CENTRE, not to a rail — a behaviour a
//     reader guesses wrong in both directions, since a saturating clamp would
//     send +Infinity to +1 and hand an automation source a hard-right stick.
//
//  2. The DOCS no longer promise a snap-back. That is the half of the module's
//     self-contradiction the ruling killed, and it is asserted against the
//     artifact so re-introducing the sentence is red.
//
// ⚠ THIS FILE IS NOT `joystick-face-model.test.ts` — that file exists now
// (2026-09-01, the promotion this header spent two revisions promising) and
// pins the FACE: the two-ordinary-cells curation, the dock pad body's drag
// contract, and the redundancy discipline (the pad emits no `control-*`
// anchor). THIS file stays what it always was: the #1963 value semantics
// every surface shares — card, knob cells and pad body all commit through
// `clampJoy` and all persist through `node.params`.

import { describe, expect, it } from 'vitest';
import { clampJoy, joystickDef } from '$lib/audio/modules/joystick';

describe('#1963 "1 - persist": the value the stick leaves behind', () => {
  it('CLAMPS to the rails, so a pad edge and an out-of-range write agree', () => {
    expect(clampJoy(-2)).toBe(-1);
    expect(clampJoy(-1.0000001)).toBe(-1);
    expect(clampJoy(-0.5)).toBe(-0.5);
    expect(clampJoy(0.5)).toBe(0.5);
    expect(clampJoy(1.0000001)).toBe(1);
    expect(clampJoy(2)).toBe(1);
  });

  it('⚠ sends every NON-FINITE value to the CENTRE, not to a rail', () => {
    // The case a reader guesses wrong: a saturating clamp would map +Infinity
    // to +1 and hand a MIDI/automation source emitting garbage a HARD RIGHT
    // stick. `clampJoy` returns 0 first, so the stick recentres instead.
    expect(clampJoy(NaN)).toBe(0);
    expect(clampJoy(Infinity)).toBe(0);
    expect(clampJoy(-Infinity)).toBe(0);
  });

  it('NEGATIVE CONTROL — a saturating clamp would disagree on exactly those three', () => {
    // Written as the thing clampJoy is NOT, so the leg above cannot pass
    // vacuously against an implementation that only ever sees finite input.
    const saturating = (v: number) => Math.max(-1, Math.min(1, v));
    expect(saturating(Infinity)).toBe(1);
    expect(saturating(-Infinity)).toBe(-1);
    expect(Number.isNaN(saturating(NaN))).toBe(true);
    // ...and they agree everywhere else, which is why only the three matter.
    for (const v of [-2, -1, -0.5, 0, 0.5, 1, 2]) expect(clampJoy(v)).toBe(saturating(v));
  });

  it('both axes default to the CENTRE, which is the state a fresh spawn persists', () => {
    for (const id of ['pos_x', 'pos_y']) {
      const p = joystickDef.params.find((q) => q.id === id);
      expect(p?.defaultValue, id).toBe(0);
      expect([p?.min, p?.max], id).toEqual([-1, 1]);
    }
  });

  it('the DOCS no longer promise a snap-back — the half the ruling killed', () => {
    // A source-level leg, because the docs are the surface the ruling was
    // actually about: the def used to say the value is "snapped back to 0 on
    // release" AND that "it survives a patch reload", which cannot both be
    // useful. Anchored to the artifact so re-introducing either sentence is red.
    //
    // ⚠ THE FORBIDDEN THING IS "SNAP *BACK*", NOT THE WORD "SNAP". The first
    // draft of this leg banned the substring and went red on the docs' own
    // (correct, and newly written) sentence about a non-finite value SNAPPING
    // TO CENTRE — a ban broad enough to forbid the fix as well as the bug.
    const blob = JSON.stringify(joystickDef.docs).toLowerCase();
    for (const banned of ['snapped back', 'snaps back', 'snap back', 'spring-back', 'on release']) {
      expect(blob, `the #1963 ruling deleted "${banned}" from this module's docs`).not.toContain(banned);
    }
    expect(blob, 'the surviving half of the contradiction must still be stated').toContain('survives a reload');
    expect(blob, 'and the replacement re-centre gesture has to be documented somewhere').toContain('double-click');
  });
});
