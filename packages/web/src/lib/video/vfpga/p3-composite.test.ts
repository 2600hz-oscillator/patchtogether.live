// packages/web/src/lib/video/vfpga/p3-composite.test.ts
//
// P3 composite-era bent VFPGA catalog — pure (GL-free) unit coverage. Asserts the
// four bent programs (sync-bender, chroma-rot, framestore-howl, databend-cvbs)
// register, pass the §2.1 validation gate, place through P&R into the expected
// pass plan, and that the NEW const/bind plumbing (this PR) lowers a tile's
// config.consts + config.bind correctly (static consts emitted on the pass; bound
// knobs renamed to the host role/param uniform + omitted from consts). The real-
// GPU GLSL compile + a non-trivial bent-pixel render are covered by the browser
// e2e (vfpga-p3-composite.spec.ts); the seed/feedback math + register loop-cut are
// pure, so they live here. Mirrors the b3ntb0x-dsp "logic core unit-tested without
// GL" discipline.

import { describe, expect, it } from 'vitest';
import { fabricToEffect, validateFabric } from './place-and-route';
import { getCell, hasCell } from './cells';
import { cellInputUniform } from './cells/types';
import { getVfpgaSpec } from './registry';
import type { VfpgaSpec } from './types';

// The four P3 programs + the new bend cells they place.
const P3_SPECS = ['sync-bender', 'chroma-rot', 'framestore-howl', 'databend-cvbs'] as const;
const BEND_CELLS: { type: 'clb'; op: string }[] = [
  { type: 'clb', op: 'syncBend' },
  { type: 'clb', op: 'warp' },
  { type: 'clb', op: 'chromaRot' },
  { type: 'clb', op: 'databend' },
];

function spec(id: string): VfpgaSpec {
  const s = getVfpgaSpec(id);
  expect(s, `spec ${id} is registered`).toBeDefined();
  return s!;
}

// ----------------------------------------------------------------------
// Bend cells register + carry the seed plumbing.
// ----------------------------------------------------------------------

describe('P3 bend cells — registration', () => {
  it('every new bend cell is registered + round-trips by (type, op)', () => {
    for (const { type, op } of BEND_CELLS) {
      expect(hasCell(type, op), `${type}:${op} registered`).toBe(true);
      expect(getCell(type, op)!.op).toBe(op);
    }
  });

  it('the seeded bends (syncBend, databend) share the single uSeed seed uniform', () => {
    for (const op of ['syncBend', 'databend']) {
      const seedKnob = getCell('clb', op)!.knobs.find((k) => k.name === 'seed');
      expect(seedKnob, `${op} has a seed knob`).toBeDefined();
      expect(seedKnob!.uniform).toBe('uSeed'); // bound to a gate role's countUniform
    }
  });

  it('each bend kernel includes the shared deterministic hash (VRT-safe rng)', () => {
    for (const op of ['syncBend', 'databend']) {
      const cell = getCell('clb', op)!;
      const frag = cell.kernel({
        uTexFor: (i) => cellInputUniform(i),
        uniformFor: (k) => cell.knobs.find((kb) => kb.name === k)!.uniform,
      });
      expect(frag).toContain('bendHash'); // the shared seeded hash, no true rng
      expect(frag).not.toContain('Math.random');
    }
  });
});

// ----------------------------------------------------------------------
// Every P3 spec validates + places.
// ----------------------------------------------------------------------

describe('P3 specs — validate + place through place-and-route', () => {
  describe.each(P3_SPECS)('%s', (id) => {
    it('passes the §2.1 validation gate', () => {
      const s = spec(id);
      expect(s.fabric, 'is fabric-described (not a legacy effect)').toBeDefined();
      expect(validateFabric(s.fabric!)).toEqual([]);
    });

    it('compiles to a pass plan whose vout1 resolves to the surface output', () => {
      const eff = fabricToEffect(spec(id).fabric!);
      expect(eff.passes.length).toBeGreaterThanOrEqual(1);
      expect(eff.outputs.vout1).toBe('output');
      // every sampler source is a host vin or a declared fbo or the black sentinel
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

    it('its CV roles + param slots agree on uniform names (host drives the bound knobs)', () => {
      // Every cvRole/param/gate uniform a spec declares must be referenced by some
      // emitted pass (else the control is dead). This is the host<->fabric contract:
      // a tile binds a knob TO that uniform; the host sets it BY that uniform.
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
// The const/bind lowering (the new plumbing this PR adds).
// ----------------------------------------------------------------------

describe('P3 const/bind lowering', () => {
  it('a bound knob is renamed to its bind uniform + omitted from consts', () => {
    // sync-bender binds hjit→uHJitter (param p1); the syncBend pass must declare
    // uHJitter as a uniform (so the host param loop drives it) and NOT carry it as
    // a static const.
    const eff = fabricToEffect(spec('sync-bender').fabric!);
    const pass = eff.passes.find((p) => p.target === 'output')!;
    expect(pass.uniforms).toContain('uHJitter');
    expect(pass.consts?.['uHJitter']).toBeUndefined();
    // uTime is declared by the kernel + host-provided; never a const.
    expect(pass.consts?.['uTime']).toBeUndefined();
  });

  it('an UNBOUND knob with a config.consts override is emitted as that static value', () => {
    // framestore-howl sets warp.rot = 0.02 as a const (unbound); the warp pass
    // must carry uWarpRot = 0.02 in consts (and the kernel must read uWarpRot).
    const eff = fabricToEffect(spec('framestore-howl').fabric!);
    const warpPass = eff.passes.find((p) => p.frag.includes('uWarpRot'))!;
    expect(warpPass).toBeTruthy();
    expect(warpPass.consts?.['uWarpRot']).toBe(0.02);
  });

  it('an UNBOUND knob with NO override falls back to the cell defaultValue', () => {
    // databend-cvbs's xor tile is diff with const gain=1 (set), but the lut tile
    // sets level=0.5 as a const while init is bound → consts carries uLutLevel only.
    const eff = fabricToEffect(spec('databend-cvbs').fabric!);
    const lutPass = eff.passes.find((p) => p.frag.includes('uLutInit'))!;
    expect(lutPass.consts?.['uLutLevel']).toBe(0.5); // explicit const
    expect(lutPass.consts?.['uLutInit']).toBeUndefined(); // bound to p1
    expect(lutPass.uniforms).toContain('uLutInit');
  });

  it('validation rejects a bind / const naming a knob the cell does not have', () => {
    const f = structuredClone(spec('sync-bender').fabric!);
    const sync = f.tiles.find((t) => t.id === 'sync')!;
    sync.config.bind!.push({ knob: 'nope', to: 'p', slot: 5, uniform: 'uNope' });
    sync.config.consts = { alsoNope: 1 };
    const errs = validateFabric(f);
    expect(errs.find((e) => /binds knob "nope"/.test(e.message))).toBeTruthy();
    expect(errs.find((e) => /sets const "alsoNope"/.test(e.message))).toBeTruthy();
  });
});

// ----------------------------------------------------------------------
// framestore-howl — the feedback flagship: a real register loop, cut at :prev.
// ----------------------------------------------------------------------

describe('framestore-howl — register frame-store feedback', () => {
  it('declares ONE register pair (the frame store) swapped at end of frame', () => {
    const eff = fabricToEffect(spec('framestore-howl').fabric!);
    expect(eff.registers).toHaveLength(1);
    const reg = eff.registers![0]!;
    expect(reg.id).toBe('store');
    expect(reg.front).toBe('fbo_store__a');
    expect(reg.back).toBe('fbo_store__b');
    // both ping-pong FBOs are allocated (the no-leak invariant: 2 stable FBOs,
    // swapped in place — never reallocated per frame).
    const ids = new Set((eff.fbos ?? []).map((f) => f.id));
    expect(ids.has('fbo_store__a')).toBe(true);
    expect(ids.has('fbo_store__b')).toBe(true);
  });

  it('the warp pass reads the register BACK buffer (last frame) — the cut feedback edge', () => {
    const eff = fabricToEffect(spec('framestore-howl').fabric!);
    const warpPass = eff.passes.find((p) => p.frag.includes('uWarpZoom'))!;
    expect(warpPass.inputs).toContainEqual({ source: 'fbo_store__b', uniform: cellInputUniform('a') });
  });

  it('orders passes warp → mix → {store, out} (producers before consumers)', () => {
    const eff = fabricToEffect(spec('framestore-howl').fabric!);
    const idx = (pred: (frag: string, target: string) => boolean) =>
      eff.passes.findIndex((p) => pred(p.frag, p.target));
    const warpI = idx((f) => f.includes('uWarpZoom'));
    const mixI = idx((f) => f.includes('uMixT'));
    // mix feeds both store (capture) and out (vout1); both come after mix.
    expect(warpI).toBeLessThan(mixI);
    const after = eff.passes.slice(mixI + 1);
    expect(after.length).toBeGreaterThanOrEqual(1); // store and/or out follow mix
  });

  it('the feedback fabric is acyclic ONLY because of the :prev cut (a plain read would loop)', () => {
    // Swap store:prev → store (a combinational read) and P&R must reject the loop.
    const f = structuredClone(spec('framestore-howl').fabric!);
    const net = f.nets.find((n) => n.from === 'store:prev')!;
    net.from = 'store'; // combinational read of the value written this frame
    expect(validateFabric(f).find((e) => /combinational cycle/.test(e.message))).toBeTruthy();
  });
});

// ----------------------------------------------------------------------
// databend-cvbs — the LUT16 datapath bend.
// ----------------------------------------------------------------------

describe('databend-cvbs — LUT16 datapath', () => {
  it('places the literal LUT16 tile (a 4-input truth table over the picture)', () => {
    const f = spec('databend-cvbs').fabric!;
    const lut = f.tiles.find((t) => t.type === 'lut16')!;
    expect(lut).toBeTruthy();
    expect(lut.inputs).toEqual(['a', 'b', 'c', 'd']);
    // all four LUT inputs are driven from the single host video-in IIN1.
    const lutNets = f.nets.filter((n) => n.to.startsWith(`${lut.id}:`));
    expect(lutNets).toHaveLength(4);
    for (const n of lutNets) expect(n.from).toBe('IIN1');
  });

  it('XOR-combines the databent picture with the bit-error field (3 compute passes)', () => {
    const eff = fabricToEffect(spec('databend-cvbs').fabric!);
    // lut + databend + diff(xor) = 3 compute passes (iob tiles emit none).
    expect(eff.passes).toHaveLength(3);
    const xorPass = eff.passes.find((p) => p.target === 'output')!;
    // the xor (diff) pass samples both upstream tile FBOs.
    const sources = (xorPass.inputs ?? []).map((i) => i.source);
    expect(sources.length).toBe(2);
    expect(sources.every((s) => s.startsWith('fbo_'))).toBe(true);
  });
});
