// packages/web/src/lib/video/toybox-presets.test.ts
//
// Phase-6 manifest-PRESET validation. Reads the REAL static manifest
// (packages/web/static/toybox/manifest.json) and asserts every bundled preset
// is structurally sound + self-contained:
//   - 25 presets, with the expected ids,
//   - each references ONLY bundled content / models (no dangling ids),
//   - each combine field is a valid GRAPH ({nodes,edges}) that topo-sorts
//     cleanly to a wired OUTPUT (so it renders, not black),
//   - each cvRoute targets a real layer/combine-op param.
//
// This is the unit-level headline proof that the presets drive the whole
// pipeline (load → layers → combine DAG → cv) — complementing the VRT/e2e that
// prove the pixels.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  isCombineGraph,
  topoSort,
  type ToyboxCombineGraph,
  OP_PARAMS,
  type ToyboxOpKind,
} from './toybox-combine-graph';
import { LAYER_COUNT } from './toybox-content';
import { MATERIAL_PARAMS } from './toybox-cv-routes';

const MANIFEST_PATH = fileURLToPath(
  new URL('../../../static/toybox/manifest.json', import.meta.url),
);

interface RawPreset {
  id: string;
  label: string;
  layers: { kind: string; contentId: string | null; material?: { modelId?: string } }[];
  combine: { nodes: { id: string; kind: string; layer?: number; params?: Record<string, number> }[]; edges: { from: string; to: string; toPort: string }[] };
  cvRoutes: Record<string, { target: string; layer?: number; nodeId?: string; param: string }>;
}
interface RawManifest {
  shaders: { id: string; params: { id: string }[] }[];
  gen: { id: string; params: { id: string }[] }[];
  models: { id: string }[];
  presets: RawPreset[];
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as RawManifest;
const presets = manifest.presets;
const contentById = new Map(
  [...manifest.gen, ...manifest.shaders].map((c) => [c.id, c]),
);
const modelIds = new Set(manifest.models.map((m) => m.id));
const materialParamIds = new Set(MATERIAL_PARAMS.map((p) => p.id));

describe('TOYBOX manifest presets', () => {
  it('declares exactly the 25 expected presets', () => {
    expect(presets.map((p) => p.id)).toEqual([
      'plasma-dissolve',
      'cow-on-camera',
      'worley-bloom',
      'textured-sphere',
      'reactor-field',
      'projection-map',
      'growing-peak',
      'mountain-weather',
      'glitch-tv',
      'spiral-feedback',
      'wave-interference',
      'cat-feedback',
      'ocean-voyage',
      'neon-descent',
      'primitive-pool',
      'starry-night',
      'plasma-terminal',
      'tunnel-tv',
      'comic-gyroid',
      'chrome-teapot',
      'neon-knot',
      'caustic-cow',
      'clay-pawn-terrain',
      'metaball-mirror',
      'flighty',
    ]);
  });

  for (const preset of presets) {
    describe(`preset "${preset.id}"`, () => {
      it('has a label + LAYER_COUNT layers', () => {
        expect(preset.label.length).toBeGreaterThan(0);
        expect(preset.layers).toHaveLength(LAYER_COUNT);
      });

      it('references ONLY bundled content / models (self-contained)', () => {
        for (const layer of preset.layers) {
          if (layer.kind === 'shader' || layer.kind === 'gen') {
            expect(layer.contentId, `${preset.id} layer content`).toBeTruthy();
            expect(contentById.has(layer.contentId!), `${preset.id} → ${layer.contentId}`).toBe(true);
          } else if (layer.kind === 'obj') {
            const mid = layer.material?.modelId;
            expect(mid, `${preset.id} obj model`).toBeTruthy();
            expect(modelIds.has(mid!), `${preset.id} → model ${mid}`).toBe(true);
          }
        }
      });

      it('combine is a valid GRAPH that topo-sorts to a wired OUTPUT', () => {
        expect(isCombineGraph(preset.combine)).toBe(true);
        const g = preset.combine as unknown as ToyboxCombineGraph;
        // exactly one OUTPUT node, with its in0 wired.
        const outs = g.nodes.filter((n) => n.kind === 'output');
        expect(outs).toHaveLength(1);
        const out = outs[0]!;
        const outEdge = g.edges.find((e) => e.to === out.id && e.toPort === 'in0');
        expect(outEdge, `${preset.id} OUTPUT in0 wired`).toBeTruthy();
        // the DAG is acyclic (topoSort orders every node).
        const { ok } = topoSort(g);
        expect(ok, `${preset.id} combine acyclic`).toBe(true);
        // every edge references real nodes.
        const ids = new Set(g.nodes.map((n) => n.id));
        for (const e of g.edges) {
          expect(ids.has(e.from), `${preset.id} edge.from ${e.from}`).toBe(true);
          expect(ids.has(e.to), `${preset.id} edge.to ${e.to}`).toBe(true);
        }
      });

      it('reaches the OUTPUT from at least one source (renders, not black)', () => {
        const g = preset.combine as unknown as ToyboxCombineGraph;
        const out = g.nodes.find((n) => n.kind === 'output')!;
        // BFS backwards from OUTPUT; assert we hit a source.
        const incoming = new Map<string, string[]>();
        for (const e of g.edges) {
          if (!incoming.has(e.to)) incoming.set(e.to, []);
          incoming.get(e.to)!.push(e.from);
        }
        const seen = new Set<string>();
        const stack = [out.id];
        let reachedSource = false;
        while (stack.length) {
          const cur = stack.pop()!;
          if (seen.has(cur)) continue;
          seen.add(cur);
          const node = g.nodes.find((n) => n.id === cur);
          if (node?.kind === 'source') reachedSource = true;
          for (const from of incoming.get(cur) ?? []) stack.push(from);
        }
        expect(reachedSource, `${preset.id} OUTPUT reaches a source`).toBe(true);
      });

      it('cvRoutes target real layer/combine-op params', () => {
        const g = preset.combine as unknown as ToyboxCombineGraph;
        for (const [port, route] of Object.entries(preset.cvRoutes)) {
          expect(/^cv[1-8]$/.test(port), `${preset.id} port ${port}`).toBe(true);
          if (route.target === 'layer') {
            expect(typeof route.layer).toBe('number');
            const layer = preset.layers[route.layer!]!;
            if (route.param.startsWith('material:')) {
              expect(layer.kind, `${preset.id} ${port} material on obj`).toBe('obj');
              expect(materialParamIds.has(route.param), `${preset.id} ${port} ${route.param}`).toBe(true);
            } else {
              // a content uniform — the layer's content must declare it.
              const content = layer.contentId ? contentById.get(layer.contentId) : undefined;
              expect(content, `${preset.id} ${port} layer content`).toBeTruthy();
              expect(
                content!.params.some((p) => p.id === route.param),
                `${preset.id} ${port} → ${route.param}`,
              ).toBe(true);
            }
          } else {
            // combine op param.
            const node = g.nodes.find((n) => n.id === route.nodeId);
            expect(node, `${preset.id} ${port} op ${route.nodeId}`).toBeTruthy();
            const defs = OP_PARAMS[node!.kind as ToyboxOpKind] ?? [];
            expect(
              defs.some((d) => d.id === route.param),
              `${preset.id} ${port} → ${node!.kind}.${route.param}`,
            ).toBe(true);
          }
        }
      });
    });
  }
});
