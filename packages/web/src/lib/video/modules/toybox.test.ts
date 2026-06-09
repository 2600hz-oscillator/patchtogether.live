// packages/web/src/lib/video/modules/toybox.test.ts
//
// Def-shape coverage for the TOYBOX module (the 6-input modulation section).
// The GL render pipeline is exercised by E2E/VRT (jsdom can't render shaders);
// here we pin the port surface — that the 6 generic modulation input ports exist
// (type `modsignal`, so they accept cv/gate/audio) with the neutral linear hint
// + no paramTarget (routing is dynamic, handled in setParam) — so a regression
// that drops a port or re-narrows the type fails a fast unit test. Also covers
// the schemaVersion-2 migration that strips dropped cv7/cv8 routes (the 8→6
// non-destructive load).

import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { toyboxDef, migrateToyboxData, __FEEDBACK_FRAG_SRC_FOR_TEST } from './toybox';
import { CV_PORT_IDS } from '$lib/video/toybox-cv-routes';
import { FEEDBACK_MODE_COUNT } from '$lib/video/toybox-feedback';
import { patch, ydoc } from '$lib/graph/store';
import { makeDefaultCombineGraph } from '$lib/video/toybox-combine-graph';
import type { VideoEngineContext, VideoFrameContext } from '$lib/video/engine';
import type { ModuleNode, Edge } from '$lib/graph/types';

describe('toyboxDef shape', () => {
  it('is a video-source module with one video output', () => {
    expect(toyboxDef.type).toBe('toybox');
    expect(toyboxDef.domain).toBe('video');
    expect(toyboxDef.outputs).toHaveLength(1);
    expect(toyboxDef.outputs[0]!.id).toBe('out');
    expect(toyboxDef.outputs[0]!.type).toBe('video');
  });

  it('declares 8 inputs: 6 generic modulation ports (cv1..cv6) THEN 2 video ports (inA/inB)', () => {
    const ids = toyboxDef.inputs.map((p) => p.id);
    // cv1..cv6 first (order matters: the card + CV routing read ports by id at
    // a stable index), inA/inB appended LAST.
    expect(ids).toEqual([...CV_PORT_IDS, 'inA', 'inB']);
    expect(toyboxDef.inputs).toHaveLength(8);
  });

  it('the 6 cv ports are type `modsignal` (cv/gate/audio) with a linear hint + NO paramTarget', () => {
    const cvPorts = toyboxDef.inputs.filter((p) => p.id !== 'inA' && p.id !== 'inB');
    expect(cvPorts).toHaveLength(6);
    for (const port of cvPorts) {
      // modsignal: accepts cv, gate, OR audio (canConnect scopes audio→non-audio
      // to this type only). The port IDs stay cv1..cv6.
      expect(port.type).toBe('modsignal');
      // Neutral-linear hint: the cv-bridge degrades to raw passthrough (no
      // param named 'cvN' to resolve), so TOYBOX shapes the value in setParam.
      expect(port.cvScale).toEqual({ mode: 'linear' });
      // Dynamic routing → no static paramTarget.
      expect(port.paramTarget).toBeUndefined();
    }
  });

  it('the 2 video inputs (inA/inB) are type `video` (a patched feed into a layer)', () => {
    const inA = toyboxDef.inputs.find((p) => p.id === 'inA');
    const inB = toyboxDef.inputs.find((p) => p.id === 'inB');
    expect(inA?.type).toBe('video');
    expect(inB?.type).toBe('video');
  });

  it('has no static numeric engine params (content/material/combine live in node.data)', () => {
    expect(toyboxDef.params).toEqual([]);
  });

  it('is schemaVersion 4 with a migrate hook', () => {
    // v4 = feedback gained the `intensity` (wet/dry mix) param (backfilled).
    // v3 = chromakey single `key` channel-select → keyR/keyG/keyB HSV key
    // (v2 was the 8→6 cv7/cv8 route strip).
    expect(toyboxDef.schemaVersion).toBe(4);
    expect(typeof toyboxDef.migrate).toBe('function');
  });
});

describe('migrateToyboxData — 8-input (cv1..cv8) patch loads as 6 inputs', () => {
  it('strips the dropped cv7/cv8 routes from a v1 save without throwing', () => {
    const v1data = {
      layers: [{ kind: 'gen', contentId: 'noise-fbm', params: {} }],
      cvRoutes: {
        cv1: { target: 'layer', layer: 0, param: 'speed' },
        cv6: { target: 'combine', nodeId: 'op1', param: 'amount' },
        cv7: { target: 'layer', layer: 0, param: 'scale' }, // dropped pool port
        cv8: { target: 'layer', layer: 1, param: 'speed' }, // dropped pool port
      },
    };
    const out = migrateToyboxData(v1data, 1) as { cvRoutes: Record<string, unknown> };
    const keys = Object.keys(out.cvRoutes);
    expect(keys).toContain('cv1');
    expect(keys).toContain('cv6');
    expect(keys).not.toContain('cv7');
    expect(keys).not.toContain('cv8');
    expect(keys).toHaveLength(2);
  });

  it('is a no-op at/above the current schemaVersion + tolerates missing/garbage data', () => {
    const same = { cvRoutes: { cv7: { target: 'layer', layer: 0, param: 'x' } } };
    expect(migrateToyboxData(same, 2)).toBe(same); // already current → untouched
    expect(() => migrateToyboxData(null, 1)).not.toThrow();
    expect(() => migrateToyboxData(undefined, 1)).not.toThrow();
    expect(() => migrateToyboxData({}, 1)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// REGRESSION GUARD — CV modulation must NOT write through to the synced Y.Doc.
//
// Root cause of the progressive-slowdown / memory leak (perf PR): the TOYBOX
// factory's CV-bridge setParam → applyCvRoute → resolveRoute().apply mutated the
// addressed combine/layer param IN PLACE on the object returned by
// liveCombineRaw()/liveLayers(). Those getters used to return the LIVE
// SyncedStore (Yjs) proxy, so every per-frame CV write mutated the synced +
// persisted Y.Doc → a `ydoc.update` PER CV FRAME → the snapshot bus re-emitted →
// Canvas rebuilt the whole SvelteFlow graph → xyflow leaked detached <svg>/<path>
// edge DOM each rebuild (~130-160 MB/min retained with one active CV cable).
//
// The fix makes those getters return a render-local CLONE that CV modulation
// mutates, re-synced from the store only on a genuine user edit. This guard
// drives the REAL factory's setParam('cv1', …) CV-apply path and asserts that
// (a) the live store's combine param is UNCHANGED and (b) the Y.Doc fires ZERO
// update events — i.e. live modulation stays transient runtime state, exactly
// like #147 paramTaps. GL-free: a fake WebGL2 context (the factory only needs
// non-null handles; jsdom can't render shaders anyway).
// ---------------------------------------------------------------------------

const RTID = 'toybox-cv-leak-guard';

function makeFakeGl(): WebGL2RenderingContext {
  return new Proxy(
    {},
    {
      get: (_t, prop) => {
        const p = String(prop);
        // Every create*/getUniformLocation must return a NON-null handle (the
        // factory throws on a null texture/fbo/renderbuffer/program/shader/VAO).
        if (p.startsWith('create') || p === 'getUniformLocation') return () => ({});
        if (p === 'checkFramebufferStatus') return () => 0x8cd5; // FRAMEBUFFER_COMPLETE
        if (p === 'getProgramParameter' || p === 'getShaderParameter') return () => true;
        if (p === 'getExtension') return () => null;
        return () => 0;
      },
    },
  ) as unknown as WebGL2RenderingContext;
}

function makeToyboxCtx(): VideoEngineContext {
  return {
    gl: makeFakeGl(),
    res: { width: 1024, height: 768 },
    compileFragment: () => ({}) as WebGLProgram,
    createFbo: () => ({ fbo: {} as WebGLFramebuffer, texture: {} as WebGLTexture }),
    createFloatFbo: () => ({ fbo: {} as WebGLFramebuffer, texture: {} as WebGLTexture, isFloat: false, width: 1024, height: 768 }),
    drawFullscreenQuad: () => undefined,
  };
}

function makeFrameCtx(frameNo: number): VideoFrameContext {
  return {
    gl: makeFakeGl(),
    time: frameNo / 60,
    frame: frameNo,
    getInputTexture: () => null,
  };
}

describe('TOYBOX CV modulation does NOT write through to the synced Y.Doc (leak guard)', () => {
  // The factory kicks off a one-shot ensureToyboxCatalog() → fetch('/toybox/
  // manifest.json'), which has no URL base in jsdom. Stub fetch to an empty-but-
  // valid manifest so that async load resolves cleanly (this test exercises the
  // combine/CV path, not shader content). Scoped to this block.
  beforeAll(() => {
    vi.stubGlobal('fetch', async () =>
      ({ ok: true, status: 200, statusText: 'OK', json: async () => ({ shaders: [], gen: [], models: [], presets: [] }) }) as unknown as Response,
    );
  });
  afterAll(() => { vi.unstubAllGlobals(); });

  afterEach(() => {
    delete patch.nodes[RTID];
    for (const id of Object.keys(patch.edges)) delete patch.edges[id];
  });

  it('firing setParam(cvN) repeatedly leaves the store combine param + Y.Doc untouched', () => {
    // Seed a real TOYBOX node with the default combine graph and a CV route
    // cv1 → combine op1.amount, plus an inbound cv cable so kindFor()='cv'.
    const combine = makeDefaultCombineGraph();
    patch.nodes[RTID] = {
      id: RTID,
      type: 'toybox',
      domain: 'video',
      position: { x: 0, y: 0 },
      params: {},
      data: {
        combine,
        cvRoutes: { cv1: { target: 'combine', nodeId: 'op1', param: 'amount' } },
        cvInputs: { cv1: { scale: 1, offset: 0 } },
      },
    } as unknown as ModuleNode;
    patch.edges['e-cv'] = {
      id: 'e-cv',
      source: { nodeId: 'lfo-x', portId: 'phase0' },
      target: { nodeId: RTID, portId: 'cv1' },
      sourceType: 'cv',
    } as unknown as Edge;

    // The authored store value before any modulation.
    const storedBefore = (patch.nodes[RTID]!.data as { combine: { nodes: Array<{ id: string; params?: Record<string, number> }> } })
      .combine.nodes.find((n) => n.id === 'op1')!.params!.amount;
    expect(storedBefore).toBe(0);

    // Count Y.Doc updates across the whole CV-drive window — the leak's mechanism.
    let docUpdates = 0;
    const onUpdate = () => { docUpdates++; };
    ydoc.on('update', onUpdate);
    try {
      const handle = toyboxDef.factory(makeToyboxCtx(), patch.nodes[RTID] as ModuleNode);
      // Drive the CV-bridge entry point + a draw each frame, like the engine.
      for (let f = 0; f < 120; f++) {
        handle.setParam('cv1', Math.sin(f / 7)); // a swinging modulator
        handle.surface.draw(makeFrameCtx(f));
      }
      handle.dispose();
    } finally {
      ydoc.off('update', onUpdate);
    }

    // (a) The SYNCED + PERSISTED store value is unchanged — CV modulation is
    //     transient and must not ride save / multiplayer.
    const storedAfter = (patch.nodes[RTID]!.data as { combine: { nodes: Array<{ id: string; params?: Record<string, number> }> } })
      .combine.nodes.find((n) => n.id === 'op1')!.params!.amount;
    expect(storedAfter).toBe(0);

    // (b) ZERO Y.Doc updates from 120 frames of active CV modulation. Before the
    //     fix this was ~120 (one per frame) → the snapshot/SvelteFlow re-render
    //     storm that leaked detached edge SVG.
    expect(docUpdates).toBe(0);
  });
});

describe('FEEDBACK fragment shader (the stateful op program)', () => {
  it('declares the feedback + input samplers + the per-mode uniforms', () => {
    const src = __FEEDBACK_FRAG_SRC_FOR_TEST;
    expect(src).toContain('uniform sampler2D uFeedback'); // previous frame
    expect(src).toContain('uniform sampler2D uInput'); // upstream in0
    expect(src).toContain('uniform int   uMode');
    for (const u of ['uZoom', 'uRotate', 'uScaleP', 'uTx', 'uTy', 'uDecay', 'uGain', 'uThresh', 'uHue', 'uBlur', 'uSlitPos', 'uSlitWidth', 'uFlow', 'uIntensity']) {
      expect(src, `declares ${u}`).toContain(u);
    }
  });
  it('declares + reads the wet/dry uIntensity uniform', () => {
    const src = __FEEDBACK_FRAG_SRC_FOR_TEST;
    expect(src).toContain('uniform float uIntensity;');
    // It is actually consumed (not just declared): the wet/dry mix references it.
    expect(src).toContain('uIntensity');
    expect((src.match(/uIntensity/g) ?? []).length).toBeGreaterThan(1);
  });
  it('TUNNEL drives its wet/dry mix off uIntensity (no flat-everywhere blend)', () => {
    // The TUNNEL branch ends in the wet/dry mix `mix(src.rgb, hall, uIntensity)`
    // (at full wet = the pure recursive hall; at full dry = the live input). The
    // recursive Droste tap (single ring-gated feedback sample) replaced the prior
    // unrolled HOM_LEVELS composite, which over-blended the flat full-frame source.
    const src = __FEEDBACK_FRAG_SRC_FOR_TEST;
    const tunnel = src.slice(src.indexOf('if (uMode == 0)'), src.indexOf('} else if (uMode == 1)'));
    expect(tunnel).toMatch(/mix\(\s*src\.rgb\s*,\s*hall\s*,\s*uIntensity\s*\)/);
    // The prior implementation's flat-source over-composite must be GONE.
    expect(tunnel).not.toContain('HOM_LEVELS');
    expect(tunnel).not.toContain('0.10 + 0.35 * src.a');
  });
  it('switches on every one of the 12 modes (uMode == 0 .. 10, else = 11)', () => {
    const src = __FEEDBACK_FRAG_SRC_FOR_TEST;
    // Modes 0..10 are explicit `uMode == N`; mode 11 is the trailing else.
    for (let m = 0; m < FEEDBACK_MODE_COUNT - 1; m++) {
      expect(src, `handles uMode == ${m}`).toContain(`uMode == ${m}`);
    }
    // The trailing else covers the last mode (VECTOR, id 11).
    expect(src).toContain('} else {');
  });

  it('TUNNEL (mode 0) is a ring-gated hall-of-mirrors, NOT a flat-source blend', () => {
    // Guard the TUNNEL fix at the SHADER-SOURCE level: the live source must enter
    // only via the new outer RING; the interior is the recursive feedback tap. The
    // prior implementations blended the flat full-frame source into the interior —
    // those exact shapes (`0.12 + 0.5 * src.a` and `0.10 + 0.35 * src.a`) must NOT
    // return.
    const src = __FEEDBACK_FRAG_SRC_FOR_TEST;
    const tunnel = src.slice(src.indexOf('if (uMode == 0)'), src.indexOf('} else if (uMode == 1)'));
    // It samples the previous frame at a zoomed/rotated tap (the recursion)…
    expect(tunnel).toMatch(/fb\(\s*fuv\s*\)/);
    // …gates the live source to the band that leaves the previous frame (the ring),
    expect(tunnel).toMatch(/ring/);
    expect(tunnel).toMatch(/fuv\.x\s*<\s*0\.0|fuv\.x\s*>\s*1\.0/);
    // …and decays the recursive interior (persistence toward the vanishing point).
    expect(tunnel).toMatch(/uDecay/);
    // The flat-into-interior blends from BOTH prior versions must be GONE.
    expect(tunnel).not.toContain('0.12 + 0.5 * src.a');
    expect(tunnel).not.toContain('0.10 + 0.35 * src.a');
  });
});
