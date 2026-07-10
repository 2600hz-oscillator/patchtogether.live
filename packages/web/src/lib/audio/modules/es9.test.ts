// Def-shape + class-mapping tests for the ES-9 native-bridge module. The
// transport halves have their own suites (dsp: es9-bridge-core.test.ts;
// web: $lib/audio/es9/es9-transport.test.ts).

import { describe, expect, it } from 'vitest';
import {
  ES9_CLASS_AUDIO,
  ES9_CLASS_CV,
  ES9_CLASS_GATE,
  ES9_CLASS_PITCH,
  es9ClassesFromParams,
  es9Def,
  es9OutputModes,
} from './es9';

describe('es9 def shape', () => {
  it('declares the full jack complement: 16 inputs, 30 outputs', () => {
    expect(es9Def.inputs).toHaveLength(16);   // out1-8 + mix9-16
    expect(es9Def.outputs).toHaveLength(30);  // in1-14 + spdif L/R + 14 cv twins
    const ids = [...es9Def.inputs, ...es9Def.outputs].map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('hardware-output jacks accept the CV family; mixer buses stay audio-only', () => {
    for (let n = 1; n <= 8; n++) {
      const p = es9Def.inputs.find((x) => x.id === `out${n}`);
      expect(p?.type).toBe('audio');
      expect(p?.accepts).toEqual(['cv', 'pitch', 'gate']);
    }
    for (let n = 9; n <= 16; n++) {
      const p = es9Def.inputs.find((x) => x.id === `mix${n}`);
      expect(p?.type).toBe('audio');
      expect(p?.accepts).toBeUndefined();
    }
  });

  it('every DC input jack has a raw audio port and a cv twin; S/PDIF has no twin', () => {
    for (let n = 1; n <= 14; n++) {
      expect(es9Def.outputs.find((p) => p.id === `in${n}`)?.type).toBe('audio');
      expect(es9Def.outputs.find((p) => p.id === `in${n}_cv`)?.type).toBe('cv');
    }
    expect(es9Def.outputs.find((p) => p.id === 'spdif_l')?.type).toBe('audio');
    expect(es9Def.outputs.find((p) => p.id === 'spdif_r')?.type).toBe('audio');
    expect(es9Def.outputs.find((p) => p.id === 'spdif_l_cv')).toBeUndefined();
  });

  it('declares 22 discrete class params with the right defaults', () => {
    expect(es9Def.params).toHaveLength(22);
    for (const p of es9Def.params) {
      expect(p.curve).toBe('discrete');
      expect(p.min).toBe(0);
      expect(p.max).toBe(3);
    }
    // Input twins default to cv (the modular-native case), output jacks to
    // audio (bit-transparent).
    expect(es9Def.params.find((p) => p.id === 'in3_class')?.defaultValue).toBe(ES9_CLASS_CV);
    expect(es9Def.params.find((p) => p.id === 'out3_class')?.defaultValue).toBe(ES9_CLASS_AUDIO);
  });

  it('is a singleton with palette + docs coverage for every port and control', () => {
    expect(es9Def.maxInstances).toBe(1);
    expect(es9Def.palette).toBeDefined();
    for (const p of es9Def.inputs) expect(es9Def.docs?.inputs?.[p.id], p.id).toBeTruthy();
    for (const p of es9Def.outputs) expect(es9Def.docs?.outputs?.[p.id], p.id).toBeTruthy();
    for (const p of es9Def.params) expect(es9Def.docs?.controls?.[p.id], p.id).toBeTruthy();
  });
});

describe('class mapping helpers', () => {
  it('defaults: inputs cv, outputs audio, non-jack channels audio', () => {
    const { inClasses, outClasses } = es9ClassesFromParams(undefined);
    for (let c = 0; c < 14; c++) expect(inClasses[c]).toBe(ES9_CLASS_CV);
    expect(inClasses[14]).toBe(ES9_CLASS_AUDIO);   // S/PDIF L
    expect(inClasses[15]).toBe(ES9_CLASS_AUDIO);   // S/PDIF R
    for (let c = 0; c < 16; c++) expect(outClasses[c]).toBe(ES9_CLASS_AUDIO);
  });

  it('reads per-jack overrides from params (1-based jack → 0-based channel)', () => {
    const { inClasses, outClasses } = es9ClassesFromParams({
      in1_class: ES9_CLASS_PITCH,
      in14_class: ES9_CLASS_GATE,
      out8_class: ES9_CLASS_CV,
    });
    expect(inClasses[0]).toBe(ES9_CLASS_PITCH);
    expect(inClasses[13]).toBe(ES9_CLASS_GATE);
    expect(outClasses[7]).toBe(ES9_CLASS_CV);
  });

  it('derives bridge hold/fade modes: audio fades, everything CV-ish holds', () => {
    const modes = es9OutputModes({
      out1_class: ES9_CLASS_CV,
      out2_class: ES9_CLASS_PITCH,
      out3_class: ES9_CLASS_GATE,
      out4_class: ES9_CLASS_AUDIO,
    });
    expect(modes['0']).toBe('cv');
    expect(modes['1']).toBe('cv');
    expect(modes['2']).toBe('cv');
    expect(modes['3']).toBe('audio');
    expect(modes['8']).toBe('audio');   // mixer buses are always audio
  });
});
