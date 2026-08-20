// packages/web/src/lib/audio/modules/cv-buddy.test.ts
//
// CV Buddy def contract + the ADVERSARIAL guards that keep it a note SINK.
// PURE (no AudioContext): asserts ports/params/docs shape + the two invariants
// that break silently if a later edit gets them wrong:
//   1. isNoteSource(cvBuddyDef) === false  (no 'pitch'-typed / poly OUTPUT)
//   2. resolveMainAudioOut === null        (no audio out ⇒ never a mixer send)

import { describe, it, expect } from 'vitest';
import { cvBuddyDef, CV_BUDDY_PPQN_CHOICES, CV_BUDDY_DEFAULT_PPQN, snapPpqn } from './cv-buddy';
import { cvBuddyMiniDef } from './cv-buddy-mini';
import { knobNameReadout } from '$lib/ui/controls/knob-vocabulary-model';
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

// ── PPQN: THE ROSTER **IS** THE LEGAL SET (owner ruling, 2026-08-20) ─────────
//
// *"just change it to legal settings only."* Before this, `ppqn` declared
// `1..48 discrete` with no roster: FORTY-EIGHT reachable positions against
// SEVEN legal ones. The card's `<select>` could not produce the other 41 and
// nothing rejected them — `setParam` handed the value straight to the clock
// scheduler — so a rack could clock Pam's at a division nothing else in the
// room agreed on, and a faceplate painted the whole thing as a 48-position dial.
//
// The fix is a SPARSE roster declared EXHAUSTIVE rather than an index remap,
// and the difference is entirely about USER DATA: the values stay real PPQN
// numbers, so `ppqn: 24` in a saved rack, an IndexedDB replica or a peer's Y
// update is still exactly what it always was. There is no migration, because
// there is nothing to migrate — which matters because the per-module migration
// substrate was deliberately deleted (`persistence.ts`) and the arrival routes
// that bypass every loader (replica restore, peer sync, undo) have no seam a
// migration could sit in.
describe('cvBuddy ppqn — legal settings only', () => {
  const ppqn = () => cvBuddyDef.params.find((p) => p.id === 'ppqn')!;

  it('the roster IS the exported menu, and it is declared EXHAUSTIVE with a why', () => {
    const p = ppqn();
    expect(p.options?.map((o) => o.value)).toEqual([...CV_BUDDY_PPQN_CHOICES]);
    expect(p.optionsExhaustive, 'the sparse roster must be DECLARED, not inferred').toBeTruthy();
    // The `why` is required by the type; this refuses a placeholder.
    expect(p.optionsExhaustive!.why.split(/\s+/).length).toBeGreaterThan(8);
    // ⚠ The declared RANGE is untouched — that is the whole point. A stored
    // `ppqn: 24` is still in range and still means 24.
    expect(p.min).toBe(1);
    expect(p.max).toBe(48);
    expect(p.defaultValue).toBe(CV_BUDDY_DEFAULT_PPQN);
  });

  it('BOTH kinds share ONE param object — not two rosters free to drift', () => {
    // They render one shared body and draw from one ES-9 jack pool; two copies
    // would be two menus, and the drift would be invisible until a user noticed
    // one card offering a division the other refused.
    expect(cvBuddyMiniDef.params.find((p) => p.id === 'ppqn')).toBe(ppqn());
  });

  it('SNAPS every reachable position onto a legal division', () => {
    const legal = new Set(CV_BUDDY_PPQN_CHOICES);
    for (let v = 1; v <= 48; v++) expect(legal.has(snapPpqn(v)), `ppqn ${v}`).toBe(true);
    // Legal values pass through EXACT — snapping must not perturb a setting a
    // player deliberately chose.
    for (const v of CV_BUDDY_PPQN_CHOICES) expect(snapPpqn(v)).toBe(v);
  });

  it('a LEGACY rack holding an illegal value: what it CLOCKS and what it SHOWS agree', () => {
    // The read-side story, stated as a test because it is the thing a user
    // meets. A rack saved before this ruling can hold e.g. `ppqn: 7`.
    //
    //   · it CLOCKS at 8 — the engine snaps at the point of USE, which is the
    //     one place every arrival route passes through (file load, IndexedDB
    //     restore, peer sync, undo);
    //   · it SHOWS 8 — the selector and the readout both resolve through the
    //     same `nearestByValue`;
    //   · and the graph still holds 7 until the player's first ordinary,
    //     TAGGED, undoable write normalizes it. No silent engine-side repair:
    //     a silent repair of a data-integrity bug is indistinguishable from no
    //     bug, which is how the original defect survived.
    expect(snapPpqn(7)).toBe(8);
    expect(knobNameReadout(7, ppqn())).toBe('8');
    // The two resolvers agreeing is the property — asserted across the whole
    // illegal span, not just one example, because a floor-snapping
    // implementation would SHOW one division and STORE another.
    for (let v = 1; v <= 48; v++) {
      expect(knobNameReadout(v, ppqn()), `display vs snap at ${v}`).toBe(String(snapPpqn(v)));
    }
  });

  it('NEGATIVE CONTROL — without the roster, all 41 illegal positions were reachable', () => {
    // The pre-ruling state, reconstructed by deleting exactly what was added.
    // Without it there is no legal set to land on, so the defect is that every
    // integer is simply accepted.
    const { options: _o, optionsExhaustive: _e, ...bare } = ppqn();
    expect((bare as { options?: unknown }).options).toBeUndefined();
    const steps = bare.max - bare.min + 1;
    expect(steps).toBe(48);
    expect(steps - CV_BUDDY_PPQN_CHOICES.length).toBe(41);
  });
});
