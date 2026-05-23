// packages/web/src/lib/audio/modules/slewswitch.test.ts
//
// Unit-test the SLEWSWITCH module-def shape. The worklet behavior is
// covered indirectly by the Atlantis-patch E2E (loads the patch, asserts
// audio out reaches the master bus) and by any future ART scenario.

import { describe, it, expect } from 'vitest';
import { slewSwitchDef } from './slewswitch';

describe('slewSwitchDef shape', () => {
  it('declares 4 cv inputs + step_clock + reset + 4 slew cv', () => {
    const ids = slewSwitchDef.inputs.map((p) => p.id).sort();
    expect(ids).toEqual([
      'in1', 'in2', 'in3', 'in4',
      'reset', 'slew1_cv', 'slew2_cv', 'slew3_cv', 'slew4_cv',
      'step_clock',
    ]);
  });

  it('declares 4 slewed outs + switched + step_idx + eoc', () => {
    const ids = slewSwitchDef.outputs.map((p) => p.id).sort();
    expect(ids).toEqual(['eoc', 'out1', 'out2', 'out3', 'out4', 'step_idx', 'switched']);
  });

  it('eoc is a gate, the slewed + switched outs are cv', () => {
    const eoc = slewSwitchDef.outputs.find((o) => o.id === 'eoc');
    expect(eoc?.type).toBe('gate');
    for (const id of ['out1', 'out2', 'out3', 'out4', 'switched', 'step_idx']) {
      expect(slewSwitchDef.outputs.find((o) => o.id === id)?.type).toBe('cv');
    }
  });

  it('step_clock + reset are gate-typed inputs', () => {
    expect(slewSwitchDef.inputs.find((p) => p.id === 'step_clock')?.type).toBe('gate');
    expect(slewSwitchDef.inputs.find((p) => p.id === 'reset')?.type).toBe('gate');
  });

  it('slew CV inputs each declare a log-curve paramTarget', () => {
    for (const k of ['slew1_cv', 'slew2_cv', 'slew3_cv', 'slew4_cv'] as const) {
      const p = slewSwitchDef.inputs.find((x) => x.id === k)!;
      expect(p.paramTarget).toBe(k.replace('_cv', ''));
      expect(p.cvScale?.mode).toBe('log');
    }
  });

  it('mode + length params are discrete', () => {
    expect(slewSwitchDef.params.find((p) => p.id === 'mode')?.curve).toBe('discrete');
    expect(slewSwitchDef.params.find((p) => p.id === 'length')?.curve).toBe('discrete');
  });
});
