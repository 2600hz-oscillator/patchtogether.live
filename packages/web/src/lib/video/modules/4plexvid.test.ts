// packages/web/src/lib/video/modules/4plexvid.test.ts
//
// Locks down 4PLEXVID's module-def shape + exercises the factory's
// gate -> selector-advance plumbing with a fake GL context (no real
// WebGL needed — mirrors videobox.test.ts). The GL-side per-output
// passthrough render is covered by e2e/tests/4plexvid.spec.ts.

import { describe, expect, it } from 'vitest';
import { fourPlexVidDef } from './4plexvid';
import type { VideoEngineContext } from '$lib/video/engine';
import type { ModuleNode } from '$lib/graph/types';
import { getVideoModuleDef, listVideoModuleDefs } from '$lib/video/module-registry';
// Side-effect import auto-registers every video def (including ours).
import '$lib/video/modules';

describe('fourPlexVidDef — module def shape', () => {
  it('appears in the global video registry list (auto-registered via barrel import)', () => {
    const types = listVideoModuleDefs().map((d) => d.type);
    expect(types).toContain('4plexvid');
    expect(getVideoModuleDef('4plexvid')).toBe(fourPlexVidDef);
  });
});

// ---------------------------------------------------------------------------
// Factory gate -> selector-advance plumbing (fake GL — no real WebGL).
// ---------------------------------------------------------------------------

function makeFakeGl(): WebGL2RenderingContext {
  const stub = (): unknown => ({});
  return {
    getUniformLocation: stub,
    createTexture: () => ({}),
    bindTexture: () => undefined,
    texParameteri: () => undefined,
    texImage2D: () => undefined,
    deleteTexture: () => undefined,
    deleteFramebuffer: () => undefined,
    deleteProgram: () => undefined,
    TEXTURE_2D: 0, RGBA: 0, UNSIGNED_BYTE: 0,
    TEXTURE_MIN_FILTER: 0, TEXTURE_MAG_FILTER: 0,
    TEXTURE_WRAP_S: 0, TEXTURE_WRAP_T: 0,
    NEAREST: 0, CLAMP_TO_EDGE: 0,
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

function spawn(params: Record<string, number> = {}) {
  const node = { id: 'plex', type: '4plexvid', domain: 'video', params, position: { x: 0, y: 0 } } as ModuleNode;
  return fourPlexVidDef.factory(makeCtx(), node);
}

/** A gate pulse = rising edge (1) then falling edge (0). */
function pulse(h: ReturnType<typeof spawn>, gateId: string) {
  h.setParam(gateId, 1);
  h.setParam(gateId, 0);
}

describe('fourPlexVidDef.factory — gate advances the matching selector', () => {
  it('defaults every selector to 0 (in1)', () => {
    const h = spawn();
    for (const s of ['sel1', 'sel2', 'sel3', 'sel4']) expect(h.readParam(s)).toBe(0);
  });

  it('a gate rising edge rotates only its own output selector', () => {
    const h = spawn();
    pulse(h, 'gate1');
    expect(h.readParam('sel1')).toBe(1);
    // The other selectors are untouched — independent per-output routing.
    expect(h.readParam('sel2')).toBe(0);
    expect(h.readParam('sel3')).toBe(0);
    expect(h.readParam('sel4')).toBe(0);
  });

  it('four pulses wrap the selector full circle (1->2->3->0)', () => {
    const h = spawn();
    pulse(h, 'gate2'); expect(h.readParam('sel2')).toBe(1);
    pulse(h, 'gate2'); expect(h.readParam('sel2')).toBe(2);
    pulse(h, 'gate2'); expect(h.readParam('sel2')).toBe(3);
    pulse(h, 'gate2'); expect(h.readParam('sel2')).toBe(0); // wrapped
  });

  it('a held-high gate advances exactly once (edge-triggered, not level)', () => {
    const h = spawn();
    h.setParam('gate3', 1);
    h.setParam('gate3', 1);
    h.setParam('gate3', 1);
    expect(h.readParam('sel3')).toBe(1); // one advance, not three
  });

  it('honors a persisted selector starting value', () => {
    const h = spawn({ sel4: 2 });
    expect(h.readParam('sel4')).toBe(2);
    pulse(h, 'gate4');
    expect(h.readParam('sel4')).toBe(3);
    pulse(h, 'gate4');
    expect(h.readParam('sel4')).toBe(0); // wrap from 3
  });

  it('a directly-set selector value persists + is the base for the next advance', () => {
    const h = spawn();
    h.setParam('sel1', 2); // UI knob set
    expect(h.readParam('sel1')).toBe(2);
    pulse(h, 'gate1');
    expect(h.readParam('sel1')).toBe(3);
  });
});
