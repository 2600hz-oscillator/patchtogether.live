// packages/web/src/lib/docs/modules-manifest.test.ts
//
// Smoke tests for the auto-generated modules-manifest.ts. Catches drift
// between the registry source and the generator: every well-known audio
// module must produce a manifest entry with the expected shape, and the
// catalog must stay in lockstep with packages/web/src/lib/audio/modules/*.ts.

import { describe, it, expect } from 'vitest';
import { manifest } from './modules-manifest';

describe('docs modules manifest', () => {
  it('has at least 19 modules (the count at the time of /docs migration)', () => {
    expect(manifest.modules.length).toBeGreaterThanOrEqual(19);
    expect(manifest.moduleCount).toBe(manifest.modules.length);
  });

  it('every module has the required shape', () => {
    for (const m of manifest.modules) {
      expect(m.type, 'type').toBeTruthy();
      expect(m.label, `${m.type}.label`).toBeTruthy();
      expect(m.category, `${m.type}.category`).toBeTruthy();
      expect(typeof m.schemaVersion, `${m.type}.schemaVersion`).toBe('number');
      expect(m.description, `${m.type}.description`).toBeTruthy();
      expect(Array.isArray(m.inputs), `${m.type}.inputs`).toBe(true);
      expect(Array.isArray(m.outputs), `${m.type}.outputs`).toBe(true);
      expect(Array.isArray(m.params), `${m.type}.params`).toBe(true);
      expect(m.sourceUrl, `${m.type}.sourceUrl`).toMatch(
        /github\.com\/2600hz-oscillator\/patchtogether\.live/,
      );
    }
  });

  it('each port has id + type + note', () => {
    for (const m of manifest.modules) {
      for (const p of [...m.inputs, ...m.outputs]) {
        expect(p.id, `${m.type}.port.id`).toBeTruthy();
        expect(p.type, `${m.type}.${p.id}.type`).toBeTruthy();
        expect(p.note, `${m.type}.${p.id}.note`).toBeTruthy();
      }
    }
  });

  it('contains the canonical module catalog (sequencer, analogVco, audioOut, mixmstrs)', () => {
    const types = manifest.modules.map((m) => m.type);
    for (const t of ['sequencer', 'analogVco', 'audioOut', 'mixmstrs', 'timelorde']) {
      expect(types).toContain(t);
    }
  });

  it('sequencer has clock input + pitch & gate outputs', () => {
    const seq = manifest.modules.find((m) => m.type === 'sequencer');
    expect(seq).toBeDefined();
    if (!seq) return;
    expect(seq.inputs.find((p) => p.id === 'clock')).toBeDefined();
    expect(seq.outputs.find((p) => p.id === 'pitch')).toBeDefined();
    expect(seq.outputs.find((p) => p.id === 'gate')).toBeDefined();
  });

  it('mixmstrs is marked singleton (maxInstances=1) with master_volume param', () => {
    const m = manifest.modules.find((m) => m.type === 'mixmstrs');
    expect(m).toBeDefined();
    if (!m) return;
    expect(m.maxInstances).toBe(1);
    expect(m.params.find((p) => p.id === 'master_volume')).toBeDefined();
  });

  it('timelorde is marked singleton', () => {
    const t = manifest.modules.find((m) => m.type === 'timelorde');
    expect(t).toBeDefined();
    if (!t) return;
    expect(t.maxInstances).toBe(1);
  });

  it('reports zero parser warnings for the current registry', () => {
    expect(manifest.warnings).toEqual([]);
  });

  it('emits an ISO-8601 generatedAt timestamp', () => {
    expect(manifest.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('lists at least the four canonical categories', () => {
    for (const c of ['sources', 'modulation', 'effects', 'output']) {
      expect(manifest.categories).toContain(c);
    }
  });
});
