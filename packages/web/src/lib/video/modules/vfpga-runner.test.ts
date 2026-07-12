// packages/web/src/lib/video/modules/vfpga-runner.test.ts
//
// Unit tests for the vfpga-runner host module def + factory plumbing (fake GL —
// jsdom can't render shaders; the real GL pipeline is covered by the e2e). We
// assert: the def declares the full I/O superset; the factory edge-detects gates
// into read('gateState') / rising-edge counts; the snapshot read works; and a
// hot-swap to a (currently the only) spec is a no-op while staying valid.

import { describe, expect, it } from 'vitest';
import { vfpgaRunnerDef } from './vfpga-runner';
import type { VideoEngineContext, VideoFrameContext } from '$lib/video/engine';
import type { ModuleNode } from '$lib/graph/types';
import { getVideoModuleDef, listVideoModuleDefs } from '$lib/video/module-registry';
import {
  VFPGA_VIDEO_IN_PORTS,
  VFPGA_CV_PORTS,
  VFPGA_GATE_PORTS,
  VFPGA_PARAM_SLOTS,
} from '$lib/video/vfpga/types';

import '$lib/video/modules';

describe('vfpgaRunnerDef — module def shape', () => {
  it('worker-eligible under the EXPLICIT flag only (renderLocus worker-experimental)', () => {
    // All catalog VFPGAs are pure-GL, but the card polls read('gateState') /
    // readParam('cvN_val') every frame and the WorkerProxyHandle serves
    // read() by materializing + ticking a main-thread fallback -- so the
    // DEFAULT-ON worker tier (PR V2) would render every VFPGA twice. It
    // stays in the experimental tier until worker-side probe forwarding
    // exists (see the def comment + workerLocusEligible).
    expect(vfpgaRunnerDef.renderLocus).toBe('worker-experimental');
  });

  it('declares the full INPUT superset: vin1-4 (video) + cv1-4 (cv) + g1-4 (gate)', () => {
    const byId = new Map(vfpgaRunnerDef.inputs.map((p) => [p.id, p]));
    for (const v of VFPGA_VIDEO_IN_PORTS) {
      expect(byId.get(v)?.type).toBe('video');
    }
    for (let i = 0; i < VFPGA_CV_PORTS.length; i++) {
      const p = byId.get(VFPGA_CV_PORTS[i]!)!;
      expect(p.type).toBe('cv');
      expect(p.paramTarget).toBe(`cv${i + 1}_val`);
      expect(p.cvScale?.mode).toBe('linear');
    }
    for (let i = 0; i < VFPGA_GATE_PORTS.length; i++) {
      const p = byId.get(VFPGA_GATE_PORTS[i]!)!;
      expect(p.type).toBe('gate');
      expect(p.paramTarget).toBe(`g${i + 1}_evt`);
    }
  });

  it('declares the p1..p8 generic slot bank + synthetic cv/gate params', () => {
    const ids = new Set(vfpgaRunnerDef.params.map((p) => p.id));
    for (const slot of VFPGA_PARAM_SLOTS) expect(ids.has(slot)).toBe(true);
    for (let i = 1; i <= 4; i++) {
      expect(ids.has(`cv${i}_val`)).toBe(true);
      expect(ids.has(`g${i}_evt`)).toBe(true);
    }
  });

  it('auto-registers in the global video registry', () => {
    expect(listVideoModuleDefs().map((d) => d.type)).toContain('vfpgaRunner');
    expect(getVideoModuleDef('vfpgaRunner')).toBe(vfpgaRunnerDef);
  });

});

// ---------------------------------------------------------------------------
// Factory plumbing (fake GL — no real WebGL).
// ---------------------------------------------------------------------------

function makeFakeGl(): WebGL2RenderingContext {
  const stub = (): unknown => ({});
  return new Proxy(
    {
      getUniformLocation: stub,
      createTexture: () => ({}),
      bindTexture: () => undefined,
      texParameteri: () => undefined,
      texImage2D: () => undefined,
      pixelStorei: () => undefined,
      bindFramebuffer: () => undefined,
      viewport: () => undefined,
      useProgram: () => undefined,
      activeTexture: () => undefined,
      uniform1i: () => undefined,
      uniform1f: () => undefined,
      uniform2f: () => undefined,
      deleteTexture: () => undefined,
      deleteFramebuffer: () => undefined,
      deleteProgram: () => undefined,
      TEXTURE0: 0,
    } as Record<string, unknown>,
    { get: (t, k) => (k in t ? t[k as string] : 0) },
  ) as unknown as WebGL2RenderingContext;
}

function makeCtx(): VideoEngineContext {
  return {
    gl: makeFakeGl(),
    res: { width: 1024, height: 768 },
    compileFragment: () => ({}) as WebGLProgram,
    createFbo: () => ({ fbo: {} as WebGLFramebuffer, texture: {} as WebGLTexture }),
    drawFullscreenQuad: () => undefined,
  };
}

function makeFrame(): VideoFrameContext {
  return {
    gl: makeFakeGl(),
    time: 0,
    frame: 0,
    getInputTexture: () => null,
  };
}

function spawn(data: Record<string, unknown> = {}, params: Record<string, number> = {}) {
  const node = {
    id: 'vfpga', type: 'vfpgaRunner', domain: 'video', params, data, position: { x: 0, y: 0 },
  } as ModuleNode;
  return vfpgaRunnerDef.factory(makeCtx(), node);
}

describe('vfpgaRunnerDef.factory — gate edge-detect', () => {
  it('read("gateState") starts all-low', () => {
    const h = spawn();
    h.surface.draw(makeFrame());
    expect(h.read?.('gateState')).toEqual([false, false, false, false]);
  });

  it('a held gate reads as pressed after draw edge-detect (hysteresis)', () => {
    const h = spawn();
    h.setParam('g1_evt', 1); // raw gate high (above 0.6 rise threshold)
    h.surface.draw(makeFrame());
    expect((h.read?.('gateState') as boolean[])[0]).toBe(true);
    // Falling below 0.4 releases it.
    h.setParam('g1_evt', 0);
    h.surface.draw(makeFrame());
    expect((h.read?.('gateState') as boolean[])[0]).toBe(false);
  });

  it('only the pulsed gate flips (others stay low)', () => {
    const h = spawn();
    h.setParam('g3_evt', 1);
    h.surface.draw(makeFrame());
    expect(h.read?.('gateState')).toEqual([false, false, true, false]);
  });
});

describe('vfpgaRunnerDef.factory — preset + snapshot + outputs', () => {
  it('defaults to smpte-bars and reads its id', () => {
    const h = spawn();
    expect(h.read?.('vfpga')).toBe('smpte-bars');
  });

  it('read("snapshot") returns a full-resolution preview for smpte-bars', () => {
    const h = spawn();
    const snap = h.read?.('snapshot') as ImageData | null;
    expect(snap).toBeTruthy();
    expect(snap!.width).toBeGreaterThan(0);
    expect(snap!.height).toBeGreaterThan(0);
  });

  it('vout2 is null for a single-output spec (smpte-bars), vout1 resolves', () => {
    const h = spawn();
    h.surface.draw(makeFrame());
    expect(h.read?.('outputTexture:vout2')).toBeNull();
    expect(h.read?.('outputTexture:vout1')).toBeTruthy();
  });

  it('hot-swap to the same id is a no-op but keeps a valid pipeline', () => {
    const h = spawn({ vfpga: 'smpte-bars' });
    h.setParam('__reloadVfpga', 1); // sentinel
    h.surface.draw(makeFrame());
    expect(h.read?.('vfpga')).toBe('smpte-bars');
    expect(h.read?.('outputTexture:vout1')).toBeTruthy();
  });

  it('hot-swap to a DIFFERENT preset rebuilds the pipeline + read("vfpga") follows the new id', () => {
    // The user-reported preset bug: loading a non-default VFPGA must actually
    // swap the running effect. The card writes node.data.vfpga (the SAME data
    // object the factory captured — snapshot.ts passes `data: n.data` by ref) and
    // pulses __reloadVfpga; the factory must re-resolve from that live data + swap.
    const data: Record<string, unknown> = { vfpga: 'smpte-bars' };
    const node = {
      id: 'vfpga', type: 'vfpgaRunner', domain: 'video', params: {}, data, position: { x: 0, y: 0 },
    } as ModuleNode;
    const h = vfpgaRunnerDef.factory(makeCtx(), node);
    expect(h.read?.('vfpga')).toBe('smpte-bars');
    // Mutate the captured data object in place (what setVfpgaSpec does on the live
    // SyncedStore node), then pulse the reload sentinel.
    data.vfpga = 'chroma-rot';
    h.setParam('__reloadVfpga', 1);
    h.surface.draw(makeFrame());
    expect(h.read?.('vfpga')).toBe('chroma-rot'); // engine actually swapped
    expect(h.read?.('outputTexture:vout1')).toBeTruthy();
  });

  it('unknown spec id falls back to the default (smpte-bars)', () => {
    const h = spawn({ vfpga: 'does-not-exist' });
    expect(h.read?.('vfpga')).toBe('smpte-bars');
  });

  it('renders the default smpte-bars through the FABRIC path across repeated draws (no register swap, stable output)', () => {
    // smpte-bars is now fabric-described (P1 dogfood); its 1-tile generator
    // fabric P&R's to a single output pass with NO registers, so repeated draws
    // are stable + the swap loop is a no-op (byte-identical to the legacy path).
    const h = spawn();
    for (let i = 0; i < 3; i++) h.surface.draw(makeFrame());
    expect(h.read?.('outputTexture:vout1')).toBeTruthy();
    expect(h.read?.('outputTexture:vout2')).toBeNull();
    // The CPU-preview snapshot still resolves (spec id unchanged).
    expect(h.read?.('snapshot')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// P3 composite-era bent VFPGAs — hot-swap + draw through the factory (fake GL).
// Verifies the new const/bind plumbing + the framestore-howl register swap drive
// the GL pipeline without crashing (the actual bent pixels are the e2e's job).
// ---------------------------------------------------------------------------

describe('vfpgaRunnerDef.factory — P3 bent VFPGAs hot-swap + draw', () => {
  // framestore-howl + chroma-rot are now 2-OUTPUT specs (the frame-store send / the
  // Y plane) — they get their own multi-output assertions below; the rest stay
  // single-output.
  for (const id of ['sync-bender', 'databend-cvbs']) {
    it(`loads ${id} via node.data and draws repeatedly with a valid vout1`, () => {
      const h = spawn({ vfpga: id });
      expect(h.read?.('vfpga')).toBe(id);
      // Drive a CV + a gate so the role/seed/feedback uniform paths execute.
      h.setParam('cv1_val', 0.7);
      h.setParam('g1_evt', 1);
      for (let i = 0; i < 4; i++) h.surface.draw(makeFrame());
      h.setParam('g1_evt', 0);
      h.surface.draw(makeFrame());
      // Single-output bent specs: vout1 resolves, vout2 is null.
      expect(h.read?.('outputTexture:vout1')).toBeTruthy();
      expect(h.read?.('outputTexture:vout2')).toBeNull();
    });
  }

  it('framestore-howl allocates the register pair, draws (swaps), drives BOTH outputs, and disposes cleanly', () => {
    // The feedback flagship's frame-store is a register ping-pong pair: build →
    // draw (which runs the end-of-frame swapRegisters) → dispose, all without
    // throwing. This exercises the no-leak path (fixed FBOs swapped in place, then
    // freed on dispose) the leak-audit covers. It is also the catalog's FIRST
    // 2-output spec: vout1 = the composited howl, vout2 = the frame-store send
    // (the warped recirculated frame). Both must resolve to a texture.
    const h = spawn({ vfpga: 'framestore-howl' });
    for (let i = 0; i < 3; i++) h.surface.draw(makeFrame());
    expect(h.read?.('outputTexture:vout1')).toBeTruthy();
    expect(h.read?.('outputTexture:vout2'), 'framestore-howl vout2 (frame-store send) resolves').toBeTruthy();
    expect(() => h.dispose?.()).not.toThrow();
  });

  it('chroma-rot is 2-input + 2-output: draws and drives BOTH outputs (the Y/C split)', () => {
    // The Y/C transplant flagship: IIN1 = luma source, IIN2 = chroma source; vout1 =
    // the chroma-corrupted composite, vout2 = the separated luma (Y) plane. Both must
    // resolve to a texture (vin2 unpatched here is fine — the cell falls back to A's
    // own chroma; the real two-source transplant is the e2e's job).
    const h = spawn({ vfpga: 'chroma-rot' });
    expect(h.read?.('vfpga')).toBe('chroma-rot');
    h.setParam('cv1_val', 0.5);
    h.setParam('g1_evt', 1);
    for (let i = 0; i < 3; i++) h.surface.draw(makeFrame());
    h.setParam('g1_evt', 0);
    h.surface.draw(makeFrame());
    expect(h.read?.('outputTexture:vout1'), 'chroma-rot vout1 (composite) resolves').toBeTruthy();
    expect(h.read?.('outputTexture:vout2'), 'chroma-rot vout2 (luma Y plane) resolves').toBeTruthy();
    expect(() => h.dispose?.()).not.toThrow();
  });
});
