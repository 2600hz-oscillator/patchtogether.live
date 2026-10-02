// EDGEFADER module-def contract (no GL) — the edges.test.ts shape pin for a
// two-input video crossfader. This file pins what the registries, the CV
// bridge and the face resolve from the def: identity, every port (the cv ports'
// paramTarget == id with a linear cvScale, the melt_gate LEVEL hold targeting
// the synthetic meltGate), the single video output, every param's range and
// default (threshold/thickness mirror EDGES), the face declaration, the
// noUserControl anchor, the docs' full coverage, EDGEFADER_DEFAULTS and the
// MELT toggle-OR-gate law. The pure transition law is pinned next door in
// edgefader-core.test.ts.
//
// What this file is structurally unable to see: the factory (it compiles four
// shaders and allocates FBOs, so it is never instantiated here — the real-GPU
// per-module-per-port sweep and edgefader.spec.ts own it, including the
// `read('cascade')` / `read('meltActive')` seams), the shell extension the
// face names (shell-extensions.test.ts enrols it), the registry entries that
// carry the module (module-manifest / strict-docs / strict-faces), and whether
// the bridge really writes `meltGate` (the e2e drives the jack).

import { describe, it, expect } from 'vitest';
import { edgefaderDef, EDGEFADER_DEFAULTS, edgefaderMeltActive } from './edgefader';
import { EDGES_DEFAULTS, EDGES_MAX_THICKNESS } from './edges';

const input = (id: string) => edgefaderDef.inputs.find((p) => p.id === id);
const param = (id: string) => edgefaderDef.params.find((p) => p.id === id);
const PARAM_IDS = edgefaderDef.params.map((p) => p.id);
const CV_PORTS = ['fader', 'threshold', 'thickness'] as const;

describe('edgefaderDef — identity', () => {
  it('is the video utility "edgefader"', () => {
    expect(edgefaderDef.type).toBe('edgefader');
    expect(edgefaderDef.label).toBe('edgefader');
    expect(edgefaderDef.domain).toBe('video');
    expect(edgefaderDef.palette).toEqual({ top: 'Video modules', sub: 'Utilities' });
    expect(edgefaderDef.category).toBe('utilities');
  });
});

describe('edgefaderDef — ports', () => {
  it('declares exactly in_a, in_b, three cv ports and the melt gate, in that order', () => {
    expect(edgefaderDef.inputs.map((p) => p.id)).toEqual(['in_a', 'in_b', 'fader', 'threshold', 'thickness', 'melt_gate']);
  });

  it('in_a and in_b are video inputs', () => {
    expect(input('in_a')?.type).toBe('video');
    expect(input('in_b')?.type).toBe('video');
    expect(input('in_a')?.paramTarget).toBeUndefined();
    expect(input('in_b')?.paramTarget).toBeUndefined();
  });

  it('every cv port targets the param of the same id with a linear cvScale (the cross-domain bridge routes by port id)', () => {
    for (const id of CV_PORTS) {
      const p = input(id);
      expect(p?.type, `${id} is cv`).toBe('cv');
      expect(p?.paramTarget, `${id} targets itself`).toBe(id);
      expect(p?.cvScale, `${id} is linear-scaled`).toEqual({ mode: 'linear' });
      expect(PARAM_IDS, `${id} names a declared param`).toContain(p?.paramTarget);
    }
  });

  it('melt_gate is a gate port with edge "gate" (a LEVEL hold) targeting the synthetic meltGate param, with no cvScale', () => {
    const g = input('melt_gate');
    expect(g?.type).toBe('gate');
    expect(g?.edge).toBe('gate');
    expect(g?.paramTarget).toBe('meltGate');
    expect(g?.cvScale).toBeUndefined();
    expect(PARAM_IDS).toContain('meltGate');
  });

  it('every paramTarget on the def names a declared param, and no two ports share one', () => {
    const targets = edgefaderDef.inputs.map((p) => p.paramTarget).filter((t): t is string => typeof t === 'string');
    for (const t of targets) expect(PARAM_IDS, `target ${t}`).toContain(t);
    expect(new Set(targets).size).toBe(targets.length);
  });

  it('has the single video output "out"', () => {
    expect(edgefaderDef.outputs).toEqual([{ id: 'out', type: 'video' }]);
  });
});

describe('edgefaderDef — params', () => {
  it('declares fader, threshold, thickness, melt, meltGate in that order', () => {
    expect(PARAM_IDS).toEqual(['fader', 'threshold', 'thickness', 'melt', 'meltGate']);
  });

  it('fader spans 0..1 linear, resting at 0.5 (a bipolar CV sweeps the whole travel, the FADER precedent)', () => {
    const f = param('fader');
    expect(f?.min).toBe(0);
    expect(f?.max).toBe(1);
    expect(f?.defaultValue).toBe(0.5);
    expect(f?.curve).toBe('linear');
    expect(f?.units).toBeUndefined();
    expect(f?.label).toBe('A/B');
  });

  it('threshold spans 0..1 linear and mirrors EDGES_DEFAULTS (0.2)', () => {
    const t = param('threshold');
    expect(t?.min).toBe(0);
    expect(t?.max).toBe(1);
    expect(t?.curve).toBe('linear');
    expect(t?.defaultValue).toBe(0.2);
    expect(t?.defaultValue).toBe(EDGES_DEFAULTS.threshold);
    expect(t?.units).toBeUndefined();
  });

  it('thickness spans 1..EDGES_MAX_THICKNESS px linear and mirrors EDGES_DEFAULTS (2)', () => {
    const w = param('thickness');
    expect(w?.min).toBe(1);
    expect(w?.max).toBe(EDGES_MAX_THICKNESS);
    expect(w?.max).toBe(8);
    expect(w?.curve).toBe('linear');
    expect(w?.units).toBe('px');
    expect(w?.defaultValue).toBe(2);
    expect(w?.defaultValue).toBe(EDGES_DEFAULTS.thickness);
  });

  it('melt is a 0/1 discrete latching toggle, off by default', () => {
    const m = param('melt');
    expect(m?.min).toBe(0);
    expect(m?.max).toBe(1);
    expect(m?.defaultValue).toBe(0);
    expect(m?.curve).toBe('discrete');
    expect(m?.units).toBeUndefined();
  });

  it('meltGate is the 0..1 linear landing pad for the gate level, 0 by default', () => {
    const g = param('meltGate');
    expect(g?.min).toBe(0);
    expect(g?.max).toBe(1);
    expect(g?.defaultValue).toBe(0);
    expect(g?.curve).toBe('linear');
    expect(g?.units).toBeUndefined();
  });

  it('every param\'s defaultValue is EDGEFADER_DEFAULTS[id] and lies inside its range', () => {
    for (const p of edgefaderDef.params) {
      expect(p.defaultValue, p.id).toBe(EDGEFADER_DEFAULTS[p.id as keyof typeof EDGEFADER_DEFAULTS]);
      expect(p.defaultValue, `${p.id} ≥ min`).toBeGreaterThanOrEqual(p.min);
      expect(p.defaultValue, `${p.id} ≤ max`).toBeLessThanOrEqual(p.max);
      expect(p.label.length, `${p.id} has a label`).toBeGreaterThan(0);
    }
  });

  it('EDGEFADER_DEFAULTS is exactly the five documented values', () => {
    expect(EDGEFADER_DEFAULTS).toEqual({
      fader: 0.5,
      threshold: EDGES_DEFAULTS.threshold,
      thickness: EDGES_DEFAULTS.thickness,
      melt: 0,
      meltGate: 0,
    });
  });
});

describe('edgefaderDef — face', () => {
  const face = edgefaderDef.face;

  it('orders fader, melt, threshold, thickness in one band (no pages)', () => {
    expect(face?.order).toEqual(['fader', 'melt', 'threshold', 'thickness']);
    expect(face?.pages).toBeUndefined();
  });

  it('every ordered id is a declared param and the synthetic meltGate is NOT on the face', () => {
    for (const id of face?.order ?? []) expect(PARAM_IDS, id).toContain(id);
    expect(face?.order).not.toContain('meltGate');
  });

  it('declares FADERS for the three continuous params and leaves melt to infer a toggle', () => {
    expect(face?.paramCells).toEqual({ fader: 'fader', threshold: 'fader', thickness: 'fader' });
    for (const id of Object.keys(face?.paramCells ?? {})) expect(PARAM_IDS, id).toContain(id);
  });

  it('glyph is "none" (a video def has no audio out to meter) and the dock body arrives through the "edgefader" extension', () => {
    expect(face?.glyph).toBe('none');
    expect(face?.extension).toBe('edgefader');
  });
});

describe('edgefaderDef — noUserControl', () => {
  it('names meltGate alone, written by the cv-port, with a stated reason', () => {
    expect(edgefaderDef.noUserControl).toHaveLength(1);
    const entry = edgefaderDef.noUserControl?.[0];
    expect(entry?.param).toBe('meltGate');
    expect(entry?.writer).toBe('cv-port');
    expect(entry?.why.length ?? 0).toBeGreaterThan(40);
  });

  it('is anchored both ways: a declared input targets meltGate, and meltGate is a declared param absent from the face', () => {
    const writers = edgefaderDef.inputs.filter((p) => p.paramTarget === 'meltGate');
    expect(writers.map((p) => p.id)).toEqual(['melt_gate']);
    expect(PARAM_IDS).toContain('meltGate');
    expect(edgefaderDef.face?.order).not.toContain('meltGate');
  });
});

describe('edgefaderDef — docs', () => {
  const docs = edgefaderDef.docs;

  it('carries an explanation that names the law: edges, five bands, the cascade, inside/outside, blur and melt', () => {
    const explanation = docs?.explanation ?? '';
    expect(explanation.length).toBeGreaterThan(400);
    for (const word of ['edge', 'five', 'band', 'half done', 'inside', 'blur', 'melt', 'exact']) {
      expect(explanation.toLowerCase(), word).toContain(word);
    }
  });

  it('names the revised law: the three-quarter unit part of each band, and the inside/outside ripple anchored on A\'s edges', () => {
    const explanation = docs?.explanation ?? '';
    expect(explanation).toContain('three quarters');
    expect(explanation).toContain("A's edges");
    expect(explanation).toContain('bottom quarter');
  });

  it('documents EVERY input, and nothing that is not an input', () => {
    const ids = edgefaderDef.inputs.map((p) => p.id);
    for (const id of ids) expect(docs?.inputs?.[id]?.length ?? 0, id).toBeGreaterThan(30);
    expect(Object.keys(docs?.inputs ?? {}).sort()).toEqual([...ids].sort());
  });

  it('documents EVERY output', () => {
    const ids = edgefaderDef.outputs.map((p) => p.id);
    for (const id of ids) expect(docs?.outputs?.[id]?.length ?? 0, id).toBeGreaterThan(30);
    expect(Object.keys(docs?.outputs ?? {}).sort()).toEqual([...ids].sort());
  });

  it('documents EVERY param as a control, including the hidden meltGate', () => {
    for (const id of PARAM_IDS) expect(docs?.controls?.[id]?.length ?? 0, id).toBeGreaterThan(30);
    expect(Object.keys(docs?.controls ?? {}).sort()).toEqual([...PARAM_IDS].sort());
  });

  it('the melt_gate doc speaks gate vocabulary (WHILE / HELD / HIGH) and names the OR with the toggle', () => {
    const d = docs?.inputs?.melt_gate ?? '';
    for (const word of ['WHILE', 'HELD', 'HIGH']) expect(d, word).toContain(word);
    expect(d.toLowerCase()).toContain('toggle');
    expect(d.toLowerCase()).toContain('or');
  });

  it('the meltGate control doc says it is hidden, level-written, and OR-combined with MELT', () => {
    const d = docs?.controls?.meltGate ?? '';
    expect(d.toLowerCase()).toContain('hidden');
    expect(d).toContain('HIGH');
    expect(d.toLowerCase()).toContain('toggle');
  });

  it('the fader docs state the exact endpoints and the resting-picture cascade', () => {
    expect(docs?.controls?.fader).toContain('0 shows only IN A');
    expect(docs?.controls?.fader).toContain('1 shows only IN B');
    expect(docs?.outputs?.out).toContain('exactly IN A with the fader at 0');
    expect(docs?.outputs?.out).toContain('exactly IN B at 1');
  });
});

describe('edgefaderMeltActive — the toggle OR the held gate', () => {
  it('toggle only → melt', () => {
    expect(edgefaderMeltActive({ melt: 1, meltGate: 0 })).toBe(true);
  });
  it('gate only → melt', () => {
    expect(edgefaderMeltActive({ melt: 0, meltGate: 1 })).toBe(true);
  });
  it('both → melt', () => {
    expect(edgefaderMeltActive({ melt: 1, meltGate: 1 })).toBe(true);
  });
  it('neither → blur', () => {
    expect(edgefaderMeltActive({ melt: 0, meltGate: 0 })).toBe(false);
    expect(edgefaderMeltActive(EDGEFADER_DEFAULTS)).toBe(false);
  });
  it('the threshold is exactly 0.5 on both inputs (≥ 0.5 is on)', () => {
    expect(edgefaderMeltActive({ melt: 0.5, meltGate: 0 })).toBe(true);
    expect(edgefaderMeltActive({ melt: 0, meltGate: 0.5 })).toBe(true);
    expect(edgefaderMeltActive({ melt: 0.49999, meltGate: 0 })).toBe(false);
    expect(edgefaderMeltActive({ melt: 0, meltGate: 0.49999 })).toBe(false);
    expect(edgefaderMeltActive({ melt: 0.3, meltGate: 0.3 }), 'two sub-threshold levels do not add up').toBe(false);
  });
});
