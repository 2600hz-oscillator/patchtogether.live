// packages/web/src/lib/audio/modules/polyseqz.test.ts
//
// Module-level unit tests for POLYSEQZ. Validates the def shape, default
// step seeding, and step coercion / round-trip — the audio-graph factory
// path is exercised in the ART scenario + E2E spec.

import { describe, it, expect } from 'vitest';
import {
  polyseqzDef,
  defaultChordSteps,
  coerceToChordStep,
  STEP_COUNT,
  POLYSEQZ_VOICE_LANES,
} from './polyseqz';
import { CHORD_QUALITY_NAMES, VOICE_LANES } from '$lib/audio/chord-tables';
import { POLY_CHANNEL_PAIRS } from '$lib/audio/poly';

describe('polyseqz: module def', () => {
  it('registers as audio-domain module type "polyseqz"', () => {
    expect(polyseqzDef.type).toBe('polyseqz');
    expect(polyseqzDef.domain).toBe('audio');
    expect(polyseqzDef.label).toBe('POLYSEQZ');
    expect(polyseqzDef.category).toBe('modulation');
  });

  it('declares the polyPitchGate output port', () => {
    const out = polyseqzDef.outputs.find((p) => p.id === 'poly');
    expect(out).toBeDefined();
    expect(out?.type).toBe('polyPitchGate');
  });

  it('exposes humanize CV input + knob param', () => {
    const inp = polyseqzDef.inputs.find((p) => p.id === 'humanize_cv');
    expect(inp?.type).toBe('cv');
    expect(inp?.paramTarget).toBe('humanize');
    const knob = polyseqzDef.params.find((p) => p.id === 'humanize');
    expect(knob).toBeDefined();
    expect(knob?.min).toBe(0);
    expect(knob?.max).toBe(1);
    expect(knob?.defaultValue).toBe(0);
  });

  it('exposes a length param matching STEP_COUNT', () => {
    const length = polyseqzDef.params.find((p) => p.id === 'length');
    expect(length).toBeDefined();
    expect(length?.max).toBe(STEP_COUNT);
  });

  it('voice lane count matches the polyPitchGate cable', () => {
    expect(POLYSEQZ_VOICE_LANES).toBe(POLY_CHANNEL_PAIRS);
    expect(POLYSEQZ_VOICE_LANES).toBe(VOICE_LANES);
  });
});

describe('polyseqz: defaultChordSteps', () => {
  it('returns STEP_COUNT entries', () => {
    const steps = defaultChordSteps();
    expect(steps.length).toBe(STEP_COUNT);
  });

  it('every default step is off, with C3 root and maj/closed/inv0', () => {
    const steps = defaultChordSteps();
    for (const s of steps) {
      expect(s.on).toBe(false);
      expect(s.root).toBe(48); // C3
      expect(s.quality).toBe('maj');
      expect(s.inversion).toBe(0);
      expect(s.voicing).toBe('closed');
    }
  });
});

describe('polyseqz: coerceToChordStep — round-trip + tolerance', () => {
  it('round-trips a fully-specified step', () => {
    const raw = { on: true, root: 67, quality: 'min7', inversion: 1, voicing: 'open' };
    const out = coerceToChordStep(raw);
    expect(out.on).toBe(true);
    expect(out.root).toBe(67);
    expect(out.quality).toBe('min7');
    expect(out.inversion).toBe(1);
    expect(out.voicing).toBe('open');
  });

  it('falls back to defaults when fields missing', () => {
    const out = coerceToChordStep({ on: true });
    expect(out.on).toBe(true);
    expect(out.quality).toBe('maj');
    expect(out.inversion).toBe(0);
    expect(out.voicing).toBe('closed');
  });

  it('drops invalid quality values', () => {
    const out = coerceToChordStep({ on: true, root: 60, quality: 'bogus' });
    expect(out.quality).toBe('maj');
  });

  it('drops invalid inversion values', () => {
    const out = coerceToChordStep({ on: true, root: 60, inversion: 99 });
    expect(out.inversion).toBe(0);
  });

  it('accepts midi field for backward compat with NoteStep shape', () => {
    // Reuses coerceToNoteStep underneath — older sequencer-style
    // {on, midi, ...} blobs should still load.
    const out = coerceToChordStep({ on: true, midi: 64, quality: 'min' });
    expect(out.on).toBe(true);
    expect(out.root).toBe(64);
    expect(out.quality).toBe('min');
  });

  it('null root means empty step', () => {
    const out = coerceToChordStep({ on: true, root: null });
    expect(out.root).toBeNull();
  });

  it('all CHORD_QUALITY_NAMES round-trip cleanly', () => {
    for (const q of CHORD_QUALITY_NAMES) {
      const out = coerceToChordStep({ on: true, root: 60, quality: q });
      expect(out.quality).toBe(q);
    }
  });
});
