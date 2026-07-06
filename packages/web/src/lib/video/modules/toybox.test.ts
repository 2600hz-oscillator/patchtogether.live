// packages/web/src/lib/video/modules/toybox.test.ts
//
// Def-shape coverage for the TOYBOX module (the 6-input modulation section).
// The GL render pipeline is exercised by E2E/VRT (jsdom can't render shaders);
// here we pin the port surface — that the 6 generic modulation input ports exist
// (type `modsignal`, so they accept cv/gate/audio) with the neutral linear hint
// + no paramTarget (routing is dynamic, handled in setParam) — so a regression
// that drops a port or re-narrows the type fails a fast unit test.

import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { toyboxDef, __FEEDBACK_FRAG_SRC_FOR_TEST } from './toybox';
import { CV_PORT_IDS } from '$lib/video/toybox-cv-routes';
import { FEEDBACK_MODE_COUNT } from '$lib/video/toybox-feedback';
import { patch, ydoc, undoManager } from '$lib/graph/store';
import * as Y from 'yjs';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import { setLayerMaterialField } from '$lib/graph/toybox-layers';
import { LAYER_COUNT as LAYER_COUNT_FOR_TEST } from '$lib/video/toybox-content';
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

// ---------------------------------------------------------------------------
// BATCH-OP CV TARGETING — a cv route into a batch-op param drives the live
// (render-local) combine param. Downgraded here from e2e/toybox-node-batch.spec
// ('TOYBOX batch op nodes — CV targeting'): the old e2e read node.data.combine
// after the cv drive and asserted the STORE value changed, which is now
// architecturally WRONG — CV modulation writes ONLY the render-local clone
// (read('liveModulated')), never the synced Y.Doc (the leak fix above). This
// drives the REAL toyboxDef factory's setParam(cvN) hot-path and reads the
// post-modulation param off read('liveModulated').combine — the same engine-
// internal read the toybox-cv-routing e2e asserts on — so a broken cv route /
// resolveRoute / effectiveCvValue wiring fails this fast unit test (no render).
// ---------------------------------------------------------------------------

const CVID = 'toybox-cv-targeting';

/** Build a combine graph: src0 -> the op node -> output, so the op's params are
 *  addressable by a cvRoute { target:'combine', nodeId:'op', param }. */
function combineWithOp(kind: string): unknown {
  return {
    nodes: [
      { id: 'src0', kind: 'source', layer: 0, x: 14, y: 14 },
      { id: 'op', kind, x: 120, y: 14, params: {} },
      { id: 'out', kind: 'output', x: 286, y: 66 },
    ],
    edges: [
      { id: 'e0', from: 'src0', to: 'op', toPort: 'in0' },
      { id: 'eo', from: 'op', to: 'out', toPort: 'in0' },
    ],
  };
}

describe('TOYBOX batch-op CV targeting drives the render-local combine param', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', async () =>
      ({ ok: true, status: 200, statusText: 'OK', json: async () => ({ shaders: [], gen: [], models: [], presets: [] }) }) as unknown as Response,
    );
  });
  afterAll(() => { vi.unstubAllGlobals(); });
  afterEach(() => {
    delete patch.nodes[CVID];
    for (const id of Object.keys(patch.edges)) delete patch.edges[id];
  });

  // Each entry: the op kind, the CV-routed param, and the param's [min,max].
  // cv=+1 → foldCvToUnipolar(1)=1 → effective = max (scale 1, offset 0);
  // cv=−1 → fold(−1)=0 → effective = min.
  for (const { kind, param, min, max } of [
    { kind: 'tile', param: 'tilesX', min: 1, max: 16 },
    { kind: 'biocells', param: 'cellCount', min: 4, max: 64 },
    { kind: 'framedelay', param: 'mix', min: 0, max: 1 },
    { kind: 'flowsmear', param: 'persistence', min: 0, max: 1 },
  ] as const) {
    it(`${kind}.${param}: a cv2 route + drive modulates the live param (max→min), not the store`, () => {
      patch.nodes[CVID] = {
        id: CVID,
        type: 'toybox',
        domain: 'video',
        position: { x: 0, y: 0 },
        params: {},
        data: {
          combine: combineWithOp(kind),
          cvRoutes: { cv2: { target: 'combine', nodeId: 'op', param } },
          cvInputs: { cv2: { scale: 1, offset: 0 } },
        },
      } as unknown as ModuleNode;
      // An inbound cv cable so the factory's kindFor('cv2') sees a patched cv port
      // (only edge.target + edge.sourceType are read).
      patch.edges['e-cv2'] = {
        id: 'e-cv2',
        source: { nodeId: 'lfo', portId: 'out' },
        target: { nodeId: CVID, portId: 'cv2' },
        sourceType: 'cv',
      } as unknown as Edge;

      const handle = toyboxDef.factory(makeToyboxCtx(), patch.nodes[CVID] as ModuleNode);
      try {
        const liveParam = (): number | undefined => {
          const lm = handle.read?.('liveModulated') as
            | { combine?: { nodes?: Array<{ id: string; params?: Record<string, number> }> } }
            | undefined;
          return lm?.combine?.nodes?.find((n) => n.id === 'op')?.params?.[param];
        };

        // Drive cv2 to +1 → the param resolves to its MAX in the render-local clone.
        handle.setParam('cv2', 1);
        handle.surface.draw(makeFrameCtx(0));
        expect(liveParam(), `${kind}.${param} cv=+1 → max`).toBeCloseTo(max, 1);

        // Drive cv2 to −1 → the param resolves to its MIN (well under max/2).
        handle.setParam('cv2', -1);
        handle.surface.draw(makeFrameCtx(1));
        const lo = liveParam();
        expect(lo, `${kind}.${param} cv=−1 → min`).toBeCloseTo(min, 1);
        expect(lo!, `${kind}.${param} cv=−1 is well below max`).toBeLessThan(max * 0.5 + 0.001);

        // The SYNCED store value is NEVER written by CV modulation (the leak fix):
        // the op node in node.data.combine keeps its authored (empty) params.
        const storedOp = (patch.nodes[CVID]!.data as {
          combine: { nodes: Array<{ id: string; params?: Record<string, number> }> };
        }).combine.nodes.find((n) => n.id === 'op');
        expect(storedOp?.params?.[param], 'store param untouched by CV').toBeUndefined();
      } finally {
        handle.dispose();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// CV/MODULATION SECTION — the full setParam → applyCvRoute → kindFor →
// resolveRoute → effectiveCvValue → apply wiring, plus applyUnpatchedOffsets.
//
// Downgraded here from e2e/toybox-cv-routing.spec.ts (DOWNGRADE → behavioral,
// webgl-suite-optimization §2/§7-3). The e2e booted a full 90s WebGL TOYBOX,
// seeded routes on node.data, drove the engine's REAL setParam each frame, and
// read the moved param off read('liveModulated') — but the assertions are pure
// numeric param math (no pixels). This drives the SAME real toyboxDef factory
// setParam path and reads the SAME read('liveModulated') channel with NO render
// and NO GPU boot, so a broken kindFor / resolveRoute / effectiveCvValue /
// scale-offset / applyUnpatchedOffsets wiring fails this fast unit test.
//
// (The e2e's only DOM-unique assertion — the cv2 badge auto-detecting AUDIO from
// the inbound edge sourceType — is covered by toybox-cv-section.spec, which owns
// the in-card target/param select + badge UI. The layer-CONTENT-uniform route
// branch — cv1 → 'speed' — depends on the fetched manifest (stubbed empty here),
// and its resolveRoute branch is owned by toybox-cv-routes' unit tests; the
// WIRING this guard covers is target-type-agnostic, exercised via combine + obj
// targets whose ranges are static in code.)
// ---------------------------------------------------------------------------

const ROUTEID = 'toybox-cv-routing-dg';

/** A combine graph with a fade op (range [0,1]) addressable as combine:xf.amount
 *  and an obj layer (layer 2) so material:spin (range [0,3]) resolves. */
function routingNode(id: string): ModuleNode {
  return {
    id,
    type: 'toybox',
    domain: 'video',
    position: { x: 0, y: 0 },
    params: {},
    data: {
      layers: [
        // layers 0/1 unused by these routes (cv2→combine, cv3→obj at layer 2);
        // keep them 'off' so no manifest content lookup runs (stub is empty).
        { kind: 'off', contentId: null, params: {} },
        { kind: 'off', contentId: null, params: {} },
        {
          kind: 'obj',
          contentId: null,
          params: {},
          material: { modelId: 'cube', rotX: 0.3, rotY: 0.6, rotZ: 0, scale: 1, spin: 0, matcap: 0, tintR: 1, tintG: 1, tintB: 1 },
        },
        { kind: 'off', contentId: null, params: {} },
      ],
      combine: {
        nodes: [
          { id: 'src0', kind: 'source', layer: 0, x: 14, y: 14 },
          { id: 'src1', kind: 'source', layer: 1, x: 14, y: 66 },
          { id: 'xf', kind: 'fade', x: 120, y: 40, params: { amount: 0.5 } },
          { id: 'out', kind: 'output', x: 286, y: 40 },
        ],
        edges: [
          { id: 'e0', from: 'src0', to: 'xf', toPort: 'in0' },
          { id: 'e1', from: 'src1', to: 'xf', toPort: 'in1' },
          { id: 'e2', from: 'xf', to: 'out', toPort: 'in0' },
        ],
      },
      cvRoutes: {},
      cvInputs: {},
    },
  } as unknown as ModuleNode;
}

/** Seed an inbound edge into a TOYBOX mod port with a given sourceType so the
 *  factory's kindFor() sees a patched port owned by the cv-bridge. */
function seedEdge(eid: string, port: string, sourceType: string): void {
  patch.edges[eid] = {
    id: eid,
    source: { nodeId: 'lfo', portId: 'out' },
    target: { nodeId: ROUTEID, portId: port },
    sourceType,
  } as unknown as Edge;
}

describe('TOYBOX CV/modulation wiring (setParam → resolved param)', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', async () =>
      ({ ok: true, status: 200, statusText: 'OK', json: async () => ({ shaders: [], gen: [], models: [], presets: [] }) }) as unknown as Response,
    );
  });
  afterAll(() => { vi.unstubAllGlobals(); });
  afterEach(() => {
    delete patch.nodes[ROUTEID];
    for (const id of Object.keys(patch.edges)) delete patch.edges[id];
  });

  /** Read the resolved combine fade amount off read('liveModulated'). */
  function liveAmount(handle: ReturnType<typeof toyboxDef.factory>): number | undefined {
    const lm = handle.read?.('liveModulated') as
      | { combine?: { nodes?: Array<{ id: string; params?: Record<string, number> }> } }
      | undefined;
    return lm?.combine?.nodes?.find((n) => n.id === 'xf')?.params?.amount;
  }
  /** Read the resolved obj material spin off read('liveModulated'). */
  function liveSpin(handle: ReturnType<typeof toyboxDef.factory>): number | undefined {
    const lm = handle.read?.('liveModulated') as
      | { layers?: Array<{ material?: { spin?: number } }> }
      | undefined;
    return lm?.layers?.[2]?.material?.spin;
  }

  it('cv→combine + cv→obj: a +1/0/−1 cv sweep folds to max/mid/min on the routed param', () => {
    const node = routingNode(ROUTEID);
    (node.data as Record<string, unknown>).cvRoutes = {
      cv2: { target: 'combine', nodeId: 'xf', param: 'amount' },
      cv3: { target: 'layer', layer: 2, param: 'material:spin' },
    };
    (node.data as Record<string, unknown>).cvInputs = { cv2: { scale: 1, offset: 0 }, cv3: { scale: 1, offset: 0 } };
    // Assign into the reactive store, then drive the STORE node (livePatch reads
    // a proxied copy — the local `node` ref is NOT the store object).
    patch.nodes[ROUTEID] = node;
    seedEdge('e2', 'cv2', 'cv');
    seedEdge('e3', 'cv3', 'cv');

    const handle = toyboxDef.factory(makeToyboxCtx(), patch.nodes[ROUTEID] as ModuleNode);
    try {
      // cv2 = +1 → fold(1)=1 → fade amount = max (1).
      handle.setParam('cv2', 1);
      handle.surface.draw(makeFrameCtx(0));
      expect(liveAmount(handle), 'cv2=+1 → fade max').toBeCloseTo(1, 2);
      // cv2 = -1 → fold(-1)=0 → min (0).
      handle.setParam('cv2', -1);
      handle.surface.draw(makeFrameCtx(1));
      expect(liveAmount(handle), 'cv2=-1 → fade min').toBeCloseTo(0, 2);
      // cv2 = 0 → fold(0)=0.5 → midpoint (0.5).
      handle.setParam('cv2', 0);
      handle.surface.draw(makeFrameCtx(2));
      expect(liveAmount(handle), 'cv2=0 → fade midpoint').toBeCloseTo(0.5, 2);

      // cv3 = +1 → material:spin max (3). cv3 = -1 → min (0).
      handle.setParam('cv3', 1);
      handle.surface.draw(makeFrameCtx(3));
      expect(liveSpin(handle), 'cv3=+1 → spin max').toBeCloseTo(3, 1);
      handle.setParam('cv3', -1);
      handle.surface.draw(makeFrameCtx(4));
      expect(liveSpin(handle), 'cv3=-1 → spin min').toBeCloseTo(0, 1);
    } finally {
      handle.dispose();
    }
  });

  it('attenuverter SCALE inverts; an AUDIO source is detected + taken as a 0..1 envelope (not folded)', () => {
    const node = routingNode(ROUTEID);
    (node.data as Record<string, unknown>).cvRoutes = {
      cv2: { target: 'combine', nodeId: 'xf', param: 'amount' }, // CV, inverted
      cv4: { target: 'combine', nodeId: 'xf', param: 'amount' }, // AUDIO (drives same param)
    };
    (node.data as Record<string, unknown>).cvInputs = { cv2: { scale: -1, offset: 1 }, cv4: { scale: 1, offset: 0 } };
    patch.nodes[ROUTEID] = node;
    seedEdge('e2', 'cv2', 'cv');
    seedEdge('e4', 'cv4', 'audio');

    const handle = toyboxDef.factory(makeToyboxCtx(), patch.nodes[ROUTEID] as ModuleNode);
    try {
      // cv2 SCALE -1 OFFSET 1: a rising cv LOWERS the param.
      // cv = +1 → fold→1 → norm = clamp(1*-1+1)=0 → amount min (0).
      handle.setParam('cv2', 1);
      handle.surface.draw(makeFrameCtx(0));
      expect(liveAmount(handle), 'cv2 inverted: +1 → min').toBeCloseTo(0, 2);
      // cv = -1 → fold→0 → norm = clamp(0*-1+1)=1 → amount max (1).
      handle.setParam('cv2', -1);
      handle.surface.draw(makeFrameCtx(1));
      expect(liveAmount(handle), 'cv2 inverted: -1 → max').toBeCloseTo(1, 2);

      // cv4 is an AUDIO source → kindFor='audio' → the value is taken as an
      // already-0..1 envelope (NOT folded). 0.75 → amount 0.75.
      handle.setParam('cv4', 0.75);
      handle.surface.draw(makeFrameCtx(2));
      expect(liveAmount(handle), 'audio envelope 0.75 → amount 0.75 (not folded)').toBeCloseTo(0.75, 2);
    } finally {
      handle.dispose();
    }
  });

  it('OFFSET on an UNPATCHED routed port drives the param each frame (manual control, no cable)', () => {
    const node = routingNode(ROUTEID);
    (node.data as Record<string, unknown>).cvRoutes = { cv5: { target: 'combine', nodeId: 'xf', param: 'amount' } };
    (node.data as Record<string, unknown>).cvInputs = { cv5: { scale: 1, offset: 0.5 } }; // no inbound edge on cv5
    patch.nodes[ROUTEID] = node;
    // Intentionally NO edge on cv5 → applyUnpatchedOffsets owns the write.

    const stored = patch.nodes[ROUTEID] as ModuleNode;
    const handle = toyboxDef.factory(makeToyboxCtx(), stored);
    try {
      // draw() runs applyUnpatchedOffsets (frozenTime() === null in this ctx).
      handle.surface.draw(makeFrameCtx(0));
      expect(liveAmount(handle), 'OFFSET 0.5 → amount 0.5 (signal 0)').toBeCloseTo(0.5, 2);

      // Raise OFFSET to 0.9 ON THE STORE NODE → the param tracks it next frame.
      (stored.data as { cvInputs: Record<string, { scale: number; offset: number }> }).cvInputs.cv5.offset = 0.9;
      handle.surface.draw(makeFrameCtx(1));
      expect(liveAmount(handle), 'OFFSET 0.9 → amount 0.9').toBeCloseTo(0.9, 2);
    } finally {
      handle.dispose();
    }
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

// ---------------------------------------------------------------------------
// TRANSIENT KNOB/CC setParam — the MIDI-CC render-starvation fix.
//
// TOYBOX layer/material/combine params have NO reconciler push path (they live
// in node.data; the reconciler diffs node.params only) — historically they
// reached the render ONLY via the per-message store write, which is exactly
// the write storm the CC coalescer (cc-commit.ts) removes. handle.setParam now
// also accepts the layer-qualified ('layer:<i>:<param>') / combine
// ('combine:<op>:<param>') / bare-material ids the card's knobs pass to
// MIDI-learn + control surfaces, applied to the RENDER-LOCAL clone exactly
// like applyCvRoute (the #719 invariant: per-message writes never touch the
// Y.Doc). The settled store commit then flips the liveLayers change key and
// re-syncs the clone — so the store re-apply is idempotent with the transient.
// ---------------------------------------------------------------------------

const TRID = 'toybox-transient-param';

describe('TOYBOX transient knob/CC setParam (layer-qualified) — render-local only', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', async () =>
      ({ ok: true, status: 200, statusText: 'OK', json: async () => ({ shaders: [], gen: [], models: [], presets: [] }) }) as unknown as Response,
    );
  });
  afterAll(() => { vi.unstubAllGlobals(); });

  afterEach(() => {
    delete patch.nodes[TRID];
    for (const id of Object.keys(patch.edges)) delete patch.edges[id];
  });

  function seedObjToybox(): void {
    patch.nodes[TRID] = {
      id: TRID,
      type: 'toybox',
      domain: 'video',
      position: { x: 0, y: 0 },
      params: {},
      data: {
        layers: [
          { kind: 'obj', contentId: null, params: {}, material: { modelId: 'cube', rotX: 0.3, rotY: 0.6, scale: 1 } },
        ],
        combine: makeDefaultCombineGraph(),
      },
    } as unknown as ModuleNode;
  }

  type LiveModulated = {
    layers: Array<{ material?: Record<string, number> }>;
    combine: { nodes: Array<{ id: string; params?: Record<string, number> }> };
  };

  it('a 250-message layer:0:rotX stream drives the clone per message with ZERO Y.Doc updates', () => {
    seedObjToybox();
    const storedBefore = ((patch.nodes[TRID]!.data as { layers: Array<{ material: Record<string, number> }> })
      .layers[0]!.material.rotX);
    expect(storedBefore).toBe(0.3);

    let docUpdates = 0;
    const onUpdate = () => { docUpdates++; };
    ydoc.on('update', onUpdate);
    let lastSent = 0;
    try {
      const handle = toyboxDef.factory(makeToyboxCtx(), patch.nodes[TRID] as ModuleNode);
      for (let i = 0; i < 250; i++) {
        lastSent = -3.14159 + (i / 249) * 6.28318;
        handle.setParam('layer:0:rotX', lastSent);
      }
      // The ENGINE sees the last transient value (the render pulls the clone)…
      const lm = handle.read?.('liveModulated') as LiveModulated;
      expect(lm.layers[0]!.material!.rotX).toBeCloseTo(lastSent, 6);
      handle.dispose();
    } finally {
      ydoc.off('update', onUpdate);
    }

    // …while the SYNCED store value + Y.Doc are untouched (the durable value
    // lands via the coalesced settle commit, not here).
    const storedAfter = ((patch.nodes[TRID]!.data as { layers: Array<{ material: Record<string, number> }> })
      .layers[0]!.material.rotX);
    expect(storedAfter).toBe(0.3);
    expect(docUpdates).toBe(0);
  });

  it('the settled store commit re-syncs the clone (idempotent with the transient value)', () => {
    seedObjToybox();
    const handle = toyboxDef.factory(makeToyboxCtx(), patch.nodes[TRID] as ModuleNode);
    handle.setParam('layer:0:rotX', 1.25);
    let lm = handle.read?.('liveModulated') as LiveModulated;
    expect(lm.layers[0]!.material!.rotX).toBeCloseTo(1.25, 6);

    // Simulate the trailing settle commit: the SAME value lands in the store
    // (what setLayerMaterialField does at commit time).
    (patch.nodes[TRID]!.data as { layers: Array<{ material: Record<string, number> }> })
      .layers[0]!.material.rotX = 1.25;

    // The change-key flip re-clones from the store — same value, no snap.
    lm = handle.read?.('liveModulated') as LiveModulated;
    expect(lm.layers[0]!.material!.rotX).toBeCloseTo(1.25, 6);
    handle.dispose();
  });

  it('combine:<op>:<param> + bare material ids resolve; unknown ids are ignored', () => {
    seedObjToybox();
    const handle = toyboxDef.factory(makeToyboxCtx(), patch.nodes[TRID] as ModuleNode);

    // Combine op param (the default graph ships op1 with an `amount`).
    handle.setParam('combine:op1:amount', 0.9);
    let lm = handle.read?.('liveModulated') as LiveModulated;
    expect(lm.combine.nodes.find((n) => n.id === 'op1')!.params!.amount).toBeCloseTo(0.9, 6);

    // Bare material id (legacy binding shape) → first OBJ layer.
    handle.setParam('scale', 2.5);
    lm = handle.read?.('liveModulated') as LiveModulated;
    expect(lm.layers[0]!.material!.scale).toBeCloseTo(2.5, 6);

    // Unknown / unresolvable ids are silently ignored (as before).
    expect(() => handle.setParam('layer:9:rotX', 1)).not.toThrow();
    expect(() => handle.setParam('not-a-param', 1)).not.toThrow();
    handle.dispose();
  });
});

// ---------------------------------------------------------------------------
// OBSERVER REV-KEYS (phase-2 MIDI-CC perf fix) — liveLayers()/liveCombineRaw()
// change detection now rides an engine-transient observeDeep rev counter on
// the node's Y.Map instead of stringifying the whole layers blob per call
// (with image layers that was up to ~1.3MB of JSON.stringify per call,
// 2-10×/frame). These tests pin:
//   - hot path = ZERO stringify + stable clone reference between writes
//   - settled-commit echo of a transient-applied value = value-equal no-op
//     (no re-clone, CV/transient values on SIBLING params preserved)
//   - invalidation still fires for real edits, REMOTE peer edits (observers
//     cover Y.applyUpdate) and UNDO (inverse ops never re-run the setters)
//   - structural layer edits degrade to the padded full re-clone
//   - a NON-store-backed node keeps the legacy stringify fallback
// ---------------------------------------------------------------------------

const REVID = 'toybox-rev-keys';

describe('TOYBOX observer rev-keys (liveLayers change detection)', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', async () =>
      ({ ok: true, status: 200, statusText: 'OK', json: async () => ({ shaders: [], gen: [], models: [], presets: [] }) }) as unknown as Response,
    );
  });
  afterAll(() => { vi.unstubAllGlobals(); });

  afterEach(() => {
    if (patch.nodes[REVID]) delete patch.nodes[REVID];
    for (const id of Object.keys(patch.edges)) delete patch.edges[id];
  });

  function seedRevToybox(): void {
    patch.nodes[REVID] = {
      id: REVID,
      type: 'toybox',
      domain: 'video',
      position: { x: 0, y: 0 },
      params: {},
      data: {
        // Fully LAYER_COUNT-padded, like any card-edited patch: the
        // toybox-layers setters pad in place on first touch, and that pad IS
        // a structural (full-reclone) event — seeding padded keeps these
        // tests focused on the leaf/echo semantics.
        layers: [
          { kind: 'obj', contentId: null, params: {}, material: { modelId: 'cube', rotX: 0.3, rotY: 0.6, scale: 1 } },
          { kind: 'off', contentId: null, params: {} },
          { kind: 'off', contentId: null, params: {} },
          { kind: 'off', contentId: null, params: {} },
        ],
        combine: makeDefaultCombineGraph(),
      },
    } as unknown as ModuleNode;
  }

  type LiveModulated = {
    layers: Array<{ kind?: string; material?: Record<string, number> }>;
    combine: { nodes: Array<{ id: string; params?: Record<string, number> }> };
  };

  it('hot path: repeated reads with no writes return the SAME clone with ZERO JSON.stringify', () => {
    seedRevToybox();
    const handle = toyboxDef.factory(makeToyboxCtx(), patch.nodes[REVID] as ModuleNode);
    // Prime the clone (first read may stringify/parse once for the clone).
    const first = (handle.read?.('liveModulated') as LiveModulated).layers;
    const spy = vi.spyOn(JSON, 'stringify');
    for (let i = 0; i < 20; i++) {
      const lm = handle.read?.('liveModulated') as LiveModulated;
      expect(lm.layers).toBe(first); // stable reference — no per-frame re-key
    }
    // The whole point: the per-frame change-detect no longer serializes the
    // layers blob (base64 imageBytes included) on every pull.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    handle.dispose();
  });

  it('settle echo is a value-equal NO-OP: no re-clone, transient values on sibling params survive', () => {
    seedRevToybox();
    const handle = toyboxDef.factory(makeToyboxCtx(), patch.nodes[REVID] as ModuleNode);
    // Transient CC leg applies rotX AND a sibling (rotY) to the clone.
    handle.setParam('layer:0:rotX', 1.25);
    handle.setParam('layer:0:rotY', 2.0);
    const before = (handle.read?.('liveModulated') as LiveModulated).layers;
    expect(before[0]!.material!.rotX).toBeCloseTo(1.25, 6);

    // The settled store commit echoes the SAME rotX value.
    setLayerMaterialField(REVID, 0, 'rotX', 1.25);

    const after = (handle.read?.('liveModulated') as LiveModulated).layers;
    // Same clone object — the echo neither re-cloned nor reset anything…
    expect(after).toBe(before);
    expect(after[0]!.material!.rotX).toBeCloseTo(1.25, 6);
    // …and the CV/transient value on the SIBLING param is preserved (a full
    // re-clone would have snapped it back to the stored 0.6).
    expect(after[0]!.material!.rotY).toBeCloseTo(2.0, 6);
    handle.dispose();
  });

  it('a REAL store change invalidates: the clone reflects the new value', () => {
    seedRevToybox();
    const handle = toyboxDef.factory(makeToyboxCtx(), patch.nodes[REVID] as ModuleNode);
    handle.setParam('layer:0:rotX', 1.25); // transient
    setLayerMaterialField(REVID, 0, 'rotX', 0.9); // user turns the knob elsewhere
    const lm = handle.read?.('liveModulated') as LiveModulated;
    expect(lm.layers[0]!.material!.rotX).toBeCloseTo(0.9, 6);
    handle.dispose();
  });

  it('a REMOTE peer edit invalidates (observeDeep covers Y.applyUpdate)', () => {
    seedRevToybox();
    const handle = toyboxDef.factory(makeToyboxCtx(), patch.nodes[REVID] as ModuleNode);
    // Prime the clone.
    expect((handle.read?.('liveModulated') as LiveModulated).layers[0]!.material!.rotX).toBeCloseTo(0.3, 6);

    // Second client: sync the doc state, edit the layer, ship the diff back.
    const remote = syncedStore<{ nodes: Record<string, ModuleNode>; edges: Record<string, Edge> }>({ nodes: {}, edges: {} });
    const remoteDoc = getYjsDoc(remote);
    Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(ydoc));
    ((remote.nodes[REVID]!.data as { layers: Array<{ material: Record<string, number> }> })
      .layers[0]!.material).rotX = -2.5;
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remoteDoc, Y.encodeStateVector(ydoc)));

    const lm = handle.read?.('liveModulated') as LiveModulated;
    expect(lm.layers[0]!.material!.rotX).toBeCloseTo(-2.5, 6);
    handle.dispose();
  });

  it('UNDO invalidates (inverse Y ops never re-run the toybox-layers setters)', () => {
    seedRevToybox();
    const handle = toyboxDef.factory(makeToyboxCtx(), patch.nodes[REVID] as ModuleNode);
    undoManager.stopCapturing();
    undoManager.clear();
    setLayerMaterialField(REVID, 0, 'rotX', 2.75); // tracked LOCAL_ORIGIN edit
    expect((handle.read?.('liveModulated') as LiveModulated).layers[0]!.material!.rotX).toBeCloseTo(2.75, 6);
    undoManager.stopCapturing();
    undoManager.undo();
    const lm = handle.read?.('liveModulated') as LiveModulated;
    expect(lm.layers[0]!.material!.rotX).toBeCloseTo(0.3, 6); // reverted + clone re-synced
    handle.dispose();
  });

  it('structural layers replacement degrades to the padded full re-clone', () => {
    seedRevToybox();
    const handle = toyboxDef.factory(makeToyboxCtx(), patch.nodes[REVID] as ModuleNode);
    handle.setParam('layer:0:rotY', 2.0); // transient value that must NOT survive a structural reset
    ydoc.transact(() => {
      (patch.nodes[REVID]!.data as { layers: unknown }).layers = [
        { kind: 'off', contentId: null, params: {} },
        { kind: 'obj', contentId: null, params: {}, material: { modelId: 'cube', rotX: 1.1, scale: 1 } },
      ];
    });
    const lm = handle.read?.('liveModulated') as LiveModulated;
    expect(lm.layers).toHaveLength(LAYER_COUNT_FOR_TEST);
    expect(lm.layers[0]!.kind).toBe('off');
    expect(lm.layers[0]!.material?.rotY ?? 0).not.toBeCloseTo(2.0, 6);
    expect(lm.layers[1]!.material!.rotX).toBeCloseTo(1.1, 6);
    handle.dispose();
  });

  it('a NON-store-backed node keeps the stringify fallback (still change-detects)', () => {
    const bare = {
      id: 'toybox-bare-node',
      type: 'toybox',
      domain: 'video',
      position: { x: 0, y: 0 },
      params: {},
      data: {
        layers: [
          { kind: 'obj', contentId: null, params: {}, material: { modelId: 'cube', rotX: 0.3, scale: 1 } },
        ],
        combine: makeDefaultCombineGraph(),
      },
    } as unknown as ModuleNode;
    // NOT inserted into patch.nodes — the observer can't attach; the factory
    // must fall back to the legacy stringify change key.
    const handle = toyboxDef.factory(makeToyboxCtx(), bare);
    expect((handle.read?.('liveModulated') as LiveModulated).layers[0]!.material!.rotX).toBeCloseTo(0.3, 6);
    (bare.data as { layers: Array<{ material: Record<string, number> }> }).layers[0]!.material.rotX = 0.8;
    expect((handle.read?.('liveModulated') as LiveModulated).layers[0]!.material!.rotX).toBeCloseTo(0.8, 6);
    handle.dispose();
  });
});
