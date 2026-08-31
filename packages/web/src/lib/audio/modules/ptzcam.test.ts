// Def-shape and contract gates for ptzcam. The protocol lives in
// ptz-sysex.test.ts, the planner in ptz-control.test.ts; the live chain is
// e2e/tests/ptzcam.spec.ts.
import { describe, expect, it } from 'vitest';
import { ptzcamDef } from './ptzcam';

describe('ptzcam def shape', () => {
  it('is an audio-domain MIDI sink with a factory', () => {
    expect(ptzcamDef.type).toBe('ptzcam');
    expect(ptzcamDef.domain).toBe('audio');
    expect(ptzcamDef.palette).toEqual({ top: 'MIDI', sub: 'MIDI' });
    expect(typeof ptzcamDef.factory).toBe('function');
  });

  it('label is lowercase (card CSS uppercases for display)', () => {
    expect(ptzcamDef.label).toBe(ptzcamDef.label.toLowerCase());
  });

  it('a small instance cap — one module per camera, two cameras on stage, slack for spares', () => {
    expect(ptzcamDef.maxInstances).toBe(4);
  });

  it('declares size on the def, not in rack-sizes', () => {
    expect(ptzcamDef.size).toBe('2u');
    expect(ptzcamDef.hp).toBe(2);
  });

  it('has exactly three cv inputs and no outputs', () => {
    expect(ptzcamDef.inputs.map((p) => [p.id, p.type])).toEqual([
      ['pan_cv', 'cv'],
      ['tilt_cv', 'cv'],
      ['zoom_cv', 'cv'],
    ]);
    expect(ptzcamDef.outputs).toEqual([]);
  });

  it('cv inputs deliberately carry no paramTarget or cvScale (main-thread consumer)', () => {
    // The CV is sampled by the factory and summed with the knob in JS — an
    // AudioParam landing pad would make the summed value unreadable headless.
    // The three ports are enrolled in PASSTHROUGH_BY_DESIGN instead; if a
    // paramTarget appears here, that enrolment and this rationale are stale.
    for (const port of ptzcamDef.inputs) {
      expect(port.paramTarget).toBeUndefined();
      expect(port.cvScale).toBeUndefined();
    }
  });

  it('params are the four knobs with in-range defaults', () => {
    expect(ptzcamDef.params.map((p) => p.id)).toEqual(['pan', 'tilt', 'zoom', 'slew']);
    for (const p of ptzcamDef.params) {
      expect(p.defaultValue).toBeGreaterThanOrEqual(p.min);
      expect(p.defaultValue).toBeLessThanOrEqual(p.max);
      expect(p.curve).toBe('linear');
    }
    const byId = Object.fromEntries(ptzcamDef.params.map((p) => [p.id, p]));
    expect([byId.pan!.min, byId.pan!.max, byId.pan!.defaultValue]).toEqual([-1, 1, 0]);
    expect([byId.tilt!.min, byId.tilt!.max, byId.tilt!.defaultValue]).toEqual([-1, 1, 0]);
    expect([byId.zoom!.min, byId.zoom!.max, byId.zoom!.defaultValue]).toEqual([0, 1, 0]);
  });

  it('docs cover every port and every control', () => {
    const docs = ptzcamDef.docs!;
    expect(docs.explanation!.length).toBeGreaterThan(400);
    for (const port of ptzcamDef.inputs) {
      expect(docs.inputs?.[port.id], `docs.inputs.${port.id}`).toBeTruthy();
    }
    for (const p of ptzcamDef.params) {
      expect(docs.controls?.[p.id], `docs.controls.${p.id}`).toBeTruthy();
    }
  });
});
