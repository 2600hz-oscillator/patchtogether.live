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
    expect(analogVcoDef.label).toBe('analog vco');
    expect(analogVcoDef.category).toBe('sources');
  });

  it('exposes inputs: pitch, fm, pm, sync (audio-rate) + tune/fine/fmAmount/pmAmount/shape (cv)', () => {
    const ids = analogVcoDef.inputs.map((p) => p.id).sort();
    expect(ids).toEqual(['fine', 'fm', 'fmAmount', 'pitch', 'pm', 'pmAmount', 'shape', 'sync', 'tune']);
  });

  it('exposes 6 output ports (saw, square, triangle, sine, morph, sync)', () => {
    const ids = analogVcoDef.outputs.map((p) => p.id).sort();
    expect(ids).toEqual(['morph', 'saw', 'sine', 'square', 'sync', 'triangle']);
  });

  it('sync input: audio-rate hard-sync input (no paramTarget)', () => {
    const port = analogVcoDef.inputs.find((p) => p.id === 'sync');
    expect(port).toBeDefined();
    expect(port!.type).toBe('audio');
    expect(port!.paramTarget).toBeUndefined();
  });

  it('sync output: audio-rate hard-sync pulse output', () => {
    const port = analogVcoDef.outputs.find((p) => p.id === 'sync');
    expect(port).toBeDefined();
    expect(port!.type).toBe('audio');
  });

  it('exposes 6 params (tune, fine, fmAmount, pmAmount, pw, shape)', () => {
    const ids = analogVcoDef.params.map((p) => p.id).sort();
    expect(ids).toEqual(['fine', 'fmAmount', 'pmAmount', 'pw', 'shape', 'tune']);
  });

  it('shape param: 0..1, default 0 (=saw, back-compat for the morph output)', () => {
    const param = analogVcoDef.params.find((p) => p.id === 'shape')!;
    expect(param.min).toBe(0);
    expect(param.max).toBe(1);
    expect(param.defaultValue).toBe(0);
  });

  it('shape CV input: paramTarget=shape, cvScale=linear', () => {
    const port = analogVcoDef.inputs.find((p) => p.id === 'shape');
    expect(port!.type).toBe('cv');
    expect(port!.paramTarget).toBe('shape');
    expect(port!.cvScale).toEqual({ mode: 'linear' });
  });

  it('morph output: audio-rate', () => {
    const port = analogVcoDef.outputs.find((p) => p.id === 'morph');
    expect(port!.type).toBe('audio');
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

  it('schemaVersion=5 with no migrate() (old-patch migrate logic removed — cleanup 2/5)', () => {
    expect(analogVcoDef.schemaVersion).toBe(5);
    // Per-module old-patch migrate() bodies were dropped; a fresh save stamps
    // the current version so no migrate ever fires for new patches.
    expect(analogVcoDef.migrate).toBeUndefined();
  });
});
