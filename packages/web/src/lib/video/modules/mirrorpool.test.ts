// packages/web/src/lib/video/modules/mirrorpool.test.ts
//
// MIRRORPOOL module-def + factory smoke test. jsdom can't run the GL render
// (that is covered by the deferred-baseline mirrorpool-composite.spec.ts +
// the pure physics in mirrorpool-core.test.ts), but the def contract and the
// factory's CHEAP synchronous construction (FBO alloc + float probe, deferred
// shader compile) are testable with a stub GL context.

import { describe, it, expect } from 'vitest';
import { mirrorpoolDef, MIRRORPOOL_DEFAULTS } from './mirrorpool';
import type { VideoEngineContext } from '$lib/video/engine';

describe('mirrorpoolDef shape', () => {
  it('is a video source with two video inputs + one video output', () => {
    expect(mirrorpoolDef.domain).toBe('video');
    expect(mirrorpoolDef.category).toBe('sources');
    const vin = mirrorpoolDef.inputs.filter((p) => p.type === 'video').map((p) => p.id);
    expect(vin).toEqual(['pool', 'scene']);
    expect(mirrorpoolDef.outputs).toEqual([{ id: 'video_out', type: 'video' }]);
  });

  it('label is lowercase (guard-enforced) + pullExempt (real-time sim)', () => {
    expect(mirrorpoolDef.label).toBe('mirrorpool');
    expect(mirrorpoolDef.pullExempt).toBe(true);
  });

  it('every param has a matching `<param>_cv` input carrying a cvScale', () => {
    for (const param of mirrorpoolDef.params) {
      const cv = mirrorpoolDef.inputs.find(
        (i) => i.type === 'cv' && i.paramTarget === param.id,
      );
      expect(cv, `CV input for ${param.id}`).toBeTruthy();
      expect(cv!.cvScale, `cvScale for ${param.id}`).toBeTruthy();
      expect(cv!.id).toBe(`${param.id}_cv`);
    }
  });

  it('surface_mode blends Refract(0)→Mirror(1); defaults match', () => {
    const mode = mirrorpoolDef.params.find((p) => p.id === 'surface_mode')!;
    expect(mode.min).toBe(0);
    expect(mode.max).toBe(1);
    expect(mode.defaultValue).toBe(0);
    expect(MIRRORPOOL_DEFAULTS.surface_mode).toBe(0);
    expect(MIRRORPOOL_DEFAULTS.brightness).toBe(1);
  });
});

// ── Factory construction (stub GL — no shader link, deferred to draw) ──
function makeFakeGl(): WebGL2RenderingContext {
  return {
    createTexture: () => ({}),
    bindTexture: () => undefined,
    texImage2D: () => undefined,
    texParameteri: () => undefined,
    createFramebuffer: () => ({}),
    bindFramebuffer: () => undefined,
    framebufferTexture2D: () => undefined,
    checkFramebufferStatus: () => 0x8cd5, // FRAMEBUFFER_COMPLETE
    viewport: () => undefined,
    clearColor: () => undefined,
    clear: () => undefined,
    deleteTexture: () => undefined,
    deleteFramebuffer: () => undefined,
    deleteProgram: () => undefined,
    getUniformLocation: () => ({}),
    TEXTURE_2D: 0, RGBA8: 0, RGBA: 0, UNSIGNED_BYTE: 0,
    TEXTURE_MIN_FILTER: 0, TEXTURE_MAG_FILTER: 0,
    TEXTURE_WRAP_S: 0, TEXTURE_WRAP_T: 0, LINEAR: 0, CLAMP_TO_EDGE: 0,
    FRAMEBUFFER: 0, COLOR_ATTACHMENT0: 0, FRAMEBUFFER_COMPLETE: 0x8cd5,
    COLOR_BUFFER_BIT: 0,
  } as unknown as WebGL2RenderingContext;
}

function makeCtx(isFloat: boolean): VideoEngineContext {
  const gl = makeFakeGl();
  return {
    gl,
    res: { width: 1024, height: 768 },
    compileFragment: () => ({}) as WebGLProgram,
    drawFullscreenQuad: () => undefined,
    createFbo: () => ({ fbo: {} as WebGLFramebuffer, texture: {} as WebGLTexture }),
    createFloatFbo: (w?: number, h?: number) => ({
      fbo: {} as WebGLFramebuffer,
      texture: {} as WebGLTexture,
      isFloat,
      width: w ?? 256,
      height: h ?? 256,
    }),
  } as unknown as VideoEngineContext;
}

describe('mirrorpool factory', () => {
  it('constructs without linking a shader; reports isFloat from the float probe', () => {
    const handle = mirrorpoolDef.factory(makeCtx(true), { id: 'mp1', type: 'mirrorpool', params: {} } as never);
    expect(handle.domain).toBe('video');
    expect(handle.surface.texture).toBeTruthy();
    expect(handle.read?.('isFloat')).toBe(true);
    handle.dispose?.();
  });

  it('degrades to isFloat=false when the GPU cannot allocate float targets', () => {
    const handle = mirrorpoolDef.factory(makeCtx(false), { id: 'mp2', type: 'mirrorpool', params: {} } as never);
    expect(handle.read?.('isFloat')).toBe(false);
    handle.dispose?.();
  });

  it('setParam / readParam round-trips a control', () => {
    const handle = mirrorpoolDef.factory(makeCtx(true), { id: 'mp3', type: 'mirrorpool', params: {} } as never);
    expect(handle.readParam('rain')).toBe(MIRRORPOOL_DEFAULTS.rain);
    handle.setParam('rain', 0.87);
    expect(handle.readParam('rain')).toBeCloseTo(0.87, 6);
    handle.dispose?.();
  });
});
