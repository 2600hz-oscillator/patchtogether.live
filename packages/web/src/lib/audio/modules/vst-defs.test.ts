// Def-shape tests for the two VST BRIDGE cards. The port shapes ARE the
// lane integration (plan §4: "the ports do all the work" — planColumnWiring
// / resolveClipWiring infer everything from them, zero wiring code), so
// these assertions are DERIVED from the same classifiers the canvas uses,
// not restatements of the literals. The transport halves have their own
// suites (dsp: vst-bridge-core.test.ts; web: vst/vst-transport.test.ts).

import { describe, expect, it } from 'vitest';
import {
  chainRole,
  isClipEligible,
  isNoteSource,
  resolveClipWiring,
  resolveMainAudioIn,
  resolveMainAudioOut,
} from '$lib/graph/patch-convenience';
import { vstFxDef } from './vst-fx';
import { vstInstrumentDef } from './vst-instrument';

describe('vstInstrument def shape — a chain SOURCE the clip player drives', () => {
  it('bins as a chain SOURCE (audio out, no main audio in, no chainWiring)', () => {
    expect(vstInstrumentDef.chainWiring).toBeUndefined();
    expect(chainRole(vstInstrumentDef)).toBe('source');
    expect(resolveMainAudioIn(vstInstrumentDef)).toBeNull();
    expect(resolveMainAudioOut(vstInstrumentDef)).toEqual({
      kind: 'stereo', left: 'out_l', right: 'out_r',
    });
  });

  it('is a clip TARGET in poly mode with gate + velocity both wired (the owner lane rule)', () => {
    expect(isNoteSource(vstInstrumentDef)).toBe(false);
    expect(isClipEligible(vstInstrumentDef)).toBe(true);
    expect(resolveClipWiring(vstInstrumentDef)).toEqual({
      mode: 'poly',
      pitchInPort: 'poly',
      gateInPort: 'gate',
      velInPort: 'vel',
    });
  });

  it('declares the tidyVco note-input complement with the right cable types', () => {
    const byId = new Map(vstInstrumentDef.inputs.map((p) => [p.id, p]));
    expect(byId.get('poly')?.type).toBe('polyPitchGate');
    expect(byId.get('pitch')?.type).toBe('cv');
    expect(byId.get('gate')?.type).toBe('gate');
    // Level-sensitive note gate, NOT a trigger — NoteOff needs the fall.
    expect(byId.get('gate')?.edge).toBe('gate');
    // isVelCvInput shape: cv cable, no paramTarget, `vel` id token.
    expect(byId.get('vel')?.type).toBe('cv');
    expect(byId.get('vel')?.paramTarget).toBeUndefined();
  });

  it('is stereo-paired, multi-instance, param-free, lowercase-labelled', () => {
    expect(vstInstrumentDef.stereoPairs).toEqual([['out_l', 'out_r']]);
    // Multiple VST cards at once is the whole point (helper cap is 16).
    expect(vstInstrumentDef.maxInstances).toBeUndefined();
    expect(vstInstrumentDef.params).toEqual([]);
    expect(vstInstrumentDef.label).toBe(vstInstrumentDef.label.toLowerCase());
  });
});

describe('vstFx def shape — a stereo chain INSERT', () => {
  it("bins as role 'both' (stereo main in AND out, no chainWiring) → FX insert", () => {
    expect(vstFxDef.chainWiring).toBeUndefined();
    expect(chainRole(vstFxDef)).toBe('both');
    expect(resolveMainAudioIn(vstFxDef)).toEqual({
      kind: 'stereo', left: 'in_l', right: 'in_r',
    });
    expect(resolveMainAudioOut(vstFxDef)).toEqual({
      kind: 'stereo', left: 'out_l', right: 'out_r',
    });
  });

  it('is not a clip target and not a note source (pure audio insert)', () => {
    expect(isNoteSource(vstFxDef)).toBe(false);
    expect(resolveClipWiring(vstFxDef)).toBeNull();
  });

  it('is stereo-paired on both sides, multi-instance, param-free, lowercase-labelled', () => {
    expect(vstFxDef.stereoPairs).toEqual([['in_l', 'in_r'], ['out_l', 'out_r']]);
    expect(vstFxDef.maxInstances).toBeUndefined();
    expect(vstFxDef.params).toEqual([]);
    expect(vstFxDef.label).toBe(vstFxDef.label.toLowerCase());
  });
});

describe('both defs — docs completeness at the surface (STRICT_DOCS backs this at lint level)', () => {
  for (const def of [vstInstrumentDef, vstFxDef]) {
    it(`${def.type}: every port carries an authored docs entry + a real explanation`, () => {
      const docs = def.docs!;
      expect(docs.explanation.length).toBeGreaterThan(200);
      // The multiplayer caveat is a required disclosure (plan §7): audio
      // renders only on the machine running the helper + plugin.
      expect(docs.explanation).toMatch(/helper/i);
      for (const p of def.inputs) {
        expect(docs.inputs?.[p.id], `${def.type} input ${p.id}`).toBeTruthy();
      }
      for (const p of def.outputs) {
        expect(docs.outputs?.[p.id], `${def.type} output ${p.id}`).toBeTruthy();
      }
    });
  }
});
