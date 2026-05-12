// packages/web/src/lib/audio/modules/wavetable-vco.test.ts
//
// Pins the WavetableVCO module def shape — specifically the tune/fine/fm/pm CV
// inputs added in feat/vco-cv-inputs (parity with AnalogVCO). The wavetable
// processor IS a phase accumulator (vs Faust os.* primitives), so PM is
// implemented as a phase-readout offset.

import { describe, expect, it } from 'vitest';
import { wavetableVcoDef } from './wavetable-vco';

describe('wavetableVcoDef: module def shape', () => {
  it('declares type=wavetableVco, label="Wavetable VCO", category=sources', () => {
    expect(wavetableVcoDef.type).toBe('wavetableVco');
    expect(wavetableVcoDef.label).toBe('Wavetable VCO');
    expect(wavetableVcoDef.category).toBe('sources');
  });

  it('exposes 8 inputs: pitch, fm, pm, wavePos + tune/fine/fmAmount/pmAmount', () => {
    const ids = wavetableVcoDef.inputs.map((p) => p.id).sort();
    expect(ids).toEqual([
      'fine', 'fm', 'fmAmount', 'pitch', 'pm', 'pmAmount', 'tune', 'wavePos',
    ]);
  });

  it('exposes single audio output', () => {
    const ids = wavetableVcoDef.outputs.map((p) => p.id);
    expect(ids).toEqual(['audio']);
  });

  it('exposes 5 params (tune, fine, wavePos, fmAmount, pmAmount)', () => {
    const ids = wavetableVcoDef.params.map((p) => p.id).sort();
    expect(ids).toEqual(['fine', 'fmAmount', 'pmAmount', 'tune', 'wavePos']);
  });

  it('tune CV input: paramTarget=tune, cvScale=linear', () => {
    const port = wavetableVcoDef.inputs.find((p) => p.id === 'tune');
    expect(port!.type).toBe('cv');
    expect(port!.paramTarget).toBe('tune');
    expect(port!.cvScale).toEqual({ mode: 'linear' });
  });

  it('fine CV input: paramTarget=fine, cvScale=linear', () => {
    const port = wavetableVcoDef.inputs.find((p) => p.id === 'fine');
    expect(port!.type).toBe('cv');
    expect(port!.paramTarget).toBe('fine');
    expect(port!.cvScale).toEqual({ mode: 'linear' });
  });

  it('fmAmount CV input: paramTarget=fmAmount, cvScale=linear', () => {
    const port = wavetableVcoDef.inputs.find((p) => p.id === 'fmAmount');
    expect(port!.type).toBe('cv');
    expect(port!.paramTarget).toBe('fmAmount');
    expect(port!.cvScale).toEqual({ mode: 'linear' });
  });

  it('pm: audio-rate input (phase modulation source)', () => {
    const port = wavetableVcoDef.inputs.find((p) => p.id === 'pm');
    expect(port!.type).toBe('audio');
  });

  it('pmAmount CV input: paramTarget=pmAmount, cvScale=linear, ±1 bipolar', () => {
    const port = wavetableVcoDef.inputs.find((p) => p.id === 'pmAmount');
    expect(port!.type).toBe('cv');
    expect(port!.paramTarget).toBe('pmAmount');
    expect(port!.cvScale).toEqual({ mode: 'linear' });
    const param = wavetableVcoDef.params.find((p) => p.id === 'pmAmount')!;
    expect(param.min).toBe(-1);
    expect(param.max).toBe(1);
    expect(param.defaultValue).toBe(0);
  });

  it('fmAmount param: ±1 bipolar (negative inverts the modulator)', () => {
    const param = wavetableVcoDef.params.find((p) => p.id === 'fmAmount')!;
    expect(param.min).toBe(-1);
    expect(param.max).toBe(1);
    expect(param.defaultValue).toBe(0);
  });

  it('wavePos: cv input, paramTarget=wavePos (no cvScale — audio-rate sum, PASSTHROUGH)', () => {
    const port = wavetableVcoDef.inputs.find((p) => p.id === 'wavePos');
    expect(port!.type).toBe('cv');
    expect(port!.paramTarget).toBe('wavePos');
    // No cvScale by design — listed in PASSTHROUGH_BY_DESIGN in
    // cv-scale-registry.test.ts. The worklet sums wpKnob + wpCv per-sample.
    expect(port!.cvScale).toBeUndefined();
  });

  it('schemaVersion=3 (v1→v2 pmAmount migration; v2→v3 bipolar fm/pmAmount widen)', () => {
    expect(wavetableVcoDef.schemaVersion).toBe(3);
    expect(wavetableVcoDef.migrate).toBeDefined();
    const migrated = wavetableVcoDef.migrate!({ params: { tune: 0 } }, 1) as { params: Record<string, number> };
    expect(migrated.params.pmAmount).toBe(0);
    expect(migrated.params.tune).toBe(0);
    // v2 → v3 is a no-op: old [0..1] values are a legal subset of [-1..+1].
    const v2 = wavetableVcoDef.migrate!({ params: { fmAmount: 0.5, pmAmount: 0.25 } }, 2) as { params: Record<string, number> };
    expect(v2.params.fmAmount).toBe(0.5);
    expect(v2.params.pmAmount).toBe(0.25);
  });
});
