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

const env: FrameEnv = {
  prefersReducedMotion: () => false,
  createImageBitmap: null,
  loadImage: () => Promise.resolve(null),
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
    expect([...NODE_FRAME_PRODUCER_TYPES].sort()).toEqual(['scope']);
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
