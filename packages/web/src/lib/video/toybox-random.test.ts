// packages/web/src/lib/video/toybox-random.test.ts
//
// The TOYBOX randomize engine (#1576, workstream 4) — pure-function coverage.
//
// Everything here drives `generateToyboxPatch` with FIXTURE assets (the engine
// is pure over its inputs), except the resolveRoute-AGREEMENT block, which
// registers the same fixtures in the runtime asset provider so the REAL
// `findOrphanedRoutes` / `resolveRoute` machinery — the code the app actually
// runs when a cv signal arrives — validates the engine's routes. That block is
// what pins the engine's private route resolver against the app's; without it
// the two could drift and every green here would be about a shadow copy.
import { describe, it, expect, afterAll } from 'vitest';
import {
  ANTI_REPEAT_MEMORY,
  DIM_GEN_CONTENT,
  EMPTY_TOYBOX_CONTEXT,
  MAX_BUILD_ATTEMPTS,
  TOYBOX_ARCHETYPES,
  generateToyboxPatch,
  mergeRevertWithLocks,
  mulberry32,
  rollToyboxPatch,
  type ToyboxCurrentState,
  type ToyboxRandomAssets,
  type ToyboxRandomContext,
  type ToyboxRollBlob,
} from './toybox-random';
import { LAYER_COUNT, type ToyboxContent, type ToyboxLayer, type ToyboxModel } from './toybox-content';
import {
  OP_PARAMS,
  outputNode,
  topoSort,
  type ToyboxCombineGraph,
  type ToyboxOpKind,
} from './toybox-combine-graph';
import { CV_PORT_IDS, findOrphanedRoutes } from './toybox-cv-routes';
import {
  clearRuntimeToyboxAssets,
  registerRuntimeToyboxAsset,
} from './toybox-asset-registry';
import { applyDataBlobToData } from '$lib/graph/toybox-presets';

// ---------------- Fixtures (the test builds its own asset bank) ----------------

const param = (id: string, min: number, max: number, def: number) => ({
  id,
  label: id.toUpperCase(),
  min,
  max,
  default: def,
  curve: 'linear' as const,
});

const GEN_A: ToyboxContent = {
  id: 'fix-gen-a',
  label: 'FIX GEN A',
  family: 'GEN',
  glsl: 'fixture://gen-a',
  params: [param('speed', 0, 2, 1), param('scale', 0.5, 8, 3)],
};
const GEN_B: ToyboxContent = {
  id: 'fix-gen-b',
  label: 'FIX GEN B',
  family: 'GEN',
  glsl: 'fixture://gen-b',
  params: [param('hue', 0, 1, 0.5)],
};
// A content entry with NO declared params — the dice must survive picking it.
const GEN_C: ToyboxContent = {
  id: 'fix-gen-c',
  label: 'FIX GEN C',
  family: 'GEN',
  glsl: 'fixture://gen-c',
  params: [],
};
const FX_A: ToyboxContent = {
  id: 'fix-fx-a',
  label: 'FIX FX A',
  family: 'FX',
  glsl: 'fixture://fx-a',
  params: [param('gain', 0, 2, 1)],
};
const FRAG_A: ToyboxContent = {
  id: 'fix-frag-a',
  label: 'FIX FRAG A',
  family: 'FRAG',
  glsl: 'fixture://frag-a',
  input: 'scene',
  params: [param('warp', -1, 1, 0)],
};
const MODEL_A: ToyboxModel = { id: 'fix-cube', label: 'FIX CUBE', builtin: 'cube' };
const MODEL_B: ToyboxModel = { id: 'fix-sphere', label: 'FIX SPHERE', builtin: 'sphere', matcap: 1 };

// A DIM-listed content entry (the real registered id, so the engine's
// DIM_GEN_CONTENT gate applies to it): may never CARRY the frame alone.
const GEN_DIM: ToyboxContent = {
  id: 'star-field',
  label: 'STAR FIELD (FIXTURE)',
  family: 'GEN',
  glsl: 'fixture://star-field',
  params: [param('density', 2, 24, 10)],
};

const ASSETS: ToyboxRandomAssets = {
  content: [GEN_A, GEN_B, GEN_C, FX_A, FRAG_A, GEN_DIM],
  models: [MODEL_A, MODEL_B],
};

/** A seed spread with an irregular (prime) stride — enough rolls to exercise
 *  every archetype family without pinning any population count. */
const SEEDS = Array.from({ length: 24 }, (_, i) => 1009 + i * 7919);

const CTX_FULL: ToyboxRandomContext = {
  videoIn: { inA: true, inB: true },
  cv: { cv1: 'cv', cv3: 'gate', cv6: 'audio' },
};

/** Walk the combine edges backward from OUT — the TEST's own reachability
 *  instrument (independent of the engine's). */
function reachesOut(g: ToyboxCombineGraph): Set<string> {
  const into = new Map<string, string[]>();
  for (const e of g.edges) {
    if (!into.has(e.to)) into.set(e.to, []);
    into.get(e.to)!.push(e.from);
  }
  const seen = new Set<string>();
  const stack = ['out'];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const prev of into.get(cur) ?? []) stack.push(prev);
  }
  return seen;
}

/** Source-node layer indexes that reach OUT. */
function loadBearingLayers(blob: ToyboxRollBlob): Set<number> {
  const reach = reachesOut(blob.combine);
  const out = new Set<number>();
  for (const n of blob.combine.nodes) {
    if (n.kind === 'source' && reach.has(n.id) && typeof n.layer === 'number') out.add(n.layer);
  }
  return out;
}

describe('mulberry32', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a1 = mulberry32(42);
    const a2 = mulberry32(42);
    const b = mulberry32(43);
    const seqA1 = [a1(), a1(), a1()];
    const seqA2 = [a2(), a2(), a2()];
    const seqB = [b(), b(), b()];
    expect(seqA1).toEqual(seqA2);
    expect(seqA1).not.toEqual(seqB);
    for (const v of seqA1) expect(v, 'in [0,1)').toBeGreaterThanOrEqual(0);
    for (const v of seqA1) expect(v, 'in [0,1)').toBeLessThan(1);
  });
});

describe('determinism (R19/R24)', () => {
  it('same seed + same context + same assets ⇒ byte-identical result', () => {
    for (const seed of SEEDS.slice(0, 6)) {
      const a = generateToyboxPatch(seed, CTX_FULL, ASSETS);
      const b = generateToyboxPatch(seed, CTX_FULL, ASSETS);
      expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
    }
  });

  it('the seed sweep spans more than one archetype (variety floor, R7)', () => {
    const ids = new Set(SEEDS.map((s) => generateToyboxPatch(s, EMPTY_TOYBOX_CONTEXT, ASSETS).archetypeId));
    expect(ids.size, `archetypes seen: ${[...ids].join(', ')}`).toBeGreaterThan(1);
  });
});

describe('archetype table (derived membership — no counts)', () => {
  for (const arch of TOYBOX_ARCHETYPES) {
    it(`'${arch.id}' builds a valid, alive, first-class patch`, () => {
      // Force THIS archetype by excluding every other id.
      const exclude = TOYBOX_ARCHETYPES.filter((a) => a.id !== arch.id).map((a) => a.id);
      for (const seed of SEEDS.slice(0, 4)) {
        const res = generateToyboxPatch(seed, CTX_FULL, ASSETS, exclude);
        expect(res.archetypeId).toBe(arch.id);
        expect(res.fellBack, `${arch.id} seed ${seed} needed the fallback`).toBe(false);
        const { blob } = res;
        expect(blob.layers).toHaveLength(LAYER_COUNT);
        expect(outputNode(blob.combine)).toBeDefined();
        expect(topoSort(blob.combine).ok).toBe(true);
        // At least one load-bearing layer is alive without external feeds OR is
        // a patched-feed video layer (units: layer indexes).
        const bearing = loadBearingLayers(blob);
        const alive = [...bearing].some((i) => {
          const l = blob.layers[i]!;
          return (
            ['gen', 'shader', 'frag', 'obj'].includes(l.kind) ||
            (l.kind === 'video' && (l.videoSource === 'inA' || l.videoSource === 'inB'))
          );
        });
        expect(alive, `${arch.id} seed ${seed}: no alive load-bearing layer`).toBe(true);
      }
    });

    it(`'${arch.id}' explains itself (why is real prose)`, () => {
      expect(arch.why.length).toBeGreaterThan(40);
      expect(arch.weight).toBeGreaterThan(0);
    });
  }

  it('the reachability instrument itself can fail (negative control)', () => {
    // Sever the out edge of a valid roll and confirm the walker reports
    // nothing load-bearing — a walker that cannot go red proves nothing.
    const res = generateToyboxPatch(SEEDS[0]!, EMPTY_TOYBOX_CONTEXT, ASSETS);
    const cut: ToyboxCombineGraph = {
      nodes: res.blob.combine.nodes,
      edges: res.blob.combine.edges.filter((e) => e.to !== 'out'),
    };
    expect(loadBearingLayers({ ...res.blob, combine: cut }).size).toBe(0);
  });
});

describe('context-awareness (R13)', () => {
  it('a patched video port is a load-bearing video layer in EVERY roll', () => {
    for (const ctx of [
      { videoIn: { inA: true, inB: false }, cv: {} },
      { videoIn: { inA: false, inB: true }, cv: {} },
      { videoIn: { inA: true, inB: true }, cv: {} },
    ] satisfies ToyboxRandomContext[]) {
      for (const seed of SEEDS) {
        const { blob } = generateToyboxPatch(seed, ctx, ASSETS);
        const bearing = loadBearingLayers(blob);
        for (const port of ['inA', 'inB'] as const) {
          if (!ctx.videoIn[port]) continue;
          const idx = blob.layers.findIndex((l) => l.kind === 'video' && l.videoSource === port);
          expect(idx, `seed ${seed}: no video layer for ${port}`).toBeGreaterThanOrEqual(0);
          expect(bearing.has(idx), `seed ${seed}: ${port} layer ${idx} not load-bearing`).toBe(true);
        }
      }
    }
  });

  it('every patched cv port routes to a param that exists; unpatched ports are untouched', () => {
    for (const seed of SEEDS) {
      const { blob } = generateToyboxPatch(seed, CTX_FULL, ASSETS);
      const routed = Object.keys(blob.cvRoutes).sort();
      expect(routed).toEqual(Object.keys(CTX_FULL.cv).sort());
      for (const port of routed) expect(blob.cvRoutes[port]).toBeTruthy();
    }
  });

  it('with nothing patched, rolls carry no routes and no video layers', () => {
    for (const seed of SEEDS.slice(0, 8)) {
      const { blob } = generateToyboxPatch(seed, EMPTY_TOYBOX_CONTEXT, ASSETS);
      expect(Object.keys(blob.cvRoutes)).toEqual([]);
      expect(blob.layers.some((l) => l.kind === 'video')).toBe(false);
    }
  });
});

describe('agreement with the APP-side route resolver', () => {
  // Register the SAME fixtures in the runtime provider so getContentMeta —
  // what resolveRoute actually reads — resolves the rolled contentIds. This is
  // the leg that keeps the engine's private resolver honest.
  afterAll(() => clearRuntimeToyboxAssets());

  it('findOrphanedRoutes finds NOTHING in any roll (unconditional)', () => {
    for (const c of ASSETS.content) registerRuntimeToyboxAsset('content', c, { listed: true });
    for (const m of ASSETS.models) registerRuntimeToyboxAsset('model', m, { listed: true });
    for (const seed of SEEDS) {
      const { blob } = generateToyboxPatch(seed, CTX_FULL, ASSETS);
      expect(
        findOrphanedRoutes(blob.cvRoutes, blob.layers, blob.combine),
        `seed ${seed}`,
      ).toEqual([]);
    }
  });
});

describe('honest scope (R4/R25)', () => {
  it('the blob carries EXACTLY layers/combine/cvRoutes — nothing else to write', () => {
    for (const seed of SEEDS.slice(0, 8)) {
      const { blob } = generateToyboxPatch(seed, CTX_FULL, ASSETS);
      expect(Object.keys(blob).sort()).toEqual(['combine', 'cvRoutes', 'layers']);
    }
  });

  it('applying a roll leaves name/cvInputs untouched and replaces the three fields', () => {
    const res = generateToyboxPatch(SEEDS[1]!, CTX_FULL, ASSETS);
    const data: Record<string, unknown> = {
      name: 'my toybox',
      cvInputs: { cv1: { scale: -0.5, offset: 0.25 } },
      layers: [{ kind: 'gen', contentId: 'old', params: { x: 1 } }],
      combine: { nodes: [], edges: [] },
      cvRoutes: { cv2: { target: 'layer', layer: 0, param: 'x' } },
    };
    applyDataBlobToData(data, res.blob as Record<string, unknown>);
    expect(data.name).toBe('my toybox');
    expect(data.cvInputs).toEqual({ cv1: { scale: -0.5, offset: 0.25 } });
    expect(JSON.stringify(data.layers)).toEqual(JSON.stringify(res.blob.layers));
    expect(JSON.stringify(data.combine)).toEqual(JSON.stringify(res.blob.combine));
    expect(JSON.stringify(data.cvRoutes)).toEqual(JSON.stringify(res.blob.cvRoutes));
  });
});

describe('curated ranges (R1)', () => {
  it('every rolled op param is a declared param inside its OP_PARAMS range (units: op param values)', () => {
    for (const seed of SEEDS) {
      const { blob } = generateToyboxPatch(seed, CTX_FULL, ASSETS);
      for (const n of blob.combine.nodes) {
        if (n.kind === 'source' || n.kind === 'output') continue;
        const defs = OP_PARAMS[n.kind as ToyboxOpKind];
        expect(defs, `unknown op kind ${n.kind}`).toBeDefined();
        for (const [id, v] of Object.entries(n.params ?? {})) {
          const def = defs!.find((d) => d.id === id);
          expect(def, `seed ${seed}: op ${n.kind} rolled undeclared param '${id}'`).toBeDefined();
          expect(v, `seed ${seed}: ${n.kind}.${id}=${v} below min ${def!.min}`).toBeGreaterThanOrEqual(def!.min);
          expect(v, `seed ${seed}: ${n.kind}.${id}=${v} above max ${def!.max}`).toBeLessThanOrEqual(def!.max);
        }
      }
    }
  });

  it('every rolled content param is declared by its content and in range', () => {
    for (const seed of SEEDS) {
      const { blob } = generateToyboxPatch(seed, EMPTY_TOYBOX_CONTEXT, ASSETS);
      for (const layer of blob.layers) {
        if (!['gen', 'shader', 'frag'].includes(layer.kind)) continue;
        const meta = ASSETS.content.find((c) => c.id === layer.contentId);
        expect(meta, `rolled unknown contentId ${layer.contentId}`).toBeDefined();
        for (const [id, v] of Object.entries(layer.params)) {
          const def = meta!.params.find((p) => p.id === id);
          expect(def, `seed ${seed}: undeclared content param '${id}'`).toBeDefined();
          expect(v).toBeGreaterThanOrEqual(def!.min);
          expect(v).toBeLessThanOrEqual(def!.max);
        }
      }
    }
  });
});

describe('anti-repeat (R7)', () => {
  it('an excluded archetype is never picked while alternatives exist', () => {
    for (const seed of SEEDS) {
      const first = generateToyboxPatch(seed, EMPTY_TOYBOX_CONTEXT, ASSETS);
      const second = generateToyboxPatch(seed + 1, EMPTY_TOYBOX_CONTEXT, ASSETS, [first.archetypeId]);
      expect(second.archetypeId).not.toBe(first.archetypeId);
    }
  });

  it('excluding EVERY archetype falls back to the full table rather than failing', () => {
    const all = TOYBOX_ARCHETYPES.map((a) => a.id);
    const res = generateToyboxPatch(SEEDS[2]!, EMPTY_TOYBOX_CONTEXT, ASSETS, all);
    expect(all).toContain(res.archetypeId);
  });

  it('the card memory constant leaves the table pickable', () => {
    // ANTI_REPEAT_MEMORY must stay below the table size or every roll would
    // exhaust the exclusion filter (derived from the table, not a count).
    expect(ANTI_REPEAT_MEMORY).toBeLessThan(TOYBOX_ARCHETYPES.length);
  });
});

describe('fallback (R24)', () => {
  it('a bank that defeats every archetype still yields a valid roll via the fallback', () => {
    // No content at all, but a patched feed: every archetype's content pick
    // throws, the retry cap trips, and the fallback builds a pure-feed patch.
    const ctx: ToyboxRandomContext = { videoIn: { inA: true, inB: false }, cv: { cv2: 'cv' } };
    const empty: ToyboxRandomAssets = { content: [], models: [] };
    const res = generateToyboxPatch(SEEDS[3]!, ctx, empty);
    expect(res.fellBack).toBe(true);
    expect(res.blob.layers[0]!.kind).toBe('video');
    expect(res.blob.layers[0]!.videoSource).toBe('inA');
    expect(res.blob.cvRoutes.cv2).toBeTruthy();
    expect(topoSort(res.blob.combine).ok).toBe(true);
  });

  it('an empty bank with nothing patched throws loudly (never a black patch)', () => {
    const empty: ToyboxRandomAssets = { content: [], models: [] };
    expect(() => generateToyboxPatch(SEEDS[4]!, EMPTY_TOYBOX_CONTEXT, empty)).toThrow(
      /no content assets/i,
    );
  });

  it('MAX_BUILD_ATTEMPTS bounds the search (cost is a policy threshold, not a count)', () => {
    expect(MAX_BUILD_ATTEMPTS).toBeGreaterThan(0);
  });
});

describe('DIM content never carries the frame (the owner-black class, R5)', () => {
  it('every roll keeps at least one load-bearing NON-DIM carrier layer', () => {
    for (const seed of SEEDS) {
      const { blob } = generateToyboxPatch(seed, EMPTY_TOYBOX_CONTEXT, ASSETS);
      const bearing = loadBearingLayers(blob);
      const carrier = [...bearing].some((i) => {
        const l = blob.layers[i]!;
        if (l.kind === 'obj') return true;
        if (!['gen', 'shader', 'frag'].includes(l.kind)) return false;
        return !(l.contentId && DIM_GEN_CONTENT.has(l.contentId));
      });
      expect(carrier, `seed ${seed}: only DIM/feed layers reach OUT`).toBe(true);
    }
  });

  it('every DIM entry names its measurement (why is real prose)', () => {
    for (const [id, why] of DIM_GEN_CONTENT) {
      expect(id.length).toBeGreaterThan(0);
      expect(why.length).toBeGreaterThan(40);
    }
  });
});

describe('graph restructuring (owner demand: randomize the GRAPH)', () => {
  it('rolled graphs vary in OP-NODE COUNT across the sweep, not just in content', () => {
    const opCounts = new Set<number>();
    for (const seed of SEEDS) {
      const { blob } = generateToyboxPatch(seed, EMPTY_TOYBOX_CONTEXT, ASSETS);
      opCounts.add(blob.combine.nodes.filter((n) => n.kind !== 'source' && n.kind !== 'output').length);
    }
    expect(opCounts.size, `distinct op counts: ${[...opCounts].join(',')} (units: op nodes per roll)`).toBeGreaterThan(2);
  });

  it('the sweep exercises ops beyond the blend family', () => {
    const kinds = new Set<string>();
    for (const seed of SEEDS) {
      const { blob } = generateToyboxPatch(seed, EMPTY_TOYBOX_CONTEXT, ASSETS);
      for (const n of blob.combine.nodes) {
        if (n.kind !== 'source' && n.kind !== 'output') kinds.add(n.kind);
      }
    }
    const beyondBlends = [...kinds].filter((k) => !['fade', 'over', 'lumakey'].includes(k));
    expect(beyondBlends.length, `non-blend ops seen: ${beyondBlends.join(',')}`).toBeGreaterThan(2);
  });

  it("'branch-merge' rolls a DIAMOND: one op fed by TWO op arms", () => {
    const exclude = TOYBOX_ARCHETYPES.filter((a) => a.id !== 'branch-merge').map((a) => a.id);
    let sawDiamond = false;
    for (const seed of SEEDS) {
      const res = generateToyboxPatch(seed, EMPTY_TOYBOX_CONTEXT, ASSETS, exclude);
      expect(res.archetypeId).toBe('branch-merge');
      const g = res.blob.combine;
      const opIds = new Set(g.nodes.filter((n) => n.kind !== 'source' && n.kind !== 'output').map((n) => n.id));
      for (const n of g.nodes) {
        if (!opIds.has(n.id)) continue;
        const inbound = g.edges.filter((e) => e.to === n.id && opIds.has(e.from));
        if (inbound.length >= 2) sawDiamond = true;
      }
    }
    expect(sawDiamond, 'no branch-merge roll produced an op fed by two op arms').toBe(true);
  });
});

describe('locks (R12 / ws3 — absolute, engine-honored)', () => {
  const LOCKED_LAYER: ToyboxLayer = {
    kind: 'gen',
    contentId: 'fix-gen-a',
    params: { speed: 1.25, scale: 4 },
    locked: true,
  };

  it('a locked LAYER is byte-identical at its index in EVERY roll, and stays load-bearing', () => {
    const current: ToyboxCurrentState = {
      layers: [GEN_LAYER_FREE(), LOCKED_LAYER, GEN_LAYER_FREE(), GEN_LAYER_FREE()],
    };
    for (const seed of SEEDS) {
      const { blob } = generateToyboxPatch(seed, CTX_FULL, ASSETS, [], current);
      expect(JSON.stringify(blob.layers[1])).toEqual(JSON.stringify(LOCKED_LAYER));
      expect(loadBearingLayers(blob).has(1), `seed ${seed}: locked layer not load-bearing`).toBe(true);
    }
  });

  it('a locked NODE survives with params/position AND its upstream feeds (implied layer locks)', () => {
    const lockedNode = {
      id: 'op9',
      kind: 'lumakey' as const,
      x: 120,
      y: 66,
      params: { amount: 0.42, soft: 0.2, invert: 1 },
      locked: true,
    };
    const current: ToyboxCurrentState = {
      layers: [
        GEN_LAYER_FREE(),
        GEN_LAYER_FREE(),
        { kind: 'gen', contentId: 'fix-gen-b', params: { hue: 0.7 } },
        { kind: 'gen', contentId: 'fix-gen-c', params: {} },
      ],
      combine: {
        nodes: [
          { id: 'src0', kind: 'source', layer: 0, x: 14, y: 14 },
          { id: 'src1', kind: 'source', layer: 1, x: 14, y: 66 },
          { id: 'src2', kind: 'source', layer: 2, x: 14, y: 118 },
          { id: 'src3', kind: 'source', layer: 3, x: 14, y: 170 },
          lockedNode,
          { id: 'out', kind: 'output', x: 286, y: 66 },
        ],
        edges: [
          { id: 'e1', from: 'src2', to: 'op9', toPort: 'in0' },
          { id: 'e2', from: 'src3', to: 'op9', toPort: 'in1' },
          { id: 'e3', from: 'op9', to: 'out', toPort: 'in0' },
        ],
      },
    };
    for (const seed of SEEDS.slice(0, 10)) {
      const { blob } = generateToyboxPatch(seed, EMPTY_TOYBOX_CONTEXT, ASSETS, [], current);
      const got = blob.combine.nodes.find((n) => n.id === 'op9');
      expect(JSON.stringify(got), `seed ${seed}`).toEqual(JSON.stringify(lockedNode));
      const hasFeed = (from: string, port: string) =>
        blob.combine.edges.some((e) => e.from === from && e.to === 'op9' && e.toPort === port);
      expect(hasFeed('src2', 'in0'), `seed ${seed}: locked feed src2→op9 lost`).toBe(true);
      expect(hasFeed('src3', 'in1'), `seed ${seed}: locked feed src3→op9 lost`).toBe(true);
      // Implied locks: the layers the locked node consumes are byte-kept.
      expect(JSON.stringify(blob.layers[2])).toEqual(JSON.stringify(current.layers![2]));
      expect(JSON.stringify(blob.layers[3])).toEqual(JSON.stringify(current.layers![3]));
      // And the locked chain reaches OUT (load-bearing, not decoration).
      const reach = reachesOut(blob.combine);
      expect(reach.has('op9'), `seed ${seed}: locked node stranded`).toBe(true);
    }
  });

  it('existing cv routes to LOCKED targets survive; fresh routes avoid locked elements', () => {
    const current: ToyboxCurrentState = {
      layers: [GEN_LAYER_FREE(), LOCKED_LAYER, GEN_LAYER_FREE(), GEN_LAYER_FREE()],
      cvRoutes: {
        cv2: { target: 'layer', layer: 1, param: 'speed' }, // locked target, UNPATCHED port
        cv5: { target: 'layer', layer: 0, param: 'speed' }, // unlocked target — dropped
      },
    };
    for (const seed of SEEDS.slice(0, 10)) {
      const { blob } = generateToyboxPatch(seed, CTX_FULL, ASSETS, [], current);
      expect(blob.cvRoutes.cv2).toEqual({ target: 'layer', layer: 1, param: 'speed' });
      expect(blob.cvRoutes.cv5).toBeUndefined();
      for (const port of Object.keys(CTX_FULL.cv)) {
        const r = blob.cvRoutes[port];
        expect(r, `seed ${seed}: ${port} unrouted`).toBeTruthy();
        if (r && r.target === 'layer') {
          expect(r.layer, `seed ${seed}: fresh route targets the locked layer`).not.toBe(1);
        }
      }
    }
  });

  it('ALL layers locked + patched video: locks WIN, roll still valid, layers untouched', () => {
    const all: ToyboxLayer[] = [
      { ...clone(LOCKED_LAYER) },
      { kind: 'gen', contentId: 'fix-gen-b', params: {}, locked: true },
      { kind: 'off', contentId: null, params: {}, locked: true },
      { kind: 'off', contentId: null, params: {}, locked: true },
    ];
    const ctx: ToyboxRandomContext = { videoIn: { inA: true, inB: false }, cv: {} };
    for (const seed of SEEDS.slice(0, 6)) {
      const { blob } = generateToyboxPatch(seed, ctx, ASSETS, [], { layers: all });
      expect(JSON.stringify(blob.layers)).toEqual(JSON.stringify(all));
      expect(blob.layers.some((l) => l.kind === 'video')).toBe(false);
    }
  });

  function GEN_LAYER_FREE(): ToyboxLayer {
    return { kind: 'gen', contentId: 'fix-gen-c', params: {} };
  }
  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
});

describe('mergeRevertWithLocks (REVERT honors locks like a roll)', () => {
  const PRE = {
    layers: [
      { kind: 'gen', contentId: 'fix-gen-a', params: { speed: 0.5 } },
      { kind: 'off', contentId: null, params: {} },
      { kind: 'off', contentId: null, params: {} },
      { kind: 'off', contentId: null, params: {} },
    ],
  } as Record<string, unknown>;

  it('no locks → the snapshot passes through untouched', () => {
    expect(mergeRevertWithLocks(PRE, { layers: [] })).toBe(PRE);
    expect(mergeRevertWithLocks(null, undefined)).toBeNull();
  });

  it('a locked layer keeps its CURRENT content through the revert', () => {
    const lockedNow: ToyboxLayer = { kind: 'gen', contentId: 'fix-gen-b', params: { hue: 0.9 }, locked: true };
    const merged = mergeRevertWithLocks(PRE, {
      layers: [{ kind: 'gen', contentId: 'fix-gen-c', params: {} }, lockedNow],
    })!;
    const layers = merged.layers as ToyboxLayer[];
    expect(JSON.stringify(layers[1])).toEqual(JSON.stringify(lockedNow));
    // Unlocked scope restored from the snapshot.
    expect(JSON.stringify(layers[0])).toEqual(JSON.stringify((PRE.layers as ToyboxLayer[])[0]));
  });

  it('a locked node absent from the snapshot graph is carried over WITH its feeds', () => {
    const lockedNode = { id: 'op4', kind: 'tile', x: 120, y: 14, params: { tilesX: 3, tilesY: 3, mirror: 0, offX: 0, offY: 0, rotate: 0 }, locked: true };
    const merged = mergeRevertWithLocks(null, {
      layers: [{ kind: 'gen', contentId: 'fix-gen-a', params: {}, locked: false }],
      combine: {
        nodes: [
          { id: 'src0', kind: 'source', layer: 0, x: 14, y: 14 },
          { id: 'src1', kind: 'source', layer: 1, x: 14, y: 66 },
          { id: 'src2', kind: 'source', layer: 2, x: 14, y: 118 },
          { id: 'src3', kind: 'source', layer: 3, x: 14, y: 170 },
          lockedNode,
          { id: 'out', kind: 'output', x: 286, y: 66 },
        ],
        edges: [
          { id: 'e1', from: 'src0', to: 'op4', toPort: 'in0' },
          { id: 'e2', from: 'op4', to: 'out', toPort: 'in0' },
        ],
      },
    })!;
    const g = merged.combine as { nodes: Array<{ id: string }>; edges: Array<{ from: string; to: string }> };
    expect(g.nodes.some((n) => n.id === 'op4')).toBe(true);
    expect(g.edges.some((e) => e.from === 'src0' && e.to === 'op4')).toBe(true);
  });
});

describe('rollToyboxPatch wrapper', () => {
  it('threads explicit assets/seed through unchanged', () => {
    const direct = generateToyboxPatch(777, CTX_FULL, ASSETS);
    const wrapped = rollToyboxPatch({ seed: 777, context: CTX_FULL, assets: ASSETS });
    expect(JSON.stringify(wrapped)).toEqual(JSON.stringify(direct));
  });

  it('mints a fresh seed when omitted and records it for replay', () => {
    const res = rollToyboxPatch({ assets: ASSETS });
    const replay = rollToyboxPatch({ seed: res.seed, assets: ASSETS });
    expect(JSON.stringify(replay.blob)).toEqual(JSON.stringify(res.blob));
  });
});
