// packages/web/src/lib/video/vfpga/p4-early-hd.test.ts
//
// P4 early-HD-era bent VFPGA catalog — pure (GL-free) unit coverage. Asserts the
// three bent programs (macroblock-mosh, tmds-sparkle, scaler-glitch) register, pass
// the §2.1 validation gate, place through P&R into the expected pass plan, drive
// their declared controls, and exercise the era-defining fabric features: the
// register frame-store feedback (mosh's reference frame, cut at :prev), the literal
// LUT16 datapath (tmds-sparkle's bit-flip field), and the BRAM line buffer
// (scaler-glitch's bram budget). The real-GPU GLSL compile + a non-trivial bent-
// pixel render are covered by the browser e2e (vfpga-p4-early-hd.spec.ts); the
// seed/feedback math + register loop-cut + budget are pure, so they live here.
// Mirrors the P3 composite test discipline.

import { describe, expect, it } from 'vitest';
import { fabricToEffect, validateFabric } from './place-and-route';
import { getCell, hasCell } from './cells';
import { cellInputUniform } from './cells/types';
import { getVfpgaSpec } from './registry';
import type { VfpgaSpec } from './types';

// The three P4 programs + the new bend cells they place.
const P4_SPECS = ['macroblock-mosh', 'tmds-sparkle', 'scaler-glitch'] as const;
const P4_CELLS: { type: 'clb' | 'bram'; op: string }[] = [
  { type: 'clb', op: 'mosh' },
  { type: 'clb', op: 'tmdsbend' },
  { type: 'bram', op: 'linebuf' },
];

function spec(id: string): VfpgaSpec {
  const s = getVfpgaSpec(id);
  expect(s, `spec ${id} is registered`).toBeDefined();
  return s!;
}

// ----------------------------------------------------------------------
// New P4 bend cells register + carry the seed plumbing.
// ----------------------------------------------------------------------

describe('P4 bend cells — registration', () => {
  it('every new bend cell is registered + round-trips by (type, op)', () => {
    for (const { type, op } of P4_CELLS) {
      expect(hasCell(type, op), `${type}:${op} registered`).toBe(true);
      expect(getCell(type, op)!.op).toBe(op);
    }
  });

  it('every seeded bend (mosh, tmdsbend, linebuf) shares the single uSeed seed uniform', () => {
    for (const { type, op } of P4_CELLS) {
      const seedKnob = getCell(type, op)!.knobs.find((k) => k.name === 'seed');
      expect(seedKnob, `${op} has a seed knob`).toBeDefined();
      expect(seedKnob!.uniform).toBe('uSeed'); // bound to a gate role's countUniform
    }
  });

  it('each bend kernel includes the shared deterministic hash (VRT-safe rng, no true rng)', () => {
    for (const { type, op } of P4_CELLS) {
      const cell = getCell(type, op)!;
      const frag = cell.kernel({
        uTexFor: (i) => cellInputUniform(i),
        uniformFor: (k) => cell.knobs.find((kb) => kb.name === k)!.uniform,
      });
      expect(frag).toContain('bendHash'); // the shared seeded hash
      expect(frag).not.toContain('Math.random');
    }
  });
});

// ----------------------------------------------------------------------
// Every P4 spec validates + places.
// ----------------------------------------------------------------------

describe('P4 specs — validate + place through place-and-route', () => {
  describe.each(P4_SPECS)('%s', (id) => {
    it('passes the §2.1 validation gate', () => {
      const s = spec(id);
      expect(s.fabric, 'is fabric-described (not a legacy effect)').toBeDefined();
      expect(validateFabric(s.fabric!)).toEqual([]);
    });

    it('compiles to a pass plan whose vout1 resolves to the surface output', () => {
      const eff = fabricToEffect(spec(id).fabric!);
      expect(eff.passes.length).toBeGreaterThanOrEqual(1);
      expect(eff.outputs.vout1).toBe('output');
      const fboIds = new Set((eff.fbos ?? []).map((f) => f.id));
      for (const p of eff.passes) {
        for (const inp of p.inputs ?? []) {
          const ok = inp.source === '__unpatched__' || inp.source.startsWith('vin') || fboIds.has(inp.source);
          expect(ok, `${id}: source ${inp.source} resolves`).toBe(true);
        }
      }
    });

    it('compiles byte-identically across runs (deterministic → VRT-safe)', () => {
      const f = spec(id).fabric!;
      expect(JSON.stringify(fabricToEffect(f))).toBe(JSON.stringify(fabricToEffect(f)));
    });

    it('its CV roles + param slots + gate uniforms all reach an emitted pass', () => {
      const s = spec(id);
      const eff = fabricToEffect(s.fabric!);
      const passUniforms = new Set(eff.passes.flatMap((p) => p.uniforms ?? []));
      for (const r of s.cvRoles ?? []) expect(passUniforms.has(r.uniform), `cv ${r.uniform} reaches a pass`).toBe(true);
      for (const p of s.params ?? []) expect(passUniforms.has(p.uniform), `param ${p.uniform} reaches a pass`).toBe(true);
      for (const g of s.gateRoles ?? []) {
        if (g.heldUniform) expect(passUniforms.has(g.heldUniform), `gate ${g.heldUniform} reaches a pass`).toBe(true);
        if (g.countUniform) expect(passUniforms.has(g.countUniform), `gate ${g.countUniform} reaches a pass`).toBe(true);
      }
    });
  });
});

// ----------------------------------------------------------------------
// macroblock-mosh — the EARLY-HD register frame-store: a real feedback loop
// (the reference frame), cut at :prev (same flagship pattern as framestore-howl).
// ----------------------------------------------------------------------

describe('macroblock-mosh — register reference frame-store feedback', () => {
  it('declares TWO register pairs (the reference store + clip-B motion store) swapped at end of frame', () => {
    const eff = fabricToEffect(spec('macroblock-mosh').fabric!);
    expect(eff.registers).toHaveLength(2);
    const byId = new Map(eff.registers!.map((r) => [r.id, r]));
    // the reference frame-store (image-A feedback reference)
    expect(byId.get('store')).toMatchObject({ front: 'fbo_store__a', back: 'fbo_store__b' });
    // the clip-B motion-source store (holds B's previous frame for motion estimation)
    expect(byId.get('storeB')).toMatchObject({ front: 'fbo_storeB__a', back: 'fbo_storeB__b' });
    const ids = new Set((eff.fbos ?? []).map((f) => f.id));
    for (const id of ['fbo_store__a', 'fbo_store__b', 'fbo_storeB__a', 'fbo_storeB__b']) {
      expect(ids.has(id), `${id} allocated`).toBe(true);
    }
  });

  it('the mosh pass reads the register BACK buffer (last frame = the reference) — the cut edge', () => {
    const eff = fabricToEffect(spec('macroblock-mosh').fabric!);
    const moshPass = eff.passes.find((p) => p.frag.includes('uMoshMvect'))!;
    expect(moshPass.inputs).toContainEqual({ source: 'fbo_store__b', uniform: cellInputUniform('a') });
  });

  it('the mosh pass also reads clip B now (IIN2→vin2) + clip B last frame (storeB:prev) for two-clip motion transfer', () => {
    const eff = fabricToEffect(spec('macroblock-mosh').fabric!);
    const moshPass = eff.passes.find((p) => p.frag.includes('uMoshMvectB'))!;
    // b = clip B now (the host vin2 sampler), bprev = clip B last frame (storeB back buffer).
    expect(moshPass.inputs).toContainEqual({ source: 'vin2', uniform: cellInputUniform('b') });
    expect(moshPass.inputs).toContainEqual({ source: 'fbo_storeB__b', uniform: cellInputUniform('bprev') });
    // the transferred-motion gain reaches the pass (param p5 / CIN2 both drive it).
    expect(moshPass.uniforms).toContain('uMoshMvectB');
  });

  it('orders passes mosh → mix → {store, out} (producers before consumers)', () => {
    const eff = fabricToEffect(spec('macroblock-mosh').fabric!);
    const moshI = eff.passes.findIndex((p) => p.frag.includes('uMoshMvect'));
    const mixI = eff.passes.findIndex((p) => p.frag.includes('uMixT'));
    expect(moshI).toBeLessThan(mixI);
    expect(eff.passes.slice(mixI + 1).length).toBeGreaterThanOrEqual(1);
  });

  it('the feedback fabric is acyclic ONLY because of the :prev cut (a plain read would loop)', () => {
    const f = structuredClone(spec('macroblock-mosh').fabric!);
    const net = f.nets.find((n) => n.from === 'store:prev')!;
    net.from = 'store'; // combinational read of the value written this frame
    expect(validateFabric(f).find((e) => /combinational cycle/.test(e.message))).toBeTruthy();
  });

  it('the I-frame gate binds to the mosh tile (forced clean reload, held)', () => {
    const eff = fabricToEffect(spec('macroblock-mosh').fabric!);
    const moshPass = eff.passes.find((p) => p.frag.includes('uMoshMvect'))!;
    expect(moshPass.uniforms).toContain('uMoshIframe');
    expect(moshPass.consts?.['uMoshIframe']).toBeUndefined(); // gate-driven, not a const
  });
});

// ----------------------------------------------------------------------
// tmds-sparkle — the LUT16 bit-flip datapath (the second literal LUT16 showcase).
// ----------------------------------------------------------------------

describe('tmds-sparkle — LUT16 bit-flip field', () => {
  it('places the literal LUT16 tile (a 4-input truth table over the picture)', () => {
    const f = spec('tmds-sparkle').fabric!;
    const lut = f.tiles.find((t) => t.type === 'lut16')!;
    expect(lut).toBeTruthy();
    expect(lut.inputs).toEqual(['a', 'b', 'c', 'd']);
    const lutNets = f.nets.filter((n) => n.to.startsWith(`${lut.id}:`));
    expect(lutNets).toHaveLength(4);
    for (const n of lutNets) expect(n.from).toBe('IIN1');
  });

  it('XOR-combines the TMDS-bent picture with the bit-error field (3 compute passes)', () => {
    const eff = fabricToEffect(spec('tmds-sparkle').fabric!);
    // lut + tmdsbend + diff(xor) = 3 compute passes (iob tiles emit none).
    expect(eff.passes).toHaveLength(3);
    const xorPass = eff.passes.find((p) => p.target === 'output')!;
    const sources = (xorPass.inputs ?? []).map((i) => i.source);
    expect(sources.length).toBe(2);
    expect(sources.every((s) => s.startsWith('fbo_'))).toBe(true);
  });

  it('the LUT INIT is bound to a param (the flip mask sweeps) + level stays a const', () => {
    const eff = fabricToEffect(spec('tmds-sparkle').fabric!);
    const lutPass = eff.passes.find((p) => p.frag.includes('uLutInit'))!;
    expect(lutPass.consts?.['uLutLevel']).toBe(0.5); // explicit const (threshold)
    expect(lutPass.consts?.['uLutInit']).toBeUndefined(); // bound to p2
    expect(lutPass.uniforms).toContain('uLutInit');
  });
});

// ----------------------------------------------------------------------
// scaler-glitch — the BRAM line-buffer (the early-HD video staple), budget-counted.
// ----------------------------------------------------------------------

describe('scaler-glitch — BRAM line buffer', () => {
  it('places exactly one BRAM line-buffer tile reading the host video in', () => {
    const f = spec('scaler-glitch').fabric!;
    const bram = f.tiles.filter((t) => t.type === 'bram');
    expect(bram).toHaveLength(1);
    expect(bram[0]!.config.op).toBe('linebuf');
    expect(bram[0]!.config.rows).toBe(8);
    const bramNets = f.nets.filter((n) => n.to.startsWith(`${bram[0]!.id}:`));
    expect(bramNets).toHaveLength(1);
    expect(bramNets[0]!.from).toBe('IIN1');
  });

  it('declares + honours a BRAM-rows budget (the authentic resource cap)', () => {
    const f = spec('scaler-glitch').fabric!;
    expect(f.budget?.bramRows).toBe(8);
    // exactly at budget = valid; one row over = a budget error.
    expect(validateFabric(f)).toEqual([]);
    const over = structuredClone(f);
    over.budget!.bramRows = 4; // now 8 rows > 4 budget
    expect(validateFabric(over).find((e) => /BRAM-rows budget exceeded/.test(e.message))).toBeTruthy();
  });

  it('compiles to a single compute pass (the line-buffer scaler is the whole fabric)', () => {
    const eff = fabricToEffect(spec('scaler-glitch').fabric!);
    expect(eff.passes).toHaveLength(1);
    expect(eff.passes[0]!.target).toBe('output');
    expect(eff.passes[0]!.inputs?.[0]?.source).toBe('vin1');
  });
});
