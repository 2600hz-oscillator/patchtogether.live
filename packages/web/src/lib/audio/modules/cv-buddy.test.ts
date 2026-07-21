// packages/web/src/lib/audio/modules/cv-buddy.test.ts
//
// CV Buddy def contract + the ADVERSARIAL guards that keep it a note SINK.
// PURE (no AudioContext): asserts ports/params/docs shape + the two invariants
// that break silently if a later edit gets them wrong:
//   1. isNoteSource(cvBuddyDef) === false  (no 'pitch'-typed / poly OUTPUT)
//   2. resolveMainAudioOut === null        (no audio out ⇒ never a mixer send)

import { describe, it, expect } from 'vitest';
import { cvBuddyDef, CV_BUDDY_PPQN_CHOICES, CV_BUDDY_DEFAULT_PPQN } from './cv-buddy';
import { isNoteSource, resolveMainAudioOut } from '$lib/graph/patch-convenience';

describe('cvBuddy def — identity + ports', () => {
  it('is an audio output module with a lowercase label', () => {
    expect(cvBuddyDef.type).toBe('cvBuddy');
    expect(cvBuddyDef.domain).toBe('audio');
    expect(cvBuddyDef.category).toBe('output');
    expect(cvBuddyDef.label).toBe('cv buddy');
    expect(cvBuddyDef.label).toBe(cvBuddyDef.label.toLowerCase());
  });

  it('inputs mirror midiOutBuddy: gate(gate) + pitch(cv) + velocity(cv)', () => {
    expect(cvBuddyDef.inputs).toEqual([
      { id: 'gate', type: 'gate', edge: 'gate' },
      { id: 'pitch', type: 'cv' },
      { id: 'velocity', type: 'cv' },
    ]);
  });

  it('outputs are cv/gate ONLY — pitchCv/gate/velCv/run/clock', () => {
    const byId = Object.fromEntries(cvBuddyDef.outputs.map((p) => [p.id, p.type]));
    expect(byId).toEqual({ pitchCv: 'cv', gate: 'gate', velCv: 'cv', run: 'gate', clock: 'gate' });
  });

  it('has NO pitch-typed output and NO poly output (the isNoteSource trap)', () => {
    expect(cvBuddyDef.outputs.some((p) => p.type === 'pitch')).toBe(false);
    expect(cvBuddyDef.outputs.some((p) => p.type === 'polyPitchGate')).toBe(false);
  });

  it('has NO audio-typed output (never a mixer send)', () => {
    expect(cvBuddyDef.outputs.some((p) => p.type === 'audio')).toBe(false);
  });
});

describe('cvBuddy def — ADVERSARIAL invariants', () => {
  it('isNoteSource(cvBuddyDef) === false — CV Buddy can RECEIVE note data', () => {
    expect(isNoteSource(cvBuddyDef)).toBe(false);
  });

  it('resolveMainAudioOut(cvBuddyDef) === null — planSendToMixer never fires', () => {
    expect(resolveMainAudioOut(cvBuddyDef)).toBeNull();
  });
});

describe('cvBuddy def — params + chainWiring marker', () => {
  it('declares the ppqn menu (default 24 DIN-sync) + a ±20 ms clock offset', () => {
    const ppqn = cvBuddyDef.params.find((p) => p.id === 'ppqn');
    const off = cvBuddyDef.params.find((p) => p.id === 'clockOffsetMs');
    expect(ppqn?.defaultValue).toBe(CV_BUDDY_DEFAULT_PPQN);
    expect(CV_BUDDY_DEFAULT_PPQN).toBe(24);
    expect(CV_BUDDY_PPQN_CHOICES).toContain(24);
    expect(off).toMatchObject({ min: -20, max: 20, defaultValue: 0, units: 'ms' });
  });

  it('carries the noteSink chainWiring marker (Part-B tap planner) + audio-return flag', () => {
    expect(cvBuddyDef.chainWiring).toEqual({
      role: 'noteSink',
      laneTap: { pitchIn: 'pitch', gateIn: 'gate', velIn: 'velocity' },
      returnsAudio: true,
    });
  });
});

describe('cvBuddy def — co-located docs completeness (STRICT_DOCS)', () => {
  it('documents the explanation + every port + every param', () => {
    const docs = cvBuddyDef.docs!;
    expect(docs.explanation?.trim()).toBeTruthy();
    for (const p of cvBuddyDef.inputs) expect(docs.inputs?.[p.id]?.trim(), `input ${p.id}`).toBeTruthy();
    for (const p of cvBuddyDef.outputs) expect(docs.outputs?.[p.id]?.trim(), `output ${p.id}`).toBeTruthy();
    for (const p of cvBuddyDef.params) expect(docs.controls?.[p.id]?.trim(), `param ${p.id}`).toBeTruthy();
  });
});
