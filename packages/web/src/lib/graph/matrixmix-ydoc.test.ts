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
} from './matrixmix';

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
