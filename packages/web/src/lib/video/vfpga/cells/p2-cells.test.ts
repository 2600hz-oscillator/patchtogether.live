// packages/web/src/lib/video/vfpga/cells/p2-cells.test.ts
//
// P2 cell-library breadth — placement + resource-accounting tests. The shared
// kernel<->metadata contract is asserted for EVERY cell by cells.test.ts (the
// glob-driven sweep); this file proves each P2 cell PLACES through place-and-route:
// the validation gate accepts a small fabric using it, fabricToEffect emits the
// expected pass plan (kernel frag, sampler bindings, knob uniforms), and the DSP
// cells count against the DSP budget. Pure (GL-free) — GLSL compile is asserted in
// the browser e2e (p2-cells.spec.ts) on a real renderer.

import { describe, expect, it } from 'vitest';
import { getCell, hasCell } from './index';
import { cellInputUniform } from './types';
import { fabricToEffect, validateFabric } from '$lib/video/vfpga/place-and-route';
import type { VfpgaFabric, VfpgaTile, VfpgaTileType } from '$lib/video/vfpga/types';

// ----------------------------------------------------------------------
// The full P2 cell set: (type, op, input-count) — the breadth this PR adds.
// ----------------------------------------------------------------------
const P2_CELLS: { type: VfpgaTileType; op: string; inputs: string[] }[] = [
  // CLB ops
  { type: 'clb', op: 'add', inputs: ['a', 'b'] },
  { type: 'clb', op: 'multiply', inputs: ['a', 'b'] },
  { type: 'clb', op: 'diff', inputs: ['a', 'b'] },
  { type: 'clb', op: 'invert', inputs: ['a'] },
  { type: 'clb', op: 'gain', inputs: ['a'] },
  { type: 'clb', op: 'select', inputs: ['a', 'b'] },
  { type: 'clb', op: 'luma', inputs: ['a'] },
  { type: 'clb', op: 'hsvShift', inputs: ['a'] },
  // DSP cells (the doc-named trio)
  { type: 'dsp', op: 'conv3x3', inputs: ['a'] },
  { type: 'dsp', op: 'mac', inputs: ['a', 'b'] },
  { type: 'dsp', op: 'quadDemod', inputs: ['i', 'q'] },
  // LUT16
  { type: 'lut16', op: 'lut', inputs: ['a', 'b', 'c', 'd'] },
];

/** A single-tile fabric placing `cell`, driving each input from a distinct host
 *  video-in (IIN1..IINn), and routing the tile to vout1. */
function oneTileFabric(type: VfpgaTileType, op: string, inputs: string[]): VfpgaFabric {
  const tile: VfpgaTile = { id: 't', type, config: { op }, inputs };
  const nets = inputs.map((inp, i) => ({ from: `IIN${i + 1}`, to: `t:${inp}` }));
  return {
    grid: { rows: 1, cols: 1 },
    tiles: [tile],
    nets,
    outputs: { vout1: 't' },
  };
}

describe('P2 cell library — registration', () => {
  it('every P2 cell is registered + round-trips by (type, op)', () => {
    for (const { type, op } of P2_CELLS) {
      expect(hasCell(type, op), `${type}:${op} registered`).toBe(true);
      const cell = getCell(type, op)!;
      expect(cell.type).toBe(type);
      expect(cell.op).toBe(op);
    }
  });

  it("each cell's declared inputs match the placement fixture", () => {
    for (const { type, op, inputs } of P2_CELLS) {
      expect(getCell(type, op)!.inputs).toEqual(inputs);
    }
  });
});

describe('P2 cell library — places through place-and-route', () => {
  describe.each(P2_CELLS)('$type:$op', ({ type, op, inputs }) => {
    const fabric = oneTileFabric(type, op, inputs);

    it('passes the §2.1 validation gate', () => {
      expect(validateFabric(fabric)).toEqual([]);
    });

    it('compiles to a single output pass with the cell kernel + uniforms', () => {
      const eff = fabricToEffect(fabric);
      expect(eff.passes).toHaveLength(1);
      const pass = eff.passes[0]!;
      expect(pass.target).toBe('output'); // the vout1 tile renders to the surface
      // the kernel string is the cell's kernel (same #version contract)
      const cell = getCell(type, op)!;
      const expectedFrag = cell.kernel({
        uTexFor: (i) => cellInputUniform(i),
        uniformFor: (k) => cell.knobs.find((kb) => kb.name === k)!.uniform,
      });
      expect(pass.frag).toBe(expectedFrag);
      // one sampler binding per input, sourced from its IINn → vinN
      expect(pass.inputs).toEqual(
        inputs.map((inp, i) => ({ source: `vin${i + 1}`, uniform: cellInputUniform(inp) })),
      );
      // P&R emits exactly the knob uniforms (or undefined for a knob-less cell).
      const knobUniforms = cell.knobs.map((k) => k.uniform);
      if (knobUniforms.length) expect(pass.uniforms).toEqual(knobUniforms);
      else expect(pass.uniforms).toBeUndefined();
    });
  });
});

describe('P2 DSP cells — resource accounting', () => {
  it('a dsp-cell tile counts against the DSP budget', () => {
    // two conv3x3 tiles, dsp budget 1 → over budget.
    const f: VfpgaFabric = {
      grid: { rows: 1, cols: 2 },
      tiles: [
        { id: 'c1', type: 'dsp', config: { op: 'conv3x3' }, inputs: ['a'] },
        { id: 'c2', type: 'dsp', config: { op: 'conv3x3' }, inputs: ['a'] },
      ],
      nets: [
        { from: 'IIN1', to: 'c1:a' },
        { from: 'IIN2', to: 'c2:a' },
      ],
      outputs: { vout1: 'c1', vout2: 'c2' },
      budget: { dsp: 1 },
    };
    expect(validateFabric(f).find((e) => /DSP budget exceeded: 2/.test(e.message))).toBeTruthy();
  });

  it('a CLB-cell tile does NOT count against the DSP budget', () => {
    // gain (clb) + a single conv3x3 (dsp): dsp count is 1, within budget 1.
    const f: VfpgaFabric = {
      grid: { rows: 1, cols: 2 },
      tiles: [
        { id: 'g', type: 'clb', config: { op: 'gain' }, inputs: ['a'] },
        { id: 'c', type: 'dsp', config: { op: 'conv3x3' }, inputs: ['a'] },
      ],
      nets: [
        { from: 'IIN1', to: 'g:a' },
        { from: 'g', to: 'c:a' },
      ],
      outputs: { vout1: 'c' },
      budget: { dsp: 1 },
    };
    expect(validateFabric(f)).toEqual([]);
  });
});

describe('P2 cells — multi-cell pass plan', () => {
  it('chains gain → conv3x3 → select(a, b) and orders the passes by dependency', () => {
    // IIN1 → gain ; IIN2 → (gain output and raw) ; build a small DAG:
    //   g = gain(IIN1) ; c = conv3x3(g) ; s = select(c, IIN2) → vout1
    const f: VfpgaFabric = {
      grid: { rows: 1, cols: 3 },
      // author OUT of topo order to prove the sort runs
      tiles: [
        { id: 's', type: 'clb', config: { op: 'select' }, inputs: ['a', 'b'] },
        { id: 'c', type: 'dsp', config: { op: 'conv3x3' }, inputs: ['a'] },
        { id: 'g', type: 'clb', config: { op: 'gain' }, inputs: ['a'] },
      ],
      nets: [
        { from: 'IIN1', to: 'g:a' },
        { from: 'g', to: 'c:a' },
        { from: 'c', to: 's:a' },
        { from: 'IIN2', to: 's:b' },
      ],
      outputs: { vout1: 's' },
    };
    expect(validateFabric(f)).toEqual([]);
    const eff = fabricToEffect(f);
    // producers before consumers; s (vout1) renders straight to 'output'.
    const order = eff.passes.map((p) => (p.target === 'output' ? 's' : p.target));
    expect(order).toEqual(['fbo_g', 'fbo_c', 's']);
    // conv3x3 samples gain's FBO; select samples conv3x3's FBO + vin2.
    const cPass = eff.passes.find((p) => p.target === 'fbo_c')!;
    expect(cPass.inputs).toEqual([{ source: 'fbo_g', uniform: cellInputUniform('a') }]);
    const sPass = eff.passes.find((p) => p.target === 'output')!;
    expect(sPass.inputs).toContainEqual({ source: 'fbo_c', uniform: cellInputUniform('a') });
    expect(sPass.inputs).toContainEqual({ source: 'vin2', uniform: cellInputUniform('b') });
  });

  it('a P2 cell legally participates in a register feedback loop (mac fed by reg:prev)', () => {
    // mac(IIN1, reg:prev) → reg ; mac → vout1. The :prev read cuts the comb loop.
    const f: VfpgaFabric = {
      grid: { rows: 1, cols: 2 },
      tiles: [
        { id: 'm', type: 'dsp', config: { op: 'mac' }, inputs: ['a', 'b'] },
        { id: 'r', type: 'reg', config: { op: 'reg' }, inputs: ['a'] },
      ],
      nets: [
        { from: 'IIN1', to: 'm:a' },
        { from: 'r:prev', to: 'm:b' },
        { from: 'm', to: 'r:a' },
      ],
      outputs: { vout1: 'm' },
    };
    expect(validateFabric(f)).toEqual([]);
    const eff = fabricToEffect(f);
    // mac reads the register's BACK buffer for input b (last frame).
    const mPass = eff.passes.find((p) => p.target === 'output')!;
    expect(mPass.inputs).toContainEqual({ source: 'fbo_r__b', uniform: cellInputUniform('b') });
    expect(eff.registers).toEqual([{ id: 'r', front: 'fbo_r__a', back: 'fbo_r__b' }]);
  });
});

describe('P2 cells — determinism', () => {
  it('every P2 cell compiles byte-identically across runs (VRT-safe)', () => {
    for (const { type, op, inputs } of P2_CELLS) {
      const f = oneTileFabric(type, op, inputs);
      expect(JSON.stringify(fabricToEffect(f))).toBe(JSON.stringify(fabricToEffect(f)));
    }
  });
});
