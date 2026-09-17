import { describe, expect, it } from 'vitest';
import { captureGateLength } from './clip-record-capture';
import { extendRecordedNote } from './clip-record';
import {
  coerceClipRecord, coerceNoteEvent, copyClip, defaultNoteClip, doubleNoteClip,
  reverseClipSteps, noteGateDurations, assignPolyLanes, createPolyLaneBook,
  type NoteClipRecord,
} from './clip-types';

const clip = (gateLen?: number): NoteClipRecord => ({
  ...defaultNoteClip(), steps: [{ step: 2, midi: 60, lengthSteps: 1, ...(gateLen === undefined ? {} : { gateLen }) }],
});

describe('captured gate duration', () => {
  it('keeps a stab and a 1.4-step hold independent of rounded onset/release steps', () => {
    for (const duration of [0.2, 1.4]) {
      const gateLen = captureGateLength(1000, 1000 + duration * 125, 0.125);
      const result = extendRecordedNote(clip(), 2, 60, 3, gateLen).steps[0]!;
      expect(result.gateLen).toBeCloseTo(duration);
      expect(result.lengthSteps).toBe(1);
      expect(noteGateDurations([result], 0.125, 0.9)[0]).toBeCloseTo(duration * 0.125);
    }
  });

  it('uses the lane duration and survives multiple loop wraps, clamping to the clip end', () => {
    expect(captureGateLength(1000, 1350, 0.25)).toBeCloseTo(1.4);
    expect(extendRecordedNote(clip(), 2, 60, 2, captureGateLength(1000, 5000, 0.125)).steps[0])
      .toMatchObject({ gateLen: 14, lengthSteps: 14 });
    const last = { ...clip(), steps: [{ step: 15, midi: 60 }] };
    expect(extendRecordedNote(last, 15, 60, 0, 1.4).steps[0]).toMatchObject({ gateLen: 1, lengthSteps: 1 });
  });

  it('rejects invalid timing and preserves the legacy fallback', () => {
    for (const dur of [undefined, 0, -1, NaN, Infinity]) expect(captureGateLength(1000, 1100, dur)).toBeUndefined();
    expect(captureGateLength(1000, 999, 0.125)).toBeUndefined();
    expect(extendRecordedNote(clip(), 2, 60, 4).steps[0]).toEqual({ step: 2, midi: 60, lengthSteps: 3 });
  });

  it('round-trips new fields, drops invalid fields, and never adds them to legacy saves', () => {
    expect(coerceClipRecord(JSON.parse(JSON.stringify(clip(1.4))))).toEqual(clip(1.4));
    expect(coerceClipRecord(clip())).toEqual(clip());
    for (const gateLen of [0, -1, NaN, Infinity, '1.4']) {
      expect(coerceNoteEvent({ step: 2, midi: 60, gateLen })).toEqual({ step: 2, midi: 60 });
    }
    expect((coerceClipRecord(clip(100)) as NoteClipRecord).steps[0]!.gateLen).toBe(14);
  });

  it('copy, double and reverse retain precision without carrying gates beyond the loop', () => {
    expect(copyClip(clip(1.4)).steps[0]!.gateLen).toBe(1.4);
    expect(doubleNoteClip(clip(1.4)).steps.map((e) => [e.step, e.gateLen])).toEqual([[2, 1.4], [18, 1.4]]);
    const reverse = reverseClipSteps(clip(1.4));
    expect(reverse.steps[0]).toMatchObject({ step: 12, lengthSteps: 1, gateLen: 1.4 });
    expect(reverseClipSteps(reverse)).toEqual(clip(1.4));
    expect(reverseClipSteps(clip(0.2)).steps[0]).toMatchObject({ step: 13, gateLen: 0.2 });
    expect(reverseClipSteps(clip(100)).steps[0]).toMatchObject({ step: 0, gateLen: 14, lengthSteps: 14 });
  });

  it('legacy chords retain their shared duration; captured voices close independently', () => {
    const legacy = [{ step: 0, midi: 60, lengthSteps: 3 }, { step: 0, midi: 64 }];
    expect(noteGateDurations(legacy, 0.125, 0.9)).toEqual([0.373, 0.373]);
    const notes = legacy.map((e, i) => ({ ...e, gateLen: [0.2, 1.4][i]! }));
    const durations = noteGateDurations(notes, 0.125, 0.1);
    expect(durations[0]).toBeCloseTo(0.025);
    expect(durations[1]).toBeCloseTo(0.175);
    const book = createPolyLaneBook();
    const writes = assignPolyLanes(book, notes, 10, durations);
    expect(writes.map((e) => e.lane)).toEqual([0, 1]);
    expect(writes[0]!.offAt).toBeCloseTo(10.025);
    expect(writes[1]!.offAt).toBeCloseTo(10.175);
    expect(assignPolyLanes(book, [{ midi: 67 }], 10.1, 0.2)[0]!.lane).toBe(0);
    expect(book.note[1]).toBe(64);
  });
});
