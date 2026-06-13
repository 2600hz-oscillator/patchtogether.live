// packages/web/src/lib/graph/matrixmix-ydoc.test.ts
//
// REAL-Y.Doc regression tests for the MATRIXMIX axis mutators + the
// create-edge-from-a-cell writer. Runs against the SAME syncedStore + Y.Doc the
// live patch uses (graph/store.ts), so node.data / patch.edges become real Y
// types once written — the way to catch the "Type already integrated" trap if a
// 2nd axis-set ever spread an integrated map. Mirrors the control-surface-ydoc
// discipline ([[yjs-save-load-real-ydoc]]).
//
// createMatrixEdge needs real module defs so the SHARED validateEdge can resolve
// ports + directions; importing the audio modules barrel registers them.

import { describe, it, expect, afterEach } from 'vitest';
import { patch } from '$lib/graph/store';
import { getModuleDef } from '$lib/audio/module-registry';
import { getVideoModuleDef } from '$lib/video/module-registry';
import { getMetaModuleDef } from '$lib/meta/module-registry';
import '$lib/audio/modules'; // side-effect: register audio module defs
import '$lib/meta/modules'; // side-effect: register meta module defs
import type { ModuleNode } from './types';
import {
  MATRIXMIX_TYPE,
  readMatrixData,
  setXAxisModule,
  setYAxisModule,
  createMatrixEdge,
  removeMatrixEdge,
} from './matrixmix';
import { jacksForDef, classifyCell } from '$lib/ui/matrixmix-grid';

const MID = 'mm-ydoc-test';
const ADSR = 'adsr-1';
const VCA = 'vca-1';

const defLookup = (type: string) =>
  getModuleDef(type) ?? getVideoModuleDef(type) ?? getMetaModuleDef(type);

function node(id: string, type: string, domain = 'audio'): ModuleNode {
  return { id, type, domain, position: { x: 0, y: 0 }, params: {}, data: {} } as unknown as ModuleNode;
}

function setup(): void {
  patch.nodes[MID] = node(MID, MATRIXMIX_TYPE, 'meta');
  patch.nodes[ADSR] = node(ADSR, 'adsr');
  patch.nodes[VCA] = node(VCA, 'vca');
}

afterEach(() => {
  for (const id of Object.keys(patch.nodes)) delete patch.nodes[id];
  for (const id of Object.keys(patch.edges)) delete patch.edges[id];
});

describe('matrixmix — real Y.Doc axis mutators', () => {
  it('sets X then Y axis selections IN PLACE (single-key, never throws)', () => {
    setup();
    expect(() => {
      setXAxisModule(MID, ADSR);
      setYAxisModule(MID, VCA);
    }).not.toThrow();
    const d = readMatrixData(patch.nodes[MID]);
    expect(d.xAxisModuleId).toBe(ADSR);
    expect(d.yAxisModuleId).toBe(VCA);
  });

  it('SURVIVES re-selecting the same axis (the integrate trap) + can clear', () => {
    setup();
    setXAxisModule(MID, ADSR);
    expect(() => setXAxisModule(MID, VCA)).not.toThrow(); // 2nd set, same key
    expect(readMatrixData(patch.nodes[MID]).xAxisModuleId).toBe(VCA);
    setXAxisModule(MID, undefined); // clear
    expect(readMatrixData(patch.nodes[MID]).xAxisModuleId).toBeUndefined();
  });
});

describe('matrixmix — createMatrixEdge against the live patch', () => {
  it('creates the correct edge for a LEGAL cell (ADSR.env cv → VCA.cv)', () => {
    setup();
    // Cable: ADSR.env (cv output) → VCA.cv (cv input).
    const source = { nodeId: ADSR, portId: 'env' };
    const target = { nodeId: VCA, portId: 'cv' };
    const id = createMatrixEdge(source, target, 'cv', 'cv', defLookup);
    expect(id).toBe(`e-${ADSR}-env-${VCA}-cv`);
    const e = patch.edges[id!];
    expect(e).toBeDefined();
    if (!e) return;
    expect(e.source).toEqual(source);
    expect(e.target).toEqual(target);
    expect(e.sourceType).toBe('cv');
    expect(e.targetType).toBe('cv');
  });

  it('REJECTS an illegal cell (cv output → audio input) — silent no-op, no edge', () => {
    setup();
    // ADSR.env is cv; VCA.audio is an audio input → canConnect(cv, audio) false.
    const id = createMatrixEdge(
      { nodeId: ADSR, portId: 'env' },
      { nodeId: VCA, portId: 'audio' },
      'cv',
      'audio',
      defLookup,
    );
    expect(id).toBeNull();
    expect(Object.keys(patch.edges)).toHaveLength(0);
  });

  it('REPLACES an existing cable on the target INPUT (an input holds one cable)', () => {
    setup();
    patch.nodes['lfo-1'] = node('lfo-1', 'lfo');
    // Pre-existing cable feeding VCA.cv from a third module (use a real cv out).
    // Use ADSR.env_inv as a stand-in third source so the def resolves.
    patch.edges['pre'] = {
      id: 'pre',
      source: { nodeId: 'lfo-1', portId: 'phase0' },
      target: { nodeId: VCA, portId: 'cv' },
      sourceType: 'cv',
      targetType: 'cv',
    } as never;
    const id = createMatrixEdge(
      { nodeId: ADSR, portId: 'env' },
      { nodeId: VCA, portId: 'cv' },
      'cv',
      'cv',
      defLookup,
    );
    expect(id).toBeDefined();
    // The pre-existing cable on VCA.cv is gone; only the new one feeds it.
    expect(patch.edges['pre']).toBeUndefined();
    const feeders = Object.values(patch.edges).filter(
      (e) => e && e.target.nodeId === VCA && e.target.portId === 'cv',
    );
    expect(feeders).toHaveLength(1);
    expect(feeders[0]!.source).toEqual({ nodeId: ADSR, portId: 'env' });
  });

  it('is idempotent — re-creating the same edge returns the same id, no duplicate', () => {
    setup();
    const a = createMatrixEdge({ nodeId: ADSR, portId: 'env' }, { nodeId: VCA, portId: 'cv' }, 'cv', 'cv', defLookup);
    const b = createMatrixEdge({ nodeId: ADSR, portId: 'env' }, { nodeId: VCA, portId: 'cv' }, 'cv', 'cv', defLookup);
    expect(a).toBe(b);
    expect(Object.keys(patch.edges)).toHaveLength(1);
  });
});

describe('matrixmix — removeMatrixEdge (unpatch) against the live patch', () => {
  it('removes EXACTLY the direct edge between the two matrixed modules', () => {
    setup();
    const id = createMatrixEdge(
      { nodeId: ADSR, portId: 'env' },
      { nodeId: VCA, portId: 'cv' },
      'cv',
      'cv',
      defLookup,
    );
    expect(id).toBeDefined();
    expect(patch.edges[id!]).toBeDefined();

    const removed = removeMatrixEdge(id!);
    expect(removed).toBe(true);
    // The exact edge is gone; nothing else was created.
    expect(patch.edges[id!]).toBeUndefined();
    expect(Object.keys(patch.edges)).toHaveLength(0);
  });

  it('removing a direct edge leaves FOREIGN edges (gray ✕) untouched', () => {
    setup();
    patch.nodes['lfo-1'] = node('lfo-1', 'lfo');
    // A foreign cable on ADSR's OUTPUT jack — ADSR.env fans out to a THIRD
    // module (LFO.rate, cv→cv). In the matrix this is a gray ✕; it must NEVER
    // be removed by the matrix.
    patch.edges['foreign-out'] = {
      id: 'foreign-out',
      source: { nodeId: ADSR, portId: 'env' },
      target: { nodeId: 'lfo-1', portId: 'rate' },
      sourceType: 'cv',
      targetType: 'cv',
    } as never;

    // The direct cable between the two matrixed modules (ADSR.env → VCA.cv).
    const directId = createMatrixEdge(
      { nodeId: ADSR, portId: 'env' },
      { nodeId: VCA, portId: 'cv' },
      'cv',
      'cv',
      defLookup,
    );
    expect(directId).toBeDefined();

    const removed = removeMatrixEdge(directId!);
    expect(removed).toBe(true);
    // The direct edge is gone…
    expect(patch.edges[directId!]).toBeUndefined();
    // …but the foreign OUTPUT cable (gray ✕) survives.
    expect(patch.edges['foreign-out']).toBeDefined();
    expect(Object.keys(patch.edges)).toEqual(['foreign-out']);
  });

  it('a gray-✕ (foreign output) cell exposes NO edgeId → the card can never remove it', () => {
    setup();
    patch.nodes['lfo-1'] = node('lfo-1', 'lfo');
    // ADSR.env (cv output) fans out to LFO.rate (cv input) → the cell pairing
    // ADSR.env with VCA.cv reads as outputFanout (gray ✕) — the output already
    // feeds a third module, the cell's own input (VCA.cv) is free. Classify it
    // through the SAME pure core the card uses and confirm it carries NO edgeId,
    // so onCellClick's `direct` branch never fires for it.
    patch.edges['foreign-out'] = {
      id: 'foreign-out',
      source: { nodeId: ADSR, portId: 'env' },
      target: { nodeId: 'lfo-1', portId: 'rate' },
      sourceType: 'cv',
      targetType: 'cv',
    } as never;
    // X = ADSR (cols), Y = VCA (rows). colJack = ADSR.env, rowJack = VCA.cv.
    const colJack = jacksForDef(defLookup('adsr')).find(
      (j) => j.portId === 'env' && j.direction === 'output',
    )!;
    const rowJack = jacksForDef(defLookup('vca')).find(
      (j) => j.portId === 'cv' && j.direction === 'input',
    )!;
    const cls = classifyCell(
      rowJack,
      colJack,
      Object.values(patch.edges),
      ADSR /* xModuleId — cols */,
      VCA /* yModuleId — rows */,
      (n) => n,
    );
    expect(cls.kind).toBe('outputFanout');
    expect(cls.edgeId).toBeUndefined();
    // The foreign cable stands.
    expect(patch.edges['foreign-out']).toBeDefined();
  });

  it('is idempotent — removing an absent / already-gone edge is a no-op (false)', () => {
    setup();
    expect(removeMatrixEdge('e-does-not-exist')).toBe(false);
    const id = createMatrixEdge(
      { nodeId: ADSR, portId: 'env' },
      { nodeId: VCA, portId: 'cv' },
      'cv',
      'cv',
      defLookup,
    );
    expect(removeMatrixEdge(id!)).toBe(true);
    // Second remove finds nothing.
    expect(removeMatrixEdge(id!)).toBe(false);
    expect(Object.keys(patch.edges)).toHaveLength(0);
  });
});
