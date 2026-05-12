// packages/web/src/lib/audio/modules/analog-vco.test.ts
//
// Pins the AnalogVCO module def shape — specifically the tune/fine/fm/pm CV
// inputs added in feat/vco-cv-inputs. The original user complaint
// (ADSR.env → Analog VCO showed "No compatible ports") came from these knobs
// having no matching CV input ports at all. This test prevents that
// regression: every modulatable knob has a paramTarget'd CV input.

import { describe, expect, it } from 'vitest';
import { analogVcoDef } from './analog-vco';

describe('analogVcoDef: module def shape', () => {
  it('declares type=analogVco, label="Analog VCO", category=sources', () => {
    expect(analogVcoDef.type).toBe('analogVco');
    expect(analogVcoDef.label).toBe('Analog VCO');
    expect(analogVcoDef.category).toBe('sources');
  });

  it('exposes inputs: pitch, fm, pm (audio-rate) + tune/fine/fmAmount/pmAmount (cv)', () => {
    const ids = analogVcoDef.inputs.map((p) => p.id).sort();
    expect(ids).toEqual(['fine', 'fm', 'fmAmount', 'pitch', 'pm', 'pmAmount', 'tune']);
  });

  it('exposes 4 output ports (saw, square, triangle, sine)', () => {
    const ids = analogVcoDef.outputs.map((p) => p.id).sort();
    expect(ids).toEqual(['saw', 'sine', 'square', 'triangle']);
  });

  it('exposes 5 params (tune, fine, fmAmount, pmAmount, pw)', () => {
    const ids = analogVcoDef.params.map((p) => p.id).sort();
    expect(ids).toEqual(['fine', 'fmAmount', 'pmAmount', 'pw', 'tune']);
  });

  it('tune CV input: paramTarget=tune, cvScale=linear, ±36 semi range', () => {
    const port = analogVcoDef.inputs.find((p) => p.id === 'tune');
    expect(port).toBeDefined();
    expect(port!.type).toBe('cv');
    expect(port!.paramTarget).toBe('tune');
    expect(port!.cvScale).toEqual({ mode: 'linear' });
    const param = analogVcoDef.params.find((p) => p.id === 'tune')!;
    expect(param.min).toBe(-36);
    expect(param.max).toBe(36);
  });

  it('fine CV input: paramTarget=fine, cvScale=linear, ±100 cent range', () => {
    const port = analogVcoDef.inputs.find((p) => p.id === 'fine');
    expect(port!.type).toBe('cv');
    expect(port!.paramTarget).toBe('fine');
    expect(port!.cvScale).toEqual({ mode: 'linear' });
    const param = analogVcoDef.params.find((p) => p.id === 'fine')!;
    expect(param.min).toBe(-100);
    expect(param.max).toBe(100);
  });

  it('fmAmount CV input: paramTarget=fmAmount, cvScale=linear', () => {
    const port = analogVcoDef.inputs.find((p) => p.id === 'fmAmount');
    expect(port!.type).toBe('cv');
    expect(port!.paramTarget).toBe('fmAmount');
    expect(port!.cvScale).toEqual({ mode: 'linear' });
  });

  it('pm: audio-rate input (phase modulation source)', () => {
    const port = analogVcoDef.inputs.find((p) => p.id === 'pm');
    expect(port!.type).toBe('audio');
  });

  it('pmAmount CV input: paramTarget=pmAmount, cvScale=linear, ±1 bipolar', () => {
    const port = analogVcoDef.inputs.find((p) => p.id === 'pmAmount');
    expect(port!.type).toBe('cv');
    expect(port!.paramTarget).toBe('pmAmount');
    expect(port!.cvScale).toEqual({ mode: 'linear' });
    const param = analogVcoDef.params.find((p) => p.id === 'pmAmount')!;
    expect(param.min).toBe(-1);
    expect(param.max).toBe(1);
    expect(param.defaultValue).toBe(0);
  });

  it('fmAmount param: ±1 bipolar (negative inverts the modulator)', () => {
    const param = analogVcoDef.params.find((p) => p.id === 'fmAmount')!;
    expect(param.min).toBe(-1);
    expect(param.max).toBe(1);
    expect(param.defaultValue).toBe(0);
  });

  it('every CV input declares paramTarget that points at a real param', () => {
    for (const port of analogVcoDef.inputs) {
      if (port.type !== 'cv') continue;
      expect(port.paramTarget, `${port.id} paramTarget`).toBeDefined();
      const param = analogVcoDef.params.find((p) => p.id === port.paramTarget);
      expect(param, `${port.id} → param ${port.paramTarget}`).toBeDefined();
    }
  });

  it('schemaVersion=3 (v1→v2 pmAmount migration; v2→v3 bipolar fm/pmAmount widen)', () => {
    expect(analogVcoDef.schemaVersion).toBe(3);
    expect(analogVcoDef.migrate).toBeDefined();
    // v1 → v3 still seeds the missing pmAmount param at default 0.
    const migrated = analogVcoDef.migrate!({ params: { tune: 0 } }, 1) as { params: Record<string, number> };
    expect(migrated.params.pmAmount).toBe(0);
    expect(migrated.params.tune).toBe(0);
    // v2 → v3 is a no-op: old [0..1] values are a legal subset of [-1..+1].
    const v2 = analogVcoDef.migrate!({ params: { fmAmount: 0.5, pmAmount: 0.25 } }, 2) as { params: Record<string, number> };
    expect(v2.params.fmAmount).toBe(0.5);
    expect(v2.params.pmAmount).toBe(0.25);
  });
});
