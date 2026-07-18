// packages/web/src/lib/video/modules/out-to-launch.test.ts
//
// OUT TO LAUNCH — module def + pure-GL factory contract. The real 9×9 GPU
// downsample needs a WebGL2 context (jsdom lacks one) — that's the e2e/VRT
// surface; here we pin the def shape + that draw()/read() behave with a fake GL
// context (the SHAPEGEN test harness pattern). The video→LED colour mapping is
// covered in launchpad-monitor.test.ts.

import { describe, it, expect } from 'vitest';
import {
  outToLaunchDef,
  OUT_TO_LAUNCH_DEFAULTS,
  OUT_TO_LAUNCH_GRID,
  OUT_TO_LAUNCH_GRID_BYTES,
} from './out-to-launch';
import type { VideoEngineContext, VideoFrameContext } from '$lib/video/engine';
import type { ModuleNode } from '$lib/graph/types';

// ── Def shape ───────────────────────────────────────────────────────────────

describe('outToLaunchDef — module shape', () => {
  it('is a video SINK: one video input, ZERO outputs', () => {
    expect(outToLaunchDef.domain).toBe('video');
    expect(outToLaunchDef.outputs).toHaveLength(0);
    const inp = outToLaunchDef.inputs.find((p) => p.id === 'in');
    expect(inp).toBeDefined();
    expect(inp!.type).toBe('video');
  });

  it('has a lowercase label (repo guard)', () => {
    expect(outToLaunchDef.label).toBe('out to launch');
    expect(outToLaunchDef.label).toBe(outToLaunchDef.label.toLowerCase());
  });

  it('declares bright + gamma params with the documented defaults', () => {
    const ids = outToLaunchDef.params.map((p) => p.id);
    expect(ids).toEqual(['bright', 'gamma']);
    const bright = outToLaunchDef.params.find((p) => p.id === 'bright')!;
    const gamma = outToLaunchDef.params.find((p) => p.id === 'gamma')!;
    expect(bright.defaultValue).toBe(OUT_TO_LAUNCH_DEFAULTS.bright);
    expect(gamma.defaultValue).toBe(OUT_TO_LAUNCH_DEFAULTS.gamma);
    expect(gamma.min).toBe(0.5);
    expect(gamma.max).toBe(3);
  });

  it('is pullExempt (drives external hardware — must keep drawing while unobserved)', () => {
    expect(outToLaunchDef.pullExempt).toBe(true);
  });

  it('ships co-located docs (explanation + the two controls)', () => {
    expect(outToLaunchDef.docs?.explanation).toBeTruthy();
    expect(outToLaunchDef.docs?.controls?.bright).toBeTruthy();
    expect(outToLaunchDef.docs?.controls?.gamma).toBeTruthy();
    expect(outToLaunchDef.docs?.inputs?.in).toBeTruthy();
  });

  it('the 9×9 grid constants are consistent (81 texels × 4 = 324 bytes)', () => {
    expect(OUT_TO_LAUNCH_GRID).toBe(9);
    expect(OUT_TO_LAUNCH_GRID_BYTES).toBe(9 * 9 * 4);
    expect(OUT_TO_LAUNCH_GRID_BYTES).toBe(324);
  });
});

// ── Factory contract (fake GL) ──────────────────────────────────────────────

function makeFakeGl(readValue = 0): WebGL2RenderingContext {
  const stub = (): unknown => ({});
  return {
    getUniformLocation: stub,
    createTexture: () => ({}),
    createFramebuffer: () => ({}),
    bindTexture: () => undefined,
    texParameteri: () => undefined,
    texImage2D: () => undefined,
    deleteTexture: () => undefined,
    deleteFramebuffer: () => undefined,
    deleteProgram: () => undefined,
    activeTexture: () => undefined,
    bindFramebuffer: () => undefined,
    framebufferTexture2D: () => undefined,
    viewport: () => undefined,
    useProgram: () => undefined,
    uniform1i: () => undefined,
    uniform1f: () => undefined,
    // Fill the readback buffer so we can prove draw() populated the grid.
    readPixels: (_x: number, _y: number, _w: number, _h: number, _f: number, _t: number, dst: ArrayBufferView) => {
      const u = dst as Uint8Array;
      for (let i = 0; i < u.length; i++) u[i] = readValue;
    },
    TEXTURE_2D: 0, RGBA: 0, UNSIGNED_BYTE: 0,
    TEXTURE_MIN_FILTER: 0, TEXTURE_MAG_FILTER: 0,
    TEXTURE_WRAP_S: 0, TEXTURE_WRAP_T: 0,
    LINEAR: 0, CLAMP_TO_EDGE: 0, TEXTURE0: 0,
    FRAMEBUFFER: 0, COLOR_ATTACHMENT0: 0,
  } as unknown as WebGL2RenderingContext;
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

function spawn(params: Record<string, unknown> = {}) {
  const node = { id: 'otl', type: 'outToLaunch', domain: 'video', params, position: { x: 0, y: 0 } } as ModuleNode;
  return outToLaunchDef.factory(makeCtx(), node);
}

/** A frame ctx whose getInputTexture returns `tex` (null = unpatched). Its own
 *  gl.readPixels fills the dst buffer with `readValue`. */
function makeFrameCtx(frameNo: number, tex: WebGLTexture | null, readValue = 0): VideoFrameContext {
  return {
    gl: makeFakeGl(readValue),
    time: frameNo / 60,
    frame: frameNo,
    getInputTexture: () => tex,
  };
}

describe('outToLaunch — factory draw()/read()', () => {
  it('is a sink: surface.fbo + surface.texture are null (no output texture)', () => {
    const h = spawn();
    expect(h.surface.fbo).toBeNull();
    expect(h.surface.texture).toBeNull();
  });

  it('read("grid9x9") returns a 324-byte buffer that draw() populates', () => {
    const h = spawn();
    const before = h.read?.('grid9x9') as Uint8Array;
    expect(before).toBeInstanceOf(Uint8Array);
    expect(before.length).toBe(OUT_TO_LAUNCH_GRID_BYTES);
    // A frame WITH an input texture + a non-zero readback fills the grid.
    h.surface.draw(makeFrameCtx(0, {} as WebGLTexture, 200));
    const after = h.read?.('grid9x9') as Uint8Array;
    expect(after.length).toBe(OUT_TO_LAUNCH_GRID_BYTES);
    expect(after[0]).toBe(200);
    expect(h.read?.('hasInput')).toBe(true);
    expect(h.read?.('framesElapsed')).toBe(1);
  });

  it('draw() with NO input texture is a clean no-throw (hasInput false)', () => {
    const h = spawn();
    expect(() => h.surface.draw(makeFrameCtx(0, null))).not.toThrow();
    expect(h.read?.('hasInput')).toBe(false);
    expect(h.read?.('framesElapsed')).toBe(1);
  });

  it('setParam / readParam round-trips the knobs + strips unknown node params', () => {
    const h = spawn({ bright: 0.4, bogus: 7 });
    expect(h.readParam('bright')).toBe(0.4);
    expect(h.readParam('gamma')).toBe(OUT_TO_LAUNCH_DEFAULTS.gamma);
    expect(h.readParam('bogus')).toBeUndefined();
    h.setParam('gamma', 1.5);
    expect(h.readParam('gamma')).toBe(1.5);
  });

  it('dispose() is a clean no-throw', () => {
    const h = spawn();
    expect(() => h.dispose()).not.toThrow();
  });
});
