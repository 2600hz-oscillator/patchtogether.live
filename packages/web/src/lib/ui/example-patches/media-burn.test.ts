// packages/web/src/lib/ui/example-patches/media-burn.test.ts
//
// Unit coverage for the MEDIA BURN demo fixture + its loader. Mirror
// of glitches.test.ts in shape; the assertions are tailored to the
// MEDIA BURN content (15 PICTUREBOX tiles in a 5x3 grid + 1 CADILLAC
// positioned to hit the rightmost column at t=1s).

import { describe, it, expect, beforeAll } from 'vitest';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import { registerVideoModule, type VideoModuleDef } from '$lib/video/module-registry';
import { registerMetaModule, type MetaModuleDef } from '$lib/meta/module-registry';
import { parseEnvelope, ENVELOPE_VERSION, type LivePatch } from '$lib/graph/persistence';
import type { ModuleNode, Edge } from '$lib/graph/types';
import { MEDIA_BURN_ENVELOPE_RAW, getMediaBurnEnvelope, loadMediaBurn } from './media-burn';
import {
  MEDIA_BURN_LAYOUT,
  CADILLAC,
  cadillacStartX,
  rightmostTileRightX,
} from './media-burn-math';

// ---------------- Test fixtures ----------------

const throwingFactory = (): never => {
  throw new Error('factory should not be called from media-burn.test.ts');
};

const stubPictureboxDef: VideoModuleDef = {
  type: 'picturebox',
  domain: 'video',
  label: 'PICTUREBOX',
  category: 'sources',
  schemaVersion: 2,
  inputs: [{ id: 'gain', type: 'cv', paramTarget: 'gain' }],
  outputs: [{ id: 'out', type: 'image' }],
  params: [{ id: 'gain', label: 'Gain', defaultValue: 1, min: 0, max: 2, curve: 'linear' }],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  factory: throwingFactory as any,
};

const stubCadillacDef: MetaModuleDef = {
  type: 'cadillac',
  domain: 'meta',
  label: 'CADILLAC',
  category: 'tools',
  inputs: [],
  outputs: [],
  params: [],
  schemaVersion: 1,
  maxInstances: 1,
};

function freshPatch() {
  const store = syncedStore<{ nodes: Record<string, ModuleNode>; edges: Record<string, Edge> }>({
    nodes: {},
    edges: {},
  });
  const ydoc = getYjsDoc(store);
  return { store: store as unknown as LivePatch, ydoc };
}

// ---------------- Setup ----------------

beforeAll(() => {
  registerVideoModule(stubPictureboxDef);
  registerMetaModule(stubCadillacDef);
});

// ---------------- Tests ----------------

describe('media-burn: envelope shape', () => {
  it('imports as a non-null JSON object', () => {
    expect(MEDIA_BURN_ENVELOPE_RAW).toBeTypeOf('object');
    expect(MEDIA_BURN_ENVELOPE_RAW).not.toBeNull();
  });

  it('parses into a PatchEnvelope (v1, moduleSchemas + update present)', () => {
    const env = getMediaBurnEnvelope();
    expect(env.envelopeVersion).toBe(ENVELOPE_VERSION);
    expect(typeof env.savedAt).toBe('string');
    expect(new Date(env.savedAt).getTime()).toBeGreaterThan(0);
    expect(env.moduleSchemas).toBeTypeOf('object');
    expect(typeof env.update).toBe('string');
    expect(env.update.length).toBeGreaterThan(0);
    expect(env.update).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it('moduleSchemas advertises picturebox + cadillac (the only two types in the patch)', () => {
    const env = getMediaBurnEnvelope();
    expect(env.moduleSchemas).toHaveProperty('picturebox');
    expect(env.moduleSchemas).toHaveProperty('cadillac');
  });
});

describe('media-burn: loadMediaBurn against a fake store', () => {
  it('lands 15 PICTUREBOX tiles + 1 CADILLAC = 16 nodes', () => {
    const { store, ydoc } = freshPatch();
    const result = loadMediaBurn(ydoc, store);

    expect(result.nodesLoaded).toBe(16);
    expect(result.edgesLoaded).toBe(0);

    const pbs = Object.values(store.nodes).filter((n): n is ModuleNode => n?.type === 'picturebox');
    const cads = Object.values(store.nodes).filter((n): n is ModuleNode => n?.type === 'cadillac');
    expect(pbs.length).toBe(MEDIA_BURN_LAYOUT.ROWS * MEDIA_BURN_LAYOUT.COLS);
    expect(cads.length).toBe(1);
  });

  it('every PICTUREBOX carries non-empty imageBytes with imageMime=image/jpeg', () => {
    const { store, ydoc } = freshPatch();
    loadMediaBurn(ydoc, store);
    const pbs = Object.values(store.nodes).filter((n): n is ModuleNode => n?.type === 'picturebox');
    for (const pb of pbs) {
      const data = pb.data as { imageBytes?: string; imageMime?: string } | undefined;
      expect(typeof data?.imageBytes).toBe('string');
      expect((data?.imageBytes ?? '').length).toBeGreaterThan(500);
      expect(data?.imageMime).toBe('image/jpeg');
    }
  });

  it('PICTUREBOX tiles sit on a flush 5x3 grid (every neighbour is exactly cardW / cardH away)', () => {
    const { store, ydoc } = freshPatch();
    loadMediaBurn(ydoc, store);
    const pbs = Object.values(store.nodes).filter((n): n is ModuleNode => n?.type === 'picturebox');

    // Project to a (col, row) -> position map keyed by id naming
    // convention (media-burn-pb-r{R}-c{C}).
    const byCell: Record<string, { x: number; y: number }> = {};
    for (const pb of pbs) {
      const m = pb.id.match(/r(\d+)-c(\d+)$/);
      expect(m, `pb id ${pb.id} matches naming convention`).not.toBeNull();
      byCell[`${m![1]}-${m![2]}`] = pb.position;
    }

    // Horizontal neighbours.
    for (let r = 0; r < MEDIA_BURN_LAYOUT.ROWS; r++) {
      for (let c = 0; c < MEDIA_BURN_LAYOUT.COLS - 1; c++) {
        const a = byCell[`${r}-${c}`]!;
        const b = byCell[`${r}-${c + 1}`]!;
        expect(b.x - a.x).toBe(MEDIA_BURN_LAYOUT.CARD_W);
        expect(b.y).toBe(a.y);
      }
    }
    // Vertical neighbours.
    for (let r = 0; r < MEDIA_BURN_LAYOUT.ROWS - 1; r++) {
      for (let c = 0; c < MEDIA_BURN_LAYOUT.COLS; c++) {
        const a = byCell[`${r}-${c}`]!;
        const b = byCell[`${r + 1}-${c}`]!;
        expect(b.y - a.y).toBe(MEDIA_BURN_LAYOUT.CARD_H);
        expect(b.x).toBe(a.x);
      }
    }
  });

  it('CADILLAC start.x matches cadillacStartX(xR, CAR_W, 1s, 300 px/s) = 1400', () => {
    const { store, ydoc } = freshPatch();
    loadMediaBurn(ydoc, store);
    const cad = Object.values(store.nodes).find((n): n is ModuleNode => n?.type === 'cadillac')!;
    const xR = rightmostTileRightX(
      MEDIA_BURN_LAYOUT.BASE_X,
      MEDIA_BURN_LAYOUT.COLS,
      MEDIA_BURN_LAYOUT.CARD_W,
    );
    const expected = cadillacStartX(
      xR,
      CADILLAC.WIDTH,
      CADILLAC.SECONDS_UNTIL_FIRST_HIT,
      CADILLAC.SPEED_PX_PER_SEC,
    );
    expect(expected).toBe(1400);
    expect(cad.position.x).toBe(expected);
  });

  it('CADILLAC node has NO spawnedAtMs (overlay will fall back to Date.now() at load)', () => {
    const { store, ydoc } = freshPatch();
    loadMediaBurn(ydoc, store);
    const cad = Object.values(store.nodes).find((n): n is ModuleNode => n?.type === 'cadillac')!;
    const data = (cad.data ?? {}) as Record<string, unknown>;
    expect(data).not.toHaveProperty('spawnedAtMs');
    expect(data).not.toHaveProperty('spawnerClientId');
  });

  it('is idempotent — second load yields the same 16 node ids', () => {
    const { store, ydoc } = freshPatch();
    loadMediaBurn(ydoc, store);
    const firstIds = Object.values(store.nodes).map((n) => n?.id).filter(Boolean).sort();

    loadMediaBurn(ydoc, store);
    const secondIds = Object.values(store.nodes).map((n) => n?.id).filter(Boolean).sort();

    expect(secondIds).toEqual(firstIds);
    expect(firstIds.length).toBe(16);
  });
});
