// packages/web/src/lib/docs/doc-index.test.ts
//
// Contract for buildDocIndex — the flat, client-resolvable doc payload the
// interactive virtual-module page indexes by control key / port id. The core
// guarantee the interactive page leans on is the CV→param DUAL link: a CV input
// (adsr `attack`) carries its target param's name + authored desc so the hover
// pane can show "modulates Attack — {how the Attack fader behaves}".

import { describe, it, expect } from 'vitest';
import { buildDocIndex } from './doc-index';
import { buildModuleManifest, type ManifestModule } from './module-manifest';

function modByType(type: string): ManifestModule {
  const m = buildModuleManifest().modules.find((x) => x.type === type);
  if (!m) throw new Error(`module ${type} not in manifest`);
  return m;
}

describe('buildDocIndex — adsr (the CV/control overlap demo)', () => {
  const index = buildDocIndex(modByType('adsr'));

  it('has an `attack` faceplate control with name, range, and authored desc', () => {
    const attack = index.controls.attack;
    expect(attack).toBeDefined();
    expect(attack.kind).toBe('param');
    // Friendly name comes from the ParamDef label (adsr labels the param "A").
    expect(attack.name).toBe('A');
    // Range is the numeric span from the def.
    expect(attack.range).toContain('0.001');
    expect(attack.range).toContain('10');
    // Authored prose is carried through from docs.controls.attack.
    expect(attack.desc).toBeTruthy();
    expect(attack.desc).toMatch(/rise/i);
  });

  it('has an `attack` CV INPUT whose paramTarget resolves to the attack control', () => {
    const attackIn = index.inputs.attack;
    expect(attackIn).toBeDefined();
    expect(attackIn.cable).toBe('cv');
    // The dual link: the CV jack knows it modulates the `attack` param, and
    // carries that control's name + authored desc for the pane's dual context.
    expect(attackIn.paramTarget).toBeDefined();
    expect(attackIn.paramTarget!.id).toBe('attack');
    expect(attackIn.paramTarget!.name).toBe('A');
    // The dual desc is the SAME authored control prose (drift-gated, one source).
    expect(attackIn.paramTarget!.desc).toBe(index.controls.attack.desc);
    expect(attackIn.paramTarget!.desc).toBeTruthy();
  });

  it('carries the gate input with its authored prose and gate cable', () => {
    const gate = index.inputs.gate;
    expect(gate).toBeDefined();
    expect(gate.cable).toBe('gate');
    expect(gate.desc).toMatch(/gate/i);
    // A pure gate input is NOT a param-CV, so no dual link.
    expect(gate.paramTarget).toBeUndefined();
  });

  it('exposes outputs (env, env_inv) with authored prose', () => {
    expect(index.outputs.env).toBeDefined();
    expect(index.outputs.env.cable).toBe('cv');
    expect(index.outputs.env.desc).toMatch(/envelope/i);
    expect(index.outputs.env_inv).toBeDefined();
    expect(index.outputs.env_inv.desc).toMatch(/invert/i);
  });

  it('carries the module explanation as the pane default state', () => {
    expect(index.explanation).toBeTruthy();
    expect(index.explanation).toMatch(/envelope/i);
  });
});

describe('buildDocIndex — sequencer (control families + transport CV)', () => {
  const index = buildDocIndex(modByType('sequencer'));

  it('has the bpm param control with authored prose', () => {
    expect(index.controls.bpm).toBeDefined();
    expect(index.controls.bpm.name).toBe('BPM');
    expect(index.controls.bpm.desc).toMatch(/tempo/i);
  });

  it('keeps the step-grid control FAMILY template entry', () => {
    const fam = index.controls['seq-gate-{n}'];
    expect(fam).toBeDefined();
    expect(fam.kind).toBe('family');
    expect(fam.desc).toBeTruthy();
  });

  it('has the clock input + pitch/gate/clock outputs', () => {
    expect(index.inputs.clock).toBeDefined();
    expect(index.inputs.clock.cable).toBe('gate');
    expect(index.outputs.pitch).toBeDefined();
    expect(index.outputs.gate).toBeDefined();
    expect(index.outputs.clock).toBeDefined();
  });
});
