// packages/web/src/lib/ui/media/node-frame-producer-registry.test.ts
//
// THE ANCHOR for the node-lifetime PER-FRAME producer seam (legacy-removal S1).
//
// Two halves, and they fail for different reasons:
//
//   MEMBERSHIP — who owns what. Every sibling registry carries this shape
//   (derived-not-listed, real module defs, non-empty, exact, disjoint), and the
//   disjointness against `CARD_PRODUCER_LANE_TYPES` is what makes a producer
//   extraction ATOMIC: a commit that adds a producer without removing the type
//   from the card set reddens, and one that removes it without adding a producer
//   reddens on the derivation gate in `dom-source-modules.test.ts`.
//
//   MECHANISM — the lifetime. The registry runs ONE shared ticker over every
//   live producer node, and the failures worth catching are the ones a card
//   could not have: a node re-seated from a new graph snapshot, one producer
//   throwing and stopping the loop for the rest, a ticker that outlives the last
//   node, per-node scratch leaking across nodes.
//
// ⚠ WHAT THIS GATE CANNOT SEE, stated so a green run is not over-read: it drives
// the core with fakes. It cannot tell you a real rAF fires, that the engine
// really has a `cvCombined` channel, or that any picture moved. That is
// `e2e/tests/card-producer-lifetime.spec.ts`, which reads the module's own
// output texture across frames — the ONLY instrument that can see a producer
// that is registered, swept, counted and silent.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import '$lib/audio/modules';
import '$lib/video/modules';
import { getModuleDef } from '$lib/audio/module-registry';
import { getVideoModuleDef } from '$lib/video/module-registry';

import type { ModuleNode } from '$lib/graph/types';
import { CARD_PRODUCER_LANE_TYPES } from '$lib/ui/workflow/dom-source-modules';
import {
  FRAME_PRODUCERS,
  NODE_FRAME_PRODUCER_TYPES,
  SCOPE_FRAME_PRODUCER,
  SYNESTHESIA_FRAME_PRODUCER,
  TIMELORDE_FRAME_PRODUCER,
} from './frame-producers';
import {
  createNodeFrameProducerRegistry,
  frameProducerTypes,
  type FrameEnv,
  type FrameGraph,
  type FrameProducer,
  type FrameProducerEngine,
  type FrameSurface,
} from './node-frame-producer-registry';

const REGISTRY_SRC = readFileSync(
  fileURLToPath(new URL('./node-frame-producer-registry.ts', import.meta.url)),
  'utf8',
);

// ── FAKES ────────────────────────────────────────────────────────────────────

function node(id: string, type: string, params: Record<string, number> = {}): ModuleNode {
  return { id, type, domain: 'audio', params } as unknown as ModuleNode;
}

interface FakeEngine extends FrameProducerEngine {
  writes: Array<{ nodeId: string; key: string; value: unknown }>;
  params: Record<string, number>;
}

function fakeEngine(params: Record<string, number> = {}): FakeEngine {
  const writes: FakeEngine['writes'] = [];
  return {
    writes,
    params,
    read: () => undefined,
    readParam: (_n, paramId) => params[paramId],
    write: (n, key, value) => void writes.push({ nodeId: n.id, key, value }),
    blitVideoNode: () => null,
    videoSource: () => null,
  };
}

const noGraph: FrameGraph = { findSource: () => null, node: () => undefined };

/** The default host env: no reduced motion, no bitmaps, no images, and a clock
 *  the test can WIND BY HAND — the whole reason `nowMs` is injected rather than
 *  read from `performance`. */
let fakeNowMs = 0;
const env: FrameEnv = {
  prefersReducedMotion: () => false,
  nowMs: () => fakeNowMs,
  createImageBitmap: null,
  loadImage: () => Promise.resolve(null),
  createRaster: () => null,
};

/** A ticker the test drives by hand — the whole reason `tick()` is public. */
function harness(producers: readonly FrameProducer[], graph: FrameGraph = noGraph) {
  let started = 0;
  let stopped = 0;
  const surfaces: Array<{ nodeId: string; w: number; h: number }> = [];
  const registry = createNodeFrameProducerRegistry(
    producers,
    {
      createSurface(nodeId, _type, w, h) {
        surfaces.push({ nodeId, w, h });
        return { width: w, height: h, getContext: () => ({}) } as FrameSurface;
      },
      startTicker() {
        started++;
        return () => {
          stopped++;
        };
      },
      env,
    },
    graph,
  );
  return {
    registry,
    surfaces,
    get started() {
      return started;
    },
    get stopped() {
      return stopped;
    },
  };
}

// ── MEMBERSHIP ───────────────────────────────────────────────────────────────

describe('NODE_FRAME_PRODUCER_TYPES — who owns a module per-frame push', () => {
  it('is DERIVED from the producer list, never a second literal', () => {
    expect([...NODE_FRAME_PRODUCER_TYPES].sort()).toEqual(
      FRAME_PRODUCERS.map((p) => p.type).sort(),
    );
  });

  it('is NOT EMPTY — an empty owner set makes every disjointness claim vacuous', () => {
    expect(NODE_FRAME_PRODUCER_TYPES.size).toBeGreaterThan(0);
  });

  it('names only REAL module types — a renamed module reddens here', () => {
    const ghosts = [...NODE_FRAME_PRODUCER_TYPES].filter(
      (t) => !getModuleDef(t) && !getVideoModuleDef(t),
    );
    expect(ghosts, `owned type(s) with no registered def: ${ghosts.join(', ')}`).toEqual([]);
  });

  it('is exactly the extracted set, so a silent departure is visible in the diff', () => {
    // rasterize joined in legacy-removal S1.5 — the fourth departure from
    // CARD_PRODUCER_LANE_TYPES, and the first carrying TWO duties in one body
    // (the cvCombined push and the painter's advancing read).
    //
    // ⚠ foxy joined 2026-09-04 and it is the first member whose missing owner
    // was AUDIBLE — or rather, was not. Its `wavecel` worklet plays a wavetable
    // that only the factory's `bridgeTick()` rebuilds, and the sole caller of
    // that tick was a preview-drawing surface reading its rasters. Measured on
    // one patch, with that surface mounted and without it: maxPeak 1.0000
    // against 0.0000 over a 6 s window. Every earlier member went dark or stale
    // without its owner; this one went SILENT.
    expect([...NODE_FRAME_PRODUCER_TYPES].sort()).toEqual([
      'foxy',
      'rasterize',
      'scope',
      'synesthesia',
      'timelorde',
    ]);
  });

  it('⚠ is DISJOINT from CARD_PRODUCER_LANE_TYPES — the atomicity gate', () => {
    // The direction that costs. `CARD_PRODUCER_LANE_TYPES` means "this module's
    // card IS the producer, so keep it mounted off-screen"; this set means "a
    // node-scoped owner runs the push". A type in both would run the push TWICE
    // per frame from two lifetimes — and for `cvCombined` that is not even
    // detectable by looking at the picture, because both writers compute the
    // same record from the same engine. It would simply be a second owner
    // nobody could see, waiting for the two to diverge.
    const both = [...NODE_FRAME_PRODUCER_TYPES].filter((t) => CARD_PRODUCER_LANE_TYPES.has(t));
    expect(both, `type(s) claimed by BOTH a card and a node producer: ${both.join(', ')}`)
      .toEqual([]);
  });

  it('every producer declares a non-trivial `why` — the type demands it, this checks it MEANS something', () => {
    // `tsc` refuses a producer with no `why`; it cannot refuse an empty string.
    for (const p of FRAME_PRODUCERS) {
      expect(p.why.length, `${p.type}: why is too short to be a reason`).toBeGreaterThan(60);
      expect(p.type, `${p.type}: why should not merely restate the type`).toBeTruthy();
    }
  });

  it('frameProducerTypes is the derivation, and it is not a constant', () => {
    // PERMANENT NEGATIVE CONTROL over the instrument: a helper that returned a
    // fixed set would satisfy every assertion above.
    const synthetic: FrameProducer = { type: '__probe__', why: 'x', frame: () => {} };
    expect([...frameProducerTypes([synthetic])]).toEqual(['__probe__']);
    expect([...frameProducerTypes([])]).toEqual([]);
  });
});

// ── MECHANISM ────────────────────────────────────────────────────────────────

describe('createNodeFrameProducerRegistry — the shared-ticker lifetime', () => {
  const probeType = 'scope';

  function counting(): { producer: FrameProducer; seen: Array<{ id: string; params: Record<string, number> }> } {
    const seen: Array<{ id: string; params: Record<string, number> }> = [];
    return {
      seen,
      producer: {
        type: probeType,
        why: 'test probe',
        frame: (ctx) =>
          void seen.push({
            id: ctx.node.id,
            params: ctx.node.params as Record<string, number>,
          }),
      },
    };
  }

  it('runs a producer once per tick for every live node of its type, and NOT for others', () => {
    const { producer, seen } = counting();
    const h = harness([producer]);
    h.registry.sync([node('a', probeType), node('b', probeType), node('c', 'adsr')], fakeEngine());
    h.registry.tick();
    expect(seen.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('does NOTHING before an engine exists — a push into null is not a push', () => {
    const { producer, seen } = counting();
    const h = harness([producer]);
    h.registry.sync([node('a', probeType)], null);
    h.registry.tick();
    expect(seen).toEqual([]);
    // ...and starts as soon as one arrives, WITHOUT a graph change. A patch load
    // materializes the engine after the nodes, so a registry that only picked up
    // an engine on the next graph edit would sit idle on a freshly loaded rack.
    h.registry.sync([node('a', probeType)], fakeEngine());
    h.registry.tick();
    expect(seen.map((s) => s.id)).toEqual(['a']);
  });

  it('⚠ RE-SEATS the node every sync — the identity-stale proxy class', () => {
    // The snapshot hands out a NEW object per graph change. A registry holding
    // the first one would freeze every producer at the params the node had when
    // it appeared: knobs would move, the readout would move, the render would
    // not. Exactly the shape `yjs-proxy-stable-identity-defeats-derived` records.
    const { producer, seen } = counting();
    const h = harness([producer]);
    h.registry.sync([node('a', probeType, { timeMs: 20 })], fakeEngine());
    h.registry.tick();
    h.registry.sync([node('a', probeType, { timeMs: 99 })], fakeEngine());
    h.registry.tick();
    expect(seen.map((s) => s.params.timeMs)).toEqual([20, 99]);
  });

  it('gives each node its OWN scratch, for the whole life of the node', () => {
    // A `let` in a producer module would be shared by every node of that type —
    // the bug the card version could not have (one component per node) and the
    // one this shape is most likely to introduce.
    const producer: FrameProducer = {
      type: probeType,
      why: 'test probe',
      frame: (ctx) => {
        ctx.state.n = ((ctx.state.n as number | undefined) ?? 0) + 1;
      },
    };
    const h = harness([producer]);
    h.registry.sync([node('a', probeType), node('b', probeType)], fakeEngine());
    h.registry.tick();
    h.registry.tick();
    h.registry.sync([node('a', probeType), node('b', probeType), node('c', probeType)], fakeEngine());
    h.registry.tick();
    expect(h.registry.snapshot().map((r) => [r.nodeId, r.frames])).toEqual([
      ['a', 3],
      ['b', 3],
      ['c', 1],
    ]);
  });

  it('⚠ one producer THROWING does not stop the ticker for the rest', () => {
    // A shared loop is a shared failure domain unless it is made not to be. The
    // error is recorded rather than swallowed, so a broken producer is visible
    // in `snapshot()` instead of merely quiet.
    const ok = counting();
    const boom: FrameProducer = {
      type: 'timelorde',
      why: 'test probe',
      frame: () => {
        throw new Error('kaboom');
      },
    };
    const h = harness([boom, ok.producer]);
    h.registry.sync([node('t', 'timelorde'), node('a', probeType)], fakeEngine());
    h.registry.tick();
    h.registry.tick();
    expect(ok.seen.map((s) => s.id), 'the healthy producer kept running').toEqual(['a', 'a']);
    const rows = h.registry.snapshot();
    expect(rows.find((r) => r.nodeId === 't')!.lastError).toBe('kaboom');
    expect(rows.find((r) => r.nodeId === 't')!.frames, 'a throwing frame is NOT counted').toBe(0);
    expect(rows.find((r) => r.nodeId === 'a')!.lastError).toBeNull();
  });

  it('starts ONE ticker for the first node and stops it when the last one leaves', () => {
    const { producer } = counting();
    const h = harness([producer]);
    expect(h.started, 'a rack with no producer node costs nothing').toBe(0);
    h.registry.sync([node('a', probeType), node('b', probeType)], fakeEngine());
    expect(h.started, 'ONE ticker for both').toBe(1);
    h.registry.sweep(['a']);
    expect(h.stopped, 'still one node left').toBe(0);
    h.registry.sweep([]);
    expect(h.stopped, 'the last node left').toBe(1);
    expect(h.registry.snapshot()).toEqual([]);
  });

  it('the GRAPH is the authority — sweep disposes, and `dispose` is called once', () => {
    const disposed: Array<Record<string, unknown>> = [];
    const producer: FrameProducer = {
      type: probeType,
      why: 'test probe',
      frame: (ctx) => {
        ctx.state.marked = true;
      },
      dispose: (state) => void disposed.push(state),
    };
    const h = harness([producer]);
    h.registry.sync([node('a', probeType)], fakeEngine());
    h.registry.tick();
    h.registry.sweep([]);
    h.registry.sweep([]);
    expect(disposed).toEqual([{ marked: true }]);
    expect(h.registry.has('a')).toBe(false);
  });

  it('a failing `dispose` cannot strand the sweep', () => {
    const producer: FrameProducer = {
      type: probeType,
      why: 'test probe',
      frame: () => {},
      dispose: () => {
        throw new Error('bad teardown');
      },
    };
    const h = harness([producer]);
    h.registry.sync([node('a', probeType), node('b', probeType)], fakeEngine());
    expect(() => h.registry.sweep([])).not.toThrow();
    expect(h.registry.snapshot()).toEqual([]);
  });

  it('mints a surface at most once per node and RESIZES it in place', () => {
    let sizes: Array<[number, number]> = [];
    const producer: FrameProducer = {
      type: probeType,
      why: 'test probe',
      frame: (ctx) => {
        const s = ctx.surface(64, 48);
        if (s) sizes.push([s.width, s.height]);
      },
    };
    const h = harness([producer]);
    h.registry.sync([node('a', probeType)], fakeEngine());
    h.registry.tick();
    h.registry.tick();
    expect(h.surfaces, 'one mint for two frames').toEqual([{ nodeId: 'a', w: 64, h: 48 }]);
    expect(sizes).toEqual([[64, 48], [64, 48]]);
    expect(h.registry.snapshot()[0]!.hasSurface).toBe(true);

    // ...and a later request for a different size resizes rather than re-mints.
    sizes = [];
    const grow: FrameProducer = {
      type: 'timelorde',
      why: 'test probe',
      frame: (ctx) => {
        const s = ctx.surface(sizes.length === 0 ? 10 : 20, 10);
        if (s) sizes.push([s.width, s.height]);
      },
    };
    const g = harness([grow]);
    g.registry.sync([node('t', 'timelorde')], fakeEngine());
    g.registry.tick();
    g.registry.tick();
    expect(g.surfaces.length, 'still one mint').toBe(1);
    expect(sizes).toEqual([[10, 10], [20, 10]]);
  });

  it('refuses TWO producers for one type — a silent second owner is the bug it prevents', () => {
    const a: FrameProducer = { type: probeType, why: 'a', frame: () => {} };
    const b: FrameProducer = { type: probeType, why: 'b', frame: () => {} };
    expect(() => harness([a, b])).toThrow(/two producers claim type/);
  });

  it('⚠ has NO teardown a surface can call — the structural guard', () => {
    // `sweep` and `disposeNode` are both keyed to the GRAPH. The whole failure
    // class this seam exists to remove is a VIEW ending a NODE's lifetime, so
    // the right place to refuse it is the type, before any test runs.
    expect(REGISTRY_SRC, 'no stop()/teardown()/detach() on the registry interface')
      .not.toMatch(/^\s{2}(?:stop|teardown|detach|unmount)\s*\(/m);
  });
});

// ── THE SCOPE PRODUCER ───────────────────────────────────────────────────────

describe('SCOPE_FRAME_PRODUCER — the cvCombined push, off the card', () => {
  it('pushes EVERY declared param, from readParam, in one record', () => {
    const eng = fakeEngine({
      timeMs: 40, ch1Scale: 2, ch1Offset: 0.1, ch1Range: 1,
      ch2Scale: 3, ch2Offset: -0.2, ch2Range: 0, mode: 1, intensity: 0.75,
    });
    const h = harness([SCOPE_FRAME_PRODUCER]);
    h.registry.sync([node('s', 'scope')], eng);
    h.registry.tick();
    expect(eng.writes.length).toBe(1);
    expect(eng.writes[0]!.key).toBe('cvCombined');
    expect(eng.writes[0]!.value).toEqual(eng.params);
  });

  it('⚠ writes UNCONDITIONALLY, every frame — a pulled cable must be able to un-latch', () => {
    // `cv-shadow` clears `combined` only on a KNOB MOVE, so a param that was
    // under CV stays at its last modulated value until something overwrites it.
    // A producer that only pushed "patched" params would therefore leave a
    // just-unpatched param frozen forever — the bug is in what it SKIPS.
    const eng = fakeEngine({ timeMs: 40 });
    const h = harness([SCOPE_FRAME_PRODUCER]);
    h.registry.sync([node('s', 'scope')], eng);
    h.registry.tick();
    h.registry.tick();
    expect(eng.writes.length).toBe(2);
  });

  it('drops non-finite and missing readings rather than pushing NaN into a shadow', () => {
    const eng = fakeEngine({ timeMs: NaN, ch1Scale: Infinity, mode: 1 });
    const h = harness([SCOPE_FRAME_PRODUCER]);
    h.registry.sync([node('s', 'scope')], eng);
    h.registry.tick();
    expect(eng.writes[0]!.value).toEqual({ mode: 1 });
  });

  it('reads the LIVE node, so a knob move lands without a remount', () => {
    const eng = fakeEngine({ timeMs: 20 });
    const h = harness([SCOPE_FRAME_PRODUCER]);
    h.registry.sync([node('s', 'scope')], eng);
    h.registry.tick();
    eng.params.timeMs = 120;
    h.registry.tick();
    expect((eng.writes[1]!.value as Record<string, number>).timeMs).toBe(120);
  });
});

// ── THE SYNESTHESIA PRODUCER ─────────────────────────────────────────────────

describe('SYNESTHESIA_FRAME_PRODUCER — the cross-domain pixel path, off the card', () => {
  /** A graph with ONE edge into `{copy}_video_in`, and a source node whose
   *  DOMAIN decides which of the two frame paths applies. */
  function graphWith(
    edges: Array<{ to: string; srcId: string; srcPort: string }>,
    srcDomain: 'audio' | 'video' = 'video',
  ): FrameGraph {
    return {
      findSource(targetNodeId, targetPortId) {
        const e = edges.find((x) => x.to === targetPortId);
        return e && targetNodeId === 'syn' ? { nodeId: e.srcId, portId: e.srcPort } : null;
      },
      node: (id) => ({ id, type: 'src', domain: srcDomain } as unknown as ModuleNode),
    };
  }

  /** A surface whose 2D context reports a KNOWN raster, so the levels the
   *  producer computes are checkable rather than merely non-null. */
  function pixelHarness(
    graph: FrameGraph,
    rgba: [number, number, number, number],
    opts: { blit?: unknown; drawFrame?: boolean } = {},
  ) {
    const drew: string[] = [];
    const registry = createNodeFrameProducerRegistry(
      [SYNESTHESIA_FRAME_PRODUCER],
      {
        createSurface(_nodeId, _type, w, h) {
          return {
            width: w,
            height: h,
            getContext: () => ({
              clearRect: () => void drew.push('clear'),
              drawImage: () => void drew.push('drawImage'),
              getImageData: (_x: number, _y: number, gw: number, gh: number) => {
                const data = new Uint8ClampedArray(gw * gh * 4);
                for (let i = 0; i < gw * gh; i++) {
                  data[i * 4] = rgba[0];
                  data[i * 4 + 1] = rgba[1];
                  data[i * 4 + 2] = rgba[2];
                  data[i * 4 + 3] = rgba[3];
                }
                return { data };
              },
            }),
          } as unknown as FrameSurface;
        },
        startTicker: () => () => {},
        env,
      },
      graph,
    );
    const eng = fakeEngine();
    // `'blit' in opts`, NOT `opts.blit ?? {}` — the whole point of the leg that
    // passes `blit: null` is that the engine could NOT blit, and `??` would
    // quietly hand it a truthy stand-in and test the opposite branch.
    eng.blitVideoNode = () => ('blit' in opts ? opts.blit! : {});
    eng.videoSource = () =>
      opts.drawFrame ? { drawFrame: () => void drew.push('drawFrame') } : null;
    return { registry, eng, drew };
  }

  it('pushes the patched frame levels for a copy in VIDEO mode', () => {
    const { registry, eng } = pixelHarness(
      graphWith([{ to: 'a_video_in', srcId: 'src', srcPort: 'out' }]),
      [255, 0, 0, 255],
    );
    registry.sync([node('syn', 'synesthesia', { a_mode: 1 })], eng);
    registry.tick();
    expect(eng.writes.length).toBe(1);
    expect(eng.writes[0]!.key).toBe('video_levels_a');
    const lv = eng.writes[0]!.value as number[];
    expect(lv[0], 'a solid RED frame maxes the R lane').toBeCloseTo(1, 2);
    expect(lv[1]).toBeCloseTo(0, 2);
    expect(lv[2]).toBeCloseTo(0, 2);
  });

  it('⚠ pushes NOTHING for a copy in AUDIO mode — the worklet owns those levels', () => {
    // A push here would overwrite live spectral analysis with a frame nobody
    // asked for, and it would pay a blit plus a readback per frame to do it.
    const { registry, eng, drew } = pixelHarness(
      graphWith([{ to: 'a_video_in', srcId: 'src', srcPort: 'out' }]),
      [255, 0, 0, 255],
    );
    registry.sync([node('syn', 'synesthesia', { a_mode: 0 })], eng);
    registry.tick();
    expect(eng.writes).toEqual([]);
    expect(drew, 'and it does not even sample the frame').toEqual([]);
  });

  it('⚠ pushes NOTHING when the port is UNPATCHED — "no source" is not "zeros"', () => {
    // The distinction is the module's behaviour: an unpatched VIDEO copy must
    // leave the worklet's held levels alone (gate closed, meters dark), not be
    // driven to zero by a producer reporting an absence as a measurement.
    const { registry, eng } = pixelHarness(graphWith([]), [255, 0, 0, 255]);
    registry.sync([node('syn', 'synesthesia', { a_mode: 1 })], eng);
    registry.tick();
    expect(eng.writes).toEqual([]);
  });

  it('handles the two copies INDEPENDENTLY — one in each mode', () => {
    const { registry, eng } = pixelHarness(
      graphWith([
        { to: 'a_video_in', srcId: 'src', srcPort: 'out' },
        { to: 'b_video_in', srcId: 'src', srcPort: 'out' },
      ]),
      [0, 255, 0, 255],
    );
    registry.sync([node('syn', 'synesthesia', { a_mode: 0, b_mode: 1 })], eng);
    registry.tick();
    expect(eng.writes.map((w) => w.key)).toEqual(['video_levels_b']);
  });

  it('takes the AUDIO-domain path through drawFrame, and the VIDEO path through a blit', () => {
    // The two paths are not interchangeable: an audio-domain mono-video source
    // paints straight into the scratch, while a video-domain node has to be
    // blitted into the engine's shared drawing buffer first and then sampled.
    const vid = pixelHarness(
      graphWith([{ to: 'a_video_in', srcId: 'src', srcPort: 'out' }], 'video'),
      [0, 0, 255, 255],
    );
    vid.registry.sync([node('syn', 'synesthesia', { a_mode: 1 })], vid.eng);
    vid.registry.tick();
    expect(vid.drew).toContain('drawImage');

    const aud = pixelHarness(
      graphWith([{ to: 'a_video_in', srcId: 'src', srcPort: 'out' }], 'audio'),
      [0, 0, 255, 255],
      { drawFrame: true },
    );
    aud.registry.sync([node('syn', 'synesthesia', { a_mode: 1 })], aud.eng);
    aud.registry.tick();
    expect(aud.drew).toContain('drawFrame');
    expect(aud.drew, 'the audio path never blits — drawFrame paints the scratch itself')
      .not.toContain('drawImage');
    expect(aud.eng.writes[0]!.key).toBe('video_levels_a');
  });

  it('a video-domain source the engine cannot blit pushes nothing rather than zeros', () => {
    const { registry, eng } = pixelHarness(
      graphWith([{ to: 'a_video_in', srcId: 'src', srcPort: 'out' }], 'video'),
      [255, 255, 255, 255],
      { blit: null },
    );
    registry.sync([node('syn', 'synesthesia', { a_mode: 1 })], eng);
    registry.tick();
    expect(eng.writes).toEqual([]);
  });
});

// ── THE TIMELORDE PRODUCER ───────────────────────────────────────────────────

describe('TIMELORDE_FRAME_PRODUCER — the composited display, off the card', () => {
  interface TlHarness {
    registry: ReturnType<typeof createNodeFrameProducerRegistry>;
    eng: FakeEngine;
    /** Every 2D op the composite performed, in order. */
    ops: string[];
    /** Bitmaps handed to `createImageBitmap`, resolved by `settle()`. */
    settle: () => Promise<void>;
    conversions: number;
    /** Overlay rasters minted through `env.createRaster`. */
    rasters: number;
    /** `lossy` harness only: lose / restore the surface's 2D context (the
     *  context reports lost in between), or lose the last minted raster's. */
    loseSurface: () => void;
    restoreSurface: () => void;
    loseRaster: () => void;
  }

  function tlHarness(opts: {
    reduced?: boolean;
    /** What `read(node,'hasDisplayFrame')` answers. */
    holdsFrame?: () => 0 | 1;
    /** Resolve the owl load with a decoded image (default) or nothing. */
    owl?: { width: number; height: number } | null;
    /** Hold conversions open until `settle()` — models a slow bitmap encode. */
    slowConvert?: boolean;
    /** A runtime with NO canvas to mint the overlay raster on (`createRaster`
     *  answers null) — the bare owl must stand and nothing may throw. */
    noRaster?: boolean;
    /** What the surface's `getImageData` reports — the bare owl the overlay
     *  is classified from. Defaults to all-zero (nothing pulses). */
    pixel?: [number, number, number, number];
    /** The owl's `drawImage` THROWS this many times before it succeeds — a
     *  decode race: the load resolved, the raster is not yet usable. */
    owlDrawFails?: number;
    /** Give the surface and every raster `contextlost` / `contextrestored`
     *  events, and the surface context an `isContextLost()` — the 2D-canvas
     *  loss seam `tlOnContextLoss` / `tlContextLost` read. */
    lossy?: boolean;
    graph?: FrameGraph;
  }): TlHarness {
    const ops: string[] = [];
    let conversions = 0;
    let rasters = 0;
    let owlDrawFails = opts.owlDrawFails ?? 0;
    let surfaceLost = false;
    let lastSurface: object | null = null;
    let lastRaster: object | null = null;
    const listeners = new Map<object, Map<string, Array<() => void>>>();
    /** Make a fake canvas an event target, when the harness is `lossy`. */
    const lossyCanvas = (c: object): void => {
      if (!opts.lossy) return;
      (c as { addEventListener: (type: string, fn: () => void) => void }).addEventListener = (
        type,
        fn,
      ) => {
        const byType = listeners.get(c) ?? new Map<string, Array<() => void>>();
        byType.set(type, [...(byType.get(type) ?? []), fn]);
        listeners.set(c, byType);
      };
    };
    const dispatch = (c: object | null, type: string): void => {
      if (!c) return;
      for (const fn of listeners.get(c)?.get(type) ?? []) fn();
    };
    const pending: Array<() => void> = [];
    const eng = fakeEngine();
    eng.read = (_n, key) => (key === 'hasDisplayFrame' ? (opts.holdsFrame?.() ?? 0) : undefined);
    /** A recording 2D context; `prefix` separates the SURFACE's op stream from
     *  the overlay RASTER's, which is the distinction the tests below assert. */
    const recordingContext = (prefix: string, lost?: () => boolean) =>
      new Proxy(
        {},
        {
          get(_t, k) {
            // A probe, not an op: unrecorded, so op-stream equalities hold.
            if (k === 'isContextLost') return () => lost?.() === true;
            if (k === 'drawImage') {
              return (...args: unknown[]) => {
                ops.push(`${prefix}drawImage(${args.length})`);
                if (args.length === 5 && owlDrawFails > 0) {
                  owlDrawFails--;
                  throw new Error('decode race: the image is not yet usable');
                }
              };
            }
            if (k === 'getImageData') {
              return (_x: number, _y: number, gw: number, gh: number) => {
                ops.push(`${prefix}getImageData`);
                const data = new Uint8ClampedArray(gw * gh * 4);
                const px = opts.pixel ?? [0, 0, 0, 0];
                for (let i = 0; i < data.length; i += 4) {
                  data[i] = px[0]; data[i + 1] = px[1]; data[i + 2] = px[2]; data[i + 3] = px[3];
                }
                return { data };
              };
            }
            if (k === 'createImageData') {
              return (gw: number, gh: number) => {
                ops.push(`${prefix}createImageData`);
                return { width: gw, height: gh, data: new Uint8ClampedArray(gw * gh * 4) };
              };
            }
            return (...args: unknown[]) => {
              ops.push(`${prefix}${String(k)}(${args.length})`);
            };
          },
          set(_t, k, v) {
            ops.push(`${prefix}set:${String(k)}${k === 'globalAlpha' ? `=${String(v)}` : ''}`);
            return true;
          },
        },
      );
    const registry = createNodeFrameProducerRegistry(
      [TIMELORDE_FRAME_PRODUCER],
      {
        createSurface(_nodeId, _type, w, h) {
          const s = {
            width: w,
            height: h,
            getContext: () => recordingContext('', () => surfaceLost),
          };
          lossyCanvas(s);
          lastSurface = s;
          return s as unknown as FrameSurface;
        },
        startTicker: () => () => {},
        env: {
          prefersReducedMotion: () => opts.reduced === true,
          nowMs: () => fakeNowMs,
          createImageBitmap: (_src) => {
            conversions++;
            return opts.slowConvert
              ? new Promise<unknown>((r) => pending.push(() => r({})))
              : Promise.resolve({});
          },
          loadImage: () =>
            Promise.resolve(
              opts.owl === null ? null : ((opts.owl ?? { width: 400, height: 400 }) as never),
            ),
          createRaster(w, h) {
            if (opts.noRaster) return null;
            rasters++;
            const r = {
              width: w,
              height: h,
              getContext: () => recordingContext('raster:'),
            };
            lossyCanvas(r);
            lastRaster = r;
            return r as unknown as FrameSurface;
          },
        },
      },
      opts.graph ?? noGraph,
    );
    return {
      registry,
      eng,
      ops,
      get conversions() {
        return conversions;
      },
      get rasters() {
        return rasters;
      },
      loseSurface: () => {
        surfaceLost = true;
        dispatch(lastSurface, 'contextlost');
      },
      restoreSurface: () => {
        surfaceLost = false;
        dispatch(lastSurface, 'contextrestored');
      },
      loseRaster: () => dispatch(lastRaster, 'contextlost'),
      settle: async () => {
        for (const r of pending.splice(0)) r();
        // Two microtask turns: one for the bitmap promise, one for the `.then`.
        await Promise.resolve();
        await Promise.resolve();
      },
    };
  }

  it('composites the OWL and pushes a display frame when nothing is patched', async () => {
    const h = tlHarness({});
    h.registry.sync([node('t', 'timelorde')], h.eng);
    h.registry.tick(); // kicks the owl load
    await h.settle();
    h.registry.tick(); // owl decoded — now it draws
    await h.settle();
    expect(h.ops.some((o) => o.startsWith('fillRect'))).toBe(true);
    expect(h.ops.some((o) => o.startsWith('drawImage'))).toBe(true);
    expect(h.eng.writes.map((w) => w.key)).toContain('displayFrame');
  });

  it('prefers the PATCHED FEED over the owl when one is connected', () => {
    const graph: FrameGraph = {
      findSource: (n, p) => (n === 't' && p === 'video_in' ? { nodeId: 'src', portId: 'out' } : null),
      node: (id) => ({ id, type: 'src', domain: 'audio' } as unknown as ModuleNode),
    };
    const h = tlHarness({ graph });
    h.eng.videoSource = () => ({ drawFrame: () => void h.ops.push('feedDrawFrame') });
    h.registry.sync([node('t', 'timelorde')], h.eng);
    h.registry.tick();
    expect(h.ops).toContain('feedDrawFrame');
    // …and it did NOT also paint the idle ground under it.
    expect(h.ops.some((o) => o.startsWith('fillRect'))).toBe(false);
  });

  it('⚠ under REDUCED MOTION it CONVERGES: pushes while the node holds nothing, then stops', async () => {
    // The live bug this arm encodes: a one-shot push that lands before the
    // engine handle exists — or on a handle that is then replaced — is lost
    // FOREVER, and video_out serves the idle field for the rest of the session.
    let holds: 0 | 1 = 0;
    const h = tlHarness({ reduced: true, holdsFrame: () => holds });
    h.registry.sync([node('t', 'timelorde')], h.eng);
    h.registry.tick(); // the owl is still decoding — the ground is painted and pushed
    await h.settle(); // the owl decodes; that push lands
    h.registry.tick(); // the OWL is painted and pushed
    await h.settle();
    expect(h.conversions, 'it keeps trying while the node holds no frame').toBeGreaterThan(0);
    const before = h.conversions;
    holds = 1;
    h.registry.tick();
    h.registry.tick();
    expect(h.conversions, 'and stops the moment the node holds one').toBe(before);
  });

  it('⚠ under REDUCED MOTION a held frame painted BEFORE the owl decoded does NOT end the convergence', async () => {
    // The other half of the same defect. The owl arrives asynchronously, and a
    // tick that runs before it lands paints the bare #07090d ground — a frame
    // the node then HOLDS, byte-identical to the idle field. A convergence that
    // asked only "does the node hold a frame" stopped there. MEASURED by
    // `timelorde-owl-overlay-parity.spec.ts` under `reducedMotion: 'reduce'`:
    // 1 boot in 4 latched the ground and video_out never showed the owl.
    let holds: 0 | 1 = 0;
    const h = tlHarness({ reduced: true, holdsFrame: () => holds });
    h.registry.sync([node('t', 'timelorde')], h.eng);
    h.registry.tick(); // owl pending → the ground only, pushed
    expect(h.ops.some((o) => o === 'drawImage(5)'), 'no owl on the first frame').toBe(false);
    expect(h.conversions).toBe(1);
    holds = 1; // …and the node now holds THAT frame
    await h.settle(); // the owl decodes
    h.ops.length = 0;
    h.registry.tick();
    expect(
      h.ops.some((o) => o === 'drawImage(5)'),
      'the OWL is painted although the node already holds a (ground-only) frame',
    ).toBe(true);
    expect(h.conversions, 'and pushed').toBe(2);
    await h.settle(); // the owl frame lands
    h.registry.tick();
    h.registry.tick();
    expect(h.conversions, 'and NOW it converges').toBe(2);
  });

  it('⚠ an owl whose draw is REFUSED (decode race) leaves a placeholder — the reduced-motion arm does not converge on it', async () => {
    // The same latch one branch over: `complete` used to flip whenever the
    // owl LOAD had resolved, not when the owl was PAINTED. `tlDrawOwl` catches
    // a throwing `drawImage` and leaves the ground; a convergence that took the
    // resolved load as "finished" stopped on that ground for the session.
    let holds: 0 | 1 = 0;
    const h = tlHarness({ reduced: true, holdsFrame: () => holds, owlDrawFails: 1 });
    h.registry.sync([node('t', 'timelorde')], h.eng);
    h.registry.tick(); // owl pending → the ground, pushed
    await h.settle(); // the owl decodes
    h.ops.length = 0;
    h.registry.tick(); // drawImage(owl) THROWS → the ground again, pushed
    expect(h.ops, 'the draw was attempted').toContain('drawImage(5)');
    expect(h.conversions).toBe(2);
    expect(h.registry.snapshot()[0]!.lastError, 'and the refusal was swallowed').toBeNull();
    holds = 1; // the node now holds THAT frame
    await h.settle(); // …and its push lands
    h.ops.length = 0;
    h.registry.tick();
    expect(h.ops, 'the owl is painted although the node holds a (ground-only) frame').toContain(
      'drawImage(5)',
    );
    expect(h.conversions, 'a refused draw does not end the convergence').toBe(3);
    await h.settle(); // the OWL frame lands
    h.registry.tick();
    h.registry.tick();
    expect(h.conversions, 'the painted owl does').toBe(3);
  });

  it('a runtime with NO images (owl null) converges on the ground under reduced motion — it IS the picture', async () => {
    let holds: 0 | 1 = 0;
    const h = tlHarness({ reduced: true, holdsFrame: () => holds, owl: null });
    h.registry.sync([node('t', 'timelorde')], h.eng);
    h.registry.tick(); // pending → ground
    await h.settle(); // the load resolves null
    h.registry.tick(); // ground — and this one is final
    expect(h.conversions).toBe(2);
    holds = 1;
    await h.settle();
    h.registry.tick();
    h.registry.tick();
    expect(h.conversions, 'no owl to wait for: converged').toBe(2);
  });

  it('⚠ under REDUCED MOTION the picture is the BARE owl — no beat boost, no overlay built', async () => {
    // `pulse` is pinned to 0 there, and the boost is what makes the frame a
    // function of wall-clock time. Its absence is the whole VRT determinism
    // claim, so it is asserted at the op stream rather than described — and
    // since the overlay is built lazily on the first PULSING frame, a
    // reduced-motion rack never even mints the raster or reads back once.
    const h = tlHarness({ reduced: true });
    h.registry.sync([node('t', 'timelorde')], h.eng);
    h.registry.tick();
    await h.settle();
    fakeNowMs = 12_345;
    h.registry.tick();
    await h.settle();
    expect(h.ops).not.toContain('getImageData');
    expect(h.ops.some((o) => o.startsWith('putImageData'))).toBe(false);
    expect(h.ops.some((o) => o.startsWith('set:globalAlpha'))).toBe(false);
    expect(h.rasters, 'no overlay raster is minted for a frame that never pulses').toBe(0);
    fakeNowMs = 0;
  });

  it('the beat boost runs when the CLOCK says it should — the picture follows time', async () => {
    // The inverse control of the leg above: with motion allowed, the same
    // producer DOES boost, and it does so because `nowMs` moved. Injecting the
    // clock is what makes that assertable without sleeping.
    //
    // ⚠ AND THE BOOST IS NOW A DRAW, NOT A READBACK. The evidence of a boosted
    // frame is the OVERLAY draw — `globalAlpha` set to `pulse·amount`, a second
    // `drawImage` after the owl's, `globalAlpha` restored — with NO
    // `getImageData`/`putImageData` on the surface. That readback-per-frame was
    // the measured hog (see `tlDrawOwl`), so a frame that reads back is the
    // regression this leg exists to catch.
    const h = tlHarness({});
    h.registry.sync([node('t', 'timelorde', { bpm: 120, running: 1 })], h.eng);
    h.registry.tick();
    await h.settle();
    let boosted = 0;
    let readbacks = 0;
    // Sweep a whole beat: `beatPulse` is FLAT 0 for the last 40 % of every beat,
    // so a single sample can legitimately miss — the same trap the e2e movement
    // probe records for this module.
    for (let ms = 0; ms <= 500; ms += 25) {
      fakeNowMs = ms;
      h.ops.length = 0;
      h.registry.tick();
      await h.settle();
      readbacks += h.ops.filter((o) => o === 'getImageData').length;
      const alphaSet = h.ops.findIndex((o) => o.startsWith('set:globalAlpha=') && !o.endsWith('=1'));
      if (alphaSet < 0) continue;
      boosted++;
      // The overlay draw sits between the alpha set and the alpha restore, and
      // the surface is never read back or written per-pixel for it.
      const after = h.ops.slice(alphaSet);
      expect(after.filter((o) => o === 'drawImage(3)').length, 'one overlay drawImage').toBe(1);
      expect(after).toContain('set:globalAlpha=1');
      expect(h.ops.some((o) => o.startsWith('putImageData'))).toBe(false);
    }
    fakeNowMs = 0;
    expect(boosted, 'somewhere in a beat the pulse is non-zero and the boost runs').toBeGreaterThan(0);
    expect(
      readbacks,
      'the surface is read back EXACTLY ONCE per node — to bake the overlay — never per frame',
    ).toBe(1);
    expect(h.rasters, 'and one overlay raster is minted for it').toBe(1);
  });

  it('the overlay is BAKED from the composited bare owl — white, alpha = membership', async () => {
    // The raster receives one `createImageData` + one `putImageData`, and the
    // buffer it is given is what `buildBeatBoostOverlay` makes of the surface's
    // pixels: a fully-yellow surface bakes a fully-opaque white overlay.
    const h = tlHarness({ pixel: [255, 255, 0, 255] });
    h.registry.sync([node('t', 'timelorde', { bpm: 120, running: 1 })], h.eng);
    h.registry.tick();
    await h.settle();
    fakeNowMs = 0; // phase 0 — full pulse
    h.ops.length = 0;
    h.registry.tick();
    await h.settle();
    const bake = h.ops.filter((o) => o.startsWith('raster:'));
    expect(bake).toEqual(['raster:createImageData', 'raster:putImageData(3)']);
    // The bake happens AFTER the owl is drawn (so it classifies the composited
    // pixels) and BEFORE the overlay is drawn at alpha.
    const owlDraw = h.ops.indexOf('drawImage(5)');
    const readback = h.ops.indexOf('getImageData');
    const alpha = h.ops.findIndex((o) => o.startsWith('set:globalAlpha=0.6'));
    expect(owlDraw).toBeGreaterThanOrEqual(0);
    expect(readback).toBeGreaterThan(owlDraw);
    expect(alpha).toBeGreaterThan(readback);
  });

  it('⚠ a LOST surface context drops the baked overlay — the bare owl stands while lost, the overlay is re-baked after restore', async () => {
    // Membership is a function of the RASTERISER, not only of the owl: a
    // context that comes back after a GPU-process crash or an acceleration
    // fallback can land on a different one (measured: 5738 member pixels GPU
    // vs 5730 CPU on the same owl), and a lost context reads back BLANK. The
    // per-frame classification could not go stale; the bake can, so loss
    // drops it and nothing is baked from a context that reports itself lost.
    const h = tlHarness({ lossy: true });
    h.registry.sync([node('t', 'timelorde', { bpm: 120, running: 1 })], h.eng);
    h.registry.tick();
    await h.settle();
    fakeNowMs = 0; // phase 0 — full pulse
    h.ops.length = 0;
    h.registry.tick();
    await h.settle();
    expect(h.ops.filter((o) => o === 'getImageData').length, 'baked once').toBe(1);
    expect(h.rasters).toBe(1);
    expect(h.ops.some((o) => o.startsWith('set:globalAlpha=0.6')), 'and drawn').toBe(true);

    h.loseSurface();
    h.ops.length = 0;
    h.registry.tick();
    await h.settle();
    expect(h.ops, 'while LOST: no readback — it would classify a blank').not.toContain('getImageData');
    expect(h.rasters, 'nothing minted from a lost context').toBe(1);
    expect(h.ops.some((o) => o.startsWith('set:globalAlpha=')), 'no stale overlay drawn').toBe(false);
    expect(h.ops, 'the bare owl still stands').toContain('drawImage(5)');

    h.restoreSurface();
    h.ops.length = 0;
    h.registry.tick();
    await h.settle();
    expect(h.ops.filter((o) => o === 'getImageData').length, 're-baked from a fresh readback').toBe(1);
    expect(h.rasters, 'on a fresh raster').toBe(2);
    expect(h.ops.some((o) => o.startsWith('set:globalAlpha=0.6')), 'and drawn again').toBe(true);
    h.ops.length = 0;
    h.registry.tick();
    await h.settle();
    expect(h.ops, 'and cached again').not.toContain('getImageData');
    expect(h.registry.snapshot()[0]!.lastError).toBeNull();
    fakeNowMs = 0;
  });

  it('a lost RASTER context drops the overlay too — a blank overlay is a boost that never comes', async () => {
    const h = tlHarness({ lossy: true });
    h.registry.sync([node('t', 'timelorde', { bpm: 120, running: 1 })], h.eng);
    h.registry.tick();
    await h.settle();
    fakeNowMs = 0;
    h.registry.tick();
    await h.settle();
    expect(h.rasters).toBe(1);
    h.loseRaster();
    h.ops.length = 0;
    h.registry.tick();
    await h.settle();
    expect(h.ops.filter((o) => o === 'getImageData').length, 're-baked').toBe(1);
    expect(h.rasters, 'on a fresh raster').toBe(2);
    expect(h.ops.some((o) => o.startsWith('set:globalAlpha=0.6'))).toBe(true);
    fakeNowMs = 0;
  });

  it('the owl + overlay draw starts from a RESET context — a foreign feed drawFrame cannot leave a composite op behind', async () => {
    // `tlDrawVideoFeed` hands the SAME context to the patched source's
    // `drawFrame`. The readback boost wrote pixels and was immune to whatever
    // composite op that left behind; the overlay is a `drawImage`, so the
    // owl frame begins with `reset()` (every default restored, bitmap cleared)
    // before anything is drawn.
    let connected = true;
    const graph: FrameGraph = {
      findSource: (n, p) =>
        connected && n === 't' && p === 'video_in' ? { nodeId: 'src', portId: 'out' } : null,
      node: (id) => ({ id, type: 'src', domain: 'audio' } as unknown as ModuleNode),
    };
    const h = tlHarness({ graph });
    h.eng.videoSource = () => ({ drawFrame: () => void h.ops.push('feedDrawFrame') });
    h.registry.sync([node('t', 'timelorde')], h.eng);
    h.registry.tick();
    await h.settle();
    expect(h.ops).toContain('feedDrawFrame');
    connected = false; // the feed goes away — the owl is back on the same context
    h.ops.length = 0;
    h.registry.tick();
    await h.settle();
    const reset = h.ops.indexOf('reset(0)');
    const owl = h.ops.indexOf('drawImage(5)');
    expect(reset, 'the context is reset').toBeGreaterThanOrEqual(0);
    expect(owl, 'before the owl is drawn').toBeGreaterThan(reset);
    expect(h.ops.slice(0, reset), 'and nothing is drawn before the reset').toEqual([]);
  });

  it('a runtime with NO raster to mint draws the bare owl and never throws', async () => {
    const h = tlHarness({ noRaster: true });
    h.registry.sync([node('t', 'timelorde', { bpm: 120, running: 1 })], h.eng);
    h.registry.tick();
    await h.settle();
    let readbacks = 0;
    for (let ms = 0; ms <= 100; ms += 25) {
      fakeNowMs = ms;
      h.ops.length = 0;
      h.registry.tick();
      await h.settle();
      readbacks += h.ops.filter((o) => o === 'getImageData').length;
      expect(h.ops.some((o) => o.startsWith('set:globalAlpha')), 'no overlay draw').toBe(false);
      expect(h.ops.some((o) => o.startsWith('drawImage(5)')), 'the owl is still drawn').toBe(true);
    }
    fakeNowMs = 0;
    expect(h.registry.snapshot()[0]!.lastError).toBeNull();
    expect(
      readbacks,
      'the failed mint is cached after ONE readback — not re-attempted every frame',
    ).toBe(1);
    expect(h.eng.writes.map((w) => w.key)).toContain('displayFrame');
  });

  it('⚠ ONE bitmap conversion in flight — a slow encode must not queue up', async () => {
    const h = tlHarness({ slowConvert: true });
    h.registry.sync([node('t', 'timelorde')], h.eng);
    h.registry.tick();
    h.registry.tick();
    h.registry.tick();
    expect(h.conversions, 'three frames, one conversion').toBe(1);
    await h.settle();
    h.registry.tick();
    expect(h.conversions, 'and the next frame is free to start one').toBe(2);
  });

  it('per-node scratch: two timelordes keep separate beat anchors and owls', async () => {
    const h = tlHarness({});
    h.registry.sync([node('t1', 'timelorde'), node('t2', 'timelorde')], h.eng);
    h.registry.tick();
    await h.settle();
    h.registry.tick();
    await h.settle();
    const rows = h.registry.snapshot();
    expect(rows.map((r) => r.nodeId).sort()).toEqual(['t1', 't2']);
    expect(rows.every((r) => r.hasSurface), 'each node composites into its OWN surface').toBe(true);
    expect(rows.every((r) => r.lastError === null)).toBe(true);
  });
});
