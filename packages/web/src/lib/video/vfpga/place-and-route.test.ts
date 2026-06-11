// packages/web/src/lib/video/vfpga/place-and-route.test.ts
//
// Pure (GL-free) unit tests for the fabric place-and-route core. Mirrors the
// b3ntb0x-dsp discipline: the load-bearing compile logic (topo order, comb-loop
// reject, :prev loop-cut, FBO assignment/precision/ping-pong, pass emission,
// budget enforcement) is exercised in jsdom with NO WebGL.

import { describe, expect, it } from 'vitest';
import {
  fabricToEffect,
  validateFabric,
  FabricCompileError,
  type FabricError,
} from './place-and-route';
import type { VfpgaFabric, VfpgaTile, VfpgaNet } from './types';

// ----------------------------------------------------------------------
// Fixtures.
// ----------------------------------------------------------------------

const clb = (id: string, op: string, inputs?: string[], extra?: Partial<VfpgaTile>): VfpgaTile => ({
  id,
  type: 'clb',
  config: { op },
  ...(inputs ? { inputs } : {}),
  ...extra,
});

/** Minimal valid 1-tile passthru fabric (the P&R smoke fixture). */
function passthruFabric(): VfpgaFabric {
  return {
    grid: { rows: 1, cols: 1 },
    tiles: [clb('p', 'passthru', ['a'])],
    nets: [{ from: 'IIN1', to: 'p:a' }],
    outputs: { vout1: 'p' },
  };
}

/** A 2-stage chain: mix(a,b) → threshold → out (forces a topo order). */
function chainFabric(): VfpgaFabric {
  return {
    grid: { rows: 1, cols: 3 },
    tiles: [
      clb('m', 'mix', ['a', 'b']),
      clb('th', 'threshold', ['a']),
    ],
    nets: [
      { from: 'IIN1', to: 'm:a' },
      { from: 'IIN2', to: 'm:b' },
      { from: 'm', to: 'th:a' }, // th reads m's this-frame output
    ],
    outputs: { vout1: 'th' },
  };
}

const findError = (errs: FabricError[], re: RegExp) => errs.find((e) => re.test(e.message));

// ----------------------------------------------------------------------
// validateFabric.
// ----------------------------------------------------------------------

describe('validateFabric', () => {
  it('accepts a minimal 1-tile passthru fabric', () => {
    expect(validateFabric(passthruFabric())).toEqual([]);
  });

  it('accepts a valid 2-stage chain', () => {
    expect(validateFabric(chainFabric())).toEqual([]);
  });

  it('rejects duplicate tile ids', () => {
    const f = passthruFabric();
    f.tiles.push(clb('p', 'threshold', ['a']));
    expect(findError(validateFabric(f), /duplicate tile id "p"/)).toBeTruthy();
  });

  it('rejects an unknown cell (type, op)', () => {
    const f = passthruFabric();
    f.tiles[0]!.config.op = 'nope';
    expect(findError(validateFabric(f), /unknown cell clb:"nope"/)).toBeTruthy();
  });

  it('rejects a tile type with no P0 cell (e.g. dsp)', () => {
    const f = passthruFabric();
    f.tiles[0] = { id: 'p', type: 'dsp', config: { op: 'conv3x3' }, inputs: ['a'] };
    expect(findError(validateFabric(f), /unknown cell dsp:"conv3x3"/)).toBeTruthy();
  });

  it('rejects a net.from referencing an unknown tile', () => {
    const f = passthruFabric();
    f.nets[0] = { from: 'ghost', to: 'p:a' };
    expect(findError(validateFabric(f), /references unknown tile/)).toBeTruthy();
  });

  it('rejects a net.to referencing an unknown tile', () => {
    const f = passthruFabric();
    f.nets.push({ from: 'IIN2', to: 'ghost:a' });
    expect(findError(validateFabric(f), /to "ghost:a" references unknown tile/)).toBeTruthy();
  });

  it('rejects a net.to targeting an input the cell does not read', () => {
    const f = passthruFabric();
    f.nets.push({ from: 'IIN2', to: 'p:zzz' });
    expect(findError(validateFabric(f), /input "zzz" the cell does not read/)).toBeTruthy();
  });

  it('rejects a net.to missing an :input name', () => {
    const f = passthruFabric();
    f.nets[0] = { from: 'IIN1', to: 'p' };
    expect(findError(validateFabric(f), /missing an :<inputName>/)).toBeTruthy();
  });

  it('rejects an iob_in tile with a non-host port op', () => {
    const f = passthruFabric();
    f.tiles.push({ id: 'badio', type: 'iob_in', config: { op: 'XIN9' } });
    expect(findError(validateFabric(f), /is not a host IOB-in port/)).toBeTruthy();
  });

  it('rejects an iob_out tile with a non-host port op', () => {
    const f = passthruFabric();
    f.tiles.push({ id: 'badout', type: 'iob_out', config: { op: 'OUT9' } });
    expect(findError(validateFabric(f), /is not a host IOB-out port/)).toBeTruthy();
  });

  it('rejects outputs.vout1 that resolves to nothing', () => {
    const f = passthruFabric();
    f.outputs.vout1 = 'ghost';
    expect(findError(validateFabric(f), /outputs.vout1 "ghost" resolves to no tile/)).toBeTruthy();
  });

  it('rejects a :prev read of a non-register tile', () => {
    const f = chainFabric();
    f.nets.push({ from: 'm:prev', to: 'th:a' });
    expect(findError(validateFabric(f), /uses ":prev" but tile "m" is type "clb"/)).toBeTruthy();
  });

  describe('budget enforcement', () => {
    it('rejects over the pass budget', () => {
      const f = chainFabric();
      f.budget = { passes: 1 }; // chain has 2 compute tiles
      expect(findError(validateFabric(f), /pass budget exceeded: 2 passes > budget 1/)).toBeTruthy();
    });

    it('accepts at the pass budget', () => {
      const f = chainFabric();
      f.budget = { passes: 2 };
      expect(validateFabric(f)).toEqual([]);
    });

    it('rejects over the dsp budget', () => {
      const f = passthruFabric();
      // a reg tile so the comb-graph stays valid; add 2 dsp tiles unwired
      f.tiles.push({ id: 'd1', type: 'dsp', config: { op: 'mac' }, inputs: ['a'] });
      f.tiles.push({ id: 'd2', type: 'dsp', config: { op: 'mac' }, inputs: ['a'] });
      f.budget = { dsp: 1 };
      // (the dsp cells are unknown in P0 — both an unknown-cell AND budget error;
      //  assert the budget one specifically)
      expect(findError(validateFabric(f), /DSP budget exceeded: 2 dsp tiles > budget 1/)).toBeTruthy();
    });

    it('rejects over the bramRows budget', () => {
      const f = passthruFabric();
      f.tiles.push({ id: 'lb', type: 'bram', config: { op: 'linebuf', rows: 64 }, inputs: ['a'] });
      f.budget = { bramRows: 32 };
      expect(findError(validateFabric(f), /BRAM-rows budget exceeded: 64 rows > budget 32/)).toBeTruthy();
    });
  });
});

// ----------------------------------------------------------------------
// Combinational-loop rejection vs. :prev loop-cut.
// ----------------------------------------------------------------------

describe('combinational cycle handling', () => {
  it('REJECTS a pure combinational cycle (a→b→a, no register)', () => {
    const f: VfpgaFabric = {
      grid: { rows: 1, cols: 2 },
      tiles: [clb('a', 'passthru', ['a']), clb('b', 'passthru', ['a'])],
      nets: [
        { from: 'a', to: 'b:a' },
        { from: 'b', to: 'a:a' }, // closes the comb loop
      ],
      outputs: { vout1: 'a' },
    };
    const errs = validateFabric(f);
    expect(findError(errs, /combinational cycle/)).toBeTruthy();
    expect(() => fabricToEffect(f)).toThrow(FabricCompileError);
  });

  it('ACCEPTS a feedback loop cut by a :prev register read', () => {
    // mix(input, reg:prev) → reg ; reg holds last frame → no comb cycle.
    const f: VfpgaFabric = {
      grid: { rows: 1, cols: 2 },
      tiles: [
        clb('fb', 'mix', ['a', 'b']),
        { id: 'r', type: 'reg', config: { op: 'reg' }, inputs: ['a'] },
      ],
      nets: [
        { from: 'IIN1', to: 'fb:a' },
        { from: 'r:prev', to: 'fb:b' }, // CLOCKED read of last frame → cuts the loop
        { from: 'fb', to: 'r:a' }, // reg captures this frame
      ],
      outputs: { vout1: 'fb' },
    };
    expect(validateFabric(f)).toEqual([]);
    expect(() => fabricToEffect(f)).not.toThrow();
  });

  it('a NON-:prev read of a reg that closes a cycle is still a comb loop', () => {
    const f: VfpgaFabric = {
      grid: { rows: 1, cols: 2 },
      tiles: [
        clb('fb', 'mix', ['a', 'b']),
        { id: 'r', type: 'reg', config: { op: 'reg' }, inputs: ['a'] },
      ],
      nets: [
        { from: 'IIN1', to: 'fb:a' },
        { from: 'r', to: 'fb:b' }, // NOT :prev → this-frame read → comb cycle
        { from: 'fb', to: 'r:a' },
      ],
      outputs: { vout1: 'fb' },
    };
    expect(findError(validateFabric(f), /combinational cycle/)).toBeTruthy();
  });
});

// ----------------------------------------------------------------------
// fabricToEffect — topo order, FBO assignment, pass emission.
// ----------------------------------------------------------------------

describe('fabricToEffect', () => {
  it('compiles the 1-tile passthru fabric to a single output pass', () => {
    const eff = fabricToEffect(passthruFabric());
    expect(eff.passes).toHaveLength(1);
    expect(eff.outputs).toEqual({ vout1: 'output' });
    const pass = eff.passes[0]!;
    expect(pass.target).toBe('output'); // vout1 tile renders straight to surface
    // its single input `a` samples the host video-in IIN1 → vin1
    expect(pass.inputs).toEqual([{ source: 'vin1', uniform: 'uTex_a' }]);
    // passthru has no knobs → no uniforms
    expect(pass.uniforms).toBeUndefined();
    // the vout1 tile's own FBO is dropped (it writes the surface 'output')
    expect(eff.fbos).toBeUndefined();
  });

  it('throws FabricCompileError (not a bare Error) on an invalid fabric', () => {
    const f = passthruFabric();
    f.tiles[0]!.config.op = 'nope';
    let thrown: unknown;
    try {
      fabricToEffect(f);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(FabricCompileError);
    expect((thrown as FabricCompileError).errors.length).toBeGreaterThan(0);
  });

  it('orders passes so a consumer comes AFTER its producer (combinational order)', () => {
    // Author tiles deliberately OUT of order: threshold first, mix second.
    const f: VfpgaFabric = {
      grid: { rows: 1, cols: 2 },
      tiles: [clb('th', 'threshold', ['a']), clb('m', 'mix', ['a', 'b'])],
      nets: [
        { from: 'IIN1', to: 'm:a' },
        { from: 'IIN2', to: 'm:b' },
        { from: 'm', to: 'th:a' }, // th depends on m
      ],
      outputs: { vout1: 'th' },
    };
    const eff = fabricToEffect(f);
    const order = eff.passes.map((p) => (p.target === 'output' ? 'th' : p.target));
    // m must be emitted before th (th = output target)
    expect(order).toEqual(['fbo_m', 'th']);
  });

  it('routes a producer pass into its own FBO + binds it as the consumer sampler', () => {
    const eff = fabricToEffect(chainFabric());
    // producer = mix → fbo_m ; consumer = threshold → output, samples fbo_m
    const mixPass = eff.passes.find((p) => p.target === 'fbo_m')!;
    expect(mixPass).toBeTruthy();
    expect(eff.fbos).toContainEqual({ id: 'fbo_m', kind: 'rgba8' });
    const thPass = eff.passes.find((p) => p.target === 'output')!;
    expect(thPass.inputs).toEqual([{ source: 'fbo_m', uniform: 'uTex_a' }]);
    // threshold's `level` knob → uThreshold uniform emitted
    expect(thPass.uniforms).toEqual(['uThreshold']);
  });

  it('assigns a float FBO when a tile declares config.kind = "float"', () => {
    const f = chainFabric();
    f.tiles[0]!.config.kind = 'float'; // mix tile float
    const eff = fabricToEffect(f);
    expect(eff.fbos).toContainEqual({ id: 'fbo_m', kind: 'float' });
  });

  it('assigns a register tile a ping-pong FBO PAIR (front/back)', () => {
    const f: VfpgaFabric = {
      grid: { rows: 1, cols: 2 },
      tiles: [
        clb('fb', 'mix', ['a', 'b']),
        { id: 'r', type: 'reg', config: { op: 'reg' }, inputs: ['a'] },
      ],
      nets: [
        { from: 'IIN1', to: 'fb:a' },
        { from: 'r:prev', to: 'fb:b' },
        { from: 'fb', to: 'r:a' },
      ],
      outputs: { vout1: 'fb' },
    };
    const eff = fabricToEffect(f);
    const ids = (eff.fbos ?? []).map((x) => x.id);
    expect(ids).toContain('fbo_r__a'); // front (this-frame write)
    expect(ids).toContain('fbo_r__b'); // back (the :prev read of last frame)
  });

  it('routes a :prev read to the register back buffer', () => {
    const f: VfpgaFabric = {
      grid: { rows: 1, cols: 2 },
      tiles: [
        clb('fb', 'mix', ['a', 'b']),
        { id: 'r', type: 'reg', config: { op: 'reg' }, inputs: ['a'] },
      ],
      nets: [
        { from: 'IIN1', to: 'fb:a' },
        { from: 'r:prev', to: 'fb:b' },
        { from: 'fb', to: 'r:a' },
      ],
      outputs: { vout1: 'fb' },
    };
    const eff = fabricToEffect(f);
    const fbPass = eff.passes.find((p) => p.target === 'output')!; // fb drives vout1
    // input b reads the reg's BACK buffer (last frame)
    expect(fbPass.inputs).toContainEqual({ source: 'fbo_r__b', uniform: 'uTex_b' });
  });

  it('binds an undriven cell input to the unpatched-black sentinel', () => {
    // mix with only input a wired; b left unpatched.
    const f: VfpgaFabric = {
      grid: { rows: 1, cols: 1 },
      tiles: [clb('m', 'mix', ['a', 'b'])],
      nets: [{ from: 'IIN1', to: 'm:a' }],
      outputs: { vout1: 'm' },
    };
    const eff = fabricToEffect(f);
    const pass = eff.passes[0]!;
    expect(pass.inputs).toContainEqual({ source: 'vin1', uniform: 'uTex_a' });
    expect(pass.inputs).toContainEqual({ source: '__unpatched__', uniform: 'uTex_b' });
  });

  it('resolves vout1 through an explicit iob_out tile + OUT net', () => {
    const f: VfpgaFabric = {
      grid: { rows: 1, cols: 2 },
      tiles: [
        clb('p', 'passthru', ['a']),
        { id: 'o1', type: 'iob_out', config: { op: 'OUT1' } },
      ],
      nets: [
        { from: 'IIN1', to: 'p:a' },
        { from: 'p', to: 'OUT1' }, // p drives OUT1
      ],
      outputs: { vout1: 'o1' }, // vout1 reads the OUT1 IOB-out tile
    };
    const eff = fabricToEffect(f);
    expect(eff.outputs.vout1).toBe('output');
    // p (the OUT1 driver) renders straight to the surface
    expect(eff.passes.find((p) => p.target === 'output')).toBeTruthy();
    expect(eff.passes).toHaveLength(1); // only the compute tile emits a pass
  });

  it('emits a vout2 reading a second tile FBO', () => {
    const f: VfpgaFabric = {
      grid: { rows: 1, cols: 2 },
      tiles: [clb('p1', 'passthru', ['a']), clb('p2', 'passthru', ['a'])],
      nets: [
        { from: 'IIN1', to: 'p1:a' },
        { from: 'IIN2', to: 'p2:a' },
      ],
      outputs: { vout1: 'p1', vout2: 'p2' },
    };
    const eff = fabricToEffect(f);
    expect(eff.outputs.vout1).toBe('output');
    expect(eff.outputs.vout2).toBe('fbo_p2'); // vout2 keeps its own FBO
    expect((eff.fbos ?? []).map((x) => x.id)).toContain('fbo_p2');
  });
});

// ----------------------------------------------------------------------
// Determinism — the same fabric compiles byte-identically (VRT-safe).
// ----------------------------------------------------------------------

describe('determinism', () => {
  it('compiles a fabric to an identical effect across runs', () => {
    const a = fabricToEffect(chainFabric());
    const b = fabricToEffect(chainFabric());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('topo order is stable + fabric-order tie-broken for independent tiles', () => {
    // two independent passthru tiles → fabric order preserved
    const tiles: VfpgaTile[] = [clb('x', 'passthru', ['a']), clb('y', 'passthru', ['a'])];
    const nets: VfpgaNet[] = [
      { from: 'IIN1', to: 'x:a' },
      { from: 'IIN2', to: 'y:a' },
    ];
    const f: VfpgaFabric = { grid: { rows: 1, cols: 2 }, tiles, nets, outputs: { vout1: 'x', vout2: 'y' } };
    const eff = fabricToEffect(f);
    // x is vout1 → 'output'; y → fbo_y; order: x then y (fabric order)
    expect(eff.passes.map((p) => p.target)).toEqual(['output', 'fbo_y']);
  });
});
