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
  it('is a video module, type vfpgaRunner, lowercase label', () => {
    expect(vfpgaRunnerDef.type).toBe('vfpgaRunner');
    expect(vfpgaRunnerDef.domain).toBe('video');
    expect(vfpgaRunnerDef.label).toBe('vfpga-runner');
    // Lowercase-label repo standard.
    expect(vfpgaRunnerDef.label).toBe(vfpgaRunnerDef.label.toLowerCase());
  });

  it('runs off-main-thread (renderLocus worker) — all catalog VFPGAs are pure-GL', () => {
    expect(vfpgaRunnerDef.renderLocus).toBe('worker');
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

  it('declares two video outputs (vout1 canonical, vout2)', () => {
    const outs = vfpgaRunnerDef.outputs.map((o) => o.id);
    expect(outs).toEqual(['vout1', 'vout2']);
    for (const o of vfpgaRunnerDef.outputs) expect(o.type).toBe('video');
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

  it('declares no maxInstances (no cap)', () => {
    expect(vfpgaRunnerDef.maxInstances).toBeUndefined();
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

  it('unknown spec id falls back to the default (smpte-bars)', () => {
    const h = spawn({ vfpga: 'does-not-exist' });
    expect(h.read?.('vfpga')).toBe('smpte-bars');
  });
});
